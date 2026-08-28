import type { LLMClient } from "@vibeqa/llm";
import {
  BrowserActionSchema,
  type BrowserAction,
  type Observation
} from "@vibeqa/schemas";

import { ProgressiveEscalationStrategy } from "./escalation-policy.js";
import {
  DeterministicProgressEvaluator,
  pageFingerprint
} from "./progress-evaluator.js";
import type {
  AdaptiveActionSummary,
  AdaptiveExecutionMetadata,
  AdaptiveHandoffSnapshot,
  AdaptivePlannerDecisionOutcome,
  EscalationPolicyDecision,
  ProgressEvaluation,
  ProgressiveEscalationPolicyConfig
} from "./types.js";

export interface AdaptiveExecutionControllerOptions {
  deterministicClient: LLMClient;
  ollamaClient: LLMClient;
  verifyOllamaAvailability?: () => Promise<void>;
  policy?: ProgressiveEscalationStrategy;
  policyConfig?: Partial<ProgressiveEscalationPolicyConfig>;
  now?: () => number;
  escalateWhenDeterministicExhausted?: boolean;
  maxSteps?: number;
  diagnosticPostEscalationStepBudget?: number;
}

export class AdaptiveExecutionController implements LLMClient {
  private readonly progress = new DeterministicProgressEvaluator();
  private readonly policy: ProgressiveEscalationStrategy;
  private readonly now: () => number;
  private phase: "deterministic" | "ollama" = "deterministic";
  private escalationCount = 0;
  private deterministicSteps = 0;
  private ollamaSteps = 0;
  private ollamaInvocationCount = 0;
  private readonly startedAt: number;
  private escalatedAt: number | null = null;
  private lastActionCount = 0;
  private metadata: AdaptiveExecutionMetadata;

  constructor(private readonly options: AdaptiveExecutionControllerOptions) {
    this.policy =
      options.policy ?? new ProgressiveEscalationStrategy(options.policyConfig);
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.metadata = initialMetadata(
      options.maxSteps ?? null,
      options.diagnosticPostEscalationStepBudget ?? null
    );
  }

  async generate(prompt: string): Promise<string> {
    const snapshot = parseRuntimePrompt(prompt);
    const progress = this.progress.evaluate({
      observation: snapshot.observation,
      actionHistory: snapshot.actionHistory,
      lastActionSucceeded: true
    });
    this.updateStepCounts(snapshot.actionHistory.length);

    if (this.phase === "deterministic") {
      if (hasTerminalEvidence(snapshot.observation)) {
        return await this.generateWith(
          this.options.deterministicClient,
          "deterministic",
          prompt,
          snapshot
        );
      }
      const policyDecision = this.policy.evaluate(
        { ...progress, deterministicSteps: this.deterministicSteps },
        this.escalationCount
      );
      this.recordProgress(progress, policyDecision);
      if (policyDecision.escalate) {
        await this.tryEscalation(policyDecision, snapshot, prompt, progress);
      }
    }

    if (this.phase === "ollama") {
      if (this.diagnosticBudgetReached(snapshot)) {
        return "null";
      }
      return await this.generateWith(
        this.options.ollamaClient,
        "ollama",
        this.createEscalatedPrompt(prompt),
        snapshot
      );
    }

    const response = await this.generateWith(
      this.options.deterministicClient,
      "deterministic",
      prompt,
      snapshot
    );
    if (
      isNullAction(response) &&
      (this.options.escalateWhenDeterministicExhausted ?? true) &&
      !hasTerminalEvidence(snapshot.observation)
    ) {
      const exhausted = this.policy.evaluate(
        {
          ...progress,
          deterministicSteps: this.deterministicSteps,
          deterministicExhausted: true
        },
        this.escalationCount
      );
      this.recordProgress(progress, exhausted);
      await this.tryEscalation(exhausted, snapshot, prompt, progress);
      if ((this.phase as string) === "ollama") {
        if (this.diagnosticBudgetReached(snapshot)) {
          return "null";
        }
        return await this.generateWith(
          this.options.ollamaClient,
          "ollama",
          this.createEscalatedPrompt(prompt),
          snapshot
        );
      }
    }
    return response;
  }

