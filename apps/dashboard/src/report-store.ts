import { readFile, readdir } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32
} from "node:path";

import type {
  DashboardConsoleError,
  DashboardIssue,
  DashboardRun,
  DashboardRunStatus,
  DashboardScreenshot,
  DashboardStep,
  DashboardTimelineEvent
} from "./types.js";

type JsonRecord = Record<string, unknown>;

const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".svg", ".webp"]);

export class ReportStore {
  readonly outputRoot: string;

  constructor(outputRoot: string) {
    this.outputRoot = resolve(outputRoot);
  }

  async listRuns(): Promise<DashboardRun[]> {
    let entries;
    try {
      entries = await readdir(this.outputRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        return [];
      }
      throw error;
    }

    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await this.loadRun(entry.name);
          } catch {
            return null;
          }
        })
    );

    return runs
      .filter((run): run is DashboardRun => run !== null)
      .sort((left, right) => right.id.localeCompare(left.id));
  }

  async loadRun(runId: string): Promise<DashboardRun> {
    assertRunId(runId);
    const runDirectory = resolve(this.outputRoot, runId);
    assertWithin(this.outputRoot, runDirectory);

    const [report, trace, screenshots] = await Promise.all([
      readJson(join(runDirectory, "report.json")),
      readJson(join(runDirectory, "trace.json")),
      collectScreenshots(runDirectory, runId)
    ]);

    const reportRecord = asRecord(report);
    const traceRecord = asRecord(trace);
    const rawSteps = asArray(reportRecord.executedSteps).map(asRecord);
    const rawBugs = asArray(reportRecord.bugReports).map(asRecord);
    const traceSteps = asArray(traceRecord.steps).map(asRecord);
    const steps = rawSteps.map(parseStep);
    const status = parseStatus(reportRecord.status);
    const primaryBug =
      rawBugs.find((bug) => stringValue(bug.category) === "console") ??
      rawBugs[0] ??
      null;

    return {
      id: runId,
      goal: stringValue(reportRecord.goal, "Untitled QA run"),
      status,
      startedAt: nullableString(traceSteps[0]?.timestamp),
      stepCount: steps.length,
      passedStepCount: steps.filter((step) => step.status === "passed").length,
      issueCount: rawBugs.length,
      screenshotCount: screenshots.length,
      steps,
      timeline: parseTimeline(traceSteps, steps),
      primaryIssue: primaryBug ? parseIssue(primaryBug, screenshots) : null,
      screenshots,
      errors: stringArray(reportRecord.errors)
    };
  }

  resolveArtifact(runId: string, relativePath: string): string {
    assertRunId(runId);
    const runDirectory = resolve(this.outputRoot, runId);
    const artifactPath = resolve(runDirectory, relativePath);
    assertWithin(runDirectory, artifactPath);
    if (!IMAGE_EXTENSIONS.has(extname(artifactPath).toLowerCase())) {
      throw new Error("Unsupported artifact type.");
    }
    return artifactPath;
  }
}

function parseStep(step: JsonRecord, index: number): DashboardStep {
  const observation = asOptionalRecord(step.observation);
  const evaluation = asOptionalRecord(step.evaluatorFeedback);
  return {
    index: numberValue(step.index, index),
    name: stringValue(step.name, `Step ${index + 1}`),
    status: parseStatus(step.status),
    actionLabel: describeAction(asOptionalRecord(step.action)),
    reason: nullableString(evaluation?.reason),
    errors: stringArray(step.errors),
    url: nullableString(observation?.url)
  };
}

function parseIssue(
  bug: JsonRecord,
  screenshots: DashboardScreenshot[]
): DashboardIssue {
  const evidence = asOptionalRecord(bug.evidence);
  const screenshotPath = nullableString(evidence?.screenshot);
  const screenshotName = screenshotPath
    ? win32.basename(screenshotPath) || basename(screenshotPath)
    : null;
  const screenshot = screenshotName
    ? screenshots.find((item) => item.name === screenshotName)
    : null;

  return {
    title: stringValue(bug.title, "Detected issue"),
    description: stringValue(bug.description, "No issue description was recorded."),
    category: stringValue(bug.category, "evaluation"),
    stepName: stringValue(bug.stepName, "Unknown step"),
    consoleErrors: asArray(evidence?.consoleErrors).map(parseConsoleError),
    screenshotUrl: screenshot?.url ?? null
  };
}

