import {
  pageFingerprint,
  type AdaptiveExecutionMetadata,
  type AdaptiveHandoffSnapshot,
  type AdaptiveProgressEvent
} from "@vibeqa/adaptive-execution";
import type { BrowserAction, Observation } from "@vibeqa/schemas";
import { describe, expect, it } from "vitest";

import {
  aggregateAdaptiveFailureAnalysis,
  analyzeAdaptiveRun,
  formatAdaptiveFailureAnalysisMarkdown,
  type AdaptiveRunDiagnosticInput,
  type GeneralizationExecution,
  type GeneralizationRun,
  type GeneralizationScenario,
  type GeneralizationSuiteResult,
  type PlannerDecisionDiagnostic
} from "../src/index.js";

describe("Adaptive escalation failure diagnostics", () => {
  it("creates phase-aware deterministic, handoff, and Ollama traces", () => {
    const result = analyzeAdaptiveRun(input());

    expect(result.phases.map((phase) => phase.phase)).toEqual([
      "deterministic",
      "handoff",
      "ollama"
    ]);
    expect(result.phases[0]?.actions).toHaveLength(1);
    expect(result.phases[1]?.remainingStepBudget).toBe(5);
    expect(result.phases[2]?.evaluatorFeedback).toContain("page remained observable");
  });

  it("records remaining budget and planner-null termination", () => {
    const result = analyzeAdaptiveRun(input());

    expect(result).toMatchObject({
      totalMaxSteps: 6,
      stepsConsumedBeforeEscalation: 1,
      remainingStepsAtHandoff: 5,
      actualPostEscalationSteps: 1,
      terminationReason: "PLANNER_NULL",
      postEscalationEndReason: "PLANNER_NULL",
      primaryFailureReason: "EARLY_TERMINATION"
    });
    expect(result.contributingFactors).toContain("EVALUATOR_COMPLETION_MISMATCH");
  });

  it("classifies invalid planner output with multiple contributing factors", () => {
    const value = input({
      plannerDecisions: [decision("invalid_action")]
    });
    const result = analyzeAdaptiveRun(value);

    expect(result.primaryFailureReason).toBe("OLLAMA_INVALID_ACTION");
    expect(result.contributingFactors).toEqual(
      expect.arrayContaining(["OLLAMA_INVALID_ACTION", "EVALUATOR_COMPLETION_MISMATCH"])
    );
  });

  it("classifies browser action failures", () => {
    const value = input({ errors: ["locator click failed"] });
    required(value.trace.steps.at(-1)).result = {
      success: false,
      error: "locator click failed"
    };
    const result = analyzeAdaptiveRun(value);

    expect(result.terminationReason).toBe("ACTION_FAILURE");
    expect(result.primaryFailureReason).toBe("BROWSER_ACTION_FAILURE");
  });

  it("classifies true repeated-state stagnation", () => {
    const result = analyzeAdaptiveRun(input());
    expect(result.repeatedStateAudits[0]?.classification).toBe("TRUE_STAGNATION");
  });

  it("classifies benign repeated states when observable state changed", () => {
    const value = input();
    required(value.adaptive.progressEvents[0]).visibleTextChanged = true;
    const result = analyzeAdaptiveRun(value);

    expect(result.repeatedStateAudits[0]?.classification).toBe("BENIGN_REPEAT");
    expect(result.contributingFactors).toContain("REPEATED_STATE_FALSE_TRIGGER");
  });

  it("classifies semantic progress under the same fingerprint", () => {
    const value = input();
    required(value.adaptive.progressEvents[0]).progressed = true;
    required(value.adaptive.progressEvents[0]).evaluatorReportedProgress = true;
    const result = analyzeAdaptiveRun(value);

    expect(result.repeatedStateAudits[0]?.classification).toBe(
      "SEMANTIC_PROGRESS_SAME_FINGERPRINT"
    );
  });

  it("measures opportunity loss without hidden benchmark targets", () => {
    const value = input();
    required(value.adaptive.handoffSnapshot).interactiveElements = [];
    const result = analyzeAdaptiveRun(value);

    expect(result.opportunityLoss.level).toBe("high");
    expect(JSON.stringify(result.opportunityLoss)).not.toContain("#hidden-target");
  });

  it("classifies explicit post-escalation budget exhaustion", () => {
    const value = input({ agentCompleted: false, agentStepCount: 6 });
    value.adaptive.diagnosticBudgetExhausted = true;
    const result = analyzeAdaptiveRun(value);

    expect(result.terminationReason).toBe("MAX_STEPS");
    expect(result.primaryFailureReason).toBe("POST_ESCALATION_BUDGET_EXHAUSTED");
  });

  it("aggregates taxonomy, termination, trigger, opportunity, and scenario metrics", () => {
    const diagnosis = analyzeAdaptiveRun(input());
    const result = aggregateAdaptiveFailureAnalysis([
      run("deterministic", "GOAL_COMPLETED", null),
      run("adaptive", "GOAL_INCOMPLETE", diagnosis)
    ]);

    expect(result).toMatchObject({
      totalEscalatedRuns: 1,
      failedEscalatedRuns: 1,
      meanRemainingBudgetAtEscalation: 5,
      meanActualPostEscalationSteps: 1,
      repeatedStateFalseTriggerRate: 0,
      failureTaxonomyCounts: { EARLY_TERMINATION: 1 },
      terminationReasonCounts: { PLANNER_NULL: 1 }
    });
    expect(result?.scenarioFailures[0]).toMatchObject({
      deterministicSuccessRate: 1,
      adaptiveSuccessRate: 0,
      dominantFailureReason: "EARLY_TERMINATION"
    });
  });

  it("compares pure Ollama initial context with escalated Ollama handoff context", () => {
    const diagnosis = analyzeAdaptiveRun(input());
    const result = aggregateAdaptiveFailureAnalysis([
      run("ollama", "GOAL_COMPLETED", null, [decision("valid_action")]),
      run("adaptive", "GOAL_INCOMPLETE", diagnosis)
    ]);

    expect(result?.pureVsEscalated[0]).toMatchObject({
      pureOllamaRuns: 1,
      escalatedOllamaRuns: 1,
      averagePureOllamaStepsAvailable: 6,
      averageEscalatedStepsAvailable: 5,
      averagePriorActionsAtHandoff: 1
    });
  });

  it("renders the failure, termination, scenario, and comparison report sections", () => {
    const diagnosis = analyzeAdaptiveRun(input());
    const metrics = aggregateAdaptiveFailureAnalysis([
      run("ollama", "GOAL_COMPLETED", null, [decision("valid_action")]),
      run("adaptive", "GOAL_INCOMPLETE", diagnosis)
    ]);
    const report = formatAdaptiveFailureAnalysisMarkdown({
      scenarios: [{ ...scenario(), evaluatorOnly: undefined }],
      configuration: {
        adaptiveDebugReplay: true,
        adaptivePostEscalationStepBudget: 3
      },
      metrics: { adaptiveFailureAnalysis: metrics }
    } as unknown as GeneralizationSuiteResult);

    expect(report).toContain("Adaptive Escalation Failure Analysis");
    expect(report).toContain("Failure Taxonomy Distribution");
    expect(report).toContain("Termination Reason Distribution");
    expect(report).toContain("Pure Ollama vs Escalated Ollama");
    expect(report).toContain("Scenario-Level Failure Breakdown");
    expect(report).toContain("Diagnostic replay: enabled");
    expect(report).toContain("| scenario | N/A | 100.0% | N/A | 0.0% |");
  });
});

