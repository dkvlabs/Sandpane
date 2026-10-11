/**
 * A3b conversation lifecycle (design 2026-10-09 §3.3), client side, pure units:
 *  - the five typed wrappers emit exactly the documented frames, with the
 *    default deadline, and `conversation.list` sends `includeArchived` only
 *    when asked;
 *  - the title validator mirrors `Validator::conversation_title` (and the
 *    rename whitespace-only refusal, using Rust's White_Space set) — never
 *    stricter, never looser — with a drift check against the Rust source;
 *  - every exact Core message the client maps equals Core's `pub const`, and
 *    its copy keeps Core's "nothing was …"; anything else is never mapped;
 *  - the delete confirmation view (A1 two-step pattern);
 *  - the export collector: paging until `truncated` is false, a cursor that
 *    does not advance or the page cap stops as PARTIAL, any page failure
 *    yields no document, and redaction counts are summed across pages;
 *  - the export file name, the "sandbox chosen at creation" label and the
 *    title derived from a first message.
 *
 * Hostile characters are built with String.fromCodePoint, never written raw.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CoreCommands,
  CoreValidationError,
  MAX_CONVERSATION_TITLE_CHARS,
  isRustBlank,
  validateConversationRenameTitle,
  validateConversationTitle,
} from '../src/core-client/commands';
import { CoreRpcError } from '../src/core-client/connection';
import type { ErrorCode } from '../src/core-client/events';
import {
  CONVERSATION_EXPORT_FORMAT,
  PROTOCOL_VERSION,
  type ConfirmationRequest,
  type Conversation,
} from '../src/core-client/protocol';
import {
  EXPORT_BEST_EFFORT_COPY,
  EXPORT_NOTE,
  EXPORT_PAGE_CAP,
  collectConversationExport,
} from '../src/core-client/conversationExport';
import {
  ARCHIVED_CONVERSATION_LABEL,
  DELETE_CONVERSATION_BUTTON,
  MSG_CONVERSATION_ARCHIVED,
  MSG_CONVERSATION_HAS_TASKS,
  MSG_CONVERSATION_NOT_FOUND,
  MSG_TITLE_BLANK,
  conversationDeleteView,
  conversationErrorCopy,
  conversationSandboxLabel,
  conversationTitleProblem,
  exportFileName,
  isConversationArchived,
  titleFromMessage,
} from '../src/vscode/conversationActions';
import { MSG_PROJECT_ARCHIVED, TOKEN_REJECTED_MESSAGE } from '../src/vscode/projectActions';
import { MAX_IMPACT_LINES } from '../src/vscode/sandboxActions';
import { makeHarness } from './helpers/fakeCore';

const TOKEN = 'c'.repeat(32) + '0123456789abcdef0123456789abcdef';
const NOW = Date.parse('2026-10-11T12:00:00Z');
const cp = (n: number): string => String.fromCodePoint(n);
const rpc = (code: string, message: string): CoreRpcError =>
  new CoreRpcError({ code: code as ErrorCode, message }, 'r1');
const repoRoot = resolve(process.cwd(), '..', '..');
const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), 'utf8');

const conv: Conversation = { id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', createdAt: '' };

function confirmation(overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return {
    token: TOKEN,
    expiresAt: '2026-10-11T12:02:00Z',
    action: 'conversation.delete',
    target: { name: 'Auth', id: 'c1' },
    impact: [
      'deletes conversation Auth and all of its Core records; this cannot be undone',
      '3 messages and 1 task are deleted, with their task events, artifacts and verification records',
    ],
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

describe('A3b wrappers emit exact frames', () => {
  it('conversation.list sends includeArchived:true only when asked', async () => {
    expect((await frameOf((c) => c.conversationList({ projectId: 'p1' }), [])).frame?.params).toEqual({ projectId: 'p1' });
    expect(
      (await frameOf((c) => c.conversationList({ projectId: 'p1', includeArchived: false }), [])).frame?.params,
    ).toEqual({ projectId: 'p1' });
    expect(
      (await frameOf((c) => c.conversationList({ projectId: 'p1', includeArchived: true }), [])).frame?.params,
    ).toEqual({ projectId: 'p1', includeArchived: true });
  });

  it('rename / archive / unarchive send {conversationId[, title]}', async () => {
    expect((await frameOf((c) => c.conversationRename({ conversationId: 'c1', title: 'Auth v2' }), conv)).frame).toEqual({
      v: PROTOCOL_VERSION,
      id: 'test-1',
      method: 'conversation.rename',
      params: { conversationId: 'c1', title: 'Auth v2' },
    });
    expect((await frameOf((c) => c.conversationArchive('c1'), conv)).frame).toMatchObject({
      method: 'conversation.archive',
      params: { conversationId: 'c1' },
    });
    expect((await frameOf((c) => c.conversationUnarchive('c1'), conv)).frame).toMatchObject({
      method: 'conversation.unarchive',
      params: { conversationId: 'c1' },
    });
  });

  it('delete step 1 sends {conversationId} with NO token; step 2 sends {conversationId, confirmToken}', async () => {
    const step1 = await frameOf((c) => c.conversationDeleteRequest('c1'), { confirmation: confirmation() });
    expect(step1.frame?.params).toEqual({ conversationId: 'c1' });
    expect((step1.value as ConfirmationRequest).target).toEqual({ name: 'Auth', id: 'c1' });
    const step2 = await frameOf((c) => c.conversationDeleteConfirm('c1', TOKEN), { deleted: true });
    expect(step2.frame?.params).toEqual({ conversationId: 'c1', confirmToken: TOKEN });
    expect(step2.value).toEqual({ deleted: true });
  });

  it('step 1 accepts a renamed target (bound by id) but refuses another id, action, or a deleted:true claim', async () => {
    const renamed = await frameOf((c) => c.conversationDeleteRequest('c1'), {
      confirmation: confirmation({ target: { name: 'Renamed meanwhile', id: 'c1' } }),
    });
    expect(renamed.error).toBeUndefined();
    for (const ok of [
      { confirmation: confirmation({ target: { name: 'Auth', id: 'c2' } }) },
      { confirmation: confirmation({ action: 'project.delete' }) },
      { confirmation: confirmation(), deleted: true },
      { deleted: true },
    ]) {
      const { error } = await frameOf((c) => c.conversationDeleteRequest('c1'), ok);
      expect(error, JSON.stringify(ok)).toBeInstanceOf(Error);
    }
  });

  it('export sends {conversationId, afterSequence} (limit only when given)', async () => {
    expect((await frameOf((c) => c.conversationExport({ conversationId: 'c1', afterSequence: 0 }))).frame).toMatchObject({
      method: 'conversation.export',
      params: { conversationId: 'c1', afterSequence: 0 },
    });
    expect(
      (await frameOf((c) => c.conversationExport({ conversationId: 'c1', afterSequence: 7, limit: 50 }))).frame?.params,
    ).toEqual({ conversationId: 'c1', afterSequence: 7, limit: 50 });
  });

  it('refuses an empty id, a malformed token and an invalid title before any frame', async () => {
    for (const call of [
      (c: CoreCommands) => c.conversationArchive(''),
      (c: CoreCommands) => c.conversationUnarchive(''),
      (c: CoreCommands) => c.conversationDeleteRequest(''),
      (c: CoreCommands) => c.conversationDeleteConfirm('c1', TOKEN.toUpperCase()),
      (c: CoreCommands) => c.conversationRename({ conversationId: 'c1', title: '   ' }),
      (c: CoreCommands) => c.conversationRename({ conversationId: 'c1', title: 'a\nb' }),
      (c: CoreCommands) => c.conversationExport({ conversationId: '', afterSequence: 0 }),
    ]) {
      const { frame, error } = await frameOf(call);
      expect(frame).toBeUndefined();
      expect(error).toBeInstanceOf(CoreValidationError);
    }
  });

  it('all five keep the default deadline (§3.3 item 9)', async () => {
    const h = makeHarness({ requestTimeoutMs: 15_000 });
    await h.conn.connect();
    const commands = new CoreCommands(h.conn);
    void commands.conversationRename({ conversationId: 'c1', title: 'x' }).catch(() => undefined);
    void commands.conversationArchive('c1').catch(() => undefined);
    void commands.conversationUnarchive('c1').catch(() => undefined);
    void commands.conversationDeleteRequest('c1').catch(() => undefined);
    void commands.conversationDeleteConfirm('c1', TOKEN).catch(() => undefined);
    void commands.conversationExport({ conversationId: 'c1', afterSequence: 0 }).catch(() => undefined);
    expect(h.timers.pending.map((t) => t.ms)).toEqual([15_000, 15_000, 15_000, 15_000, 15_000, 15_000]);
  });

  it('conversation.create sends a Core-valid title: blank → "" (Core substitutes), never \\n or \\t', async () => {
    const blank = await frameOf((c) => c.conversationCreate({ projectId: 'p1', agentId: 'codex', title: ` ${cp(0x3000)}\t` }), conv);
    expect(blank.frame?.params).toMatchObject({ title: '' });
    const bad = await frameOf((c) => c.conversationCreate({ projectId: 'p1', agentId: 'codex', title: 'a\nb' }), conv);
    expect(bad.frame).toBeUndefined();
    expect(bad.error).toBeInstanceOf(CoreValidationError);
  });

  it('conversation.create addresses the chosen sandbox by Core\'s addressable rule (Atlas.Demo is valid)', async () => {
    const { frame, error } = await frameOf(
      (c) => c.conversationCreate({ projectId: 'p1', agentId: 'codex', sandboxId: 'Atlas.Demo', title: 'x' }),
      conv,
    );
    expect(error).toBeUndefined();
    expect(frame?.params).toMatchObject({ sandboxId: 'Atlas.Demo' });
  });
});

describe('conversation title validator mirrors Core exactly', () => {
  const refused: Array<[string, string]> = [
    ['empty', ''],
    ['newline', 'Auth\nflow'],
    ['tab', 'Auth\tflow'],
    ['CR', 'Auth\rflow'],
    ['NUL', `Auth${cp(0)}`],
    ['DEL', `Auth${cp(0x7f)}`],
    ['C1 NEL', `Auth${cp(0x85)}`],
    ['C1 CSI', `Auth${cp(0x9b)}`],
    ['line separator', `Auth${cp(0x2028)}`],
    ['paragraph separator', `Auth${cp(0x2029)}`],
    ['LRM', `Auth${cp(0x200e)}`],
    ['RLM', `Auth${cp(0x200f)}`],
    ['ALM', `Auth${cp(0x061c)}`],
    ['LRE', `${cp(0x202a)}Auth`],
    ['RLO', `${cp(0x202e)}Auth`],
    ['LRI', `${cp(0x2066)}Auth`],
    ['PDI', `Auth${cp(0x2069)}`],
    ['lone surrogate', `Auth${String.fromCharCode(0xd800)}`],
    ['too long', 'é'.repeat(MAX_CONVERSATION_TITLE_CHARS + 1)],
  ];
  it.each(refused)('refuses %s', (_label, value) => {
    expect(() => validateConversationTitle(value)).toThrow(CoreValidationError);
    expect(() => validateConversationRenameTitle(value)).toThrow(CoreValidationError);
  });

  const allowed: Array<[string, string]> = [
    ['plain', 'Auth flow'],
    ['unicode', 'Atlas Demo — ü 漢字 ✓'],
    ['exactly 200 (multi-byte)', 'é'.repeat(MAX_CONVERSATION_TITLE_CHARS)],
    ['astral chars count once', cp(0x1f600).repeat(MAX_CONVERSATION_TITLE_CHARS)],
    ['ZWSP (Core does not refuse it)', `Auth${cp(0x200b)}flow`],
    ['leading/trailing spaces (not trimmed)', ' Auth '],
    ['U+00A0 inside', `Auth${cp(0xa0)}flow`],
  ];
  it.each(allowed)('allows %s', (_label, value) => {
    expect(validateConversationTitle(value)).toBe(value);
    expect(validateConversationRenameTitle(value)).toBe(value);
  });

  it('rename refuses whitespace-only by Rust\'s White_Space set — U+FEFF alone is NOT blank for Core', () => {
    for (const blank of [' ', '   ', cp(0x3000), `${cp(0xa0)} ${cp(0x2003)}`, cp(0x205f), cp(0x1680)]) {
      expect(isRustBlank(blank), JSON.stringify(blank)).toBe(true);
      expect(() => validateConversationRenameTitle(blank)).toThrow(/empty or whitespace-only/);
    }
    // Rust `str::trim` does not trim U+FEFF / U+200B (not White_Space), and they
    // are neither Cc nor a spoofing character: Core ACCEPTS them as a title.
    for (const kept of [cp(0xfeff), cp(0x200b)]) {
      expect(isRustBlank(kept)).toBe(false);
      expect(validateConversationRenameTitle(kept)).toBe(kept);
    }
  });

  it('conversationTitleProblem: undefined when valid, Core\'s reason otherwise', () => {
    expect(conversationTitleProblem('Auth v2')).toBeUndefined();
    expect(conversationTitleProblem('   ')).toMatch(/whitespace-only/);
    expect(conversationTitleProblem('a\tb')).toMatch(/Core would refuse this title/);
  });

  it('drift: Core\'s validator and rename handler still say what this client mirrors', () => {
    const validation = read('core/crates/sandpane-core/src/validation.rs');
    expect(validation).toContain(`pub const MAX_CONVERSATION_TITLE_CHARS: usize = ${MAX_CONVERSATION_TITLE_CHARS};`);
    const fn = /pub fn conversation_title\(value: &str\)[\s\S]*?\n    \}/.exec(validation)?.[0] ?? '';
    expect(fn).toContain('Self::bounded(value, MAX_CONVERSATION_TITLE_CHARS)?;');
    expect(fn).toContain('.find(|c| c.is_control() || is_spoofing_format_char(*c))');
    expect(fn).not.toMatch(/trim/);
    const lifecycle = read('core/crates/sandpane-service/src/conversation_lifecycle.rs');
    const rename = /pub\(crate\) fn conversation_rename\([\s\S]*?\n\}/.exec(lifecycle)?.[0] ?? '';
    expect(rename).toContain('if p.title.trim().is_empty() {');
    expect(rename).toContain('MSG_TITLE_BLANK');
    expect(rename).toContain('Validator::conversation_title(&p.title)');
    const create = /pub\(crate\) fn title_for_create\([\s\S]*?\n\}/.exec(lifecycle)?.[0] ?? '';
    expect(create).toContain('if title.trim().is_empty() {');
    expect(create).toContain('Validator::conversation_title(title)');
  });
});

describe('Core\'s exact messages and their client copy', () => {
  const rustStr = (source: string, name: string): string => {
    const m = new RegExp(`pub const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)";`).exec(source);
    if (!m?.[1]) throw new Error(`no \`pub const ${name}\``);
    return m[1].replace(/\\\n\s*/g, '');
  };

  it('every mapped message equals the Rust constant', () => {
    const lifecycle = read('core/crates/sandpane-service/src/conversation_lifecycle.rs');
    expect(rustStr(lifecycle, 'MSG_CONVERSATION_ARCHIVED')).toBe(MSG_CONVERSATION_ARCHIVED);
    expect(rustStr(lifecycle, 'MSG_CONVERSATION_HAS_TASKS')).toBe(MSG_CONVERSATION_HAS_TASKS);
    expect(rustStr(lifecycle, 'MSG_CONVERSATION_NOT_FOUND')).toBe(MSG_CONVERSATION_NOT_FOUND);
    expect(rustStr(lifecycle, 'MSG_TITLE_BLANK')).toBe(MSG_TITLE_BLANK);
    expect(rustStr(lifecycle, 'CONVERSATION_DELETE_ACTION')).toBe('conversation.delete');
    expect(rustStr(read('core/crates/sandpane-service/src/confirm.rs'), 'TOKEN_REJECTED_MESSAGE')).toBe(TOKEN_REJECTED_MESSAGE);
    expect(rustStr(read('core/crates/sandpane-protocol/src/lib.rs'), 'CONVERSATION_EXPORT_FORMAT')).toBe(CONVERSATION_EXPORT_FORMAT);
  });

  const mapped: Array<[string, string, RegExp]> = [
    ['VALIDATION_FAILED', MSG_CONVERSATION_ARCHIVED, /archived\. Unarchive it first; nothing was changed\./],
    ['CONFLICT', MSG_CONVERSATION_HAS_TASKS, /nothing was deleted/],
    ['NOT_FOUND', MSG_CONVERSATION_NOT_FOUND, /no such conversation/],
    ['VALIDATION_FAILED', MSG_TITLE_BLANK, /nothing was changed/],
  ];
  it.each(mapped)('%s "%s" maps to copy that keeps Core\'s outcome', (code, message, outcome) => {
    expect(conversationErrorCopy(rpc(code, message))).toMatch(outcome);
  });

  it('the token rejection is mapped only for the delete flow, pointing at Delete Conversation', () => {
    expect(conversationErrorCopy(rpc('VALIDATION_FAILED', TOKEN_REJECTED_MESSAGE))).toBeNull();
    expect(conversationErrorCopy(rpc('VALIDATION_FAILED', TOKEN_REJECTED_MESSAGE), { delete: true })).toBe(
      'Core refused the confirmation (invalid, expired or already used). Nothing was deleted — run Delete Conversation again for a fresh confirmation.',
    );
  });

  it('never maps a different code, a near-miss message, INTERNAL or a non-RPC error', () => {
    expect(conversationErrorCopy(rpc('NOT_FOUND', MSG_CONVERSATION_ARCHIVED))).toBeNull();
    expect(conversationErrorCopy(rpc('VALIDATION_FAILED', `${MSG_CONVERSATION_ARCHIVED}.`))).toBeNull();
    expect(conversationErrorCopy(rpc('INTERNAL', MSG_CONVERSATION_HAS_TASKS))).toBeNull();
    expect(conversationErrorCopy(new Error(MSG_CONVERSATION_ARCHIVED))).toBeNull();
    // A3a's project message is the project mapper's, not this one's.
    expect(conversationErrorCopy(rpc('VALIDATION_FAILED', MSG_PROJECT_ARCHIVED))).toBeNull();
  });
});

