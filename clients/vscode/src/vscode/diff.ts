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

export interface DiffCommandPlan {
  command: 'vscode.diff';
  /** [left/base, right/working, title] — the documented vscode.diff signature. */
  args: [string, string, string];
  warning?: string;
}

export interface OpenFilePlan {
  command: 'vscode.open';
  args: [string];
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

/**
 * `git:` raw-content URI understood by the built-in Git extension
 * (`git:/absolute/path?{"path":"...","ref":"<sha>"}`).
 *
 * STATUS: the URI *shape* is unit-tested here; that the installed `vscode.git`
 * resolves it on this host is an integration fact still to be verified — see
 * README "Verified vs. pending" (specs/03 §6 has no remote/local diff case yet).
 */
export function gitRevisionUri(fsPath: string, ref: string): string {
  const query = encodeURIComponent(JSON.stringify({ path: fsPath, ref }));
  return `git:${encodeURI(fsPath)}?${query}`;
}

export function fileUri(fsPath: string): string {
  return `file:${encodeURI(fsPath)}`;
}

function joinPath(repoRoot: string, relPath: string): string | null {
  const root = repoRoot.replace(/\/+$/, '');
  const rel = relPath.replace(/^\/+/, '');
  // Containment check before building any URI: a change set must not walk out
  // of the repository (specs/06 §4 — canonicalize and validate paths).
  if (rel.length === 0 || rel.split('/').some((seg) => seg === '..')) return null;
  return `${root}/${rel}`;
}

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
      reason: `"${change.path}" is empty or escapes the repository root; no URI was built.`,
    };
  }
  const dirtyWarning = changeSet.hostDirty
    ? 'Host tree is dirty: these files may contain your own uncommitted work, and apply is ' +
      'blocked until that is resolved (specs/06 §6).'
    : undefined;
  const title = `${change.path} (${shortRef(baseCommit)} ↔ working tree)${changeSet.hostDirty ? ' · host dirty' : ''}`;

  switch (change.status) {
    case 'untracked':
      // No base blob exists for an untracked file: show it, do not fake a diff.
      return {
        ok: true,
        kind: 'open',
        plan: {
          command: 'vscode.open',
          args: [fileUri(fsPath)],
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
          args: [gitRevisionUri(fsPath, baseCommit), fileUri(fsPath), title],
          ...(dirtyWarning ? { warning: dirtyWarning } : {}),
        },
      };
    case 'renamed':
      return {
        ok: false,
        reason:
          `Core's ChangeSet carries a single "path" per change and no rename source, so the ` +
          'old name is unknown. A diff here would compare the wrong file. Renamed entries need a ' +
          'protocol field for the original path (P4 gap).',
      };
    case 'added':
    case 'modified':
      return {
        ok: true,
        kind: 'diff',
        plan: {
          command: 'vscode.diff',
          args: [gitRevisionUri(fsPath, baseCommit), fileUri(fsPath), title],
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
