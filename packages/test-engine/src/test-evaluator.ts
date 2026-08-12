import type { AgentTraceStep } from "@vibeqa/agent-core";
import type { Observation } from "@vibeqa/schemas";

import type { BugReport, TestStep } from "./types.js";

export interface TestStepEvaluation {
  success: boolean;
  errors: string[];
  bugReports: BugReport[];
}

export class TestEvaluator {
  evaluate(
    step: TestStep,
    stepIndex: number,
    actionTrace: AgentTraceStep | null,
    previousObservation: Observation | null,
    newObservation: Observation | null
  ): TestStepEvaluation {
    const findings: Array<{
      category: BugReport["category"];
      message: string;
    }> = [];

    if (!actionTrace?.result.success) {
      findings.push({
        category: "action",
        message: actionTrace?.result.error ?? "Browser action was not executed."
      });
    }

    if (actionTrace?.evaluation && !actionTrace.evaluation.success) {
      findings.push({
        category: "evaluation",
        message: actionTrace.evaluation.reason
      });
    }

    if (!newObservation && actionTrace?.result.success) {
      findings.push({
        category: "action",
        message: "No observation was captured after the action."
      });
    }

    if (step.expected?.url && newObservation) {
      if (normalizeUrl(newObservation.url) !== normalizeUrl(step.expected.url)) {
        findings.push({
          category: "navigation",
          message: `Expected URL ${step.expected.url} but reached ${newObservation.url}.`
        });
      }
    }

    if (
      step.expected?.urlChanged !== undefined &&
      previousObservation &&
      newObservation
    ) {
      const changed =
        normalizeUrl(previousObservation.url) !== normalizeUrl(newObservation.url);
      if (changed !== step.expected.urlChanged) {
        findings.push({
          category: "navigation",
          message: step.expected.urlChanged
            ? `Expected the URL to change from ${previousObservation.url}.`
            : `Expected the URL to remain ${previousObservation.url} but reached ${newObservation.url}.`
        });
      }
    }

    if (
      step.expected?.requiredText &&
      newObservation &&
      !newObservation.textSample.includes(step.expected.requiredText)
    ) {
      findings.push({
        category: "content",
        message: `Required text was not found: ${step.expected.requiredText}`
      });
    }

    if (step.expected?.allowConsoleErrors !== true && newObservation) {
      for (const consoleError of newObservation.consoleErrors) {
        findings.push({
          category: "console",
          message: `${consoleError.type}: ${consoleError.text}`
        });
      }
    }

    return {
      success: findings.length === 0,
      errors: findings.map((finding) => finding.message),
      bugReports: findings.map((finding) =>
        createBugReport(finding, step, stepIndex, newObservation)
      )
    };
  }
}

function createBugReport(
  finding: { category: BugReport["category"]; message: string },
  step: TestStep,
  stepIndex: number,
  observation: Observation | null
): BugReport {
  return {
    title: `${finding.category} failure in ${step.name}`,
    description: finding.message,
    stepIndex,
    stepName: step.name,
    category: finding.category,
    evidence: {
      url: observation?.url ?? null,
      consoleErrors: observation?.consoleErrors ?? [],
      screenshot: observation?.screenshotPath ?? null
    }
  };
}

function normalizeUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