function input(
  overrides: Partial<AdaptiveRunDiagnosticInput> = {}
): AdaptiveRunDiagnosticInput {
  const first = observation("initial", ["#first", "#second"]);
  const repeated = observation("same", ["#first", "#second"]);
  const after = observation("same", ["#first", "#second"]);
  const action: BrowserAction = { type: "click", selector: "#first" };
  const ollamaAction: BrowserAction = { type: "click", selector: "#second" };
  const adaptive = metadata(repeated);
  const execution: GeneralizationExecution = {
    goalCompleted: false,
    detectedBugIds: [],
    infrastructureError: null,
    durationMs: 1000,
    plannerDurationMs: 500,
    safetyEvents: { allowed: 2, blocked: 0, approvalRequired: 0 },
    observations: [first, repeated, after].map((item, index) => ({
      fingerprint: pageFingerprint(item),
      normalizedUrl: item.url,
      observation: item,
      observationIndex: index,
      interactiveElementKeys: item.elements.map((element) => element.selector)
    })),
    actions: [action, ollamaAction].map((item, index) => ({
      action: item,
      fromStateFingerprint: pageFingerprint(index === 0 ? first : repeated),
      toStateFingerprint: pageFingerprint(repeated),
      success: true,
      error: null
    })),
    discoveryStep: null,
    completionStep: null,
    uniqueStatesBeforeDiscovery: 0,
    uniqueElementsBeforeDiscovery: 0,
    approvalRequired: false,
    safetyBlocked: false,
    adaptive
  };
  return {
    scenario: scenario(),
    execution,
    trace: {
      goal: "Explore the dashboard safely",
      steps: [
        traceStep(first, action),
        traceStep(repeated, ollamaAction),
        traceStep(after, null)
      ]
    },
    errors: [],
    agentCompleted: true,
    agentStepCount: 2,
    plannerDecisions: [decision("valid_action"), decision("null_action")],
    adaptive,
    ...overrides
  };
}

