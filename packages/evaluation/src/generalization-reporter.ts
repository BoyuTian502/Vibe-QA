import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { calculateLatencyRatio } from "./generalization-metrics.js";
import {
  formatAdaptiveExecutionMarkdown,
  formatAdaptiveExecutionSummary
} from "./adaptive-reporter.js";
import {
  formatAdaptiveFailureAnalysisMarkdown,
  formatAdaptiveFailureAnalysisSummary
} from "./adaptive-failure-reporter.js";
import { formatHybridDiagnosticsMarkdown } from "./hybrid-diagnostics-reporter.js";
import type {
  GeneralizationPerformanceMetrics,
  GeneralizationPlannerMetrics,
  GeneralizationScenarioCategory,
  GeneralizationScenarioPlannerMetrics,
  GeneralizationSuiteResult,
  WilsonConfidenceInterval
} from "./generalization-types.js";

const MEANINGFUL_RATE_DIFFERENCE = 0.05;

export interface GeneralizationReportPaths {
  outputDirectory: string;
  summaryPath: string;
  runsPath: string;
  reportPath: string;
  comparisonPath: string | null;
}

export async function writeGeneralizationReport(
  outputDirectory: string,
  result: GeneralizationSuiteResult
): Promise<GeneralizationReportPaths> {
  const summaryPath = join(outputDirectory, "summary.json");
  const runsPath = join(outputDirectory, "runs.json");
  const reportPath = join(outputDirectory, "benchmark-report.md");
  const comparisonPath =
    result.metrics.plannerPerformance.length > 1
      ? join(outputDirectory, "comparison.json")
      : null;
  await mkdir(outputDirectory, { recursive: true });
  const writes: Promise<void>[] = [
    writeJson(summaryPath, {
      suite: result.suite,
      suiteId: result.suiteId,
      generatedAt: result.generatedAt,
      configuration: result.configuration,
      scenarios: result.scenarios,
      metrics: result.metrics
    }),
    writeJson(runsPath, result.runs),
    writeFile(reportPath, formatGeneralizationMarkdownReport(result), "utf8")
  ];
  if (comparisonPath) {
    writes.push(
      writeJson(comparisonPath, {
        suite: result.suite,
        suiteId: result.suiteId,
        generatedAt: result.generatedAt,
        sample: sampleMetadata(result),
        planners: result.metrics.plannerPerformance,
        scenariosByPlanner: result.metrics.scenarioPlannerPerformance,
        hybridRouting: result.metrics.hybridRouting,
        hybridDiagnostics: result.metrics.hybridDiagnostics,
        adaptiveExecution: result.metrics.adaptiveExecution,
        interpretation: generalizationInterpretation(result)
      })
    );
  }
  await Promise.all(writes);
  return { outputDirectory, summaryPath, runsPath, reportPath, comparisonPath };
}

export function formatGeneralizationSummary(result: GeneralizationSuiteResult): string {
  const metrics = result.metrics;
  return [
    "--------------------------------------------------",
    "Benchmark V3 - Generalization & Autonomous Discovery",
    "--------------------------------------------------",
    "",
    `Suite version: ${result.configuration.benchmarkSuiteVersion}`,
    `Scenarios: ${result.configuration.scenarioCount}`,
    `Executions per planner: ${result.configuration.executionsPerPlanner}`,
    `Total executions: ${result.configuration.totalExecutions}`,
    `Planner strategies: ${result.configuration.planners.join(", ")}`,
    `Models: ${formatModels(result)}`,
    `Git commit: ${result.configuration.gitCommitSha ?? "unavailable"}`,
    "",
    `Autonomous Discovery: ${proportionValue(metrics.confidenceIntervals.autonomousDiscovery)}`,
    `Ambiguous Goal Completion: ${proportionValue(metrics.confidenceIntervals.goalCompletion)}`,
    `Exploration Efficiency: ${decimal(metrics.explorationEfficiency)}`,
    `Detour Rate: ${percentage(metrics.detourRate)}`,
    `State Revisit Rate: ${percentage(metrics.stateRevisitRate)}`,
    `Recovery Success: ${proportionValue(metrics.confidenceIntervals.recoverySuccess)}`,
    `Expected-outcome Stability: ${proportionValue(metrics.confidenceIntervals.expectedOutcome)}`,
    `Average / Median Steps: ${decimal(metrics.averageStepCount)} / ${decimal(metrics.medianStepCount)}`,
    `Average / Median Duration: ${seconds(metrics.averageDurationMs)} / ${seconds(metrics.medianDurationMs)}`,
    `Time to Discovery (mean / median): ${decimal(metrics.timeToDiscovery.mean)} / ${decimal(metrics.timeToDiscovery.median)} steps`,
    `Success within 5 / 10 / max steps: ${percentage(metrics.stepBudgetSuccess.within5Steps)} / ${percentage(metrics.stepBudgetSuccess.within10Steps)} / ${percentage(metrics.stepBudgetSuccess.withinMaxSteps)}`,
    ...(metrics.hybridRouting
      ? [
          "",
          `Hybrid selected deterministic / Ollama: ${percentage(metrics.hybridRouting.selectedPlannerDistribution.deterministic)} / ${percentage(metrics.hybridRouting.selectedPlannerDistribution.ollama)}`,
          `Hybrid routing accuracy proxy: ${percentage(metrics.hybridRouting.routingAccuracyRate)} (${metrics.hybridRouting.routingAccuracyMatches}/${metrics.hybridRouting.routingAccuracyAttempts})`,
          `Hybrid fallbacks / unavailable: ${metrics.hybridRouting.fallbackCount} / ${metrics.hybridRouting.unavailableExecutionCount}`
        ]
      : []),
    ...(metrics.adaptiveExecution
      ? ["", formatAdaptiveExecutionSummary(metrics.adaptiveExecution)]
      : []),
    ...(metrics.adaptiveFailureAnalysis
      ? ["", formatAdaptiveFailureAnalysisSummary(metrics.adaptiveFailureAnalysis)]
      : []),
    ""
  ].join("\n");
}

