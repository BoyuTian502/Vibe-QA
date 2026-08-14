import type { BrowserAction, ElementInformation, Observation } from "@vibeqa/schemas";

import { normalizeUrl } from "./fingerprint.js";
import type { ActionCandidate, ExplorationState } from "./types.js";

export interface CandidateGenerationOptions {
  inputValue?: string;
  maxFailuresPerAction?: number;
}

export function generateActionCandidates(
  observation: Observation,
  stateFingerprint: string,
  state: ExplorationState,
  options: CandidateGenerationOptions = {}
): ActionCandidate[] {
  const inputValue = options.inputValue ?? "VibeQA exploration";
  const maxFailures = options.maxFailuresPerAction ?? 1;
  const candidates = new Map<string, ActionCandidate>();

  for (const element of observation.elements) {
    if (!element.visible || !element.enabled) {
      continue;
    }

    const action = actionForElement(element, inputValue);
    if (!action) {
      continue;
    }

    const key = actionKey(action);
    const failures = state.failedActions.filter(
      (failedAction) => failedAction.actionKey === key
    ).length;
    const exploredFromState =
      state.executedActions.some(
        (record) =>
          record.fromStateFingerprint === stateFingerprint && record.actionKey === key
      ) ||
      state.failedActions.some(
        (record) =>
          record.stateFingerprint === stateFingerprint && record.actionKey === key
      );

    if (exploredFromState || failures >= maxFailures) {
      continue;
    }

    const elementKey = createElementKey(element);
    const { score, reasons } = scoreCandidate(action, element, elementKey, state);
    const candidate: ActionCandidate = {
      id: `candidate-${stateFingerprint}-${hashKey(key)}`,
      stateFingerprint,
      elementId: element.id,
      elementKey,
      action,
      score,
      reasons
    };
    const existing = candidates.get(key);
    if (!existing || candidate.score > existing.score) {
      candidates.set(key, candidate);
    }
  }

  return [...candidates.values()].sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id)
  );
}

export function actionKey(action: BrowserAction): string {
  switch (action.type) {
    case "goto":
    case "navigate":
      return `${action.type}:${normalizeUrl(action.url)}`;
    case "click":
    case "getText":
      return `${action.type}:${action.selector}`;
    case "type":
      return `${action.type}:${action.selector}:${action.value}`;
    case "wait":
      return `${action.type}:${action.ms}`;
    case "screenshot":
      return `${action.type}:${action.path ?? ""}`;
    case "assert":
      return `${action.type}:${action.selector}:${action.containsText}`;
    case "getCurrentUrl":
      return action.type;
  }
}

export function createElementKey(element: ElementInformation): string {
  return [
    element.tagName,
    element.role ?? "",
    element.selector,
    element.href ?? "",
    element.accessibleName ?? ""
  ].join(":");
}

function actionForElement(
  element: ElementInformation,
  inputValue: string
): BrowserAction | null {
  if (element.tagName === "a" && element.href) {
    return { type: "navigate", url: element.href };
  }

  if (element.editable) {
    const inputType = element.inputType?.toLowerCase() ?? "";
    if (["hidden", "password", "file", "submit", "button"].includes(inputType)) {
      return null;
    }
    if (["checkbox", "radio"].includes(inputType) || element.tagName === "select") {
      return { type: "click", selector: element.selector };
    }
    return { type: "type", selector: element.selector, value: inputValue };
  }

  if (
    element.tagName === "button" ||
    element.tagName === "a" ||
    ["button", "link", "navigation", "menuitem", "tab"].includes(element.role ?? "")
  ) {
    return { type: "click", selector: element.selector };
  }

  return null;
}

function scoreCandidate(
  action: BrowserAction,
  element: ElementInformation,
  elementKey: string,
  state: ExplorationState
): { score: number; reasons: string[] } {
  let score = 20;
  const reasons: string[] = [];
  const previouslyExecuted = state.executedActions.filter(
    (record) => record.actionKey === actionKey(action)
  ).length;

  if (action.type === "navigate") {
    const unseen = !state.visitedUrls.includes(normalizeUrl(action.url));
    score += unseen ? 100 : 15;
    reasons.push(unseen ? "unseen destination" : "previously visited destination");
  } else if (action.type === "click") {
    score += 45;
    reasons.push("interactive control");
  } else if (action.type === "type") {
    score += 30;
    reasons.push("unexplored editable field");
  }

  const elementPreviouslyExercised = state.executedActions.some(
    (record) => record.elementKey === elementKey
  );
  if (!elementPreviouslyExercised) {
    score += 25;
    reasons.push("unexplored element");
  }

  if (["navigation", "link", "tab"].includes(element.role ?? "")) {
    score += 10;
    reasons.push("navigation semantics");
  }

  if (previouslyExecuted > 0) {
    score -= previouslyExecuted * 10;
    reasons.push("repeated action penalty");
  }

  return { score, reasons };
}

function hashKey(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}
