import {
  pageFingerprint,
  type AdaptiveActionSummary,
  type AdaptiveExecutionMetadata
} from "@vibeqa/adaptive-execution";
import type { BrowserAction, Observation } from "@vibeqa/schemas";

import type {
  AdaptiveEscalationFailureReason,
  AdaptiveFailureAnalysisMetrics,
  AdaptiveObservationSummary,
  AdaptiveOpportunityLoss,
  AdaptivePhaseTrace,
  AdaptiveRunDiagnostics,
  AdaptiveTerminationReason,
  GeneralizationExecution,
  GeneralizationRun,
  GeneralizationScenario,
  OpportunityLossLevel,
  PlannerDecisionDiagnostic,
  PlannerDecisionOutcome,
  RepeatedStateTriggerAudit,
  RepeatedStateTriggerQuality
} from "./generalization-types.js";

interface DiagnosticTraceStep {
  observation: Observation | null;
  action: BrowserAction | null;
  result: { success: boolean; error?: string };
  safetyDecision?: "allow" | "block" | "require_approval";
  evaluation?: { success: boolean; reason: string; shouldContinue: boolean };
}

export interface AdaptiveRunDiagnosticInput {
  scenario: GeneralizationScenario;
  execution: GeneralizationExecution;
  trace: { goal: string; steps: DiagnosticTraceStep[] };
  errors: readonly string[];
  agentCompleted: boolean;
  agentStepCount: number;
  plannerDecisions: readonly PlannerDecisionDiagnostic[];
  adaptive: AdaptiveExecutionMetadata;
}

const FAILURE_REASONS: readonly AdaptiveEscalationFailureReason[] = [
  "HANDOFF_CONTEXT_INSUFFICIENT",
  "POST_ESCALATION_BUDGET_EXHAUSTED",
  "PRE_ESCALATION_STATE_DAMAGE",
  "GOAL_ALREADY_MISFRAMED",
  "REPEATED_STATE_FALSE_TRIGGER",
  "OLLAMA_INVALID_ACTION",
  "OLLAMA_NON_PROGRESS_ACTION",
  "EARLY_TERMINATION",
  "EVALUATOR_COMPLETION_MISMATCH",
  "SAFETY_BLOCK",
  "BROWSER_ACTION_FAILURE",
  "UNKNOWN_FAILURE"
];

const TERMINATION_REASONS: readonly AdaptiveTerminationReason[] = [
  "GOAL_COMPLETE",
  "MAX_STEPS",
  "PLANNER_NULL",
  "EVALUATOR_STOP",
  "ACTION_FAILURE",
  "NO_PROGRESS_STOP",
  "SAFETY_STOP",
  "ESCALATION_FAILURE",
  "OTHER"
];

const TRIGGER_QUALITY: readonly RepeatedStateTriggerQuality[] = [
  "TRUE_STAGNATION",
  "BENIGN_REPEAT",
  "SEMANTIC_PROGRESS_SAME_FINGERPRINT",
  "UNKNOWN"
];

const OPPORTUNITY_LEVELS: readonly OpportunityLossLevel[] = [
  "none",
  "low",
  "medium",
  "high"
];

const DECISION_OUTCOMES: readonly PlannerDecisionOutcome[] = [
  "valid_action",
  "null_action",
  "invalid_action",
  "parser_failure",
  "action_not_applicable"
];

