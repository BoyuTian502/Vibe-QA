import type { LLMClient } from "./client.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5-mini";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface OpenAICompatibleClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OpenAICompatibleLLMClient implements LLMClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: OpenAICompatibleClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    if (this.apiKey.trim().length === 0) {
      throw new Error(
        "OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey explicitly."
      );
    }

    this.model = options.model ?? DEFAULT_MODEL;
    if (this.model.trim().length === 0) {
      throw new Error("OpenAI-compatible model must not be empty.");
    }

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("OpenAI-compatible timeoutMs must be a positive integer.");
    }

    this.endpoint = `${normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)}/chat/completions`;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async generate(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }]
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new OpenAICompatibleHTTPError(
          response.status,
          response.statusText,
          await readErrorMessage(response)
        );
      }

      const data = (await response.json()) as unknown;
      return parseGeneratedText(data);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new OpenAICompatibleTimeoutError(this.timeoutMs);
      }

      if (
        error instanceof OpenAICompatibleHTTPError ||
        error instanceof OpenAICompatibleResponseError
      ) {
        throw error;
      }

      throw new Error(`OpenAI-compatible request failed: ${errorMessage(error)}`, {
        cause: error
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class OpenAICompatibleHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly apiMessage: string | null
  ) {
    super(
      `OpenAI-compatible API returned ${status}${statusText ? ` ${statusText}` : ""}${
        apiMessage ? `: ${apiMessage}` : ""
      }.`
    );
    this.name = "OpenAICompatibleHTTPError";
  }
}

export class OpenAICompatibleResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAICompatibleResponseError";
  }
}

export class OpenAICompatibleTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`OpenAI-compatible request timed out after ${timeoutMs}ms.`);
    this.name = "OpenAICompatibleTimeoutError";
  }
}

function parseGeneratedText(data: unknown): string {
  const record = objectRecord(
    data,
    "OpenAI-compatible API returned an invalid JSON response."
  );
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new OpenAICompatibleResponseError(
      "OpenAI-compatible API response did not contain any choices."
    );
  }

  const firstChoice = objectRecord(
    choices[0],
    "OpenAI-compatible API returned an invalid choice."
  );
  const message = objectRecord(
    firstChoice.message,
    "OpenAI-compatible API choice did not contain a message."
  );
  const content = message.content;

  if (typeof content !== "string" || content.length === 0) {
    throw new OpenAICompatibleResponseError(
      "OpenAI-compatible API response did not contain generated text."
    );
  }

  return content;
}

async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const data = (await response.json()) as unknown;
    const record = objectRecord(data, "");
    const error = record.error;
    if (typeof error === "string") {
      return error;
    }

    if (typeof error === "object" && error !== null && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message;
      return typeof message === "string" ? message : null;
    }

    return typeof record.message === "string" ? record.message : null;
  } catch {
    return null;
  }
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenAICompatibleResponseError(message);
  }

  return value as Record<string, unknown>;
}

function normalizeBaseUrl(baseUrl: string): string {
  const parsedUrl = new URL(baseUrl);
  return parsedUrl.toString().replace(/\/$/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown network error";
}
