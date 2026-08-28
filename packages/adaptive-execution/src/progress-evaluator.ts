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

  evaluate(input: RuntimeProgressInput): ProgressEvaluation {
    const fingerprint = pageFingerprint(input.observation);
    const visits = (this.stateVisits.get(fingerprint) ?? 0) + 1;
    this.stateVisits.set(fingerprint, visits);
    const currentElements = new Set(
      input.observation.elements
        .filter((element) => element.visible && element.enabled)
        .map(elementKey)
    );
    const newElements = [...currentElements].filter(
      (element) => !this.discoveredElements.has(element)
    );
    for (const element of currentElements) {
      this.discoveredElements.add(element);
    }

    const text = normalizeText(input.observation.textSample);
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

    this.noProgressCount = progressed ? 0 : this.noProgressCount + 1;
    this.failedActionCount = actionFailed ? this.failedActionCount + 1 : 0;
    this.evaluationFailureCount = evaluationFailed
      ? this.evaluationFailureCount + 1
      : 0;
    this.previousFingerprint = fingerprint;
    this.previousText = text;
    this.previousActionCount = input.actionHistory.length;

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
      repeatedStateCount: visits,
      noProgressCount: this.noProgressCount,
      failedActionCount: this.failedActionCount,
      evaluationFailureCount: this.evaluationFailureCount
    };
  }
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
