import type {
  AdaptiveActionSummary,
  AdaptiveExecutionMetadata,
  AdaptiveHandoffSnapshot,
  AdaptivePolicyVersion,
  AdaptiveProgressEvent
} from "@vibeqa/adaptive-execution";
import type { BrowserAction, Observation } from "@vibeqa/schemas";

import type {
  AdaptiveExecutionMetrics,
  BenchmarkApplicationConfiguration,
  BenchmarkDifficulty,
  BenchmarkPlanner,
  DistributionStatistics,
  ExecutionPlanner,
  HybridRoutingMetrics,
  HybridRoutingDiagnostics,
  PlannerRoutingMetadata,
  RoutingRecommendationCategory,
  SafetyEventCounts
} from "./types.js";

export type GeneralizationScenarioCategory =
  "hidden_bug" | "ambiguous_goal" | "same_url_state" | "recovery";

export type GeneralizationClassification =
  | "HIDDEN_BUG_FOUND"
  | "GOAL_COMPLETED"
  | "HIDDEN_BUG_MISSED"
  | "GOAL_INCOMPLETE"
  | "AGENT_ERROR"
  | "SAFETY_BLOCKED"
  | "APPROVAL_REQUIRED";

export interface GeneralizationBugSignal {
  bugId: string;
  type: "console_error" | "post_action_state";
  textIncludes?: string;
  actionSelector?: string;
  disallowedInterveningActionSelectors?: string[];
  resultingUrlPath?: string;
  resultingTextIncludes?: string;
}

export interface GeneralizationGoalState {
  urlPath?: string;
  textIncludes?: string;
  requiresSameUrlStateChange?: boolean;
}

export interface GeneralizationEvaluatorOnly {
  expectedBugIds: string[];
  bugSignals: GeneralizationBugSignal[];
  goalState?: GeneralizationGoalState;
  hiddenTargetSelectors: string[];
  hiddenExpectedActions: string[];
  recommendedPlanner: ExecutionPlanner;
  recommendedPlannerCategory: RoutingRecommendationCategory;
}

export interface GeneralizationRoutingHints {
  mode: "functional" | "exploratory" | "regression";
  hasExpectedBehavior: boolean;
  exactWorkflowKnown: boolean;
  explicitlyExploratory: boolean;
  hiddenIssueDiscoveryRequested: boolean;
  recoveryRequired: boolean;
  sameUrlStateReasoning: boolean;
  semanticGoalAmbiguous: boolean;
}

export interface GeneralizationScenario {
  id: string;
  name: string;
  category: GeneralizationScenarioCategory;
  difficulty: BenchmarkDifficulty;
  startUrl: string;
  plannerGoal: string;
  hiddenExpectationSummary: string;
  maxSteps: number;
  credentialsRequirement: "none" | "benchmark-account";
  routingHints: GeneralizationRoutingHints;
  evaluatorOnly: GeneralizationEvaluatorOnly;
}

export interface GeneralizationScenarioSummary {
  id: string;
  name: string;
  category: GeneralizationScenarioCategory;
  difficulty: BenchmarkDifficulty;
  startUrl: string;
  plannerGoal: string;
  hiddenExpectationSummary: string;
  maxSteps: number;
  credentialsRequirement: "none" | "benchmark-account";
  routingHints: GeneralizationRoutingHints;
}

export interface GeneralizationPlannerInput {
  goal: string;
  startUrl: string;
  maxSteps: number;
}

export interface GeneralizationObservedState {
  fingerprint: string;
  normalizedUrl: string;
  observation: Observation;
  observationIndex: number;
  interactiveElementKeys: string[];
}

export interface GeneralizationActionRecord {
  action: BrowserAction;
  fromStateFingerprint: string | null;
  toStateFingerprint: string | null;
  success: boolean;
  error: string | null;
}

export type PlannerDecisionOutcome =
  | "valid_action"
  | "null_action"
  | "invalid_action"
  | "parser_failure"
  | "action_not_applicable";

export interface PlannerDecisionDiagnostic {
  outcome: PlannerDecisionOutcome;
  promptCharacterCount: number;
  observationCharacterCount: number;
  actionHistoryCount: number;
  responseCharacterCount: number;
  attempts: number;
  validationFailures: PlannerDecisionOutcome[];
  action: AdaptiveActionSummary | null;
  repeatedAction: boolean;
}

