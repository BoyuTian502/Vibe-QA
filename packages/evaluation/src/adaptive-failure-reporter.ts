import type {
  AdaptiveFailureAnalysisMetrics,
  GeneralizationSuiteResult
} from "./generalization-types.js";

export function formatAdaptiveFailureAnalysisSummary(
  metrics: AdaptiveFailureAnalysisMetrics
): string {
  return [
    "Adaptive Escalation Failure Analysis",
    `Failed escalations: ${metrics.failedEscalatedRuns}/${metrics.totalEscalatedRuns}`,
    `Mean remaining budget at handoff: ${decimal(metrics.meanRemainingBudgetAtEscalation)} steps`,
    `Mean actual post-escalation actions: ${decimal(metrics.meanActualPostEscalationSteps)}`,
    `Repeated-state false-trigger rate: ${percentage(metrics.repeatedStateFalseTriggerRate)}`,
    `Dominant failed-escalation reason: ${dominant(metrics.failureTaxonomyCounts) ?? "none"}`,
    `Dominant termination reason: ${dominant(metrics.terminationReasonCounts) ?? "none"}`
  ].join("\n");
}

export function formatAdaptiveFailureAnalysisMarkdown(
  result: GeneralizationSuiteResult
): string {
  const metrics = result.metrics.adaptiveFailureAnalysis;
  if (!metrics)
    return "## Adaptive Escalation Failure Analysis\n\nNo diagnostic sample is available.";
  const hiddenScenarioIds = new Set(
    result.scenarios
      .filter((scenario) => scenario.category === "hidden_bug")
      .map((scenario) => scenario.id)
  );
  const replayBudget = result.configuration.adaptivePostEscalationStepBudget;
  return [
    "## Adaptive Escalation Failure Analysis",
    "",
    "All classifications in this section are evaluator-side diagnostics. They are produced after execution and are never exposed to the runtime planner.",
    "",
    "### Failure Taxonomy Distribution",
    "",
    ...countList(metrics.failureTaxonomyCounts),
    "",
    "Contributing factors:",
    ...countList(metrics.contributingFactorCounts),
    "",
    "### Termination Reason Distribution",
    "",
    ...countList(metrics.terminationReasonCounts),
    "",
    "### Post-Escalation Budget Audit",
    "",
    `- Mean remaining total budget at handoff: ${decimal(metrics.meanRemainingBudgetAtEscalation)} actions`,
    `- Mean actions actually executed after handoff: ${decimal(metrics.meanActualPostEscalationSteps)}`,
    `- Diagnostic replay: ${result.configuration.adaptiveDebugReplay ? "enabled" : "disabled"}`,
    `- Requested diagnostic post-escalation cap: ${replayBudget ?? "production default"}`,
    "",
    "### Repeated-State Trigger Quality",
    "",
    ...countList(metrics.repeatedStateTriggerCounts),
    `- Measured false-trigger rate: ${percentage(metrics.repeatedStateFalseTriggerRate)}`,
    "",
    "### Opportunity Loss Before Escalation",
    "",
    ...countList(metrics.opportunityLossCounts),
    "",
    "### Ollama Decision Outcomes",
    "",
    ...countList(metrics.plannerDecisionCounts),
    "",
    "### Pure Ollama vs Escalated Ollama",
    "",
    "| Scenario | Same start state | Pure / escalated steps available | Pure / escalated prompt chars | Prior actions | Unexplored elements | Hidden discovery | Goal completion | Recovery |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...metrics.pureVsEscalated.map(
      (item) =>
        `| ${item.scenarioId} | ${percentage(item.sameStartingStateRate)} | ${decimal(item.averagePureOllamaStepsAvailable)} / ${decimal(item.averageEscalatedStepsAvailable)} | ${integer(item.averagePurePromptCharacters)} / ${integer(item.averageEscalatedPromptCharacters)} | ${decimal(item.averagePriorActionsAtHandoff)} | ${decimal(item.averageUnexploredElementsAtHandoff)} | ${percentage(item.pureHiddenDiscoveryRate)} / ${percentage(item.escalatedHiddenDiscoveryRate)} | ${percentage(item.pureGoalCompletionRate)} / ${percentage(item.escalatedGoalCompletionRate)} | ${percentage(item.pureRecoveryRate)} / ${percentage(item.escalatedRecoveryRate)} |`
    ),
    ...(metrics.pureVsEscalated.length === 0
      ? ["No same-run pure Ollama comparison sample is available."]
      : []),
    "",
    "### Scenario-Level Failure Breakdown",
    "",
    "| Scenario | Det | Ollama | Hybrid | Adaptive | Escalation | Successful escalation | Dominant failure | Pre / post steps | False trigger | Opportunity loss |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |",
    ...metrics.scenarioFailures.map(
      (item) =>
        `| ${item.scenarioId} | ${percentageOrNA(item.deterministicSuccessRate)} | ${percentageOrNA(item.ollamaSuccessRate)} | ${percentageOrNA(item.hybridSuccessRate)} | ${percentageOrNA(item.adaptiveSuccessRate)} | ${percentage(item.escalationRate)} | ${percentage(item.successfulEscalationRate)} | ${item.dominantFailureReason ?? "none"} | ${decimal(item.averagePreEscalationSteps)} / ${decimal(item.averagePostEscalationSteps)} | ${percentage(item.repeatedStateFalseTriggerRate)} | ${item.opportunityLoss} |`
    ),
    "",
    "Termination frequencies by scenario:",
    ...metrics.scenarioFailures.map(
      (item) => `- ${item.scenarioId}: ${nonZeroCounts(item.terminationReasonCounts)}`
    ),
    "",
    "### Hidden-Discovery Deep Dive",
    "",
    ...metrics.pureVsEscalated
      .filter((item) => hiddenScenarioIds.has(item.scenarioId))
      .flatMap((item) => [
        `#### ${item.scenarioId}`,
        "",
        `- Pure Ollama hidden discovery: ${percentage(item.pureHiddenDiscoveryRate)}`,
        `- Escalated Ollama hidden discovery: ${percentage(item.escalatedHiddenDiscoveryRate)}`,
        `- Handoff matched a pure initial state in ${percentage(item.sameStartingStateRate)} of Adaptive runs.`,
        `- Ollama received ${decimal(item.averageEscalatedStepsAvailable)} remaining actions after ${decimal(item.averagePriorActionsAtHandoff)} deterministic actions, versus ${decimal(item.averagePureOllamaStepsAvailable)} actions from the initial state.`,
        `- Mean still-unexplored interactive elements at handoff: ${decimal(item.averageUnexploredElementsAtHandoff)}.`,
        `- Pure Ollama reached discovery after ${decimal(item.averagePureActionsBeforeDiscovery)} actions and ${decimal(item.averagePureStatesBeforeDiscovery)} unique states on successful runs; mean full-run duration was ${seconds(item.averagePureDiscoveryDurationMs)}.`,
        `- Dominant pure discovery path: ${item.pureDiscoveryPathShape}.`,
        `- Adaptive reached handoff after ${decimal(item.averageAdaptiveStatesBeforeEscalation)} unique deterministic states, then executed ${decimal(item.averageAdaptivePostEscalationActions)} Ollama actions on average.`,
        `- Dominant Adaptive pre-escalation path: ${item.adaptivePreEscalationPathShape}.`,
        `- Dominant Adaptive failure reason: ${item.dominantAdaptiveFailureReason ?? "none"}.`
      ]),
    ...(metrics.pureVsEscalated.some((item) => hiddenScenarioIds.has(item.scenarioId))
      ? []
      : [
          "A pure Ollama comparison sample is required for the hidden-discovery path analysis."
        ]),
    "",
    "### Diagnostic Interpretation",
    "",
    `- Implementation defect evidence: budget exhaustion accounts for ${metrics.failureTaxonomyCounts.POST_ESCALATION_BUDGET_EXHAUSTED} primary failures; planner-null and invalid-output evidence should be considered separately before changing production limits.`,
    `- Policy weakness evidence: repeated-state false triggers measured ${percentage(metrics.repeatedStateFalseTriggerRate)}, while opportunity loss was medium/high in ${metrics.opportunityLossCounts.medium + metrics.opportunityLossCounts.high} escalated runs.`,
    `- Model limitation evidence: post-handoff decision outcomes include ${metrics.plannerDecisionCounts.null_action} null decisions and ${metrics.plannerDecisionCounts.invalid_action + metrics.plannerDecisionCounts.parser_failure + metrics.plannerDecisionCounts.action_not_applicable} invalid or inapplicable outputs.`,
    "- Benchmark limitation: these deterministic local scenarios isolate useful failure modes but do not establish causality for arbitrary websites or models.",
    "- No production threshold or budget change is inferred automatically from this report."
  ].join("\n");
}

function countList(values: Record<string, number>): string[] {
  return Object.entries(values).map(([name, count]) => `- ${name}: ${count}`);
}

function nonZeroCounts(values: Record<string, number>): string {
  const entries = Object.entries(values).filter(([, count]) => count > 0);
  return entries.length === 0
    ? "none"
    : entries.map(([name, count]) => `${name}=${count}`).join(", ");
}

function dominant(values: Record<string, number>): string | null {
  return (
    Object.entries(values).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
  );
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function percentageOrNA(value: number | null): string {
  return value === null ? "N/A" : percentage(value);
}

function decimal(value: number): string {
  return value.toFixed(1);
}

function integer(value: number): string {
  return Math.round(value).toString();
}

function seconds(value: number): string {
  return `${(value / 1000).toFixed(2)}s`;
}
