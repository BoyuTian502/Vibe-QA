import { describe, expect, it } from "vitest";

import type { BrowserController } from "../../agent-core/src/index.js";
import type {
  ActionSafetyPolicy,
  ApprovalDecision
} from "../../safety-policy/src/index.js";
import type {
  BrowserAction,
  ElementInformation,
  Observation
} from "../../schemas/src/index.js";
import {
  ExplorationSession,
  actionKey,
  createExplorationState,
  createPageStateFingerprint,
  generateActionCandidates
} from "../src/index.js";

describe("exploration candidates", () => {
  it("creates scored candidates from links, buttons, and editable inputs", () => {
    const observation = createObservation("http://localhost/start", "Start", [
      element({
        id: "link",
        tagName: "a",
        selector: "#reports",
        text: "Reports",
        href: "http://localhost/reports"
      }),
      element({
        id: "button",
        tagName: "button",
        selector: "#refresh",
        text: "Refresh"
      }),
      element({
        id: "input",
        tagName: "input",
        selector: 'input[name="search"]',
        editable: true,
        inputType: "text"
      })
    ]);
    const state = createExplorationState(observation.url, "Explore the site");
    const fingerprint = createPageStateFingerprint(observation);

    const candidates = generateActionCandidates(observation, fingerprint, state);

    expect(candidates.map((candidate) => candidate.action)).toEqual(
      expect.arrayContaining([
        { type: "navigate", url: "http://localhost/reports" },
        { type: "click", selector: "#refresh" },
        {
          type: "type",
          selector: 'input[name="search"]',
          value: "VibeQA exploration"
        }
      ])
    );
    expect(candidates[0]).toMatchObject({
      action: { type: "navigate", url: "http://localhost/reports" },
      reasons: expect.arrayContaining(["unseen destination"])
    });
  });

  it("ignores disabled and invisible elements", () => {
    const observation = createObservation("http://localhost/start", "Start", [
      element({ id: "disabled", enabled: false, selector: "#disabled" }),
      element({ id: "hidden", visible: false, selector: "#hidden" })
    ]);

    expect(
      generateActionCandidates(
        observation,
        createPageStateFingerprint(observation),
        createExplorationState(observation.url, "Explore")
      )
    ).toEqual([]);
  });

  it("deduplicates equivalent actions", () => {
    const observation = createObservation("http://localhost/start", "Start", [
      element({
        id: "first-link",
        tagName: "a",
        selector: "#first-link",
        href: "http://localhost/reports"
      }),
      element({
        id: "second-link",
        tagName: "a",
        selector: "#second-link",
        href: "http://localhost/reports"
      })
    ]);
    const candidates = generateActionCandidates(
      observation,
      createPageStateFingerprint(observation),
      createExplorationState(observation.url, "Explore")
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.action).toEqual({
      type: "navigate",
      url: "http://localhost/reports"
    });
  });

  it("does not repeat explored or previously failed actions", () => {
    const observation = createObservation("http://localhost/start", "Start", [
      element({ id: "refresh", selector: "#refresh" })
    ]);
    const state = createExplorationState(observation.url, "Explore");
    const fingerprint = createPageStateFingerprint(observation);
    const [candidate] = generateActionCandidates(observation, fingerprint, state);
    expect(candidate).toBeDefined();
    if (!candidate) {
      return;
    }

    state.executedActions.push({
      candidateId: candidate.id,
      elementKey: candidate.elementKey,
      fromStateFingerprint: fingerprint,
      toStateFingerprint: fingerprint,
      action: candidate.action,
      actionKey: actionKey(candidate.action),
      success: true
    });
    expect(generateActionCandidates(observation, fingerprint, state)).toEqual([]);

    state.executedActions.length = 0;
    state.failedActions.push({
      candidateId: candidate.id,
      stateFingerprint: "another-state",
      action: candidate.action,
      actionKey: actionKey(candidate.action),
      error: "Known failure"
    });
    expect(generateActionCandidates(observation, fingerprint, state)).toEqual([]);
  });
});

describe("page-state fingerprinting", () => {
  it("distinguishes different application states on the same URL", () => {
    const first = createObservation("http://localhost/dashboard", "Loading", []);
    const second = createObservation("http://localhost/dashboard", "Ready", []);

    expect(createPageStateFingerprint(first)).not.toBe(
      createPageStateFingerprint(second)
    );
    expect(createPageStateFingerprint(first)).toBe(
      createPageStateFingerprint(structuredClone(first))
    );
  });
});

