import type { AdaptiveExecutionMetadata } from "@vibeqa/adaptive-execution";
import { describe, expect, it } from "vitest";

import { aggregateAdaptiveExecutionMetrics } from "../src/index.js";

describe("adaptive execution metrics", () => {
  it("calculates escalation, avoided LLM, success, utility, and threshold metrics", () => {
    const result = aggregateAdaptiveExecutionMetrics([
      { planner: "deterministic", scenarioId: "easy", successful: true },
      {
        planner: "adaptive",
        scenarioId: "easy",
        successful: true,
        adaptive: metadata({ escalationOccurred: false, deterministicSteps: 2 })
      },
      {
        planner: "adaptive",
        scenarioId: "hard",
        successful: true,
        hiddenBugDiscovered: true,
        adaptive: metadata({
          escalationRequired: true,
          escalationOccurred: true,
          escalationSucceeded: true,
          ollamaAvailable: true,
          deterministicSteps: 3,
          ollamaSteps: 2,
          ollamaInvocationCount: 2,
          escalationTiming: "early",
          opportunityPreservingEscalation: true,
          opportunityRetainedAtHandoff: 1,
          safeCandidatesRemainingAtHandoff: 6,
          remainingStepBudgetAtHandoff: 5,
          initialPageFingerprint: "initial",
          handoffSnapshot: { pageFingerprint: "initial" } as never,
          completionGateRejectionCount: 1,
          nullRecoveryCount: 1,
          plannerDecisions: [
            plannerDecision("null_action"),
            plannerDecision("valid_action")
          ]
        })
      },
      {
        planner: "adaptive",
        scenarioId: "miss",
        successful: false,
        adaptive: metadata({
          escalationRequired: true,
          escalationOccurred: true,
          escalationSucceeded: true,
          ollamaAvailable: true,
          deterministicSteps: 4,
          ollamaSteps: 1,
          ollamaInvocationCount: 1,
          escalationTiming: "stagnation",
          opportunityPreservingEscalation: false,
          opportunityRetainedAtHandoff: 0.5,
          safeCandidatesRemainingAtHandoff: 2,
          remainingStepBudgetAtHandoff: 2,
          initialPageFingerprint: "initial",
          handoffSnapshot: { pageFingerprint: "late" } as never,
          completionGateRejectionCount: 1,
          nullRecoveryCount: 0,
          plannerDecisions: [plannerDecision("null_action")]
        })
      }
    ]);

    expect(result).toMatchObject({
      totalAdaptiveRuns: 3,
      escalationCount: 2,
      escalationRate: 2 / 3,
      successfulEscalationRate: 0.5,
      avoidedLlmRate: 1 / 3,
      ollamaInvocationCount: 3,
      earlyEscalationCount: 1,
      stagnationEscalationCount: 1,
      opportunityPreservingEscalationCount: 1,
      plannerNullDecisionCount: 2,
      postHandoffPlannerDecisionCount: 3,
      plannerNullRateAfterHandoff: 2 / 3,
      nullRecoveryCount: 1,
      nullRecoveryRate: 0.5,
      completionGateRejectionCount: 2,
      hiddenDiscoveryAfterEarlyHandoffCount: 1,
      hiddenDiscoveryAfterEarlyHandoffRate: 1,
      handoffStateSimilarityToInitialStateRate: 0.5,
      utilityCounts: {
        USEFUL_ESCALATION: 1,
        UNNECESSARY_ESCALATION: 0,
        FAILED_ESCALATION: 1,
        NO_ESCALATION_NEEDED: 1
      }
    });
    expect(result?.opportunityRetainedAtHandoff.mean).toBe(0.75);
    expect(result?.safeCandidatesRemainingAtHandoff.mean).toBe(4);
    expect(result?.postHandoffActionUtilization.mean).toBeCloseTo(0.45);
    expect(result?.thresholdAnalysis.map((item) => item.profile)).toEqual([
      "conservative",
      "balanced",
      "aggressive"
    ]);
  });
});

function metadata(
  overrides: Partial<AdaptiveExecutionMetadata> = {}
): AdaptiveExecutionMetadata {
  return {
    requestedStrategy: "adaptive",
    startingPlanner: "deterministic",
    escalationRequired: false,
    escalationOccurred: false,
    escalationSucceeded: false,
    ollamaAvailable: null,
    degradedExecution: false,
    escalationStep: null,
    escalationSignals: [],
    escalationReason: null,
    plannerBefore: "deterministic",
    plannerAfter: null,
    deterministicSteps: 0,
    ollamaSteps: 0,
    totalSteps: 0,
    timeBeforeEscalationMs: null,
    timeAfterEscalationMs: null,
    ollamaInvocationCount: 0,
    finalOutcome: null,
    progressEvents: [],
    escalationFailure: null,
    ...overrides
  };
}

function plannerDecision(
  outcome: "valid_action" | "null_action"
): NonNullable<AdaptiveExecutionMetadata["plannerDecisions"]>[number] {
  return {
    phase: "ollama",
    invocation: 1,
    outcome,
    action: null,
    promptCharacterCount: 100,
    responseCharacterCount: 4,
    actionHistoryCount: 0,
    pageFingerprint: "state",
    durationMs: 10,
    error: null
  };
}
