import { fileURLToPath } from "node:url";

import { MockLLMClient, type LLMClient } from "@vibeqa/llm";
import { describe, expect, it } from "vitest";

import {
  AIBugAnalyzer,
  BugAnalysisService,
  createBaselineBugAnalysis,
  createBugAnalysisInput
} from "../src/bug-analysis.js";
import { ReportStore } from "../src/report-store.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures", import.meta.url));

const generatedResponse = JSON.stringify({
  summary: "The fragile widget crashes when activated.",
  rootCause:
    "The evidence points to an uncaught exception in the widget interaction handler.",
  suggestedFixes: [
    "Handle the widget error inside its event handler.",
    "Add a regression test for the interaction."
  ],
  severity: "high",
  severityReasoning: "The exception interrupts a user-visible dashboard workflow."
});

describe("AI bug analysis", () => {
  it("builds a sanitized artifact prompt and parses structured model output", async () => {
    const run = await new ReportStore(fixtureRoot).loadRun("demo-run-001");
    run.goal = "Test password=hunter2 without exposing it";
    const firstTimelineEvent = run.timeline[0];
    if (firstTimelineEvent) {
      firstTimelineEvent.observationUrl =
        "http://example.test/dashboard?token=private-value#secret";
    }
    const client = new MockLLMClient(`\`\`\`json\n${generatedResponse}\n\`\`\``);

    const analysis = await new AIBugAnalyzer(client).analyze(
      createBugAnalysisInput(run)
    );

    expect(analysis).toMatchObject({
      summary: "The fragile widget crashes when activated.",
      severity: "high",
      source: "ai",
      notice: null
    });
    expect(analysis.suggestedFixes).toHaveLength(2);
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).toContain('"report"');
    expect(client.prompts[0]).toContain('"trace"');
    expect(client.prompts[0]).toContain('"screenshots"');
    expect(client.prompts[0]).toContain("browser-state.svg");
    expect(client.prompts[0]).toContain("[REDACTED]");
    expect(client.prompts[0]).not.toContain("hunter2");
    expect(client.prompts[0]).not.toContain("private-value");
  });

  it("rejects model responses that do not follow the analysis schema", async () => {
    const run = await new ReportStore(fixtureRoot).loadRun("demo-run-001");
    const analyzer = new AIBugAnalyzer(new MockLLMClient("not json"));

    await expect(analyzer.analyze(createBugAnalysisInput(run))).rejects.toThrow(
      /valid JSON/
    );
  });

  it("creates a useful evidence-based baseline without an external model", async () => {
    const run = await new ReportStore(fixtureRoot).loadRun("demo-run-001");
    const analysis = createBaselineBugAnalysis(createBugAnalysisInput(run));

    expect(analysis).toMatchObject({
      source: "baseline",
      severity: "high",
      notice: null
    });
    expect(analysis.summary).toContain("browser error");
    expect(analysis.rootCause).toContain("uncaught client-side exception");
    expect(analysis.suggestedFixes).toHaveLength(3);
    expect(analysis.severityReasoning).toContain("High severity");
  });

  it("falls back deterministically and caches analysis when the model fails", async () => {
    const run = await new ReportStore(fixtureRoot).loadRun("demo-run-001");
    let calls = 0;
    const failingClient: LLMClient = {
      generate: async () => {
        calls += 1;
        throw new Error("model unavailable");
      }
    };
    const service = new BugAnalysisService(failingClient);

    const first = await service.analyze(run);
    const second = await service.analyze(run);

    expect(first).toBe(second);
    expect(first).toMatchObject({
      source: "baseline",
      notice: expect.stringContaining("AI analysis was unavailable")
    });
    expect(calls).toBe(1);
  });

  it("does not analyze a passing run without a bug report", async () => {
    const run = await new ReportStore(fixtureRoot).loadRun("demo-run-002");
    const client = new MockLLMClient(generatedResponse);

    await expect(new BugAnalysisService(client).analyze(run)).resolves.toBeNull();
    expect(client.prompts).toHaveLength(0);
  });
});
