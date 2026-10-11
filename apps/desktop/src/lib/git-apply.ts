/**
 * A6 `git.apply` for reviewed files, on the desktop (design 2026-10-09 §3.6).
 *
 * Everything here is pure (no React, no DOM), so it is unit-tested in node:
 *
 * - The gate: Apply is enabled ONLY when Core advertises BOTH the `git.apply`
 *   method and the `git-apply` feature. Otherwise the review stays read-only
 *   with an honest "not implemented by this Core" note.
 * - Selectability per entry of ONE `git.review` answer (its `reviewId`).
 * - The send plan: entries copied VERBATIM from that answer (`applyEntryOf`),
 *   never `selectedFiles`, at most 1000, and REFUSED (no frame) when a
 *   `git.diff` the user opened for an entry returned a different `taskBlob`.
 * - The confirmation flags (§3.6 item 9): (a) content never fully shown,
 *   (b) executable files, (c) paths that run automatically.
 * - Honest copy for every outcome: success, partial (a warning — never success
 *   and never "nothing written"), aborts keyed on Core's exact constants (an
 *   unknown reason is shown verbatim), both CONFLICT kinds, and the lost answer
 *   ("may have been applied — check `git status`"), never "nothing changed".
 *
 * The message constants are Core's (`sandpane-core/src/apply.rs`,
 * `sandpane-service/src/git_apply.rs`), drift-tested in
 * `tests/git-apply.test.ts` against the Rust sources read from disk.
 */

import {
  MAY_HAVE_BEEN_APPLIED_COPY,
  type CoreRequestError,
  PROXY_MAY_HAVE_BEEN_APPLIED_SUFFIX,
  asCoreRequestError,
} from "./core-client";
import { MAX_APPLY_ENTRIES, applyEntryOf } from "./guards";
import {
  FEATURE_GIT_APPLY,
  coreAdvertisesFeature,
  coreAdvertisesMethod,
  type ApplyEntry,
  type ApplyResult,
  type ChangeSet,
  type CoreCapabilities,
  type FileChange,
  type FileChangeStatus,
  type GitApplyParams,
  type GitDiffResult,
} from "./protocol";
import { displayRevealed, type FeatureGate } from "./reducers";
import { MAX_CORE_MESSAGE_CHARS } from "./sandbox-lifecycle";
import { MSG_NO_GIT_CONTEXT } from "./git-messages";

export { MAX_APPLY_ENTRIES } from "./guards";

/** Display cap for a path or the repository path in apply copy. */
export const APPLY_NAME_MAX_CHARS = 1024;

// ---------------------------------------------------------------------------
// Core's exact messages (drift-tested)
// ---------------------------------------------------------------------------

export const NOTHING_WRITTEN_SUFFIX = "; nothing was written";
export const MSG_NEEDS_REVIEW =
  "git.apply needs reviewId and a non-empty entries list copied from a git.review answer; nothing was written";
export const MSG_SELECTED_FILES =
  "selectedFiles is not accepted: send reviewId and entries copied from a git.review answer instead; nothing was written";
export const MSG_TOO_MANY_ENTRIES = "at most 1000 entries can be applied at once; nothing was written";
export const MSG_ENTRIES_NOT_REVIEWED =
  "entries do not match a review Core produced; review again; nothing was written";
export const MSG_DIRECT_MOUNT =
  "this task worked directly in your repository; its changes are already in your working tree, so there is nothing to apply; nothing was written";
export const MSG_CHECK_FAILED = "the patch does not apply cleanly; nothing was written";
export const MSG_PATCH_TOO_LARGE =
  "the selected changes are too large to apply in one step (the patch exceeds 64 MiB); nothing was written";
export const MSG_PREPARE_TOO_SLOW =
  "preparing the apply took longer than its 20 s budget; apply fewer files at once; nothing was written";
export const MSG_CONTENT_TOO_LARGE =
  "the selected files hold more than 64 MiB of new content, too much to apply in one step; apply fewer files at once; nothing was written";
/** I1: the write phase had too little budget left to start `git apply`. */
export const MSG_WRITE_TOO_LATE =
  "git apply was not started (too little of its time budget was left to finish it safely); nothing was written";
export const MSG_WRITE_NOT_RUN =
  "git apply was not started (reading the repository's configuration timed out or failed); nothing was written";
export const MSG_CHECK_UNAVAILABLE = "git could not check the patch (timed out or failed); nothing was written";
export const MSG_HOST_UNBORN =
  "your repository has no commit, so it is not at the task's base; nothing was written";
export const MSG_HOST_WORK_TREE_REDIRECTED =
  "git does not place your repository's work tree at its root (is a repository-local core.worktree set?); nothing was written";
