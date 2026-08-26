import type { BenchmarkScenario } from "@vibeqa/evaluation";
import type { BugReport, TestCase, TestStep } from "@vibeqa/test-engine";

export interface ExpectedFailureSignature {
  stepName: string;
  category: BugReport["category"];
  descriptionIncludes: string;
}

export interface ExecutableBenchmarkScenario extends BenchmarkScenario {
  testCase: TestCase | null;
  expectedFailureSignature?: ExpectedFailureSignature;
}

const BENCHMARK_EMAIL = "qa@example.com";
const BENCHMARK_PASSWORD = "password123";

export function createBenchmarkScenarios(
  benchmarkUrl: string
): ExecutableBenchmarkScenario[] {
  const loginSteps = createLoginSteps(benchmarkUrl);
  return [
    {
      id: "login",
      name: "Successful Login Workflow",
      mode: "functional",
      difficulty: "easy",
      startUrl: `${benchmarkUrl}/login`,
      objective: "Verify that the benchmark account can sign in successfully",
      expectedOutcome: "The browser reaches the private dashboard after login.",
      expectedBugId: null,
      maxSteps: loginSteps.length + 1,
      credentialsRequirement: "benchmark-account",
      successCriteria: { type: "test_passed" },
      testCase: {
        goal: "Verify that the benchmark account can sign in successfully",
        startUrl: `${benchmarkUrl}/login`,
        steps: loginSteps
      }
    },
    {
      id: "authenticated-dashboard",
      name: "Authenticated Dashboard Access",
      mode: "functional",
      difficulty: "medium",
      startUrl: `${benchmarkUrl}/login`,
      objective: "Verify authenticated access to private dashboard content",
      expectedOutcome: "Private dashboard content and seeded projects are visible.",
      expectedBugId: null,
      maxSteps: loginSteps.length + 2,
      credentialsRequirement: "benchmark-account",
      successCriteria: { type: "test_passed" },
      testCase: {
        goal: "Verify authenticated access to private dashboard content",
        startUrl: `${benchmarkUrl}/login`,
        steps: [
          ...loginSteps,
          {
            name: "Confirm seeded project content",
            action: { type: "getText", selector: "#project-list" },
            expected: { requiredText: "Launch checklist" }
          }
        ]
      }
    },
    {
      id: "project-detail-navigation",
      name: "Project Detail Navigation",
      mode: "functional",
      difficulty: "medium",
      startUrl: `${benchmarkUrl}/login`,
      objective: "Verify navigation from the dashboard to a seeded project",
      expectedOutcome: "The seeded project detail page opens with its workflow data.",
      expectedBugId: null,
      maxSteps: loginSteps.length + 3,
      credentialsRequirement: "benchmark-account",
      successCriteria: { type: "test_passed" },
      testCase: {
        goal: "Verify navigation from the dashboard to a seeded project",
        startUrl: `${benchmarkUrl}/login`,
        steps: [
          ...loginSteps,
          {
            name: "Open the launch checklist project",
            action: { type: "click", selector: 'a[href="/projects/proj-alpha"]' }
          },
          {
            name: "Confirm project details",
            action: { type: "wait", ms: 100 },
            expected: {
              url: `${benchmarkUrl}/projects/proj-alpha`,
              requiredText: "Launch checklist"
            }
          }
        ]
      }
    },
    {
      id: "invalid-login",
      name: "Invalid Login Rejection",
      mode: "functional",
      difficulty: "medium",
      startUrl: `${benchmarkUrl}/login`,
      objective: "Verify that invalid credentials do not grant dashboard access",
      expectedOutcome: "The login page rejects the invalid sign-in attempt.",
      expectedBugId: null,
      maxSteps: 4,
      credentialsRequirement: "none",
      successCriteria: { type: "test_passed" },
      testCase: {
        goal: "Verify that invalid credentials do not grant dashboard access",
        startUrl: `${benchmarkUrl}/login`,
        steps: [
          {
            name: "Enter an unknown email",
            action: {
              type: "type",
              selector: 'input[name="email"]',
              value: "unknown@example.invalid"
            }
          },
          {
            name: "Enter an invalid password",
            action: {
              type: "type",
              selector: 'input[name="password"]',
              value: "invalid-password"
            }
          },
          {
            name: "Submit invalid login",
            action: { type: "click", selector: 'button[type="submit"]' }
          },
          {
            name: "Confirm access is rejected",
            action: { type: "wait", ms: 100 },
            expected: {
              url: `${benchmarkUrl}/login`,
              requiredText: "Invalid benchmark credentials."
            }
          }
        ]
      }
    },
    {
      id: "bug-widget-crash",
      name: "Seeded Fragile Widget Failure",
      mode: "functional",
      difficulty: "medium",
      startUrl: `${benchmarkUrl}/login`,
      objective: "Find and document the dashboard widget failure",
      expectedOutcome: "Vibe-QA detects the seeded uncaught JavaScript exception.",
      expectedBugId: "BUG-BENCH-005",
      maxSteps: loginSteps.length + 2,
      credentialsRequirement: "benchmark-account",
      successCriteria: {
        type: "seeded_bug_detected",
        bugId: "BUG-BENCH-005"
      },
      expectedFailureSignature: {
        stepName: "Run the fragile dashboard widget",
        category: "console",
        descriptionIncludes: "BUG-BENCH-005"
      },
      testCase: {
        goal: "Find and document the dashboard widget failure",
        startUrl: `${benchmarkUrl}/login`,
        steps: [
          ...loginSteps,
          {
            name: "Run the fragile dashboard widget",
            action: { type: "click", selector: "#trigger-client-error" },
            expected: { requiredText: "Widget completed successfully" }
          }
        ]
      }
    },
    {
      id: "settings-navigation",
      name: "Settings Navigation Regression",
      mode: "regression",
      difficulty: "medium",
      startUrl: `${benchmarkUrl}/login`,
      objective: "Verify that authenticated navigation to settings still works",
      expectedOutcome: "The settings page opens with workspace settings content.",
      expectedBugId: null,
      maxSteps: loginSteps.length + 3,
      credentialsRequirement: "benchmark-account",
      successCriteria: { type: "test_passed" },
      testCase: {
        goal: "Verify that authenticated navigation to settings still works",
        startUrl: `${benchmarkUrl}/login`,
        steps: [
          ...loginSteps,
          {
            name: "Open settings",
            action: { type: "click", selector: 'a[href="/settings"]' }
          },
          {
            name: "Confirm settings page",
            action: { type: "wait", ms: 100 },
            expected: {
              url: `${benchmarkUrl}/settings`,
              requiredText: "WORKSPACE SETTINGS"
            }
          }
        ]
      }
    },
    {
      id: "logout-session-leak",
      name: "Post-Logout Session Protection",
      mode: "regression",
      difficulty: "medium",
      startUrl: `${benchmarkUrl}/login`,
      objective: "Verify that private dashboard content is protected after logout",
      expectedOutcome: "Vibe-QA detects private dashboard access after logout.",
      expectedBugId: "BUG-BENCH-002",
      maxSteps: loginSteps.length + 4,
      credentialsRequirement: "benchmark-account",
      successCriteria: {
        type: "seeded_bug_detected",
        bugId: "BUG-BENCH-002"
      },
      expectedFailureSignature: {
        stepName: "Attempt private dashboard access after logout",
        category: "navigation",
        descriptionIncludes: "Expected URL"
      },
      testCase: {
        goal: "Verify that private dashboard content is protected after logout",
        startUrl: `${benchmarkUrl}/login`,
        steps: [
          ...loginSteps,
          {
            name: "Log out of the workspace",
            action: { type: "click", selector: "#logout-button" }
          },
          {
            name: "Confirm the login page",
            action: { type: "wait", ms: 150 },
            expected: {
              url: `${benchmarkUrl}/login`,
              requiredText: "Sign in to Acme Growth"
            }
          },
          {
            name: "Attempt private dashboard access after logout",
            action: { type: "navigate", url: `${benchmarkUrl}/dashboard` },
            expected: {
              url: `${benchmarkUrl}/login`,
              requiredText: "Sign in to Acme Growth"
            }
          }
        ]
      }
    },
    {
      id: "dashboard-exploration",
      name: "Authenticated Dashboard Exploration",
      mode: "exploratory",
      difficulty: "hard",
      startUrl: `${benchmarkUrl}/settings`,
      objective: "Explore authenticated workspace navigation and interactive states",
      expectedOutcome: "Explore at least three page states and two actions.",
      expectedBugId: null,
      maxSteps: 2,
      credentialsRequirement: "benchmark-account",
      successCriteria: {
        type: "exploration_coverage",
        minUniquePageStates: 3,
        minInteractiveElements: 4,
        minCandidateActions: 2
      },
      testCase: null
    }
  ];
}

export function benchmarkCredentials(): { email: string; password: string } {
  return { email: BENCHMARK_EMAIL, password: BENCHMARK_PASSWORD };
}

function createLoginSteps(benchmarkUrl: string): TestStep[] {
  return [
    {
      name: "Enter benchmark email",
      action: {
        type: "type",
        selector: 'input[name="email"]',
        value: BENCHMARK_EMAIL
      }
    },
    {
      name: "Enter benchmark password",
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
      name: "Confirm private dashboard",
      action: { type: "wait", ms: 150 },
      expected: {
        url: `${benchmarkUrl}/dashboard`,
        requiredText: "PRIVATE DASHBOARD"
      }
    }
  ];
}
