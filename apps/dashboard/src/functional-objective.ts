import type { TestCase, TestResult } from "@vibeqa/test-engine";

const NAVIGATION = /\b(?:navigate|visit|go to|open|follow)\b|导航|跳转|打开|前往/giu;
const CLICK = /\b(?:click|press|tap)\b|点击/giu;
const LOGIN = /\b(?:log[ -]?in|sign[ -]?in|authenticate|authenticated)\b|登录/iu;
const FORM = /\b(?:submit|fill|type|enter|send)\b|提交|填写|输入|发送/iu;
const OTHER_ACTION =
  /\b(?:add|create|delete|remove|buy|purchase|checkout|upload|download|save|edit|update|search|filter|sort|select|choose|toggle|hover|scroll|reset|register|subscribe|logout|log out|sign out|change)\b|创建|删除|购买|上传|下载|保存|编辑|搜索|筛选|退出|修改/iu;
const TEXT_CHECK =
  /^(?:verify|check|ensure|confirm|test|read)(?: that)? (?:the )?(?:homepage|page|website|site|dashboard|(?:expected )?(?:visible )?(?:page )?(?:text|content))(?: (?:text|content|loads?(?: successfully)?|opens?(?: successfully)?|(?:is|remains) (?:visible|available)|(?:displays?|shows?|contains?) (?:its |the )?(?:main )?(?:content|text)))?(?: and (?:displays?|shows?) (?:its |the )?(?:main )?(?:content|text))?[.!?]?$|^(?:验证|检查|确认)(?:首页|页面|网站)(?:正常|成功)?(?:加载|显示)(?:成功|正常|内容|文本)?[。.!?]?$/iu;
const NAVIGATION_COMMAND =
  /^(?:please )?(?:navigate|visit|go to|open|follow|click|press|tap)\b|^(?:导航|跳转|打开|前往|点击)/iu;
const UNSUPPORTED =
  "Unsupported deterministic Functional objective. Use a page-text check, temporary login, or one navigation target; use a structured TestCase for other workflows.";

function intent(objective: string) {
  objective = objective.replace(/\s+/gu, " ").trim();
  return {
    navigation: [...objective.matchAll(NAVIGATION)].length,
    click: [...objective.matchAll(CLICK)].length,
    login: LOGIN.test(objective),
    form: FORM.test(objective),
    other: OTHER_ACTION.test(objective)
  };
}

export function localFunctionalKind(
  objective: string,
  hasCredentials: boolean
): "text" | "login" | "navigation" {
  objective = objective.replace(/\s+/gu, " ").trim();
  const action = intent(objective);
  if (action.other || action.navigation + action.click > 1)
    throw new Error(UNSUPPORTED);
  if (
    /\b(?:and|then)\s+(?!(?:verify|check|ensure|confirm|displays?|shows?|contains?|loads?)\b)/iu.test(
      objective
    )
  ) {
    throw new Error(UNSUPPORTED);
  }
  if (action.navigation || action.click) {
    if (
      action.login ||
      action.form ||
      hasCredentials ||
      !NAVIGATION_COMMAND.test(objective)
    )
      throw new Error(UNSUPPORTED);
    return "navigation";
  }
  if (action.login) {
    if (!hasCredentials) {
      throw new Error(
        "A login objective requires temporary credentials or a structured login TestCase."
      );
    }
    return "login";
  }
  if (action.form || !TEXT_CHECK.test(objective.replace(/\s+/gu, " ")))
    throw new Error(UNSUPPORTED);
  return hasCredentials ? "login" : "text";
}

// This is an action-consistency check, not a semantic judge of arbitrary prose.
export function assertFunctionalPlan(objective: string, testCase: TestCase): void {
  const action = intent(objective);
  const finalVerification = testCase.steps
    .map((step) => step.action.type === "assert" || step.expected !== undefined)
    .lastIndexOf(true);
  const actions = testCase.steps
    .slice(0, finalVerification + 1)
    .map((step) => step.action);
  const interaction = actions.some((step) =>
    ["navigate", "goto", "click"].includes(step.type)
  );
  const inputIndex = actions.findIndex((step) => step.type === "type");
  const submit =
    inputIndex >= 0 &&
    actions.slice(inputIndex + 1).some((step) => step.type === "click");
  if (
    finalVerification < 0 ||
    (action.navigation + action.click > 0 && !interaction) ||
    ((action.form || action.login) && !submit) ||
    (action.other && !interaction)
  ) {
    throw new Error(
      "The Functional plan does not execute the requested interaction before its final verification. Use a structured TestCase for unsupported workflows."
    );
  }
}

export function checkFunctionalNavigationResult(
  objective: string,
  result: TestResult
): void {
  if (!intent(objective).navigation || result.status !== "passed") return;
  const actions = result.trace.steps.filter((step) => step.action !== null);
  const changed = result.executedSteps.some((step, index) => {
    const before = actions[index]?.observation?.url;
    return (
      step.status === "passed" &&
      ["navigate", "goto", "click"].includes(step.action.type) &&
      before &&
      step.observation &&
      before !== step.observation.url
    );
  });
  if (changed) return;
  const message =
    "The navigation objective did not produce a verified URL change. Page text alone cannot satisfy this objective; use a structured TestCase for same-URL interactions.";
  result.status = "failed";
  result.errors.push(message);
  result.bugReports.push({
    title: "Functional objective was not satisfied",
    description: message,
    category: "evaluation",
    stepIndex: -1,
    stepName: "Objective consistency",
    evidence: {
      url: result.executedSteps.at(-1)?.observation?.url ?? null,
      consoleErrors: [],
      screenshot: null
    }
  });
}
