import type { BrowserAction, Observation } from "@vibeqa/schemas";
import { describe, expect, it, vi } from "vitest";

import { Agent, type BrowserController } from "../src/index.js";

const click = (selector: string): BrowserAction => ({ type: "click", selector });

describe("opt-in exploratory element recovery", () => {
  it("executes a valid current element without recovery", async () => {
    const { agent, browser } = setup([click("#next"), null]);
    const state = await agent.run("Explore this page");
    expect(state).toMatchObject({ completed: true, stepCount: 1, errors: [] });
    expect(browser.click).toHaveBeenCalledWith("#next");
    expect(agent.getTrace().steps.every((step) => !step.elementRecovery)).toBe(true);
  });

  it("rejects a nonexistent synthetic ID, refreshes, and executes only the replanned target", async () => {
    const { agent, browser, prompts } = setup([
      click("#element-7"),
      click("#next"),
      null
    ]);
    const state = await agent.run("Explore this page");
    expect(state).toMatchObject({ completed: true, stepCount: 1, errors: [] });
    expect(browser.click).toHaveBeenCalledTimes(1);
    expect(browser.click).toHaveBeenCalledWith("#next");
    expect(browser.observe).toHaveBeenCalledTimes(3);
    expect(prompts[1]).toContain('"failedSelectors":["#element-7"]');
    const failed = agent.getTrace().steps[0];
    expect(failed).toMatchObject({
      action: click("#element-7"),
      result: { success: false },
      elementRecovery: {
        status: "recovered",
        attempt: 0,
        invalidSelector: "#element-7",
        recoveryObservationId: "observation-2",
        replannedAction: click("#next")
      }
    });
    expect(agent.getMemory().getHistory().observations).toHaveLength(3);
    expect(agent.getMemory().getHistory().actions).toEqual([click("#next")]);
    if (failed?.elementRecovery) failed.elementRecovery.status = "exhausted";
    expect(agent.getTrace().steps[0]?.elementRecovery?.status).toBe("recovered");
  });

  it("recovers a DOM detachment occurring after observation, without replaying the failed selector", async () => {
    const { agent, browser, prompts } = setup([click("#next"), click("#fresh"), null]);
    browser.click.mockImplementationOnce(async () => {
      throw new Error("locator.click: Element is not attached to the DOM");
    });
    browser.observe
      .mockResolvedValueOnce(observation(1, ["#next"]))
      .mockResolvedValue(observation(2, ["#fresh"]));
    const state = await agent.run("Explore the controls");
    expect(state.errors).toEqual([]);
    expect(browser.click.mock.calls).toEqual([["#next"], ["#fresh"]]);
    expect(prompts[1]).toContain('"selector":"#fresh"');
    expect(agent.getTrace().steps[0]?.elementRecovery?.status).toBe("recovered");
  });

  it.each(["#missing", "#next"])(
    "bounds repeated invalid or failed targets (%s) to two replans",
    async (selector) => {
      const { agent, browser, prompts } = setup([
        click(selector),
        click(selector),
        click(selector),
        click("#fresh")
      ]);
      if (selector === "#next")
        browser.click.mockRejectedValue(
          new Error("locator.click: Element is not attached to the DOM")
        );
      const state = await agent.run("Explore the controls");
      expect(state.completed).toBe(false);
      expect(state.errors).toEqual([
        expect.stringContaining("STALE_ELEMENT_RECOVERY_FAILED")
      ]);
      expect(prompts).toHaveLength(3);
      expect(browser.click).toHaveBeenCalledTimes(selector === "#next" ? 1 : 0);
      expect(browser.observe).toHaveBeenCalledTimes(3);
      expect(
        agent.getTrace().steps.map((step) => step.elementRecovery?.attempt)
      ).toEqual([0, 1, 2]);
      expect(
        agent
          .getTrace()
          .steps.every((step) => step.elementRecovery?.status === "exhausted")
      ).toBe(true);
    }
  );

  it("does not treat null during recovery as successful completion", async () => {
    const { agent } = setup([click("#missing"), null]);
    expect(await agent.run("Explore the page")).toMatchObject({
      completed: false,
      errors: [expect.stringContaining("STALE_ELEMENT_RECOVERY_FAILED")]
    });
  });

  it("cannot execute a reference from the previous page after navigation", async () => {
    const { agent, browser } = setup([
      { type: "navigate", url: "https://example.test/new" },
      click("#old"),
      click("#fresh"),
      null
    ]);
    browser.observe.mockResolvedValueOnce(observation(1, ["#old"])).mockResolvedValue({
      ...observation(2, ["#fresh"]),
      url: "https://example.test/new"
    });
    expect((await agent.run("Explore both pages")).errors).toEqual([]);
    expect(browser.click.mock.calls).toEqual([["#fresh"]]);
    expect(agent.getTrace().steps[1]?.elementRecovery?.invalidSelector).toBe("#old");
  });

  it.each(["#purchase", "#delete-account"])(
    "preserves safety for replanned %s",
    async (selector) => {
      const { agent, browser } = setup([click("#missing"), click(selector), null]);
      browser.observe.mockResolvedValue(observation(1, [selector]));
      await agent.run("Explore the page");
      expect(browser.click).not.toHaveBeenCalled();
      expect(agent.getTrace().steps[1]?.safetyDecision).toBe(
        selector === "#purchase" ? "require_approval" : "block"
      );
      expect(agent.getTrace().steps[0]?.elementRecovery?.status).toBe("interrupted");
    }
  );

  it.each([
    "locator.click: Timeout 30000ms exceeded. click action done; waiting for scheduled navigations to finish",
    "Browser closed"
  ])(
    "does not recover potentially dispatched actions or infrastructure failures: %s",
    async (message) => {
      const { agent, browser, prompts } = setup([click("#next"), click("#fresh")]);
      browser.click.mockRejectedValue(new Error(message));
      expect((await agent.run("Explore the page")).errors).toEqual([message]);
      expect(prompts).toHaveLength(1);
      expect(agent.getTrace().steps[0]?.elementRecovery).toBeUndefined();
    }
  );

  it("leaves default Agent and functional/regression callers unchanged", async () => {
    const { browser, client } = setup([click("#missing"), null]);
    browser.click.mockRejectedValue(
      new Error("locator.click: Element is not attached to the DOM")
    );
    const agent = new Agent({ browser, llmClient: client });
    await agent.run("Existing workflow");
    expect(browser.click).toHaveBeenCalledWith("#missing");
    expect(agent.getTrace().steps[0]?.elementRecovery).toBeUndefined();
  });

  it("does not include a failed sensitive input value in recovery context or trace", async () => {
    const { agent, prompts } = setup([
      { type: "type", selector: "#password-missing", value: "private-secret-value" },
      click("#next"),
      null
    ]);
    await agent.run("Explore the page");
    expect(JSON.stringify(agent.getTrace())).not.toContain("private-secret-value");
    expect(prompts[1]).not.toContain("private-secret-value");
  });
});

