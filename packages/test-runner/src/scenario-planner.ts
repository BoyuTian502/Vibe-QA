import type { AgentState, BrowserAction, Observation } from "@vibeqa/schemas";
import type { Planner } from "@vibeqa/planner";

import type { TestStep } from "./test-case.js";

export class ScenarioPlanner implements Planner {
  constructor(private readonly steps: TestStep[]) {}

  async decide(
    state: AgentState,
    observation: Observation
  ): Promise<BrowserAction | null> {
    void observation;
    return this.steps[state.stepCount] ?? null;
  }
}
