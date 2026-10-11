/**
 * A5 `git.diff` on the desktop (design 2026-10-09 §3.5).
 *
 * - The request names a change-set entry EXACTLY: its `path` as `git.review`
 *   returned it (never trimmed, normalized or re-encoded) and ALWAYS its
 *   `status` (a path can be listed twice). Paths are passed through, not
 *   validated: Core's change-list gate is the judge.
 * - The patch is UNTRUSTED display text. It is shown line by line as React
 *   text children, revealed (hidden, control and bidi characters become
 *   visible escapes and the line is marked) and capped. It is never rendered
 *   as HTML or Markdown, never executed, and never offered for apply.
 * - File names come from the JSON `path` / `oldPath` only; the patch is read
 *   for one thing — the "symlink → target" line — and only from the fixed
 *   shape of Core's untracked symlink patch (see `symlinkTarget`).
 * - `git.diff` is read-only, so no failure can have changed a file.
 */

import {
  CoreRequestError,
  MAY_HAVE_BEEN_APPLIED_COPY,
  PROXY_MAY_HAVE_BEEN_APPLIED_SUFFIX,
  asCoreRequestError,
} from "./core-client";
import { coreAdvertisesMethod, type ChangeSet, type CoreCapabilities, type GitDiffResult } from "./protocol";
import { describeCoreError, displayRevealed, featureGate, type FeatureGate } from "./reducers";
import { MAX_CORE_MESSAGE_CHARS } from "./sandbox-lifecycle";

export { GIT_DIFF_DEFAULT_BYTES, GIT_DIFF_MAX_BYTES, buildGitDiffParams } from "./guards";
import { GIT_DIFF_DEFAULT_BYTES } from "./guards";

/** Display caps for the patch view (the full text is still what Copy copies). */
export const PATCH_VIEW_MAX_LINES = 2000;
export const PATCH_LINE_MAX_CHARS = 1000;
/** Display cap for a path, an old path or a symlink target in a disclosure. */
export const DIFF_NAME_MAX_CHARS = 1024;

export const BINARY_DISCLOSURE =
  "treated as binary (possibly by repository attributes) — no text diff shown";
export const LOSSY_DISCLOSURE =
  "contains bytes that are not valid UTF-8; shown with replacement characters";
export const EMPTY_PATCH_DISCLOSURE =
  "Core returned an empty patch for this entry (for example a mode-only change or a pure rename)";
/** Always shown with a diff: what this view is, and is not. */
export const DIFF_DISPLAY_ONLY_NOTE =
  "Display only: this patch is shown as text and is never applied from here. Apply uses the change set and its confirmation.";

/** The Diff action's gate on `system.probe` `methods`. */
export function diffGate(capabilities: Pick<CoreCapabilities, "methods"> | null): FeatureGate {
  return featureGate(
    capabilities === null ? null : coreAdvertisesMethod(capabilities, "git.diff"),
    "git.diff",
    "Diff is not supported by this Core (it does not advertise git.diff); the change set lists paths only.",
  );
}

/** "N paths were not inspected" when Core says so; `null` when it does not. */
export function changeSetCompleteness(changeSet: Pick<ChangeSet, "uninspected">): string | null {
  const n = changeSet.uninspected?.length ?? 0;
  if (n === 0) return null;
  return `${n} ${n === 1 ? "path was" : "paths were"} not inspected — this change set is not complete.`;
}

/**
 * The target of Core's untracked symlink patch, or `null`. The JetBrains rule
 * (A5 review W1), all of which must hold, else no symlink line is shown:
 * the entry is `untracked` (and neither binary nor truncated); line 2 is
 * exactly `new file mode 120000` (Core C-quotes a newline in a header name, so
 * a file name cannot forge it, and a typechange's mid-patch mode never
 * counts); the first hunk header is exactly `@@ -0,0 +1 @@`; and the hunk has
 * exactly ONE `+` line. A target containing a newline is two `+` lines, so it
 * is never shown partially. The `+` line is the link's text, never the
 * content of what it points to.
 */
