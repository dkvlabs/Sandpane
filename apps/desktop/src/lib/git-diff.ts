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
 * - File names come from the JSON `path` / `oldPath` only; the patch header is
 *   read for one thing — `new file mode 120000` (a symlink) — and only before
 *   the first hunk.
 * - `git.diff` is read-only, so no failure can have changed a file.
 */

import { CoreRequestError, MAY_HAVE_BEEN_APPLIED_COPY, asCoreRequestError } from "./core-client";
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
 * The symlink target of a new-file patch whose header says
 * `new file mode 120000`, or `null`. Only the header (before the first `@@`)
 * is read for the mode; the target is the first `+` line of the hunk — the
 * link's text, never the content of what it points to.
 */
export function symlinkTarget(patch: string): string | null {
  const lines = patch.split("\n");
  const hunk = lines.findIndex((line) => line.startsWith("@@"));
  if (hunk < 0) return null;
  if (!lines.slice(0, hunk).includes("new file mode 120000")) return null;
  const added = lines.slice(hunk + 1).find((line) => line.startsWith("+"));
  return added === undefined ? null : added.slice(1);
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
  const target = result.binary ? null : symlinkTarget(result.patch);
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

/**
 * The patch as display lines: split on LF only, each line revealed (tabs are
 * kept as patch whitespace; every other control, hidden or bidi character is
 * escaped, including CR and U+2028) and capped, at most
 * `PATCH_VIEW_MAX_LINES` lines with the rest counted.
 */
export function patchView(patch: string): { lines: PatchLine[]; hiddenLines: number } {
  if (patch.length === 0) return { lines: [], hiddenLines: 0 };
  const all = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
  const shown = all.slice(0, PATCH_VIEW_MAX_LINES);
  return {
    lines: shown.map((line) => {
      let unusual = false;
      const text = line
        .split("\t")
        .map((part) => {
          const revealed = displayRevealed(part, PATCH_LINE_MAX_CHARS);
          if (revealed.unusual) unusual = true;
          return revealed.text;
        })
        .join("\t");
      return { text, unusual, kind: lineKind(line) };
    }),
    hiddenLines: all.length - shown.length,
  };
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
 * Copy for a failed `git.diff`. It is read-only: no failure — a timeout, a
 * lost answer, Core's INTERNAL — can have changed a file, so the
 * "may have been applied" wording of writes never appears here. Core's exact
 * refusals keep their "Nothing was read — …" copy.
 */
export function diffFailureCopy(err: unknown): DiffFailureCopy {
  const error = asCoreRequestError(err);
  const raw = error.message.endsWith(MAY_HAVE_BEEN_APPLIED_COPY)
    ? error.message.slice(0, -MAY_HAVE_BEEN_APPLIED_COPY.length).trimEnd()
    : error.message;
  const reason = displayRevealed(raw, MAX_CORE_MESSAGE_CHARS).text;
  if (error.isCoreError) {
    if (error.code === "INTERNAL") {
      return {
        title: "Core could not produce the diff — no file was changed (git.diff is read-only)",
        body: `Core reported INTERNAL: ${reason}`,
        action: "Re-read the review and try again; git may have failed or timed out inside Core.",
      };
    }
    const copy = describeCoreError(new CoreRequestError("core", error.code, raw));
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
