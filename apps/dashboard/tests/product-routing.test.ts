import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { PlaywrightBrowserController } from "@vibeqa/browser-playwright";
import { describe, expect, it, vi } from "vitest";

import { startDashboardServer } from "../src/server.js";
import { AgentTestRequestExecutor, UserTestWorkflow } from "../src/test-workflow.js";
import type { ProductTestResult } from "../src/product-execution.js";

describe("product form to execution", () => {
  it("submits empty-text Exploratory through Adaptive V2 and keeps other modes deterministic", async () => {
    const target = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        request.url === "/second"
          ? "<title>Second page</title><h1>Explored destination</h1>"
          : `<title>Practice</title><h1>Practice home</h1>${Array.from({ length: 4 }, (_, index) => `<a id="page-${index}" href="/${index === 0 ? "second" : `page-${index}`}">Page ${index}</a>`).join("")}`
      );
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const targetUrl = `http://127.0.0.1:${address.port}/`;
    const outputRoot = join(
      process.cwd(),
      "run-output",
      `product-routing-${randomUUID()}`
    );
    const generate = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ type: "click", selector: "#element-7" }))
      .mockResolvedValueOnce(
        JSON.stringify({ type: "navigate", url: `${targetUrl}second` })
      )
      .mockResolvedValue("null");
    const workflow = new UserTestWorkflow(
      new AgentTestRequestExecutor({ outputRoot, explorationClient: { generate } })
    );
    const dashboard = await startDashboardServer({
      port: 0,
      outputRoot,
      testWorkflow: workflow,
      llmClient: null
    });
    const browser = await PlaywrightBrowserController.launch({ headless: true });
    try {
      await browser.navigate(`${dashboard.url}/tests/new`);
      // Click the visible label, not a constructed API payload or a hidden radio.
      await browser.click('label.mode-option:has(input[value="exploratory"])');
      await browser.type("#websiteUrl", targetUrl);
      await browser.type(
        "#objective",
        "Explore all available pages as a first-time user"
      );
      expect(await browser.getText("#expected-text-hint")).toContain(
        "Optional. Exploratory mode autonomously navigates"
      );
      await browser.click('.test-request-form button[type="submit"]');
      expect(browser.getCurrentUrl()).toContain("/test-requests/");
      const requestId = browser.getCurrentUrl().split("/").at(-1) ?? "";
      const completed = await workflow.waitForCompletion(requestId);
      expect(completed).toMatchObject({
        mode: "exploratory",
        expectedBehavior: "",
        status: "completed",
        testStatus: "passed"
      });
      const report = JSON.parse(
        await readFile(join(outputRoot, completed.runId ?? "", "report.json"), "utf8")
      ) as ProductTestResult;
      expect(report.execution).toMatchObject({
        requestedMode: "exploratory",
        strategy: "adaptive-v2",
        modelInvocationCount: 3,
        actionCount: 1
      });
      expect(report.execution?.pagesVisited).toEqual([targetUrl, `${targetUrl}second`]);
      expect(
        report.trace.steps.some(
          (step) => step.action?.type === "navigate" && step.safetyDecision === "allow"
        )
      ).toBe(true);
      expect(report.trace.execution).toEqual(report.execution);
      expect(report.executedSteps.map((step) => step.action.type)).toEqual([
        "navigate"
      ]);
      expect(report.execution?.elementRecovery).toEqual({
        failedTargets: 0,
        replanAttempts: 0,
        recoveredTargets: 0
      });
      expect(report.execution?.modelOutputRecovery).toMatchObject({
        invalidResponseCount: 1,
        retryCount: 1,
        recoveredCount: 1
      });
      expect(generate.mock.calls[1]?.[0]).toContain("CORRECTION REQUIRED");
      const detail = await (
        await fetch(`${dashboard.url}/runs/${completed.runId}`)
      ).text();
      expect(detail).toContain("Exploratory journey");
      expect(detail).toContain("Autonomous exploration");
      expect(detail).toContain("3 model calls");

      const callsAfterExploration = generate.mock.calls.length;
      for (const mode of ["functional", "regression"] as const) {
        const response = await fetch(`${dashboard.url}/tests`, {
          method: "POST",
          body: new URLSearchParams({
            mode,
            websiteUrl: targetUrl,
            objective: "Verify the page loads",
            expectedBehavior: "Practice\t home",
            planner: "ollama",
            strategy: "adaptive"
          }),
          redirect: "manual"
        });
        expect(response.status).toBe(303);
        const id = response.headers.get("location")?.split("/").at(-1) ?? "";
        const request = await workflow.waitForCompletion(id);
        expect(request).toMatchObject({ mode, testStatus: "passed" });
        const result = JSON.parse(
          await readFile(join(outputRoot, request.runId ?? "", "report.json"), "utf8")
        ) as ProductTestResult;
        expect(result.execution).toMatchObject({
          requestedMode: mode,
          strategy: "deterministic",
          modelInvocationCount: 0
        });
      }
      expect(generate).toHaveBeenCalledTimes(callsAfterExploration);
      expect((await browser.observe()).consoleErrors).toEqual([]);
    } finally {
      await browser.close();
      await dashboard.close();
      await new Promise<void>((resolve, reject) =>
        target.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }, 30_000);

  it("rejects missing or duplicate modes instead of selecting Functional", async () => {
    const execute = vi.fn();
    const dashboard = await startDashboardServer({
      port: 0,
      outputRoot: "run-output/absent",
      testWorkflow: new UserTestWorkflow({ execute }),
      llmClient: null
    });
    try {
      for (const modes of [[], ["functional", "exploratory"], ["unknown"]]) {
        const body = new URLSearchParams({
          websiteUrl: "https://example.test/",
          objective: "Explore pages",
          expectedBehavior: ""
        });
        for (const mode of modes) body.append("mode", mode);
        const response = await fetch(`${dashboard.url}/tests`, {
          method: "POST",
          body
        });
        expect(response.status).toBe(400);
        expect(await response.text()).not.toMatch(
          /value="(?:functional|regression|exploratory)"\s+checked/
        );
      }
      expect(execute).not.toHaveBeenCalled();
      const form = await (await fetch(`${dashboard.url}/tests/new`)).text();
      expect(form).not.toMatch(
        /value="(?:functional|regression|exploratory)"\s+checked/
      );
      expect(form).not.toMatch(/name="(?:planner|strategy|adaptivePolicy)"/);
    } finally {
      await dashboard.close();
    }
  });
});
