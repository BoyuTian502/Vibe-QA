import type {
  BenchmarkMode,
  BenchmarkPlanner,
  ExecutionPlanner,
  HybridConfidencePerformance,
  HybridRoutingDiagnostics,
  HybridRoutingExecutionDiagnostic,
  HybridRulePerformance,
  PlannerRoutingMetadata,
  RoutingAgreementBreakdown,
  RoutingConfidence,
  RoutingOutcomePerformance,
  RoutingRecommendationCategory,
  RoutingRegretEstimate
} from "./types.js";

export const DEFAULT_ROUTING_REGRET_THRESHOLD = 0.2;

export interface HybridDiagnosticSource {
  planner: BenchmarkPlanner;
  scenarioId: string;
  category: string;
  taskMode: BenchmarkMode;
  classification: string;
  taskSuccess: boolean;
  hiddenBugDiscovered: boolean | null;
  recoverySuccess: boolean | null;
  durationMs: number;
  steps: number;
  explorationEfficiency: number | null;
  revisitRate: number | null;
  detourRate: number | null;
  routing?: PlannerRoutingMetadata | null;
}

export function aggregateHybridRoutingDiagnostics(
  sources: readonly HybridDiagnosticSource[],
  regretThreshold = DEFAULT_ROUTING_REGRET_THRESHOLD
): HybridRoutingDiagnostics | null {
  validateRegretThreshold(regretThreshold);
  const hybridSources = sources.filter(
    (
      source
    ): source is HybridDiagnosticSource & {
      routing: PlannerRoutingMetadata;
    } => source.planner === "hybrid" && source.routing != null
  );
  if (hybridSources.length === 0) {
    return null;
  }

  const executions = hybridSources.map((source) =>
    executionDiagnostic(source, sources, regretThreshold)
  );
  const agreementExecutions = executions.filter(
    (execution) => execution.routingAgreed !== null
  );
  const agreed = agreementExecutions.filter(
    (execution) => execution.routingAgreed === true
  );
  const disagreed = agreementExecutions.filter(
    (execution) => execution.routingAgreed === false
  );
  const regretExecutions = executions.filter(
    (execution) => execution.regret.estimatedDifference !== null
  );
  const materialRegrets = regretExecutions.filter(
    (execution) => execution.regret.materiallyWorse
  );
  const v1Estimates = hybridSources.map((source) =>
    v1Estimate(source, sources, regretThreshold)
  );
  const comparableV1Agreement = v1Estimates.filter(
    (estimate) => estimate.agreed !== null
  );
  const comparableV1Regret = v1Estimates.filter(
    (estimate) => estimate.regret.estimatedDifference !== null
  );
  const v1Regrets = comparableV1Regret.filter(
    (estimate) => estimate.regret.materiallyWorse
  );
  const v1RegretRate = rate(v1Regrets.length, comparableV1Regret.length);
  const v2RegretRate = rate(materialRegrets.length, regretExecutions.length);

  return {
    regretThreshold,
    executions,
    confusionMatrix: confusionMatrix(executions),
    routingAgreementAttempts: agreementExecutions.length,
    routingAgreementMatches: agreed.length,
    routingAgreementRate: rate(agreed.length, agreementExecutions.length),
    agreementByScenario: agreementBreakdown(
      executions,
      (execution) => execution.scenarioId
    ),
    agreementByCategory: agreementBreakdown(
      executions,
      (execution) => execution.taskCategory
    ),
    agreedOutcomePerformance: outcomePerformance(agreed),
    disagreedOutcomePerformance: outcomePerformance(disagreed),
    rulePerformance: rulePerformance(executions),
    confidencePerformance: confidencePerformance(executions),
    routingRegretCount: materialRegrets.length,
    routingRegretRate: v2RegretRate,
    v1EstimatedRoutingAgreementRate: rate(
      comparableV1Agreement.filter((estimate) => estimate.agreed).length,
      comparableV1Agreement.length
    ),
    v1EstimatedRoutingRegretCount: v1Regrets.length,
    v1EstimatedRoutingRegretRate: v1RegretRate,
    estimatedRoutingRegretImprovement: v1RegretRate - v2RegretRate,
    scenarioMisroutes: executions.filter(
      (execution) =>
        execution.routingAgreed === false || execution.regret.materiallyWorse
    )
  };
}

