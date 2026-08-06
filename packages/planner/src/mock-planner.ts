import type { AgentState, BrowserAction, Observation } from "@vibeqa/schemas";

import type { Planner } from "./planner.js";

export class MockPlanner implements Planner {
  async decide(
    state: AgentState,
    observation: Observation
  ): Promise<BrowserAction | null> {
    if (isLoginPage(observation)) {
      return this.planLoginPageAction(state);
    }

    return null;
  }

  private planLoginPageAction(state: AgentState): BrowserAction | null {
    const completedActions = state.actionHistory.map((record) => record.action);

    if (
      !completedActions.some(
        (action) => action.type === "type" && action.selector === 'input[name="email"]'
      )
    ) {
      return {
        type: "type",
        selector: 'input[name="email"]',
        value: "qa@example.com"
      };
    }

    if (
      !completedActions.some(
        (action) =>
          action.type === "type" && action.selector === 'input[name="password"]'
      )
    ) {
      return {
        type: "type",
        selector: 'input[name="password"]',
        value: "password123"
      };
    }

    if (
      !completedActions.some(
        (action) =>
          action.type === "click" && action.selector === 'button[type="submit"]'
      )
    ) {
      return {
        type: "click",
        selector: 'button[type="submit"]'
      };
    }

    return null;
  }
}

function isLoginPage(observation: Observation): boolean {
  return (
    observation.url.endsWith("/login") ||
    observation.title.includes("Login") ||
    observation.textSample.includes("Sign in to Acme Growth")
  );
}
