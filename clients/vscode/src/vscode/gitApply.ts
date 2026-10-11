/**
 * Pure helpers for A6 (`git.apply` for reviewed files, design 2026-10-09
 * §3.6). No `vscode` import.
 *
 * The flow they serve (wired in `session.ts`): ONE `git.review` answer → the
 * user picks entries (only applicable ones are pickable) → a native modal
 * names the repository, lists every selected file and flags (a) content not
 * fully seen, (b) executable files, (c) paths that run automatically → only
 * the explicit "Apply N files" button sends `git.apply {taskId,
 * expectedBase, reviewId, entries}` with the entries copied VERBATIM.
 *
 * Copy rules: Core text is revealed and capped; a partial result is never
 * success and never "nothing written"; a lost answer says the apply MAY have
 * happened; nothing claims more than Core said.
 */

import { CoreRpcError, CoreTransportError } from '../core-client/connection';
import { CoreValidationError } from '../core-client/commands';
import { isProvablyUnsent } from '../core-client/idempotency';
import { FILE_CHANGE_STATUSES } from '../core-client/protocol';
import type { ApplyResult, ChangeSet, CoreFeature, FileChange, GitDiffResult, ModeChange } from '../core-client/protocol';
import { APPLY_EVENT_KINDS } from '../core-client/events';
import { plainText } from '../text/visibleText';
import { changeLabel, labelText } from './gitDiff';

export { MAX_APPLY_ENTRIES } from '../core-client/commands';
export { APPLY_EVENT_KINDS };

/** The feature an A6 Core advertises (`sandpane_protocol::FEATURES`). */
export const GIT_APPLY_FEATURE: CoreFeature = 'git-apply';

// --- Core's exact messages (sandpane-core apply.rs; drift-tested) ---------

const NOTHING_WRITTEN = '; nothing was written';
export const MSG_NEEDS_REVIEW =
  'git.apply needs reviewId and a non-empty entries list copied from a git.review answer; nothing was written';
export const MSG_SELECTED_FILES =
  'selectedFiles is not accepted: send reviewId and entries copied from a git.review answer instead; nothing was written';
export const MSG_TOO_MANY_ENTRIES = 'at most 1000 entries can be applied at once; nothing was written';
export const MSG_ENTRIES_NOT_REVIEWED = 'entries do not match a review Core produced; review again; nothing was written';
export const MSG_DIRECT_MOUNT =
  'this task worked directly in your repository; its changes are already in your working tree, so there is ' +
  'nothing to apply; nothing was written';
export const MSG_CHECK_FAILED = 'the patch does not apply cleanly; nothing was written';
export const MSG_PATCH_TOO_LARGE =
  'the selected changes are too large to apply in one step (the patch exceeds 64 MiB); nothing was written';
export const MSG_PREPARE_TOO_SLOW =
  'preparing the apply took longer than its 20 s budget; apply fewer files at once; nothing was written';
export const MSG_CONTENT_TOO_LARGE =
  'the selected files hold more than 64 MiB of new content, too much to apply in one step; apply fewer files at ' +
  'once; nothing was written';
export const MSG_WRITE_NOT_RUN =
  "git apply was not started (reading the repository's configuration timed out or failed); nothing was written";
export const MSG_WRITE_TOO_LATE =
  'git apply was not started (too little of its time budget was left to finish it safely); nothing was written';
export const MSG_CHECK_UNAVAILABLE = 'git could not check the patch (timed out or failed); nothing was written';
export const MSG_HOST_UNBORN = "your repository has no commit, so it is not at the task's base; nothing was written";
export const MSG_HOST_WORK_TREE_REDIRECTED =
  "git does not place your repository's work tree at its root (is a repository-local core.worktree set?); " +
  'nothing was written';

/**
 * Core's formatted messages, `{}` marking each value Core inserts (paths are
 * Rust-debug-quoted). Matched by their fixed parts only; drift-tested against
 * the `format!` strings of apply.rs / git_apply.rs.
 */
export const APPLY_TEMPLATES = {
  changed: `{} changed since it was reviewed; review it again${NOTHING_WRITTEN}`,
  listed_twice: `{} is listed more than once in entries${NOTHING_WRITTEN}`,
  no_content:
    '{} has no reviewed content id (it was over the 32 MiB apply cap, or not a file Core could read, when it was ' +
    `reviewed), so it is too large or unsupported to apply${NOTHING_WRITTEN}`,
  symlink: `{}: symlinks are never applied${NOTHING_WRITTEN}`,
  gitlink: `{}: submodule entries (gitlinks) are never applied${NOTHING_WRITTEN}`,
  base_symlink: `{} is a symlink in the base commit; deleting or replacing a tracked symlink is not supported${NOTHING_WRITTEN}`,
  collision: `{}: the content appears to be part of a SHA-1 collision attack${NOTHING_WRITTEN}`,
  snapshot_differs: `{}: the snapshot differs from the reviewed entries${NOTHING_WRITTEN}`,
  leading_path: `{} lies under a symlink or a file in your working tree${NOTHING_WRITTEN}`,
  dirty: `{} in your working tree have uncommitted changes or are untracked or ignored files${NOTHING_WRITTEN}`,
  hidden: `{} are flagged assume-unchanged or skip-worktree in your index, which hides changes${NOTHING_WRITTEN}`,
  filtered:
    '{} has the filter attribute {} (for example Git LFS) in your repository; Core never runs filters, so it would ' +
    `receive raw content${NOTHING_WRITTEN}`,
  head_moved: `your repository's HEAD is {}, not the task's base {}${NOTHING_WRITTEN}`,
  expected_base: `base diverged: the task's recorded base is {}, the client expected {}${NOTHING_WRITTEN}`,
  write_failed:
    "the write failed after git's checks passed; some files may have been written or staged — check `git status` in {}",
  write_killed:
    "the write failed after git's checks passed; some files may have been written or staged — check `git status` in {}" +
    '; `.git/index.lock` may remain — remove it only after checking that no git process is running',
  verify_unavailable: 'could not verify the staged content — check `git status` in {}',
  verify_failed: 'files were changed, but the staged content differs from the reviewed content — check `git status` in {}',
  mounted: `{}: a sandbox mounts this repository directly and can change it while Core writes; stop or remove it first${NOTHING_WRITTEN}`,
  mount_being_created:
    `{} is busy: sandbox {} is being created with a direct mount of it and could change it while Core writes${NOTHING_WRITTEN}`,
  locked:
    `{} is busy: {} holds its writer lock (a running writer task, another apply or a worktree discard)${NOTHING_WRITTEN}`,
  no_git_context: `task has no Git context (repo binding + base_commit)${NOTHING_WRITTEN}`,
} as const;

