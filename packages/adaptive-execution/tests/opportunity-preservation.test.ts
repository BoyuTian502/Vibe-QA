import type { LLMClient } from "@vibeqa/llm";
import type { BrowserAction, Observation } from "@vibeqa/schemas";
import { describe, expect, it, vi } from "vitest";

import {
  AdaptiveExecutionController,
  DeterministicCompletionEvaluator,
  OpportunityPreservationEvaluator
} from "../src/index.js";

describe("Adaptive V2 opportunity-preserving escalation", () => {
  it("keeps a controlled known workflow deterministic", async () => {
    const ollama = new SequenceClient(["null"]);
    const controller = controllerWith({
      deterministic: [navigate("http://site.test/settings")],
      ollama,
      knownWorkflow: true
    });

    const response = await controller.generate(
      prompt(highOpportunityObservation(), [], "Verify the known settings workflow")
    );

    expect(JSON.parse(response)).toEqual({
      type: "navigate",
      url: "http://site.test/settings"
    });
    expect(ollama.prompts).toHaveLength(0);
    expect(controller.getMetadata()).toMatchObject({
      policyVersion: "v2",
      escalationOccurred: false,
      escalationTiming: "none"
    });
  });

  it("hands a high-value exploratory state to Ollama before the narrowing action", async () => {
    const verify = vi.fn(async () => {});
    const ollama = new SequenceClient([click("#view-activity")]);
    const controller = controllerWith({
      deterministic: [navigate("http://site.test/settings")],
      ollama,
      verify
    });

    const response = await controller.generate(
      prompt(
        highOpportunityObservation(),
        [],
        "Explore the dashboard and discover user-visible failures"
      )
    );

    expect(JSON.parse(response)).toEqual({
      type: "click",
      selector: "#view-activity"
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(controller.getMetadata()).toMatchObject({
      escalationOccurred: true,
      escalationStep: 0,
      escalationTiming: "early",
      opportunityPreservingEscalation: true,
      opportunityRetainedAtHandoff: 1,
      deterministicSteps: 0
    });
    expect(controller.getMetadata().safeCandidatesRemainingAtHandoff).toBeGreaterThan(
      3
    );
  });

  it("derives opportunity only from live visible state", () => {
    const observation = highOpportunityObservation();
    observation.elements.push({
      ...required(observation.elements[0]),
      id: "hidden",
      selector: "#hidden-failure-selector",
      accessibleName: "BUG-BENCH-999 password=do-not-copy",
      text: "evaluator-only",
      visible: false,
      enabled: false
    });

    const result = new OpportunityPreservationEvaluator().evaluate({
      goal: "Explore the dashboard",
      observation,
      actionHistory: [],
      proposedAction: {
        type: "navigate",
        url: "http://site.test/settings"
      }
    });

    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({
      risk: "high",
      highBranchingState: true,
      nextActionNarrowsState: true,
      shouldEscalateBeforeAction: true
    });
    expect(serialized).not.toContain("BUG-BENCH-999");
    expect(serialized).not.toContain("#hidden-failure-selector");
    expect(serialized).not.toContain("do-not-copy");
  });

  it("sanitizes continuation context and excludes evaluator-only data", async () => {
    const observation = highOpportunityObservation();
    observation.textSample = "Dashboard token=secret-token BUG-BENCH-005";
    observation.elements.push({
      ...required(observation.elements[0]),
      id: "hidden",
      selector: "#hidden-evaluator-target",
      accessibleName: "evaluator-recommendation",
      text: "evaluator-recommendation",
      visible: false
    });
    const ollama = new SequenceClient([click("#view-activity")]);
    const controller = controllerWith({
      deterministic: [navigate("http://site.test/settings")],
      ollama
    });
    const prior: BrowserAction[] = [
      { type: "type", selector: "#password", value: "secret-token" }
    ];

    await controller.generate(
      prompt(observation, prior, "Explore the authenticated dashboard")
    );

    const continuation = required(ollama.prompts[0]);
    expect(continuation).toContain("Continue from the current browser and Agent state");
    expect(continuation).toContain("Safe unexplored candidates with exact targets:");
    expect(continuation).toContain("navigate:http://site.test/settings");
    expect(continuation).not.toContain("secret-token");
    expect(continuation).not.toContain("BUG-BENCH-005");
    expect(continuation).not.toContain("#hidden-evaluator-target");
    expect(continuation).not.toContain("evaluator-recommendation");
  });

  it("rejects a premature null and recovers a useful action", async () => {
    const ollama = new SequenceClient(["null", click("#view-activity")]);
    const controller = controllerWith({
      deterministic: [navigate("http://site.test/settings")],
      ollama
    });

    const response = await controller.generate(
      prompt(highOpportunityObservation(), [], "Explore dashboard failures")
    );

    expect(JSON.parse(response)).toEqual({
      type: "click",
      selector: "#view-activity"
    });
    expect(ollama.prompts).toHaveLength(2);
    expect(ollama.prompts[1]).toContain("previous null decision was rejected");
    expect(controller.getMetadata()).toMatchObject({
      nullRetryCount: 1,
      nullRecoveryCount: 1,
      completionGateRejectionCount: 1,
      postHandoffTerminationReason: "none"
    });
    expect(controller.getMetadata().nullDecisionsAfterHandoff).toEqual([
      expect.objectContaining({
        classification: "premature-unresolved-candidates",
        completionConfirmed: false
      })
    ]);
  });

  it("enforces the bounded null retry limit", async () => {
    const ollama = new SequenceClient(["null", "null", click("#view-activity")]);
    const controller = controllerWith({
      deterministic: [navigate("http://site.test/settings")],
      ollama,
      nullRetryLimit: 1
    });

    const response = await controller.generate(
      prompt(highOpportunityObservation(), [], "Explore dashboard failures")
    );

    expect(response).toBe("null");
    expect(ollama.prompts).toHaveLength(2);
    expect(controller.getMetadata()).toMatchObject({
      nullRetryCount: 1,
      nullRecoveryCount: 0,
      completionGateRejectionCount: 2,
      postHandoffTerminationReason: "null-retry-exhausted"
    });
  });

  it("accepts null immediately when deterministic completion is confirmed", async () => {
    const settings = lowOpportunityObservation(
      "http://site.test/settings",
      "Workspace settings Account settings inspected"
    );
    const ollama = new SequenceClient(["null", click("#only")]);
    const controller = controllerWith({
      deterministic: ["null"],
      ollama
    });

    const response = await controller.generate(
      prompt(settings, [], "Verify that account settings can be reached and inspected")
    );

    expect(response).toBe("null");
    expect(ollama.prompts).toHaveLength(1);
    expect(controller.getMetadata()).toMatchObject({
      completionConfirmed: true,
      completionGateRejectionCount: 0,
      postHandoffTerminationReason: "goal-complete"
    });
  });

  it("does not equate planner null with semantic completion", () => {
    const result = new DeterministicCompletionEvaluator().evaluate({
      goal: "Explore the dashboard and discover failures",
      observation: highOpportunityObservation(),
      actionHistory: [],
      discoveredBugs: []
    });

    expect(result).toEqual({
      confirmed: false,
      reason: "The discovery objective has no runtime-visible failure evidence yet.",
      evidence: []
    });
  });

  it("rejects unrelated failure evidence and accepts goal-relevant evidence", () => {
    const observation = highOpportunityObservation();
    observation.consoleErrors = [
      {
        type: "pageerror",
        text: "dashboard widget crashed",
        location: null
      }
    ];
    const evaluator = new DeterministicCompletionEvaluator();

    expect(
      evaluator.evaluate({
        goal: "Check the authenticated account for broken session access behavior",
        observation,
        actionHistory: [],
        discoveredBugs: []
      }).confirmed
    ).toBe(false);
    expect(
      evaluator.evaluate({
        goal: "Explore the dashboard and discover user-visible failures",
        observation,
        actionHistory: [],
        discoveredBugs: []
      })
    ).toMatchObject({
      confirmed: true,
      evidence: ["goal-relevant-console-error"]
    });
  });

  it("keeps Adaptive V1 behavior available through the existing controller API", async () => {
    const ollama = new SequenceClient(["null", click("#view-activity")]);
    const controller = controllerWith({
      deterministic: [navigate("http://site.test/settings")],
      ollama,
      opportunityPreservationEnabled: false
    });

    const response = await controller.generate(
      prompt(highOpportunityObservation(), [], "Explore dashboard failures")
    );

    expect(JSON.parse(response)).toEqual({
      type: "navigate",
      url: "http://site.test/settings"
    });
    expect(ollama.prompts).toHaveLength(0);
    expect(controller.getMetadata()).toMatchObject({
      policyVersion: "v1",
      escalationOccurred: false
    });

    const repeated = highOpportunityObservation();
    await controller.generate(
      prompt(
        repeated,
        [{ type: "navigate", url: "http://site.test/settings" }],
        "Explore dashboard failures"
      )
    );
    expect(ollama.prompts).toHaveLength(1);
  });
});

function controllerWith(input: {
  deterministic: readonly string[];
  ollama: SequenceClient;
  knownWorkflow?: boolean;
  opportunityPreservationEnabled?: boolean;
  nullRetryLimit?: number;
  verify?: () => Promise<void>;
}): AdaptiveExecutionController {
  return new AdaptiveExecutionController({
    deterministicClient: new SequenceClient(input.deterministic),
    ollamaClient: input.ollama,
    verifyOllamaAvailability: input.verify ?? (async () => {}),
    maxSteps: 10,
    knownWorkflow: input.knownWorkflow,
    opportunityPreservationEnabled: input.opportunityPreservationEnabled,
    nullRetryLimit: input.nullRetryLimit
  });
}

class SequenceClient implements LLMClient {
  readonly prompts: string[] = [];
  private index = 0;

  constructor(private readonly responses: readonly string[]) {}

  async generate(promptValue: string): Promise<string> {
    this.prompts.push(promptValue);
    const response = this.responses[this.index] ?? "null";
    this.index += 1;
    return response;
  }
}

function highOpportunityObservation(): Observation {
  const url = "http://site.test/dashboard";
  const elements: Observation["elements"] = [
    link("settings", "Settings", "http://site.test/settings"),
    link("project", "Launch project", "http://site.test/projects/alpha"),
    button("view-activity", "Activity", "tab"),
    button("refresh", "Refresh insights"),
    button("logout", "Log out"),
    button("help", "Workspace help")
  ];
  return {
    id: "dashboard-state",
    timestamp: "2026-08-28T00:00:00.000Z",
    url,
    title: "Private dashboard",
    metadata: { url, title: "Private dashboard", viewport: null },
    consoleErrors: [],
    accessibility: {
      headings: [
        { level: 1, text: "Workspace overview" },
        { level: 2, text: "Projects" }
      ],
      landmarks: [
        { role: "navigation", name: "Primary" },
        { role: "main", name: "Dashboard" }
      ],
      interactiveElementCount: elements.length
    },
    elements,
    textSample: "Private dashboard Workspace overview Projects Activity",
    screenshotPath: null
  };
}

function lowOpportunityObservation(url: string, text: string): Observation {
  return {
    ...highOpportunityObservation(),
    id: "low-opportunity",
    url,
    title: text,
    metadata: { url, title: text, viewport: null },
    accessibility: { headings: [], landmarks: [], interactiveElementCount: 1 },
    elements: [button("only", "Continue")],
    textSample: text
  };
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

function prompt(
  observation: Observation,
  actions: readonly BrowserAction[],
  goal: string
): string {
  return [
    "You are VibeQA.",
    `Goal: ${goal}`,
    `Current observation: ${JSON.stringify(observation)}`,
    `Previous actions: ${JSON.stringify(actions)}`,
    "Discovered bugs: []"
  ].join("\n");
}

function navigate(url: string): string {
  return JSON.stringify({ type: "navigate", url });
}

function click(selector: string): string {
  return JSON.stringify({ type: "click", selector });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected fixture value.");
  return value;
}
