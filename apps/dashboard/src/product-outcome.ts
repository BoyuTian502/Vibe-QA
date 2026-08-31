// Presentation only: interpret existing evidence without changing evaluation.
export type ProductOutcomeKind =
  | "PASSED"
  | "TARGET_ISSUE"
  | "TEST_ASSERTION_FAILURE"
  | "SAFETY_BLOCKED"
  | "APPROVAL_REQUIRED"
  | "UNSUPPORTED_OBJECTIVE"
  | "AGENT_ERROR"
  | "MODEL_ERROR"
  | "BROWSER_ERROR"
  | "INFRASTRUCTURE_ERROR"
  | "UNKNOWN";

export interface ProductOutcome {
  kind: ProductOutcomeKind;
  label: string;
  summary: string;
  tone: "success" | "issue" | "attention";
}

interface OutcomeEvidence {
  status: string;
  errors?: readonly string[];
  bugReports?: ReadonlyArray<{ category?: string }>;
  trace?: {
    steps: ReadonlyArray<{
      safetyDecision?: string | null;
      approvalStatus?: string | null;
      result?: { error?: string | null };
    }>;
  };
  execution?: { terminationReason?: string };
}

const copy: Record<ProductOutcomeKind, [string, string]> = {
  PASSED: [
    "Passed",
    "The recorded checks passed. This is not a guarantee that the website has no bugs."
  ],
  TARGET_ISSUE: [
    "Issue found",
    "A page or console error was captured on the target website. Review the evidence before confirming a bug."
  ],
  TEST_ASSERTION_FAILURE: [
    "Expected result not met",
    "The page did not match a test expectation. Check the expectation and evidence before treating this as a website bug."
  ],
  SAFETY_BLOCKED: [
    "Blocked by safety",
    "The requested action was not permitted. It was not executed; this is not a website bug."
  ],
  APPROVAL_REQUIRED: [
    "Approval required",
    "The sensitive action was not executed. This Alpha dashboard ends the run safely and closes the browser; approval and resume are available only through the existing developer API."
  ],
  UNSUPPORTED_OBJECTIVE: [
    "Unsupported objective",
    "This objective or control is outside the supported local workflow. Use explicit supported steps or the structured test API."
  ],
  AGENT_ERROR: [
    "Agent execution error",
    "Vibe-QA could not finish the objective. This execution failure is not evidence of a website bug."
  ],
  MODEL_ERROR: [
    "Model execution error",
    "The local model was unavailable or returned an unusable decision. The objective was not confirmed; this is not a website bug."
  ],
  BROWSER_ERROR: [
    "Browser execution error",
    "The browser could not complete an operation. Check page readiness, the target, and connectivity before attributing this to the website."
  ],
  INFRASTRUCTURE_ERROR: [
    "Local setup error",
    "A local service, browser installation, or evidence-storage operation failed. This is not a website bug."
  ],
  UNKNOWN: [
    "Outcome unavailable",
    "This artifact does not contain a recognized final outcome."
  ]
};

export function classifyProductOutcome(input: OutcomeEvidence): ProductOutcome {
  const steps = input.trace?.steps ?? [];
  const errors = [
    ...(input.errors ?? []),
    ...steps.flatMap((step) => (step.result?.error ? [step.result.error] : []))
  ];
  const has = (pattern: RegExp) => errors.some((error) => pattern.test(error));
  let kind: ProductOutcomeKind;
  if (
    steps.some(
      (step) => step.safetyDecision === "block" || step.approvalStatus === "denied"
    ) ||
    has(/^Action (?:blocked by safety policy|denied by human approval)/i)
  )
    kind = "SAFETY_BLOCKED";
  else if (
    steps.some((step) => step.approvalStatus === "pending") ||
    input.execution?.terminationReason === "approval-required" ||
    has(/^Action is awaiting human approval/i)
  )
    kind = "APPROVAL_REQUIRED";
  // Earlier recoverable trace errors do not override a successful final result.
  else if (input.status === "passed") kind = "PASSED";
  else if (
    has(
      /^(?:UNSUPPORTED_FUNCTIONAL_|Unsupported deterministic|The Functional plan|A login objective|The local login check|A local navigation check|Navigation target)/i
    )
  )
    kind = "UNSUPPORTED_OBJECTIVE";
  else if (
    has(
      /(?:browserType\.launch|Executable doesn't exist|EACCES|EPERM|ENOSPC|EADDRINUSE|ENOENT.*(?:open|mkdir)|Test execution is not configured)/i
    )
  )
    kind = "INFRASTRUCTURE_ERROR";
  else if (
    has(
      /^(?:Local exploration model|Ollama |STALE_ELEMENT_RECOVERY_FAILED|Unexpected token.*JSON|Unexpected end of JSON|Expected .*JSON|.*not valid JSON)|"code":\s*"invalid_(?:union|type)"/i
    )
  )
    kind = "MODEL_ERROR";
  else if (
    has(
      /(?:page\.(?:goto|screenshot)|locator\.|net::ERR_|Target page, context or browser has been closed|The page remained empty or loading)/i
    )
  )
    kind = "BROWSER_ERROR";
  else if (
    input.execution?.terminationReason === "agent-error" ||
    input.execution?.terminationReason === "null-retry-exhausted" ||
    has(/^Exploration stopped without confirming/)
  )
    kind = "AGENT_ERROR";
  else if (input.bugReports?.some((bug) => bug.category === "console"))
    kind = "TARGET_ISSUE";
  else if (
    input.bugReports?.some(
      (bug) => bug.category === "content" || bug.category === "navigation"
    ) ||
    has(/^(?:Required text was not found|Expected URL|Expected the URL)/)
  )
    kind = "TEST_ASSERTION_FAILURE";
  else kind = input.status === "failed" ? "AGENT_ERROR" : "UNKNOWN";
  const [label, summary] = copy[kind];
  return {
    kind,
    label,
    summary,
    tone: kind === "PASSED" ? "success" : isWebsiteFinding(kind) ? "issue" : "attention"
  };
}

export function isWebsiteFinding(kind: ProductOutcomeKind): boolean {
  return kind === "TARGET_ISSUE" || kind === "TEST_ASSERTION_FAILURE";
}