export function analyzeAdaptiveRun(
  input: AdaptiveRunDiagnosticInput
): AdaptiveRunDiagnostics {
  const handoff = input.adaptive.handoffSnapshot;
  const repeatedStateAudits = input.adaptive.progressEvents
    .filter((event) => event.signals.includes("repeated-state"))
    .map<RepeatedStateTriggerAudit>((event) => ({
      currentFingerprint: event.currentFingerprint,
      previousMatchingFingerprint: event.previousMatchingFingerprint,
      actionsBetweenStates: event.actionsSincePreviousMatch.map((action) => ({
        ...action
      })),
      urlChanged: event.urlChanged,
      visibleTextChanged: event.visibleTextChanged,
      interactiveElementsChanged: event.interactiveElementsChanged,
      evaluatorReportedProgress: event.evaluatorReportedProgress,
      classification: classifyRepeatedStateTrigger(event)
    }));
  const opportunityLoss = assessOpportunityLoss(input.execution, input.adaptive);
  const terminationReason = classifyTermination(input);
  const successful = input.execution.goalCompleted;
  const factors = successful
    ? []
    : failureFactors(input, repeatedStateAudits, opportunityLoss, terminationReason);
  const phaseTraces = createPhaseTraces(input);

  return {
    handoffSnapshot: handoff ? structuredClone(handoff) : null,
    phases: phaseTraces,
    terminationReason,
    primaryFailureReason: successful ? null : selectPrimaryFailure(factors),
    contributingFactors: factors,
    repeatedStateAudits,
    opportunityLoss,
    totalMaxSteps: input.adaptive.maxSteps ?? input.scenario.maxSteps,
    stepsConsumedBeforeEscalation: input.adaptive.deterministicSteps,
    remainingStepsAtHandoff:
      input.adaptive.remainingStepBudgetAtHandoff ??
      Math.max(0, input.scenario.maxSteps - input.adaptive.deterministicSteps),
    actualPostEscalationSteps: input.adaptive.ollamaSteps,
    postEscalationEndReason: terminationReason,
    plannerDecisions: input.plannerDecisions.map((decision) =>
      structuredClone(decision)
    ),
    promptContext: {
      firstOllamaPromptCharacters:
        input.plannerDecisions[0]?.promptCharacterCount ?? null,
      firstOllamaObservationCharacters:
        input.plannerDecisions[0]?.observationCharacterCount ?? null,
      firstOllamaActionHistoryCount:
        input.plannerDecisions[0]?.actionHistoryCount ?? null,
      handoffPromptCharacters: handoff?.promptCharacterCount ?? null,
      handoffActionHistoryCharacters: handoff?.actionHistoryCharacterCount ?? null
    }
  };
}

export function aggregateAdaptiveFailureAnalysis(
  runs: readonly GeneralizationRun[]
): AdaptiveFailureAnalysisMetrics | null {
  const adaptiveRuns = runs.filter(
    (run) => run.planner === "adaptive" && run.adaptiveDiagnostics
  );
  if (adaptiveRuns.length === 0) return null;
  const escalatedRuns = adaptiveRuns.filter((run) => run.adaptive?.escalationOccurred);
  const failedRuns = escalatedRuns.filter((run) => !successful(run));
  const audits = escalatedRuns.flatMap(
    (run) => run.adaptiveDiagnostics?.repeatedStateAudits ?? []
  );
  const falseTriggerCount = audits.filter((audit) =>
    ["BENIGN_REPEAT", "SEMANTIC_PROGRESS_SAME_FINGERPRINT"].includes(
      audit.classification
    )
  ).length;

  return {
    totalEscalatedRuns: escalatedRuns.length,
    failedEscalatedRuns: failedRuns.length,
    failureTaxonomyCounts: countValues(
      FAILURE_REASONS,
      failedRuns.flatMap((run) =>
        run.adaptiveDiagnostics?.primaryFailureReason
          ? [run.adaptiveDiagnostics.primaryFailureReason]
          : []
      )
    ),
    contributingFactorCounts: countValues(
      FAILURE_REASONS,
      failedRuns.flatMap((run) => run.adaptiveDiagnostics?.contributingFactors ?? [])
    ),
    terminationReasonCounts: countValues(
      TERMINATION_REASONS,
      escalatedRuns.flatMap((run) =>
        run.adaptiveDiagnostics ? [run.adaptiveDiagnostics.terminationReason] : []
      )
    ),
    repeatedStateTriggerCounts: countValues(
      TRIGGER_QUALITY,
      audits.map((audit) => audit.classification)
    ),
    repeatedStateFalseTriggerRate: rate(falseTriggerCount, audits.length),
    meanRemainingBudgetAtEscalation: average(
      escalatedRuns.flatMap((run) =>
        run.adaptiveDiagnostics ? [run.adaptiveDiagnostics.remainingStepsAtHandoff] : []
      )
    ),
    meanActualPostEscalationSteps: average(
      escalatedRuns.flatMap((run) =>
        run.adaptiveDiagnostics
          ? [run.adaptiveDiagnostics.actualPostEscalationSteps]
          : []
      )
    ),
    opportunityLossCounts: countValues(
      OPPORTUNITY_LEVELS,
      escalatedRuns.flatMap((run) =>
        run.adaptiveDiagnostics ? [run.adaptiveDiagnostics.opportunityLoss.level] : []
      )
    ),
    plannerDecisionCounts: countValues(
      DECISION_OUTCOMES,
      escalatedRuns.flatMap(
        (run) =>
          run.adaptiveDiagnostics?.plannerDecisions.flatMap((item) => [
            item.outcome,
            ...item.validationFailures
          ]) ?? []
      )
    ),
    scenarioFailures: scenarioFailureMetrics(runs),
    pureVsEscalated: pureVsEscalatedComparison(runs)
  };
}

