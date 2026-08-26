import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BenchmarkSuiteResult } from "./types.js";

export interface BenchmarkReportPaths {
  outputDirectory: string;
  summaryPath: string;
  runsPath: string;
}

export async function writeBenchmarkReport(
  outputDirectory: string,
  result: BenchmarkSuiteResult
): Promise<BenchmarkReportPaths> {
  const summaryPath = join(outputDirectory, "summary.json");
  const runsPath = join(outputDirectory, "runs.json");
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeJson(summaryPath, {
      suiteId: result.suiteId,
      generatedAt: result.generatedAt,
      configuration: result.configuration,
      scenarios: result.scenarios,
      metrics: result.metrics
    }),
    writeJson(runsPath, result.runs)
  ]);
  return { outputDirectory, summaryPath, runsPath };
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
    `Planner: ${result.configuration.planner}`,
    "",
    `Task Success Rate: ${percentage(metrics.taskSuccessRate)}`,
    `Seeded Bug Detection Rate: ${percentage(metrics.bugDetectionRate)}`,
    `False Positive Rate: ${percentage(metrics.falsePositiveRate)}`,
    `Infrastructure Error Rate: ${percentage(metrics.infrastructureErrorRate)}`,
    `Average Steps: ${decimal(metrics.stepCount.mean)}`,
    `Average Duration: ${seconds(metrics.durationMs.mean)}`,
    `Median Duration: ${seconds(metrics.durationMs.median)}`,
    `Repeated-run Stability: ${percentage(metrics.repeatedRunStability)}`,
    "",
    "Safety Events:",
    `Allowed: ${metrics.safetyEvents.allowed}`,
    `Blocked: ${metrics.safetyEvents.blocked}`,
    `Approval Required: ${metrics.safetyEvents.approvalRequired}`,
    "",
    "--------------------------------------------------",
    "Scenario Results",
    "--------------------------------------------------",
    "",
    ...metrics.scenarioResults.map(
      (scenario) =>
        `${scenario.scenarioName}: ${scenario.expectedOutcomes} / ${scenario.totalRuns} expected outcomes`
    ),
    ""
  ];
  return lines.join("\n");
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function decimal(value: number): string {
  return value.toFixed(1);
}

function seconds(value: number): string {
  return `${(value / 1000).toFixed(1)}s`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
