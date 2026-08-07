import { describe, expect, it } from "vitest";

import type { LLMClient } from "../../llm/src/index.js";
import type { Observation } from "../../schemas/src/index.js";
import { Agent, type BrowserController } from "../src/index.js";

class TraceLLMClient implements LLMClient {
  constructor(private readonly responses: string[]) {}

  async generate(): Promise<string> {
    return this.responses.shift() ?? "null";
  }
}

class TraceBrowser implements BrowserController {
  private url = "http://localhost:3000/login";

  constructor(private readonly clickError?: Error) {}

  async observe(): Promise<Observation> {
    return createObservation(this.url);
  }

  async goto(url: string): Promise<void> {
    this.url = url;
  }

  async navigate(url: string): Promise<void> {
    this.url = url;
  }

  async click(): Promise<void> {
    if (this.clickError) {
      throw this.clickError;
    }
  }

  async type(): Promise<void> {}

  async getText(): Promise<string> {
    return "";
  }

  async wait(): Promise<void> {}

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async assert(): Promise<void> {}

  getCurrentUrl(): string {
    return this.url;
  }
}

describe("Agent trace", () => {
  it("creates a trace for each run", async () => {
    const agent = createAgent(["null"]);

    await agent.run("Inspect the login page");

    const trace = agent.getTrace();
    expect(trace.goal).toBe("Inspect the login page");
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]?.observation?.url).toBe("http://localhost:3000/login");
    expect(trace.steps[0]?.action).toBeNull();
  });

  it("records every observed state and chosen action", async () => {
    const response = JSON.stringify({
      type: "navigate",
      url: "http://localhost:3000/dashboard"
    });
    const agent = createAgent([response, "null"]);

    await agent.run("Open the dashboard");

    const trace = agent.getTrace();
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps.map((step) => step.observation?.url)).toEqual([
      "http://localhost:3000/login",
      "http://localhost:3000/dashboard"
    ]);
    expect(trace.steps[0]?.thought.prompt).toContain("Goal: Open the dashboard");
    expect(trace.steps[0]?.thought.reasoning).toBe(response);
    expect(trace.steps[0]?.action).toEqual({
      type: "navigate",
      url: "http://localhost:3000/dashboard"
    });
    expect(trace.steps[0]?.evaluation).toEqual({
      success: true,
      reason: "Navigation reached http://localhost:3000/dashboard.",
      shouldContinue: true
    });
  });

  it("records successful browser action execution", async () => {
    const agent = createAgent([
      JSON.stringify({ type: "click", selector: "button" }),
      "null"
    ]);

    await agent.run("Click the button");

    expect(agent.getTrace().steps[0]?.result).toEqual({ success: true });
  });

  it("records failed browser action execution", async () => {
    const agent = new Agent({
      browser: new TraceBrowser(new Error("Button is covered")),
      llmClient: new TraceLLMClient([
        JSON.stringify({ type: "click", selector: "button" })
      ])
    });

    const state = await agent.run("Click the button");

    expect(state.completed).toBe(false);
    expect(state.errors).toEqual(["Button is covered"]);
    expect(agent.getTrace().steps[0]).toMatchObject({
      action: { type: "click", selector: "button" },
      result: { success: false, error: "Button is covered" }
    });
  });
});

function createAgent(responses: string[]): Agent {
  return new Agent({
    browser: new TraceBrowser(),
    llmClient: new TraceLLMClient(responses),
    maxSteps: 5
  });
}

function createObservation(url: string): Observation {
  return {
    id: `observation-${url}`,
    timestamp: "2026-08-07T00:00:00.000Z",
    url,
    title: "VibeQA trace page",
    metadata: {
      url,
      title: "VibeQA trace page",
      viewport: { width: 1280, height: 900 }
    },
    consoleErrors: [],
    accessibility: {
      headings: [],
      landmarks: [],
      interactiveElementCount: 0
    },
    elements: [],
    textSample: "Trace page",
    screenshotPath: null
  };
}
