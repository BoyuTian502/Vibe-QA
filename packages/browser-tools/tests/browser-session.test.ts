import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startBenchmarkServer,
  type BenchmarkServer
} from "../../../apps/benchmark-app/src/index.js";
import { ObservationSchema } from "../../schemas/src/index.js";
import { BrowserSession } from "../src/index.js";

let app: BenchmarkServer;
let session: BrowserSession | null;

beforeEach(async () => {
  app = await startBenchmarkServer();
  app.reset();
  session = await BrowserSession.launch({ headless: true });
});

afterEach(async () => {
  await session?.close();
  await app.close();
  session = null;
});

describe("BrowserSession", () => {
  it("opens the benchmark login page and returns structured observation output", async () => {
    const screenshotPath = join(
      process.cwd(),
      "run-output",
      "test-screenshots",
      "login.png"
    );

    await mkdir(join(process.cwd(), "run-output", "test-screenshots"), {
      recursive: true
    });
    expect(session).not.toBeNull();

    await session.goto(`${app.url}/login`);

    const observation = await session.observe({ screenshotPath });

    expect(ObservationSchema.parse(observation)).toEqual(observation);
    expect(observation.url).toBe(`${app.url}/login`);
    expect(observation.title).toContain("VibeQA Benchmark Login");
    expect(observation.metadata.title).toBe(observation.title);
    expect(observation.consoleErrors).toEqual([]);
    expect(observation.accessibility.headings.map((heading) => heading.text)).toContain(
      "Sign in to Acme Growth"
    );
    expect(observation.accessibility.interactiveElementCount).toBeGreaterThan(0);
    expect(observation.textSample).toContain("Sign in to Acme Growth");
    expect(
      observation.elements.some((element) => element.selector === 'input[name="email"]')
    ).toBe(true);
    expect(observation.screenshotPath).toBe(screenshotPath);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});
