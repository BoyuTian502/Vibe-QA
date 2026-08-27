import { describe, expect, it } from "vitest";

import {
  GeneralizationRunner,
  calculateLatencyRatio,
  calculateWilsonConfidenceInterval,
  formatGeneralizationMarkdownReport,
  generalizationInterpretation,
  type GeneralizationExecution,
  type GeneralizationScenario
} from "../src/index.js";

describe("generalization robustness reporting", () => {
  it("calculates a two-sided 95% Wilson interval", () => {
    const interval = calculateWilsonConfidenceInterval(5, 10);

    expect(interval).toMatchObject({
      confidenceLevel: 0.95,
      successes: 5,
      attempts: 10
    });
    expect(interval.lower).toBeCloseTo(0.2366, 3);
    expect(interval.upper).toBeCloseTo(0.7634, 3);
  });

  it("calculates the zero-success Wilson boundary", () => {
    const interval = calculateWilsonConfidenceInterval(0, 10);

    expect(interval.lower).toBe(0);
    expect(interval.upper).toBeCloseTo(0.2775, 3);
  });

  it("calculates the full-success Wilson boundary", () => {
    const interval = calculateWilsonConfidenceInterval(10, 10);

    expect(interval.lower).toBeCloseTo(0.7225, 3);
    expect(interval.upper).toBe(1);
  });

  it("groups every scenario independently for each planner", async () => {
    const result = await runner(() => execution({ goalCompleted: true })).run(
      [scenario("one"), scenario("two")],
      { runsPerScenario: 2, planners: ["deterministic", "ollama"] }
    );

    expect(result.metrics.scenarioPlannerPerformance).toHaveLength(4);
    expect(
      result.metrics.scenarioPlannerPerformance.map((item) => ({
        scenario: item.scenarioId,
        planner: item.planner,
        attempts: item.totalRuns,
        successes: item.successfulRuns
      }))
    ).toEqual([
      { scenario: "one", planner: "deterministic", attempts: 2, successes: 2 },
      { scenario: "two", planner: "deterministic", attempts: 2, successes: 2 },
      { scenario: "one", planner: "ollama", attempts: 2, successes: 2 },
      { scenario: "two", planner: "ollama", attempts: 2, successes: 2 }
    ]);
  });

  it("prominently reports sample-size and suite metadata", async () => {
    const result = await runner(() => execution({ goalCompleted: true })).run(
      [scenario("one"), scenario("two")],
      { runsPerScenario: 3, planners: ["deterministic", "ollama"] }
    );
    const report = formatGeneralizationMarkdownReport(result);

    expect(result.configuration).toMatchObject({
      benchmarkSuiteVersion: "3.0.0",
      scenarioCount: 2,
      executionsPerPlanner: 6,
      totalExecutions: 12
    });
    expect(report).toContain("### Sample Metadata");
    expect(report).toContain("- Scenarios: 2");
    expect(report).toContain("- Executions per planner: 6");
    expect(report).toContain("- Total executions: 12");
  });

  it("does not contradict aggregate recovery metrics", async () => {
    const result = await runner((_scenario, _repetition, planner) =>
      execution({ goalCompleted: planner === "ollama" })
    ).run(
      [scenario("recovery-one", "recovery"), scenario("recovery-two", "recovery")],
      {
        runsPerScenario: 2,
        planners: ["deterministic", "ollama"]
      }
    );
    const findings = generalizationInterpretation(result).metricFindings.join(" ");

    expect(findings).toContain("Recovery success is higher for Ollama");
    expect(findings).toContain("deterministic 0.0%, Ollama 100.0%");
    expect(findings).not.toContain("Recovery success is higher for deterministic");
  });

  it("describes opposing scenario outcomes as mixed", async () => {
    const result = await runner((currentScenario, _repetition, planner) =>
      execution({
        goalCompleted:
          (currentScenario.id === "one" && planner === "deterministic") ||
          (currentScenario.id === "two" && planner === "ollama")
      })
    ).run([scenario("one", "ambiguous_goal"), scenario("two", "ambiguous_goal")], {
      runsPerScenario: 2,
      planners: ["deterministic", "ollama"]
    });
    const interpretation = generalizationInterpretation(result);

    expect(interpretation.metricFindings.join(" ")).toContain(
      "Ambiguous goals are mixed by scenario"
    );
    expect(interpretation.metricFindings.join(" ")).toContain(
      "Recovery results are mixed by scenario"
    );
    expect(interpretation.hybridFindings.join(" ")).toContain(
      "neither planner is preferred"
    );
  });

  it("calculates relative duration without dividing by zero", () => {
    expect(calculateLatencyRatio(1_000, 7_500)).toBe(7.5);
    expect(calculateLatencyRatio(0, 7_500)).toBeNull();
  });

  it("adds Hybrid routing and measured performance to the V4 report", async () => {
    const result = await new GeneralizationRunner({
      execute: async () =>
        execution({
          goalCompleted: true,
          routing: {
            requestedStrategy: "hybrid",
            selectedPlanner: "deterministic",
            executedPlanner: "deterministic",
            routingRule: "ambiguous-semantic-default",
            routingReason: "Ambiguous goals use the conservative default.",
            fallback: false,
            fallbackReason: null,
            recommendedPlanner: "deterministic",
            matchedRecommendation: true
          }
        })
    }).run([scenario("hybrid")], {
      runsPerScenario: 1,
      planners: ["hybrid"]
    });
    const report = formatGeneralizationMarkdownReport(result);

    expect(report).toContain("Benchmark V4 - Hybrid Routing Evaluation");
    expect(report).toContain("Selected deterministic: 100.0% (1)");
    expect(report).toContain("Routing accuracy proxy: 100.0% (1/1)");
    expect(report).toContain("Ambiguous goal completion: 100.0%");
  });
});