  getMetadata(
    totalSteps = this.deterministicSteps + this.ollamaSteps
  ): AdaptiveExecutionMetadata {
    const now = this.now();
    const uncountedSteps = Math.max(
      0,
      totalSteps - this.deterministicSteps - this.ollamaSteps
    );
    const deterministicSteps =
      this.phase === "deterministic"
        ? this.deterministicSteps + uncountedSteps
        : this.deterministicSteps;
    const ollamaSteps =
      this.phase === "ollama" ? this.ollamaSteps + uncountedSteps : this.ollamaSteps;
    return structuredClone({
      ...this.metadata,
      deterministicSteps,
      ollamaSteps,
      totalSteps,
      ollamaInvocationCount: this.ollamaInvocationCount,
      timeAfterEscalationMs:
        this.escalatedAt === null ? null : Math.max(0, now - this.escalatedAt)
    });
  }

  finalize(finalOutcome: boolean, totalSteps?: number): AdaptiveExecutionMetadata {
    this.metadata.finalOutcome = finalOutcome;
    return this.getMetadata(totalSteps);
  }

  private async tryEscalation(
    decision: EscalationPolicyDecision,
    snapshot: RuntimePromptSnapshot,
    prompt: string,
    progress: ProgressEvaluation
  ): Promise<void> {
    if (!decision.escalate || this.phase === "ollama") return;
    this.metadata.escalationRequired = true;
    this.metadata.escalationSignals = [...decision.signals];
    this.metadata.escalationReason = decision.reason;
    this.metadata.escalationStep = this.deterministicSteps;
    try {
      await this.options.verifyOllamaAvailability?.();
      this.phase = "ollama";
      this.escalationCount += 1;
      this.escalatedAt = this.now();
      this.metadata.escalationOccurred = true;
      this.metadata.escalationSucceeded = true;
      this.metadata.ollamaAvailable = true;
      this.metadata.plannerAfter = "ollama";
      this.metadata.deterministicSteps = this.deterministicSteps;
      this.metadata.timeBeforeEscalationMs = Math.max(
        0,
        this.escalatedAt - this.startedAt
      );
      this.metadata.remainingStepBudgetAtHandoff = remainingStepBudget(
        this.options.maxSteps,
        this.deterministicSteps
      );
      this.metadata.handoffSnapshot = createHandoffSnapshot(
        snapshot,
        prompt,
        progress,
        decision,
        this.metadata
      );
    } catch (error) {
      this.metadata.ollamaAvailable = false;
      this.metadata.escalationSucceeded = false;
      this.metadata.degradedExecution = true;
      this.metadata.escalationFailure = safeError(error);
    }
  }

  private updateStepCounts(actionCount: number): void {
    const added = Math.max(0, actionCount - this.lastActionCount);
    if (this.phase === "ollama") this.ollamaSteps += added;
    else this.deterministicSteps += added;
    this.lastActionCount = actionCount;
  }

  private async generateWith(
    client: LLMClient,
    planner: "deterministic" | "ollama",
    prompt: string,
    snapshot: RuntimePromptSnapshot
  ): Promise<string> {
    if (planner === "ollama") this.ollamaInvocationCount += 1;
    const startedAt = this.now();
    try {
      const response = await client.generate(prompt);
      this.recordPlannerDecision(
        planner,
        snapshot,
        prompt,
        response,
        isNullAction(response) ? "null_action" : "valid_action",
        Math.max(0, this.now() - startedAt),
        null
      );
      return response;
    } catch (error) {
      this.recordPlannerDecision(
        planner,
        snapshot,
        prompt,
        "",
        "generation_error",
        Math.max(0, this.now() - startedAt),
        safeError(error)
      );
      throw error;
    }
  }

  private diagnosticBudgetReached(snapshot: RuntimePromptSnapshot): boolean {
    const limit = this.options.diagnosticPostEscalationStepBudget;
    if (limit === undefined || this.ollamaSteps < limit) return false;
    this.metadata.diagnosticBudgetExhausted = true;
    this.recordPlannerDecision(
      "ollama",
      snapshot,
      "",
      "",
      "diagnostic_budget_stop",
      0,
      null
    );
    return true;
  }

