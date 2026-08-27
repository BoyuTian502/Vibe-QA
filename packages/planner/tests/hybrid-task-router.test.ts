import { describe, expect, it } from "vitest";

import { HybridTaskRouter, type HybridTaskMetadata } from "../src/index.js";

describe("HybridTaskRouter", () => {
  const router = new HybridTaskRouter();

  it("routes regression tasks to deterministic execution", () => {
    expect(router.route(task({ mode: "regression" }))).toMatchObject({
      planner: "deterministic",
      ruleId: "regression-controlled",
      confidence: "high"
    });
  });

  it("routes explicit functional workflows to deterministic execution", () => {
    expect(
      router.route(task({ hasExpectedBehavior: true, exactWorkflowKnown: true }))
    ).toMatchObject({
      planner: "deterministic",
      ruleId: "functional-known-workflow",
      confidence: "high"
    });
  });

  it("routes explicit exploration to Ollama", () => {
    expect(router.route(task({ mode: "exploratory" }))).toMatchObject({
      planner: "ollama",
      ruleId: "explicit-exploration",
      confidence: "high"
    });
  });

  it("recognizes normalized hidden issue discovery intent", () => {
    expect(
      router.route(
        task({
          objective:
            "Please investigate this workflow and identify unexpected behavior."
        })
      )
    ).toMatchObject({
      planner: "ollama",
      ruleId: "hidden-issue-discovery",
      confidence: "high"
    });
  });

  it("routes pathless recovery tasks to Ollama", () => {
    expect(
      router.route(task({ recoveryRequired: true, exactWorkflowKnown: false }))
    ).toMatchObject({
      planner: "ollama",
      ruleId: "recovery-without-known-path",
      confidence: "medium"
    });
  });

  it("routes same-URL semantic reasoning to Ollama", () => {
    expect(router.route(task({ sameUrlStateReasoning: true }))).toMatchObject({
      planner: "ollama",
      ruleId: "same-url-state-reasoning",
      confidence: "medium"
    });
  });

  it("routes ambiguous goals to Ollama with low confidence", () => {
    expect(router.route(task({ semanticGoalAmbiguous: true }))).toMatchObject({
      planner: "ollama",
      ruleId: "ambiguous-semantic-ollama",
      confidence: "low"
    });
  });

  it("uses a low-confidence deterministic fallback by default", () => {
    const result = router.route(task());

    expect(result).toMatchObject({
      planner: "deterministic",
      ruleId: "conservative-default",
      confidence: "low"
    });
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("applies explicit rule precedence", () => {
    expect(
      router.route(
        task({
          mode: "regression",
          explicitlyExploratory: true,
          hiddenIssueDiscoveryRequested: true,
          recoveryRequired: true,
          sameUrlStateReasoning: true,
          semanticGoalAmbiguous: true
        })
      )
    ).toMatchObject({ ruleId: "regression-controlled" });

    expect(
      router.route(
        task({
          hasExpectedBehavior: true,
          exactWorkflowKnown: true,
          hiddenIssueDiscoveryRequested: true
        })
      )
    ).toMatchObject({ ruleId: "functional-known-workflow" });

    expect(
      router.route(
        task({
          hiddenIssueDiscoveryRequested: true,
          explicitlyExploratory: true,
          semanticGoalAmbiguous: true
        })
      )
    ).toMatchObject({ ruleId: "hidden-issue-discovery" });
  });

  it("cannot be influenced by benchmark-only metadata or credentials", () => {
    const visibleTask = task({ objective: "Verify the account overview." });
    const privilegedA = {
      ...visibleTask,
      scenarioId: "benchmark-one",
      evaluatorRecommendation: "ollama",
      expectedBugId: "BUG-BENCH-001",
      hiddenSelector: "#secret-target",
      password: "first-secret"
    };
    const privilegedB = {
      ...visibleTask,
      scenarioId: "benchmark-two",
      evaluatorRecommendation: "deterministic",
      expectedBugId: "BUG-BENCH-999",
      hiddenSelector: "#different-target",
      password: "second-secret"
    };

    expect(router.route(privilegedA)).toEqual(router.route(privilegedB));
    expect(JSON.stringify(router.route(privilegedA))).not.toContain("secret");
    expect(JSON.stringify(router.route(privilegedA))).not.toContain("BUG-BENCH");
    expect(JSON.stringify(router.route(privilegedA))).not.toContain("benchmark");
  });
});

function task(overrides: Partial<HybridTaskMetadata> = {}): HybridTaskMetadata {
  return {
    mode: "functional",
    objective: "Verify the account overview.",
    hasExpectedBehavior: false,
    exactWorkflowKnown: false,
    ...overrides
  };
}
