import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Evaluator } from "@vibeqa/agent-core";
import { PlaywrightBrowserController } from "@vibeqa/browser-playwright";
import type { NavigationMetadata, Observation } from "@vibeqa/schemas";
import { describe, expect, it, vi } from "vitest";
import { detectPageError, ExplorationEvaluator } from "../src/exploration-evaluator.js";
import { AgentTestRequestExecutor, UserTestWorkflow } from "../src/test-workflow.js";
import { startDashboardServer } from "../src/server.js";
import type { ProductTestResult } from "../src/product-execution.js";
import {
  SecureAuthenticatedBrowserController,
  TemporaryLoginCredentials
} from "../src/secure-credentials.js";

describe("Exploratory navigation verification", () => {
  it("keeps direct navigation valid and explicit Functional URL verification strict", () => {
    const direct = observation("https://example.test/home");
    const action = { type: "navigate" as const, url: direct.url };
    expect(new ExplorationEvaluator().evaluate(action, direct).success).toBe(true);
    const redirected = observation("https://example.test/final", action.url);
    expect(new ExplorationEvaluator().evaluate(action, redirected)).toMatchObject({
      success: true,
      navigation: {
        requestedUrl: action.url,
        finalUrl: redirected.url,
        redirected: true,
        outcome: "redirect-accepted"
      }
    });
    expect(new Evaluator().evaluate(action, redirected)).toMatchObject({
      success: false,
      shouldContinue: false
    });
  });

  it.each([
    "cross-origin",
    "unsafe-scheme",
    "credentials",
    "stale",
    "incomplete",
    "unobservable",
    "redirect-error",
    "unsafe-hop"
  ])("does not silently accept %s redirects", (condition) => {
    const action = { type: "navigate" as const, url: "https://example.test/start" };
    const result = observation("https://example.test/end", action.url);
    const metadata = result.metadata.navigation;
    if (condition === "cross-origin")
      metadata.finalUrl = result.url = "https://external.test/";
    if (condition === "unsafe-scheme")
      metadata.finalUrl = result.url = "file:///tmp/page";
    if (condition === "credentials")
      metadata.finalUrl = result.url = "https://user:secret@example.test/end";
    if (condition === "stale") metadata.requestedUrl = "https://example.test/old";
    if (condition === "incomplete") metadata.completed = false;
    if (condition === "unobservable") result.textSample = "";
    if (condition === "redirect-error") metadata.responseStatus = 403;
    if (condition === "unsafe-hop")
      metadata.redirectChain = [action.url, "https://external.test/", result.url];
    expect(new ExplorationEvaluator().evaluate(action, result)).toMatchObject({
      success: false,
      shouldContinue: false,
      navigation: { outcome: "unverified" }
    });
  });

  it.each([404, 500, 503])(
    "detects main-document HTTP %s with a controlled page-error result",
    (status) => {
      const page = observation("https://example.test/error");
      page.metadata.navigation.responseStatus = status;
      expect(detectPageError(page)).toMatchObject({
        source: "http-status",
        statusCode: status
      });
      expect(
        new ExplorationEvaluator().evaluate({ type: "navigate", url: page.url }, page)
      ).toMatchObject({
        success: false,
        shouldContinue: false,
        navigation: { outcome: "page-error" }
      });
    }
  );

  it("uses clear title/main-heading fallback without turning ordinary 404 mentions into findings", () => {
    const page = observation("https://example.test/docs");
    page.title = "How to handle 404 responses";
    page.textSample =
      "Example: error 404. The phrase Page not found can appear in logs.";
    page.accessibility.headings = [{ level: 2, text: "404" }];
    expect(detectPageError(page)).toBeNull();
    page.accessibility.headings = [{ level: 1, text: "Page not found" }];
    expect(detectPageError(page)).toMatchObject({
      source: "page-not-found",
      statusCode: 200
    });
    page.accessibility.headings = [];
    page.title = "404: This page could not be found.";
    expect(detectPageError(page)?.source).toBe("page-not-found");
    page.title = "Page Not Found (404) | QA Practice";
    expect(detectPageError(page)?.source).toBe("page-not-found");
    page.title = "Practice";
    page.accessibility.headings = [{ level: 1, text: "404 \u2014 Page Not Found" }];
    expect(detectPageError(page)?.source).toBe("page-not-found");
    page.accessibility.headings = [];
    page.title = "Documentation";
    page.metadata.navigation.responseStatus = 403;
    expect(detectPageError(page)).toBeNull();
    page.metadata.navigation.responseStatus = 404;
    page.metadata.navigation.finalUrl = "https://example.test/old";
    expect(detectPageError(page)).toBeNull();
  });
});

