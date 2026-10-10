/**
 * A3a project lifecycle (design 2026-10-09 §3.2), client side, pure units:
 *  - the typed wrappers emit exactly the documented frames;
 *  - the project name / description validators mirror `Validator::project_name`
 *    / `Validator::project_description` (never stricter, never looser), with a
 *    drift check against the Rust source;
 *  - every exact Core message the client maps equals Core's `pub const`, and its
 *    copy keeps Core's "nothing was …"; anything else is never mapped;
 *  - the delete confirmation view (A1 two-step pattern) names the project, caps
 *    and escapes impact lines, shows the expiry and never the token.
 *
 * Hostile characters are built with String.fromCodePoint, never written raw.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CoreCommands,
  CoreValidationError,
  MAX_PROJECT_DESCRIPTION_CHARS,
  MAX_PROJECT_NAME_CHARS,
  PROJECT_GIT_TIMEOUT_MS,
  validateProjectDescription,
  validateProjectName,
} from '../src/core-client/commands';
import { CoreRpcError } from '../src/core-client/connection';
import type { ErrorCode } from '../src/core-client/events';
import { PROTOCOL_VERSION, type ConfirmationRequest, type Project } from '../src/core-client/protocol';
import {
  ARCHIVED_LABEL,
  DELETE_PROJECT_BUTTON,
  MSG_PROJECT_ARCHIVED,
  MSG_PROJECT_CREATE_IN_FLIGHT,
  MSG_PROJECT_HAS_SANDBOXES,
  MSG_PROJECT_HAS_TASKS,
  MSG_PROJECT_NOT_FOUND,
  MSG_REPOSITORY_IN_USE,
  MSG_REPOSITORY_NOT_REGISTERED,
  MSG_REPOSITORY_REMOVE_WHILE_CREATING,
  MSG_REPOSITORY_UNREGISTERED_DURING_CREATE,
  MSG_UPDATE_NEEDS_A_FIELD,
  TOKEN_REJECTED_MESSAGE,
  isArchived,
  projectDeleteView,
  projectErrorCopy,
  projectPickItem,
} from '../src/vscode/projectActions';
import { EXTERNAL_MARKER, MAX_IMPACT_LINES } from '../src/vscode/sandboxActions';
import { makeHarness } from './helpers/fakeCore';

const TOKEN = 'b'.repeat(32) + '0123456789abcdef0123456789abcdef';
const NOW = Date.parse('2026-10-10T12:00:00Z');
const cp = (n: number): string => String.fromCodePoint(n);
const rpc = (code: string, message: string): CoreRpcError =>
  new CoreRpcError({ code: code as ErrorCode, message }, 'r1');
const repoRoot = resolve(process.cwd(), '..', '..');
const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), 'utf8');

function confirmation(overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return {
    token: TOKEN,
    expiresAt: '2026-10-10T12:02:00Z',
    action: 'project.delete',
    target: { name: 'Atlas Demo', id: 'p1' },
    impact: ['deletes 2 conversation(s), 5 message(s) and 2 task(s)', 'task branches in the host repositories are left in place'],
    external: false,
    ...overrides,
  };
}

/** Run a wrapper on a live fake connection; answer any frame with `ok`. */
async function frameOf(call: (c: CoreCommands) => Promise<unknown>, ok: unknown = {}) {
  const h = makeHarness();
  await h.conn.connect();
  const commands = new CoreCommands(h.conn);
  const written = h.transport.writes.length;
  const promise = call(commands).then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as unknown, error }),
  );
  await Promise.resolve();
  if (h.transport.writes.length > written) {
    const frame = h.transport.lastRequest();
    h.transport.respond({ v: PROTOCOL_VERSION, id: frame.id, ok });
    return { frame, ...(await promise) };
  }
  return { frame: undefined, ...(await promise) };
}

