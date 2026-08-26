export type BenchmarkMode = "functional" | "exploratory" | "regression";

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
}

export interface ScenarioBenchmarkMetrics {
  scenarioId: string;
  scenarioName: string;
  mode: BenchmarkMode;
  totalRuns: number;
  expectedOutcomes: number;
  expectedOutcomeRate: number;
  classifications: Record<BenchmarkClassification, number>;
}

export interface ModeBenchmarkMetrics {
  mode: BenchmarkMode;
  totalRuns: number;
  taskSuccessRate: number;
  bugDetectionRate: number;
  falsePositiveRate: number;
  infrastructureErrorRate: number;
  averageStepCount: number;
  averageDurationMs: number;
}

export interface BenchmarkMetrics {
  totalRuns: number;
  taskSuccessRate: number;
  bugDetectionRate: number;
  falsePositiveRate: number;
  infrastructureErrorRate: number;
  repeatedRunStability: number;
  stepCount: DistributionStatistics;
  durationMs: DistributionStatistics;
  safetyEvents: SafetyEventCounts;
  scenarioResults: ScenarioBenchmarkMetrics[];
  modePerformance: ModeBenchmarkMetrics[];
}

export interface BenchmarkConfiguration {
  runsPerScenario: number;
  scenarioFilter: string[];
  modeFilter: BenchmarkMode[];
  planner: "deterministic";
  browserIsolation: "fresh-context-per-run";
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
}

export interface BenchmarkScenarioExecutor {
  execute(scenario: BenchmarkScenario, repetition: number): Promise<BenchmarkExecution>;
}