function v1Estimate(
  source: HybridDiagnosticSource & { routing: PlannerRoutingMetadata },
  allSources: readonly HybridDiagnosticSource[],
  threshold: number
): { agreed: boolean | null; regret: RoutingRegretEstimate } {
  const selectedPlanner = v1SelectedPlanner(source.routing);
  const recommendation = recommendedCategory(source.routing);
  const alternativePlanner = otherPlanner(selectedPlanner);
  const selectedRate = historicalSuccessRate(
    allSources,
    source.scenarioId,
    selectedPlanner
  );
  const alternativeRate = historicalSuccessRate(
    allSources,
    source.scenarioId,
    alternativePlanner
  );
  const difference =
    selectedRate === null || alternativeRate === null
      ? null
      : alternativeRate - selectedRate;
  return {
    agreed: routingAgreement(selectedPlanner, recommendation),
    regret: {
      scenarioId: source.scenarioId,
      selectedPlanner,
      alternativePlanner,
      selectedPlannerHistoricalSuccessRate: selectedRate,
      alternativePlannerHistoricalSuccessRate: alternativeRate,
      estimatedDifference: difference,
      materiallyWorse: isMaterialRegret(difference, threshold)
    }
  };
}

function v1SelectedPlanner(routing: PlannerRoutingMetadata): ExecutionPlanner {
  return routing.routingRule === "ambiguous-semantic-ollama" ||
    routing.routingRule === "same-url-state-reasoning"
    ? "deterministic"
    : routing.selectedPlanner;
}

function executionDiagnostic(
  source: HybridDiagnosticSource & { routing: PlannerRoutingMetadata },
  allSources: readonly HybridDiagnosticSource[],
  regretThreshold: number
): HybridRoutingExecutionDiagnostic {
  const recommendation = recommendedCategory(source.routing);
  return {
    scenarioId: source.scenarioId,
    taskCategory: source.category,
    taskMode: source.taskMode,
    taskMetadata: source.routing.taskMetadata ?? null,
    routingRule: source.routing.routingRule,
    confidence: source.routing.routingConfidence ?? null,
    selectedPlanner: source.routing.selectedPlanner,
    executedPlanner: source.routing.executedPlanner,
    fallback: source.routing.fallback,
    classification: source.classification,
    taskSuccess: source.taskSuccess,
    hiddenBugDiscovered: source.hiddenBugDiscovered,
    recoverySuccess: source.recoverySuccess,
    durationMs: source.durationMs,
    steps: source.steps,
    explorationEfficiency: source.explorationEfficiency,
    revisitRate: source.revisitRate,
    detourRate: source.detourRate,
    recommendedCategory: recommendation,
    routingAgreed: routingAgreement(source.routing.selectedPlanner, recommendation),
    regret: routingRegret(source, allSources, regretThreshold)
  };
}

function routingRegret(
  source: HybridDiagnosticSource & { routing: PlannerRoutingMetadata },
  allSources: readonly HybridDiagnosticSource[],
  threshold: number
): RoutingRegretEstimate {
  const selectedPlanner = source.routing.selectedPlanner;
  const alternativePlanner = otherPlanner(selectedPlanner);
  const selectedRate = historicalSuccessRate(
    allSources,
    source.scenarioId,
    selectedPlanner
  );
  const alternativeRate = historicalSuccessRate(
    allSources,
    source.scenarioId,
    alternativePlanner
  );
  const difference =
    selectedRate === null || alternativeRate === null
      ? null
      : alternativeRate - selectedRate;
  return {
    scenarioId: source.scenarioId,
    selectedPlanner,
    alternativePlanner,
    selectedPlannerHistoricalSuccessRate: selectedRate,
    alternativePlannerHistoricalSuccessRate: alternativeRate,
    estimatedDifference: difference,
    materiallyWorse: isMaterialRegret(difference, threshold)
  };
}

function historicalSuccessRate(
  sources: readonly HybridDiagnosticSource[],
  scenarioId: string,
  planner: ExecutionPlanner
): number | null {
  const samples = sources.filter(
    (source) => source.scenarioId === scenarioId && source.planner === planner
  );
  return samples.length === 0
    ? null
    : rate(samples.filter((source) => source.taskSuccess).length, samples.length);
}

function confusionMatrix(
  executions: readonly HybridRoutingExecutionDiagnostic[]
): HybridRoutingDiagnostics["confusionMatrix"] {
  const matrix = {
    deterministic: recommendationCounts(),
    ollama: recommendationCounts()
  };
  for (const execution of executions) {
    if (execution.recommendedCategory) {
      matrix[execution.selectedPlanner][execution.recommendedCategory] += 1;
    }
  }
  return matrix;
}

function recommendationCounts(): Record<RoutingRecommendationCategory, number> {
  return {
    "deterministic-preferred": 0,
    "ollama-preferred": 0,
    mixed: 0
  };
}

