import { join } from "node:path";

import { startBenchmarkServer } from "@vibeqa/benchmark-app";
import {
  BenchmarkRunner,
  formatBenchmarkSummary,
  writeBenchmarkReport,
  type BenchmarkMode
} from "@vibeqa/evaluation";
import { Command } from "commander";

import { BenchmarkPlaywrightExecutor } from "./executor.js";
import { createBenchmarkScenarios } from "./scenarios.js";

interface CliOptions {
  runs: number;
  scenario?: string;
  mode?: BenchmarkMode;
}

const program = new Command()
  .name("vibeqa-benchmark")
  .description("Run the deterministic Vibe-QA evaluation benchmark suite")
  .option("--runs <count>", "runs per scenario", parsePositiveInteger, 5)
  .option("--scenario <id>", "run one scenario by ID")
  .option("--mode <mode>", "filter by functional, exploratory, or regression")
  .parse();

const options = program.opts<CliOptions>();
if (options.mode && !isBenchmarkMode(options.mode)) {
  program.error(`Unknown benchmark mode: ${options.mode}`);
}

const benchmark = await startBenchmarkServer({ port: 0, host: "127.0.0.1" });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDirectory = join(process.cwd(), "run-output", "benchmark", timestamp);

try {
  const scenarios = createBenchmarkScenarios(benchmark.url);
  let completedRuns = 0;
  const selectedCount = scenarios.filter(
    (scenario) =>
      (!options.scenario || scenario.id === options.scenario) &&
      (!options.mode || scenario.mode === options.mode)
  ).length;
  console.log("--------------------------------------------------");
  console.log("Vibe-QA Evaluation Benchmark");
  console.log("--------------------------------------------------\n");
  console.log(`Benchmark website: ${benchmark.url}`);
  console.log(`Runs per scenario: ${options.runs}`);
  console.log(`Selected scenarios: ${selectedCount}`);
  console.log("Planner: deterministic baseline\n");

  const executor = new BenchmarkPlaywrightExecutor({
    benchmark,
    onRunStart: (scenario, repetition) => {
      completedRuns += 1;
      const totalRuns = selectedCount * options.runs;
      console.log(
        `[${completedRuns}/${totalRuns}] ${scenario.name} (run ${repetition}/${options.runs})`
      );
    }
  });
  const result = await new BenchmarkRunner(executor).run(scenarios, {
    runsPerScenario: options.runs,
    scenarioIds: options.scenario ? [options.scenario] : undefined,
    modes: options.mode ? [options.mode] : undefined
  });
  const paths = await writeBenchmarkReport(outputDirectory, result);
  console.log(`\n${formatBenchmarkSummary(result)}`);
  console.log(`Artifacts: ${paths.outputDirectory}`);
} catch (error) {
  console.error(
    `\nBenchmark failed: ${error instanceof Error ? error.message : "Unknown error"}`
  );
  process.exitCode = 1;
} finally {
  await benchmark.close();
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("runs must be a positive integer");
  }
  return parsed;
}

function isBenchmarkMode(value: string): value is BenchmarkMode {
  return value === "functional" || value === "exploratory" || value === "regression";
}
