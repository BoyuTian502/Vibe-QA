import type { LLMClient } from "@vibeqa/llm";
import {
  BrowserActionSchema,
  type AgentState,
  type BrowserAction,
  type Observation
} from "@vibeqa/schemas";

import type { Planner } from "./planner.js";

export class LLMPlanner implements Planner {
  constructor(private readonly client: LLMClient) {}

  async decide(
    state: AgentState,
    observation: Observation
  ): Promise<BrowserAction | null> {
    const prompt = this.createPrompt(state, observation);
    const response = await this.client.generate(prompt);
    return this.parseAction(response);
  }

  private createPrompt(state: AgentState, observation: Observation): string {
    return [
      "You are choosing the next typed browser action for VibeQA.",
      "Return only JSON matching one BrowserAction, or null.",
      `Goal: ${state.goal}`,
      `Step count: ${state.stepCount}`,
      `Current URL: ${observation.url}`,
      `Title: ${observation.title}`,
      `Visible text: ${observation.textSample}`,
      `Elements: ${JSON.stringify(
        observation.elements.map((element) => ({
          selector: element.selector,
          tagName: element.tagName,
          accessibleName: element.accessibleName,
          text: element.text,
          enabled: element.enabled,
          editable: element.editable
        }))
      )}`
    ].join("\n");
  }

  private parseAction(response: string): BrowserAction | null {
    const parsed = JSON.parse(response) as unknown;
    if (parsed === null) {
      return null;
    }

    return BrowserActionSchema.parse(parsed);
  }
}
