import type { LLMClient } from "@vibeqa/llm";
import {
  BrowserActionSchema,
  type BrowserAction,
  type Observation
} from "@vibeqa/schemas";

import { ProgressiveEscalationStrategy } from "./escalation-policy.js";
import { DeterministicCompletionEvaluator } from "./completion-evaluator.js";
import { OpportunityPreservationEvaluator } from "./opportunity-evaluator.js";
import {
  DeterministicProgressEvaluator,
  pageFingerprint
} from "./progress-evaluator.js";
import type {
  AdaptiveActionSummary,
  AdaptiveExecutionMetadata,
  AdaptiveHandoffSnapshot,
  AdaptivePlannerDecisionOutcome,
  AdaptiveEscalationTiming,
  EscalationPolicyDecision,
  OpportunityPreservationEvaluation,
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
  opportunityPreservationEnabled?: boolean;
  knownWorkflow?: boolean;
  nullRetryLimit?: number;
  opportunityEvaluator?: OpportunityPreservationEvaluator;
  completionEvaluator?: DeterministicCompletionEvaluator;
}

export class AdaptiveExecutionController implements LLMClient {
  private readonly progress = new DeterministicProgressEvaluator();
  private readonly policy: ProgressiveEscalationStrategy;
  private readonly opportunity: OpportunityPreservationEvaluator;
  private readonly completion: DeterministicCompletionEvaluator;
  private readonly now: () => number;
  private readonly nullRetryLimit: number;
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
    this.opportunity =
      options.opportunityEvaluator ?? new OpportunityPreservationEvaluator();
    this.completion =
      options.completionEvaluator ?? new DeterministicCompletionEvaluator();
    this.nullRetryLimit = options.nullRetryLimit ?? 1;
    if (!Number.isInteger(this.nullRetryLimit) || this.nullRetryLimit < 0) {
      throw new Error("Adaptive null retry limit must be a non-negative integer.");
    }
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.metadata = initialMetadata(
      options.maxSteps ?? null,
      options.diagnosticPostEscalationStepBudget ?? null,
      options.opportunityPreservationEnabled ?? true,
      this.nullRetryLimit
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
    const currentOpportunity = this.opportunity.evaluate({
      goal: snapshot.goal,
      observation: snapshot.observation,
      actionHistory: snapshot.actionHistory,
      proposedAction: null,
      knownWorkflow: this.options.knownWorkflow
    });
    if (this.metadata.initialSafeCandidateCount === undefined) {
      this.metadata.initialSafeCandidateCount =
        currentOpportunity.safeUnexploredCandidates.length;
      this.metadata.initialPageFingerprint = progress.currentFingerprint;
    }

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
        await this.tryEscalation(
          policyDecision,
          snapshot,
          prompt,
          progress,
          escalationTiming(policyDecision),
          currentOpportunity
        );
      }
    }

    if (this.phase === "ollama") {
      return await this.generateOllama(snapshot, prompt);
    }

    const response = await this.generateWith(
      this.options.deterministicClient,
      "deterministic",
      prompt,
      snapshot
    );
    const proposedAction = parseResponseAction(response);
    if (proposedAction) {
      const opportunity = this.opportunity.evaluate({
        goal: snapshot.goal,
        observation: snapshot.observation,
        actionHistory: snapshot.actionHistory,
        proposedAction,
        knownWorkflow: this.options.knownWorkflow
      });
      if (
        this.metadata.policyVersion === "v2" &&
        opportunity.shouldEscalateBeforeAction
      ) {
        const earlyDecision = opportunityDecision(opportunity);
        this.recordProgress(progress, earlyDecision);
        await this.tryEscalation(
          earlyDecision,
          snapshot,
          prompt,
          progress,
          "early",
          opportunity
        );
        if ((this.phase as string) === "ollama") {
          return await this.generateOllama(snapshot, prompt);
        }
      }
    }
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
      await this.tryEscalation(
        exhausted,
        snapshot,
        prompt,
        progress,
        "exhaustion",
        currentOpportunity
      );
      if ((this.phase as string) === "ollama") {
        return await this.generateOllama(snapshot, prompt);
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
    progress: ProgressEvaluation,
    timing: AdaptiveEscalationTiming,
    opportunity: OpportunityPreservationEvaluation
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
      this.metadata.escalationTiming = timing;
      this.metadata.opportunityPreservingEscalation = timing === "early";
      this.metadata.deterministicSteps = this.deterministicSteps;
      this.metadata.timeBeforeEscalationMs = Math.max(
        0,
        this.escalatedAt - this.startedAt
      );
      this.metadata.remainingStepBudgetAtHandoff = remainingStepBudget(
        this.options.maxSteps,
        this.deterministicSteps
      );
      const sensitiveValues = snapshot.actionHistory.flatMap((action) =>
        action.type === "type" ? [action.value] : []
      );
      const safeOpportunity = sanitizeOpportunityEvaluation(
        opportunity,
        sensitiveValues
      );
      const handoffCandidates = opportunity.safeUnexploredCandidates.length;
      this.metadata.safeCandidatesRemainingAtHandoff = handoffCandidates;
      this.metadata.opportunityRetainedAtHandoff = opportunityRetention(
        this.metadata.initialSafeCandidateCount ?? handoffCandidates,
        handoffCandidates
      );
      this.metadata.opportunityEvaluationAtHandoff = safeOpportunity;
      this.metadata.handoffSnapshot = createHandoffSnapshot(
        snapshot,
        prompt,
        progress,
        decision,
        this.metadata,
        safeOpportunity
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
      if (planner === "ollama") {
        this.metadata.postHandoffTerminationReason = "generation-error";
      }
      throw error;
    }
  }

  private async generateOllama(
    snapshot: RuntimePromptSnapshot,
    agentPrompt: string
  ): Promise<string> {
    if (this.diagnosticBudgetReached(snapshot)) {
      this.metadata.postHandoffTerminationReason = "budget-exhausted";
      return "null";
    }
    if (this.metadata.policyVersion === "v1") {
      return await this.generateWith(
        this.options.ollamaClient,
        "ollama",
        createV1ContinuationPrompt(snapshot, this.metadata, agentPrompt),
        snapshot
      );
    }

    for (let retryAttempt = 0; retryAttempt <= this.nullRetryLimit; retryAttempt += 1) {
      const opportunity = this.opportunity.evaluate({
        goal: snapshot.goal,
        observation: snapshot.observation,
        actionHistory: snapshot.actionHistory,
        proposedAction: null,
        knownWorkflow: false
      });
      const response = await this.generateWith(
        this.options.ollamaClient,
        "ollama",
        this.createEscalatedPrompt(snapshot, opportunity, retryAttempt),
        snapshot
      );
      if (!isNullAction(response)) {
        if (retryAttempt > 0) {
          this.metadata.nullRecoveryCount = (this.metadata.nullRecoveryCount ?? 0) + 1;
        }
        this.metadata.postHandoffTerminationReason = "none";
        return response;
      }

      const completion = this.completion.evaluate({
        goal: snapshot.goal,
        observation: snapshot.observation,
        actionHistory: snapshot.actionHistory,
        discoveredBugs: snapshot.discoveredBugs
      });
      const remainingBudget = remainingStepBudget(
        this.options.maxSteps,
        snapshot.actionHistory.length
      );
      const candidateCount = opportunity.safeUnexploredCandidates.length;
      let classification: NonNullable<
        AdaptiveExecutionMetadata["nullDecisionsAfterHandoff"]
      >[number]["classification"];
      if (completion.confirmed) classification = "legitimate-completion";
      else if (remainingBudget === 0) classification = "budget-exhausted";
      else if (candidateCount === 0) classification = "no-useful-action";
      else if (retryAttempt >= this.nullRetryLimit) {
        classification = "retry-limit-exhausted";
      } else classification = "premature-unresolved-candidates";

      this.metadata.nullDecisionsAfterHandoff?.push({
        invocation: this.ollamaInvocationCount,
        classification,
        completionConfirmed: completion.confirmed,
        safeCandidateCount: candidateCount,
        remainingBudget,
        retryAttempt
      });

      if (completion.confirmed) {
        this.metadata.completionConfirmed = true;
        this.metadata.postHandoffTerminationReason = "goal-complete";
        return "null";
      }
      if (remainingBudget === 0) {
        this.metadata.postHandoffTerminationReason = "budget-exhausted";
        return "null";
      }
      if (candidateCount === 0) {
        this.metadata.candidateExhausted = true;
        this.metadata.postHandoffTerminationReason = "candidate-exhausted";
        return "null";
      }

      this.metadata.completionGateRejectionCount =
        (this.metadata.completionGateRejectionCount ?? 0) + 1;
      if (retryAttempt >= this.nullRetryLimit) {
        this.metadata.postHandoffTerminationReason = "null-retry-exhausted";
        return "null";
      }
      this.metadata.nullRetryCount = (this.metadata.nullRetryCount ?? 0) + 1;
    }

    this.metadata.postHandoffTerminationReason = "null-retry-exhausted";
    return "null";
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

  private createEscalatedPrompt(
    snapshot: RuntimePromptSnapshot,
    opportunity: OpportunityPreservationEvaluation,
    retryAttempt: number
  ): string {
    return createContinuationPrompt(snapshot, this.metadata, opportunity, retryAttempt);
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
  diagnosticPostEscalationStepBudget: number | null = null,
  opportunityPreservationEnabled = true,
  nullRetryLimit = 1
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
    diagnosticBudgetExhausted: false,
    policyVersion: opportunityPreservationEnabled ? "v2" : "v1",
    escalationTiming: "none",
    opportunityPreservingEscalation: false,
    initialSafeCandidateCount: undefined,
    initialPageFingerprint: undefined,
    safeCandidatesRemainingAtHandoff: undefined,
    opportunityRetainedAtHandoff: undefined,
    opportunityEvaluationAtHandoff: null,
    nullDecisionsAfterHandoff: [],
    nullRetryCount: 0,
    nullRecoveryCount: 0,
    completionGateRejectionCount: 0,
    completionConfirmed: false,
    candidateExhausted: false,
    postHandoffTerminationReason: "none",
    nullRetryLimit
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
  metadata: AdaptiveExecutionMetadata,
  opportunity: OpportunityPreservationEvaluation
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
    actionHistoryCharacterCount: JSON.stringify(priorActions).length,
    opportunity: structuredClone(opportunity),
    unexploredSafeCandidates: opportunity.safeUnexploredCandidates.map((candidate) =>
      structuredClone(candidate)
    ),
    opportunityRetained: metadata.opportunityRetainedAtHandoff,
    stateTransitionSummary: compactStateTransitions(metadata)
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

function parseResponseAction(response: string): BrowserAction | null {
  if (isNullAction(response) || response.length === 0) return null;
  try {
    return BrowserActionSchema.parse(JSON.parse(response));
  } catch {
    return null;
  }
}

function escalationTiming(
  decision: EscalationPolicyDecision
): AdaptiveEscalationTiming {
  if (decision.signals.includes("opportunity-preservation")) return "early";
  if (decision.signals.includes("exploration-exhausted")) return "exhaustion";
  return "stagnation";
}

function opportunityDecision(
  opportunity: OpportunityPreservationEvaluation
): EscalationPolicyDecision {
  const signals: EscalationPolicyDecision["signals"] = [
    "opportunity-preservation",
    ...(opportunity.discoveryOrientedGoal
      ? (["exploratory-objective"] as const)
      : (["semantic-uncertainty"] as const)),
    "high-branching-state",
    "next-action-narrows-state"
  ];
  return {
    escalate: true,
    signals,
    reason: `Opportunity-preserving handoff before a narrowing deterministic action (${opportunity.safeUnexploredCandidates.length} safe unexplored candidates).`
  };
}

function opportunityRetention(
  initialCandidates: number,
  currentCandidates: number
): number {
  if (initialCandidates <= 0) return currentCandidates > 0 ? 1 : 0;
  return Math.min(1, currentCandidates / initialCandidates);
}

function createContinuationPrompt(
  snapshot: RuntimePromptSnapshot,
  metadata: AdaptiveExecutionMetadata,
  opportunity: OpportunityPreservationEvaluation,
  retryAttempt: number
): string {
  const sensitiveValues = snapshot.actionHistory.flatMap((action) =>
    action.type === "type" ? [action.value] : []
  );
  const sanitize = (value: string): string =>
    sanitizeDiagnosticText(value, sensitiveValues);
  const observation = sanitizeObservation(snapshot.observation, sanitize);
  const actions = snapshot.actionHistory
    .slice(-5)
    .map((action) => sanitizeContinuationAction(action, sanitize));
  const candidates = opportunity.safeUnexploredCandidates
    .slice(0, 12)
    .map(
      (candidate) =>
        `${candidate.action.type}:${candidate.action.target ? sanitize(candidate.action.target) : "none"} (${sanitize(candidate.label)}; ${candidate.category})`
    );
  const retry =
    retryAttempt > 0
      ? [
          `- A previous null decision was rejected because ${candidates.length} safe unexplored candidate(s) remain.`,
          "- Reconsider the unresolved candidates and choose one useful safe action, or return null only with visible completion evidence."
        ]
      : [];
  return [
    "Adaptive execution context:",
    `- Handoff mode: ${metadata.escalationTiming ?? "stagnation"}.`,
    `- Handoff reason: ${sanitize(metadata.escalationReason ?? "Runtime escalation policy requested continuation.")}`,
    "- Continue from the current browser and Agent state; do not restart the task.",
    `- Remaining action budget at handoff: ${metadata.remainingStepBudgetAtHandoff ?? "unknown"}.`,
    `- Safe unexplored candidates with exact targets: ${JSON.stringify(candidates)}.`,
    "- Use only an exact selector or URL shown in the current observation and candidate list.",
    `- Progress summary: ${compactStateTransitions(metadata).join(" ") || "No prior transition summary."}`,
    "- Do not return null merely because earlier deterministic actions were attempted.",
    "- Return null only when the public goal is visibly satisfied, a requested failure is observed, or no useful safe action remains.",
    ...retry,
    `Goal: ${sanitize(snapshot.goal)}`,
    `Step: ${snapshot.actionHistory.length}`,
    `Current observation: ${JSON.stringify(observation)}`,
    `Previous actions: ${JSON.stringify(actions)}`,
    `Discovered bugs: ${JSON.stringify(snapshot.discoveredBugs.map(sanitize))}`
  ].join("\n");
}

function createV1ContinuationPrompt(
  snapshot: RuntimePromptSnapshot,
  metadata: AdaptiveExecutionMetadata,
  agentPrompt: string
): string {
  const sensitiveValues = snapshot.actionHistory.flatMap((action) =>
    action.type === "type" ? [action.value] : []
  );
  const sanitize = (value: string): string =>
    sanitizeDiagnosticText(value, sensitiveValues);
  return [
    "Adaptive execution context:",
    "- Deterministic execution stopped making sufficient runtime progress.",
    `- Escalation signals: ${metadata.escalationSignals.join(", ") || "runtime-stagnation"}.`,
    "- Continue from the current browser and Agent state; do not restart the task.",
    "- Do not return null merely because earlier deterministic actions were attempted.",
    "- Return null only when the public goal is visibly satisfied, a requested failure is observed, or no useful safe action remains.",
    "",
    sanitize(agentPrompt)
  ].join("\n");
}

function sanitizeObservation(
  observation: Observation,
  sanitize: (value: string) => string
): Observation {
  return {
    ...observation,
    url: sanitize(observation.url),
    title: sanitize(observation.title),
    metadata: {
      ...observation.metadata,
      url: sanitize(observation.metadata.url),
      title: sanitize(observation.metadata.title)
    },
    consoleErrors: observation.consoleErrors.map((error) => ({
      ...error,
      text: sanitize(error.text),
      location: error.location
        ? { ...error.location, url: sanitize(error.location.url) }
        : null
    })),
    accessibility: {
      ...observation.accessibility,
      headings: observation.accessibility.headings.map((heading) => ({
        ...heading,
        text: sanitize(heading.text)
      })),
      landmarks: observation.accessibility.landmarks.map((landmark) => ({
        ...landmark,
        name: landmark.name ? sanitize(landmark.name) : null
      }))
    },
    elements: observation.elements
      .filter((element) => element.visible)
      .map((element) => ({
        ...element,
        accessibleName: element.accessibleName
          ? sanitize(element.accessibleName)
          : null,
        text: sanitize(element.text),
        selector: sanitize(element.selector),
        href: element.href ? sanitize(element.href) : null
      })),
    textSample: sanitize(observation.textSample),
    screenshotPath: observation.screenshotPath
      ? sanitize(observation.screenshotPath)
      : null
  };
}

function sanitizeContinuationAction(
  action: BrowserAction,
  sanitize: (value: string) => string
): BrowserAction {
  if (action.type === "type") {
    return { ...action, selector: sanitize(action.selector), value: "[REDACTED]" };
  }
  if (action.type === "assert") {
    return {
      ...action,
      selector: sanitize(action.selector),
      containsText: sanitize(action.containsText)
    };
  }
  if ("selector" in action) return { ...action, selector: sanitize(action.selector) };
  if ("url" in action) return { ...action, url: sanitize(action.url) };
  if (action.type === "screenshot" && action.path) {
    return { ...action, path: sanitize(action.path) };
  }
  return { ...action };
}

function compactStateTransitions(metadata: AdaptiveExecutionMetadata): string[] {
  return metadata.progressEvents.slice(-3).map((event) => {
    const changes = [
      event.urlChanged ? "URL changed" : null,
      event.visibleTextChanged ? "visible text changed" : null,
      event.interactiveElementsChanged ? "controls changed" : null
    ].filter((value): value is string => value !== null);
    return `Step ${event.step}: ${event.progressed ? "progress" : "no progress"}${changes.length > 0 ? ` (${changes.join(", ")})` : ""}.`;
  });
}

function sanitizeOpportunityEvaluation(
  opportunity: OpportunityPreservationEvaluation,
  sensitiveValues: readonly string[]
): OpportunityPreservationEvaluation {
  const sanitize = (value: string): string =>
    sanitizeDiagnosticText(value, sensitiveValues);
  return {
    ...structuredClone(opportunity),
    safeUnexploredCandidates: opportunity.safeUnexploredCandidates.map((candidate) => ({
      ...candidate,
      label: sanitize(candidate.label),
      action: {
        ...candidate.action,
        target: candidate.action.target ? sanitize(candidate.action.target) : null
      }
    }))
  };
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