type TemplateKind = keyof typeof APPLY_TEMPLATES;

/** Does `text` fit `template` (fixed parts in order, `{}` = any value)? */
export function matchesTemplate(text: string, template: string): boolean {
  const parts = template.split('{}');
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  if (parts.length === 1) return text === template;
  if (!text.startsWith(first) || !text.endsWith(last) || text.length < first.length + last.length) return false;
  let at = first.length;
  const end = text.length - last.length;
  for (const middle of parts.slice(1, -1)) {
    const found = text.indexOf(middle, at);
    if (found < 0 || found + middle.length > end) return false;
    at = found + middle.length;
  }
  return true;
}

export type ApplyAbortKind =
  | 'not_reviewed'
  | 'changed'
  | 'listed_twice'
  | 'no_content'
  | 'symlink'
  | 'gitlink'
  | 'base_symlink'
  | 'collision'
  | 'snapshot_differs'
  | 'leading_path'
  | 'dirty'
  | 'hidden'
  | 'filtered'
  | 'head_moved'
  | 'expected_base'
  | 'check_failed'
  | 'check_unavailable'
  | 'content_too_large'
  | 'patch_too_large'
  | 'prepare_too_slow'
  | 'write_not_run'
  | 'direct_mount'
  | 'no_git_context'
  | 'unborn'
  | 'redirected'
  | 'unknown';

const EXACT_REASONS: [string, ApplyAbortKind][] = [
  [MSG_ENTRIES_NOT_REVIEWED, 'not_reviewed'],
  [MSG_CHECK_FAILED, 'check_failed'],
  [MSG_CHECK_UNAVAILABLE, 'check_unavailable'],
  [MSG_CONTENT_TOO_LARGE, 'content_too_large'],
  [MSG_PATCH_TOO_LARGE, 'patch_too_large'],
  [MSG_PREPARE_TOO_SLOW, 'prepare_too_slow'],
  [MSG_WRITE_NOT_RUN, 'write_not_run'],
  [MSG_WRITE_TOO_LATE, 'write_not_run'],
  [MSG_DIRECT_MOUNT, 'direct_mount'],
  [MSG_HOST_UNBORN, 'unborn'],
  [MSG_HOST_WORK_TREE_REDIRECTED, 'redirected'],
  [APPLY_TEMPLATES.no_git_context, 'no_git_context'],
];

/** Templates for non-partial aborts, most specific first. */
const ABORT_TEMPLATES: [TemplateKind, ApplyAbortKind][] = [
  ['changed', 'changed'],
  ['listed_twice', 'listed_twice'],
  ['no_content', 'no_content'],
  ['symlink', 'symlink'],
  ['gitlink', 'gitlink'],
  ['base_symlink', 'base_symlink'],
  ['collision', 'collision'],
  ['snapshot_differs', 'snapshot_differs'],
  ['leading_path', 'leading_path'],
  ['dirty', 'dirty'],
  ['hidden', 'hidden'],
  ['filtered', 'filtered'],
  ['head_moved', 'head_moved'],
  ['expected_base', 'expected_base'],
];

/** Which of Core's abort reasons `reason` is (exact constants, then templates). */
export function classifyAbortReason(reason: string): ApplyAbortKind {
  for (const [text, kind] of EXACT_REASONS) if (reason === text) return kind;
  for (const [template, kind] of ABORT_TEMPLATES) if (matchesTemplate(reason, APPLY_TEMPLATES[template])) return kind;
  return 'unknown';
}

