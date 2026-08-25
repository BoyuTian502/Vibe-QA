export type DashboardRunStatus = "passed" | "failed" | "unknown";

export interface DashboardRunSummary {
  id: string;
  goal: string;
  status: DashboardRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  stepCount: number;
  passedStepCount: number;
  issueCount: number;
  screenshotCount: number;
}

export interface DashboardStep {
  index: number;
  name: string;
  status: DashboardRunStatus;
  actionLabel: string;
  reason: string | null;
  errors: string[];
  url: string | null;
}

export interface DashboardConsoleError {
  type: string;
  text: string;
}

export interface DashboardIssue {
  title: string;
  description: string;
  category: string;
  stepName: string;
  consoleErrors: DashboardConsoleError[];
  screenshotUrl: string | null;
}

export interface DashboardTimelineEvent {
  index: number;
  timestamp: string | null;
  label: string;
  status: "passed" | "failed" | "pending";
  detail: string | null;
  error: string | null;
  safetyDecision: string | null;
  approvalStatus: string | null;
  observationTitle: string | null;
  observationUrl: string | null;
}

export interface DashboardScreenshot {
  name: string;
  relativePath: string;
  url: string;
}

export interface DashboardRun extends DashboardRunSummary {
  steps: DashboardStep[];
  timeline: DashboardTimelineEvent[];
  primaryIssue: DashboardIssue | null;
  screenshots: DashboardScreenshot[];
  errors: string[];
}