describe("product redirect and page-error acceptance", () => {
  it("submits through New Test, accepts a redirect, records a clicked 404, and preserves evidence", async () => {
    const target = await fixtureServer();
    const root = join(
      process.cwd(),
      "run-output",
      `redirect-acceptance-${randomUUID()}`
    );
    const generate = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ type: "navigate", url: `${target.url}/redirect` })
      )
      .mockResolvedValueOnce(JSON.stringify({ type: "click", selector: "#missing" }))
      .mockResolvedValue("null");
    const workflow = new UserTestWorkflow(
      new AgentTestRequestExecutor({
        outputRoot: root,
        explorationClient: { generate }
      })
    );
    const dashboard = await startDashboardServer({
      port: 0,
      outputRoot: root,
      testWorkflow: workflow,
      llmClient: null
    });
    const ui = await PlaywrightBrowserController.launch();
    try {
      await ui.navigate(`${dashboard.url}/tests/new`);
      await ui.type("#websiteUrl", `${target.url}/`);
      await ui.click('label.mode-option:has(input[value="exploratory"])');
      await ui.type(
        "#objective",
        "Explore the website autonomously and discover user-visible failures across pages"
      );
      await ui.click('.test-request-form button[type="submit"]');
      const id = ui.getCurrentUrl().split("/").at(-1) ?? "";
      const completed = await workflow.waitForCompletion(id);
      expect(completed).toMatchObject({
        mode: "exploratory",
        expectedBehavior: "",
        outcome: { kind: "TARGET_ISSUE" }
      });
      if (!completed.runId) throw new Error("No product report was created");
      const report = JSON.parse(
        await readFile(join(root, completed.runId, "report.json"), "utf8")
      ) as ProductTestResult;
      expect(report.execution).toMatchObject({
        strategy: "adaptive-v2",
        terminationReason: "page-error",
        modelInvocationCount: 2,
        actionCount: 2
      });
      expect(report.executedSteps.map((step) => step.action.type)).toEqual([
        "navigate",
        "click"
      ]);
      expect(report.trace.steps[0]?.evaluation).toMatchObject({
        success: true,
        navigation: {
          requestedUrl: `${target.url}/redirect`,
          finalUrl: `${target.url}/destination`,
          redirected: true,
          outcome: "redirect-accepted",
          responseStatus: 200,
          redirectChain: [`${target.url}/redirect`, `${target.url}/destination`]
        }
      });
      const findings = report.bugReports.filter((bug) => bug.pageError);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.pageError).toMatchObject({
        url: `${target.url}/missing`,
        statusCode: 404,
        title: "Missing page",
        source: "http-status",
        severity: "medium",
        action: { type: "click", selector: "#missing" }
      });
      expect(findings[0]?.pageError?.path).toHaveLength(2);
      expect(report.trace.steps.at(-1)?.pageError?.statusCode).toBe(404);
      expect(
        report.trace.steps
          .filter((step) => step.action)
          .every((step) => step.safetyDecision === "allow")
      ).toBe(true);
      expect(report.screenshots).toHaveLength(3);
      for (const path of report.screenshots)
        expect((await stat(path)).size).toBeGreaterThan(0);
      const html = await (
        await fetch(`${dashboard.url}/runs/${completed.runId}`)
      ).text();
      expect(html).toContain('data-outcome="TARGET_ISSUE"');
      expect(html).toContain("HTTP 404 page failure");
      expect(html).toContain("Stopped after capturing a page failure");
      expect(html).toContain("Navigation redirected from");
      expect(html).not.toContain("Agent execution error");
      expect(html).toContain("Medium");
    } finally {
      await ui.close();
      await dashboard.close();
      await target.close();
    }
  }, 30_000);

  it("finds initial-page soft 404/5xx without planning; real navigation errors still fail", async () => {
    const target = await fixtureServer();
    const outputRoot = join(process.cwd(), "run-output", `page-error-${randomUUID()}`);
    const generate = vi.fn(async () => "null");
    const executor = new AgentTestRequestExecutor({
      outputRoot,
      explorationClient: { generate }
    });
    try {
      for (const path of ["/soft404", "/server-error", "/empty404"]) {
        const result = await executor.execute(
          {
            mode: "exploratory",
            websiteUrl: target.url + path,
            objective: "Explore this website",
            expectedBehavior: "",
            credentials: null
          },
          randomUUID()
        );
        expect(result.outcome?.kind).toBe("TARGET_ISSUE");
        const report = JSON.parse(
          await readFile(join(outputRoot, result.runId, "report.json"), "utf8")
        ) as ProductTestResult;
        expect(report.execution).toMatchObject({
          terminationReason: "page-error",
          actionCount: 0
        });
        expect(report.bugReports[0]?.pageError).toMatchObject({
          source: path === "/soft404" ? "page-not-found" : "http-status",
          statusCode: path === "/soft404" ? 200 : path === "/empty404" ? 404 : 500,
          action: null,
          path: []
        });
        expect(report.screenshots).toHaveLength(1);
      }
      expect(generate).not.toHaveBeenCalled();
      const failureClient = {
        generate: vi.fn(async () =>
          JSON.stringify({ type: "navigate", url: `${target.url}/network-error` })
        )
      };
      const failed = await new AgentTestRequestExecutor({
        outputRoot,
        explorationClient: failureClient
      }).execute(
        {
          mode: "exploratory",
          websiteUrl: `${target.url}/`,
          objective: "Explore and discover failures",
          expectedBehavior: "",
          credentials: null
        },
        randomUUID()
      );
      expect(failed.outcome?.kind).toBe("BROWSER_ERROR");
      const report = JSON.parse(
        await readFile(join(outputRoot, failed.runId, "report.json"), "utf8")
      ) as ProductTestResult;
      expect(report.trace.steps[0]?.result.success).toBe(false);
      expect(report.bugReports.some((bug) => bug.pageError)).toBe(false);
    } finally {
      await target.close();
    }
  }, 30_000);

  it("ignores subresource/hidden 404s, clears stale status on SPA changes, and redacts navigation evidence", async () => {
    const target = await fixtureServer();
    const browser = await PlaywrightBrowserController.launch();
    try {
      await browser.navigate(`${target.url}/normal`);
      await browser.wait(150);
      const normal = await browser.observe();
      expect(normal.metadata.navigation?.responseStatus).toBe(200);
      expect(detectPageError(normal)).toBeNull();
      expect(
        normal.accessibility.headings.map((heading) => heading.text)
      ).not.toContain("Page not found");
      await browser.navigate(`${target.url}/missing`);
      expect((await browser.observe()).metadata.navigation?.responseStatus).toBe(404);
      await browser.click("#recover");
      const recovered = await browser.observe();
      expect(recovered.metadata.navigation?.responseStatus).toBeNull();
      expect(detectPageError(recovered)).toBeNull();
      const credentials = new TemporaryLoginCredentials(
        "fixture-user",
        "fixture-private-value"
      );
      const secured = new SecureAuthenticatedBrowserController(browser, credentials);
      await secured.navigate(`${target.url}/secret?token=fixture-private-value`);
      const evidence = JSON.stringify(await secured.observe());
      expect(evidence).not.toContain("fixture-private-value");
      expect(evidence).toContain("[REDACTED]");
      credentials.clear();
    } finally {
      await browser.close();
      await target.close();
    }
  }, 30_000);
});

