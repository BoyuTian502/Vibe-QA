import { fileURLToPath } from "node:url";

export { ReportStore } from "./report-store.js";
export { startDashboardServer } from "./server.js";
export {
  AgentTestRequestExecutor,
  FileTestArtifactStore,
  TestRequestValidationError,
  TestWorkflowUnavailableError,
  UserTestWorkflow,
  createUserTestWorkflow,
  validateCreateTestRequest
} from "./test-workflow.js";
export type {
  AgentTestRequestExecutorOptions,
  CreateTestRequestInput,
  TestArtifactStore,
  TestRequestExecutor,
  UserTestExecution,
  UserTestRequest,
  UserTestRequestStatus,
  UserTestWorkflowOptions
} from "./test-workflow.js";
export {
  AIBugAnalyzer,
  BugAnalysisService,
  buildBugAnalysisPrompt,
  createAnalysisClientFromEnvironment,
  createBaselineBugAnalysis,
  createBugAnalysisInput
} from "./bug-analysis.js";
export type {
  BugAnalysis,
  BugAnalysisInput,
  BugAnalysisSource,
  BugSeverity
} from "./bug-analysis.js";
export type { DashboardServer, DashboardServerOptions } from "./server.js";
export type {
  DashboardConsoleError,
  DashboardIssue,
  DashboardRun,
  DashboardRunStatus,
  DashboardRunSummary,
  DashboardScreenshot,
  DashboardStep,
  DashboardTimelineEvent
} from "./types.js";

import { startDashboardServer } from "./server.js";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? "4173");
  const dashboard = await startDashboardServer({ port });

  console.log("=================================");
  console.log(" Vibe-QA Report Dashboard");
  console.log("=================================\n");
  console.log(`Open browser:\n${dashboard.url}\n`);
  console.log(`Reading reports from:\n${dashboard.outputRoot}\n`);
  console.log(
    `Bug analysis:\n${process.env.OPENAI_API_KEY ? "OpenAI-compatible model" : "Local evidence baseline (set OPENAI_API_KEY to enable AI generation)"}\n`
  );
  console.log(
    `User test workflow:\n${process.env.OPENAI_API_KEY ? "AI planner ready" : "Set OPENAI_API_KEY to enable natural-language test creation"}\n`
  );
  console.log("Press CTRL+C to stop");

  const shutdown = async (): Promise<void> => {
    await dashboard.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
