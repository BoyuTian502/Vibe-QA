# VibeQA Agent Design

## 1. Agent operating model

VibeQA follows this loop:

```text
Observe
→ Understand
→ Generate hypothesis
→ Select experiment
→ Execute
→ Observe result
→ Detect anomaly
→ Reproduce and investigate
→ Update website model
→ Continue or stop
```

The agent's purpose is not merely to finish a task.

Its purpose is to discover failures that affect realistic user goals while remaining bounded, safe, and explainable.

## 2. LangGraph workflow

```text
START
  ↓
initialize_run
  ↓
validate_policy
  ↓
prepare_browser
  ↓
authenticate
  ↓
initial_observation
  ↓
update_website_model
  ↓
generate_missions
  ↓
generate_hypotheses
  ↓
select_experiment
  ↓
execute_experiment
  ↓
collect_observation
  ↓
detect_anomalies
  ├── anomaly → investigate_bug
  │                ↓
  │          update_bug_store
  │
  └── no anomaly
          ↓
update_coverage_and_model
  ↓
evaluate_stop_conditions
  ├── continue → generate_hypotheses
  ├── approval → human_interrupt
  └── stop → generate_report
                    ↓
                   END
```

## 3. State model

```ts
export type TestMode =
  | "release_check"
  | "exploration"
  | "both";

export type RunStatus =
  | "initializing"
  | "awaiting_login"
  | "discovering"
  | "testing"
  | "investigating"
  | "reporting"
  | "completed"
  | "failed"
  | "stopped";

export interface WebsiteTestState {
  runId: string;
  projectId: string;
  status: RunStatus;
  mode: TestMode;

  baseUrl: string;
  appDescription: string;
  userGoals: TestMission[];

  auth: AuthState;
  safety: SafetyPolicy;
  budget: BudgetState;

  websiteModel: WebsiteModel;
  pageStates: Record<string, PageState>;
  discoveredWorkflows: Workflow[];
  expectedBehaviors: ExpectedBehavior[];

  hypothesisQueue: Hypothesis[];
  currentExperiment: Experiment | null;
  experimentHistory: ExperimentResult[];

  currentPageStateId: string | null;
  currentUrl: string | null;
  actionHistory: BrowserActionRecord[];

  evidenceRefs: EvidenceRef[];
  anomalyQueue: Anomaly[];
  activeInvestigation: BugInvestigation | null;
  confirmedBugs: BugReport[];
  rejectedAnomalies: Anomaly[];

  coverage: CoverageState;
  stopReason: string | null;
  finalReportRef: string | null;
  errors: RunError[];
}
```

## 4. Mission model

A mission is a high-level user goal.

```ts
export interface TestMission {
  id: string;
  goal: string;
  source: "user" | "inferred" | "regression_memory";
  priority: "critical" | "high" | "medium" | "low";
  successCriteria: string[];
  status: "pending" | "passed" | "failed" | "blocked";
}
```

Example:

```json
{
  "id": "mission_create_project",
  "goal": "Create and persist a project",
  "source": "user",
  "priority": "critical",
  "successCriteria": [
    "A project can be created",
    "The new project appears in the project list",
    "The project remains visible after refresh"
  ],
  "status": "pending"
}
```

## 5. Page-state model

```ts
export interface PageState {
  id: string;
  url: string;
  routePattern: string;
  title: string;
  semanticPurpose: string;
  fingerprint: string;

  visualState: {
    modal: string | null;
    activeTab: string | null;
    loading: boolean;
    errorBanner: string | null;
  };

  interactiveElements: ElementDescriptor[];
  entities: EntityDescriptor[];
  outgoingTransitions: Transition[];
  lastSeenAt: string;
}
```

## 6. Element model

```ts
export interface ElementDescriptor {
  id: string;
  role: string | null;
  accessibleName: string | null;
  text: string | null;
  elementType: string;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  destructive: boolean;
  riskTags: string[];
  locator: LocatorDescriptor;
}
```

The LLM selects an element by ID.

The browser worker resolves and verifies the actual locator.

## 7. Observation model

