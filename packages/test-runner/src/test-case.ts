import { readFile } from "node:fs/promises";

import { z } from "zod";
import { BrowserActionSchema, type BrowserAction } from "@vibeqa/schemas";

export const TestStepSchema = z.discriminatedUnion("type", [
  BrowserActionSchema.options[1],
  BrowserActionSchema.options[2],
  BrowserActionSchema.options[5],
  BrowserActionSchema.options[7]
]);

export const TestCaseSchema = z.object({
  name: z.string().min(1),
  targetUrl: z.string().url(),
  steps: z.array(TestStepSchema).min(1)
});

export type TestStep = Extract<
  BrowserAction,
  { type: "navigate" | "click" | "wait" | "assert" }
>;

export interface TestCase {
  name: string;
  targetUrl: string;
  steps: TestStep[];
}

export async function loadTestCaseFromJson(path: string): Promise<TestCase> {
  const contents = await readFile(path, "utf8");
  return parseTestCaseJson(contents);
}

export function parseTestCaseJson(contents: string): TestCase {
  return TestCaseSchema.parse(JSON.parse(contents));
}
