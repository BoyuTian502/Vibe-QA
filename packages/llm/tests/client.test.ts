import { describe, expect, it } from "vitest";

import { MockLLMClient } from "../src/index.js";

describe("MockLLMClient", () => {
  it("returns a deterministic response and records prompts", async () => {
    const client = new MockLLMClient('{"type":"getCurrentUrl"}');

    await expect(client.generate("Choose the next browser action.")).resolves.toBe(
      '{"type":"getCurrentUrl"}'
    );
    expect(client.prompts).toEqual(["Choose the next browser action."]);
  });
});