export function formatGeneralizationMarkdownReport(
  result: GeneralizationSuiteResult
): string {
  const interpretation = generalizationInterpretation(result);
  return [
    "# Vibe-QA Evaluation Benchmark",
    "",
    "## Benchmark V2 - Controlled Workflow Reliability",
    "",
    "V2 results are intentionally not merged into this suite. Controlled workflows measure repeatable execution when the browser path is specified.",
    "",
    "## Benchmark V3 - Generalization & Autonomous Discovery",
    "",
    "V3 measures behavior when the execution path and bug location are not explicitly specified.",
    "",
    "### Sample Metadata",
    "",
    `- Generated: ${result.generatedAt}`,
    `- Suite: ${result.suite}`,
    `- Benchmark suite version: ${result.configuration.benchmarkSuiteVersion}`,
    `- Scenarios: ${result.configuration.scenarioCount}`,
    `- Repetitions per scenario and planner: ${result.configuration.runsPerScenario}`,
    `- Executions per planner: ${result.configuration.executionsPerPlanner}`,
    `- Planners: ${result.configuration.planners.join(", ")}`,
    `- Total executions: ${result.configuration.totalExecutions}`,
    `- Models: ${formatModels(result)}`,
    `- Git commit: ${result.configuration.gitCommitSha ?? "unavailable"}`,
    `- Benchmark application: ${result.configuration.benchmarkApplication.name} ${result.configuration.benchmarkApplication.version}`,
    `- Benchmark configuration: ${result.configuration.benchmarkApplication.configuration}`,
    `- Browser isolation: ${result.configuration.browserIsolation}`,
    "",
    "### Generalization Metrics",
    "",
    performanceTable(result.metrics),
    "",
    "### Planner Comparison",
    "",
    result.metrics.plannerPerformance.length > 1
      ? plannerComparisonTable(result.metrics.plannerPerformance)
      : "A planner comparison is generated when more than one planner is executed.",
    ...(result.metrics.hybridRouting
      ? [
          "",
          "### Benchmark V4 - Hybrid Routing Evaluation",
          "",
          'Research question: "Can a rule-based hybrid router preserve deterministic efficiency on controlled tasks while retaining LLM advantages on autonomous discovery and recovery tasks?"',
          "",
          generalizationHybridRoutingMarkdown(result),
          "",
          "#### Measured V4 Interpretation",
          "",
          ...generalizationHybridInterpretation(result).map((finding) => `- ${finding}`)
        ]
      : []),
    ...(result.metrics.hybridDiagnostics
      ? [
          "",
          formatHybridDiagnosticsMarkdown(result.metrics.hybridDiagnostics),
          "",
          "### Hybrid V1 vs Hybrid V2",
          "",
          "The persisted Hybrid V1 generalization baseline was 15.0% hidden discovery, 37.5% ambiguous-goal completion, 38.3% recovery, 0.454 exploration efficiency, 44.7% state revisits, 3.95s average duration, and 30.0% expected-outcome stability. These values are historical and were not rerun as V1 in this experiment."
        ]
      : []),
    ...(result.metrics.adaptiveExecution
      ? [
          "",
          formatAdaptiveExecutionMarkdown(
            result.metrics.adaptiveExecution,
            generalizationAdaptiveInterpretation(result)
          ),
          "",
          adaptivePerformanceMarkdown(result)
        ]
      : []),
    ...(result.metrics.adaptiveFailureAnalysis
      ? ["", formatAdaptiveFailureAnalysisMarkdown(result)]
      : []),
    "",
    "### Per-Scenario Statistics",
    "",
    scenarioPlannerTable(result.metrics.scenarioPlannerPerformance),
    "",
    "### Evidence-Based Interpretation",
    "",
    ...interpretation.metricFindings.map((finding) => `- ${finding}`),
    "",
    "### Hybrid-Strategy Analysis",
    "",
    ...interpretation.hybridFindings.map((finding) => `- ${finding}`),
    "",
    "This section is descriptive only. It does not implement or evaluate a Hybrid Planner.",
    "",
    "### Cost and Latency",
    "",
    ...latencyAnalysis(result),
    "",
    "No API dollar cost is reported because the Ollama model runs locally.",
    "",
    "### Scenario Design",
    "",
    "| Scenario | Category | Difficulty | Planner-visible goal | Hidden expectation summary |",
    "| --- | --- | --- | --- | --- |",
    ...result.scenarios.map(
      (scenario) =>
        `| ${escapeCell(scenario.name)} | ${scenario.category} | ${scenario.difficulty} | ${escapeCell(scenario.plannerGoal)} | ${escapeCell(scenario.hiddenExpectationSummary)} |`
    ),
    "",
    "Evaluator-only selectors, exact action sequences, credentials, and seeded bug IDs are not included in planner input.",
    "",
    "### Difficulty Breakdown",
    "",
    "| Difficulty | Runs | Discovery | Goal completion | Efficiency | Recovery |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...result.metrics.difficultyPerformance.map(
      (item) =>
        `| ${item.difficulty} | ${item.totalRuns} | ${proportionValue(item.confidenceIntervals.autonomousDiscovery)} | ${proportionValue(item.confidenceIntervals.goalCompletion)} | ${decimal(item.explorationEfficiency)} | ${proportionValue(item.confidenceIntervals.recoverySuccess)} |`
    ),
    "",
    "### Individual Runs",
    "",
    "| Scenario | Planner | Result | Steps | States | Detours | Discovery step |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
    ...result.runs.map(
      (run) =>
        `| ${escapeCell(run.scenarioName)} | ${plannerLabel(run.planner, run.modelName)} | ${run.classification} | ${run.actions.length} | ${new Set(run.observations.map((item) => item.fingerprint)).size} | ${run.detourActions} | ${run.discoveryStep ?? "-"} |`
    ),
    "",
    "### Metric Definitions",
    "",
    "- Proportion intervals are two-sided 95% Wilson confidence intervals. N/A means the selected sample had no applicable opportunities.",
    "- Exploration efficiency is the number of first-time state transitions divided by executed actions.",
    "- A detour is a failed action, a no-state-change action, or a transition to an already observed state.",
    "- State revisit rate is repeated state observations divided by all observations.",
    "- Recovery succeeds when a run reaches its hidden outcome after at least one detour.",
    "- Expected-outcome stability is successful benchmark outcomes divided by attempts. The legacy repeated-run stability metric remains unchanged.",
    "- Coverage before discovery counts unique states and interactive elements observed through the first hidden-bug signal.",
    "",
    "### Limitations",
    "",
    "This is a deterministic local benchmark application with a fixed scenario set. It measures comparative behavior under controlled conditions, not universal website-testing accuracy. Confidence intervals quantify sampling uncertainty for this benchmark only. Planner results can vary with model version, model settings, host load, browser startup, and local hardware.",
    ""
  ].join("\n");
}