describe('A3a wrappers emit exact frames', () => {
  const project = { id: 'p1', name: 'Atlas Demo', description: '', createdAt: '' };

  it('project.list sends {} by default and {includeArchived:true} only when asked', async () => {
    expect((await frameOf((c) => c.projectList(), [])).frame?.params).toEqual({});
    expect((await frameOf((c) => c.projectList({ includeArchived: false }), [])).frame?.params).toEqual({});
    expect((await frameOf((c) => c.projectList({ includeArchived: true }), [])).frame?.params).toEqual({
      includeArchived: true,
    });
  });

  it('project.update sends only the fields given; refuses an empty update locally', async () => {
    const rename = await frameOf((c) => c.projectUpdate({ projectId: 'p1', name: 'Atlas Renamed' }), project);
    expect(rename.frame).toEqual({
      v: PROTOCOL_VERSION,
      id: 'test-1',
      method: 'project.update',
      params: { projectId: 'p1', name: 'Atlas Renamed' },
    });
    const clear = await frameOf((c) => c.projectUpdate({ projectId: 'p1', description: '' }), project);
    expect(clear.frame?.params).toEqual({ projectId: 'p1', description: '' });
    const none = await frameOf((c) => c.projectUpdate({ projectId: 'p1' }), project);
    expect(none.frame).toBeUndefined();
    expect(none.error).toBeInstanceOf(CoreValidationError);
  });

  it('archive / unarchive / add / remove repository send {projectId[, path]}', async () => {
    expect((await frameOf((c) => c.projectArchive('p1'), project)).frame).toMatchObject({
      method: 'project.archive',
      params: { projectId: 'p1' },
    });
    expect((await frameOf((c) => c.projectUnarchive('p1'), project)).frame).toMatchObject({
      method: 'project.unarchive',
      params: { projectId: 'p1' },
    });
    expect((await frameOf((c) => c.projectAddRepository({ projectId: 'p1', path: '/repo/atlas' }), project)).frame).toMatchObject({
      method: 'project.add_repository',
      params: { projectId: 'p1', path: '/repo/atlas' },
    });
    expect((await frameOf((c) => c.projectRemoveRepository({ projectId: 'p1', path: '/repo/atlas' }), project)).frame).toMatchObject({
      method: 'project.remove_repository',
      params: { projectId: 'p1', path: '/repo/atlas' },
    });
  });

  it('refuses a relative repository path and an empty project id before any frame', async () => {
    for (const call of [
      (c: CoreCommands) => c.projectRemoveRepository({ projectId: 'p1', path: 'repo/atlas' }),
      (c: CoreCommands) => c.projectAddRepository({ projectId: '', path: '/repo/atlas' }),
      (c: CoreCommands) => c.projectArchive(''),
      (c: CoreCommands) => c.projectDeleteConfirm('p1', TOKEN.toUpperCase()),
    ]) {
      const { frame, error } = await frameOf(call);
      expect(frame).toBeUndefined();
      expect(error).toBeInstanceOf(CoreValidationError);
    }
  });

  it('W2: project.add_repository and project.create get a 45 s deadline (Core git canonicalization may take 30 s); the others keep 15 s', async () => {
    const h = makeHarness({ requestTimeoutMs: 15_000 });
    await h.conn.connect();
    const commands = new CoreCommands(h.conn);
    void commands.projectAddRepository({ projectId: 'p1', path: '/repo/atlas' }).catch(() => undefined);
    void commands.projectCreate({ name: 'Atlas Demo', repositories: ['/repo/atlas'] }).catch(() => undefined);
    void commands.projectRemoveRepository({ projectId: 'p1', path: '/repo/atlas' }).catch(() => undefined);
    void commands.projectUpdate({ projectId: 'p1', name: 'Atlas Renamed' }).catch(() => undefined);
    expect(PROJECT_GIT_TIMEOUT_MS).toBe(45_000);
    expect(h.timers.pending.map((t) => t.ms).sort((a, b) => a - b)).toEqual([15_000, 15_000, 45_000, 45_000]);
  });

  it('W2 drift: the 45 s deadline stays above Core\'s git limit (RunLimits::QUERY, used by the git toplevel check)', () => {
    const processRs = read('core/crates/sandpane-core/src/process.rs');
    const query = /pub const QUERY: RunLimits = RunLimits \{\s*timeout: Duration::from_secs\((\d+)\)/.exec(processRs);
    expect(query?.[1]).toBeDefined();
    expect(PROJECT_GIT_TIMEOUT_MS).toBeGreaterThan(Number(query?.[1]) * 1000);
    expect(read('core/crates/sandpane-core/src/git.rs')).toContain('limits: RunLimits::QUERY,');
  });

  it('delete step 1 sends {projectId} with NO token; step 2 sends {projectId, confirmToken}', async () => {
    const step1 = await frameOf((c) => c.projectDeleteRequest('p1'), { confirmation: confirmation() });
    expect(step1.frame?.params).toEqual({ projectId: 'p1' });
    expect(Object.keys(step1.frame?.params as object)).not.toContain('confirmToken');
    expect((step1.value as ConfirmationRequest).target).toEqual({ name: 'Atlas Demo', id: 'p1' });
    const step2 = await frameOf((c) => c.projectDeleteConfirm('p1', TOKEN), { deleted: true });
    expect(step2.frame?.params).toEqual({ projectId: 'p1', confirmToken: TOKEN });
    expect(step2.value).toEqual({ deleted: true });
  });

  it('step 1 refuses an answer for another id, another action, or one claiming deleted:true', async () => {
    for (const ok of [
      { confirmation: confirmation({ target: { name: 'Atlas Demo', id: 'p2' } }) },
      { confirmation: confirmation({ action: 'sandbox.remove' }) },
      { confirmation: confirmation(), deleted: true },
      { deleted: true },
    ]) {
      const { error } = await frameOf((c) => c.projectDeleteRequest('p1'), ok);
      expect(error, JSON.stringify(ok)).toBeInstanceOf(Error);
    }
  });
});

describe('project name / description validators mirror Core exactly', () => {
  const nameRefused: Array<[string, string]> = [
    ['empty', ''],
    ['newline', 'Atlas\nDemo'],
    ['tab', 'Atlas\tDemo'],
    ['CR', 'Atlas\rDemo'],
    ['NUL', `Atlas${cp(0)}`],
    ['DEL', `Atlas${cp(0x7f)}`],
    ['C1 NEL', `Atlas${cp(0x85)}`],
    ['C1 end', `Atlas${cp(0x9f)}`],
    ['line separator', `Atlas${cp(0x2028)}Demo`],
    ['paragraph separator', `Atlas${cp(0x2029)}Demo`],
    ['LRM', `Atlas${cp(0x200e)}`],
    ['RLM', `Atlas${cp(0x200f)}`],
    ['ALM', `Atlas${cp(0x061c)}`],
    ['LRE', `${cp(0x202a)}Atlas`],
    ['RLO', `${cp(0x202e)}Atlas`],
    ['LRI', `${cp(0x2066)}Atlas`],
    ['FSI', `a${cp(0x2068)}b`],
    ['PDI', `Atlas${cp(0x2069)}`],
    ['lone surrogate', `Atlas${String.fromCharCode(0xd800)}`],
    ['too long', 'é'.repeat(MAX_PROJECT_NAME_CHARS + 1)],
  ];
  it.each(nameRefused)('name refuses %s', (_label, value) => {
    expect(() => validateProjectName(value)).toThrow(CoreValidationError);
  });

  const nameAllowed: Array<[string, string]> = [
    ['plain', 'Atlas Demo'],
    ['unicode', 'Atlas Demo — ü 漢字'],
    ['exactly max chars (multi-byte)', 'é'.repeat(MAX_PROJECT_NAME_CHARS)],
    ['astral chars count once', cp(0x1f600).repeat(MAX_PROJECT_NAME_CHARS)],
    ['ZWSP (Core does not refuse it)', `Atlas${cp(0x200b)}Demo`],
    ['U+2065 (just below the isolates)', `Atlas${cp(0x2065)}`],
    ['U+202F (just above the overrides)', `Atlas${cp(0x202f)}`],
    ['leading/trailing spaces (Core does not trim)', ' Atlas '],
    ['U+00A0 (first char after C1)', `Atlas${cp(0xa0)}`],
  ];
  it.each(nameAllowed)('name allows %s', (_label, value) => {
    expect(validateProjectName(value)).toBe(value);
  });

  it('description: empty clears, \\n allowed, every other control and spoofing char refused', () => {
    expect(validateProjectDescription('')).toBe('');
    expect(validateProjectDescription('line one\nline two — ü 漢字')).toBe('line one\nline two — ü 漢字');
    expect(validateProjectDescription('é'.repeat(MAX_PROJECT_DESCRIPTION_CHARS))).toHaveLength(MAX_PROJECT_DESCRIPTION_CHARS);
    expect(() => validateProjectDescription('é'.repeat(MAX_PROJECT_DESCRIPTION_CHARS + 1))).toThrow(CoreValidationError);
    expect(validateProjectDescription(`a${cp(0x200b)}b`)).toBe(`a${cp(0x200b)}b`);
    for (const bad of ['a\tb', 'a\rb', `a${cp(0x7f)}`, `a${cp(0x85)}`, `a${cp(0x2028)}`, `a${cp(0x200f)}`, `a${cp(0x061c)}`, `a${cp(0x202b)}`, `a${cp(0x2067)}`, `a${String.fromCharCode(0xdc00)}`]) {
      expect(() => validateProjectDescription(bad), JSON.stringify(bad)).toThrow(CoreValidationError);
    }
  });

  it('project.create uses the same name rule (a newline name never leaves the client)', async () => {
    const { frame, error } = await frameOf((c) => c.projectCreate({ name: 'Atlas\nDemo', repositories: [] }));
    expect(frame).toBeUndefined();
    expect(error).toBeInstanceOf(CoreValidationError);
  });

  it('drift: Core\'s validator source still says what this client mirrors', () => {
    const validation = read('core/crates/sandpane-core/src/validation.rs');
    expect(validation).toContain(`pub const MAX_PROJECT_NAME_CHARS: usize = ${MAX_PROJECT_NAME_CHARS};`);
    expect(validation).toContain(`pub const MAX_PROJECT_DESCRIPTION_CHARS: usize = ${MAX_PROJECT_DESCRIPTION_CHARS};`);
    const spoof = /fn is_spoofing_format_char\(c: char\) -> bool \{[\s\S]*?\n\}/.exec(validation)?.[0] ?? '';
    const ranges = [...spoof.matchAll(/'\\u\{([0-9A-Fa-f]+)\}'(?:\s*\.\.=\s*'\\u\{([0-9A-Fa-f]+)\}')?/g)].map((m) =>
      m[2] ? `${m[1] ?? ''}..=${m[2]}` : (m[1] ?? ''),
    );
    expect(ranges.map((r) => r.toUpperCase())).toEqual(['2028', '2029', '200E', '200F', '061C', '202A..=202E', '2066..=2069']);
    const nameFn = /pub fn project_name\(value: &str\)[\s\S]*?\n    \}/.exec(validation)?.[0] ?? '';
    expect(nameFn).toContain('Self::bounded(value, MAX_PROJECT_NAME_CHARS)?;');
    expect(nameFn).toContain('.find(|c| c.is_control() || is_spoofing_format_char(*c))');
    expect(nameFn).not.toMatch(/trim/);
    const descFn = /pub fn project_description\(value: &str\)[\s\S]*?\n    \}/.exec(validation)?.[0] ?? '';
    expect(descFn).toContain('value.chars().count() > MAX_PROJECT_DESCRIPTION_CHARS');
    expect(descFn).toContain("(c.is_control() && *c != '\\n') || is_spoofing_format_char(*c)");
    const bounded = /fn bounded\(value: &str, max: usize\)[\s\S]*?\n    \}/.exec(validation)?.[0] ?? '';
    expect(bounded).toContain('value.is_empty()');
    expect(bounded).toContain('value.chars().count() > max');
    // project.create and project.update both call the same validator.
    const lifecycle = read('core/crates/sandpane-service/src/project_lifecycle.rs');
    expect(lifecycle).toContain('Validator::project_name');
    expect(lifecycle).toContain('Validator::project_description');
  });
});

