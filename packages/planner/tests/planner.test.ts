import { describe, expect, it } from "vitest";

import { MockLLMClient } from "../../llm/src/index.js";
import type { AgentState, Observation } from "../../schemas/src/index.js";
import { LLMPlanner, MockPlanner } from "../src/index.js";

const initialState: AgentState = {
  goal: "Log in",
  currentObservation: null,
  actionHistory: [],
  observationHistory: [],
  stepCount: 0,
  status: "idle"
};

const loginObservation: Observation = {
  id: "observation-login",
  timestamp: "2026-08-06T00:00:00.000Z",
  url: "http://localhost:3000/login",
  title: "VibeQA Benchmark Login - VibeQA Benchmark",
  elements: [
    {
      id: "element-1",
      tagName: "input",
      role: null,
      accessibleName: "Email",
      text: "",
      visible: true,
      enabled: true,
      editable: true,
      selector: 'input[name="email"]'
    }
  ],
  textSample: "Sign in to Acme Growth",
  screenshotPath: null
};

describe("MockPlanner", () => {
  it("returns the deterministic login email action for a login page observation", async () => {
    const planner = new MockPlanner();

    await expect(planner.decide(initialState, loginObservation)).resolves.toEqual({
      type: "type",
      selector: 'input[name="email"]',
      value: "qa@example.com"
    });
  });
});

describe("LLMPlanner", () => {
  it("calls LLMClient and parses its BrowserAction response", async () => {
    const client = new MockLLMClient(
      JSON.stringify({
        type: "click",
        selector: 'button[type="submit"]'
      })
    );
    const planner = new LLMPlanner(client);

    await expect(planner.decide(initialState, loginObservation)).resolves.toEqual({
      type: "click",
      selector: 'button[type="submit"]'
    });
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).toContain("Goal: Log in");
    expect(client.prompts[0]).toContain("Current URL: http://localhost:3000/login");
  });
});