```ts
export interface Observation {
  id: string;
  timestamp: string;
  urlBefore: string;
  urlAfter: string;
  pageStateId: string;
  title: string;

  structure: {
    headings: string[];
    dialogs: string[];
    alerts: string[];
    forms: FormSummary[];
    interactiveElements: ElementDescriptor[];
  };

  effect: {
    navigationOccurred: boolean;
    domChanged: boolean;
    newEntityDetected: boolean;
    loadingDurationMs: number;
  };

  console: {
    errors: ConsoleEvent[];
    warnings: ConsoleEvent[];
  };

  network: {
    failedRequests: NetworkEvent[];
    serverErrors: NetworkEvent[];
    mutations: NetworkEvent[];
  };

  visual: {
    screenshotRef: string;
    blankPageScore: number;
    overflowCandidates: VisualIssue[];
  };

  traceRef: string;
}
```

## 8. Expected behavior model

Expected behavior must include a source and confidence.

```ts
export interface ExpectedBehavior {
  id: string;
  trigger: string;
  expectedOutcomes: string[];
  source:
    | "user"
    | "regression_flow"
    | "system_fact"
    | "ui_semantics"
    | "llm_inference";
  confidence: number;
}
```

Source priority:

1. User-defined criteria
2. Known regression flow
3. Deterministic system fact
4. Standard UI semantics
5. LLM inference

Low-confidence inferred behavior must not directly become a confirmed bug.

## 9. Hypothesis model

```ts
export type HypothesisType =
  | "happy_path"
  | "validation"
  | "persistence"
  | "idempotency"
  | "navigation"
  | "authentication"
  | "error_handling"
  | "visual_robustness";

export interface Hypothesis {
  id: string;
  type: HypothesisType;
  statement: string;
  targetFeature: string;
  preconditions: string[];
  experimentTemplate: string;

  importance: number;
  risk: number;
  failureLikelihood: number;
  novelty: number;
  coverageGain: number;
  expectedBehaviorConfidence: number;
  preconditionReadiness: number;
  safetyScore: number;
  estimatedActions: number;

  forbidden: boolean;
  destructive: boolean;
  status: "queued" | "selected" | "completed" | "blocked";
}
```

## 10. Hypothesis scoring

```ts
export function scoreHypothesis(h: Hypothesis): number {
  const bugValue =
    0.45 * h.importance +
    0.35 * h.risk +
    0.20 * h.failureLikelihood;

  const informationGain =
    0.60 * h.novelty +
    0.40 * h.coverageGain;

  const safety = h.forbidden ? 0 : h.safetyScore;
  const cost = Math.max(h.estimatedActions, 1);

  return (
    bugValue *
    informationGain *
    h.preconditionReadiness *
    safety
  ) / cost;
}
```

## 11. Experiment model

```ts
export interface Experiment {
  id: string;
  hypothesisId: string;
  goal: string;
  preconditions: ExperimentPrecondition[];
  steps: BrowserAction[];
  assertions: AssertionSpec[];
  checkpointRef: string;
  maxDurationMs: number;
}
```

Experiments should be short and restorable.

Do not allow unrestricted long chains generated by the LLM.

## 12. Browser actions

V1 allow-list:

```ts
export type BrowserAction =
  | { type: "observe" }
  | {
      type: "navigate";
      url: string;
    }
  | {
      type: "click";
      elementId: string;
      expectedEffect:
        | "navigation"
        | "open_dialog"
        | "submit"
        | "toggle"
        | "unknown";
    }
  | {
      type: "fill";
      elementId: string;
      valueRef: string;
    }
  | {
      type: "select";
      elementId: string;
      optionValue: string;
    }
  | {
      type: "upload";
      elementId: string;
      fixtureId: string;
    }
  | {
      type: "refresh";
    }
  | {
      type: "go_back";
      steps: number;
    }
  | {
      type: "assert";
      assertion: AssertionSpec;
    }
  | {
      type: "reset";
      checkpointRef: string;
    };
```

## 13. Test-data factory

The LLM should choose a test-data category, not create unrestricted payloads.

Examples:

