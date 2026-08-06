import type { AgentState } from "@vibeqa/schemas";

export function createInitialAgentState(goal: string): AgentState {
  return {
    goal,
    currentObservation: null,
    actionHistory: [],
    observationHistory: [],
    stepCount: 0,
    status: "idle"
  };
}
