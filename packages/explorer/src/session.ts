import { Agent, type AgentTrace, type BrowserController } from "@vibeqa/agent-core";
import type { LLMClient } from "@vibeqa/llm";
import {
  DefaultActionSafetyPolicy,
  type ActionSafetyPolicy
} from "@vibeqa/safety-policy";
import type { BrowserAction, Observation } from "@vibeqa/schemas";

import { actionKey, createElementKey, generateActionCandidates } from "./candidates.js";
import { createPageStateFingerprint, normalizeUrl } from "./fingerprint.js";
import { createExplorationState } from "./state.js";
import type {
  ActionCandidate,
  ExplorationPendingApproval,
  ExplorationResult,
  ExplorationRunOptions,
  ExplorationState
} from "./types.js";

export interface ExplorationSessionOptions {
  browser: BrowserController;
  safetyPolicy?: ActionSafetyPolicy;
  candidateGenerator?: CandidateGenerator;
  defaultMaxSteps?: number;
}

export type CandidateGenerator = (
  observation: Observation,
  stateFingerprint: string,
  state: ExplorationState
) => ActionCandidate[];

type PendingExecution =
  | { kind: "start"; agent: Agent }
  | {
      kind: "candidate";
      agent: Agent;
      candidate: ActionCandidate;
      fromStateFingerprint: string;
    };

export class ExplorationSession {
  private readonly browser: BrowserController;
  private readonly safetyPolicy: ActionSafetyPolicy;
  private readonly candidateGenerator: CandidateGenerator;
  private readonly defaultMaxSteps: number;
  private state: ExplorationState = createExplorationState(
    "http://localhost/",
    "Not started"
  );
  private currentObservation: Observation | null = null;
  private maxSteps = 0;
  private traces: AgentTrace[] = [];
  private pendingExecution: PendingExecution | null = null;

  constructor(options: ExplorationSessionOptions) {
    this.browser = options.browser;
    this.safetyPolicy = options.safetyPolicy ?? new DefaultActionSafetyPolicy();
    this.candidateGenerator = options.candidateGenerator ?? generateActionCandidates;
    this.defaultMaxSteps = options.defaultMaxSteps ?? 20;
  }

  async run(options: ExplorationRunOptions): Promise<ExplorationResult> {
    validateRunOptions(options, this.defaultMaxSteps);
    if (this.pendingExecution) {
      throw new Error("Resolve the pending approval before starting a new run.");
    }

    this.maxSteps = options.maxSteps ?? this.defaultMaxSteps;
    this.state = createExplorationState(options.startUrl, options.goal);
    this.currentObservation = null;
    this.traces = [];

    const startAgent = await this.executeThroughAgent({
      type: "navigate",
      url: this.state.startUrl
    });
    if (this.pauseForApproval({ kind: "start", agent: startAgent })) {
      return this.createResult();
    }
    if (!this.finalizeStart(startAgent)) {
      return this.createResult();
    }

    return await this.continueExploration();
  }

  async resumeApproval(
    requestId: string,
    approved: boolean
  ): Promise<ExplorationResult> {
    const pending = this.pendingExecution;
    if (!pending) {
      throw new Error("The exploration has no pending approval request.");
    }

    await pending.agent.resumeApproval(requestId, approved);
    this.pendingExecution = null;
    this.state.pendingApproval = null;
    this.state.status = "running";
    this.state.stopReason = null;

    const canContinue =
      pending.kind === "start"
        ? this.finalizeStart(pending.agent)
        : this.finalizeCandidate(
            pending.agent,
            pending.candidate,
            pending.fromStateFingerprint
          );

    return canContinue ? await this.continueExploration() : this.createResult();
  }

  getPendingApproval(): ExplorationPendingApproval | null {
    return this.state.pendingApproval
      ? structuredClone(this.state.pendingApproval)
      : null;
  }

  getState(): ExplorationState {
    return structuredClone(this.state);
  }

  private async continueExploration(): Promise<ExplorationResult> {
    while (this.state.status === "running") {
      if (this.state.stepCount >= this.maxSteps) {
        this.complete("max_steps");
        break;
      }

      const observation = this.currentObservation;
      if (!observation) {
        this.halt("The exploration has no current observation.");
        break;
      }

      const fromStateFingerprint = createPageStateFingerprint(observation);
      const candidates = this.candidateGenerator(
        observation,
        fromStateFingerprint,
        this.state
      );
      this.state.candidateActions = candidates;
      const selected = candidates[0];
      if (!selected) {
        this.complete("no_candidates");
        break;
      }

      const agent = await this.executeThroughAgent(selected.action);
      const pending: PendingExecution = {
        kind: "candidate",
        agent,
        candidate: selected,
        fromStateFingerprint
      };
      if (this.pauseForApproval(pending)) {
        break;
      }
      if (!this.finalizeCandidate(agent, selected, fromStateFingerprint)) {
        break;
      }
    }

    return this.createResult();
  }

