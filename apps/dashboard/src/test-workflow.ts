import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Agent, type BrowserController } from "@vibeqa/agent-core";
import { AdaptiveExecutionController } from "@vibeqa/adaptive-execution";
import { PlaywrightBrowserController } from "@vibeqa/browser-playwright";
import {
  actionKey,
  createElementKey,
  createExplorationState,
  createPageStateFingerprint,
  generateActionCandidates,
  type ActionCandidate
} from "@vibeqa/explorer";
import { OllamaClient, type LLMClient } from "@vibeqa/llm";
import type { TestPlanner } from "@vibeqa/planner";
import { DefaultActionSafetyPolicy } from "@vibeqa/safety-policy";
import {
  BrowserActionSchema,
  type BrowserAction,
  type Observation
} from "@vibeqa/schemas";
import {
  TestTask,
  TestEvaluator,
  type BugReport,
  type ExecutedTestStep,
  type TestCase,
  type TestResult,
  type TestTaskOptions,
  type TestStatus
} from "@vibeqa/test-engine";

import { alphaExecutionPolicy, type QATestMode } from "./alpha-policy.js";
import type { ProductTestResult } from "./product-execution.js";
import { classifyProductOutcome, type ProductOutcome } from "./product-outcome.js";
import { createFunctionalFormSteps, parseFunctionalForm } from "./functional-form.js";
import {
  assertFunctionalPlan,
  checkFunctionalNavigationResult,
  localFunctionalKind
} from "./functional-objective.js";
export type { QATestMode } from "./alpha-policy.js";

import {
  redactCredentialValues,
  SecureAuthenticatedBrowserController,
  TEMPORARY_PASSWORD_PLACEHOLDER,
  TEMPORARY_USERNAME_PLACEHOLDER
} from "./secure-credentials.js";
import type { TemporaryLoginCredentials } from "./secure-credentials.js";

export interface CreateTestRequestInput {
  websiteUrl: string;
  objective: string;
  expectedBehavior: string;
  mode: QATestMode;
  credentials: TemporaryLoginCredentials | null;
}

export interface StoredTestConfiguration {
  websiteUrl: string;
  objective: string;
  expectedBehavior: string;
  mode: QATestMode;
  authenticationUsed: boolean;
}

export type UserTestRequestStatus = "queued" | "running" | "completed" | "failed";

export interface UserTestRequest {
  outcome?: ProductOutcome;
  id: string;
  websiteUrl: string;
  objective: string;
  expectedBehavior: string;
  mode: QATestMode;
  authenticationUsed: boolean;
  status: UserTestRequestStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  runId: string | null;
  testStatus: TestStatus | null;
  error: string | null;
}

export interface UserTestExecution {
  outcome?: ProductOutcome;
  runId: string;
  status: TestStatus;
}

export interface TestRequestExecutor {
  execute(input: CreateTestRequestInput, requestId: string): Promise<UserTestExecution>;
}

export interface UserTestWorkflowOptions {
  idFactory?: () => string;
  now?: () => Date;
  availableModes?: readonly QATestMode[];
}

export interface AgentTestRequestExecutorOptions {
  onApproval?: TestTaskOptions["onApproval"];
  planner?: TestPlanner | null;
  explorationClient?: LLMClient;
  outputRoot: string;
  launchBrowser?: () => Promise<ClosableBrowserController>;
  artifactStore?: TestArtifactStore;
  now?: () => Date;
}

export interface TestArtifactStore {
  screenshotDirectory(runId: string): string;
  save(
    runId: string,
    result: TestResult,
    configuration: StoredTestConfiguration
  ): Promise<void>;
}

interface ClosableBrowserController extends BrowserController {
  close(): Promise<void>;
}

const MAX_OBJECTIVE_LENGTH = 1_000;
const MAX_EXPECTED_BEHAVIOR_LENGTH = 1_500;
const MAX_URL_LENGTH = 2_048;
const ALL_TEST_MODES: readonly QATestMode[] = [
  "functional",
  "exploratory",
  "regression"
];

export class UserTestWorkflow {
  private readonly requests = new Map<string, UserTestRequest>();
  private readonly completions = new Map<string, Promise<UserTestRequest>>();
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly modes: readonly QATestMode[];