describe('labels', () => {
  it('archived conversations are labeled; live ones are not', () => {
    expect(isConversationArchived(conv)).toBe(false);
    expect(isConversationArchived({ ...conv, archivedAt: null })).toBe(false);
    expect(isConversationArchived({ ...conv, archivedAt: '2026-10-11T11:00:00Z' })).toBe(true);
    expect(ARCHIVED_CONVERSATION_LABEL).toBe('ARCHIVED');
  });

  it('"sandbox chosen at creation" only when the feature is advertised; a name, never a binding', () => {
    const listed = ['atlas-box'];
    expect(conversationSandboxLabel({ ...conv, sandboxId: 'atlas-box' }, false, listed)).toBeNull();
    expect(conversationSandboxLabel({ ...conv, sandboxId: 'atlas-box' }, true, listed)).toBe('sandbox chosen at creation: atlas-box');
    expect(conversationSandboxLabel({ ...conv, sandboxId: 'gone-box' }, true, listed)).toBe(
      'sandbox chosen at creation: gone-box (not in the current sandbox list)',
    );
    // Absent = none recorded (pre-v6 rows are absent too) — never "none chosen".
    expect(conversationSandboxLabel(conv, true, listed)).toBe('no sandbox recorded at creation');
    // No sandbox list could be read (e.g. sbx NOT_INSTALLED): never claim "not in the list".
    expect(conversationSandboxLabel({ ...conv, sandboxId: 'atlas-box' }, true, null)).toBe(
      'sandbox chosen at creation: atlas-box (the sandbox list could not be read)',
    );
    const hostile = conversationSandboxLabel({ ...conv, sandboxId: `x${cp(0x202e)}y` }, true, []) ?? '';
    expect(hostile).not.toContain(cp(0x202e));
    expect(hostile).toContain('\\u202E');
  });

  it('titleFromMessage: one Core-valid line, cut by code point, blank → ""', () => {
    expect(titleFromMessage('Fix the bug\nin auth\tnow')).toBe('Fix the bug in auth now');
    expect(titleFromMessage(`  ${cp(0x202e)}evil  `)).toBe('evil');
    expect(titleFromMessage('\n\t ')).toBe('');
    const emojiAt80 = `${'a'.repeat(79)}${cp(0x1f600)}tail`;
    const cut = titleFromMessage(emojiAt80);
    expect(Array.from(cut)).toHaveLength(80);
    expect(cut.endsWith(cp(0x1f600))).toBe(true);
    for (const sample of ['a\nb', `x${cp(0x85)}y`, `${cp(0x2028)}z`, emojiAt80]) {
      const t = titleFromMessage(sample);
      if (t !== '') expect(validateConversationTitle(t)).toBe(t);
    }
  });

  it('exportFileName: from the redacted title, filesystem-safe, capped, with a fallback', () => {
    expect(exportFileName('Auth flow')).toBe('Auth-flow-export.json');
    expect(exportFileName('[REDACTED:token] ../../etc/passwd')).toBe('REDACTED-token-..-..-etc-passwd-export.json');
    expect(exportFileName(`${cp(0x202e)}`)).toBe('conversation-export.json');
    expect(exportFileName('...')).toBe('conversation-export.json');
    expect(exportFileName('x'.repeat(300))).toBe(`${'x'.repeat(60)}-export.json`);
  });
});

