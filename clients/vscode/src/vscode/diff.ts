/**
 * Diff review (specs/03 §4 "Diff review — Core Git change set + vscode.diff").
 *
 * `buildDiffPlan` is a **pure argument builder**: it takes the ChangeSet Core
 * returned and produces the exact `vscode.diff` command + args, using the real
 * base revision recorded on the task. It never invents a revision, never
 * synthesizes content, and refuses when Core gave it nothing to compare. The
 * vscode-side caller (`reviewChanges` command) executes the returned plan.
 */

import type { ChangeSet, FileChange } from '../core-client/protocol';
import { plainText } from '../text/visibleText';

/**
 * A URI described by its parts, never by a pre-encoded string (review bug 1 /
 * security S5): `vscode.diff` needs real `Uri` objects, and building
 * `file:${encodeURI(path)}` strings mangles any path containing `#` or `?`
 * (encodeURI leaves both unescaped, so they become the fragment/query). The
 * extension side turns a spec into a `vscode.Uri` with `materializeUri`.
 */
export type UriSpec =
  | { scheme: 'file'; fsPath: string }
  /**
   * The built-in Git extension's revision URI: the file URI re-schemed to
   * `git` with query `{"path": <fsPath>, "ref": <sha>}` — the same shape its
   * own `toGitUri` produces.
   */
  | { scheme: 'git'; fsPath: string; ref: string };

export interface DiffCommandPlan {
  command: 'vscode.diff';
  /** [left/base, right/working, title] — the documented vscode.diff signature. */
  args: [UriSpec, UriSpec, string];
  warning?: string;
}

export interface OpenFilePlan {
  command: 'vscode.open';
  args: [UriSpec];
  note: string;
}

export type DiffPlan =
  | { ok: true; kind: 'diff'; plan: DiffCommandPlan }
  | { ok: true; kind: 'open'; plan: OpenFilePlan }
  | { ok: false; reason: string };

export interface ReviewedChange {
  change: FileChange;
  /** Repository-relative path for display; the plan holds the absolute URIs. */
  path: string;
  plan: DiffPlan;
}

export function fileSpec(fsPath: string): UriSpec {
  return { scheme: 'file', fsPath };
}

export function gitRevisionSpec(fsPath: string, ref: string): UriSpec {
  return { scheme: 'git', fsPath, ref };
}

/** The query the Git extension expects on a `git:` revision URI. */
export function gitRevisionQuery(fsPath: string, ref: string): string {
  return JSON.stringify({ path: fsPath, ref });
}

/** Minimal `vscode.Uri` surface, so materialization is testable without VS Code. */
export interface UriLike<U> {
  with(change: { scheme?: string; query?: string }): U;
}

export interface UriFactory<U> {
  file(fsPath: string): U & UriLike<U>;
}

/**
 * Build the real URI object: `Uri.file` (which escapes `#`, `?`, `%`, spaces
 * and Unicode correctly) and, for a revision, `.with({scheme:'git', query})`.
 * STATUS: that the installed `vscode.git` resolves the revision URI on this
 * host is an integration fact still to be verified — see README.
 */
export function materializeUri<U>(spec: UriSpec, factory: UriFactory<U>): U {
  const file = factory.file(spec.fsPath);
  if (spec.scheme === 'file') return file;
  return file.with({ scheme: 'git', query: gitRevisionQuery(spec.fsPath, spec.ref) });
}

/** Most diff editors one Review opens at once (security review S5). */
export const MAX_REVIEW_EDITORS = 10;

/**
 * Split the openable plans into the ones to open now and a count left closed,
 * so a 500-file change set cannot open 500 editors. The rest are reported.
 */
export function capReviewPlans<T>(items: readonly T[], max: number = MAX_REVIEW_EDITORS): {
  open: T[];
  notOpened: number;
} {
  const limit = Math.max(0, Math.floor(max));
  return { open: items.slice(0, limit), notOpened: Math.max(0, items.length - limit) };
}

function joinPath(repoRoot: string, relPath: string): string | null {
  const root = repoRoot.replace(/\/+$/, '');
  const rel = relPath.replace(/^\/+/, '');
  // Containment check before building any URI: a change set must not walk out
  // of the repository (specs/06 §4 — canonicalize and validate paths).
  if (rel.length === 0 || rel.split('/').some((seg) => seg === '..')) return null;
  return `${root}/${rel}`;
}

/** A git object id: abbreviated (7+) or full SHA-1 (40) / SHA-256 (64), lowercase hex. */
const COMMIT_ID = /^[0-9a-f]{7,64}$/;

export interface DiffPlanInput {
  repoRoot: string;
  changeSet: Pick<ChangeSet, 'baseCommit' | 'hostDirty' | 'taskId'>;
  change: FileChange;
}

