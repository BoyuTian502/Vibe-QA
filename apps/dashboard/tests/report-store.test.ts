import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ReportStore } from "../src/report-store.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));

describe("ReportStore", () => {
  it("loads report, trace, issue, steps, and screenshot evidence", async () => {
    const store = new ReportStore(fixtureRoot);
    const runs = await store.listRuns();

    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.id)).toEqual(["demo-run-002", "demo-run-001"]);
    expect(runs[1]).toMatchObject({
      id: "demo-run-001",
      status: "failed",
      durationMs: 3000,
      stepCount: 2,
      passedStepCount: 1,
      issueCount: 1,
      screenshotCount: 1
    });

    const run = await store.loadRun("demo-run-001");
    expect(run.primaryIssue).toMatchObject({
      category: "console",
      stepName: "Run fragile dashboard widget",
      screenshotUrl: expect.stringContaining("browser-state.svg")
    });
    expect(run.steps.map((step) => step.status)).toEqual(["passed", "failed"]);
    expect(run.timeline).toHaveLength(4);
    expect(run.timeline.at(-1)).toMatchObject({
      status: "failed",
      safetyDecision: "allow",
      error: expect.stringContaining("BUG-BENCH-005")
    });

    const passingRun = await store.loadRun("demo-run-002");
    expect(passingRun).toMatchObject({
      status: "passed",
      startedAt: "2026-08-21T09:00:00.000Z",
      completedAt: "2026-08-21T09:00:05.250Z",
      durationMs: 5250,
      issueCount: 0,
      screenshotCount: 0
    });
  });

  it("contains artifact paths within the selected run", () => {
    const store = new ReportStore(fixtureRoot);

    expect(
      store.resolveArtifact("demo-run-001", "screenshots/browser-state.svg")
    ).toMatch(/browser-state\.svg$/);
    expect(() => store.resolveArtifact("demo-run-001", "../../report.json")).toThrow(
      /outside the selected run/
    );
    expect(() => store.resolveArtifact("../demo-run-001", "report.json")).toThrow(
      /Invalid run ID/
    );
  });
});
