import type { EscalationUtility } from "./types.js";

export function classifyEscalationUtility(input: {
  escalationOccurred: boolean;
  finalOutcome: boolean;
  deterministicLikelyCouldComplete?: boolean;
}): EscalationUtility | null {
  if (!input.escalationOccurred) {
    return input.finalOutcome ? "NO_ESCALATION_NEEDED" : null;
  }
  if (!input.finalOutcome) return "FAILED_ESCALATION";
  return input.deterministicLikelyCouldComplete
    ? "UNNECESSARY_ESCALATION"
    : "USEFUL_ESCALATION";
}
