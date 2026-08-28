import { describeDistribution } from "./metrics.js";
import { aggregateAdaptiveExecutionMetrics } from "./adaptive-metrics.js";
import { aggregateHybridRoutingDiagnostics } from "./hybrid-diagnostics.js";
import { aggregateHybridRoutingMetrics } from "./hybrid-metrics.js";
import type {
  GeneralizationMetrics,
  GeneralizationPerformanceMetrics,
  GeneralizationRun,
  WilsonConfidenceInterval
} from "./generalization-types.js";

const WILSON_95_Z_SCORE = 1.959963984540054;

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
    scenarioPlannerPerformance: [
      ...groupBy(runs, (run) => `${run.planner}:${run.scenarioId}`).values()
    ].map((scenarioRuns) => {
      const first = requiredFirst(scenarioRuns);
      return {
        scenarioId: first.scenarioId,
        scenarioName: first.scenarioName,
        category: first.category,
        difficulty: first.difficulty,
        planner: first.planner,
        modelName: first.modelName,
        ...aggregatePerformance(scenarioRuns)
      };
    }),
    difficultyPerformance: [...groupBy(runs, (run) => run.difficulty).entries()].map(
      ([difficulty, difficultyRuns]) => ({
        difficulty,
        ...aggregatePerformance(difficultyRuns)
      })
    ),
    hybridRouting: aggregateHybridRoutingMetrics(runs),
    hybridDiagnostics: aggregateHybridRoutingDiagnostics(
      runs.map((run) => ({
        planner: run.planner,
        scenarioId: run.scenarioId,
        category: run.category,
        taskMode: run.routing?.taskMetadata?.mode ?? "functional",
        classification: run.classification,
        taskSuccess: isSuccessfulRun(run),
        hiddenBugDiscovered:
          run.expectedBugIds.length === 0
            ? null
            : run.expectedBugIds.every((bugId) => run.detectedBugIds.includes(bugId)),
        recoverySuccess: run.recoveryRequired ? run.recoverySucceeded : null,
        durationMs: run.durationMs,
        steps: run.actions.length,
        explorationEfficiency: rate(run.usefulNewStates, run.actions.length),
        revisitRate: rate(run.revisitedStates, run.observations.length),
        detourRate: rate(run.detourActions, run.actions.length),
        routing: run.routing
      }))
    ),
    adaptiveExecution: aggregateAdaptiveExecutionMetrics(
      runs.map((run) => ({
        planner: run.planner,
        scenarioId: run.scenarioId,
        successful: isSuccessfulRun(run),
        adaptive: run.adaptive
      }))
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

export function calculateWilsonConfidenceInterval(
  successes: number,
  attempts: number
): WilsonConfidenceInterval {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(attempts) ||
    successes < 0 ||
    attempts < 0 ||
    successes > attempts
  ) {
    throw new Error("Wilson interval requires valid integer success counts.");
  }
  if (attempts === 0) {
    return {
      confidenceLevel: 0.95,
      successes,
      attempts,
      lower: 0,
      upper: 0
    };
  }
  const observedRate = successes / attempts;
  const zSquared = WILSON_95_Z_SCORE ** 2;
  const denominator = 1 + zSquared / attempts;
  const center = (observedRate + zSquared / (2 * attempts)) / denominator;
  const margin =
    (WILSON_95_Z_SCORE / denominator) *
    Math.sqrt(
      (observedRate * (1 - observedRate)) / attempts + zSquared / (4 * attempts ** 2)
    );
  return {
    confidenceLevel: 0.95,
    successes,
    attempts,
    lower: successes === 0 ? 0 : Math.max(0, center - margin),
    upper: successes === attempts ? 1 : Math.min(1, center + margin)
  };
}

export function calculateLatencyRatio(
  baselineDurationMs: number,
  comparisonDurationMs: number
): number | null {
  if (baselineDurationMs <= 0 || comparisonDurationMs < 0) {
    return null;
  }
  return comparisonDurationMs / baselineDurationMs;
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
  const plannerDurations = describeDistribution(
    runs.flatMap((run) =>
      typeof run.plannerDurationMs === "number" ? [run.plannerDurationMs] : []
    )
  );
  const recoveryRuns = runs.filter((run) => run.recoveryRequired);
  const recoverySuccesses = recoveryRuns.filter((run) => run.recoverySucceeded).length;

  return {
    totalRuns: runs.length,
    successfulRuns: successfulRuns.length,
    hiddenBugOpportunities: hiddenBugRuns.length,
    hiddenBugDetections: discoveredRuns.length,
    ambiguousGoalOpportunities: ambiguousGoalRuns.length,
    ambiguousGoalCompletions: ambiguousGoalRuns.filter((run) => run.goalCompleted)
      .length,
    recoveryOpportunities: recoveryRuns.length,
    recoverySuccesses,
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
    medianStepCount: steps.median,
    averageDurationMs: durations.mean,
    medianDurationMs: durations.median,
    plannerDurationSampleCount: plannerDurations.count,
    averagePlannerDurationMs:
      plannerDurations.count === 0 ? null : plannerDurations.mean,
    medianPlannerDurationMs:
      plannerDurations.count === 0 ? null : plannerDurations.median,
    repeatedRunStability: calculateGeneralizationStability(runs),
    averageUniqueStates: average(
      runs.map(
        (run) =>
          new Set(run.observations.map((observation) => observation.fingerprint)).size
      )
    ),
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
    },
    confidenceIntervals: {
      autonomousDiscovery: calculateWilsonConfidenceInterval(
        discoveredRuns.length,
        hiddenBugRuns.length
      ),
      goalCompletion: calculateWilsonConfidenceInterval(
        ambiguousGoalRuns.filter((run) => run.goalCompleted).length,
        ambiguousGoalRuns.length
      ),
      recoverySuccess: calculateWilsonConfidenceInterval(
        recoverySuccesses,
        recoveryRuns.length
      ),
      expectedOutcome: calculateWilsonConfidenceInterval(
        successfulRuns.length,
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
