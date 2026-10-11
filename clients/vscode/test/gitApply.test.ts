/**
 * A6 (design 2026-10-09 §3.6): `git.apply` for reviewed files.
 *  - wire: `{taskId, expectedBase, reviewId, entries}` with the entries copied
 *    VERBATIM from the `git.review` answer; `selectedFiles` is never sent;
 *  - deadline: 45 s, above Core's total apply budget;
 *  - drift: the feature, every Core message the copy keys on, the struct
 *    fields, the entry cap and the event kinds equal the Rust sources;
 *  - selection: which entries can be applied, and why not;
 *  - confirmation: every file listed (revealed), flags (a)/(b)/(c), the
 *    binding sentence, an explicit "Apply N files" button;
 *  - results and errors: success, partial, aborts, CONFLICT (lock vs mount),
 *    lost answers — never "nothing changed" when Core may have written.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CoreCommands,
  CoreValidationError,
  GIT_APPLY_TIMEOUT_MS,
  GIT_QUERY_TIMEOUT_MS,
} from '../src/core-client/commands';
import { CoreRpcError, CoreTransportError } from '../src/core-client/connection';
import type { ErrorCode } from '../src/core-client/events';
import { KNOWN_FEATURES, PROTOCOL_VERSION } from '../src/core-client/protocol';
import type { ChangeSet, FileChange, GitDiffResult } from '../src/core-client/protocol';
import {
  APPLY_TEMPLATES,
  APPLY_EVENT_KINDS,
  GIT_APPLY_FEATURE,
  MAX_APPLY_ENTRIES,
  MSG_CHECK_FAILED,
  MSG_CHECK_UNAVAILABLE,
  MSG_CONTENT_TOO_LARGE,
  MSG_DIRECT_MOUNT,
  MSG_ENTRIES_NOT_REVIEWED,
  MSG_HOST_UNBORN,
  MSG_HOST_WORK_TREE_REDIRECTED,
  MSG_NEEDS_REVIEW,
  MSG_PATCH_TOO_LARGE,
  MSG_PREPARE_TOO_SLOW,
  MSG_SELECTED_FILES,
  MSG_TOO_MANY_ENTRIES,
  MSG_WRITE_NOT_RUN,
  BINDING_SENTENCE,
  NOT_APPLICABLE_HEADER,
  notApplicableCopy,
  CREATE_BUSY_COPY,
  CREATE_BUSY_TEMPLATES,
  MODAL_LIST_CAP,
  MSG_WRITE_TOO_LATE,
  createBusyCopy,
  matchesTemplate,
  mismatchCopy,
  renderApplyListDocument,
  typedConfirmation,
  typedConfirmed,
  REASON_NO_CONTENT_ID,
  REASON_SYMLINK,
  REASON_TOO_LARGE,
  ReviewedDiffs,
  applyButtonLabel,
  applyConfirmationView,
  applyErrorView,
  applyPickPlan,
  applyResultView,
  classifyAbortReason,
  diffMismatch,
  entrySelectability,
  executableReason,
  lostAnswerCopy,
  notFullyShownReason,
  parseApplyChangeSet,
  parseApplyResult,
  runsAutomaticallyReason,
} from '../src/vscode/gitApply';
import { parseGitDiffResult, renderPatchDocument } from '../src/vscode/gitDiff';
import { makeHarness } from './helpers/fakeCore';

const repoRoot = resolve(process.cwd(), '..', '..');
const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), 'utf8');
const rustProtocol = read('core/crates/sandpane-protocol/src/lib.rs');
const applyRs = read('core/crates/sandpane-core/src/apply.rs');
const gitApplyRs = read('core/crates/sandpane-service/src/git_apply.rs');
const serviceLib = read('core/crates/sandpane-service/src/lib.rs');

const BASE = 'b71995fc1e0f4a3c8f0d7b1a2e3c4d5e6f708192';
const BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const BLOB2 = '0123456789abcdef0123456789abcdef01234567';

const rpc = (code: string, message: string): CoreRpcError =>
  new CoreRpcError({ code: code as ErrorCode, message }, 'r1');

/** Rust `\`-newline string continuations joined (whitespace after them dropped). */
const joined = (source: string): string => source.replace(/\\\n\s*/g, '');

/** A Rust `pub const NAME: &str = "…";` value. */
function rustConst(source: string, name: string): string {
  const m = new RegExp(`pub const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)";`).exec(source);
  if (!m?.[1]) throw new Error(`no \`pub const ${name}\``);
  return joined(m[1]);
}

/**
 * The format string of `pub fn NAME(…) -> String { format!("…" …) }`, with
 * every `{name}` / `{name:?}` / `{}` placeholder normalized to `{}` and
 * `{NOTHING_WRITTEN}` expanded to its literal.
 */
