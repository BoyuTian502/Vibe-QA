import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startBenchmarkServer,
  type BenchmarkServer
} from "../../../apps/benchmark-app/src/index.js";
import { PlaywrightBrowserController } from "../../browser-playwright/src/index.js";
import type { AgentTraceStep } from "../../agent-core/src/index.js";
import type { Observation } from "../../schemas/src/index.js";
import { TestEvaluator, TestTask, type TestCase } from "../src/index.js";

let app: BenchmarkServer;
let browser: PlaywrightBrowserController | null;

beforeEach(async () => {
  app = await startBenchmarkServer();
  app.reset();
  browser = await PlaywrightBrowserController.launch({ headless: true });
});

afterEach(async () => {
  await browser?.close();
  await app.close();
  browser = null;
});

describe("TestTask", () => {
  it("executes a login workflow and returns a passing structured report", async () => {
    expect(browser).not.toBeNull();
    const testCase = loginTestCase(app.url);
    const task = new TestTask({
      browser,
      testCase,
      screenshotDirectory: join(process.cwd(), "run-output", "test-engine-tests")
    });

    const result = await task.run();

    expect(result.goal).toBe("Test login functionality");
    expect(result.status).toBe("passed");
    expect(result.executedSteps).toHaveLength(testCase.steps.length);
    expect(result.executedSteps.every((step) => step.status === "passed")).toBe(true);
    expect(result.executedSteps.at(-1)?.observation?.url).toBe(`${app.url}/dashboard`);
    expect(result.errors).toEqual([]);
    expect(result.bugReports).toEqual([]);
    expect(result.trace.goal).toBe(testCase.goal);
    expect(result.screenshots.length).toBeGreaterThanOrEqual(testCase.steps.length);
    expect(result.screenshots.every((path) => existsSync(path))).toBe(true);
  });

  it("reports failed actions with trace evidence", async () => {
    expect(browser).not.toBeNull();
    const task = new TestTask({
      browser,
      testCase: {
        goal: "Test missing login control",
        startUrl: `${app.url}/login`,
        steps: [
          {
            name: "Click missing control",
            action: { type: "click", selector: "[" }
          }
        ]
      },
      screenshotDirectory: join(process.cwd(), "run-output", "test-engine-tests")
    });

    const result = await task.run();

    expect(result.status).toBe("failed");
    expect(result.executedSteps[0]?.status).toBe("failed");
    expect(result.errors[0]).toContain("Unexpected token");
    expect(result.bugReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "action",
          stepName: "Click missing control"
        })
      ])
    );
    expect(result.trace.steps[0]?.result.success).toBe(false);
  });

  it("reports required-text and console-error failures", async () => {
    expect(browser).not.toBeNull();
    await browser.navigate(`${app.url}/dashboard`);
    const task = new TestTask({
      browser,
      testCase: {
        goal: "Test fragile dashboard widget",
        startUrl: `${app.url}/dashboard`,
        steps: [
          {
            name: "Run fragile widget",
            action: { type: "click", selector: "#trigger-client-error" },
            expected: { requiredText: "Widget completed successfully" }
          }
        ]
      },
      screenshotDirectory: join(process.cwd(), "run-output", "test-engine-tests")
    });

    const result = await task.run();

    expect(result.status).toBe("failed");
    expect(result.bugReports.map((bug) => bug.category)).toEqual(
      expect.arrayContaining(["content", "console", "evaluation"])
    );
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "Required text was not found: Widget completed successfully",
        expect.stringContaining("BUG-BENCH-005")
      ])
    );
  });
});

describe("TestEvaluator", () => {
  it("detects a required URL change that did not occur", () => {
    const observation = createObservation("http://localhost:3000/login");
    const actionTrace: AgentTraceStep = {
      timestamp: "2026-08-12T00:00:00.000Z",
      observation,
      thought: {},
      action: { type: "click", selector: 'button[type="submit"]' },
      result: { success: true }
    };

    const result = new TestEvaluator().evaluate(
      {
        name: "Submit login",
        action: { type: "click", selector: 'button[type="submit"]' },
        expected: { urlChanged: true }
      },
      0,
      actionTrace,
      observation,
      observation
    );

    expect(result.success).toBe(false);
    expect(result.bugReports[0]?.category).toBe("navigation");
  });
});

function loginTestCase(baseUrl: string): TestCase {
  return {
    goal: "Test login functionality",
    startUrl: `${baseUrl}/login`,
    steps: [
      {
        name: "Enter email",
        action: {
          type: "type",
          selector: 'input[name="email"]',
          value: "qa@example.com"
        }
      },
      {
        name: "Enter password",
        action: {
          type: "type",
          selector: 'input[name="password"]',
          value: "password123"
        }
      },
      {
        name: "Submit login",
        action: { type: "click", selector: 'button[type="submit"]' }
      },
      {
        name: "Wait for dashboard",
        action: { type: "wait", ms: 100 },
        expected: {
          url: `${baseUrl}/dashboard`,
          requiredText: "PRIVATE DASHBOARD"
        }
      }
    ]
  };
}

function createObservation(url: string): Observation {
  return {
    id: `observation-${url}`,
    timestamp: "2026-08-12T00:00:00.000Z",
    url,
    title: "Test page",
    metadata: {
      url,
      title: "Test page",
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
