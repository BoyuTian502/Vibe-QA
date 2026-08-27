import { describe, expect, it } from "vitest";

import {
  aggregateHybridRoutingDiagnostics,
  DEFAULT_ROUTING_REGRET_THRESHOLD,
  type HybridDiagnosticSource,
  type PlannerRoutingMetadata
} from "../src/index.js";

describe("Hybrid routing diagnostics", () => {
  it("builds a routing confusion matrix and agreement breakdowns", () => {
    const diagnostics = requiredDiagnostics([
      pure("scenario-a", "deterministic", true),
      pure("scenario-a", "ollama", false),
      hybrid("scenario-a", "category-a", "deterministic", "high", true),
      pure("scenario-b", "deterministic", false),
      pure("scenario-b", "ollama", true),
      hybrid("scenario-b", "category-b", "deterministic", "low", false, {
        recommendation: "ollama-preferred"
      })
    ]);

    expect(diagnostics.confusionMatrix).toEqual({
      deterministic: {
        "deterministic-preferred": 1,
        "ollama-preferred": 1,
        mixed: 0
      },
      ollama: {
        "deterministic-preferred": 0,
        "ollama-preferred": 0,
        mixed: 0
      }
    });
    expect(diagnostics.routingAgreementRate).toBe(0.5);
    expect(diagnostics.agreedOutcomePerformance).toMatchObject({
      runs: 1,
      successRate: 1
    });
    expect(diagnostics.disagreedOutcomePerformance).toMatchObject({
      runs: 1,
      successRate: 0
    });
    expect(diagnostics.agreementByScenario).toHaveLength(2);
    expect(diagnostics.agreementByCategory).toHaveLength(2);
  });

  it("compares historical planner performance without claiming a causal result", () => {
    const diagnostics = requiredDiagnostics([
      pure("hidden", "deterministic", false),
      pure("hidden", "deterministic", false),
      pure("hidden", "ollama", true),
      pure("hidden", "ollama", true),
      hybrid("hidden", "hidden_bug", "deterministic", "high", false, {
        recommendation: "ollama-preferred"
      })
    ]);
    const regret = diagnostics.executions[0]?.regret;

    expect(regret).toMatchObject({
      selectedPlannerHistoricalSuccessRate: 0,
      alternativePlannerHistoricalSuccessRate: 1,
      estimatedDifference: 1,
      materiallyWorse: true
    });
    expect(diagnostics.routingRegretRate).toBe(1);
  });

  it("uses a configurable conservative regret threshold", () => {
    const sources = [
      ...rateSamples("threshold", "deterministic", 7, 10),
      ...rateSamples("threshold", "ollama", 9, 10),
      hybrid("threshold", "ambiguous_goal", "deterministic", "low", true, {
        recommendation: "ollama-preferred"
      })
    ];

    expect(
      requiredDiagnostics(sources, DEFAULT_ROUTING_REGRET_THRESHOLD).routingRegretCount
    ).toBe(1);
    expect(requiredDiagnostics(sources, 0.21).routingRegretCount).toBe(0);
    const exactBoundary = [
      ...rateSamples("exact-boundary", "deterministic", 8, 10),
      ...rateSamples("exact-boundary", "ollama", 10, 10),
      hybrid("exact-boundary", "ambiguous_goal", "deterministic", "low", true, {
        recommendation: "ollama-preferred"
      })
    ];
    expect(requiredDiagnostics(exactBoundary, 0.2).routingRegretCount).toBe(1);
    expect(() => requiredDiagnostics(sources, 1.1)).toThrow("Routing regret threshold");
  });

  it("aggregates rule and low-confidence performance", () => {
    const diagnostics = requiredDiagnostics([
      pure("ambiguous", "deterministic", false),
      pure("ambiguous", "ollama", true),
      hybrid("ambiguous", "ambiguous_goal", "ollama", "low", true, {
        rule: "ambiguous-semantic-ollama",
        recommendation: "ollama-preferred"
      }),
      hybrid("ambiguous", "ambiguous_goal", "ollama", "low", false, {
        rule: "ambiguous-semantic-ollama",
        recommendation: "ollama-preferred"
      })
    ]);

    expect(diagnostics.rulePerformance[0]).toMatchObject({
      ruleId: "ambiguous-semantic-ollama",
      uses: 2,
      selectedPlanner: "ollama",
      taskSuccessRate: 0.5,
      routingAgreementRate: 1,
      estimatedRoutingRegretRate: 0
    });
    expect(
      diagnostics.confidencePerformance.find((item) => item.confidence === "low")
    ).toMatchObject({ runs: 2, successfulRuns: 1, successRate: 0.5 });
  });

  it("estimates V1 regret from changed V2 rules without rerunning V1", () => {
    const diagnostics = requiredDiagnostics([
      pure("same-url", "deterministic", false),
      pure("same-url", "ollama", true),
      hybrid("same-url", "same_url_state", "ollama", "medium", true, {
        rule: "same-url-state-reasoning",
        recommendation: "ollama-preferred"
      })
    ]);

    expect(diagnostics.routingRegretRate).toBe(0);
    expect(diagnostics.v1EstimatedRoutingRegretRate).toBe(1);
    expect(diagnostics.estimatedRoutingRegretImprovement).toBe(1);
  });
});

