import type { BrowserController } from "@vibeqa/agent-core";
import type { TestPlanner } from "@vibeqa/planner";
import type { ElementInformation, Observation } from "@vibeqa/schemas";
import type { TestResult } from "@vibeqa/test-engine";
import { describe, expect, it, vi } from "vitest";

import { alphaExecutionPolicy } from "../src/alpha-policy.js";
import { TemporaryLoginCredentials } from "../src/secure-credentials.js";

import {
  AgentTestRequestExecutor,
  TestRequestValidationError,
  UserTestWorkflow,
  createUserTestWorkflow,
  validateCreateTestRequest,
  type CreateTestRequestInput,
  type QATestMode,
  type StoredTestConfiguration,
  type TestArtifactStore
} from "../src/test-workflow.js";

describe("UserTestWorkflow", () => {
  it.each(["functional", "regression"] as const)(
    "defaults %s to local deterministic execution",
    async (mode) => {
      const generate = vi
        .fn()
        .mockRejectedValue(new Error("No model should be called"));
      const artifacts = new MemoryArtifactStore();
      const executor = new AgentTestRequestExecutor({
        outputRoot: "unused",
        explorationClient: { generate },
        launchBrowser: async () => new FakeBrowserController(),
        artifactStore: artifacts
      });
      expect(alphaExecutionPolicy(mode)).toEqual({
        strategy: "deterministic",
        adaptivePolicyVersion: null
      });
      await expect(
        executor.execute(
          { ...testInput(mode), expectedBehavior: "Sign in" },
          "local-default"
        )
      ).resolves.toMatchObject({ status: "passed" });
      expect(generate).not.toHaveBeenCalled();
      expect(artifacts.saved?.executedSteps.map((step) => step.action)).toEqual([
        { type: "getText", selector: "body" }
      ]);
    }
  );

  it("makes every product mode available without a paid API or planner option", () => {
    expect(createUserTestWorkflow(null, "unused").availableModes).toEqual([
      "functional",
      "exploratory",
      "regression"
    ]);
    expect(alphaExecutionPolicy("exploratory")).toEqual({
      strategy: "adaptive",
      adaptivePolicyVersion: "v2"
    });
  });

  it("does not pass a local check when the expected text is absent", async () => {
    const artifacts = new MemoryArtifactStore();
    const executor = new AgentTestRequestExecutor({
      outputRoot: "unused",
      launchBrowser: async () => new FakeBrowserController(),
      artifactStore: artifacts
    });
    await expect(
      executor.execute(
        { ...testInput("functional"), expectedBehavior: "Missing content" },
        "missing-text"
      )
    ).resolves.toMatchObject({ status: "failed" });
    expect(
      artifacts.saved?.bugReports.some((report) => report.category === "content")
    ).toBe(true);
  });

  it("uses the existing Adaptive V2 path before narrowing a high-value exploratory state", async () => {
    const links: ElementInformation[] = Array.from({ length: 4 }, (_, index) => ({
      id: `link-${index}`,
      tagName: "a",
      role: "link",
      accessibleName: `Page ${index}`,
      text: `Page ${index}`,
      visible: true,
      enabled: true,
      editable: false,
      selector: `#link-${index}`,
      href: `http://example.test/page-${index}`
    }));
    const browser = new FakeBrowserController(links);
    const artifacts = new MemoryArtifactStore();
    const generate = vi.fn().mockResolvedValue("null");
    const executor = new AgentTestRequestExecutor({
      outputRoot: "unused",
      explorationClient: { generate },
      launchBrowser: async () => browser,
      artifactStore: artifacts
    });
    const input = {
      ...testInput("exploratory"),
      objective:
        "Explore all available workspace pages for private-user with private-pass-value",
      expectedBehavior: "Useful content is available",
      credentials: new TemporaryLoginCredentials("private-user", "private-pass-value"),
      hiddenBugId: "SECRET-BENCHMARK-ID",
      hiddenSelector: "#secret-target",
      routingRecommendation: "ollama"
    };
    await expect(executor.execute(input, "adaptive-default")).resolves.toMatchObject({
      status: "failed"
    });
    expect(generate).toHaveBeenCalledTimes(2);
    const prompt = generate.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Adaptive execution context:");
    expect(prompt).toContain("Handoff mode: early");
    expect(prompt).not.toMatch(
      /SECRET-BENCHMARK-ID|secret-target|routingRecommendation/
    );
    expect(prompt).not.toMatch(/private-user|private-pass-value/);
    expect(JSON.stringify(artifacts.savedConfiguration)).not.toMatch(
      /private-user|private-pass-value/
    );
    expect(browser.navigatedUrls).toEqual([input.websiteUrl]);
    expect(artifacts.saved?.errors.join(" ")).toContain(
      "without confirming the objective"
    );
    expect(browser.closed).toBe(true);
  });

  it("records local model unavailability without falling back to a successful result", async () => {
    const links: ElementInformation[] = Array.from({ length: 4 }, (_, index) => ({
      id: `link-${index}`,
      tagName: "a",
      role: "link",
      accessibleName: `Page ${index}`,
      text: `Page ${index}`,
      visible: true,
      enabled: true,
      editable: false,
      selector: `#link-${index}`,
      href: `http://example.test/page-${index}`
    }));
    const artifacts = new MemoryArtifactStore();
    const executor = new AgentTestRequestExecutor({
      outputRoot: "unused",
      explorationClient: {
        generate: async () => {
          throw new Error("connection refused");
        }
      },
      launchBrowser: async () => new FakeBrowserController(links),
      artifactStore: artifacts
    });
    await expect(
      executor.execute(
        { ...testInput("exploratory"), objective: "Explore the workspace" },
        "unavailable"
      )
    ).resolves.toMatchObject({ status: "failed" });
    expect(artifacts.saved?.errors.join(" ")).toContain(
      "Local exploration model unavailable"
    );
  });

  it("creates a request and preserves status through completion", async () => {
    const workflow = new UserTestWorkflow(
      {
        execute: async (input, requestId) => {
          expect(input.objective).toBe("Test login functionality");
          expect(input.mode).toBe("functional");
          expect(requestId).toBe("request-001");
          return { runId: "run-001", status: "passed" };
        }
      },
      {
        idFactory: () => "request-001",
        now: () => new Date("2026-08-25T08:00:00.000Z")
      }
    );

    const request = workflow.submit(testInput("functional"));

    expect(request).toMatchObject({
      id: "request-001",
      websiteUrl: "http://example.test/login",
      expectedBehavior: "The user reaches the dashboard",
      mode: "functional",
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
    let plannerRequest = "";
    const planner: TestPlanner = {
      plan: async (request, startUrl) => {
        plannerRequest = request;
        return {
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
            {
              name: "Read current URL",
              action: { type: "getCurrentUrl" },
              expected: { url: "http://example.test/login" }
            }
          ]
        };
      }
    };
    const executor = new AgentTestRequestExecutor({
      planner,
      outputRoot: "unused",
      launchBrowser: async () => browser,
      artifactStore: artifacts,
      now: () => new Date("2026-08-25T08:30:00.000Z")
    });

    const execution = await executor.execute(
      testInput("functional"),
      "request-agent-001"
    );

    expect(execution).toMatchObject({ status: "passed" });
    expect(plannerRequest).toContain("Testing mode: Functional");
    expect(plannerRequest).toContain(
      "Expected behavior: The user reaches the dashboard"
    );
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
    expect(artifacts.savedConfiguration).toEqual({
      websiteUrl: "http://example.test/login",
      objective: "Test login functionality",
      expectedBehavior: "The user reaches the dashboard",
      mode: "functional",
      authenticationUsed: false
    });
  });

  it("uses existing Explorer candidates and stops when no in-scope candidates remain", async () => {
    const browser = new FakeBrowserController([
      {
        id: "external-link",
        tagName: "a",
        role: "link",
        accessibleName: "External site",
        text: "External site",
        visible: true,
        enabled: true,
        editable: false,
        selector: "#external-link",
        href: "https://outside.test/"
      }
    ]);
    const artifacts = new MemoryArtifactStore();
    const executor = new AgentTestRequestExecutor({
      planner: null,
      outputRoot: "unused",
      launchBrowser: async () => browser,
      artifactStore: artifacts
    });

    const execution = await executor.execute(
      testInput("exploratory"),
      "request-explore-001"
    );

    expect(execution.status).toBe("passed");
    expect(browser.navigatedUrls).toEqual(["http://example.test/login"]);
    expect(browser.closed).toBe(true);
    expect(artifacts.saved?.goal).toBe("Test login functionality");
    expect(artifacts.saved?.screenshots.length).toBeGreaterThan(0);
    expect(artifacts.savedConfiguration?.mode).toBe("exploratory");
  });

  it("turns regression configuration into an expectation-driven plan", async () => {
    let plannerRequest = "";
    const executor = new AgentTestRequestExecutor({
      planner: {
        plan: async (request, startUrl) => {
          plannerRequest = request;
          return {
            goal: "Regression check",
            startUrl,
            steps: [
              {
                name: "Confirm sign-in page",
                action: { type: "wait", ms: 0 },
                expected: { requiredText: "Sign in" }
              }
            ]
          };
        }
      },
      outputRoot: "unused",
      launchBrowser: async () => new FakeBrowserController(),
      artifactStore: new MemoryArtifactStore()
    });

    await expect(
      executor.execute(testInput("regression"), "request-regression-001")
    ).resolves.toMatchObject({ status: "passed" });
    expect(plannerRequest).toContain("Testing mode: Regression");
    expect(plannerRequest).toContain("Create a regression plan");
    expect(plannerRequest).toContain("The user reaches the dashboard");
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
          objective: "Test login",
          expectedBehavior: "The login page remains available",
          mode: "functional",
          credentials: null
        },
        "request-cross-origin"
      )
    ).rejects.toThrow(/outside the submitted website/);
    expect(browserLaunched).toBe(false);
  });

  it("rejects invalid URLs, embedded credentials, secrets, and empty objectives", () => {
    expect(() =>
      validateCreateTestRequest({
        ...testInput("functional"),
        websiteUrl: "not-a-url"
      })
    ).toThrow(TestRequestValidationError);
    expect(() =>
      validateCreateTestRequest({
        websiteUrl: "https://user:pass@example.com",
        objective: "Test login",
        expectedBehavior: "The login page loads",
        mode: "functional",
        credentials: null
      })
    ).toThrow(/embedded credentials/);
    expect(() =>
      validateCreateTestRequest({
        websiteUrl: "https://example.com",
        objective: "Test login with password=hunter2",
        expectedBehavior: "The login page loads",
        mode: "functional",
        credentials: null
      })
    ).toThrow(/Do not include/);
    expect(() =>
      validateCreateTestRequest({
        websiteUrl: "https://example.com",
        objective: " ",
        expectedBehavior: "The page loads",
        mode: "functional",
        credentials: null
      })
    ).toThrow(/objective is required/);
    expect(() =>
      validateCreateTestRequest({
        ...testInput("functional"),
        mode: "invalid" as QATestMode
      })
    ).toThrow(/valid testing mode/);
  });
});

class MemoryArtifactStore implements TestArtifactStore {
  saved: TestResult | null = null;
  savedConfiguration: StoredTestConfiguration | null = null;

  screenshotDirectory(runId: string): string {
    return `memory/${runId}/screenshots`;
  }

  async save(
    _runId: string,
    result: TestResult,
    configuration: StoredTestConfiguration
  ): Promise<void> {
    this.saved = result;
    this.savedConfiguration = configuration;
  }
}

function testInput(mode: QATestMode): CreateTestRequestInput {
  return {
    websiteUrl: "http://example.test/login",
    objective: "Test login functionality",
    expectedBehavior: "The user reaches the dashboard",
    mode,
    credentials: null
  };
}

class FakeBrowserController implements BrowserController {
  readonly navigatedUrls: string[] = [];
  closed = false;
  private currentUrl = "http://example.test/";
  private observationIndex = 0;

  constructor(private readonly elements: ElementInformation[] = []) {}

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
        interactiveElementCount: this.elements.length
      },
      elements: this.elements,
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
