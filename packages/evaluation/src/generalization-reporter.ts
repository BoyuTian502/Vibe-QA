import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  GeneralizationPerformanceMetrics,
  GeneralizationSuiteResult
} from "./generalization-types.js";

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
        planners: result.metrics.plannerPerformance
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
    `Scenarios: ${result.scenarios.length}`,
    `Total runs: ${metrics.totalRuns}`,
    `Planner strategies: ${result.configuration.planners.join(", ")}`,
    "",
    `Autonomous Discovery: ${percentage(metrics.autonomousDiscoveryRate)}`,
    `Ambiguous Goal Completion: ${percentage(metrics.goalCompletionRate)}`,
    `Exploration Efficiency: ${decimal(metrics.explorationEfficiency)}`,
    `Detour Rate: ${percentage(metrics.detourRate)}`,
    `State Revisit Rate: ${percentage(metrics.stateRevisitRate)}`,
    `Recovery Success: ${percentage(metrics.recoverySuccessRate)}`,
    `Average Steps: ${decimal(metrics.averageStepCount)}`,
    `Average Duration: ${seconds(metrics.averageDurationMs)}`,
    `Time to Discovery (mean / median): ${decimal(metrics.timeToDiscovery.mean)} / ${decimal(metrics.timeToDiscovery.median)} steps`,
    `Success within 5 / 10 / max steps: ${percentage(metrics.stepBudgetSuccess.within5Steps)} / ${percentage(metrics.stepBudgetSuccess.within10Steps)} / ${percentage(metrics.stepBudgetSuccess.withinMaxSteps)}`,
    ""
  ].join("\n");
}

export function formatGeneralizationMarkdownReport(
  result: GeneralizationSuiteResult
): string {
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
    `- Generated: ${result.generatedAt}`,
    `- Suite: ${result.suite}`,
    `- Planners: ${result.configuration.planners.join(", ")}`,
    `- Runs per scenario: ${result.configuration.runsPerScenario}`,
    `- Git commit: ${result.configuration.gitCommitSha ?? "unavailable"}`,
    `- Browser isolation: ${result.configuration.browserIsolation}`,
    "",
    "### Generalization Metrics",
    "",
    performanceTable(result.metrics),
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
    "### Planner Comparison",
    "",
    result.metrics.plannerPerformance.length > 1
      ? [
          "| Planner | Discovery | Goal completion | Efficiency | Detours | Revisits | Recovery | Avg steps | Avg duration |",
          "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
          ...result.metrics.plannerPerformance.map(
            (planner) =>
              `| ${plannerLabel(planner.planner, planner.modelName)} | ${percentage(planner.autonomousDiscoveryRate)} | ${percentage(planner.goalCompletionRate)} | ${decimal(planner.explorationEfficiency)} | ${percentage(planner.detourRate)} | ${percentage(planner.stateRevisitRate)} | ${percentage(planner.recoverySuccessRate)} | ${decimal(planner.averageStepCount)} | ${seconds(planner.averageDurationMs)} |`
          )
        ].join("\n")
      : "A planner comparison is generated when more than one planner is executed.",
    "",
    "### Difficulty Breakdown",
    "",
    "| Difficulty | Runs | Discovery | Goal completion | Efficiency | Recovery |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...result.metrics.difficultyPerformance.map(
      (item) =>
        `| ${item.difficulty} | ${item.totalRuns} | ${percentage(item.autonomousDiscoveryRate)} | ${percentage(item.goalCompletionRate)} | ${decimal(item.explorationEfficiency)} | ${percentage(item.recoverySuccessRate)} |`
    ),
    "",
    "### Scenario Results",
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
    "- Exploration efficiency is the number of first-time state transitions divided by executed actions.",
    "- A detour is a failed action, a no-state-change action, or a transition to an already observed state.",
    "- State revisit rate is repeated state observations divided by all observations.",
    "- Recovery succeeds when a run reaches its hidden outcome after at least one detour.",
    "- Coverage before discovery counts unique states and interactive elements observed through the first hidden-bug signal.",
    "",
    "### Limitations",
    "",
    "This is a deterministic local benchmark application with a small scenario set. It measures comparative behavior under fixed conditions, not universal website-testing accuracy. Planner results may also vary with local model version and host performance.",
    ""
  ].join("\n");
}

function performanceTable(metrics: GeneralizationPerformanceMetrics): string {
  return [
    "| Metric | Value |",
    "| --- | ---: |",
    `| Autonomous discovery | ${percentage(metrics.autonomousDiscoveryRate)} |`,
    `| Ambiguous goal completion | ${percentage(metrics.goalCompletionRate)} |`,
    `| Exploration efficiency | ${decimal(metrics.explorationEfficiency)} |`,
    `| Detour rate | ${percentage(metrics.detourRate)} |`,
    `| State revisit rate | ${percentage(metrics.stateRevisitRate)} |`,
    `| Recovery success | ${percentage(metrics.recoverySuccessRate)} |`,
    `| Repeated-run stability | ${percentage(metrics.repeatedRunStability)} |`,
    `| Average steps | ${decimal(metrics.averageStepCount)} |`,
    `| Average duration | ${seconds(metrics.averageDurationMs)} |`,
    `| Time to discovery, mean | ${decimal(metrics.timeToDiscovery.mean)} steps |`,
    `| Time to discovery, median | ${decimal(metrics.timeToDiscovery.median)} steps |`,
    `| Success within 5 steps | ${percentage(metrics.stepBudgetSuccess.within5Steps)} |`,
    `| Success within 10 steps | ${percentage(metrics.stepBudgetSuccess.within10Steps)} |`,
    `| Success within max steps | ${percentage(metrics.stepBudgetSuccess.withinMaxSteps)} |`
  ].join("\n");
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
