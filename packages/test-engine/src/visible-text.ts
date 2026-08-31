function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function matchesVisiblePageText(observed: string, expected: string): boolean {
  const pageText = normalizeWhitespace(observed);
  const segments = expected
    .split(/\r\n|[\n\r\u2028\u2029]/u)
    .map(normalizeWhitespace)
    .filter(Boolean);

  return segments.length > 0 && segments.every((segment) => pageText.includes(segment));
}