  private recordPlannerDecision(
    planner: "deterministic" | "ollama",
    snapshot: RuntimePromptSnapshot,
    prompt: string,
    response: string,
    outcome: AdaptivePlannerDecisionOutcome,
    durationMs: number,
    error: string | null
  ): void {
    this.metadata.plannerDecisions.push({
      phase: planner,
      invocation: this.metadata.plannerDecisions.length + 1,
      outcome,
      action: summarizeResponse(response),
      promptCharacterCount: prompt.length,
      responseCharacterCount: response.length,
      actionHistoryCount: snapshot.actionHistory.length,
      pageFingerprint: pageFingerprint(snapshot.observation),
      durationMs,
      error
    });
  }

  private recordProgress(
    progress: ReturnType<DeterministicProgressEvaluator["evaluate"]>,
    decision: EscalationPolicyDecision
  ): void {
    const event = {
      step: this.deterministicSteps,
      ...progress,
      signals: [...decision.signals]
    };
    const previous = this.metadata.progressEvents.at(-1);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(event)) {
      this.metadata.progressEvents.push(event);
    }
  }

  private createEscalatedPrompt(prompt: string): string {
    return [
      "Adaptive execution context:",
      "- Deterministic execution stopped making sufficient runtime progress.",
      `- Escalation signals: ${this.metadata.escalationSignals.join(", ") || "runtime-stagnation"}.`,
      "- Continue from the current browser and Agent state; do not restart the task.",
      "- Do not return null merely because earlier deterministic actions were attempted.",
      "- Return null only when the public goal is visibly satisfied, a requested failure is observed, or no useful safe action remains.",
      "",
      prompt
    ].join("\n");
  }
}

export function createCompletedDeterministicMetadata(
  totalSteps: number,
  durationMs: number,
  finalOutcome: boolean | null = null
): AdaptiveExecutionMetadata {
  return {
    ...initialMetadata(),
    deterministicSteps: totalSteps,
    totalSteps,
    timeBeforeEscalationMs: durationMs,
    finalOutcome
  };
}

function initialMetadata(
  maxSteps: number | null = null,
  diagnosticPostEscalationStepBudget: number | null = null
): AdaptiveExecutionMetadata {
  return {
    requestedStrategy: "adaptive",
    startingPlanner: "deterministic",
    escalationRequired: false,
    escalationOccurred: false,
    escalationSucceeded: false,
    ollamaAvailable: null,
    degradedExecution: false,
    escalationStep: null,
    escalationSignals: [],
    escalationReason: null,
    plannerBefore: "deterministic",
    plannerAfter: null,
    deterministicSteps: 0,
    ollamaSteps: 0,
    totalSteps: 0,
    timeBeforeEscalationMs: null,
    timeAfterEscalationMs: null,
    ollamaInvocationCount: 0,
    finalOutcome: null,
    progressEvents: [],
    escalationFailure: null,
    maxSteps,
    remainingStepBudgetAtHandoff: null,
    handoffSnapshot: null,
    plannerDecisions: [],
    diagnosticReplay: diagnosticPostEscalationStepBudget !== null,
    diagnosticPostEscalationStepBudget,
    diagnosticBudgetExhausted: false
  };
}

interface RuntimePromptSnapshot {
  goal: string;
  observation: Observation;
  actionHistory: BrowserAction[];
  discoveredBugs: string[];
}

function parseRuntimePrompt(prompt: string): RuntimePromptSnapshot {
  const observationMatch = /Current observation: (\{.*\})\nPrevious actions:/s.exec(
    prompt
  );
  const actionsMatch = /Previous actions: (\[.*\])\nDiscovered bugs:/s.exec(prompt);
  const goalMatch = /^Goal: (.*)$/m.exec(prompt);
  const bugsMatch = /Discovered bugs: (\[.*\])$/s.exec(prompt);
  if (!observationMatch?.[1] || !actionsMatch?.[1]) {
    throw new Error("Adaptive execution requires the standard Agent runtime prompt.");
  }
  return {
    goal: goalMatch?.[1] ?? "",
    observation: JSON.parse(observationMatch[1]) as Observation,
    actionHistory: JSON.parse(actionsMatch[1]) as BrowserAction[],
    discoveredBugs: bugsMatch?.[1] ? (JSON.parse(bugsMatch[1]) as string[]) : []
  };
}

function isNullAction(response: string): boolean {
  return response.trim() === "null";
}