function createPhaseTraces(input: AdaptiveRunDiagnosticInput): AdaptivePhaseTrace[] {
  const actionSteps = input.trace.steps.filter((step) => step.action !== null);
  const deterministicActionSteps = actionSteps.slice(
    0,
    input.adaptive.deterministicSteps
  );
  const ollamaActionSteps = actionSteps.slice(input.adaptive.deterministicSteps);
  const observations = input.execution.observations;
  const deterministicObservations = observations.slice(
    0,
    Math.min(observations.length, input.adaptive.deterministicSteps + 1)
  );
  const ollamaObservations = observations.slice(input.adaptive.deterministicSteps);
  const handoff = input.adaptive.handoffSnapshot;
  return [
    phaseTrace(
      "deterministic",
      deterministicObservations.map((item) => item.observation),
      deterministicActionSteps,
      input.adaptive.progressEvents,
      input.adaptive.timeBeforeEscalationMs,
      input.adaptive.remainingStepBudgetAtHandoff,
      input.trace.goal
    ),
    {
      phase: "handoff",
      observations: handoff
        ? [
            {
              fingerprint: handoff.pageFingerprint,
              url: handoff.currentUrl,
              title: handoff.pageTitle,
              visibleTextSummary: handoff.visibleTextSummary,
              interactiveElementCount: handoff.interactiveElements.length,
              consoleErrorCount: 0
            }
          ]
        : [],
      actions: [],
      failures: input.adaptive.escalationFailure
        ? [input.adaptive.escalationFailure]
        : [],
      pageFingerprints: handoff ? [handoff.pageFingerprint] : [],
      progressDecisions: [],
      evaluatorFeedback: handoff?.evaluatorStatus.reasons ?? [],
      durationMs: 0,
      remainingStepBudget: input.adaptive.remainingStepBudgetAtHandoff,
      goalRepresentation: sanitize(input.trace.goal),
      actionHistorySummary: handoff?.priorDeterministicActions ?? []
    },
    phaseTrace(
      "ollama",
      ollamaObservations.map((item) => item.observation),
      ollamaActionSteps,
      [],
      input.adaptive.timeAfterEscalationMs,
      Math.max(
        0,
        (input.adaptive.remainingStepBudgetAtHandoff ?? 0) - input.adaptive.ollamaSteps
      ),
      input.trace.goal
    )
  ];
}

