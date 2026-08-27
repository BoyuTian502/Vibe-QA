import type { BenchmarkServer } from "@vibeqa/benchmark-app";
import type { BrowserController } from "@vibeqa/agent-core";
import { PlaywrightBrowserController } from "@vibeqa/browser-playwright";
import type {
  BenchmarkExecution,
  BenchmarkPlanner,
  BenchmarkScenario,
  BenchmarkScenarioExecutor,
  PlannerRoutingMetadata,
  SafetyEventCounts
} from "@vibeqa/evaluation";
import { ExplorationSession, type ExplorationResult } from "@vibeqa/explorer";
import { TestTask, type TestResult } from "@vibeqa/test-engine";

import {
  DeterministicBenchmarkPlannerStrategy,
  type BenchmarkPlannerStrategy
} from "./planner-strategies.js";
import { benchmarkCredentials, type ExecutableBenchmarkScenario } from "./scenarios.js";

interface ClosableBrowserController extends BrowserController {
  close(): Promise<void>;
}

export interface BenchmarkPlaywrightExecutorOptions {
  benchmark: BenchmarkServer;
  launchBrowser?: () => Promise<ClosableBrowserController>;
  plannerStrategies?: Partial<Record<BenchmarkPlanner, BenchmarkPlannerStrategy>>;
  now?: () => number;
  onRunStart?: (
    scenario: BenchmarkScenario,
    repetition: number,
    planner: BenchmarkPlanner
  ) => void;
}

export class BenchmarkPlaywrightExecutor implements BenchmarkScenarioExecutor {
  private readonly launchBrowser: () => Promise<ClosableBrowserController>;
  private readonly now: () => number;
  private readonly plannerStrategies: Partial<
    Record<BenchmarkPlanner, BenchmarkPlannerStrategy>
  >;

  constructor(private readonly options: BenchmarkPlaywrightExecutorOptions) {
    this.launchBrowser =
      options.launchBrowser ??
      (async () => await PlaywrightBrowserController.launch({ headless: true }));
    this.now = options.now ?? Date.now;
    this.plannerStrategies = {
      deterministic: new DeterministicBenchmarkPlannerStrategy(),
      ...options.plannerStrategies
    };
  }

