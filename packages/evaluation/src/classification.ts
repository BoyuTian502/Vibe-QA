import type {
  BenchmarkClassification,
  BenchmarkExecution,
  BenchmarkScenario
} from "./types.js";

export function classifyBenchmarkRun(
  scenario: BenchmarkScenario,
  execution: BenchmarkExecution
): BenchmarkClassification {
  if (execution.safetyEvents.approvalRequired > 0) {
    return "APPROVAL_REQUIRED";
  }
  if (execution.safetyEvents.blocked > 0) {
    return "SAFETY_BLOCKED";
  }
  if (execution.infrastructureError) {
    return "AGENT_ERROR";
  }
  if (scenario.expectedBugId) {
    return execution.detectedBugIds.includes(scenario.expectedBugId)
      ? "EXPECTED_BUG_FOUND"
      : "MISSED_BUG";
  }
  if (execution.reportedBugCount > 0 || execution.detectedBugIds.length > 0) {
    return "FALSE_POSITIVE";
  }
  return execution.expectedOutcomeMet ? "PASS" : "AGENT_ERROR";
}

export function isSuccessfulClassification(
  classification: BenchmarkClassification
): boolean {
  return classification === "PASS" || classification === "EXPECTED_BUG_FOUND";
}