/** Honest copy per abort kind (Core said "nothing was written" for each). */
const ABORT_COPY: Record<Exclude<ApplyAbortKind, 'unknown'>, string> = {
  not_reviewed:
    'Core does not recognize this review any more (it keeps reviews in memory only, so a Core restart forgets them), ' +
    'or the entries did not match it. Nothing was written. Review again.',
  changed: 'A selected file changed in the task worktree after you reviewed it, so Core refused. Nothing was written. Review again.',
  listed_twice: 'A path was listed twice in the request, so Core refused. Nothing was written.',
  no_content:
    'An entry had no reviewed content id (it was over the 32 MiB apply cap or unreadable when reviewed). Nothing was written.',
  symlink: 'Symlinks are never applied. Nothing was written.',
  gitlink: 'Submodule entries (gitlinks) are never applied. Nothing was written.',
  base_symlink:
    'A selected path is a symlink in the base commit; deleting or replacing a tracked symlink is not supported. Nothing was written.',
  collision: 'Core found content that appears to be part of a SHA-1 collision attack. Nothing was written.',
  snapshot_differs:
    "Core's snapshot did not match the reviewed entries exactly (for example a file/directory swap). Nothing was written.",
  leading_path:
    'A selected path lies under a symlink or a file in your working tree, so writing it could land outside the ' +
    'repository. Nothing was written.',
  dirty:
    'Some selected paths have uncommitted changes in your working tree, or are untracked or ignored files there. Core ' +
    'never overwrites your work. Nothing was written. Commit, stash or move them first.',
  hidden:
    'Some selected paths are flagged assume-unchanged or skip-worktree in your index, which hides changes. Nothing was written.',
  filtered:
    'A selected path has a filter attribute (for example Git LFS) in your repository; Core never runs filters. Nothing was written.',
  head_moved:
    "Your repository's HEAD is no longer the task's base commit. Nothing was written. Check out the base commit first.",
  expected_base: "The base this client sent is not the task's recorded base. Nothing was written. Review again.",
  check_failed: 'The patch does not apply cleanly to your working tree. Nothing was written.',
  check_unavailable:
    'Git could not check the patch (it timed out or failed). This is not a verdict that the patch conflicts. Nothing was written.',
  content_too_large: 'The selected files hold more than 64 MiB of new content. Nothing was written. Apply fewer files at once.',
  patch_too_large: 'The patch exceeds 64 MiB. Nothing was written. Apply fewer files at once.',
  prepare_too_slow: 'Preparing the apply took longer than its 20 s budget. Nothing was written. Apply fewer files at once.',
  write_not_run: 'git apply was never started. Nothing was written.',
  direct_mount:
    'This task worked directly in your repository; its changes are already in your working tree, so there is nothing to ' +
    'apply. Nothing was written.',
  no_git_context:
    'This task has no Git context in Core (no repository binding and base commit), so there is nothing to apply. Nothing ' +
    'was written. Tasks created over the wire have none in this build.',
  unborn: "Your repository has no commit, so it is not at the task's base. Nothing was written.",
  redirected:
    "Git does not place your repository's work tree at its root (a repository-local core.worktree may be set). Nothing was written.",
};

/** Aborts after which a fresh review is offered (§3.6 item 5 of the brief). */
const RE_REVIEW_KINDS: ReadonlySet<ApplyAbortKind> = new Set<ApplyAbortKind>(['not_reviewed', 'changed']);

// --- user-facing constants ------------------------------------------------

export const REVIEW_AGAIN = 'Review again';
export const BINDING_SENTENCE =
  'Writes these files into your working tree and stages them. Nothing is committed. The content is the version Core ' +
  'hashed when you reviewed.';
export const APPLY_NOT_IMPLEMENTED =
  'Apply is not implemented by the attached Sandpane Core (it does not advertise "git-apply"); nothing was sent.';
export const NO_REVIEW_ID =
  "Core did not issue a review id for this task's changes, so they cannot be applied: Core issues one only for tasks " +
  'that worked in a host worktree. Nothing was sent.';
export const APPLY_IN_FLIGHT =
  'An apply is already in progress (review, selection, confirmation or Core’s answer). Wait for it to finish; ' +
  'nothing else was sent.';
export const CORE_RESTARTED =
  'Core restarted since this review (Core keeps reviews in memory only), so the review is no longer valid — review ' +
  'again. Nothing was sent.';
export const MALFORMED_REVIEW = "Core's git.review answer was not in the expected shape; nothing was sent.";

export const REASON_SYMLINK = 'symlinks are never applied';
export const REASON_TOO_LARGE = 'too large or unreadable to apply (over 32 MiB)';
export const REASON_NO_CONTENT_ID = 'no reviewed content id';

const MAX_PATH = 500;
const MAX_REASON = 1_000;

/** A repository name for copy: revealed and capped, or an honest stand-in. */
export function repoLabel(repoPath: string | null | undefined): string {
  return typeof repoPath === 'string' && repoPath.length > 0
    ? plainText(repoPath, MAX_PATH)
    : "the task's repository (Core did not name it)";
}

/** A file for modal / notification text: revealed (no QuickPick `$(` handling needed). */
export function plainChangeLabel(change: Pick<FileChange, 'path' | 'oldPath'>): string {
  const path = plainText(change.path, MAX_PATH);
  return typeof change.oldPath === 'string' && change.oldPath.length > 0
    ? `${plainText(change.oldPath, MAX_PATH)} → ${path}`
    : path;
}

export function applyButtonLabel(count: number): string {
  return `Apply ${count} ${count === 1 ? 'file' : 'files'}`;
}

// --- decode ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Shape check of a `git.review` answer for the apply flow. The change entries
 * are kept as the SAME objects Core sent (they are sent back verbatim);
 * the A6 optional fields are open strings — a non-string is read as absent.
 */
export function parseApplyChangeSet(raw: unknown): ChangeSet | null {
  if (!isRecord(raw)) return null;
  if (typeof raw['baseCommit'] !== 'string' || typeof raw['hostDirty'] !== 'boolean') return null;
  const changes = raw['changes'];
  if (!Array.isArray(changes)) return null;
  for (const change of changes) {
    if (!isRecord(change) || typeof change['path'] !== 'string' || typeof change['status'] !== 'string') return null;
  }
  const uninspected = raw['uninspected'];
  return {
    taskId: typeof raw['taskId'] === 'string' ? raw['taskId'] : '',
    baseCommit: raw['baseCommit'],
    hostDirty: raw['hostDirty'],
    changes: [...(changes as FileChange[])],
    ...(nonEmpty(raw['repoPath']) ? { repoPath: raw['repoPath'] } : {}),
    ...(Array.isArray(uninspected) ? { uninspected: uninspected.filter((p): p is string => typeof p === 'string') } : {}),
    ...(nonEmpty(raw['reviewId']) ? { reviewId: raw['reviewId'] } : {}),
    ...(nonEmpty(raw['hostHooksPath']) ? { hostHooksPath: raw['hostHooksPath'] } : {}),
  };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}

