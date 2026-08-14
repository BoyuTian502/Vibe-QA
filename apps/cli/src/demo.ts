#!/usr/bin/env node
import { createInterface } from "node:readline";

import { Command } from "commander";
import type { BugReport, TestResult } from "@vibeqa/test-engine";

import { runTechnicalDemo, type DemoEvent } from "./demo-runner.js";
import { parseDemoScenario } from "./demo-scenarios.js";

const program = new Command();

program
  .name("vibeqa-demo")
  .description("Run the local Vibe-QA browser testing technical demo.")
  .option("--scenario <name>", "Demo scenario: login or bug", "bug")
  .option("--keep-open", "Keep the browser open until Enter is pressed", false)
  .parse();

const options = program.opts<{ scenario: string; keepOpen: boolean }>();

try {
  const scenario = parseDemoScenario(options.scenario);
  printHeader();
  console.log("[1] Starting benchmark application...");

  await runTechnicalDemo({
    scenario,
    keepOpen: options.keepOpen,
    onEvent: printEvent,
    onResult: (result) => {
      printResult(
        result.result,
        result.reportPath,
        result.tracePath,
        result.outputDirectory
      );
    },
    waitForKeepOpen: waitForEnter
  });
} catch (error) {
  console.error(`\nDemo failed: ${errorMessage(error)}`);
  process.exitCode = 1;
}

function printHeader(): void {
  console.log("--------------------------------------------------");
  console.log("Vibe-QA Technical Demo");
  console.log("--------------------------------------------------\n");
}

function printEvent(event: DemoEvent): void {
  switch (event.type) {
    case "benchmark-ready":
      console.log("    [OK] ready");
      console.log(`\nBenchmark:\n${event.url}\n`);
      console.log("[2] Launching visible browser...");
      return;
    case "browser-ready":
      console.log("    [OK] Chromium launched\n");
      return;
    case "test-started":
      console.log(`Goal:\n${event.goal}\n`);
      console.log("[3] Running test...");
      return;
    case "evidence-saved":
      return;
  }
}

function printResult(
  result: TestResult,
  reportPath: string,
  tracePath: string,
  outputDirectory: string
): void {
  const setupSucceeded = result.executedSteps.length > 0;
  console.log(`    ${setupSucceeded ? "[OK]" : "[FAIL]"} Navigate to login`);
  for (const step of result.executedSteps) {
    console.log(`    ${step.status === "passed" ? "[OK]" : "[FAIL]"} ${step.name}`);
  }

  console.log("\n[4] Evaluating evidence...");
  const consoleBugs = result.bugReports.filter((bug) => bug.category === "console");
  console.log(
    consoleBugs.length > 0
      ? `    [DETECTED] ${consoleBugs.length} console/page error(s) captured`
      : "    [OK] no unexpected console/page errors"
  );

  console.log("\n--------------------------------------------------");
  console.log(`TEST RESULT: ${result.status.toUpperCase()}`);
  console.log("--------------------------------------------------\n");

  if (result.status === "failed") {
    printBug(primaryBug(result.bugReports), tracePath);
  } else {
    console.log("No bug detected in the selected functional scenario.\n");
  }

  console.log("Evidence:");
  for (const screenshot of result.screenshots) {
    console.log(`- screenshot: ${screenshot}`);
  }
  console.log(`- report: ${reportPath}`);
  console.log(`- trace: ${tracePath}`);
  console.log(`\nOutput directory:\n${outputDirectory}`);
  console.log("\n--------------------------------------------------");
}

function printBug(bug: BugReport | null, tracePath: string): void {
  if (!bug) {
    console.log("Bug detected, but no structured BugReport was generated.\n");
    return;
  }

  console.log(`Bug detected:\n${bug.title}\n`);
  console.log("Expected:");
  console.log("The dashboard action completes without a browser error.\n");
  console.log("Actual:");
  console.log(`${bug.description}\n`);
  if (bug.evidence.consoleErrors.length > 0) {
    console.log("Console/page error:");
    for (const consoleError of bug.evidence.consoleErrors) {
      console.log(`- ${consoleError.type}: ${consoleError.text}`);
    }
    console.log();
  }
  if (bug.evidence.screenshot) {
    console.log(`Screenshot:\n${bug.evidence.screenshot}\n`);
  }
  console.log(`Trace:\n${tracePath}\n`);
}

function primaryBug(bugs: BugReport[]): BugReport | null {
  return bugs.find((bug) => bug.category === "console") ?? bugs[0] ?? null;
}

async function waitForEnter(): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    readline.once("line", finish);
    readline.once("SIGINT", finish);
    process.stdout.write("\nPress Enter to close the browser...");
  });
  readline.close();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown demo error";
}
