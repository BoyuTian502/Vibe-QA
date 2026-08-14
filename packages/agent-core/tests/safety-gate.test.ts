import { describe, expect, it } from "vitest";

import type { LLMClient } from "../../llm/src/index.js";
import type {
  ActionSafetyPolicy,
  ApprovalDecision
} from "../../safety-policy/src/index.js";
import type { BrowserAction, Observation } from "../../schemas/src/index.js";
import { Agent, type BrowserController } from "../src/index.js";

class ScriptedClient implements LLMClient {
  constructor(private readonly responses: string[]) {}

  async generate(): Promise<string> {
    return this.responses.shift() ?? "null";
  }
}

class RecordingBrowser implements BrowserController {
  readonly calls: BrowserAction[] = [];
  observeCount = 0;
  private typedValue = "";

  async observe(): Promise<Observation> {
    this.observeCount += 1;
    return createObservation(this.typedValue);
  }

  async goto(url: string): Promise<void> {
    this.calls.push({ type: "goto", url });
  }

  async navigate(url: string): Promise<void> {
    this.calls.push({ type: "navigate", url });
  }

  async click(selector: string): Promise<void> {
    this.calls.push({ type: "click", selector });
  }

  async type(selector: string, value: string): Promise<void> {
    this.calls.push({ type: "type", selector, value });
    this.typedValue = value;
  }

  async getText(selector: string): Promise<string> {
    this.calls.push({ type: "getText", selector });
    return "";
  }

  async wait(ms: number): Promise<void> {
    this.calls.push({ type: "wait", ms });
  }

  async screenshot(options: { path?: string } = {}): Promise<Uint8Array | string> {
    this.calls.push({ type: "screenshot", path: options.path });
    return options.path ?? new Uint8Array();
  }

  async assert(selector: string, containsText: string): Promise<void> {
    this.calls.push({ type: "assert", selector, containsText });
  }

  getCurrentUrl(): string {
    this.calls.push({ type: "getCurrentUrl" });
    return "http://localhost:3000/settings";
  }
}

class FixedPolicy implements ActionSafetyPolicy {
  constructor(private readonly decision: ApprovalDecision) {}

  evaluate(): ApprovalDecision {
    return this.decision;
  }
}

