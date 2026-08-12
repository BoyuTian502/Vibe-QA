import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startBenchmarkServer,
  type BenchmarkServer
} from "../../../apps/benchmark-app/src/index.js";
import { Agent, type BrowserController } from "../../agent-core/src/index.js";
import type { LLMClient } from "../../llm/src/index.js";
import { ObservationSchema } from "../../schemas/src/index.js";
import { PlaywrightBrowserController } from "../src/index.js";

let app: BenchmarkServer;
let controller: PlaywrightBrowserController | null;

beforeEach(async () => {
  app = await startBenchmarkServer();
  app.reset();
  controller = await PlaywrightBrowserController.launch({ headless: true });
});

afterEach(async () => {
  await controller?.close();
  await app.close();
  controller = null;
});

describe("PlaywrightBrowserController", () => {
  it("navigates, observes, types, clicks, screenshots, and captures console errors", async () => {
    expect(controller).not.toBeNull();
    const browser: BrowserController = controller;

    await browser.navigate(`${app.url}/login`);
    const login = await browser.observe();
    expect(ObservationSchema.parse(login)).toEqual(login);
    expect(login.textSample).toContain("Sign in to Acme Growth");

    await browser.type('input[name="email"]', "qa@example.com");
    await browser.type('input[name="password"]', "password123");
    await browser.click('button[type="submit"]');
    await expect.poll(() => browser.getCurrentUrl()).toBe(`${app.url}/dashboard`);

    const dashboard = await browser.observe();
    expect(dashboard.url).toBe(`${app.url}/dashboard`);
    expect(dashboard.textSample).toContain("PRIVATE DASHBOARD");

    const screenshot = await browser.screenshot();
    expect(screenshot).toBeInstanceOf(Uint8Array);
    expect(screenshot).not.toHaveLength(0);

    await browser.click("#trigger-client-error");
    expect(await controller.getConsoleErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "pageerror",
          text: "BUG-BENCH-005: fragile dashboard widget crashed"
        })
      ])
    );
  });

  it("runs the autonomous Agent through the controller interface", async () => {
    expect(controller).not.toBeNull();
    await controller.navigate(`${app.url}/login`);
    const client = new ScriptedLLMClient([
      JSON.stringify({
        type: "type",
        selector: 'input[name="email"]',
        value: "qa@example.com"
      }),
      "null"
    ]);
    const agent = new Agent({ browser: controller, llmClient: client, maxSteps: 2 });

    const state = await agent.run("Enter the test account email");

    expect(state.completed).toBe(true);
    expect(state.actionHistory).toEqual([
      {
        type: "type",
        selector: 'input[name="email"]',
        value: "qa@example.com"
      }
    ]);
    expect(agent.getTrace().steps[0]?.result).toEqual({ success: true });
  });
});

class ScriptedLLMClient implements LLMClient {
  constructor(private readonly responses: string[]) {}

  async generate(): Promise<string> {
    return this.responses.shift() ?? "null";
  }
}
