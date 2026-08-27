import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  BenchmarkPerformanceMetrics,
  BenchmarkSuiteResult,
  PlannerBenchmarkMetrics
} from "./types.js";

export interface BenchmarkReportPaths {
  outputDirectory: string;
  summaryPath: string;
  runsPath: string;
  reportPath: string;
  comparisonPath: string | null;
}

export async function writeBenchmarkReport(
  outputDirectory: string,
  result: BenchmarkSuiteResult
): Promise<BenchmarkReportPaths> {
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
      suiteId: result.suiteId,
      generatedAt: result.generatedAt,
      configuration: result.configuration,
      scenarios: result.scenarios,
      metrics: result.metrics
    }),
    writeJson(runsPath, result.runs),
    writeFile(reportPath, formatBenchmarkMarkdownReport(result), "utf8")
  ];
  if (comparisonPath) {
    writes.push(
      writeJson(comparisonPath, {
        suiteId: result.suiteId,
        generatedAt: result.generatedAt,
        planners: result.metrics.plannerPerformance,
        hybridRouting: result.metrics.hybridRouting
      })
    );
  }
  await Promise.all(writes);
  return {
    outputDirectory,
    summaryPath,
    runsPath,
    reportPath,
    comparisonPath
  };
}

export function formatBenchmarkSummary(result: BenchmarkSuiteResult): string {
  const metrics = result.metrics;
  const lines = [
    "--------------------------------------------------",
    "Vibe-QA Evaluation Benchmark",
    "--------------------------------------------------",
    "",
    `Scenarios: ${result.scenarios.length}`,
    `Runs per scenario: ${result.configuration.runsPerScenario}`,
    `Total runs: ${metrics.totalRuns}`,
    `Planner strategies: ${result.configuration.planners.join(", ")}`,
    "",
    `Task Success Rate: ${percentage(metrics.taskSuccessRate)}`,
    `Seeded Bug Detection Rate: ${percentage(metrics.bugDetectionRate)}`,
    `False Positive Rate: ${percentage(metrics.falsePositiveRate)}`,
    `Infrastructure Error Rate: ${percentage(metrics.infrastructureErrorRate)}`,
    `Average Steps: ${decimal(metrics.averageStepCount)}`,
    `Median Steps: ${decimal(metrics.medianStepCount)}`,
    `Average Duration: ${seconds(metrics.averageDurationMs)}`,
    `Median Duration: ${seconds(metrics.medianDurationMs)}`,
    `Repeated-run Stability: ${percentage(metrics.repeatedRunStability)}`,
    "",
    "Safety Events:",
    `Allowed: ${metrics.safetyEvents.allowed}`,
    `Blocked: ${metrics.safetyEvents.blocked}`,
    `Approval Required: ${metrics.safetyEvents.approvalRequired}`,
    "",
    formatPlannerComparison(metrics.plannerPerformance),
    ...(metrics.hybridRouting ? ["", formatHybridPlainSummary(result)] : []),
    "",
    "--------------------------------------------------",
    "Difficulty Breakdown",
    "--------------------------------------------------",
    "",
    ...metrics.difficultyPerformance.flatMap((difficulty) => [
      `${capitalize(difficulty.difficulty)}:`,
      `Success: ${percentage(difficulty.taskSuccessRate)}`,
      `Bug Detection: ${bugDetectionValue(difficulty)}`,
      ""
    ]),
    "--------------------------------------------------",
    "Scenario Results",
    "--------------------------------------------------",
    "",
    ...metrics.scenarioResults.map(
      (scenario) =>
        `${scenario.scenarioName} [${scenario.difficulty}]: ${scenario.expectedOutcomes} / ${scenario.totalRuns} expected outcomes`
    ),
    ""
  ];
  return lines.join("\n");
}