  constructor(
    private readonly executor: TestRequestExecutor | null,
    options: UserTestWorkflowOptions = {}
  ) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.modes = this.executor ? (options.availableModes ?? ALL_TEST_MODES) : [];
  }

  get available(): boolean {
    return this.modes.length > 0;
  }

  get availableModes(): readonly QATestMode[] {
    return [...this.modes];
  }

  supports(mode: QATestMode): boolean {
    return this.modes.includes(mode);
  }

  submit(input: CreateTestRequestInput): UserTestRequest {
    let validated: CreateTestRequestInput;
    try {
      validated = validateCreateTestRequest(input);
    } catch (error) {
      input.credentials?.clear();
      throw error;
    }
    if (!this.executor || !this.supports(validated.mode)) {
      validated.credentials?.clear();
      throw new TestWorkflowUnavailableError(validated.mode);
    }
    const request: UserTestRequest = {
      id: this.idFactory(),
      websiteUrl: validated.websiteUrl,
      objective: validated.objective,
      expectedBehavior: validated.expectedBehavior,
      mode: validated.mode,
      authenticationUsed: validated.credentials !== null,
      status: "queued",
      createdAt: this.now().toISOString(),
      startedAt: null,
      completedAt: null,
      runId: null,
      testStatus: null,
      error: null
    };
    this.requests.set(request.id, request);
    const completion = Promise.resolve().then(
      async () => await this.executeRequest(request, validated)
    );
    this.completions.set(request.id, completion);
    return copyRequest(request);
  }

  get(requestId: string): UserTestRequest | null {
    const request = this.requests.get(requestId);
    return request ? copyRequest(request) : null;
  }

  async waitForCompletion(requestId: string): Promise<UserTestRequest> {
    const completion = this.completions.get(requestId);
    if (!completion) {
      throw new Error(`Unknown test request ID: ${requestId}`);
    }
    return copyRequest(await completion);
  }

  private async executeRequest(
    request: UserTestRequest,
    input: CreateTestRequestInput
  ): Promise<UserTestRequest> {
    request.status = "running";
    request.startedAt = this.now().toISOString();

    try {
      const execution = await this.executor?.execute(input, request.id);
      if (!execution) {
        throw new TestWorkflowUnavailableError(input.mode);
      }
      request.status = "completed";
      request.runId = execution.runId;
      request.testStatus = execution.status;
      request.outcome =
        execution.outcome ?? classifyProductOutcome({ status: execution.status });
    } catch (error) {
      request.status = "failed";
      request.error = errorMessage(error, input.credentials);
      request.outcome = classifyProductOutcome({
        status: "failed",
        errors: [request.error]
      });
    } finally {
      request.completedAt = this.now().toISOString();
      input.credentials?.clear();
    }

    return request;
  }
}

export class AgentTestRequestExecutor implements TestRequestExecutor {
  private readonly onApproval: TestTaskOptions["onApproval"];
  private readonly planner: TestPlanner | null;
  private readonly explorationClient: LLMClient | undefined;
  private readonly launchBrowser: () => Promise<ClosableBrowserController>;
  private readonly artifactStore: TestArtifactStore;
  private readonly now: () => Date;

  constructor(options: AgentTestRequestExecutorOptions) {
    this.onApproval = options.onApproval;
    this.planner = options.planner ?? null;
    this.explorationClient = options.explorationClient;
    this.launchBrowser =
      options.launchBrowser ??
      (async () => await PlaywrightBrowserController.launch({ headless: true }));
    this.artifactStore =
      options.artifactStore ?? new FileTestArtifactStore(options.outputRoot);
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    input: CreateTestRequestInput,
    requestId: string
  ): Promise<UserTestExecution> {
    let browser: ClosableBrowserController | null = null;
    const startedAt = this.now();

    try {
      if (!ALL_TEST_MODES.includes(input.mode)) {
        throw new TestRequestValidationError("Select a valid testing mode.");
      }
      const policy = alphaExecutionPolicy(input.mode);
      const testCase =
        policy.strategy === "deterministic" && this.planner
          ? await this.createTestCase(input)
          : null;
      const runId = createRunId(this.now(), requestId);
      browser = await this.launchBrowser();
      const executionBrowser = input.credentials
        ? new SecureAuthenticatedBrowserController(browser, input.credentials)
        : browser;
      let executionResult: ProductTestResult;
      switch (input.mode) {
        case "exploratory":
          executionResult = await this.runExploration(
            executionBrowser,
            input,
            this.artifactStore.screenshotDirectory(runId)
          );
          break;
        case "functional":
        case "regression": {
          const functionalCase =
            testCase ?? (await createLocalTestCase(input, executionBrowser));
          if (input.mode === "functional")
            assertFunctionalPlan(input.objective, functionalCase);
          executionResult = await new TestTask({
            browser: executionBrowser,
            testCase: functionalCase,
            onApproval: this.onApproval,
            screenshotDirectory: this.artifactStore.screenshotDirectory(runId)
          }).run();
          break;
        }
      }
      const completedAt = this.now();
      const observations = executionResult.trace.steps.flatMap((step) =>
        step.observation ? [step.observation] : []
      );
      executionResult.execution ??= {
        requestedMode: input.mode,
        strategy: this.planner ? "custom" : "deterministic",
        modelInvocationCount: 0,
        terminationReason:
          executionResult.status === "passed" ? "workflow-complete" : "workflow-failed",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        pagesVisited: unique(observations.map((observation) => observation.url)),
        stateCount: unique(observations.map(createPageStateFingerprint)).length,
        actionCount: executionResult.executedSteps.length
      };
      executionResult.execution.startedAt = startedAt.toISOString();
      executionResult.execution.completedAt = completedAt.toISOString();
      executionResult.execution.durationMs =
        completedAt.getTime() - startedAt.getTime();
      executionResult.trace.execution = executionResult.execution;
      const result = sanitizeTestResult(executionResult, input.credentials);
      if (input.mode === "functional") {
        checkFunctionalNavigationResult(input.objective, result);
      }
      await this.artifactStore.save(runId, result, storedConfiguration(input));
      return { runId, status: result.status, outcome: classifyProductOutcome(result) };
    } catch (error) {
      throw new Error(errorMessage(error, input.credentials));
    } finally {
      input.credentials?.clear();
      await browser?.close();
    }
  }