function parseConsoleError(value: unknown): DashboardConsoleError {
  const error = asRecord(value);
  return {
    type: stringValue(error.type, "error"),
    text: stringValue(error.text, "Unknown browser error")
  };
}

function parseTimeline(
  traceSteps: JsonRecord[],
  reportSteps: DashboardStep[]
): DashboardTimelineEvent[] {
  let actionIndex = 0;
  return traceSteps.map((traceStep, index) => {
    const action = asOptionalRecord(traceStep.action);
    const observation = asOptionalRecord(traceStep.observation);
    const result = asOptionalRecord(traceStep.result);
    const evaluation = asOptionalRecord(traceStep.evaluation);
    const matchingStep = action ? reportSteps[actionIndex] : undefined;
    if (action) {
      actionIndex += 1;
    }

    const success = booleanValue(result?.success, true);
    const approvalStatus = nullableString(traceStep.approvalStatus);
    const status =
      approvalStatus === "pending"
        ? "pending"
        : !success || matchingStep?.status === "failed"
          ? "failed"
          : "passed";
    return {
      index,
      timestamp: nullableString(traceStep.timestamp),
      label: action
        ? (matchingStep?.name ?? describeAction(action))
        : index === 0
          ? "Capture the starting page"
          : "Observe the page after the action",
      status,
      detail: nullableString(evaluation?.reason),
      error: nullableString(result?.error),
      safetyDecision: nullableString(traceStep.safetyDecision),
      approvalStatus,
      observationTitle: nullableString(observation?.title),
      observationUrl: nullableString(observation?.url)
    };
  });
}

function describeAction(action: JsonRecord | null): string {
  if (!action) {
    return "No browser action";
  }

  const type = stringValue(action.type, "action");
  switch (type) {
    case "click":
      return `Click ${friendlySelector(stringValue(action.selector, "element"))}`;
    case "type":
      return `Enter text in ${friendlySelector(stringValue(action.selector, "field"))}`;
    case "wait":
      return `Wait ${numberValue(action.ms, 0)} ms`;
    case "navigate":
    case "goto":
      return `Open ${stringValue(action.url, "page")}`;
    case "assert":
      return `Check ${friendlySelector(stringValue(action.selector, "content"))}`;
    case "screenshot":
      return "Capture screenshot";
    case "getText":
      return `Read ${friendlySelector(stringValue(action.selector, "content"))}`;
    case "getCurrentUrl":
      return "Read the current URL";
    default:
      return type;
  }
}

function friendlySelector(selector: string): string {
  const nameMatch = /\[name=["']?([^\]"']+)/.exec(selector);
  if (nameMatch?.[1]) {
    return `${nameMatch[1].replace(/[-_]/g, " ")} field`;
  }
  if (selector === "#trigger-client-error") {
    return "the fragile dashboard widget";
  }
  if (selector.includes('type="submit"')) {
    return "the submit button";
  }
  return selector;
}

async function collectScreenshots(
  runDirectory: string,
  runId: string
): Promise<DashboardScreenshot[]> {
  const screenshotDirectory = join(runDirectory, "screenshots");
  const files = await walkImageFiles(screenshotDirectory);
  return files
    .map((filePath) => {
      const relativePath = relative(runDirectory, filePath);
      const urlPath = relativePath
        .split(sep)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      return {
        name: basename(filePath),
        relativePath,
        url: `/artifacts/${encodeURIComponent(runId)}/${urlPath}`
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walkImageFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return await walkImageFiles(path);
      }
      return entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())
        ? [path]
        : [];
    })
  );
  return nested.flat();
}

function parseStatus(value: unknown): DashboardRunStatus {
  return value === "passed" || value === "failed" ? value : "unknown";
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
}

function asOptionalRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error("Invalid run ID.");
  }
}

function assertWithin(parent: string, candidate: string): void {
  const relativePath = relative(parent, candidate);
  if (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  ) {
    return;
  }
  throw new Error("Artifact path is outside the selected run.");
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
