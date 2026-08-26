import type { LLMClient } from "@vibeqa/llm";
import type { BrowserAction } from "@vibeqa/schemas";
import type { TestCase, TestStep } from "@vibeqa/test-engine";

import type { ExecutableBenchmarkScenario } from "./scenarios.js";

export interface PreparedBenchmarkScenario {
  testCase: TestCase | null;
  explorationGoal: string;
}

export interface BenchmarkPlannerStrategy {
  readonly name: "deterministic" | "ollama";
  readonly modelName: string | null;
  verifyAvailability(): Promise<void>;
  prepare(scenario: ExecutableBenchmarkScenario): Promise<PreparedBenchmarkScenario>;
}

export class DeterministicBenchmarkPlannerStrategy implements BenchmarkPlannerStrategy {
  readonly name = "deterministic" as const;
  readonly modelName = null;

  async verifyAvailability(): Promise<void> {}

  async prepare(
    scenario: ExecutableBenchmarkScenario
  ): Promise<PreparedBenchmarkScenario> {
    return {
      testCase: scenario.testCase ? structuredClone(scenario.testCase) : null,
      explorationGoal: scenario.objective
    };
  }
}

export class OllamaBenchmarkPlannerStrategy implements BenchmarkPlannerStrategy {
  readonly name = "ollama" as const;
  private readonly endpoint: string;

  constructor(
    private readonly client: LLMClient,
    readonly modelName = "qwen2.5-coder:7b"
  ) {
    this.endpoint = configuredEndpoint(client);
  }

  async verifyAvailability(): Promise<void> {
    try {
      await this.client.generate(
        'Return only this JSON object to confirm readiness: {"ready":true}'
      );
    } catch (error) {
      const cause = error instanceof Error ? error.message : "unknown connection error";
      throw new Error(
        `Ollama planner unavailable at ${this.endpoint}. Ensure Ollama is running and install ${this.modelName}. Cause: ${cause}`
      );
    }
  }

  async prepare(
    scenario: ExecutableBenchmarkScenario
  ): Promise<PreparedBenchmarkScenario> {
    if (!scenario.testCase) {
      return {
        testCase: null,
        explorationGoal: await this.planExplorationGoal(scenario)
      };
    }

    const testCase = scenario.testCase;
    const steps = testCase.steps.map((step, index) => ({
      id: `step-${index + 1}`,
      name: step.name,
      action: safeActionSummary(step.action),
      expected: step.expected ?? null
    }));
    const prompt = [
      "You are the constrained Vibe-QA benchmark planner.",
      "Order the provided safe step templates to satisfy the objective.",
      'Return only JSON with this shape: {"stepIds":["step-1"]}.',
      "Include every provided step ID exactly once and do not invent IDs.",
      `Scenario: ${scenario.name}`,
      `Objective: ${scenario.objective}`,
      `Start URL: ${scenario.startUrl}`,
      `Safe step templates: ${JSON.stringify(steps)}`
    ].join("\n");
    const response = await this.client.generate(prompt);
    const stepIds = parseStepIds(
      response,
      steps.map((step) => step.id)
    );
    const byId = new Map(
      testCase.steps.map((step, index) => [`step-${index + 1}`, step] as const)
    );
    return {
      testCase: {
        goal: testCase.goal,
        startUrl: testCase.startUrl,
        steps: stepIds.map((id) => structuredClone(requiredStep(byId, id)))
      },
      explorationGoal: scenario.objective
    };
  }

  private async planExplorationGoal(
    scenario: ExecutableBenchmarkScenario
  ): Promise<string> {
    const response = await this.client.generate(
      [
        "You are the Vibe-QA exploratory benchmark planner.",
        "Refine the objective into one concise exploration goal without changing scope.",
        'Return only JSON with this shape: {"goal":"string"}.',
        `Scenario: ${scenario.name}`,
        `Objective: ${scenario.objective}`,
        `Start URL: ${scenario.startUrl}`,
        `Maximum actions: ${scenario.maxSteps}`
      ].join("\n")
    );
    const record = parseJsonObject(response);
    if (typeof record.goal !== "string" || record.goal.trim().length === 0) {
      throw new Error("Ollama exploration plan must contain a non-empty goal.");
    }
    return record.goal.trim();
  }
}

function configuredEndpoint(client: LLMClient): string {
  const endpoint = (client as LLMClient & { baseUrl?: unknown }).baseUrl;
  return typeof endpoint === "string" && endpoint.length > 0
    ? endpoint
    : "the configured endpoint";
}

function safeActionSummary(action: BrowserAction): Record<string, unknown> {
  switch (action.type) {
    case "type":
      return {
        type: action.type,
        selector: action.selector,
        value: "[provided securely at execution]"
      };
    case "goto":
    case "navigate":
      return { type: action.type, url: action.url };
    case "click":
    case "getText":
      return { type: action.type, selector: action.selector };
    case "wait":
      return { type: action.type, ms: action.ms };
    case "screenshot":
      return { type: action.type };
    case "assert":
      return {
        type: action.type,
        selector: action.selector,
        containsText: action.containsText
      };
    case "getCurrentUrl":
      return { type: action.type };
  }
}

function parseStepIds(response: string, expectedIds: readonly string[]): string[] {
  const record = parseJsonObject(response);
  if (!Array.isArray(record.stepIds)) {
    throw new Error("Ollama plan must contain a stepIds array.");
  }
  const stepIds = record.stepIds;
  if (!stepIds.every((value): value is string => typeof value === "string")) {
    throw new Error("Ollama plan step IDs must be strings.");
  }
  if (
    stepIds.length !== expectedIds.length ||
    new Set(stepIds).size !== expectedIds.length ||
    stepIds.some((id) => !expectedIds.includes(id))
  ) {
    throw new Error("Ollama plan must include every safe step ID exactly once.");
  }
  return stepIds;
}

function parseJsonObject(response: string): Record<string, unknown> {
  const stripped = stripJsonCodeFence(response.trim());
  const parsed = JSON.parse(stripped) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Ollama planner response must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function stripJsonCodeFence(response: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(response);
  return match?.[1] ?? response;
}

function requiredStep(byId: Map<string, TestStep>, id: string): TestStep {
  const step = byId.get(id);
  if (!step) {
    throw new Error(`Ollama plan referenced an unknown step ID: ${id}`);
  }
  return step;
}