/** `msg_context(MSG_NO_GIT_CONTEXT)`: the only apply outcome reachable over the wire until A4b. */
export const MSG_APPLY_NO_GIT_CONTEXT = `${MSG_NO_GIT_CONTEXT}${NOTHING_WRITTEN_SUFFIX}`;

/**
 * Fixed fragments of Core's `format!` messages (each one drift-tested as a
 * substring of the Rust template). `prefix` / `suffix` / `infix` say where the
 * fragment sits; the variable parts (paths, oids, the repository) never take
 * part in matching.
 */
export const APPLY_FRAGMENTS = {
  changed: " changed since it was reviewed; review it again; nothing was written",
  listedTwice: " is listed more than once in entries; nothing was written",
  noContent: " has no reviewed content id (it was over the 32 MiB apply cap, or not a file Core could read, when it was reviewed)",
  symlink: ": symlinks are never applied; nothing was written",
  gitlink: ": submodule entries (gitlinks) are never applied; nothing was written",
  baseSymlink:
    " is a symlink in the base commit; deleting or replacing a tracked symlink is not supported; nothing was written",
  collision: ": the content appears to be part of a SHA-1 collision attack; nothing was written",
  snapshotDiffers: ": the snapshot differs from the reviewed entries; nothing was written",
  leadingPath: " lies under a symlink or a file in your working tree; nothing was written",
  dirty: " in your working tree have uncommitted changes or are untracked or ignored files; nothing was written",
  hidden:
    " are flagged assume-unchanged or skip-worktree in your index, which hides changes; nothing was written",
  filteredInfix: " has the filter attribute ",
  filteredSuffix: "; Core never runs filters, so it would receive raw content; nothing was written",
  headMovedPrefix: "your repository's HEAD is ",
  headMovedInfix: ", not the task's base ",
  expectedBasePrefix: "base diverged: the task's recorded base is ",
  writeFailedPrefix:
    "the write failed after git's checks passed; some files may have been written or staged — check `git status` in ",
  indexLockInfix: "`.git/index.lock` may remain — remove it only after checking that no git process is running",
  verifyUnavailablePrefix: "could not verify the staged content — check `git status` in ",
  verifyFailedPrefix:
    "files were changed, but the staged content differs from the reviewed content — check `git status` in ",
  /** CONFLICT (service `msg_locked`): `{repo} is busy: {holder} holds its writer lock (…); nothing was written`. */
  lockedInfix: " is busy: ",
  lockedSuffix:
    " holds its writer lock (a running writer task, another apply or a worktree discard); nothing was written",
  /**
   * CONFLICT (service `msg_mount_being_created`): `{repo} is busy: sandbox
   * {name:?} is being created with a direct mount of it and could change it …`.
   */
  mountBeingCreatedSuffix:
    " is being created with a direct mount of it and could change it while Core writes; nothing was written",
  /** CONFLICT (core `msg_mounted`): `{what}: a sandbox mounts this repository directly …`. */
  mountedSuffix:
    ": a sandbox mounts this repository directly and can change it while Core writes; stop or remove it first; nothing was written",
} as const;

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export const APPLY_UNSUPPORTED_NOTE =
  "Apply is not implemented by this Core (it does not advertise the git-apply feature); this review is read-only here.";

/** Apply needs BOTH the method and the `git-apply` feature (§3.6 item 10). */
export function applyGate(
  capabilities: Pick<CoreCapabilities, "methods" | "features"> | null,
): FeatureGate {
  if (capabilities === null) {
    return { state: "unprobed", note: "Core has not been probed yet, so support for git.apply is unknown." };
  }
  const supported =
    coreAdvertisesMethod(capabilities, "git.apply") && coreAdvertisesFeature(capabilities, FEATURE_GIT_APPLY);
  return supported
    ? { state: "supported", note: "git.apply (git-apply) is advertised by this Core." }
    : { state: "unsupported", note: APPLY_UNSUPPORTED_NOTE };
}

// ---------------------------------------------------------------------------
// Selectability
// ---------------------------------------------------------------------------

export const REASON_SYMLINK = "symlinks are never applied";
export const REASON_TOO_LARGE = "too large or unreadable to apply (over 32 MiB)";
export const REASON_NO_CONTENT_ID = "no reviewed content id";
export const REASON_UNKNOWN_STATUS =
  "Core reported a status this build does not recognise; it cannot be applied from here";
export const REASON_UNKNOWN_TWIN =
  "Core also lists this path with a status this build does not recognise; it cannot be applied from here";
export const REASON_NO_REVIEW_ID =
  "Core did not bind this review to reviewed content (no reviewId) — only host_worktree tasks can be applied";

export type Selectability = { selectable: true } | { selectable: false; reason: string };

/** The symlink mode (`120000`): never applied. */
export const MODE_SYMLINK = "120000";
/** The executable mode (`100755`): flagged (b) in the confirmation. */
export const MODE_EXECUTABLE = "100755";

