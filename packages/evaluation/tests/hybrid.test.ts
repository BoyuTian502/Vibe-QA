import { describe, expect, it } from "vitest";

import {
  aggregateBenchmarkMetrics,
  aggregateHybridRoutingMetrics,
  BenchmarkRunner,
  formatBenchmarkMarkdownReport,
  type BenchmarkRun,
  type PlannerRoutingMetadata
} from "../src/index.js";

describe("hybrid benchmark metrics", () => {
  it("calculates routing distribution, accuracy, fallback, and rule counts", () => {
    const metrics = aggregateHybridRoutingMetrics([
      run("one", routing("deterministic", "deterministic", true)),
      run("two", routing("ollama", "deterministic", true, true)),
      run("three", routing("ollama", null, false))
    ]);

    expect(metrics).toMatchObject({
      totalHybridRuns: 3,
      selectedPlannerCounts: { deterministic: 1, ollama: 2 },
      selectedPlannerDistribution: {
        deterministic: 1 / 3,
        ollama: 2 / 3
      },
      executedPlannerCounts: { deterministic: 2, ollama: 0 },
      fallbackCount: 1,
      ollamaUnavailableFallbackCount: 1,
      unavailableExecutionCount: 1,
      routingAccuracyAttempts: 3,
      routingAccuracyMatches: 2,
      routingAccuracyRate: 2 / 3
    });
    expect(metrics?.routingRuleCounts).toEqual({ "test-rule": 3 });
  });

  it("does not count a Hybrid fallback as an Ollama benchmark execution", () => {
    const metrics = aggregateBenchmarkMetrics([
      run("fallback", routing("ollama", "deterministic", true, true))
    ]);

    expect(metrics.plannerPerformance).toHaveLength(1);
    expect(metrics.plannerPerformance[0]?.planner).toBe("hybrid");
    expect(metrics.hybridRouting?.selectedPlannerCounts.ollama).toBe(1);
    expect(metrics.hybridRouting?.executedPlannerCounts.ollama).toBe(0);
    expect(metrics.hybridRouting?.executedPlannerCounts.deterministic).toBe(1);
  });

  it("adds measured Hybrid routing to the controlled V4 report", async () => {
    const metadata = routing("deterministic", "deterministic", true);
    const result = await new BenchmarkRunner({
      execute: async () => ({
        expectedOutcomeMet: true,
        detectedBugIds: [],
        reportedBugCount: 0,
        infrastructureError: null,
        stepCount: 2,
        durationMs: 100,
        safetyEvents: { allowed: 2, blocked: 0, approvalRequired: 0 },
        exploration: null,
        routing: metadata
      })
    }).run(
      [
        {
          id: "controlled",
          name: "Controlled workflow",
          mode: "functional",
          difficulty: "easy",
          startUrl: "http://benchmark.test/login",
          objective: "Verify login.",
          expectedOutcome: "Dashboard is visible.",
          expectedBugId: null,
          maxSteps: 3,
          credentialsRequirement: "none",
          successCriteria: { type: "test_passed" }
        }
      ],
      { runsPerScenario: 1, planners: ["hybrid"] }
    );
    const report = formatBenchmarkMarkdownReport(result);

    expect(report).toContain("Benchmark V4 - Hybrid Routing Evaluation");
    expect(report).toContain("Selected deterministic: 100.0% (1)");
    expect(report).toContain("Routing accuracy proxy: 100.0% (1/1)");
    expect(report).toContain("Controlled task success: 100.0%");
  });
});

function run(id: string, metadata: PlannerRoutingMetadata): BenchmarkRun {
  return {
    id,
    scenarioId: id,
    scenarioName: id,
    repetition: 1,
    mode: "functional",
    difficulty: "medium",
    planner: "hybrid",
    modelName: "rule-based-v1",
    startedAt: "2026-08-27T00:00:00.000Z",
    classification: "PASS",
    expectedOutcomeMet: true,
    expectedBugId: null,
    detectedBugIds: [],
    reportedBugCount: 0,
    infrastructureError: null,
    stepCount: 2,
    durationMs: 100,
    safetyEvents: { allowed: 2, blocked: 0, approvalRequired: 0 },
    exploration: null,
    routing: metadata
  };
}

function routing(
  selectedPlanner: "deterministic" | "ollama",
  executedPlanner: "deterministic" | "ollama" | null,
  matchedRecommendation: boolean,
  fallback = false
): PlannerRoutingMetadata {
  return {
    requestedStrategy: "hybrid",
    selectedPlanner,
    executedPlanner,
    routingRule: "test-rule",
    routingReason: "Measured test routing reason.",
    fallback,
    fallbackReason: fallback ? "ollama-unavailable" : null,
    recommendedPlanner: selectedPlanner,
    matchedRecommendation
  };
}
