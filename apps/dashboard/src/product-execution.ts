import type { TestResult } from "@vibeqa/test-engine";
import type { AgentTraceStep } from "@vibeqa/agent-core";
import type {
  ExplorationEvaluationResult,
  PageErrorFinding
} from "./exploration-evaluator.js";

import type { QATestMode } from "./alpha-policy.js";

// Product evidence only. Research diagnostics and handoff snapshots stay internal.
export interface ProductExecution {
  requestedMode: QATestMode;
  strategy: "deterministic" | "adaptive-v2" | "custom";
  modelInvocationCount: number;
  terminationReason: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  pagesVisited: string[];
  stateCount: number;
  actionCount: number;
  elementRecovery?: {
    failedTargets: number;
    replanAttempts: number;
    recoveredTargets: number;
  };
  escalationReason?: string | null;
  plannerDecisions?: Array<{
    phase: string;
    outcome: string;
    actionType: string | null;
  }>;
}

export interface ProductTestResult extends TestResult {
  bugReports: Array<
    TestResult["bugReports"][number] & { pageError?: PageErrorFinding }
  >;
  execution?: ProductExecution;
  trace: TestResult["trace"] & {
    execution?: ProductExecution;
    steps: Array<
      AgentTraceStep & {
        pageError?: PageErrorFinding;
        evaluation?: ExplorationEvaluationResult;
      }
    >;
  };
}
