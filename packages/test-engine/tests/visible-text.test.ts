import type { AgentTraceStep } from "@vibeqa/agent-core";
import type { Observation } from "@vibeqa/schemas";
import { describe, expect, it } from "vitest";

import { TestEvaluator } from "../src/test-evaluator.js";

describe("expected visible page text", () => {
  it.each([
    ["exact match", "PRIVATE DASHBOARD", "PRIVATE DASHBOARD", true],
    ["surrounding whitespace", "  Dashboard  ", " Dashboard ", true],
    ["repeated spaces", "Welcome   to    Dashboard", "Welcome to Dashboard", true],
    ["observed line breaks", "Welcome\r\nto\nDashboard", "Welcome to Dashboard", true],
    ["tabs and spaces", "Welcome\t to Dashboard", "Welcome  to\tDashboard", true],
    ["Unicode spaces", "Welcome\u00a0to\u3000Dashboard", "Welcome to Dashboard", true],
    [
      "Chinese",
      "\u4ea7\u54c1\u4e2d\u5fc3\nRCenter   Web",
      "\u4ea7\u54c1\u4e2d\u5fc3\nRCenter Web",
      true
    ],
    [
      "independent lines",
      "Footer then other text then Header",
      "Header\r\n\nFooter",
      true
    ],
    ["duplicate lines", "Dashboard", "Dashboard\nDashboard", true],
    ["Unicode line separators", "One other Two", "One\u2028Two\u2029", true],
    ["missing line", "Header only", "Header\nFooter", false],
    ["missing phrase", "Welcome to Dashboard", "Account settings", false],
    ["case sensitivity", "Dashboard", "dashboard", false],
    ["punctuation preserved", "Hello, world", "Hello world", false],
    ["no fuzzy matching", "Account settings", "Account updated settings", false],
    ["empty segments", "Dashboard", " \r\n\t ", false]
  ])("handles %s", (_name, observed, expected, passed) => {
    const observation = createObservation(observed as string);
    const result = evaluate(observation, expected as string);
    expect(result.success).toBe(passed);
    expect(result.bugReports.map((bug) => bug.category)).toEqual(
      passed ? [] : ["content"]
    );
  });

  it("uses the full snapshot when supplied, including an empty snapshot", () => {
    const sample = createObservation("Dashboard");
    expect(evaluate(sample, "Footer", "Dashboard\nFooter").success).toBe(true);
    expect(evaluate(sample, "Dashboard", "").success).toBe(false);
  });
});

function evaluate(observation: Observation, requiredText: string, fullText?: string) {
  const action = { type: "getText", selector: "body" } as const;
  const trace: AgentTraceStep = {
    timestamp: observation.timestamp,
    observation,
    thought: {},
    action,
    result: { success: true }
  };
  return new TestEvaluator().evaluate(
    { name: "Check visible text", action, expected: { requiredText } },
    0,
    trace,
    observation,
    observation,
    fullText
  );
}

function createObservation(textSample: string): Observation {
  return {
    id: "text-observation",
    timestamp: "2026-08-31T00:00:00.000Z",
    url: "http://localhost/",
    title: "Text fixture",
    metadata: { url: "http://localhost/", title: "Text fixture", viewport: null },
    consoleErrors: [],
    accessibility: { headings: [], landmarks: [], interactiveElementCount: 0 },
    elements: [],
    textSample,
    screenshotPath: null
  };
}
