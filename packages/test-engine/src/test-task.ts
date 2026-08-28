import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  Agent,
  type AgentTrace,
  type AgentTraceStep,
  type BrowserController
} from "@vibeqa/agent-core";
import type { LLMClient } from "@vibeqa/llm";
import type { BrowserAction, Observation } from "@vibeqa/schemas";

import { TestEvaluator } from "./test-evaluator.js";
import type { BugReport, ExecutedTestStep, TestCase, TestResult } from "./types.js";

export interface TestTaskOptions {
  browser: BrowserController;
  testCase: TestCase;
  screenshotDirectory?: string;
  evaluator?: TestEvaluator;
  llmClient?: LLMClient;
  maxSteps?: number;
}

export class TestTask {
  private readonly browser: BrowserController;
  private readonly testCase: TestCase;
  private readonly evaluator: TestEvaluator;
  private readonly screenshotDirectory: string;
  private readonly llmClient: LLMClient;
  private readonly maxSteps: number;

  constructor(options: TestTaskOptions) {
    this.browser = options.browser;
    this.testCase = options.testCase;
    this.evaluator = options.evaluator ?? new TestEvaluator();
    this.screenshotDirectory =
      options.screenshotDirectory ?? join(process.cwd(), "run-output", "test-engine");
    this.llmClient =
      options.llmClient ??
      new TestStepClient(this.testCase.steps.map((step) => step.action));
    this.maxSteps = options.maxSteps ?? this.testCase.steps.length + 1;
  }

  async run(): Promise<TestResult> {
    validateTestCase(this.testCase);

    const reportingBrowser = new ReportingBrowserController(
      this.browser,
      join(this.screenshotDirectory, randomUUID())
    );
    const agent = new Agent({
      browser: reportingBrowser,
      llmClient: this.llmClient,
      maxSteps: this.maxSteps
    });

    try {
      await reportingBrowser.navigate(this.testCase.startUrl);
      await agent.run(this.testCase.goal);
    } catch (error) {
      const message = errorMessage(error);
      return {
        goal: this.testCase.goal,
        status: "failed",
        executedSteps: [],
        screenshots: [],
        errors: [message],
        bugReports: [createSetupBug(message)],
        trace: agent.getTrace()
      };
    }

    return this.createResult(agent.getTrace());
  }

  private createResult(trace: AgentTrace): TestResult {
    const actionSteps = trace.steps
      .map((step, traceIndex) => ({ step, traceIndex }))
      .filter(
        (
          entry
        ): entry is {
          step: AgentTraceStep & { action: BrowserAction };
          traceIndex: number;
        } => entry.step.action !== null
      );
    const executedSteps: ExecutedTestStep[] = [];
    const bugReports: BugReport[] = [];

    for (const [index, testStep] of this.testCase.steps.entries()) {
      const actionEntry = actionSteps[index];
      const actionTrace = actionEntry?.step ?? null;
      const previousObservation = actionTrace?.observation ?? null;
      const newObservation = actionEntry
        ? findNextObservation(trace.steps, actionEntry.traceIndex + 1)
        : null;
      const evaluation = this.evaluator.evaluate(
        testStep,
        index,
        actionTrace,
        previousObservation,
        newObservation
      );

      bugReports.push(...evaluation.bugReports);
      executedSteps.push({
        index,
        name: testStep.name,
        action: testStep.action,
        observation: newObservation,
        status: evaluation.success ? "passed" : "failed",
        evaluatorFeedback: actionTrace?.evaluation ?? null,
        errors: evaluation.errors
      });
    }

    const errors = unique([
      ...executedSteps.flatMap((step) => step.errors),
      ...trace.steps.flatMap((step) => (step.result.error ? [step.result.error] : []))
    ]);
    const screenshots = unique(
      trace.steps.flatMap((step) =>
        step.observation?.screenshotPath ? [step.observation.screenshotPath] : []
      )
    );

    return {
      goal: this.testCase.goal,
      status:
        executedSteps.length === this.testCase.steps.length && errors.length === 0
          ? "passed"
          : "failed",
      executedSteps,
      screenshots,
      errors,
      bugReports,
      trace
    };
  }
}

class TestStepClient implements LLMClient {
  private actionIndex = 0;

  constructor(private readonly actions: BrowserAction[]) {}

  async generate(): Promise<string> {
    const action = this.actions[this.actionIndex];
    this.actionIndex += 1;
    return action ? JSON.stringify(action) : "null";
  }
}

class ReportingBrowserController implements BrowserController {
  private observationIndex = 0;

  constructor(
    private readonly browser: BrowserController,
    private readonly screenshotDirectory: string
  ) {}

  async observe(): Promise<Observation> {
    const path = join(
      this.screenshotDirectory,
      `observation-${String(this.observationIndex).padStart(3, "0")}.png`
    );
    this.observationIndex += 1;
    const screenshotPath = await this.browser.screenshot({ path });
    const observation = await this.browser.observe();

    return {
      ...observation,
      screenshotPath: typeof screenshotPath === "string" ? screenshotPath : null
    };
  }

  async goto(url: string): Promise<void> {
    await this.browser.goto(url);
  }

  async navigate(url: string): Promise<void> {
    await this.browser.navigate(url);
  }

  async click(selector: string): Promise<void> {
    await this.browser.click(selector);
  }

  async type(selector: string, value: string): Promise<void> {
    await this.browser.type(selector, value);
  }

  async getText(selector: string): Promise<string> {
    return await this.browser.getText(selector);
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

function findNextObservation(
  traceSteps: AgentTraceStep[],
  startIndex: number
): Observation | null {
  return (
    traceSteps.slice(startIndex).find((step) => step.observation)?.observation ?? null
  );
}

function validateTestCase(testCase: TestCase): void {
  if (testCase.goal.trim().length === 0) {
    throw new Error("Test goal must not be empty.");
  }

  new URL(testCase.startUrl);

  if (testCase.steps.length === 0) {
    throw new Error("Test case must contain at least one step.");
  }
}

function createSetupBug(message: string): BugReport {
  return {
    title: "Test setup failed",
    description: message,
    stepIndex: -1,
    stepName: "setup",
    category: "action",
    evidence: {
      url: null,
      consoleErrors: [],
      screenshot: null
    }
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown test task error";
}