export function symlinkTarget(
  result: Pick<GitDiffResult, "status" | "patch" | "binary" | "truncated">,
): string | null {
  if (result.status !== "untracked" || result.binary || result.truncated) return null;
  const lines = result.patch.split("\n");
  if (!lines[0]?.startsWith("diff --git ") || lines[1] !== "new file mode 120000") return null;
  const hunk = lines.findIndex((line) => line.startsWith("@@"));
  if (hunk < 0 || lines[hunk] !== "@@ -0,0 +1 @@") return null;
  const added = lines.slice(hunk + 1).filter((line) => line.startsWith("+"));
  return added.length === 1 ? added[0].slice(1) : null;
}

/**
 * Every disclosure for one result, in reading order. `maxBytesSent` is the
 * clamped value this client sent (undefined = Core's default).
 */
export function diffDisclosures(result: GitDiffResult, maxBytesSent: number | undefined): string[] {
  const out: string[] = [];
  const name = (value: string) => displayRevealed(value, DIFF_NAME_MAX_CHARS).text;
  if (result.oldPath !== undefined) out.push(`${name(result.oldPath)} → ${name(result.path)}`);
  if (result.binary) out.push(BINARY_DISCLOSURE);
  const target = symlinkTarget(result);
  if (target !== null) out.push(`symlink → ${name(target)}`);
  if (result.truncated) out.push(`diff truncated at ${maxBytesSent ?? GIT_DIFF_DEFAULT_BYTES} bytes`);
  if (result.lossy) out.push(LOSSY_DISCLOSURE);
  if (!result.binary && result.patch.length === 0) out.push(EMPTY_PATCH_DISCLOSURE);
  if (result.baseBlob !== undefined) out.push(`base blob ${name(result.baseBlob).slice(0, 12)}`);
  return out;
}

export interface PatchLine {
  /** Revealed and capped text: React renders it as a text child. */
  text: string;
  /** The line held hidden, control or bidi characters (now escaped). */
  unusual: boolean;
  /** `+`, `-`, `@` or ` ` (from the first character) for styling only. */
  kind: "add" | "del" | "hunk" | "context" | "meta";
}

/** Reveal every segment between tabs (tabs stay patch whitespace), uncapped. */
function revealKeepingTabs(value: string): { text: string; unusual: boolean } {
  let unusual = false;
  const text = value
    .split("\t")
    .map((part) => {
      const revealed = displayRevealed(part, Number.MAX_SAFE_INTEGER);
      if (revealed.unusual) unusual = true;
      return revealed.text;
    })
    .join("\t");
  return { text, unusual };
}

/** The patch's lines (split on LF only; one trailing LF ends the last line). */
function patchLines(patch: string): string[] {
  if (patch.length === 0) return [];
  return patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
}

/**
 * One display line: the WHOLE line (tabs included) is capped at
 * `PATCH_LINE_MAX_CHARS` code points, then revealed (A5 review I2 — the cap
 * was per tab segment). `unusual` looks at the whole line, so a hidden
 * character past the cut still marks it.
 */
function displayPatchLine(line: string): { text: string; unusual: boolean } {
  const points = Array.from(line);
  const cut = points.length > PATCH_LINE_MAX_CHARS;
  const head = revealKeepingTabs(cut ? points.slice(0, PATCH_LINE_MAX_CHARS).join("") : line);
  const unusual = cut ? revealKeepingTabs(line).unusual : head.unusual;
  return {
    text: cut ? `${head.text}… (${points.length - PATCH_LINE_MAX_CHARS} more characters)` : head.text,
    unusual,
  };
}

/**
 * The patch as display lines: split on LF only, each line capped and revealed
 * (tabs are kept as patch whitespace; every other control, hidden or bidi
 * character is escaped, including CR and U+2028), at most
 * `PATCH_VIEW_MAX_LINES` lines with the rest counted.
 */
