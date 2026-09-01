import { createHash } from "node:crypto";

import type { LLMClient } from "@vibeqa/llm";
import {
  BrowserActionSchema,
  type BrowserAction,
  type Observation
} from "@vibeqa/schemas";

import {
  redactCredentialValues,
  type TemporaryLoginCredentials
} from "./secure-credentials.js";

const DEFAULT_REPAIR_LIMIT = 2;
const MAX_RESPONSE_PREVIEW = 240;

export interface ModelOutputFailure {
  attempt: number;
  timestamp: string;
  responseHash: string;
  responsePreview: string;
  reason: string;
}

export interface ModelOutputRecoveryDiagnostics {
  generationAttempts: number;
  invalidResponseCount: number;
  retryCount: number;
  recoveredCount: number;
  exhaustionCount: number;
  failures: ModelOutputFailure[];
}

export interface ModelActionRuntimeOptions {
  client: LLMClient;
  credentials?: TemporaryLoginCredentials | null;
  maxRepairAttempts?: number;
  now?: () => Date;
}

export class ModelOutputInvalidError extends Error {
  readonly code = "MODEL_OUTPUT_INVALID";

  constructor(attempts: number) {
    super(
      `MODEL_OUTPUT_INVALID: The local model returned unusable BrowserAction JSON after ${attempts} attempts.`
    );
    this.name = "ModelOutputInvalidError";
  }
}

export class ModelActionRuntime {
  private readonly client: LLMClient;
  private readonly credentials: TemporaryLoginCredentials | null;
  private readonly maxRepairAttempts: number;
  private readonly now: () => Date;
  private diagnostics: ModelOutputRecoveryDiagnostics = emptyDiagnostics();

  constructor(options: ModelActionRuntimeOptions) {
    this.client = options.client;
    this.credentials = options.credentials ?? null;
    this.maxRepairAttempts = options.maxRepairAttempts ?? DEFAULT_REPAIR_LIMIT;
    this.now = options.now ?? (() => new Date());
  }

  async generate(
    plannerPrompt: string,
    observation: Observation,
    recoveryContext: unknown
  ): Promise<string> {
    const contract = buildActionContract(observation, recoveryContext);
    let prompt = `${contract}\n\nPlanner context:\n${plannerPrompt}`;
    let sawInvalidOutput = false;

    for (let attempt = 1; attempt <= this.maxRepairAttempts + 1; attempt += 1) {
      this.diagnostics.generationAttempts += 1;
      const response = await this.client.generate(
        redactCredentialValues(prompt, this.credentials)
      );
      try {
        const action = parseModelAction(response);
        validateGroundedAction(action, observation);
        if (sawInvalidOutput) this.diagnostics.recoveredCount += 1;
        return action === null ? "null" : JSON.stringify(action);
      } catch (error) {
        sawInvalidOutput = true;
        this.diagnostics.invalidResponseCount += 1;
        const reason = safeParseReason(error, this.credentials);
        this.diagnostics.failures.push({
          attempt,
          timestamp: this.now().toISOString(),
          responseHash: createHash("sha256").update(response).digest("hex"),
          responsePreview: safeResponsePreview(response, this.credentials),
          reason
        });
        if (attempt > this.maxRepairAttempts) {
          this.diagnostics.exhaustionCount += 1;
          throw new ModelOutputInvalidError(attempt);
        }
        this.diagnostics.retryCount += 1;
        prompt = [
          "CORRECTION REQUIRED: Your previous response did not match the schema.",
          `Validation error: ${reason}`,
          "Return a corrected response for the same current observation.",
          contract,
          "Do not repeat or discuss the invalid response.",
          `Planner context:\n${compactPlannerContext(plannerPrompt)}`
        ].join("\n");
      }
    }

    throw new ModelOutputInvalidError(this.maxRepairAttempts + 1);
  }

  getDiagnostics(): ModelOutputRecoveryDiagnostics {
    return structuredClone(this.diagnostics);
  }
}

