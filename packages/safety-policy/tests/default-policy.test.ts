import { describe, expect, it } from "vitest";

import type { BrowserAction, Observation } from "../../schemas/src/index.js";
import { DefaultActionSafetyPolicy } from "../src/index.js";

describe("DefaultActionSafetyPolicy", () => {
  it.each<BrowserAction>([
    { type: "getText", selector: "h1" },
    { type: "getCurrentUrl" },
    { type: "screenshot" },
    { type: "wait", ms: 100 },
    { type: "navigate", url: "http://localhost:3000/dashboard" }
  ])("allows read-only action $type", (action) => {
    const decision = new DefaultActionSafetyPolicy().evaluate(
      action,
      context("Inspect the page")
    );

    expect(decision.decision).toBe("allow");
  });

  it("blocks irreversible account deletion", () => {
    const decision = new DefaultActionSafetyPolicy().evaluate(
      { type: "click", selector: "#delete-account" },
      context("Review account controls", "Delete account permanently")
    );

    expect(decision).toMatchObject({ decision: "block" });
  });

  it.each([
    ["#checkout", "Complete checkout"],
    ["#save-settings", "Save settings"],
    ["#delete-project", "Delete project"]
  ])("requires approval for %s", (selector, label) => {
    const decision = new DefaultActionSafetyPolicy({
      requestIdFactory: () => "approval-fixed"
    }).evaluate({ type: "click", selector }, context("Test the workflow", label));

    expect(decision).toEqual({
      decision: "require_approval",
      reason:
        "The action may change persistent state or trigger an external side effect.",
      requestId: "approval-fixed"
    });
  });

  it("allows login submission for backward-compatible test workflows", () => {
    const decision = new DefaultActionSafetyPolicy().evaluate(
      { type: "click", selector: 'button[type="submit"]' },
      context("Test login functionality", "Sign in")
    );

    expect(decision.decision).toBe("allow");
  });

  it("blocks actions marked forbidden by test policy", () => {
    const decision = new DefaultActionSafetyPolicy({
      forbiddenPatterns: ["production-only"]
    }).evaluate(
      { type: "click", selector: "#production-only-action" },
      context("Test controls")
    );

    expect(decision).toMatchObject({ decision: "block" });
  });
});

function context(goal: string, elementText?: string) {
  return {
    goal,
    observation: createObservation(elementText),
    actionHistory: []
  };
}

function createObservation(elementText?: string): Observation {
  return {
    id: "safety-observation",
    timestamp: "2026-08-14T00:00:00.000Z",
    url: "http://localhost:3000/settings",
    title: "VibeQA Settings",
    metadata: {
      url: "http://localhost:3000/settings",
      title: "VibeQA Settings",
      viewport: { width: 1280, height: 900 }
    },
    consoleErrors: [],
    accessibility: {
      headings: [],
      landmarks: [],
      interactiveElementCount: elementText ? 1 : 0
    },
    elements: elementText
      ? [
          {
            id: "target",
            tagName: "button",
            role: "button",
            accessibleName: elementText,
            text: elementText,
            visible: true,
            enabled: true,
            editable: false,
            selector: selectorForText(elementText)
          }
        ]
      : [],
    textSample: elementText ?? "Settings",
    screenshotPath: null
  };
}

function selectorForText(text: string): string {
  const selectors: Record<string, string> = {
    "Delete account permanently": "#delete-account",
    "Complete checkout": "#checkout",
    "Save settings": "#save-settings",
    "Delete project": "#delete-project",
    "Sign in": 'button[type="submit"]'
  };
  return selectors[text] ?? "#target";
}
