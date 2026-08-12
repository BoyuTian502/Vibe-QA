import type { LLMClient } from "./client.js";

export class OllamaClient implements LLMClient {
  constructor(private readonly model = "qwen2.5-coder:7b") {}

  async generate(prompt: string): Promise<string> {
    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const data = await response.json();

    return data.response;
  }
}