describe('conversationDeleteView — the A1 two-step pattern', () => {
  it('names the conversation and id, lists impact, shows expiry and never the token', () => {
    const view = conversationDeleteView(confirmation(), NOW);
    expect(view.message).toBe('Delete conversation "Auth"?');
    expect(view.button).toBe(DELETE_CONVERSATION_BUTTON);
    expect(view.detail).toContain('Conversation: Auth');
    expect(view.detail).toContain('Conversation id: c1');
    expect(view.detail).toContain('• 3 messages and 1 task are deleted');
    expect(view.detail).toContain('(in about 120 s)');
    expect(view.detail).toContain('host files, worktrees, branches and sandboxes are not touched');
    expect(view.detail).toContain('Cancel sends nothing');
    expect(view.detail).not.toContain(TOKEN);
    expect(view.detail).not.toContain('NOT CONFIRMED AS CREATED');
    expect(view.altered).toBe(false);
  });

  it('caps impact at 20 lines, counts the rest, escapes hidden characters', () => {
    const impact = Array.from({ length: MAX_IMPACT_LINES + 3 }, (_, i) => `line ${i}`);
    impact[0] = `deletes conversation ${cp(0x202e)}gnp.exe`;
    const view = conversationDeleteView(confirmation({ impact, target: { name: `Auth${cp(0x200f)}`, id: 'c1' } }), NOW);
    expect(view.detail.match(/^• /gm)).toHaveLength(MAX_IMPACT_LINES);
    expect(view.detail).toContain('(+3 more impact line(s) not shown)');
    expect(view.detail).not.toContain(cp(0x202e));
    expect(view.message).not.toContain(cp(0x200f));
    expect(view.altered).toBe(true);
  });

  it('an unreadable expiry says it cannot be used and points at Delete Conversation', () => {
    const detail = conversationDeleteView(confirmation({ expiresAt: 'soon' }), NOW).detail;
    expect(detail).toContain('cannot be used');
    expect(detail).toContain('run Delete Conversation again');
    expect(detail).not.toContain('run Remove again');
  });
});

