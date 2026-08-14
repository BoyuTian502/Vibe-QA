import type { LLMClient } from "@vibeqa/llm";
import {
  DefaultActionSafetyPolicy,
  type ActionSafetyPolicy,
  type ApprovalDecision
} from "@vibeqa/safety-policy";
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
  safetyPolicy?: ActionSafetyPolicy;
}

export interface PendingApproval {
  requestId: string;
  action: BrowserAction;
  reason: string;
  goal: string;
  observation: Observation | null;
  stepCount: number;
  actionHistory: BrowserAction[];
}

interface PendingApprovalState extends PendingApproval {
  traceStep: AgentTraceStep;
}

export class Agent {
  private readonly browser: BrowserController;
  private readonly llmClient: LLMClient;
  private readonly maxSteps: number;
  private readonly memory: Memory;
  private readonly evaluator: Evaluator;
  private readonly safetyPolicy: ActionSafetyPolicy;
  private pendingAction: BrowserAction | null = null;
  private pendingApproval: PendingApprovalState | null = null;
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
    this.safetyPolicy = options.safetyPolicy ?? new DefaultActionSafetyPolicy();
  }

  async run(goal: string): Promise<AgentState> {
    if (goal.trim().length === 0) {
      throw new Error("Agent goal must not be empty.");
    }

    this.state = createAgentState(goal);
    this.memory.clear();
    this.pendingAction = null;
    this.pendingApproval = null;
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
      !this.pendingApproval &&
      this.state.stepCount < this.maxSteps
    ) {
      try {
        const action = await this.think();

        if (!action) {
          this.state.completed = true;
          break;
        }

        await this.act(action);
        if (this.pendingApproval || this.halted) {
          break;
        }

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
    const priorSensitiveValues = sensitiveValues(this.state.actionHistory);
    traceStep.thought.prompt = redactTraceText(prompt, priorSensitiveValues);

    try {
      const response = await this.llmClient.generate(prompt);
      const action = parseBrowserAction(response);
      const traceSensitiveValues = action
        ? [...priorSensitiveValues, ...sensitiveValues([action])]
        : priorSensitiveValues;
      traceStep.thought.prompt = redactTraceText(prompt, traceSensitiveValues);
      traceStep.thought.reasoning = redactTraceText(response, traceSensitiveValues);
      traceStep.action = action ? sanitizeActionForTrace(action) : null;
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
      traceStep.action = sanitizeActionForTrace(action);
      this.actionTraceStep = traceStep;
    }

    try {
      const decision = await this.safetyPolicy.evaluate(action, {
        goal: this.state.goal,
        observation: this.state.currentObservation,
        actionHistory: this.state.actionHistory
      });
      this.recordSafetyDecision(traceStep, decision);

      if (decision.decision === "block") {
        const message = `Action blocked by safety policy: ${decision.reason}`;
        this.pendingAction = null;
        this.state.errors.push(message);
        this.halted = true;
        if (traceStep) {
          traceStep.result = { success: false, error: message };
        }
        return;
      }

      if (decision.decision === "require_approval") {
        if (!traceStep) {
          throw new Error("A trace step is required to pause for approval.");
        }

        traceStep.approvalStatus = "pending";
        traceStep.result = {
          success: false,
          error: "Action is awaiting human approval."
        };
        this.pendingApproval = {
          requestId: decision.requestId,
          action,
          reason: decision.reason,
          goal: this.state.goal,
          observation: this.state.currentObservation,
          stepCount: this.state.stepCount,
          actionHistory: [...this.state.actionHistory],
          traceStep
        };
        return;
      }

      await this.executeAndRecordAction(action, traceStep);
    } catch (error) {
      if (traceStep) {
        this.recordTraceError(traceStep, error);
      }
      throw error;
    }
  }

  async resumeApproval(requestId: string, approved: boolean): Promise<AgentState> {
    const pending = this.pendingApproval;
    if (!pending) {
      throw new Error("The agent has no pending approval request.");
    }
    if (pending.requestId !== requestId) {
      throw new Error(`Unknown approval request ID: ${requestId}`);
    }

    this.pendingApproval = null;
    this.actionTraceStep = pending.traceStep;

    if (!approved) {
      const message = "Action denied by human approval.";
      pending.traceStep.approvalStatus = "denied";
      pending.traceStep.result = { success: false, error: message };
      this.pendingAction = null;
      this.state.errors.push(message);
      this.halted = true;
      return this.state;
    }

    pending.traceStep.approvalStatus = "approved";
    try {
      await this.executeAndRecordAction(pending.action, pending.traceStep);
      const evaluation = await this.reflect(pending.action);
      if (!evaluation.shouldContinue) {
        this.state.errors.push(evaluation.reason);
        this.halted = true;
      }
    } catch (error) {
      this.recordTraceError(pending.traceStep, error);
      this.recordError(error);
      this.halted = true;
      return this.state;
    }

    return this.loop();
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

  getPendingApproval(): PendingApproval | null {
    const pending = this.pendingApproval;
    if (!pending) {
      return null;
    }

    return {
      requestId: pending.requestId,
      action: { ...pending.action },
      reason: pending.reason,
      goal: pending.goal,
      observation: pending.observation,
      stepCount: pending.stepCount,
      actionHistory: pending.actionHistory.map((action) => ({ ...action }))
    };
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

  private async executeAndRecordAction(
    action: BrowserAction,
    traceStep: AgentTraceStep | null
  ): Promise<void> {
    await this.executeAction(action);
    this.state.stepCount += 1;
    this.state.actionHistory.push(action);
    this.memory.addAction(action);
    this.pendingAction = null;
    if (traceStep) {
      traceStep.result = { success: true };
    }
  }

  private recordSafetyDecision(
    traceStep: AgentTraceStep | null,
    decision: ApprovalDecision
  ): void {
    if (!traceStep) {
      return;
    }

    traceStep.safetyDecision = decision.decision;
    traceStep.safetyReason = decision.reason;
    if (decision.decision === "require_approval") {
      traceStep.approvalRequestId = decision.requestId;
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
    traceStep.observation = sanitizeObservationForTrace(
      observation,
      sensitiveValues(this.state.actionHistory)
    );
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

function sanitizeActionForTrace(action: BrowserAction): BrowserAction {
  if (action.type === "type" && isSensitiveSelector(action.selector)) {
    return { ...action, value: "[REDACTED]" };
  }

  return { ...action };
}

function sensitiveValues(actions: readonly BrowserAction[]): string[] {
  return actions.flatMap((action) =>
    action.type === "type" &&
    isSensitiveSelector(action.selector) &&
    action.value.length > 0
      ? [action.value]
      : []
  );
}

function isSensitiveSelector(selector: string): boolean {
  return /password|passwd|secret|token|api[-_]?key|credential/i.test(selector);
}

function redactTraceText(text: string, values: readonly string[]): string {
  let redacted = text;
  for (const value of values) {
    redacted = redacted.split(value).join("[REDACTED]");
  }

  return redacted.replace(
    /("selector"\s*:\s*"[^"]*(?:password|passwd|secret|token|api[-_]?key|credential)[^"]*"\s*,\s*"value"\s*:\s*")[^"]*(")/gi,
    "$1[REDACTED]$2"
  );
}

function sanitizeObservationForTrace(
  observation: Observation,
  values: readonly string[]
): Observation {
  if (values.length === 0) {
    return observation;
  }

  const redact = (value: string): string => redactTraceText(value, values);
  return {
    ...observation,
    url: redact(observation.url),
    title: redact(observation.title),
    metadata: {
      ...observation.metadata,
      url: redact(observation.metadata.url),
      title: redact(observation.metadata.title)
    },
    consoleErrors: observation.consoleErrors.map((error) => ({
      ...error,
      text: redact(error.text),
      location: error.location
        ? { ...error.location, url: redact(error.location.url) }
        : null
    })),
    accessibility: {
      ...observation.accessibility,
      headings: observation.accessibility.headings.map((heading) => ({
        ...heading,
        text: redact(heading.text)
      })),
      landmarks: observation.accessibility.landmarks.map((landmark) => ({
        ...landmark,
        name: landmark.name ? redact(landmark.name) : null
      }))
    },
    elements: observation.elements.map((element) => ({
      ...element,
      accessibleName: element.accessibleName ? redact(element.accessibleName) : null,
      text: redact(element.text)
    })),
    textSample: redact(observation.textSample),
    screenshotPath: observation.screenshotPath
      ? redact(observation.screenshotPath)
      : null
  };
}
