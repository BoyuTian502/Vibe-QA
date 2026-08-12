import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenAICompatibleHTTPError,
  OpenAICompatibleLLMClient,
  OpenAICompatibleResponseError,
  OpenAICompatibleTimeoutError
} from "../src/index.js";

const originalApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalApiKey;
  }
});

describe("OpenAICompatibleLLMClient", () => {
  it("sends the prompt and returns generated text", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "Generated plan" } }]
      })
    );
    const client = new OpenAICompatibleLLMClient({
      apiKey: "test-api-key",
      baseUrl: "https://llm.example.test/v1/",
      model: "test-model",
      fetch: fetchMock
    });

    await expect(client.generate("Plan a login test")).resolves.toBe("Generated plan");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://llm.example.test/v1/chat/completions");
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/json"
      }
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "Plan a login test" }]
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads OPENAI_API_KEY from the environment", async () => {
    process.env.OPENAI_API_KEY = "environment-key";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const client = new OpenAICompatibleLLMClient({ fetch: fetchMock });

    await client.generate("prompt");

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer environment-key"
    });
  });

  it("requires an API key", () => {
    delete process.env.OPENAI_API_KEY;

    expect(() => new OpenAICompatibleLLMClient()).toThrow(
      "Set OPENAI_API_KEY or pass apiKey explicitly"
    );
  });

  it("surfaces API status and error messages", async () => {
    const client = new OpenAICompatibleLLMClient({
      apiKey: "test-key",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse(
            { error: { message: "Invalid authentication credentials" } },
            { status: 401, statusText: "Unauthorized" }
          )
        )
    });

    const error = await client.generate("prompt").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAICompatibleHTTPError);
    expect(error).toMatchObject({
      status: 401,
      apiMessage: "Invalid authentication credentials"
    });
    expect(String(error)).not.toContain("test-key");
  });

  it("rejects malformed and empty responses", async () => {
    const malformed = createClientWithResponse({ choices: [] });
    const empty = createClientWithResponse({
      choices: [{ message: { content: "" } }]
    });

    await expect(malformed.generate("prompt")).rejects.toBeInstanceOf(
      OpenAICompatibleResponseError
    );
    await expect(empty.generate("prompt")).rejects.toThrow(
      "did not contain generated text"
    );
  });

  it("aborts and reports requests that exceed the timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );
    const client = new OpenAICompatibleLLMClient({
      apiKey: "test-key",
      timeoutMs: 10,
      fetch: fetchMock
    });

    const error = await client
      .generate("slow prompt")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAICompatibleTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 10 });
  });

  it("wraps network failures with useful context", async () => {
    const client = new OpenAICompatibleLLMClient({
      apiKey: "test-key",
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("socket closed"))
    });

    await expect(client.generate("prompt")).rejects.toThrow(
      "OpenAI-compatible request failed: socket closed"
    );
  });
});

function createClientWithResponse(body: unknown): OpenAICompatibleLLMClient {
  return new OpenAICompatibleLLMClient({
    apiKey: "test-key",
    fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body))
  });
}

function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { "content-type": "application/json" }
  });
}
