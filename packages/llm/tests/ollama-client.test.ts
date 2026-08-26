import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_OLLAMA_BASE_URL, OllamaClient } from "../src/index.js";

const originalBaseUrl = process.env.OLLAMA_BASE_URL;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalBaseUrl === undefined) {
    delete process.env.OLLAMA_BASE_URL;
  } else {
    process.env.OLLAMA_BASE_URL = originalBaseUrl;
  }
});

describe("OllamaClient", () => {
  it("uses the IPv4 loopback endpoint by default", async () => {
    delete process.env.OLLAMA_BASE_URL;
    const fetchMock = successfulFetch();
    const client = new OllamaClient({ fetch: fetchMock });

    await client.generate("ready");

    expect(client.baseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/generate");
  });

  it("uses OLLAMA_BASE_URL when provided", async () => {
    process.env.OLLAMA_BASE_URL = "http://192.0.2.10:11434/";
    const fetchMock = successfulFetch();
    const client = new OllamaClient({ fetch: fetchMock });

    await client.generate("ready");

    expect(client.baseUrl).toBe("http://192.0.2.10:11434");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://192.0.2.10:11434/api/generate");
  });

  it("allows explicit base URL configuration to override the environment", async () => {
    process.env.OLLAMA_BASE_URL = "http://environment.example.test:11434";
    const fetchMock = successfulFetch();
    const client = new OllamaClient({
      model: "custom-model",
      baseUrl: "http://ollama.example.test:12000/api-root/",
      fetch: fetchMock
    });

    await client.generate("plan");

    expect(client.model).toBe("custom-model");
    expect(client.baseUrl).toBe("http://ollama.example.test:12000/api-root");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://ollama.example.test:12000/api-root/api/generate"
    );
  });

  it("preserves the legacy model-string constructor", () => {
    delete process.env.OLLAMA_BASE_URL;
    const client = new OllamaClient("legacy-model");

    expect(client.model).toBe("legacy-model");
    expect(client.baseUrl).toBe(DEFAULT_OLLAMA_BASE_URL);
  });
});

function successfulFetch() {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ response: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );
}
