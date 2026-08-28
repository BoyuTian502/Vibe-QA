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
  currentFingerprint: string;
  previousMatchingFingerprint: string | null;
  actionsSincePreviousMatch: AdaptiveActionSummary[];
  urlChanged: boolean;
  visibleTextChanged: boolean;
  interactiveElementsChanged: boolean;
  evaluatorReportedProgress: boolean | null;
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
  currentFingerprint: string;
  previousMatchingFingerprint: string | null;
  actionsSincePreviousMatch: AdaptiveActionSummary[];
  urlChanged: boolean;
  visibleTextChanged: boolean;
  interactiveElementsChanged: boolean;
  evaluatorReportedProgress: boolean | null;
  repeatedStateCount: number;
  noProgressCount: number;
  failedActionCount: number;
  evaluationFailureCount: number;
  signals: EscalationSignal[];
}

export interface AdaptiveActionSummary {
  type: BrowserAction["type"];
  target: string | null;
}

export interface AdaptiveInteractiveElementSnapshot {
  tagName: string;
  role: string | null;
  accessibleName: string | null;
  text: string;
  selector: string;
  href: string | null;
  enabled: boolean;
  editable: boolean;
}

export interface AdaptiveHandoffSnapshot {
  goal: string;
  currentUrl: string;
  pageTitle: string;
  visibleTextSummary: string;
  interactiveElements: AdaptiveInteractiveElementSnapshot[];
  accessibility: Observation["accessibility"];
  pageFingerprint: string;
  priorDeterministicActions: AdaptiveActionSummary[];
  failedOrNoProgressActions: AdaptiveActionSummary[];
  discoveredBugs: string[];
  progressHistory: AdaptiveProgressEvent[];
  escalationSignals: EscalationSignal[];
  escalationReason: string;
  totalMaxSteps: number | null;
  remainingStepBudget: number | null;
  evaluatorStatus: {
    progressed: boolean;
    reasons: string[];
  };
  memorySummary: {
    actionCount: number;
    discoveredBugCount: number;
    recentActionTypes: BrowserAction["type"][];
  };
  promptCharacterCount: number;
  actionHistoryCharacterCount: number;
}

export type AdaptivePlannerDecisionOutcome =
  "valid_action" | "null_action" | "diagnostic_budget_stop" | "generation_error";

export interface AdaptivePlannerDecision {
  phase: AdaptivePlannerPhase;
  invocation: number;
  outcome: AdaptivePlannerDecisionOutcome;
  action: AdaptiveActionSummary | null;
  promptCharacterCount: number;
  responseCharacterCount: number;
  actionHistoryCount: number;
  pageFingerprint: string;
  durationMs: number;
  error: string | null;
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
  maxSteps: number | null;
  remainingStepBudgetAtHandoff: number | null;
  handoffSnapshot: AdaptiveHandoffSnapshot | null;
  plannerDecisions: AdaptivePlannerDecision[];
  diagnosticReplay: boolean;
  diagnosticPostEscalationStepBudget: number | null;
  diagnosticBudgetExhausted: boolean;
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