// ---------------------------------------------------------------------------
// Export collector
// ---------------------------------------------------------------------------

interface PageSpec {
  messages: number[];
  truncated: boolean;
  nextSequence: number;
  byKind?: Record<string, number>;
  title?: string;
}

function page(spec: PageSpec, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const byKind = spec.byKind ?? {};
  return {
    format: CONVERSATION_EXPORT_FORMAT,
    exportedAt: '2026-10-11T12:00:00Z',
    conversation: { ...conv, title: spec.title ?? 'Auth' },
    messages: spec.messages.map((sequence) => ({
      id: `m${sequence}`,
      conversationId: 'c1',
      role: 'user',
      content: `message ${sequence}`,
      sequence,
    })),
    truncated: spec.truncated,
    nextSequence: spec.nextSequence,
    redaction: {
      bestEffort: true,
      replacements: Object.values(byKind).reduce((a, b) => a + b, 0),
      byKind,
    },
    ...overrides,
  };
}

function scripted(pages: unknown[]) {
  const cursors: number[] = [];
  const fetchPage = (afterSequence: number): Promise<unknown> => {
    cursors.push(afterSequence);
    const next = pages[cursors.length - 1];
    if (next instanceof Error) return Promise.reject(next);
    if (next === undefined) return Promise.reject(new Error('no more scripted pages'));
    return Promise.resolve(next);
  };
  return { cursors, fetchPage };
}

