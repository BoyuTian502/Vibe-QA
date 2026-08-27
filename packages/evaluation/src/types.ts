export type BenchmarkMode = "functional" | "exploratory" | "regression";

export type BenchmarkDifficulty = "easy" | "medium" | "hard";

export type ExecutionPlanner = "deterministic" | "ollama";

export type BenchmarkPlanner = ExecutionPlanner | "hybrid";

export type RoutingConfidence = "high" | "medium" | "low";

export type RoutingRecommendationCategory =
  "deterministic-preferred" | "ollama-preferred" | "mixed";

export interface RoutingTaskMetadataSnapshot {
  mode: BenchmarkMode;
  hasExpectedBehavior: boolean;
  exactWorkflowKnown: boolean;
  explicitlyExploratory: boolean;
  hiddenIssueDiscoveryRequested: boolean;
  recoveryRequired: boolean;
  sameUrlStateReasoning: boolean;
  semanticGoalAmbiguous: boolean;
  maxSteps: number | null;
  authenticationRequired: boolean;
}

export interface PlannerRoutingMetadata {
  requestedStrategy: "hybrid";
  selectedPlanner: ExecutionPlanner;
  executedPlanner: ExecutionPlanner | null;
  routingRule: string;
  routingReason: string;
  routerVersion?: "v1" | "v2";
  routingConfidence?: RoutingConfidence;
  taskMetadata?: RoutingTaskMetadataSnapshot;
  fallback: boolean;
  fallbackReason: "ollama-unavailable" | null;
  recommendedPlanner: ExecutionPlanner | null;
  recommendedCategory?: RoutingRecommendationCategory | null;
  matchedRecommendation: boolean | null;
}

export interface HybridRoutingMetrics {
  totalHybridRuns: number;
  selectedPlannerCounts: Record<ExecutionPlanner, number>;
  selectedPlannerDistribution: Record<ExecutionPlanner, number>;
  executedPlannerCounts: Record<ExecutionPlanner, number>;
  fallbackCount: number;
  ollamaUnavailableFallbackCount: number;
  unavailableExecutionCount: number;
  routingAccuracyAttempts: number;
  routingAccuracyMatches: number;
  routingAccuracyRate: number;
  routingRuleCounts: Record<string, number>;
  routingReasonCounts: Record<string, number>;
  confidenceCounts: Record<RoutingConfidence, number>;
  lowConfidenceRuns: number;
  lowConfidenceSuccessfulRuns: number;
  lowConfidenceSuccessRate: number;
}

export interface RoutingConfusionMatrix {
  deterministic: Record<RoutingRecommendationCategory, number>;
  ollama: Record<RoutingRecommendationCategory, number>;
}

export interface RoutingAgreementBreakdown {
  key: string;
  attempts: number;
  matches: number;
  rate: number;
}

export interface RoutingOutcomePerformance {
  runs: number;
  successfulRuns: number;
  successRate: number;
}

export interface RoutingRegretEstimate {
  scenarioId: string;
  selectedPlanner: ExecutionPlanner;
  alternativePlanner: ExecutionPlanner;
  selectedPlannerHistoricalSuccessRate: number | null;
  alternativePlannerHistoricalSuccessRate: number | null;
  estimatedDifference: number | null;
  materiallyWorse: boolean;
}

export interface HybridRoutingExecutionDiagnostic {
  scenarioId: string;
  taskCategory: string;
  taskMode: BenchmarkMode;
  taskMetadata: RoutingTaskMetadataSnapshot | null;
  routingRule: string;
  confidence: RoutingConfidence | null;
  selectedPlanner: ExecutionPlanner;
  executedPlanner: ExecutionPlanner | null;
  fallback: boolean;
  classification: string;
  taskSuccess: boolean;
  hiddenBugDiscovered: boolean | null;
  recoverySuccess: boolean | null;
  durationMs: number;
  steps: number;
  explorationEfficiency: number | null;
  revisitRate: number | null;
  detourRate: number | null;
  recommendedCategory: RoutingRecommendationCategory | null;
  routingAgreed: boolean | null;
  regret: RoutingRegretEstimate;
}