function generalizationHybridRoutingMarkdown(
  result: GeneralizationSuiteResult
): string {
  const routing = result.metrics.hybridRouting;
  if (!routing) {
    return "Hybrid routing was not requested for this benchmark.";
  }
  const hybrid = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "hybrid"
  );
  return [
    "#### Hybrid Routing Summary",
    "",
    `- Hybrid executions: ${routing.totalHybridRuns}`,
    `- Selected deterministic: ${percentage(routing.selectedPlannerDistribution.deterministic)} (${routing.selectedPlannerCounts.deterministic})`,
    `- Selected Ollama: ${percentage(routing.selectedPlannerDistribution.ollama)} (${routing.selectedPlannerCounts.ollama})`,
    `- Executed deterministic: ${routing.executedPlannerCounts.deterministic}`,
    `- Executed Ollama: ${routing.executedPlannerCounts.ollama}`,
    `- Routing accuracy proxy: ${percentage(routing.routingAccuracyRate)} (${routing.routingAccuracyMatches}/${routing.routingAccuracyAttempts})`,
    "- Routing accuracy proxy means agreement with evaluator-owned task-category recommendations, not proof that the selected planner was optimal. Recommendations are never passed to the router.",
    `- Fallbacks: ${routing.fallbackCount}`,
    `- Ollama-unavailable fallbacks: ${routing.ollamaUnavailableFallbackCount}`,
    `- Unavailable selected-planner executions: ${routing.unavailableExecutionCount}`,
    "",
    "#### Planner-Switch Rules",
    "",
    ...Object.entries(routing.routingRuleCounts).map(
      ([rule, count]) => `- ${rule}: ${count}`
    ),
    "",
    "#### Routing Reasons",
    "",
    ...Object.entries(routing.routingReasonCounts).map(
      ([reason, count]) => `- ${reason}: ${count}`
    ),
    "",
    "#### Hybrid Performance",
    "",
    hybrid
      ? [
          `- Hidden bug discovery: ${proportionValue(hybrid.confidenceIntervals.autonomousDiscovery)}`,
          `- Ambiguous goal completion: ${proportionValue(hybrid.confidenceIntervals.goalCompletion)}`,
          `- Recovery success: ${proportionValue(hybrid.confidenceIntervals.recoverySuccess)}`,
          `- Exploration efficiency: ${decimal(hybrid.explorationEfficiency)}`,
          `- Average duration: ${seconds(hybrid.averageDurationMs)}`,
          `- Expected-outcome stability: ${proportionValue(hybrid.confidenceIntervals.expectedOutcome)}`
        ].join("\n")
      : "- No Hybrid performance sample is available."
  ].join("\n");
}

