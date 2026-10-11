/**
 * Pure helpers for A5 (`git.diff` + ChangeSet fields, design 2026-10-09 §3.5).
 * No `vscode` import.
 *
 * The patch is UNTRUSTED, display-only text: it is shown in a read-only
 * virtual document (`sandpane-diff:` scheme, `diff` language), never rendered
 * as HTML or Markdown, never executed, never applied and never written into
 * the user's repository. File names come from the JSON `path` / `oldPath`
 * only, never from the patch header (a name containing ` b/` is ambiguous
 * there). Hidden, bidi and line-separator characters are revealed.
 */

import { CoreRpcError, CoreTransportError } from '../core-client/connection';
import { FILE_CHANGE_STATUSES } from '../core-client/protocol';
import type { ChangeSet, FileChange, GitDiffResult } from '../core-client/protocol';
import { inspectHidden, plainText } from '../text/visibleText';

/** Scheme of the read-only virtual patch documents. */
export const PATCH_SCHEME = 'sandpane-diff';

// --- Core's exact messages (sandpane-service lib.rs / sandpane-core) ---
export const MSG_TASK_NOT_FOUND = 'task not found';
export const MSG_NO_GIT_CONTEXT = 'task has no Git context (repo binding + base_commit)';
export const MSG_WORKTREE_REMOVED = "the task's worktree was removed (discarded); there is nothing left to review";
export const MSG_WORK_TREE_REDIRECTED =
  "git does not place this task's work tree at its recorded directory (is a repository-local " +
  'core.worktree set?); nothing was read';
export const MSG_DIFF_PATH_NOT_IN_LIST = "path is not in this task's change list; nothing was read";
export const MSG_DIFF_PATH_LISTED_TWICE =
  "path is listed more than once in this task's change list; pass its status; nothing was read";
export const MSG_DIFF_PATH_NOT_EXACT =
  'this path is not valid UTF-8, so Core cannot name the file exactly; nothing was read';
/** `GitError::SubmodulesPresent` starts with this (paths and counts follow). */
export const SUBMODULE_PREFIX = 'repository contains submodule(s) ';
/** Untracked reads: Core formats `"{rel:?}<suffix>"`. */
export const UNTRACKED_CHANGED_SUFFIX = ' changed while it was being read; nothing was read';
export const UNTRACKED_REFUSAL_SUFFIXES = [
  ' is not a plain path inside the review target; nothing was read',
  ' is a directory (for example a nested repository); nothing was read',
  ' is not a regular file; nothing was read',
] as const;

// --- disclosures ---
export const BINARY_DISCLOSURE = 'treated as binary (possibly by repository attributes) \u2014 no text diff shown';
export const LOSSY_DISCLOSURE = 'contains bytes that are not valid UTF-8; shown with replacement characters';
export function truncatedDisclosure(maxBytes: number): string {
  return `diff truncated at ${maxBytes} bytes \u2014 the last hunk header may promise more lines than are shown`;
}
export const DIFF_TIMEOUT_COPY = 'Core did not answer in time \u2014 no file was changed (git.diff is read-only).';
const REVIEW_TIMEOUT_COPY = 'Core did not answer in time \u2014 no file was changed (git.review is read-only).';
export const MALFORMED_DIFF_COPY = "Core's git.diff answer was not in the expected shape; nothing is shown.";

/** Display caps (revealed, then capped). */
const MAX_PATH_CHARS = 500;
const MAX_TARGET_CHARS = 500;

