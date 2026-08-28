import { AdaptiveExecutionController } from "@vibeqa/adaptive-execution";
import { Agent, type BrowserController } from "@vibeqa/agent-core";
import type { LLMClient } from "@vibeqa/llm";
import type { Observation } from "@vibeqa/schemas";
import { describe, expect, it } from "vitest";

describe("Adaptive execution integration", () => {
  it("preserves one Agent, browser session, memory, trace, and authentication across escalation", async () => {
    const browser = new StatefulBrowser();
    const deterministic = new SequenceClient([
      JSON.stringify({ type: "click", selector: "#first" })
    ]);
    const ollama = new SequenceClient([
      JSON.stringify({ type: "click", selector: "#second" }),
      "null"
    ]);
    const controller = new AdaptiveExecutionController({
      deterministicClient: deterministic,
      ollamaClient: ollama,
      verifyOllamaAvailability: async () => {}
    });
    const agent = new Agent({ browser, llmClient: controller, maxSteps: 4 });

    const state = await agent.run("Inspect the authenticated dashboard");

    expect(state.completed).toBe(true);
    expect(state.actionHistory).toEqual([
      { type: "click", selector: "#first" },
      { type: "click", selector: "#second" }
    ]);
    expect(browser.authenticated).toBe(true);
    expect(browser.calls).toEqual(["#first", "#second"]);
    expect(agent.getMemory().getHistory().actions).toHaveLength(2);
    expect(agent.getTrace().steps.filter((step) => step.action)).toHaveLength(2);
    expect(ollama.prompts[0]).toContain(
      "Continue from the current browser and Agent state"
    );
    expect(ollama.prompts[0]).toContain("Previous actions:");
    expect(controller.getMetadata(state.stepCount)).toMatchObject({
      escalationOccurred: true,
      deterministicSteps: 1,
      ollamaSteps: 1,
      totalSteps: 2
    });
  });

  it("does not count unavailable escalation as Ollama execution", async () => {
    const controller = new AdaptiveExecutionController({
      deterministicClient: new SequenceClient(["null"]),
      ollamaClient: new SequenceClient(["null"]),
      verifyOllamaAvailability: async () => {
        throw new Error("not reachable");
      }
    });
    const agent = new Agent({
      browser: new StatefulBrowser(),
      llmClient: controller,
      maxSteps: 2
    });

    await agent.run("Explore the page");

    expect(controller.getMetadata()).toMatchObject({
      escalationRequired: true,
      escalationOccurred: false,
      escalationSucceeded: false,
      ollamaAvailable: false,
      ollamaInvocationCount: 0
    });
  });

  it("preserves the authenticated browser session during an early handoff", async () => {
    const browser = new StatefulBrowser(highOpportunityObservation());
    const controller = new AdaptiveExecutionController({
      deterministicClient: new SequenceClient([
        JSON.stringify({
          type: "navigate",
          url: "http://site.test/settings"
        })
      ]),
      ollamaClient: new SequenceClient([
        JSON.stringify({ type: "click", selector: "#view-activity" }),
        "null",
        "null"
      ]),
      verifyOllamaAvailability: async () => {},
      maxSteps: 4
    });
    const agent = new Agent({ browser, llmClient: controller, maxSteps: 4 });

    await agent.run("Explore the authenticated dashboard for failures");

    expect(browser.authenticated).toBe(true);
    expect(browser.calls).toContain("#view-activity");
    expect(browser.calls).not.toContain("http://site.test/settings");
    expect(controller.getMetadata()).toMatchObject({
      escalationTiming: "early",
      escalationStep: 0,
      opportunityPreservingEscalation: true
    });
  });
});

class SequenceClient implements LLMClient {
  readonly prompts: string[] = [];
  private index = 0;

  constructor(private readonly responses: readonly string[]) {}

  async generate(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const response = this.responses[this.index] ?? "null";
    this.index += 1;
    return response;
  }
}

class StatefulBrowser implements BrowserController {
  readonly authenticated = true;
  readonly calls: string[] = [];

  constructor(private readonly observed: Observation = observation()) {}

  async observe(): Promise<Observation> {
    return structuredClone(this.observed);
  }
  async goto(): Promise<void> {}
  async navigate(url: string): Promise<void> {
    this.calls.push(url);
  }
  async click(selector: string): Promise<void> {
    this.calls.push(selector);
  }
  async type(): Promise<void> {}
  async getText(): Promise<string> {
    return "Dashboard";
  }
  async wait(): Promise<void> {}
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async assert(): Promise<void> {}
  getCurrentUrl(): string {
    return "http://site.test/dashboard";
  }
}

function observation(): Observation {
  const url = "http://site.test/dashboard";
  return {
    id: "dashboard",
    timestamp: "2026-08-27T00:00:00.000Z",
    url,
    title: "Private dashboard",
    metadata: { url, title: "Private dashboard", viewport: null },
    consoleErrors: [],
    accessibility: { headings: [], landmarks: [], interactiveElementCount: 2 },
    elements: ["first", "second"].map((id) => ({
      id,
      tagName: "button",
      role: "button",
      accessibleName: id,
      text: id,
      visible: true,
      enabled: true,
      editable: false,
      selector: `#${id}`
    })),
    textSample: "Authenticated workspace dashboard",
    screenshotPath: null
  };
}

function highOpportunityObservation(): Observation {
  const value = observation();
  value.accessibility = {
    headings: [
      { level: 1, text: "Workspace" },
      { level: 2, text: "Projects" }
    ],
    landmarks: [
      { role: "navigation", name: "Primary" },
      { role: "main", name: "Dashboard" }
    ],
    interactiveElementCount: 6
  };
  value.elements = [
    link("settings", "Settings", "http://site.test/settings"),
    link("project", "Project", "http://site.test/projects/alpha"),
    button("view-activity", "Activity", "tab"),
    button("refresh", "Refresh insights"),
    button("logout", "Log out"),
    button("help", "Workspace help")
  ];
  return value;
}

function link(
  id: string,
  label: string,
  href: string
): Observation["elements"][number] {
  return {
    id,
    tagName: "a",
    role: "link",
    accessibleName: label,
    text: label,
    visible: true,
    enabled: true,
    editable: false,
    selector: `#${id}`,
    href
  };
}

function button(
  id: string,
  label: string,
  role = "button"
): Observation["elements"][number] {
  return {
    id,
    tagName: "button",
    role,
    accessibleName: label,
    text: label,
    visible: true,
    enabled: true,
    editable: false,
    selector: `#${id}`
  };
}