describe('Core\'s exact messages and their client copy', () => {
  /** A Rust `pub const NAME: &str = "...";`, `\`-newline continuations folded. */
  const rustStr = (source: string, name: string): string => {
    const m = new RegExp(`pub const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)";`).exec(source);
    if (!m?.[1]) throw new Error(`no \`pub const ${name}\``);
    return m[1].replace(/\\\n\s*/g, '');
  };

  it('every mapped message equals the Rust constant', () => {
    const lifecycle = read('core/crates/sandpane-service/src/project_lifecycle.rs');
    const confirm = read('core/crates/sandpane-service/src/confirm.rs');
    expect(rustStr(lifecycle, 'MSG_PROJECT_ARCHIVED')).toBe(MSG_PROJECT_ARCHIVED);
    expect(rustStr(lifecycle, 'MSG_PROJECT_HAS_TASKS')).toBe(MSG_PROJECT_HAS_TASKS);
    expect(rustStr(lifecycle, 'MSG_PROJECT_HAS_SANDBOXES')).toBe(MSG_PROJECT_HAS_SANDBOXES);
    expect(rustStr(lifecycle, 'MSG_REPOSITORY_IN_USE')).toBe(MSG_REPOSITORY_IN_USE);
    expect(rustStr(lifecycle, 'MSG_PROJECT_CREATE_IN_FLIGHT')).toBe(MSG_PROJECT_CREATE_IN_FLIGHT);
    expect(rustStr(lifecycle, 'MSG_REPOSITORY_REMOVE_WHILE_CREATING')).toBe(MSG_REPOSITORY_REMOVE_WHILE_CREATING);
    expect(rustStr(lifecycle, 'MSG_REPOSITORY_UNREGISTERED_DURING_CREATE')).toBe(MSG_REPOSITORY_UNREGISTERED_DURING_CREATE);
    expect(rustStr(lifecycle, 'MSG_PROJECT_NOT_FOUND')).toBe(MSG_PROJECT_NOT_FOUND);
    expect(rustStr(lifecycle, 'MSG_REPOSITORY_NOT_REGISTERED')).toBe(MSG_REPOSITORY_NOT_REGISTERED);
    expect(rustStr(lifecycle, 'MSG_UPDATE_NEEDS_A_FIELD')).toBe(MSG_UPDATE_NEEDS_A_FIELD);
    expect(rustStr(confirm, 'TOKEN_REJECTED_MESSAGE')).toBe(TOKEN_REJECTED_MESSAGE);
  });

  const mapped: Array<[string, string, RegExp]> = [
    ['VALIDATION_FAILED', MSG_PROJECT_ARCHIVED, /nothing was changed/],
    ['CONFLICT', MSG_PROJECT_HAS_TASKS, /nothing was deleted/],
    ['CONFLICT', MSG_PROJECT_HAS_SANDBOXES, /nothing was deleted/],
    ['CONFLICT', MSG_PROJECT_CREATE_IN_FLIGHT, /nothing was deleted/],
    ['CONFLICT', MSG_REPOSITORY_IN_USE, /nothing was removed/],
    ['CONFLICT', MSG_REPOSITORY_REMOVE_WHILE_CREATING, /nothing was removed/],
    ['CONFLICT', MSG_REPOSITORY_UNREGISTERED_DURING_CREATE, /nothing was run/],
    ['NOT_FOUND', MSG_PROJECT_NOT_FOUND, /nothing was changed/],
    ['NOT_FOUND', MSG_REPOSITORY_NOT_REGISTERED, /nothing was removed/],
    ['VALIDATION_FAILED', MSG_UPDATE_NEEDS_A_FIELD, /nothing was changed/],
    ['VALIDATION_FAILED', TOKEN_REJECTED_MESSAGE, /Nothing was deleted/],
  ];
  it.each(mapped)('%s "%s" maps to copy that keeps Core\'s outcome', (code, message, outcome) => {
    const copy = projectErrorCopy(rpc(code, message));
    expect(copy).toMatch(outcome);
  });

  it('never maps a different code, a near-miss message, INTERNAL or a non-RPC error', () => {
    expect(projectErrorCopy(rpc('CONFLICT', MSG_PROJECT_HAS_TASKS))).not.toBeNull(); // control
    expect(projectErrorCopy(rpc('CONFLICT', MSG_PROJECT_ARCHIVED))).toBeNull();
    expect(projectErrorCopy(rpc('CONFLICT', `${MSG_PROJECT_HAS_TASKS}.`))).toBeNull();
    expect(projectErrorCopy(rpc('INTERNAL', MSG_PROJECT_HAS_TASKS))).toBeNull();
    expect(projectErrorCopy(new Error(MSG_PROJECT_HAS_TASKS))).toBeNull();
  });
});