function phaseTrace(
  phase: "deterministic" | "ollama",
  observations: readonly Observation[],
  steps: readonly DiagnosticTraceStep[],
  progressDecisions: AdaptiveExecutionMetadata["progressEvents"],
  durationMs: number | null,
  remainingStepBudget: number | null,
  goal: string
): AdaptivePhaseTrace {
  const actions = steps.flatMap((step) =>
    step.action ? [summarizeAction(step.action)] : []
  );
  const summaries = observations.map(summarizeObservation);
  return {
    phase,
    observations: summaries,
    actions,
    failures: steps.flatMap((step) =>
      step.result.error ? [sanitize(step.result.error)] : []
    ),
    pageFingerprints: summaries.map((item) => item.fingerprint),
    progressDecisions: progressDecisions.map((event) => structuredClone(event)),
    evaluatorFeedback: steps.flatMap((step) =>
      step.evaluation ? [sanitize(step.evaluation.reason)] : []
    ),
    durationMs,
    remainingStepBudget,
    goalRepresentation: sanitize(goal),
    actionHistorySummary: actions
  };
}

function summarizeObservation(observation: Observation): AdaptiveObservationSummary {
  return {
    fingerprint: pageFingerprint(observation),
    url: sanitize(observation.url),
    title: sanitize(observation.title),
    visibleTextSummary: sanitize(observation.textSample).slice(0, 500),
    interactiveElementCount: observation.elements.filter((item) => item.visible).length,
    consoleErrorCount: observation.consoleErrors.length
  };
}

function assessOpportunityLoss(
  execution: GeneralizationExecution,
  adaptive: AdaptiveExecutionMetadata
): AdaptiveOpportunityLoss {
  const initial = execution.observations[0];
  const handoff = adaptive.handoffSnapshot;
  const initialKeys = new Set(
    initial?.observation.elements
      .filter((element) => element.visible)
      .map((element) => element.selector) ?? []
  );
  const interactedTargets = new Set(
    handoff?.priorDeterministicActions.flatMap((action) =>
      action.target ? [action.target] : []
    ) ?? []
  );
  const handoffKeys = new Set(
    handoff?.interactiveElements.map((element) => element.selector) ?? []
  );
  const unexplored = [...handoffKeys].filter(
    (key) => !interactedTargets.has(key)
  ).length;
  const missingRatio =
    initialKeys.size === 0
      ? 0
      : [...initialKeys].filter((key) => !handoffKeys.has(key)).length /
        initialKeys.size;
  const stateMatches =
    initial !== undefined &&
    handoff !== null &&
    comparableObservationState(initial.observation) === comparableHandoffState(handoff);
  const factors: string[] = [];
  if (!stateMatches) factors.push("handoff-state-differs-from-initial-state");
  if (missingRatio > 0) factors.push("interactive-elements-no-longer-visible");
  if (unexplored === 0 && handoffKeys.size > 0) {
    factors.push("all-visible-handoff-elements-were-already-attempted");
  }
  let level: OpportunityLossLevel = "none";
  if (missingRatio > 0.5 || (handoffKeys.size > 0 && unexplored === 0)) level = "high";
  else if (missingRatio > 0.25 || (!stateMatches && interactedTargets.size > 1)) {
    level = "medium";
  } else if (!stateMatches || interactedTargets.size > 0) level = "low";
  return {
    level,
    factors,
    initialInteractiveElementCount: initialKeys.size,
    handoffInteractiveElementCount: handoffKeys.size,
    unexploredInteractiveElementCount: unexplored,
    startAndHandoffStateMatch: stateMatches
  };
}