describe("Agent safety gate", () => {
  it("executes safe actions immediately", async () => {
    const browser = new RecordingBrowser();
    const agent = createAgent(
      browser,
      [{ type: "screenshot" }],
      decision({ decision: "allow", reason: "Read-only action." })
    );

    const state = await agent.run("Capture the page");

    expect(browser.calls).toEqual([{ type: "screenshot", path: undefined }]);
    expect(state.completed).toBe(true);
    expect(agent.getTrace().steps[0]?.safetyDecision).toBe("allow");
  });

  it("never executes blocked actions", async () => {
    const browser = new RecordingBrowser();
    const agent = createAgent(
      browser,
      [{ type: "click", selector: "#delete-account" }],
      decision({ decision: "block", reason: "Account deletion is forbidden." })
    );

    const state = await agent.run("Delete the account");

    expect(browser.calls).toEqual([]);
    expect(state.stepCount).toBe(0);
    expect(state.errors[0]).toContain("Account deletion is forbidden");
    expect(agent.getTrace().steps[0]).toMatchObject({
      safetyDecision: "block",
      safetyReason: "Account deletion is forbidden.",
      result: { success: false }
    });
  });

  it("pauses risky actions and preserves the current run", async () => {
    const browser = new RecordingBrowser();
    const agent = createAgent(
      browser,
      [{ type: "screenshot" }, { type: "click", selector: "#save-settings" }],
      new SequencePolicy([
        { decision: "allow", reason: "Read-only action." },
        {
          decision: "require_approval",
          reason: "Settings persist.",
          requestId: "approval-settings"
        }
      ])
    );

    const state = await agent.run("Update account settings");
    const pending = agent.getPendingApproval();

    expect(browser.calls).toEqual([{ type: "screenshot", path: undefined }]);
    expect(state.stepCount).toBe(1);
    expect(state.completed).toBe(false);
    expect(pending).toMatchObject({
      requestId: "approval-settings",
      action: { type: "click", selector: "#save-settings" },
      goal: "Update account settings",
      stepCount: 1,
      actionHistory: [{ type: "screenshot" }]
    });
    expect(pending?.observation).not.toBeNull();
    expect(agent.getMemory().getHistory()).toMatchObject({
      observations: expect.any(Array),
      actions: [{ type: "screenshot" }]
    });
    expect(agent.getTrace().steps[1]).toMatchObject({
      safetyDecision: "require_approval",
      approvalRequestId: "approval-settings",
      approvalStatus: "pending"
    });
  });

  it("executes an approved pending action exactly once and resumes", async () => {
    const browser = new RecordingBrowser();
    const agent = createApprovalAgent(browser);

    await agent.run("Save settings");
    const state = await agent.resumeApproval("approval-save", true);

    expect(browser.calls).toEqual([{ type: "click", selector: "#save-settings" }]);
    expect(state.stepCount).toBe(1);
    expect(state.completed).toBe(true);
    expect(agent.getPendingApproval()).toBeNull();
    expect(agent.getTrace().steps[0]).toMatchObject({
      safetyDecision: "require_approval",
      approvalRequestId: "approval-save",
      approvalStatus: "approved",
      result: { success: true }
    });
  });

  it("never executes a denied pending action", async () => {
    const browser = new RecordingBrowser();
    const agent = createApprovalAgent(browser);

    await agent.run("Save settings");
    const state = await agent.resumeApproval("approval-save", false);

    expect(browser.calls).toEqual([]);
    expect(state.stepCount).toBe(0);
    expect(state.errors).toContain("Action denied by human approval.");
    expect(agent.getTrace().steps[0]).toMatchObject({
      approvalStatus: "denied",
      result: { success: false, error: "Action denied by human approval." }
    });
  });

  it("rejects a wrong approval request ID without losing pending state", async () => {
    const browser = new RecordingBrowser();
    const agent = createApprovalAgent(browser);
    await agent.run("Save settings");

    await expect(agent.resumeApproval("approval-wrong", true)).rejects.toThrow(
      "Unknown approval request ID"
    );

    expect(browser.calls).toEqual([]);
    expect(agent.getPendingApproval()?.requestId).toBe("approval-save");
  });

  it("redacts sensitive typed values from the trace", async () => {
    const browser = new RecordingBrowser();
    const secret = "do-not-store-this";
    const agent = createAgent(
      browser,
      [{ type: "type", selector: 'input[name="password"]', value: secret }],
      decision({ decision: "allow", reason: "Typing does not submit." })
    );

    await agent.run("Enter credentials");

    expect(browser.calls[0]).toEqual({
      type: "type",
      selector: 'input[name="password"]',
      value: secret
    });
    const serializedTrace = JSON.stringify(agent.getTrace());
    expect(serializedTrace).not.toContain(secret);
    expect(serializedTrace).toContain("[REDACTED]");
  });
});

class SequencePolicy implements ActionSafetyPolicy {
  constructor(private readonly decisions: ApprovalDecision[]) {}

  evaluate(): ApprovalDecision {
    const next = this.decisions.shift();
    if (!next) {
      throw new Error("No safety decision was scripted.");
    }
    return next;
  }
}

function createApprovalAgent(browser: RecordingBrowser): Agent {
  return createAgent(
    browser,
    [{ type: "click", selector: "#save-settings" }],
    decision({
      decision: "require_approval",
      reason: "Settings persist.",
      requestId: "approval-save"
    })
  );
}

function createAgent(
  browser: RecordingBrowser,
  actions: BrowserAction[],
  safetyPolicy: ActionSafetyPolicy
): Agent {
  return new Agent({
    browser,
    llmClient: new ScriptedClient([
      ...actions.map((action) => JSON.stringify(action)),
      "null"
    ]),
    safetyPolicy,
    maxSteps: 5
  });
}

function decision(value: ApprovalDecision): ActionSafetyPolicy {
  return new FixedPolicy(value);
}

function createObservation(textSample = "Settings"): Observation {
  const url = "http://localhost:3000/settings";
  return {
    id: "agent-safety-observation",
    timestamp: "2026-08-14T00:00:00.000Z",
    url,
    title: "Settings",
    metadata: {
      url,
      title: "Settings",
      viewport: { width: 1280, height: 900 }
    },
    consoleErrors: [],
    accessibility: {
      headings: [],
      landmarks: [],
      interactiveElementCount: 0
    },
    elements: [],
    textSample,
    screenshotPath: null
  };
}
