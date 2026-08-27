import { startBenchmarkServer } from "@vibeqa/benchmark-app";
import { PlaywrightBrowserController } from "@vibeqa/browser-playwright";
import {
  GeneralizationRunner,
  classifyGeneralizationRun,
  type GeneralizationScenario
} from "@vibeqa/evaluation";
import { createPageStateFingerprint } from "@vibeqa/explorer";
import type { LLMClient } from "@vibeqa/llm";
import { describe, expect, it } from "vitest";

import { GeneralizationPlaywrightExecutor } from "../src/generalization-executor.js";
import { createGeneralizationScenarios } from "../src/generalization-scenarios.js";

describe("generalization benchmark runner", () => {
  it("runs V3 without an exact scripted browser path", async () => {
    const benchmark = await startBenchmarkServer({ port: 0 });
    try {
      const scenario = requiredScenario(benchmark.url, "same-url-dashboard-state");
      const execution = await new GeneralizationPlaywrightExecutor({
        benchmark
      }).execute({ ...scenario, maxSteps: 2 }, 1, "deterministic");

      expect(execution.infrastructureError).toBeNull();
      expect(execution.observations.length).toBeGreaterThan(0);
      expect(execution.actions.length).toBeGreaterThan(0);
    } finally {
      await benchmark.close();
    }
  }, 30_000);

  it("discovers a hidden bug through Agent while keeping evaluator data blind", async () => {
    const benchmark = await startBenchmarkServer({ port: 0 });
    const client = new RecordingClient([
      JSON.stringify({
        action: { type: "click", selector: "#trigger-client-error" }
      }),
      "null"
    ]);
    try {
      const scenario: GeneralizationScenario = {
        ...requiredScenario(benchmark.url, "discover-dashboard-failure"),
        maxSteps: 2,
        evaluatorOnly: {
          ...requiredScenario(benchmark.url, "discover-dashboard-failure")
            .evaluatorOnly,
          hiddenTargetSelectors: ["#evaluator-only-never-on-page"],
          hiddenExpectedActions: ["private evaluator sequence marker"]
        }
      };
      const execution = await new GeneralizationPlaywrightExecutor({
        benchmark,
        ollamaClient: client
      }).execute(scenario, 1, "ollama");

      expect(classifyGeneralizationRun(scenario, execution)).toBe("HIDDEN_BUG_FOUND");
      expect(execution.discoveryStep).toBe(1);
      expect(JSON.stringify(execution)).not.toContain("qa@example.com");
      expect(JSON.stringify(execution)).not.toContain("password123");
      expect(client.prompts).toHaveLength(2);
      for (const prompt of client.prompts) {
        expect(prompt).not.toContain("BUG-BENCH-005");
        expect(prompt).not.toContain("#evaluator-only-never-on-page");
        expect(prompt).not.toContain("private evaluator sequence marker");
        expect(prompt).not.toContain("qa@example.com");
        expect(prompt).not.toContain("password123");
      }
    } finally {
      await benchmark.close();
    }
  }, 30_000);

  it("classifies an autonomous hidden bug miss", async () => {
    const benchmark = await startBenchmarkServer({ port: 0 });
    try {
      const scenario = requiredScenario(benchmark.url, "discover-dashboard-failure");
      const execution = await new GeneralizationPlaywrightExecutor({
        benchmark,
        ollamaClient: new RecordingClient(["null"])
      }).execute(scenario, 1, "ollama");

      expect(classifyGeneralizationRun(scenario, execution)).toBe("HIDDEN_BUG_MISSED");
    } finally {
      await benchmark.close();
    }
  }, 30_000);

  it("requests one correction for malformed LLM action output", async () => {
    const benchmark = await startBenchmarkServer({ port: 0 });
    const client = new RecordingClient([
      JSON.stringify({ action: "press", target: "#trigger-client-error" }),
      JSON.stringify({
        next_action: { type: "click", target: "#trigger-client-error" }
      })
    ]);
    try {
      const scenario = {
        ...requiredScenario(benchmark.url, "discover-dashboard-failure"),
        maxSteps: 1
      };
      const execution = await new GeneralizationPlaywrightExecutor({
        benchmark,
        ollamaClient: client
      }).execute(scenario, 1, "ollama");

      expect(execution.detectedBugIds).toContain("BUG-BENCH-005");
      expect(client.prompts).toHaveLength(2);
      expect(client.prompts[1]).toContain("previous response was invalid");
      expect(client.prompts[1]).not.toContain("BUG-BENCH-005");
    } finally {
      await benchmark.close();
    }
  }, 30_000);

  it("measures Ollama generation wall time separately from execution duration", async () => {
    const benchmark = await startBenchmarkServer({ port: 0 });
    const times = [0, 10, 30, 35, 55, 100];
    try {
      const scenario = {
        ...requiredScenario(benchmark.url, "discover-dashboard-failure"),
        maxSteps: 2
      };
      const execution = await new GeneralizationPlaywrightExecutor({
        benchmark,
        ollamaClient: new RecordingClient([
          JSON.stringify({
            action: { type: "click", selector: "#trigger-client-error" }
          }),
          "null"
        ]),
        now: () => times.shift() ?? 100
      }).execute(scenario, 1, "ollama");

      expect(execution.durationMs).toBe(100);
      expect(execution.plannerDurationMs).toBe(40);
    } finally {
      await benchmark.close();
    }
  }, 30_000);

  it("distinguishes same-URL dashboard states by observation fingerprint", async () => {
    const benchmark = await startBenchmarkServer({ port: 0 });
    const browser = await PlaywrightBrowserController.launch({ headless: true });
    try {
      await browser.navigate(`${benchmark.url}/dashboard`);
      const overview = await browser.observe();
      await browser.click("#view-activity");
      const activity = await browser.observe();

      expect(overview.url).toBe(activity.url);
      expect(createPageStateFingerprint(overview)).not.toBe(
        createPageStateFingerprint(activity)
      );
      expect(activity.textSample).toContain("Recent workspace activity");
    } finally {
      await browser.close();
      await benchmark.close();
    }
  }, 30_000);

  it("produces separate planner metrics for a V3 comparison", async () => {
    const scenarios = createGeneralizationScenarios("http://benchmark.test");
    const result = await new GeneralizationRunner({
      execute: async () => ({
        goalCompleted: true,
        detectedBugIds: [],
        infrastructureError: null,
        durationMs: 10,
        safetyEvents: { allowed: 1, blocked: 0, approvalRequired: 0 },
        observations: [],
        actions: [],
        discoveryStep: null,
        completionStep: 0,
        uniqueStatesBeforeDiscovery: 0,
        uniqueElementsBeforeDiscovery: 0,
        approvalRequired: false,
        safetyBlocked: false
      })
    }).run(
      scenarios.filter((scenario) => scenario.id === "ambiguous-settings"),
      { runsPerScenario: 1, planners: ["deterministic", "ollama"] }
    );

    expect(result.metrics.plannerPerformance.map((item) => item.planner)).toEqual([
      "deterministic",
      "ollama"
    ]);
  });
});

class RecordingClient implements LLMClient {
  readonly prompts: string[] = [];
  private index = 0;

  constructor(private readonly responses: readonly string[]) {}

  async generate(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const response = this.responses[this.index] ?? "null";
    this.index += 1;
    return response;
  }
}

function requiredScenario(url: string, id: string): GeneralizationScenario {
  const scenario = createGeneralizationScenarios(url).find(
    (candidate) => candidate.id === id
  );
  if (!scenario) {
    throw new Error(`Missing generalization scenario: ${id}`);
  }
  return scenario;
}
