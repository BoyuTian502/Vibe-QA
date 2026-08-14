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
      name: "Enter test account email",
      action: {
        type: "type",
        selector: 'input[name="email"]',
        value: BENCHMARK_EMAIL
      }
    },
    {
      name: "Enter test account password",
      action: {
        type: "type",
        selector: 'input[name="password"]',
        value: BENCHMARK_PASSWORD
      }
    },
    {
      name: "Submit login",
      action: { type: "click", selector: 'button[type="submit"]' }
    },
    {
      name: "Verify authenticated dashboard",
      action: { type: "wait", ms: 600 },
      expected: {
        url: `${benchmarkUrl}/dashboard`,
        requiredText: "PRIVATE DASHBOARD"
      }
    }
  ];

  if (scenario === "login") {
    return {
      goal: "Verify the benchmark login workflow",
      startUrl: `${benchmarkUrl}/login`,
      steps: loginSteps
    };
  }

  return {
    goal: "Detect the fragile dashboard widget failure",
    startUrl: `${benchmarkUrl}/login`,
    steps: [
      ...loginSteps,
      {
        name: "Run fragile dashboard widget",
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