  private async executeThroughAgent(action: BrowserAction): Promise<Agent> {
    const agent = new Agent({
      browser: this.browser,
      llmClient: new SingleActionClient(action),
      safetyPolicy: this.safetyPolicy,
      maxSteps: 2
    });
    await agent.run(this.state.goal);
    return agent;
  }

  private pauseForApproval(pending: PendingExecution): boolean {
    const approval = pending.agent.getPendingApproval();
    if (!approval) {
      return false;
    }

    this.pendingExecution = pending;
    this.state.pendingApproval = {
      ...approval,
      candidateId: pending.kind === "candidate" ? pending.candidate.id : null,
      fromStateFingerprint:
        pending.kind === "candidate" ? pending.fromStateFingerprint : null
    };
    this.state.status = "paused";
    this.state.stopReason = "approval_required";
    return true;
  }

  private finalizeStart(agent: Agent): boolean {
    this.traces.push(agent.getTrace());
    const observation = agent.state.currentObservation;
    const executed = agent.state.actionHistory.length === 1;
    if (!executed || !observation || agent.state.errors.length > 0) {
      const message =
        agent.state.errors[0] ?? "Failed to navigate to the exploration start URL.";
      this.halt(message);
      return false;
    }

    this.recordObservation(observation);
    return true;
  }

  private finalizeCandidate(
    agent: Agent,
    candidate: ActionCandidate,
    fromStateFingerprint: string
  ): boolean {
    const trace = agent.getTrace();
    this.traces.push(trace);
    this.state.stepCount += 1;
    this.state.candidateActions = [];

    const actionExecuted = agent.state.actionHistory.length === 1;
    const actionTrace = trace.steps.find((step) => step.action !== null);
    const error =
      agent.state.errors[0] ??
      actionTrace?.result.error ??
      (actionExecuted ? undefined : "The browser action did not execute.");
    const observation = actionExecuted ? agent.state.currentObservation : null;
    const toStateFingerprint = observation ? this.recordObservation(observation) : null;

    if (!actionExecuted || error) {
      if (actionExecuted && toStateFingerprint) {
        this.state.executedActions.push({
          candidateId: candidate.id,
          elementKey: candidate.elementKey,
          fromStateFingerprint,
          toStateFingerprint,
          action: candidate.action,
          actionKey: actionKey(candidate.action),
          success: false,
          error
        });
      }
      this.recordFailedAction(
        candidate,
        fromStateFingerprint,
        error ?? "The browser action failed."
      );
      this.state.edges.push({
        id: `edge-${this.state.edges.length + 1}`,
        fromStateFingerprint,
        toStateFingerprint,
        action: candidate.action,
        candidateId: candidate.id,
        status: edgeFailureStatus(
          actionTrace?.safetyDecision,
          actionTrace?.approvalStatus
        ),
        error: error ?? "The browser action failed."
      });
      this.halt(error ?? "The browser action failed.");
      return false;
    }

    if (!toStateFingerprint) {
      const message = "The action completed without a follow-up observation.";
      this.recordFailedAction(candidate, fromStateFingerprint, message);
      this.halt(message);
      return false;
    }

    this.state.executedActions.push({
      candidateId: candidate.id,
      elementKey: candidate.elementKey,
      fromStateFingerprint,
      toStateFingerprint,
      action: candidate.action,
      actionKey: actionKey(candidate.action),
      success: true
    });
    this.state.edges.push({
      id: `edge-${this.state.edges.length + 1}`,
      fromStateFingerprint,
      toStateFingerprint,
      action: candidate.action,
      candidateId: candidate.id,
      status: "succeeded"
    });
    return true;
  }