describe('collectConversationExport', () => {
  it('a single untruncated page is a complete export', async () => {
    const { cursors, fetchPage } = scripted([page({ messages: [1, 2], truncated: false, nextSequence: 2 })]);
    const outcome = await collectConversationExport('c1', fetchPage);
    expect(cursors).toEqual([0]);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.incomplete).toBeNull();
    expect(outcome.file).toEqual({
      format: CONVERSATION_EXPORT_FORMAT,
      exportedAt: '2026-10-11T12:00:00Z',
      conversation: conv,
      messages: page({ messages: [1, 2], truncated: false, nextSequence: 2 })['messages'],
      redaction: { bestEffort: true, replacements: 0, byKind: {} },
      complete: true,
      note: EXPORT_NOTE,
    });
    expect(EXPORT_NOTE).toBe(
      'Redaction is best-effort; review before sharing. Task events, artifacts and verification output are not included.',
    );
    expect(EXPORT_BEST_EFFORT_COPY).toBe('Redaction is best-effort; review the export before sharing it.');
  });

  it('loops from afterSequence 0 until truncated is false, concatenating messages and SUMMING redaction', async () => {
    const { cursors, fetchPage } = scripted([
      // First page: the title's replacements (token: 1) are counted here only.
      page({ messages: [1, 2], truncated: true, nextSequence: 2, byKind: { token: 2, jwt: 1 }, title: '[REDACTED:token] auth' }),
      page({ messages: [3, 4], truncated: true, nextSequence: 4, byKind: { token: 1 }, title: '[REDACTED:token] auth' }),
      page({ messages: [5], truncated: false, nextSequence: 5, byKind: { 'env-secret': 4 }, title: '[REDACTED:token] auth' }),
    ]);
    const outcome = await collectConversationExport('c1', fetchPage);
    expect(cursors).toEqual([0, 2, 4]);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.file.messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(outcome.file.redaction).toEqual({ bestEffort: true, replacements: 8, byKind: { 'env-secret': 4, jwt: 1, token: 3 } });
    expect(outcome.file.conversation.title).toBe('[REDACTED:token] auth');
    expect(outcome.file.complete).toBe(true);
    expect(outcome.pages).toBe(3);
  });

  it('a nextSequence that does not strictly increase stops as PARTIAL (complete:false)', async () => {
    const { cursors, fetchPage } = scripted([
      page({ messages: [1], truncated: true, nextSequence: 1 }),
      page({ messages: [], truncated: true, nextSequence: 1 }),
      page({ messages: [2], truncated: false, nextSequence: 2 }),
    ]);
    const outcome = await collectConversationExport('c1', fetchPage);
    expect(cursors).toEqual([0, 1]);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.incomplete).toBe('cursor-not-advancing');
    expect(outcome.file.complete).toBe(false);
    expect(outcome.file.messages.map((m) => m.sequence)).toEqual([1]);
  });

  it('a first page whose cursor does not advance past 0 is partial too', async () => {
    const { fetchPage } = scripted([page({ messages: [], truncated: true, nextSequence: 0 })]);
    const outcome = await collectConversationExport('c1', fetchPage);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.incomplete).toBe('cursor-not-advancing');
    expect(outcome.file.complete).toBe(false);
  });

  it('stops after the hard page cap (200) and discloses a partial export', async () => {
    expect(EXPORT_PAGE_CAP).toBe(200);
    const cursors: number[] = [];
    const outcome = await collectConversationExport('c1', (after) => {
      cursors.push(after);
      return Promise.resolve(page({ messages: [after + 1], truncated: true, nextSequence: after + 1 }));
    });
    expect(cursors).toHaveLength(EXPORT_PAGE_CAP);
    if (!outcome.ok) throw new Error('expected ok');
    expect(outcome.incomplete).toBe('page-cap');
    expect(outcome.file.complete).toBe(false);
    expect(outcome.file.messages).toHaveLength(EXPORT_PAGE_CAP);
  });

  it('any page failure yields NO document (Core error, or a malformed page)', async () => {
    const coreError = rpc('INTERNAL', 'redactor unavailable; nothing was exported (Core never exports unredacted text)');
    const failing = scripted([page({ messages: [1], truncated: true, nextSequence: 1 }), coreError]);
    const failed = await collectConversationExport('c1', failing.fetchPage);
    expect(failed.ok).toBe(false);
    expect('file' in failed).toBe(false);
    if (failed.ok) throw new Error('expected failure');
    expect(failed.error).toBe(coreError);

    const malformed: Array<[string, unknown]> = [
      ['wrong format', page({ messages: [1], truncated: false, nextSequence: 1 }, { format: 'other.v2' })],
      ['other conversation', page({ messages: [1], truncated: false, nextSequence: 1 }, { conversation: { ...conv, id: 'c2' } })],
      ['bestEffort not true', page({ messages: [1], truncated: false, nextSequence: 1 }, { redaction: { bestEffort: false, replacements: 0, byKind: {} } })],
      ['negative count', page({ messages: [1], truncated: false, nextSequence: 1 }, { redaction: { bestEffort: true, replacements: -1, byKind: {} } })],
      ['sum mismatch', page({ messages: [1], truncated: false, nextSequence: 1 }, { redaction: { bestEffort: true, replacements: 5, byKind: { token: 1 } } })],
      ['truncated not boolean', page({ messages: [1], truncated: false, nextSequence: 1 }, { truncated: 'no' })],
      ['nextSequence not integer', page({ messages: [1], truncated: false, nextSequence: 1 }, { nextSequence: 1.5 })],
      ['message of another conversation', page({ messages: [1], truncated: false, nextSequence: 1 }, {
        messages: [{ id: 'm1', conversationId: 'c9', role: 'user', content: 'SECRET-CONTENT', sequence: 1 }],
      })],
      ['not an object', 'nope'],
    ];
    for (const [label, bad] of malformed) {
      const { fetchPage } = scripted([bad]);
      const outcome = await collectConversationExport('c1', fetchPage);
      expect(outcome.ok, label).toBe(false);
      if (outcome.ok) continue;
      // The refusal names the check, never the page content.
      expect(String((outcome.error as Error).message), label).not.toContain('SECRET-CONTENT');
      expect(String((outcome.error as Error).message), label).not.toContain('message 1');
    }
  });

  it('sums a hostile "__proto__" kind as plain data', async () => {
    const hostile = JSON.parse(
      JSON.stringify(page({ messages: [1], truncated: false, nextSequence: 1 })).replace(
        '"byKind":{}',
        '"byKind":{"__proto__":2}',
      ).replace('"replacements":0', '"replacements":2'),
    ) as unknown;
    const { fetchPage } = scripted([hostile]);
    const outcome = await collectConversationExport('c1', fetchPage);
    if (!outcome.ok) throw new Error('expected ok');
    expect(Object.getPrototypeOf(outcome.file.redaction.byKind)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(outcome.file.redaction.byKind, '__proto__')).toBe(true);
    expect(outcome.file.redaction.replacements).toBe(2);
  });
});