  private async createTestCase(input: CreateTestRequestInput): Promise<TestCase> {
    if (!this.planner) {
      throw new TestWorkflowUnavailableError(input.mode);
    }
    const planned = constrainPlannedTestCase(
      await this.planner.plan(
        redactCredentialValues(buildPlannerRequest(input), input.credentials),
        input.websiteUrl
      ),
      input.websiteUrl
    );
    if (!planned.steps.some(isVerificationStep)) {
      throw new TestRequestValidationError(
        "The generated plan did not include a verifiable expected outcome."
      );
    }
    return { ...planned, goal: input.objective };
  }

  private async runExploration(
    browser: BrowserController,
    input: CreateTestRequestInput,
    screenshotDirectory: string
  ): Promise<ProductTestResult> {
    const targetOrigin = new URL(input.websiteUrl).origin;
    const goal = input.objective;
    const state = createExplorationState(input.websiteUrl, goal);
    const baselineSafety = new DefaultActionSafetyPolicy();
    const evidenceBrowser = new EvidenceBrowserController(browser, screenshotDirectory);
    const localClient = this.explorationClient ?? new OllamaClient();
    const controller: AdaptiveExecutionController = new AdaptiveExecutionController({
      deterministicClient: {
        generate: async (): Promise<string> => {
          const observation = agent.state.currentObservation;
          if (!observation) return "null";
          const fingerprint = createPageStateFingerprint(observation);
          state.visitedUrls = unique([...state.visitedUrls, observation.url]);
          state.executedActions = agent.getTrace().steps.flatMap((step) => {
            if (!step.action || !step.observation) return [];
            const traceAction = step.action;
            const action =
              traceAction.type === "type"
                ? (agent.state.actionHistory.find(
                    (previous) =>
                      previous.type === "type" &&
                      previous.selector === traceAction.selector
                  ) ?? traceAction)
                : traceAction;
            const element =
              "selector" in action
                ? step.observation.elements.find(
                    (item) => item.selector === action.selector
                  )
                : null;
            return [
              {
                candidateId: "",
                elementKey: element ? createElementKey(element) : "",
                fromStateFingerprint: createPageStateFingerprint(step.observation),
                toStateFingerprint: fingerprint,
                action,
                actionKey: actionKey(action),
                success: step.result.success
              }
            ];
          });
          const candidate = sameOriginCandidates(
            authenticatedCandidates(
              observation,
              fingerprint,
              state,
              input.credentials !== null
            ),
            targetOrigin
          ).find(
            (item) =>
              baselineSafety.evaluate(item.action, {
                goal,
                observation,
                actionHistory: agent.state.actionHistory
              }).decision === "allow"
          );
          return candidate ? JSON.stringify(candidate.action) : "null";
        }
      },
      ollamaClient: {
        generate: async (prompt) => {
          let response: string;
          try {
            response = await localClient.generate(
              [
                "Return only one BrowserAction JSON object or null, with no explanation.",
                "Use canonical fields: navigate {url}, click {selector}, type {selector,value}, wait {ms}, screenshot {}, getText {selector}, getCurrentUrl {}, assert {selector,containsText}. Include the action type in the type field.",
                "For click/type, copy a unique visible enabled selector from the current observation. Observation IDs such as element-7 are NOT DOM IDs or CSS selectors. For ambiguous links use navigate with the observed href. Do not reuse a failed target.",
                `Element recovery: ${redactCredentialValues(JSON.stringify(agent.getElementRecoveryContext()), input.credentials)}`,
                redactCredentialValues(prompt, input.credentials)
              ].join("\n")
            );
          } catch (error) {
            const endpoint =
              localClient instanceof OllamaClient ? ` at ${localClient.baseUrl}` : "";
            throw new Error(
              `Local exploration model unavailable${endpoint}: ${errorMessage(error, input.credentials)}`
            );
          }
          // Both the frozen controller and Agent receive the same canonical JSON.
          // In particular, a fenced null must reach Adaptive's bounded null policy.
          try {
            const trimmed = response.trim();
            const json =
              /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
            const action: unknown = JSON.parse(json);
            return action === null
              ? "null"
              : JSON.stringify(BrowserActionSchema.parse(action));
          } catch {
            throw new Error(
              "Local exploration model returned invalid BrowserAction JSON."
            );
          }
        }
      },
      maxSteps: 12,
      opportunityPreservationEnabled:
        alphaExecutionPolicy(input.mode).adaptivePolicyVersion === "v2",
      knownWorkflow: false,
      escalateWhenDeterministicExhausted: false
    });
    const agent: Agent = new Agent({
      browser: evidenceBrowser,
      llmClient: controller,
      recoverElementActions: true,
      maxSteps: 12,
      safetyPolicy: {
        evaluate: (action, context) => {
          const destination =
            "url" in action
              ? action.url
              : action.type === "click"
                ? context.observation?.elements.find(
                    (element) => element.selector === action.selector
                  )?.href
                : null;
          if (
            destination &&
            new URL(destination, input.websiteUrl).origin !== targetOrigin
          ) {
            return {
              decision: "block",
              reason: "The action leaves the submitted website."
            };
          }
          return baselineSafety.evaluate(action, context);
        }
      }
    });
    await evidenceBrowser.navigate(input.websiteUrl);
    await agent.run(goal);
    const metadata = controller.getMetadata(agent.state.stepCount);
    const lifecycleErrors =
      metadata.postHandoffTerminationReason === "null-retry-exhausted"
        ? [
            "Exploration stopped without confirming the objective; useful actions remain."
          ]
        : [];
    const result: ProductTestResult = explorationToTestResult(
      agent,
      input.objective,
      lifecycleErrors
    );
    // An optional assertion evaluates the final page; it never supplies the plan.
    if (
      input.expectedBehavior.trim() &&
      agent.state.currentObservation &&
      !agent.getPendingApproval()
    ) {
      const assertionAgent = new Agent({
        browser: evidenceBrowser,
        llmClient: {
          generate: async () => JSON.stringify({ type: "getText", selector: "body" })
        },
        maxSteps: 1,
        safetyPolicy: baselineSafety
      });
      await assertionAgent.run("Verify optional final page text");
      const assertion = explorationToTestResult(
        assertionAgent,
        input.objective,
        [],
        input.expectedBehavior,
        evidenceBrowser.lastPageText
      );
      const stepOffset = result.executedSteps.length;
      result.executedSteps.push(
        ...assertion.executedSteps.map((step) => ({
          ...step,
          index: step.index + stepOffset
        }))
      );
      result.trace.steps.push(...assertion.trace.steps);
      result.screenshots = unique([...result.screenshots, ...assertion.screenshots]);
      result.errors = unique([...result.errors, ...assertion.errors]);
      result.bugReports.push(
        ...assertion.bugReports.map((bug) => ({
          ...bug,
          stepIndex: bug.stepIndex + stepOffset
        }))
      );
      if (assertion.status === "failed") result.status = "failed";
    }
    const observations = result.trace.steps.flatMap((step) =>
      step.observation ? [step.observation] : []
    );
    result.execution = {
      requestedMode: "exploratory",
      strategy: "adaptive-v2",
      modelInvocationCount: metadata.ollamaInvocationCount,
      terminationReason: agent.getPendingApproval()
        ? "approval-required"
        : agent.state.errors.some((error) =>
              error.startsWith("STALE_ELEMENT_RECOVERY_FAILED")
            )
          ? "STALE_ELEMENT_RECOVERY_FAILED"
          : agent.state.errors.length
            ? "agent-error"
            : agent.state.stepCount >= 12
              ? "max-steps"
              : metadata.postHandoffTerminationReason &&
                  metadata.postHandoffTerminationReason !== "none"
                ? metadata.postHandoffTerminationReason
                : "planner-stopped",
      startedAt: "",
      completedAt: "",
      durationMs: 0,
      pagesVisited: unique(observations.map((observation) => observation.url)),
      stateCount: unique(observations.map(createPageStateFingerprint)).length,
      actionCount: agent.state.actionHistory.length,
      elementRecovery: {
        failedTargets: result.trace.steps.filter((step) => step.elementRecovery).length,
        replanAttempts: result.trace.steps.filter(
          (step) => step.elementRecovery?.recoveryObservationId
        ).length,
        recoveredTargets: result.trace.steps.filter(
          (step) => step.elementRecovery?.status === "recovered"
        ).length
      },
      escalationReason: metadata.escalationReason,
      plannerDecisions: metadata.plannerDecisions.map((decision) => ({
        phase: decision.phase,
        outcome: decision.outcome,
        actionType: decision.action?.type ?? null
      }))
    };
    return result;
  }
}