function rpcMessage(error: CoreRpcError): string {
  const prefix = `${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/**
 * Honest copy for `git.review` / `git.diff` failures Core names exactly, or
 * `null` (the caller reports it generically). Every Core refusal here says
 * "nothing was read"; so does the copy.
 */
export function gitErrorCopy(error: unknown, operation: 'git.review' | 'git.diff' = 'git.diff'): string | null {
  if (error instanceof CoreTransportError && error.reason === 'timeout') {
    return operation === 'git.diff' ? DIFF_TIMEOUT_COPY : REVIEW_TIMEOUT_COPY;
  }
  if (!(error instanceof CoreRpcError)) return null;
  const message = rpcMessage(error);
  if (error.code === 'NOT_FOUND' && message === MSG_TASK_NOT_FOUND) {
    return 'Core has no such task (it may have been deleted); nothing was read.';
  }
  if (error.code !== 'VALIDATION_FAILED') return null;
  switch (message) {
    case MSG_NO_GIT_CONTEXT:
      return (
        'This task has no Git context in Core (no repository binding and base commit), so there is ' +
        'nothing to compare; no diff is shown. Tasks created over the wire have none in this build.'
      );
    case MSG_WORKTREE_REMOVED:
      return "The task's worktree was removed (discarded); there is nothing left to review.";
    case MSG_WORK_TREE_REDIRECTED:
      return (
        "Git does not place this task's work tree where Core recorded it (a repository-local " +
        'core.worktree may be set), so Core refused; nothing was read.'
      );
    case MSG_DIFF_PATH_NOT_IN_LIST:
      return "This file is no longer in the task's change list (it may have changed since the review); nothing was read. Run the review again.";
    case MSG_DIFF_PATH_LISTED_TWICE:
      return 'Core lists this path more than once and could not tell which entry was meant; nothing was read.';
    case MSG_DIFF_PATH_NOT_EXACT:
      return 'This path is not valid UTF-8, so Core cannot name the file exactly; nothing was read.';
    default:
      break;
  }
  if (message.startsWith(SUBMODULE_PREFIX)) {
    return 'The repository contains submodules; Sandpane refuses to review it rather than risk a partial answer. Nothing was read.';
  }
  if (message.endsWith(UNTRACKED_CHANGED_SUFFIX)) {
    return 'The file changed while Core was reading it; nothing was read. Try again.';
  }
  if (UNTRACKED_REFUSAL_SUFFIXES.some((suffix) => message.endsWith(suffix))) {
    return 'Core refused to read this entry: it is not a regular file inside the task\u2019s work tree; nothing was read.';
  }
  return null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

/**
 * Shape check for an untrusted `git.diff` answer. Returns only the documented
 * fields, or `null` — the caller reports `MALFORMED_DIFF_COPY` and never
 * echoes the payload.
 */
export function parseGitDiffResult(raw: unknown): GitDiffResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['path'] !== 'string' || typeof r['patch'] !== 'string') return null;
  if (!(FILE_CHANGE_STATUSES as readonly unknown[]).includes(r['status'])) return null;
  if (typeof r['binary'] !== 'boolean' || typeof r['truncated'] !== 'boolean' || typeof r['lossy'] !== 'boolean') return null;
  if (!optionalString(r['oldPath']) || !optionalString(r['baseBlob'])) return null;
  return {
    path: r['path'],
    status: r['status'] as GitDiffResult['status'],
    patch: r['patch'],
    binary: r['binary'],
    truncated: r['truncated'],
    lossy: r['lossy'],
    ...(typeof r['oldPath'] === 'string' ? { oldPath: r['oldPath'] } : {}),
    ...(typeof r['baseBlob'] === 'string' ? { baseBlob: r['baseBlob'] } : {}),
  };
}

/** A change-list entry for a picker / listing: revealed, one line; renames as `old → new`. */
export function changeLabel(change: Pick<FileChange, 'path' | 'oldPath'>): string {
  const path = plainText(change.path, MAX_PATH_CHARS);
  return typeof change.oldPath === 'string' && change.oldPath.length > 0
    ? `${plainText(change.oldPath, MAX_PATH_CHARS)} \u2192 ${path}`
    : path;
}

/** What a review/apply surface must add about the change set itself. */
export function changeSetNotes(changeSet: ChangeSet): string[] {
  const notes: string[] = [];
  if (typeof changeSet.repoPath === 'string' && changeSet.repoPath.length > 0) {
    notes.push(`repository (from Core): ${plainText(changeSet.repoPath, MAX_PATH_CHARS)}`);
  }
  const uninspected = Array.isArray(changeSet.uninspected) ? changeSet.uninspected.length : 0;
  if (uninspected > 0) {
    notes.push(`${uninspected} paths were not inspected \u2014 this change list is NOT complete`);
  }
  return notes;
}

/**
 * The link target of a synthesized untracked symlink patch (`new file mode
 * 120000`): its single `+` line is the target TEXT, never the target's
 * content. `null` for anything else.
 */
export function symlinkTarget(patch: string): string | null {
  const lines = patch.split('\n');
  if (!lines.some((line) => line === 'new file mode 120000')) return null;
  const hunk = lines.findIndex((line) => line.startsWith('@@'));
  if (hunk < 0) return null;
  const target = lines.slice(hunk + 1).find((line) => line.startsWith('+'));
  return target === undefined ? null : target.slice(1);
}

/**
 * One patch line made safe to look at: every hidden / bidi / control / line-
 * separator character is escaped (`\uXXXX`) EXCEPT the tab, which is real
 * patch content. `altered` marks the line for the disclosure count.
 */
function revealPatchLine(line: string): { text: string; altered: boolean; crlf: boolean } {
  let altered = false;
  // A CRLF line ending is common, not suspicious: shown as a visible `\r`
  // but counted separately from hidden / bidi characters.
  const crlf = line.endsWith('\r');
  const content = crlf ? line.slice(0, -1) : line;
  const text = content
    .split('\t')
    .map((segment) => {
      const revealed = inspectHidden(segment);
      altered = altered || revealed.altered;
      return revealed.text;
    })
    .join('\t');
  return { text: crlf ? `${text}\\r` : text, altered, crlf };
}

export interface PatchDocumentInput {
  taskId: string;
  result: GitDiffResult;
  /** The byte limit that applied (Core's default when none was sent). */
  maxBytes: number;
}

/** The read-only document text: a disclosure header, then the revealed patch. */
export function renderPatchDocument(input: PatchDocumentInput): { text: string; hiddenLines: number } {
  const { result } = input;
  let hiddenLines = 0;
  let crlfLines = 0;
  const body = result.patch.length === 0
    ? []
    : result.patch.replace(/\n$/, '').split('\n').map((line) => {
        const revealed = revealPatchLine(line);
        if (revealed.altered) hiddenLines += 1;
        if (revealed.crlf) crlfLines += 1;
        return revealed.text;
      });
  const target = symlinkTarget(result.patch);
  const header = [
    '# Sandpane \u2014 Core git.diff for one file (read-only, display only): this patch is never applied, run or written to your repository.',
    `# task: ${plainText(input.taskId, 200)}`,
    `# path: ${changeLabel(result)}`,
    `# status: ${result.status}`,
    ...(typeof result.baseBlob === 'string' && result.baseBlob.length > 0
      ? [`# base blob: ${plainText(result.baseBlob, 200).slice(0, 12)}`]
      : []),
    ...(target !== null ? [`# symlink \u2192 ${plainText(target, MAX_TARGET_CHARS)} (the link text, not the target's content)`] : []),
    ...(result.binary ? [`# ${BINARY_DISCLOSURE}`] : []),
    ...(result.truncated ? [`# ${truncatedDisclosure(input.maxBytes)}`] : []),
    ...(result.lossy ? [`# ${LOSSY_DISCLOSURE}`] : []),
    ...(hiddenLines > 0
      ? [`# ${hiddenLines} line(s) contained hidden, bidi or control characters; they are shown as \\uXXXX escapes`]
      : []),
    ...(crlfLines > 0 ? [`# ${crlfLines} line(s) end with CR (CRLF line endings), shown as \\r`] : []),
    '# File names above come from Core\u2019s JSON fields, not from the patch header.',
    '',
  ];
  return { text: [...header, ...body, ''].join('\n'), hiddenLines };
}

/** Most patch documents kept in memory; older ones are dropped (and say so). */
export const MAX_PATCH_DOCUMENTS = 20;

export const PATCH_GONE_TEXT =
  '# This Sandpane patch view is no longer available (only the most recent patches are kept in memory).\n' +
  '# Run "Sandpane: Show Task Patch" again.\n';

/**
 * In-memory backing store of the `sandpane-diff:` content provider: no temp
 * files, nothing on disk. Bounded; an evicted or unknown document returns an
 * honest note instead of stale or invented content.
 */
export class PatchDocumentStore {
  private counter = 0;
  private readonly docs = new Map<string, string>();

  put(label: string, text: string): { path: string } {
    this.counter += 1;
    const base = (label.split('/').pop() ?? 'patch').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'patch';
    const path = `/${this.counter}/${base}.diff`;
    this.docs.set(path, text);
    while (this.docs.size > MAX_PATCH_DOCUMENTS) {
      const oldest = this.docs.keys().next().value;
      if (oldest === undefined) break;
      this.docs.delete(oldest);
    }
    return { path };
  }

  provideTextDocumentContent(uri: { path: string }): string {
    return this.docs.get(uri.path) ?? PATCH_GONE_TEXT;
  }
}
