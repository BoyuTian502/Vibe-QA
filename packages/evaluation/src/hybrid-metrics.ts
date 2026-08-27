import type {
  ExecutionPlanner,
  HybridRoutingMetrics,
  PlannerRoutingMetadata
} from "./types.js";

export function aggregateHybridRoutingMetrics(
  runs: readonly {
    planner: string;
    classification?: string;
    routing?: PlannerRoutingMetadata | null;
  }[]
): HybridRoutingMetrics | null {
  const hybridRuns = runs.filter(
    (run): run is typeof run & { routing: PlannerRoutingMetadata } =>
      run.planner === "hybrid" && run.routing !== null && run.routing !== undefined
  );
  if (hybridRuns.length === 0) {
    return null;
  }

  const selectedPlannerCounts = plannerCounts(
    hybridRuns.map((run) => run.routing.selectedPlanner)
  );
  const executedPlannerCounts = plannerCounts(
    hybridRuns.flatMap((run) =>
      run.routing.executedPlanner ? [run.routing.executedPlanner] : []
    )
  );
  const accuracyRuns = hybridRuns.filter(
    (run) => run.routing.matchedRecommendation !== null
  );
  const lowConfidenceRuns = hybridRuns.filter(
    (run) => run.routing.routingConfidence === "low"
  );
  const lowConfidenceSuccessfulRuns = lowConfidenceRuns.filter((run) =>
    isSuccessfulClassification(run.classification)
  ).length;

  return {
    totalHybridRuns: hybridRuns.length,
    selectedPlannerCounts,
    selectedPlannerDistribution: {
      deterministic: rate(selectedPlannerCounts.deterministic, hybridRuns.length),
      ollama: rate(selectedPlannerCounts.ollama, hybridRuns.length)
    },
    executedPlannerCounts,
    fallbackCount: hybridRuns.filter((run) => run.routing.fallback).length,
    ollamaUnavailableFallbackCount: hybridRuns.filter(
      (run) =>
        run.routing.fallback && run.routing.fallbackReason === "ollama-unavailable"
    ).length,
    unavailableExecutionCount: hybridRuns.filter(
      (run) => run.routing.executedPlanner === null
    ).length,
    routingAccuracyAttempts: accuracyRuns.length,
    routingAccuracyMatches: accuracyRuns.filter(
      (run) => run.routing.matchedRecommendation === true
    ).length,
    routingAccuracyRate: rate(
      accuracyRuns.filter((run) => run.routing.matchedRecommendation === true).length,
      accuracyRuns.length
    ),
    routingRuleCounts: countValues(hybridRuns.map((run) => run.routing.routingRule)),
    routingReasonCounts: countValues(
      hybridRuns.map((run) => run.routing.routingReason)
    ),
    confidenceCounts: {
      high: hybridRuns.filter((run) => run.routing.routingConfidence === "high").length,
      medium: hybridRuns.filter((run) => run.routing.routingConfidence === "medium")
        .length,
      low: lowConfidenceRuns.length
    },
    lowConfidenceRuns: lowConfidenceRuns.length,
    lowConfidenceSuccessfulRuns,
    lowConfidenceSuccessRate: rate(
      lowConfidenceSuccessfulRuns,
      lowConfidenceRuns.length
    )
  };
}

function isSuccessfulClassification(classification: string | undefined): boolean {
  return (
    classification === "PASS" ||
    classification === "EXPECTED_BUG_FOUND" ||
    classification === "HIDDEN_BUG_FOUND" ||
    classification === "GOAL_COMPLETED"
  );
}

function plannerCounts(
  planners: readonly ExecutionPlanner[]
): Record<ExecutionPlanner, number> {
  return {
    deterministic: planners.filter((planner) => planner === "deterministic").length,
    ollama: planners.filter((planner) => planner === "ollama").length
  };
}

function countValues(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
