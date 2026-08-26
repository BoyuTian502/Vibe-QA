import { describe, expect, it } from "vitest";

import {
  BenchmarkRunner,
  aggregateBenchmarkMetrics,
  calculateRepeatedRunStability,
  classifyBenchmarkRun,
  describeDistribution,
  filterBenchmarkScenarios,
  formatBenchmarkSummary,
  type BenchmarkExecution,
  type BenchmarkRun,
  type BenchmarkScenario
} from "../src/index.js";

describe("benchmark classification", () => {
  it("classifies a successful run", () => {
    expect(classifyBenchmarkRun(scenario(), execution())).toBe("PASS");
  });

  it("classifies an expected seeded bug as benchmark success", () => {
    expect(
      classifyBenchmarkRun(
        scenario({ expectedBugId: "BUG-BENCH-005" }),
        execution({
          expectedOutcomeMet: true,
          detectedBugIds: ["BUG-BENCH-005"],
          reportedBugCount: 1
        })
      )
    ).toBe("EXPECTED_BUG_FOUND");
  });

  it("classifies a missed seeded bug", () => {
    expect(
      classifyBenchmarkRun(
        scenario({ expectedBugId: "BUG-BENCH-005" }),
        execution({ expectedOutcomeMet: false })
      )
    ).toBe("MISSED_BUG");
  });

  it("classifies an unexpected report as a false positive", () => {
    expect(
      classifyBenchmarkRun(
        scenario(),
        execution({ expectedOutcomeMet: false, reportedBugCount: 1 })
      )
    ).toBe("FALSE_POSITIVE");
  });

  it("keeps agent errors separate from website bugs", () => {
    expect(
      classifyBenchmarkRun(
        scenario({ expectedBugId: "BUG-BENCH-005" }),
        execution({
          infrastructureError: "Browser failed to launch",
          reportedBugCount: 1,
          detectedBugIds: ["BUG-BENCH-005"]
        })
      )
    ).toBe("AGENT_ERROR");
  });

  it("classifies approval and blocked safety outcomes", () => {
    expect(
      classifyBenchmarkRun(
        scenario(),
        execution({
          safetyEvents: { allowed: 1, blocked: 0, approvalRequired: 1 }
        })
      )
    ).toBe("APPROVAL_REQUIRED");
    expect(
      classifyBenchmarkRun(
        scenario(),
        execution({
          safetyEvents: { allowed: 1, blocked: 1, approvalRequired: 0 }
        })
      )
    ).toBe("SAFETY_BLOCKED");
  });
});

describe("benchmark metrics", () => {
  const runs = [
    run({
      id: "clean-pass-1",
      scenarioId: "clean",
      classification: "PASS",
      durationMs: 1000,
      stepCount: 4,
      safetyEvents: { allowed: 4, blocked: 0, approvalRequired: 0 }
    }),
    run({
      id: "clean-false-positive",
      scenarioId: "clean",
      classification: "FALSE_POSITIVE",
      expectedOutcomeMet: false,
      reportedBugCount: 1,
      durationMs: 3000,
      stepCount: 6,
      safetyEvents: { allowed: 5, blocked: 1, approvalRequired: 0 }
    }),
    run({
      id: "bug-found",
      scenarioId: "bug",
      scenarioName: "Seeded bug",
      classification: "EXPECTED_BUG_FOUND",
      expectedBugId: "BUG-BENCH-005",
      detectedBugIds: ["BUG-BENCH-005"],
      reportedBugCount: 1,
      durationMs: 5000,
      stepCount: 8,
      safetyEvents: { allowed: 7, blocked: 0, approvalRequired: 1 }
    }),
    run({
      id: "bug-missed",
      scenarioId: "bug",
      scenarioName: "Seeded bug",
      classification: "MISSED_BUG",
      expectedBugId: "BUG-BENCH-005",
      expectedOutcomeMet: false,
      durationMs: 7000,
      stepCount: 10,
      safetyEvents: { allowed: 8, blocked: 0, approvalRequired: 0 }
    })
  ];

  it("calculates success, bug-detection, and false-positive rates", () => {
    const metrics = aggregateBenchmarkMetrics(runs);
    expect(metrics.taskSuccessRate).toBe(0.5);
    expect(metrics.bugDetectionRate).toBe(0.5);
    expect(metrics.falsePositiveRate).toBe(0.5);
  });

  it("calculates average, median, min, and max distributions", () => {
    expect(describeDistribution([1000, 3000, 5000, 7000])).toEqual({
      count: 4,
      mean: 4000,
      median: 4000,
      min: 1000,
      max: 7000
    });
    const metrics = aggregateBenchmarkMetrics(runs);
    expect(metrics.durationMs.mean).toBe(4000);
    expect(metrics.stepCount.mean).toBe(7);
  });

  it("calculates repeated-run stability by scenario", () => {
    expect(calculateRepeatedRunStability(runs)).toBe(0.5);
  });

  it("aggregates safety events", () => {
    expect(aggregateBenchmarkMetrics(runs).safetyEvents).toEqual({
      allowed: 24,
      blocked: 1,
      approvalRequired: 1
    });
  });
});