export interface HybridRulePerformance {
  ruleId: string;
  uses: number;
  selectedPlanner: ExecutionPlanner | "mixed";
  taskSuccessRate: number;
  hiddenBugDiscoveryRate: number | null;
  recoverySuccessRate: number | null;
  averageDurationMs: number;
  stability: number;
  routingAgreementRate: number;
  routingAgreementAttempts: number;
  estimatedRoutingRegretRate: number;
}

export interface HybridConfidencePerformance {
  confidence: RoutingConfidence;
  runs: number;
  successfulRuns: number;
  successRate: number;
}

export interface HybridRoutingDiagnostics {
  regretThreshold: number;
  executions: HybridRoutingExecutionDiagnostic[];
  confusionMatrix: RoutingConfusionMatrix;
  routingAgreementAttempts: number;
  routingAgreementMatches: number;
  routingAgreementRate: number;
  agreementByScenario: RoutingAgreementBreakdown[];
  agreementByCategory: RoutingAgreementBreakdown[];
  agreedOutcomePerformance: RoutingOutcomePerformance;
  disagreedOutcomePerformance: RoutingOutcomePerformance;
  rulePerformance: HybridRulePerformance[];
  confidencePerformance: HybridConfidencePerformance[];
  routingRegretCount: number;
  routingRegretRate: number;
  v1EstimatedRoutingAgreementRate: number;
  v1EstimatedRoutingRegretCount: number;
  v1EstimatedRoutingRegretRate: number;
  estimatedRoutingRegretImprovement: number;
  scenarioMisroutes: HybridRoutingExecutionDiagnostic[];
}

export type BenchmarkClassification =
  | "PASS"
  | "EXPECTED_BUG_FOUND"
  | "MISSED_BUG"
  | "FALSE_POSITIVE"
  | "AGENT_ERROR"
  | "SAFETY_BLOCKED"
  | "APPROVAL_REQUIRED";

export type BenchmarkSuccessCriteria =
  | { type: "test_passed" }
  | { type: "seeded_bug_detected"; bugId: string }
  | {
      type: "exploration_coverage";
      minUniquePageStates: number;
      minInteractiveElements: number;
      minCandidateActions: number;
    };

export interface BenchmarkScenario {
  id: string;
  name: string;
  mode: BenchmarkMode;
  difficulty: BenchmarkDifficulty;
  startUrl: string;
  objective: string;
  expectedOutcome: string;
  expectedBugId: string | null;
  maxSteps: number;
  credentialsRequirement: "none" | "benchmark-account";
  successCriteria: BenchmarkSuccessCriteria;
}

export interface SafetyEventCounts {
  allowed: number;
  blocked: number;
  approvalRequired: number;
}

export interface ExplorationBenchmarkDetails {
  uniquePageStates: number;
  uniqueInteractiveElements: number;
  candidateActionsAttempted: number;
  coverageScore: number;
  terminationReason: string | null;
}

export interface BenchmarkExecution {
  expectedOutcomeMet: boolean;
  detectedBugIds: string[];
  reportedBugCount: number;
  infrastructureError: string | null;
  stepCount: number;
  durationMs: number;
  safetyEvents: SafetyEventCounts;
  exploration: ExplorationBenchmarkDetails | null;
  routing?: PlannerRoutingMetadata | null;
}

