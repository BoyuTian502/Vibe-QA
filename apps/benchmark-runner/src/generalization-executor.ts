import { Agent, type AgentTrace, type BrowserController } from "@vibeqa/agent-core";
import {
  AdaptiveExecutionController,
  type AdaptiveExecutionMetadata
} from "@vibeqa/adaptive-execution";
import type { BenchmarkServer } from "@vibeqa/benchmark-app";
import { PlaywrightBrowserController } from "@vibeqa/browser-playwright";
import {
  type BenchmarkPlanner,
  type ExecutionPlanner,
  type GeneralizationActionRecord,
  type GeneralizationExecution,
  type GeneralizationObservedState,
  type GeneralizationScenario,
  type GeneralizationScenarioExecutor,
  type PlannerRoutingMetadata,
  type PlannerDecisionDiagnostic,
  type SafetyEventCounts,
  analyzeAdaptiveRun,
  toGeneralizationPlannerInput
} from "@vibeqa/evaluation";
import {
  createElementKey,
  createPageStateFingerprint,
  createExplorationState,
  ExplorationSession,
  generateActionCandidates,
  normalizeUrl,
  actionKey,
  type ActionCandidate,
  type ExplorationState,
  type ExplorationResult
} from "@vibeqa/explorer";
import type { LLMClient } from "@vibeqa/llm";
import type { HybridTaskMetadata } from "@vibeqa/planner";
import {
  DefaultActionSafetyPolicy,
  type ActionSafetyPolicy
} from "@vibeqa/safety-policy";
import {
  BrowserActionSchema,
  type BrowserAction,
  type Observation
} from "@vibeqa/schemas";

import { benchmarkCredentials } from "./scenarios.js";
import type {
  HybridBenchmarkPlannerStrategy,
  OllamaBenchmarkPlannerStrategy
} from "./planner-strategies.js";

interface ClosableBrowserController extends BrowserController {
  close(): Promise<void>;
  registerSensitiveSelector?(selector: string): void;
  registerSensitiveValue?(value: string): void;
}

export interface GeneralizationPlaywrightExecutorOptions {
  benchmark: BenchmarkServer;
  ollamaClient?: LLMClient;
  ollamaStrategy?: OllamaBenchmarkPlannerStrategy;
  hybridStrategy?: HybridBenchmarkPlannerStrategy;
  launchBrowser?: () => Promise<ClosableBrowserController>;
  safetyPolicy?: ActionSafetyPolicy;
  now?: () => number;
  adaptiveDebugReplay?: boolean;
  adaptivePostEscalationStepBudget?: number;
  onRunStart?: (
    scenario: GeneralizationScenario,
    repetition: number,
    planner: BenchmarkPlanner
  ) => void;
}

export class GeneralizationPlaywrightExecutor implements GeneralizationScenarioExecutor {
  private readonly launchBrowser: () => Promise<ClosableBrowserController>;
  private readonly safetyPolicy: ActionSafetyPolicy;
  private readonly now: () => number;

  constructor(private readonly options: GeneralizationPlaywrightExecutorOptions) {
    this.launchBrowser =
      options.launchBrowser ??
      (async () => await PlaywrightBrowserController.launch({ headless: true }));
    this.safetyPolicy = options.safetyPolicy ?? new DefaultActionSafetyPolicy();
    this.now = options.now ?? Date.now;
  }

