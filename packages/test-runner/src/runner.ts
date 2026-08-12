import { AgentLoop, type AgentStepResult } from "@vibeqa/agent-core";
import type { BrowserSession } from "@vibeqa/browser-tools";
import type { BrowserAction, BrowserActionResult, Observation } from "@vibeqa/schemas";

import { ScenarioPlanner } from "./scenario-planner.js";
import type { TestCase, TestStep } from "./test-case.js";

export type TestStatus = "passed" | "failed";

export interface ExecutionTraceEntry {
  stepIndex: number;
  expectedAction: TestStep;
  action: BrowserAction | null;
  observation: Observation;
  nextObservation: Observation | null;
  result: BrowserActionResult | null;
  status: TestStatus;
  error: string | null;
}

export interface TestResult {
  testName: string;
  status: TestStatus;
  passedSteps: number;
  failedSteps: number;
  error: string | null;
  executionTrace: ExecutionTraceEntry[];
}

export interface TestRunnerOptions {
  browser: BrowserSession;
}

export class TestRunner {
  constructor(private readonly options: TestRunnerOptions) {}

  async run(testCase: TestCase): Promise<TestResult> {
    const planner = new ScenarioPlanner(testCase.steps);
    const loop = new AgentLoop({
      goal: testCase.name,
      browser: this.options.browser,
      planner
    });
    const trace: ExecutionTraceEntry[] = [];

    await this.options.browser.navigate(testCase.targetUrl);

    for (const [index, expectedAction] of testCase.steps.entries()) {
      const step = await loop.runStep();
      const verification = this.verifyStep(expectedAction, step);

      trace.push({
        stepIndex: index,
        expectedAction,
        action: step.action,
        observation: step.observation,
        nextObservation: step.nextObservation,
        result: step.result,
        status: verification.ok ? "passed" : "failed",
        error: verification.error
      });

      if (!verification.ok) {
        return this.createResult(testCase.name, trace, verification.error);
      }
    }

    return this.createResult(testCase.name, trace, null);
  }

  private verifyStep(
    expectedAction: TestStep | undefined,
    step: AgentStepResult
  ): { ok: boolean; error: string | null } {
    if (!expectedAction) {
      return { ok: false, error: "Missing expected step." };
    }

    if (!step.action) {
      return { ok: false, error: "Planner returned no action before scenario ended." };
    }

    if (JSON.stringify(step.action) !== JSON.stringify(expectedAction)) {
      return {
        ok: false,
        error: `Planner returned unexpected action: ${JSON.stringify(step.action)}`
      };
    }

    if (!step.result?.ok) {
      return {
        ok: false,
        error: step.result?.error ?? "Browser action failed."
      };
    }

    if (!step.nextObservation) {
      return { ok: false, error: "Missing post-action observation." };
    }

    return { ok: true, error: null };
  }

  private createResult(
    testName: string,
    trace: ExecutionTraceEntry[],
    error: string | null
  ): TestResult {
    const passedSteps = trace.filter((entry) => entry.status === "passed").length;
    const failedSteps = trace.filter((entry) => entry.status === "failed").length;

    return {
      testName,
      status: failedSteps === 0 ? "passed" : "failed",
      passedSteps,
      failedSteps,
      error,
      executionTrace: trace
    };
  }
}