export interface BenchmarkRun {
  id: string;
  scenarioId: string;
  scenarioName: string;
  repetition: number;
  mode: BenchmarkMode;
  difficulty: BenchmarkDifficulty;
  planner: BenchmarkPlanner;
  modelName: string | null;
  startedAt: string;
  classification: BenchmarkClassification;
  expectedOutcomeMet: boolean;
  expectedBugId: string | null;
  detectedBugIds: string[];
  reportedBugCount: number;
  infrastructureError: string | null;
  stepCount: number;
  durationMs: number;
  safetyEvents: SafetyEventCounts;
  exploration: ExplorationBenchmarkDetails | null;
  routing?: PlannerRoutingMetadata | null;
}

export interface DistributionStatistics {
  count: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  standardDeviation: number;
}

export interface BenchmarkPerformanceMetrics {
  totalRuns: number;
  expectedBugOpportunities: number;
  cleanRunOpportunities: number;
  taskSuccessRate: number;
  bugDetectionRate: number;
  falsePositiveRate: number;
  infrastructureErrorRate: number;
  repeatedRunStability: number;
  averageStepCount: number;
  medianStepCount: number;
  averageDurationMs: number;
  medianDurationMs: number;
  averageUniquePageStates: number;
  averageCandidateActionsAttempted: number;
  averageUniqueInteractiveElements: number;
  averageCoverageScore: number;
}

export interface ScenarioBenchmarkMetrics {
  scenarioId: string;
  scenarioName: string;
  mode: BenchmarkMode;
  difficulty: BenchmarkDifficulty;
  totalRuns: number;
  expectedOutcomes: number;
  expectedOutcomeRate: number;
  classifications: Record<BenchmarkClassification, number>;
}

export interface ModeBenchmarkMetrics extends BenchmarkPerformanceMetrics {
  mode: BenchmarkMode;
}

export interface DifficultyBenchmarkMetrics extends BenchmarkPerformanceMetrics {
  difficulty: BenchmarkDifficulty;
}

export interface PlannerBenchmarkMetrics extends BenchmarkPerformanceMetrics {
  planner: BenchmarkPlanner;
  modelName: string | null;
}

export interface BenchmarkMetrics extends BenchmarkPerformanceMetrics {
  stepCount: DistributionStatistics;
  durationMs: DistributionStatistics;
  safetyEvents: SafetyEventCounts;
  scenarioResults: ScenarioBenchmarkMetrics[];
  modePerformance: ModeBenchmarkMetrics[];
  difficultyPerformance: DifficultyBenchmarkMetrics[];
  plannerPerformance: PlannerBenchmarkMetrics[];
  hybridRouting: HybridRoutingMetrics | null;
  hybridDiagnostics: HybridRoutingDiagnostics | null;
}

export interface BenchmarkApplicationConfiguration {
  name: string;
  version: string;
  configuration: string;
}

export interface BenchmarkConfiguration {
  runsPerScenario: number;
  scenarioIds: string[];
  scenarioFilter: string[];
  modeFilter: BenchmarkMode[];
  difficultyFilter: BenchmarkDifficulty[];
  planner: BenchmarkPlanner;
  planners: BenchmarkPlanner[];
  plannerModels: Partial<Record<BenchmarkPlanner, string>>;
  browserIsolation: "fresh-context-per-run";
  gitCommitSha: string | null;
  benchmarkApplication: BenchmarkApplicationConfiguration;
  randomSeed: null;
}

export interface BenchmarkSuiteResult {
  suiteId: string;
  generatedAt: string;
  configuration: BenchmarkConfiguration;
  scenarios: BenchmarkScenario[];
  runs: BenchmarkRun[];
  metrics: BenchmarkMetrics;
}

export interface BenchmarkRunOptions {
  runsPerScenario?: number;
  scenarioIds?: readonly string[];
  modes?: readonly BenchmarkMode[];
  difficulties?: readonly BenchmarkDifficulty[];
  planners?: readonly BenchmarkPlanner[];
}

export interface BenchmarkScenarioExecutor {
  execute(
    scenario: BenchmarkScenario,
    repetition: number,
    planner: BenchmarkPlanner
  ): Promise<BenchmarkExecution>;
}
