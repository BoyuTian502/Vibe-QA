import type { LLMClient } from "@vibeqa/llm";
import {
  BrowserActionSchema,
  type BrowserAction,
  type Observation
} from "@vibeqa/schemas";

import { Evaluator, type EvaluationResult } from "./evaluator.js";
import { Memory } from "./memory.js";
import type { AgentTrace, AgentTraceStep } from "./trace.js";

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
  private trace: AgentTrace = { goal: "", steps: [] };
  private currentTraceStep: AgentTraceStep | null = null;
  private actionTraceStep: AgentTraceStep | null = null;
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
    this.trace = { goal, steps: [] };
    this.currentTraceStep = null;
    this.actionTraceStep = null;
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
    const traceStep = this.createTraceStep();

    try {
      const observation = await this.browser.observe();
      this.recordObservation(observation, traceStep);
      return observation;
    } catch (error) {
      this.recordTraceError(traceStep, error);
      throw error;
    }
  }

  async think(): Promise<BrowserAction | null> {
    const observation = this.state.currentObservation;
    if (!observation) {
      throw new Error("The agent cannot think before observing the page.");
    }

    const traceStep = this.currentTraceStep ?? this.createTraceStep(observation);
    const prompt = this.createReasoningPrompt(observation);
    traceStep.thought.prompt = prompt;

    try {
      const response = await this.llmClient.generate(prompt);
      traceStep.thought.reasoning = response;
      const action = parseBrowserAction(response);
      traceStep.action = action;
      traceStep.result = { success: true };
      this.pendingAction = action;
      this.actionTraceStep = action ? traceStep : null;
      return action;
    } catch (error) {
      this.recordTraceError(traceStep, error);
      throw error;
    }
  }

  async act(action: BrowserAction | null = this.pendingAction): Promise<void> {
    if (!action) {
      throw new Error("The agent has no browser action to execute.");
    }

    const traceStep = this.actionTraceStep ?? this.currentTraceStep;
    if (traceStep) {
      traceStep.action = action;
      this.actionTraceStep = traceStep;
    }

    try {
      await this.executeAction(action);
      this.state.stepCount += 1;
      this.state.actionHistory.push(action);
      this.memory.addAction(action);
      this.pendingAction = null;
      if (traceStep) {
        traceStep.result = { success: true };
      }
    } catch (error) {
      if (traceStep) {
        this.recordTraceError(traceStep, error);
      }
      throw error;
    }
  }

  async reflect(
    previousAction: BrowserAction,
    newObservation?: Observation
  ): Promise<EvaluationResult> {
    const evaluatedTraceStep = this.actionTraceStep;
    const observation = newObservation ?? (await this.observe());
    if (newObservation) {
      this.recordObservation(newObservation, this.createTraceStep());
    }

    const evaluation = this.evaluator.evaluate(previousAction, observation);
    if (evaluatedTraceStep) {
      evaluatedTraceStep.evaluation = evaluation;
    }
    if (!evaluation.success) {
      this.memory.addBug(evaluation.reason);
    }

    for (const consoleError of observation.consoleErrors) {
      this.memory.addBug(consoleError.text);
    }

    this.actionTraceStep = null;
    return evaluation;
  }

  getMemory(): Memory {
    return this.memory;
  }

  getTrace(): AgentTrace {
    return {
      goal: this.trace.goal,
      steps: this.trace.steps.map((step) => ({
        ...step,
        thought: { ...step.thought },
        result: { ...step.result },
        evaluation: step.evaluation ? { ...step.evaluation } : undefined
      }))
    };
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
    const message = errorMessage(error);
    this.state.errors.push(message);

    const traceStep = this.currentTraceStep;
    if (traceStep && traceStep.result.error !== message) {
      this.recordTraceError(traceStep, error);
    }
  }

  private createTraceStep(observation: Observation | null = null): AgentTraceStep {
    const step: AgentTraceStep = {
      timestamp: new Date().toISOString(),
      observation,
      thought: {},
      action: null,
      result: { success: true }
    };

    this.trace.steps.push(step);
    this.currentTraceStep = step;
    return step;
  }

  private recordObservation(observation: Observation, traceStep: AgentTraceStep): void {
    this.state.currentObservation = observation;
    this.memory.addObservation(observation);
    traceStep.observation = observation;
    traceStep.result = { success: true };
    this.currentTraceStep = traceStep;
  }

  private recordTraceError(traceStep: AgentTraceStep, error: unknown): void {
    traceStep.result = {
      success: false,
      error: errorMessage(error)
    };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown agent error";
}
