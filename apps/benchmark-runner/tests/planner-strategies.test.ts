import { OllamaClient, type LLMClient } from "@vibeqa/llm";
import { describe, expect, it, vi } from "vitest";

import { parseBenchmarkCliOptions } from "../src/cli-options.js";
import {
  DeterministicBenchmarkPlannerStrategy,
  HybridBenchmarkPlannerStrategy,
  OllamaBenchmarkPlannerStrategy
} from "../src/planner-strategies.js";
import { createBenchmarkScenarios } from "../src/scenarios.js";

describe("benchmark planner configuration", () => {
  it("keeps deterministic planning as the CLI default", () => {
    expect(parseBenchmarkCliOptions(["--runs", "2"])).toMatchObject({
      suite: "controlled-v2",
      runs: 2,
      planners: ["deterministic"]
    });
  });

  it("selects V3 explicitly without changing the V2 default", () => {
    expect(
      parseBenchmarkCliOptions(["--suite", "generalization", "--runs", "2"])
    ).toMatchObject({
      suite: "generalization-v3",
      runs: 2,
      planners: ["deterministic"]
    });
    expect(parseBenchmarkCliOptions([]).suite).toBe("controlled-v2");
  });

  it("parses planner, mode, difficulty, scenario, and comparison filters", () => {
    expect(
      parseBenchmarkCliOptions([
        "--planner",
        "ollama",
        "--mode",
        "exploratory",
        "--difficulty",
        "hard",
        "--scenario",
        "dashboard-exploration"
      ])
    ).toMatchObject({
      planners: ["ollama"],
      mode: "exploratory",
      difficulty: "hard",
      scenario: "dashboard-exploration"
    });
    expect(
      parseBenchmarkCliOptions(["--compare", "deterministic,ollama"]).planners
    ).toEqual(["deterministic", "ollama"]);
    expect(parseBenchmarkCliOptions(["--planner", "hybrid"]).planners).toEqual([
      "hybrid"
    ]);
    expect(
      parseBenchmarkCliOptions(["--compare", "deterministic,ollama,hybrid"]).planners
    ).toEqual(["deterministic", "ollama", "hybrid"]);
  });

  it("preserves scenario difficulty metadata", () => {
    const scenarios = createBenchmarkScenarios("http://benchmark.test");

    expect(scenarios.some((scenario) => scenario.difficulty === "easy")).toBe(true);
    expect(scenarios.some((scenario) => scenario.difficulty === "medium")).toBe(true);
    expect(scenarios.some((scenario) => scenario.difficulty === "hard")).toBe(true);
  });

  it("returns the existing scenario plan for deterministic execution", async () => {
    const scenario = requiredScenario("login");
    const prepared = await new DeterministicBenchmarkPlannerStrategy().prepare(
      scenario
    );

    expect(prepared.testCase).toEqual(scenario.testCase);
  });

  it("uses LLMClient for Ollama planning without exposing typed credentials", async () => {
    const client = new RecordingClient(
      JSON.stringify({ stepIds: ["step-1", "step-2", "step-3", "step-4"] })
    );
    const prepared = await new OllamaBenchmarkPlannerStrategy(client).prepare(
      requiredScenario("login")
    );

    expect(prepared.testCase?.steps).toHaveLength(4);
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).not.toContain("qa@example.com");
    expect(client.prompts[0]).not.toContain("password123");
    expect(client.prompts[0]).toContain("[provided securely at execution]");
  });

  it("fails clearly when Ollama is unavailable", async () => {
    const client: LLMClient & { baseUrl: string } = {
      baseUrl: "http://127.0.0.1:11434",
      generate: async () => {
        throw new Error("fetch failed");
      }
    };

    await expect(
      new OllamaBenchmarkPlannerStrategy(client).verifyAvailability()
    ).rejects.toThrow("Ollama planner unavailable at http://127.0.0.1:11434");
  });

  it("checks model availability through the configured Ollama endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ response: '{"ready":true}' }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const client = new OllamaClient({
      baseUrl: "http://ollama.internal.test:11434/",
      fetch: fetchMock
    });

    await new OllamaBenchmarkPlannerStrategy(client).verifyAvailability();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://ollama.internal.test:11434/api/generate"
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "qwen2.5-coder:7b"
    });
  });

  it("records deterministic Hybrid routing for a known functional workflow", async () => {
    const ollama = new OllamaBenchmarkPlannerStrategy(
      new RecordingClient('{"ready":true}')
    );
    const strategy = new HybridBenchmarkPlannerStrategy(
      new DeterministicBenchmarkPlannerStrategy(),
      ollama
    );

    const prepared = await strategy.prepare(requiredScenario("login"));

    expect(prepared.infrastructureError).toBeNull();
    expect(prepared.routing).toMatchObject({
      requestedStrategy: "hybrid",
      selectedPlanner: "deterministic",
      executedPlanner: "deterministic",
      routingRule: "functional-known-workflow",
      routerVersion: "v2",
      routingConfidence: "high",
      fallback: false,
      recommendedPlanner: null,
      matchedRecommendation: null
    });
  });

  it("does not silently fall back when Ollama is unavailable in benchmark mode", async () => {
    const unavailable = new OllamaBenchmarkPlannerStrategy({
      generate: async () => {
        throw new Error("fetch failed");
      }
    });
    const strategy = new HybridBenchmarkPlannerStrategy(
      new DeterministicBenchmarkPlannerStrategy(),
      unavailable
    );

    const prepared = await strategy.prepare(requiredScenario("dashboard-exploration"));

    expect(prepared.infrastructureError).toContain("Ollama planner unavailable");
    expect(prepared.routing).toMatchObject({
      selectedPlanner: "ollama",
      executedPlanner: null,
      fallback: false
    });
  });

  it("keeps evaluator recommendations outside the router decision", async () => {
    const strategy = new HybridBenchmarkPlannerStrategy(
      new DeterministicBenchmarkPlannerStrategy(),
      new OllamaBenchmarkPlannerStrategy(new RecordingClient('{"ready":true}'))
    );
    const task = {
      mode: "functional" as const,
      objective: "Verify the account overview.",
      hasExpectedBehavior: false,
      exactWorkflowKnown: false,
      semanticGoalAmbiguous: false
    };

    const deterministicRecommendation = await strategy.select(task, "deterministic");
    const ollamaRecommendation = await strategy.select(task, "ollama");

    expect(deterministicRecommendation).toEqual(ollamaRecommendation);
    expect(deterministicRecommendation.routing).toMatchObject({
      selectedPlanner: "deterministic",
      recommendedPlanner: null,
      recommendedCategory: null,
      matchedRecommendation: null
    });
  });

  it("records the opt-in deterministic fallback without relabeling it", async () => {
    const unavailable = new OllamaBenchmarkPlannerStrategy({
      generate: async () => {
        throw new Error("fetch failed");
      }
    });
    const strategy = new HybridBenchmarkPlannerStrategy(
      new DeterministicBenchmarkPlannerStrategy(),
      unavailable,
      { allowDeterministicFallback: true }
    );

    const prepared = await strategy.prepare(requiredScenario("dashboard-exploration"));

    expect(prepared.infrastructureError).toBeNull();
    expect(prepared.routing).toMatchObject({
      selectedPlanner: "ollama",
      executedPlanner: "deterministic",
      fallback: true,
      fallbackReason: "ollama-unavailable"
    });
  });
});

class RecordingClient implements LLMClient {
  readonly prompts: string[] = [];

  constructor(private readonly response: string) {}

  async generate(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.response;
  }
}

function requiredScenario(id: string) {
  const scenario = createBenchmarkScenarios("http://benchmark.test").find(
    (item) => item.id === id
  );
  if (!scenario) {
    throw new Error(`Missing benchmark scenario: ${id}`);
  }
  return scenario;
}
