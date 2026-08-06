import type { LLMClient } from "./client.js";

export class MockLLMClient implements LLMClient {
  readonly prompts: string[] = [];

  constructor(private readonly response = '{"type":"getCurrentUrl"}') {}

  async generate(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.response;
  }
}