function metadata(observed: Observation): AdaptiveExecutionMetadata {
  const event: AdaptiveProgressEvent = {
    step: 1,
    progressed: false,
    reasons: ["repeated-state", "no-progress"],
    currentFingerprint: pageFingerprint(observed),
    previousMatchingFingerprint: pageFingerprint(observed),
    actionsSincePreviousMatch: [{ type: "click", target: "#first" }],
    urlChanged: false,
    visibleTextChanged: false,
    interactiveElementsChanged: false,
    evaluatorReportedProgress: null,
    repeatedStateCount: 2,
    noProgressCount: 1,
    failedActionCount: 0,
    evaluationFailureCount: 0,
    signals: ["repeated-state"]
  };
  return {
    requestedStrategy: "adaptive",
    startingPlanner: "deterministic",
    escalationRequired: true,
    escalationOccurred: true,
    escalationSucceeded: true,
    ollamaAvailable: true,
    degradedExecution: false,
    escalationStep: 1,
    escalationSignals: ["repeated-state"],
    escalationReason: "Runtime progress monitoring detected: repeated-state.",
    plannerBefore: "deterministic",
    plannerAfter: "ollama",
    deterministicSteps: 1,
    ollamaSteps: 1,
    totalSteps: 2,
    timeBeforeEscalationMs: 250,
    timeAfterEscalationMs: 750,
    ollamaInvocationCount: 2,
    finalOutcome: false,
    progressEvents: [event],
    escalationFailure: null,
    maxSteps: 6,
    remainingStepBudgetAtHandoff: 5,
    handoffSnapshot: handoff(observed, event),
    plannerDecisions: [],
    diagnosticReplay: false,
    diagnosticPostEscalationStepBudget: null,
    diagnosticBudgetExhausted: false
  };
}

function handoff(
  observed: Observation,
  event: AdaptiveProgressEvent
): AdaptiveHandoffSnapshot {
  return {
    goal: "Explore the dashboard safely",
    currentUrl: observed.url,
    pageTitle: observed.title,
    visibleTextSummary: observed.textSample,
    interactiveElements: observed.elements.map((element) => ({
      tagName: element.tagName,
      role: element.role,
      accessibleName: element.accessibleName,
      text: element.text,
      selector: element.selector,
      href: element.href,
      enabled: element.enabled,
      editable: element.editable
    })),
    accessibility: structuredClone(observed.accessibility),
    pageFingerprint: pageFingerprint(observed),
    priorDeterministicActions: [{ type: "click", target: "#first" }],
    failedOrNoProgressActions: [{ type: "click", target: "#first" }],
    discoveredBugs: [],
    progressHistory: [event],
    escalationSignals: ["repeated-state"],
    escalationReason: "Runtime progress monitoring detected: repeated-state.",
    totalMaxSteps: 6,
    remainingStepBudget: 5,
    evaluatorStatus: { progressed: false, reasons: ["no-progress"] },
    memorySummary: {
      actionCount: 1,
      discoveredBugCount: 0,
      recentActionTypes: ["click"]
    },
    promptCharacterCount: 2000,
    actionHistoryCharacterCount: 40
  };
}

