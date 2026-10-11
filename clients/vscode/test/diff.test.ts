import { describe, expect, it } from 'vitest';
import {
  MAX_REVIEW_EDITORS,
  buildChangeSetPlans,
  buildDiffPlan,
  capReviewPlans,
  fileSpec,
  gitRevisionSpec,
  materializeUri,
  type UriFactory,
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
      expect(left).toEqual({ scheme: 'git', fsPath: `${REPO}/src/AuthService.ts`, ref: BASE });
      expect(right).toEqual({ scheme: 'file', fsPath: `${REPO}/src/AuthService.ts` });
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
      expect(result.plan.args[1]).toEqual({ scheme: 'file', fsPath: `${REPO}/src/Gone.ts` });
    }
  });

  it('refuses a renamed file when Core sent no old path (pre-A5 Core)', () => {
    const result = plan('renamed', 'src/NewName.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/rename/i);
  });

  it('A5: diffs a rename base(oldPath) \u2194 working(path) when Core sent oldPath', () => {
    const result = buildDiffPlan({
      repoRoot: REPO,
      changeSet: changeSet(),
      change: { path: 'src/NewName.ts', status: 'renamed', oldPath: 'src/OldName.ts' },
    });
    expect(result.ok && result.kind).toBe('diff');
    if (result.ok && result.kind === 'diff') {
      expect(result.plan.args[0]).toEqual({ scheme: 'git', fsPath: `${REPO}/src/OldName.ts`, ref: BASE });
      expect(result.plan.args[1]).toEqual({ scheme: 'file', fsPath: `${REPO}/src/NewName.ts` });
      expect(result.plan.args[2]).toContain('src/OldName.ts \u2192 src/NewName.ts');
    }
    const escaping = buildDiffPlan({
      repoRoot: REPO,
      changeSet: changeSet(),
      change: { path: 'src/NewName.ts', status: 'renamed', oldPath: '../outside.ts' },
    });
    expect(escaping.ok).toBe(false);
  });

  it('A5: exact review paths (real tab / newline, no C-quoting) join to the repo root byte-exact; the title is revealed', () => {
    const path = 'dir/new\nline\t"q".txt';
    const result = plan('modified', path);
    expect(result.ok && result.kind).toBe('diff');
    if (result.ok && result.kind === 'diff') {
      expect(result.plan.args[0]).toEqual({ scheme: 'git', fsPath: `${REPO}/${path}`, ref: BASE });
      expect(result.plan.args[1]).toEqual({ scheme: 'file', fsPath: `${REPO}/${path}` });
      // One visible line: the editor title never breaks on Core's newline.
      expect(result.plan.args[2]).not.toMatch(/[\n\t]/);
      expect(result.plan.args[2]).toContain('dir/new\\nline\\t"q".txt');
    }
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
    expect(materializeUri(fileSpec(`${REPO}/${path}`), fakeUri)).toMatchObject({ path: `${REPO}/${path}` });
    const result = buildDiffPlan({
      repoRoot: REPO,
      changeSet: changeSet(),
      change: change('modified', path),
    });
    expect(result.ok && result.kind === 'diff').toBe(true);
  });
});

/**
 * Stand-in for `vscode.Uri` with its documented component semantics: `file()`
 * keeps the filesystem path as the PATH component (nothing becomes a query or
 * fragment) and `with()` replaces only the named components. It is a test
 * double for VS Code, not the unit under test (materializeUri / the plans).
 */
interface FakeUri {
  scheme: string;
  path: string;
  query: string;
  fragment: string;
}
const fakeUri: UriFactory<FakeUri> = {
  file(fsPath: string) {
    const make = (u: FakeUri): FakeUri & { with(c: { scheme?: string; query?: string }): FakeUri } => ({
      ...u,
      with: (c) => make({ ...u, ...(c.scheme ? { scheme: c.scheme } : {}), ...(c.query !== undefined ? { query: c.query } : {}) }),
    });
    return make({ scheme: 'file', path: fsPath, query: '', fragment: '' });
  },
};

describe('URI materialization (review bug 1 / security S5)', () => {
  it.each([
    'src/a#b.ts',
    'src/what?.ts',
    'src/100%.ts',
    'src/路径/файл с space.ts',
  ])('keeps "%s" entirely in the path component — no fragment, no stray query', (rel) => {
    const fsPath = `${REPO}/${rel}`;
    const file = materializeUri(fileSpec(fsPath), fakeUri);
    expect(file).toMatchObject({ scheme: 'file', path: fsPath, query: '', fragment: '' });

    const git = materializeUri(gitRevisionSpec(fsPath, BASE), fakeUri);
    expect(git.scheme).toBe('git');
    expect(git.path).toBe(fsPath);
    expect(git.fragment).toBe('');
    expect(JSON.parse(git.query)).toEqual({ path: fsPath, ref: BASE });
  });

  it('every plan argument is a spec, never a pre-encoded string', () => {
    const result = plan('modified', 'src/a#b?.ts');
    expect(result.ok && result.kind === 'diff').toBe(true);
    if (result.ok && result.kind === 'diff') {
      const [left, right] = result.plan.args;
      expect(typeof left).toBe('object');
      expect(typeof right).toBe('object');
      expect(left.fsPath).toBe(`${REPO}/src/a#b?.ts`);
    }
  });
});

describe('review editor cap (security S5)', () => {
  it('opens at most the cap and reports how many were left closed', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    expect(capReviewPlans(items, 10)).toEqual({ open: items.slice(0, 10), notOpened: 15 });
    expect(capReviewPlans(items.slice(0, 3), 10)).toEqual({ open: [0, 1, 2], notOpened: 0 });
    expect(capReviewPlans(items).open).toHaveLength(MAX_REVIEW_EDITORS);
    expect(capReviewPlans(items, -1)).toEqual({ open: [], notOpened: 25 });
  });
});

describe('base commit validation before building a git: ref (review W5)', () => {
  it.each(['HEAD', 'main', '--output=/tmp/x', 'b71995f..HEAD', 'b71995fc1e0f4a3c8f0d7b1a2e3c4d5e6f708192:secret', 'abc12', 'B71995FC', 'g'.repeat(40), 'a'.repeat(65)])(
    'refuses %s with an honest reason and builds no URI',
    (base) => {
      const result = plan('modified', 'src/A.ts', { baseCommit: base });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/not a commit id/i);
    },
  );

  it('accepts abbreviated and full lowercase hex object ids (SHA-1 and SHA-256)', () => {
    for (const base of ['b71995f', BASE, 'a'.repeat(64)]) {
      expect(plan('modified', 'src/A.ts', { baseCommit: base }).ok).toBe(true);
    }
  });
});
