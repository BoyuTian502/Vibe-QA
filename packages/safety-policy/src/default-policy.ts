import type { BrowserAction, ElementInformation } from "@vibeqa/schemas";

import type {
  ActionSafetyContext,
  ActionSafetyPolicy,
  ApprovalDecision
} from "./policy.js";

export interface DefaultActionSafetyPolicyOptions {
  forbiddenPatterns?: readonly (string | RegExp)[];
  requestIdFactory?: () => string;
}

const BLOCKED_ACTION_PATTERN =
  /\b(?:delete|remove|close|destroy)\s+(?:my\s+)?(?:account|workspace|organization|organisation|tenant)\b|\b(?:delete all data|erase all|drop database|irreversible|permanent deletion)\b/i;
const RISKY_ACTION_PATTERN =
  /\b(?:delete|remove|trash|purchase|buy|checkout|pay|place order|confirm order|send|message|email|publish|post|upload|invite|create|sync)\b|\b(?:save|update|change)\b[^\n]*(?:setting|profile|account|preference)/i;
const LOGIN_PATTERN = /\b(?:log[ -]?in|sign[ -]?in|authenticate)\b/i;
const SUBMIT_PATTERN = /\bsubmit\b|type\s*=\s*["']?submit/i;
const FILE_INPUT_PATTERN = /\bfile\b|upload|type\s*=\s*["']?file/i;

export class DefaultActionSafetyPolicy implements ActionSafetyPolicy {
  private readonly forbiddenPatterns: readonly (string | RegExp)[];
  private readonly requestIdFactory: () => string;

  constructor(options: DefaultActionSafetyPolicyOptions = {}) {
    this.forbiddenPatterns = options.forbiddenPatterns ?? [];
    this.requestIdFactory = options.requestIdFactory ?? createApprovalRequestId;
  }

  evaluate(action: BrowserAction, context: ActionSafetyContext): ApprovalDecision {
    const target = describeActionTarget(action, context);
    const semanticTarget = target.replace(/[-_]+/g, " ");

    if (this.matchesForbiddenPolicy(target)) {
      return {
        decision: "block",
        reason: "The action matches an explicitly forbidden test policy."
      };
    }

    switch (action.type) {
      case "getText":
      case "getCurrentUrl":
      case "screenshot":
      case "assert":
        return {
          decision: "allow",
          reason: "The action only reads or verifies browser state."
        };
      case "wait":
        return {
          decision: "allow",
          reason: "The bounded wait has no external side effect."
        };
      case "goto":
      case "navigate":
        return {
          decision: "allow",
          reason: "Page navigation does not itself submit or mutate data."
        };
      case "type":
        if (FILE_INPUT_PATTERN.test(semanticTarget)) {
          return this.requireApproval(
            "Uploading a file can create an external side effect."
          );
        }
        return {
          decision: "allow",
          reason: "Entering text does not submit the form or persist the value."
        };
      case "click":
        return this.evaluateClick(semanticTarget);
    }
  }

  private evaluateClick(target: string): ApprovalDecision {
    if (BLOCKED_ACTION_PATTERN.test(target)) {
      return {
        decision: "block",
        reason: "The action could irreversibly delete account-level data."
      };
    }

    // Authentication is an exception for this control, not the whole run or page.
    if (
      SUBMIT_PATTERN.test(target) &&
      LOGIN_PATTERN.test(target) &&
      !RISKY_ACTION_PATTERN.test(target)
    ) {
      return {
        decision: "allow",
        reason: "Submitting the local login form is an expected authentication step."
      };
    }

    if (RISKY_ACTION_PATTERN.test(target) || SUBMIT_PATTERN.test(target)) {
      return this.requireApproval(
        "The action may change persistent state or trigger an external side effect."
      );
    }

    return {
      decision: "allow",
      reason: "No persistent or external side effect was identified."
    };
  }

  private requireApproval(reason: string): ApprovalDecision {
    return {
      decision: "require_approval",
      reason,
      requestId: this.requestIdFactory()
    };
  }

  private matchesForbiddenPolicy(target: string): boolean {
    return this.forbiddenPatterns.some((pattern) => {
      if (typeof pattern === "string") {
        return target.toLowerCase().includes(pattern.toLowerCase());
      }

      pattern.lastIndex = 0;
      return pattern.test(target);
    });
  }
}

function describeActionTarget(
  action: BrowserAction,
  context: ActionSafetyContext
): string {
  const parts: string[] = [action.type];

  if ("selector" in action) {
    parts.push(action.selector);
    const element = findElement(action.selector, context.observation?.elements ?? []);
    if (element) {
      parts.push(
        element.tagName,
        element.role ?? "",
        element.accessibleName ?? "",
        element.text
      );
    }
  } else if ("url" in action) {
    parts.push(action.url);
  }

  return parts.filter(Boolean).join(" ");
}

function findElement(
  selector: string,
  elements: readonly ElementInformation[]
): ElementInformation | undefined {
  const exact = elements.find((element) => element.selector === selector);
  if (exact) return exact;
  // Existing structured login tests use a generic submit selector. Its target is
  // unambiguous only when the live observation contains a single visible button.
  if (/^button\[type=(?:"submit"|'submit'|submit)\]$/i.test(selector)) {
    const buttons = elements.filter(
      (element) => element.tagName === "button" && element.visible && element.enabled
    );
    if (buttons.length === 1) return buttons[0];
  }
  return undefined;
}

function createApprovalRequestId(): string {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `approval-${Date.now().toString(36)}-${randomPart}`;
}
