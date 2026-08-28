import type { LLMClient } from "@vibeqa/llm";
import type { BrowserAction, Observation } from "@vibeqa/schemas";
import { describe, expect, it, vi } from "vitest";

import {
  AdaptiveExecutionController,
  DeterministicProgressEvaluator,
  ProgressiveEscalationStrategy,
  classifyEscalationUtility
} from "../src/index.js";

describe("progressive escalation", () => {
  it("starts with deterministic planning while progress continues", async () => {
    const deterministic = new SequenceClient([
      action({ type: "click", selector: "#next" }),
      "null"
    ]);
    const ollama = new SequenceClient(["null"]);
    const controller = new AdaptiveExecutionController({
      deterministicClient: deterministic,
      ollamaClient: ollama,
      escalateWhenDeterministicExhausted: false
    });

    await controller.generate(prompt(observation("one"), []));
    await controller.generate(
      prompt(observation("two", "http://site.test/next"), [
        { type: "click", selector: "#next" }
      ])
    );

    expect(deterministic.prompts).toHaveLength(2);
    expect(ollama.prompts).toHaveLength(0);
    expect(controller.getMetadata(1)).toMatchObject({
      startingPlanner: "deterministic",
      escalationOccurred: false,
      deterministicSteps: 1
    });
  });

  it("escalates after a repeated state without restarting prompt context", async () => {
    const verify = vi.fn(async () => {});
    const controller = new AdaptiveExecutionController({
      deterministicClient: new SequenceClient([
        action({ type: "click", selector: "#next" })
      ]),
      ollamaClient: new SequenceClient(["null"]),
      verifyOllamaAvailability: verify
    });
    const current = observation("same");
    await controller.generate(prompt(current, []));
    const resumedPrompt = prompt(current, [{ type: "click", selector: "#next" }]);
    await controller.generate(resumedPrompt);

    expect(verify).toHaveBeenCalledOnce();
    expect(controller.getMetadata(1)).toMatchObject({
      escalationOccurred: true,
      escalationStep: 1,
      plannerAfter: "ollama",
      escalationSignals: expect.arrayContaining(["repeated-state"])
    });
  });

  it("uses the no-progress window independently of repeated-state sensitivity", () => {
    const strategy = new ProgressiveEscalationStrategy({
      repeatedStateThreshold: 99,
      noProgressThreshold: 3
    });
    const decision = strategy.evaluate(
      progressInput({ noProgressCount: 3, repeatedStateCount: 1 }),
      0
    );
    expect(decision.signals).toContain("no-progress");
  });

  it("does not escalate a repeated page after meaningful form progress", () => {
    const strategy = new ProgressiveEscalationStrategy();
    const decision = strategy.evaluate(
      progressInput({ progressed: true, repeatedStateCount: 2 }),
      0
    );

    expect(decision.escalate).toBe(false);
    expect(decision.signals).not.toContain("repeated-state");
  });

  it("uses repeated failed actions and evaluator failures as runtime signals", () => {
    const strategy = new ProgressiveEscalationStrategy();
    expect(
      strategy.evaluate(progressInput({ failedActionCount: 2 }), 0).signals
    ).toContain("repeated-failed-actions");
    expect(
      strategy.evaluate(progressInput({ evaluationFailureCount: 2 }), 0).signals
    ).toContain("evaluation-failure");
  });

  it("respects maxEscalations", () => {
    const strategy = new ProgressiveEscalationStrategy({ maxEscalations: 1 });
    expect(
      strategy.evaluate(progressInput({ repeatedStateCount: 3 }), 1).escalate
    ).toBe(false);
  });

  it("records degraded execution when Ollama is unavailable", async () => {
    const controller = new AdaptiveExecutionController({
      deterministicClient: new SequenceClient(["null"]),
      ollamaClient: new SequenceClient(["null"]),
      verifyOllamaAvailability: async () => {
        throw new Error("Ollama planner unavailable at http://127.0.0.1:11434");
      }
    });
    await controller.generate(prompt(observation("start"), []));

    expect(controller.getMetadata()).toMatchObject({
      escalationRequired: true,
      escalationOccurred: false,
      escalationSucceeded: false,
      ollamaAvailable: false,
      degradedExecution: true,
      ollamaInvocationCount: 0
    });
  });

  it("does not escalate after observable bug evidence is captured", async () => {
    const controller = new AdaptiveExecutionController({
      deterministicClient: new SequenceClient(["null"]),
      ollamaClient: new SequenceClient(["null"]),
      verifyOllamaAvailability: async () => {}
    });
    const value = observation("failure captured");
    value.consoleErrors.push({
      type: "pageerror",
      text: "widget failed",
      location: null
    });

    await controller.generate(prompt(value, [{ type: "click", selector: "#next" }]));

    expect(controller.getMetadata(1).escalationOccurred).toBe(false);
  });

  it("does not allow bug IDs, evaluator metadata, or credentials to trigger escalation", () => {
    const evaluator = new DeterministicProgressEvaluator();
    const first = evaluator.evaluate({
      observation: observation("BUG-BENCH-005 password123 hidden-selector"),
      actionHistory: []
    });
    const strategy = new ProgressiveEscalationStrategy();
    const decision = strategy.evaluate({ ...first, deterministicSteps: 0 }, 0);

    expect(decision.escalate).toBe(false);
    expect(JSON.stringify(decision)).not.toContain("password123");
    expect(JSON.stringify(decision)).not.toContain("BUG-BENCH-005");
  });

  it("classifies useful, unnecessary, failed, and avoided escalations", () => {
    expect(
      classifyEscalationUtility({ escalationOccurred: true, finalOutcome: true })
    ).toBe("USEFUL_ESCALATION");
    expect(
      classifyEscalationUtility({
        escalationOccurred: true,
        finalOutcome: true,
        deterministicLikelyCouldComplete: true
      })
    ).toBe("UNNECESSARY_ESCALATION");
    expect(
      classifyEscalationUtility({ escalationOccurred: true, finalOutcome: false })
    ).toBe("FAILED_ESCALATION");
    expect(
      classifyEscalationUtility({ escalationOccurred: false, finalOutcome: true })
    ).toBe("NO_ESCALATION_NEEDED");
  });
});

