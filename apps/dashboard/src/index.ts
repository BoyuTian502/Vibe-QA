import { fileURLToPath } from "node:url";

export { ReportStore } from "./report-store.js";
export { ALPHA_EXECUTION_POLICY, alphaExecutionPolicy } from "./alpha-policy.js";
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
  QATestMode,
  StoredTestConfiguration,
  TestArtifactStore,
  TestRequestExecutor,
  UserTestExecution,
  UserTestRequest,
  UserTestRequestStatus,
  UserTestWorkflowOptions
} from "./test-workflow.js";
export {
  ModelActionRuntime,
  ModelOutputInvalidError,
  buildActionContract
} from "./model-action-runtime.js";
export type {
  ModelActionRuntimeOptions,
  ModelOutputFailure,
  ModelOutputRecoveryDiagnostics
} from "./model-action-runtime.js";
export { RetryingBrowserController, isTransientBrowserError } from "./browser-retry.js";
export type {
  BrowserRetryEvent,
  BrowserRetryOperation,
  RetryingBrowserControllerOptions
} from "./browser-retry.js";
export {
  SecureAuthenticatedBrowserController,
  TEMPORARY_PASSWORD_PLACEHOLDER,
  TEMPORARY_USERNAME_PLACEHOLDER,
  TemporaryLoginCredentials,
  redactCredentialValues
} from "./secure-credentials.js";
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
    "User test workflow:\nFunctional, Regression, and Exploratory modes ready. No paid API required.\nExploratory uses the local Ollama model when needed.\n"
  );
  console.log("Press CTRL+C to stop");

  const shutdown = async (): Promise<void> => {
    await dashboard.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