function classifyTermination(
  input: AdaptiveRunDiagnosticInput
): AdaptiveTerminationReason {
  if (input.execution.goalCompleted) return "GOAL_COMPLETE";
  if (input.execution.safetyBlocked || input.execution.approvalRequired) {
    return "SAFETY_STOP";
  }
  if (input.adaptive.escalationRequired && !input.adaptive.escalationOccurred) {
    return "ESCALATION_FAILURE";
  }
  if (input.errors.length > 0) {
    if (
      input.trace.steps.some(
        (step) => step.evaluation && !step.evaluation.shouldContinue
      )
    ) {
      return "EVALUATOR_STOP";
    }
    return "ACTION_FAILURE";
  }
  if (input.adaptive.diagnosticBudgetExhausted) return "MAX_STEPS";
  if (input.agentStepCount >= (input.adaptive.maxSteps ?? input.scenario.maxSteps)) {
    return "MAX_STEPS";
  }
  if (
    input.plannerDecisions.at(-1)?.outcome === "null_action" ||
    input.agentCompleted
  ) {
    return "PLANNER_NULL";
  }
  return "OTHER";
}

function failureFactors(
  input: AdaptiveRunDiagnosticInput,
  audits: readonly RepeatedStateTriggerAudit[],
  opportunityLoss: AdaptiveOpportunityLoss,
  termination: AdaptiveTerminationReason
): AdaptiveEscalationFailureReason[] {
  const factors: AdaptiveEscalationFailureReason[] = [];
  const handoff = input.adaptive.handoffSnapshot;
  if (!handoff || !handoff.goal || handoff.interactiveElements.length === 0) {
    factors.push("HANDOFF_CONTEXT_INSUFFICIENT");
  }
  if (handoff && sanitize(input.scenario.plannerGoal) !== handoff.goal) {
    factors.push("GOAL_ALREADY_MISFRAMED");
  }
  if (termination === "MAX_STEPS") {
    factors.push("POST_ESCALATION_BUDGET_EXHAUSTED");
  }
  if (["medium", "high"].includes(opportunityLoss.level)) {
    factors.push("PRE_ESCALATION_STATE_DAMAGE");
  }
  if (
    audits.some((audit) =>
      ["BENIGN_REPEAT", "SEMANTIC_PROGRESS_SAME_FINGERPRINT"].includes(
        audit.classification
      )
    )
  ) {
    factors.push("REPEATED_STATE_FALSE_TRIGGER");
  }
  if (
    input.plannerDecisions.some((decision) =>
      ["invalid_action", "parser_failure", "action_not_applicable"].includes(
        decision.outcome
      )
    )
  ) {
    factors.push("OLLAMA_INVALID_ACTION");
  }
  const postActions = input.execution.actions.slice(input.adaptive.deterministicSteps);
  if (
    postActions.length > 0 &&
    postActions.filter(
      (action) =>
        !action.success || action.fromStateFingerprint === action.toStateFingerprint
    ).length /
      postActions.length >=
      0.5
  ) {
    factors.push("OLLAMA_NON_PROGRESS_ACTION");
  }
  if (termination === "PLANNER_NULL" && input.adaptive.remainingStepBudgetAtHandoff) {
    factors.push("EARLY_TERMINATION", "EVALUATOR_COMPLETION_MISMATCH");
  }
  if (termination === "SAFETY_STOP") factors.push("SAFETY_BLOCK");
  if (termination === "ACTION_FAILURE") factors.push("BROWSER_ACTION_FAILURE");
  if (factors.length === 0) factors.push("UNKNOWN_FAILURE");
  return [...new Set(factors)];
}

function selectPrimaryFailure(
  factors: readonly AdaptiveEscalationFailureReason[]
): AdaptiveEscalationFailureReason {
  const priority: readonly AdaptiveEscalationFailureReason[] = [
    "POST_ESCALATION_BUDGET_EXHAUSTED",
    "SAFETY_BLOCK",
    "BROWSER_ACTION_FAILURE",
    "OLLAMA_INVALID_ACTION",
    "EARLY_TERMINATION",
    "OLLAMA_NON_PROGRESS_ACTION",
    "REPEATED_STATE_FALSE_TRIGGER",
    "PRE_ESCALATION_STATE_DAMAGE",
    "HANDOFF_CONTEXT_INSUFFICIENT",
    "GOAL_ALREADY_MISFRAMED",
    "EVALUATOR_COMPLETION_MISMATCH",
    "UNKNOWN_FAILURE"
  ];
  return priority.find((reason) => factors.includes(reason)) ?? "UNKNOWN_FAILURE";
}

