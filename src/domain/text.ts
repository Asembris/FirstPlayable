/**
 * Text measurement and plain-text constraints shared by the brief and the
 * scene contracts. Counting is by Unicode code point, not UTF-16 unit, because
 * the specification states its budgets in code points.
 */

export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** C0 controls other than newline, plus DEL and the C1 range. */
const FORBIDDEN_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

export function isPlainText(value: string): boolean {
  return !FORBIDDEN_CONTROL.test(value);
}

export function normalizeForLiteralMatch(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/**
 * Case-insensitive, Unicode-normalized, complete word or phrase match. This
 * proves nothing about concepts; it only detects the literal wording.
 */
export function containsLiteralPhrase(haystack: string, phrase: string): boolean {
  const text = normalizeForLiteralMatch(haystack);
  const needle = normalizeForLiteralMatch(phrase).trim();
  if (needle.length === 0) return false;
  const words = needle.split(/\s+/u).map((word) => escapeRegExp(word));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${words.join("[^\\p{L}\\p{N}_]+")}(?![\\p{L}\\p{N}_])`,
    "u",
  );
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