export type AdaptiveEscalationFailureReason =
  | "HANDOFF_CONTEXT_INSUFFICIENT"
  | "POST_ESCALATION_BUDGET_EXHAUSTED"
  | "PRE_ESCALATION_STATE_DAMAGE"
  | "GOAL_ALREADY_MISFRAMED"
  | "REPEATED_STATE_FALSE_TRIGGER"
  | "OLLAMA_INVALID_ACTION"
  | "OLLAMA_NON_PROGRESS_ACTION"
  | "EARLY_TERMINATION"
  | "EVALUATOR_COMPLETION_MISMATCH"
  | "SAFETY_BLOCK"
  | "BROWSER_ACTION_FAILURE"
  | "UNKNOWN_FAILURE";

export type AdaptiveTerminationReason =
  | "GOAL_COMPLETE"
  | "MAX_STEPS"
  | "PLANNER_NULL"
  | "EVALUATOR_STOP"
  | "ACTION_FAILURE"
  | "NO_PROGRESS_STOP"
  | "SAFETY_STOP"
  | "ESCALATION_FAILURE"
  | "OTHER";

export type RepeatedStateTriggerQuality =
  | "TRUE_STAGNATION"
  | "BENIGN_REPEAT"
  | "SEMANTIC_PROGRESS_SAME_FINGERPRINT"
  | "UNKNOWN";

export type OpportunityLossLevel = "none" | "low" | "medium" | "high";

export interface RepeatedStateTriggerAudit {
  currentFingerprint: string;
  previousMatchingFingerprint: string | null;
  actionsBetweenStates: AdaptiveActionSummary[];
  urlChanged: boolean;
  visibleTextChanged: boolean;
  interactiveElementsChanged: boolean;
  evaluatorReportedProgress: boolean | null;
  classification: RepeatedStateTriggerQuality;
}

export interface AdaptiveObservationSummary {
  fingerprint: string;
  url: string;
  title: string;
  visibleTextSummary: string;
  interactiveElementCount: number;
  consoleErrorCount: number;
}

export interface AdaptivePhaseTrace {
  phase: "deterministic" | "handoff" | "ollama";
  observations: AdaptiveObservationSummary[];
  actions: AdaptiveActionSummary[];
  failures: string[];
  pageFingerprints: string[];
  progressDecisions: AdaptiveProgressEvent[];
  evaluatorFeedback: string[];
  durationMs: number | null;
  remainingStepBudget: number | null;
  goalRepresentation: string;
  actionHistorySummary: AdaptiveActionSummary[];
}

export interface AdaptiveOpportunityLoss {
  level: OpportunityLossLevel;
  factors: string[];
  initialInteractiveElementCount: number;
  handoffInteractiveElementCount: number;
  unexploredInteractiveElementCount: number;
  startAndHandoffStateMatch: boolean;
}

export interface AdaptiveRunDiagnostics {
  handoffSnapshot: AdaptiveHandoffSnapshot | null;
  phases: AdaptivePhaseTrace[];
  terminationReason: AdaptiveTerminationReason;
  primaryFailureReason: AdaptiveEscalationFailureReason | null;
  contributingFactors: AdaptiveEscalationFailureReason[];
  repeatedStateAudits: RepeatedStateTriggerAudit[];
  opportunityLoss: AdaptiveOpportunityLoss;
  totalMaxSteps: number;
  stepsConsumedBeforeEscalation: number;
  remainingStepsAtHandoff: number;
  actualPostEscalationSteps: number;
  postEscalationEndReason: AdaptiveTerminationReason;
  plannerDecisions: PlannerDecisionDiagnostic[];
  promptContext: {
    firstOllamaPromptCharacters: number | null;
    firstOllamaObservationCharacters: number | null;
    firstOllamaActionHistoryCount: number | null;
    handoffPromptCharacters: number | null;
    handoffActionHistoryCharacters: number | null;
  };
}

