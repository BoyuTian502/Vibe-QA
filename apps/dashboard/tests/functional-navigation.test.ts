import { createServer } from "node:http";

import type { BrowserController } from "@vibeqa/agent-core";
import { PlaywrightBrowserController } from "@vibeqa/browser-playwright";
import type { Observation } from "@vibeqa/schemas";
import type { TestCase, TestResult } from "@vibeqa/test-engine";
import { describe, expect, it, vi } from "vitest";

import {
  assertFunctionalPlan,
  localFunctionalKind
} from "../src/functional-objective.js";
import {
  AgentTestRequestExecutor,
  UserTestWorkflow,
  type CreateTestRequestInput,
  type TestArtifactStore
} from "../src/test-workflow.js";

const objective =
  "Navigate from the homepage to the Product Center section and verify that the destination page loads successfully.";
const request: CreateTestRequestInput = {
  websiteUrl: "http://example.test/#/home",
  objective,
  expectedBehavior: "Product Center",
  mode: "functional",
  credentials: null
};

describe("deterministic Functional objectives", () => {
  it.each([
    "Submit the contact form and verify the page",
    "Create a project and verify the dashboard",
    "Navigate to Products and click the first item",
    "Search for a product and verify the page",
    "Verify the homepage and approve the request",
    "Do not click Product Center; verify the homepage",
    "Verify the page after approving the request"
  ])(
    "does not downgrade an unsupported objective to a text check: %s",
    async (goal) => {
      const { executor, browser } = fixture();
      await expect(
        executor.execute({ ...request, objective: goal }, "unsupported")
      ).rejects.toThrow(/Unsupported deterministic Functional objective/);
      expect(browser.clicks).toEqual([]);
      expect(browser.closed).toBe(true);
    }
  );

  it("requires credentials for an actual login objective", () => {
    expect(() => localFunctionalKind("Test login functionality", false)).toThrow(
      /temporary credentials/
    );
    expect(localFunctionalKind("Test login functionality", true)).toBe("login");
    expect(
      localFunctionalKind("Verify that the homepage loads successfully.", false)
    ).toBe("text");
  });

  it("executes navigation before the normalized final text check without model calls", async () => {
    const { executor, artifacts, browser, generate } = fixture();
    await expect(
      executor.execute(
        { ...request, expectedBehavior: " Product\t Center " },
        "navigation"
      )
    ).resolves.toMatchObject({ status: "passed" });
    const result = artifacts.saved;
    expect(result?.executedSteps.map((step) => step.action.type)).toEqual([
      "wait",
      "click",
      "wait",
      "getText"
    ]);
    expect(result?.executedSteps.at(-1)?.observation?.url).toBe(
      "http://example.test/#/products"
    );
    expect(
      result?.trace.steps.some(
        (step) => step.action?.type === "click" && step.safetyDecision === "allow"
      )
    ).toBe(true);
    expect(browser.clicks).toHaveLength(1);
    expect(browser.closed).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });

  it("fails when homepage text exists but the click leaves the URL unchanged", async () => {
    const { executor, artifacts } = fixture({ noop: true });
    await expect(executor.execute(request, "noop")).resolves.toMatchObject({
      status: "failed"
    });
    expect(
      artifacts.saved?.errors.some((error) => error.includes("URL to change"))
    ).toBe(true);
  });

  it("checks text on the destination, not the homepage", async () => {
    const { executor, artifacts } = fixture({ missingDestinationText: true });
    await expect(
      executor.execute(request, "missing-destination-text")
    ).resolves.toMatchObject({ status: "failed" });
    expect(artifacts.saved?.executedSteps.at(-1)?.errors).toContain(
      "Required text was not found: Product Center"
    );
  });

  it.each(["missing", "ambiguous"])(
    "reports a controlled %s target failure",
    async (target) => {
      const { executor, browser } = fixture({ targetError: target });
      const workflow = new UserTestWorkflow(executor);
      const submitted = workflow.submit(request);
      await expect(workflow.waitForCompletion(submitted.id)).resolves.toMatchObject({
        status: "failed",
        testStatus: null,
        error: expect.stringContaining("missing, ambiguous, or unsupported")
      });
      expect(browser.clicks).toEqual([]);
      expect(browser.closed).toBe(true);
    }
  );

  it("preserves the existing safety gate for risky navigation labels", async () => {
    const { executor, browser, artifacts } = fixture({ label: "Delete account" });
    await expect(
      executor.execute(
        {
          ...request,
          objective: "Navigate to the account section",
          expectedBehavior: "Delete account"
        },
        "blocked"
      )
    ).resolves.toMatchObject({ status: "failed" });
    expect(browser.clicks).toEqual([]);
    expect(
      artifacts.saved?.trace.steps.some((step) => step.safetyDecision === "block")
    ).toBe(true);
  });

  it("rejects injected assertion-only plans for navigation and submission objectives", () => {
    const testCase: TestCase = {
      goal: objective,
      startUrl: request.websiteUrl,
      steps: [
        {
          name: "Text",
          action: { type: "getText", selector: "body" },
          expected: { requiredText: "Product Center" }
        }
      ]
    };
    expect(() => assertFunctionalPlan(objective, testCase)).toThrow(
      /requested interaction/
    );
    expect(() => assertFunctionalPlan("Submit the login form", testCase)).toThrow(
      /requested interaction/
    );
    expect(() =>
      assertFunctionalPlan(objective, {
        ...testCase,
        steps: [
          ...testCase.steps,
          { name: "Too late", action: { type: "click", selector: "#products" } }
        ]
      })
    ).toThrow(/requested interaction/);
  });

  it("does not accept an injected no-op navigation plan as successful completion", async () => {
    const { executor, artifacts } = fixture(
      { noop: true },
      {
        goal: objective,
        startUrl: request.websiteUrl,
        steps: [
          { name: "No-op click", action: { type: "click", selector: "#products" } },
          {
            name: "Text",
            action: { type: "getText", selector: "body" },
            expected: { requiredText: "Product Center" }
          }
        ]
      }
    );
    await expect(executor.execute(request, "injected-noop")).resolves.toMatchObject({
      status: "failed"
    });
    expect(artifacts.saved?.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("did not produce a verified URL change")
      ])
    );
  });

  it("executes a real SPA list-item navigation through TestTask and Playwright", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<html><body><ul><li onclick="location.hash='/products';document.querySelector('h1').textContent='Products destination'">Product Center</li></ul><h1>Homepage</h1><p>Product Center</p></body></html>`
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const artifacts = new ArtifactStore();
    let closed = false;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const executor = new AgentTestRequestExecutor({
        outputRoot: "unused",
        artifactStore: artifacts,
        launchBrowser: async () => {
          const browser = await PlaywrightBrowserController.launch({ headless: true });
          const close = browser.close.bind(browser);
          browser.close = async () => {
            await close();
            closed = true;
          };
          return browser;
        }
      });
      const run = await executor.execute(
        { ...request, websiteUrl: `http://127.0.0.1:${address.port}/#/home` },
        "spa-navigation"
      );
      expect(run.status).toBe("passed");
      const click = artifacts.saved?.executedSteps.find(
        (step) => step.action.type === "click"
      );
      expect(click?.observation?.url).toContain("#/products");
      expect(artifacts.saved?.executedSteps.at(-1)?.observation?.textSample).toContain(
        "Products destination"
      );
      expect(closed).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});