```text
valid_short_text
empty_text
whitespace_only
long_text_256
long_text_4096
unicode_text
emoji_text
valid_email
invalid_email
safe_png_small
safe_png_large
safe_pdf
```

Security payload generation is out of scope for V1.

## 14. Deterministic anomaly rules

The rule engine should detect:

- New uncaught console error
- HTTP 500–599
- Failed core mutation
- Page crash
- Blank-page threshold exceeded
- Loading threshold exceeded
- Required entity missing after successful mutation
- Protected content still visible after logout and reload
- Browser context unexpectedly closed

Ambiguous cases are sent to semantic evaluation.

## 15. Bug investigation

Investigation steps:

1. Confirm evidence is complete.
2. Restore the pre-experiment checkpoint.
3. Re-run the exact sequence.
4. Compare outcomes.
5. Check console and network causality.
6. Measure user impact.
7. Assign confidence.
8. Classify the anomaly.

```ts
export interface BugInvestigation {
  id: string;
  anomalyId: string;
  experimentId: string;
  attempts: number;
  reproductions: number;
  evidenceStrength: number;
  expectedBehaviorConfidence: number;
  impactClarity: number;
  causalLinkStrength: number;
  status:
    | "confirmed"
    | "likely"
    | "needs_review"
    | "rejected"
    | "flaky";
}
```

Confidence calculation:

```ts
export function calculateBugConfidence(
  investigation: BugInvestigation
): number {
  const reproductionRate =
    investigation.attempts === 0
      ? 0
      : investigation.reproductions /
        investigation.attempts;

  return (
    0.30 * reproductionRate +
    0.25 * investigation.evidenceStrength +
    0.20 * investigation.expectedBehaviorConfidence +
    0.15 * investigation.impactClarity +
    0.10 * investigation.causalLinkStrength
  );
}
```

Classification:

```text
0.85–1.00: Confirmed Bug
0.65–0.84: Likely Bug
0.40–0.64: Needs Review
Below 0.40: Rejected or informational
```

## 16. Severity model

Severity and confidence are separate.

### Critical

- Application cannot be used
- Login completely fails
- Core data loss
- Major private-data exposure
- Core workflow fails for all users

### High

- Major feature fails
- Save operation fails
- Common input crashes a workflow
- User cannot continue

### Medium

- Secondary feature fails
- Validation is clearly broken
- Workaround exists

### Low

- Minor UI or messaging issue
- No meaningful task blockage

## 17. Exploration stages

### Stage 1: Orient

- Identify current page
- Confirm authenticated state
- Identify top-level navigation
- Maximum 5 actions

### Stage 2: Map core features

- Identify entities
- Identify primary workflows
- Visit high-value pages
- Maximum 15 actions

### Stage 3: Test core hypotheses

Prioritize:

- Happy path
- Persistence
- Validation
- Authentication
- Navigation
- Maximum 30 actions

### Stage 4: Targeted exploration

Only continue on:

- High-risk uncovered features
- Previously failing features
- New anomalies
- High-scoring remaining hypotheses

## 18. Stop conditions

Hard stop:

- Time exhausted
- Action budget exhausted
- LLM-call budget exhausted
- Browser unrecoverable
- Authentication unrecoverable
- User stop request
- Repeated safety violation
- Three consecutive unrecoverable errors

Smart stop:

- Critical missions are complete
- No meaningful new state or information in the last ten actions
- All remaining hypothesis scores are below threshold
- Two confirmed critical bugs are found
- Five confirmed high-severity bugs are found

## 19. Coverage

Track:

- Page-state coverage
- Feature coverage
- Workflow coverage
- Risk-weighted coverage
- Behavior-type coverage

Do not present click count as meaningful coverage.

## 20. LLM boundaries

Use the LLM for:

- Page-purpose interpretation
- Feature and workflow inference
- Mission generation
- Hypothesis generation
- Ambiguous anomaly interpretation
- Report wording

Do not use the LLM for:

- Browser execution
- Secret retrieval
- Safety authorization
- Budget enforcement
- High-confidence technical error detection
- Retry limits
- State persistence
- File access
