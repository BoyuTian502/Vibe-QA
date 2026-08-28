import { isSuccessfulClassification } from "./classification.js";
import { aggregateHybridRoutingDiagnostics } from "./hybrid-diagnostics.js";
import { aggregateHybridRoutingMetrics } from "./hybrid-metrics.js";
import type {
  BenchmarkClassification,
  BenchmarkMetrics,
  BenchmarkPerformanceMetrics,
  BenchmarkRun,
  DifficultyBenchmarkMetrics,
  DistributionStatistics,
  ModeBenchmarkMetrics,
  PlannerBenchmarkMetrics,
  SafetyEventCounts,
  ScenarioBenchmarkMetrics
} from "./types.js";
import { aggregateAdaptiveExecutionMetrics } from "./adaptive-metrics.js";

const CLASSIFICATIONS: readonly BenchmarkClassification[] = [
  "PASS",
  "EXPECTED_BUG_FOUND",
  "MISSED_BUG",
  "FALSE_POSITIVE",
  "AGENT_ERROR",
  "SAFETY_BLOCKED",
  "APPROVAL_REQUIRED"
];

export function aggregateBenchmarkMetrics(
  runs: readonly BenchmarkRun[]
): BenchmarkMetrics {
  const stepCount = describeDistribution(runs.map((run) => run.stepCount));
  const durationMs = describeDistribution(runs.map((run) => run.durationMs));
  const performance = aggregatePerformance(runs);
  const safetyEvents = runs.reduce<SafetyEventCounts>(
    (total, run) => ({
      allowed: total.allowed + run.safetyEvents.allowed,
      blocked: total.blocked + run.safetyEvents.blocked,
      approvalRequired: total.approvalRequired + run.safetyEvents.approvalRequired
    }),
    { allowed: 0, blocked: 0, approvalRequired: 0 }
  );

  return {
    ...performance,
    stepCount,
    durationMs,
    safetyEvents,
    scenarioResults: aggregateScenarioResults(runs),
    modePerformance: aggregateModePerformance(runs),
    difficultyPerformance: aggregateDifficultyPerformance(runs),
    plannerPerformance: aggregatePlannerPerformance(runs),
    hybridRouting: aggregateHybridRoutingMetrics(runs),
    hybridDiagnostics: aggregateHybridRoutingDiagnostics(
      runs.map((run) => ({
        planner: run.planner,
        scenarioId: run.scenarioId,
        category: run.mode,
        taskMode: run.mode,
        classification: run.classification,
        taskSuccess: isSuccessfulClassification(run.classification),
        hiddenBugDiscovered:
          run.expectedBugId === null
            ? null
            : run.detectedBugIds.includes(run.expectedBugId),
        recoverySuccess: null,
        durationMs: run.durationMs,
        steps: run.stepCount,
        explorationEfficiency: null,
        revisitRate: null,
        detourRate: null,
        routing: run.routing
      }))
    ),
    adaptiveExecution: aggregateAdaptiveExecutionMetrics(
      runs.map((run) => ({
        planner: run.planner,
        scenarioId: run.scenarioId,
        successful: isSuccessfulClassification(run.classification),
        adaptive: run.adaptive
      }))
    )
  };
}

