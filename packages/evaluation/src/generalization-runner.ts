import { randomUUID } from "node:crypto";

import { aggregateGeneralizationMetrics } from "./generalization-metrics.js";
import type {
  GeneralizationClassification,
  GeneralizationConfiguration,
  GeneralizationExecution,
  GeneralizationPlannerInput,
  GeneralizationRun,
  GeneralizationRunOptions,
  GeneralizationScenario,
  GeneralizationScenarioExecutor,
  GeneralizationScenarioSummary,
  GeneralizationSuiteResult
} from "./generalization-types.js";
import type {
  BenchmarkApplicationConfiguration,
  BenchmarkDifficulty,
  BenchmarkPlanner,
  PlannerRoutingMetadata,
  RoutingRecommendationCategory
} from "./types.js";

export interface GeneralizationRunnerOptions {
  now?: () => Date;
  idFactory?: () => string;
  gitCommitSha?: string | null;
  plannerModels?: Partial<Record<BenchmarkPlanner, string>>;
  benchmarkApplication?: BenchmarkApplicationConfiguration;
}

const DEFAULT_APPLICATION: BenchmarkApplicationConfiguration = {
  name: "benchmark-saas-workspace",
  version: "0.0.0",
  configuration: "five-seeded-bugs-plus-generalization-states"
};

export class GeneralizationRunner {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly gitCommitSha: string | null;
  private readonly plannerModels: Partial<Record<BenchmarkPlanner, string>>;
  private readonly benchmarkApplication: BenchmarkApplicationConfiguration;

  constructor(
    private readonly executor: GeneralizationScenarioExecutor,
    options: GeneralizationRunnerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.gitCommitSha = options.gitCommitSha ?? null;
    this.plannerModels = { ...options.plannerModels };
    this.benchmarkApplication = {
      ...(options.benchmarkApplication ?? DEFAULT_APPLICATION)
    };
  }

  async run(
    scenarios: readonly GeneralizationScenario[],
    options: GeneralizationRunOptions = {}
  ): Promise<GeneralizationSuiteResult> {
    const runsPerScenario = options.runsPerScenario ?? 5;
    if (!Number.isInteger(runsPerScenario) || runsPerScenario < 1) {
      throw new Error("Generalization runs per scenario must be a positive integer.");
    }

    const planners: BenchmarkPlanner[] = unique<BenchmarkPlanner>(
      options.planners ?? ["deterministic"]
    );
    if (planners.length === 0) {
      throw new Error("Generalization execution requires at least one planner.");
    }
    const selectedScenarios = filterGeneralizationScenarios(scenarios, options);
    if (selectedScenarios.length === 0) {
      throw new Error("No generalization scenarios matched the requested filters.");
    }

    const runs: GeneralizationRun[] = [];
    for (const planner of planners) {
      for (const scenario of selectedScenarios) {
        for (let repetition = 1; repetition <= runsPerScenario; repetition += 1) {
          const startedAt = this.now().toISOString();
          let execution: GeneralizationExecution;
          try {
            execution = await this.executor.execute(scenario, repetition, planner);
          } catch (error) {
            execution = failedExecution(error);
          }
          runs.push(
            createRun(
              scenario,
              execution,
              planner,
              repetition,
              startedAt,
              this.idFactory(),
              this.plannerModels[planner] ?? null
            )
          );
        }
      }
    }

    const configuration: GeneralizationConfiguration = {
      benchmarkSuiteVersion: "3.0.0",
      runsPerScenario,
      scenarioCount: selectedScenarios.length,
      executionsPerPlanner: selectedScenarios.length * runsPerScenario,
      totalExecutions: selectedScenarios.length * runsPerScenario * planners.length,
      scenarioIds: selectedScenarios.map((scenario) => scenario.id),
      scenarioFilter: [...(options.scenarioIds ?? [])],
      difficultyFilter: [...(options.difficulties ?? [])],
      planners,
      plannerModels: Object.fromEntries(
        planners.flatMap((planner) => {
          const model = this.plannerModels[planner];
          return model ? [[planner, model]] : [];
        })
      ),
      browserIsolation: "fresh-context-per-run",
      gitCommitSha: this.gitCommitSha,
      benchmarkApplication: { ...this.benchmarkApplication },
      randomSeed: null
    };

    return {
      suite: "generalization-v3",
      suiteId: this.idFactory(),
      generatedAt: this.now().toISOString(),
      configuration,
      scenarios: selectedScenarios.map(toScenarioSummary),
      runs,
      metrics: aggregateGeneralizationMetrics(runs)
    };
  }
}

export function toGeneralizationPlannerInput(
  scenario: GeneralizationScenario
): GeneralizationPlannerInput {
  return {
    goal: scenario.plannerGoal,
    startUrl: scenario.startUrl,
    maxSteps: scenario.maxSteps
  };
}

export function toScenarioSummary(
  scenario: GeneralizationScenario
): GeneralizationScenarioSummary {
  return {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    difficulty: scenario.difficulty,
    startUrl: scenario.startUrl,
    plannerGoal: scenario.plannerGoal,
    hiddenExpectationSummary: scenario.hiddenExpectationSummary,
    maxSteps: scenario.maxSteps,
    credentialsRequirement: scenario.credentialsRequirement,
    routingHints: { ...scenario.routingHints }
  };
}