/** Shape check of a `git.apply` answer; `null` = malformed (never echoed). */
export function parseApplyResult(raw: unknown): ApplyResult | null {
  if (!isRecord(raw) || typeof raw['applied'] !== 'boolean') return null;
  const reason = raw['abortReason'];
  if (reason !== undefined && reason !== null && typeof reason !== 'string') return null;
  const conflicted = raw['conflictedFiles'] === undefined ? [] : stringArray(raw['conflictedFiles']);
  if (conflicted === null) return null;
  const out: ApplyResult = { applied: raw['applied'], conflictedFiles: conflicted };
  if (typeof reason === 'string') out.abortReason = reason;
  if (raw['appliedFiles'] !== undefined && raw['appliedFiles'] !== null) {
    const files = stringArray(raw['appliedFiles']);
    if (files === null) return null;
    out.appliedFiles = files;
  }
  if (raw['modeChanges'] !== undefined && raw['modeChanges'] !== null) {
    const list = raw['modeChanges'];
    if (!Array.isArray(list)) return null;
    const changes: ModeChange[] = [];
    for (const item of list) {
      if (!isRecord(item) || typeof item['path'] !== 'string' || typeof item['from'] !== 'string' || typeof item['to'] !== 'string') {
        return null;
      }
      changes.push({ path: item['path'], from: item['from'], to: item['to'] });
    }
    out.modeChanges = changes;
  }
  const tree = raw['snapshotTree'];
  if (tree !== undefined && tree !== null) {
    if (typeof tree !== 'string') return null;
    out.snapshotTree = tree;
  }
  const partial = raw['partial'];
  if (partial !== undefined && partial !== null) {
    if (typeof partial !== 'boolean') return null;
    out.partial = partial;
  }
  return out;
}

// --- selection --------------------------------------------------------------

/**
 * Why `change` cannot be applied, or `null` when it can: a `deleted` entry,
 * or one with both `taskBlob` and `taskMode` that is not a symlink.
 */
export function entrySelectability(change: FileChange): string | null {
  const status: unknown = change.status;
  if (!(FILE_CHANGE_STATUSES as readonly unknown[]).includes(status)) {
    return `status "${labelText(String(status)).slice(0, 40)}" is not understood by this client`;
  }
  if (status === 'deleted') return null;
  const blob: unknown = change.taskBlob;
  const mode: unknown = change.taskMode;
  if (mode === '120000') return REASON_SYMLINK;
  if (nonEmpty(blob) && nonEmpty(mode)) return null;
  if (blob === undefined && mode === undefined) return REASON_TOO_LARGE;
  return REASON_NO_CONTENT_ID;
}

/** What the user saw of one entry in the Diff view (this session, this Core). */
export interface DiffRecord {
  taskBlob?: string;
  taskMode?: string;
  binary: boolean;
  truncated: boolean;
  lossy: boolean;
}

type DiffLike = DiffRecord | Pick<GitDiffResult, 'binary' | 'truncated' | 'lossy' | 'taskBlob' | 'taskMode'>;

/** §3.6 item 9: an opened diff showed other content than the entry binds. */
export function diffMismatch(change: FileChange, record: DiffLike | undefined): boolean {
  if (!record) return false;
  if (typeof record.taskBlob === 'string' && record.taskBlob !== change.taskBlob) return true;
  return typeof record.taskMode === 'string' && typeof change.taskMode === 'string' && record.taskMode !== change.taskMode;
}

/** Flag (a): why the user has not fully seen this entry's content, or null. */
export function notFullyShownReason(change: FileChange, record: DiffLike | undefined): string | null {
  if (!record) return 'never opened in the Diff view this session';
  if (record.binary) return 'binary — no text diff was shown';
  if (record.truncated) return 'its diff was truncated';
  if (record.lossy) return 'its diff had bytes that are not valid UTF-8 (shown with replacement characters)';
  if (change.status !== 'deleted' && typeof record.taskBlob !== 'string') {
    return 'the diff Core showed carried no content id, so it is not bound to the reviewed content';
  }
  return null;
}

/** Flag (b): an executable file (addition or exec-bit change). */
export function executableReason(change: FileChange): string | null {
  return change.taskMode === '100755' ? 'executable (mode 100755)' : null;
}

const AUTO_DIRS = ['.husky', '.githooks', '.vscode', '.idea'];
const AUTO_FILES = ['.envrc', '.gitattributes', '.gitmodules'];

function autoRunReason(path: string, hooksPath: string | null): string | null {
  const parts = path.toLowerCase().split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    if (AUTO_DIRS.includes(part)) return `under ${part}/`;
    if (AUTO_FILES.includes(part)) return part;
    if (part === '.github' && parts[i + 1] === 'workflows') return 'under .github/workflows/';
  }
  if (hooksPath !== null) {
    const lower = path.toLowerCase();
    if (hooksPath === '.' ? !lower.includes('/') : lower === hooksPath || lower.startsWith(`${hooksPath}/`)) {
      return 'under the repository’s core.hooksPath';
    }
  }
  return null;
}

