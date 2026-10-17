/**
 * Neutralize terminal control characters (ESC/ANSI, CR, newlines, bidi overrides) and characters that render
 * as nothing or as an ordinary space (format, private-use, unassigned, separator and non-ASCII space characters,
 * Hangul fillers, braille blank, variation selectors), so text an agent put into a request cannot rewrite, fake
 * or hide what the human sees in the CLI. Each one is shown as a \u escape.
 */
const HIDDEN = /(?! )\p{Zs}|[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

export function safe(s: unknown): string {
  return String(s ?? "").replace(HIDDEN, (c) => {
    const cp = c.codePointAt(0)!;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
  });
}