function adaptivePerformanceMarkdown(result: GeneralizationSuiteResult): string {
  const adaptive = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "adaptive"
  );
  if (!adaptive) return "No Adaptive generalization sample is available.";
  return [
    "### Adaptive Generalization Performance",
    "",
    `- Hidden discovery: ${percentage(adaptive.autonomousDiscoveryRate)}`,
    `- Ambiguous goal completion: ${percentage(adaptive.goalCompletionRate)}`,
    `- Recovery success: ${percentage(adaptive.recoverySuccessRate)}`,
    `- Exploration efficiency: ${decimal(adaptive.explorationEfficiency)}`,
    `- State revisit rate: ${percentage(adaptive.stateRevisitRate)}`,
    `- Average duration: ${seconds(adaptive.averageDurationMs)}`,
    `- Stability: ${percentage(adaptive.repeatedRunStability)}`
  ].join("\n");
}

function generalizationAdaptiveInterpretation(
  result: GeneralizationSuiteResult
): string[] {
  const adaptive = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "adaptive"
  );
  const deterministic = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "deterministic"
  );
  const ollama = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "ollama"
  );
  const metrics = result.metrics.adaptiveExecution;
  if (!adaptive || !metrics) return ["No Adaptive generalization sample is available."];
  return [
    `Adaptive hidden discovery measured ${percentage(adaptive.autonomousDiscoveryRate)}${deterministic ? ` versus ${percentage(deterministic.autonomousDiscoveryRate)} for deterministic` : ""}.`,
    `Adaptive recovery measured ${percentage(adaptive.recoverySuccessRate)}${deterministic ? ` versus ${percentage(deterministic.recoverySuccessRate)} for deterministic` : ""}.`,
    `Adaptive average duration measured ${seconds(adaptive.averageDurationMs)}${ollama ? ` versus ${seconds(ollama.averageDurationMs)} for pure Ollama` : ""}.`,
    `Adaptive avoided Ollama in ${percentage(metrics.avoidedLlmRate)} of measured runs and escalated in ${percentage(metrics.escalationRate)}.`,
    `Useful escalations (${metrics.utilityCounts.USEFUL_ESCALATION}) are compared with unnecessary escalations (${metrics.utilityCounts.UNNECESSARY_ESCALATION}) using only post-run measured deterministic outcomes.`,
    "The intended latency/generalization tradeoff is not declared successful unless these measured values satisfy both efficiency and quality criteria."
  ];
}