export function describeDistribution(
  values: readonly number[]
): DistributionStatistics {
  if (values.length === 0) {
    return {
      count: 0,
      mean: 0,
      median: 0,
      min: 0,
      max: 0,
      standardDeviation: 0
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  return {
    count: sorted.length,
    mean,
    median,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    standardDeviation: Math.sqrt(variance)
  };
}

export function calculateRepeatedRunStability(runs: readonly BenchmarkRun[]): number {
  const grouped = groupBy(runs, (run) => `${run.planner}:${run.scenarioId}`);
  const scenarioRates = [...grouped.values()].map((scenarioRuns) =>
    rate(
      scenarioRuns.filter((run) => isSuccessfulClassification(run.classification))
        .length,
      scenarioRuns.length
    )
  );
  return scenarioRates.length === 0
    ? 0
    : scenarioRates.reduce((sum, value) => sum + value, 0) / scenarioRates.length;
}

function aggregatePerformance(
  runs: readonly BenchmarkRun[]
): BenchmarkPerformanceMetrics {
  const expectedBugRuns = runs.filter((run) => run.expectedBugId !== null);
  const cleanRuns = runs.filter((run) => run.expectedBugId === null);
  const explorationRuns = runs.filter((run) => run.exploration !== null);
  const steps = describeDistribution(runs.map((run) => run.stepCount));
  const durations = describeDistribution(runs.map((run) => run.durationMs));
  return {
    totalRuns: runs.length,
    expectedBugOpportunities: expectedBugRuns.length,
    cleanRunOpportunities: cleanRuns.length,
    taskSuccessRate: rate(
      runs.filter((run) => isSuccessfulClassification(run.classification)).length,
      runs.length
    ),
    bugDetectionRate: rate(
      expectedBugRuns.filter((run) => run.classification === "EXPECTED_BUG_FOUND")
        .length,
      expectedBugRuns.length
    ),
    falsePositiveRate: rate(
      cleanRuns.filter((run) => run.classification === "FALSE_POSITIVE").length,
      cleanRuns.length
    ),
    infrastructureErrorRate: rate(
      runs.filter((run) => run.classification === "AGENT_ERROR").length,
      runs.length
    ),
    repeatedRunStability: calculateRepeatedRunStability(runs),
    averageStepCount: steps.mean,
    medianStepCount: steps.median,
    averageDurationMs: durations.mean,
    medianDurationMs: durations.median,
    averageUniquePageStates: averageExploration(
      explorationRuns,
      (run) => run.exploration?.uniquePageStates ?? 0
    ),
    averageCandidateActionsAttempted: averageExploration(
      explorationRuns,
      (run) => run.exploration?.candidateActionsAttempted ?? 0
    ),
    averageUniqueInteractiveElements: averageExploration(
      explorationRuns,
      (run) => run.exploration?.uniqueInteractiveElements ?? 0
    ),
    averageCoverageScore: averageExploration(
      explorationRuns,
      (run) => run.exploration?.coverageScore ?? 0
    )
  };
}

function aggregateScenarioResults(
  runs: readonly BenchmarkRun[]
): ScenarioBenchmarkMetrics[] {
  return [...groupBy(runs, (run) => run.scenarioId).values()].map((scenarioRuns) => {
    const first = scenarioRuns[0];
    if (!first) {
      throw new Error("Scenario metrics require at least one run.");
    }
    const expectedOutcomes = scenarioRuns.filter((run) =>
      isSuccessfulClassification(run.classification)
    ).length;
    return {
      scenarioId: first.scenarioId,
      scenarioName: first.scenarioName,
      mode: first.mode,
      difficulty: first.difficulty,
      totalRuns: scenarioRuns.length,
      expectedOutcomes,
      expectedOutcomeRate: rate(expectedOutcomes, scenarioRuns.length),
      classifications: Object.fromEntries(
        CLASSIFICATIONS.map((classification) => [
          classification,
          scenarioRuns.filter((run) => run.classification === classification).length
        ])
      ) as Record<BenchmarkClassification, number>
    };
  });
}

function aggregateModePerformance(
  runs: readonly BenchmarkRun[]
): ModeBenchmarkMetrics[] {
  return [...groupBy(runs, (run) => run.mode).entries()].map(([mode, modeRuns]) => ({
    mode,
    ...aggregatePerformance(modeRuns)
  }));
}

function aggregateDifficultyPerformance(
  runs: readonly BenchmarkRun[]
): DifficultyBenchmarkMetrics[] {
  return [...groupBy(runs, (run) => run.difficulty).entries()].map(
    ([difficulty, difficultyRuns]) => ({
      difficulty,
      ...aggregatePerformance(difficultyRuns)
    })
  );
}

function aggregatePlannerPerformance(
  runs: readonly BenchmarkRun[]
): PlannerBenchmarkMetrics[] {
  return [...groupBy(runs, (run) => run.planner).entries()].map(
    ([planner, plannerRuns]) => ({
      planner,
      modelName: plannerRuns.find((run) => run.modelName)?.modelName ?? null,
      ...aggregatePerformance(plannerRuns)
    })
  );
}

function averageExploration(
  runs: readonly BenchmarkRun[],
  valueFor: (run: BenchmarkRun) => number
): number {
  return runs.length === 0
    ? 0
    : runs.reduce((sum, run) => sum + valueFor(run), 0) / runs.length;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function groupBy<T, K>(values: readonly T[], keyFor: (value: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = grouped.get(key) ?? [];
    group.push(value);
    grouped.set(key, group);
  }
  return grouped;
}
