import type { BrowserAction, Observation } from "@vibeqa/schemas";

export type ApprovalDecision =
  | { decision: "allow"; reason: string }
  | { decision: "block"; reason: string }
  | {
      decision: "require_approval";
      reason: string;
      requestId: string;
    };

export interface ActionSafetyContext {
  goal: string;
  observation: Observation | null;
  actionHistory: readonly BrowserAction[];
}

export interface ActionSafetyPolicy {
  evaluate(
    action: BrowserAction,
    context: ActionSafetyContext
  ): ApprovalDecision | Promise<ApprovalDecision>;
}

export type RiskPolicy = ActionSafetyPolicy;