/**
 * Whether ONE entry of a review can be selected for apply (§3.6 item 3):
 * `deleted`, or carrying both `taskBlob` and `taskMode`, and never mode
 * `120000`. `reviewBound` is false when the answer carried no `reviewId`.
 */
export function entrySelectability(
  change: FileChange,
  context: { reviewBound: boolean; unknownTwin: boolean },
): Selectability {
  if (change.status === "unknown") return { selectable: false, reason: REASON_UNKNOWN_STATUS };
  if (context.unknownTwin) return { selectable: false, reason: REASON_UNKNOWN_TWIN };
  if (!context.reviewBound) return { selectable: false, reason: REASON_NO_REVIEW_ID };
  if (change.taskMode === MODE_SYMLINK) return { selectable: false, reason: REASON_SYMLINK };
  if (change.status === "deleted") return { selectable: true };
  const hasBlob = change.taskBlob !== undefined && change.taskBlob.length > 0;
  const hasMode = change.taskMode !== undefined && change.taskMode.length > 0;
  if (hasBlob && hasMode) return { selectable: true };
  if (!hasBlob && !hasMode) return { selectable: false, reason: REASON_TOO_LARGE };
  return { selectable: false, reason: REASON_NO_CONTENT_ID };
}

/** Selectability of every entry, in Core's order (index-aligned). */
export function reviewSelectability(changeSet: ChangeSet): Selectability[] {
  const unknownPaths = new Set(changeSet.changes.filter((c) => c.status === "unknown").map((c) => c.path));
  const reviewBound = changeSet.reviewId !== undefined && changeSet.reviewId.length > 0;
  return changeSet.changes.map((change) =>
    entrySelectability(change, {
      reviewBound,
      unknownTwin: change.status !== "unknown" && unknownPaths.has(change.path),
    }),
  );
}

// ---------------------------------------------------------------------------
// What the user saw: git.diff records
// ---------------------------------------------------------------------------

/** What one opened `git.diff` showed for an entry (never the patch itself). */
export interface DiffRecord {
  taskBlob?: string;
  taskMode?: string;
  binary: boolean;
  truncated: boolean;
}

/** Diff records are keyed by an entry's exact status + path. */
export function diffRecordKey(path: string, status: FileChangeStatus | "unknown"): string {
  return `${status}\u0000${path}`;
}

export function diffRecordOf(result: GitDiffResult): DiffRecord {
  return {
    ...(result.taskBlob === undefined ? {} : { taskBlob: result.taskBlob }),
    ...(result.taskMode === undefined ? {} : { taskMode: result.taskMode }),
    binary: result.binary,
    truncated: result.truncated,
  };
}

/**
 * The record for the entry the user opened, or `null` when the result is for
 * a different entry: BOTH `path` and `status` must match (A6 review I2). A
 * path can be listed twice (e.g. `deleted` and `untracked`).
 */
export function diffRecordFor(
  entry: { path: string; status: FileChangeStatus },
  result: GitDiffResult,
): DiffRecord | null {
  return result.path === entry.path && result.status === entry.status ? diffRecordOf(result) : null;
}

/**
 * §3.6 item 9 / brief item 4: the opened diff showed DIFFERENT task content
 * than the reviewed entry binds (its `taskBlob` or `taskMode` differs, or the
 * diff found a file where the review had none). Then nothing may be sent.
 */
export function diffMismatch(
  entry: Pick<ApplyEntry, "taskBlob" | "taskMode">,
  record: DiffRecord | undefined,
): boolean {
  if (record === undefined) return false;
  // I4: the content id AND the mode. A diff that reports neither cannot prove
  // a change (flag (a) covers it instead).
  const blobDiffers = record.taskBlob !== undefined && record.taskBlob !== entry.taskBlob;
  const modeDiffers = record.taskMode !== undefined && record.taskMode !== entry.taskMode;
  return blobDiffers || modeDiffers;
}

// ---------------------------------------------------------------------------
// Confirmation flags
// ---------------------------------------------------------------------------

/** Directories whose files run automatically (any path component, any case). */
const AUTO_RUN_DIRS = [".husky", ".githooks", ".vscode", ".idea"];
/** Files that run or change behaviour automatically (any component, any case). */
const AUTO_RUN_FILES = [".envrc", ".gitattributes", ".gitmodules"];

/** `hostHooksPath` as a comparable prefix: `./` and trailing `/` stripped, lower-cased. */
function normalizedHooksPath(hooksPath: string): string {
  let value = hooksPath;
  while (value.startsWith("./")) value = value.slice(2);
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value.toLowerCase();
}

