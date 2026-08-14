import type { AgentTrace, PendingApproval } from "@vibeqa/agent-core";
import type {
  BrowserAction,
  ConsoleError,
  ElementInformation,
  Observation
} from "@vibeqa/schemas";

export type ExplorationStatus = "running" | "completed" | "paused" | "halted";

export type ExplorationStopReason =
  "max_steps" | "no_candidates" | "approval_required" | "error";

export interface ExplorationNode {
  fingerprint: string;
  normalizedUrl: string;
  observation: Observation;
  firstSeenStep: number;
  visitCount: number;
}

export interface ExplorationEdge {
  id: string;
  fromStateFingerprint: string;
  toStateFingerprint: string | null;
  action: BrowserAction;
  candidateId: string;
  status: "succeeded" | "failed" | "blocked" | "denied";
  error?: string;
}

export interface ActionCandidate {
  id: string;
  stateFingerprint: string;
  elementId: string;
  elementKey: string;
  action: BrowserAction;
  score: number;
  reasons: string[];
}

export interface ExecutedExplorationAction {
  candidateId: string;
  elementKey: string;
  fromStateFingerprint: string;
  toStateFingerprint: string;
  action: BrowserAction;
  actionKey: string;
  success: boolean;
  error?: string;
}

export interface FailedExplorationAction {
  candidateId: string;
  stateFingerprint: string;
  action: BrowserAction;
  actionKey: string;
  error: string;
}

export interface DiscoveredInteractiveElement {
  stateFingerprint: string;
  elementKey: string;
  element: ElementInformation;
  firstSeenStep: number;
}

export interface DiscoveredConsoleError {
  stateFingerprint: string;
  url: string;
  error: ConsoleError;
  firstSeenStep: number;
}

export interface ExplorationFinding {
  id: string;
  type: "console_error" | "action_failure";
  message: string;
  url: string;
  stateFingerprint: string;
  evidence: string[];
}

export interface ExplorationPendingApproval extends PendingApproval {
  candidateId: string | null;
  fromStateFingerprint: string | null;
}

export interface ExplorationState {
  goal: string;
  startUrl: string;
  currentUrl: string;
  status: ExplorationStatus;
  stopReason: ExplorationStopReason | null;
  visitedUrls: string[];
  observedPageStates: ExplorationNode[];
  executedActions: ExecutedExplorationAction[];
  discoveredInteractiveElements: DiscoveredInteractiveElement[];
  failedActions: FailedExplorationAction[];
  consoleErrorsDiscovered: DiscoveredConsoleError[];
  screenshots: string[];
  candidateActions: ActionCandidate[];
  edges: ExplorationEdge[];
  findings: ExplorationFinding[];
  errors: string[];
  pendingApproval: ExplorationPendingApproval | null;
  stepCount: number;
  uniquePageStateCount: number;
}

export interface ExplorationRunOptions {
  startUrl: string;
  goal: string;
  maxSteps?: number;
}

export interface ExplorationResult {
  goal: string;
  status: ExplorationStatus;
  stopReason: ExplorationStopReason | null;
  state: ExplorationState;
  findings: ExplorationFinding[];
  traces: AgentTrace[];
  pendingApproval: ExplorationPendingApproval | null;
}
