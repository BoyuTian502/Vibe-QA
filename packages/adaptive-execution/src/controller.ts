import type { LLMClient } from "@vibeqa/llm";
import type { BrowserAction, Observation } from "@vibeqa/schemas";

import { ProgressiveEscalationStrategy } from "./escalation-policy.js";
import { DeterministicProgressEvaluator } from "./progress-evaluator.js";
import type {
  AdaptiveExecutionMetadata,
  EscalationPolicyDecision,
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
    this.metadata = initialMetadata();
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
        const terminalResponse =
          await this.options.deterministicClient.generate(prompt);
        this.recordPlannedAction(terminalResponse, "deterministic");
        return terminalResponse;
      }
      const policyDecision = this.policy.evaluate(
        { ...progress, deterministicSteps: this.deterministicSteps },
        this.escalationCount
      );
      this.recordProgress(progress, policyDecision);
      if (policyDecision.escalate) {
        await this.tryEscalation(policyDecision);
      }
    }

    if (this.phase === "ollama") {
      this.ollamaInvocationCount += 1;
      const response = await this.options.ollamaClient.generate(
        this.createEscalatedPrompt(prompt)
      );
      this.recordPlannedAction(response, "ollama");
      return response;
    }

    const response = await this.options.deterministicClient.generate(prompt);
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
      await this.tryEscalation(exhausted);
      if ((this.phase as string) === "ollama") {
        this.ollamaInvocationCount += 1;
        const ollamaResponse = await this.options.ollamaClient.generate(
          this.createEscalatedPrompt(prompt)
        );
        this.recordPlannedAction(ollamaResponse, "ollama");
        return ollamaResponse;
      }
    }
    this.recordPlannedAction(response, "deterministic");
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

  private async tryEscalation(decision: EscalationPolicyDecision): Promise<void> {
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
      this.metadata.timeBeforeEscalationMs = Math.max(
        0,
        this.escalatedAt - this.startedAt
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

  private recordPlannedAction(
    response: string,
    planner: "deterministic" | "ollama"
  ): void {
    if (isNullAction(response)) return;
    if (planner === "deterministic") this.deterministicSteps += 0;
    else this.ollamaSteps += 0;
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

function initialMetadata(): AdaptiveExecutionMetadata {
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
    escalationFailure: null
  };
}

function parseRuntimePrompt(prompt: string): {
  observation: Observation;
  actionHistory: BrowserAction[];
} {
  const observationMatch = /Current observation: (\{.*\})\nPrevious actions:/s.exec(
    prompt
  );
  const actionsMatch = /Previous actions: (\[.*\])\nDiscovered bugs:/s.exec(prompt);
  if (!observationMatch?.[1] || !actionsMatch?.[1]) {
    throw new Error("Adaptive execution requires the standard Agent runtime prompt.");
  }
  return {
    observation: JSON.parse(observationMatch[1]) as Observation,
    actionHistory: JSON.parse(actionsMatch[1]) as BrowserAction[]
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