/**
 * Why `path` runs automatically, or `null`. Matched on path components,
 * case-insensitively (APFS and NTFS are case-insensitive by default) and at
 * any depth: over-flagging is the safe direction. `hostHooksPath` (Core
 * reports it only when repo-relative) flags everything under it; `.` or an
 * empty value (the repository root) flags every path.
 */
export function autoRunReason(path: string, hostHooksPath?: string): string | null {
  const parts = path.split("/").map((part) => part.toLowerCase());
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (AUTO_RUN_DIRS.includes(part)) return `under ${part}/`;
    if (part === ".github" && parts[i + 1] === "workflows") return "under .github/workflows/";
    if (AUTO_RUN_FILES.includes(part)) return part;
  }
  if (hostHooksPath !== undefined) {
    const hooks = normalizedHooksPath(hostHooksPath);
    const lower = path.toLowerCase();
    if (hooks === "" || hooks === "." || lower === hooks || lower.startsWith(`${hooks}/`)) {
      return "under the repository's core.hooksPath";
    }
  }
  return null;
}

export interface FlaggedEntry {
  entry: ApplyEntry;
  why: string;
}

export interface ApplyFlags {
  /** (a) binary, truncated, or never opened in the Diff view this session. */
  notFullyShown: FlaggedEntry[];
  /** (b) executable additions and exec-bit changes (`taskMode` 100755). */
  executable: FlaggedEntry[];
  /** (c) paths that run automatically (hooks, CI workflows, editor config…). */
  autoRun: FlaggedEntry[];
}