function requiredDiagnostics(
  sources: readonly HybridDiagnosticSource[],
  threshold = DEFAULT_ROUTING_REGRET_THRESHOLD
) {
  const diagnostics = aggregateHybridRoutingDiagnostics(sources, threshold);
  if (!diagnostics) {
    throw new Error("Expected Hybrid diagnostics.");
  }
  return diagnostics;
}

function pure(
  scenarioId: string,
  planner: "deterministic" | "ollama",
  success: boolean
): HybridDiagnosticSource {
  return source(scenarioId, planner, success);
}

function hybrid(
  scenarioId: string,
  category: string,
  selectedPlanner: "deterministic" | "ollama",
  confidence: "high" | "medium" | "low",
  success: boolean,
  overrides: {
    rule?: string;
    recommendation?: "deterministic-preferred" | "ollama-preferred" | "mixed";
  } = {}
): HybridDiagnosticSource {
  return {
    ...source(scenarioId, "hybrid", success),
    category,
    routing: routing(
      selectedPlanner,
      confidence,
      overrides.rule ?? "test-rule",
      overrides.recommendation ?? "deterministic-preferred"
    )
  };
}

function source(
  scenarioId: string,
  planner: "deterministic" | "ollama" | "hybrid",
  success: boolean
): HybridDiagnosticSource {
  return {
    planner,
    scenarioId,
    category: "functional",
    taskMode: "functional",
    classification: success ? "GOAL_COMPLETED" : "GOAL_INCOMPLETE",
    taskSuccess: success,
    hiddenBugDiscovered: null,
    recoverySuccess: null,
    durationMs: 100,
    steps: 2,
    explorationEfficiency: 0.5,
    revisitRate: 0.25,
    detourRate: 0.5,
    routing: null
  };
}

function routing(
  selectedPlanner: "deterministic" | "ollama",
  confidence: "high" | "medium" | "low",
  rule: string,
  recommendation: "deterministic-preferred" | "ollama-preferred" | "mixed"
): PlannerRoutingMetadata {
  const recommendedPlanner =
    recommendation === "mixed"
      ? null
      : recommendation === "ollama-preferred"
        ? "ollama"
        : "deterministic";
  return {
    requestedStrategy: "hybrid",
    selectedPlanner,
    executedPlanner: selectedPlanner,
    routingRule: rule,
    routingReason: "Test routing reason.",
    routerVersion: "v2",
    routingConfidence: confidence,
    fallback: false,
    fallbackReason: null,
    recommendedPlanner,
    recommendedCategory: recommendation,
    matchedRecommendation:
      recommendedPlanner === null ? null : selectedPlanner === recommendedPlanner
  };
}

function rateSamples(
  scenarioId: string,
  planner: "deterministic" | "ollama",
  successes: number,
  total: number
): HybridDiagnosticSource[] {
  return Array.from({ length: total }, (_, index) =>
    pure(scenarioId, planner, index < successes)
  );
}
