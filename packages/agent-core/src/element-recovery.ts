import type { BrowserAction, Observation } from "@vibeqa/schemas";

export const ELEMENT_REPLAN_LIMIT = 2;
export const ELEMENT_RECOVERY_FAILED = "STALE_ELEMENT_RECOVERY_FAILED";

export class InvalidElementReferenceError extends Error {}

export function validateElementReference(
  action: BrowserAction,
  observation: Observation | null,
  failedSelectors: readonly string[]
): void {
  if (action.type !== "click" && action.type !== "type") return;
  if (failedSelectors.includes(action.selector)) {
    throw new InvalidElementReferenceError(
      "The target already failed; choose a different current-page action."
    );
  }
  const matches =
    observation?.elements.filter((element) => element.selector === action.selector) ??
    [];
  if (matches.length !== 1) {
    throw new InvalidElementReferenceError(
      "The target is absent or ambiguous in the current observation. Observation IDs are not CSS selectors."
    );
  }
  const element = matches[0];
  if (
    !element?.visible ||
    !element.enabled ||
    (action.type === "type" && !element.editable)
  ) {
    throw new InvalidElementReferenceError(
      "The target is not currently visible, enabled, or editable for this action."
    );
  }
}

export function isRecoverableElementError(
  error: unknown,
  action: BrowserAction
): boolean {
  if (action.type !== "click" && action.type !== "type") return false;
  if (error instanceof InvalidElementReferenceError) return true;
  if (!(error instanceof Error)) return false;
  // Only pre-interaction locator failures. Never replay a click that dispatched
  // and then timed out waiting for navigation or a response.
  const message = error.message;
  if (/click action done|fill action done|waiting for.*navigation/i.test(message))
    return false;
  return (
    /not attached to the DOM|element was detached|strict mode violation/i.test(
      message
    ) ||
    (/locator\.(?:click|fill|evaluate): Timeout/i.test(message) &&
      /waiting for locator\(/i.test(message) &&
      !/locator resolved/i.test(message))
  );
}