function observation(
  url: string,
  requestedUrl = url
): Observation & {
  metadata: Observation["metadata"] & { navigation: NavigationMetadata };
} {
  return {
    id: "observation",
    timestamp: new Date().toISOString(),
    url,
    title: "Ready",
    metadata: {
      url,
      title: "Ready",
      viewport: null,
      navigation: {
        requestedUrl,
        finalUrl: url,
        completed: true,
        redirected: requestedUrl !== url,
        responseStatus: 200,
        redirectChain: [requestedUrl, url]
      }
    },
    consoleErrors: [],
    accessibility: { headings: [], landmarks: [], interactiveElementCount: 0 },
    elements: [],
    textSample: "Ready",
    screenshotPath: null
  };
}

async function fixtureServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    const path = url.pathname;
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/network-error") {
      request.socket.destroy();
      return;
    }
    if (path === "/redirect" || path === "/secret") {
      response.writeHead(302, { location: `/destination${url.search}` });
      response.end();
      return;
    }
    if (path === "/missing") {
      response.statusCode = 404;
      response.end(
        "<title>Missing page</title><h1>Page not found</h1><button id=\"recover\" onclick=\"history.pushState({}, '', '/recovered'); document.title='Recovered'; document.body.innerHTML='<h1>Recovered</h1>'\">Recover</button>"
      );
      return;
    }
    if (path === "/server-error") {
      response.statusCode = 500;
      response.end("<title>Unavailable</title><h1>Server unavailable</h1>");
      return;
    }
    if (path === "/empty404") {
      response.statusCode = 404;
      response.end("<html><body></body></html>");
      return;
    }
    if (path === "/soft404") {
      response.end("<title>404: This page could not be found.</title><h1>404</h1>");
      return;
    }
    if (path === "/normal") {
      response.end(
        '<title>404 handling guide</title><h1>Documentation</h1><p>404 is a response code. Page not found is an example message.</p><h1 hidden>Page not found</h1><img src="/missing"><script>fetch("/missing")</script>'
      );
      return;
    }
    response.end(
      `<title>Practice</title><h1>Practice pages</h1><a id="missing" href="/missing">Missing page</a><a href="/redirect">Redirect</a><a href="/normal">Guide</a><a href="/other">Other</a>`
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}
