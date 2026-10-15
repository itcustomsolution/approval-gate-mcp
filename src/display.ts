/**
 * Neutralize terminal control characters (ESC/ANSI, CR, newlines, bidi overrides) so text an
 * agent put into a request cannot rewrite or fake what the human sees in the CLI.
 */
export function safe(s: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
