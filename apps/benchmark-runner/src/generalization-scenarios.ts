import type { GeneralizationScenario } from "@vibeqa/evaluation";

export function createGeneralizationScenarios(
  benchmarkUrl: string
): GeneralizationScenario[] {
  const dashboardUrl = `${benchmarkUrl}/dashboard`;
  return [
    {
      id: "discover-dashboard-failure",
      name: "Autonomous Dashboard Failure Discovery",
      category: "hidden_bug",
      difficulty: "hard",
      startUrl: dashboardUrl,
      plannerGoal:
        "Explore the authenticated dashboard and report any user-visible failure during normal interaction.",
      hiddenExpectationSummary:
        "Discover the seeded client-side dashboard failure without a prescribed control or path.",
      maxSteps: 10,
      credentialsRequirement: "benchmark-account",
      evaluatorOnly: {
        expectedBugIds: ["BUG-BENCH-005"],
        bugSignals: [
          {
            bugId: "BUG-BENCH-005",
            type: "console_error",
            textIncludes: "fragile dashboard widget crashed"
          }
        ],
        hiddenTargetSelectors: ["#trigger-client-error"],
        hiddenExpectedActions: ["activate the dashboard diagnostic control"]
      }
    },
    {
      id: "discover-session-protection-failure",
      name: "Autonomous Account Protection Discovery",
      category: "hidden_bug",
      difficulty: "hard",
      startUrl: dashboardUrl,
      plannerGoal:
        "Check whether the authenticated account experience contains broken access behavior across a normal session lifecycle.",
      hiddenExpectationSummary:
        "Discover the seeded post-session private-content exposure without a prescribed navigation sequence.",
      maxSteps: 10,
      credentialsRequirement: "benchmark-account",
      evaluatorOnly: {
        expectedBugIds: ["BUG-BENCH-002"],
        bugSignals: [
          {
            bugId: "BUG-BENCH-002",
            type: "post_action_state",
            actionSelector: "#logout-button",
            disallowedInterveningActionSelectors: ["#login-submit"],
            resultingUrlPath: "/dashboard",
            resultingTextIncludes: "Private dashboard"
          }
        ],
        hiddenTargetSelectors: ["#logout-button"],
        hiddenExpectedActions: [
          "end the authenticated session",
          "attempt to revisit private content"
        ]
      }
    },
    {
      id: "ambiguous-settings",
      name: "Ambiguous Settings Goal",
      category: "ambiguous_goal",
      difficulty: "medium",
      startUrl: dashboardUrl,
      plannerGoal: "Verify that account settings can be reached and inspected.",
      hiddenExpectationSummary:
        "Reach the settings state and identify its workspace configuration content.",
      maxSteps: 6,
      credentialsRequirement: "benchmark-account",
      evaluatorOnly: {
        expectedBugIds: [],
        bugSignals: [],
        goalState: { urlPath: "/settings", textIncludes: "Workspace settings" },
        hiddenTargetSelectors: ['a[href="/settings"]'],
        hiddenExpectedActions: ["navigate from the dashboard to settings"]
      }
    },
    {
      id: "ambiguous-project-navigation",
      name: "Ambiguous Project Navigation Goal",
      category: "ambiguous_goal",
      difficulty: "medium",
      startUrl: dashboardUrl,
      plannerGoal:
        "Check whether a user can move from the workspace overview into a real project workflow.",
      hiddenExpectationSummary:
        "Reach a seeded project detail state without a prescribed project or selector.",
      maxSteps: 6,
      credentialsRequirement: "benchmark-account",
      evaluatorOnly: {
        expectedBugIds: [],
        bugSignals: [],
        goalState: { urlPath: "/projects/proj-alpha", textIncludes: "Project detail" },
        hiddenTargetSelectors: ['a[href="/projects/proj-alpha"]'],
        hiddenExpectedActions: ["open a seeded project from the workspace"]
      }
    },
    {
      id: "same-url-dashboard-state",
      name: "Same-URL Dashboard State Reasoning",
      category: "same_url_state",
      difficulty: "hard",
      startUrl: dashboardUrl,
      plannerGoal:
        "Review the dashboard's information views and confirm that recent workspace activity can be inspected.",
      hiddenExpectationSummary:
        "Distinguish a meaningful dashboard state transition that does not change the URL.",
      maxSteps: 8,
      credentialsRequirement: "benchmark-account",
      evaluatorOnly: {
        expectedBugIds: [],
        bugSignals: [],
        goalState: {
          textIncludes: "Recent workspace activity",
          requiresSameUrlStateChange: true
        },
        hiddenTargetSelectors: ["#view-activity"],
        hiddenExpectedActions: ["switch to the activity dashboard state"]
      }
    },
    {
      id: "recover-project-workflow",
      name: "Recovery from Dashboard Detours",
      category: "recovery",
      difficulty: "hard",
      startUrl: dashboardUrl,
      plannerGoal:
        "Explore the workspace and locate the release workflow represented by an existing project.",
      hiddenExpectationSummary:
        "Reach the launch workflow after any safe non-optimal interactions and avoid repeated failures.",
      maxSteps: 10,
      credentialsRequirement: "benchmark-account",
      evaluatorOnly: {
        expectedBugIds: [],
        bugSignals: [],
        goalState: {
          urlPath: "/projects/proj-alpha",
          textIncludes: "Launch checklist"
        },
        hiddenTargetSelectors: ['a[href="/projects/proj-alpha"]'],
        hiddenExpectedActions: ["recover from a detour and open the launch workflow"]
      }
    }
  ];
}
