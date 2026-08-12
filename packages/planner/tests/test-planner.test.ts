import { describe, expect, it } from "vitest";

import { MockLLMClient } from "../../llm/src/index.js";
import type { TestCase as EngineTestCase } from "../../test-engine/src/index.js";
import { LLMTestPlanner, type TestCase, type TestPlanner } from "../src/index.js";

describe("LLMTestPlanner", () => {
  it("converts a natural language request into a structured TestCase", async () => {
    const response = JSON.stringify({
      goal: "Test login functionality",
      startUrl: "http://localhost:3000/login",
      steps: [
        {
          name: "Enter email",
          action: {
            type: "type",
            selector: 'input[name="email"]',
            value: "qa@example.com"
          }
        },
        {
          name: "Submit login",
          action: { type: "click", selector: 'button[type="submit"]' },
          expected: {
            url: "http://localhost:3000/dashboard",
            urlChanged: true,
            requiredText: "PRIVATE DASHBOARD",
            allowConsoleErrors: false
          }
        }
      ]
    });
    const client = new MockLLMClient(response);
    const planner: TestPlanner = new LLMTestPlanner(client);

    const testCase = await planner.plan(
      "Test login functionality of this website",
      "http://localhost:3000/login"
    );

    expect(testCase).toEqual(JSON.parse(response));
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).toContain(
      "Testing request: Test login functionality of this website"
    );
    expect(client.prompts[0]).toContain(
      "Required start URL: http://localhost:3000/login"
    );

    const engineCompatible: EngineTestCase = testCase;
    expect(engineCompatible.goal).toBe("Test login functionality");
  });

  it("parses JSON returned inside a code fence", async () => {
    const client = new MockLLMClient(
      `\`\`\`json
${JSON.stringify({
  goal: "Inspect login page",
  startUrl: "http://localhost:3000/login",
  steps: [{ name: "Observe URL", action: { type: "getCurrentUrl" } }]
})}
\`\`\``
    );
    const planner = new LLMTestPlanner(client);

    await expect(
      planner.plan("Inspect login page", "http://localhost:3000/login")
    ).resolves.toMatchObject({
      goal: "Inspect login page",
      steps: [{ action: { type: "getCurrentUrl" } }]
    });
  });

  it("rejects invalid actions and start URL changes", async () => {
    const invalidActionPlanner = createPlanner({
      goal: "Test login",
      startUrl: "http://localhost:3000/login",
      steps: [{ name: "Do something", action: { type: "hover" } }]
    });
    const changedUrlPlanner = createPlanner({
      goal: "Test login",
      startUrl: "https://example.com/login",
      steps: [{ name: "Read URL", action: { type: "getCurrentUrl" } }]
    });

    await expect(
      invalidActionPlanner.plan("Test login", "http://localhost:3000/login")
    ).rejects.toThrow();
    await expect(
      changedUrlPlanner.plan("Test login", "http://localhost:3000/login")
    ).rejects.toThrow("Planner changed the required start URL");
  });
});

function createPlanner(response: unknown): LLMTestPlanner {
  return new LLMTestPlanner(new MockLLMClient(JSON.stringify(response)));
}

const typeCompatibilityCheck: TestCase | null = null;
void typeCompatibilityCheck;