function rustTemplate(source: string, name: string): string {
  const start = source.indexOf(`pub fn ${name}(`);
  if (start < 0) throw new Error(`no \`pub fn ${name}\``);
  const body = joined(source.slice(start, source.indexOf('\n}\n', start)));
  const m = /format!\(\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(body);
  if (!m?.[1]) throw new Error(`no format! in ${name}`);
  return m[1].replace(/\{NOTHING_WRITTEN\}/g, '; nothing was written').replace(/\{[a-z_]*(?::\?)?\}/g, '{}');
}

function struct(name: string): string {
  const start = rustProtocol.indexOf(`pub struct ${name} {`);
  if (start < 0) throw new Error(`no struct ${name}`);
  return rustProtocol.slice(start, rustProtocol.indexOf('\n}\n', start));
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
  h.transport.respond({ v: PROTOCOL_VERSION, id: frame.id, ok: { applied: false, conflictedFiles: [] } });
  await promise;
  return { frame, error: undefined };
}

const modified = (path: string, extra: Partial<FileChange> = {}): FileChange => ({
  path,
  status: 'modified',
  taskBlob: BLOB,
  taskMode: '100644',
  ...extra,
});

function changeSet(changes: FileChange[], extra: Partial<ChangeSet> = {}): ChangeSet {
  return {
    taskId: 'task-a',
    baseCommit: BASE,
    hostDirty: false,
    changes,
    repoPath: '/repo/atlas',
    reviewId: 'rev-1',
    ...extra,
  };
}

function diff(overrides: Partial<GitDiffResult> = {}): GitDiffResult {
  return {
    path: 'src/a.ts',
    status: 'modified',
    patch: '@@ -1 +1 @@\n-a\n+b\n',
    binary: false,
    truncated: false,
    lossy: false,
    taskBlob: BLOB,
    taskMode: '100644',
    ...overrides,
  };
}

describe('A6 wire: git.apply', () => {
  it('sends {taskId, expectedBase, reviewId, entries} with every entry VERBATIM (tab, quote, newline, non-ASCII, rename, extra field)', async () => {
    const entries = [
      { path: ' dir/weırd\t"q"\nline é中.txt ', status: 'added', taskBlob: BLOB, taskMode: '100755' },
      { path: 'new name.ts', status: 'renamed', oldPath: 'old\tname.ts', taskBlob: BLOB2, taskMode: '100644' },
      { path: 'gone.txt', status: 'deleted' },
      // A field a later Core may add travels unchanged (never rebuilt).
      { path: 'x.ts', status: 'modified', taskBlob: BLOB, taskMode: '100644', future: { k: 1 } },
    ] as unknown as FileChange[];
    const { frame } = await frameOf((c) => c.gitApply({ taskId: 'task-a', expectedBase: BASE, reviewId: 'rev-1', entries }));
    expect(frame).toEqual({
      v: PROTOCOL_VERSION,
      id: 'test-1',
      method: 'git.apply',
      params: { taskId: 'task-a', expectedBase: BASE, reviewId: 'rev-1', entries: JSON.parse(JSON.stringify(entries)) },
    });
    const sent = (frame?.params as { entries: FileChange[] }).entries;
    expect(sent[0]?.path).toBe(entries[0]?.path);
    expect(sent[1]?.oldPath).toBe('old\tname.ts');
    expect(Object.keys(frame?.params as object).sort()).toEqual(['entries', 'expectedBase', 'reviewId', 'taskId']);
  });

  it('never sends selectedFiles, even when a caller smuggles it in', async () => {
    const params = { taskId: 't1', expectedBase: BASE, reviewId: 'r', entries: [modified('a.ts')], selectedFiles: ['a.ts'] };
    const { frame } = await frameOf((c) => c.gitApply(params as never));
    expect(frame?.params).not.toHaveProperty('selectedFiles');
    const commandsTs = read('clients/vscode/src/core-client/commands.ts');
    expect(commandsTs).not.toMatch(/selectedFiles/);
    expect(commandsTs).not.toMatch(/validateSelectedFile/);
  });

  it('refuses locally only what Core refuses (empty list, more than 1000 entries, empty reviewId) and never echoes entries', async () => {
    for (const bad of [
      { taskId: 't1', expectedBase: BASE, reviewId: 'r', entries: [] },
      { taskId: 't1', expectedBase: BASE, reviewId: '', entries: [modified('SECRET-PATH')] },
      { taskId: 't1', expectedBase: BASE, entries: [modified('SECRET-PATH')] },
      { taskId: 't1', expectedBase: BASE, reviewId: 'r', entries: Array.from({ length: MAX_APPLY_ENTRIES + 1 }, (_, i) => modified(`f${i}`)) },
      { taskId: 't1', expectedBase: BASE, reviewId: 'r', entries: [{ status: 'added' }] },
    ]) {
      const { frame, error } = await frameOf((c) => c.gitApply(bad as never));
      expect(frame).toBeUndefined();
      expect(error).toBeInstanceOf(CoreValidationError);
      expect(String((error as Error).message)).not.toContain('SECRET-PATH');
    }
    // Exactly 1000 entries go out; Core gates every other property.
    const many = Array.from({ length: MAX_APPLY_ENTRIES }, (_, i) => ({ path: `../f${i}`, status: 'weird' }));
    const { frame } = await frameOf((c) => c.gitApply({ taskId: 't1', expectedBase: BASE, reviewId: 'r', entries: many as never }));
    expect((frame?.params as { entries: unknown[] }).entries).toHaveLength(MAX_APPLY_ENTRIES);
  });

  it('git.apply gets the 45 s git deadline', async () => {
    const h = makeHarness({ requestTimeoutMs: 15_000 });
    await h.conn.connect();
    const commands = new CoreCommands(h.conn);
    void commands.gitApply({ taskId: 't1', expectedBase: BASE, reviewId: 'r', entries: [modified('a')] }).catch(() => undefined);
    expect(GIT_APPLY_TIMEOUT_MS).toBe(45_000);
    expect(GIT_APPLY_TIMEOUT_MS).toBe(GIT_QUERY_TIMEOUT_MS);
    expect(h.timers.pending.map((t) => t.ms)).toEqual([45_000]);
  });
});

describe('A6 drift: Rust sources', () => {
  it('git-apply is a known feature and equals Rust FEATURES', () => {
    expect(GIT_APPLY_FEATURE).toBe('git-apply');
    expect(KNOWN_FEATURES).toContain(GIT_APPLY_FEATURE);
    expect(rustProtocol).toMatch(/pub const FEATURES: \[&str; 6\] = \[[\s\S]*"git-apply",\s*"verification",\s*\];/);
  });

  it("the 45 s deadline stays above Core's total apply budget (prepare + write + verify)", () => {
    const secs = (name: string): number => {
      const m = new RegExp(`pub const ${name}: Duration = Duration::from_secs\\((\\d+)\\);`).exec(applyRs);
      if (!m?.[1]) throw new Error(`no ${name}`);
      return Number(m[1]);
    };
    const verify = /verify_budget: Duration::from_secs\((\d+)\)/.exec(applyRs);
    const total = secs('APPLY_PREPARE_BUDGET') + secs('APPLY_WRITE_TIMEOUT') + Number(verify?.[1]);
    expect(total).toBe(41);
    expect(GIT_APPLY_TIMEOUT_MS).toBeGreaterThan(total * 1000);
  });

  it('the entry cap equals MAX_APPLY_ENTRIES', () => {
    expect(applyRs).toContain(`pub const MAX_APPLY_ENTRIES: usize = ${MAX_APPLY_ENTRIES};`);
  });

  it('exact messages equal sandpane-core apply.rs', () => {
    const consts: [string, string][] = [
      ['MSG_NEEDS_REVIEW', MSG_NEEDS_REVIEW],
      ['MSG_SELECTED_FILES', MSG_SELECTED_FILES],
      ['MSG_TOO_MANY_ENTRIES', MSG_TOO_MANY_ENTRIES],
      ['MSG_ENTRIES_NOT_REVIEWED', MSG_ENTRIES_NOT_REVIEWED],
      ['MSG_DIRECT_MOUNT', MSG_DIRECT_MOUNT],
      ['MSG_CHECK_FAILED', MSG_CHECK_FAILED],
      ['MSG_PATCH_TOO_LARGE', MSG_PATCH_TOO_LARGE],
      ['MSG_PREPARE_TOO_SLOW', MSG_PREPARE_TOO_SLOW],
      ['MSG_CONTENT_TOO_LARGE', MSG_CONTENT_TOO_LARGE],
      ['MSG_WRITE_NOT_RUN', MSG_WRITE_NOT_RUN],
      ['MSG_CHECK_UNAVAILABLE', MSG_CHECK_UNAVAILABLE],
      ['MSG_HOST_UNBORN', MSG_HOST_UNBORN],
      ['MSG_HOST_WORK_TREE_REDIRECTED', MSG_HOST_WORK_TREE_REDIRECTED],
    ];
    for (const [name, value] of consts) expect(rustConst(applyRs, name), name).toBe(value);
  });

  it('message templates equal the Rust format strings (paths quoted by Core)', () => {
    const fns: [keyof typeof APPLY_TEMPLATES, string][] = [
      ['changed', 'msg_changed'],
      ['listed_twice', 'msg_listed_twice'],
      ['no_content', 'msg_no_content'],
      ['symlink', 'msg_symlink'],
      ['gitlink', 'msg_gitlink'],
      ['base_symlink', 'msg_base_symlink'],
      ['collision', 'msg_collision'],
      ['snapshot_differs', 'msg_snapshot_differs'],
      ['leading_path', 'msg_leading_path'],
      ['dirty', 'msg_dirty'],
      ['hidden', 'msg_hidden'],
      ['filtered', 'msg_filtered'],
      ['head_moved', 'msg_head_moved'],
      ['expected_base', 'msg_expected_base'],
      ['write_failed', 'msg_write_failed'],
      ['verify_unavailable', 'msg_verify_unavailable'],
      ['verify_failed', 'msg_verify_failed'],
      ['mounted', 'msg_mounted'],
    ];
    for (const [kind, fn] of fns) expect(rustTemplate(applyRs, fn), fn).toBe(APPLY_TEMPLATES[kind]);
    // msg_write_killed = msg_write_failed(repo) + its own tail.
    const killedTail = rustTemplate(applyRs, 'msg_write_killed');
    expect(killedTail.startsWith('{}')).toBe(true);
    expect(APPLY_TEMPLATES.write_killed).toBe(APPLY_TEMPLATES.write_failed + killedTail.slice(2));
    expect(rustTemplate(gitApplyRs, 'msg_locked')).toBe(APPLY_TEMPLATES.locked);
    // The no-Git-context refusal is the review message + "; nothing was written".
    expect(rustTemplate(applyRs, 'msg_context')).toBe('{}; nothing was written');
    expect(APPLY_TEMPLATES.no_git_context).toBe(`${rustConst(serviceLib, 'MSG_NO_GIT_CONTEXT')}; nothing was written`);
  });

  it('event kinds equal git_apply.rs', () => {
    expect(rustConst(gitApplyRs, 'EVENT_APPLY_STARTED')).toBe(APPLY_EVENT_KINDS.started);
    expect(rustConst(gitApplyRs, 'EVENT_APPLIED')).toBe(APPLY_EVENT_KINDS.applied);
    expect(rustConst(gitApplyRs, 'EVENT_APPLY_FAILED')).toBe(APPLY_EVENT_KINDS.failed);
    expect(rustConst(gitApplyRs, 'EVENT_APPLY_RECONCILED')).toBe(APPLY_EVENT_KINDS.reconciled);
  });

  it('A6 wire fields exist in Rust and TS (and selectedFiles is gone from the TS params)', () => {
    for (const field of ['pub task_blob: Option<String>,', 'pub task_mode: Option<String>,']) {
      expect(struct('FileChange'), field).toContain(field);
      expect(struct('GitDiffResult'), field).toContain(field);
    }
    expect(struct('ChangeSet')).toContain('pub review_id: Option<String>,');
    expect(struct('ChangeSet')).toContain('pub host_hooks_path: Option<String>,');
    expect(struct('GitApplyParams')).toContain('pub review_id: Option<String>,');
    expect(struct('GitApplyParams')).toContain('pub entries: Option<Vec<FileChange>>,');
    for (const field of ['pub applied_files: Option<Vec<String>>,', 'pub mode_changes: Option<Vec<ModeChange>>,', 'pub snapshot_tree: Option<String>,', 'pub partial: Option<bool>,']) {
      expect(struct('ApplyResult'), field).toContain(field);
    }
    for (const field of ['pub path: String,', 'pub from: String,', 'pub to: String,']) expect(struct('ModeChange')).toContain(field);
    const ts = read('clients/vscode/src/core-client/protocol.ts');
    for (const needle of [
      'taskBlob?: string | null;',
      'taskMode?: string | null;',
      'reviewId?: string | null;',
      'hostHooksPath?: string | null;',
      'appliedFiles?: string[] | null;',
      'modeChanges?: ModeChange[] | null;',
      'snapshotTree?: string | null;',
      'partial?: boolean | null;',
      'entries: readonly FileChange[];',
    ]) {
      expect(ts, needle).toContain(needle);
    }
    const params = ts.slice(ts.indexOf('export interface GitApplyParams'), ts.indexOf('}', ts.indexOf('export interface GitApplyParams')));
    expect(params).not.toContain('selectedFiles');
  });
});

describe('A6 decode', () => {
  it('git.review: new fields are optional open strings; a non-string is treated as absent; entries stay the same objects', () => {
    const raw = {
      taskId: 'task-a',
      baseCommit: BASE,
      hostDirty: false,
      reviewId: 'rev-1',
      hostHooksPath: '.hooks',
      changes: [modified('a.ts'), { path: 'b.ts', status: 'modified', taskBlob: 7, taskMode: null }],
    };
    const parsed = parseApplyChangeSet(raw);
    expect(parsed?.reviewId).toBe('rev-1');
    expect(parsed?.hostHooksPath).toBe('.hooks');
    expect(parsed?.changes[0]).toBe(raw.changes[0]);
    expect(entrySelectability(parsed!.changes[1]!)).toBe(REASON_NO_CONTENT_ID);
    expect(parseApplyChangeSet({ ...raw, reviewId: 5 })?.reviewId).toBeUndefined();
    expect(parseApplyChangeSet({ ...raw, changes: 'x' })).toBeNull();
    expect(parseApplyChangeSet({ ...raw, changes: [{ status: 'added' }] })).toBeNull();
    expect(parseApplyChangeSet({ ...raw, baseCommit: 1 })).toBeNull();
  });

  it('git.diff: taskBlob / taskMode are decoded (optional strings)', () => {
    expect(parseGitDiffResult({ ...diff(), taskBlob: BLOB, taskMode: '100755' })).toMatchObject({ taskBlob: BLOB, taskMode: '100755' });
    expect(parseGitDiffResult({ ...diff(), taskBlob: undefined, taskMode: undefined })).not.toHaveProperty('taskBlob');
    expect(parseGitDiffResult({ ...diff(), taskBlob: 3 })).toBeNull();
  });

  it('git.diff display: a pure rename with an empty patch says "renamed, content unchanged", never "no changes"', () => {
    const text = renderPatchDocument({ taskId: 't', result: diff({ status: 'renamed', oldPath: 'old.ts', path: 'new.ts', patch: '' }), maxBytes: 1 }).text;
    expect(text).toContain('renamed, content unchanged');
    expect(text).not.toMatch(/no changes/i);
    expect(text).toContain('task content id: e69de29bb2d1');
    const empty = renderPatchDocument({ taskId: 't', result: diff({ patch: '' }), maxBytes: 1 }).text;
    expect(empty).toContain('Core returned an empty patch');
    expect(empty).not.toMatch(/no changes/i);
  });

  it('ApplyResult is shape-checked; optional A6 fields tolerated when absent', () => {
    expect(parseApplyResult({ applied: false, conflictedFiles: [] })).toEqual({ applied: false, conflictedFiles: [] });
    expect(
      parseApplyResult({ applied: true, conflictedFiles: [], appliedFiles: ['a'], modeChanges: [{ path: 'a', from: '100644', to: '100755' }], snapshotTree: 'abc' }),
    ).toMatchObject({ applied: true, appliedFiles: ['a'], modeChanges: [{ path: 'a', from: '100644', to: '100755' }] });
    expect(parseApplyResult({ applied: false, conflictedFiles: [], partial: true, abortReason: 'r' })?.partial).toBe(true);
    // A pre-A6 shape without conflictedFiles is read as no conflicts.
    expect(parseApplyResult({ applied: false, abortReason: 'r' })?.conflictedFiles).toEqual([]);
    for (const bad of [null, [], { applied: 'yes' }, { applied: true, appliedFiles: [1] }, { applied: false, partial: 'true' }, { applied: true, modeChanges: [{ path: 'a' }] }]) {
      expect(parseApplyResult(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('A6 selection', () => {
  it('selectable: deleted, or taskBlob + taskMode present and not a symlink', () => {
    expect(entrySelectability(modified('a.ts'))).toBeNull();
    expect(entrySelectability({ path: 'g.txt', status: 'deleted' })).toBeNull();
    expect(entrySelectability(modified('x', { status: 'renamed', oldPath: 'w' }))).toBeNull();
    expect(entrySelectability(modified('ln', { taskMode: '120000' }))).toBe(REASON_SYMLINK);
    expect(entrySelectability({ path: 'big.bin', status: 'added' })).toBe(REASON_TOO_LARGE);
    expect(entrySelectability({ path: 'odd', status: 'added', taskBlob: BLOB })).toBe(REASON_NO_CONTENT_ID);
    expect(entrySelectability({ path: 'odd', status: 'added', taskMode: '100644' })).toBe(REASON_NO_CONTENT_ID);
    expect(entrySelectability({ path: 'odd', status: 'copied' as never, taskBlob: BLOB, taskMode: '100644' })).toMatch(/status/);
    expect([REASON_SYMLINK, REASON_TOO_LARGE, REASON_NO_CONTENT_ID]).toEqual([
      'symlinks are never applied',
      'too large or unreadable to apply (over 32 MiB)',
      'no reviewed content id',
    ]);
  });

  it('the pick plan: applicable entries first; the rest under ONE header as inert rows with the reason; "$(" is broken', () => {
    const cs = changeSet([
      modified('$(pass-filled) ok.ts'),
      modified('link', { taskMode: '120000' }),
      { path: 'huge.bin', status: 'added' },
      { path: 'gone.txt', status: 'deleted' },
    ]);
    const plan = applyPickPlan(cs, () => undefined);
    expect(plan.selectable.map((c) => c.path)).toEqual(['$(pass-filled) ok.ts', 'gone.txt']);
    expect(plan.items.map((i) => [i.label, i.separator, i.applicable])).toEqual([
      ['$ (pass-filled) ok.ts', false, true],
      ['gone.txt', false, true],
      [NOT_APPLICABLE_HEADER, true, false],
      ['(cannot be applied) link', false, false],
      ['(cannot be applied) huge.bin', false, false],
    ]);
    expect(plan.items.map((i) => i.entry)).toEqual([cs.changes[0], cs.changes[3], undefined, cs.changes[1], cs.changes[2]]);
    expect(plan.items[3]?.description).toBe('modified \u00b7 not selectable: symlinks are never applied');
    expect(plan.items[4]?.description).toBe('added \u00b7 not selectable: too large or unreadable to apply (over 32 MiB)');
    expect(plan.items.every((i) => i.picked === false)).toBe(true);
    for (const item of plan.items) {
      expect(item.label).not.toContain('$(');
      expect(item.description ?? '').not.toContain('$(');
    }
    // Nothing applicable: no header row at all when every entry applies.
    expect(applyPickPlan(changeSet([modified('a')]), () => undefined).items.some((i) => i.separator)).toBe(false);
    expect(notApplicableCopy([{ entry: cs.changes[1]!, reason: REASON_SYMLINK }])).toBe(
      'None of the checked entries can be applied: link (symlinks are never applied). Nothing was sent.',
    );
  });

  it('the modal lists checked rows that cannot be applied as NOT sent', () => {
    const view = applyConfirmationView({
      taskId: 't',
      repoPath: '/r',
      hostDirty: false,
      hostHooksPath: undefined,
      entries: [modified('a.ts')],
      diffFor: () => undefined,
      ignored: [{ entry: modified('ln', { taskMode: '120000' }), reason: REASON_SYMLINK }],
    });
    expect(view.button).toBe('Apply 1 file');
    expect(view.detail).toContain('Checked but NOT sent \u2014 these cannot be applied (1):\n\u00b7 ln \u2014 symlinks are never applied');
    expect(view.detail).toContain('Files (1):\n\u00b7 modified a.ts');
  });
});

describe('A6 confirmation flags', () => {
  it('(a) not fully shown: never opened, binary, truncated, lossy, or a diff without a content id', () => {
    const entry = modified('src/a.ts');
    expect(notFullyShownReason(entry, undefined)).toMatch(/never opened in the Diff view this session/);
    expect(notFullyShownReason(entry, diff({ binary: true }))).toMatch(/binary/);
    expect(notFullyShownReason(entry, diff({ truncated: true }))).toMatch(/truncated/);
    expect(notFullyShownReason(entry, diff({ lossy: true }))).toMatch(/UTF-8/);
    expect(notFullyShownReason(entry, diff({ taskBlob: undefined }))).toMatch(/content id/);
    expect(notFullyShownReason(entry, diff())).toBeNull();
    expect(notFullyShownReason({ path: 'g', status: 'deleted' }, diff({ path: 'g', status: 'deleted', taskBlob: undefined, taskMode: undefined }))).toBeNull();
  });

  it('(b) executable additions and exec-bit changes (taskMode 100755)', () => {
    expect(executableReason(modified('run.sh', { taskMode: '100755' }))).toMatch(/100755/);
    expect(executableReason(modified('a.ts'))).toBeNull();
    expect(executableReason({ path: 'g', status: 'deleted' })).toBeNull();
  });

  it('(c) paths that run automatically, on components, case-insensitively, incl. oldPath and hostHooksPath', () => {
    const runs = (path: string, oldPath?: string, hooks?: string) =>
      runsAutomaticallyReason(modified(path, oldPath ? { status: 'renamed', oldPath } : {}), hooks);
    for (const path of [
      '.husky/pre-commit',
      'pkg/.husky/pre-push',
      '.githooks/x',
      '.github/workflows/ci.yml',
      '.GitHub/Workflows/ci.yml',
      '.envrc',
      'sub/.envrc',
      '.vscode/tasks.json',
      '.idea/runConfigurations/x.xml',
      '.gitattributes',
      '.GitAttributes',
      'lib/.gitattributes',
      '.gitmodules',
    ]) {
      expect(runs(path), path).not.toBeNull();
    }
    for (const path of ['src/husky.ts', '.github/ISSUE_TEMPLATE.md', 'workflows/.github', 'x.envrc', '.vscodeignore', 'docs/.idea.md']) {
      expect(runs(path), path).toBeNull();
    }
    expect(runs('safe.ts', '.husky/pre-commit')).not.toBeNull();
    expect(runs('tools/hooks/pre-commit', undefined, 'tools/hooks/')).not.toBeNull();
    expect(runs('tools/hooks/pre-commit', undefined, './tools/hooks')).not.toBeNull();
    expect(runs('tools/hooksX/a', undefined, 'tools/hooks')).toBeNull();
    expect(runs('tools/hooks/a', undefined, '')).toBeNull();
  });

  it('the modal lists EVERY selected file revealed, names the repository, flags (a)(b)(c) separately and states the binding', () => {
    const entries: FileChange[] = [
      modified('evil\nline.txt', { status: 'added', taskMode: '100755' }),
      modified('new.ts', { status: 'renamed', oldPath: 'old\u202e.ts' }),
      { path: 'gone.txt', status: 'deleted' },
      modified('.github/workflows/ci.yml'),
      ...Array.from({ length: 30 }, (_, i) => modified(`many/f${i}.ts`)),
    ];
    const view = applyConfirmationView({
      taskId: 'task-a-123456789',
      repoPath: '/repo/at\u200blas',
      hostDirty: true,
      hostHooksPath: undefined,
      entries,
      diffFor: (c) => (c.path === 'many/f0.ts' ? diff({ path: 'many/f0.ts' }) : undefined),
    });
    expect(view.button).toBe('Apply 34 files');
    expect(applyButtonLabel(1)).toBe('Apply 1 file');
    const all = `${view.message}\n${view.detail}`;
    expect(all).toContain('/repo/at\\u200Blas');
    expect(all).not.toContain('\u200b');
    expect(all).toContain('added evil\\nline.txt');
    expect(all).not.toContain('evil\nline.txt');
    expect(all).toContain('renamed old\\u202E.ts → new.ts');
    expect(all).toContain('deleted gone.txt');
    for (let i = 0; i < 30; i += 1) expect(all).toContain(`modified many/f${i}.ts`);
    expect(all).toContain(BINDING_SENTENCE);
    expect(BINDING_SENTENCE).toBe(
      'Writes these files into your working tree and stages them. Nothing is committed. The content is the version Core hashed when you reviewed.',
    );
    expect(view.detail).toMatch(/\(a\) Content you have not fully seen \(33\)/);
    expect(view.detail).toMatch(/\(b\) Executable \(1\)/);
    expect(view.detail).toMatch(/\(c\) Runs automatically \(1\)/);
    expect(view.detail).toMatch(/\.github\/workflows\/ci\.yml/);
    expect(all).toMatch(/uncommitted changes/);
    expect(all).not.toMatch(/Core will abort rather than overwrite/);
  });

  it('flags with nothing to report still say "none"', () => {
    const view = applyConfirmationView({
      taskId: 't',
      repoPath: null,
      hostDirty: false,
      hostHooksPath: undefined,
      entries: [modified('a.ts')],
      diffFor: () => diff({ path: 'a.ts' }),
    });
    expect(view.detail).toMatch(/\(a\) Content you have not fully seen: none/);
    expect(view.detail).toMatch(/\(b\) Executable: none/);
    expect(view.detail).toMatch(/\(c\) Runs automatically: none/);
    expect(view.message).toContain("the task's repository (Core did not name it)");
  });
});

describe('A6 diff/entry mismatch', () => {
  it('a different taskBlob (or taskMode) in an opened diff is a mismatch; no diff or no blob is not', () => {
    const entry = modified('src/a.ts');
    expect(diffMismatch(entry, undefined)).toBe(false);
    expect(diffMismatch(entry, diff())).toBe(false);
    expect(diffMismatch(entry, diff({ taskBlob: BLOB2 }))).toBe(true);
    expect(diffMismatch(entry, diff({ taskMode: '100755' }))).toBe(true);
    expect(diffMismatch(entry, diff({ taskBlob: undefined }))).toBe(false);
  });

  it('records are keyed by task, status and exact path (tab/newline safe), bounded, forgettable and dropped on a new Core instance', () => {
    const store = new ReviewedDiffs(3);
    store.sync('inst-1');
    store.record('t1', diff({ path: 'a\tb' }));
    expect(store.get('t1', { path: 'a\tb', status: 'modified' })?.taskBlob).toBe(BLOB);
    expect(store.get('t1', { path: 'a', status: 'modified' })).toBeUndefined();
    expect(store.get('t1', { path: 'a\tb', status: 'added' })).toBeUndefined();
    expect(store.get('t2', { path: 'a\tb', status: 'modified' })).toBeUndefined();
    store.forget('t1', { path: 'a\tb', status: 'modified' });
    expect(store.get('t1', { path: 'a\tb', status: 'modified' })).toBeUndefined();
    for (const p of ['1', '2', '3', '4']) store.record('t1', diff({ path: p }));
    expect(store.get('t1', { path: '1', status: 'modified' })).toBeUndefined();
    expect(store.get('t1', { path: '4', status: 'modified' })).toBeDefined();
    store.sync('inst-1');
    expect(store.get('t1', { path: '4', status: 'modified' })).toBeDefined();
    store.sync('inst-2');
    expect(store.get('t1', { path: '4', status: 'modified' })).toBeUndefined();
  });
});

describe('A6 results', () => {
  const ctx = { repoPath: '/repo/atlas', selected: 2 };

  it('success: "Applied N files to <repo> (staged, not committed)" plus mode changes', () => {
    const view = applyResultView(
      { applied: true, conflictedFiles: [], appliedFiles: ['a.ts', 'run.sh'], modeChanges: [{ path: 'run.sh', from: '100644', to: '100755' }], snapshotTree: 'abc' },
      ctx,
    );
    expect(view.tone).toBe('ok');
    expect(view.text).toContain('Applied 2 files to /repo/atlas (staged, not committed)');
    expect(view.text).toContain('run.sh 100644 → 100755');
    expect(view.reReview).toBe(false);
  });

  it('partial: a warning with Core\'s reason (git status / index.lock), never success, never "nothing written"', () => {
    for (const reason of [
      "the write failed after git's checks passed; some files may have been written or staged — check `git status` in /repo/atlas; `.git/index.lock` may remain — remove it only after checking that no git process is running",
      'could not verify the staged content — check `git status` in /repo/atlas',
      'files were changed, but the staged content differs from the reviewed content — check `git status` in /repo/atlas',
    ]) {
      const view = applyResultView({ applied: false, partial: true, abortReason: reason, conflictedFiles: [], appliedFiles: ['a.ts'] }, ctx);
      expect(view.tone).toBe('warning');
      expect(view.text).toMatch(/may have been written or staged/);
      expect(view.text).toContain('git status');
      expect(view.text).toContain('a.ts');
      expect(view.text).not.toMatch(/^Applied/);
      expect(view.text).not.toMatch(/nothing (was )?(written|changed)/i);
    }
    const killed = applyResultView(
      { applied: false, partial: true, abortReason: APPLY_TEMPLATES.write_killed.replace('{}', '/repo/atlas'), conflictedFiles: [] },
      ctx,
    );
    expect(killed.text).toContain('.git/index.lock');
  });

  it('aborts: honest copy keyed on the exact constants, Core\'s reason shown revealed', () => {
    const changed = applyResultView({ applied: false, abortReason: APPLY_TEMPLATES.changed.replace('{}', '"src/a.ts"'), conflictedFiles: [] }, ctx);
    expect(changed.reReview).toBe(true);
    expect(changed.text).toMatch(/Review again/);
    expect(applyResultView({ applied: false, abortReason: MSG_ENTRIES_NOT_REVIEWED, conflictedFiles: [] }, ctx).reReview).toBe(true);
    const check = applyResultView({ applied: false, abortReason: MSG_CHECK_FAILED, conflictedFiles: ['a.ts', 'b\nc.ts'] }, ctx);
    expect(check.text).toMatch(/does not apply cleanly/);
    expect(check.text).toContain('b\\nc.ts');
    const unavailable = applyResultView({ applied: false, abortReason: MSG_CHECK_UNAVAILABLE, conflictedFiles: [] }, ctx);
    expect(unavailable.text).toMatch(/could not check/);
    expect(unavailable.text).not.toMatch(/does not apply cleanly/);
    for (const [reason, kind] of [
      [MSG_CONTENT_TOO_LARGE, 'content_too_large'],
      [MSG_PREPARE_TOO_SLOW, 'prepare_too_slow'],
      [MSG_WRITE_NOT_RUN, 'write_not_run'],
      [MSG_PATCH_TOO_LARGE, 'patch_too_large'],
      [MSG_DIRECT_MOUNT, 'direct_mount'],
      [APPLY_TEMPLATES.no_git_context, 'no_git_context'],
      [APPLY_TEMPLATES.dirty.replace('{}', '"a.ts"'), 'dirty'],
      [APPLY_TEMPLATES.hidden.replace('{}', '"a.ts"'), 'hidden'],
      [APPLY_TEMPLATES.leading_path.replace('{}', '"a.ts"'), 'leading_path'],
      [APPLY_TEMPLATES.symlink.replace('{}', '"a.ts"'), 'symlink'],
      [APPLY_TEMPLATES.base_symlink.replace('{}', '"a.ts"'), 'base_symlink'],
      [APPLY_TEMPLATES.filtered.replace('{}', '"a.ts"').replace('{}', '"lfs"'), 'filtered'],
      [APPLY_TEMPLATES.head_moved.replace('{}', 'aaa').replace('{}', 'bbb'), 'head_moved'],
      [APPLY_TEMPLATES.expected_base.replace('{}', 'aaa').replace('{}', 'bbb'), 'expected_base'],
      [APPLY_TEMPLATES.snapshot_differs.replace('{}', '"a.ts"'), 'snapshot_differs'],
    ] as const) {
      expect(classifyAbortReason(reason), reason).toBe(kind);
      const view = applyResultView({ applied: false, abortReason: reason, conflictedFiles: [] }, ctx);
      expect(view.tone).toBe('error');
      expect(view.text).toMatch(/nothing was written/);
    }
  });

  it('an unknown reason is shown verbatim (revealed, capped) and never upgraded to "nothing was written"', () => {
    const view = applyResultView({ applied: false, abortReason: 'brand new\u202e reason', conflictedFiles: [] }, ctx);
    expect(classifyAbortReason('brand new reason')).toBe('unknown');
    expect(view.text).toContain('brand new\\u202E reason');
    expect(view.text).not.toMatch(/nothing (was )?(written|changed)/i);
    const long = applyResultView({ applied: false, abortReason: 'x'.repeat(5000), conflictedFiles: [] }, ctx);
    expect(long.text.length).toBeLessThan(2500);
  });
});

describe('A6 errors', () => {
  const repo = '/repo/atlas';

  it('a timeout or lost answer: "may have been applied … check `git status` … before retrying", never "nothing changed"', () => {
    expect(lostAnswerCopy(repo)).toBe(
      'Core did not answer in time — the apply may have been applied; check `git status` in /repo/atlas before retrying.',
    );
    for (const reason of ['timeout', 'closed', 'send_failed'] as const) {
      const view = applyErrorView(new CoreTransportError(reason, 'x'), repo);
      expect(view?.text).toMatch(/may have been applied; check `git status` in \/repo\/atlas before retrying/);
      expect(view?.text).not.toMatch(/nothing (was )?(written|changed)/i);
      expect(view?.reReview).toBe(false);
    }
  });

  it('CONFLICT: the writer lock (retry later) and a direct mount (stop or remove it first) are told apart', () => {
    const locked = applyErrorView(rpc('CONFLICT', APPLY_TEMPLATES.locked.replace('{}', repo).replace('{}', 'task t9')), repo);
    expect(locked?.text).toMatch(/busy/);
    expect(locked?.text).toMatch(/try again/i);
    expect(locked?.text).toMatch(/nothing was written/);
    const mounted = applyErrorView(rpc('CONFLICT', APPLY_TEMPLATES.mounted.replace('{}', 'sandbox "atlas-live"')), repo);
    expect(mounted?.text).toMatch(/stop or remove/i);
    expect(mounted?.text).toContain('sandbox "atlas-live"');
    expect(mounted?.text).not.toMatch(/try again|shortly/i);
  });

  it('"nothing was sent" only when the frame provably never left; any other failure claims nothing', () => {
    expect(applyErrorView(new CoreValidationError('entries', 'x'), repo)).toBeNull();
    for (const reason of ['not_connected', 'untrusted_socket', 'unsupported_platform'] as const) {
      expect(applyErrorView(new CoreTransportError(reason, 'x'), repo), reason).toBeNull();
    }
    const others = [
      applyErrorView(rpc('PERMISSION_DENIED', 'policy says no'), repo),
      applyErrorView(rpc('TASK_INTERRUPTED', 'x'), repo),
      applyErrorView(rpc('FUTURE_CODE', 'something new'), repo),
      applyErrorView(new CoreTransportError('frame_too_large' as never, 'x'), repo),
      applyErrorView(new Error('bug'), repo),
    ];
    for (const view of others) {
      expect(view).not.toBeNull();
      expect(view?.text).not.toMatch(/nothing (was )?sent/i);
      expect(view?.text).not.toMatch(/Core did not apply/);
    }
    expect(others[0]?.text).toContain('PERMISSION_DENIED');
    expect(others[0]?.text).toContain('policy says no');
    expect(others[3]?.text).toMatch(/may have been applied/);
  });

  it('VALIDATION_FAILED / NOT_FOUND / INTERNAL', () => {
    expect(applyErrorView(rpc('VALIDATION_FAILED', MSG_NEEDS_REVIEW), repo)?.text).toMatch(/nothing was written/);
    expect(applyErrorView(rpc('VALIDATION_FAILED', MSG_TOO_MANY_ENTRIES), repo)?.text).toMatch(/1000/);
    expect(applyErrorView(rpc('NOT_FOUND', 'task not found'), repo)?.text).toMatch(/no such task/i);
    const internal = applyErrorView(rpc('INTERNAL', 'git ran, but Core could not record the outcome (x) — check `git status` in /repo/atlas'), repo);
    expect(internal?.text).toContain('could not record the outcome');
    expect(internal?.text).toMatch(/check `git status` in \/repo\/atlas/);
    expect(internal?.text).not.toMatch(/^.*nothing was written.*$/m);
  });
});

describe('A6 review fixes (V-W1/W2/W3, I3/I4)', () => {
  const repo = '/repo/atlas';

  it('V-W2: mount_being_created and MSG_WRITE_TOO_LATE equal the Rust sources and are keyed', () => {
    expect(rustTemplate(gitApplyRs, 'msg_mount_being_created')).toBe(APPLY_TEMPLATES.mount_being_created);
    expect(rustConst(applyRs, 'MSG_WRITE_TOO_LATE')).toBe(MSG_WRITE_TOO_LATE);
    expect(classifyAbortReason(MSG_WRITE_TOO_LATE)).toBe('write_not_run');
    const late = applyResultView({ applied: false, abortReason: MSG_WRITE_TOO_LATE, conflictedFiles: [] }, { repoPath: repo, selected: 1 });
    expect(late.text).toMatch(/^Not applied — git apply was never started/);
    const message = APPLY_TEMPLATES.mount_being_created.replace('{}', repo).replace('{}', '"atlas-live"');
    // Not mistaken for the writer lock (both start "<repo> is busy: ").
    expect(matchesTemplate(message, APPLY_TEMPLATES.locked)).toBe(false);
    const view = applyErrorView(rpc('CONFLICT', message), repo);
    expect(view?.text).toMatch(/a direct-mount sandbox is being created for this repository/);
    expect(view?.text).toMatch(/once it exists, every apply is refused until it is stopped or removed/);
    expect(view?.text).toContain('"atlas-live"');
    expect(view?.text).not.toMatch(/try again after it finishes/i);
  });

  it('V-W3: sandbox.create CONFLICTs (repository busy) are keyed with their own copy and drift-tested', () => {
    expect(rustTemplate(gitApplyRs, 'msg_create_repo_busy')).toBe(CREATE_BUSY_TEMPLATES.repo_busy);
    expect(rustTemplate(gitApplyRs, 'msg_create_mount_in_progress')).toBe(CREATE_BUSY_TEMPLATES.mount_in_progress);
    const busy = rpc('CONFLICT', CREATE_BUSY_TEMPLATES.repo_busy.replace('{}', repo).replace('{}', 'git.apply:t1'));
    const inProgress = rpc('CONFLICT', CREATE_BUSY_TEMPLATES.mount_in_progress.replace('{}', repo).replace('{}', '"atlas-2"'));
    for (const error of [busy, inProgress]) {
      expect(createBusyCopy(error)).toBe(CREATE_BUSY_COPY);
    }
    expect(CREATE_BUSY_COPY).toBe('Repository busy — nothing was created; try again when it finishes.');
    expect(createBusyCopy(rpc('CONFLICT', 'another operation on sandbox "x" is in progress; nothing was run'))).toBeNull();
    expect(createBusyCopy(rpc('VALIDATION_FAILED', busy.message))).toBeNull();
  });

  it('I3: GIT_APPLY_TIMEOUT_MS equals Core\'s CLIENT_APPLY_DEADLINE', () => {
    const m = /pub const CLIENT_APPLY_DEADLINE: Duration = Duration::from_secs\((\d+)\);/.exec(applyRs);
    expect(Number(m?.[1]) * 1000).toBe(GIT_APPLY_TIMEOUT_MS);
  });

  it('I4: "$(" from Core text is broken in every result / error notification', () => {
    const texts = [
      applyResultView({ applied: false, abortReason: 'odd $(alert) reason', conflictedFiles: ['$(x).ts'] }, { repoPath: '/r/$(y)', selected: 1 }).text,
      applyResultView({ applied: false, partial: true, abortReason: '$(z)', conflictedFiles: [], appliedFiles: ['$(w)'] }, { repoPath: null, selected: 1 }).text,
      applyResultView({ applied: true, conflictedFiles: [], appliedFiles: ['a'], modeChanges: [{ path: '$(v)', from: '1', to: '2' }] }, { repoPath: '/$(u)', selected: 1 }).text,
      applyErrorView(rpc('INTERNAL', 'boom $(flame)'), '/$(r)')?.text ?? '',
      applyErrorView(new CoreTransportError('timeout', 'x'), '/$(r)')?.text ?? '',
      lostAnswerCopy('/$(r)'),
      mismatchCopy([modified('$(m).ts')]),
    ];
    for (const text of texts) expect(text).not.toContain('$(');
  });

  it('V-W1: the modal caps its file list at 50 (+ "and K more", the full list in the editor); flags stay complete', () => {
    const entries = Array.from({ length: 60 }, (_, i) => modified(`many/f${i}.ts`));
    const view = applyConfirmationView({ taskId: 't', repoPath: repo, hostDirty: false, hostHooksPath: undefined, entries, diffFor: () => undefined });
    expect(MODAL_LIST_CAP).toBe(50);
    expect(view.detail).toContain('modified many/f49.ts');
    expect(view.detail).not.toMatch(/· modified many\/f50\.ts/);
    expect(view.detail).toContain('… and 10 more — the full list is open in the editor');
    // (a) lists all 60, uncapped.
    expect(view.detail).toMatch(/\(a\) Content you have not fully seen \(60\)/);
    expect(view.detail).toContain('many/f59.ts — never opened in the Diff view this session');
    const doc = renderApplyListDocument({ taskId: 'task-a', repoPath: '/repo/at\u200blas', hostDirty: false, hostHooksPath: undefined, entries, diffFor: () => undefined });
    for (let i = 0; i < 60; i += 1) expect(doc).toContain(`modified many/f${i}.ts`);
    expect(doc).toContain('/repo/at\\u200Blas');
    expect(doc).toContain(BINDING_SENTENCE);
    expect(doc).toMatch(/read-only/);
    // 50 or fewer: no cap line.
    const small = applyConfirmationView({ taskId: 't', repoPath: repo, hostDirty: false, hostHooksPath: undefined, entries: entries.slice(0, 50), diffFor: () => undefined });
    expect(small.detail).not.toContain('more — the full list');
  });

  it('V-W1: the typed second step asks for exactly N, never pre-filled, and only the exact value confirms', () => {
    const options = typedConfirmation(12, '/repo/at\u202elas');
    expect(options).toEqual({
      ignoreFocusOut: true,
      title: 'Apply 12 files to /repo/at\\u202Elas',
      prompt: 'Type 12 to write and stage these files. Nothing is committed.',
      validateInput: options.validateInput,
    });
    expect(options).not.toHaveProperty('value');
    expect(options.validateInput('12')).toBeNull();
    for (const bad of ['', ' 12', '12 ', '012', '11', 'twelve', '12\n']) {
      expect(options.validateInput(bad), JSON.stringify(bad)).toBe('Type 12 to apply, or press Escape to cancel');
      expect(typedConfirmed(bad, 12)).toBe(false);
    }
    expect(typedConfirmed(undefined, 12)).toBe(false);
    expect(typedConfirmed('12', 12)).toBe(true);
    expect(typedConfirmation(1, null).title).toBe("Apply 1 file to the task's repository (Core did not name it)");
  });
});