export interface GeneralizationExecution {
  goalCompleted: boolean;
  detectedBugIds: string[];
  infrastructureError: string | null;
  durationMs: number;
  plannerDurationMs?: number | null;
  safetyEvents: SafetyEventCounts;
  observations: GeneralizationObservedState[];
  actions: GeneralizationActionRecord[];
  discoveryStep: number | null;
  completionStep: number | null;
  uniqueStatesBeforeDiscovery: number;
  uniqueElementsBeforeDiscovery: number;
  approvalRequired: boolean;
  safetyBlocked: boolean;
  routing?: PlannerRoutingMetadata | null;
  adaptive?: AdaptiveExecutionMetadata | null;
  plannerDecisions?: PlannerDecisionDiagnostic[];
  agentCompleted?: boolean;
  agentStepCount?: number;
  adaptiveDiagnostics?: AdaptiveRunDiagnostics | null;
}

export interface GeneralizationRun extends GeneralizationExecution {
  id: string;
  scenarioId: string;
  scenarioName: string;
  category: GeneralizationScenarioCategory;
  difficulty: BenchmarkDifficulty;
  planner: BenchmarkPlanner;
  modelName: string | null;
  repetition: number;
  startedAt: string;
  maxSteps: number;
  classification: GeneralizationClassification;
  expectedBugIds: string[];
  usefulNewStates: number;
  detourActions: number;
  revisitedStates: number;
  recoveryRequired: boolean;
  recoverySucceeded: boolean;
}

export interface StepBudgetMetrics {
  within5Steps: number;
  within10Steps: number;
  withinMaxSteps: number;
}

export interface WilsonConfidenceInterval {
  confidenceLevel: 0.95;
  successes: number;
  attempts: number;
  lower: number;
  upper: number;
}

export interface GeneralizationConfidenceIntervals {
  autonomousDiscovery: WilsonConfidenceInterval;
  goalCompletion: WilsonConfidenceInterval;
  recoverySuccess: WilsonConfidenceInterval;
  expectedOutcome: WilsonConfidenceInterval;
}

export interface GeneralizationPerformanceMetrics {
  totalRuns: number;
  successfulRuns: number;
  hiddenBugOpportunities: number;
  hiddenBugDetections: number;
  ambiguousGoalOpportunities: number;
  ambiguousGoalCompletions: number;
  recoveryOpportunities: number;
  recoverySuccesses: number;
  autonomousDiscoveryRate: number;
  goalCompletionRate: number;
  explorationEfficiency: number;
  detourRate: number;
  stateRevisitRate: number;
  recoverySuccessRate: number;
  averageStepCount: number;
  medianStepCount: number;
  averageDurationMs: number;
  medianDurationMs: number;
  plannerDurationSampleCount: number;
  averagePlannerDurationMs: number | null;
  medianPlannerDurationMs: number | null;
  repeatedRunStability: number;
  averageUniqueStates: number;
  timeToDiscovery: DistributionStatistics;
  averageUniqueStatesBeforeDiscovery: number;
  averageUniqueElementsBeforeDiscovery: number;
  stepBudgetSuccess: StepBudgetMetrics;
  confidenceIntervals: GeneralizationConfidenceIntervals;
}

export interface GeneralizationScenarioMetrics extends GeneralizationPerformanceMetrics {
  scenarioId: string;
  scenarioName: string;
  category: GeneralizationScenarioCategory;
  difficulty: BenchmarkDifficulty;
}

export interface GeneralizationPlannerMetrics extends GeneralizationPerformanceMetrics {
  planner: BenchmarkPlanner;
  modelName: string | null;
}

export interface GeneralizationScenarioPlannerMetrics extends GeneralizationScenarioMetrics {
  planner: BenchmarkPlanner;
  modelName: string | null;
}

export interface GeneralizationMetrics extends GeneralizationPerformanceMetrics {
  plannerPerformance: GeneralizationPlannerMetrics[];
  scenarioPerformance: GeneralizationScenarioMetrics[];
  scenarioPlannerPerformance: GeneralizationScenarioPlannerMetrics[];
  difficultyPerformance: Array<
    GeneralizationPerformanceMetrics & { difficulty: BenchmarkDifficulty }
  >;
  hybridRouting: HybridRoutingMetrics | null;
  hybridDiagnostics: HybridRoutingDiagnostics | null;
  adaptiveExecution: AdaptiveExecutionMetrics | null;
  adaptiveFailureAnalysis: AdaptiveFailureAnalysisMetrics | null;
}

