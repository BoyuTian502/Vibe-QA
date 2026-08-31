import { Evaluator, type EvaluationResult } from "@vibeqa/agent-core";
import type { BrowserAction, NavigationMetadata, Observation } from "@vibeqa/schemas";

export interface PageErrorSignal {
  source: "http-status" | "page-not-found";
  statusCode: number | null;
  url: string;
  title: string;
  message: string;
}

export interface PageErrorFinding extends PageErrorSignal {
  screenshot: string | null;
  action: BrowserAction | null;
  path: BrowserAction[];
  severity: "medium" | "high";
}

export interface NavigationVerification {
  requestedUrl: string;
  finalUrl: string;
  redirected: boolean;
  responseStatus: number | null;
  redirectChain: string[];
  outcome: "reached" | "redirect-accepted" | "page-error" | "unverified";
}

export interface ExplorationEvaluationResult extends EvaluationResult {
  navigation?: NavigationVerification;
}

// Product exploration only. Explicit Functional/Regression URL assertions retain
// their existing strict evaluator; a redirect is evidence, not a blanket pass.
export class ExplorationEvaluator extends Evaluator {
  override evaluate(
    action: BrowserAction,
    observation: Observation
  ): ExplorationEvaluationResult {
    const pageError = detectPageError(observation);
    const navigationAction = action.type === "navigate" || action.type === "goto";
    const metadata = observation.metadata.navigation;
    const navigation: NavigationVerification | undefined = navigationAction
      ? {
          requestedUrl: action.url,
          finalUrl: observation.url,
          redirected: normalizeUrl(action.url) !== normalizeUrl(observation.url),
          responseStatus: metadata?.responseStatus ?? null,
          redirectChain: metadata?.redirectChain ?? [],
          outcome: "unverified"
        }
      : undefined;
    if (pageError) {
      return {
        success: false,
        reason: pageError.message,
        shouldContinue: false,
        ...(navigation ? { navigation: { ...navigation, outcome: "page-error" } } : {})
      };
    }
    if (navigationAction && navigation) {
      const direct = !navigation.redirected;
      const hasPage = Boolean(
        observation.textSample.trim() ||
        observation.elements.some((element) => element.visible)
      );
      const verifiedRedirect =
        metadata?.completed === true &&
        normalizeUrl(metadata.requestedUrl) === normalizeUrl(action.url) &&
        normalizeUrl(metadata.finalUrl) === normalizeUrl(observation.url) &&
        safeRedirectDestination(action.url, observation.url) &&
        metadata.redirectChain.every((url) =>
          safeRedirectDestination(action.url, url)
        ) &&
        (metadata.responseStatus === null ||
          (metadata.responseStatus >= 200 && metadata.responseStatus < 300));
      if (hasPage && (direct || verifiedRedirect)) {
        const evaluation = super.evaluate({ type: "getCurrentUrl" }, observation);
        return {
          ...evaluation,
          reason: evaluation.success
            ? direct
              ? `Navigation reached ${observation.url}.`
              : `Navigation redirected from ${action.url} to ${observation.url}; the destination is observable.`
            : evaluation.reason,
          navigation: {
            ...navigation,
            outcome: direct ? "reached" : "redirect-accepted"
          }
        };
      }
      return {
        success: false,
        shouldContinue: false,
        reason: `Navigation could not be verified from ${action.url} to ${observation.url}; redirect evidence or an observable safe destination is missing.`,
        navigation
      };
    }
    return super.evaluate(action, observation);
  }
}

export function detectPageError(observation: Observation): PageErrorSignal | null {
  const navigation = observation.metadata.navigation;
  const status = currentStatus(navigation, observation.url);
  if (status === 404 || (status !== null && status >= 500 && status <= 599)) {
    return {
      source: "http-status",
      statusCode: status,
      url: observation.url,
      title: observation.title,
      message: `Page error: HTTP ${status}${status === 404 ? " Not Found" : " server error"} at ${observation.url}.`
    };
  }
  const prominent = [
    observation.title,
    ...observation.accessibility.headings
      .filter((heading) => heading.level === 1)
      .map((heading) => heading.text)
  ];
  if ((status === null || status === 200) && prominent.some(isNotFoundLabel)) {
    return {
      source: "page-not-found",
      statusCode: status,
      url: observation.url,
      title: observation.title,
      message: `Page error: a prominent page-not-found label was observed at ${observation.url}${status === 200 ? " despite HTTP 200" : " (HTTP status unavailable)"}.`
    };
  }
  return null;
}

function currentStatus(
  navigation: NavigationMetadata | undefined,
  url: string
): number | null {
  return navigation?.completed &&
    normalizeUrl(navigation.finalUrl) === normalizeUrl(url)
    ? navigation.responseStatus
    : null;
}

function isNotFoundLabel(value: string): boolean {
  const label = value
    .replace(/[\u2013\u2014]/gu, "-")
    .replace(/\(\s*404\s*\)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return /^(?:(?:error\s*)?404(?:\s*[:|.-]\s*(?:this page could not be found|page not found|not found))?|page not found|not found|this page could not be found)[.!]?(?:\s+[|:-]\s+.{1,80})?$/i.test(
    label
  );
}

function safeRedirectDestination(requested: string, final: string): boolean {
  const from = new URL(requested);
  const to = new URL(final);
  return (
    ["http:", "https:"].includes(to.protocol) &&
    !to.username &&
    !to.password &&
    (to.origin === from.origin ||
      (from.protocol === "http:" &&
        to.protocol === "https:" &&
        from.hostname === to.hostname &&
        !from.port &&
        !to.port))
  );
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  return url.href.replace(/\/$/, "");
}
