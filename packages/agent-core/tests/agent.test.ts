import { describe, expect, it } from "vitest";

import type { LLMClient } from "../../llm/src/index.js";
import type { BrowserAction, Observation } from "../../schemas/src/index.js";
import { Agent, Evaluator, Memory, type BrowserController } from "../src/index.js";

class ScriptedLLMClient implements LLMClient {
  readonly prompts: string[] = [];

  constructor(private readonly responses: string[]) {}

  async generate(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.responses.shift() ?? "null";
  }
}

class InMemoryBrowser implements BrowserController {
  private url = "http://localhost:3000/login";
  readonly calls: BrowserAction[] = [];

  async observe(): Promise<Observation> {
    return createObservation(this.url);
  }

  async goto(url: string): Promise<void> {
    this.calls.push({ type: "goto", url });
    this.url = url;
  }

  async navigate(url: string): Promise<void> {
    this.calls.push({ type: "navigate", url });
    this.url = url;
  }

  async click(selector: string): Promise<void> {
    this.calls.push({ type: "click", selector });
  }

  async type(selector: string, value: string): Promise<void> {
    this.calls.push({ type: "type", selector, value });
  }

  async getText(selector: string): Promise<string> {
    this.calls.push({ type: "getText", selector });
    return "";
  }

  async wait(ms: number): Promise<void> {
    this.calls.push({ type: "wait", ms });
  }

  async screenshot(options: { path?: string } = {}): Promise<Uint8Array | string> {
    this.calls.push({ type: "screenshot", path: options.path });
    return options.path ?? new Uint8Array();
  }

  async assert(selector: string, containsText: string): Promise<void> {
    this.calls.push({ type: "assert", selector, containsText });
  }

  getCurrentUrl(): string {
    this.calls.push({ type: "getCurrentUrl" });
    return this.url;
  }
}

describe("Agent", () => {
  it("runs observe, think, act, and reflect until the LLM completes the goal", async () => {
    const browser = new InMemoryBrowser();
    const client = new ScriptedLLMClient([
      JSON.stringify({ type: "navigate", url: "http://localhost:3000/dashboard" }),
      "null"
    ]);
    const agent = new Agent({ browser, llmClient: client, maxSteps: 5 });

    const state = await agent.run("Open the dashboard");

    expect(state.completed).toBe(true);
    expect(state.stepCount).toBe(1);
    expect(state.currentObservation?.url).toBe("http://localhost:3000/dashboard");
    expect(state.actionHistory).toEqual([
      { type: "navigate", url: "http://localhost:3000/dashboard" }
    ]);
    expect(state.errors).toEqual([]);
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[0]).toContain("Goal: Open the dashboard");
    expect(agent.getMemory().getHistory().observations).toHaveLength(2);
  });

  it("records malformed model output as an agent error", async () => {
    const agent = new Agent({
      browser: new InMemoryBrowser(),
      llmClient: new ScriptedLLMClient(["not-json"])
    });

    const state = await agent.run("Inspect the login page");

    expect(state.completed).toBe(false);
    expect(state.errors[0]).toContain("Unexpected token");
  });
});

describe("Memory", () => {
  it("stores observations, actions, and unique discovered bugs", () => {
    const memory = new Memory();
    const observation = createObservation("http://localhost:3000/login");
    const action: BrowserAction = { type: "click", selector: "button" };

    memory.addObservation(observation);
    memory.addAction(action);
    memory.addBug("Console exception");
    memory.addBug("Console exception");

    expect(memory.getHistory()).toEqual({
      observations: [observation],
      actions: [action],
      discoveredBugs: ["Console exception"]
    });
  });
});

describe("Evaluator", () => {
  it("stops after navigation reaches an unexpected URL", () => {
    const evaluator = new Evaluator();

    expect(
      evaluator.evaluate(
        { type: "navigate", url: "http://localhost:3000/dashboard" },
        createObservation("http://localhost:3000/login")
      )
    ).toEqual({
      success: false,
      reason:
        "Navigation expected http://localhost:3000/dashboard but reached http://localhost:3000/login.",
      shouldContinue: false
    });
  });
});

function createObservation(url: string): Observation {
  return {
    id: `observation-${url}`,
    timestamp: "2026-08-07T00:00:00.000Z",
    url,
    title: "VibeQA test page",
    metadata: {
      url,
      title: "VibeQA test page",
      viewport: { width: 1280, height: 900 }
    },
    consoleErrors: [],
    accessibility: {
      headings: [],
      landmarks: [],
      interactiveElementCount: 0
    },
    elements: [],
    textSample: "Test page",
    screenshotPath: null
  };
}
