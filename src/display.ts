/**
 * Neutralize terminal control characters (ESC/ANSI, CR, newlines, bidi overrides) and characters that render
 * as nothing or as an ordinary space (format, private-use, unassigned, separator and non-ASCII space characters,
 * Hangul fillers, braille blank, variation selectors), so text an agent put into a request cannot rewrite, fake
 * or hide what the human sees in the CLI. Each one is shown as a \u escape, and a literal backslash as two
 * backslashes, so different text never displays the same (a real U+200B is \u200b, the six characters
 * "\u200b" are \\u200b).
 */
const HIDDEN = /(?! )\p{Zs}|[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;
const HIDDEN_OR_BACKSLASH = new RegExp(`\\\\|${HIDDEN.source}`, "gu");

const escape = (c: string) => {
  if (c === "\\") return "\\\\";
  const cp = c.codePointAt(0)!;
  return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
};

/** Text for the terminal: hidden characters and literal backslashes escaped. */
export function safe(s: unknown): string {
  return String(s ?? "").replace(HIDDEN_OR_BACKSLASH, escape);
}

/** A line of JSON.stringify output, whose backslashes are already escapes: hidden characters only. */
export function safeJsonLine(s: string): string {
  return s.replace(HIDDEN, escape);
}
