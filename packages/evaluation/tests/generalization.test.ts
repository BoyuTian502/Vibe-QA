import type { Observation } from "@vibeqa/schemas";
import { describe, expect, it } from "vitest";

import {
  GeneralizationRunner,
  aggregateBenchmarkMetrics,
  aggregateGeneralizationMetrics,
  calculateDetourRate,
  calculateExplorationEfficiency,
  calculateRecoverySuccessRate,
  calculateStateRevisitRate,
  classifyGeneralizationRun,
  formatGeneralizationMarkdownReport,
  toGeneralizationPlannerInput,
  type BenchmarkRun,
  type GeneralizationExecution,
  type GeneralizationRun,
  type GeneralizationScenario
} from "../src/index.js";

describe("generalization benchmark evaluation", () => {
  it("keeps evaluator-only data out of planner input and result scenario metadata", async () => {
    const input = toGeneralizationPlannerInput(scenario());
    const result = await new GeneralizationRunner({
      execute: async () => execution()
    }).run([scenario()], { runsPerScenario: 1 });
    const plannerJson = JSON.stringify(input);
    const scenarioJson = JSON.stringify(result.scenarios);

    expect(plannerJson).not.toContain("BUG-BENCH-999");
    expect(plannerJson).not.toContain("#hidden-target");
    expect(plannerJson).not.toContain("hidden exact sequence");
    expect(scenarioJson).not.toContain("#hidden-target");
    expect(scenarioJson).not.toContain("hidden exact sequence");
    expect(plannerJson).not.toContain("recommendedPlanner");
    expect(scenarioJson).not.toContain("recommendedPlanner");
    expect(result.suite).toBe("generalization-v3");
  });

  it("classifies found and missed hidden bugs", () => {
    expect(
      classifyGeneralizationRun(
        scenario(),
        execution({ detectedBugIds: ["BUG-BENCH-999"], goalCompleted: true })
      )
    ).toBe("HIDDEN_BUG_FOUND");
    expect(classifyGeneralizationRun(scenario(), execution())).toBe(
      "HIDDEN_BUG_MISSED"
    );
  });

  it("credits first-time transitions once and counts later revisits as detours", async () => {
    const first = observed(0);
    const second = observed(1);
    const revisit = { ...observed(2), fingerprint: first.fingerprint };
    const result = await new GeneralizationRunner({
      execute: async () =>
        execution({
          observations: [first, second, revisit],
          actions: [
            {
              ...action(),
              fromStateFingerprint: first.fingerprint,
              toStateFingerprint: second.fingerprint
            },
            {
              ...action(),
              fromStateFingerprint: second.fingerprint,
              toStateFingerprint: first.fingerprint
            }
          ]
        })
    }).run([scenario()], { runsPerScenario: 1 });

    expect(result.runs[0]).toMatchObject({
      usefulNewStates: 1,
      detourActions: 1,
      revisitedStates: 1,
      recoveryRequired: true
    });
  });

  it("calculates discovery, efficiency, detour, revisit, recovery, and budgets", () => {
    const runs = [
      run({
        classification: "HIDDEN_BUG_FOUND",
        detectedBugIds: ["BUG-BENCH-999"],
        usefulNewStates: 2,
        detourActions: 1,
        revisitedStates: 1,
        recoveryRequired: true,
        recoverySucceeded: true,
        discoveryStep: 3,
        uniqueStatesBeforeDiscovery: 3,
        uniqueElementsBeforeDiscovery: 7
      }),
      run({
        id: "run-2",
        classification: "HIDDEN_BUG_MISSED",
        usefulNewStates: 1,
        detourActions: 2,
        revisitedStates: 2,
        recoveryRequired: true,
        recoverySucceeded: false,
        actions: [action(), action(), action(), action(), action(), action()],
        observations: [observed(0), observed(1), observed(2), observed(3)]
      })
    ];
    const metrics = aggregateGeneralizationMetrics(runs);

    expect(metrics.autonomousDiscoveryRate).toBe(0.5);
    expect(calculateExplorationEfficiency(runs)).toBeCloseTo(0.3);
    expect(calculateDetourRate(runs)).toBeCloseTo(0.3);
    expect(calculateStateRevisitRate(runs)).toBeCloseTo(3 / 8);
    expect(calculateRecoverySuccessRate(runs)).toBe(0.5);
    expect(metrics.timeToDiscovery).toMatchObject({
      count: 1,
      mean: 3,
      median: 3,
      min: 3,
      max: 3
    });
    expect(metrics.stepBudgetSuccess.within5Steps).toBe(0.5);
    expect(metrics.stepBudgetSuccess.within10Steps).toBe(0.5);
    expect(metrics.stepBudgetSuccess.withinMaxSteps).toBe(0.5);
  });

  it("keeps planner comparison separate and documents V2 versus V3", async () => {
    const result = await new GeneralizationRunner({
      execute: async (_scenario, _repetition, planner) =>
        execution({
          goalCompleted: planner === "deterministic",
          detectedBugIds: planner === "deterministic" ? ["BUG-BENCH-999"] : []
        })
    }).run([scenario()], {
      runsPerScenario: 1,
      planners: ["deterministic", "ollama"]
    });
    const report = formatGeneralizationMarkdownReport(result);

    expect(result.metrics.plannerPerformance).toHaveLength(2);
    expect(report).toContain("Benchmark V2 - Controlled Workflow Reliability");
    expect(report).toContain("Benchmark V3 - Generalization & Autonomous Discovery");
    expect(report).toContain("Controlled workflows measure repeatable execution");
  });

  it("leaves controlled V2 metric behavior unchanged", () => {
    const metrics = aggregateBenchmarkMetrics([controlledRun()]);

    expect(metrics.taskSuccessRate).toBe(1);
    expect(metrics.bugDetectionRate).toBe(0);
    expect(metrics.averageStepCount).toBe(4);
    expect(metrics.plannerPerformance).toHaveLength(1);
  });
});

