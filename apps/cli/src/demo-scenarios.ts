import type { TestCase } from "@vibeqa/test-engine";

export type DemoScenarioName = "login" | "bug";

const BENCHMARK_EMAIL = "qa@example.com";
const BENCHMARK_PASSWORD = "password123";

export function createDemoScenario(
  scenario: DemoScenarioName,
  benchmarkUrl: string
): TestCase {
  const loginSteps: TestCase["steps"] = [
    {
      name: "Enter the demo email address",
      action: {
        type: "type",
        selector: 'input[name="email"]',
        value: BENCHMARK_EMAIL
      }
    },
    {
      name: "Enter the demo password securely",
      action: {
        type: "type",
        selector: 'input[name="password"]',
        value: BENCHMARK_PASSWORD
      }
    },
    {
      name: "Sign in",
      action: { type: "click", selector: 'button[type="submit"]' }
    },
    {
      name: "Confirm the private dashboard opened",
      action: { type: "wait", ms: 600 },
      expected: {
        url: `${benchmarkUrl}/dashboard`,
        requiredText: "PRIVATE DASHBOARD"
      }
    }
  ];

  if (scenario === "login") {
    return {
      goal: "Confirm that a user can sign in and reach the private dashboard",
      startUrl: `${benchmarkUrl}/login`,
      steps: loginSteps
    };
  }

  return {
    goal: "Find and document the dashboard widget failure",
    startUrl: `${benchmarkUrl}/login`,
    steps: [
      ...loginSteps,
      {
        name: "Click the fragile dashboard widget",
        action: { type: "click", selector: "#trigger-client-error" },
        expected: { requiredText: "Widget completed successfully" }
      }
    ]
  };
}

export function parseDemoScenario(value: string): DemoScenarioName {
  if (value === "login" || value === "bug") {
    return value;
  }
  throw new Error(`Unknown demo scenario: ${value}. Use login or bug.`);
}
