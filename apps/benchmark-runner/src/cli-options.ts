import {
  type BenchmarkDifficulty,
  type BenchmarkMode,
  type BenchmarkPlanner
} from "@vibeqa/evaluation";
import type { AdaptivePolicyVersion } from "@vibeqa/adaptive-execution";
import { Command, InvalidArgumentError } from "commander";

export interface BenchmarkCliOptions {
  suite: "controlled-v2" | "generalization-v3";
  runs: number;
  scenario?: string;
  mode?: BenchmarkMode;
  difficulty?: BenchmarkDifficulty;
  planners: BenchmarkPlanner[];
  adaptiveDebugReplay: boolean;
  adaptivePostEscalationStepBudget: number | null;
  adaptivePolicyVersion: AdaptivePolicyVersion;
}

interface RawCliOptions {
  suite: "controlled-v2" | "generalization-v3";
  runs: number;
  scenario?: string;
  mode?: BenchmarkMode;
  difficulty?: BenchmarkDifficulty;
  planner: BenchmarkPlanner;
  compare?: BenchmarkPlanner[];
  adaptiveDebugReplay?: boolean;
  postEscalationSteps?: number;
  adaptivePolicy: AdaptivePolicyVersion;
}

export function parseBenchmarkCliOptions(
  argv: readonly string[] = process.argv.slice(2)
): BenchmarkCliOptions {
  const program = new Command()
    .name("vibeqa-benchmark")
    .description("Run the comparative Vibe-QA evaluation benchmark suite")
    .exitOverride()
    .option(
      "--suite <suite>",
      "use controlled or generalization benchmark suite",
      parseSuite,
      "controlled-v2"
    )
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
      "use deterministic, ollama, hybrid, or adaptive planning",
      parsePlanner,
      "deterministic"
    )
    .option(
      "--compare <planners>",
      "run comma-separated planners in one session",
      parsePlannerList
    )
    .option(
      "--adaptive-debug-replay",
      "enable evaluator-only Adaptive post-escalation budget replay"
    )
    .option(
      "--post-escalation-steps <count>",
      "cap Adaptive debug replay to this many post-escalation actions",
      parsePositiveInteger
    )
    .option(
      "--adaptive-policy <version>",
      "use Adaptive policy v1 or opportunity-preserving v2",
      parseAdaptivePolicy,
      "v2"
    );

  program.parse([...argv], { from: "user" });
  const options = program.opts<RawCliOptions>();
  const planners = options.compare ?? [options.planner];
  if (options.adaptiveDebugReplay && !planners.includes("adaptive")) {
    throw new InvalidArgumentError(
      "adaptive debug replay requires the adaptive planner"
    );
  }
  if (options.adaptiveDebugReplay && options.suite !== "generalization-v3") {
    throw new InvalidArgumentError(
      "adaptive debug replay requires the generalization suite"
    );
  }
  if (options.postEscalationSteps && !options.adaptiveDebugReplay) {
    throw new InvalidArgumentError(
      "post-escalation-steps requires --adaptive-debug-replay"
    );
  }
  return {
    suite: options.suite,
    runs: options.runs,
    scenario: options.scenario,
    mode: options.mode,
    difficulty: options.difficulty,
    planners,
    adaptiveDebugReplay: options.adaptiveDebugReplay ?? false,
    adaptivePostEscalationStepBudget: options.adaptiveDebugReplay
      ? (options.postEscalationSteps ?? 3)
      : null,
    adaptivePolicyVersion: options.adaptivePolicy
  };
}

function parseAdaptivePolicy(value: string): AdaptivePolicyVersion {
  if (value === "v1" || value === "v2") return value;
  throw new InvalidArgumentError(`unknown Adaptive policy version: ${value}`);
}

function parseSuite(value: string): "controlled-v2" | "generalization-v3" {
  if (value === "controlled" || value === "controlled-v2" || value === "v2") {
    return "controlled-v2";
  }
  if (value === "generalization" || value === "generalization-v3" || value === "v3") {
    return "generalization-v3";
  }
  throw new InvalidArgumentError(`unknown benchmark suite: ${value}`);
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
  if (
    value === "deterministic" ||
    value === "ollama" ||
    value === "hybrid" ||
    value === "adaptive"
  ) {
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
