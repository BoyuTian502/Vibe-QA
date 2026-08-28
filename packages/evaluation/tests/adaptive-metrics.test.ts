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
        adaptive: metadata({
          escalationRequired: true,
          escalationOccurred: true,
          escalationSucceeded: true,
          ollamaAvailable: true,
          deterministicSteps: 3,
          ollamaSteps: 2,
          ollamaInvocationCount: 2
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
          ollamaInvocationCount: 1
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
      utilityCounts: {
        USEFUL_ESCALATION: 1,
        UNNECESSARY_ESCALATION: 0,
        FAILED_ESCALATION: 1,
        NO_ESCALATION_NEEDED: 1
      }
    });
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