  async execute(
    scenario: GeneralizationScenario,
    repetition: number,
    planner: BenchmarkPlanner
  ): Promise<GeneralizationExecution> {
    this.options.onRunStart?.(scenario, repetition, planner);
    this.options.benchmark.reset();
    const startedAt = this.now();
    let browser: ClosableBrowserController | null = null;
    let routing: PlannerRoutingMetadata | null = null;

    try {
      let executedPlanner: ExecutionPlanner | "adaptive";
      if (planner === "hybrid") {
        if (!this.options.hybridStrategy) {
          throw new Error("The Hybrid generalization strategy is not configured.");
        }
        const selection = await this.options.hybridStrategy.select(
          generalizationTaskMetadata(scenario)
        );
        routing = selection.routing;
        if (!selection.executedPlanner) {
          return failedGeneralizationExecution(
            selection.infrastructureError ?? "The selected planner is unavailable.",
            Math.max(0, this.now() - startedAt),
            routing
          );
        }
        executedPlanner = selection.executedPlanner;
      } else {
        executedPlanner = planner;
      }

      browser = await this.launchBrowser();
      if (scenario.credentialsRequirement === "benchmark-account") {
        await authenticateBenchmark(browser, this.options.benchmark.url);
      }
      const credentials = benchmarkCredentials();
      const plannerBrowser = new RedactingBrowserController(browser, [
        credentials.email,
        credentials.password
      ]);

      const plannerInput = toGeneralizationPlannerInput(scenario);
      if (executedPlanner === "adaptive") {
        if (!this.options.ollamaClient) {
          throw new Error("The adaptive strategy requires an Ollama client.");
        }
        const ollamaClient = new GeneralizationAgentClient(
          this.options.ollamaClient,
          this.now
        );
        const controller = new AdaptiveExecutionController({
          deterministicClient: new DeterministicGeneralizationClient(
            plannerInput.startUrl,
            plannerInput.goal,
            this.safetyPolicy
          ),
          ollamaClient,
          verifyOllamaAvailability: async () => {
            if (!this.options.ollamaStrategy) {
              throw new Error("The Ollama availability check is not configured.");
            }
            await this.options.ollamaStrategy.verifyAvailability();
          },
          now: this.now,
          maxSteps: adaptiveMaxSteps(
            plannerInput.maxSteps,
            this.options.adaptiveDebugReplay,
            this.options.adaptivePostEscalationStepBudget
          ),
          diagnosticPostEscalationStepBudget: this.options.adaptiveDebugReplay
            ? this.options.adaptivePostEscalationStepBudget
            : undefined
        });
        await plannerBrowser.navigate(plannerInput.startUrl);
        const agent = new Agent({
          browser: plannerBrowser,
          llmClient: controller,
          safetyPolicy: this.safetyPolicy,
          maxSteps: adaptiveMaxSteps(
            plannerInput.maxSteps,
            this.options.adaptiveDebugReplay,
            this.options.adaptivePostEscalationStepBudget
          )
        });
        await agent.run(plannerInput.goal);
        return evaluateAgentTrace(
          scenario,
          agent.getTrace(),
          agent.state.errors,
          agent.getPendingApproval() !== null,
          Math.max(0, this.now() - startedAt),
          ollamaClient.totalGenerationDurationMs,
          routing,
          controller.getMetadata(agent.state.stepCount),
          {
            agentCompleted: agent.state.completed,
            agentStepCount: agent.state.stepCount,
            plannerDecisions: ollamaClient.getDecisionDiagnostics()
          }
        );
      }

      if (executedPlanner === "deterministic") {
        const baselinePolicy = new DefaultActionSafetyPolicy();
        const result = await new ExplorationSession({
          browser: plannerBrowser,
          safetyPolicy: this.safetyPolicy,
          candidateGenerator: (observation, fingerprint, state) =>
            generateActionCandidates(observation, fingerprint, state).filter(
              (candidate) => {
                if (
                  candidate.action.type === "click" &&
                  (isBareElementSelector(candidate.action.selector) ||
                    hasDuplicateVisibleSelector(observation, candidate.action.selector))
                ) {
                  return false;
                }
                return (
                  baselinePolicy.evaluate(candidate.action, {
                    goal: plannerInput.goal,
                    observation,
                    actionHistory: state.executedActions.map((record) => record.action)
                  }).decision === "allow"
                );
              }
            )
        }).run(plannerInput);
        return evaluateExplorationResult(
          scenario,
          result,
          Math.max(0, this.now() - startedAt),
          routing
        );
      }

      if (!this.options.ollamaClient) {
        throw new Error("The Ollama generalization planner is not configured.");
      }
      await plannerBrowser.navigate(plannerInput.startUrl);
      const agentClient = new GeneralizationAgentClient(
        this.options.ollamaClient,
        this.now
      );
      const agent = new Agent({
        browser: plannerBrowser,
        llmClient: agentClient,
        safetyPolicy: this.safetyPolicy,
        maxSteps: plannerInput.maxSteps
      });
      await agent.run(plannerInput.goal);
      return evaluateAgentTrace(
        scenario,
        agent.getTrace(),
        agent.state.errors,
        agent.getPendingApproval() !== null,
        Math.max(0, this.now() - startedAt),
        agentClient.totalGenerationDurationMs,
        routing,
        null,
        {
          agentCompleted: agent.state.completed,
          agentStepCount: agent.state.stepCount,
          plannerDecisions: agentClient.getDecisionDiagnostics()
        }
      );
    } catch (error) {
      if (routing) {
        return failedGeneralizationExecution(
          safePlannerError(error),
          Math.max(0, this.now() - startedAt),
          routing
        );
      }
      throw error;
    } finally {
      await browser?.close();
    }
  }
}

