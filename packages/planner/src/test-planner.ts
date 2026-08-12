import type { BrowserAction } from "@vibeqa/schemas";

export interface TestCase {
  goal: string;
  startUrl: string;
  steps: TestStep[];
}

export interface TestStep {
  name: string;
  action: BrowserAction;
  expected?: {
    url?: string;
    urlChanged?: boolean;
    requiredText?: string;
    allowConsoleErrors?: boolean;
  };
}

export interface TestPlanner {
  plan(request: string, startUrl: string): Promise<TestCase>;
}