/**
 * Flag (c): paths that run automatically (hooks, CI, editor/IDE tasks, direnv,
 * git attributes/modules), matched on path components, case-insensitively,
 * for `path` and a rename's `oldPath`; plus Core's repo-relative
 * `hostHooksPath` as a prefix.
 */
export function runsAutomaticallyReason(change: FileChange, hostHooksPath?: string | null): string | null {
  const hooks =
    typeof hostHooksPath === 'string'
      ? hostHooksPath.toLowerCase().replace(/^(\.\/)+/, '').replace(/\/+$/, '')
      : '';
  const hooksPath = hooks.length > 0 ? hooks : null;
  for (const path of [change.path, change.oldPath]) {
    if (typeof path !== 'string' || path.length === 0) continue;
    const reason = autoRunReason(path, hooksPath);
    if (reason !== null) return reason;
  }
  return null;
}

/**
 * In-memory record of the `git.diff` answers the user opened (never
 * persisted). Keyed by task, status and the EXACT path (JSON-encoded, so a
 * tab or newline in a path cannot collide); bounded; cleared when a new Core
 * instance is seen.
 */
export class ReviewedDiffs {
  private instance: string | null | undefined = undefined;
  private readonly records = new Map<string, DiffRecord>();

  constructor(private readonly max = 500) {}

  private static key(taskId: string, change: Pick<FileChange, 'path' | 'status'>): string {
    return JSON.stringify([taskId, change.status, change.path]);
  }

  /** Drop every record when the Core instance changed. */
  sync(instanceId: string | null): void {
    if (this.instance !== undefined && this.instance !== instanceId) this.records.clear();
    this.instance = instanceId;
  }

  record(taskId: string, result: GitDiffResult): void {
    const key = ReviewedDiffs.key(taskId, result);
    this.records.delete(key);
    this.records.set(key, {
      binary: result.binary,
      truncated: result.truncated,
      lossy: result.lossy,
      ...(typeof result.taskBlob === 'string' ? { taskBlob: result.taskBlob } : {}),
      ...(typeof result.taskMode === 'string' ? { taskMode: result.taskMode } : {}),
    });
    while (this.records.size > this.max) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  get(taskId: string, change: Pick<FileChange, 'path' | 'status'>): DiffRecord | undefined {
    return this.records.get(ReviewedDiffs.key(taskId, change));
  }

