import type { LLMClient } from "@vibeqa/llm";
import {
  BrowserActionSchema,
  type BrowserAction,
  type Observation
} from "@vibeqa/schemas";

import { Evaluator, type EvaluationResult } from "./evaluator.js";
import { Memory } from "./memory.js";

export interface AgentState {
  goal: string;
  stepCount: number;
  currentObservation: Observation | null;
  actionHistory: BrowserAction[];
  completed: boolean;
  errors: string[];
}

export interface BrowserController {
  observe(): Promise<Observation>;
  goto(url: string): Promise<void>;
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, value: string): Promise<void>;
  getText(selector: string): Promise<string>;
  wait(ms: number): Promise<void>;
  screenshot(options?: { path?: string }): Promise<Uint8Array | string>;
  assert(selector: string, containsText: string): Promise<void>;
  getCurrentUrl(): string;
}

export interface AgentOptions {
  browser: BrowserController;
  llmClient: LLMClient;
  maxSteps?: number;
  memory?: Memory;
  evaluator?: Evaluator;
}

export class Agent {
  private readonly browser: BrowserController;
  private readonly llmClient: LLMClient;
  private readonly maxSteps: number;
  private readonly memory: Memory;
  private readonly evaluator: Evaluator;
  private pendingAction: BrowserAction | null = null;
  private halted = false;

  state: AgentState = createAgentState("");

  constructor(options: AgentOptions) {
    this.browser = options.browser;
    this.llmClient = options.llmClient;
    this.maxSteps = options.maxSteps ?? 20;
    this.memory = options.memory ?? new Memory();
    this.evaluator = options.evaluator ?? new Evaluator();
  }

  async run(goal: string): Promise<AgentState> {
    if (goal.trim().length === 0) {
      throw new Error("Agent goal must not be empty.");
    }

    this.state = createAgentState(goal);
    this.memory.clear();
    this.pendingAction = null;
    this.halted = false;

    try {
      await this.observe();
      return await this.loop();
    } catch (error) {
      this.recordError(error);
      this.halted = true;
      return this.state;
    }
  }

  async loop(): Promise<AgentState> {
    while (
      !this.state.completed &&
      !this.halted &&
      this.state.stepCount < this.maxSteps
    ) {
      try {
        const action = await this.think();

        if (!action) {
          this.state.completed = true;
          break;
        }

        await this.act(action);
        const evaluation = await this.reflect(action);
        if (!evaluation.shouldContinue) {
          this.state.errors.push(evaluation.reason);
          this.halted = true;
        }
      } catch (error) {
        this.recordError(error);
        this.halted = true;
      }
    }

    return this.state;
  }

  async observe(): Promise<Observation> {
    const observation = await this.browser.observe();
    this.state.currentObservation = observation;
    this.memory.addObservation(observation);
    return observation;
  }

  async think(): Promise<BrowserAction | null> {
    const observation = this.state.currentObservation;
    if (!observation) {
      throw new Error("The agent cannot think before observing the page.");
    }

    const response = await this.llmClient.generate(
      this.createReasoningPrompt(observation)
    );
    const action = parseBrowserAction(response);
    this.pendingAction = action;
    return action;
  }

  async act(action: BrowserAction | null = this.pendingAction): Promise<void> {
    if (!action) {
      throw new Error("The agent has no browser action to execute.");
    }

    await this.executeAction(action);
    this.state.stepCount += 1;
    this.state.actionHistory.push(action);
    this.memory.addAction(action);
    this.pendingAction = null;
  }

  async reflect(
    previousAction: BrowserAction,
    newObservation?: Observation
  ): Promise<EvaluationResult> {
    const observation = newObservation ?? (await this.observe());
    if (newObservation) {
      this.state.currentObservation = newObservation;
      this.memory.addObservation(newObservation);
    }

    const evaluation = this.evaluator.evaluate(previousAction, observation);
    if (!evaluation.success) {
      this.memory.addBug(evaluation.reason);
    }

    for (const consoleError of observation.consoleErrors) {
      this.memory.addBug(consoleError.text);
    }

    return evaluation;
  }

  getMemory(): Memory {
    return this.memory;
  }

  private createReasoningPrompt(observation: Observation): string {
    const history = this.memory.getHistory();

    return [
      "You are VibeQA, an autonomous website testing agent.",
      "Choose exactly one next browser action that advances the goal.",
      "Return only valid BrowserAction JSON, or null when the goal is complete.",
      "Supported types: goto, navigate, click, type, getText, wait, screenshot, assert, getCurrentUrl.",
      `Goal: ${this.state.goal}`,
      `Step: ${this.state.stepCount}`,
      `Current observation: ${JSON.stringify(observation)}`,
      `Previous actions: ${JSON.stringify(history.actions)}`,
      `Discovered bugs: ${JSON.stringify(history.discoveredBugs)}`
    ].join("\n");
  }

  private async executeAction(action: BrowserAction): Promise<void> {
    switch (action.type) {
      case "goto":
        await this.browser.goto(action.url);
        return;
      case "navigate":
        await this.browser.navigate(action.url);
        return;
      case "click":
        await this.browser.click(action.selector);
        return;
      case "type":
        await this.browser.type(action.selector, action.value);
        return;
      case "getText":
        await this.browser.getText(action.selector);
        return;
      case "wait":
        await this.browser.wait(action.ms);
        return;
      case "screenshot":
        await this.browser.screenshot({ path: action.path });
        return;
      case "assert":
        await this.browser.assert(action.selector, action.containsText);
        return;
      case "getCurrentUrl":
        this.browser.getCurrentUrl();
        return;
    }
  }

  private recordError(error: unknown): void {
    this.state.errors.push(
      error instanceof Error ? error.message : "Unknown agent error"
    );
  }
}

function createAgentState(goal: string): AgentState {
  return {
    goal,
    stepCount: 0,
    currentObservation: null,
    actionHistory: [],
    completed: false,
    errors: []
  };
}

function parseBrowserAction(response: string): BrowserAction | null {
  const trimmedResponse = response.trim();
  if (trimmedResponse === "null") {
    return null;
  }

  const parsed = JSON.parse(stripJsonCodeFence(trimmedResponse)) as unknown;
  return BrowserActionSchema.parse(parsed);
}

function stripJsonCodeFence(response: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(response);
  return match?.[1] ?? response;
}
