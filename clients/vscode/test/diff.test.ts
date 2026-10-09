import { describe, expect, it } from 'vitest';
import {
  buildChangeSetPlans,
  buildDiffPlan,
  fileUri,
  gitRevisionUri,
} from '../src/vscode/diff';
import type { ChangeSet, FileChange } from '../src/core-client/protocol';

const BASE = 'b71995fc1e0f4a3c8f0d7b1a2e3c4d5e6f708192';
const REPO = '/repo/atlas';

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    taskId: 't1',
    baseCommit: BASE,
    hostDirty: false,
    changes: [],
    ...overrides,
  };
}

function change(status: FileChange['status'], path: string): FileChange {
  return { path, status };
}

function plan(status: FileChange['status'], path: string, overrides: Partial<ChangeSet> = {}) {
  return buildDiffPlan({
    repoRoot: REPO,
    changeSet: changeSet(overrides),
    change: change(status, path),
  });
}

describe('vscode.diff argument builder', () => {
  it('builds [base revision, working tree, title] from real Core data', () => {
    const result = plan('modified', 'src/AuthService.ts');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'diff') {
      expect(result.plan.command).toBe('vscode.diff');
      expect(result.plan.args).toHaveLength(3);
      const [left, right, title] = result.plan.args;
      expect(left.startsWith(`git:${REPO}/src/AuthService.ts?`)).toBe(true);
      expect(left).toContain(encodeURIComponent(JSON.stringify({ path: `${REPO}/src/AuthService.ts`, ref: BASE })));
      expect(right).toBe(`file:${REPO}/src/AuthService.ts`);
      expect(title).toContain('b71995fc');
      expect(title).toContain('working tree');
    }
  });

  it('adds the dirty-host warning when Core reports the host is dirty', () => {
    const result = plan('added', 'src/New.ts', { hostDirty: true });
    expect(result.ok && result.kind === 'diff' && result.plan.warning).toMatch(/dirty/i);
  });

  it('does not fabricate a diff for an untracked file', () => {
    const result = plan('untracked', 'notes.txt');
    expect(result.ok && result.kind).toBe('open');
    if (result.ok && result.kind === 'open') {
      expect(result.plan.command).toBe('vscode.open');
      expect(result.plan.note).toMatch(/no base revision/i);
    }
  });

  it('diffs a deleted file against the base blob', () => {
    const result = plan('deleted', 'src/Gone.ts');
    expect(result.ok && result.kind === 'diff').toBe(true);
    if (result.ok && result.kind === 'diff') {
      expect(result.plan.args[1]).toBe(`file:${REPO}/src/Gone.ts`);
    }
  });

  it('refuses a renamed file because the ChangeSet has no old path', () => {
    const result = plan('renamed', 'src/NewName.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/rename/i);
  });

  it('refuses when Core recorded no base commit', () => {
    const result = plan('modified', 'src/A.ts', { baseCommit: '  ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/fabricated/i);
  });

  it('refuses a non-absolute repository root', () => {
    const result = buildDiffPlan({
      repoRoot: 'repo/atlas',
      changeSet: changeSet(),
      change: change('modified', 'src/A.ts'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not absolute/);
  });

  it('refuses a path that escapes the repository root', () => {
    const result = plan('modified', '../../etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/escapes the repository root/);
  });

  it('splits a whole change set into openable and refused parts', () => {
    const set = changeSet({
      changes: [
        change('modified', 'src/A.ts'),
        change('untracked', 'scratch.txt'),
        change('renamed', 'src/B.ts'),
        change('deleted', 'src/C.ts'),
      ],
    });
    const { reviewed, refused } = buildChangeSetPlans(REPO, set);
    expect(reviewed.map((r) => r.change.status)).toEqual(['modified', 'untracked', 'deleted']);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.path).toBe('src/B.ts');
  });

  it('keeps Unicode and spaces intact in the URIs it builds', () => {
    const path = 'src/路径/файл с space.ts';
    const uri = fileUri(`${REPO}/${path}`);
    expect(uri.startsWith('file:')).toBe(true);
    expect(gitRevisionUri(`${REPO}/${path}`, BASE)).toContain(encodeURIComponent(JSON.stringify({ path: `${REPO}/${path}`, ref: BASE })));
    const result = buildDiffPlan({
      repoRoot: REPO,
      changeSet: changeSet(),
      change: change('modified', path),
    });
    expect(result.ok && result.kind === 'diff').toBe(true);
  });
});