class DeterministicGeneralizationClient implements LLMClient {
  private readonly state: ExplorationState;
  private pending: { candidate: ActionCandidate; fromFingerprint: string } | null =
    null;

  constructor(
    startUrl: string,
    private readonly goal: string,
    private readonly safetyPolicy: ActionSafetyPolicy
  ) {
    this.state = createExplorationState(startUrl, goal);
  }

  async generate(prompt: string): Promise<string> {
    const observation = extractPromptObservation(prompt);
    const history = extractPromptActions(prompt);
    const fingerprint = this.recordObservation(observation);
    if (this.pending) {
      this.state.executedActions.push({
        candidateId: this.pending.candidate.id,
        elementKey: this.pending.candidate.elementKey,
        fromStateFingerprint: this.pending.fromFingerprint,
        toStateFingerprint: fingerprint,
        action: this.pending.candidate.action,
        actionKey: actionKey(this.pending.candidate.action),
        success: true
      });
      this.state.stepCount += 1;
      this.pending = null;
    }

    const candidates = generateActionCandidates(observation, fingerprint, this.state);
    for (const candidate of candidates) {
      if (
        candidate.action.type === "click" &&
        (isBareElementSelector(candidate.action.selector) ||
          hasDuplicateVisibleSelector(observation, candidate.action.selector))
      ) {
        continue;
      }
      const decision = await this.safetyPolicy.evaluate(candidate.action, {
        goal: this.goal,
        observation,
        actionHistory: history
      });
      if (decision.decision !== "allow") continue;
      this.pending = { candidate, fromFingerprint: fingerprint };
      return JSON.stringify(candidate.action);
    }
    return "null";
  }

  private recordObservation(observation: Observation): string {
    const fingerprint = createPageStateFingerprint(observation);
    const normalizedUrl = normalizeUrl(observation.url);
    if (!this.state.visitedUrls.includes(normalizedUrl)) {
      this.state.visitedUrls.push(normalizedUrl);
    }
    const existing = this.state.observedPageStates.find(
      (node) => node.fingerprint === fingerprint
    );
    if (existing) {
      existing.visitCount += 1;
    } else {
      this.state.observedPageStates.push({
        fingerprint,
        normalizedUrl,
        observation,
        firstSeenStep: this.state.stepCount,
        visitCount: 1
      });
    }
    for (const element of observation.elements.filter((item) => item.visible)) {
      const elementKey = createElementKey(element);
      if (
        !this.state.discoveredInteractiveElements.some(
          (item) =>
            item.stateFingerprint === fingerprint && item.elementKey === elementKey
        )
      ) {
        this.state.discoveredInteractiveElements.push({
          stateFingerprint: fingerprint,
          elementKey,
          element,
          firstSeenStep: this.state.stepCount
        });
      }
    }
    this.state.currentUrl = normalizedUrl;
    this.state.uniquePageStateCount = this.state.observedPageStates.length;
    return fingerprint;
  }
}

export class GeneralizationAgentClient implements LLMClient {
  private generationDurationMs = 0;
  private readonly diagnostics: PlannerDecisionDiagnostic[] = [];

  constructor(
    private readonly client: LLMClient,
    private readonly now: () => number = Date.now
  ) {}

  get totalGenerationDurationMs(): number {
    return this.generationDurationMs;
  }

  getDecisionDiagnostics(): PlannerDecisionDiagnostic[] {
    return this.diagnostics.map((item) => structuredClone(item));
  }

