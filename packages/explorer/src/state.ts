import type { ExplorationState } from "./types.js";
import { normalizeUrl } from "./fingerprint.js";

export function createExplorationState(
  startUrl: string,
  goal: string
): ExplorationState {
  const normalizedStartUrl = normalizeUrl(startUrl);
  return {
    goal,
    startUrl: normalizedStartUrl,
    currentUrl: normalizedStartUrl,
    status: "running",
    stopReason: null,
    visitedUrls: [],
    observedPageStates: [],
    executedActions: [],
    discoveredInteractiveElements: [],
    failedActions: [],
    consoleErrorsDiscovered: [],
    screenshots: [],
    candidateActions: [],
    edges: [],
    findings: [],
    errors: [],
    pendingApproval: null,
    stepCount: 0,
    uniquePageStateCount: 0
  };
}