function generalizationHybridInterpretation(
  result: GeneralizationSuiteResult
): string[] {
  const deterministic = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "deterministic"
  );
  const ollama = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "ollama"
  );
  const hybrid = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "hybrid"
  );
  const routing = result.metrics.hybridRouting;
  if (!hybrid || !routing) {
    return ["No Hybrid generalization sample is available."];
  }

  const findings = [
    deterministic
      ? `Hidden discovery is ${percentage(hybrid.autonomousDiscoveryRate)} for Hybrid versus ${percentage(deterministic.autonomousDiscoveryRate)} for deterministic.`
      : `Hybrid hidden discovery is ${percentage(hybrid.autonomousDiscoveryRate)}.`,
    deterministic
      ? `Ambiguous goal completion is ${percentage(hybrid.goalCompletionRate)} for Hybrid versus ${percentage(deterministic.goalCompletionRate)} for deterministic.`
      : `Hybrid ambiguous goal completion is ${percentage(hybrid.goalCompletionRate)}.`,
    deterministic
      ? `Recovery success is ${percentage(hybrid.recoverySuccessRate)} for Hybrid versus ${percentage(deterministic.recoverySuccessRate)} for deterministic.`
      : `Hybrid recovery success is ${percentage(hybrid.recoverySuccessRate)}.`,
    ollama
      ? `Hybrid average duration is ${durationRatio(hybrid.averageDurationMs, ollama.averageDurationMs)} of pure Ollama.`
      : "No pure Ollama duration sample is present for comparison.",
    `Hybrid expected-outcome stability is ${percentage(expectedOutcomeRate(hybrid))}; no stability improvement is claimed unless the measured value exceeds the alternatives.`,
    `Routing matched the evaluator recommendation in ${routing.routingAccuracyMatches}/${routing.routingAccuracyAttempts} Hybrid executions.`
  ];

  const checks = [
    deterministic
      ? hybrid.autonomousDiscoveryRate > deterministic.autonomousDiscoveryRate
      : false,
    deterministic
      ? hybrid.recoverySuccessRate >= deterministic.recoverySuccessRate
      : false,
    ollama ? hybrid.averageDurationMs < ollama.averageDurationMs : false,
    routing.routingAccuracyRate >= 0.95
  ];
  findings.push(
    `Generalization tradeoff criteria satisfied: ${checks.filter(Boolean).length}/${checks.length}. This is not an overall success declaration and controlled-workflow evidence remains in the separate V2 report.`
  );
  return findings;
}

function durationRatio(value: number, baseline: number): string {
  return baseline <= 0 ? "N/A" : `${(value / baseline).toFixed(2)}x`;
}

