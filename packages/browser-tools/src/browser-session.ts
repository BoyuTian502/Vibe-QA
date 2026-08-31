import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request
} from "playwright";
import {
  type AccessibilityInfo,
  type ConsoleError,
  ElementInformationSchema,
  ObservationSchema,
  type ElementInformation,
  type Observation,
  type NavigationMetadata
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
  private readonly sensitiveSelectors = new Set<string>();
  private readonly sensitiveValues = new Set<string>();
  private navigation: NavigationMetadata | null = null;
  private documentResponse: { url: string; status: number } | null = null;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    consoleErrors: ConsoleError[]
  ) {
    this.consoleErrors = consoleErrors;
    page.on("response", (response) => {
      const request = response.request();
      // Only top-level documents, never images, API calls, or iframe responses.
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame())
        return;
      if (response.status() >= 300 && response.status() < 400) return;
      const redirectChain: string[] = [];
      for (let hop: Request | null = request; hop; hop = hop.redirectedFrom()) {
        redirectChain.unshift(hop.url());
      }
      this.documentResponse = { url: response.url(), status: response.status() };
      this.navigation = {
        requestedUrl: redirectChain[0] ?? response.url(),
        finalUrl: response.url(),
        completed: true,
        redirected: redirectChain.length > 1,
        responseStatus: response.status(),
        redirectChain
      };
    });
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
    this.navigation = null;
    this.documentResponse = null;
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      this.navigation = {
        ...this.navigationEvidence(),
        requestedUrl: url,
        completed: true,
        redirected: url !== this.page.url()
      };
    } catch (error) {
      this.navigation = null;
      this.documentResponse = null;
      throw error;
    }
  }

  async navigate(url: string): Promise<void> {
    await this.goto(url);
  }

  async click(selector: string): Promise<void> {
    const before = this.page.url();
    await this.page.locator(selector).click();
    if (this.page.url() !== before && this.navigation?.finalUrl !== this.page.url()) {
      // A same-document SPA click has no new HTTP response.
      this.navigation = {
        requestedUrl: this.page.url(),
        finalUrl: this.page.url(),
        completed: true,
        redirected: false,
        responseStatus: null,
        redirectChain: []
      };
    }
  }

  async type(selector: string, value: string): Promise<void> {
    const control = this.page.locator(selector);
    const isSelect = await control.evaluate((element) => element.tagName === "SELECT");
    if (isSelect) {
      const matches = await control
        .locator("option")
        .evaluateAll(
          (options, label) =>
            options.filter(
              (option) =>
                option instanceof HTMLOptionElement &&
                !option.disabled &&
                option.label === label
            ).length,
          value
        );
      if (matches !== 1)
        throw new Error(
          "UNSUPPORTED_FUNCTIONAL_CONTROL: Select requires one enabled option with the exact visible label."
        );
      await control.selectOption({ label: value });
      return;
    }
    await control.fill(value);
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
    const mask = this.screenshotMasks();
    if (options.path) {
      await mkdir(dirname(options.path), { recursive: true });
      await this.page.screenshot({
        path: options.path,
        fullPage: options.fullPage ?? true,
        mask,
        maskColor: "#1c2733"
      });
      return options.path;
    }

    return await this.page.screenshot({
      fullPage: options.fullPage ?? true,
      mask,
      maskColor: "#1c2733"
    });
  }

  registerSensitiveSelector(selector: string): void {
    this.sensitiveSelectors.add(selector);
  }

  registerSensitiveValue(value: string): void {
    if (value.length > 0) {
      this.sensitiveValues.add(value);
    }
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
        viewport: this.page.viewportSize(),
        ...(this.navigation ? { navigation: this.navigationEvidence() } : {})
      },
      consoleErrors: this.consoleErrors,
      accessibility,
      elements,
      textSample,
      screenshotPath
    });
  }

  async close(): Promise<void> {
    this.sensitiveSelectors.clear();
    this.sensitiveValues.clear();
    await this.context.close();
    await this.browser.close();
  }

  private navigationEvidence(): NavigationMetadata {
    const finalUrl = this.page.url();
    const requestedUrl = this.navigation?.requestedUrl ?? finalUrl;
    return {
      requestedUrl,
      finalUrl,
      completed: true,
      redirected: requestedUrl !== finalUrl,
      // Do not carry an old document's status into a different SPA route.
      responseStatus:
        this.documentResponse &&
        withoutHash(this.documentResponse.url) === withoutHash(finalUrl)
          ? this.documentResponse.status
          : null,
      redirectChain: [...(this.navigation?.redirectChain ?? [])]
    };
  }

  private screenshotMasks() {
    return [
      ...[...this.sensitiveSelectors].map((selector) => this.page.locator(selector)),
      ...[...this.sensitiveValues].map((value) =>
        this.page.getByText(value, { exact: false })
      )
    ];
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
              select?.labels?.[0]?.textContent ??
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
        .filter(
          (heading) =>
            heading.getClientRects().length > 0 &&
            getComputedStyle(heading).visibility !== "hidden"
        )
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

function withoutHash(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.href;
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
