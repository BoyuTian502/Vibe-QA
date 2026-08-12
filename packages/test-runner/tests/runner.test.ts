import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startBenchmarkServer,
  type BenchmarkServer
} from "../../../apps/benchmark-app/src/index.js";
import { BrowserSession } from "../../browser-tools/src/index.js";
import { loadTestCaseFromJson, TestRunner } from "../src/index.js";

let app: BenchmarkServer;
let browser: BrowserSession | null;

beforeEach(async () => {
  app = await startBenchmarkServer();
  app.reset();
  browser = await BrowserSession.launch({ headless: true });
});

afterEach(async () => {
  await browser?.close();
  await app.close();
  browser = null;
});

describe("TestRunner", () => {
  it("loads a JSON test case and executes ordered steps through AgentLoop", async () => {
    expect(browser).not.toBeNull();

    const testCasePath = join(process.cwd(), "run-output", "test-runner-case.json");
    await mkdir(join(process.cwd(), "run-output"), { recursive: true });
    await writeFile(
      testCasePath,
      JSON.stringify(
        {
          name: "Benchmark login page smoke test",
          targetUrl: `${app.url}/login`,
          steps: [
            {
              type: "assert",
              selector: "body",
              containsText: "Sign in to Acme Growth"
            },
            {
              type: "wait",
              ms: 1
            }
          ]
        },
        null,
        2
      )
    );

    const testCase = await loadTestCaseFromJson(testCasePath);
    const runner = new TestRunner({ browser });

    const result = await runner.run(testCase);

    expect(result).toMatchObject({
      testName: "Benchmark login page smoke test",
      status: "passed",
      passedSteps: 2,
      failedSteps: 0,
      error: null
    });
    expect(result.executionTrace).toHaveLength(2);
    expect(result.executionTrace[0]?.observation.textSample).toContain(
      "Sign in to Acme Growth"
    );
    expect(result.executionTrace[0]?.nextObservation?.textSample).toContain(
      "Sign in to Acme Growth"
    );
  });

  it("returns a structured failure result when verification fails", async () => {
    expect(browser).not.toBeNull();

    const runner = new TestRunner({ browser });
    const result = await runner.run({
      name: "Expected failure scenario",
      targetUrl: `${app.url}/login`,
      steps: [
        {
          type: "assert",
          selector: "body",
          containsText: "This text is not on the login page"
        }
      ]
    });

    expect(result.status).toBe("failed");
    expect(result.passedSteps).toBe(0);
    expect(result.failedSteps).toBe(1);
    expect(result.error).toContain("Assertion failed");
    expect(result.executionTrace[0]?.status).toBe("failed");
    expect(result.executionTrace[0]?.result?.ok).toBe(false);
  });
});