export function generalizationInterpretation(result: GeneralizationSuiteResult): {
  metricFindings: string[];
  hybridFindings: string[];
} {
  const pair = plannerPair(result.metrics.plannerPerformance);
  if (!pair) {
    return {
      metricFindings: [
        "A planner comparison requires both deterministic and Ollama results."
      ],
      hybridFindings: [
        "No planner suitability conclusion is available from a single-planner sample."
      ]
    };
  }
  const [deterministic, ollama] = pair;
  const ambiguous = categoryComparison(
    result.metrics.scenarioPlannerPerformance,
    "ambiguous_goal",
    (metrics) => metrics.goalCompletionRate
  );
  const recovery = recoveryComparison(result.metrics.scenarioPlannerPerformance);
  const discoveryFinding = compareHigher(
    "Hidden bug discovery",
    deterministic.autonomousDiscoveryRate,
    ollama.autonomousDiscoveryRate
  );
  const ambiguousFinding = ambiguous.mixed
    ? `Ambiguous goals are mixed by scenario; aggregate completion is ${percentage(deterministic.goalCompletionRate)} for deterministic and ${percentage(ollama.goalCompletionRate)} for Ollama.`
    : compareHigher(
        "Ambiguous goal completion",
        deterministic.goalCompletionRate,
        ollama.goalCompletionRate
      );
  const recoveryFinding = recovery.mixed
    ? `Recovery results are mixed by scenario; aggregate recovery is ${percentage(deterministic.recoverySuccessRate)} for deterministic and ${percentage(ollama.recoverySuccessRate)} for Ollama.`
    : recovery.scenarioCount < 2
      ? `Recovery evidence comes from ${recovery.scenarioCount} comparable scenario${recovery.scenarioCount === 1 ? "" : "s"}; aggregate recovery is ${percentage(deterministic.recoverySuccessRate)} for deterministic and ${percentage(ollama.recoverySuccessRate)} for Ollama, so no category-wide superiority is claimed.`
      : compareHigher(
          "Recovery success",
          deterministic.recoverySuccessRate,
          ollama.recoverySuccessRate
        );

  return {
    metricFindings: [
      discoveryFinding,
      ambiguousFinding,
      recoveryFinding,
      compareHigher(
        "Exploration efficiency",
        deterministic.explorationEfficiency,
        ollama.explorationEfficiency,
        decimal
      ),
      compareLower("Detour rate", deterministic.detourRate, ollama.detourRate),
      compareLower(
        "State revisit rate",
        deterministic.stateRevisitRate,
        ollama.stateRevisitRate
      ),
      compareLower(
        "Average duration",
        deterministic.averageDurationMs,
        ollama.averageDurationMs,
        seconds
      ),
      compareHigher(
        "Expected-outcome stability",
        expectedOutcomeRate(deterministic),
        expectedOutcomeRate(ollama)
      )
    ],
    hybridFindings: [
      "Controlled functional/regression: V3 does not measure pre-specified controlled paths, so this suite does not replace the separate V2 reliability evidence.",
      `Autonomous exploratory discovery: ${suitabilityConclusion(deterministic.autonomousDiscoveryRate, ollama.autonomousDiscoveryRate)} when hidden-path discovery is the deciding metric.`,
      ambiguous.mixed
        ? "Ambiguous semantic goals: neither planner is preferred because scenario-level results are mixed."
        : `Ambiguous semantic goals: ${suitabilityConclusion(deterministic.goalCompletionRate, ollama.goalCompletionRate)} from measured goal completion.`,
      recovery.mixed
        ? "Recovery: neither planner is preferred because scenario-level recovery evidence is mixed."
        : `Recovery: ${suitabilityConclusion(deterministic.recoverySuccessRate, ollama.recoverySuccessRate)} from aggregate recovery, subject to the scenario-count qualification above.`,
      `Latency-sensitive use: ${suitabilityConclusion(ollama.averageDurationMs, deterministic.averageDurationMs)} from lower average execution duration.`,
      `Reliability-sensitive use: ${suitabilityConclusion(expectedOutcomeRate(deterministic), expectedOutcomeRate(ollama))} from expected-outcome stability.`
    ]
  };
}

function performanceTable(metrics: GeneralizationPerformanceMetrics): string {
  return [
    "| Metric | Value |",
    "| --- | ---: |",
    `| Autonomous discovery | ${proportionValue(metrics.confidenceIntervals.autonomousDiscovery)} |`,
    `| Ambiguous goal completion | ${proportionValue(metrics.confidenceIntervals.goalCompletion)} |`,
    `| Exploration efficiency | ${decimal(metrics.explorationEfficiency)} |`,
    `| Detour rate | ${percentage(metrics.detourRate)} |`,
    `| State revisit rate | ${percentage(metrics.stateRevisitRate)} |`,
    `| Recovery success | ${proportionValue(metrics.confidenceIntervals.recoverySuccess)} |`,
    `| Expected-outcome stability | ${proportionValue(metrics.confidenceIntervals.expectedOutcome)} |`,
    `| Repeated-run stability (legacy) | ${percentage(metrics.repeatedRunStability)} |`,
    `| Average / median steps | ${decimal(metrics.averageStepCount)} / ${decimal(metrics.medianStepCount)} |`,
    `| Average / median duration | ${seconds(metrics.averageDurationMs)} / ${seconds(metrics.medianDurationMs)} |`,
    `| Average unique states | ${decimal(metrics.averageUniqueStates)} |`,
    `| Time to discovery, mean | ${decimal(metrics.timeToDiscovery.mean)} steps |`,
    `| Time to discovery, median | ${decimal(metrics.timeToDiscovery.median)} steps |`,
    `| Success within 5 steps | ${percentage(metrics.stepBudgetSuccess.within5Steps)} |`,
    `| Success within 10 steps | ${percentage(metrics.stepBudgetSuccess.within10Steps)} |`,
    `| Success within max steps | ${percentage(metrics.stepBudgetSuccess.withinMaxSteps)} |`
  ].join("\n");
}

