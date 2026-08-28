import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { startBenchmarkServer, type BenchmarkServer } from "@vibeqa/benchmark-app";
import {
  BenchmarkRunner,
  GeneralizationRunner,
  formatBenchmarkSummary,
  formatGeneralizationSummary,
  writeBenchmarkReport,
  writeGeneralizationReport,
  type BenchmarkPlanner
} from "@vibeqa/evaluation";
import { OllamaClient, type LLMClient } from "@vibeqa/llm";

import { parseBenchmarkCliOptions } from "./cli-options.js";
import { BenchmarkPlaywrightExecutor } from "./executor.js";
import { GeneralizationPlaywrightExecutor } from "./generalization-executor.js";
import { createGeneralizationScenarios } from "./generalization-scenarios.js";
import {
  DeterministicBenchmarkPlannerStrategy,
  AdaptiveBenchmarkPlannerStrategy,
  HybridBenchmarkPlannerStrategy,
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
    const ollamaClient =
      options.planners.includes("ollama") ||
      options.planners.includes("hybrid") ||
      options.planners.includes("adaptive")
        ? new OllamaClient(OLLAMA_MODEL)
        : null;
    const strategies = createPlannerStrategies(options.planners, ollamaClient);
    for (const planner of options.planners) {
      await requiredStrategy(strategies, planner).verifyAvailability();
    }

    benchmark = await startBenchmarkServer({ port: 0, host: "127.0.0.1" });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDirectory = join(process.cwd(), "run-output", "benchmark", timestamp);
    if (options.suite === "generalization-v3") {
      await runGeneralizationBenchmark({
        benchmark,
        outputDirectory,
        options,
        ollamaClient,
        strategies
      });
      return;
    }

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
      ollamaClient: ollamaClient ?? undefined,
      ollamaStrategy: strategies.ollama as OllamaBenchmarkPlannerStrategy | undefined,
      adaptivePolicyVersion: options.adaptivePolicyVersion,
      onRunStart: (scenario, repetition, planner) => {
        completedRuns += 1;
        console.log(
          `[${completedRuns}/${totalRuns}] ${scenario.name} [${scenario.difficulty}] (${planner}, run ${repetition}/${options.runs})`
        );
      }
    });
    const result = await new BenchmarkRunner(executor, {
      gitCommitSha: readGitCommitSha(),
      plannerModels: plannerModels(options.planners, options.adaptivePolicyVersion),
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
  planners: readonly BenchmarkPlanner[],
  ollamaClient: LLMClient | null
): Partial<Record<BenchmarkPlanner, BenchmarkPlannerStrategy>> {
  const strategies: Partial<Record<BenchmarkPlanner, BenchmarkPlannerStrategy>> = {};
  const deterministic = new DeterministicBenchmarkPlannerStrategy();
  if (
    planners.includes("deterministic") ||
    planners.includes("hybrid") ||
    planners.includes("adaptive")
  ) {
    strategies.deterministic = deterministic;
  }
  if (
    planners.includes("ollama") ||
    planners.includes("hybrid") ||
    planners.includes("adaptive")
  ) {
    if (!ollamaClient) {
      throw new Error("The Ollama planner client is not configured.");
    }
    const ollama = new OllamaBenchmarkPlannerStrategy(ollamaClient, OLLAMA_MODEL);
    strategies.ollama = ollama;
    if (planners.includes("hybrid")) {
      strategies.hybrid = new HybridBenchmarkPlannerStrategy(deterministic, ollama, {
        allowDeterministicFallback: false
      });
    }
    if (planners.includes("adaptive")) {
      strategies.adaptive = new AdaptiveBenchmarkPlannerStrategy(deterministic);
    }
  }
  return strategies;
}

async function runGeneralizationBenchmark(input: {
  benchmark: BenchmarkServer;
  outputDirectory: string;
  options: ReturnType<typeof parseBenchmarkCliOptions>;
  ollamaClient: LLMClient | null;
  strategies: Partial<Record<BenchmarkPlanner, BenchmarkPlannerStrategy>>;
}): Promise<void> {
  const scenarios = createGeneralizationScenarios(input.benchmark.url);
  const selectedCount = scenarios.filter(
    (scenario) =>
      (!input.options.scenario || scenario.id === input.options.scenario) &&
      (!input.options.difficulty || scenario.difficulty === input.options.difficulty)
  ).length;
  const totalRuns = selectedCount * input.options.runs * input.options.planners.length;
  let completedRuns = 0;

  console.log("--------------------------------------------------");
  console.log("Vibe-QA Generalization & Autonomous Discovery Benchmark");
  console.log("--------------------------------------------------\n");
  console.log(`Benchmark website: ${input.benchmark.url}`);
  console.log(`Suite: generalization-v3`);
  console.log(`Runs per scenario: ${input.options.runs}`);
  console.log(`Selected scenarios: ${selectedCount}`);
  console.log(`Planner strategies: ${input.options.planners.join(", ")}\n`);
  if (input.options.adaptiveDebugReplay) {
    console.log(
      `Adaptive diagnostic replay: ${input.options.adaptivePostEscalationStepBudget} post-escalation action(s)\n`
    );
  }
  if (input.options.planners.includes("adaptive")) {
    console.log(`Adaptive policy: ${input.options.adaptivePolicyVersion}\n`);
  }

  const executor = new GeneralizationPlaywrightExecutor({
    benchmark: input.benchmark,
    ollamaClient: input.ollamaClient ?? undefined,
    hybridStrategy: input.strategies.hybrid as
      HybridBenchmarkPlannerStrategy | undefined,
    ollamaStrategy: input.strategies.ollama as
      OllamaBenchmarkPlannerStrategy | undefined,
    adaptiveDebugReplay: input.options.adaptiveDebugReplay,
    adaptivePostEscalationStepBudget:
      input.options.adaptivePostEscalationStepBudget ?? undefined,
    adaptivePolicyVersion: input.options.adaptivePolicyVersion,
    onRunStart: (scenario, repetition, planner) => {
      completedRuns += 1;
      console.log(
        `[${completedRuns}/${totalRuns}] ${scenario.name} [${scenario.difficulty}] (${planner}, run ${repetition}/${input.options.runs})`
      );
    }
  });
  const result = await new GeneralizationRunner(executor, {
    gitCommitSha: readGitCommitSha(),
    plannerModels: plannerModels(
      input.options.planners,
      input.options.adaptivePolicyVersion
    ),
    benchmarkApplication: {
      name: "benchmark-saas-workspace",
      version: "0.0.0",
      configuration: "five-seeded-bugs-plus-generalization-states"
    },
    adaptiveDebugReplay: input.options.adaptiveDebugReplay,
    adaptivePostEscalationStepBudget: input.options.adaptivePostEscalationStepBudget,
    adaptivePolicyVersion: input.options.adaptivePolicyVersion
  }).run(scenarios, {
    runsPerScenario: input.options.runs,
    scenarioIds: input.options.scenario ? [input.options.scenario] : undefined,
    difficulties: input.options.difficulty ? [input.options.difficulty] : undefined,
    planners: input.options.planners
  });
  const paths = await writeGeneralizationReport(input.outputDirectory, result);
  console.log(`\n${formatGeneralizationSummary(result)}`);
  console.log(`Artifacts: ${paths.outputDirectory}`);
  console.log(`Markdown report: ${paths.reportPath}`);
  if (paths.comparisonPath) {
    console.log(`Planner comparison: ${paths.comparisonPath}`);
  }
}

function plannerModels(
  planners: readonly BenchmarkPlanner[],
  adaptivePolicyVersion: "v1" | "v2"
): Partial<Record<BenchmarkPlanner, string>> {
  return {
    ...(planners.includes("ollama") ? { ollama: OLLAMA_MODEL } : {}),
    ...(planners.includes("hybrid") ? { hybrid: "rule-based-v2" } : {}),
    ...(planners.includes("adaptive")
      ? { adaptive: `adaptive-${adaptivePolicyVersion}+${OLLAMA_MODEL}` }
      : {})
  };
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
