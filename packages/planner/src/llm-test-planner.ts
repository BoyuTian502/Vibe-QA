import type { LLMClient } from "@vibeqa/llm";
import { BrowserActionSchema } from "@vibeqa/schemas";

import type { TestCase, TestPlanner, TestStep } from "./test-planner.js";

export class LLMTestPlanner implements TestPlanner {
  constructor(private readonly client: LLMClient) {}

  async plan(request: string, startUrl: string): Promise<TestCase> {
    if (request.trim().length === 0) {
      throw new Error("Test request must not be empty.");
    }

    const normalizedStartUrl = new URL(startUrl).toString();
    const response = await this.client.generate(
      this.createPrompt(request, normalizedStartUrl)
    );
    return parseTestCase(response, normalizedStartUrl);
  }

  private createPrompt(request: string, startUrl: string): string {
    return [
      "You are VibeQA's functional website test planner.",
      "Convert the testing request into one deterministic TestCase.",
      "Return only JSON. Do not include Markdown or commentary.",
      `Testing request: ${request}`,
      `Required start URL: ${startUrl}`,
      "Output schema:",
      JSON.stringify(
        {
          goal: "string",
          startUrl,
          steps: [
            {
              name: "string",
              action: {
                type: "navigate | goto | click | type | getText | wait | screenshot | assert | getCurrentUrl"
              },
              expected: {
                url: "optional absolute URL",
                urlChanged: "optional boolean",
                requiredText: "optional string",
                allowConsoleErrors: "optional boolean"
              }
            }
          ]
        },
        null,
        2
      ),
      "Use CSS selectors for element actions.",
      "Include explicit verification expectations where the requested outcome is known.",
      "Do not invent credentials unless they are present in the testing request."
    ].join("\n");
  }
}

function parseTestCase(response: string, requiredStartUrl: string): TestCase {
  const parsed = JSON.parse(stripJsonCodeFence(response.trim())) as unknown;
  const record = objectRecord(parsed, "Planner response must be a JSON object.");
  const goal = nonEmptyString(record.goal, "TestCase.goal must be a non-empty string.");
  const startUrl = new URL(
    nonEmptyString(record.startUrl, "TestCase.startUrl must be a URL.")
  ).toString();

  if (startUrl !== requiredStartUrl) {
    throw new Error(
      `Planner changed the required start URL from ${requiredStartUrl} to ${startUrl}.`
    );
  }

  if (!Array.isArray(record.steps) || record.steps.length === 0) {
    throw new Error("TestCase.steps must contain at least one step.");
  }

  return {
    goal,
    startUrl,
    steps: record.steps.map((step, index) => parseTestStep(step, index))
  };
}

function parseTestStep(value: unknown, index: number): TestStep {
  const record = objectRecord(value, `TestCase.steps[${index}] must be an object.`);
  const name = nonEmptyString(
    record.name,
    `TestCase.steps[${index}].name must be a non-empty string.`
  );
  const action = BrowserActionSchema.parse(record.action);
  const expected =
    record.expected === undefined
      ? undefined
      : parseExpectation(record.expected, index);

  return expected ? { name, action, expected } : { name, action };
}

function parseExpectation(
  value: unknown,
  index: number
): NonNullable<TestStep["expected"]> {
  const record = objectRecord(
    value,
    `TestCase.steps[${index}].expected must be an object.`
  );
  const expected: NonNullable<TestStep["expected"]> = {};

  if (record.url !== undefined) {
    expected.url = new URL(
      nonEmptyString(record.url, `TestCase.steps[${index}].expected.url must be a URL.`)
    ).toString();
  }

  if (record.urlChanged !== undefined) {
    expected.urlChanged = booleanValue(
      record.urlChanged,
      `TestCase.steps[${index}].expected.urlChanged must be a boolean.`
    );
  }

  if (record.requiredText !== undefined) {
    expected.requiredText = nonEmptyString(
      record.requiredText,
      `TestCase.steps[${index}].expected.requiredText must be a non-empty string.`
    );
  }

  if (record.allowConsoleErrors !== undefined) {
    expected.allowConsoleErrors = booleanValue(
      record.allowConsoleErrors,
      `TestCase.steps[${index}].expected.allowConsoleErrors must be a boolean.`
    );
  }

  return expected;
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }

  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }

  return value;
}

function booleanValue(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }

  return value;
}

function stripJsonCodeFence(response: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(response);
  return match?.[1] ?? response;
}
