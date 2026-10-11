/**
 * Anti-spoofing for Core-supplied text shown in native VS Code surfaces
 * (notifications, modal dialogs, quick picks, the status line).
 *
 * Mirrors the JetBrains client's `VisibleText`
 * (clients/jetbrains/.../text/VisibleText.kt) so every Sandpane client treats a
 * crafted name, id, impact line or error message the same way: characters that
 * change how text LOOKS without being visible themselves are replaced by a
 * visible `\uXXXX` escape, so a Core string cannot fake an extra line, hide part
 * of itself, or reorder what the user reads (bidi override).
 *
 * Escaped, per CODE POINT (never per UTF-16 unit, so emoji stay intact):
 *  - Cc controls — `\n`, `\r`, `\t` by name, every other one as `\uXXXX`;
 *  - Cf format characters — bidi embeddings/overrides/isolates
 *    (U+202A–U+202E, U+2066–U+2069), marks (U+200E/U+200F/U+061C), zero-width
 *    space/joiners (U+200B–U+200D), word joiner, BOM U+FEFF, soft hyphen, tags;
 *  - Zl/Zp — U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR;
 *  - unpaired surrogates;
 *  - letters that render as nothing (Hangul fillers, U+034F).
 *
 * The backslash itself is not escaped, which keeps `revealHidden` idempotent.
 * Consequence (same as JetBrains): a value that literally contains the six
 * characters `\u202E` reads the same as one containing the real override, so a
 * surface where the difference matters checks `inspectHidden(...).altered`.
 */

/** Letters (Lo/Mn) that typically render as blank space or nothing at all. */
const INVISIBLE_LETTERS: ReadonlySet<number> = new Set([0x034f, 0x115f, 0x1160, 0x3164, 0xffa0]);

const HIDDEN_CATEGORY = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;

/** Whether `codePoint` is one this module escapes. */
export function isHiddenCodePoint(codePoint: number): boolean {
  if (INVISIBLE_LETTERS.has(codePoint)) return true;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true; // unpaired surrogate
  return HIDDEN_CATEGORY.test(String.fromCodePoint(codePoint));
}

function escapeCodePoint(cp: number): string {
  if (cp === 0x0a) return '\\n';
  if (cp === 0x0d) return '\\r';
  if (cp === 0x09) return '\\t';
  const hex = cp.toString(16).toUpperCase();
  return cp <= 0xffff ? `\\u${hex.padStart(4, '0')}` : `\\U${hex.padStart(8, '0')}`;
}

export interface Revealed {
  text: string;
  /** True when at least one hidden character was escaped. */
  altered: boolean;
}

/**
 * `text` with every hidden character escaped. Single-line by default: line
 * breaks become a literal `\n`, so one Core string can never pose as two lines.
 */
export function inspectHidden(text: string): Revealed {
  let altered = false;
  let out = '';
  // `for…of` iterates code points; a lone surrogate arrives as its own unit.
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isHiddenCodePoint(cp)) {
      altered = true;
      out += escapeCodePoint(cp);
    } else {
      out += ch;
    }
  }
  return { text: out, altered };
}

export function revealHidden(text: string): string {
  return inspectHidden(text).text;
}

/**
 * Plain, single-line, bounded text for a VS Code notification / modal / quick
 * pick. On top of `revealHidden`:
 *  - non-modal notifications render `[label](command:…|https:…|file:…)` as a
 *    clickable link, so the `](` pair is broken with a visible space — a Core
 *    string can never become a clickable command;
 *  - the result is capped at `max` code points with a visible ellipsis.
 */
export function plainText(value: unknown, max = 500): string {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const revealed = revealHidden(raw).replace(/\]\(/g, '] (');
  const points = Array.from(revealed);
  return points.length > max ? `${points.slice(0, max).join('')}… (truncated)` : revealed;
}

/**
 * One line of untrusted multi-line text (a patch line, a verification output
 * line) made safe to look at: every hidden / bidi / control / line-separator
 * character is escaped (`\uXXXX`, CR as `\r`) EXCEPT the tab, which is kept
 * as real content. The caller splits on LF first, so LF and TAB are the only
 * control characters that ever reach the screen raw. `altered` = something
 * was escaped.
 */
export function revealKeepingTabs(line: string): Revealed {
  let altered = false;
  const text = line
    .split('\t')
    .map((segment) => {
      const revealed = inspectHidden(segment);
      altered = altered || revealed.altered;
      return revealed.text;
    })
    .join('\t');
  return { text, altered };
}
