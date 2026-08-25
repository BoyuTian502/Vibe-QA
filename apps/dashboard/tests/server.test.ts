import { fileURLToPath } from "node:url";

import { MockLLMClient } from "@vibeqa/llm";
import { describe, expect, it } from "vitest";

import { startDashboardServer } from "../src/server.js";
import { UserTestWorkflow } from "../src/test-workflow.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));
const analysisResponse = JSON.stringify({
  summary: "The fragile widget crashes when activated.",
  rootCause: "An uncaught exception occurs in the widget interaction handler.",
  suggestedFixes: ["Handle the exception.", "Add a regression test."],
  severity: "high",
  severityReasoning: "The error interrupts a visible dashboard workflow."
});

describe("dashboard server", () => {
  it("renders a report, exposes structured run data, serves evidence, and closes", async () => {
    const dashboard = await startDashboardServer({
      host: "127.0.0.1",
      port: 0,
      outputRoot: fixtureRoot,
      llmClient: new MockLLMClient(analysisResponse)
    });

    try {
      const page = await fetch(dashboard.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Vibe-QA Report Dashboard");
      expect(html).toContain("Verify the benchmark login workflow");
      expect(html).toContain("Dashboard");
      expect(html).toContain("History");
      expect(html).toContain("Run Details");
      expect(html).toContain("New Test");
      expect(html).toContain("Execution timeline");
      expect(html).toContain("Evidence screenshots");

      const fallbackPage = await fetch(`${dashboard.url}/?run=missing-run`);
      expect(await fallbackPage.text()).toContain(
        "Verify the benchmark login workflow"
      );

      const historyPage = await fetch(`${dashboard.url}/history`);
      const historyHtml = await historyPage.text();
      expect(historyPage.status).toBe(200);
      expect(historyHtml).toContain("QA run history");
      expect(historyHtml).toContain("Run time");
      expect(historyHtml).toContain("Status");
      expect(historyHtml).toContain("Bugs found");
      expect(historyHtml).toContain("Screenshots");
      expect(historyHtml).toContain("Duration");
      expect(historyHtml).toContain("5.3 s");
      expect(historyHtml).toContain("3.0 s");

      const detailPage = await fetch(`${dashboard.url}/runs/demo-run-001`);
      const detailHtml = await detailPage.text();
      expect(detailPage.status).toBe(200);
      expect(detailHtml).toContain("Detect the fragile dashboard widget failure");
      expect(detailHtml).toContain("Detected issue");
      expect(detailHtml).toContain("AI bug analysis");
      expect(detailHtml).toContain("The fragile widget crashes when activated.");
      expect(detailHtml).toContain("Likely root cause");
      expect(detailHtml).toContain("Suggested fixes");
      expect(detailHtml).toContain("Why this severity");
      expect(detailHtml).toContain("AI generated");
      expect(detailHtml).toContain('aria-current="page">Run Details</a>');

      const selectedRun = await fetch(`${dashboard.url}/runs?run=demo-run-001`);
      expect(selectedRun.url).toBe(`${dashboard.url}/runs/demo-run-001`);

      const apiResponse = await fetch(`${dashboard.url}/api/runs/demo-run-001`);
      expect(apiResponse.status).toBe(200);
      await expect(apiResponse.json()).resolves.toMatchObject({
        id: "demo-run-001",
        status: "failed",
        durationMs: 3000,
        screenshotCount: 1
      });

      const analysis = await fetch(`${dashboard.url}/api/runs/demo-run-001/analysis`);
      expect(analysis.status).toBe(200);
      await expect(analysis.json()).resolves.toMatchObject({
        severity: "high",
        source: "ai"
      });

      const image = await fetch(
        `${dashboard.url}/artifacts/demo-run-001/screenshots/browser-state.svg`
      );
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toContain("image/svg+xml");
      expect(await image.text()).toContain("<svg");
    } finally {
      await dashboard.close();
    }

    await expect(fetch(`${dashboard.url}/health`)).rejects.toThrow();
  });

  it("renders a useful empty state when no artifact directory exists", async () => {
    const dashboard = await startDashboardServer({
      host: "127.0.0.1",
      port: 0,
      outputRoot: fileURLToPath(new URL("./missing-fixtures", import.meta.url)),
      llmClient: null
    });

    try {
      const response = await fetch(dashboard.url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("No demo reports found");

      const newTestPage = await fetch(`${dashboard.url}/tests/new`);
      const newTestHtml = await newTestPage.text();
      expect(newTestHtml).toContain("Run a website test");
      expect(newTestHtml).toContain("Exploratory mode ready");
      expect(newTestHtml).toContain('value="functional"');
      expect(newTestHtml).toContain('value="exploratory"');
      expect(newTestHtml).toContain('value="regression"');
      expect(newTestHtml).toContain("disabled");
    } finally {
      await dashboard.close();
    }
  });

  it("creates a user test request and exposes its completion status", async () => {
    const workflow = new UserTestWorkflow(
      {
        execute: async () => ({ runId: "demo-run-001", status: "failed" })
      },
      {
        idFactory: () => "request-web-001",
        now: () => new Date("2026-08-25T09:00:00.000Z")
      }
    );
    const dashboard = await startDashboardServer({
      host: "127.0.0.1",
      port: 0,
      outputRoot: fixtureRoot,
      llmClient: null,
      testWorkflow: workflow
    });

    try {
      const formPage = await fetch(`${dashboard.url}/tests/new`);
      const formHtml = await formPage.text();
      expect(formPage.status).toBe(200);
      expect(formHtml).toContain('name="websiteUrl"');
      expect(formHtml).toContain('name="objective"');
      expect(formHtml).toContain('name="expectedBehavior"');
      expect(formHtml).toContain('name="mode"');
      expect(formHtml).toContain("All test modes ready");

      const invalid = await fetch(`${dashboard.url}/tests`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          websiteUrl: "bad-url",
          objective: "Test login functionality",
          expectedBehavior: "The user reaches the dashboard",
          mode: "functional"
        }),
        redirect: "manual"
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain("Website URL must be a valid URL");

      const created = await fetch(`${dashboard.url}/tests`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          websiteUrl: "http://example.test/login",
          objective: "Test login functionality",
          expectedBehavior: "The user reaches the dashboard",
          mode: "functional"
        }),
        redirect: "manual"
      });
      expect(created.status).toBe(303);
      expect(created.headers.get("location")).toBe("/test-requests/request-web-001");

      await workflow.waitForCompletion("request-web-001");
      const statusPage = await fetch(`${dashboard.url}/test-requests/request-web-001`);
      const statusHtml = await statusPage.text();
      expect(statusHtml).toContain("Issue found");
      expect(statusHtml).toContain("Functional test request");
      expect(statusHtml).toContain("The user reaches the dashboard");
      expect(statusHtml).toContain("View test report");
      expect(statusHtml).toContain("/runs/demo-run-001");

      const apiResponse = await fetch(
        `${dashboard.url}/api/test-requests/request-web-001`
      );
      await expect(apiResponse.json()).resolves.toMatchObject({
        status: "completed",
        runId: "demo-run-001",
        testStatus: "failed",
        mode: "functional",
        expectedBehavior: "The user reaches the dashboard"
      });
    } finally {
      await dashboard.close();
    }
  });
});