describe("ExplorationSession", () => {
  it("starts at the requested URL and records the first observed state", async () => {
    const start = createObservation("http://localhost/start", "Start", [], {
      screenshotPath: "evidence/start.png",
      consoleError: "Initial console warning"
    });
    const browser = new StatefulBrowser([start]);
    const explorer = new ExplorationSession({ browser });

    const result = await explorer.run({
      startUrl: start.url,
      goal: "Explore the start page",
      maxSteps: 5
    });

    expect(browser.calls[0]).toEqual({ type: "navigate", url: start.url });
    expect(result.state.visitedUrls).toEqual(["http://localhost/start"]);
    expect(result.state.observedPageStates).toHaveLength(1);
    expect(result.state.uniquePageStateCount).toBe(1);
    expect(result.state.screenshots).toEqual(["evidence/start.png"]);
    expect(result.state.consoleErrorsDiscovered[0]?.error.text).toBe(
      "Initial console warning"
    );
  });

  it("records newly visited URLs", async () => {
    const start = createObservation("http://localhost/start", "Start", [
      element({
        id: "reports",
        tagName: "a",
        selector: "#reports",
        text: "Reports",
        href: "http://localhost/reports"
      })
    ]);
    const reports = createObservation("http://localhost/reports", "Reports", []);
    const browser = new StatefulBrowser([start, reports]);
    const explorer = new ExplorationSession({ browser });

    const result = await explorer.run({
      startUrl: start.url,
      goal: "Explore navigation",
      maxSteps: 5
    });

    expect(result.state.visitedUrls).toEqual([
      "http://localhost/start",
      "http://localhost/reports"
    ]);
    expect(result.state.executedActions[0]?.action).toEqual({
      type: "navigate",
      url: "http://localhost/reports"
    });
  });

  it("tracks two states with one URL as separate coverage nodes", async () => {
    const initial = createObservation("http://localhost/dashboard", "Collapsed", [
      element({ id: "toggle", selector: "#toggle", text: "Expand" })
    ]);
    const expanded = createObservation("http://localhost/dashboard", "Expanded", []);
    const browser = new StatefulBrowser([initial]);
    browser.addClickTransition(initial.url, "#toggle", expanded);
    const explorer = new ExplorationSession({ browser });

    const result = await explorer.run({
      startUrl: initial.url,
      goal: "Explore dashboard states",
      maxSteps: 5
    });

    expect(result.state.visitedUrls).toHaveLength(1);
    expect(result.state.uniquePageStateCount).toBe(2);
    expect(result.state.observedPageStates.map((node) => node.fingerprint)).toEqual(
      expect.arrayContaining([
        createPageStateFingerprint(initial),
        createPageStateFingerprint(expanded)
      ])
    );
  });

  it("terminates when no candidates remain", async () => {
    const page = createObservation("http://localhost/empty", "Empty", []);
    const explorer = new ExplorationSession({
      browser: new StatefulBrowser([page])
    });

    const result = await explorer.run({
      startUrl: page.url,
      goal: "Explore the empty page",
      maxSteps: 10
    });

    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("no_candidates");
    expect(result.state.stepCount).toBe(0);
  });

  it("terminates at maxSteps", async () => {
    const first = createObservation("http://localhost/flow", "First", [
      element({ id: "next", selector: "#next", text: "Next" })
    ]);
    const second = createObservation("http://localhost/flow", "Second", [
      element({ id: "continue", selector: "#continue", text: "Continue" })
    ]);
    const browser = new StatefulBrowser([first]);
    browser.addClickTransition(first.url, "#next", second);
    const explorer = new ExplorationSession({ browser });

    const result = await explorer.run({
      startUrl: first.url,
      goal: "Explore the flow",
      maxSteps: 1
    });

    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("max_steps");
    expect(result.state.stepCount).toBe(1);
    expect(browser.calls).not.toContainEqual({ type: "click", selector: "#continue" });
  });

  it("preserves state while approval is pending and resumes safely", async () => {
    const settings = createObservation("http://localhost/settings", "Settings", [
      element({
        id: "save",
        selector: "#save-settings",
        text: "Save settings"
      })
    ]);
    const saved = createObservation("http://localhost/settings", "Saved", []);
    const browser = new StatefulBrowser([settings]);
    browser.addClickTransition(settings.url, "#save-settings", saved);
    const explorer = new ExplorationSession({
      browser,
      safetyPolicy: new ApprovalPolicy()
    });

    const paused = await explorer.run({
      startUrl: settings.url,
      goal: "Explore workspace settings",
      maxSteps: 5
    });

    expect(paused.status).toBe("paused");
    expect(paused.stopReason).toBe("approval_required");
    expect(paused.state.stepCount).toBe(0);
    expect(paused.state.uniquePageStateCount).toBe(1);
    expect(paused.pendingApproval).toMatchObject({
      requestId: "exploration-approval",
      action: { type: "click", selector: "#save-settings" }
    });
    expect(browser.calls).not.toContainEqual({
      type: "click",
      selector: "#save-settings"
    });

    const resumed = await explorer.resumeApproval("exploration-approval", true);

    expect(browser.calls.filter((call) => call.type === "click")).toEqual([
      { type: "click", selector: "#save-settings" }
    ]);
    expect(resumed.status).toBe("completed");
    expect(resumed.state.stepCount).toBe(1);
    expect(resumed.state.uniquePageStateCount).toBe(2);
    expect(resumed.pendingApproval).toBeNull();
  });
});