function plannerComparisonTable(
  planners: readonly GeneralizationPlannerMetrics[]
): string {
  return [
    "| Planner | Runs | Discovery (95% CI) | Goal completion (95% CI) | Efficiency | Detours | Revisits | Recovery (95% CI) | Stability (95% CI) | Avg / median steps | Avg / median duration |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...planners.map(
      (planner) =>
        `| ${plannerLabel(planner.planner, planner.modelName)} | ${planner.totalRuns} | ${proportionValue(planner.confidenceIntervals.autonomousDiscovery)} | ${proportionValue(planner.confidenceIntervals.goalCompletion)} | ${decimal(planner.explorationEfficiency)} | ${percentage(planner.detourRate)} | ${percentage(planner.stateRevisitRate)} | ${proportionValue(planner.confidenceIntervals.recoverySuccess)} | ${proportionValue(planner.confidenceIntervals.expectedOutcome)} | ${decimal(planner.averageStepCount)} / ${decimal(planner.medianStepCount)} | ${seconds(planner.averageDurationMs)} / ${seconds(planner.medianDurationMs)} |`
    )
  ].join("\n");
}

function scenarioPlannerTable(
  metrics: readonly GeneralizationScenarioPlannerMetrics[]
): string {
  return [
    "| Scenario | Planner | Attempts | Successes | Success rate (95% CI) | Hidden bugs | Avg / median steps | Avg duration | Stability | Recovery | Avg states | Detours | Revisits |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...metrics.map(
      (item) =>
        `| ${escapeCell(item.scenarioName)} | ${plannerLabel(item.planner, item.modelName)} | ${item.totalRuns} | ${item.successfulRuns} | ${proportionValue(item.confidenceIntervals.expectedOutcome)} | ${proportionValue(item.confidenceIntervals.autonomousDiscovery)} | ${decimal(item.averageStepCount)} / ${decimal(item.medianStepCount)} | ${seconds(item.averageDurationMs)} | ${percentage(item.repeatedRunStability)} | ${proportionValue(item.confidenceIntervals.recoverySuccess)} | ${decimal(item.averageUniqueStates)} | ${percentage(item.detourRate)} | ${percentage(item.stateRevisitRate)} |`
    )
  ].join("\n");
}

function latencyAnalysis(result: GeneralizationSuiteResult): string[] {
  const pair = plannerPair(result.metrics.plannerPerformance);
  const lines = result.metrics.plannerPerformance.map(
    (planner) =>
      `- ${plannerLabel(planner.planner, planner.modelName)}: average ${seconds(planner.averageDurationMs)}, median ${seconds(planner.medianDurationMs)}.`
  );
  if (pair) {
    const [deterministic, ollama] = pair;
    lines.push(
      `- Relative slowdown (Ollama/deterministic duration ratio): ${ratioValue(calculateLatencyRatio(deterministic.averageDurationMs, ollama.averageDurationMs))} average and ${ratioValue(calculateLatencyRatio(deterministic.medianDurationMs, ollama.medianDurationMs))} median.`
    );
  }
  const ollama = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "ollama"
  );
  if (ollama && ollama.averagePlannerDurationMs !== null) {
    const share =
      ollama.averageDurationMs <= 0
        ? null
        : ollama.averagePlannerDurationMs / ollama.averageDurationMs;
    lines.push(
      `- Measured Ollama LLMClient.generate wall time: average ${seconds(ollama.averagePlannerDurationMs)}, median ${seconds(ollama.medianPlannerDurationMs ?? 0)}, across ${ollama.plannerDurationSampleCount} executions (${share === null ? "N/A" : percentage(share)} of average execution duration).`
    );
  } else {
    lines.push("- Planner-only latency was not measured for this result set.");
  }
  lines.push(
    "- Execution duration starts before browser launch and ends after scenario execution. It includes browser startup, authentication, navigation, observations, actions, waits, safety checks, and model calls; it excludes browser shutdown and report writing."
  );
  lines.push(
    "- Planner latency isolates elapsed LLMClient.generate calls, including correction attempts. It is wall-clock inference/request time, not pure model compute time."
  );
  return lines;
}

function sampleMetadata(result: GeneralizationSuiteResult): Record<string, unknown> {
  return {
    benchmarkSuiteVersion: result.configuration.benchmarkSuiteVersion,
    scenarios: result.configuration.scenarioCount,
    repetitionsPerScenarioAndPlanner: result.configuration.runsPerScenario,
    executionsPerPlanner: result.configuration.executionsPerPlanner,
    planners: result.configuration.planners,
    totalExecutions: result.configuration.totalExecutions,
    models: result.configuration.plannerModels,
    gitCommit: result.configuration.gitCommitSha
  };
}

function categoryComparison(
  metrics: readonly GeneralizationScenarioPlannerMetrics[],
  category: GeneralizationScenarioCategory,
  valueFor: (metrics: GeneralizationScenarioPlannerMetrics) => number
): { mixed: boolean; scenarioCount: number } {
  return scenarioComparison(
    metrics.filter((item) => item.category === category),
    valueFor
  );
}