interface FixtureOptions {
  noop?: boolean;
  missingDestinationText?: boolean;
  targetError?: string;
  label?: string;
}

function fixture(options: FixtureOptions = {}, plan?: TestCase) {
  const browser = new NavigationBrowser(options);
  const artifacts = new ArtifactStore();
  const generate = vi.fn().mockRejectedValue(new Error("Unexpected model call"));
  const executor = new AgentTestRequestExecutor({
    outputRoot: "unused",
    artifactStore: artifacts,
    launchBrowser: async () => browser,
    explorationClient: { generate },
    ...(plan ? { planner: { plan: async () => plan } } : {})
  });
  return { executor, browser, artifacts, generate };
}

class ArtifactStore implements TestArtifactStore {
  saved: TestResult | null = null;
  screenshotDirectory(): string {
    return "run-output/functional-navigation-tests";
  }
  async save(_id: string, result: TestResult): Promise<void> {
    this.saved = result;
  }
}

class NavigationBrowser implements BrowserController {
  url = request.websiteUrl;
  clicks: string[] = [];
  closed = false;
  private count = 0;
  constructor(private readonly options: FixtureOptions) {}
  async navigate(url: string) {
    this.url = url;
  }
  async goto(url: string) {
    await this.navigate(url);
  }
  async observe(): Promise<Observation> {
    return {
      id: String(this.count++),
      timestamp: new Date().toISOString(),
      url: this.url,
      title: "Fixture",
      metadata: { url: this.url, title: "Fixture", viewport: null },
      elements: [],
      textSample: await this.getText("body"),
      screenshotPath: null,
      consoleErrors: [],
      accessibility: { headings: [], landmarks: [], interactiveElementCount: 0 }
    };
  }
  async getText(selector: string) {
    if (selector !== "body" && this.options.targetError)
      throw new Error(this.options.targetError);
    return this.options.missingDestinationText && this.url.endsWith("/products")
      ? "Other page"
      : (this.options.label ?? "Product Center");
  }
  async click(selector: string) {
    this.clicks.push(selector);
    if (!this.options.noop) this.url = "http://example.test/#/products";
  }
  async type() {}
  async wait() {}
  async screenshot() {
    return "run-output/functional-navigation-tests/mocked.png";
  }
  async assert() {}
  getCurrentUrl() {
    return this.url;
  }
  async close() {
    this.closed = true;
  }
}