function runner(
  execute: (
    scenario: GeneralizationScenario,
    repetition: number,
    planner: "deterministic" | "ollama"
  ) => GeneralizationExecution
): GeneralizationRunner {
  return new GeneralizationRunner(
    {
      execute: async (currentScenario, repetition, planner) =>
        execute(currentScenario, repetition, planner)
    },
    {
      gitCommitSha: "benchmark-commit",
      plannerModels: { ollama: "qwen2.5-coder:7b" }
    }
  );
}

function scenario(
  id: string,
  category: GeneralizationScenario["category"] = "ambiguous_goal"
): GeneralizationScenario {
  return {
    id,
    name: `Scenario ${id}`,
    category,
    difficulty: "medium",
    startUrl: "http://benchmark.test/dashboard",
    plannerGoal: "Reach the requested state.",
    hiddenExpectationSummary: "Reach a hidden evaluator state.",
    maxSteps: 5,
    credentialsRequirement: "none",
    routingHints: {
      mode: "functional",
      hasExpectedBehavior: false,
      exactWorkflowKnown: false,
      explicitlyExploratory: false,
      hiddenIssueDiscoveryRequested: false,
      recoveryRequired: category === "recovery",
      semanticGoalAmbiguous: category === "ambiguous_goal"
    },
    evaluatorOnly: {
      recommendedPlanner: category === "recovery" ? "ollama" : "deterministic",
      expectedBugIds: [],
      bugSignals: [],
      goalState: { textIncludes: "done" },
      hiddenTargetSelectors: [],
      hiddenExpectedActions: []
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
    durationMs: 1_000,
    plannerDurationMs: null,
    safetyEvents: { allowed: 1, blocked: 0, approvalRequired: 0 },
    observations: [observed("state-one", 0), observed("state-one", 1)],
    actions: [
      {
        action: { type: "click", selector: "#safe" },
        fromStateFingerprint: "state-one",
        toStateFingerprint: "state-one",
        success: true,
        error: null
      }
    ],
    discoveryStep: null,
    completionStep: null,
    uniqueStatesBeforeDiscovery: 0,
    uniqueElementsBeforeDiscovery: 0,
    approvalRequired: false,
    safetyBlocked: false,
    ...overrides
  };
}

function observed(fingerprint: string, observationIndex: number) {
  const url = "http://benchmark.test/dashboard";
  return {
    fingerprint,
    normalizedUrl: url,
    observationIndex,
    interactiveElementKeys: ["#safe"],
    observation: {
      id: `observation-${observationIndex}`,
      timestamp: "2026-08-27T00:00:00.000Z",
      url,
      title: "Dashboard",
      metadata: { url, title: "Dashboard", viewport: { width: 1280, height: 900 } },
      consoleErrors: [],
      accessibility: { headings: [], landmarks: [], interactiveElementCount: 1 },
      elements: [],
      textSample: "Dashboard",
      screenshotPath: null
    }
  };
}
