import type { BrowserController } from "@vibeqa/agent-core";
import { PlaywrightBrowserController } from "@vibeqa/browser-playwright";
import type { Observation } from "@vibeqa/schemas";
import type { TestResult } from "@vibeqa/test-engine";
import { describe, expect, it } from "vitest";

import { startBenchmarkServer } from "../../benchmark-app/src/index.js";

import {
  AgentTestRequestExecutor,
  UserTestWorkflow,
  type StoredTestConfiguration,
  type TestArtifactStore
} from "../src/test-workflow.js";
import {
  TEMPORARY_PASSWORD_PLACEHOLDER,
  TEMPORARY_USERNAME_PLACEHOLDER,
  TemporaryLoginCredentials
} from "../src/secure-credentials.js";

const USERNAME = "temporary.qa@example.test";
const PASSWORD = "temporary-password-8291";

describe("secure authenticated testing", () => {
  it("runs the Alpha local login default without a model and keeps credentials temporary", async () => {
    const benchmark = await startBenchmarkServer({ port: 0 });
    const artifacts = new SecurityArtifactStore();
    const credentials = new TemporaryLoginCredentials("qa@example.com", "password123");
    let modelCalls = 0;
    const executor = new AgentTestRequestExecutor({
      outputRoot: "unused",
      artifactStore: artifacts,
      explorationClient: {
        generate: async () => {
          modelCalls += 1;
          throw new Error("Unexpected model call");
        }
      }
    });
    try {
      await expect(
        executor.execute(
          {
            websiteUrl: `${benchmark.url}/login`,
            objective: "Test login functionality",
            expectedBehavior: "PRIVATE DASHBOARD",
            mode: "functional",
            credentials
          },
          "alpha-local-login"
        )
      ).resolves.toMatchObject({ status: "passed" });
      expect(modelCalls).toBe(0);
      expect(credentials.cleared).toBe(true);
      expect(artifacts.saved?.executedSteps).toHaveLength(5);
      expect(JSON.stringify(artifacts.saved)).not.toMatch(
        /qa@example\.com|password123/
      );
    } finally {
      await benchmark.close();
    }
  });

  it("injects credentials only at the browser boundary and redacts all artifacts", async () => {
    const credentials = new TemporaryLoginCredentials(USERNAME, PASSWORD);
    const browser = new CredentialEchoBrowser();
    const artifacts = new SecurityArtifactStore();
    let plannerPrompt = "";
    const executor = new AgentTestRequestExecutor({
      planner: {
        plan: async (request, startUrl) => {
          plannerPrompt = request;
          return {
            goal: "Authenticated login",
            startUrl,
            steps: [
              {
                name: "Enter username",
                action: {
                  type: "type",
                  selector: 'input[name="email"]',
                  value: TEMPORARY_USERNAME_PLACEHOLDER
                }
              },
              {
                name: "Enter password",
                action: {
                  type: "type",
                  selector: 'input[name="password"]',
                  value: TEMPORARY_PASSWORD_PLACEHOLDER
                }
              },
              {
                name: "Submit login",
                action: { type: "click", selector: 'button[type="submit"]' }
              },
              {
                name: "Verify dashboard",
                action: { type: "getCurrentUrl" },
                expected: { url: "http://example.test/dashboard" }
              }
            ]
          };
        }
      },
      outputRoot: "unused",
      launchBrowser: async () => browser,
      artifactStore: artifacts
    });

    await expect(
      executor.execute(
        {
          websiteUrl: "http://example.test/login",
          objective: "Test authenticated login",
          expectedBehavior: "The dashboard opens",
          mode: "functional",
          credentials
        },
        "secure-request"
      )
    ).resolves.toMatchObject({ status: "passed" });

    expect(browser.typedValues).toEqual([USERNAME, PASSWORD]);
    expect(browser.sensitiveValues).toEqual([USERNAME, PASSWORD]);
    expect(browser.sensitiveSelectors).toEqual(
      expect.arrayContaining([
        'input[type="password"]',
        'input[type="email"]',
        'input[name="email"]',
        'input[name="password"]'
      ])
    );
    expect(plannerPrompt).toContain(TEMPORARY_USERNAME_PLACEHOLDER);
    expect(plannerPrompt).toContain(TEMPORARY_PASSWORD_PLACEHOLDER);
    expect(plannerPrompt).not.toContain(USERNAME);
    expect(plannerPrompt).not.toContain(PASSWORD);

    const serializedArtifacts = JSON.stringify(artifacts.saved);
    expect(serializedArtifacts).not.toContain(USERNAME);
    expect(serializedArtifacts).not.toContain(PASSWORD);
    expect(serializedArtifacts).not.toContain(TEMPORARY_USERNAME_PLACEHOLDER);
    expect(serializedArtifacts).not.toContain(TEMPORARY_PASSWORD_PLACEHOLDER);
    expect(artifacts.configuration).toEqual({
      websiteUrl: "http://example.test/login",
      objective: "Test authenticated login",
      expectedBehavior: "The dashboard opens",
      mode: "functional",
      authenticationUsed: true
    });
    expect(JSON.stringify(artifacts.configuration)).not.toContain(USERNAME);
    expect(JSON.stringify(artifacts.configuration)).not.toContain(PASSWORD);
    expect(credentials.cleared).toBe(true);
    expect(browser.closed).toBe(true);
  });

  it("never exposes credentials through request state or failure messages", async () => {
    const credentials = new TemporaryLoginCredentials(USERNAME, PASSWORD);
    const workflow = new UserTestWorkflow(
      {
        execute: async () => {
          throw new Error(`Authentication failed for ${USERNAME} with ${PASSWORD}`);
        }
      },
      { idFactory: () => "secure-failure" }
    );

    const request = workflow.submit({
      websiteUrl: "https://example.test/login",
      objective: "Test authenticated login",
      expectedBehavior: "The account dashboard opens",
      mode: "functional",
      credentials
    });
    const completed = await workflow.waitForCompletion(request.id);

    expect(JSON.stringify(request)).not.toContain(USERNAME);
    expect(JSON.stringify(request)).not.toContain(PASSWORD);
    expect(completed.authenticationUsed).toBe(true);
    expect(completed.error).toBe(
      "Authentication failed for [REDACTED] with [REDACTED]"
    );
    expect(credentials.cleared).toBe(true);
  });

  it("redacts credentials when the temporary holder is serialized", () => {
    const credentials = new TemporaryLoginCredentials(USERNAME, PASSWORD);

    expect(JSON.stringify({ credentials })).toBe('{"credentials":{"redacted":true}}');
    expect(JSON.stringify({ credentials })).not.toContain(USERNAME);
    expect(JSON.stringify({ credentials })).not.toContain(PASSWORD);
  });

  it("clears credentials when planning fails before a browser is launched", async () => {
    const credentials = new TemporaryLoginCredentials(USERNAME, PASSWORD);
    let browserLaunched = false;
    const executor = new AgentTestRequestExecutor({
      planner: {
        plan: async () => {
          throw new Error(`Planner failed for ${USERNAME}`);
        }
      },
      outputRoot: "unused",
      launchBrowser: async () => {
        browserLaunched = true;
        return new CredentialEchoBrowser();
      }
    });

    await expect(
      executor.execute(
        {
          websiteUrl: "https://example.test/login",
          objective: "Test authenticated login",
          expectedBehavior: "The dashboard opens",
          mode: "functional",
          credentials
        },
        "planning-failure"
      )
    ).rejects.toThrow("Planner failed for [REDACTED]");
    expect(browserLaunched).toBe(false);
    expect(credentials.cleared).toBe(true);
  });

  it("logs in to the benchmark through a fresh isolated Playwright session", async () => {
    const benchmark = await startBenchmarkServer({ port: 0 });
    const artifacts = new SecurityArtifactStore();
    const credentials = new TemporaryLoginCredentials("qa@example.com", "password123");
    const executor = new AgentTestRequestExecutor({
      planner: {
        plan: async (_request, startUrl) => ({
          goal: "Verify authenticated benchmark access",
          startUrl,
          steps: [
            {
              name: "Enter email",
              action: {
                type: "type",
                selector: 'input[name="email"]',
                value: TEMPORARY_USERNAME_PLACEHOLDER
              }
            },
            {
              name: "Enter password",
              action: {
                type: "type",
                selector: 'input[name="password"]',
                value: TEMPORARY_PASSWORD_PLACEHOLDER
              }
            },
            {
              name: "Submit login",
              action: { type: "click", selector: 'button[type="submit"]' }
            },
            {
              name: "Wait for dashboard",
              action: { type: "wait", ms: 150 },
              expected: {
                url: `${benchmark.url}/dashboard`,
                requiredText: "PRIVATE DASHBOARD"
              }
            }
          ]
        })
      },
      outputRoot: "unused",
      launchBrowser: async () =>
        await PlaywrightBrowserController.launch({ headless: true }),
      artifactStore: artifacts
    });

    try {
      await expect(
        executor.execute(
          {
            websiteUrl: `${benchmark.url}/login`,
            objective: "Test login-required dashboard access",
            expectedBehavior: "The private dashboard opens",
            mode: "functional",
            credentials
          },
          "benchmark-auth"
        )
      ).resolves.toMatchObject({ status: "passed" });
      const serialized = JSON.stringify(artifacts.saved);
      expect(serialized).not.toContain("qa@example.com");
      expect(serialized).not.toContain("password123");
    } finally {
      await benchmark.close();
    }
  });
});

