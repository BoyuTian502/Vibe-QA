export type BenchmarkMode = "functional" | "exploratory" | "regression";

export type BenchmarkDifficulty = "easy" | "medium" | "hard";

export type BenchmarkPlanner = "deterministic" | "ollama";

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