function scenario(): GeneralizationScenario {
  return {
    id: "hidden",
    name: "Hidden bug",
    category: "hidden_bug",
    difficulty: "hard",
    startUrl: "http://benchmark.test/dashboard",
    plannerGoal: "Explore the dashboard and report failures.",
    hiddenExpectationSummary: "Discover a seeded failure.",
    maxSteps: 10,
    credentialsRequirement: "benchmark-account",
    routingHints: {
      mode: "functional",
      hasExpectedBehavior: false,
      exactWorkflowKnown: false,
      explicitlyExploratory: false,
      hiddenIssueDiscoveryRequested: true,
      recoveryRequired: false,
      semanticGoalAmbiguous: false
    },
    evaluatorOnly: {
      recommendedPlanner: "ollama",
      expectedBugIds: ["BUG-BENCH-999"],
      bugSignals: [
        {
          bugId: "BUG-BENCH-999",
          type: "console_error",
          textIncludes: "hidden failure"
        }
      ],
      hiddenTargetSelectors: ["#hidden-target"],
      hiddenExpectedActions: ["hidden exact sequence"]
    }
  };
}

function execution(
  overrides: Partial<GeneralizationExecution> = {}
): GeneralizationExecution {
  return {
    goalCompleted: false,
    detectedBugIds: [],
    infrastructureError: null,
    durationMs: 100,
    safetyEvents: { allowed: 4, blocked: 0, approvalRequired: 0 },
    observations: [observed(0), observed(1), observed(2), observed(3)],
    actions: [action(), action(), action(), action()],
    discoveryStep: null,
    completionStep: null,
    uniqueStatesBeforeDiscovery: 0,
    uniqueElementsBeforeDiscovery: 0,
    approvalRequired: false,
    safetyBlocked: false,
    ...overrides
  };
}

function run(overrides: Partial<GeneralizationRun> = {}): GeneralizationRun {
  return {
    ...execution(),
    id: "run-1",
    scenarioId: "hidden",
    scenarioName: "Hidden bug",
    category: "hidden_bug",
    difficulty: "hard",
    planner: "deterministic",
    modelName: null,
    repetition: 1,
    startedAt: "2026-08-26T00:00:00.000Z",
    maxSteps: 10,
    classification: "HIDDEN_BUG_MISSED",
    expectedBugIds: ["BUG-BENCH-999"],
    usefulNewStates: 0,
    detourActions: 0,
    revisitedStates: 0,
    recoveryRequired: false,
    recoverySucceeded: false,
    ...overrides
  };
}

function observed(index: number) {
  const observation = observationAt(index);
  return {
    fingerprint: `state-${index}`,
    normalizedUrl: observation.url,
    observation,
    observationIndex: index,
    interactiveElementKeys: [`element-${index}`]
  };
}

function action() {
  return {
    action: { type: "click" as const, selector: "#safe" },
    fromStateFingerprint: "state-0",
    toStateFingerprint: "state-1",
    success: true,
    error: null
  };
}

function observationAt(index: number): Observation {
  const url = `http://benchmark.test/dashboard?state=${index}`;
  return {
    id: `observation-${index}`,
    timestamp: "2026-08-26T00:00:00.000Z",
    url,
    title: "Dashboard",
    metadata: { url, title: "Dashboard", viewport: { width: 1280, height: 900 } },
    consoleErrors: [],
    accessibility: { headings: [], landmarks: [], interactiveElementCount: 0 },
    elements: [],
    textSample: `state ${index}`,
    screenshotPath: null
  };
}

function controlledRun(): BenchmarkRun {
  return {
    id: "controlled",
    scenarioId: "login",
    scenarioName: "Login",
    repetition: 1,
    mode: "functional",
    difficulty: "easy",
    planner: "deterministic",
    modelName: null,
    startedAt: "2026-08-26T00:00:00.000Z",
    classification: "PASS",
    expectedOutcomeMet: true,
    expectedBugId: null,
    detectedBugIds: [],
    reportedBugCount: 0,
    infrastructureError: null,
    stepCount: 4,
    durationMs: 100,
    safetyEvents: { allowed: 4, blocked: 0, approvalRequired: 0 },
    exploration: null
  };
}