export function buildActionContract(
  observation: Observation,
  recoveryContext: unknown
): string {
  const selectorCounts = new Map<string, number>();
  for (const element of observation.elements) {
    selectorCounts.set(
      element.selector,
      (selectorCounts.get(element.selector) ?? 0) + 1
    );
  }
  const targets = observation.elements
    .filter((element) => element.visible && element.enabled)
    .flatMap((element) => {
      const uniqueSelector = selectorCounts.get(element.selector) === 1;
      if (!element.href && !uniqueSelector) return [];
      return [
        {
          ...(uniqueSelector ? { selector: element.selector } : {}),
          actions: element.href
            ? ["navigate"]
            : element.editable
              ? ["type"]
              : ["click"],
          ...(element.accessibleName
            ? { accessibleName: normalizeText(element.accessibleName, 80) }
            : {}),
          ...(element.href ? { href: element.href } : {})
        }
      ];
    })
    .sort((left, right) =>
      `${left.href ?? ""}\u0000${left.selector ?? ""}`.localeCompare(
        `${right.href ?? ""}\u0000${right.selector ?? ""}`
      )
    );

  return [
    "BROWSER ACTION OUTPUT CONTRACT:",
    "Return exactly one BrowserAction JSON object or the JSON literal null.",
    "Return JSON only. Do not use Markdown fences, prose, comments, arrays, or extra keys.",
    "Allowed shapes:",
    '{"type":"navigate","url":"https://..."}',
    '{"type":"click","selector":"..."}',
    '{"type":"type","selector":"...","value":"..."}',
    '{"type":"wait","ms":500}',
    '{"type":"screenshot"}',
    '{"type":"getText","selector":"..."}',
    '{"type":"getCurrentUrl"}',
    '{"type":"assert","selector":"...","containsText":"..."}',
    "For click, type, getText, or assert, copy a selector exactly from CURRENT TARGETS.",
    "When a target lists navigate, use its exact href. Never click an ambiguous shared selector.",
    "Observation IDs are not selectors. Never reuse a failed target.",
    `Current observation ID: ${observation.id}`,
    `Current URL: ${observation.url}`,
    `CURRENT TARGETS: ${JSON.stringify(targets)}`,
    `Element recovery: ${JSON.stringify(recoveryContext)}`
  ].join("\n");
}

function validateGroundedAction(
  action: BrowserAction | null,
  observation: Observation
): void {
  if (!action) return;
  if (action.type === "navigate" || action.type === "goto") {
    const observed = observation.elements.some(
      (element) => element.visible && element.enabled && element.href === action.url
    );
    if (!observed) {
      throw new Error("Navigation URL is not a current observed target.");
    }
    return;
  }
  if (
    action.type !== "click" &&
    action.type !== "type" &&
    action.type !== "getText" &&
    action.type !== "assert"
  )
    return;
  if (
    (action.type === "getText" || action.type === "assert") &&
    action.selector === "body"
  )
    return;
  const matches = observation.elements.filter(
    (element) =>
      element.selector === action.selector && element.visible && element.enabled
  );
  if (matches.length !== 1) {
    throw new Error(
      "Action selector is absent or ambiguous in the current observation."
    );
  }
  if (action.type === "type" && !matches[0]?.editable) {
    throw new Error("Type action target is not editable in the current observation.");
  }
}

function parseModelAction(response: string): BrowserAction | null {
  const trimmed = response.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const parsed = JSON.parse(fenced?.[1] ?? trimmed) as unknown;
  if (parsed === null) return null;
  const action = BrowserActionSchema.parse(parsed);
  assertExactActionKeys(parsed, action);
  return action;
}

function assertExactActionKeys(parsed: unknown, action: BrowserAction): void {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const keys: Record<BrowserAction["type"], readonly string[]> = {
    goto: ["type", "url"],
    navigate: ["type", "url"],
    click: ["type", "selector"],
    type: ["type", "selector", "value"],
    getText: ["type", "selector"],
    wait: ["type", "ms"],
    screenshot: ["type", "path"],
    assert: ["type", "selector", "containsText"],
    getCurrentUrl: ["type"]
  };
  const allowed = new Set(keys[action.type]);
  const extras = Object.keys(parsed).filter((key) => !allowed.has(key));
  if (extras.length) {
    throw new Error(`BrowserAction contains unsupported fields: ${extras.join(", ")}`);
  }
}

function safeResponsePreview(
  response: string,
  credentials: TemporaryLoginCredentials | null
): string {
  const credentialSafe = redactCredentialValues(response, credentials);
  return credentialSafe
    .replace(/("value"\s*:\s*")[^"]*(")/giu, "$1[REDACTED]$2")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [REDACTED]")
    .replace(
      /("?(?:password|passwd|token|api[_-]?key|secret)"?\s*[:=]\s*")([^"]*)(")/giu,
      "$1[REDACTED]$3"
    )
    .replace(
      /\b(password|passwd|token|api[_-]?key|secret)\s*[:=]\s*[^\s,;}]+/giu,
      "$1=[REDACTED]"
    )
    .replace(/([?&](?:token|key|password|secret)=)[^&#\s]+/giu, "$1[REDACTED]")
    .slice(0, MAX_RESPONSE_PREVIEW);
}

function safeParseReason(
  error: unknown,
  credentials: TemporaryLoginCredentials | null
): string {
  if (!(error instanceof Error)) return "Unknown JSON validation error.";
  return redactCredentialValues(error.message, credentials)
    .replace(/\s+/gu, " ")
    .slice(0, 240);
}

function normalizeText(value: string, maxLength: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function compactPlannerContext(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 2_000);
}

function emptyDiagnostics(): ModelOutputRecoveryDiagnostics {
  return {
    generationAttempts: 0,
    invalidResponseCount: 0,
    retryCount: 0,
    recoveredCount: 0,
    exhaustionCount: 0,
    failures: []
  };
}
