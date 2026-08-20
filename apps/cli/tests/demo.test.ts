import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { runTechnicalDemo, type DemoEvent } from "../src/demo-runner.js";
import { createDemoScenario } from "../src/demo-scenarios.js";

describe("technical demo scenarios", () => {
  it("constructs deterministic login and seeded-bug scenarios", () => {
    const baseUrl = "http://127.0.0.1:3000";
    const login = createDemoScenario("login", baseUrl);
    const bug = createDemoScenario("bug", baseUrl);

    expect(login.startUrl).toBe(`${baseUrl}/login`);
    expect(login.steps.at(-1)?.name).toBe("Confirm the private dashboard opened");
    expect(bug.steps).toHaveLength(login.steps.length + 1);
    expect(bug.steps.at(-1)).toMatchObject({
      name: "Click the fragile dashboard widget",
      action: { type: "click", selector: "#trigger-client-error" }
    });
  });
});

describe("runTechnicalDemo", () => {
  it("starts the benchmark, passes the login scenario, writes evidence, and cleans up", async () => {
    const events: DemoEvent[] = [];
    let keepOpenWaited = false;
    const result = await runTechnicalDemo({
      scenario: "login",
      headless: true,
      keepOpen: true,
      actionDelayMs: 0,
      outputRoot: testOutputRoot(),
      onEvent: (event) => events.push(event),
      waitForKeepOpen: async () => {
        keepOpenWaited = true;
      }
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "benchmark-ready" }),
        { type: "browser-ready" },
        expect.objectContaining({ type: "test-started" }),
        expect.objectContaining({ type: "evidence-saved" })
      ])
    );
    expect(result.benchmarkUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(result.result.status).toBe("passed");
    expect(result.result.bugReports).toEqual([]);
    expect(result.result.executedSteps).toHaveLength(4);
    expect(result.cleanup).toEqual({
      browserClosed: true,
      benchmarkClosed: true
    });
    expect(keepOpenWaited).toBe(true);
    expect(existsSync(result.reportPath)).toBe(true);
    expect(existsSync(result.tracePath)).toBe(true);
    expect(result.result.screenshots.every((path) => existsSync(path))).toBe(true);

    const report = await readFile(result.reportPath, "utf8");
    expect(report).not.toContain("password123");
    expect(report).toContain("[REDACTED]");
  });

  it("returns the real fragile-widget failure and structured BugReport", async () => {
    const result = await runTechnicalDemo({
      scenario: "bug",
      headless: true,
      actionDelayMs: 0,
      outputRoot: testOutputRoot()
    });

    expect(result.result.status).toBe("failed");
    expect(result.result.executedSteps.at(-1)?.status).toBe("failed");
    expect(result.result.bugReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "console",
          stepName: "Click the fragile dashboard widget",
          description: expect.stringContaining("BUG-BENCH-005")
        })
      ])
    );
    expect(result.result.screenshots.length).toBeGreaterThan(0);
    expect(result.cleanup).toEqual({
      browserClosed: true,
      benchmarkClosed: true
    });
  });
});

function testOutputRoot(): string {
  return join(process.cwd(), "run-output", "demo-tests", randomUUID());
}
