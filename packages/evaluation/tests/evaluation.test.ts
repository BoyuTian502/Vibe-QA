import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BenchmarkRunner,
  aggregateBenchmarkMetrics,
  calculateRepeatedRunStability,
  classifyBenchmarkRun,
  describeDistribution,
  filterBenchmarkScenarios,
  formatBenchmarkMarkdownReport,
  formatBenchmarkSummary,
  formatPlannerComparison,
  writeBenchmarkReport,
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
      max: 7000,
      standardDeviation: Math.sqrt(5_000_000)
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

  it("calculates population standard deviation", () => {
    expect(describeDistribution([2, 4, 4, 4, 5, 5, 7, 9]).standardDeviation).toBe(2);
  });

  it("groups performance by planner, mode, and difficulty", () => {
    const groupedRuns = [
      run({ id: "det-easy", difficulty: "easy" }),
      run({
        id: "ollama-hard",
        planner: "ollama",
        modelName: "qwen2.5-coder:7b",
        mode: "exploratory",
        difficulty: "hard",
        exploration: {
          uniquePageStates: 4,
          uniqueInteractiveElements: 12,
          candidateActionsAttempted: 3,
          coverageScore: 0.8,
          terminationReason: "max_steps"
        }
      })
    ];
    const metrics = aggregateBenchmarkMetrics(groupedRuns);

    expect(metrics.plannerPerformance).toHaveLength(2);
    expect(metrics.modePerformance).toHaveLength(2);
    expect(metrics.difficultyPerformance).toHaveLength(2);
    expect(
      metrics.plannerPerformance.find((item) => item.planner === "ollama")
    ).toMatchObject({
      modelName: "qwen2.5-coder:7b",
      averageUniquePageStates: 4,
      averageCandidateActionsAttempted: 3,
      averageUniqueInteractiveElements: 12,
      averageCoverageScore: 0.8
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

  it("filters scenarios by difficulty", () => {
    const scenarios = [
      scenario({ id: "easy", difficulty: "easy" }),
      scenario({ id: "hard", difficulty: "hard" })
    ];
    expect(
      filterBenchmarkScenarios(scenarios, { difficulties: ["hard"] }).map(
        (item) => item.id
      )
    ).toEqual(["hard"]);
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
    expect(result.configuration.planner).toBe("deterministic");
    expect(result.runs.every((item) => item.planner === "deterministic")).toBe(true);
  });

  it("executes and groups multiple planner strategies", async () => {
    const result = await new BenchmarkRunner({
      execute: async () => execution()
    }).run([scenario()], {
      runsPerScenario: 2,
      planners: ["deterministic", "ollama"]
    });

    expect(result.runs).toHaveLength(4);
    expect(result.metrics.plannerPerformance.map((item) => item.planner)).toEqual([
      "deterministic",
      "ollama"
    ]);
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
    expect(summary).toContain("Planner strategies: deterministic");
  });

  it("serializes reproducibility metadata", async () => {
    const result = await new BenchmarkRunner(
      { execute: async () => execution() },
      {
        gitCommitSha: "abc123",
        plannerModels: { ollama: "qwen2.5-coder:7b" },
        benchmarkApplication: {
          name: "benchmark-saas-workspace",
          version: "1.0.0",
          configuration: "seeded-fixture"
        }
      }
    ).run([scenario()], {
      runsPerScenario: 1,
      planners: ["ollama"],
      difficulties: ["medium"]
    });

    expect(result.configuration).toMatchObject({
      planner: "ollama",
      planners: ["ollama"],
      plannerModels: { ollama: "qwen2.5-coder:7b" },
      gitCommitSha: "abc123",
      difficultyFilter: ["medium"],
      scenarioIds: ["clean"],
      randomSeed: null
    });
  });

  it("formats planner comparison without inventing unexecuted planners", () => {
    const comparison = formatPlannerComparison(
      aggregateBenchmarkMetrics([run()]).plannerPerformance
    );

    expect(comparison).toContain("Deterministic");
    expect(comparison).not.toContain("Ollama");
  });

  it("generates Markdown and comparison artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vibeqa-evaluation-"));
    const result = await new BenchmarkRunner({
      execute: async () => execution()
    }).run([scenario()], {
      runsPerScenario: 1,
      planners: ["deterministic", "ollama"]
    });

    try {
      const paths = await writeBenchmarkReport(directory, result);
      const report = await readFile(paths.reportPath, "utf8");

      expect(paths.comparisonPath).not.toBeNull();
      expect(report).toBe(formatBenchmarkMarkdownReport(result));
      expect(report).toContain("## Difficulty Breakdown");
      expect(report).toContain("## Planner Comparison");
      expect(report).toContain("controlled test site");
      expect(report).toContain("universal website-testing accuracy");
    } finally {
      await unlink(join(directory, "summary.json"));
      await unlink(join(directory, "runs.json"));
      await unlink(join(directory, "comparison.json"));
      await unlink(join(directory, "benchmark-report.md"));
      await rmdir(directory);
    }
  });
});

function scenario(overrides: Partial<BenchmarkScenario> = {}): BenchmarkScenario {
  return {
    id: "clean",
    name: "Clean workflow",
    mode: "functional",
    difficulty: "medium",
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
    difficulty: "medium",
    planner: "deterministic",
    modelName: null,
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
