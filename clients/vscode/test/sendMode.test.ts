/**
 * A4 (design 2026-10-09 §3.4): `conversation.send` mode.
 *  - drift: the feature string, the two mode values and Core's exact refusal
 *    match the Rust sources; the new TaskSummary fields exist on both sides;
 *  - wire: Task (or no choice) sends NO `mode` key, Discuss sends
 *    `"mode":"discuss"`, anything else never leaves the client;
 *  - display: `TaskSummary.mode` is an OPEN string ("plan" decodes and shows),
 *    `chosenSandboxName` is a name labelled "not where it runs";
 *  - copy: Core's VALIDATION_FAILED mode refusal gets honest client copy.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CoreCommands, CoreValidationError, validateSendMode } from '../src/core-client/commands';
import { CoreRpcError } from '../src/core-client/connection';
import type { ErrorCode } from '../src/core-client/events';
import { KNOWN_FEATURES, PROTOCOL_VERSION, SEND_MODES } from '../src/core-client/protocol';
import type { TaskSummary } from '../src/core-client/protocol';
import { EMPTY_STATE, reduceTaskView } from '../src/state/reducer';
import { parseWebviewMessage } from '../src/webview/bridge';
import {
  CHOSEN_SANDBOX_LABEL,
  MAX_TASK_MODE_CHARS,
  MSG_SEND_MODE_INVALID,
  SEND_MODE_FEATURE,
  SEND_MODE_LABEL,
  SEND_MODE_NOTE,
  SEND_MODE_UNSUPPORTED,
  UNREADABLE_CORE_VALUE,
  chosenSandboxText,
  codeSpanText,
  sendModeErrorCopy,
  taskModeParts,
  taskModeText,
} from '../src/vscode/sendMode';
import { makeHarness } from './helpers/fakeCore';

const repoRoot = resolve(process.cwd(), '..', '..');
const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), 'utf8');
const rustProtocol = read('core/crates/sandpane-protocol/src/lib.rs');
const serviceLib = read('core/crates/sandpane-service/src/lib.rs');

const rpc = (code: string, message: string): CoreRpcError =>
  new CoreRpcError({ code: code as ErrorCode, message }, 'r1');

async function frameOf(call: (c: CoreCommands) => Promise<unknown>) {
  const h = makeHarness();
  await h.conn.connect();
  const commands = new CoreCommands(h.conn);
  const before = h.transport.writes.length;
  const promise = call(commands).catch((error: unknown) => error);
  await Promise.resolve();
  if (h.transport.writes.length === before) return { frame: undefined, error: await promise };
  const frame = h.transport.lastRequest();
  h.transport.respond({ v: PROTOCOL_VERSION, id: frame.id, ok: { id: 't1', conversationId: 'c1', status: 'queued' } });
  await promise;
  return { frame, error: undefined };
}

describe('A4 drift: feature, mode values and message match the Rust sources', () => {
  it('the feature string is a known feature and a Rust FEATURES entry', () => {
    expect(SEND_MODE_FEATURE).toBe('conversation-send-mode');
    expect(KNOWN_FEATURES).toContain(SEND_MODE_FEATURE);
    expect(rustProtocol).toContain(`"${SEND_MODE_FEATURE}"`);
  });

  it('the two mode values equal the Rust SendMode::as_str arms, in order', () => {
    const arms = [...serviceLib.matchAll(/SendMode::(?:Task|Discuss) => "([a-z]+)"/g)].map((m) => m[1]);
    expect(arms).toEqual([...SEND_MODES]);
    expect(SEND_MODES).toEqual(['task', 'discuss']);
  });

  it('the refusal equals the raw-string MSG_SEND_MODE_INVALID in sandpane-service', () => {
    const m = /pub const MSG_SEND_MODE_INVALID: &str = r#"(.*?)"#;/.exec(serviceLib);
    if (!m?.[1]) throw new Error('sandpane-service has no raw-string `pub const MSG_SEND_MODE_INVALID`');
    expect(m[1]).toBe(MSG_SEND_MODE_INVALID);
    expect(MSG_SEND_MODE_INVALID).toBe('mode must be "task" or "discuss"');
  });

  it('ConversationSendParams.mode and TaskSummary.mode / chosenSandboxName exist in Rust and in the TS client', () => {
    const struct = (name: string): string => {
      const start = rustProtocol.indexOf(`pub struct ${name} {`);
      if (start < 0) throw new Error(`sandpane-protocol has no \`pub struct ${name}\``);
      return rustProtocol.slice(start, rustProtocol.indexOf('\n}\n', start));
    };
    expect(struct('ConversationSendParams')).toContain('pub mode: Option<String>,');
    expect(struct('TaskSummary')).toContain('pub mode: Option<String>,');
    expect(struct('TaskSummary')).toContain('pub chosen_sandbox_name: Option<String>,');
    // The binding field keeps its pre-A4 meaning and name.
    expect(struct('TaskSummary')).toContain('pub sandbox_name: Option<String>,');

    const ts = read('clients/vscode/src/core-client/protocol.ts');
    const tsBody = (name: string): string => {
      const start = ts.indexOf(`export interface ${name} {`);
      if (start < 0) throw new Error(`protocol.ts has no \`export interface ${name}\``);
      return ts.slice(start, ts.indexOf('\n}\n', start));
    };
    expect(tsBody('ConversationSendParams')).toMatch(/\n\s+mode\?: SendMode;/);
    expect(tsBody('TaskSummary')).toMatch(/\n\s+mode\?: string \| null;/);
    expect(tsBody('TaskSummary')).toMatch(/\n\s+chosenSandboxName\?: string \| null;/);
  });

  it("the adapter.unavailable message keeps the prefix this client's copy relies on and names the mode", () => {
    expect(serviceLib).toContain("no verified agent adapter for '{agent_id}' in this build");
    expect(serviceLib).toContain('task stays queued (requested mode: {})');
  });
});

describe('A4 wire: conversation.send carries mode only for Discuss', () => {
  const base = { conversationId: 'c1', content: 'hi', attachments: [] };

  it('no mode → no key (byte-identical to the A2/A3b frame)', async () => {
    const { frame } = await frameOf((c) => c.conversationSend(base));
    expect(frame?.params).toEqual(base);
    expect(Object.keys(frame?.params as object)).not.toContain('mode');
  });

  it('Task → no key (Core treats absent as task)', async () => {
    const { frame } = await frameOf((c) => c.conversationSend({ ...base, mode: 'task' }));
    expect(frame?.params).toEqual(base);
  });

  it('Discuss → "mode":"discuss", next to the idempotency key', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    const { frame } = await frameOf((c) => c.conversationSend({ ...base, idempotencyKey: key, mode: 'discuss' }));
    expect(frame?.params).toEqual({ ...base, idempotencyKey: key, mode: 'discuss' });
    expect(JSON.stringify(frame)).toContain('"mode":"discuss"');
  });

  it('I5: null is treated as absent, as Core does (no key, no local refusal)', async () => {
    expect(validateSendMode(null)).toBeUndefined();
    expect(validateSendMode(undefined)).toBeUndefined();
    expect(validateSendMode('discuss')).toBe('discuss');
    const { frame, error } = await frameOf((c) => c.conversationSend({ ...base, mode: null as unknown as 'task' }));
    expect(error).toBeUndefined();
    expect(frame?.params).toEqual(base);
  });

  it('any other value never leaves the client (Core would refuse it the same way)', async () => {
    for (const bad of ['Task', 'DISCUSS', '', ' task', 'plan']) {
      const { frame, error } = await frameOf((c) =>
        c.conversationSend({ ...base, mode: bad as unknown as 'task' }),
      );
      expect(frame, bad).toBeUndefined();
      expect(error, bad).toBeInstanceOf(CoreValidationError);
      expect(String((error as Error).message)).toContain(MSG_SEND_MODE_INVALID);
    }
  });
});

describe('A4 display: TaskSummary.mode is an open string; chosenSandboxName is only a name', () => {
  it('an unknown mode "plan" decodes and is carried for display, never mapped onto a known one', () => {
    const summary = {
      id: 'task-1',
      conversationId: 'c1',
      status: 'queued',
      mode: 'plan',
      chosenSandboxName: 'atlas-box',
    } as TaskSummary;
    const state = reduceTaskView(EMPTY_STATE, { kind: 'taskList', tasks: [summary] });
    const task = state.tasks['task-1'];
    expect(task?.mode).toBe('plan');
    expect(task?.chosenSandboxName).toBe('atlas-box');
    // Not a binding: the reducer never copies it into sandboxName.
    expect(task?.sandboxName).toBeUndefined();
    expect(task?.unknownKinds).toEqual([]);
    expect(taskModeText('plan')).toBe('plan');
    expect(taskModeText('discuss')).toBe('discuss');
  });

  it('old rows without the fields stay absent (no invented "task")', () => {
    const state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskSummary',
      summary: { id: 'old', conversationId: 'c1', status: 'queued' },
    });
    expect(state.tasks['old']?.mode).toBeUndefined();
    expect(taskModeText(undefined)).toBeNull();
    expect(taskModeText(null)).toBeNull();
    expect(chosenSandboxText(undefined)).toBeNull();
  });

  it('I4: a non-string mode / chosenSandboxName is shown as unreadable, never echoed', () => {
    for (const bad of [7, { evil: 'x' }, ['discuss'], true]) {
      const shown = taskModeText(bad);
      expect(shown, JSON.stringify(bad)).toBe(UNREADABLE_CORE_VALUE);
      expect(chosenSandboxText(bad)).toBe(UNREADABLE_CORE_VALUE);
    }
    expect(UNREADABLE_CORE_VALUE).not.toMatch(/7|evil|discuss|true/);
  });

  it('Core strings are revealed and capped (hidden characters never pass through raw)', () => {
    const shown = taskModeText(`pl\u202Ean${'x'.repeat(500)}`);
    expect(shown).not.toContain('\u202E');
    expect(shown?.length).toBeLessThanOrEqual(MAX_TASK_MODE_CHARS + '\u2026 (truncated)'.length);
    const name = chosenSandboxText('atlas\u200Bbox');
    expect(name).not.toContain('\u200B');
    expect(name).toContain('atlas');
  });

  it('tree / tooltip parts: only what Core reported, labelled; code spans cannot be broken out of', () => {
    expect(taskModeParts({ mode: 'plan', chosenSandboxName: 'atlas-box' })).toEqual([
      'Send mode: plan',
      'sandbox chosen by its chat \u2014 not where it runs: atlas-box',
    ]);
    expect(taskModeParts({})).toEqual([]);
    expect(taskModeParts({ mode: null, chosenSandboxName: '' })).toEqual([]);
    expect(codeSpanText('a`b')).toBe("a'b");
  });

  it('labels say exactly what Core knows', () => {
    expect(SEND_MODE_LABEL).toBe('Send mode');
    expect(CHOSEN_SANDBOX_LABEL).toBe('sandbox chosen by its chat — not where it runs');
  });

  it('task.created { mode } and scheduler.deferred { reason, mode } are not treated as unknown', () => {
    let state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskEvent',
      event: { taskId: 't', sequence: 1, kind: 'task.created', payload: { conversationId: 'c1', mode: 'discuss' }, timestamp: 'x' },
    });
    state = reduceTaskView(state, {
      kind: 'taskEvent',
      event: { taskId: 't', sequence: 2, kind: 'scheduler.deferred', payload: { reason: 'no adapter', mode: 'discuss' }, timestamp: 'x' },
    });
    expect(state.tasks['t']?.unknownKinds).toEqual([]);
    expect(state.tasks['t']?.lines.at(-1)?.text).toContain('no adapter');
  });
});

describe('A4 copy: composer and refusals never claim more than Core records', () => {
  it('the composer note says neither mode runs an agent and Discuss is not safe execution', () => {
    expect(SEND_MODE_NOTE).toMatch(/neither .*runs an agent/i);
    expect(SEND_MODE_NOTE).toMatch(/Discuss is not a sandbox.*not safe execution/i);
    for (const claim of [/read-only/i, /\bis safe\b/i, /\bsafely\b/i, /isolated/i]) {
      expect(SEND_MODE_NOTE).not.toMatch(claim);
    }
    expect(SEND_MODE_UNSUPPORTED).toContain('not supported by this Core');
  });

  it("Core's exact VALIDATION_FAILED mode refusal gets honest copy; anything else is not claimed", () => {
    const copy = sendModeErrorCopy(rpc('VALIDATION_FAILED', MSG_SEND_MODE_INVALID));
    expect(copy).toContain('Core refused the send mode');
    // Core's message says nothing about what was (not) recorded; neither does the copy.
    expect(copy).not.toMatch(/nothing was|task was created|\bran\b/);
    // I2: why Core refused is the client's inference — worded as a possibility.
    expect(copy).toContain('this may mean the extension and Core are different versions');
    expect(copy).not.toMatch(/disagree/);
    expect(sendModeErrorCopy(rpc('VALIDATION_FAILED', 'mode must be task'))).toBeNull();
    expect(sendModeErrorCopy(rpc('CONFLICT', MSG_SEND_MODE_INVALID))).toBeNull();
    expect(sendModeErrorCopy(new Error(MSG_SEND_MODE_INVALID))).toBeNull();
  });
});

describe('A4 webview copy mirrors the extension copy (app.ts is import-free)', () => {
  it('each mirrored constant equals its src/vscode/sendMode.ts source', () => {
    const app = read('clients/vscode/src/webview/app.ts');
    const literal = (name: string): string => {
      const m = new RegExp(`const ${name} = '((?:[^'\\\\]|\\\\.)*)';`).exec(app);
      if (!m?.[1]) throw new Error(`app.ts has no one-line \`const ${name}\``);
      return JSON.parse(`"${m[1].replace(/"/g, '\\"')}"`) as string;
    };
    expect(literal('SEND_MODE_LABEL')).toBe(SEND_MODE_LABEL);
    expect(literal('CHOSEN_SANDBOX_LABEL')).toBe(CHOSEN_SANDBOX_LABEL);
    expect(literal('SEND_MODE_NOTE')).toBe(SEND_MODE_NOTE);
    expect(literal('SEND_MODE_UNSUPPORTED')).toBe(SEND_MODE_UNSUPPORTED);
  });
});

describe('A4 webview message: the composer choice', () => {
  it('passes "discuss" through exactly; no mode or any other value means Task', () => {
    expect(parseWebviewMessage({ type: 'send', text: 'hi', writable: false, planId: 3, mode: 'discuss' })).toEqual({
      type: 'send',
      text: 'hi',
      writable: false,
      planId: 3,
      mode: 'discuss',
    });
    for (const other of [undefined, 'task', 'Discuss', 'plan', 1, null]) {
      const parsed = parseWebviewMessage({ type: 'send', text: 'hi', writable: false, planId: 3, mode: other });
      expect(parsed, String(other)).toEqual({ type: 'send', text: 'hi', writable: false, planId: 3 });
    }
  });
});
