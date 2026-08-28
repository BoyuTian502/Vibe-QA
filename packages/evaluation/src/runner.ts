import { randomUUID } from "node:crypto";

import { classifyBenchmarkRun, isSuccessfulClassification } from "./classification.js";
import { aggregateBenchmarkMetrics } from "./metrics.js";
import type {
  BenchmarkApplicationConfiguration,
  BenchmarkConfiguration,
  BenchmarkDifficulty,
  BenchmarkMode,
  BenchmarkPlanner,
  BenchmarkRun,
  BenchmarkRunOptions,
  BenchmarkScenario,
  BenchmarkScenarioExecutor,
  BenchmarkSuiteResult,
  PlannerRoutingMetadata,
  RoutingRecommendationCategory
} from "./types.js";

export interface BenchmarkRunnerOptions {
  now?: () => Date;
  idFactory?: () => string;
  gitCommitSha?: string | null;
  plannerModels?: Partial<Record<BenchmarkPlanner, string>>;
  benchmarkApplication?: BenchmarkApplicationConfiguration;
}

const DEFAULT_BENCHMARK_APPLICATION: BenchmarkApplicationConfiguration = {
  name: "benchmark-saas-workspace",
  version: "0.0.0",
  configuration: "five-seeded-bugs"
};

export class BenchmarkRunner {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly gitCommitSha: string | null;
  private readonly plannerModels: Partial<Record<BenchmarkPlanner, string>>;
  private readonly benchmarkApplication: BenchmarkApplicationConfiguration;

  constructor(
    private readonly executor: BenchmarkScenarioExecutor,
    options: BenchmarkRunnerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.gitCommitSha = options.gitCommitSha ?? null;
    this.plannerModels = { ...options.plannerModels };
    this.benchmarkApplication = {
      ...(options.benchmarkApplication ?? DEFAULT_BENCHMARK_APPLICATION)
    };
  }

  async run(
    scenarios: readonly BenchmarkScenario[],
    options: BenchmarkRunOptions = {}
  ): Promise<BenchmarkSuiteResult> {
    const runsPerScenario = options.runsPerScenario ?? 5;
    if (!Number.isInteger(runsPerScenario) || runsPerScenario < 1) {
      throw new Error("Benchmark runs per scenario must be a positive integer.");
    }
    const requestedPlanners: readonly BenchmarkPlanner[] = options.planners ?? [
      "deterministic"
    ];
    const planners = unique(requestedPlanners);
    if (planners.length === 0) {
      throw new Error("Benchmark execution requires at least one planner.");
    }
    const selectedScenarios = filterBenchmarkScenarios(scenarios, options);
    if (selectedScenarios.length === 0) {
      throw new Error("No benchmark scenarios matched the requested filters.");
    }

    const suiteId = this.idFactory();
    const generatedAt = this.now().toISOString();
    const runs: BenchmarkRun[] = [];
    for (const planner of planners) {
      for (const scenario of selectedScenarios) {
        for (let repetition = 1; repetition <= runsPerScenario; repetition += 1) {
          const startedAt = this.now().toISOString();
          try {
            const execution = await this.executor.execute(
              scenario,
              repetition,
              planner
            );
            const classification = classifyBenchmarkRun(scenario, execution);
            runs.push({
              id: `${planner}-${scenario.id}-${repetition}-${this.idFactory()}`,
              scenarioId: scenario.id,
              scenarioName: scenario.name,
              repetition,
              mode: scenario.mode,
              difficulty: scenario.difficulty,
              planner,
              modelName: this.plannerModels[planner] ?? null,
              startedAt,
              classification,
              expectedOutcomeMet: execution.expectedOutcomeMet,
              expectedBugId: scenario.expectedBugId,
              detectedBugIds: [...execution.detectedBugIds],
              reportedBugCount: execution.reportedBugCount,
              infrastructureError: execution.infrastructureError,
              stepCount: execution.stepCount,
              durationMs: execution.durationMs,
              safetyEvents: { ...execution.safetyEvents },
              exploration: execution.exploration ? { ...execution.exploration } : null,
              routing: annotateRoutingRecommendation(
                execution.routing,
                controlledRecommendation(scenario)
              ),
              adaptive: execution.adaptive
                ? {
                    ...structuredClone(execution.adaptive),
                    finalOutcome: isSuccessfulClassification(classification)
                  }
                : null
            });
          } catch (error) {
            runs.push({
              id: `${planner}-${scenario.id}-${repetition}-${this.idFactory()}`,
              scenarioId: scenario.id,
              scenarioName: scenario.name,
              repetition,
              mode: scenario.mode,
              difficulty: scenario.difficulty,
              planner,
              modelName: this.plannerModels[planner] ?? null,
              startedAt,
              classification: "AGENT_ERROR",
              expectedOutcomeMet: false,
              expectedBugId: scenario.expectedBugId,
              detectedBugIds: [],
              reportedBugCount: 0,
              infrastructureError: safeErrorMessage(error),
              stepCount: 0,
              durationMs: 0,
              safetyEvents: { allowed: 0, blocked: 0, approvalRequired: 0 },
              exploration: null,
              routing: null,
              adaptive: null
            });
          }
        }
      }
    }

    const configuration: BenchmarkConfiguration = {
      runsPerScenario,
      scenarioIds: selectedScenarios.map((scenario) => scenario.id),
      scenarioFilter: [...(options.scenarioIds ?? [])],
      modeFilter: [...(options.modes ?? [])],
      difficultyFilter: [...(options.difficulties ?? [])],
      planner: planners[0] ?? "deterministic",
      planners,
      plannerModels: Object.fromEntries(
        planners.flatMap((planner) =>
          this.plannerModels[planner] ? [[planner, this.plannerModels[planner]]] : []
        )
      ),
      browserIsolation: "fresh-context-per-run",
      gitCommitSha: this.gitCommitSha,
      benchmarkApplication: { ...this.benchmarkApplication },
      randomSeed: null
    };
    return {
      suiteId,
      generatedAt,
      configuration,
      scenarios: selectedScenarios.map(copyScenario),
      runs,
      metrics: aggregateBenchmarkMetrics(runs)
    };
  }
}

