import type { Observation } from "@vibeqa/schemas";

export function createPageStateFingerprint(observation: Observation): string {
  const visibleElements = observation.elements
    .filter((element) => element.visible)
    .map((element) => ({
      tagName: normalizeText(element.tagName),
      role: normalizeText(element.role ?? ""),
      accessibleName: normalizeText(element.accessibleName ?? ""),
      text: normalizeText(element.text),
      selector: element.selector,
      editable: element.editable,
      enabled: element.enabled,
      href: element.href ? normalizeUrl(element.href) : null,
      inputType: normalizeText(element.inputType ?? "")
    }))
    .sort((left, right) => {
      const leftValue = JSON.stringify(left);
      const rightValue = JSON.stringify(right);
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });

  const identity = JSON.stringify({
    url: normalizeUrl(observation.url),
    title: normalizeText(observation.title),
    textSample: normalizeText(observation.textSample),
    headings: observation.accessibility.headings.map((heading) => ({
      level: heading.level,
      text: normalizeText(heading.text)
    })),
    elements: visibleElements
  });

  return `state-${fnv1a(identity)}`;
}

export function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.searchParams.sort();
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
