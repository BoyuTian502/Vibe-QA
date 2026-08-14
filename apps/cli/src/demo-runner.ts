import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startBenchmarkServer, type BenchmarkServer } from "@vibeqa/benchmark-app";
import type { BrowserController } from "@vibeqa/agent-core";
import {
  PlaywrightBrowserController,
  type PlaywrightBrowserControllerOptions
} from "@vibeqa/browser-playwright";
import type { BrowserAction } from "@vibeqa/schemas";
import { TestTask, type TestResult } from "@vibeqa/test-engine";

import { createDemoScenario, type DemoScenarioName } from "./demo-scenarios.js";

export type DemoEvent =
  | { type: "benchmark-ready"; url: string }
  | { type: "browser-ready" }
  | { type: "test-started"; goal: string }
  | { type: "evidence-saved"; outputDirectory: string };

export interface DemoCleanupResult {
  browserClosed: boolean;
  benchmarkClosed: boolean;
}

export interface TechnicalDemoResult {
  scenario: DemoScenarioName;
  benchmarkUrl: string;
  outputDirectory: string;
  reportPath: string;
  tracePath: string;
  result: TestResult;
  cleanup: DemoCleanupResult;
}

export interface TechnicalDemoOptions {
  scenario?: DemoScenarioName;
  headless?: boolean;
  keepOpen?: boolean;
  actionDelayMs?: number;
  outputRoot?: string;
  onEvent?: (event: DemoEvent) => void;
  onResult?: (result: TechnicalDemoResult) => void | Promise<void>;
  waitForKeepOpen?: () => Promise<void>;
  dependencies?: Partial<DemoDependencies>;
}

interface ClosableBrowserController extends BrowserController {
  close(): Promise<void>;
}

interface DemoDependencies {
  startBenchmark: () => Promise<BenchmarkServer>;
  launchBrowser: (
    options: PlaywrightBrowserControllerOptions
  ) => Promise<ClosableBrowserController>;
  now: () => Date;
}

const defaultDependencies: DemoDependencies = {
  startBenchmark: startBenchmarkServer,
  launchBrowser: PlaywrightBrowserController.launch,
  now: () => new Date()
};

export async function runTechnicalDemo(
  options: TechnicalDemoOptions = {}
): Promise<TechnicalDemoResult> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const scenarioName = options.scenario ?? "bug";
  const outputRoot = options.outputRoot ?? join(process.cwd(), "run-output", "demo");
  const outputDirectory = join(outputRoot, formatTimestamp(dependencies.now()));
  const reportPath = join(outputDirectory, "report.json");
  const tracePath = join(outputDirectory, "trace.json");
  const cleanup: DemoCleanupResult = {
    browserClosed: false,
    benchmarkClosed: false
  };
  let benchmark: BenchmarkServer | null = null;
  let browser: ClosableBrowserController | null = null;
  let demoResult: TechnicalDemoResult | null = null;
  let executionError: unknown;
  let executionFailed = false;

  try {
    benchmark = await dependencies.startBenchmark();
    benchmark.reset();
    options.onEvent?.({ type: "benchmark-ready", url: benchmark.url });

    browser = await dependencies.launchBrowser({
      headless: options.headless ?? false
    });
    options.onEvent?.({ type: "browser-ready" });

    const testCase = createDemoScenario(scenarioName, benchmark.url);
    options.onEvent?.({ type: "test-started", goal: testCase.goal });
    const pacedBrowser = new PacedBrowserController(
      browser,
      options.actionDelayMs ?? 450
    );
    const task = new TestTask({
      browser: pacedBrowser,
      testCase,
      screenshotDirectory: join(outputDirectory, "screenshots")
    });
    const result = sanitizeTestResult(await task.run());

    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeJson(reportPath, result),
      writeJson(tracePath, result.trace)
    ]);
    options.onEvent?.({ type: "evidence-saved", outputDirectory });

    demoResult = {
      scenario: scenarioName,
      benchmarkUrl: benchmark.url,
      outputDirectory,
      reportPath,
      tracePath,
      result,
      cleanup
    };
    await options.onResult?.(demoResult);

    if (options.keepOpen) {
      if (!options.waitForKeepOpen) {
        throw new Error("keepOpen requires a waitForKeepOpen callback.");
      }
      await options.waitForKeepOpen();
    }
  } catch (error) {
    executionError = error;
    executionFailed = true;
  }

  const cleanupErrors: unknown[] = [];
  if (browser) {
    try {
      await browser.close();
      cleanup.browserClosed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (benchmark) {
    try {
      await benchmark.close();
      cleanup.benchmarkClosed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  const errors = executionFailed ? [executionError, ...cleanupErrors] : cleanupErrors;
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "The demo failed and could not clean up fully.");
  }

  if (!demoResult) {
    throw new Error("The technical demo did not produce a result.");
  }
  return demoResult;
}

class PacedBrowserController implements BrowserController {
  constructor(
    private readonly browser: BrowserController,
    private readonly actionDelayMs: number
  ) {}

  async observe() {
    return await this.browser.observe();
  }

  async goto(url: string): Promise<void> {
    await this.browser.goto(url);
    await this.pause();
  }

  async navigate(url: string): Promise<void> {
    await this.browser.navigate(url);
    await this.pause();
  }

  async click(selector: string): Promise<void> {
    await this.browser.click(selector);
    await this.pause();
  }

  async type(selector: string, value: string): Promise<void> {
    await this.browser.type(selector, value);
    await this.pause();
  }

  async getText(selector: string): Promise<string> {
    return await this.browser.getText(selector);
  }

  async wait(ms: number): Promise<void> {
    await this.browser.wait(ms);
    await this.pause();
  }

  async screenshot(options: { path?: string } = {}): Promise<Uint8Array | string> {
    return await this.browser.screenshot(options);
  }

  async assert(selector: string, containsText: string): Promise<void> {
    await this.browser.assert(selector, containsText);
    await this.pause();
  }

  getCurrentUrl(): string {
    return this.browser.getCurrentUrl();
  }

  private async pause(): Promise<void> {
    if (this.actionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.actionDelayMs));
    }
  }
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

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
