import { OllamaClient, type LLMClient } from "@vibeqa/llm";
import { describe, expect, it, vi } from "vitest";

import { parseBenchmarkCliOptions } from "../src/cli-options.js";
import {
  DeterministicBenchmarkPlannerStrategy,
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