  async execute(
    scenario: BenchmarkScenario,
    repetition: number,
    planner: BenchmarkPlanner = "deterministic"
  ): Promise<BenchmarkExecution> {
    const executable = scenario as ExecutableBenchmarkScenario;
    this.options.onRunStart?.(scenario, repetition, planner);
    this.options.benchmark.reset();
    const startedAt = this.now();
    let browser: ClosableBrowserController | null = null;
    let routing: PlannerRoutingMetadata | null = null;

    try {
      const strategy = this.plannerStrategies[planner];
      if (!strategy) {
        throw new Error(`No benchmark planner strategy is configured for ${planner}.`);
      }
      const prepared = await strategy.prepare(executable);
      routing = prepared.routing;
      if (prepared.infrastructureError) {
        return failedBenchmarkExecution(
          prepared.infrastructureError,
          Math.max(0, this.now() - startedAt),
          routing
        );
      }
      browser = await this.launchBrowser();
      const benchmarkBrowser = new CompactEvidenceBrowserController(browser);
      if (scenario.mode === "exploratory") {
        await authenticateBenchmark(benchmarkBrowser, this.options.benchmark.url);
        const result = await new ExplorationSession({
          browser: benchmarkBrowser
        }).run({
          startUrl: scenario.startUrl,
          goal: prepared.explorationGoal,
          maxSteps: scenario.maxSteps
        });
        return explorationExecution(
          scenario,
          result,
          Math.max(0, this.now() - startedAt),
          routing
        );
      }

      if (!prepared.testCase) {
        throw new Error(`Scenario ${scenario.id} does not define a TestCase.`);
      }
      const result = await new TestTask({
        browser: benchmarkBrowser,
        testCase: prepared.testCase,
        screenshotDirectory: "run-output/benchmark-discarded-evidence"
      }).run();
      return testExecution(
        executable,
        result,
        Math.max(0, this.now() - startedAt),
        routing
      );
    } catch (error) {
      if (routing) {
        return failedBenchmarkExecution(
          safeErrorMessage(error),
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

class CompactEvidenceBrowserController implements BrowserController {
  constructor(private readonly browser: BrowserController) {}

  async observe() {
    return await this.browser.observe();
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

  async screenshot(): Promise<Uint8Array | string> {
    return await this.browser.screenshot();
  }

  async assert(selector: string, containsText: string): Promise<void> {
    await this.browser.assert(selector, containsText);
  }

  getCurrentUrl(): string {
    return this.browser.getCurrentUrl();
  }
}

function testExecution(
  scenario: ExecutableBenchmarkScenario,
  result: TestResult,
  durationMs: number,
  routing: PlannerRoutingMetadata | null
): BenchmarkExecution {
  const detectedBugIds = extractBugIds(result);
  if (
    scenario.expectedBugId &&
    scenario.expectedFailureSignature &&
    result.bugReports.some(
      (bug) =>
        bug.stepName === scenario.expectedFailureSignature?.stepName &&
        bug.category === scenario.expectedFailureSignature.category &&
        bug.description.includes(scenario.expectedFailureSignature.descriptionIncludes)
    )
  ) {
    detectedBugIds.push(scenario.expectedBugId);
  }
  const uniqueBugIds = [...new Set(detectedBugIds)];
  return {
    expectedOutcomeMet: scenario.expectedBugId
      ? uniqueBugIds.includes(scenario.expectedBugId)
      : result.status === "passed",
    detectedBugIds: uniqueBugIds,
    reportedBugCount: result.bugReports.length,
    infrastructureError: setupError(result),
    stepCount: result.executedSteps.length,
    durationMs,
    safetyEvents: countSafetyEvents([result.trace]),
    exploration: null,
    routing
  };
}

function explorationExecution(
  scenario: BenchmarkScenario,
  result: ExplorationResult,
  durationMs: number,
  routing: PlannerRoutingMetadata | null
): BenchmarkExecution {
  const detectedBugIds = extractBugIds(result);
  const criteria = scenario.successCriteria;
  const expectedOutcomeMet =
    criteria.type === "exploration_coverage" &&
    result.state.uniquePageStateCount >= criteria.minUniquePageStates &&
    result.state.discoveredInteractiveElements.length >=
      criteria.minInteractiveElements &&
    result.state.executedActions.length >= criteria.minCandidateActions;
  const coverageScore =
    criteria.type === "exploration_coverage"
      ? average([
          coverageRatio(
            result.state.uniquePageStateCount,
            criteria.minUniquePageStates
          ),
          coverageRatio(
            result.state.discoveredInteractiveElements.length,
            criteria.minInteractiveElements
          ),
          coverageRatio(
            result.state.executedActions.length,
            criteria.minCandidateActions
          )
        ])
      : 0;
  return {
    expectedOutcomeMet,
    detectedBugIds,
    reportedBugCount: result.findings.length,
    infrastructureError:
      result.status === "halted" && result.stopReason === "error"
        ? (result.state.errors[0] ?? "Exploration halted with an error.")
        : null,
    stepCount: result.state.stepCount,
    durationMs,
    safetyEvents: countSafetyEvents(result.traces),
    exploration: {
      uniquePageStates: result.state.uniquePageStateCount,
      uniqueInteractiveElements: result.state.discoveredInteractiveElements.length,
      candidateActionsAttempted: result.state.executedActions.length,
      coverageScore,
      terminationReason: result.stopReason
    },
    routing
  };
}

function failedBenchmarkExecution(
  error: string,
  durationMs: number,
  routing: PlannerRoutingMetadata | null
): BenchmarkExecution {
  return {
    expectedOutcomeMet: false,
    detectedBugIds: [],
    reportedBugCount: 0,
    infrastructureError: safeErrorMessage(error),
    stepCount: 0,
    durationMs,
    safetyEvents: { allowed: 0, blocked: 0, approvalRequired: 0 },
    exploration: null,
    routing
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /((?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*)\S+/gi,
    "$1[REDACTED]"
  );
}

function coverageRatio(actual: number, target: number): number {
  return target === 0 ? 1 : Math.min(actual / target, 1);
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countSafetyEvents(
  traces: readonly { steps: readonly { safetyDecision?: string }[] }[]
): SafetyEventCounts {
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

function extractBugIds(value: unknown): string[] {
  return [...new Set(JSON.stringify(value).match(/BUG-BENCH-\d{3}/g) ?? [])];
}

function setupError(result: TestResult): string | null {
  const setupBug = result.bugReports.find((bug) => bug.stepIndex === -1);
  return setupBug?.description ?? null;
}

async function authenticateBenchmark(
  browser: BrowserController,
  benchmarkUrl: string
): Promise<void> {
  const credentials = benchmarkCredentials();
  await browser.navigate(`${benchmarkUrl}/login`);
  await browser.type('input[name="email"]', credentials.email);
  await browser.type('input[name="password"]', credentials.password);
  await browser.click('button[type="submit"]');
  await browser.wait(150);
  if (browser.getCurrentUrl() !== `${benchmarkUrl}/dashboard`) {
    throw new Error("Benchmark authentication setup did not reach the dashboard.");
  }
}