export function formatPlannerComparison(
  planners: readonly PlannerBenchmarkMetrics[]
): string {
  const header = ["Metric", ...planners.map(plannerLabel)];
  const rows = [
    ["Task Success", ...planners.map((item) => percentage(item.taskSuccessRate))],
    ["Bug Detection", ...planners.map(bugDetectionValue)],
    ["False Positive", ...planners.map(falsePositiveValue)],
    [
      "Infrastructure Errors",
      ...planners.map((item) => percentage(item.infrastructureErrorRate))
    ],
    ["Avg Steps", ...planners.map((item) => decimal(item.averageStepCount))],
    ["Median Steps", ...planners.map((item) => decimal(item.medianStepCount))],
    ["Avg Duration", ...planners.map((item) => seconds(item.averageDurationMs))],
    ["Median Duration", ...planners.map((item) => seconds(item.medianDurationMs))],
    ["Stability", ...planners.map((item) => percentage(item.repeatedRunStability))]
  ];
  return [
    "--------------------------------------------------",
    "Planner Comparison",
    "--------------------------------------------------",
    "",
    formatPlainTable(header, rows)
  ].join("\n");
}

export function formatBenchmarkMarkdownReport(result: BenchmarkSuiteResult): string {
  const metrics = result.metrics;
  return [
    "# Vibe-QA Evaluation Benchmark",
    "",
    `Generated: ${result.generatedAt}`,
    "",
    "## Benchmark V2 - Controlled Workflow Reliability",
    "",
    "## Configuration",
    "",
    `- Planners: ${result.configuration.planners.join(", ")}`,
    `- Models: ${formatModels(result)}`,
    `- Runs per scenario: ${result.configuration.runsPerScenario}`,
    `- Scenario IDs: ${result.configuration.scenarioIds.join(", ")}`,
    `- Mode filters: ${formatFilter(result.configuration.modeFilter)}`,
    `- Difficulty filters: ${formatFilter(result.configuration.difficultyFilter)}`,
    `- Git commit: ${result.configuration.gitCommitSha ?? "unavailable"}`,
    `- Benchmark application: ${result.configuration.benchmarkApplication.name} ${result.configuration.benchmarkApplication.version}`,
    `- Benchmark configuration: ${result.configuration.benchmarkApplication.configuration}`,
    `- Browser isolation: ${result.configuration.browserIsolation}`,
    `- Random seed: ${result.configuration.randomSeed ?? "not used"}`,
    "",
    "## Overall Metrics",
    "",
    markdownPerformanceTable(metrics),
    "",
    "### Distribution Statistics",
    "",
    "| Measurement | Count | Mean | Median | Min | Max | Standard deviation |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    distributionRow("Steps", metrics.stepCount),
    distributionRow("Duration (ms)", metrics.durationMs),
    "",
    "## Scenario Results",
    "",
    "| Scenario | Mode | Difficulty | Expected outcomes | Success rate |",
    "| --- | --- | --- | ---: | ---: |",
    ...metrics.scenarioResults.map(
      (scenario) =>
        `| ${scenario.scenarioName} | ${scenario.mode} | ${scenario.difficulty} | ${scenario.expectedOutcomes}/${scenario.totalRuns} | ${percentage(scenario.expectedOutcomeRate)} |`
    ),
    "",
    "## Difficulty Breakdown",
    "",
    markdownGroupTable(
      "Difficulty",
      metrics.difficultyPerformance.map((item) => [item.difficulty, item])
    ),
    "",
    "## Mode Breakdown",
    "",
    markdownGroupTable(
      "Mode",
      metrics.modePerformance.map((item) => [item.mode, item])
    ),
    "",
    "## Planner Comparison",
    "",
    markdownGroupTable(
      "Planner",
      metrics.plannerPerformance.map((item) => [plannerLabel(item), item])
    ),
    ...(metrics.hybridRouting
      ? [
          "",
          "## Benchmark V4 - Hybrid Routing Evaluation",
          "",
          'Research question: "Can a rule-based hybrid router preserve deterministic efficiency on controlled tasks while retaining LLM advantages on autonomous discovery and recovery tasks?"',
          "",
          hybridRoutingMarkdown(result),
          "",
          "### Measured Interpretation",
          "",
          ...controlledHybridInterpretation(result).map((line) => `- ${line}`)
        ]
      : []),
    "",
    "## Limitations",
    "",
    "- This benchmark uses a controlled test site with deterministic seeded behaviors.",
    "- Sample sizes may be small and should be reported alongside every metric.",
    "- Results should not be interpreted as universal website-testing accuracy.",
    "- LLM planner performance can vary by model, runtime, hardware, and environment.",
    "- The constrained Ollama strategy orders known safe steps; exploratory candidate ranking remains deterministic.",
    ""
  ].join("\n");
}

