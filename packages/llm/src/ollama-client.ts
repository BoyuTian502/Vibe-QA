import type { LLMClient } from "./client.js";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export interface OllamaClientOptions {
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class OllamaClient implements LLMClient {
  readonly model: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(modelOrOptions: string | OllamaClientOptions = {}) {
    const options =
      typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
    this.model = options.model ?? "qwen2.5-coder:7b";
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL
    );
    this.fetchImpl = options.fetch ?? fetch;
  }

  async generate(prompt: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama error from ${this.baseUrl}: ${response.status}`);
    }

    const data = (await response.json()) as { response: string };
    return data.response;
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new Error("Ollama base URL must not be empty.");
  }
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Ollama base URL must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}
