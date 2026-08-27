export type RoutedPlanner = "deterministic" | "ollama";

export type HybridTaskMode = "functional" | "exploratory" | "regression";

export type HybridRoutingRuleId =
  | "regression-controlled"
  | "functional-known-workflow"
  | "explicit-exploration"
  | "hidden-issue-discovery"
  | "recovery-without-known-path"
  | "ambiguous-semantic-default"
  | "conservative-default";

export interface HybridTaskMetadata {
  mode: HybridTaskMode;
  objective: string;
  hasExpectedBehavior: boolean;
  exactWorkflowKnown: boolean;
  explicitlyExploratory?: boolean;
  hiddenIssueDiscoveryRequested?: boolean;
  recoveryRequired?: boolean;
  semanticGoalAmbiguous?: boolean;
  maxSteps?: number;
  authenticationRequired?: boolean;
}

export interface HybridRoutingDecision {
  planner: RoutedPlanner;
  ruleId: HybridRoutingRuleId;
  reason: string;
}

export class HybridTaskRouter {
  route(task: HybridTaskMetadata): HybridRoutingDecision {
    if (task.mode === "regression") {
      return decision(
        "deterministic",
        "regression-controlled",
        "Controlled regression workflows favor deterministic speed and repeatability."
      );
    }

    if (
      task.mode === "functional" &&
      task.hasExpectedBehavior &&
      task.exactWorkflowKnown
    ) {
      return decision(
        "deterministic",
        "functional-known-workflow",
        "The functional task provides an expected outcome and a known workflow."
      );
    }

    if (task.mode === "exploratory" || task.explicitlyExploratory === true) {
      return decision(
        "ollama",
        "explicit-exploration",
        "The task explicitly requests autonomous exploration."
      );
    }

    if (
      task.hiddenIssueDiscoveryRequested === true ||
      hasHiddenIssueDiscoveryIntent(task.objective)
    ) {
      return decision(
        "ollama",
        "hidden-issue-discovery",
        "The task requests discovery of hidden, broken, or unexpected behavior."
      );
    }

    if (task.recoveryRequired === true && !task.exactWorkflowKnown) {
      return decision(
        "ollama",
        "recovery-without-known-path",
        "The task requires recovery or exploration without a predefined path."
      );
    }

    if (task.semanticGoalAmbiguous === true) {
      return decision(
        "deterministic",
        "ambiguous-semantic-default",
        "Hybrid V1 conservatively routes ambiguous non-exploratory goals to deterministic execution."
      );
    }

    return decision(
      "deterministic",
      "conservative-default",
      "No exploration-specific rule applies, so Hybrid V1 uses the deterministic default."
    );
  }
}

export function hasHiddenIssueDiscoveryIntent(objective: string): boolean {
  const normalized = objective
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normalized.length === 0) {
    return false;
  }
  const words = new Set(normalized.split(/\s+/));
  const discoveryWords = [
    "check",
    "discover",
    "explore",
    "find",
    "identify",
    "investigate",
    "search"
  ];
  const issueWords = [
    "anomalies",
    "anomaly",
    "broken",
    "bug",
    "bugs",
    "failure",
    "failures",
    "issue",
    "issues",
    "problem",
    "problems",
    "unexpected"
  ];
  return (
    discoveryWords.some((word) => words.has(word)) &&
    issueWords.some((word) => words.has(word))
  );
}

function decision(
  planner: RoutedPlanner,
  ruleId: HybridRoutingRuleId,
  reason: string
): HybridRoutingDecision {
  return Object.freeze({ planner, ruleId, reason });
}
