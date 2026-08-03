import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startBenchmarkServer,
  type BenchmarkServer
} from "../../../apps/benchmark-app/src/index.js";
import { BrowserSession } from "../../browser-tools/src/index.js";
import { AgentLoop } from "../src/index.js";

let app: BenchmarkServer;
let browser: BrowserSession | null;

beforeEach(async () => {
  app = await startBenchmarkServer();
  app.reset();
  browser = await BrowserSession.launch({ headless: true });
});

afterEach(async () => {
  await browser?.close();
  await app.close();
  browser = null;
});

describe("AgentLoop", () => {
  it("observes the benchmark login page, produces a mock action, executes it, and records state", async () => {
    expect(browser).not.toBeNull();

    await browser.goto(`${app.url}/login`);
    const loop = new AgentLoop({
      goal: "Log in to the benchmark SaaS workspace",
      browser
    });

    const step = await loop.runStep();

    expect(step.observation.textSample).toContain("Sign in to Acme Growth");
    expect(step.action).toEqual({
      type: "type",
      selector: 'input[name="email"]',
      value: "qa@example.com"
    });
    expect(step.result).toEqual({ ok: true });
    expect(step.state.goal).toBe("Log in to the benchmark SaaS workspace");
    expect(step.state.currentObservation?.id).toBe(step.observation.id);
    expect(step.state.observationHistory).toHaveLength(1);
    expect(step.state.actionHistory).toHaveLength(1);
    expect(step.state.actionHistory[0]?.action).toEqual(step.action);
    expect(step.state.stepCount).toBe(1);
    expect(step.state.status).toBe("idle");
  });
});
