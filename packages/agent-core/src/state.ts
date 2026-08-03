import type { BrowserAction, Observation } from "@vibeqa/schemas";

export type AgentStatus =
  "idle" | "observing" | "deciding" | "executing" | "completed" | "failed";

export interface ActionRecord {
  step: number;
  action: BrowserAction;
  result: BrowserActionResult;
  timestamp: string;
}

export interface BrowserActionResult {
  ok: boolean;
  value?: string;
  error?: string;
}

export interface AgentState {
  goal: string;
  currentObservation: Observation | null;
  actionHistory: ActionRecord[];
  observationHistory: Observation[];
  stepCount: number;
  status: AgentStatus;
}

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