function decision(
  outcome: PlannerDecisionDiagnostic["outcome"]
): PlannerDecisionDiagnostic {
  return {
    outcome,
    promptCharacterCount: 2000,
    observationCharacterCount: 1200,
    actionHistoryCount: 1,
    responseCharacterCount: 40,
    attempts: 1,
    validationFailures: outcome === "invalid_action" ? ["invalid_action"] : [],
    action: outcome === "valid_action" ? { type: "click", target: "#second" } : null,
    repeatedAction: false
  };
}

function traceStep(
  observed: Observation,
  action: BrowserAction | null
): AdaptiveRunDiagnosticInput["trace"]["steps"][number] {
  return {
    observation: observed,
    action,
    result: { success: true },
    safetyDecision: action ? "allow" : undefined,
    evaluation: action
      ? {
          success: true,
          reason: "page remained observable",
          shouldContinue: true
        }
      : undefined
  };
}

function scenario(): GeneralizationScenario {
  return {
    id: "scenario",
    name: "Scenario",
    category: "ambiguous_goal",
    difficulty: "medium",
    startUrl: "http://site.test/dashboard",
    plannerGoal: "Explore the dashboard safely",
    hiddenExpectationSummary: "Goal should be completed",
    maxSteps: 6,
    credentialsRequirement: "none",
    routingHints: {
      mode: "exploratory",
      hasExpectedBehavior: false,
      exactWorkflowKnown: false,
      explicitlyExploratory: true,
      hiddenIssueDiscoveryRequested: false,
      recoveryRequired: false,
      sameUrlStateReasoning: false,
      semanticGoalAmbiguous: true
    },
    evaluatorOnly: {
      expectedBugIds: [],
      bugSignals: [],
      hiddenTargetSelectors: ["#hidden-target"],
      hiddenExpectedActions: [],
      recommendedPlanner: "ollama",
      recommendedPlannerCategory: "ollama-preferred"
    }
  };
}

function observation(text: string, selectors: readonly string[]): Observation {
  const url = "http://site.test/dashboard";
  return {
    id: text,
    timestamp: "2026-08-28T00:00:00.000Z",
    url,
    title: "Dashboard",
    metadata: { url, title: "Dashboard", viewport: null },
    consoleErrors: [],
    accessibility: {
      headings: [],
      landmarks: [],
      interactiveElementCount: selectors.length
    },
    elements: selectors.map((selector) => ({
      id: selector,
      tagName: "button",
      role: "button",
      accessibleName: selector,
      text: selector,
      visible: true,
      enabled: true,
      editable: false,
      selector
    })),
    textSample: text,
    screenshotPath: null
  };
}

function run(
  planner: GeneralizationRun["planner"],
  classification: GeneralizationRun["classification"],
  diagnostics: GeneralizationRun["adaptiveDiagnostics"],
  plannerDecisions: PlannerDecisionDiagnostic[] = []
): GeneralizationRun {
  const observed = observation("initial", ["#first", "#second"]);
  const successful = ["GOAL_COMPLETED", "HIDDEN_BUG_FOUND"].includes(classification);
  return {
    ...input().execution,
    id: `${planner}-run`,
    scenarioId: "scenario",
    scenarioName: "Scenario",
    category: "ambiguous_goal",
    difficulty: "medium",
    planner,
    modelName: planner === "ollama" ? "qwen" : null,
    repetition: 1,
    startedAt: "2026-08-28T00:00:00.000Z",
    maxSteps: 6,
    classification,
    expectedBugIds: [],
    usefulNewStates: successful ? 1 : 0,
    detourActions: 1,
    revisitedStates: 1,
    recoveryRequired: true,
    recoverySucceeded: successful,
    goalCompleted: successful,
    observations: [
      {
        fingerprint: pageFingerprint(observed),
        normalizedUrl: observed.url,
        observation: observed,
        observationIndex: 0,
        interactiveElementKeys: observed.elements.map((item) => item.selector)
      }
    ],
    adaptive: planner === "adaptive" ? metadata(observed) : null,
    adaptiveDiagnostics: diagnostics,
    plannerDecisions
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected test fixture value.");
  }
  return value;
}
