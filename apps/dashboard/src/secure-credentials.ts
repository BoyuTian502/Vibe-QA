import type { BrowserController } from "@vibeqa/agent-core";
import type { Observation } from "@vibeqa/schemas";

export const TEMPORARY_USERNAME_PLACEHOLDER = "{{VIBEQA_TEMP_USERNAME}}";
export const TEMPORARY_PASSWORD_PLACEHOLDER = "{{VIBEQA_TEMP_PASSWORD}}";

const MAX_CREDENTIAL_LENGTH = 512;
const COMMON_CREDENTIAL_SELECTORS = [
  'input[type="password"]',
  'input[type="email"]',
  'input[name*="user" i]',
  'input[name*="login" i]',
  'input[autocomplete="username"]',
  'input[autocomplete="current-password"]'
] as const;

interface SensitiveBrowserController extends BrowserController {
  registerSensitiveSelector?(selector: string): void;
  registerSensitiveValue?(value: string): void;
}

export class TemporaryLoginCredentials {
  #username: string;
  #password: string;

  constructor(username: string, password: string) {
    if (username.length === 0 || password.length === 0) {
      throw new Error("Both a login username and password are required.");
    }
    if (
      username.length > MAX_CREDENTIAL_LENGTH ||
      password.length > MAX_CREDENTIAL_LENGTH
    ) {
      throw new Error(
        `Temporary credentials must be ${MAX_CREDENTIAL_LENGTH} characters or fewer.`
      );
    }

    this.#username = username;
    this.#password = password;
  }

  get cleared(): boolean {
    return this.#username.length === 0 && this.#password.length === 0;
  }

  resolveValue(selector: string, plannedValue: string): string {
    this.assertAvailable();
    if (
      plannedValue === TEMPORARY_PASSWORD_PLACEHOLDER ||
      isPasswordSelector(selector)
    ) {
      return this.#password;
    }
    if (
      plannedValue === TEMPORARY_USERNAME_PLACEHOLDER ||
      isUsernameSelector(selector)
    ) {
      return this.#username;
    }
    return plannedValue;
  }

  redact(value: string): string {
    let redacted = value;
    for (const secret of [this.#username, this.#password]) {
      if (secret.length > 0) {
        redacted = redacted.split(secret).join("[REDACTED]");
      }
    }
    return redacted;
  }

  registerWith(browser: SensitiveBrowserController): void {
    this.assertAvailable();
    for (const selector of COMMON_CREDENTIAL_SELECTORS) {
      browser.registerSensitiveSelector?.(selector);
    }
    browser.registerSensitiveValue?.(this.#username);
    browser.registerSensitiveValue?.(this.#password);
  }

  clear(): void {
    this.#username = "";
    this.#password = "";
  }

  toJSON(): { redacted: true } {
    return { redacted: true };
  }

  private assertAvailable(): void {
    if (this.cleared) {
      throw new Error("Temporary login credentials are no longer available.");
    }
  }
}

export class SecureAuthenticatedBrowserController implements BrowserController {
  constructor(
    private readonly browser: SensitiveBrowserController,
    private readonly credentials: TemporaryLoginCredentials
  ) {
    credentials.registerWith(browser);
  }

  async observe(): Promise<Observation> {
    return redactValue(
      await this.secureCall(async () => await this.browser.observe()),
      this.credentials
    ) as Observation;
  }

  async goto(url: string): Promise<void> {
    await this.secureCall(async () => await this.browser.goto(url));
  }

  async navigate(url: string): Promise<void> {
    await this.secureCall(async () => await this.browser.navigate(url));
  }

  async click(selector: string): Promise<void> {
    await this.secureCall(async () => await this.browser.click(selector));
  }

  async type(selector: string, value: string): Promise<void> {
    this.browser.registerSensitiveSelector?.(selector);
    const resolvedValue = this.credentials.resolveValue(selector, value);
    await this.secureCall(async () => await this.browser.type(selector, resolvedValue));
  }

  async getText(selector: string): Promise<string> {
    return this.credentials.redact(
      await this.secureCall(async () => await this.browser.getText(selector))
    );
  }

  async wait(ms: number): Promise<void> {
    await this.secureCall(async () => await this.browser.wait(ms));
  }

  async screenshot(options?: { path?: string }): Promise<Uint8Array | string> {
    return await this.secureCall(async () => await this.browser.screenshot(options));
  }

  async assert(selector: string, containsText: string): Promise<void> {
    await this.secureCall(
      async () => await this.browser.assert(selector, containsText)
    );
  }

  getCurrentUrl(): string {
    try {
      return this.credentials.redact(this.browser.getCurrentUrl());
    } catch (error) {
      throw sanitizedError(error, this.credentials);
    }
  }

  private async secureCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw sanitizedError(error, this.credentials);
    }
  }
}

export function redactCredentialValues<T>(
  value: T,
  credentials: TemporaryLoginCredentials | null
): T {
  return credentials ? (redactValue(value, credentials) as T) : value;
}

function redactValue(value: unknown, credentials: TemporaryLoginCredentials): unknown {
  if (typeof value === "string") {
    return credentials.redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, credentials));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, credentials)])
    );
  }
  return value;
}

function sanitizedError(error: unknown, credentials: TemporaryLoginCredentials): Error {
  const message =
    error instanceof Error ? error.message : "Authenticated browser action failed.";
  return new Error(credentials.redact(message));
}

function isPasswordSelector(selector: string): boolean {
  return /password|passwd|passcode|secret/i.test(selector);
}

function isUsernameSelector(selector: string): boolean {
  return /username|user-name|email|login|account/i.test(selector);
}
