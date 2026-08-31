import type { BrowserController } from "@vibeqa/agent-core";
import type { ElementInformation, Observation } from "@vibeqa/schemas";
import type { TestCase } from "@vibeqa/test-engine";

export type FormInstruction =
  | { kind: "fill" | "select"; label: string; value: string }
  | { kind: "choose"; label: string; group?: string; checkbox?: boolean }
  | { kind: "click"; label: string };

const PREFIX =
  "UNSUPPORTED_FUNCTIONAL_OBJECTIVE: Unsupported deterministic Functional objective";

export function parseFunctionalForm(objective: string): FormInstruction[] | null {
  const lines = objective
    .split(/\r\n|[\n\r;]/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    !lines.some((line) =>
      /^(?:enter|fill|type|select|choose)\b|^check checkbox\b|^submit(?: form)?$|^click submit$/iu.test(
        line
      )
    )
  )
    return null;
  const instructions: FormInstruction[] = [];
  for (const [index, line] of lines.entries()) {
    if (
      /^verify (?:expected visible page text|success text)$/iu.test(line) &&
      index === lines.length - 1
    )
      continue;
    const fill = /^(?:enter|fill|type) (.+?) in (.+)$/iu.exec(line);
    const select = /^select (.+?) (?:as|in|from) (.+)$/iu.exec(line);
    const choose = /^choose (.+?)(?: as (.+))?$/iu.exec(line);
    const checkbox = /^check checkbox (.+)$/iu.exec(line);
    const click = /^click (.+)$/iu.exec(line);
    const label =
      fill?.[2] ?? select?.[2] ?? choose?.[1] ?? checkbox?.[1] ?? click?.[1];
    if (fill?.[1] && label)
      instructions.push({ kind: "fill", label: token(label), value: token(fill[1]) });
    else if (select?.[1] && label)
      instructions.push({
        kind: "select",
        label: token(label),
        value: token(select[1])
      });
    else if (choose && label)
      instructions.push({
        kind: "choose",
        label: token(label),
        ...(choose[2] ? { group: token(choose[2]) } : {})
      });
    else if (checkbox && label)
      instructions.push({ kind: "choose", label: token(label), checkbox: true });
    else if (click && label) instructions.push({ kind: "click", label: token(label) });
    else if (/^submit(?: form)?$/iu.test(line))
      instructions.push({ kind: "click", label: "Submit" });
    else
      throw new Error(
        `${PREFIX} at instruction ${index + 1}. Use one explicit form command per line; no steps were dropped.`
      );
  }
  if (instructions.length === 0 || instructions.length > 20)
    throw new Error(`${PREFIX}: use 1 to 20 explicit form commands.`);
  for (const instruction of instructions) {
    if (
      /password|passwd|secret|token|api[ -]?key|credential|密码|密钥/iu.test(
        instruction.label
      )
    ) {
      throw new Error(
        `${PREFIX}: secret fields must use the temporary-login workflow, not literal form instructions.`
      );
    }
  }
  return instructions;
}

export async function createFunctionalFormSteps(
  instructions: FormInstruction[],
  browser: Pick<BrowserController, "navigate" | "wait" | "observe" | "getText">,
  startUrl: string
): Promise<TestCase["steps"]> {
  await browser.navigate(startUrl);
  await browser.wait(500);
  const observation = await browser.observe();
  const steps: TestCase["steps"] = [
    { name: "Wait for form", action: { type: "wait", ms: 500 } }
  ];
  for (const [index, instruction] of instructions.entries()) {
    const selector = controlSelector(instruction, observation);
    try {
      await browser.getText(selector);
    } catch {
      throw new Error(
        `${PREFIX}: instruction ${index + 1} control "${instruction.label}" is missing, ambiguous, disabled, or not a supported native control.`
      );
    }
    steps.push({
      name: `${instruction.kind === "fill" ? "Fill" : instruction.kind === "select" ? "Select" : instruction.kind === "choose" ? "Choose" : "Click"} ${instruction.label}`,
      action:
        instruction.kind === "fill" || instruction.kind === "select"
          ? { type: "type", selector, value: instruction.value }
          : { type: "click", selector }
    });
  }
  steps.push({ name: "Wait for form result", action: { type: "wait", ms: 500 } });
  return steps;
}

function token(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string" && parsed.length > 0) return parsed;
    } catch {
      /* The error below deliberately omits submitted values. */
    }
    throw new Error(`${PREFIX}: invalid quoted value or label.`);
  }
  return trimmed;
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function controlSelector(
  instruction: FormInstruction,
  observation: Observation
): string {
  const label = JSON.stringify(instruction.label);
  const native =
    instruction.kind === "select"
      ? "select:not([multiple])"
      : instruction.kind === "fill"
        ? 'textarea, input:not([type]), input:is([type="text"], [type="email"], [type="tel"], [type="number"], [type="date"], [type="datetime-local"], [type="time"], [type="month"], [type="url"], [type="search"])'
        : instruction.kind === "choose"
          ? instruction.checkbox
            ? 'input[type="checkbox"]:not(:checked)'
            : 'input:is([type="radio"], [type="checkbox"]:not(:checked))'
          : 'button, input:is([type="submit"], [type="button"])';
  const matchesLabel = (element: ElementInformation) =>
    [element.accessibleName, element.text].some(
      (name) => name !== null && normalize(name) === normalize(instruction.label)
    );
  const observed = observation.elements
    .filter(matchesLabel)
    .filter(
      (element) =>
        observation.elements.filter(
          (candidate) => candidate.selector === element.selector
        ).length === 1
    )
    .map((element) => `:is(${element.selector}):is(${native})`);
  const selectors = [
    ...observed,
    `:is(${native})[aria-label=${label}]`,
    `label:text-is(${label}) :is(${native})`,
    `${fieldGroup(instruction.label)} :is(${native})`
  ];
  if (instruction.kind === "click")
    selectors.push(
      `button:text-is(${label})`,
      `input:is([type="submit"], [type="button"])[value=${label}]`
    );
  const group =
    instruction.kind === "choose" && instruction.group
      ? `${fieldGroup(instruction.group)} `
      : "";
  return `${group}:is(${selectors.join(", ")}):visible:not(:disabled):not([readonly]):not([aria-disabled="true"])`;
}

function fieldGroup(label: string): string {
  // Nearby labels support common Bootstrap-style forms without for/id bindings.
  return `:is(div, fieldset, section):has(> :is(label, legend):text-is(${JSON.stringify(label)}))`;
}
