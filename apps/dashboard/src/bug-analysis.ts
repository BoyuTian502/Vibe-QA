import { OpenAICompatibleLLMClient, type LLMClient } from "@vibeqa/llm";

import type { DashboardRun } from "./types.js";

export type BugSeverity = "low" | "medium" | "high" | "critical";
export type BugAnalysisSource = "ai" | "baseline";

export interface BugAnalysis {
  summary: string;
  rootCause: string;
  suggestedFixes: string[];
  severity: BugSeverity;
  severityReasoning: string;
  source: BugAnalysisSource;
  notice: string | null;
}

export interface BugAnalysisInput {
  report: {
    runId: string;
    goal: string;
    status: string;
    issue: {
      title: string;
      description: string;
      category: string;
      stepName: string;
      consoleErrors: Array<{ type: string; text: string }>;
    };
    steps: Array<{
      name: string;
      status: string;
      action: string;
      reason: string | null;
      errors: string[];
      url: string | null;
    }>;
  };
  trace: {
    events: Array<{
      label: string;
      status: string;
      detail: string | null;
      error: string | null;
      safetyDecision: string | null;
      observationTitle: string | null;
      observationUrl: string | null;
    }>;
  };
  screenshots: Array<{
    name: string;
    relativePath: string;
  }>;
}

interface GeneratedBugAnalysis {
  summary: string;
  rootCause: string;
  suggestedFixes: string[];
  severity: BugSeverity;
  severityReasoning: string;
}

const MAX_EVENTS = 50;
const MAX_TEXT_LENGTH = 1_500;

export class AIBugAnalyzer {
  constructor(private readonly client: LLMClient) {}

  async analyze(input: BugAnalysisInput): Promise<BugAnalysis> {
    const generated = parseBugAnalysis(
      await this.client.generate(buildBugAnalysisPrompt(input))
    );
    return {
      ...generated,
      source: "ai",
      notice: null
    };
  }
}

export class BugAnalysisService {
  private readonly cache = new Map<string, Promise<BugAnalysis | null>>();
  private readonly analyzer: AIBugAnalyzer | null;

  constructor(client: LLMClient | null) {
    this.analyzer = client ? new AIBugAnalyzer(client) : null;
  }

  async analyze(run: DashboardRun): Promise<BugAnalysis | null> {
    const cached = this.cache.get(run.id);
    if (cached) {
      return await cached;
    }

    const pending = this.analyzeRun(run);
    this.cache.set(run.id, pending);
    return await pending;
  }

  private async analyzeRun(run: DashboardRun): Promise<BugAnalysis | null> {
    if (!run.primaryIssue) {
      return null;
    }

    const input = createBugAnalysisInput(run);
    if (!this.analyzer) {
      return createBaselineBugAnalysis(input, null);
    }

    try {
      return await this.analyzer.analyze(input);
    } catch {
      return createBaselineBugAnalysis(
        input,
        "AI analysis was unavailable, so this explanation uses the local evidence baseline."
      );
    }
  }
}

export function createBugAnalysisInput(run: DashboardRun): BugAnalysisInput {
  if (!run.primaryIssue) {
    throw new Error("A bug report is required before analysis can be generated.");
  }

  return {
    report: {
      runId: run.id,
      goal: safeText(run.goal),
      status: run.status,
      issue: {
        title: safeText(run.primaryIssue.title),
        description: safeText(run.primaryIssue.description),
        category: safeText(run.primaryIssue.category),
        stepName: safeText(run.primaryIssue.stepName),
        consoleErrors: run.primaryIssue.consoleErrors.map((error) => ({
          type: safeText(error.type),
          text: safeText(error.text)
        }))
      },
      steps: run.steps.slice(0, MAX_EVENTS).map((step) => ({
        name: safeText(step.name),
        status: step.status,
        action: safeText(step.actionLabel),
        reason: step.reason ? safeText(step.reason) : null,
        errors: step.errors.map(safeText),
        url: safeUrl(step.url)
      }))
    },
    trace: {
      events: run.timeline.slice(0, MAX_EVENTS).map((event) => ({
        label: safeText(event.label),
        status: event.status,
        detail: event.detail ? safeText(event.detail) : null,
        error: event.error ? safeText(event.error) : null,
        safetyDecision: event.safetyDecision,
        observationTitle: event.observationTitle
          ? safeText(event.observationTitle)
          : null,
        observationUrl: safeUrl(event.observationUrl)
      }))
    },
    screenshots: run.screenshots.map((screenshot) => ({
      name: safeText(screenshot.name),
      relativePath: safeText(screenshot.relativePath)
    }))
  };
}