  async generate(prompt: string): Promise<string> {
    const observation = extractPromptObservation(prompt);
    const actionHistory = extractPromptActions(prompt);
    const promptCharacterCount = prompt.length;
    const observationCharacterCount = JSON.stringify(observation).length;
    const validationFailures: PlannerDecisionDiagnostic["validationFailures"] = [];
    let responseCharacterCount = 0;
    const constrainedPrompt = [
      "Generalization benchmark action rules:",
      "- Use only a selector value that appears exactly in the current observation.",
      "- Element ids such as element-3 are record identifiers, not CSS selectors.",
      "- For links, prefer navigate with the exact observed href instead of clicking a generic selector.",
      "- Never invent selectors, URLs, action types, or fields.",
      "- Return null as soon as the public goal is satisfied or a failure has been observed.",
      "- If the goal asks you to explore or find failures, continue through untried safe normal interactions until a failure is observed or no useful interaction remains.",
      "- Return only one BrowserAction JSON object or null, with no explanation.",
      "",
      prompt
    ].join("\n");
    let correction = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const generationStartedAt = this.now();
      let response: string;
      try {
        response = await this.client.generate(
          correction ? `${constrainedPrompt}\n\n${correction}` : constrainedPrompt
        );
      } finally {
        this.generationDurationMs += Math.max(0, this.now() - generationStartedAt);
      }
      responseCharacterCount = response.length;
      try {
        const action = normalizeModelAction(response, prompt);
        this.diagnostics.push({
          outcome: action ? "valid_action" : "null_action",
          promptCharacterCount,
          observationCharacterCount,
          actionHistoryCount: actionHistory.length,
          responseCharacterCount,
          attempts: attempt + 1,
          validationFailures: [...validationFailures],
          action: action ? summarizeAction(action) : null,
          repeatedAction: action
            ? actionHistory.some(
                (previous) => actionIdentity(previous) === actionIdentity(action)
              )
            : false
        });
        return action ? JSON.stringify(action) : "null";
      } catch (error) {
        validationFailures.push(classifyPlannerDecisionError(error));
        correction = [
          `Your previous response was invalid: ${safePlannerError(error)}`,
          "Return a corrected canonical BrowserAction JSON object using only observed values, or null."
        ].join("\n");
      }
    }
    this.diagnostics.push({
      outcome: validationFailures.at(-1) ?? "invalid_action",
      promptCharacterCount,
      observationCharacterCount,
      actionHistoryCount: actionHistory.length,
      responseCharacterCount,
      attempts: 2,
      validationFailures: [...validationFailures],
      action: null,
      repeatedAction: false
    });
    throw new Error(
      "Ollama did not return a valid observed BrowserAction after correction."
    );
  }
}

function normalizeModelAction(
  response: string,
  agentPrompt: string
): BrowserAction | null {
  const trimmed = response.trim();
  if (trimmed === "null") {
    return null;
  }
  const parsed = JSON.parse(extractJsonValue(trimmed)) as unknown;
  if (parsed === null) {
    return null;
  }
  if (typeof parsed !== "object") {
    throw new Error("response must be a JSON object or null");
  }
  const record = Array.isArray(parsed)
    ? asRecord(parsed[0])
    : (parsed as Record<string, unknown>);
  if (
    record.completed === true ||
    record.done === true ||
    ["complete", "completed", "done", "finish", "finished"].includes(
      String(record.type ?? "").toLowerCase()
    )
  ) {
    return null;
  }
  let candidate: unknown =
    record.action ??
    record.browserAction ??
    record.browser_action ??
    record.nextAction ??
    record.next_action ??
    (Array.isArray(record.actions) ? record.actions[0] : undefined) ??
    record;
  if (typeof record.action === "string") {
    const { action, ...fields } = record;
    candidate = { ...fields, type: action };
  }
  if (candidate === null) {
    return null;
  }
  const canonical = canonicalAction(candidate);
  if (canonical === null) {
    return null;
  }
  const action = BrowserActionSchema.parse(canonical);
  validateObservedSelector(action, agentPrompt);
  return action;
}

function canonicalAction(candidate: unknown): unknown {
  const record = asRecord(candidate);
  const rawType =
    record.type ?? record.action ?? record.actionType ?? record.action_type;
  if (typeof rawType !== "string") {
    return record;
  }
  const type = normalizeActionType(rawType);
  if (type === "complete") {
    return null;
  }
  const selector =
    record.selector ?? record.target ?? record.cssSelector ?? record.css_selector;
  switch (type) {
    case "goto":
    case "navigate":
      return { type, url: record.url ?? record.href ?? record.target };
    case "click":
    case "getText":
      return { type, selector };
    case "type":
      return {
        type,
        selector,
        value: record.value ?? record.text ?? record.input
      };
    case "wait":
      return { type, ms: record.ms ?? record.durationMs ?? record.duration };
    case "screenshot":
      return typeof record.path === "string" ? { type, path: record.path } : { type };
    case "assert":
      return {
        type,
        selector,
        containsText:
          record.containsText ?? record.expectedText ?? record.expected ?? record.text
      };
    case "getCurrentUrl":
      return { type };
    default:
      return record;
  }
}

