import type {
  EscalationPolicyDecision,
  EscalationPolicyInput,
  EscalationSignal,
  ProgressiveEscalationPolicyConfig,
  ThresholdAnalysisProfile
} from "./types.js";

export const DEFAULT_PROGRESSIVE_ESCALATION_CONFIG: ProgressiveEscalationPolicyConfig =
  {
    maxDeterministicStepsBeforeEscalation: 4,
    repeatedStateThreshold: 2,
    failedActionThreshold: 2,
    noProgressThreshold: 3,
    maxEscalations: 1
  };

export const ADAPTIVE_THRESHOLD_PROFILES: readonly ThresholdAnalysisProfile[] = [
  {
    name: "conservative",
    config: {
      maxDeterministicStepsBeforeEscalation: 5,
      noProgressThreshold: 4,
      failedActionThreshold: 3,
      repeatedStateThreshold: 3,
      maxEscalations: 1
    }
  },
  {
    name: "balanced",
    config: { ...DEFAULT_PROGRESSIVE_ESCALATION_CONFIG }
  },
  {
    name: "aggressive",
    config: {
      maxDeterministicStepsBeforeEscalation: 3,
      noProgressThreshold: 2,
      failedActionThreshold: 1,
      repeatedStateThreshold: 2,
      maxEscalations: 1
    }
  }
];

export class ProgressiveEscalationStrategy {
  readonly config: ProgressiveEscalationPolicyConfig;

  constructor(config: Partial<ProgressiveEscalationPolicyConfig> = {}) {
    this.config = { ...DEFAULT_PROGRESSIVE_ESCALATION_CONFIG, ...config };
    validateConfig(this.config);
  }

  evaluate(
    input: EscalationPolicyInput,
    escalationCount: number
  ): EscalationPolicyDecision {
    if (escalationCount >= this.config.maxEscalations) {
      return { escalate: false, signals: [], reason: "Maximum escalations reached." };
    }

    const signals: EscalationSignal[] = [];
    if (
      !input.progressed &&
      input.repeatedStateCount >= this.config.repeatedStateThreshold
    ) {
      signals.push("repeated-state");
    }
    if (input.noProgressCount >= this.config.noProgressThreshold) {
      signals.push("no-progress");
    }
    if (input.failedActionCount >= this.config.failedActionThreshold) {
      signals.push("repeated-failed-actions");
    }
    if (input.evaluationFailureCount >= this.config.failedActionThreshold) {
      signals.push("evaluation-failure");
    }
    if (input.recoveryRequired && input.noProgressCount > 0) {
      signals.push("recovery-stalled");
    }
    if (input.deterministicExhausted) {
      signals.push("exploration-exhausted");
    }
    if (input.deterministicSteps >= this.config.maxDeterministicStepsBeforeEscalation) {
      signals.push("deterministic-budget-exhausted");
    }

    return signals.length > 0
      ? {
          escalate: true,
          signals: [...new Set(signals)],
          reason: `Runtime progress monitoring detected: ${[...new Set(signals)].join(", ")}.`
        }
      : {
          escalate: false,
          signals: [],
          reason: "Deterministic progress remains sufficient."
        };
  }
}

function validateConfig(config: ProgressiveEscalationPolicyConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isInteger(value) || value < (name === "maxEscalations" ? 0 : 1)) {
      throw new Error(`Invalid progressive escalation threshold: ${name}.`);
    }
  }
}