export interface AdaptiveScenarioFailureMetrics {
  scenarioId: string;
  deterministicSuccessRate: number | null;
  ollamaSuccessRate: number | null;
  hybridSuccessRate: number | null;
  adaptiveSuccessRate: number | null;
  escalationRate: number;
  successfulEscalationRate: number;
  dominantFailureReason: AdaptiveEscalationFailureReason | null;
  averagePreEscalationSteps: number;
  averagePostEscalationSteps: number;
  terminationReasonCounts: Record<AdaptiveTerminationReason, number>;
  repeatedStateFalseTriggerRate: number;
  opportunityLoss: OpportunityLossLevel;
}

export interface PureVsEscalatedComparison {
  scenarioId: string;
  pureOllamaRuns: number;
  escalatedOllamaRuns: number;
  sameStartingStateRate: number;
  averagePureOllamaStepsAvailable: number;
  averageEscalatedStepsAvailable: number;
  averagePurePromptCharacters: number;
  averageEscalatedPromptCharacters: number;
  averagePriorActionsAtHandoff: number;
  averageUnexploredElementsAtHandoff: number;
  pureHiddenDiscoveryRate: number;
  escalatedHiddenDiscoveryRate: number;
  pureGoalCompletionRate: number;
  escalatedGoalCompletionRate: number;
  pureRecoveryRate: number;
  escalatedRecoveryRate: number;
  averagePureStatesBeforeDiscovery: number;
  averagePureActionsBeforeDiscovery: number;
  averagePureDiscoveryDurationMs: number;
  averageAdaptiveStatesBeforeEscalation: number;
  averageAdaptivePostEscalationActions: number;
  pureDiscoveryPathShape: string;
  adaptivePreEscalationPathShape: string;
  dominantAdaptiveFailureReason: AdaptiveEscalationFailureReason | null;
}

export interface AdaptiveFailureAnalysisMetrics {
  totalEscalatedRuns: number;
  failedEscalatedRuns: number;
  failureTaxonomyCounts: Record<AdaptiveEscalationFailureReason, number>;
  contributingFactorCounts: Record<AdaptiveEscalationFailureReason, number>;
  terminationReasonCounts: Record<AdaptiveTerminationReason, number>;
  repeatedStateTriggerCounts: Record<RepeatedStateTriggerQuality, number>;
  repeatedStateFalseTriggerRate: number;
  meanRemainingBudgetAtEscalation: number;
  meanActualPostEscalationSteps: number;
  opportunityLossCounts: Record<OpportunityLossLevel, number>;
  plannerDecisionCounts: Record<PlannerDecisionOutcome, number>;
  scenarioFailures: AdaptiveScenarioFailureMetrics[];
  pureVsEscalated: PureVsEscalatedComparison[];
}

export interface GeneralizationConfiguration {
  benchmarkSuiteVersion: "3.0.0";
  runsPerScenario: number;
  scenarioCount: number;
  executionsPerPlanner: number;
  totalExecutions: number;
  scenarioIds: string[];
  scenarioFilter: string[];
  difficultyFilter: BenchmarkDifficulty[];
  planners: BenchmarkPlanner[];
  plannerModels: Partial<Record<BenchmarkPlanner, string>>;
  browserIsolation: "fresh-context-per-run";
  gitCommitSha: string | null;
  benchmarkApplication: BenchmarkApplicationConfiguration;
  randomSeed: null;
  adaptiveDebugReplay: boolean;
  adaptivePostEscalationStepBudget: number | null;
  adaptivePolicyVersion: AdaptivePolicyVersion;
}

export interface GeneralizationSuiteResult {
  suite: "generalization-v3";
  suiteId: string;
  generatedAt: string;
  configuration: GeneralizationConfiguration;
  scenarios: GeneralizationScenarioSummary[];
  runs: GeneralizationRun[];
  metrics: GeneralizationMetrics;
}

export interface GeneralizationRunOptions {
  runsPerScenario?: number;
  scenarioIds?: readonly string[];
  difficulties?: readonly BenchmarkDifficulty[];
  planners?: readonly BenchmarkPlanner[];
}

export interface GeneralizationScenarioExecutor {
  execute(
    scenario: GeneralizationScenario,
    repetition: number,
    planner: BenchmarkPlanner
  ): Promise<GeneralizationExecution>;
}
