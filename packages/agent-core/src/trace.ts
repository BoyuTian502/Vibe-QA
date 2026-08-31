import type { BrowserAction, Observation } from "@vibeqa/schemas";
import type { ApprovalDecision } from "@vibeqa/safety-policy";

import type { EvaluationResult } from "./evaluator.js";

export interface AgentTrace {
  goal: string;
  steps: AgentTraceStep[];
}

export interface AgentTraceStep {
  elementRecovery?: {
    attempt: number;
    status: "retrying" | "recovered" | "exhausted" | "interrupted";
    reason: string;
    invalidSelector: string;
    recoveryObservationId?: string;
    replannedAction?: BrowserAction;
  };
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
  safetyDecision?: ApprovalDecision["decision"];
  safetyReason?: string;
  approvalRequestId?: string;
  approvalStatus?: "pending" | "approved" | "denied";
  evaluation?: EvaluationResult;
}