function classifyRepeatedStateTrigger(
  event: AdaptiveExecutionMetadata["progressEvents"][number]
): RepeatedStateTriggerQuality {
  if (!event.previousMatchingFingerprint) return "UNKNOWN";
  if (
    event.evaluatorReportedProgress === true ||
    (event.progressed &&
      !event.urlChanged &&
      !event.visibleTextChanged &&
      !event.interactiveElementsChanged)
  ) {
    return "SEMANTIC_PROGRESS_SAME_FINGERPRINT";
  }
  if (
    event.urlChanged ||
    event.visibleTextChanged ||
    event.interactiveElementsChanged
  ) {
    return "BENIGN_REPEAT";
  }
  return event.progressed ? "BENIGN_REPEAT" : "TRUE_STAGNATION";
}

function scenarioFailureMetrics(runs: readonly GeneralizationRun[]) {
  const scenarioIds = [...new Set(runs.map((run) => run.scenarioId))];
  return scenarioIds.map((scenarioId) => {
    const scenarioRuns = runs.filter((run) => run.scenarioId === scenarioId);
    const adaptive = scenarioRuns.filter((run) => run.planner === "adaptive");
    const escalated = adaptive.filter((run) => run.adaptive?.escalationOccurred);
    const primaryFailures = adaptive.flatMap((run) =>
      run.adaptiveDiagnostics?.primaryFailureReason
        ? [run.adaptiveDiagnostics.primaryFailureReason]
        : []
    );
    const audits = adaptive.flatMap(
      (run) => run.adaptiveDiagnostics?.repeatedStateAudits ?? []
    );
    return {
      scenarioId,
      deterministicSuccessRate: plannerSuccessRate(scenarioRuns, "deterministic"),
      ollamaSuccessRate: plannerSuccessRate(scenarioRuns, "ollama"),
      hybridSuccessRate: plannerSuccessRate(scenarioRuns, "hybrid"),
      adaptiveSuccessRate: plannerSuccessRate(scenarioRuns, "adaptive"),
      escalationRate: rate(escalated.length, adaptive.length),
      successfulEscalationRate: rate(
        escalated.filter(successful).length,
        escalated.length
      ),
      dominantFailureReason: dominant(primaryFailures),
      averagePreEscalationSteps: average(
        adaptive.flatMap((run) =>
          run.adaptiveDiagnostics
            ? [run.adaptiveDiagnostics.stepsConsumedBeforeEscalation]
            : []
        )
      ),
      averagePostEscalationSteps: average(
        adaptive.flatMap((run) =>
          run.adaptiveDiagnostics
            ? [run.adaptiveDiagnostics.actualPostEscalationSteps]
            : []
        )
      ),
      terminationReasonCounts: countValues(
        TERMINATION_REASONS,
        adaptive.flatMap((run) =>
          run.adaptiveDiagnostics ? [run.adaptiveDiagnostics.terminationReason] : []
        )
      ),
      repeatedStateFalseTriggerRate: rate(
        audits.filter((audit) => audit.classification !== "TRUE_STAGNATION").length,
        audits.length
      ),
      opportunityLoss: dominantOpportunity(
        adaptive.flatMap((run) =>
          run.adaptiveDiagnostics ? [run.adaptiveDiagnostics.opportunityLoss.level] : []
        )
      )
    };
  });
}

