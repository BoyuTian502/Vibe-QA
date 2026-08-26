import { describeDistribution } from "./metrics.js";
import type {
  GeneralizationMetrics,
  GeneralizationPerformanceMetrics,
  GeneralizationRun
} from "./generalization-types.js";

export function aggregateGeneralizationMetrics(
  runs: readonly GeneralizationRun[]
): GeneralizationMetrics {
  return {
    ...aggregatePerformance(runs),
    plannerPerformance: [...groupBy(runs, (run) => run.planner).entries()].map(
      ([planner, plannerRuns]) => ({
        planner,
        modelName: plannerRuns.find((run) => run.modelName)?.modelName ?? null,
        ...aggregatePerformance(plannerRuns)
      })
    ),
    scenarioPerformance: [...groupBy(runs, (run) => run.scenarioId).values()].map(
      (scenarioRuns) => {
        const first = requiredFirst(scenarioRuns);
        return {
          scenarioId: first.scenarioId,
          scenarioName: first.scenarioName,
          category: first.category,
          difficulty: first.difficulty,
          ...aggregatePerformance(scenarioRuns)
        };
      }
    ),
    difficultyPerformance: [...groupBy(runs, (run) => run.difficulty).entries()].map(
      ([difficulty, difficultyRuns]) => ({
        difficulty,
        ...aggregatePerformance(difficultyRuns)
      })
    )
  };
}

export function calculateExplorationEfficiency(
  runs: readonly GeneralizationRun[]
): number {
  const actions = sum(runs, (run) => run.actions.length);
  return rate(
    sum(runs, (run) => run.usefulNewStates),
    actions
  );
}

export function calculateDetourRate(runs: readonly GeneralizationRun[]): number {
  const actions = sum(runs, (run) => run.actions.length);
  return rate(
    sum(runs, (run) => run.detourActions),
    actions
  );
}

export function calculateStateRevisitRate(runs: readonly GeneralizationRun[]): number {
  const observations = sum(runs, (run) => run.observations.length);
  return rate(
    sum(runs, (run) => run.revisitedStates),
    observations
  );
}

export function calculateRecoverySuccessRate(
  runs: readonly GeneralizationRun[]
): number {
  const recoveryRuns = runs.filter((run) => run.recoveryRequired);
  return rate(
    recoveryRuns.filter((run) => run.recoverySucceeded).length,
    recoveryRuns.length
  );
}

function aggregatePerformance(
  runs: readonly GeneralizationRun[]
): GeneralizationPerformanceMetrics {
  const hiddenBugRuns = runs.filter((run) => run.expectedBugIds.length > 0);
  const ambiguousGoalRuns = runs.filter((run) => run.expectedBugIds.length === 0);
  const discoveredRuns = hiddenBugRuns.filter((run) =>
    run.expectedBugIds.every((bugId) => run.detectedBugIds.includes(bugId))
  );
  const successfulRuns = runs.filter(isSuccessfulRun);
  const discoverySteps = describeDistribution(
    discoveredRuns.flatMap((run) =>
      run.discoveryStep === null ? [] : [run.discoveryStep]
    )
  );
  const steps = describeDistribution(runs.map((run) => run.actions.length));
  const durations = describeDistribution(runs.map((run) => run.durationMs));

  return {
    totalRuns: runs.length,
    autonomousDiscoveryRate: rate(discoveredRuns.length, hiddenBugRuns.length),
    goalCompletionRate: rate(
      ambiguousGoalRuns.filter((run) => run.goalCompleted).length,
      ambiguousGoalRuns.length
    ),
    explorationEfficiency: calculateExplorationEfficiency(runs),
    detourRate: calculateDetourRate(runs),
    stateRevisitRate: calculateStateRevisitRate(runs),
    recoverySuccessRate: calculateRecoverySuccessRate(runs),
    averageStepCount: steps.mean,
    averageDurationMs: durations.mean,
    repeatedRunStability: calculateGeneralizationStability(runs),
    timeToDiscovery: discoverySteps,
    averageUniqueStatesBeforeDiscovery: average(
      discoveredRuns.map((run) => run.uniqueStatesBeforeDiscovery)
    ),
    averageUniqueElementsBeforeDiscovery: average(
      discoveredRuns.map((run) => run.uniqueElementsBeforeDiscovery)
    ),
    stepBudgetSuccess: {
      within5Steps: rate(
        successfulRuns.filter((run) => successStep(run) <= 5).length,
        runs.length
      ),
      within10Steps: rate(
        successfulRuns.filter((run) => successStep(run) <= 10).length,
        runs.length
      ),
      withinMaxSteps: rate(
        successfulRuns.filter((run) => successStep(run) <= run.maxSteps).length,
        runs.length
      )
    }
  };
}

function calculateGeneralizationStability(runs: readonly GeneralizationRun[]): number {
  const groups = groupBy(runs, (run) => `${run.planner}:${run.scenarioId}`);
  return average(
    [...groups.values()].map((group) =>
      rate(group.filter(isSuccessfulRun).length, group.length)
    )
  );
}

function isSuccessfulRun(run: GeneralizationRun): boolean {
  return (
    run.classification === "HIDDEN_BUG_FOUND" || run.classification === "GOAL_COMPLETED"
  );
}

function successStep(run: GeneralizationRun): number {
  return run.expectedBugIds.length > 0
    ? (run.discoveryStep ?? Number.POSITIVE_INFINITY)
    : (run.completionStep ?? Number.POSITIVE_INFINITY);
}

function requiredFirst<T>(values: readonly T[]): T {
  const first = values[0];
  if (!first) {
    throw new Error("Generalization metrics require at least one run.");
  }
  return first;
}

function sum<T>(values: readonly T[], valueFor: (value: T) => number): number {
  return values.reduce((total, value) => total + valueFor(value), 0);
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function groupBy<T, K>(values: readonly T[], keyFor: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}