describe("benchmark runner", () => {
  it("filters scenarios by ID and mode", () => {
    const scenarios = [scenario(), scenario({ id: "explore", mode: "exploratory" })];
    expect(
      filterBenchmarkScenarios(scenarios, { modes: ["exploratory"] }).map(
        (item) => item.id
      )
    ).toEqual(["explore"]);
    expect(
      filterBenchmarkScenarios(scenarios, { scenarioIds: ["clean"] }).map(
        (item) => item.id
      )
    ).toEqual(["clean"]);
  });

  it("executes multiple repeated runs", async () => {
    let calls = 0;
    const runner = new BenchmarkRunner(
      {
        execute: async () => {
          calls += 1;
          return execution();
        }
      },
      {
        now: () => new Date("2026-08-26T08:00:00.000Z"),
        idFactory: () => `id-${calls}`
      }
    );
    const result = await runner.run(
      [scenario(), scenario({ id: "second", mode: "regression" })],
      { runsPerScenario: 3 }
    );

    expect(calls).toBe(6);
    expect(result.runs).toHaveLength(6);
    expect(result.metrics.totalRuns).toBe(6);
  });

  it("redacts credential-like infrastructure errors from structured output", async () => {
    const runner = new BenchmarkRunner({
      execute: async () => {
        throw new Error("password=portfolio-secret");
      }
    });
    const result = await runner.run([scenario()], { runsPerScenario: 1 });
    const output = JSON.stringify(result);

    expect(output).not.toContain("portfolio-secret");
    expect(result.runs[0]?.classification).toBe("AGENT_ERROR");
  });

  it("formats a concise quantitative summary", async () => {
    const result = await new BenchmarkRunner({
      execute: async () => execution()
    }).run([scenario()], { runsPerScenario: 1 });
    const summary = formatBenchmarkSummary(result);

    expect(summary).toContain("Vibe-QA Evaluation Benchmark");
    expect(summary).toContain("Task Success Rate: 100.0%");
    expect(summary).toContain("Planner: deterministic");
  });
});

function scenario(overrides: Partial<BenchmarkScenario> = {}): BenchmarkScenario {
  return {
    id: "clean",
    name: "Clean workflow",
    mode: "functional",
    startUrl: "http://benchmark.test/login",
    objective: "Verify a clean workflow",
    expectedOutcome: "The workflow passes.",
    expectedBugId: null,
    maxSteps: 5,
    credentialsRequirement: "none",
    successCriteria: { type: "test_passed" },
    ...overrides
  };
}

function execution(overrides: Partial<BenchmarkExecution> = {}): BenchmarkExecution {
  return {
    expectedOutcomeMet: true,
    detectedBugIds: [],
    reportedBugCount: 0,
    infrastructureError: null,
    stepCount: 4,
    durationMs: 1000,
    safetyEvents: { allowed: 4, blocked: 0, approvalRequired: 0 },
    exploration: null,
    ...overrides
  };
}

function run(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id: "run",
    scenarioId: "clean",
    scenarioName: "Clean workflow",
    repetition: 1,
    mode: "functional",
    startedAt: "2026-08-26T08:00:00.000Z",
    classification: "PASS",
    expectedOutcomeMet: true,
    expectedBugId: null,
    detectedBugIds: [],
    reportedBugCount: 0,
    infrastructureError: null,
    stepCount: 4,
    durationMs: 1000,
    safetyEvents: { allowed: 4, blocked: 0, approvalRequired: 0 },
    exploration: null,
    ...overrides
  };
}
