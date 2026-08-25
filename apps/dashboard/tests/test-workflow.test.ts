import type { BrowserController } from "@vibeqa/agent-core";
import type { TestPlanner } from "@vibeqa/planner";
import type { Observation } from "@vibeqa/schemas";
import type { TestResult } from "@vibeqa/test-engine";
import { describe, expect, it } from "vitest";

import {
  AgentTestRequestExecutor,
  TestRequestValidationError,
  UserTestWorkflow,
  validateCreateTestRequest,
  type TestArtifactStore
} from "../src/test-workflow.js";

describe("UserTestWorkflow", () => {
  it("creates a request and preserves status through completion", async () => {
    const workflow = new UserTestWorkflow(
      {
        execute: async (input, requestId) => {
          expect(input.objective).toBe("Test login functionality");
          expect(requestId).toBe("request-001");
          return { runId: "run-001", status: "passed" };
        }
      },
      {
        idFactory: () => "request-001",
        now: () => new Date("2026-08-25T08:00:00.000Z")
      }
    );

    const request = workflow.submit({
      websiteUrl: "http://example.test/login",
      objective: "Test login functionality"
    });

    expect(request).toMatchObject({
      id: "request-001",
      websiteUrl: "http://example.test/login",
      status: "queued",
      runId: null
    });
    await expect(workflow.waitForCompletion(request.id)).resolves.toMatchObject({
      status: "completed",
      runId: "run-001",
      testStatus: "passed"
    });
  });

  it("runs a planned TestCase through TestTask and the existing Agent", async () => {
    const browser = new FakeBrowserController();
    const artifacts = new MemoryArtifactStore();
    const planner: TestPlanner = {
      plan: async (request, startUrl) => ({
        goal: request,
        startUrl,
        steps: [
          {
            name: "Enter password",
            action: {
              type: "type",
              selector: 'input[name="password"]',
              value: "private-value"
            }
          },
          {
            name: "Capture evidence",
            action: { type: "screenshot", path: "C:/unsafe/model-path.png" }
          },
          { name: "Read current URL", action: { type: "getCurrentUrl" } }
        ]
      })
    };
    const executor = new AgentTestRequestExecutor({
      planner,
      outputRoot: "unused",
      launchBrowser: async () => browser,
      artifactStore: artifacts,
      now: () => new Date("2026-08-25T08:30:00.000Z")
    });

    const execution = await executor.execute(
      {
        websiteUrl: "http://example.test/login",
        objective: "Test login functionality"
      },
      "request-agent-001"
    );

    expect(execution).toMatchObject({ status: "passed" });
    expect(browser.navigatedUrls).toEqual(["http://example.test/login"]);
    expect(browser.closed).toBe(true);
    expect(artifacts.saved?.trace.steps.length).toBeGreaterThan(0);
    expect(artifacts.saved?.executedSteps[0]?.action).toEqual({
      type: "type",
      selector: 'input[name="password"]',
      value: "[REDACTED]"
    });
    expect(artifacts.saved?.executedSteps[1]?.action).toEqual({
      type: "screenshot"
    });
    expect(JSON.stringify(artifacts.saved)).not.toContain("private-value");
    expect(JSON.stringify(artifacts.saved)).not.toContain("unsafe/model-path");
  });

  it("rejects planned navigation outside the submitted website", async () => {
    let browserLaunched = false;
    const executor = new AgentTestRequestExecutor({
      planner: {
        plan: async () => ({
          goal: "Test login",
          startUrl: "https://example.com/login",
          steps: [
            {
              name: "Leave the site",
              action: { type: "navigate", url: "https://unrelated.test/" }
            }
          ]
        })
      },
      outputRoot: "unused",
      launchBrowser: async () => {
        browserLaunched = true;
        return new FakeBrowserController();
      }
    });

    await expect(
      executor.execute(
        {
          websiteUrl: "https://example.com/login",
          objective: "Test login"
        },
        "request-cross-origin"
      )
    ).rejects.toThrow(/outside the submitted website/);
    expect(browserLaunched).toBe(false);
  });

  it("rejects invalid URLs, embedded credentials, secrets, and empty objectives", () => {
    expect(() =>
      validateCreateTestRequest({ websiteUrl: "not-a-url", objective: "Test login" })
    ).toThrow(TestRequestValidationError);
    expect(() =>
      validateCreateTestRequest({
        websiteUrl: "https://user:pass@example.com",
        objective: "Test login"
      })
    ).toThrow(/embedded credentials/);
    expect(() =>
      validateCreateTestRequest({
        websiteUrl: "https://example.com",
        objective: "Test login with password=hunter2"
      })
    ).toThrow(/Do not include/);
    expect(() =>
      validateCreateTestRequest({ websiteUrl: "https://example.com", objective: " " })
    ).toThrow(/objective is required/);
  });
});

class MemoryArtifactStore implements TestArtifactStore {
  saved: TestResult | null = null;

  screenshotDirectory(runId: string): string {
    return `memory/${runId}/screenshots`;
  }

  async save(_runId: string, result: TestResult): Promise<void> {
    this.saved = result;
  }
}

class FakeBrowserController implements BrowserController {
  readonly navigatedUrls: string[] = [];
  closed = false;
  private currentUrl = "http://example.test/";
  private observationIndex = 0;

  async observe(): Promise<Observation> {
    this.observationIndex += 1;
    return {
      id: `observation-${this.observationIndex}`,
      timestamp: new Date(
        `2026-08-25T08:30:0${this.observationIndex}.000Z`
      ).toISOString(),
      url: this.currentUrl,
      title: "Example Login",
      metadata: {
        url: this.currentUrl,
        title: "Example Login",
        viewport: { width: 1280, height: 900 }
      },
      consoleErrors: [],
      accessibility: {
        headings: [{ level: 1, text: "Sign in" }],
        landmarks: [{ role: "main", name: null }],
        interactiveElementCount: 1
      },
      elements: [],
      textSample: "Sign in",
      screenshotPath: null
    };
  }

  async goto(url: string): Promise<void> {
    await this.navigate(url);
  }

  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
    this.navigatedUrls.push(url);
  }

  async click(): Promise<void> {}

  async type(): Promise<void> {}

  async getText(): Promise<string> {
    return "Sign in";
  }

  async wait(): Promise<void> {}

  async screenshot(): Promise<string> {
    return `memory/screenshot-${this.observationIndex}.png`;
  }

  async assert(): Promise<void> {}

  getCurrentUrl(): string {
    return this.currentUrl;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
