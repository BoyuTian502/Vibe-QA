import type { BrowserController } from "@vibeqa/agent-core";
import {
  BrowserSession,
  type BrowserSessionOptions,
  type ScreenshotOptions
} from "@vibeqa/browser-tools";
import type { ConsoleError, Observation } from "@vibeqa/schemas";

export type PlaywrightBrowserControllerOptions = BrowserSessionOptions;

export class PlaywrightBrowserController implements BrowserController {
  private constructor(private readonly session: BrowserSession) {}

  static async launch(
    options: PlaywrightBrowserControllerOptions = {}
  ): Promise<PlaywrightBrowserController> {
    const session = await BrowserSession.launch(options);
    return new PlaywrightBrowserController(session);
  }

  async goto(url: string): Promise<void> {
    await this.session.goto(url);
  }

  async navigate(url: string): Promise<void> {
    await this.session.navigate(url);
  }

  async observe(): Promise<Observation> {
    return await this.session.observe();
  }

  async click(selector: string): Promise<void> {
    await this.session.click(selector);
  }

  async type(selector: string, value: string): Promise<void> {
    await this.session.type(selector, value);
  }

  async getText(selector: string): Promise<string> {
    return await this.session.getText(selector);
  }

  async wait(ms: number): Promise<void> {
    await this.session.wait(ms);
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Uint8Array | string> {
    return await this.session.screenshot(options);
  }

  registerSensitiveSelector(selector: string): void {
    this.session.registerSensitiveSelector(selector);
  }

  registerSensitiveValue(value: string): void {
    this.session.registerSensitiveValue(value);
  }

  async assert(selector: string, containsText: string): Promise<void> {
    await this.session.assert(selector, containsText);
  }

  getCurrentUrl(): string {
    return this.session.getCurrentUrl();
  }

  async getConsoleErrors(): Promise<ConsoleError[]> {
    const observation = await this.session.observe();
    return [...observation.consoleErrors];
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