function agreementBreakdown(
  executions: readonly HybridRoutingExecutionDiagnostic[],
  key: (execution: HybridRoutingExecutionDiagnostic) => string
): RoutingAgreementBreakdown[] {
  const groups = groupBy(executions, key);
  return [...groups.entries()].map(([groupKey, group]) => {
    const comparable = group.filter((execution) => execution.routingAgreed !== null);
    const matches = comparable.filter(
      (execution) => execution.routingAgreed === true
    ).length;
    return {
      key: groupKey,
      attempts: comparable.length,
      matches,
      rate: rate(matches, comparable.length)
    };
  });
}

function outcomePerformance(
  executions: readonly HybridRoutingExecutionDiagnostic[]
): RoutingOutcomePerformance {
  const successfulRuns = executions.filter((execution) => execution.taskSuccess).length;
  return {
    runs: executions.length,
    successfulRuns,
    successRate: rate(successfulRuns, executions.length)
  };
}

function rulePerformance(
  executions: readonly HybridRoutingExecutionDiagnostic[]
): HybridRulePerformance[] {
  return [...groupBy(executions, (execution) => execution.routingRule).entries()].map(
    ([ruleId, group]) => {
      const hidden = group.filter(
        (execution) => execution.hiddenBugDiscovered !== null
      );
      const recovery = group.filter((execution) => execution.recoverySuccess !== null);
      const agreement = group.filter((execution) => execution.routingAgreed !== null);
      const planners = new Set(group.map((execution) => execution.selectedPlanner));
      return {
        ruleId,
        uses: group.length,
        selectedPlanner: planners.size === 1 ? requiredFirst([...planners]) : "mixed",
        taskSuccessRate: successfulRate(group),
        hiddenBugDiscoveryRate:
          hidden.length === 0
            ? null
            : rate(
                hidden.filter((execution) => execution.hiddenBugDiscovered).length,
                hidden.length
              ),
        recoverySuccessRate:
          recovery.length === 0
            ? null
            : rate(
                recovery.filter((execution) => execution.recoverySuccess).length,
                recovery.length
              ),
        averageDurationMs: average(group.map((execution) => execution.durationMs)),
        stability: successfulRate(group),
        routingAgreementRate: rate(
          agreement.filter((execution) => execution.routingAgreed).length,
          agreement.length
        ),
        routingAgreementAttempts: agreement.length,
        estimatedRoutingRegretRate: rate(
          group.filter((execution) => execution.regret.materiallyWorse).length,
          group.filter((execution) => execution.regret.estimatedDifference !== null)
            .length
        )
      };
    }
  );
}

function confidencePerformance(
  executions: readonly HybridRoutingExecutionDiagnostic[]
): HybridConfidencePerformance[] {
  const confidenceLevels: RoutingConfidence[] = ["high", "medium", "low"];
  return confidenceLevels.map((confidence) => {
    const group = executions.filter((execution) => execution.confidence === confidence);
    const successfulRuns = group.filter((execution) => execution.taskSuccess).length;
    return {
      confidence,
      runs: group.length,
      successfulRuns,
      successRate: rate(successfulRuns, group.length)
    };
  });
}

function recommendedCategory(
  routing: PlannerRoutingMetadata
): RoutingRecommendationCategory | null {
  if (routing.recommendedCategory !== undefined) {
    return routing.recommendedCategory;
  }
  return routing.recommendedPlanner ? `${routing.recommendedPlanner}-preferred` : null;
}

function routingAgreement(
  selectedPlanner: ExecutionPlanner,
  recommendation: RoutingRecommendationCategory | null
): boolean | null {
  if (recommendation === null || recommendation === "mixed") {
    return null;
  }
  return recommendation === `${selectedPlanner}-preferred`;
}

function otherPlanner(planner: ExecutionPlanner): ExecutionPlanner {
  return planner === "deterministic" ? "ollama" : "deterministic";
}

function successfulRate(
  executions: readonly HybridRoutingExecutionDiagnostic[]
): number {
  return rate(
    executions.filter((execution) => execution.taskSuccess).length,
    executions.length
  );
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey) ?? [];
    group.push(value);
    groups.set(groupKey, group);
  }
  return groups;
}

function requiredFirst<T>(values: readonly T[]): T {
  const first = values[0];
  if (first === undefined) {
    throw new Error("Expected at least one routing value.");
  }
  return first;
}

function validateRegretThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Routing regret threshold must be between 0 and 1.");
  }
}

function isMaterialRegret(difference: number | null, threshold: number): boolean {
  return difference !== null && difference + 1e-12 >= threshold;
}