function authenticatedCandidates(
  observation: Observation,
  stateFingerprint: string,
  state: Parameters<typeof generateActionCandidates>[2],
  authenticationAvailable: boolean
): ActionCandidate[] {
  const candidates = generateActionCandidates(observation, stateFingerprint, state);
  if (!authenticationAvailable) {
    return candidates;
  }

  const credentialCandidates: ActionCandidate[] = observation.elements.flatMap(
    (element): ActionCandidate[] => {
      if (!element.visible || !element.enabled || !element.editable) {
        return [];
      }
      const credentialKind = classifyCredentialElement(
        element.selector,
        element.inputType
      );
      if (!credentialKind) {
        return [];
      }
      const action: BrowserAction = {
        type: "type",
        selector: element.selector,
        value:
          credentialKind === "password"
            ? TEMPORARY_PASSWORD_PLACEHOLDER
            : TEMPORARY_USERNAME_PLACEHOLDER
      };
      const key = actionKey(action);
      if (
        state.executedActions.some(
          (record) =>
            record.fromStateFingerprint === stateFingerprint && record.actionKey === key
        ) ||
        state.failedActions.some(
          (record) =>
            record.stateFingerprint === stateFingerprint && record.actionKey === key
        )
      ) {
        return [];
      }
      return [
        {
          id: `candidate-${stateFingerprint}-credential-${element.id}`,
          stateFingerprint,
          elementId: element.id,
          elementKey: createElementKey(element),
          action,
          score: credentialKind === "username" ? 180 : 170,
          reasons: ["temporary authentication field"]
        }
      ];
    }
  );

  const credentialSelectors = new Set(
    credentialCandidates.map((candidate) =>
      candidate.action.type === "type" ? candidate.action.selector : ""
    )
  );
  return [...credentialCandidates, ...candidates].filter(
    (candidate) =>
      candidate.action.type !== "type" ||
      !credentialSelectors.has(candidate.action.selector) ||
      credentialCandidates.includes(candidate)
  );
}

