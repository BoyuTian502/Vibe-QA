import type { BrowserController } from "@vibeqa/agent-core";
import type { TestPlanner } from "@vibeqa/planner";
import type { ElementInformation, Observation } from "@vibeqa/schemas";
import type { TestResult } from "@vibeqa/test-engine";
import { describe, expect, it, vi } from "vitest";

import { alphaExecutionPolicy } from "../src/alpha-policy.js";
import type { ProductTestResult } from "../src/product-execution.js";
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
          {
            ...testInput(mode),
            objective: "Verify that the homepage loads successfully.",
            expectedBehavior: "  Sign\t in\r\nSign in  "
          },
          "local-default"
        )
      ).resolves.toMatchObject({ status: "passed" });
      expect(generate).not.toHaveBeenCalled();
      expect(artifacts.saved?.execution).toMatchObject({
        requestedMode: mode,
        strategy: "deterministic",
        modelInvocationCount: 0
      });
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
        {
          ...testInput("functional"),
          objective: "Verify that the homepage loads successfully.",
          expectedBehavior: "Missing content"
        },
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
    expect(artifacts.saved?.execution).toMatchObject({
      requestedMode: "exploratory",
      strategy: "adaptive-v2",
      modelInvocationCount: 2,
      terminationReason: "null-retry-exhausted"
    });
    expect(artifacts.saved?.trace.execution).toEqual(artifacts.saved?.execution);
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
              name: "Submit login",
              action: { type: "click", selector: "#sign-in" }
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
    expect(artifacts.saved?.executedSteps[2]?.action).toEqual({
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
      { ...testInput("exploratory"), expectedBehavior: "" },
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

  it.each(["functional", "regression", "exploratory"] as const)(
    "preserves %s through request validation and execution selection",
    async (mode) => {
      const execute = vi
        .fn()
        .mockResolvedValue({ runId: "preserved", status: "passed" });
      const workflow = new UserTestWorkflow({ execute });
      const input = {
        ...testInput(mode),
        expectedBehavior: mode === "exploratory" ? "" : "Sign in"
      };
      const request = workflow.submit(input);
      await workflow.waitForCompletion(request.id);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ mode, expectedBehavior: input.expectedBehavior }),
        request.id
      );
      if (mode !== "exploratory")
        expect(() =>
          validateCreateTestRequest({ ...input, expectedBehavior: "" })
        ).toThrow(/visible page text is required/);
    }
  );

  it.each(["", "Sign\t in\nSign in", "Missing text"])(
    "keeps optional text %j separate from autonomous actions",
    async (expectedBehavior) => {
      const browser = new FakeBrowserController(explorationLinks());
      const artifacts = new MemoryArtifactStore();
      const plan = vi
        .fn()
        .mockRejectedValue(new Error("Functional builder must not run"));
      const generate = vi
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify({ type: "navigate", url: "http://example.test/explored" })
        )
        .mockResolvedValue("null");
      const executor = new AgentTestRequestExecutor({
        outputRoot: "unused",
        planner: { plan },
        explorationClient: { generate },
        launchBrowser: async () => browser,
        artifactStore: artifacts
      });
      await executor.execute(
        {
          ...testInput("exploratory"),
          objective: "Explore all pages",
          expectedBehavior
        },
        "optional-text"
      );
      expect(plan).not.toHaveBeenCalled();
      expect(browser.navigatedUrls).toEqual([
        "http://example.test/login",
        "http://example.test/explored"
      ]);
      expect(artifacts.saved?.executedSteps[0]?.action).toEqual({
        type: "navigate",
        url: "http://example.test/explored"
      });
      expect(artifacts.saved?.execution?.actionCount).toBe(1);
      expect(artifacts.saved?.execution?.pagesVisited).toContain(
        "http://example.test/explored"
      );
      expect(
        artifacts.saved?.trace.steps.some(
          (step) => step.action?.type === "navigate" && step.safetyDecision === "allow"
        )
      ).toBe(true);
      expect(
        artifacts.saved?.executedSteps.some(
          (step) => step.name === "Verify optional final page text"
        )
      ).toBe(Boolean(expectedBehavior));
      expect(
        artifacts.saved?.bugReports.some((bug) => bug.category === "content")
      ).toBe(expectedBehavior === "Missing text");
    }
  );

  it.each(["require_approval", "block"] as const)(
    "keeps safety %s active after model handoff",
    async (decision) => {
      const selector = decision === "block" ? "#delete-account" : "#purchase";
      const browser = new FakeBrowserController([
        ...explorationLinks(),
        {
          id: "risky",
          selector,
          tagName: "button",
          role: "button",
          text: decision === "block" ? "Delete account permanently" : "Purchase",
          accessibleName: null,
          visible: true,
          enabled: true,
          editable: false
        }
      ]);
      const click = vi.spyOn(browser, "click");
      const artifacts = new MemoryArtifactStore();
      const executor = new AgentTestRequestExecutor({
        outputRoot: "unused",
        launchBrowser: async () => browser,
        artifactStore: artifacts,
        explorationClient: {
          generate: async () => JSON.stringify({ type: "click", selector })
        }
      });
      await executor.execute(
        {
          ...testInput("exploratory"),
          objective: "Explore all pages",
          expectedBehavior: ""
        },
        "safety"
      );
      expect(click).not.toHaveBeenCalled();
      expect(
        artifacts.saved?.trace.steps.some((step) => step.safetyDecision === decision)
      ).toBe(true);
      expect(artifacts.saved?.status).toBe("failed");
    }
  );

  it("waits for an initial loading screen before asking Adaptive to plan", async () => {
    const browser = new FakeBrowserController(explorationLinks());
    const observe = browser.observe.bind(browser);
    vi.spyOn(browser, "observe").mockImplementationOnce(async () => ({
      ...(await observe()),
      textSample: "Loading...",
      elements: []
    }));
    const wait = vi.spyOn(browser, "wait");
    const generate = vi.fn().mockResolvedValue("null");
    const artifacts = new MemoryArtifactStore();
    await new AgentTestRequestExecutor({
      outputRoot: "unused",
      launchBrowser: async () => browser,
      artifactStore: artifacts,
      explorationClient: { generate }
    }).execute(
      {
        ...testInput("exploratory"),
        objective: "Explore all pages",
        expectedBehavior: ""
      },
      "readiness"
    );
    expect(wait).toHaveBeenCalledWith(500);
    expect(generate).toHaveBeenCalled();
    expect(generate.mock.calls[0]?.[0]).not.toContain("Loading...");
    expect(artifacts.saved?.trace.steps[0]?.observation?.textSample).toBe("Sign in");
  });

  it("normalizes fenced actions and null before Adaptive applies its bounded continuation policy", async () => {
    const browser = new FakeBrowserController(explorationLinks());
    const artifacts = new MemoryArtifactStore();
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        '```json\n{"type":"navigate","url":"http://example.test/explored"}\n```'
      )
      .mockResolvedValue("```json\nnull\n```");
    await new AgentTestRequestExecutor({
      outputRoot: "unused",
      launchBrowser: async () => browser,
      artifactStore: artifacts,
      explorationClient: { generate }
    }).execute(
      {
        ...testInput("exploratory"),
        objective: "Explore all pages",
        expectedBehavior: ""
      },
      "fenced-json"
    );
    expect(generate).toHaveBeenCalledTimes(3);
    expect(artifacts.saved?.execution).toMatchObject({
      modelInvocationCount: 3,
      actionCount: 1,
      terminationReason: "null-retry-exhausted"
    });
    expect(artifacts.saved?.execution?.plannerDecisions).toContainEqual({
      phase: "ollama",
      outcome: "valid_action",
      actionType: "navigate"
    });
    expect(
      artifacts.saved?.execution?.plannerDecisions?.filter(
        (decision) => decision.outcome === "null_action"
      )
    ).toHaveLength(2);
    expect(artifacts.saved?.errors.join(" ")).not.toContain("expected object");
    expect(browser.navigatedUrls).toContain("http://example.test/explored");
  });

  it("executes a corrected model action and records recovery diagnostics", async () => {
    const browser = new FakeBrowserController(explorationLinks());
    const artifacts = new MemoryArtifactStore();
    const generate = vi
      .fn()
      .mockResolvedValueOnce('{"type":"navigate"}')
      .mockResolvedValueOnce('{"type":"navigate","url":"http://example.test/explored"}')
      .mockResolvedValue("null");
    await new AgentTestRequestExecutor({
      outputRoot: "unused",
      launchBrowser: async () => browser,
      artifactStore: artifacts,
      explorationClient: { generate }
    }).execute(
      {
        ...testInput("exploratory"),
        objective: "Explore all pages",
        expectedBehavior: ""
      },
      "repaired-model-output"
    );
    expect(browser.navigatedUrls).toContain("http://example.test/explored");
    expect(artifacts.saved?.execution?.modelOutputRecovery).toMatchObject({
      generationAttempts: 4,
      invalidResponseCount: 1,
      retryCount: 1,
      recoveredCount: 1,
      exhaustionCount: 0
    });
    expect(artifacts.saved?.trace.steps.some((step) => step.action)).toBe(true);
  });

  it("bounds malformed model correction and records a typed invalid-output result", async () => {
    const browser = new FakeBrowserController(explorationLinks());
    const artifacts = new MemoryArtifactStore();
    await new AgentTestRequestExecutor({
      outputRoot: "unused",
      launchBrowser: async () => browser,
      artifactStore: artifacts,
      explorationClient: { generate: async () => '{"type":"unsupported"}' }
    }).execute(
      {
        ...testInput("exploratory"),
        objective: "Explore all pages",
        expectedBehavior: ""
      },
      "malformed"
    );
    expect(artifacts.saved?.execution?.actionCount).toBe(0);
    expect(artifacts.saved?.errors.join(" ")).toContain("MODEL_OUTPUT_INVALID");
    expect(artifacts.saved?.errors.join(" ")).not.toContain("unavailable");
    expect(artifacts.saved?.execution).toMatchObject({
      terminationReason: "MODEL_OUTPUT_INVALID",
      modelOutputRecovery: {
        generationAttempts: 3,
        invalidResponseCount: 3,
        retryCount: 2,
        recoveredCount: 0,
        exhaustionCount: 1
      }
    });
    expect(browser.closed).toBe(true);
  });

  it("records a recovered transient observation retry in product execution", async () => {
    const browser = new FakeBrowserController(explorationLinks());
    const observe = browser.observe.bind(browser);
    vi.spyOn(browser, "observe")
      .mockRejectedValueOnce(new Error("Execution context was destroyed"))
      .mockImplementation(observe);
    const artifacts = new MemoryArtifactStore();
    await new AgentTestRequestExecutor({
      outputRoot: "unused",
      launchBrowser: async () => browser,
      artifactStore: artifacts,
      explorationClient: { generate: async () => "null" }
    }).execute(
      { ...testInput("exploratory"), objective: "Explore all pages" },
      "browser-retry"
    );
    expect(
      artifacts.saved?.execution?.browserRetries?.map((event) => event.outcome)
    ).toEqual(["retrying", "recovered"]);
    expect(browser.closed).toBe(true);
  });

  it("saves a typed browser result when initial exploration navigation exhausts retry", async () => {
    const browser = new FakeBrowserController(explorationLinks());
    const navigate = vi
      .spyOn(browser, "navigate")
      .mockRejectedValue(new Error("page.goto: net::ERR_CONNECTION_CLOSED"));
    const artifacts = new MemoryArtifactStore();
    const generate = vi.fn();
    const execution = await new AgentTestRequestExecutor({
      outputRoot: "unused",
      launchBrowser: async () => browser,
      artifactStore: artifacts,
      explorationClient: { generate }
    }).execute(
      { ...testInput("exploratory"), objective: "Explore all pages" },
      "initial-navigation-failure"
    );
    expect(execution.outcome?.kind).toBe("BROWSER_ERROR");
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(generate).not.toHaveBeenCalled();
    expect(artifacts.saved?.execution).toMatchObject({
      strategy: "adaptive-v2",
      terminationReason: "BROWSER_ERROR",
      actionCount: 0
    });
    expect(artifacts.saved?.trace.steps[0]).toMatchObject({
      action: { type: "navigate" },
      result: { success: false }
    });
    expect(artifacts.saved?.execution?.browserRetries?.at(-1)?.outcome).toBe(
      "exhausted"
    );
    expect(browser.closed).toBe(true);
  });

  it("bounds loading waits instead of reporting an empty exploration as a pass", async () => {
    const browser = new FakeBrowserController();
    const observe = browser.observe.bind(browser);
    vi.spyOn(browser, "observe").mockImplementation(async () => ({
      ...(await observe()),
      textSample: "Loading..."
    }));
    const generate = vi.fn();
    const artifacts = new MemoryArtifactStore();
    await new AgentTestRequestExecutor({
      outputRoot: "unused",
      launchBrowser: async () => browser,
      artifactStore: artifacts,
      explorationClient: { generate }
    }).execute({ ...testInput("exploratory"), expectedBehavior: "" }, "loading");
    expect(browser.observe).toHaveBeenCalledTimes(11);
    expect(generate).not.toHaveBeenCalled();
    expect(artifacts.saved?.status).toBe("failed");
    expect(artifacts.saved?.errors.join(" ")).toContain("readiness wait");
    expect(browser.closed).toBe(true);
  });
});

function explorationLinks(): ElementInformation[] {
  return Array.from({ length: 4 }, (_, index) => ({
    id: `page-${index}`,
    tagName: "a",
    role: "link",
    accessibleName: `Page ${index}`,
    text: `Page ${index}`,
    visible: true,
    enabled: true,
    editable: false,
    selector: `#page-${index}`,
    href:
      index === 0 ? "http://example.test/explored" : `http://example.test/page-${index}`
  }));
}

class MemoryArtifactStore implements TestArtifactStore {
  saved: ProductTestResult | null = null;
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
        Date.UTC(2026, 7, 25, 8, 30, this.observationIndex)
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