function controlledRecommendation(
  scenario: BenchmarkScenario
): RoutingRecommendationCategory {
  return scenario.mode === "exploratory"
    ? "ollama-preferred"
    : "deterministic-preferred";
}

function annotateRoutingRecommendation(
  routing: PlannerRoutingMetadata | null | undefined,
  category: RoutingRecommendationCategory
): PlannerRoutingMetadata | null {
  if (!routing) {
    return null;
  }
  const recommendedPlanner =
    category === "mixed" ? null : category.replace("-preferred", "");
  const validPlanner =
    recommendedPlanner === "deterministic" || recommendedPlanner === "ollama"
      ? recommendedPlanner
      : null;
  return {
    ...routing,
    recommendedPlanner: validPlanner,
    recommendedCategory: category,
    matchedRecommendation:
      validPlanner === null ? null : routing.selectedPlanner === validPlanner
  };
}

function copyScenario(scenario: BenchmarkScenario): BenchmarkScenario {
  return {
    id: scenario.id,
    name: scenario.name,
    mode: scenario.mode,
    difficulty: scenario.difficulty,
    startUrl: scenario.startUrl,
    objective: scenario.objective,
    expectedOutcome: scenario.expectedOutcome,
    expectedBugId: scenario.expectedBugId,
    maxSteps: scenario.maxSteps,
    credentialsRequirement: scenario.credentialsRequirement,
    successCriteria: structuredClone(scenario.successCriteria)
  };
}

export function filterBenchmarkScenarios(
  scenarios: readonly BenchmarkScenario[],
  options: Pick<BenchmarkRunOptions, "scenarioIds" | "modes" | "difficulties">
): BenchmarkScenario[] {
  const scenarioIds = new Set(options.scenarioIds ?? []);
  const modes = new Set<BenchmarkMode>(options.modes ?? []);
  const difficulties = new Set<BenchmarkDifficulty>(options.difficulties ?? []);
  return scenarios.filter(
    (scenario) =>
      (scenarioIds.size === 0 || scenarioIds.has(scenario.id)) &&
      (modes.size === 0 || modes.has(scenario.mode)) &&
      (difficulties.size === 0 || difficulties.has(scenario.difficulty))
  );
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown benchmark error";
  return message.replace(
    /((?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi,
    "$1[REDACTED]"
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