class ApprovalPolicy implements ActionSafetyPolicy {
  evaluate(action: BrowserAction): ApprovalDecision {
    if (action.type === "click") {
      return {
        decision: "require_approval",
        reason: "Settings changes require human approval.",
        requestId: "exploration-approval"
      };
    }
    return { decision: "allow", reason: "Navigation is read-only." };
  }
}

class StatefulBrowser implements BrowserController {
  readonly calls: BrowserAction[] = [];
  private readonly pages = new Map<string, Observation>();
  private readonly clickTransitions = new Map<string, Observation>();
  private current: Observation;

  constructor(pages: Observation[]) {
    const first = pages[0];
    if (!first) {
      throw new Error("StatefulBrowser requires at least one page.");
    }
    this.current = first;
    for (const page of pages) {
      this.pages.set(page.url, page);
    }
  }

  addClickTransition(url: string, selector: string, observation: Observation): void {
    this.clickTransitions.set(`${url}:${selector}`, observation);
  }

  async observe(): Promise<Observation> {
    return structuredClone(this.current);
  }

  async goto(url: string): Promise<void> {
    await this.navigate(url);
  }

  async navigate(url: string): Promise<void> {
    this.calls.push({ type: "navigate", url });
    const page = this.pages.get(url);
    if (!page) {
      throw new Error(`No fake page registered for ${url}`);
    }
    this.current = page;
  }

  async click(selector: string): Promise<void> {
    this.calls.push({ type: "click", selector });
    const next = this.clickTransitions.get(`${this.current.url}:${selector}`);
    if (next) {
      this.current = next;
    }
  }

  async type(selector: string, value: string): Promise<void> {
    this.calls.push({ type: "type", selector, value });
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
    return this.current.url;
  }
}

function createObservation(
  url: string,
  textSample: string,
  elements: ElementInformation[],
  options: { screenshotPath?: string; consoleError?: string } = {}
): Observation {
  return {
    id: `observation-${textSample}`,
    timestamp: "2026-08-14T00:00:00.000Z",
    url,
    title: textSample,
    metadata: {
      url,
      title: textSample,
      viewport: { width: 1280, height: 900 }
    },
    consoleErrors: options.consoleError
      ? [{ type: "console", text: options.consoleError, location: null }]
      : [],
    accessibility: {
      headings: [{ level: 1, text: textSample }],
      landmarks: [],
      interactiveElementCount: elements.length
    },
    elements,
    textSample,
    screenshotPath: options.screenshotPath ?? null
  };
}

function element(
  overrides: Partial<ElementInformation> & { id: string }
): ElementInformation {
  return {
    id: overrides.id,
    tagName: overrides.tagName ?? "button",
    role: overrides.role ?? null,
    accessibleName: overrides.accessibleName ?? overrides.text ?? null,
    text: overrides.text ?? "",
    visible: overrides.visible ?? true,
    enabled: overrides.enabled ?? true,
    editable: overrides.editable ?? false,
    selector: overrides.selector ?? `#${overrides.id}`,
    href: overrides.href ?? null,
    inputType: overrides.inputType ?? null
  };
}
