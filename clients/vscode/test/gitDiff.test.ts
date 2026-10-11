/**
 * A5 (design 2026-10-09 §3.5): `git.diff` + ChangeSet fields.
 *  - wire: `{taskId, path, status}` with the path passed byte-exact, `status`
 *    always sent, `maxBytes` omitted by default and never above Core's cap;
 *  - deadlines: git.diff and git.review get the 45 s git deadline;
 *  - drift: exact Core messages, maxBytes bounds, wire fields;
 *  - display: the patch is untrusted text — revealed (hidden/bidi characters
 *    visible, tabs kept), every flag disclosed, renames as `old → new`,
 *    symlinks as `symlink → target`; names come from JSON, never the header;
 *  - copy: each exact refusal maps to honest copy that says nothing was read.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CoreCommands,
  CoreValidationError,
  GIT_QUERY_TIMEOUT_MS,
  PROJECT_GIT_TIMEOUT_MS,
  clampDiffBytes,
} from '../src/core-client/commands';
import { CoreRpcError, CoreTransportError } from '../src/core-client/connection';
import type { ErrorCode } from '../src/core-client/events';
import { DEFAULT_DIFF_BYTES, MAX_DIFF_BYTES, PROTOCOL_VERSION } from '../src/core-client/protocol';
import type { ChangeSet, GitDiffResult } from '../src/core-client/protocol';
import {
  BINARY_DISCLOSURE,
  DIFF_TIMEOUT_COPY,
  LOSSY_DISCLOSURE,
  MAX_PATCH_DOCUMENTS,
  MSG_DIFF_PATH_LISTED_TWICE,
  MSG_DIFF_PATH_NOT_EXACT,
  MSG_DIFF_PATH_NOT_IN_LIST,
  MSG_NO_GIT_CONTEXT,
  MSG_TASK_NOT_FOUND,
  MSG_WORKTREE_REMOVED,
  MSG_WORK_TREE_REDIRECTED,
  PATCH_SCHEME,
  PatchDocumentStore,
  UNTRACKED_CHANGED_SUFFIX,
  UNTRACKED_REFUSAL_SUFFIXES,
  SUBMODULE_PREFIX,
  changeLabel,
  changeSetNotes,
  gitErrorCopy,
  parseGitDiffResult,
  renderPatchDocument,
  symlinkTarget,
} from '../src/vscode/gitDiff';
import { makeHarness } from './helpers/fakeCore';

const repoRoot = resolve(process.cwd(), '..', '..');
const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), 'utf8');
const rustProtocol = read('core/crates/sandpane-protocol/src/lib.rs');
const serviceLib = read('core/crates/sandpane-service/src/lib.rs');
const diffRs = read('core/crates/sandpane-core/src/diff.rs');
const gitRs = read('core/crates/sandpane-core/src/git.rs');

const rpc = (code: string, message: string): CoreRpcError =>
  new CoreRpcError({ code: code as ErrorCode, message }, 'r1');

/** A Rust `pub const NAME: &str = "…";`, with `\`-newline continuations joined. */
function rustConst(source: string, name: string): string {
  const m = new RegExp(`pub const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)";`).exec(source);
  if (!m?.[1]) throw new Error(`no \`pub const ${name}\``);
  return m[1].replace(/\\\n\s*/g, '');
}

async function frameOf(call: (c: CoreCommands) => Promise<unknown>) {
  const h = makeHarness();
  await h.conn.connect();
  const commands = new CoreCommands(h.conn);
  const before = h.transport.writes.length;
  const promise = call(commands).catch((error: unknown) => error);
  await Promise.resolve();
  if (h.transport.writes.length === before) return { frame: undefined, error: await promise };
  const frame = h.transport.lastRequest();
  h.transport.respond({ v: PROTOCOL_VERSION, id: frame.id, ok: {} });
  await promise;
  return { frame, error: undefined };
}

function result(overrides: Partial<GitDiffResult> = {}): GitDiffResult {
  return {
    path: 'src/a.ts',
    status: 'modified',
    patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    binary: false,
    truncated: false,
    lossy: false,
    ...overrides,
  };
}