  forget(taskId: string, change: Pick<FileChange, 'path' | 'status'>): void {
    this.records.delete(ReviewedDiffs.key(taskId, change));
  }
}

export interface ApplyPickItem {
  label: string;
  description?: string;
  picked: boolean;
  /** The one header row above the entries that cannot be applied (a QuickPick separator). */
  separator: boolean;
  /** False for an entry shown only to say why it cannot be applied (checking it has no effect). */
  applicable: boolean;
  /** The ORIGINAL review entry (sent verbatim when picked and applicable). */
  entry?: FileChange;
}

export interface ApplyPickPlan {
  items: ApplyPickItem[];
  selectable: FileChange[];
  disabled: { entry: FileChange; reason: string }[];
}

/** Header of the rows that cannot be applied. */
export const NOT_APPLICABLE_HEADER = 'cannot be applied \u2014 checking these has no effect; nothing of them is sent';

/**
 * Picker rows for ONE review: applicable entries first (none checked up
 * front), then — under one header — every entry that cannot be applied, as a
 * row of its own with the reason. VS Code has no disabled QuickPick item and
 * (1.90 quickInputTree) draws a button-less separator only as the label of
 * the row after it, so a trailing separator per entry would vanish; these rows
 * are therefore ordinary rows that are INERT: checking one sends nothing, and
 * the confirmation lists it as "not sent". Every label goes through
 * `labelText` (`$(` broken).
 */
export function applyPickPlan(
  changeSet: ChangeSet,
  diffFor: (change: FileChange) => DiffLike | undefined,
): ApplyPickPlan {
  const selectable: FileChange[] = [];
  const disabled: { entry: FileChange; reason: string }[] = [];
  const items: ApplyPickItem[] = [];
  for (const entry of changeSet.changes) {
    const reason = entrySelectability(entry);
    if (reason !== null) {
      disabled.push({ entry, reason });
      continue;
    }
    selectable.push(entry);
    const flags = [
      notFullyShownReason(entry, diffFor(entry)) !== null ? 'not fully shown' : null,
      executableReason(entry) !== null ? 'executable' : null,
      runsAutomaticallyReason(entry, changeSet.hostHooksPath) !== null ? 'runs automatically' : null,
    ].filter((f): f is string => f !== null);
    items.push({
      label: changeLabel(entry),
      description: labelText([String(entry.status), ...flags].join(' \u00b7 ')),
      picked: false,
      separator: false,
      applicable: true,
      entry,
    });
  }
  if (disabled.length > 0) {
    items.push({ label: NOT_APPLICABLE_HEADER, picked: false, separator: true, applicable: false });
    for (const { entry, reason } of disabled) {
      items.push({
        label: labelText(`(cannot be applied) ${changeLabel(entry)}`),
        description: labelText(`${String(entry.status)} \u00b7 not selectable: ${reason}`),
        picked: false,
        separator: false,
        applicable: false,
        entry,
      });
    }
  }
  return { items, selectable, disabled };
}

/** Checked rows that cannot be applied (inert): what the user is told. */
function notApplicableCopyRaw(ignored: { entry: FileChange; reason: string }[]): string {
  const shown = ignored.slice(0, 10).map(({ entry, reason }) => `${plainChangeLabel(entry)} (${reason})`).join('; ');
  const more = ignored.length > 10 ? ` (and ${ignored.length - 10} more)` : '';
  return `None of the checked entries can be applied: ${shown}${more}. Nothing was sent.`;
}

// --- confirmation -----------------------------------------------------------

export interface ApplyConfirmationInput {
  taskId: string;
  repoPath: string | null | undefined;
  hostDirty: boolean;
  hostHooksPath: string | null | undefined;
  entries: FileChange[];
  diffFor: (change: FileChange) => DiffLike | undefined;
  /** Checked rows that cannot be applied: listed as NOT sent. */
  ignored?: { entry: FileChange; reason: string }[];
}

export interface ApplyConfirmationView {
  message: string;
  detail: string;
  button: string;
}

function flagSection(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [`${title}: none`] : [`${title} (${lines.length}):`, ...lines];
}

/**
 * The native modal (§3.6 item 9): the repository, EVERY selected file with
 * its status (revealed; renames `old → new`), flags (a)/(b)/(c) in separate
 * sections (each says "none" when empty), and the binding sentence.
 */
/** The modal lists at most this many files; beyond it the full list opens in the editor. */
export const MODAL_LIST_CAP = 50;
/** Title of the read-only full-list document (`sandpane-apply:` scheme). */
export const APPLY_LIST_TITLE = 'Sandpane: files to apply';
/** Scheme of the read-only full-list documents (in memory, never on disk). */
export const APPLY_LIST_SCHEME = 'sandpane-apply';

/** Repository line, binding sentence, file lines and flag sections (shared by modal and document). */
function confirmationLines(input: ApplyConfirmationInput, cap: number | null): string[] {
  const repo = repoLabel(input.repoPath);
  const count = input.entries.length;
  const a: string[] = [];
  const b: string[] = [];
  const c: string[] = [];
  for (const entry of input.entries) {
    const label = plainChangeLabel(entry);
    const shown = notFullyShownReason(entry, input.diffFor(entry));
    if (shown !== null) a.push(`\u00b7 ${label} \u2014 ${shown}`);
    const exec = executableReason(entry);
    if (exec !== null) b.push(`\u00b7 ${label} \u2014 ${exec}`);
    const auto = runsAutomaticallyReason(entry, input.hostHooksPath);
    if (auto !== null) c.push(`\u00b7 ${label} \u2014 ${auto}`);
  }
  const listed = cap !== null && count > cap ? input.entries.slice(0, cap) : input.entries;
  return [
    `Repository: ${repo}`,
    BINDING_SENTENCE,
    ...(input.hostDirty
      ? [
          'Core reports uncommitted changes somewhere in this repository. It refuses the apply if any selected path has ' +
            'uncommitted changes or is an untracked or ignored file; your other edits are never touched.',
        ]
      : []),
    '',
    `Files (${count}):`,
    ...listed.map((entry) => `\u00b7 ${plainText(String(entry.status), 40)} ${plainChangeLabel(entry)}`),
    ...(listed.length < count
      ? [`\u2026 and ${count - listed.length} more \u2014 the full list is open in the editor ("${APPLY_LIST_TITLE}")`]
      : []),
    '',
    // Flags are never capped.
    ...flagSection('(a) Content you have not fully seen', a),
    ...flagSection('(b) Executable', b),
    ...flagSection('(c) Runs automatically', c),
    ...(input.ignored && input.ignored.length > 0
      ? [
          '',
          `Checked but NOT sent \u2014 these cannot be applied (${input.ignored.length}):`,
          ...input.ignored.map(({ entry, reason }) => `\u00b7 ${plainChangeLabel(entry)} \u2014 ${reason}`),
        ]
      : []),
  ];
}

export function applyConfirmationView(input: ApplyConfirmationInput): ApplyConfirmationView {
  const repo = repoLabel(input.repoPath);
  const count = input.entries.length;
  return {
    message: `Apply ${count} ${count === 1 ? 'file' : 'files'} from task ${plainText(input.taskId, 200).slice(0, 8)} into ${repo}?`,
    detail: confirmationLines(input, MODAL_LIST_CAP).join('\n'),
    button: applyButtonLabel(count),
  };
}

/**
 * The FULL confirmation list for a read-only `sandpane-apply:` document,
 * opened before the modal when it lists more than `MODAL_LIST_CAP` files.
 * Revealed text only; nothing is written to disk.
 */
export function renderApplyListDocument(input: ApplyConfirmationInput): string {
  return [
    `# ${APPLY_LIST_TITLE} \u2014 read-only list of what the confirmation dialog would apply (task ${plainText(input.taskId, 200)}).`,
    '# Nothing is applied from this view; only the dialog and the typed number send git.apply.',
    '',
    ...confirmationLines(input, null),
    '',
  ].join('\n');
}

export const APPLY_LIST_GONE_TEXT =
  '# This Sandpane apply list is no longer available (only the most recent lists are kept in memory).\n' +
  '# Start the apply again to see it.\n';

/** V-W1: options of the typed second step (exact N, never pre-filled). */
export interface TypedConfirmationOptions {
  ignoreFocusOut: true;
  title: string;
  prompt: string;
  validateInput: (value: string) => string | null;
}

export function typedConfirmation(count: number, repoPath: string | null | undefined): TypedConfirmationOptions {
  const expected = String(count);
  return {
    ignoreFocusOut: true,
    title: noIcons(`Apply ${count} ${count === 1 ? 'file' : 'files'} to ${repoLabel(repoPath)}`),
    prompt: `Type ${expected} to write and stage these files. Nothing is committed.`,
    validateInput: (value: string) => (value === expected ? null : `Type ${expected} to apply, or press Escape to cancel`),
  };
}

/** Only the exact number confirms; Escape / focus loss (`undefined`) or anything else does not. */
export function typedConfirmed(value: string | undefined, count: number): boolean {
  return value === String(count);
}

export const TYPED_NOT_CONFIRMED = 'Apply not confirmed (the number was not typed); nothing was sent.';

/** `$(` would render a codicon in notifications, titles and QuickPicks: break it visibly. */
export function noIcons(text: string): string {
  return text.replace(/\$\(/g, '$ (');
}

/** The diff/entry mismatch refusal (§3.6 item 9): nothing is sent. */
function mismatchCopyRaw(entries: FileChange[]): string {
  const names = entries.slice(0, 10).map(plainChangeLabel).join(', ');
  const more = entries.length > 10 ? ` (and ${entries.length - 10} more)` : '';
  return `${names}${more} changed after you reviewed it — review again. Nothing was sent.`;
}

// --- results and errors -----------------------------------------------------

export interface ApplyOutcomeView {
  tone: 'ok' | 'warning' | 'error';
  text: string;
  /** Offer "Review again" (a fresh git.review; the selection is discarded). */
  reReview: boolean;
}

function coreSaid(reason: string): string {
  return `Core said: ${plainText(reason, MAX_REASON)}`;
}

function fileList(files: string[], max = 20): string {
  const shown = files.slice(0, max).map((f) => plainText(f, MAX_PATH)).join(', ');
  return files.length > max ? `${shown} (and ${files.length - max} more)` : shown;
}

/** The outcome of an ANSWERED `git.apply` (shape-checked first). */
function applyResultViewRaw(result: ApplyResult, ctx: { repoPath: string | null | undefined; selected: number }): ApplyOutcomeView {
  const repo = repoLabel(ctx.repoPath);
  const reason = typeof result.abortReason === 'string' && result.abortReason.length > 0 ? result.abortReason : null;
  if (result.applied) {
    const count = Array.isArray(result.appliedFiles) ? result.appliedFiles.length : ctx.selected;
    const modes = Array.isArray(result.modeChanges) && result.modeChanges.length > 0
      ? ` Mode changes: ${result.modeChanges
          .slice(0, 20)
          .map((m) => `${plainText(m.path, MAX_PATH)} ${plainText(m.from, 20)} → ${plainText(m.to, 20)}`)
          .join(', ')}${result.modeChanges.length > 20 ? ` (and ${result.modeChanges.length - 20} more)` : ''}.`
      : '';
    return {
      tone: 'ok',
      text: `Applied ${count} ${count === 1 ? 'file' : 'files'} to ${repo} (staged, not committed).${modes}`,
      reReview: false,
    };
  }
  if (result.partial === true) {
    const files = Array.isArray(result.appliedFiles) && result.appliedFiles.length > 0
      ? ` Files involved: ${fileList(result.appliedFiles)}.`
      : '';
    return {
      tone: 'warning',
      text:
        `Apply INCOMPLETE — Core reports that some files may have been written or staged in ${repo}. ` +
        `Check \`git status\` there before doing anything else.${files}\n\n${reason !== null ? coreSaid(reason) : 'Core gave no reason.'}`,
      reReview: false,
    };
  }
  const conflicts = result.conflictedFiles.length > 0 ? ` Conflicting files: ${fileList(result.conflictedFiles)}.` : '';
  if (reason === null) {
    return { tone: 'error', text: `Core did not apply the files and gave no reason.${conflicts}`, reReview: false };
  }
  const kind = classifyAbortReason(reason);
  const copy = kind === 'unknown' ? 'Core did not apply the files.' : `Not applied — ${ABORT_COPY[kind]}`;
  return { tone: 'error', text: `${copy}${conflicts}\n\n${coreSaid(reason)}`, reReview: RE_REVIEW_KINDS.has(kind) };
}

/** §3.6 item 8: the copy for a lost `git.apply` answer — never "nothing changed". */
function lostAnswerCopyRaw(repoPath: string | null | undefined): string {
  return `Core did not answer in time — the apply may have been applied; check \`git status\` in ${repoLabel(repoPath)} before retrying.`;
}

function rpcMessage(error: CoreRpcError): string {
  const prefix = `${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/**
 * Copy for a FAILED `git.apply` call. `null` ONLY when the frame provably
 * never left this client (a client-side validation refusal, not attached, an
 * untrusted socket, an unsupported platform) — the caller then says nothing
 * was sent. Every other failure means Core may have received the request, so
 * the copy never claims "nothing was sent".
 */
function applyErrorViewRaw(error: unknown, repoPath: string | null | undefined): ApplyOutcomeView | null {
  const repo = repoLabel(repoPath);
  if (error instanceof CoreValidationError || isProvablyUnsent(error)) return null;
  if (error instanceof CoreTransportError) {
    if (error.reason === 'timeout') return { tone: 'warning', text: lostAnswerCopyRaw(repoPath), reReview: false };
    return {
      tone: 'warning',
      text:
        `The connection to Core was lost before it answered \u2014 the apply may have been applied; check ` +
        `\`git status\` in ${repo} before retrying.`,
      reReview: false,
    };
  }
  if (!(error instanceof CoreRpcError)) {
    return {
      tone: 'warning',
      text:
        'The apply failed inside this client after the request may have been handed to Core \u2014 the apply may ' +
        `have been applied; check \`git status\` in ${repo} before retrying.`,
      reReview: false,
    };
  }
  const message = rpcMessage(error);
  switch (error.code) {
    case 'CONFLICT':
      if (matchesTemplate(message, APPLY_TEMPLATES.mount_being_created)) {
        return {
          tone: 'error',
          text:
            'Not applied \u2014 a direct-mount sandbox is being created for this repository, and it could change files ' +
            'while Core writes. Nothing was written; once it exists, every apply is refused until it is stopped or ' +
            'removed.\n\n' + coreSaid(message),
          reReview: false,
        };
      }
      if (matchesTemplate(message, APPLY_TEMPLATES.locked)) {
        return {
          tone: 'error',
          text:
            'Not applied — the repository is busy: another writer (a running writer task, another apply or a ' +
            'worktree discard) holds its lock. Nothing was written. Try again after it finishes.\n\n' + coreSaid(message),
          reReview: false,
        };
      }
      if (matchesTemplate(message, APPLY_TEMPLATES.mounted)) {
        return {
          tone: 'error',
          text:
            'Not applied — a sandbox or a direct_mount task mounts this repository directly and could change it ' +
            'while Core writes. Stop or remove that sandbox or task first (Core names it below). Nothing was written.\n\n' +
            coreSaid(message),
          reReview: false,
        };
      }
      return { tone: 'error', text: `Core refused the apply (CONFLICT).\n\n${coreSaid(message)}`, reReview: false };
    case 'VALIDATION_FAILED':
      if (message === MSG_TOO_MANY_ENTRIES) {
        return {
          tone: 'error',
          text: 'Not applied — at most 1000 entries can be applied at once. Nothing was written. Select fewer files.',
          reReview: false,
        };
      }
      if (message === MSG_NEEDS_REVIEW || message === MSG_SELECTED_FILES) {
        return {
          tone: 'error',
          text: `Not applied — Core refused the request shape. Nothing was written.\n\n${coreSaid(message)}`,
          reReview: false,
        };
      }
      return { tone: 'error', text: `Core refused the apply request (VALIDATION_FAILED).\n\n${coreSaid(message)}`, reReview: false };
    case 'NOT_FOUND':
      return {
        tone: 'error',
        text: `Core has no such task (it may have been deleted); nothing was applied.\n\n${coreSaid(message)}`,
        reReview: false,
      };
    case 'INTERNAL':
      return {
        tone: 'error',
        text:
          'Core reported an internal failure during the apply. Its message below says whether anything was written; ' +
          `if it does not, check \`git status\` in ${repo}.\n\n${coreSaid(message)}`,
        reReview: false,
      };
    default:
      // Core answered with another code: show it, claim nothing about writes.
      return {
        tone: 'error',
        text:
          `Core answered git.apply with an error (${plainText(error.code, 40)}). This client cannot tell more than Core's ` +
          `message below; if in doubt, check \`git status\` in ${repo}.\n\n${coreSaid(message)}`,
        reReview: false,
      };
  }
}