describe('archived labels and picker rows', () => {
  const base: Project = { id: 'p1-0123456789', name: 'Atlas Demo', description: '', createdAt: '' };

  it('labels archived projects visibly and keeps live ones plain', () => {
    expect(isArchived(base)).toBe(false);
    expect(isArchived({ ...base, archivedAt: null })).toBe(false);
    expect(isArchived({ ...base, archivedAt: '2026-10-10T11:00:00Z' })).toBe(true);
    expect(projectPickItem(base).description).toBe('id p1-01234');
    expect(projectPickItem({ ...base, archivedAt: '2026-10-10T11:00:00Z' }).description).toBe(`${ARCHIVED_LABEL} · id p1-01234`);
  });

  it('escapes hostile project names and codicon syntax in picker labels', () => {
    const item = projectPickItem({ ...base, name: `$(warning) ${cp(0x202e)}omed`, repositories: ['/repo/a'] });
    expect(item.label).not.toContain(cp(0x202e));
    expect(item.label).not.toMatch(/^\$\(/);
    expect(item.detail).toBe('1 repository(ies): /repo/a');
  });
});

describe('projectDeleteView — the A1 two-step pattern for projects', () => {
  it('names the project and id, lists impact, shows expiry and never the token', () => {
    const view = projectDeleteView(confirmation(), NOW);
    expect(view.message).toBe('Delete project "Atlas Demo"?');
    expect(view.button).toBe(DELETE_PROJECT_BUTTON);
    expect(view.detail).toContain('Project: Atlas Demo');
    expect(view.detail).toContain('Project id: p1');
    expect(view.detail).toContain('• deletes 2 conversation(s), 5 message(s) and 2 task(s)');
    expect(view.detail).toContain('(in about 120 s)');
    expect(view.detail).toContain('host files, branches and sandboxes are not touched');
    expect(view.detail).toContain('Cancel sends nothing');
    expect(view.detail).not.toContain(TOKEN);
    expect(view.detail).not.toContain(EXTERNAL_MARKER);
    expect(view.altered).toBe(false);
  });

  it('caps impact at 20 lines, counts the rest, and escapes hidden characters', () => {
    const impact = Array.from({ length: MAX_IMPACT_LINES + 5 }, (_, i) => `line ${i}`);
    impact[0] = `evil ${cp(0x202e)}gnp.exe`;
    const view = projectDeleteView(confirmation({ impact, target: { name: `Atlas${cp(0x200f)}`, id: 'p1' } }), NOW);
    expect(view.detail.match(/^• /gm)).toHaveLength(MAX_IMPACT_LINES);
    expect(view.detail).toContain('(+5 more impact line(s) not shown)');
    expect(view.detail).not.toContain(cp(0x202e));
    expect(view.message).not.toContain(cp(0x200f));
    expect(view.altered).toBe(true);
    expect(view.detail).toContain('WARNING: text from Core contained invisible or control characters');
  });

  it('an expired or unreadable expiry says it cannot be used and points at Delete Project', () => {
    expect(projectDeleteView(confirmation({ expiresAt: '2026-10-10T11:59:00Z' }), NOW).detail).toMatch(/expired/);
    const unreadable = projectDeleteView(confirmation({ expiresAt: 'soon' }), NOW).detail;
    expect(unreadable).toContain('cannot be used');
    expect(unreadable).toContain('run Delete Project again');
    expect(unreadable).not.toContain('run Remove again');
  });

  it('if Core ever marks a project confirmation external, it is shown, never hidden', () => {
    const view = projectDeleteView(confirmation({ external: true }), NOW);
    expect(view.message.startsWith(EXTERNAL_MARKER)).toBe(true);
  });
});
