import type {
  HybridRoutingDiagnostics,
  HybridRoutingExecutionDiagnostic,
  RoutingConfusionMatrix
} from "./types.js";

export function formatHybridDiagnosticsMarkdown(
  diagnostics: HybridRoutingDiagnostics
): string {
  return [
    "## Benchmark V4.1 - Hybrid Routing Refinement",
    "",
    "### Hybrid Routing Diagnostics",
    "",
    `- Routing agreement: ${percentage(diagnostics.routingAgreementRate)} (${diagnostics.routingAgreementMatches}/${diagnostics.routingAgreementAttempts})`,
    `- Outcome success when routing agrees: ${outcome(diagnostics.agreedOutcomePerformance)}`,
    `- Outcome success when routing disagrees: ${outcome(diagnostics.disagreedOutcomePerformance)}`,
    `- Routing regret threshold: ${percentage(diagnostics.regretThreshold)} alternative-planner advantage`,
    `- Hybrid V2 routing regret: ${percentage(diagnostics.routingRegretRate)} (${diagnostics.routingRegretCount} material estimates)`,
    `- Hybrid V1 estimated routing regret on the same historical samples: ${percentage(diagnostics.v1EstimatedRoutingRegretRate)} (${diagnostics.v1EstimatedRoutingRegretCount} material estimates)`,
    `- Estimated routing-regret improvement: ${signedPercentage(diagnostics.estimatedRoutingRegretImprovement)}`,
    "- Routing agreement and regret are evaluator-side diagnostic proxies, not proof that a selected planner was causally optimal.",
    "",
    "### Routing Confusion Matrix",
    "",
    confusionMatrix(diagnostics.confusionMatrix),
    "",
    "### Agreement by Scenario",
    "",
    agreementTable(diagnostics.agreementByScenario),
    "",
    "### Agreement by Task Category",
    "",
    agreementTable(diagnostics.agreementByCategory),
    "",
    "### Rule-Level Performance",
    "",
    "| Rule | Uses | Planner | Success | Hidden discovery | Recovery | Avg duration | Stability | Agreement | Regret |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...diagnostics.rulePerformance.map(
      (rule) =>
        `| ${rule.ruleId} | ${rule.uses} | ${rule.selectedPlanner} | ${percentage(rule.taskSuccessRate)} | ${nullablePercentage(rule.hiddenBugDiscoveryRate)} | ${nullablePercentage(rule.recoverySuccessRate)} | ${seconds(rule.averageDurationMs)} | ${percentage(rule.stability)} | ${percentage(rule.routingAgreementRate)} | ${percentage(rule.estimatedRoutingRegretRate)} |`
    ),
    "",
    "### Routing Confidence",
    "",
    "| Confidence | Runs | Successful | Success rate |",
    "| --- | ---: | ---: | ---: |",
    ...diagnostics.confidencePerformance.map(
      (confidence) =>
        `| ${confidence.confidence} | ${confidence.runs} | ${confidence.successfulRuns} | ${percentage(confidence.successRate)} |`
    ),
    "",
    "### Scenario-Level Misroutes",
    "",
    ...misrouteLines(diagnostics.scenarioMisroutes),
    "",
    "### Why Hybrid V1 Failed",
    "",
    whyV1Failed(diagnostics),
    "",
    "The V1 comparison above is a historical alternative-planner estimate derived from measured deterministic and Ollama samples for the same scenarios. It is not a fabricated V1 rerun and does not establish causal certainty."
  ].join("\n");
}

function whyV1Failed(diagnostics: HybridRoutingDiagnostics): string {
  const base =
    "Hybrid V1 preserved controlled latency but underperformed on generalization while routing ambiguous semantic goals and same-URL state reasoning to deterministic execution. Hybrid V2 changes only those explainable rules; hidden discovery, pathless recovery, explicit exploration, regression, and known workflows retain their established routing.";
  if (diagnostics.estimatedRoutingRegretImprovement > 0) {
    return `${base} On this sample, the historical routing-regret estimate decreased.`;
  }
  return `${base} On this sample, the historical routing-regret estimate did not decrease, so routing selection alone does not explain V1's outcome gap.`;
}

function confusionMatrix(matrix: RoutingConfusionMatrix): string {
  return [
    "| Selected planner | Deterministic preferred | Ollama preferred | Mixed |",
    "| --- | ---: | ---: | ---: |",
    `| Deterministic | ${matrix.deterministic["deterministic-preferred"]} | ${matrix.deterministic["ollama-preferred"]} | ${matrix.deterministic.mixed} |`,
    `| Ollama | ${matrix.ollama["deterministic-preferred"]} | ${matrix.ollama["ollama-preferred"]} | ${matrix.ollama.mixed} |`
  ].join("\n");
}

function agreementTable(
  groups: HybridRoutingDiagnostics["agreementByScenario"]
): string {
  return [
    "| Group | Matches | Attempts | Agreement |",
    "| --- | ---: | ---: | ---: |",
    ...groups.map(
      (group) =>
        `| ${group.key} | ${group.matches} | ${group.attempts} | ${percentage(group.rate)} |`
    )
  ].join("\n");
}

function misrouteLines(
  misroutes: readonly HybridRoutingExecutionDiagnostic[]
): string[] {
  if (misroutes.length === 0) {
    return ["- No routing disagreements or material regret estimates were observed."];
  }
  const unique = new Map<string, HybridRoutingExecutionDiagnostic>();
  for (const misroute of misroutes) {
    unique.set(`${misroute.scenarioId}:${misroute.routingRule}`, misroute);
  }
  return [...unique.values()].map((misroute) => {
    const selected = nullablePercentage(
      misroute.regret.selectedPlannerHistoricalSuccessRate
    );
    const alternative = nullablePercentage(
      misroute.regret.alternativePlannerHistoricalSuccessRate
    );
    return `- ${misroute.scenarioId}: selected ${misroute.selectedPlanner} via ${misroute.routingRule}; historical selected success ${selected}, alternative ${alternative}; agreement ${nullableBoolean(misroute.routingAgreed)}; material regret ${misroute.regret.materiallyWorse ? "yes" : "no"}.`;
  });
}

function outcome(value: {
  runs: number;
  successfulRuns: number;
  successRate: number;
}): string {
  return `${percentage(value.successRate)} (${value.successfulRuns}/${value.runs})`;
}

function nullableBoolean(value: boolean | null): string {
  return value === null ? "not scored" : value ? "yes" : "no";
}

function nullablePercentage(value: number | null): string {
  return value === null ? "N/A" : percentage(value);
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPercentage(value: number): string {
  const points = value * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} percentage points`;
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}