function pureVsEscalatedComparison(runs: readonly GeneralizationRun[]) {
  const scenarioIds = [...new Set(runs.map((run) => run.scenarioId))];
  return scenarioIds.flatMap((scenarioId) => {
    const pure = runs.filter(
      (run) => run.scenarioId === scenarioId && run.planner === "ollama"
    );
    const adaptive = runs.filter(
      (run) => run.scenarioId === scenarioId && run.planner === "adaptive"
    );
    if (pure.length === 0 || adaptive.length === 0) return [];
    const pureInitialStates = new Set(
      pure.flatMap((run) =>
        run.observations[0]
          ? [comparableObservationState(run.observations[0].observation)]
          : []
      )
    );
    const adaptiveHandoffs = adaptive.flatMap((run) =>
      run.adaptiveDiagnostics?.handoffSnapshot
        ? [run.adaptiveDiagnostics.handoffSnapshot]
        : []
    );
    const pureDiscoveries = pure.filter(
      (run) => run.classification === "HIDDEN_BUG_FOUND"
    );
    return [
      {
        scenarioId,
        pureOllamaRuns: pure.length,
        escalatedOllamaRuns: adaptive.length,
        sameStartingStateRate: rate(
          adaptiveHandoffs.filter((handoff) =>
            pureInitialStates.has(comparableHandoffState(handoff))
          ).length,
          adaptiveHandoffs.length
        ),
        averagePureOllamaStepsAvailable: average(pure.map((run) => run.maxSteps)),
        averageEscalatedStepsAvailable: average(
          adaptive.flatMap((run) =>
            run.adaptiveDiagnostics
              ? [run.adaptiveDiagnostics.remainingStepsAtHandoff]
              : []
          )
        ),
        averagePurePromptCharacters: average(
          firstDecisionByRun(pure).map((item) => item.promptCharacterCount)
        ),
        averageEscalatedPromptCharacters: average(
          firstDecisionByRun(adaptive, true).map((item) => item.promptCharacterCount)
        ),
        averagePriorActionsAtHandoff: average(
          adaptiveHandoffs.map((handoff) => handoff.priorDeterministicActions.length)
        ),
        averageUnexploredElementsAtHandoff: average(
          adaptive.flatMap((run) =>
            run.adaptiveDiagnostics
              ? [
                  run.adaptiveDiagnostics.opportunityLoss
                    .unexploredInteractiveElementCount
                ]
              : []
          )
        ),
        pureHiddenDiscoveryRate: hiddenDiscoveryRate(pure),
        escalatedHiddenDiscoveryRate: hiddenDiscoveryRate(adaptive),
        pureGoalCompletionRate: goalCompletionRate(pure),
        escalatedGoalCompletionRate: goalCompletionRate(adaptive),
        pureRecoveryRate: recoveryRate(pure),
        escalatedRecoveryRate: recoveryRate(adaptive),
        averagePureStatesBeforeDiscovery: average(
          pureDiscoveries.map((run) => run.uniqueStatesBeforeDiscovery)
        ),
        averagePureActionsBeforeDiscovery: average(
          pureDiscoveries.flatMap((run) =>
            run.discoveryStep === null ? [] : [run.discoveryStep]
          )
        ),
        averagePureDiscoveryDurationMs: average(
          pureDiscoveries.map((run) => run.durationMs)
        ),
        averageAdaptiveStatesBeforeEscalation: average(
          adaptive.flatMap((run) => {
            const phase = run.adaptiveDiagnostics?.phases.find(
              (item) => item.phase === "deterministic"
            );
            return phase ? [new Set(phase.pageFingerprints).size] : [];
          })
        ),
        averageAdaptivePostEscalationActions: average(
          adaptive.flatMap((run) =>
            run.adaptiveDiagnostics
              ? [run.adaptiveDiagnostics.actualPostEscalationSteps]
              : []
          )
        ),
        pureDiscoveryPathShape: dominantPathShape(
          pureDiscoveries.map((run) =>
            run.actions
              .slice(0, run.discoveryStep ?? run.actions.length)
              .map((action) => action.action.type)
              .join(" -> ")
          )
        ),
        adaptivePreEscalationPathShape: dominantPathShape(
          adaptive.map((run) =>
            run.actions
              .slice(0, run.adaptive?.deterministicSteps ?? 0)
              .map((action) => action.action.type)
              .join(" -> ")
          )
        ),
        dominantAdaptiveFailureReason: dominant(
          adaptive.flatMap((run) =>
            run.adaptiveDiagnostics?.primaryFailureReason
              ? [run.adaptiveDiagnostics.primaryFailureReason]
              : []
          )
        )
      }
    ];
  });
}