describe('A5 wire: git.diff', () => {
  it('sends {taskId, path, status} with the path byte-exact (tab, quote, newline, non-ASCII, leading space)', async () => {
    const path = ' src/we\u0131rd\t"name"\nline \u00E9\u4E2D.txt ';
    const { frame } = await frameOf((c) => c.gitDiff({ taskId: 't1', path, status: 'untracked' }));
    expect(frame).toEqual({ v: PROTOCOL_VERSION, id: 'test-1', method: 'git.diff', params: { taskId: 't1', path, status: 'untracked' } });
    // Byte-exact on the wire: the JSON round-trip returns the identical string.
    expect((frame?.params as { path: string }).path).toBe(path);
  });

  it('always sends status; omits maxBytes unless given; clamps it to Core\'s 1..=524288 like Core', async () => {
    const base = { taskId: 't1', path: 'a', status: 'deleted' as const };
    expect((await frameOf((c) => c.gitDiff(base))).frame?.params).toEqual(base);
    expect((await frameOf((c) => c.gitDiff({ ...base, maxBytes: 4096 }))).frame?.params).toEqual({ ...base, maxBytes: 4096 });
    expect(((await frameOf((c) => c.gitDiff({ ...base, maxBytes: 10_000_000 }))).frame?.params as Record<string, unknown>)['maxBytes']).toBe(MAX_DIFF_BYTES);
    expect(((await frameOf((c) => c.gitDiff({ ...base, maxBytes: 0 }))).frame?.params as Record<string, unknown>)['maxBytes']).toBe(1);
    expect(clampDiffBytes(undefined)).toBeUndefined();
    expect(clampDiffBytes(2.7)).toBe(2);
  });

  it('refuses a status Core does not know and a non-string path, before any frame (no other path checks)', async () => {
    for (const bad of [
      { taskId: 't1', path: 'a', status: 'copied' },
      { taskId: 't1', path: 7, status: 'added' },
      { taskId: '', path: 'a', status: 'added' },
    ]) {
      const { frame, error } = await frameOf((c) => c.gitDiff(bad as never));
      expect(frame, JSON.stringify(bad)).toBeUndefined();
      expect(error).toBeInstanceOf(CoreValidationError);
      // A refusal never echoes the payload.
      expect(String((error as Error).message)).not.toContain('copied');
    }
    // `..`, absolute and glob-looking paths are Core's to refuse — passed through.
    for (const path of ['../x', '/etc/passwd', '*', ':(glob)x']) {
      expect(((await frameOf((c) => c.gitDiff({ taskId: 't1', path, status: 'added' }))).frame?.params as Record<string, unknown>)['path']).toBe(path);
    }
  });

  it('git.diff and git.review get the 45 s git deadline; other reads keep the default', async () => {
    const h = makeHarness({ requestTimeoutMs: 15_000 });
    await h.conn.connect();
    const commands = new CoreCommands(h.conn);
    void commands.gitDiff({ taskId: 't1', path: 'a', status: 'added' }).catch(() => undefined);
    void commands.gitReview('t1').catch(() => undefined);
    void commands.taskList().catch(() => undefined);
    expect(GIT_QUERY_TIMEOUT_MS).toBe(45_000);
    expect(GIT_QUERY_TIMEOUT_MS).toBe(PROJECT_GIT_TIMEOUT_MS);
    expect(h.timers.pending.map((t) => t.ms).sort((a, b) => a - b)).toEqual([15_000, 45_000, 45_000]);
  });
});

