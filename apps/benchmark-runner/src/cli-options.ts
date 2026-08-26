import {
  type BenchmarkDifficulty,
  type BenchmarkMode,
  type BenchmarkPlanner
} from "@vibeqa/evaluation";
import { Command, InvalidArgumentError } from "commander";

export interface BenchmarkCliOptions {
  runs: number;
  scenario?: string;
  mode?: BenchmarkMode;
  difficulty?: BenchmarkDifficulty;
  planners: BenchmarkPlanner[];
}

interface RawCliOptions {
  runs: number;
  scenario?: string;
  mode?: BenchmarkMode;
  difficulty?: BenchmarkDifficulty;
  planner: BenchmarkPlanner;
  compare?: BenchmarkPlanner[];
}

export function parseBenchmarkCliOptions(
  argv: readonly string[] = process.argv.slice(2)
): BenchmarkCliOptions {
  const program = new Command()
    .name("vibeqa-benchmark")
    .description("Run the comparative Vibe-QA evaluation benchmark suite")
    .exitOverride()
    .option("--runs <count>", "runs per scenario", parsePositiveInteger, 5)
    .option("--scenario <id>", "run one scenario by ID")
    .option(
      "--mode <mode>",
      "filter by functional, exploratory, or regression",
      parseMode
    )
    .option(
      "--difficulty <difficulty>",
      "filter by easy, medium, or hard",
      parseDifficulty
    )
    .option(
      "--planner <planner>",
      "use deterministic or ollama planning",
      parsePlanner,
      "deterministic"
    )
    .option(
      "--compare <planners>",
      "run comma-separated planners in one session",
      parsePlannerList
    );

  program.parse([...argv], { from: "user" });
  const options = program.opts<RawCliOptions>();
  return {
    runs: options.runs,
    scenario: options.scenario,
    mode: options.mode,
    difficulty: options.difficulty,
    planners: options.compare ?? [options.planner]
  };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("runs must be a positive integer");
  }
  return parsed;
}

function parseMode(value: string): BenchmarkMode {
  if (value === "functional" || value === "exploratory" || value === "regression") {
    return value;
  }
  throw new InvalidArgumentError(`unknown benchmark mode: ${value}`);
}

function parseDifficulty(value: string): BenchmarkDifficulty {
  if (value === "easy" || value === "medium" || value === "hard") {
    return value;
  }
  throw new InvalidArgumentError(`unknown benchmark difficulty: ${value}`);
}

function parsePlanner(value: string): BenchmarkPlanner {
  if (value === "deterministic" || value === "ollama") {
    return value;
  }
  throw new InvalidArgumentError(`unknown benchmark planner: ${value}`);
}

function parsePlannerList(value: string): BenchmarkPlanner[] {
  const planners = [...new Set(value.split(",").map((item) => parsePlanner(item)))];
  if (planners.length === 0) {
    throw new InvalidArgumentError("compare requires at least one planner");
  }
  return planners;
}