/** A malformed `git.apply` answer: Core answered, but what it did is unreadable. */
function malformedApplyCopyRaw(repoPath: string | null | undefined): string {
  return (
    "Core's git.apply answer was not in the expected shape, so this client cannot tell what happened — the apply " +
    `may have been applied; check \`git status\` in ${repoLabel(repoPath)}.`
  );
}

// --- I4: every notification text breaks `$(` (a codicon in VS Code UI) ---

/** The outcome of an ANSWERED `git.apply` (shape-checked first). */
export function applyResultView(result: ApplyResult, ctx: { repoPath: string | null | undefined; selected: number }): ApplyOutcomeView {
  const view = applyResultViewRaw(result, ctx);
  return { ...view, text: noIcons(view.text) };
}

/** See `applyErrorViewRaw`: `null` only when the frame provably never left. */
export function applyErrorView(error: unknown, repoPath: string | null | undefined): ApplyOutcomeView | null {
  const view = applyErrorViewRaw(error, repoPath);
  return view === null ? null : { ...view, text: noIcons(view.text) };
}

export function lostAnswerCopy(repoPath: string | null | undefined): string {
  return noIcons(lostAnswerCopyRaw(repoPath));
}

export function mismatchCopy(entries: FileChange[]): string {
  return noIcons(mismatchCopyRaw(entries));
}