export function applyFlags(
  entries: readonly ApplyEntry[],
  diffs: ReadonlyMap<string, DiffRecord>,
  hostHooksPath?: string,
): ApplyFlags {
  const flags: ApplyFlags = { notFullyShown: [], executable: [], autoRun: [] };
  for (const entry of entries) {
    const record = diffs.get(diffRecordKey(entry.path, entry.status));
    const notShown =
      record === undefined
        ? "never opened in the Diff view"
        : record.binary
          ? "binary — no text diff was shown"
          : record.truncated
            ? "the diff was truncated"
            : entry.taskBlob !== undefined && record.taskBlob === undefined
              ? "the diff did not name the reviewed content"
              : null;
    if (notShown !== null) flags.notFullyShown.push({ entry, why: notShown });
    if (entry.taskMode === MODE_EXECUTABLE) {
      flags.executable.push({
        entry,
        why: entry.status === "modified" ? "mode 100755 (an exec-bit change, or already executable)" : "executable file (mode 100755)",
      });
    }
    const auto =
      autoRunReason(entry.path, hostHooksPath) ??
      (entry.oldPath === undefined ? null : autoRunReason(entry.oldPath, hostHooksPath));
    if (auto !== null) flags.autoRun.push({ entry, why: auto });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// The plan (what one confirmation would send)
// ---------------------------------------------------------------------------

/** A frozen, confirmable apply: exactly what the modal shows and what is sent. */
export interface ApplySnapshot {
  request: GitApplyParams;
  repoPath: string;
  flags: ApplyFlags;
}

export type ApplyPlan =
  | { ok: true; snapshot: ApplySnapshot }
  | { ok: false; reason: string; reReview: boolean };

export const APPLY_STATEMENT =
  "Writes these files into your working tree and stages them. Nothing is committed. The content is the version Core hashed when you reviewed.";

function shownName(value: string): string {
  return displayRevealed(value, APPLY_NAME_MAX_CHARS).text;
}

/** "<path> changed after you reviewed it — review again" (no frame is sent). */
export function changedAfterReviewCopy(path: string): string {
  return `${shownName(path)} changed after you reviewed it — review again`;
}

/**
 * What an apply of `selected` (indices into `changeSet.changes`) would send,
 * or why nothing may be sent. Entries are copied verbatim (`applyEntryOf`);
 * a diff mismatch refuses the whole send and asks for a re-review.
 */
export function planReviewedApply(args: {
  taskId: string;
  changeSet: ChangeSet;
  selected: ReadonlySet<number>;
  diffs: ReadonlyMap<string, DiffRecord>;
}): ApplyPlan {
  const { taskId, changeSet, selected, diffs } = args;
  const reviewId = changeSet.reviewId;
  if (reviewId === undefined || reviewId.length === 0) {
    return { ok: false, reason: REASON_NO_REVIEW_ID, reReview: false };
  }
  if (changeSet.repoPath === undefined) {
    return {
      ok: false,
      reason: "Core did not report the repository path, so the confirmation could not name it; nothing can be applied.",
      reReview: false,
    };
  }
  if (selected.size === 0) return { ok: false, reason: "Select at least one reviewed file to apply.", reReview: false };
  if (selected.size > MAX_APPLY_ENTRIES) {
    return {
      ok: false,
      reason: `At most ${MAX_APPLY_ENTRIES} files can be applied at once; select fewer.`,
      reReview: false,
    };
  }
  const selectability = reviewSelectability(changeSet);
  const entries: ApplyEntry[] = [];
  // Core's order, never the order the user clicked in.
  for (let index = 0; index < changeSet.changes.length; index += 1) {
    if (!selected.has(index)) continue;
    const change = changeSet.changes[index];
    const verdict = selectability[index];
    if (change === undefined || verdict === undefined || !verdict.selectable || change.status === "unknown") {
      return {
        ok: false,
        reason: "A selected entry cannot be applied; review again and select again.",
        reReview: true,
      };
    }
    const entry = applyEntryOf({ ...change, status: change.status });
    if (diffMismatch(entry, diffs.get(diffRecordKey(entry.path, entry.status)))) {
      return { ok: false, reason: changedAfterReviewCopy(entry.path), reReview: true };
    }
    entries.push(entry);
  }
  if (entries.length !== selected.size) {
    return { ok: false, reason: "The selection does not match this review; review again.", reReview: true };
  }
  return {
    ok: true,
    snapshot: {
      request: { taskId, expectedBase: changeSet.baseCommit, reviewId, entries },
      repoPath: changeSet.repoPath,
      flags: applyFlags(entries, diffs, changeSet.hostHooksPath),
    },
  };
}

/**
 * The confirmation opens ONLY from a direct user gesture on the Apply control:
 * a trusted (browser-generated) click event, never a scripted one, a timer, a
 * reconnect, or chat/agent/tool text. Returns the snapshot to show, or `null`.
 */
export function openApplyConfirmation(
  event: { nativeEvent?: { isTrusted?: boolean } } | null | undefined,
  plan: ApplyPlan,
): ApplySnapshot | null {
  if (event?.nativeEvent?.isTrusted !== true) return null;
  return plan.ok ? plan.snapshot : null;
}

/**
 * Re-checked at confirm time (a diff may have arrived after the modal opened):
 * `null` = send; otherwise the refusal (no frame is sent).
 */
export function confirmRefusal(
  snapshot: ApplySnapshot,
  diffs: ReadonlyMap<string, DiffRecord>,
): string | null {
  for (const entry of snapshot.request.entries) {
    if (diffMismatch(entry, diffs.get(diffRecordKey(entry.path, entry.status)))) {
      return changedAfterReviewCopy(entry.path);
    }
  }
  return null;
}

/** "Apply N files" — the explicit confirm label. */
export function applyButtonLabel(count: number): string {
  return `Apply ${count} ${count === 1 ? "file" : "files"}`;
}

// ---------------------------------------------------------------------------
// Outcome copy
// ---------------------------------------------------------------------------

export type ApplyTone = "success" | "attention" | "danger" | "neutral";

export interface ApplyCopy {
  kind: "success" | "partial" | "aborted" | "refused" | "unknown" | "not-sent";
  title: string;
  /** Core's reason, revealed and capped (never re-worded). */
  reason: string | null;
  action: string;
  tone: ApplyTone;
  /** Offer "Review again" (a fresh git.review, the selection discarded). */
  reReview: boolean;
  /** Extra detail lines (applied files, mode changes, conflicted files), revealed. */
  details: string[];
}

function reasonText(reason: string): string {
  return displayRevealed(reason, MAX_CORE_MESSAGE_CHARS).text;
}

function repoText(repoPath: string | undefined): string {
  return repoPath === undefined ? "the repository" : shownName(repoPath);
}

interface AbortRule {
  test: (reason: string) => boolean;
  title: string;
  action: string;
  reReview?: boolean;
}

const F = APPLY_FRAGMENTS;

/** Aborts keyed on Core's exact constants / fixed fragments, most specific first. */
const ABORT_RULES: readonly AbortRule[] = [
  {
    test: (r) => r === MSG_APPLY_NO_GIT_CONTEXT,
    title: "Not applied — this task has no Git context; nothing was written",
    action: "Core has no repository binding and base commit for this task, so there is nothing it can apply.",
  },
  {
    test: (r) => r === MSG_DIRECT_MOUNT,
    title: "Nothing to apply — this task worked directly in your repository; nothing was written",
    action: "Its changes are already in your working tree. Review them with git in your repository.",
  },
  {
    test: (r) => r === MSG_ENTRIES_NOT_REVIEWED,
    title: "Not applied — Core no longer knows this review; nothing was written",
    action: "Core keeps recent reviews in memory only (a Core restart forgets them). Review again, then select again.",
    reReview: true,
  },
  {
    test: (r) => r.endsWith(F.changed),
    title: "Not applied — a file changed after you reviewed it; nothing was written",
    action: "Review again so you see, and apply, the content as it is now.",
    reReview: true,
  },
  {
    test: (r) => r.endsWith(F.snapshotDiffers),
    title: "Not applied — the snapshot differs from the reviewed entries; nothing was written",
    action: "Review again; something on disk no longer matches the review.",
    reReview: true,
  },
  {
    test: (r) => r.endsWith(F.listedTwice),
    title: "Not applied — an entry was listed more than once; nothing was written",
    action: "Review again and select each file once.",
    reReview: true,
  },
  {
    test: (r) => r === MSG_CHECK_FAILED,
    title: "Not applied — the patch does not apply cleanly; nothing was written",
    action: "Your working tree no longer matches the task's base for these files. Core never merges into your edits.",
  },
  {
    test: (r) => r === MSG_CHECK_UNAVAILABLE,
    title: "Not applied — git could not check the patch; nothing was written",
    action: "git timed out or failed while checking (this is not a conflict). Try again later, or apply fewer files.",
  },
  {
    test: (r) => r === MSG_CONTENT_TOO_LARGE || r === MSG_PATCH_TOO_LARGE || r === MSG_PREPARE_TOO_SLOW,
    title: "Not applied — too much to apply in one step; nothing was written",
    action: "Select fewer files and apply them in smaller groups.",
  },
  {
    test: (r) => r === MSG_WRITE_NOT_RUN || r === MSG_WRITE_TOO_LATE,
    title: "Not applied — git apply was not started; nothing was written",
    action: "Core stopped before any write (its configuration read failed, or too little time was left). Try again later.",
  },
  {
    test: (r) => r.endsWith(F.dirty),
    title: "Not applied — these paths are not clean in your working tree; nothing was written",
    action: "Commit, stash or remove your uncommitted, untracked or ignored files at these paths first.",
  },
  {
    test: (r) => r.endsWith(F.hidden),
    title: "Not applied — some paths are hidden from git status in your index; nothing was written",
    action: "Clear assume-unchanged / skip-worktree on these paths first.",
  },
  {
    test: (r) => r.endsWith(F.leadingPath),
    title: "Not applied — a path lies under a symlink or a file in your working tree; nothing was written",
    action: "Core never writes through a symlink. Fix the path in your working tree first.",
  },
  {
    test: (r) => r.endsWith(F.symlink),
    title: "Not applied — symlinks are never applied; nothing was written",
    action: "Deselect the symlink.",
  },
  {
    test: (r) => r.endsWith(F.baseSymlink),
    title: "Not applied — replacing or deleting a tracked symlink is not supported; nothing was written",
    action: "Deselect that path.",
  },
  {
    test: (r) => r.endsWith(F.gitlink),
    title: "Not applied — submodule entries are never applied; nothing was written",
    action: "Deselect the submodule entry.",
  },
  {
    test: (r) => r.includes(F.filteredInfix) && r.endsWith(F.filteredSuffix),
    title: "Not applied — a path uses a git filter (for example Git LFS); nothing was written",
    action: "Core never runs filters, so it would write raw content. Apply that file another way.",
  },
  {
    test: (r) => r.includes(F.noContent) && r.endsWith(NOTHING_WRITTEN_SUFFIX),
    title: "Not applied — a file has no reviewed content id; nothing was written",
    action: "It was over the 32 MiB apply cap or not a readable file when reviewed. Deselect it.",
  },
  {
    test: (r) => r.endsWith(F.collision),
    title: "Not applied — content looks like part of a SHA-1 collision attack; nothing was written",
    action: "Do not apply this content.",
  },
  {
    test: (r) =>
      r === MSG_HOST_UNBORN ||
      (r.startsWith(F.headMovedPrefix) && r.includes(F.headMovedInfix) && r.endsWith(NOTHING_WRITTEN_SUFFIX)) ||
      (r.startsWith(F.expectedBasePrefix) && r.endsWith(NOTHING_WRITTEN_SUFFIX)),
    title: "Not applied — your repository is not at the task's base; nothing was written",
    action: "Core applies only onto the exact base commit the task started from. Check out that commit first.",
  },
  {
    test: (r) => r === MSG_HOST_WORK_TREE_REDIRECTED,
    title: "Not applied — git does not place your work tree at the repository root; nothing was written",
    action: "A repository-local core.worktree may be set. Core refuses rather than write elsewhere.",
  },
];

/** Partial outcomes: some files MAY have been written or staged. */
function partialAction(reason: string, repo: string): string {
  const lock = reason.includes(F.indexLockInfix)
    ? " `.git/index.lock` may remain — remove it only after checking that no git process is running."
    : "";
  return `Check \`git status\` in ${repo} before doing anything else; do not retry until you have.${lock}`;
}

/**
 * Copy for a decoded `ApplyResult`. `sentCount` is how many entries this
 * client sent (used only when Core omitted `appliedFiles` on success).
 */
export function applyOutcomeCopy(result: ApplyResult, repoPath: string | undefined, sentCount: number): ApplyCopy {
  const repo = repoText(repoPath);
  const reason = result.abortReason ?? null;
  if (result.partial === true) {
    // W1/W2/verify-unavailable: never success, never "nothing was written".
    const details = (result.appliedFiles ?? []).map((path) => `may have been written or staged: ${shownName(path)}`);
    return {
      kind: "partial",
      title: "Apply did not finish cleanly — some files may have been written or staged",
      reason: reason === null ? null : reasonText(reason),
      action: partialAction(reason ?? "", repo),
      tone: "danger",
      reReview: false,
      details,
    };
  }
  if (result.applied) {
    const count = result.appliedFiles?.length ?? sentCount;
    const details = [
      ...(result.appliedFiles ?? []).map((path) => `staged: ${shownName(path)}`),
      ...(result.modeChanges ?? []).map(
        (m) => `mode change: ${shownName(m.path)} ${shownName(m.from)} → ${shownName(m.to)}`,
      ),
    ];
    return {
      kind: "success",
      title: `Applied ${count} ${count === 1 ? "file" : "files"} to ${repo} (staged, not committed)`,
      reason: null,
      action: "Review the staged changes with git, then commit them yourself. Nothing was committed.",
      tone: "success",
      reReview: false,
      details,
    };
  }
  const conflicted = result.conflictedFiles.map((path) => `does not apply: ${shownName(path)}`);
  if (reason === null) {
    return {
      kind: "aborted",
      title: "Not applied — Core gave no reason",
      reason: null,
      action: "Core reported no partial write. Review again before retrying.",
      tone: "attention",
      reReview: true,
      details: conflicted,
    };
  }
  const rule = ABORT_RULES.find((candidate) => candidate.test(reason));
  if (rule !== undefined) {
    return {
      kind: "aborted",
      title: rule.title,
      reason: reasonText(reason),
      action: rule.action,
      tone: "attention",
      reReview: rule.reReview === true,
      details: conflicted,
    };
  }
  // An unknown reason is shown VERBATIM; "nothing was written" only when
  // Core's own text says so.
  return {
    kind: "aborted",
    title: reason.endsWith(NOTHING_WRITTEN_SUFFIX)
      ? "Not applied — Core refused; nothing was written"
      : "Not applied — Core reported no partial write",
    reason: reasonText(reason),
    action: "Core's reason is shown as it sent it.",
    tone: "attention",
    reReview: false,
    details: conflicted,
  };
}

/** The lost-answer copy (§3.6 item 8): never "nothing was changed". */
export function lostAnswerTitle(repoPath: string | undefined): string {
  return `Core did not answer in time — the apply may have been applied; check \`git status\` in ${repoText(repoPath)} before retrying`;
}

/**
 * Proxy codes raised BEFORE the frame is written to Core's socket (connect,
 * trust check, frame validation). The proxy marks every failure after the
 * write `mayHaveBeenApplied` (`after_write`), so these count only without it.
 */
const PRE_WRITE_PROXY_CODES: ReadonlySet<string> = new Set([
  "CORE_UNREACHABLE",
  "SOCKET_UNTRUSTED",
  "CORE_REFUSED_CONNECTION",
  "VALIDATION_FAILED",
  "FRAME_TOO_LARGE",
]);

/**
 * True only with POSITIVE evidence that the frame never left this desktop:
 * a preflight refusal (it names a `field`), the webview's encode-side frame
 * cap (it names a `byteLength`), the method allowlist, or a pre-write proxy
 * code without `mayHaveBeenApplied`. Everything else may have reached Core.
 */
function provablyNotSent(error: CoreRequestError): boolean {
  if (error.mayHaveBeenApplied) return false;
  const details =
    typeof error.details === "object" && error.details !== null ? (error.details as Record<string, unknown>) : {};
  const proxyCode = typeof details.proxyCode === "string" ? details.proxyCode : null;
  if (proxyCode !== null) return PRE_WRITE_PROXY_CODES.has(proxyCode);
  return (
    (error.code === "INVALID_PARAMS" && typeof details.field === "string") ||
    (error.code === "FRAME_TOO_LARGE" && typeof details.byteLength === "number") ||
    error.code === "METHOD_NOT_ALLOWED"
  );
}

function withoutAppliedSuffix(message: string): string {
  for (const suffix of [MAY_HAVE_BEEN_APPLIED_COPY, PROXY_MAY_HAVE_BEEN_APPLIED_SUFFIX]) {
    if (message.endsWith(suffix)) return message.slice(0, -suffix.length).trimEnd();
  }
  return message;
}

export function isWriterLockConflict(message: string): boolean {
  return message.includes(F.lockedInfix) && message.endsWith(F.lockedSuffix);
}

export function isMountBeingCreatedConflict(message: string): boolean {
  return message.includes(F.lockedInfix) && message.endsWith(F.mountBeingCreatedSuffix);
}

export function isDirectMountConflict(message: string): boolean {
  return message.endsWith(F.mountedSuffix);
}

/** Copy for a failed `git.apply` exchange (an error, not an `ApplyResult`). */
export function applyFailureCopy(err: unknown, repoPath: string | undefined): ApplyCopy {
  const error = asCoreRequestError(err);
  const raw = withoutAppliedSuffix(error.message);
  const reason = reasonText(raw);
  const repo = repoText(repoPath);
  const base = { reason, details: [] as string[], reReview: false };
  if (error.isCoreError) {
    const nothingWritten = raw.endsWith(NOTHING_WRITTEN_SUFFIX);
    if (error.code === "CONFLICT" && isMountBeingCreatedConflict(raw)) {
      return {
        ...base,
        kind: "refused",
        title: "Not applied — a direct-mount sandbox is being created for this repository; nothing was written",
        action:
          "Once it exists, every apply to this repository is refused until it is stopped or removed. Stop or remove that sandbox before applying.",
        tone: "attention",
      };
    }
    if (error.code === "CONFLICT" && isWriterLockConflict(raw)) {
      return {
        ...base,
        kind: "refused",
        title: "Not applied — the repository is busy; nothing was written",
        action:
          "Another writer holds this repository's lock (a running writer task, another apply or a worktree discard). Apply again after it finishes.",
        tone: "attention",
      };
    }
    if (error.code === "CONFLICT" && isDirectMountConflict(raw)) {
      return {
        ...base,
        kind: "refused",
        title: "Not applied — a sandbox mounts this repository directly; nothing was written",
        action:
          "Stop or remove that sandbox (or the direct_mount task Core names) first. Until then every apply to this repository is refused.",
        tone: "attention",
      };
    }
    if (error.code === "VALIDATION_FAILED") {
      if (raw === MSG_NEEDS_REVIEW || raw === MSG_SELECTED_FILES) {
        return {
          ...base,
          kind: "refused",
          title: "Not applied — Core needs entries from a review; nothing was written",
          action: "Review again, select the files, and apply from that review.",
          tone: "attention",
          reReview: true,
        };
      }
      if (raw === MSG_TOO_MANY_ENTRIES) {
        return {
          ...base,
          kind: "refused",
          title: "Not applied — too many files at once; nothing was written",
          action: `Select at most ${MAX_APPLY_ENTRIES} files per apply.`,
          tone: "attention",
        };
      }
    }
    // The abort texts, should Core ever send one as an error rather than an
    // `ApplyResult`: the same copy and the same "Review again" offer.
    const rule = nothingWritten ? ABORT_RULES.find((candidate) => candidate.test(raw)) : undefined;
    if (rule !== undefined) {
      return {
        ...base,
        kind: "refused",
        title: rule.title,
        action: rule.action,
        tone: "attention",
        reReview: rule.reReview === true,
      };
    }
    if (error.code === "NOT_FOUND") {
      return {
        ...base,
        kind: "refused",
        title: "Not applied — Core does not know this task",
        action: "Re-read the task list; the task may have been removed.",
        tone: "attention",
      };
    }
    if (nothingWritten) {
      return {
        ...base,
        kind: "refused",
        title: `Not applied — Core refused (${String(error.code)}); nothing was written`,
        action: "Core's reason is shown as it sent it.",
        tone: "attention",
      };
    }
    // e.g. INTERNAL "git ran, but Core could not record the outcome": the
    // apply MAY have run. Core's text is shown verbatim; nothing is added.
    return {
      ...base,
      kind: "unknown",
      title: `Core reported ${String(error.code)} — the apply may have been applied; check \`git status\` in ${repo} before retrying`,
      action: "Do not retry until you have checked the repository. Review again afterwards.",
      tone: "danger",
    };
  }
  if (provablyNotSent(error)) {
    return {
      ...base,
      kind: "not-sent",
      title: "Not sent — this desktop did not deliver the apply to Core; nothing was written",
      action: "Check the Core connection, then try again.",
      tone: "attention",
    };
  }
  if (error.code === "TIMEOUT") {
    return {
      ...base,
      kind: "unknown",
      title: lostAnswerTitle(repoPath),
      reason: null,
      action: "Core's whole apply budget is 41 s; its answer did not arrive within 45 s. Review again after checking.",
      tone: "danger",
    };
  }
  return {
    ...base,
    kind: "unknown",
    title: `The answer from Core was lost — the apply may have been applied; check \`git status\` in ${repo} before retrying`,
    action: `This desktop reported ${String(error.code)}. Review again after checking.`,
    tone: "danger",
  };
}
