import type { BrowserAction, Observation } from "@vibeqa/schemas";

import type { EvaluationResult } from "./evaluator.js";

export interface AgentTrace {
  goal: string;
  steps: AgentTraceStep[];
}

export interface AgentTraceStep {
  timestamp: string;
  observation: Observation | null;
  thought: {
    prompt?: string;
    reasoning?: string;
  };
  action: BrowserAction | null;
  result: {
    success: boolean;
    error?: string;
  };
  evaluation?: EvaluationResult;
}
