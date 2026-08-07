import type { BrowserAction, Observation } from "@vibeqa/schemas";

export interface EvaluationResult {
  success: boolean;
  reason: string;
  shouldContinue: boolean;
}

export class Evaluator {
  evaluate(
    previousAction: BrowserAction,
    newObservation: Observation
  ): EvaluationResult {
    if (newObservation.consoleErrors.length > 0) {
      return {
        success: false,
        reason: `The page reported ${newObservation.consoleErrors.length} console error(s).`,
        shouldContinue: true
      };
    }

    if (previousAction.type === "goto" || previousAction.type === "navigate") {
      const reachedTarget =
        normalizeUrl(newObservation.url) === normalizeUrl(previousAction.url);

      return reachedTarget
        ? {
            success: true,
            reason: `Navigation reached ${newObservation.url}.`,
            shouldContinue: true
          }
        : {
            success: false,
            reason: `Navigation expected ${previousAction.url} but reached ${newObservation.url}.`,
            shouldContinue: false
          };
    }

    if (previousAction.type === "assert") {
      const element = newObservation.elements.find(
        (candidate) => candidate.selector === previousAction.selector
      );
      const passed = element?.text.includes(previousAction.containsText) ?? false;

      return passed
        ? {
            success: true,
            reason: `Assertion passed for ${previousAction.selector}.`,
            shouldContinue: true
          }
        : {
            success: false,
            reason: `Assertion failed for ${previousAction.selector}.`,
            shouldContinue: false
          };
    }

    return {
      success: true,
      reason: `The ${previousAction.type} action completed and the page remained observable.`,
      shouldContinue: true
    };
  }
}

function normalizeUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