export function notApplicableCopy(ignored: { entry: FileChange; reason: string }[]): string {
  return noIcons(notApplicableCopyRaw(ignored));
}

export function malformedApplyCopy(repoPath: string | null | undefined): string {
  return noIcons(malformedApplyCopyRaw(repoPath));
}

// --- V-W3: sandbox.create CONFLICTs Core words as "repository busy" ------------

/** `msg_create_repo_busy` / `msg_create_mount_in_progress` (git_apply.rs; drift-tested). */
export const CREATE_BUSY_TEMPLATES = {
  repo_busy:
    '{} is busy: {} holds its writer lock (a running writer task, an apply or a worktree discard), and a direct_mount ' +
    'sandbox could change it while that runs; try again when it finishes; nothing was created',
  mount_in_progress:
    '{} is busy: sandbox {} is being created with a direct mount of it; try again when that create finishes; nothing was created',
} as const;

export const CREATE_BUSY_COPY = 'Repository busy \u2014 nothing was created; try again when it finishes.';

/** The copy for a `sandbox.create` CONFLICT that is a busy repository, else `null`. */
export function createBusyCopy(error: unknown): string | null {
  if (!(error instanceof CoreRpcError) || error.code !== 'CONFLICT') return null;
  const message = rpcMessage(error);
  return matchesTemplate(message, CREATE_BUSY_TEMPLATES.repo_busy) || matchesTemplate(message, CREATE_BUSY_TEMPLATES.mount_in_progress)
    ? CREATE_BUSY_COPY
    : null;
}