function recoveryComparison(metrics: readonly GeneralizationScenarioPlannerMetrics[]): {
  mixed: boolean;
  scenarioCount: number;
} {
  return scenarioComparison(
    metrics.filter((item) => item.recoveryOpportunities > 0),
    (item) => item.recoverySuccessRate
  );
}

function scenarioComparison(
  metrics: readonly GeneralizationScenarioPlannerMetrics[],
  valueFor: (metrics: GeneralizationScenarioPlannerMetrics) => number
): { mixed: boolean; scenarioCount: number } {
  const scenarioIds = new Set(metrics.map((item) => item.scenarioId));
  const directions: number[] = [];
  let scenarioCount = 0;
  for (const scenarioId of scenarioIds) {
    const deterministic = metrics.find(
      (item) => item.scenarioId === scenarioId && item.planner === "deterministic"
    );
    const ollama = metrics.find(
      (item) => item.scenarioId === scenarioId && item.planner === "ollama"
    );
    if (!deterministic || !ollama) {
      continue;
    }
    scenarioCount += 1;
    const difference = valueFor(ollama) - valueFor(deterministic);
    if (Math.abs(difference) >= MEANINGFUL_RATE_DIFFERENCE) {
      directions.push(Math.sign(difference));
    }
  }
  return {
    mixed: directions.includes(1) && directions.includes(-1),
    scenarioCount
  };
}

function compareHigher(
  label: string,
  deterministicValue: number,
  ollamaValue: number,
  format: (value: number) => string = percentage
): string {
  const difference = ollamaValue - deterministicValue;
  if (Math.abs(difference) < MEANINGFUL_RATE_DIFFERENCE) {
    return `${label} is similar: deterministic ${format(deterministicValue)}, Ollama ${format(ollamaValue)}.`;
  }
  const leader = difference > 0 ? "Ollama" : "deterministic";
  return `${label} is higher for ${leader}: deterministic ${format(deterministicValue)}, Ollama ${format(ollamaValue)}.`;
}

function compareLower(
  label: string,
  deterministicValue: number,
  ollamaValue: number,
  format: (value: number) => string = percentage
): string {
  const difference = ollamaValue - deterministicValue;
  if (Math.abs(difference) < MEANINGFUL_RATE_DIFFERENCE) {
    return `${label} is similar: deterministic ${format(deterministicValue)}, Ollama ${format(ollamaValue)}.`;
  }
  const leader = difference < 0 ? "Ollama" : "deterministic";
  return `${label} is lower for ${leader}: deterministic ${format(deterministicValue)}, Ollama ${format(ollamaValue)}.`;
}

function suitabilityConclusion(
  deterministicValue: number,
  ollamaValue: number
): string {
  const difference = ollamaValue - deterministicValue;
  if (Math.abs(difference) < MEANINGFUL_RATE_DIFFERENCE) {
    return "neither planner is preferred";
  }
  return difference > 0 ? "Ollama is preferred" : "deterministic is preferred";
}

function plannerPair(
  planners: readonly GeneralizationPlannerMetrics[]
): [GeneralizationPlannerMetrics, GeneralizationPlannerMetrics] | null {
  const deterministic = planners.find((planner) => planner.planner === "deterministic");
  const ollama = planners.find((planner) => planner.planner === "ollama");
  return deterministic && ollama ? [deterministic, ollama] : null;
}

function expectedOutcomeRate(metrics: GeneralizationPerformanceMetrics): number {
  return metrics.totalRuns === 0 ? 0 : metrics.successfulRuns / metrics.totalRuns;
}

function proportionValue(interval: WilsonConfidenceInterval): string {
  return interval.attempts === 0
    ? "N/A"
    : `${percentage(interval.successes / interval.attempts)} (95% CI: ${percentage(interval.lower)}-${percentage(interval.upper)}; ${interval.successes}/${interval.attempts})`;
}

function formatModels(result: GeneralizationSuiteResult): string {
  const models = Object.entries(result.configuration.plannerModels);
  return models.length === 0
    ? "none"
    : models.map(([planner, model]) => `${planner}=${model}`).join(", ");
}

function ratioValue(value: number | null): string {
  return value === null ? "N/A" : `${value.toFixed(2)}x`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function plannerLabel(planner: string, model: string | null): string {
  return model ? `${planner} (${model})` : planner;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function decimal(value: number): string {
  return value.toFixed(2);
}

function seconds(value: number): string {
  return `${(value / 1000).toFixed(2)}s`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
