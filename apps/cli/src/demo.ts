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
  console.log("[1] Preparing the sample website...");

  const demo = await runTechnicalDemo({
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
  console.log("\n[5] Closing the demo...");
  console.log(
    demo.cleanup.browserClosed && demo.cleanup.benchmarkClosed
      ? "    [OK] Browser and sample website closed cleanly"
      : "    [WARNING] Some demo resources may still be running"
  );
} catch (error) {
  console.error(`\nThe demo could not finish: ${errorMessage(error)}`);
  console.error(
    "Please check that a supported Chrome or Chromium browser is installed."
  );
  process.exitCode = 1;
}

function printHeader(): void {
  console.log("--------------------------------------------------");
  console.log("Vibe-QA Technical Demo");
  console.log("--------------------------------------------------");
  console.log("Watch Vibe-QA test a sample website in a real browser.\n");
}

function printEvent(event: DemoEvent): void {
  switch (event.type) {
    case "benchmark-ready":
      console.log("    [OK] Sample website is ready");
      console.log(`\nWebsite under test:\n${event.url}\n`);
      console.log("[2] Opening a browser you can watch...");
      return;
    case "browser-ready":
      console.log("    [OK] Browser opened\n");
      return;
    case "test-started":
      console.log(`What Vibe-QA will check:\n${event.goal}\n`);
      console.log("[3] Testing the website step by step...");
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
  console.log(`    ${setupSucceeded ? "[OK]" : "[FAIL]"} Open the sign-in page`);
  for (const step of result.executedSteps) {
    console.log(`    ${step.status === "passed" ? "[OK]" : "[ISSUE]"} ${step.name}`);
  }

  console.log("\n[4] Reviewing what happened...");
  const consoleBugs = result.bugReports.filter((bug) => bug.category === "console");
  console.log(
    consoleBugs.length > 0
      ? `    [ISSUE] The page reported ${consoleBugs.length} JavaScript error(s)`
      : "    [OK] The page reported no unexpected JavaScript errors"
  );

  console.log("\n--------------------------------------------------");
  console.log(
    result.status === "failed"
      ? "WEBSITE TEST RESULT: ISSUE FOUND"
      : "WEBSITE TEST RESULT: PASSED"
  );
  console.log("--------------------------------------------------\n");

  if (result.status === "failed") {
    printBug(primaryBug(result.bugReports));
  } else {
    console.log("Vibe-QA completed the selected journey without finding a problem.\n");
  }

  console.log("Saved evidence:");
  console.log(`- ${result.screenshots.length} screenshot(s)`);
  const screenshot = primaryBug(result.bugReports)?.evidence.screenshot;
  if (screenshot) {
    console.log(`- issue screenshot: ${screenshot}`);
  }
  console.log(`- test report: ${reportPath}`);
  console.log(`- step-by-step agent trace: ${tracePath}`);
  console.log(`\nAll demo files:\n${outputDirectory}`);
  console.log("\n--------------------------------------------------");
}

function printBug(bug: BugReport | null): void {
  if (!bug) {
    console.log(
      "Vibe-QA detected a failure, but no detailed issue report was generated.\n"
    );
    return;
  }

  console.log(`Issue found:\n${friendlyBugTitle(bug)}\n`);
  console.log("What should have happened:");
  console.log("The dashboard action completes without a browser error.\n");
  console.log("What actually happened:");
  console.log(`${bug.description}\n`);
  if (bug.evidence.consoleErrors.length > 0) {
    console.log("Error reported by the page:");
    for (const consoleError of bug.evidence.consoleErrors) {
      console.log(`- ${consoleError.type}: ${consoleError.text}`);
    }
    console.log();
  }
}

function friendlyBugTitle(bug: BugReport): string {
  return bug.category === "console"
    ? `The page reported an error during: ${bug.stepName}`
    : bug.title;
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
