import { PlaywrightBrowserController } from "@vibeqa/browser-playwright";
import type { TestResult } from "@vibeqa/test-engine";
import { describe, expect, it } from "vitest";

import { getSettings, startBenchmarkServer } from "../../benchmark-app/src/index.js";
import {
  TEMPORARY_PASSWORD_PLACEHOLDER,
  TEMPORARY_USERNAME_PLACEHOLDER,
  TemporaryLoginCredentials
} from "../src/secure-credentials.js";
import { AgentTestRequestExecutor } from "../src/test-workflow.js";

describe("authenticated safety approval acceptance", () => {
  it.each(["pending", "approved", "denied"] as const)(
    "keeps a later settings submit gated when the login run is %s",
    async (decision) => {
      const benchmark = await startBenchmarkServer({ port: 0 });
      benchmark.reset();
      const originalSettings = getSettings();
      const credentials = new TemporaryLoginCredentials(
        "qa@example.com",
        "password123"
      );
      const saveSelector = '#settings-form button[type="submit"]';
      const saved: TestResult[] = [];
      let launches = 0;
      let closes = 0;
      let saveClicks = 0;
      let settingsWrites = 0;
      let approvals = 0;
      let requestId: string | undefined;
      let settingsCookie: string | undefined;
      let writeCookie: string | undefined;

      benchmark.server.prependListener("request", (request) => {
        if (request.method === "GET" && request.url === "/settings")
          settingsCookie = request.headers.cookie;
        if (request.method === "PUT" && request.url === "/api/settings") {
          settingsWrites += 1;
          writeCookie = request.headers.cookie;
        }
      });
      const executor = new AgentTestRequestExecutor({
        outputRoot: "unused",
        artifactStore: {
          screenshotDirectory: () => "run-output/safety-approval-tests",
          save: async (_id, result) => {
            saved.push(result);
          }
        },
        planner: {
          plan: async (_request, startUrl) => ({
            goal: "Test authenticated login and workspace settings",
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
                name: "Sign in",
                action: {
                  type: "click",
                  selector: '#login-form button[type="submit"]'
                }
              },
              {
                name: "Wait for sign-in",
                action: { type: "wait", ms: 250 },
                expected: { url: `${benchmark.url}/dashboard` }
              },
              {
                name: "Open settings",
                action: { type: "navigate", url: `${benchmark.url}/settings` }
              },
              {
                name: "Prepare settings",
                action: {
                  type: "type",
                  selector: 'input[name="workspaceName"]',
                  value: "Approved workspace"
                }
              },
              {
                name: "Save settings",
                action: { type: "click", selector: saveSelector }
              },
              { name: "Wait for save", action: { type: "wait", ms: 250 } },
              {
                name: "Verify settings",
                action: { type: "getText", selector: "body" },
                expected: { requiredText: "Settings saved." }
              }
            ]
          })
        },
        launchBrowser: async () => {
          launches += 1;
          const browser = await PlaywrightBrowserController.launch({ headless: true });
          const click = browser.click.bind(browser);
          browser.click = async (selector) => {
            if (selector === saveSelector) saveClicks += 1;
            await click(selector);
          };
          const close = browser.close.bind(browser);
          browser.close = async () => {
            closes += 1;
            await close();
          };
          return browser;
        },
        ...(decision === "pending"
          ? {}
          : {
              onApproval: async (request) => {
                approvals += 1;
                requestId = request.requestId;
                expect(saveClicks).toBe(0);
                expect(settingsWrites).toBe(0);
                expect(closes).toBe(0);
                expect(getSettings()).toEqual(originalSettings);
                expect(settingsCookie).toBeTruthy();
                expect(request).toMatchObject({
                  stepCount: 6,
                  observation: { url: `${benchmark.url}/settings` },
                  action: { type: "click", selector: saveSelector }
                });
                expect(request.actionHistory).toHaveLength(6);
                await new Promise((resolve) => setTimeout(resolve, 25));
                expect(saveClicks).toBe(0);
                expect(settingsWrites).toBe(0);
                return decision === "approved";
              }
            })
      });

      try {
        const execution = await executor.execute(
          {
            websiteUrl: `${benchmark.url}/login`,
            objective: "Test authenticated login",
            expectedBehavior: "Settings saved.",
            mode: "functional",
            credentials
          },
          `safety-${decision}`
        );
        expect(execution.status).toBe(decision === "approved" ? "passed" : "failed");
        expect(launches).toBe(1);
        expect(closes).toBe(1);
        expect(credentials.cleared).toBe(true);
        expect(approvals).toBe(decision === "pending" ? 0 : 1);
        expect(saveClicks).toBe(decision === "approved" ? 1 : 0);
        expect(settingsWrites).toBe(decision === "approved" ? 1 : 0);
        const trace = saved[0]?.trace;
        const save = trace?.steps.filter(
          (step) =>
            step.action?.type === "click" && step.action.selector === saveSelector
        );
        expect(save).toHaveLength(1);
        expect(save?.[0]).toMatchObject({
          safetyDecision: "require_approval",
          approvalStatus: decision,
          result: { success: decision === "approved" }
        });
        expect(save?.[0]?.approvalRequestId).toBeTruthy();
        if (decision !== "pending")
          expect(save?.[0]?.approvalRequestId).toBe(requestId);
        if (decision === "approved") {
          expect(writeCookie).toBe(settingsCookie);
          expect(getSettings().workspaceName).toBe("Approved workspace");
          expect(trace?.steps.filter((step) => step.action)).toHaveLength(9);
        } else expect(getSettings()).toEqual(originalSettings);
        expect(JSON.stringify(saved)).not.toMatch(
          /qa@example\.com|password123|vibeqa_session=valid/
        );
      } finally {
        benchmark.reset();
        await benchmark.close();
      }
    }
  );
});