export function buildDiffPlan(input: DiffPlanInput): DiffPlan {
  const { repoRoot, changeSet, change } = input;
  const baseCommit = changeSet.baseCommit?.trim() ?? '';
  if (baseCommit.length === 0) {
    return {
      ok: false,
      reason:
        'Core recorded no base commit for this task, so there is nothing to compare against. ' +
        'Opening a fabricated diff would be a made-up result (AGENTS.md rule 5).',
    };
  }
  if (!COMMIT_ID.test(baseCommit)) {
    // The value becomes the `ref` of a git: URI that vscode.git hands to git.
    // Only a plain object id is accepted — never a branch name, a range, an
    // option-looking string or a `rev:path` expression (review W5).
    return {
      ok: false,
      reason:
        `Core's recorded base "${baseCommit.slice(0, 80)}" is not a commit id (expected 7–64 lowercase ` +
        'hex characters), so no diff URI was built. Nothing was guessed in its place.',
    };
  }
  if (!repoRoot.startsWith('/')) {
    return {
      ok: false,
      reason: `repository root is not absolute ("${repoRoot}"); Core must report the canonical repo path.`,
    };
  }

  const fsPath = joinPath(repoRoot, change.path);
  if (fsPath === null) {
    return {
      ok: false,
      reason: `"${plainText(change.path, 300)}" is empty or escapes the repository root; no URI was built.`,
    };
  }
  const dirtyWarning = changeSet.hostDirty
    ? 'Host tree is dirty: these files may contain your own uncommitted work, and apply is ' +
      'blocked until that is resolved (specs/06 §6).'
    : undefined;
  // A5: review paths are EXACT (a real tab / newline may occur); the URI
  // keeps them byte-exact, the editor title shows them revealed on one line.
  const shownPath =
    change.status === 'renamed' && typeof change.oldPath === 'string' && change.oldPath.length > 0
      ? `${plainText(change.oldPath, 300)} \u2192 ${plainText(change.path, 300)}`
      : plainText(change.path, 300);
  const title = `${shownPath} (${shortRef(baseCommit)} \u2194 working tree)${changeSet.hostDirty ? ' \u00b7 host dirty' : ''}`;

  switch (change.status) {
    case 'untracked':
      // No base blob exists for an untracked file: show it, do not fake a diff.
      return {
        ok: true,
        kind: 'open',
        plan: {
          command: 'vscode.open',
          args: [fileSpec(fsPath)],
          note: 'Untracked file — it has no base revision, so it is opened instead of diffed.',
        },
      };
    case 'deleted':
      return {
        ok: true,
        kind: 'diff',
        plan: {
          command: 'vscode.diff',
          // Right side is the working-tree path, which no longer exists; VS Code
          // renders it empty — that *is* the deletion.
          args: [gitRevisionSpec(fsPath, baseCommit), fileSpec(fsPath), title],
          ...(dirtyWarning ? { warning: dirtyWarning } : {}),
        },
      };
    case 'renamed': {
      // A5: Core sends the pre-rename path; compare base(oldPath) with the
      // working tree at the new path. Without it (pre-A5 Core) refuse.
      const oldFsPath =
        typeof change.oldPath === 'string' && change.oldPath.length > 0 ? joinPath(repoRoot, change.oldPath) : null;
      if (oldFsPath === null) {
        return {
          ok: false,
          reason:
            typeof change.oldPath === 'string' && change.oldPath.length > 0
              ? 'the rename source is empty or escapes the repository root; no URI was built.'
              : `Core's ChangeSet carries no rename source (oldPath) for this entry, so the old name is ` +
                'unknown. A diff here would compare the wrong file.',
        };
      }
      return {
        ok: true,
        kind: 'diff',
        plan: {
          command: 'vscode.diff',
          args: [gitRevisionSpec(oldFsPath, baseCommit), fileSpec(fsPath), title],
          ...(dirtyWarning ? { warning: dirtyWarning } : {}),
        },
      };
    }
    case 'added':
    case 'modified':
      return {
        ok: true,
        kind: 'diff',
        plan: {
          command: 'vscode.diff',
          args: [gitRevisionSpec(fsPath, baseCommit), fileSpec(fsPath), title],
          ...(dirtyWarning ? { warning: dirtyWarning } : {}),
        },
      };
    default: {
      const _exhaustive: never = change.status;
      return _exhaustive;
    }
  }
}

export function buildChangeSetPlans(
  repoRoot: string,
  changeSet: ChangeSet,
): { reviewed: ReviewedChange[]; refused: { path: string; reason: string }[] } {
  const reviewed: ReviewedChange[] = [];
  const refused: { path: string; reason: string }[] = [];
  for (const change of changeSet.changes) {
    const plan = buildDiffPlan({ repoRoot, changeSet, change });
    if (plan.ok) reviewed.push({ change, path: change.path, plan });
    else refused.push({ path: change.path, reason: plan.reason });
  }
  return { reviewed, refused };
}

function shortRef(ref: string): string {
  return /^[0-9a-fA-F]{7,}$/.test(ref) ? ref.slice(0, 8) : ref;
}