describe('A5 drift: bounds, messages and wire fields match the Rust sources', () => {
  it('maxBytes bounds equal sandpane_core::diff', () => {
    expect(diffRs).toContain(`pub const MAX_DIFF_BYTES: usize = ${MAX_DIFF_BYTES.toLocaleString('en-US').replace(/,/g, '_')};`);
    expect(diffRs).toContain(`pub const DEFAULT_DIFF_BYTES: usize = ${DEFAULT_DIFF_BYTES.toLocaleString('en-US').replace(/,/g, '_')};`);
    expect([MAX_DIFF_BYTES, DEFAULT_DIFF_BYTES]).toEqual([524_288, 262_144]);
  });

  it('the 45 s deadline stays above RunLimits::QUERY, which git.diff and git.review use', () => {
    const processRs = read('core/crates/sandpane-core/src/process.rs');
    const query = /pub const QUERY: RunLimits = RunLimits \{\s*timeout: Duration::from_secs\((\d+)\)/.exec(processRs);
    expect(GIT_QUERY_TIMEOUT_MS).toBeGreaterThan(Number(query?.[1]) * 1000);
  });

  it('exact messages equal sandpane-service / sandpane-core', () => {
    expect(rustConst(serviceLib, 'MSG_WORK_TREE_REDIRECTED')).toBe(MSG_WORK_TREE_REDIRECTED);
    expect(rustConst(serviceLib, 'MSG_DIFF_PATH_NOT_IN_LIST')).toBe(MSG_DIFF_PATH_NOT_IN_LIST);
    expect(rustConst(serviceLib, 'MSG_DIFF_PATH_LISTED_TWICE')).toBe(MSG_DIFF_PATH_LISTED_TWICE);
    expect(rustConst(serviceLib, 'MSG_DIFF_PATH_NOT_EXACT')).toBe(MSG_DIFF_PATH_NOT_EXACT);
    expect(serviceLib).toContain(`"${MSG_NO_GIT_CONTEXT}".to_string()`);
    // git_context (git.review / git.diff) answers an unknown task with this exact text.
    expect(serviceLib).toMatch(new RegExp(`fn git_context[\\s\\S]{0,1500}\\(ErrorCode::NotFound, "${MSG_TASK_NOT_FOUND}"\\.to_string\\(\\)\\)`));
    expect(serviceLib.replace(/\\\n\s*/g, '')).toContain(`"${MSG_WORKTREE_REMOVED}"`);
    // Untracked refusals: Core formats `{rel:?} <reason>` and appends "; nothing was read".
    expect(serviceLib).toContain('format!("{m}; nothing was read")');
    expect(diffRs).toContain(`"{rel:?}${UNTRACKED_CHANGED_SUFFIX.replace('; nothing was read', '')}"`);
    for (const suffix of UNTRACKED_REFUSAL_SUFFIXES) {
      expect(diffRs, suffix).toContain(`"{rel:?}${suffix.replace('; nothing was read', '')}"`);
    }
    expect(gitRs.replace(/\\\n\s*/g, '')).toContain(`"${SUBMODULE_PREFIX}{}{extra}; `);
  });

  it('ChangeSet.repoPath / uninspected, FileChange.oldPath and GitDiffResult fields exist in Rust and TS', () => {
    const struct = (name: string): string => {
      const start = rustProtocol.indexOf(`pub struct ${name} {`);
      if (start < 0) throw new Error(`no struct ${name}`);
      return rustProtocol.slice(start, rustProtocol.indexOf('\n}\n', start));
    };
    expect(struct('ChangeSet')).toContain('pub repo_path: Option<String>,');
    expect(struct('ChangeSet')).toContain('pub uninspected: Option<Vec<String>>,');
    expect(struct('FileChange')).toContain('pub old_path: Option<String>,');
    for (const field of ['pub path: String,', 'pub old_path: Option<String>,', 'pub status: FileChangeStatus,', 'pub patch: String,', 'pub binary: bool,', 'pub truncated: bool,', 'pub lossy: bool,', 'pub base_blob: Option<String>,']) {
      expect(struct('GitDiffResult'), field).toContain(field);
    }
    for (const field of ['pub task_id: String,', 'pub path: String,', 'pub max_bytes: Option<u64>,', 'pub status: Option<FileChangeStatus>,']) {
      expect(struct('GitDiffParams'), field).toContain(field);
    }
    const ts = read('clients/vscode/src/core-client/protocol.ts');
    for (const needle of ['repoPath?: string | null;', 'uninspected?: string[] | null;', 'oldPath?: string | null;', 'baseBlob?: string | null;', 'maxBytes?: number;']) {
      expect(ts, needle).toContain(needle);
    }
  });
});

describe('A5 decode: a git.diff answer is shape-checked, never echoed', () => {
  it('accepts the documented shape (absent optionals ok) and rejects anything else', () => {
    expect(parseGitDiffResult(result())).toEqual(result());
    expect(parseGitDiffResult({ ...result(), oldPath: 'x', baseBlob: 'abc' })?.oldPath).toBe('x');
    for (const bad of [null, 'patch', { ...result(), patch: 5 }, { ...result(), binary: 'no' }, { ...result(), path: undefined }]) {
      expect(parseGitDiffResult(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('A5 display: the patch document', () => {
  const render = (r: GitDiffResult) => renderPatchDocument({ taskId: 'task-1234567890', result: r, maxBytes: DEFAULT_DIFF_BYTES });

  it('shows the path from JSON, says read-only / never applied, and keeps the patch text', () => {
    const doc = render(result());
    expect(doc.text).toContain('path: src/a.ts');
    expect(doc.text).toContain('status: modified');
    expect(doc.text).toMatch(/read-only/);
    expect(doc.text).toMatch(/never applied/);
    expect(doc.text).toContain('+new\n');
    expect(doc.hiddenLines).toBe(0);
  });

  it('discloses binary with the attribute wording and never says "no changes"', () => {
    const doc = render(result({ binary: true, patch: '' }));
    expect(doc.text).toContain(BINARY_DISCLOSURE);
    expect(BINARY_DISCLOSURE).toBe('treated as binary (possibly by repository attributes) \u2014 no text diff shown');
    expect(doc.text).not.toMatch(/no changes/i);
  });

  it('discloses truncated (with the byte limit) and lossy', () => {
    const doc = render(result({ truncated: true, lossy: true, patch: '@@ -1,900 +1,900 @@\n-a\n' }));
    expect(doc.text).toContain(`diff truncated at ${DEFAULT_DIFF_BYTES} bytes`);
    expect(doc.text).toMatch(/hunk header may promise more lines/);
    expect(doc.text).toContain(LOSSY_DISCLOSURE);
    expect(LOSSY_DISCLOSURE).toBe('contains bytes that are not valid UTF-8; shown with replacement characters');
  });

  it('shows a rename as oldPath \u2192 path and the base blob as short text', () => {
    const doc = render(result({ status: 'renamed', oldPath: 'old/name.ts', path: 'new/name.ts', baseBlob: '0123456789abcdef0123456789abcdef01234567' }));
    expect(doc.text).toContain('path: old/name.ts \u2192 new/name.ts');
    expect(doc.text).toContain('base blob: 0123456789ab');
  });

  it('shows a symlink (mode 120000) as "symlink \u2192 target", never the target content', () => {
    const patch =
      'diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+../secret/target\n\\ No newline at end of file\n';
    expect(symlinkTarget(result({ status: 'untracked', path: 'link', patch }))).toBe('../secret/target');
    expect(symlinkTarget(result())).toBeNull();
    const doc = render(result({ status: 'untracked', path: 'link', patch }));
    expect(doc.text).toContain('symlink \u2192 ../secret/target');
  });

  // W1 (combined client review): the JetBrains rule — untracked only, the mode
  // line at index 1, the exact one-line hunk header, exactly one `+` line, and
  // not binary / truncated. Anything else shows NO symlink line.
  const SYMLINK_PATCH =
    'diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+../t\n\\ No newline at end of file\n';

  it('a typechange (tracked file \u2192 symlink, listed as modified) shows no symlink line', () => {
    // Captured shape (reviewer scratch tc.patch): two sections, the mode line mid-patch.
    const typechange =
      'diff --git a/f b/f\ndeleted file mode 100644\nindex ce01362..0000000\n--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-hello\n' +
      'diff --git a/f b/f\nnew file mode 120000\nindex 0000000..2b65e96\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+/etc/target\n\\ No newline at end of file\n';
    for (const status of ['modified', 'untracked'] as const) {
      const r = result({ status, path: 'f', patch: typechange });
      expect(symlinkTarget(r), status).toBeNull();
      expect(render(r).text, status).not.toMatch(/symlink \u2192/);
    }
  });

  it('a link target spanning two + lines (a newline in the target) shows no symlink line', () => {
    // Captured shape (reviewer scratch ml.patch).
    const twoLines =
      'diff --git a/p b/p\nnew file mode 120000\n--- /dev/null\n+++ b/p\n@@ -0,0 +1,2 @@\n+safe\n+../../x\n\\ No newline at end of file\n';
    const r = result({ status: 'untracked', path: 'p', patch: twoLines });
    expect(symlinkTarget(r)).toBeNull();
    expect(render(r).text).not.toMatch(/symlink \u2192/);
    // Same header, exact hunk, but two `+` lines.
    const forged = SYMLINK_PATCH.replace('+../t\n', '+safe\n+../../x\n');
    expect(symlinkTarget(result({ status: 'untracked', path: 'link', patch: forged }))).toBeNull();
  });

  it('the symlink line needs untracked, mode line at index 1, the exact hunk header, not binary/truncated', () => {
    const ok = result({ status: 'untracked', path: 'link', patch: SYMLINK_PATCH });
    expect(symlinkTarget(ok)).toBe('../t');
    expect(symlinkTarget({ ...ok, status: 'modified' })).toBeNull();
    expect(symlinkTarget({ ...ok, status: 'added' })).toBeNull();
    expect(symlinkTarget({ ...ok, binary: true })).toBeNull();
    expect(symlinkTarget({ ...ok, truncated: true })).toBeNull();
    expect(symlinkTarget({ ...ok, patch: SYMLINK_PATCH.replace('diff --git a/link b/link\n', 'diff --git a/link b/link\nold mode 100644\n') })).toBeNull();
    expect(symlinkTarget({ ...ok, patch: SYMLINK_PATCH.replace('@@ -0,0 +1 @@', '@@ -0,0 +1 @@ ctx') })).toBeNull();
    expect(symlinkTarget({ ...ok, patch: SYMLINK_PATCH.replace('diff --git ', 'xdiff --git ') })).toBeNull();
  });

  it('names come from JSON: a path containing " b/" is shown as Core named it, not as the header splits it', () => {
    const patch = 'diff --git a/x b/y b/x b/y\n--- a/x b/y\n+++ b/x b/y\n@@ -1 +1 @@\n-a\n+b\n';
    const doc = render(result({ path: 'x b/y', patch }));
    expect(doc.text).toContain('path: x b/y');
  });

  it('reveals hidden / bidi / line-separator characters in the patch, keeps tabs, and counts the lines', () => {
    const patch = `@@ -1 +1 @@\n-\tconst a = 1;\n+\tconst a = 1; // \u202Eevil\u202C\n+x\u2028y\n`;
    const doc = render(result({ patch }));
    expect(doc.text).not.toMatch(/[\u202E\u202C\u2028]/);
    expect(doc.text).toContain('\\u202E');
    expect(doc.text).toContain('\\u2028');
    expect(doc.text).toContain('-\tconst a = 1;');
    expect(doc.hiddenLines).toBe(2);
    expect(doc.text).toMatch(/2 line\(s\) contained hidden, bidi or control characters/);
  });

  it('CRLF line endings are shown as \\r and counted separately, not as hidden characters', () => {
    const doc = render(result({ patch: '@@ -1 +1 @@\r\n-a\r\n+b\r\n' }));
    expect(doc.text).toContain('-a\\r\n');
    expect(doc.hiddenLines).toBe(0);
    expect(doc.text).toContain('3 line(s) end with CR (CRLF line endings)');
    expect(doc.text).not.toMatch(/hidden, bidi or control/);
  });

  it('reveals hidden characters in path, oldPath and the symlink target too', () => {
    const doc = render(result({ status: 'renamed', path: 'a\nb\u202E.ts', oldPath: 'o\t.ts' }));
    expect(doc.text).toContain('path: o\\t.ts \u2192 a\\nb\\u202E.ts');
  });

  it('a "<script>" in the patch stays inert text in a plain-text document', () => {
    const doc = render(result({ patch: '+<script>alert(1)</script>\n' }));
    expect(doc.text).toContain('+<script>alert(1)</script>');
  });
});

describe('A5 review labels and notes', () => {
  it('labels a rename "old \u2192 new" and reveals hidden characters in both', () => {
    expect(changeLabel({ path: 'new.ts', oldPath: 'old.ts' })).toBe('old.ts \u2192 new.ts');
    expect(changeLabel({ path: 'new\nline\t.txt' })).toBe('new\\nline\\t.txt');
  });

  it('breaks "$(" so a file name cannot render a theme icon in the QuickPick label (W2)', () => {
    const label = changeLabel({ path: '$(pass-filled) README.md' });
    expect(label).not.toContain('$(');
    expect(label).toBe('$ (pass-filled) README.md');
    const renamed = changeLabel({ path: 'b$(check)', oldPath: '$(warning)a' });
    expect(renamed).not.toContain('$(');
    expect(renamed).toBe('$ (warning)a \u2192 b$ (check)');
    // `](` stays broken too (plainText).
    expect(changeLabel({ path: '[x](command:evil)' })).not.toContain('](');
  });

  it('shows Core\'s repoPath and never claims completeness when paths were not inspected', () => {
    const cs: ChangeSet = { taskId: 't', baseCommit: 'b', hostDirty: false, changes: [], repoPath: '/repo/at\u202Elas', uninspected: ['x', 'y'] };
    const notes = changeSetNotes(cs);
    expect(notes.join(' ')).toContain('repository (from Core): /repo/at\\u202Elas');
    expect(notes.join(' ')).toContain('2 paths were not inspected');
    expect(changeSetNotes({ ...cs, uninspected: [] }).join(' ')).not.toMatch(/not inspected/);
    expect(changeSetNotes({ taskId: 't', baseCommit: 'b', hostDirty: false, changes: [] })).toEqual([]);
  });
});

describe('A5 copy: each exact refusal says what Core did (nothing was read)', () => {
  it('maps the exact messages', () => {
    const cases: [string, string, RegExp][] = [
      ['VALIDATION_FAILED', MSG_NO_GIT_CONTEXT, /no Git context.*no diff is shown/i],
      ['VALIDATION_FAILED', MSG_WORKTREE_REMOVED, /worktree was removed/],
      ['VALIDATION_FAILED', MSG_WORK_TREE_REDIRECTED, /core\.worktree.*nothing was read/],
      ['VALIDATION_FAILED', MSG_DIFF_PATH_NOT_IN_LIST, /no longer in the task's change list.*nothing was read/],
      ['VALIDATION_FAILED', MSG_DIFF_PATH_LISTED_TWICE, /more than once.*nothing was read/],
      ['VALIDATION_FAILED', MSG_DIFF_PATH_NOT_EXACT, /not valid UTF-8.*nothing was read/],
      ['VALIDATION_FAILED', `"a/b"${UNTRACKED_CHANGED_SUFFIX}`, /changed while Core was reading it.*nothing was read/],
      ['VALIDATION_FAILED', `"a"${UNTRACKED_REFUSAL_SUFFIXES[1]}`, /not a regular file.*nothing was read/],
      ['VALIDATION_FAILED', `${SUBMODULE_PREFIX}"sub"; Sandpane cannot verify`, /submodule/],
      ['NOT_FOUND', MSG_TASK_NOT_FOUND, /no such task/],
    ];
    for (const [code, message, expected] of cases) {
      expect(gitErrorCopy(rpc(code, message)), message).toMatch(expected);
    }
    expect(gitErrorCopy(rpc('VALIDATION_FAILED', 'something else'))).toBeNull();
    expect(gitErrorCopy(rpc('NOT_FOUND', 'task not found anywhere'))).toBeNull();
  });

  it('INTERNAL from git.diff / git.review says Core could not produce it and that nothing was changed (W5)', () => {
    expect(gitErrorCopy(rpc('INTERNAL', 'git exited 128'), 'git.diff')).toBe(
      'Core could not produce the diff (INTERNAL) \u2014 no file was changed (git.diff is read-only).',
    );
    expect(gitErrorCopy(rpc('INTERNAL', MSG_DIFF_PATH_NOT_IN_LIST))).toBe(
      'Core could not produce the diff (INTERNAL) \u2014 no file was changed (git.diff is read-only).',
    );
    expect(gitErrorCopy(rpc('INTERNAL', 'x'), 'git.review')).toBe(
      'Core could not produce the change list (INTERNAL) \u2014 no file was changed (git.review is read-only).',
    );
    // Core's message is never echoed into the copy.
    expect(gitErrorCopy(rpc('INTERNAL', 'secret-ish detail'), 'git.diff')).not.toContain('secret-ish');
  });

  it('a timeout says Core did not answer and that git.diff is read-only', () => {
    expect(gitErrorCopy(new CoreTransportError('timeout', 'x'), 'git.diff')).toBe(DIFF_TIMEOUT_COPY);
    expect(DIFF_TIMEOUT_COPY).toBe('Core did not answer in time \u2014 no file was changed (git.diff is read-only).');
    expect(gitErrorCopy(new CoreTransportError('timeout', 'x'), 'git.review')).toMatch(/read-only/);
  });
});

describe('A5 read-only virtual documents (sandpane-diff:)', () => {
  it('stores text under a scheme URI path, serves it, and evicts beyond the cap with an honest note', () => {
    const store = new PatchDocumentStore();
    expect(PATCH_SCHEME).toBe('sandpane-diff');
    const first = store.put('src/a\n.ts', 'one');
    expect(first.path).toMatch(/^\/1\/[^/\n]+\.diff$/);
    expect(first.path).not.toContain('\n');
    expect(store.provideTextDocumentContent({ path: first.path })).toBe('one');
    for (let i = 0; i < MAX_PATCH_DOCUMENTS; i += 1) store.put('x', `n${i}`);
    expect(store.provideTextDocumentContent({ path: first.path })).toMatch(/no longer available/);
    expect(store.provideTextDocumentContent({ path: '/nope' })).toMatch(/no longer available/);
  });
});