export function filterGeneralizationScenarios(
  scenarios: readonly GeneralizationScenario[],
  options: Pick<GeneralizationRunOptions, "scenarioIds" | "difficulties">
): GeneralizationScenario[] {
  const ids = new Set(options.scenarioIds ?? []);
  const difficulties = new Set<BenchmarkDifficulty>(options.difficulties ?? []);
  return scenarios.filter(
    (scenario) =>
      (ids.size === 0 || ids.has(scenario.id)) &&
      (difficulties.size === 0 || difficulties.has(scenario.difficulty))
  );
}

function createRun(
  scenario: GeneralizationScenario,
  execution: GeneralizationExecution,
  planner: BenchmarkPlanner,
  repetition: number,
  startedAt: string,
  id: string,
  modelName: string | null
): GeneralizationRun {
  const observedStates = new Set<string>();
  let revisitedStates = 0;
  for (const observation of execution.observations) {
    if (observedStates.has(observation.fingerprint)) {
      revisitedStates += 1;
    } else {
      observedStates.add(observation.fingerprint);
    }
  }
  const seenDuringActions = new Set<string>(
    execution.observations[0] ? [execution.observations[0].fingerprint] : []
  );
  let usefulNewStates = 0;
  let detourActions = 0;
  for (const action of execution.actions) {
    const isUsefulNewState =
      action.success &&
      action.toStateFingerprint !== null &&
      action.toStateFingerprint !== action.fromStateFingerprint &&
      !seenDuringActions.has(action.toStateFingerprint);
    if (isUsefulNewState) {
      usefulNewStates += 1;
    } else {
      detourActions += 1;
    }
    if (action.toStateFingerprint) {
      seenDuringActions.add(action.toStateFingerprint);
    }
  }
  const classification = classifyGeneralizationRun(scenario, execution);
  const successful =
    classification === "HIDDEN_BUG_FOUND" || classification === "GOAL_COMPLETED";

  return {
    ...execution,
    routing: annotateRoutingRecommendation(
      execution.routing,
      scenario.evaluatorOnly.recommendedPlannerCategory
    ),
    adaptive: execution.adaptive
      ? { ...structuredClone(execution.adaptive), finalOutcome: successful }
      : null,
    id: `${planner}-${scenario.id}-${repetition}-${id}`,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    category: scenario.category,
    difficulty: scenario.difficulty,
    planner,
    modelName,
    repetition,
    startedAt,
    maxSteps: scenario.maxSteps,
    classification,
    expectedBugIds: [...scenario.evaluatorOnly.expectedBugIds],
    usefulNewStates,
    detourActions,
    revisitedStates,
    recoveryRequired: detourActions > 0,
    recoverySucceeded: detourActions > 0 && successful
  };
}

function annotateRoutingRecommendation(
  routing: PlannerRoutingMetadata | null | undefined,
  category: RoutingRecommendationCategory
): PlannerRoutingMetadata | null {
  if (!routing) {
    return null;
  }
  const recommendedPlanner =
    category === "deterministic-preferred"
      ? "deterministic"
      : category === "ollama-preferred"
        ? "ollama"
        : null;
  return {
    ...routing,
    recommendedPlanner,
    recommendedCategory: category,
    matchedRecommendation:
      recommendedPlanner === null
        ? null
        : routing.selectedPlanner === recommendedPlanner
  };
}

export function classifyGeneralizationRun(
  scenario: GeneralizationScenario,
  execution: GeneralizationExecution
): GeneralizationClassification {
  if (scenario.evaluatorOnly.expectedBugIds.length > 0) {
    if (
      scenario.evaluatorOnly.expectedBugIds.every((bugId) =>
        execution.detectedBugIds.includes(bugId)
      )
    ) {
      return "HIDDEN_BUG_FOUND";
    }
  } else if (execution.goalCompleted) {
    return "GOAL_COMPLETED";
  }
  if (execution.infrastructureError) {
    return "AGENT_ERROR";
  }
  if (execution.safetyBlocked) {
    return "SAFETY_BLOCKED";
  }
  if (execution.approvalRequired) {
    return "APPROVAL_REQUIRED";
  }
  if (scenario.evaluatorOnly.expectedBugIds.length > 0) {
    return "HIDDEN_BUG_MISSED";
  }
  return "GOAL_INCOMPLETE";
}

function failedExecution(error: unknown): GeneralizationExecution {
  return {
    goalCompleted: false,
    detectedBugIds: [],
    infrastructureError: safeErrorMessage(error),
    durationMs: 0,
    safetyEvents: { allowed: 0, blocked: 0, approvalRequired: 0 },
    observations: [],
    actions: [],
    discoveryStep: null,
    completionStep: null,
    uniqueStatesBeforeDiscovery: 0,
    uniqueElementsBeforeDiscovery: 0,
    approvalRequired: false,
    safetyBlocked: false,
    routing: null,
    adaptive: null
  };
}

function safeErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Unknown generalization error";
  return message.replace(
    /((?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi,
    "$1[REDACTED]"
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
