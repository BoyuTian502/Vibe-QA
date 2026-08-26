import { startBenchmarkServer } from "@vibeqa/benchmark-app";
import { BenchmarkRunner } from "@vibeqa/evaluation";
import { describe, expect, it } from "vitest";

import { BenchmarkPlaywrightExecutor } from "../src/executor.js";
import { createBenchmarkScenarios } from "../src/scenarios.js";

describe("Vibe-QA benchmark runner integration", () => {
  it("executes the representative deterministic suite against the real benchmark", async () => {
    const benchmark = await startBenchmarkServer({ port: 0 });

    try {
      const result = await new BenchmarkRunner(
        new BenchmarkPlaywrightExecutor({ benchmark })
      ).run(createBenchmarkScenarios(benchmark.url), { runsPerScenario: 1 });

      expect(result.runs).toHaveLength(6);
      expect(result.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scenarioId: "login",
            classification: "PASS"
          }),
          expect.objectContaining({
            scenarioId: "invalid-login",
            classification: "PASS"
          }),
          expect.objectContaining({
            scenarioId: "bug-widget-crash",
            classification: "EXPECTED_BUG_FOUND",
            detectedBugIds: ["BUG-BENCH-005"]
          }),
          expect.objectContaining({
            scenarioId: "settings-navigation",
            classification: "PASS"
          }),
          expect.objectContaining({
            scenarioId: "dashboard-exploration",
            classification: "PASS",
            exploration: expect.objectContaining({
              uniquePageStates: expect.any(Number),
              candidateActionsAttempted: 2
            })
          })
        ])
      );
      expect(result.metrics.modePerformance.map((mode) => mode.mode).sort()).toEqual([
        "exploratory",
        "functional",
        "regression"
      ]);
      const output = JSON.stringify(result);
      expect(output).not.toContain("qa@example.com");
      expect(output).not.toContain("password123");
    } finally {
      await benchmark.close();
    }
  }, 30_000);
});
