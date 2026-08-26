import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { startBenchmarkServer, type BenchmarkServer } from "@vibeqa/benchmark-app";
import {
  BenchmarkRunner,
  formatBenchmarkSummary,
  writeBenchmarkReport,
  type BenchmarkPlanner
} from "@vibeqa/evaluation";
import { OllamaClient } from "@vibeqa/llm";

import { parseBenchmarkCliOptions } from "./cli-options.js";
import { BenchmarkPlaywrightExecutor } from "./executor.js";
import {
  DeterministicBenchmarkPlannerStrategy,
  OllamaBenchmarkPlannerStrategy,
  type BenchmarkPlannerStrategy
} from "./planner-strategies.js";
import { createBenchmarkScenarios } from "./scenarios.js";

const OLLAMA_MODEL = "qwen2.5-coder:7b";

await main();

async function main(): Promise<void> {
  let benchmark: BenchmarkServer | null = null;
  try {
    const options = parseBenchmarkCliOptions();
    const strategies = createPlannerStrategies(options.planners);
    for (const planner of options.planners) {
      await requiredStrategy(strategies, planner).verifyAvailability();
    }

    benchmark = await startBenchmarkServer({ port: 0, host: "127.0.0.1" });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDirectory = join(process.cwd(), "run-output", "benchmark", timestamp);
    const scenarios = createBenchmarkScenarios(benchmark.url);
    let completedRuns = 0;
    const selectedCount = scenarios.filter(
      (scenario) =>
        (!options.scenario || scenario.id === options.scenario) &&
        (!options.mode || scenario.mode === options.mode) &&
        (!options.difficulty || scenario.difficulty === options.difficulty)
    ).length;
    const totalRuns = selectedCount * options.runs * options.planners.length;

    console.log("--------------------------------------------------");
    console.log("Vibe-QA Comparative Evaluation Benchmark");
    console.log("--------------------------------------------------\n");
    console.log(`Benchmark website: ${benchmark.url}`);
    console.log(`Runs per scenario: ${options.runs}`);
    console.log(`Selected scenarios: ${selectedCount}`);
    console.log(`Planner strategies: ${options.planners.join(", ")}\n`);

    const executor = new BenchmarkPlaywrightExecutor({
      benchmark,
      plannerStrategies: strategies,
      onRunStart: (scenario, repetition, planner) => {
        completedRuns += 1;
        console.log(
          `[${completedRuns}/${totalRuns}] ${scenario.name} [${scenario.difficulty}] (${planner}, run ${repetition}/${options.runs})`
        );
      }
    });
    const result = await new BenchmarkRunner(executor, {
      gitCommitSha: readGitCommitSha(),
      plannerModels: options.planners.includes("ollama")
        ? { ollama: OLLAMA_MODEL }
        : {},
      benchmarkApplication: {
        name: "benchmark-saas-workspace",
        version: "0.0.0",
        configuration: "five-seeded-bugs"
      }
    }).run(scenarios, {
      runsPerScenario: options.runs,
      scenarioIds: options.scenario ? [options.scenario] : undefined,
      modes: options.mode ? [options.mode] : undefined,
      difficulties: options.difficulty ? [options.difficulty] : undefined,
      planners: options.planners
    });
    const paths = await writeBenchmarkReport(outputDirectory, result);
    console.log(`\n${formatBenchmarkSummary(result)}`);
    console.log(`Artifacts: ${paths.outputDirectory}`);
    console.log(`Markdown report: ${paths.reportPath}`);
    if (paths.comparisonPath) {
      console.log(`Planner comparison: ${paths.comparisonPath}`);
    }
  } catch (error) {
    console.error(
      `\nBenchmark failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exitCode = 1;
  } finally {
    await benchmark?.close();
  }
}

function createPlannerStrategies(
  planners: readonly BenchmarkPlanner[]
): Partial<Record<BenchmarkPlanner, BenchmarkPlannerStrategy>> {
  const strategies: Partial<Record<BenchmarkPlanner, BenchmarkPlannerStrategy>> = {};
  if (planners.includes("deterministic")) {
    strategies.deterministic = new DeterministicBenchmarkPlannerStrategy();
  }
  if (planners.includes("ollama")) {
    strategies.ollama = new OllamaBenchmarkPlannerStrategy(
      new OllamaClient(OLLAMA_MODEL),
      OLLAMA_MODEL
    );
  }
  return strategies;
}

function requiredStrategy(
  strategies: Partial<Record<BenchmarkPlanner, BenchmarkPlannerStrategy>>,
  planner: BenchmarkPlanner
): BenchmarkPlannerStrategy {
  const strategy = strategies[planner];
  if (!strategy) {
    throw new Error(`No benchmark planner strategy is configured for ${planner}.`);
  }
  return strategy;
}

function readGitCommitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8"
    }).trim();
  } catch {
    return null;
  }
}
