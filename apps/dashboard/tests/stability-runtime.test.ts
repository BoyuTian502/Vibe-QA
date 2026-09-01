import type { BrowserController } from "@vibeqa/agent-core";
import type { Observation } from "@vibeqa/schemas";
import { describe, expect, it, vi } from "vitest";

import {
  RetryingBrowserController,
  isTransientBrowserError
} from "../src/browser-retry.js";
import {
  ModelActionRuntime,
  ModelOutputInvalidError,
  buildActionContract
} from "../src/model-action-runtime.js";
import { TemporaryLoginCredentials } from "../src/secure-credentials.js";

describe("model action stability", () => {
  it("repairs one invalid response using the same strict schema", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('{"type":"click","selector":"#save","extra":true}')
      .mockResolvedValueOnce('{"type":"click","selector":"#save"}');
    const runtime = new ModelActionRuntime({ client: { generate } });

    await expect(
      runtime.generate("Choose the next action", observation(), { failedSelectors: [] })
    ).resolves.toBe('{"type":"click","selector":"#save"}');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0]).toContain("CORRECTION REQUIRED");
    expect(runtime.getDiagnostics()).toMatchObject({
      generationAttempts: 2,
      invalidResponseCount: 1,
      retryCount: 1,
      recoveredCount: 1,
      exhaustionCount: 0
    });
  });

  it("terminates with MODEL_OUTPUT_INVALID and stores only redacted debug evidence", async () => {
    const credentials = new TemporaryLoginCredentials(
      "private@example.test",
      "private-password"
    );
    const runtime = new ModelActionRuntime({
      client: {
        generate: async () =>
          '{"type":"unsupported","value":"private-password","token":"abc123"}'
      },
      credentials
    });

    await expect(
      runtime.generate("Use private@example.test", observation(), {})
    ).rejects.toBeInstanceOf(ModelOutputInvalidError);
    const diagnostics = runtime.getDiagnostics();
    expect(diagnostics).toMatchObject({
      generationAttempts: 3,
      invalidResponseCount: 3,
      retryCount: 2,
      exhaustionCount: 1
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /private-password|private@example\.test|abc123/
    );
    expect(diagnostics.failures[0]?.responseHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses a deterministic current-observation target list", () => {
    const current = observation();
    current.elements.push({
      id: "disabled",
      tagName: "button",
      role: "button",
      accessibleName: "Disabled",
      text: "Disabled",
      visible: true,
      enabled: false,
      editable: false,
      selector: "#disabled"
    });
    const contract = buildActionContract(current, { failedSelectors: ["#old"] });
    expect(contract).toContain("Current observation ID: observation-1");
    expect(contract).toContain('"selector":"#name"');
    expect(contract).toContain('"selector":"#save"');
    expect(contract.indexOf("#name")).toBeLessThan(contract.indexOf("#save"));
    expect(contract).not.toContain("#disabled");
    expect(contract).toContain("#old");
  });

  it("rejects a target that is not present in the latest observation", async () => {
    const runtime = new ModelActionRuntime({
      client: {
        generate: async () =>
          '{"type":"navigate","url":"https://example.test/previous"}'
      }
    });
    await expect(runtime.generate("Continue", observation(), {})).rejects.toThrow(
      "MODEL_OUTPUT_INVALID"
    );
    expect(runtime.getDiagnostics()).toMatchObject({
      generationAttempts: 3,
      invalidResponseCount: 3,
      exhaustionCount: 1
    });
  });

  it("preserves exact full-response fenced JSON compatibility without a retry", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue('```json\n{"type":"wait","ms":250}\n```');
    const runtime = new ModelActionRuntime({ client: { generate } });
    await expect(runtime.generate("Wait briefly", observation(), {})).resolves.toBe(
      '{"type":"wait","ms":250}'
    );
    expect(runtime.getDiagnostics().retryCount).toBe(0);
  });
});

describe("transient browser retry", () => {
  it("recovers a transient read failure once and records both events", async () => {
    const browser = new FakeBrowser();
    vi.spyOn(browser, "observe")
      .mockRejectedValueOnce(new Error("Timeout 500ms exceeded"))
      .mockResolvedValueOnce(observation());
    const retrying = new RetryingBrowserController(browser);
    await expect(retrying.observe()).resolves.toMatchObject({ id: "observation-1" });
    expect(retrying.getEvents().map((event) => event.outcome)).toEqual([
      "retrying",
      "recovered"
    ]);
  });

  it("enforces the retry limit", async () => {
    const browser = new FakeBrowser();
    vi.spyOn(browser, "observe").mockRejectedValue(
      new Error("Execution context was destroyed")
    );
    const retrying = new RetryingBrowserController(browser);
    await expect(retrying.observe()).rejects.toThrow("Execution context");
    expect(browser.observe).toHaveBeenCalledTimes(2);
    expect(retrying.getEvents().at(-1)?.outcome).toBe("exhausted");
  });

  it("never retries clicks or non-transient failures", async () => {
    const browser = new FakeBrowser();
    vi.spyOn(browser, "click").mockRejectedValue(new Error("Timeout 500ms exceeded"));
    const retrying = new RetryingBrowserController(browser);
    await expect(retrying.click("#save")).rejects.toThrow("Timeout");
    expect(browser.click).toHaveBeenCalledTimes(1);
    expect(retrying.getEvents()).toEqual([]);
    expect(isTransientBrowserError(new Error("401 invalid credentials"))).toBe(false);
  });

  it("retries connection-closed navigation but not connection-refused", async () => {
    const browser = new FakeBrowser();
    vi.spyOn(browser, "navigate")
      .mockRejectedValueOnce(new Error("page.goto: net::ERR_CONNECTION_CLOSED"))
      .mockResolvedValueOnce();
    const retrying = new RetryingBrowserController(browser);
    await expect(retrying.navigate("https://example.test")).resolves.toBeUndefined();
    expect(browser.navigate).toHaveBeenCalledTimes(2);
    expect(retrying.getEvents().map((event) => event.outcome)).toEqual([
      "retrying",
      "recovered"
    ]);
    expect(
      isTransientBrowserError(new Error("page.goto: net::ERR_CONNECTION_REFUSED"), true)
    ).toBe(false);
  });
});

function observation(): Observation {
  return {
    id: "observation-1",
    timestamp: "2026-09-01T00:00:00.000Z",
    url: "https://example.test/settings",
    title: "Settings",
    metadata: {
      url: "https://example.test/settings",
      title: "Settings",
      viewport: { width: 1280, height: 720 }
    },
    consoleErrors: [],
    accessibility: { headings: [], landmarks: [], interactiveElementCount: 2 },
    elements: [
      {
        id: "save",
        tagName: "button",
        role: "button",
        accessibleName: "Save",
        text: "Save",
        visible: true,
        enabled: true,
        editable: false,
        selector: "#save"
      },
      {
        id: "name",
        tagName: "input",
        role: "textbox",
        accessibleName: "Name",
        text: "",
        visible: true,
        enabled: true,
        editable: true,
        selector: "#name"
      }
    ],
    textSample: "Settings Save",
    screenshotPath: null
  };
}

class FakeBrowser implements BrowserController {
  async observe(): Promise<Observation> {
    return observation();
  }
  async goto(): Promise<void> {}
  async navigate(): Promise<void> {}
  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async getText(): Promise<string> {
    return "Settings";
  }
  async wait(): Promise<void> {}
  async screenshot(): Promise<string> {
    return "evidence.png";
  }
  async assert(): Promise<void> {}
  getCurrentUrl(): string {
    return "https://example.test/settings";
  }
}
