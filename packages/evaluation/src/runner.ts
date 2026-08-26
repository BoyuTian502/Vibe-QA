import { randomUUID } from "node:crypto";

import { classifyBenchmarkRun } from "./classification.js";
import { aggregateBenchmarkMetrics } from "./metrics.js";
import type {
  BenchmarkConfiguration,
  BenchmarkMode,
  BenchmarkRun,
  BenchmarkRunOptions,
  BenchmarkScenario,
  BenchmarkScenarioExecutor,
  BenchmarkSuiteResult
} from "./types.js";

export interface BenchmarkRunnerOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export class BenchmarkRunner {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly executor: BenchmarkScenarioExecutor,
    options: BenchmarkRunnerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async run(
    scenarios: readonly BenchmarkScenario[],
    options: BenchmarkRunOptions = {}
  ): Promise<BenchmarkSuiteResult> {
    const runsPerScenario = options.runsPerScenario ?? 5;
    if (!Number.isInteger(runsPerScenario) || runsPerScenario < 1) {
      throw new Error("Benchmark runs per scenario must be a positive integer.");
    }
    const selectedScenarios = filterBenchmarkScenarios(scenarios, options);
    if (selectedScenarios.length === 0) {
      throw new Error("No benchmark scenarios matched the requested filters.");
    }

    const suiteId = this.idFactory();
    const generatedAt = this.now().toISOString();
    const runs: BenchmarkRun[] = [];
    for (const scenario of selectedScenarios) {
      for (let repetition = 1; repetition <= runsPerScenario; repetition += 1) {
        const startedAt = this.now().toISOString();
        try {
          const execution = await this.executor.execute(scenario, repetition);
          runs.push({
            id: `${scenario.id}-${repetition}-${this.idFactory()}`,
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            repetition,
            mode: scenario.mode,
            startedAt,
            classification: classifyBenchmarkRun(scenario, execution),
            expectedOutcomeMet: execution.expectedOutcomeMet,
            expectedBugId: scenario.expectedBugId,
            detectedBugIds: [...execution.detectedBugIds],
            reportedBugCount: execution.reportedBugCount,
            infrastructureError: execution.infrastructureError,
            stepCount: execution.stepCount,
            durationMs: execution.durationMs,
            safetyEvents: { ...execution.safetyEvents },
            exploration: execution.exploration ? { ...execution.exploration } : null
          });
        } catch (error) {
          runs.push({
            id: `${scenario.id}-${repetition}-${this.idFactory()}`,
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            repetition,
            mode: scenario.mode,
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
            exploration: null
          });
        }
      }
    }

    const configuration: BenchmarkConfiguration = {
      runsPerScenario,
      scenarioFilter: [...(options.scenarioIds ?? [])],
      modeFilter: [...(options.modes ?? [])],
      planner: "deterministic",
      browserIsolation: "fresh-context-per-run"
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

function copyScenario(scenario: BenchmarkScenario): BenchmarkScenario {
  return {
    id: scenario.id,
    name: scenario.name,
    mode: scenario.mode,
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
  options: Pick<BenchmarkRunOptions, "scenarioIds" | "modes">
): BenchmarkScenario[] {
  const scenarioIds = new Set(options.scenarioIds ?? []);
  const modes = new Set<BenchmarkMode>(options.modes ?? []);
  return scenarios.filter(
    (scenario) =>
      (scenarioIds.size === 0 || scenarioIds.has(scenario.id)) &&
      (modes.size === 0 || modes.has(scenario.mode))
  );
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown benchmark error";
  return message.replace(
    /((?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi,
    "$1[REDACTED]"
  );
}
