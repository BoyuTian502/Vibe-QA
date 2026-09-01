import type { BrowserController } from "@vibeqa/agent-core";
import type { Observation } from "@vibeqa/schemas";

export type BrowserRetryOperation =
  "observe" | "goto" | "navigate" | "getText" | "wait" | "screenshot";

export interface BrowserRetryEvent {
  operation: BrowserRetryOperation;
  attempt: number;
  maxAttempts: number;
  outcome: "retrying" | "recovered" | "exhausted";
  error: string;
  timestamp: string;
}

export interface RetryingBrowserControllerOptions {
  maxRetries?: number;
  now?: () => Date;
}

export class RetryingBrowserController implements BrowserController {
  private readonly maxRetries: number;
  private readonly now: () => Date;
  private readonly events: BrowserRetryEvent[] = [];

  constructor(
    private readonly browser: BrowserController,
    options: RetryingBrowserControllerOptions = {}
  ) {
    this.maxRetries = options.maxRetries ?? 1;
    this.now = options.now ?? (() => new Date());
  }

  async observe(): Promise<Observation> {
    return await this.retry("observe", async () => await this.browser.observe());
  }

  async goto(url: string): Promise<void> {
    await this.retry("goto", async () => await this.browser.goto(url), true);
  }

  async navigate(url: string): Promise<void> {
    await this.retry("navigate", async () => await this.browser.navigate(url), true);
  }

  async click(selector: string): Promise<void> {
    await this.browser.click(selector);
  }

  async type(selector: string, value: string): Promise<void> {
    await this.browser.type(selector, value);
  }

  async getText(selector: string): Promise<string> {
    return await this.retry(
      "getText",
      async () => await this.browser.getText(selector)
    );
  }

  async wait(ms: number): Promise<void> {
    await this.retry("wait", async () => await this.browser.wait(ms));
  }

  async screenshot(options?: { path?: string }): Promise<Uint8Array | string> {
    return await this.retry(
      "screenshot",
      async () => await this.browser.screenshot(options)
    );
  }

  async assert(selector: string, containsText: string): Promise<void> {
    await this.browser.assert(selector, containsText);
  }

  getCurrentUrl(): string {
    return this.browser.getCurrentUrl();
  }

  getEvents(): BrowserRetryEvent[] {
    return structuredClone(this.events);
  }

  private async retry<T>(
    operation: BrowserRetryOperation,
    execute: () => Promise<T>,
    navigation = false
  ): Promise<T> {
    let lastError: unknown;
    const maxAttempts = this.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await execute();
        if (attempt > 1) {
          this.record(operation, attempt, maxAttempts, "recovered", lastError);
        }
        return result;
      } catch (error) {
        lastError = error;
        const retryable = isTransientBrowserError(error, navigation);
        if (!retryable || attempt === maxAttempts) {
          if (retryable) {
            this.record(operation, attempt, maxAttempts, "exhausted", error);
          }
          throw error;
        }
        this.record(operation, attempt, maxAttempts, "retrying", error);
      }
    }
    throw lastError;
  }

  private record(
    operation: BrowserRetryOperation,
    attempt: number,
    maxAttempts: number,
    outcome: BrowserRetryEvent["outcome"],
    error: unknown
  ): void {
    this.events.push({
      operation,
      attempt,
      maxAttempts,
      outcome,
      error: browserErrorMessage(error),
      timestamp: this.now().toISOString()
    });
  }
}

export function isTransientBrowserError(error: unknown, navigation = false): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  if (
    /Target page, context or browser has been closed|ERR_(?:CONNECTION_REFUSED|NAME_NOT_RESOLVED|CERT_|PROXY_|INTERNET_DISCONNECTED)|401|403|credential|password|unsupported|safety|denied|not found/i.test(
      message
    )
  ) {
    return false;
  }
  if (
    /Execution context was destroyed|frame was detached|detached Frame/i.test(message)
  )
    return true;
  if (
    navigation &&
    /net::ERR_(?:ABORTED|CONNECTION_CLOSED|CONNECTION_RESET)|Navigation.*interrupted/i.test(
      message
    )
  )
    return true;
  return /Timeout \d+ms exceeded|TimeoutError/i.test(message);
}

function browserErrorMessage(error: unknown): string {
  return error instanceof Error
    ? stripAnsiStyles(error.message).replace(/\s+/gu, " ").slice(0, 300)
    : "Transient browser operation failed.";
}

function stripAnsiStyles(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "");
}
