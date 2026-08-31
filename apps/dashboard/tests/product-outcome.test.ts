import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ReportStore } from "../src/report-store.js";
import { BugAnalysisService } from "../src/bug-analysis.js";
import { classifyProductOutcome } from "../src/product-outcome.js";
import {
  renderDashboardPage,
  renderHistoryPage,
  renderTestCreationPage,
  renderTestRequestPage
} from "../src/view.js";
import type { DashboardRun } from "../src/types.js";
import type { UserTestRequest } from "../src/test-workflow.js";

describe("Alpha product outcome presentation", () => {
  it("does not count or analyze unexecuted-step bugs as target findings", async () => {
    const root = "run-output/alpha-outcome-tests";
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "run-"));
    const runId = directory.slice(root.length + 1);
    const report = {
      goal: "Review a local form",
      status: "failed",
      errors: ["Action is awaiting human approval."],
      executedSteps: [],
      bugReports: [
        { category: "action", description: "Action is awaiting human approval." }
      ]
    };
    await writeFile(join(directory, "report.json"), JSON.stringify(report));
    await writeFile(
      join(directory, "trace.json"),
      JSON.stringify({
        steps: [{ safetyDecision: "require_approval", approvalStatus: "pending" }]
      })
    );
    const store = new ReportStore(root);
    const pending = await store.loadRun(runId);
    expect(pending.outcome?.kind).toBe("APPROVAL_REQUIRED");
    expect(pending.issueCount).toBe(0);
    expect(pending.primaryIssue).toBeNull();
    const generate = vi.fn(async () => "unexpected");
    expect(await new BugAnalysisService({ generate }).analyze(pending)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    report.bugReports.push({
      category: "console",
      description: "Independent page error before the safety stop"
    });
    await writeFile(join(directory, "report.json"), JSON.stringify(report));
    expect((await store.loadRun(runId)).issueCount).toBe(1);
  });
  it.each([
    ["TARGET_ISSUE", "Issue found", "pageerror: Widget failed", "console"],
    [
      "TEST_ASSERTION_FAILURE",
      "Expected result not met",
      "Required text was not found: Ready",
      "content"
    ],
    [
      "SAFETY_BLOCKED",
      "Blocked by safety",
      "Action blocked by safety policy: Account deletion.",
      "action"
    ],
    [
      "APPROVAL_REQUIRED",
      "Approval required",
      "Action is awaiting human approval.",
      "action"
    ],
    [
      "UNSUPPORTED_OBJECTIVE",
      "Unsupported objective",
      "UNSUPPORTED_FUNCTIONAL_OBJECTIVE: Unsupported command",
      "action"
    ],
    [
      "AGENT_ERROR",
      "Agent execution error",
      "Exploration stopped without confirming the objective",
      "evaluation"
    ],
    [
      "MODEL_ERROR",
      "Model execution error",
      "STALE_ELEMENT_RECOVERY_FAILED: Unknown target",
      "action"
    ],
    [
      "BROWSER_ERROR",
      "Browser execution error",
      "page.goto: net::ERR_CONNECTION_REFUSED",
      "action"
    ],
    [
      "INFRASTRUCTURE_ERROR",
      "Local setup error",
      "browserType.launch: Executable doesn't exist",
      "action"
    ]
  ])(
    "renders %s without treating execution failures as website bugs",
    (kind, label, error, category) => {
      const outcome = classifyProductOutcome({
        status: "failed",
        errors: [error],
        bugReports: [{ category }]
      });
      expect(outcome).toMatchObject({ kind, label });
      const run = fixture(outcome);
      const html = renderDashboardPage([run], run);
      expect(html).toContain(`data-outcome="${kind}"`);
      expect(html).toContain(`<h2>${label}</h2>`);
      expect(renderHistoryPage([run])).toContain(label);
      const request: UserTestRequest = {
        id: "request",
        websiteUrl: "http://example.test",
        objective: "Check the page",
        expectedBehavior: "Ready",
        mode: "functional",
        authenticationUsed: false,
        status: "completed",
        createdAt: "2026-08-31T00:00:00Z",
        startedAt: null,
        completedAt: null,
        runId: "run",
        testStatus: "failed",
        error: null,
        outcome
      };
      expect(renderTestRequestPage([], request)).toContain(`<h2>${label}</h2>`);
      if (outcome.tone === "attention") {
        expect(html).not.toContain("Issue found");
        expect(html).toContain("No target-site bug analysis");
      }
    }
  );

  it("prefers final approval state over old errors and preserves recovered passes", () => {
    expect(
      classifyProductOutcome({
        status: "failed",
        trace: { steps: [{ approvalStatus: "pending" }] }
      }).kind
    ).toBe("APPROVAL_REQUIRED");
    expect(
      classifyProductOutcome({
        status: "failed",
        trace: {
          steps: [{ safetyDecision: "require_approval", approvalStatus: "denied" }]
        }
      }).kind
    ).toBe("SAFETY_BLOCKED");
    expect(
      classifyProductOutcome({
        status: "passed",
        trace: {
          steps: [
            {
              approvalStatus: "approved",
              result: { error: "locator.click: earlier failure" }
            }
          ]
        }
      }).kind
    ).toBe("PASSED");
    expect(
      classifyProductOutcome({
        status: "failed",
        errors: ["Unexpected token 'x', not valid JSON"]
      }).kind
    ).toBe("MODEL_ERROR");
    expect(
      classifyProductOutcome({
        status: "failed",
        errors: ["The page remained empty or loading after the readiness wait."]
      }).kind
    ).toBe("BROWSER_ERROR");
  });

  it("keeps product mode copy explicit and hides strategy controls", () => {
    const html = renderTestCreationPage(
      [],
      ["functional", "regression", "exploratory"]
    );
    expect(html.indexOf('id="websiteUrl"')).toBeLessThan(
      html.indexOf("<legend>Testing mode")
    );
    expect(html).toContain("Expected visible page text");
    expect(html).toContain("Required for this local check");
    expect(html).toContain("Exploratory mode autonomously navigates");
    expect(html).toContain("Credentials are kept in memory");
    expect(html).not.toMatch(
      /name="(?:planner|strategy|adaptivePolicy)"|Adaptive V2|Hybrid/
    );
    const exploratory = renderTestCreationPage([], ["exploratory"], null, {
      websiteUrl: "https://example.test",
      objective: "Explore",
      expectedBehavior: "",
      mode: "exploratory",
      credentials: null
    });
    expect(
      exploratory.match(/<textarea[^>]+id="expectedBehavior"[^>]*>/s)?.[0]
    ).not.toContain("required");
  });
});

function fixture(outcome: NonNullable<DashboardRun["outcome"]>): DashboardRun {
  return {
    id: "run",
    goal: "Check the page",
    status: "failed",
    outcome,
    startedAt: null,
    completedAt: null,
    durationMs: 200,
    stepCount: 0,
    passedStepCount: 0,
    issueCount: 0,
    screenshotCount: 0,
    steps: [],
    timeline: [],
    primaryIssue: null,
    screenshots: [],
    errors: [],
    targetUrl: "http://example.test"
  };
}
