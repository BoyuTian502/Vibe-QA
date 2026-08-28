import type { AdaptiveExecutionMetrics } from "./types.js";

export function formatAdaptiveExecutionSummary(
  metrics: AdaptiveExecutionMetrics
): string {
  return [
    "Benchmark V5 - Adaptive Progressive Escalation",
    `Escalation rate: ${percentage(metrics.escalationRate)} (${metrics.escalationCount}/${metrics.totalAdaptiveRuns})`,
    `Avoided LLM rate: ${percentage(metrics.avoidedLlmRate)} (${metrics.avoidedLlmCount}/${metrics.totalAdaptiveRuns})`,
    `Successful escalation rate: ${percentage(metrics.successfulEscalationRate)} (${metrics.successfulEscalationCount}/${metrics.escalationCount})`,
    `Ollama invocations: ${metrics.ollamaInvocationCount}`,
    `Mean steps before escalation: ${decimal(metrics.preEscalationSteps.mean)}`,
    `Mean steps after escalation: ${decimal(metrics.postEscalationSteps.mean)}`,
    `Early / stagnation escalations: ${metrics.earlyEscalationCount} / ${metrics.stagnationEscalationCount}`,
    `Opportunity retained at handoff: ${percentage(metrics.opportunityRetainedAtHandoff.mean)}`,
    `Planner null rate after handoff: ${percentage(metrics.plannerNullRateAfterHandoff)}`,
    `Null recovery rate: ${percentage(metrics.nullRecoveryRate)}`
  ].join("\n");
}

export function formatAdaptiveExecutionMarkdown(
  metrics: AdaptiveExecutionMetrics,
  interpretation: readonly string[]
): string {
  return [
    "## Benchmark V5 - Adaptive Progressive Escalation",
    "",
    'Research question: "Can adaptive escalation retain deterministic efficiency while invoking Ollama only when runtime progress signals indicate it is useful?"',
    "",
    "### Adaptive V2 - Opportunity-Preserving Progressive Escalation",
    "",
    'V2 question: "Can Adaptive hand off before deterministic execution consumes valuable exploration opportunity?"',
    "",
    "### Adaptive Execution Summary",
    "",
    `- Adaptive runs: ${metrics.totalAdaptiveRuns}`,
    `- Escalation rate: ${percentage(metrics.escalationRate)} (${metrics.escalationCount})`,
    `- Avoided LLM rate: ${percentage(metrics.avoidedLlmRate)} (${metrics.avoidedLlmCount})`,
    `- Successful escalation rate: ${percentage(metrics.successfulEscalationRate)} (${metrics.successfulEscalationCount}/${metrics.escalationCount})`,
    `- Adaptive task success: ${percentage(metrics.taskSuccessRate)}`,
    `- Ollama invocation count: ${metrics.ollamaInvocationCount}`,
    `- Pre-escalation steps, mean / median: ${decimal(metrics.preEscalationSteps.mean)} / ${decimal(metrics.preEscalationSteps.median)}`,
    `- Post-escalation steps, mean / median: ${decimal(metrics.postEscalationSteps.mean)} / ${decimal(metrics.postEscalationSteps.median)}`,
    `- Time before escalation, mean / median: ${seconds(metrics.timeBeforeEscalationMs.mean)} / ${seconds(metrics.timeBeforeEscalationMs.median)}`,
    `- Time after escalation, mean / median: ${seconds(metrics.timeAfterEscalationMs.mean)} / ${seconds(metrics.timeAfterEscalationMs.median)}`,
    `- Early escalation rate: ${percentage(metrics.earlyEscalationRate)} (${metrics.earlyEscalationCount})`,
    `- Stagnation escalation rate: ${percentage(metrics.stagnationEscalationRate)} (${metrics.stagnationEscalationCount})`,
    `- Opportunity-preserving escalation rate: ${percentage(metrics.opportunityPreservingEscalationRate)} (${metrics.opportunityPreservingEscalationCount})`,
    `- Opportunity retained at handoff, mean / median: ${percentage(metrics.opportunityRetainedAtHandoff.mean)} / ${percentage(metrics.opportunityRetainedAtHandoff.median)}`,
    `- Safe candidates remaining at handoff, mean / median: ${decimal(metrics.safeCandidatesRemainingAtHandoff.mean)} / ${decimal(metrics.safeCandidatesRemainingAtHandoff.median)}`,
    `- Planner null rate after handoff: ${percentage(metrics.plannerNullRateAfterHandoff)} (${metrics.plannerNullDecisionCount}/${metrics.postHandoffPlannerDecisionCount})`,
    `- Null recovery rate: ${percentage(metrics.nullRecoveryRate)} (${metrics.nullRecoveryCount}/${metrics.completionGateRejectionCount})`,
    `- Completion-gate rejections: ${metrics.completionGateRejectionCount}`,
    `- Post-handoff action utilization, mean / median: ${percentage(metrics.postHandoffActionUtilization.mean)} / ${percentage(metrics.postHandoffActionUtilization.median)}`,
    `- Hidden discovery after early handoff: ${percentage(metrics.hiddenDiscoveryAfterEarlyHandoffRate)} (${metrics.hiddenDiscoveryAfterEarlyHandoffCount})`,
    `- Hidden discovery after late handoff: ${percentage(metrics.hiddenDiscoveryAfterLateHandoffRate)} (${metrics.hiddenDiscoveryAfterLateHandoffCount})`,
    `- Handoff-state similarity to the Adaptive initial state: ${percentage(metrics.handoffStateSimilarityToInitialStateRate)}`,
    "",
    "### Escalation Utility",
    "",
    ...Object.entries(metrics.utilityCounts).map(
      ([utility, count]) => `- ${utility}: ${count}`
    ),
    `- Unclassified unsuccessful non-escalated runs: ${metrics.unclassifiedRuns}`,
    "",
    "### Threshold Analysis",
    "",
    "| Profile | Projected escalations | Projected escalation rate |",
    "| --- | ---: | ---: |",
    ...metrics.thresholdAnalysis.map(
      (profile) =>
        `| ${profile.profile} | ${profile.projectedEscalations} | ${percentage(profile.projectedEscalationRate)} |`
    ),
    "",
    "### Measured Interpretation",
    "",
    ...interpretation.map((line) => `- ${line}`)
  ].join("\n");
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function decimal(value: number): string {
  return value.toFixed(1);
}

function seconds(value: number): string {
  return `${(value / 1000).toFixed(1)}s`;
}