function sameOriginCandidates(
  candidates: ActionCandidate[],
  targetOrigin: string
): ActionCandidate[] {
  return candidates.filter((candidate) => {
    const action = candidate.action;
    return action.type !== "navigate" && action.type !== "goto"
      ? true
      : new URL(action.url).origin === targetOrigin;
  });
}

class EvidenceBrowserController implements BrowserController {
  private observationIndex = 0;
  private navigationPending = false;
  lastPageText: string | undefined;

  constructor(
    private readonly browser: BrowserController,
    private readonly screenshotDirectory: string
  ) {}

  async observe(): Promise<Observation> {
    if (this.navigationPending) await this.browser.wait(500);
    this.navigationPending = false;
    let observation = await this.browser.observe();
    // Bound the SPA loading wait; do not plan against an empty/loading-only body.
    for (
      let attempt = 0;
      isLoadingObservation(observation) && attempt < 10;
      attempt += 1
    ) {
      await this.browser.wait(500);
      observation = await this.browser.observe();
    }
    const path = join(
      this.screenshotDirectory,
      `observation-${String(this.observationIndex).padStart(3, "0")}.png`
    );
    this.observationIndex += 1;
    const screenshotPath = await this.browser.screenshot({ path });
    if (isLoadingObservation(observation)) {
      throw new Error(
        "The page remained empty or loading after the readiness wait. Exploration did not begin on this page."
      );
    }
    return {
      ...observation,
      screenshotPath: typeof screenshotPath === "string" ? screenshotPath : null
    };
  }

  async goto(url: string): Promise<void> {
    await this.browser.goto(url);
    this.navigationPending = true;
  }

  async navigate(url: string): Promise<void> {
    await this.browser.navigate(url);
    this.navigationPending = true;
  }

  async click(selector: string): Promise<void> {
    await this.browser.click(selector);
    this.navigationPending = true;
  }

  async type(selector: string, value: string): Promise<void> {
    await this.browser.type(selector, value);
  }

  async getText(selector: string): Promise<string> {
    const text = await this.browser.getText(selector);
    if (selector === "body") this.lastPageText = text;
    return text;
  }

  async wait(ms: number): Promise<void> {
    await this.browser.wait(ms);
  }

  async screenshot(): Promise<Uint8Array | string> {
    const path = join(
      this.screenshotDirectory,
      `capture-${this.observationIndex++}.png`
    );
    return await this.browser.screenshot({ path });
  }

  async assert(selector: string, containsText: string): Promise<void> {
    await this.browser.assert(selector, containsText);
  }

  getCurrentUrl(): string {
    return this.browser.getCurrentUrl();
  }
}

function isLoadingObservation(observation: Observation): boolean {
  const text = observation.textSample.replace(/\s+/gu, " ").trim();
  return (
    !text || /^(?:loading|please wait|loading please wait)[\s.!\u2026]*$/i.test(text)
  );
}

export class FileTestArtifactStore implements TestArtifactStore {
  constructor(private readonly outputRoot: string) {}

  screenshotDirectory(runId: string): string {
    return join(this.outputRoot, runId, "screenshots");
  }

  async save(
    runId: string,
    result: TestResult,
    configuration: StoredTestConfiguration
  ): Promise<void> {
    const outputDirectory = join(this.outputRoot, runId);
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeJson(join(outputDirectory, "report.json"), {
        ...result,
        configuration
      }),
      writeJson(join(outputDirectory, "trace.json"), result.trace)
    ]);
  }
}

export class TestRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestRequestValidationError";
  }
}

export class TestWorkflowUnavailableError extends Error {
  constructor(mode: QATestMode) {
    super(`${testModeLabel(mode)} testing is not available in this workflow.`);
    this.name = "TestWorkflowUnavailableError";
  }
}