export function patchView(patch: string): { lines: PatchLine[]; hiddenLines: number } {
  const all = patchLines(patch);
  const shown = all.slice(0, PATCH_VIEW_MAX_LINES);
  return {
    lines: shown.map((line) => ({ ...displayPatchLine(line), kind: lineKind(line) })),
    hiddenLines: all.length - shown.length,
  };
}

/**
 * The note after a successful Copy (A5 review I5). Copy takes the WHOLE patch,
 * so the hidden-character count is over every line, not just the shown ones.
 */
export function diffCopyNote(patch: string): string {
  const hidden = patchLines(patch).filter((line) => revealKeepingTabs(line).unusual).length;
  const count =
    hidden === 0 ? "" : ` It contains ${hidden} ${hidden === 1 ? "line" : "lines"} with hidden characters.`;
  return `Copied the patch exactly as Core returned it.${count} Never apply this patch — it may create symlinks.`;
}

function lineKind(line: string): PatchLine["kind"] {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return line.startsWith(" ") ? "context" : "meta";
}

export type CopyOutcome = { ok: true } | { ok: false; message: string };

/** Copy the patch exactly as Core returned it, reporting failure honestly. */
export async function copyDiffText(
  clipboard: { writeText(text: string): Promise<void> } | undefined,
  text: string,
): Promise<CopyOutcome> {
  if (clipboard === undefined) {
    return { ok: false, message: "Copy is not available here — no clipboard access. Nothing was copied." };
  }
  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch {
    return { ok: false, message: "Copy failed — the clipboard refused the text. Nothing was copied." };
  }
}

export interface DiffFailureCopy {
  title: string;
  body: string;
  action: string;
}

/**
 * `message` without the "may have been applied" suffix of either plane: the
 * webview's own (`MAY_HAVE_BEEN_APPLIED_COPY`) or the native proxy's
 * (`PROXY_MAY_HAVE_BEEN_APPLIED_SUFFIX`, which a current proxy never adds to a
 * read, but an older shell might).
 */
function withoutAppliedSuffix(message: string): string {
  for (const suffix of [MAY_HAVE_BEEN_APPLIED_COPY, PROXY_MAY_HAVE_BEEN_APPLIED_SUFFIX]) {
    if (message.endsWith(suffix)) return message.slice(0, -suffix.length).trimEnd();
  }
  return message;
}

/**
 * Copy for a failed `git.diff`. It is read-only: no failure — a timeout, a
 * lost answer, Core's INTERNAL — can have changed a file, so the
 * "may have been applied" wording of writes never appears here (neither the
 * webview's nor the proxy's suffix — A5 review W4). Core's exact refusals keep
 * their "Nothing was read — …" copy.
 */
export function diffFailureCopy(err: unknown): DiffFailureCopy {
  const error = asCoreRequestError(err);
  const raw = withoutAppliedSuffix(error.message);
  const reason = displayRevealed(raw, MAX_CORE_MESSAGE_CHARS).text;
  if (error.isCoreError) {
    if (error.code === "INTERNAL") {
      return {
        title: "Core could not produce the diff — no file was changed (git.diff is read-only)",
        body: `Core reported INTERNAL: ${reason}`,
        action: "Re-read the review and try again; git may have failed or timed out inside Core.",
      };
    }
    const copy = describeCoreError(new CoreRequestError("core", error.code, raw, undefined, "git.diff"));
    return { title: copy.title, body: `Core reported ${String(error.code)}: ${reason}`, action: copy.action };
  }
  if (error.code === "TIMEOUT") {
    return {
      title: "Core did not answer in time — no file was changed (git.diff is read-only)",
      body: "A large diff runs git several times and can take longer than this view waits.",
      action: "Try again, or re-read the review first.",
    };
  }
  return {
    title: "The diff did not arrive — no file was changed (git.diff is read-only)",
    body: `This desktop reported ${String(error.code)}: ${reason}`,
    action: "Check the Core connection and try again.",
  };
}
