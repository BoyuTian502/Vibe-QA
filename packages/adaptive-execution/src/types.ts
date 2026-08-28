import type { BrowserAction, Observation } from "@vibeqa/schemas";

export type AdaptivePlannerPhase = "deterministic" | "ollama";

export type EscalationSignal =
  | "repeated-state"
  | "no-progress"
  | "repeated-failed-actions"
  | "evaluation-failure"
  | "recovery-stalled"
  | "exploration-exhausted"
  | "deterministic-budget-exhausted";

export interface ProgressiveEscalationPolicyConfig {
  maxDeterministicStepsBeforeEscalation: number;
  repeatedStateThreshold: number;
  failedActionThreshold: number;
  noProgressThreshold: number;
  maxEscalations: number;
}

export interface ProgressEvaluation {
  progressed: boolean;
  reasons: string[];
  repeatedStateCount: number;
  noProgressCount: number;
  failedActionCount: number;
  evaluationFailureCount: number;
}

export interface RuntimeProgressInput {
  observation: Observation;
  actionHistory: readonly BrowserAction[];
  lastActionSucceeded?: boolean;
  evaluatorProgressed?: boolean | null;
  recoveryRequired?: boolean;
}

export interface EscalationPolicyInput extends ProgressEvaluation {
  deterministicSteps: number;
  deterministicExhausted?: boolean;
  recoveryRequired?: boolean;
}

export interface EscalationPolicyDecision {
  escalate: boolean;
  signals: EscalationSignal[];
  reason: string;
}

export interface AdaptiveProgressEvent {
  step: number;
  progressed: boolean;
  reasons: string[];
  repeatedStateCount: number;
  noProgressCount: number;
  failedActionCount: number;
  evaluationFailureCount: number;
  signals: EscalationSignal[];
}

export interface AdaptiveExecutionMetadata {
  requestedStrategy: "adaptive";
  startingPlanner: "deterministic";
  escalationRequired: boolean;
  escalationOccurred: boolean;
  escalationSucceeded: boolean;
  ollamaAvailable: boolean | null;
  degradedExecution: boolean;
  escalationStep: number | null;
  escalationSignals: EscalationSignal[];
  escalationReason: string | null;
  plannerBefore: "deterministic";
  plannerAfter: "ollama" | null;
  deterministicSteps: number;
  ollamaSteps: number;
  totalSteps: number;
  timeBeforeEscalationMs: number | null;
  timeAfterEscalationMs: number | null;
  ollamaInvocationCount: number;
  finalOutcome: boolean | null;
  progressEvents: AdaptiveProgressEvent[];
  escalationFailure: string | null;
}

export type EscalationUtility =
  | "USEFUL_ESCALATION"
  | "UNNECESSARY_ESCALATION"
  | "FAILED_ESCALATION"
  | "NO_ESCALATION_NEEDED";

export interface ThresholdAnalysisProfile {
  name: "conservative" | "balanced" | "aggressive";
  config: ProgressiveEscalationPolicyConfig;
}
