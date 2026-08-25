import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BrowserController } from "@vibeqa/agent-core";
import { PlaywrightBrowserController } from "@vibeqa/browser-playwright";
import type { LLMClient } from "@vibeqa/llm";
import { LLMTestPlanner, type TestPlanner } from "@vibeqa/planner";
import type { BrowserAction } from "@vibeqa/schemas";
import {
  TestTask,
  type TestCase,
  type TestResult,
  type TestStatus
} from "@vibeqa/test-engine";

export interface CreateTestRequestInput {
  websiteUrl: string;
  objective: string;
}

export type UserTestRequestStatus = "queued" | "running" | "completed" | "failed";

export interface UserTestRequest {
  id: string;
  websiteUrl: string;
  objective: string;
  status: UserTestRequestStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  runId: string | null;
  testStatus: TestStatus | null;
  error: string | null;
}

export interface UserTestExecution {
  runId: string;
  status: TestStatus;
}

export interface TestRequestExecutor {
  execute(input: CreateTestRequestInput, requestId: string): Promise<UserTestExecution>;
}

export interface UserTestWorkflowOptions {
  idFactory?: () => string;
  now?: () => Date;
}

export interface AgentTestRequestExecutorOptions {
  planner: TestPlanner;
  outputRoot: string;
  launchBrowser?: () => Promise<ClosableBrowserController>;
  artifactStore?: TestArtifactStore;
  now?: () => Date;
}

export interface TestArtifactStore {
  screenshotDirectory(runId: string): string;
  save(runId: string, result: TestResult): Promise<void>;
}

interface ClosableBrowserController extends BrowserController {
  close(): Promise<void>;
}

const MAX_OBJECTIVE_LENGTH = 1_000;
const MAX_URL_LENGTH = 2_048;

export class UserTestWorkflow {
  private readonly requests = new Map<string, UserTestRequest>();
  private readonly completions = new Map<string, Promise<UserTestRequest>>();
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly executor: TestRequestExecutor | null,
    options: UserTestWorkflowOptions = {}
  ) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  get available(): boolean {
    return this.executor !== null;
  }

  submit(input: CreateTestRequestInput): UserTestRequest {
    if (!this.executor) {
      throw new TestWorkflowUnavailableError();
    }

    const validated = validateCreateTestRequest(input);
    const request: UserTestRequest = {
      id: this.idFactory(),
      websiteUrl: validated.websiteUrl,
      objective: validated.objective,
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
        throw new TestWorkflowUnavailableError();
      }
      request.status = "completed";
      request.runId = execution.runId;
      request.testStatus = execution.status;
    } catch (error) {
      request.status = "failed";
      request.error = errorMessage(error);
    } finally {
      request.completedAt = this.now().toISOString();
    }

    return request;
  }
}

export class AgentTestRequestExecutor implements TestRequestExecutor {
  private readonly planner: TestPlanner;
  private readonly launchBrowser: () => Promise<ClosableBrowserController>;
  private readonly artifactStore: TestArtifactStore;
  private readonly now: () => Date;

  constructor(options: AgentTestRequestExecutorOptions) {
    this.planner = options.planner;
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
    const testCase = constrainPlannedTestCase(
      await this.planner.plan(input.objective, input.websiteUrl),
      input.websiteUrl
    );
    const runId = createRunId(this.now(), requestId);
    const browser = await this.launchBrowser();

    try {
      const task = new TestTask({
        browser,
        testCase,
        screenshotDirectory: this.artifactStore.screenshotDirectory(runId)
      });
      const result = sanitizeTestResult(await task.run());
      await this.artifactStore.save(runId, result);
      return { runId, status: result.status };
    } finally {
      await browser.close();
    }
  }
}

export class FileTestArtifactStore implements TestArtifactStore {
  constructor(private readonly outputRoot: string) {}

  screenshotDirectory(runId: string): string {
    return join(this.outputRoot, runId, "screenshots");
  }

  async save(runId: string, result: TestResult): Promise<void> {
    const outputDirectory = join(this.outputRoot, runId);
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeJson(join(outputDirectory, "report.json"), result),
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
  constructor() {
    super(
      "AI test planning is not configured. Set OPENAI_API_KEY and restart the dashboard."
    );
    this.name = "TestWorkflowUnavailableError";
  }
}

export function createUserTestWorkflow(
  llmClient: LLMClient | null,
  outputRoot: string
): UserTestWorkflow {
  const executor = llmClient
    ? new AgentTestRequestExecutor({
        planner: new LLMTestPlanner(llmClient),
        outputRoot
      })
    : null;
  return new UserTestWorkflow(executor);
}

export function validateCreateTestRequest(
  input: CreateTestRequestInput
): CreateTestRequestInput {
  const objective = input.objective.trim();
  const websiteUrl = input.websiteUrl.trim();

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
    objective
  };
}

function sanitizeTestResult(result: TestResult): TestResult {
  const sensitiveValues = result.executedSteps.flatMap((step) =>
    step.action.type === "type" && isSensitiveSelector(step.action.selector)
      ? [step.action.value]
      : []
  );
  const sanitized = structuredClone(result);
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
  return /password|passwd|secret|token|api[-_]?key|credential/i.test(selector);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected test execution error";
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
