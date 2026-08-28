import type { ElementInformation, Observation } from "@vibeqa/schemas";

import type { ProgressEvaluation, RuntimeProgressInput } from "./types.js";

export class DeterministicProgressEvaluator {
  private previousFingerprint: string | null = null;
  private previousText = "";
  private readonly discoveredElements = new Set<string>();
  private readonly stateVisits = new Map<string, number>();
  private noProgressCount = 0;
  private failedActionCount = 0;
  private evaluationFailureCount = 0;
  private previousActionCount = 0;
  private previousUrl = "";
  private previousElementKeys = "";
  private readonly matchingStates = new Map<
    string,
    { actionCount: number; fingerprint: string }
  >();

  evaluate(input: RuntimeProgressInput): ProgressEvaluation {
    const fingerprint = pageFingerprint(input.observation);
    const visits = (this.stateVisits.get(fingerprint) ?? 0) + 1;
    this.stateVisits.set(fingerprint, visits);
    const currentElements = new Set(
      input.observation.elements
        .filter((element) => element.visible && element.enabled)
        .map(elementKey)
    );
    const currentElementKeys = [...currentElements].sort().join("|");
    const previousMatchingState = this.matchingStates.get(fingerprint);
    const actionsSincePreviousMatch = previousMatchingState
      ? input.actionHistory
          .slice(previousMatchingState.actionCount)
          .map(summarizeAction)
      : [];
    const newElements = [...currentElements].filter(
      (element) => !this.discoveredElements.has(element)
    );
    for (const element of currentElements) {
      this.discoveredElements.add(element);
    }

    const text = normalizeText(input.observation.textSample);
    const normalizedUrl = normalizeUrl(input.observation.url);
    const newState =
      this.previousFingerprint !== null && fingerprint !== this.previousFingerprint;
    const newRelevantText = this.previousText.length > 0 && text !== this.previousText;
    const firstObservation = this.previousFingerprint === null;
    const actionFailed = input.lastActionSucceeded === false;
    const evaluationFailed = input.evaluatorProgressed === false;
    const latestAction = input.actionHistory.at(-1);
    const meaningfulActionProgress =
      input.actionHistory.length > this.previousActionCount &&
      latestAction !== undefined &&
      ["type", "getText", "assert", "screenshot", "getCurrentUrl", "wait"].includes(
        latestAction.type
      );
    const progressed =
      firstObservation ||
      newState ||
      newRelevantText ||
      newElements.length > 0 ||
      meaningfulActionProgress ||
      input.evaluatorProgressed === true;
    const urlChanged =
      this.previousUrl.length > 0 && normalizedUrl !== this.previousUrl;
    const interactiveElementsChanged =
      this.previousElementKeys.length > 0 &&
      currentElementKeys !== this.previousElementKeys;

    this.noProgressCount = progressed ? 0 : this.noProgressCount + 1;
    this.failedActionCount = actionFailed ? this.failedActionCount + 1 : 0;
    this.evaluationFailureCount = evaluationFailed
      ? this.evaluationFailureCount + 1
      : 0;
    this.previousFingerprint = fingerprint;
    this.previousText = text;
    this.previousUrl = normalizedUrl;
    this.previousElementKeys = currentElementKeys;
    this.previousActionCount = input.actionHistory.length;
    this.matchingStates.set(fingerprint, {
      actionCount: input.actionHistory.length,
      fingerprint
    });

    const reasons: string[] = [];
    if (firstObservation) reasons.push("initial-state");
    if (newState) reasons.push("new-state");
    if (newRelevantText) reasons.push("new-relevant-text");
    if (newElements.length > 0) reasons.push("new-interactive-element");
    if (meaningfulActionProgress) reasons.push("meaningful-action-completed");
    if (visits > 1) reasons.push("repeated-state");
    if (actionFailed) reasons.push("failed-action");
    if (evaluationFailed) reasons.push("evaluation-failure");
    if (!progressed) reasons.push("no-progress");

    return {
      progressed,
      reasons,
      currentFingerprint: fingerprint,
      previousMatchingFingerprint: previousMatchingState?.fingerprint ?? null,
      actionsSincePreviousMatch,
      urlChanged,
      visibleTextChanged: newRelevantText,
      interactiveElementsChanged,
      evaluatorReportedProgress: input.evaluatorProgressed ?? null,
      repeatedStateCount: visits,
      noProgressCount: this.noProgressCount,
      failedActionCount: this.failedActionCount,
      evaluationFailureCount: this.evaluationFailureCount
    };
  }
}

function summarizeAction(action: RuntimeProgressInput["actionHistory"][number]): {
  type: typeof action.type;
  target: string | null;
} {
  if ("selector" in action) return { type: action.type, target: action.selector };
  if ("url" in action) return { type: action.type, target: action.url };
  return { type: action.type, target: null };
}

export function pageFingerprint(observation: Observation): string {
  const value = JSON.stringify({
    url: normalizeUrl(observation.url),
    title: normalizeText(observation.title),
    text: normalizeText(observation.textSample).slice(0, 1000),
    elements: observation.elements
      .filter((element) => element.visible)
      .map(elementKey)
      .sort()
  });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function elementKey(element: ElementInformation): string {
  return [
    element.tagName,
    element.role ?? "",
    element.selector,
    element.href ?? "",
    element.accessibleName ?? ""
  ].join(":");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