function setup(actions: Array<BrowserAction | null>) {
  const prompts: string[] = [];
  const client = {
    generate: async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify(actions.shift() ?? null);
    }
  };
  let index = 0;
  const browser = {
    observe: vi.fn(async () => observation(++index, ["#next"])),
    goto: vi.fn<BrowserController["goto"]>().mockResolvedValue(undefined),
    navigate: vi.fn<BrowserController["navigate"]>().mockResolvedValue(undefined),
    click: vi.fn<BrowserController["click"]>().mockResolvedValue(undefined),
    type: vi.fn<BrowserController["type"]>().mockResolvedValue(undefined),
    getText: vi.fn(async () => "Page text"),
    wait: vi.fn(async () => {}),
    screenshot: vi.fn(async () => "evidence.png"),
    assert: vi.fn(async () => {}),
    getCurrentUrl: () => "https://example.test/"
  } satisfies BrowserController;
  return {
    agent: new Agent({
      browser,
      llmClient: client,
      recoverElementActions: true,
      maxSteps: 5
    }),
    browser,
    client,
    prompts
  };
}

function observation(index: number, selectors: string[]): Observation {
  return {
    id: `observation-${index}`,
    timestamp: new Date().toISOString(),
    url: "https://example.test/",
    title: "Page",
    metadata: {
      url: "https://example.test/",
      title: "Page",
      viewport: { width: 1280, height: 900 }
    },
    consoleErrors: [],
    accessibility: {
      headings: [],
      landmarks: [],
      interactiveElementCount: selectors.length
    },
    elements: selectors.map((selector, i) => ({
      id: `element-${i + 7}`,
      tagName: "button",
      role: "button",
      accessibleName: "Next",
      text: "Next",
      selector,
      visible: true,
      enabled: true,
      editable: false
    })),
    textSample: "Page text",
    screenshotPath: "evidence.png"
  };
}