function firstDecisionByRun(
  runs: readonly GeneralizationRun[],
  adaptive = false
): PlannerDecisionDiagnostic[] {
  return runs.flatMap((run) => {
    const decisions = adaptive
      ? run.adaptiveDiagnostics?.plannerDecisions
      : run.plannerDecisions;
    return decisions?.[0] ? [decisions[0]] : [];
  });
}

function plannerSuccessRate(
  runs: readonly GeneralizationRun[],
  planner: GeneralizationRun["planner"]
): number | null {
  const selected = runs.filter((run) => run.planner === planner);
  if (selected.length === 0) return null;
  return rate(selected.filter(successful).length, selected.length);
}

function hiddenDiscoveryRate(runs: readonly GeneralizationRun[]): number {
  const opportunities = runs.filter((run) => run.expectedBugIds.length > 0);
  return rate(
    opportunities.filter((run) => run.classification === "HIDDEN_BUG_FOUND").length,
    opportunities.length
  );
}

function goalCompletionRate(runs: readonly GeneralizationRun[]): number {
  const opportunities = runs.filter((run) => run.expectedBugIds.length === 0);
  return rate(
    opportunities.filter((run) => run.goalCompleted).length,
    opportunities.length
  );
}

function recoveryRate(runs: readonly GeneralizationRun[]): number {
  const opportunities = runs.filter((run) => run.recoveryRequired);
  return rate(
    opportunities.filter((run) => run.recoverySucceeded).length,
    opportunities.length
  );
}

function successful(run: GeneralizationRun): boolean {
  return (
    run.classification === "HIDDEN_BUG_FOUND" || run.classification === "GOAL_COMPLETED"
  );
}

function summarizeAction(action: BrowserAction): AdaptiveActionSummary {
  if ("selector" in action) return { type: action.type, target: action.selector };
  if ("url" in action) return { type: action.type, target: action.url };
  return { type: action.type, target: null };
}

function sanitize(value: string): string {
  return value
    .replace(/BUG-BENCH-\d{3}/gi, "[REDACTED-BUG-ID]")
    .replace(
      /((?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi,
      "$1[REDACTED]"
    );
}

function comparableObservationState(observation: Observation): string {
  return JSON.stringify({
    url: normalizedUrl(observation.url),
    title: normalizedText(observation.title),
    text: normalizedText(observation.textSample),
    elements: observation.elements
      .filter((element) => element.visible)
      .map((element) => element.selector)
      .sort()
  });
}

function comparableHandoffState(
  handoff: NonNullable<AdaptiveExecutionMetadata["handoffSnapshot"]>
): string {
  return JSON.stringify({
    url: normalizedUrl(handoff.currentUrl),
    title: normalizedText(handoff.pageTitle),
    text: normalizedText(handoff.visibleTextSummary),
    elements: handoff.interactiveElements.map((element) => element.selector).sort()
  });
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function countValues<T extends string>(
  values: readonly T[],
  observed: readonly T[]
): Record<T, number> {
  return Object.fromEntries(
    values.map((value) => [value, observed.filter((item) => item === value).length])
  ) as Record<T, number>;
}

function dominant<T extends string>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return (
    [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
  );
}

function dominantOpportunity(
  values: readonly OpportunityLossLevel[]
): OpportunityLossLevel {
  const rank: Record<OpportunityLossLevel, number> = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3
  };
  return [...values].sort((left, right) => rank[right] - rank[left])[0] ?? "none";
}

function dominantPathShape(values: readonly string[]): string {
  return dominant(values.filter(Boolean)) ?? "none";
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