function formatHybridPlainSummary(result: BenchmarkSuiteResult): string {
  const routing = result.metrics.hybridRouting;
  if (!routing) {
    return "";
  }
  return [
    "--------------------------------------------------",
    "Benchmark V4 - Hybrid Routing Evaluation",
    "--------------------------------------------------",
    "",
    `Selected deterministic: ${percentage(routing.selectedPlannerDistribution.deterministic)}`,
    `Selected Ollama: ${percentage(routing.selectedPlannerDistribution.ollama)}`,
    `Routing accuracy proxy: ${percentage(routing.routingAccuracyRate)} (${routing.routingAccuracyMatches}/${routing.routingAccuracyAttempts})`,
    `Fallbacks: ${routing.fallbackCount}`,
    `Unavailable executions: ${routing.unavailableExecutionCount}`
  ].join("\n");
}

function hybridRoutingMarkdown(result: BenchmarkSuiteResult): string {
  const routing = result.metrics.hybridRouting;
  if (!routing) {
    return "Hybrid routing was not requested for this benchmark.";
  }
  const hybrid = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "hybrid"
  );
  return [
    "### Hybrid Routing Summary",
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
    "### Routing Rules Used",
    "",
    ...Object.entries(routing.routingRuleCounts).map(
      ([rule, count]) => `- ${rule}: ${count}`
    ),
    "",
    "### Routing Reasons",
    "",
    ...Object.entries(routing.routingReasonCounts).map(
      ([reason, count]) => `- ${reason}: ${count}`
    ),
    "",
    "### Hybrid Performance",
    "",
    hybrid
      ? [
          `- Controlled task success: ${percentage(hybrid.taskSuccessRate)}`,
          `- Seeded bug detection: ${bugDetectionValue(hybrid)}`,
          `- Average duration: ${seconds(hybrid.averageDurationMs)}`,
          `- Stability: ${percentage(hybrid.repeatedRunStability)}`
        ].join("\n")
      : "- No Hybrid performance sample is available."
  ].join("\n");
}

function controlledHybridInterpretation(result: BenchmarkSuiteResult): string[] {
  const deterministic = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "deterministic"
  );
  const ollama = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "ollama"
  );
  const hybrid = result.metrics.plannerPerformance.find(
    (planner) => planner.planner === "hybrid"
  );
  if (!hybrid) {
    return ["No Hybrid performance sample is available."];
  }
  const findings = [
    deterministic
      ? `Controlled success is ${percentage(hybrid.taskSuccessRate)} for Hybrid versus ${percentage(deterministic.taskSuccessRate)} for deterministic.`
      : `Hybrid controlled success is ${percentage(hybrid.taskSuccessRate)}.`,
    deterministic
      ? `Hybrid average duration is ${durationRatio(hybrid.averageDurationMs, deterministic.averageDurationMs)} of deterministic.`
      : `Hybrid average duration is ${seconds(hybrid.averageDurationMs)}.`,
    ollama
      ? `Hybrid average duration is ${durationRatio(hybrid.averageDurationMs, ollama.averageDurationMs)} of Ollama.`
      : "No pure Ollama duration sample is present for comparison.",
    `Hybrid stability is ${percentage(hybrid.repeatedRunStability)}; no stability improvement is claimed unless the measured value exceeds the alternatives.`
  ];
  return findings;
}

function durationRatio(value: number, baseline: number): string {
  return baseline <= 0 ? "N/A" : `${(value / baseline).toFixed(2)}x`;
}