export function createUserTestWorkflow(
  llmClient: LLMClient | null,
  outputRoot: string
): UserTestWorkflow {
  const executor = new AgentTestRequestExecutor({
    explorationClient: llmClient ?? undefined,
    outputRoot
  });
  return new UserTestWorkflow(executor);
}

export function validateCreateTestRequest(
  input: CreateTestRequestInput
): CreateTestRequestInput {
  const objective = input.objective.trim();
  const expectedBehavior = input.expectedBehavior.trim();
  const websiteUrl = input.websiteUrl.trim();

  if (!ALL_TEST_MODES.includes(input.mode)) {
    throw new TestRequestValidationError("Select a valid testing mode.");
  }

  if (objective.length === 0) {
    throw new TestRequestValidationError("Test objective is required.");
  }
  if (objective.length > MAX_OBJECTIVE_LENGTH) {
    throw new TestRequestValidationError(
      `Test objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer.`
    );
  }
  if (containsLikelySecret(objective)) {
    throw new TestRequestValidationError(
      "Do not include passwords, API keys, tokens, or other secrets in the test objective."
    );
  }
  if (expectedBehavior.length === 0 && input.mode !== "exploratory") {
    throw new TestRequestValidationError("Expected visible page text is required.");
  }
  if (expectedBehavior.length > MAX_EXPECTED_BEHAVIOR_LENGTH) {
    throw new TestRequestValidationError(
      `Expected visible page text must be ${MAX_EXPECTED_BEHAVIOR_LENGTH} characters or fewer.`
    );
  }
  if (containsLikelySecret(expectedBehavior)) {
    throw new TestRequestValidationError(
      "Do not include passwords, API keys, tokens, or other secrets in the expected visible page text."
    );
  }
  if (websiteUrl.length === 0) {
    throw new TestRequestValidationError("Website URL is required.");
  }
  if (websiteUrl.length > MAX_URL_LENGTH) {
    throw new TestRequestValidationError(
      `Website URL must be ${MAX_URL_LENGTH} characters or fewer.`
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(websiteUrl);
  } catch {
    throw new TestRequestValidationError("Website URL must be a valid URL.");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new TestRequestValidationError("Website URL must use HTTP or HTTPS.");
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new TestRequestValidationError(
      "Website URL must not contain embedded credentials."
    );
  }

  return {
    websiteUrl: parsedUrl.toString(),
    objective: input.credentials?.redact(objective) ?? objective,
    expectedBehavior: input.credentials?.redact(expectedBehavior) ?? expectedBehavior,
    mode: input.mode,
    credentials: input.credentials
  };
}

function buildPlannerRequest(input: CreateTestRequestInput): string {
  const modeInstruction =
    input.mode === "regression"
      ? "Create a regression plan that verifies the expected behavior still holds."
      : "Create a functional plan that exercises the objective and verifies the outcome.";
  return [
    `Testing mode: ${testModeLabel(input.mode)}`,
    `Objective: ${input.objective}`,
    `Expected behavior: ${input.expectedBehavior}`,
    input.credentials
      ? `Authentication: Temporary credentials are available only during browser execution. Use ${TEMPORARY_USERNAME_PLACEHOLDER} for the username or email value and ${TEMPORARY_PASSWORD_PLACEHOLDER} for the password value. Never invent or request literal credentials.`
      : "Authentication: No temporary credentials were supplied.",
    modeInstruction,
    "Include at least one explicit assertion or expected result."
  ].join("\n");
}

function isVerificationStep(step: TestCase["steps"][number]): boolean {
  return step.action.type === "assert" || step.expected !== undefined;
}

async function createLocalTestCase(
  input: CreateTestRequestInput,
  browser: BrowserController
): Promise<TestCase> {
  const steps: TestCase["steps"] = [];
  const kind =
    input.mode === "functional"
      ? localFunctionalKind(input.objective, input.credentials !== null)
      : "text";
  if (kind === "navigation") {
    steps.push(...(await createLocalNavigationSteps(input, browser)));
  }
  if (kind === "form") {
    steps.push(
      ...(await createFunctionalFormSteps(
        parseFunctionalForm(input.objective) ?? [],
        browser,
        input.websiteUrl
      ))
    );
  }
  if (input.credentials) {
    await browser.navigate(input.websiteUrl);
    const observation = await browser.observe();
    const elements = observation.elements.filter(
      (element) => element.visible && element.enabled
    );
    const usernames = elements.filter(
      (element) =>
        element.editable &&
        classifyCredentialElement(element.selector, element.inputType) === "username"
    );
    const passwords = elements.filter(
      (element) =>
        element.editable &&
        classifyCredentialElement(element.selector, element.inputType) === "password"
    );
    const submits = elements.filter(
      (element) =>
        (element.tagName === "button" ||
          element.role === "button" ||
          element.inputType === "submit") &&
        /\b(?:sign[ -]?in|log[ -]?in)\b/i.test(
          `${element.accessibleName ?? ""} ${element.text}`
        )
    );
    const username = usernames[0];
    const password = passwords[0];
    const submit = submits[0];
    if (
      usernames.length !== 1 ||
      passwords.length !== 1 ||
      submits.length !== 1 ||
      !username ||
      !password ||
      !submit
    ) {
      throw new TestRequestValidationError(
        "The local login check requires one visible username field, password field, and sign-in button. Use a structured test for other workflows."
      );
    }
    steps.push(
      {
        name: "Enter temporary username",
        action: {
          type: "type",
          selector: username.selector,
          value: TEMPORARY_USERNAME_PLACEHOLDER
        }
      },
      {
        name: "Enter temporary password",
        action: {
          type: "type",
          selector: password.selector,
          value: TEMPORARY_PASSWORD_PLACEHOLDER
        }
      },
      { name: "Sign in", action: { type: "click", selector: submit.selector } },
      { name: "Wait for sign-in result", action: { type: "wait", ms: 250 } }
    );
  }
  steps.push({
    name: "Verify expected visible page text",
    action: { type: "getText", selector: "body" },
    expected: { requiredText: input.expectedBehavior }
  });
  return { goal: input.objective, startUrl: input.websiteUrl, steps };
}

async function createLocalNavigationSteps(
  input: CreateTestRequestInput,
  browser: BrowserController
): Promise<TestCase["steps"]> {
  const lines = input.expectedBehavior
    .split(/\r\n|[\r\n\u2028\u2029]/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const label = lines[0];
  if (lines.length !== 1 || !label) {
    throw new TestRequestValidationError(
      "A local navigation check requires one exact navigation control label in Expected visible page text. Use a structured TestCase for separate targets and expectations."
    );
  }
  await browser.navigate(input.websiteUrl);
  await browser.wait(500);
  const observation = await browser.observe();
  // Exact, visible control-like elements only. List items cover SPA menus without
  // changing the shared observation collector or Explorer candidate generation.
  const selector = `:is(a, button, [role="link"], [role="button"], [role="menuitem"], li):visible:not(:disabled):not([aria-disabled="true"]):text-is(${JSON.stringify(label)})`;
  try {
    if (!(await browser.getText("body")).replace(/\s+/gu, " ").includes(label)) {
      throw new Error("Label absent from page");
    }
    const text = await browser.getText(selector);
    if (text.replace(/\s+/gu, " ").trim() !== label) throw new Error("Label mismatch");
  } catch {
    throw new TestRequestValidationError(
      "Navigation target is missing, ambiguous, or unsupported. Expected visible page text must name one visible navigation control exactly; use a structured TestCase otherwise."
    );
  }
  const matchingLinks = observation.elements.filter(
    (element) =>
      element.visible &&
      element.enabled &&
      element.href &&
      [element.text, element.accessibleName].some(
        (name) => name?.replace(/\s+/gu, " ").trim() === label
      )
  );
  if (
    matchingLinks.some(
      (element) =>
        element.href &&
        new URL(element.href).origin !== new URL(input.websiteUrl).origin
    )
  ) {
    throw new TestRequestValidationError(
      "Navigation target is outside the submitted website."
    );
  }
  return [
    { name: "Wait for homepage navigation", action: { type: "wait", ms: 500 } },
    {
      name: "Open requested navigation target",
      action: { type: "click", selector },
      expected: { urlChanged: true }
    },
    { name: "Wait for destination page", action: { type: "wait", ms: 500 } },
    ...(matchingLinks[0]?.href
      ? [
          {
            name: "Verify destination URL",
            action: { type: "getCurrentUrl" as const },
            expected: { url: matchingLinks[0].href }
          }
        ]
      : [])
  ];
}

function explorationToTestResult(
  agent: Agent,
  objective: string,
  lifecycleErrors: string[],
  expectedText?: string,
  visiblePageText?: string
): TestResult {
  const trace = agent.getTrace();
  const evaluator = new TestEvaluator();
  const executedSteps: ExecutedTestStep[] = [];
  const bugReports: BugReport[] = [];
  for (const [traceIndex, step] of trace.steps.entries()) {
    // Locator recovery is an Agent event, not evidence of a website defect.
    // Preserve it in the trace without counting it as an executed browser action.
    if (!step.action || step.elementRecovery) continue;
    const observation =
      trace.steps.slice(traceIndex + 1).find((next) => next.observation)?.observation ??
      null;
    const testStep = {
      name: expectedText
        ? "Verify optional final page text"
        : `Explore with ${step.action.type}`,
      action: step.action,
      ...(expectedText ? { expected: { requiredText: expectedText } } : {})
    };
    const index = executedSteps.length;
    const evaluation = evaluator.evaluate(
      testStep,
      index,
      step,
      step.observation,
      observation,
      visiblePageText
    );
    bugReports.push(...evaluation.bugReports);
    executedSteps.push({
      index,
      ...testStep,
      observation,
      status: evaluation.success ? "passed" : "failed",
      evaluatorFeedback: step.evaluation ?? null,
      errors: evaluation.errors
    });
  }
  if (agent.getPendingApproval()) {
    lifecycleErrors.push(
      "Exploration stopped because an action requires human approval. No risky action was executed."
    );
  }
  const errors = unique([
    ...agent.state.errors,
    ...executedSteps.flatMap((step) => step.errors),
    ...trace.steps.flatMap(
      (step) => step.observation?.consoleErrors.map((error) => error.text) ?? []
    ),
    ...lifecycleErrors
  ]);

  if (bugReports.length === 0 && errors.length > 0) {
    bugReports.push({
      title: "Exploratory test halted",
      description: errors[0] ?? "The exploratory test halted.",
      stepIndex: -1,
      stepName: "Exploration session",
      category: "evaluation",
      evidence: {
        url: agent.state.currentObservation?.url ?? null,
        consoleErrors: agent.state.currentObservation?.consoleErrors ?? [],
        screenshot: agent.state.currentObservation?.screenshotPath ?? null
      }
    });
  }

  return {
    goal: objective,
    status: bugReports.length === 0 && errors.length === 0 ? "passed" : "failed",
    executedSteps,
    screenshots: unique(
      trace.steps.flatMap((step) =>
        step.observation?.screenshotPath ? [step.observation.screenshotPath] : []
      )
    ),
    errors,
    bugReports,
    trace: {
      goal: objective,
      steps: trace.steps
    }
  };
}

function sanitizeTestResult<T extends TestResult>(
  result: T,
  credentials: TemporaryLoginCredentials | null = null
): T {
  const sensitiveValues = result.executedSteps.flatMap((step) =>
    step.action.type === "type" && isSensitiveSelector(step.action.selector)
      ? [step.action.value]
      : []
  );
  const sanitized = redactCredentialValues(structuredClone(result), credentials);
  sanitized.executedSteps = sanitized.executedSteps.map((step) => ({
    ...step,
    action: sanitizeAction(step.action)
  }));
  sanitized.trace.steps = sanitized.trace.steps.map((step) => ({
    ...step,
    action: step.action ? sanitizeAction(step.action) : null,
    thought: {
      prompt: redactText(step.thought.prompt, sensitiveValues),
      reasoning: redactText(step.thought.reasoning, sensitiveValues)
    }
  }));
  return sanitized;
}

function sanitizeAction(action: BrowserAction): BrowserAction {
  if (action.type === "type" && isSensitiveSelector(action.selector)) {
    return { ...action, value: "[REDACTED]" };
  }
  return action;
}

function isSensitiveSelector(selector: string): boolean {
  return /password|passwd|secret|token|api[-_]?key|credential|username|user-name|email|login|account/i.test(
    selector
  );
}

function redactText(
  value: string | undefined,
  sensitiveValues: readonly string[]
): string | undefined {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    redacted = redacted?.split(sensitiveValue).join("[REDACTED]");
  }
  return redacted;
}

function containsLikelySecret(value: string): boolean {
  return /(?:password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*\S+/i.test(value);
}

function classifyCredentialElement(
  selector: string,
  inputType: string | null | undefined
): "username" | "password" | null {
  if (inputType?.toLowerCase() === "password" || /password|passwd/i.test(selector)) {
    return "password";
  }
  if (
    inputType?.toLowerCase() === "email" ||
    /username|user-name|email|login|account/i.test(selector)
  ) {
    return "username";
  }
  return null;
}

function storedConfiguration(input: CreateTestRequestInput): StoredTestConfiguration {
  return redactCredentialValues(
    {
      websiteUrl: input.websiteUrl,
      objective: input.objective,
      expectedBehavior: input.expectedBehavior,
      mode: input.mode,
      authenticationUsed: input.credentials !== null
    },
    input.credentials
  );
}

function testModeLabel(mode: QATestMode): string {
  return `${mode[0]?.toUpperCase() ?? ""}${mode.slice(1)}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function constrainPlannedTestCase(testCase: TestCase, requestedUrl: string): TestCase {
  const requestedOrigin = new URL(requestedUrl).origin;
  return {
    ...testCase,
    steps: testCase.steps.map((step) => {
      const action = step.action;
      if (action.type === "navigate" || action.type === "goto") {
        if (new URL(action.url).origin !== requestedOrigin) {
          throw new TestRequestValidationError(
            "The planned test attempted to navigate outside the submitted website."
          );
        }
      }

      return {
        ...step,
        action: action.type === "screenshot" ? { type: "screenshot" } : action
      };
    })
  };
}

function createRunId(date: Date, requestId: string): string {
  const timestamp = date.toISOString().replace(/[:.]/g, "-");
  const suffix = requestId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return `${timestamp}-request-${suffix || "test"}`;
}

function copyRequest(request: UserTestRequest): UserTestRequest {
  return { ...request };
}

function errorMessage(
  error: unknown,
  credentials: TemporaryLoginCredentials | null = null
): string {
  const message =
    error instanceof Error ? error.message : "Unexpected test execution error";
  return credentials ? credentials.redact(message) : message;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
