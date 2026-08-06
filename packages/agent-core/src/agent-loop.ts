import type { BrowserSession } from "@vibeqa/browser-tools";
import type {
  ActionRecord,
  AgentState,
  BrowserAction,
  BrowserActionResult,
  Observation
} from "@vibeqa/schemas";
import type { Planner } from "@vibeqa/planner";

import { createInitialAgentState } from "./state.js";

export interface AgentLoopOptions {
  goal: string;
  browser: BrowserSession;
  planner: Planner;
}

export interface AgentStepResult {
  observation: Observation;
  action: BrowserAction | null;
  result: BrowserActionResult | null;
  state: AgentState;
}

export class AgentLoop {
  private readonly browser: BrowserSession;
  private readonly planner: Planner;
  readonly state: AgentState;

  constructor(options: AgentLoopOptions) {
    this.browser = options.browser;
    this.planner = options.planner;
    this.state = createInitialAgentState(options.goal);
  }

  async runStep(): Promise<AgentStepResult> {
    const observation = await this.observe();
    const action = await this.decideAction(observation);

    if (!action) {
      this.state.status = "completed";
      return {
        observation,
        action,
        result: null,
        state: this.state
      };
    }

    const result = await this.executeAction(action);
    this.updateState(action, result);

    return {
      observation,
      action,
      result,
      state: this.state
    };
  }

  private async observe(): Promise<Observation> {
    this.state.status = "observing";
    const observation = await this.browser.observe();
    this.state.currentObservation = observation;
    this.state.observationHistory.push(observation);
    return observation;
  }

  private async decideAction(observation: Observation): Promise<BrowserAction | null> {
    this.state.status = "deciding";
    return await this.planner.decide(this.state, observation);
  }

  private async executeAction(action: BrowserAction): Promise<BrowserActionResult> {
    this.state.status = "executing";

    try {
      switch (action.type) {
        case "goto":
          await this.browser.goto(action.url);
          return { ok: true };
        case "click":
          await this.browser.click(action.selector);
          return { ok: true };
        case "type":
          await this.browser.type(action.selector, action.value);
          return { ok: true };
        case "getText":
          return { ok: true, value: await this.browser.getText(action.selector) };
        case "screenshot": {
          const value = await this.browser.screenshot({ path: action.path });
          return {
            ok: true,
            value: typeof value === "string" ? value : "[screenshot-bytes]"
          };
        }
        case "getCurrentUrl":
          return { ok: true, value: this.browser.getCurrentUrl() };
      }
    } catch (error) {
      this.state.status = "failed";
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown browser action failure"
      };
    }
  }

  private updateState(action: BrowserAction, result: BrowserActionResult): void {
    this.state.stepCount += 1;
    const record: ActionRecord = {
      step: this.state.stepCount,
      action,
      result,
      timestamp: new Date().toISOString()
    };

    this.state.actionHistory.push(record);
    this.state.status = result.ok ? "idle" : "failed";
  }
}