class SequenceClient implements LLMClient {
  readonly prompts: string[] = [];
  private index = 0;

  constructor(private readonly responses: readonly string[]) {}

  async generate(value: string): Promise<string> {
    this.prompts.push(value);
    const response = this.responses[this.index] ?? "null";
    this.index += 1;
    return response;
  }
}

function progressInput(
  overrides: Partial<Parameters<ProgressiveEscalationStrategy["evaluate"]>[0]>
): Parameters<ProgressiveEscalationStrategy["evaluate"]>[0] {
  return {
    progressed: false,
    reasons: [],
    repeatedStateCount: 0,
    noProgressCount: 0,
    failedActionCount: 0,
    evaluationFailureCount: 0,
    deterministicSteps: 0,
    ...overrides
  };
}

function action(value: BrowserAction): string {
  return JSON.stringify(value);
}

function prompt(value: Observation, actions: readonly BrowserAction[]): string {
  return [
    "You are VibeQA.",
    "Goal: Explore safely",
    `Current observation: ${JSON.stringify(value)}`,
    `Previous actions: ${JSON.stringify(actions)}`,
    "Discovered bugs: []"
  ].join("\n");
}

function observation(text: string, url = "http://site.test/dashboard"): Observation {
  return {
    id: `observation-${text}`,
    timestamp: "2026-08-27T00:00:00.000Z",
    url,
    title: "Dashboard",
    metadata: { url, title: "Dashboard", viewport: { width: 1280, height: 720 } },
    consoleErrors: [],
    accessibility: { headings: [], landmarks: [], interactiveElementCount: 1 },
    elements: [
      {
        id: "next",
        tagName: "button",
        role: "button",
        accessibleName: "Next",
        text: "Next",
        visible: true,
        enabled: true,
        editable: false,
        selector: "#next"
      }
    ],
    textSample: text,
    screenshotPath: null
  };
}
