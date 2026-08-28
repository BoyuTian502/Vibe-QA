import type { BrowserAction, ElementInformation, Observation } from "@vibeqa/schemas";

import type {
  AdaptiveActionSummary,
  OpportunityCandidate,
  OpportunityPreservationEvaluation,
  OpportunityReason
} from "./types.js";

export interface OpportunityPreservationInput {
  goal: string;
  observation: Observation;
  actionHistory: readonly BrowserAction[];
  proposedAction: BrowserAction | null;
  knownWorkflow?: boolean;
}

const DISCOVERY_GOAL =
  /\b(explor\w*|discover\w*|investigat\w*|find\b|locate\b|review\b|inspect\w*|failure\w*|broken\b|issue\w*)\b/i;
const SEMANTIC_GOAL =
  /\b(check whether|verify\b|confirm\b|understand\b|assess\b|workflow\b|experience\b|across\b|information views?)\b/i;
const RISKY_CONTROL =
  /\b(delete|remove|destroy|purchase|checkout|buy|pay|send|upload|save|submit|invite|publish)\b/i;

export class OpportunityPreservationEvaluator {
  evaluate(input: OpportunityPreservationInput): OpportunityPreservationEvaluation {
    const candidates = safeUnexploredCandidates(input);
    const navigationDestinations = new Set(
      candidates.flatMap((candidate) =>
        candidate.action.type === "navigate" && candidate.action.target
          ? [normalizeUrl(candidate.action.target)]
          : []
      )
    ).size;
    const semanticDiversity = new Set(candidates.map((candidate) => candidate.category))
      .size;
    const pageRegions = new Set([
      ...input.observation.accessibility.landmarks.map(
        (landmark) => `${landmark.role}:${normalizeText(landmark.name ?? "")}`
      ),
      ...input.observation.accessibility.headings.map(
        (heading) => `heading-${heading.level}:${normalizeText(heading.text)}`
      )
    ]).size;
    const discoveryOrientedGoal = DISCOVERY_GOAL.test(input.goal);
    const semanticJudgmentGoal = SEMANTIC_GOAL.test(input.goal);
    const highBranchingState =
      candidates.length >= 4 && (navigationDestinations >= 2 || semanticDiversity >= 3);
    const nextActionNarrowsState = actionNarrowsState(
      input.proposedAction,
      input.observation,
      candidates.length
    );
    const reasons: OpportunityReason[] = [];
    if (input.knownWorkflow) reasons.push("known-workflow");
    if (discoveryOrientedGoal) reasons.push("exploratory-objective");
    if (semanticJudgmentGoal) reasons.push("semantic-uncertainty");
    if (highBranchingState) reasons.push("high-branching-state");
    if (navigationDestinations >= 2) {
      reasons.push("multiple-navigation-destinations");
    }
    if (semanticDiversity >= 3) reasons.push("diverse-controls");
    if (pageRegions >= 3) reasons.push("multiple-page-regions");
    if (nextActionNarrowsState) reasons.push("next-action-narrows-state");
    if (candidates.length < 3) reasons.push("limited-unexplored-opportunity");

    const score =
      Math.min(candidates.length, 6) +
      Math.min(navigationDestinations, 3) * 1.5 +
      Math.min(semanticDiversity, 4) +
      Math.min(pageRegions, 3) * 0.5 +
      (discoveryOrientedGoal ? 2 : 0) +
      (semanticJudgmentGoal ? 1 : 0);
    const risk =
      !input.knownWorkflow && highBranchingState && score >= 9
        ? "high"
        : !input.knownWorkflow && candidates.length >= 3 && score >= 6
          ? "medium"
          : "low";

    return {
      risk,
      reasons,
      score,
      discoveryOrientedGoal,
      semanticJudgmentGoal,
      highBranchingState,
      nextActionNarrowsState,
      safeUnexploredCandidates: candidates,
      distinctNavigationDestinations: navigationDestinations,
      semanticControlDiversity: semanticDiversity,
      unexploredPageRegions: pageRegions,
      shouldEscalateBeforeAction:
        risk === "high" &&
        nextActionNarrowsState &&
        (discoveryOrientedGoal || semanticJudgmentGoal)
    };
  }
}

function safeUnexploredCandidates(
  input: OpportunityPreservationInput
): OpportunityCandidate[] {
  const attempted = new Set(input.actionHistory.map(actionIdentity));
  const candidates = new Map<string, OpportunityCandidate>();
  const selectorCounts = new Map<string, number>();
  for (const element of input.observation.elements.filter(
    (element) => element.visible && element.enabled
  )) {
    selectorCounts.set(
      element.selector,
      (selectorCounts.get(element.selector) ?? 0) + 1
    );
  }

  for (const element of input.observation.elements) {
    const candidate = candidateFor(element, selectorCounts);
    if (!candidate) continue;
    const identity = summaryIdentity(candidate.action);
    if (attempted.has(identity) || candidates.has(identity)) continue;
    candidates.set(identity, candidate);
  }
  return [...candidates.values()].sort((left, right) =>
    summaryIdentity(left.action).localeCompare(summaryIdentity(right.action))
  );
}

function candidateFor(
  element: ElementInformation,
  selectorCounts: ReadonlyMap<string, number>
): OpportunityCandidate | null {
  if (!element.visible || !element.enabled || element.editable) return null;
  const label = normalizeText(
    element.accessibleName ?? element.text ?? element.selector
  ).slice(0, 120);
  if (RISKY_CONTROL.test(label)) return null;

  let action: AdaptiveActionSummary | null = null;
  if (element.tagName === "a" && element.href) {
    action = { type: "navigate", target: element.href };
  } else if (
    selectorCounts.get(element.selector) === 1 &&
    (element.tagName === "button" ||
      ["button", "link", "navigation", "menuitem", "tab"].includes(element.role ?? ""))
  ) {
    action = { type: "click", target: element.selector };
  }
  if (!action) return null;
  return { action, label, category: controlCategory(element, label) };
}

function controlCategory(element: ElementInformation, label: string): string {
  if (element.href || ["link", "navigation", "menuitem"].includes(element.role ?? "")) {
    return "navigation";
  }
  if (element.role === "tab") return "view";
  if (/\b(log out|logout|sign out)\b/.test(label)) return "session";
  if (/\b(project|workflow|settings|dashboard|workspace)\b/.test(label)) {
    return "workflow";
  }
  if (/\b(help|refresh|inspect|activity|notification)\b/.test(label)) {
    return "information";
  }
  return element.role ?? element.tagName;
}

function actionNarrowsState(
  action: BrowserAction | null,
  observation: Observation,
  candidateCount: number
): boolean {
  if (!action || candidateCount < 3) return false;
  if (action.type === "goto" || action.type === "navigate") {
    return normalizeUrl(action.url) !== normalizeUrl(observation.url);
  }
  if (action.type !== "click") return false;
  const element = observation.elements.find(
    (candidate) => candidate.visible && candidate.selector === action.selector
  );
  return Boolean(
    element?.href ||
    ["link", "navigation", "menuitem"].includes(element?.role ?? "") ||
    /\b(settings|project|workflow|log out|logout|sign out)\b/i.test(
      `${element?.accessibleName ?? ""} ${element?.text ?? ""}`
    )
  );
}

function actionIdentity(action: BrowserAction): string {
  if ("selector" in action) return `${action.type}:${action.selector}`;
  if ("url" in action) return `${action.type}:${normalizeUrl(action.url)}`;
  return action.type;
}

function summaryIdentity(action: AdaptiveActionSummary): string {
  return `${action.type}:${action.target ?? ""}`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}
