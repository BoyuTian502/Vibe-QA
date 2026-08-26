import { isSuccessfulClassification } from "./classification.js";
import type {
  BenchmarkClassification,
  BenchmarkMetrics,
  BenchmarkRun,
  DistributionStatistics,
  ModeBenchmarkMetrics,
  SafetyEventCounts,
  ScenarioBenchmarkMetrics
} from "./types.js";

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
  const expectedBugRuns = runs.filter((run) => run.expectedBugId !== null);
  const cleanRuns = runs.filter((run) => run.expectedBugId === null);
  const safetyEvents = runs.reduce<SafetyEventCounts>(
    (total, run) => ({
      allowed: total.allowed + run.safetyEvents.allowed,
      blocked: total.blocked + run.safetyEvents.blocked,
      approvalRequired: total.approvalRequired + run.safetyEvents.approvalRequired
    }),
    { allowed: 0, blocked: 0, approvalRequired: 0 }
  );

  return {
    totalRuns: runs.length,
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
    stepCount: describeDistribution(runs.map((run) => run.stepCount)),
    durationMs: describeDistribution(runs.map((run) => run.durationMs)),
    safetyEvents,
    scenarioResults: aggregateScenarioResults(runs),
    modePerformance: aggregateModePerformance(runs)
  };
}

export function describeDistribution(
  values: readonly number[]
): DistributionStatistics {
  if (values.length === 0) {
    return { count: 0, mean: 0, median: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0
  };
}

export function calculateRepeatedRunStability(runs: readonly BenchmarkRun[]): number {
  const grouped = groupBy(runs, (run) => run.scenarioId);
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

function aggregateScenarioResults(
  runs: readonly BenchmarkRun[]
): ScenarioBenchmarkMetrics[] {
  return [...groupBy(runs, (run) => run.scenarioId).values()].map((scenarioRuns) => {
    const first = scenarioRuns[0];
    if (!first) {
      throw new Error("Scenario metrics require at least one run.");
    }
    return {
      scenarioId: first.scenarioId,
      scenarioName: first.scenarioName,
      mode: first.mode,
      totalRuns: scenarioRuns.length,
      expectedOutcomes: scenarioRuns.filter((run) =>
        isSuccessfulClassification(run.classification)
      ).length,
      expectedOutcomeRate: rate(
        scenarioRuns.filter((run) => isSuccessfulClassification(run.classification))
          .length,
        scenarioRuns.length
      ),
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
  return [...groupBy(runs, (run) => run.mode).entries()].map(([mode, modeRuns]) => {
    const metrics = aggregateModeRates(modeRuns);
    return { mode, ...metrics };
  });
}

function aggregateModeRates(
  runs: readonly BenchmarkRun[]
): Omit<ModeBenchmarkMetrics, "mode"> {
  const expectedBugRuns = runs.filter((run) => run.expectedBugId !== null);
  const cleanRuns = runs.filter((run) => run.expectedBugId === null);
  return {
    totalRuns: runs.length,
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
    averageStepCount: describeDistribution(runs.map((run) => run.stepCount)).mean,
    averageDurationMs: describeDistribution(runs.map((run) => run.durationMs)).mean
  };
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
