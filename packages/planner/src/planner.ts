import type { AgentState, BrowserAction, Observation } from "@vibeqa/schemas";

export interface Planner {
  decide(state: AgentState, observation: Observation): Promise<BrowserAction | null>;
}
