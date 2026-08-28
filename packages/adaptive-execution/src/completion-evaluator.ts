import type { BrowserAction, Observation } from "@vibeqa/schemas";

import type { SemanticCompletionEvaluation } from "./types.js";

export interface SemanticCompletionInput {
  goal: string;
  observation: Observation;
  actionHistory: readonly BrowserAction[];
  discoveredBugs: readonly string[];
}

const DISCOVERY_GOAL =
  /\b(explor\w*|discover\w*|investigat\w*|find\b|failure\w*|broken\b|issue\w*)\b/i;
const FAILURE_EVIDENCE = /\b(error|failed|failure|exception|crash|broken|denied)\b/i;

export class DeterministicCompletionEvaluator {
  evaluate(input: SemanticCompletionInput): SemanticCompletionEvaluation {
    const visible = normalize(
      `${input.observation.title} ${input.observation.textSample}`
    );
    const goal = normalize(input.goal);
    const evidence: string[] = [];

    if (DISCOVERY_GOAL.test(goal)) {
      const failureEvidence = [
        ...input.observation.consoleErrors.map((error) => error.text),
        ...input.discoveredBugs,
        ...(FAILURE_EVIDENCE.test(visible) ? [visible] : [])
      ];
      const relevantFailures = failureEvidence.filter((failure) =>
        failureMatchesGoal(goal, failure)
      );
      if (
        relevantFailures.some((failure) =>
          input.observation.consoleErrors.some((error) => error.text === failure)
        )
      ) {
        evidence.push("goal-relevant-console-error");
      }
      if (relevantFailures.some((failure) => input.discoveredBugs.includes(failure))) {
        evidence.push("goal-relevant-runtime-failure");
      }
      if (relevantFailures.includes(visible)) {
        evidence.push("goal-relevant-visible-failure");
      }
      const confirmed = evidence.length > 0;
      return {
        confirmed,
        reason: confirmed
          ? "Runtime-visible failure evidence satisfies the discovery objective."
          : "The discovery objective has no runtime-visible failure evidence yet.",
        evidence
      };
    }

    const urlTokens = new Set(
      new URL(input.observation.url).pathname
        .split("/")
        .map(normalize)
        .filter((token) => token.length >= 4)
    );
    const goalTokens = significantTokens(goal);
    const visibleTokens = significantTokens(visible);
    const matchedGoalTokens = [...goalTokens].filter(
      (token) => visibleTokens.has(token) || urlTokens.has(token)
    );
    if ([...urlTokens].some((token) => goalTokens.has(token))) {
      evidence.push("goal-relevant-url-state");
    }
    if (matchedGoalTokens.length >= 2) evidence.push("goal-text-overlap");
    if (matchingGoalPhrase(goal, visible)) evidence.push("goal-phrase-visible");

    const confirmed =
      evidence.includes("goal-phrase-visible") ||
      (evidence.includes("goal-relevant-url-state") &&
        evidence.includes("goal-text-overlap"));
    return {
      confirmed,
      reason: confirmed
        ? "The current observable state matches the public goal."
        : "The current observable state does not yet confirm the public goal.",
      evidence
    };
  }
}

function failureMatchesGoal(goal: string, failure: string): boolean {
  const context = [...significantTokens(goal)].filter(
    (token) =>
      ![
        "explore",
        "discover",
        "failure",
        "failures",
        "broken",
        "issue",
        "issues",
        "visible",
        "interaction"
      ].includes(token)
  );
  if (context.length === 0 || /\b(any|website|page)\b/.test(goal)) return true;
  const failureTokens = significantTokens(normalize(failure));
  return context.some((token) => failureTokens.has(token));
}

function matchingGoalPhrase(goal: string, visible: string): boolean {
  const tokens = [...significantTokens(goal)];
  for (let size = Math.min(4, tokens.length); size >= 2; size -= 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phrase = tokens.slice(index, index + size).join(" ");
      if (visible.includes(phrase)) return true;
    }
  }
  return false;
}

function significantTokens(value: string): Set<string> {
  const ignored = new Set([
    "that",
    "this",
    "with",
    "from",
    "into",
    "whether",
    "user",
    "users",
    "verify",
    "confirm",
    "check",
    "reach",
    "reached",
    "inspect",
    "existing",
    "normal"
  ]);
  return new Set(
    value
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !ignored.has(token))
  );
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
