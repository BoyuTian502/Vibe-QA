import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ReportStore } from "../src/report-store.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));

describe("ReportStore", () => {
  it("loads report, trace, issue, steps, and screenshot evidence", async () => {
    const store = new ReportStore(fixtureRoot);
    const runs = await store.listRuns();

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "demo-run-001",
      status: "failed",
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
