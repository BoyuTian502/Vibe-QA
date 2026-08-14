import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  type AccessibilityInfo,
  type ConsoleError,
  ElementInformationSchema,
  ObservationSchema,
  type ElementInformation,
  type Observation
} from "@vibeqa/schemas";

export interface BrowserSessionOptions {
  headless?: boolean;
  executablePath?: string;
  viewport?: {
    width: number;
    height: number;
  };
}

export interface ScreenshotOptions {
  path?: string;
  fullPage?: boolean;
}

export class BrowserSession {
  private readonly consoleErrors: ConsoleError[];

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    consoleErrors: ConsoleError[]
  ) {
    this.consoleErrors = consoleErrors;
  }

  static async launch(options: BrowserSessionOptions = {}): Promise<BrowserSession> {
    const executablePath = options.executablePath ?? findSystemChromiumExecutable();
    const browser = await chromium.launch({
      executablePath,
      headless: options.headless ?? true
    });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 900 }
    });
    const page = await context.newPage();
    const consoleErrors: ConsoleError[] = [];

    page.on("console", (message) => {
      if (message.type() !== "error") {
        return;
      }

      if (message.text().startsWith("Failed to load resource:")) {
        return;
      }

      consoleErrors.push({
        type: "console",
        text: message.text(),
        location: message.location()
      });
    });

    page.on("pageerror", (error) => {
      consoleErrors.push({
        type: "pageerror",
        text: error.message,
        location: null
      });
    });

    return new BrowserSession(browser, context, page, consoleErrors);
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async navigate(url: string): Promise<void> {
    await this.goto(url);
  }

  async click(selector: string): Promise<void> {
    await this.page.locator(selector).click();
  }

  async type(selector: string, value: string): Promise<void> {
    await this.page.locator(selector).fill(value);
  }

  async getText(selector: string): Promise<string> {
    return (await this.page.locator(selector).innerText()).trim();
  }

  async wait(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async assert(selector: string, containsText: string): Promise<void> {
    const text = await this.getText(selector);
    if (!text.includes(containsText)) {
      throw new Error(
        `Assertion failed for ${selector}: expected text to contain "${containsText}".`
      );
    }
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Uint8Array | string> {
    if (options.path) {
      await mkdir(dirname(options.path), { recursive: true });
      await this.page.screenshot({
        path: options.path,
        fullPage: options.fullPage ?? true
      });
      return options.path;
    }

    return await this.page.screenshot({
      fullPage: options.fullPage ?? true
    });
  }

  getCurrentUrl(): string {
    return this.page.url();
  }

  async observe(options: { screenshotPath?: string } = {}): Promise<Observation> {
    const screenshotPath = options.screenshotPath
      ? String(await this.screenshot({ path: options.screenshotPath }))
      : null;
    const elements = await this.collectElements();
    const accessibility = await this.collectAccessibilityInfo(elements.length);
    const title = await this.page.title();
    const url = this.getCurrentUrl();
    const textSample = (await this.page.locator("body").innerText())
      .trim()
      .slice(0, 2000);

    return ObservationSchema.parse({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      url,
      title,
      metadata: {
        url,
        title,
        viewport: this.page.viewportSize()
      },
      consoleErrors: this.consoleErrors,
      accessibility,
      elements,
      textSample,
      screenshotPath
    });
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }

  private async collectElements(): Promise<ElementInformation[]> {
    const elements = await this.page
      .locator("a, button, input, textarea, select")
      .evaluateAll((nodes) => {
        function selectorFor(element: HTMLElement): string {
          const id = element.getAttribute("id");
          if (id) {
            return `#${CSS.escape(id)}`;
          }

          const name = element.getAttribute("name");
          if (name) {
            return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
          }

          return element.tagName.toLowerCase();
        }

        return nodes
          .filter((node) => node instanceof HTMLElement)
          .map((node, index) => {
            const element = node as HTMLElement;
            const input = element instanceof HTMLInputElement ? element : null;
            const anchor = element instanceof HTMLAnchorElement ? element : null;
            const textarea = element instanceof HTMLTextAreaElement ? element : null;
            const select = element instanceof HTMLSelectElement ? element : null;
            const disabled =
              (input?.disabled ?? false) ||
              (textarea?.disabled ?? false) ||
              (select?.disabled ?? false);
            const role = element.getAttribute("role");
            const ariaLabel = element.getAttribute("aria-label");
            const label =
              input?.labels?.[0]?.textContent ??
              textarea?.labels?.[0]?.textContent ??
              null;

            return {
              id: `element-${index + 1}`,
              tagName: element.tagName.toLowerCase(),
              role,
              accessibleName:
                (ariaLabel ?? label ?? element.textContent ?? "").trim() || null,
              text: (
                element.textContent ??
                input?.value ??
                textarea?.value ??
                ""
              ).trim(),
              visible: element.offsetParent !== null,
              enabled: !disabled,
              editable: Boolean(input || textarea || select),
              selector: selectorFor(element),
              href: anchor?.href ?? null,
              inputType: input?.type ?? null
            };
          });
      });

    return elements.map((element) => ElementInformationSchema.parse(element));
  }

  private async collectAccessibilityInfo(
    interactiveElementCount: number
  ): Promise<AccessibilityInfo> {
    return await this.page.evaluate((count) => {
      const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
        .map((heading) => ({
          level: Number(heading.tagName.slice(1)),
          text: (heading.textContent ?? "").trim()
        }))
        .filter((heading) => heading.text.length > 0);

      const landmarks = Array.from(
        document.querySelectorAll("main, nav, header, footer, aside, section, [role]")
      )
        .map((element) => {
          const explicitRole = element.getAttribute("role");
          const tagRole = roleForTag(element.tagName.toLowerCase());
          const role = explicitRole ?? tagRole;
          if (!role) {
            return null;
          }

          return {
            role,
            name:
              element.getAttribute("aria-label") ??
              element.getAttribute("aria-labelledby") ??
              null
          };
        })
        .filter((landmark): landmark is { role: string; name: string | null } =>
          Boolean(landmark)
        );

      return {
        headings,
        landmarks,
        interactiveElementCount: count
      };

      function roleForTag(tagName: string): string | null {
        switch (tagName) {
          case "main":
            return "main";
          case "nav":
            return "navigation";
          case "header":
            return "banner";
          case "footer":
            return "contentinfo";
          case "aside":
            return "complementary";
          case "section":
            return "region";
          default:
            return null;
        }
      }
    }, interactiveElementCount);
  }
}

function findSystemChromiumExecutable(): string | undefined {
  const configuredPath = process.env.VIBEQA_BROWSER_EXECUTABLE_PATH;
  if (configuredPath && existsSync(configuredPath)) {
    return configuredPath;
  }

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
        ];

  return candidates.find((candidate) => existsSync(candidate));
}
