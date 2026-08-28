import {
  ADAPTIVE_THRESHOLD_PROFILES,
  ProgressiveEscalationStrategy,
  classifyEscalationUtility,
  type AdaptiveExecutionMetadata,
  type EscalationUtility
} from "@vibeqa/adaptive-execution";

import type { AdaptiveExecutionMetrics, DistributionStatistics } from "./types.js";

export interface AdaptiveMetricSource {
  planner: string;
  scenarioId: string;
  successful: boolean;
  adaptive?: AdaptiveExecutionMetadata | null;
}

const UTILITIES: readonly EscalationUtility[] = [
  "USEFUL_ESCALATION",
  "UNNECESSARY_ESCALATION",
  "FAILED_ESCALATION",
  "NO_ESCALATION_NEEDED"
];

export function aggregateAdaptiveExecutionMetrics(
  runs: readonly AdaptiveMetricSource[]
): AdaptiveExecutionMetrics | null {
  const adaptiveRuns = runs.filter(
    (run): run is AdaptiveMetricSource & { adaptive: AdaptiveExecutionMetadata } =>
      run.planner === "adaptive" && run.adaptive !== null && run.adaptive !== undefined
  );
  if (adaptiveRuns.length === 0) return null;

  const escalated = adaptiveRuns.filter((run) => run.adaptive.escalationOccurred);
  const successfulEscalations = escalated.filter((run) => run.successful);
  const deterministicRates = scenarioSuccessRates(
    runs.filter((run) => run.planner === "deterministic")
  );
  const utilities = adaptiveRuns.map((run) =>
    classifyEscalationUtility({
      escalationOccurred: run.adaptive.escalationOccurred,
      finalOutcome: run.successful,
      deterministicLikelyCouldComplete:
        (deterministicRates.get(run.scenarioId) ?? 0) >= 0.5
    })
  );

  return {
    totalAdaptiveRuns: adaptiveRuns.length,
    escalationCount: escalated.length,
    escalationRate: rate(escalated.length, adaptiveRuns.length),
    successfulEscalationCount: successfulEscalations.length,
    successfulEscalationRate: rate(successfulEscalations.length, escalated.length),
    avoidedLlmCount: adaptiveRuns.length - escalated.length,
    avoidedLlmRate: rate(adaptiveRuns.length - escalated.length, adaptiveRuns.length),
    ollamaInvocationCount: sum(
      adaptiveRuns,
      (run) => run.adaptive.ollamaInvocationCount
    ),
    preEscalationSteps: distribution(
      escalated.map((run) => run.adaptive.deterministicSteps)
    ),
    postEscalationSteps: distribution(escalated.map((run) => run.adaptive.ollamaSteps)),
    timeBeforeEscalationMs: distribution(
      escalated.flatMap((run) =>
        run.adaptive.timeBeforeEscalationMs === null
          ? []
          : [run.adaptive.timeBeforeEscalationMs]
      )
    ),
    timeAfterEscalationMs: distribution(
      escalated.flatMap((run) =>
        run.adaptive.timeAfterEscalationMs === null
          ? []
          : [run.adaptive.timeAfterEscalationMs]
      )
    ),
    taskSuccessRate: rate(
      adaptiveRuns.filter((run) => run.successful).length,
      adaptiveRuns.length
    ),
    utilityCounts: Object.fromEntries(
      UTILITIES.map((utility) => [
        utility,
        utilities.filter((value) => value === utility).length
      ])
    ) as Record<EscalationUtility, number>,
    unclassifiedRuns: utilities.filter((utility) => utility === null).length,
    thresholdAnalysis: ADAPTIVE_THRESHOLD_PROFILES.map((profile) => {
      const projectedEscalations = adaptiveRuns.filter((run) =>
        wouldEscalate(run.adaptive, profile.config)
      ).length;
      return {
        profile: profile.name,
        projectedEscalations,
        projectedEscalationRate: rate(projectedEscalations, adaptiveRuns.length)
      };
    })
  };
}

function wouldEscalate(
  metadata: AdaptiveExecutionMetadata,
  config: ConstructorParameters<typeof ProgressiveEscalationStrategy>[0]
): boolean {
  const strategy = new ProgressiveEscalationStrategy(config);
  return metadata.progressEvents.some(
    (event) =>
      strategy.evaluate(
        {
          progressed: event.progressed,
          reasons: event.reasons,
          repeatedStateCount: event.repeatedStateCount,
          noProgressCount: event.noProgressCount,
          failedActionCount: event.failedActionCount,
          evaluationFailureCount: event.evaluationFailureCount,
          deterministicSteps: event.step,
          deterministicExhausted: event.signals.includes("exploration-exhausted")
        },
        0
      ).escalate
  );
}

function scenarioSuccessRates(
  runs: readonly AdaptiveMetricSource[]
): Map<string, number> {
  const grouped = new Map<string, AdaptiveMetricSource[]>();
  for (const run of runs) {
    const values = grouped.get(run.scenarioId) ?? [];
    values.push(run);
    grouped.set(run.scenarioId, values);
  }
  return new Map(
    [...grouped.entries()].map(([scenarioId, values]) => [
      scenarioId,
      rate(values.filter((run) => run.successful).length, values.length)
    ])
  );
}

function distribution(values: readonly number[]): DistributionStatistics {
  if (values.length === 0) {
    return { count: 0, mean: 0, median: 0, min: 0, max: 0, standardDeviation: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((sumValue, value) => sumValue + value, 0) / sorted.length;
  const midpoint = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2
      : (sorted[midpoint] ?? 0);
  return {
    count: sorted.length,
    mean,
    median,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    standardDeviation: Math.sqrt(
      sorted.reduce((sumValue, value) => sumValue + (value - mean) ** 2, 0) /
        sorted.length
    )
  };
}

function sum<T>(values: readonly T[], valueFor: (value: T) => number): number {
  return values.reduce((total, value) => total + valueFor(value), 0);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
