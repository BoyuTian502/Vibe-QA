import { describe, expect, it } from "vitest";

import { HybridTaskRouter, type HybridTaskMetadata } from "../src/index.js";

describe("HybridTaskRouter", () => {
  const router = new HybridTaskRouter();

  it("routes regression tasks to deterministic execution", () => {
    expect(router.route(task({ mode: "regression" }))).toMatchObject({
      planner: "deterministic",
      ruleId: "regression-controlled"
    });
  });

  it("routes explicit functional workflows to deterministic execution", () => {
    expect(
      router.route(
        task({
          mode: "functional",
          hasExpectedBehavior: true,
          exactWorkflowKnown: true
        })
      )
    ).toMatchObject({
      planner: "deterministic",
      ruleId: "functional-known-workflow"
    });
  });

  it("routes explicit exploration to Ollama", () => {
    expect(router.route(task({ mode: "exploratory" }))).toMatchObject({
      planner: "ollama",
      ruleId: "explicit-exploration"
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
      ruleId: "hidden-issue-discovery"
    });
  });

  it("routes pathless recovery tasks to Ollama", () => {
    expect(
      router.route(task({ recoveryRequired: true, exactWorkflowKnown: false }))
    ).toMatchObject({
      planner: "ollama",
      ruleId: "recovery-without-known-path"
    });
  });

  it("conservatively routes ambiguous non-exploratory goals", () => {
    expect(router.route(task({ semanticGoalAmbiguous: true }))).toMatchObject({
      planner: "deterministic",
      ruleId: "ambiguous-semantic-default"
    });
  });

  it("uses deterministic execution when no specific rule applies", () => {
    const result = router.route(task());

    expect(result.planner).toBe("deterministic");
    expect(result.ruleId).toBe("conservative-default");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("cannot be influenced by evaluator metadata or credentials", () => {
    const visibleTask = task({ objective: "Verify the account overview." });
    const privilegedA = {
      ...visibleTask,
      expectedBugId: "BUG-BENCH-001",
      hiddenSelector: "#secret-target",
      password: "first-secret"
    };
    const privilegedB = {
      ...visibleTask,
      expectedBugId: "BUG-BENCH-999",
      hiddenSelector: "#different-target",
      password: "second-secret"
    };

    expect(router.route(privilegedA)).toEqual(router.route(privilegedB));
    expect(JSON.stringify(router.route(privilegedA))).not.toContain("secret");
    expect(JSON.stringify(router.route(privilegedA))).not.toContain("BUG-BENCH");
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