export function buildBugAnalysisPrompt(input: BugAnalysisInput): string {
  return [
    "You are a senior QA engineer analyzing evidence from one browser test run.",
    "Use only the supplied artifacts. Separate observed facts from likely causes and do not invent implementation details.",
    "Return only one JSON object with exactly these fields:",
    '{"summary":"...","rootCause":"...","suggestedFixes":["..."],"severity":"low|medium|high|critical","severityReasoning":"..."}',
    "Keep the summary concise, explain uncertainty in the root cause, and suggest 1 to 4 concrete fixes.",
    "The artifact data has been sanitized and screenshot entries are metadata only.",
    "ARTIFACTS:",
    JSON.stringify(input)
  ].join("\n");
}

export function createBaselineBugAnalysis(
  input: BugAnalysisInput,
  notice: string | null = null
): BugAnalysis {
  const issue = input.report.issue;
  const hasBrowserError =
    issue.consoleErrors.length > 0 || issue.category === "console";
  const severity: BugSeverity = hasBrowserError ? "high" : "medium";

  return {
    summary: hasBrowserError
      ? `${issue.stepName} triggers a browser error and prevents the workflow from completing reliably.`
      : `${issue.stepName} did not produce the expected result during the test run.`,
    rootCause: hasBrowserError
      ? "The trace links the failed interaction to an uncaught client-side exception. The available artifacts do not identify the exact source line, but the failure is most likely inside the interaction handler or code it invokes."
      : "The action result and subsequent observation diverge from the expected workflow. The evidence narrows the failure to this step, but source-level inspection is needed to confirm the underlying implementation defect.",
    suggestedFixes: hasBrowserError
      ? [
          "Inspect the failing interaction handler and remove or handle the exception path.",
          "Show a controlled error state instead of allowing an uncaught browser exception.",
          "Add a regression test that performs this interaction and asserts that no page or console error occurs."
        ]
      : [
          "Inspect the failed step and compare its resulting page state with the expected workflow.",
          "Add a focused regression test for the recorded action and assertion.",
          "Improve error handling so the UI reports a controlled failure when the operation cannot complete."
        ],
    severity,
    severityReasoning: hasBrowserError
      ? "High severity: an uncaught browser error can break the affected workflow for every user who performs this interaction, even if the rest of the page remains visible."
      : "Medium severity: the workflow fails, but the evidence does not show data loss, a security impact, or a site-wide outage.",
    source: "baseline",
    notice
  };
}

export function createAnalysisClientFromEnvironment(): LLMClient | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  const model = process.env.OPENAI_MODEL?.trim();
  return new OpenAICompatibleLLMClient({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {})
  });
}

function parseBugAnalysis(response: string): GeneratedBugAnalysis {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(response.trim());
  const body = match?.[1] ?? response.trim();
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error("LLM bug analysis was not valid JSON.", { cause: error });
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LLM bug analysis must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const severity = record.severity;
  const suggestedFixes = record.suggestedFixes;

  if (!isSeverity(severity)) {
    throw new Error("LLM bug analysis returned an unsupported severity.");
  }
  if (
    !Array.isArray(suggestedFixes) ||
    suggestedFixes.length < 1 ||
    suggestedFixes.length > 4 ||
    !suggestedFixes.every(isNonEmptyString)
  ) {
    throw new Error("LLM bug analysis must include 1 to 4 suggested fixes.");
  }

  return {
    summary: requiredString(record.summary, "summary"),
    rootCause: requiredString(record.rootCause, "rootCause"),
    suggestedFixes,
    severity,
    severityReasoning: requiredString(record.severityReasoning, "severityReasoning")
  };
}

function requiredString(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`LLM bug analysis field ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSeverity(value: unknown): value is BugSeverity {
  return (
    value === "low" || value === "medium" || value === "high" || value === "critical"
  );
}

function safeText(value: string): string {
  return value
    .slice(0, MAX_TEXT_LENGTH)
    .replace(
      /((?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*)([^\s,;]+)/gi,
      "$1[REDACTED]"
    );
}

function safeUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return safeText(url.toString());
  } catch {
    return safeText(value.split(/[?#]/, 1)[0] ?? value);
  }
}