  private recordObservation(observation: Observation): string {
    this.currentObservation = observation;
    const fingerprint = createPageStateFingerprint(observation);
    const normalizedUrl = normalizeUrl(observation.url);
    this.state.currentUrl = normalizedUrl;

    if (!this.state.visitedUrls.includes(normalizedUrl)) {
      this.state.visitedUrls.push(normalizedUrl);
    }

    const existingNode = this.state.observedPageStates.find(
      (node) => node.fingerprint === fingerprint
    );
    if (existingNode) {
      existingNode.visitCount += 1;
    } else {
      this.state.observedPageStates.push({
        fingerprint,
        normalizedUrl,
        observation,
        firstSeenStep: this.state.stepCount,
        visitCount: 1
      });
    }
    this.state.uniquePageStateCount = this.state.observedPageStates.length;

    for (const element of observation.elements.filter((element) => element.visible)) {
      const elementKey = createElementKey(element);
      const alreadyDiscovered = this.state.discoveredInteractiveElements.some(
        (record) =>
          record.stateFingerprint === fingerprint && record.elementKey === elementKey
      );
      if (!alreadyDiscovered) {
        this.state.discoveredInteractiveElements.push({
          stateFingerprint: fingerprint,
          elementKey,
          element,
          firstSeenStep: this.state.stepCount
        });
      }
    }

    for (const consoleError of observation.consoleErrors) {
      const alreadyDiscovered = this.state.consoleErrorsDiscovered.some(
        (record) =>
          record.stateFingerprint === fingerprint &&
          record.error.type === consoleError.type &&
          record.error.text === consoleError.text
      );
      if (!alreadyDiscovered) {
        this.state.consoleErrorsDiscovered.push({
          stateFingerprint: fingerprint,
          url: normalizedUrl,
          error: consoleError,
          firstSeenStep: this.state.stepCount
        });
        this.state.findings.push({
          id: `finding-${this.state.findings.length + 1}`,
          type: "console_error",
          message: consoleError.text,
          url: normalizedUrl,
          stateFingerprint: fingerprint,
          evidence: observation.screenshotPath ? [observation.screenshotPath] : []
        });
      }
    }

    if (
      observation.screenshotPath &&
      !this.state.screenshots.includes(observation.screenshotPath)
    ) {
      this.state.screenshots.push(observation.screenshotPath);
    }

    return fingerprint;
  }

  private recordFailedAction(
    candidate: ActionCandidate,
    stateFingerprint: string,
    error: string
  ): void {
    this.state.failedActions.push({
      candidateId: candidate.id,
      stateFingerprint,
      action: candidate.action,
      actionKey: actionKey(candidate.action),
      error
    });
    this.state.findings.push({
      id: `finding-${this.state.findings.length + 1}`,
      type: "action_failure",
      message: error,
      url: this.state.currentUrl,
      stateFingerprint,
      evidence: [...this.state.screenshots]
    });
  }

  private complete(reason: "max_steps" | "no_candidates"): void {
    this.state.status = "completed";
    this.state.stopReason = reason;
    this.state.pendingApproval = null;
  }

  private halt(message: string): void {
    if (!this.state.errors.includes(message)) {
      this.state.errors.push(message);
    }
    this.state.status = "halted";
    this.state.stopReason = "error";
    this.state.pendingApproval = null;
  }

  private createResult(): ExplorationResult {
    const pendingTrace = this.pendingExecution?.agent.getTrace();
    const traces = pendingTrace ? [...this.traces, pendingTrace] : this.traces;
    const state = this.getState();
    return {
      goal: state.goal,
      status: state.status,
      stopReason: state.stopReason,
      state,
      findings: structuredClone(state.findings),
      traces: structuredClone(traces),
      pendingApproval: state.pendingApproval
    };
  }
}

class SingleActionClient implements LLMClient {
  private returnedAction = false;

  constructor(private readonly action: BrowserAction) {}

  async generate(): Promise<string> {
    if (this.returnedAction) {
      return "null";
    }
    this.returnedAction = true;
    return JSON.stringify(this.action);
  }
}

function validateRunOptions(
  options: ExplorationRunOptions,
  defaultMaxSteps: number
): void {
  new URL(options.startUrl);
  if (options.goal.trim().length === 0) {
    throw new Error("Exploration goal must not be empty.");
  }

  const maxSteps = options.maxSteps ?? defaultMaxSteps;
  if (!Number.isInteger(maxSteps) || maxSteps < 0) {
    throw new Error("Exploration maxSteps must be a non-negative integer.");
  }
}

function edgeFailureStatus(
  safetyDecision: "allow" | "block" | "require_approval" | undefined,
  approvalStatus: "pending" | "approved" | "denied" | undefined
): "failed" | "blocked" | "denied" {
  if (safetyDecision === "block") {
    return "blocked";
  }
  if (approvalStatus === "denied") {
    return "denied";
  }
  return "failed";
}
