import type { BrowserAction, Observation } from "@vibeqa/schemas";

export type AdaptivePlannerPhase = "deterministic" | "ollama";

export type AdaptivePolicyVersion = "v1" | "v2";

export type AdaptiveEscalationTiming = "none" | "early" | "stagnation" | "exhaustion";

export type EscalationSignal =
  | "repeated-state"
  | "no-progress"
  | "repeated-failed-actions"
  | "evaluation-failure"
  | "recovery-stalled"
  | "exploration-exhausted"
  | "deterministic-budget-exhausted"
  | "opportunity-preservation"
  | "exploratory-objective"
  | "semantic-uncertainty"
  | "high-branching-state"
  | "next-action-narrows-state";

export type OpportunityRisk = "low" | "medium" | "high";

export type OpportunityReason =
  | "known-workflow"
  | "exploratory-objective"
  | "semantic-uncertainty"
  | "high-branching-state"
  | "multiple-navigation-destinations"
  | "diverse-controls"
  | "multiple-page-regions"
  | "next-action-narrows-state"
  | "limited-unexplored-opportunity";

export interface OpportunityCandidate {
  action: AdaptiveActionSummary;
  label: string;
  category: string;
}

export interface OpportunityPreservationEvaluation {
  risk: OpportunityRisk;
  reasons: OpportunityReason[];
  score: number;
  discoveryOrientedGoal: boolean;
  semanticJudgmentGoal: boolean;
  highBranchingState: boolean;
  nextActionNarrowsState: boolean;
  safeUnexploredCandidates: OpportunityCandidate[];
  distinctNavigationDestinations: number;
  semanticControlDiversity: number;
  unexploredPageRegions: number;
  shouldEscalateBeforeAction: boolean;
}

export interface SemanticCompletionEvaluation {
  confirmed: boolean;
  reason: string;
  evidence: string[];
}

export type AdaptiveNullDecisionClassification =
  | "legitimate-completion"
  | "no-useful-action"
  | "premature-unresolved-candidates"
  | "budget-exhausted"
  | "retry-limit-exhausted";

export interface AdaptiveNullDecision {
  invocation: number;
  classification: AdaptiveNullDecisionClassification;
  completionConfirmed: boolean;
  safeCandidateCount: number;
  remainingBudget: number | null;
  retryAttempt: number;
}

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
  opportunity?: OpportunityPreservationEvaluation;
  unexploredSafeCandidates?: OpportunityCandidate[];
  opportunityRetained?: number;
  stateTransitionSummary?: string[];
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
  policyVersion?: AdaptivePolicyVersion;
  escalationTiming?: AdaptiveEscalationTiming;
  opportunityPreservingEscalation?: boolean;
  initialSafeCandidateCount?: number;
  initialPageFingerprint?: string;
  safeCandidatesRemainingAtHandoff?: number;
  opportunityRetainedAtHandoff?: number;
  opportunityEvaluationAtHandoff?: OpportunityPreservationEvaluation | null;
  nullDecisionsAfterHandoff?: AdaptiveNullDecision[];
  nullRetryCount?: number;
  nullRecoveryCount?: number;
  completionGateRejectionCount?: number;
  completionConfirmed?: boolean;
  candidateExhausted?: boolean;
  postHandoffTerminationReason?:
    | "none"
    | "goal-complete"
    | "candidate-exhausted"
    | "budget-exhausted"
    | "null-retry-exhausted"
    | "generation-error";
  nullRetryLimit?: number;
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