class SecurityArtifactStore implements TestArtifactStore {
  saved: TestResult | null = null;
  configuration: StoredTestConfiguration | null = null;

  screenshotDirectory(): string {
    return "run-output/security-tests";
  }

  async save(
    _runId: string,
    result: TestResult,
    configuration: StoredTestConfiguration
  ): Promise<void> {
    this.saved = result;
    this.configuration = configuration;
  }
}

class CredentialEchoBrowser implements BrowserController {
  readonly typedValues: string[] = [];
  readonly sensitiveSelectors: string[] = [];
  readonly sensitiveValues: string[] = [];
  closed = false;
  private currentUrl = "http://example.test/login";

  registerSensitiveSelector(selector: string): void {
    this.sensitiveSelectors.push(selector);
  }

  registerSensitiveValue(value: string): void {
    this.sensitiveValues.push(value);
  }

  async observe(): Promise<Observation> {
    return {
      id: "secure-observation",
      timestamp: "2026-08-25T10:00:00.000Z",
      url: this.currentUrl,
      title: `Account for ${USERNAME}`,
      metadata: {
        url: this.currentUrl,
        title: `Account for ${USERNAME}`,
        viewport: { width: 1280, height: 900 }
      },
      consoleErrors: [],
      accessibility: {
        headings: [{ level: 1, text: `Welcome ${USERNAME}` }],
        landmarks: [{ role: "main", name: null }],
        interactiveElementCount: 3
      },
      elements: [
        credentialElement("email", "email"),
        credentialElement("password", "password")
      ],
      textSample: `Signed in as ${USERNAME} with ${PASSWORD}`,
      screenshotPath: null
    };
  }

  async goto(url: string): Promise<void> {
    await this.navigate(url);
  }

  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
  }

  async click(): Promise<void> {
    this.currentUrl = "http://example.test/dashboard";
  }

  async type(_selector: string, value: string): Promise<void> {
    this.typedValues.push(value);
  }

  async getText(): Promise<string> {
    return `Welcome ${USERNAME}`;
  }

  async wait(): Promise<void> {}

  async screenshot(): Promise<string> {
    return "run-output/security-screenshot.png";
  }

  async assert(): Promise<void> {}

  getCurrentUrl(): string {
    return this.currentUrl;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function credentialElement(name: string, inputType: string) {
  return {
    id: `element-${name}`,
    tagName: "input",
    role: null,
    accessibleName: name,
    text: "",
    visible: true,
    enabled: true,
    editable: true,
    selector: `input[name="${name}"]`,
    href: null,
    inputType
  };
}