function normalizeActionType(type: string): string {
  const normalized = type.replace(/[\s_-]+/g, "").toLowerCase();
  const aliases: Record<string, string> = {
    open: "navigate",
    goto: "goto",
    navigateto: "navigate",
    navigate: "navigate",
    click: "click",
    fill: "type",
    input: "type",
    entertext: "type",
    type: "type",
    gettext: "getText",
    readtext: "getText",
    wait: "wait",
    screenshot: "screenshot",
    assert: "assert",
    verify: "assert",
    getcurrenturl: "getCurrentUrl",
    complete: "complete",
    completed: "complete",
    done: "complete",
    finish: "complete",
    finished: "complete"
  };
  return aliases[normalized] ?? type;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("action must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function validateObservedSelector(action: BrowserAction, agentPrompt: string): void {
  if (!("selector" in action)) {
    return;
  }
  const observation = extractPromptObservation(agentPrompt);
  const matchingElements = observation.elements.filter(
    (element) => element.visible && element.selector === action.selector
  );
  if (matchingElements.length === 0) {
    throw new Error(`selector ${action.selector} is not present in the observation`);
  }
  if (matchingElements.length > 1 || isBareElementSelector(action.selector)) {
    throw new Error(
      `selector ${action.selector} does not uniquely identify an observed element`
    );
  }
}

function extractPromptObservation(agentPrompt: string): Observation {
  const match = /Current observation: (\{.*\})\nPrevious actions:/s.exec(agentPrompt);
  if (!match?.[1]) {
    throw new Error("current observation is unavailable for action validation");
  }
  return JSON.parse(match[1]) as Observation;
}

function extractPromptActions(agentPrompt: string): BrowserAction[] {
  const match = /Previous actions: (\[.*\])\nDiscovered bugs:/s.exec(agentPrompt);
  return match?.[1] ? (JSON.parse(match[1]) as BrowserAction[]) : [];
}

function extractJsonValue(value: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(value);
  if (fenced?.[1]) {
    return fenced[1];
  }
  const objectStart = value.indexOf("{");
  const arrayStart = value.indexOf("[");
  const start =
    objectStart < 0
      ? arrayStart
      : arrayStart < 0
        ? objectStart
        : Math.min(objectStart, arrayStart);
  const objectEnd = value.lastIndexOf("}");
  const arrayEnd = value.lastIndexOf("]");
  const end = Math.max(objectEnd, arrayEnd);
  return start >= 0 && end >= start ? value.slice(start, end + 1) : value;
}

function safePlannerError(error: unknown): string {
  const message = error instanceof Error ? error.message : "invalid response";
  return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}

function classifyPlannerDecisionError(
  error: unknown
): "invalid_action" | "parser_failure" | "action_not_applicable" {
  if (error instanceof SyntaxError) return "parser_failure";
  const message = error instanceof Error ? error.message : String(error);
  if (/selector .* observation|uniquely identify/i.test(message)) {
    return "action_not_applicable";
  }
  return "invalid_action";
}

function summarizeAction(action: BrowserAction): {
  type: BrowserAction["type"];
  target: string | null;
} {
  if ("selector" in action) return { type: action.type, target: action.selector };
  if ("url" in action) return { type: action.type, target: action.url };
  return { type: action.type, target: null };
}

function actionIdentity(action: BrowserAction): string {
  const summary = summarizeAction(action);
  return `${summary.type}:${summary.target ?? ""}`;
}

function hasDuplicateVisibleSelector(
  observation: Observation,
  selector: string
): boolean {
  return (
    observation.elements.filter(
      (element) => element.visible && element.selector === selector
    ).length > 1
  );
}

function isBareElementSelector(selector: string): boolean {
  return /^[a-z][a-z0-9-]*$/i.test(selector);
}

class RedactingBrowserController implements BrowserController {
  constructor(
    private readonly browser: BrowserController,
    private readonly sensitiveValues: readonly string[]
  ) {}

  async observe(): Promise<Observation> {
    return redactObservation(await this.browser.observe(), this.sensitiveValues);
  }

  async goto(url: string): Promise<void> {
    await this.browser.goto(url);
  }

  async navigate(url: string): Promise<void> {
    await this.browser.navigate(url);
  }

  async click(selector: string): Promise<void> {
    await this.browser.click(selector);
    await this.browser.wait(100);
  }

  async type(selector: string, value: string): Promise<void> {
    await this.browser.type(selector, value);
  }

  async getText(selector: string): Promise<string> {
    return redactText(await this.browser.getText(selector), this.sensitiveValues);
  }

  async wait(ms: number): Promise<void> {
    await this.browser.wait(ms);
  }

  async screenshot(options?: { path?: string }): Promise<Uint8Array | string> {
    return await this.browser.screenshot(options);
  }

  async assert(selector: string, containsText: string): Promise<void> {
    await this.browser.assert(selector, containsText);
  }

  getCurrentUrl(): string {
    return this.browser.getCurrentUrl();
  }
}

export function evaluateExplorationResult(
  scenario: GeneralizationScenario,
  result: ExplorationResult,
  durationMs: number,
  routing: PlannerRoutingMetadata | null = null
): GeneralizationExecution {
  const nodes = new Map(
    result.state.observedPageStates.map((node) => [node.fingerprint, node] as const)
  );
  const fingerprints: string[] = [];
  const firstNode = result.state.observedPageStates[0];
  if (firstNode) {
    fingerprints.push(firstNode.fingerprint);
  }
  for (const edge of result.state.edges) {
    if (edge.toStateFingerprint) {
      fingerprints.push(edge.toStateFingerprint);
    }
  }
  const observations = fingerprints.flatMap((fingerprint, index) => {
    const node = nodes.get(fingerprint);
    return node ? [toObservedState(node.observation, index)] : [];
  });
  const actions: GeneralizationActionRecord[] = result.state.edges
    .filter((edge) => edge.status === "succeeded" || edge.status === "failed")
    .map((edge) => ({
      action: edge.action,
      fromStateFingerprint: edge.fromStateFingerprint,
      toStateFingerprint: edge.toStateFingerprint,
      success: edge.status === "succeeded",
      error: edge.error ?? null
    }));
  const safetyEvents = countSafetyEvents(result.traces);
  return evaluateTrajectory(scenario, {
    observations,
    actions,
    durationMs,
    plannerDurationMs: null,
    routing,
    safetyEvents,
    infrastructureError:
      result.stopReason === "error"
        ? (result.state.errors[0] ?? "Exploration halted with an error.")
        : null,
    approvalRequired: result.stopReason === "approval_required",
    safetyBlocked: result.state.edges.some((edge) => edge.status === "blocked")
  });
}

export function evaluateAgentTrace(
  scenario: GeneralizationScenario,
  trace: AgentTrace,
  errors: readonly string[],
  approvalRequired: boolean,
  durationMs: number,
  plannerDurationMs: number | null = null,
  routing: PlannerRoutingMetadata | null = null,
  adaptive: AdaptiveExecutionMetadata | null = null,
  diagnosticContext: {
    agentCompleted: boolean;
    agentStepCount: number;
    plannerDecisions: readonly PlannerDecisionDiagnostic[];
  } | null = null
): GeneralizationExecution {
  const observationSteps = trace.steps.filter(
    (step): step is typeof step & { observation: Observation } =>
      step.observation !== null
  );
  const observations = observationSteps.map((step, index) =>
    toObservedState(step.observation, index)
  );
  const actions: GeneralizationActionRecord[] = [];
  for (const step of trace.steps) {
    if (
      !step.action ||
      step.safetyDecision === "block" ||
      step.safetyDecision === "require_approval"
    ) {
      continue;
    }
    const from = step.observation ? createPageStateFingerprint(step.observation) : null;
    const stepIndex = trace.steps.indexOf(step);
    const nextObservation = trace.steps
      .slice(stepIndex + 1)
      .find((candidate) => candidate.observation !== null)?.observation;
    actions.push({
      action: step.action,
      fromStateFingerprint: from,
      toStateFingerprint: nextObservation
        ? createPageStateFingerprint(nextObservation)
        : null,
      success: step.result.success,
      error: step.result.error ?? null
    });
  }
  const safetyEvents = countSafetyEvents([trace]);
  const safetyBlocked = trace.steps.some((step) => step.safetyDecision === "block");
  const infrastructureError = errors.find(
    (error) =>
      !error.startsWith("Action blocked by safety policy") &&
      error !== "Action denied by human approval."
  );

  const execution = evaluateTrajectory(scenario, {
    observations,
    actions,
    durationMs,
    plannerDurationMs,
    routing,
    adaptive,
    plannerDecisions: diagnosticContext?.plannerDecisions ?? [],
    agentCompleted: diagnosticContext?.agentCompleted ?? false,
    agentStepCount: diagnosticContext?.agentStepCount ?? actions.length,
    safetyEvents,
    infrastructureError: infrastructureError ?? null,
    approvalRequired,
    safetyBlocked
  });
  if (!adaptive || !diagnosticContext) return execution;
  return {
    ...execution,
    adaptiveDiagnostics: analyzeAdaptiveRun({
      scenario,
      execution,
      trace,
      errors,
      agentCompleted: diagnosticContext.agentCompleted,
      agentStepCount: diagnosticContext.agentStepCount,
      plannerDecisions: diagnosticContext.plannerDecisions,
      adaptive
    })
  };
}

interface TrajectoryInput {
  observations: GeneralizationObservedState[];
  actions: GeneralizationActionRecord[];
  durationMs: number;
  plannerDurationMs?: number | null;
  routing?: PlannerRoutingMetadata | null;
  adaptive?: AdaptiveExecutionMetadata | null;
  plannerDecisions?: readonly PlannerDecisionDiagnostic[];
  agentCompleted?: boolean;
  agentStepCount?: number;
  safetyEvents: SafetyEventCounts;
  infrastructureError: string | null;
  approvalRequired: boolean;
  safetyBlocked: boolean;
}

export function evaluateTrajectory(
  scenario: GeneralizationScenario,
  input: TrajectoryInput
): GeneralizationExecution {
  const detections = scenario.evaluatorOnly.bugSignals.flatMap((signal) => {
    if (signal.type === "console_error") {
      const index = input.observations.findIndex((record) =>
        record.observation.consoleErrors.some((error) =>
          signal.textIncludes ? error.text.includes(signal.textIncludes) : false
        )
      );
      return index >= 0 ? [{ bugId: signal.bugId, observationIndex: index }] : [];
    }

    const actionIndex = input.actions.findIndex(
      (record) =>
        record.action.type === "click" &&
        record.action.selector === signal.actionSelector &&
        record.success
    );
    if (actionIndex < 0) {
      return [];
    }
    const index = input.observations.findIndex(
      (record, observationIndex) =>
        observationIndex > actionIndex &&
        !input.actions
          .slice(actionIndex + 1, observationIndex)
          .some(
            (action) =>
              action.action.type === "click" &&
              signal.disallowedInterveningActionSelectors?.includes(
                action.action.selector
              )
          ) &&
        matchesState(record.observation, {
          urlPath: signal.resultingUrlPath,
          textIncludes: signal.resultingTextIncludes
        })
    );
    return index >= 0 ? [{ bugId: signal.bugId, observationIndex: index }] : [];
  });
  const detectedBugIds = [...new Set(detections.map((item) => item.bugId))];
  const firstDetection = detections
    .map((item) => item.observationIndex)
    .sort((left, right) => left - right)[0];
  const discoveryStep = firstDetection === undefined ? null : firstDetection;
  const observationsBeforeDiscovery = input.observations.slice(
    0,
    discoveryStep === null ? 0 : discoveryStep + 1
  );
  const goalState = scenario.evaluatorOnly.goalState;
  const completionStep = goalState
    ? input.observations.findIndex((record, index) => {
        if (!matchesState(record.observation, goalState)) {
          return false;
        }
        if (!goalState.requiresSameUrlStateChange) {
          return true;
        }
        return input.observations
          .slice(0, index)
          .some(
            (previous) =>
              previous.normalizedUrl === record.normalizedUrl &&
              previous.fingerprint !== record.fingerprint
          );
      })
    : discoveryStep;
  const goalCompleted =
    completionStep !== null &&
    completionStep >= 0 &&
    (goalState !== undefined || detectedBugIds.length > 0);

  return {
    goalCompleted,
    detectedBugIds,
    infrastructureError: input.infrastructureError,
    durationMs: input.durationMs,
    plannerDurationMs: input.plannerDurationMs ?? null,
    routing: input.routing ?? null,
    adaptive: input.adaptive ?? null,
    plannerDecisions: input.plannerDecisions
      ? input.plannerDecisions.map((item) => structuredClone(item))
      : [],
    agentCompleted: input.agentCompleted ?? false,
    agentStepCount: input.agentStepCount ?? input.actions.length,
    adaptiveDiagnostics: null,
    safetyEvents: input.safetyEvents,
    observations: input.observations,
    actions: input.actions,
    discoveryStep,
    completionStep: completionStep === -1 ? null : completionStep,
    uniqueStatesBeforeDiscovery: new Set(
      observationsBeforeDiscovery.map((record) => record.fingerprint)
    ).size,
    uniqueElementsBeforeDiscovery: new Set(
      observationsBeforeDiscovery.flatMap((record) => record.interactiveElementKeys)
    ).size,
    approvalRequired: input.approvalRequired,
    safetyBlocked: input.safetyBlocked
  };
}

function generalizationTaskMetadata(
  scenario: GeneralizationScenario
): HybridTaskMetadata {
  return {
    ...scenario.routingHints,
    objective: scenario.plannerGoal,
    maxSteps: scenario.maxSteps,
    authenticationRequired: scenario.credentialsRequirement !== "none"
  };
}

function adaptiveMaxSteps(
  productionMaxSteps: number,
  debugReplay = false,
  postEscalationStepBudget?: number
): number {
  return debugReplay && postEscalationStepBudget
    ? productionMaxSteps + postEscalationStepBudget
    : productionMaxSteps;
}

function failedGeneralizationExecution(
  error: string,
  durationMs: number,
  routing: PlannerRoutingMetadata
): GeneralizationExecution {
  return {
    goalCompleted: false,
    detectedBugIds: [],
    infrastructureError: error,
    durationMs,
    plannerDurationMs: null,
    safetyEvents: { allowed: 0, blocked: 0, approvalRequired: 0 },
    observations: [],
    actions: [],
    discoveryStep: null,
    completionStep: null,
    uniqueStatesBeforeDiscovery: 0,
    uniqueElementsBeforeDiscovery: 0,
    approvalRequired: false,
    safetyBlocked: false,
    routing
  };
}

function matchesState(
  observation: Observation,
  expectation: { urlPath?: string; textIncludes?: string }
): boolean {
  const urlMatches = expectation.urlPath
    ? new URL(observation.url).pathname === expectation.urlPath
    : true;
  const textMatches = expectation.textIncludes
    ? observation.textSample
        .toLowerCase()
        .includes(expectation.textIncludes.toLowerCase())
    : true;
  return urlMatches && textMatches;
}

function toObservedState(
  observation: Observation,
  observationIndex: number
): GeneralizationObservedState {
  return {
    fingerprint: createPageStateFingerprint(observation),
    normalizedUrl: normalizeUrl(observation.url),
    observation,
    observationIndex,
    interactiveElementKeys: observation.elements
      .filter((element) => element.visible && element.enabled)
      .map(createElementKey)
  };
}

function countSafetyEvents(traces: readonly AgentTrace[]): SafetyEventCounts {
  const counts: SafetyEventCounts = {
    allowed: 0,
    blocked: 0,
    approvalRequired: 0
  };
  for (const step of traces.flatMap((trace) => trace.steps)) {
    if (step.safetyDecision === "allow") {
      counts.allowed += 1;
    } else if (step.safetyDecision === "block") {
      counts.blocked += 1;
    } else if (step.safetyDecision === "require_approval") {
      counts.approvalRequired += 1;
    }
  }
  return counts;
}

async function authenticateBenchmark(
  browser: ClosableBrowserController,
  benchmarkUrl: string
): Promise<void> {
  const credentials = benchmarkCredentials();
  browser.registerSensitiveSelector?.('input[name="password"]');
  browser.registerSensitiveValue?.(credentials.email);
  browser.registerSensitiveValue?.(credentials.password);
  await browser.navigate(`${benchmarkUrl}/login`);
  await browser.type('input[name="email"]', credentials.email);
  await browser.type('input[name="password"]', credentials.password);
  await browser.click('button[type="submit"]');
  await browser.wait(150);
  if (browser.getCurrentUrl() !== `${benchmarkUrl}/dashboard`) {
    throw new Error("Benchmark authentication setup did not reach the dashboard.");
  }
}

function redactObservation(
  observation: Observation,
  sensitiveValues: readonly string[]
): Observation {
  const redact = (value: string): string => redactText(value, sensitiveValues);
  return {
    ...observation,
    url: redact(observation.url),
    title: redact(observation.title),
    metadata: {
      ...observation.metadata,
      url: redact(observation.metadata.url),
      title: redact(observation.metadata.title)
    },
    consoleErrors: observation.consoleErrors.map((error) => ({
      ...error,
      text: redact(error.text),
      location: error.location
        ? { ...error.location, url: redact(error.location.url) }
        : null
    })),
    accessibility: {
      ...observation.accessibility,
      headings: observation.accessibility.headings.map((heading) => ({
        ...heading,
        text: redact(heading.text)
      })),
      landmarks: observation.accessibility.landmarks.map((landmark) => ({
        ...landmark,
        name: landmark.name ? redact(landmark.name) : null
      }))
    },
    elements: observation.elements.map((element) => ({
      ...element,
      accessibleName: element.accessibleName ? redact(element.accessibleName) : null,
      text: redact(element.text)
    })),
    textSample: redact(observation.textSample),
    screenshotPath: observation.screenshotPath
      ? redact(observation.screenshotPath)
      : null
  };
}

function redactText(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues
    .reduce(
      (redacted, sensitiveValue) =>
        sensitiveValue.length > 0
          ? redacted.split(sensitiveValue).join("[REDACTED]")
          : redacted,
      value
    )
    .replace(/BUG-BENCH-\d{3}/g, "[BENCHMARK-BUG]");
}