function hasTerminalEvidence(observation: Observation): boolean {
  return observation.consoleErrors.length > 0;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Ollama unavailable";
  return message
    .replace(
      /((?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi,
      "$1[REDACTED]"
    )
    .slice(0, 300);
}

function createHandoffSnapshot(
  snapshot: RuntimePromptSnapshot,
  prompt: string,
  progress: ProgressEvaluation,
  decision: EscalationPolicyDecision,
  metadata: AdaptiveExecutionMetadata
): AdaptiveHandoffSnapshot {
  const sensitiveValues = snapshot.actionHistory.flatMap((action) =>
    action.type === "type" ? [action.value] : []
  );
  const sanitize = (value: string): string =>
    sanitizeDiagnosticText(value, sensitiveValues);
  const priorActions = snapshot.actionHistory.map(summarizeAction);
  return {
    goal: sanitize(snapshot.goal),
    currentUrl: sanitize(snapshot.observation.url),
    pageTitle: sanitize(snapshot.observation.title),
    visibleTextSummary: sanitize(snapshot.observation.textSample).slice(0, 1200),
    interactiveElements: snapshot.observation.elements
      .filter((element) => element.visible)
      .map((element) => ({
        tagName: element.tagName,
        role: element.role,
        accessibleName: element.accessibleName
          ? sanitize(element.accessibleName)
          : null,
        text: sanitize(element.text),
        selector: sanitize(element.selector),
        href: element.href ? sanitize(element.href) : null,
        enabled: element.enabled,
        editable: element.editable
      })),
    accessibility: {
      ...structuredClone(snapshot.observation.accessibility),
      headings: snapshot.observation.accessibility.headings.map((heading) => ({
        ...heading,
        text: sanitize(heading.text)
      })),
      landmarks: snapshot.observation.accessibility.landmarks.map((landmark) => ({
        ...landmark,
        name: landmark.name ? sanitize(landmark.name) : null
      }))
    },
    pageFingerprint: progress.currentFingerprint,
    priorDeterministicActions: priorActions,
    failedOrNoProgressActions: metadata.progressEvents
      .filter((event) => !event.progressed)
      .flatMap((event) => event.actionsSincePreviousMatch),
    discoveredBugs: snapshot.discoveredBugs.map((bug) => sanitize(bug)),
    progressHistory: structuredClone(metadata.progressEvents),
    escalationSignals: [...decision.signals],
    escalationReason: sanitize(decision.reason),
    totalMaxSteps: metadata.maxSteps,
    remainingStepBudget: remainingStepBudget(
      metadata.maxSteps ?? undefined,
      metadata.deterministicSteps
    ),
    evaluatorStatus: {
      progressed: progress.progressed,
      reasons: [...progress.reasons]
    },
    memorySummary: {
      actionCount: snapshot.actionHistory.length,
      discoveredBugCount: snapshot.discoveredBugs.length,
      recentActionTypes: snapshot.actionHistory.slice(-5).map((action) => action.type)
    },
    promptCharacterCount: prompt.length,
    actionHistoryCharacterCount: JSON.stringify(priorActions).length
  };
}

function summarizeAction(action: BrowserAction): AdaptiveActionSummary {
  if ("selector" in action) return { type: action.type, target: action.selector };
  if ("url" in action) return { type: action.type, target: action.url };
  return { type: action.type, target: null };
}

function summarizeResponse(response: string): AdaptiveActionSummary | null {
  if (isNullAction(response) || response.length === 0) return null;
  try {
    return summarizeAction(BrowserActionSchema.parse(JSON.parse(response)));
  } catch {
    return null;
  }
}

function remainingStepBudget(
  maxSteps: number | undefined,
  deterministicSteps: number
): number | null {
  return maxSteps === undefined ? null : Math.max(0, maxSteps - deterministicSteps);
}

function sanitizeDiagnosticText(
  value: string,
  sensitiveValues: readonly string[]
): string {
  let sanitized = value;
  for (const sensitiveValue of sensitiveValues.filter(Boolean)) {
    sanitized = sanitized.split(sensitiveValue).join("[REDACTED]");
  }
  return sanitized
    .replace(/BUG-BENCH-\d{3}/gi, "[REDACTED-BUG-ID]")
    .replace(
      /((?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi,
      "$1[REDACTED]"
    );
}