function markdownPerformanceTable(metrics: BenchmarkPerformanceMetrics): string {
  return [
    "| Metric | Value |",
    "| --- | ---: |",
    `| Task success | ${percentage(metrics.taskSuccessRate)} |`,
    `| Bug detection | ${bugDetectionValue(metrics)} |`,
    `| False positive | ${percentage(metrics.falsePositiveRate)} |`,
    `| Infrastructure error | ${percentage(metrics.infrastructureErrorRate)} |`,
    `| Average steps | ${decimal(metrics.averageStepCount)} |`,
    `| Median steps | ${decimal(metrics.medianStepCount)} |`,
    `| Average duration | ${seconds(metrics.averageDurationMs)} |`,
    `| Median duration | ${seconds(metrics.medianDurationMs)} |`,
    `| Repeated-run stability | ${percentage(metrics.repeatedRunStability)} |`,
    `| Average unique page states | ${decimal(metrics.averageUniquePageStates)} |`,
    `| Average candidate actions | ${decimal(metrics.averageCandidateActionsAttempted)} |`,
    `| Average interactive elements | ${decimal(metrics.averageUniqueInteractiveElements)} |`,
    `| Average coverage score | ${percentage(metrics.averageCoverageScore)} |`
  ].join("\n");
}

function markdownGroupTable(
  groupLabel: string,
  groups: readonly [string, BenchmarkPerformanceMetrics][]
): string {
  return [
    `| ${groupLabel} | Runs | Success | Bug detection | False positive | Avg steps | Median steps | Avg duration | Median duration | Stability |`,
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...groups.map(
      ([label, item]) =>
        `| ${label} | ${item.totalRuns} | ${percentage(item.taskSuccessRate)} | ${bugDetectionValue(item)} | ${falsePositiveValue(item)} | ${decimal(item.averageStepCount)} | ${decimal(item.medianStepCount)} | ${seconds(item.averageDurationMs)} | ${seconds(item.medianDurationMs)} | ${percentage(item.repeatedRunStability)} |`
    )
  ].join("\n");
}

function distributionRow(
  label: string,
  distribution: BenchmarkSuiteResult["metrics"]["stepCount"]
): string {
  return `| ${label} | ${distribution.count} | ${decimal(distribution.mean)} | ${decimal(distribution.median)} | ${decimal(distribution.min)} | ${decimal(distribution.max)} | ${decimal(distribution.standardDeviation)} |`;
}

function formatPlainTable(header: string[], rows: string[][]): string {
  const widths = header.map((value, index) =>
    Math.max(value.length, ...rows.map((row) => row[index]?.length ?? 0))
  );
  return [header, ...rows]
    .map((row) =>
      row
        .map((value, index) => value.padEnd(widths[index] ?? value.length))
        .join("  ")
        .trimEnd()
    )
    .join("\n");
}

function plannerLabel(planner: PlannerBenchmarkMetrics): string {
  return planner.modelName
    ? `${capitalize(planner.planner)} (${planner.modelName})`
    : capitalize(planner.planner);
}

function formatModels(result: BenchmarkSuiteResult): string {
  const models = Object.entries(result.configuration.plannerModels);
  return models.length === 0
    ? "none"
    : models.map(([planner, model]) => `${planner}=${model}`).join(", ");
}

function formatFilter(values: readonly string[]): string {
  return values.length === 0 ? "all" : values.join(", ");
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function bugDetectionValue(metrics: BenchmarkPerformanceMetrics): string {
  return metrics.expectedBugOpportunities === 0
    ? "N/A"
    : percentage(metrics.bugDetectionRate);
}

function falsePositiveValue(metrics: BenchmarkPerformanceMetrics): string {
  return metrics.cleanRunOpportunities === 0
    ? "N/A"
    : percentage(metrics.falsePositiveRate);
}

function decimal(value: number): string {
  return value.toFixed(1);
}

function seconds(value: number): string {
  return `${(value / 1000).toFixed(1)}s`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
