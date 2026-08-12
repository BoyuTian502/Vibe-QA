import type { AgentTrace, EvaluationResult } from "@vibeqa/agent-core";
import type { BrowserAction, ConsoleError, Observation } from "@vibeqa/schemas";

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

export type TestStatus = "passed" | "failed";

export interface ExecutedTestStep {
  index: number;
  name: string;
  action: BrowserAction;
  observation: Observation | null;
  status: TestStatus;
  evaluatorFeedback: EvaluationResult | null;
  errors: string[];
}

export interface BugReport {
  title: string;
  description: string;
  stepIndex: number;
  stepName: string;
  category: "action" | "navigation" | "content" | "console" | "evaluation";
  evidence: {
    url: string | null;
    consoleErrors: ConsoleError[];
    screenshot: string | null;
  };
}

export interface TestResult {
  goal: string;
  status: TestStatus;
  executedSteps: ExecutedTestStep[];
  screenshots: string[];
  errors: string[];
  bugReports: BugReport[];
  trace: AgentTrace;
}
