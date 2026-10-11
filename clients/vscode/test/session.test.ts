/**
 * `SandpaneSession` wiring against a scripted Core (a fake duplex that answers
 * frames by method — the unit under test is the session, not Core) and the
 * recording `vscode` stub (aliased in vitest.config.mts).
 *
 * Regressions covered: review bugs 1 (diff Uri objects), 3 (rescope on
 * project change), 4 (workspace mode of the SELECTED sandbox gates writable
 * sends), 6 (extension-side send authorization), 8 (conversation reset),
 * 9 (background reconnect loads data), 10 (live polling), 12d (single load).
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { SandpaneSession, EVENT_POLL_INTERVAL_MS } from '../src/session';
import type { CoreTransport, TransportHandlers } from '../src/core-client/connection';
import { FakeTimers, flush } from './helpers/fakeCore';
import { stub, Uri, type StubUri } from './helpers/vscodeStub';

interface Frame {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** `Method::ALL` order — what an A5 Core advertises (28 methods). */
const ALL_METHODS = [
  'system.probe', 'project.create', 'project.list',
  'project.update', 'project.archive', 'project.unarchive', 'project.delete',
  'project.add_repository', 'project.remove_repository',
  'sandbox.list', 'sandbox.create',
  'sandbox.stop', 'sandbox.remove',
  'conversation.create', 'conversation.send', 'conversation.list', 'conversation.history',
  'conversation.rename', 'conversation.archive', 'conversation.unarchive', 'conversation.delete', 'conversation.export',
  'task.cancel', 'task.list', 'task.subscribe', 'git.review', 'git.diff', 'git.apply',
];

/** A pre-A5 (A4) Core: the 27 methods before git.diff. */
const PRE_A5_METHODS = ALL_METHODS.filter((m) => m !== 'git.diff');

/** A pre-A3b (A3a) Core: the 22 methods before the conversation lifecycle. */
const PRE_A3B_METHODS = PRE_A5_METHODS.filter((m) => !/^conversation\.(rename|archive|unarchive|delete|export)$/.test(m));

/** A pre-A3a Core: the 16 methods before the project lifecycle. */
const PRE_A3A_METHODS = PRE_A3B_METHODS.filter((m) => !/^project\.(update|archive|unarchive|delete|add_repository|remove_repository)$/.test(m));

/** A pre-A1 Core: the 14 methods before sandbox.stop / sandbox.remove. */
const PRE_A1_METHODS = PRE_A3A_METHODS.filter((m) => m !== 'sandbox.stop' && m !== 'sandbox.remove');

const TOKEN = '0123456789abcdef'.repeat(4);

/** Scripted Core: projects p1/p2, one queued task each, sandboxes with recorded modes. */
class ScriptedCore {
  readonly requests: Frame[] = [];
  refuseConnect = false;
  /** What system.probe advertises. */
  methods: string[] = ALL_METHODS;
  /** A3a project lifecycle state of this fake. */
  readonly archived = new Set<string>();
  readonly deletedProjects = new Set<string>();
  readonly projectNames = new Map<string, string>();
  p3Exists = false;
  /** When set, step 1 answers for this project id instead of echoing the requested one. */
  confirmationTargetId: string | null = null;
  /** Step 2 deletes the project and THEN answers the forced error (lost answer). */
  deleteBeforeForcedError = false;
  projectConfirmation: Record<string, unknown> = {
    token: TOKEN,
    expiresAt: '2026-10-10T12:02:00Z',
    action: 'project.delete',
    target: { name: 'Atlas Demo', id: 'p1' },
    impact: ['deletes 1 conversation(s), 3 message(s) and 1 task(s)', 'task branches in the host repositories are left in place'],
    external: false,
  };
  /** A3b conversation state of this fake (Core's rows, by id). */
  readonly conversations = new Map<string, Record<string, unknown>>([
    ['c1', { id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', createdAt: '' }],
  ]);
  /** Step 2 deletes the conversation and THEN answers the forced error (lost answer). */
  deleteConversationBeforeForcedError = false;
  /** When set, `conversation.export` answers these pages in order (else one page from the row). */
  exportPages: unknown[] | null = null;
  conversationConfirmation: Record<string, unknown> = {
    token: TOKEN,
    expiresAt: '2026-10-10T12:02:00Z',
    action: 'conversation.delete',
    impact: [
      'deletes conversation Auth and all of its Core records; this cannot be undone',
      '3 messages and 1 task are deleted, with their task events, artifacts and verification records',
    ],
    external: false,
  };
  /** A5: the change list `git.review` answers (exact paths) and `git.diff` gates on. */
  reviewChanges: Record<string, unknown>[] = [
    { path: 'src/a#b?.ts', status: 'modified' },
    { path: 'notes #1.txt', status: 'untracked' },
  ];
  /** A5: extra ChangeSet fields (`repoPath`, `uninspected`). */
  reviewExtra: Record<string, unknown> = {};
  /** A5: when set, `git.diff` answers this instead of a generated patch. */
  diffAnswer: unknown = null;
  /** A5: a marker inside the generated patch (must never reach the log). */
  diffSecret = 'PATCH-CONTENT-MARKER';
  /** Future-Core shape: task.list rows carry `sandboxName`. Today's Core never sets it. */
  taskSandboxNames = false;
  /** A4 shape: task.list rows carry `mode` and `chosenSandboxName` (the chat's choice, NOT a binding). */
  taskChosenNames = false;
  /** A4: the `mode` value task.list rows report when `taskChosenNames` is set (any JSON value). */
  taskMode: unknown = 'discuss';
  /** `sandbox.stop` answer. */
  stopAnswer: { ok: unknown } | { err: { code: string; message: string } } = {
    ok: { stopped: true, requeried: { name: 'atlas-box', probedState: 'stopped', boundProjectId: 'p1', workspaceMode: 'sbx_clone' } },
  };
  /** `sandbox.remove` step-1 confirmation (step 1 = no confirmToken). */
  confirmation: Record<string, unknown> = {
    token: TOKEN,
    expiresAt: '2026-10-10T12:02:00Z',
    action: 'sandbox.remove',
    target: { name: 'atlas-box', id: 'b5ebec73-e2ae-471a-811a-e011cfb1948e' },
    impact: ['removes sandbox atlas-box', 'its sbx-clone workspace is deleted'],
    external: false,
  };
  /** `sandbox.remove` step-2 answer. */
  removeAnswer: { ok: unknown } | { err: { code: string; message: string } } = { ok: { removed: true } };
  /** Sandboxes `sandbox.list` reports after a successful remove. */
  removed = new Set<string>();
  agentVerified = true;
  /** When set, sandbox.list answers this structured error (with details). */
  sandboxListError: { code: string; message: string; details?: unknown } | null = null;
  /** Repositories Core reports for p1 (canonical paths). */
  p1Repositories: string[] = [];
  /** Requests matching this predicate are answered only on `release()`. */
  hold: ((frame: Frame) => boolean) | null = null;
  private held: (() => void)[] = [];

  /** Deliver every held response (in arrival order). */
  release(): void {
    const pending = this.held;
    this.held = [];
    for (const deliver of pending) deliver();
  }
  readonly events = new Map<string, { taskId: string; sequence: number; kind: string; payload: unknown; timestamp: string }[]>([
    ['task-a', [{ taskId: 'task-a', sequence: 1, kind: 'message.user', payload: { type: 'message.delta', text: 'from p1' }, timestamp: 't' }]],
    ['task-b', [{ taskId: 'task-b', sequence: 1, kind: 'message.user', payload: { type: 'message.delta', text: 'from p2' }, timestamp: 't' }]],
  ]);
  private readonly taskProject = new Map([
    ['task-a', 'p1'],
    ['task-b', 'p2'],
  ]);
  private convCounter = 0;

  private readonly live: TransportHandlers[] = [];

  /** Drop every open connection, as a Core restart would. */
  drop(): void {
    for (const h of this.live.splice(0)) h.onClose(new Error('Core went away'));
  }

  transportFactory = (): CoreTransport => {
    let handlers: TransportHandlers | null = null;
    return {
      start: (h: TransportHandlers) => {
        handlers = h;
        if (!this.refuseConnect) this.live.push(h);
        return this.refuseConnect ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve();
      },
      write: (bytes: Uint8Array) => {
        const frame = JSON.parse(new TextDecoder().decode(bytes)) as Frame;
        this.requests.push(frame);
        const reply = this.answer(frame);
        const deliver = (): void => {
          handlers?.onData(new TextEncoder().encode(`${JSON.stringify({ v: 1, id: frame.id, ...reply })}\n`));
        };
        if (this.hold?.(frame)) this.held.push(deliver);
        else setImmediate(deliver);
      },
      close: () => undefined,
    };
  };

  /**
   * A2 keyed-request model (mirrors Core §3.1): a completed key replays its
   * FIRST result plus `replayed: true`; `forced` answers the next call of a
   * method with an error instead (not stored, like Core's pre-run failures).
   */
  features: string[] | undefined = ['idempotency-keys', 'sandbox-create-agent'];
  readonly keyed = new Map<string, Record<string, unknown>>();
  readonly forced = new Map<string, { code: string; message: string }>();

  private replayFor(frame: Frame): { ok: unknown } | null {
    const key = frame.params['idempotencyKey'];
    if (typeof key !== 'string') return null;
    const stored = this.keyed.get(`${frame.method}:${key}`);
    return stored ? { ok: { ...stored, replayed: true } } : null;
  }

  private takeForced(method: string): { err: { code: string; message: string } } | null {
    const err = this.forced.get(method);
    if (!err) return null;
    this.forced.delete(method);
    return { err };
  }

  private remember(frame: Frame, result: Record<string, unknown>): { ok: unknown } {
    const key = frame.params['idempotencyKey'];
    if (typeof key === 'string') this.keyed.set(`${frame.method}:${key}`, result);
    return { ok: result };
  }

  calls(method: string): Frame[] {
    return this.requests.filter((r) => r.method === method);
  }

  private answer(frame: Frame): { ok: unknown } | { err: { code: string; message: string; details?: unknown } } {
    const p = frame.params;
    switch (frame.method) {
      case 'system.probe':
        return {
          ok: {
            protocolVersion: 1,
            coreVersion: '0.1.0-test',
            instanceId: 'inst-1',
            platform: 'darwin',
            sbx: { installed: true },
            agents: [{ id: 'codex', verified: this.agentVerified, supportsStreaming: false, supportsCancel: false, supportsResume: false }],
            methods: this.methods,
            ...(this.features !== undefined ? { features: this.features } : {}),
          },
        };
      case 'project.list':
        return {
          ok: [
            { id: 'p1', name: this.projectNames.get('p1') ?? 'Atlas Demo', description: '', createdAt: '', repositories: this.p1Repositories },
            { id: 'p2', name: 'Nova Demo', description: '', createdAt: '' },
            { id: 'p3', name: 'Orbit Demo', description: '', createdAt: '' },
          ]
            .filter((proj) => !this.deletedProjects.has(proj.id))
            .filter((proj) => proj.id !== 'p3' || this.p3Exists)
            .map((proj) => (this.archived.has(proj.id) ? { ...proj, archivedAt: '2026-10-10T11:00:00Z' } : proj))
            .filter((proj) => p['includeArchived'] === true || !('archivedAt' in proj)),
        };
      case 'project.update':
      case 'project.archive':
      case 'project.unarchive':
      case 'project.add_repository':
      case 'project.remove_repository': {
        const forced = this.takeForced(frame.method);
        if (forced) return forced;
        const id = String(p['projectId']);
        if (frame.method === 'project.archive') this.archived.add(id);
        if (frame.method === 'project.unarchive') this.archived.delete(id);
        if (typeof p['name'] === 'string') this.projectNames.set(id, p['name']);
        return { ok: { id, name: this.projectNames.get(id) ?? 'Atlas Demo', description: String(p['description'] ?? ''), createdAt: '' } };
      }
      case 'project.delete': {
        if (p['confirmToken'] === undefined) {
          const forced = this.takeForced('project.delete.step1');
          if (forced) return forced;
          return { ok: { confirmation: { ...this.projectConfirmation, target: { name: 'Atlas Demo', id: this.confirmationTargetId ?? p['projectId'] } } } };
        }
        if (this.deleteBeforeForcedError) this.deletedProjects.add(String(p['projectId']));
        const forced = this.takeForced('project.delete');
        if (forced) return forced;
        this.deletedProjects.add(String(p['projectId']));
        return { ok: { deleted: true } };
      }
      case 'sandbox.list':
        if (this.sandboxListError) return { err: this.sandboxListError };
        return {
          ok: [
            { name: 'atlas-box', probedState: 'running', boundProjectId: 'p1', workspaceMode: 'sbx_clone' },
            { name: 'nova-live', probedState: 'running', boundProjectId: 'p2', workspaceMode: 'direct_mount' },
            { name: 'atlas-unrecorded', probedState: 'running', boundProjectId: 'p1' },
          ].filter((s) => !this.removed.has(s.name)),
        };
      case 'sandbox.create': {
        const stored = this.replayFor(frame);
        if (stored) return stored;
        const forced = this.takeForced(frame.method);
        if (forced) return forced;
        return this.remember(frame, {
          name: p['name'],
          probedState: 'running',
          boundProjectId: p['projectId'],
          workspaceMode: p['workspaceMode'],
          agent: p['agent'] ?? 'shell',
        });
      }
      case 'sandbox.stop':
        return this.stopAnswer;
      case 'sandbox.remove':
        if (p['confirmToken'] === undefined) return { ok: { confirmation: this.confirmation } };
        if ('ok' in this.removeAnswer) this.removed.add(String(p['name']));
        return this.removeAnswer;
      case 'task.list':
        return {
          ok: [...this.taskProject.entries()]
            .filter(([, project]) => p['projectId'] === undefined || project === p['projectId'])
            // A deleted conversation's tasks are deleted with it (A3b).
            .filter(([, project]) => project !== 'p1' || this.conversations.has('c1'))
            .map(([id, project]) => ({
              id,
              conversationId: project === 'p1' ? 'c1' : 'c2',
              status: 'queued',
              // Real Core never fills sandboxName (tasks.sandbox_binding_id is
              // never written); `taskSandboxNames` simulates a future Core.
              ...(this.taskSandboxNames ? { sandboxName: project === 'p1' ? 'atlas-box' : 'nova-live' } : {}),
              ...(this.taskChosenNames
                ? { mode: this.taskMode, chosenSandboxName: project === 'p1' ? 'atlas-box' : 'nova-live' }
                : {}),
            })),
        };
      case 'conversation.list': {
        const forced = this.takeForced('conversation.list');
        if (forced) return forced;
        return {
          ok: [...this.conversations.values()]
            .filter((c) => p['projectId'] === undefined || c['projectId'] === p['projectId'])
            .filter((c) => p['includeArchived'] === true || c['archivedAt'] === undefined)
            .slice(0, typeof p['limit'] === 'number' ? p['limit'] : 200),
        };
      }
      case 'conversation.rename':
      case 'conversation.archive':
      case 'conversation.unarchive': {
        const forced = this.takeForced(frame.method);
        if (forced) return forced;
        const row = this.conversations.get(String(p['conversationId']));
        if (!row) return { err: { code: 'NOT_FOUND', message: 'conversation not found' } };
        if (frame.method === 'conversation.rename') row['title'] = p['title'];
        if (frame.method === 'conversation.archive' && row['archivedAt'] === undefined) row['archivedAt'] = '2026-10-11T11:00:00Z';
        if (frame.method === 'conversation.unarchive') delete row['archivedAt'];
        return { ok: { ...row } };
      }
      case 'conversation.delete': {
        const id = String(p['conversationId']);
        if (p['confirmToken'] === undefined) {
          const forced = this.takeForced('conversation.delete.step1');
          if (forced) return forced;
          return { ok: { confirmation: { ...this.conversationConfirmation, target: { name: String(this.conversations.get(id)?.['title'] ?? '?'), id } } } };
        }
        if (this.deleteConversationBeforeForcedError) this.conversations.delete(id);
        const forced = this.takeForced('conversation.delete');
        if (forced) return forced;
        this.conversations.delete(id);
        return { ok: { deleted: true } };
      }
      case 'conversation.export': {
        const forced = this.takeForced('conversation.export');
        if (forced) return forced;
        if (this.exportPages) {
          const next = this.exportPages.shift();
          return next === undefined ? { err: { code: 'INTERNAL', message: 'no scripted page' } } : { ok: next };
        }
        const row = this.conversations.get(String(p['conversationId']));
        if (!row) return { err: { code: 'NOT_FOUND', message: 'conversation not found' } };
        return {
          ok: {
            format: 'sandpane.conversation-export.v1',
            exportedAt: '2026-10-11T12:00:00Z',
            conversation: { ...row },
            messages: [{ id: 'm1', conversationId: row['id'], role: 'user', content: 'PRIVATE-MESSAGE-BODY', sequence: 1 }],
            truncated: false,
            nextSequence: 1,
            redaction: { bestEffort: true, replacements: 0, byKind: {} },
          },
        };
      }
      case 'task.subscribe': {
        const project = p['projectId'];
        const taskId = p['taskId'];
        const cursors = (p['afterSequences'] ?? {}) as Record<string, number>;
        const out = [...this.events.entries()]
          .filter(([id]) => this.taskProject.get(id) === project && (taskId === undefined || taskId === id))
          // A deleted conversation's task events are deleted with it (A3b).
          .filter(([id]) => id !== 'task-a' || this.conversations.has('c1'))
          .flatMap(([id, list]) =>
            list.filter((e) => e.sequence > (taskId ? Number(p['afterSequence']) : (cursors[id] ?? Number(p['afterSequence'])))),
          );
        return { ok: out };
      }
      case 'conversation.create': {
        this.convCounter += 1;
        const row: Record<string, unknown> = { id: `conv-new-${this.convCounter}`, projectId: p['projectId'], title: 't', agentId: 'codex', createdAt: '' };
        if (typeof p['sandboxId'] === 'string') row['sandboxId'] = p['sandboxId'];
        this.conversations.set(String(row['id']), row);
        return { ok: { ...row } };
      }
      case 'conversation.send': {
        const target = this.conversations.get(String(p['conversationId']));
        if (target && target['archivedAt'] !== undefined && !this.forced.has('conversation.send')) {
          return { err: { code: 'VALIDATION_FAILED', message: 'conversation is archived; unarchive it first; nothing was changed' } };
        }
        // A4 (mirrors Core): only "task" / "discuss"; null = absent. A pre-A4
        // Core (feature not advertised) ignores the field entirely.
        const honoursMode = this.features?.includes('conversation-send-mode') === true;
        if (honoursMode && p['mode'] !== undefined && p['mode'] !== null && p['mode'] !== 'task' && p['mode'] !== 'discuss') {
          return { err: { code: 'VALIDATION_FAILED', message: 'mode must be "task" or "discuss"' } };
        }
        const stored = this.replayFor(frame);
        if (stored) return stored;
        const forced = this.takeForced(frame.method);
        if (forced) return forced;
        const sendMode = this.features?.includes('conversation-send-mode')
          ? { mode: p['mode'] === 'discuss' ? 'discuss' : 'task', ...(typeof target?.['sandboxId'] === 'string' ? { chosenSandboxName: target['sandboxId'] } : {}) }
          : {};
        return this.remember(frame, { id: `task-new-${this.requests.length}`, conversationId: p['conversationId'], status: 'queued', ...sendMode });
      }
      case 'git.review': {
        const forced = this.takeForced('git.review');
        if (forced) return forced;
        return {
          ok: {
            taskId: p['taskId'],
            baseCommit: 'b71995fc1e0f4a3c8f0d7b1a2e3c4d5e6f708192',
            hostDirty: false,
            changes: this.reviewChanges,
            ...this.reviewExtra,
          },
        };
      }
      case 'git.diff': {
        const forced = this.takeForced('git.diff');
        if (forced) return forced;
        // A5 (mirrors Core's gate): byte-exact path (+ status) in the change list.
        const hits = this.reviewChanges.filter(
          (c) => c['path'] === p['path'] && (p['status'] === undefined || c['status'] === p['status']),
        );
        if (hits.length !== 1) {
          return {
            err: {
              code: 'VALIDATION_FAILED',
              message:
                hits.length === 0
                  ? "path is not in this task's change list; nothing was read"
                  : "path is listed more than once in this task's change list; pass its status; nothing was read",
            },
          };
        }
        return {
          ok: this.diffAnswer ?? {
            path: p['path'],
            status: hits[0]?.['status'],
            patch: `diff --git a/x b/x\n@@ -1 +1 @@\n-${this.diffSecret}\n+new\n`,
            binary: false,
            truncated: false,
            lossy: false,
          },
        };
      }
      default:
        return { err: { code: 'VALIDATION_FAILED', message: `unexpected ${frame.method}` } };
    }
  }
}

class MemoryState {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    return Promise.resolve();
  }
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await flush();
}

/** Session wall clock; tests may move it (e.g. past a confirmation's expiry). */
const clock = { now: Date.parse('2026-10-10T12:00:00Z'), reads: [] as number[], after: null as null | { reads: number; now: number } };

function makeSession(core: ScriptedCore, state = new MemoryState()) {
  const timers = new FakeTimers();
  const context = { workspaceState: state } as unknown as vscode.ExtensionContext;
  const session = new SandpaneSession(context, {
    transportFactory: core.transportFactory,
    setTimer: timers.set,
    clearTimer: timers.clear,
    now: () => {
      // Optionally jump the clock after N reads (e.g. while a modal is open).
      if (clock.after && clock.reads.length >= clock.after.reads) clock.now = clock.after.now;
      clock.reads.push(clock.now);
      return clock.now;
    },
  });
  return { session, timers, state };
}

beforeEach(() => {
  stub.reset();
  clock.now = Date.parse('2026-10-10T12:00:00Z');
  clock.reads = [];
  clock.after = null;
});
afterEach(() => stub.reset());

describe('loading (bugs 9, 12d)', () => {
  it('a background reconnect after a failed first attach loads Core state (bug 9)', async () => {
    const core = new ScriptedCore();
    core.refuseConnect = true;
    const { session, timers } = makeSession(core);
    await session.attach();
    expect(session.snapshot().connection).toBe('reconnecting');

    core.refuseConnect = false;
    timers.runNext(); // the backoff timer reconnects on its own
    await settle();
    const snap = session.snapshot();
    expect(snap.connection).toBe('online');
    expect(snap.capabilities?.coreVersion).toBe('0.1.0-test');
    expect(snap.header.project).toContain('2 project(s)'); // real data, not an empty "online"
    session.dispose();
  });

  it('attach + the webview "ready" refresh load once, not twice (12d)', async () => {
    const core = new ScriptedCore();
    const { session } = makeSession(core);
    const attaching = session.attach();
    session.handleWebviewMessage({ type: 'ready' });
    await attaching;
    await settle();
    expect(core.calls('system.probe')).toHaveLength(1);
    session.dispose();
  });
});

describe('scope changes (bugs 3, 8)', () => {
  it('selecting a sandbox bound to another project rescopes tasks, events and the conversation', async () => {
    const core = new ScriptedCore();
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    state.values.set('sandpane.ui.selectedSandbox', 'atlas-box');
    state.values.set('sandpane.ui.conversation', {
      id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', sandboxName: 'atlas-box',
    });
    const { session } = makeSession(core, state);
    await session.attach();
    await settle();
    let snap = session.snapshot();
    expect(snap.tasks.map((t) => t.taskId)).toEqual(['task-a']);
    expect(snap.conversation?.id).toBe('c1');
    expect(snap.lines.map((l) => l.text)).toEqual(['from p1']);

    session.selectSandbox('nova-live');
    await settle();
    snap = session.snapshot();
    expect(snap.header.project).toBe('Nova Demo');
    // No p1 task stays painted, and p2's events were pulled under p2's scope.
    expect(snap.tasks.map((t) => t.taskId)).toEqual(['task-b']);
    expect(snap.lines.map((l) => l.text)).toEqual(['from p2']);
    const lastSubscribe = core.calls('task.subscribe').at(-1);
    expect(lastSubscribe?.params['projectId']).toBe('p2');
    // The p1 conversation is not reused in p2 (bug 8), and its preference is cleared.
    expect(snap.conversation).toBeNull();
    expect(state.values.has('sandpane.ui.conversation')).toBe(false);
    session.dispose();
  });

  it('switching sandbox inside the same project drops a conversation made in the other sandbox', async () => {
    const core = new ScriptedCore();
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    state.values.set('sandpane.ui.selectedSandbox', 'atlas-box');
    state.values.set('sandpane.ui.conversation', {
      id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', sandboxName: 'atlas-box',
    });
    const { session } = makeSession(core, state);
    await session.attach();
    await settle();
    session.selectSandbox('atlas-unrecorded');
    expect(session.snapshot().conversation).toBeNull();
    session.dispose();
  });

  it('with several projects and none selected, nothing is subscribed unscoped', async () => {
    const core = new ScriptedCore();
    const { session } = makeSession(core);
    await session.attach();
    await settle();
    expect(core.calls('task.subscribe')).toHaveLength(0);
    expect(session.snapshot().notices.join(' ')).toMatch(/No project selected/);
    session.dispose();
  });
});

describe('send authorization and gate (bugs 4, 6)', () => {
  async function ready(sandbox: string) {
    const core = new ScriptedCore();
    const state = new MemoryState();
    const { session, timers } = makeSession(core, state);
    await session.attach();
    await settle();
    session.selectSandbox(sandbox);
    await settle();
    return { core, session, timers };
  }

  it('refuses a send without a reviewed attachment list (no conversation.send)', async () => {
    const { core, session } = await ready('atlas-box');
    await session.send('hello', false, null);
    expect(core.calls('conversation.send')).toHaveLength(0);
    expect(session.snapshot().status?.text).toMatch(/Not sent/);
    session.dispose();
  });

  it('refuses a read-only list sent as a writable task', async () => {
    const { core, session } = await ready('atlas-box');
    const plan = session.previewContext(false);
    await session.send('hello', true, plan.planId);
    expect(core.calls('conversation.send')).toHaveLength(0);
    session.dispose();
  });

  it('sends exactly the reviewed list for the same intent, then clears it', async () => {
    const { core, session } = await ready('atlas-box');
    const plan = session.previewContext(false);
    await session.send('hello', false, plan.planId);
    await settle();
    expect(core.calls('conversation.send')).toHaveLength(1);
    expect(session.snapshot().acceptedSends).toBe(1);
    expect(session.snapshot().contextPlan).toBeNull();
    // The same plan id cannot be replayed for a second send.
    await session.send('again', false, plan.planId);
    expect(core.calls('conversation.send')).toHaveLength(1);
    session.dispose();
  });

  it('a writable send in the selected direct_mount sandbox needs explicit confirmation', async () => {
    const { core, session } = await ready('nova-live');
    expect(session.snapshot().header).toMatchObject({ workspaceMode: 'direct_mount', workspaceHostWritable: true });
    const plan = session.previewContext(true);
    await session.send('edit it', true, plan.planId); // no answer scripted → declined
    expect(stub.warnings.join('\n')).toMatch(/LIVE-WRITABLE/);
    expect(core.calls('conversation.send')).toHaveLength(0);
    session.dispose();
  });

  it('a sandbox with no recorded mode is UNVERIFIED and gated, not treated as safe', async () => {
    const { core, session } = await ready('atlas-unrecorded');
    expect(session.snapshot().header.workspaceModeBadge).toMatch(/UNVERIFIED/);
    const plan = session.previewContext(true);
    await session.send('edit it', true, plan.planId);
    expect(stub.warnings.join('\n')).toMatch(/UNVERIFIED/);
    expect(core.calls('conversation.send')).toHaveLength(0);
    session.dispose();
  });

  it('a writable send in a recorded isolated sandbox goes through without the modal', async () => {
    const { core, session } = await ready('atlas-box');
    const plan = session.previewContext(true);
    await session.send('edit it', true, plan.planId);
    expect(stub.warnings).toHaveLength(0);
    expect(core.calls('conversation.send')).toHaveLength(1);
    session.dispose();
  });
});

describe('live updates (bug 10 / backlog 6)', () => {
  it('re-pulls task.subscribe on a timer while a task is non-terminal', async () => {
    const core = new ScriptedCore();
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    const { session, timers } = makeSession(core, state);
    await session.attach();
    await settle();
    const poll = timers.pending.find((t) => t.ms === EVENT_POLL_INTERVAL_MS);
    expect(poll).toBeDefined();

    core.events.get('task-a')?.push({
      taskId: 'task-a', sequence: 2, kind: 'message.agent', payload: { type: 'message.delta', text: 'live line' }, timestamp: 't',
    });
    const before = core.calls('task.subscribe').length;
    poll?.fn();
    await settle();
    expect(core.calls('task.subscribe').length).toBe(before + 1);
    expect(session.snapshot().lines.map((l) => l.text)).toContain('live line');
    session.dispose();
  });
});

describe('review opens real Uri objects (bug 1, S5)', () => {
  it('passes Uri.file / git-revision Uri objects that keep "#" and "?" in the path', async () => {
    const core = new ScriptedCore();
    const { session } = makeSession(core);
    stub.workspaceFolders = [{ uri: Uri.file('/repo/atlas'), name: 'atlas' }];
    stub.answers.set('Yes, use this folder', 'Yes, use this folder');
    await session.attach();
    await settle();
    await session.reviewChanges('task-a');

    const diff = stub.commands.find((c) => c.command === 'vscode.diff');
    expect(diff).toBeDefined();
    const [left, right, title] = diff?.args as [StubUri, StubUri, string];
    expect(typeof left).toBe('object');
    expect(left.scheme).toBe('git');
    expect(left.path).toBe('/repo/atlas/src/a#b?.ts');
    expect(JSON.parse(left.query)).toEqual({
      path: '/repo/atlas/src/a#b?.ts',
      ref: 'b71995fc1e0f4a3c8f0d7b1a2e3c4d5e6f708192',
    });
    expect(right).toMatchObject({ scheme: 'file', path: '/repo/atlas/src/a#b?.ts', fragment: '' });
    expect(title).toContain('src/a#b?.ts');

    const open = stub.commands.find((c) => c.command === 'vscode.open');
    expect(open?.args[0]).toMatchObject({ scheme: 'file', path: '/repo/atlas/notes #1.txt' });
    session.dispose();
  });
});

describe('Core remediation hints and canonical repositories (Core update)', () => {
  it("shows Core's details.hint (e.g. sbx login) to the user as text", async () => {
    const core = new ScriptedCore();
    core.sandboxListError = {
      code: 'PROVIDER_AUTH_REQUIRED',
      message: 'sbx: not signed in to Docker',
      details: { provider: 'docker', hint: 'sbx login' },
    };
    const { session } = makeSession(core);
    await session.attach();
    await settle();
    expect(stub.errors.join('\n')).toMatch(/Core suggests \(provider: docker\): sbx login/);
    expect(session.snapshot().status?.text).toMatch(/sbx login/);
    // Shown, never run: no command was executed for it.
    expect(stub.commands.filter((c) => JSON.stringify(c).includes('sbx login'))).toHaveLength(0);
    session.dispose();
  });

  it("proposes the workspace folder whose REALPATH is the project's canonical repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandpane-canon-')); // /var/… on macOS, canonical /private/var/…
    try {
      const core = new ScriptedCore();
      core.p1Repositories = [realpathSync(dir)];
      const state = new MemoryState();
      state.values.set('sandpane.ui.selectedProject', 'p1');
      const { session } = makeSession(core, state);
      stub.workspaceFolders = [
        { uri: Uri.file('/definitely/not/the/repo'), name: 'other' },
        { uri: Uri.file(dir), name: 'repo' },
      ];
      await session.attach();
      await settle();
      await session.reviewChanges('task-a'); // no answer scripted → declined after the prompt
      const prompt = stub.infos.find((m) => m.includes('repository root')) ?? '';
      expect(prompt).toContain(dir);
      expect(prompt).toMatch(/one of the project's repositories/);
      session.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('confirmRepoRoot reveals Core-registered repository paths (I7)', () => {
  it('the matched canonical repository is shown revealed in the modal provenance line', async () => {
    const repo = '/repo/at\u202Elas';
    const core = new ScriptedCore();
    core.p1Repositories = [repo];
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    const { session } = makeSession(core, state);
    stub.workspaceFolders = [{ uri: Uri.file(repo), name: 'atlas' }];
    await session.attach();
    await settle();
    await session.reviewChanges('task-a'); // no answer scripted → declined after the prompt
    const prompt = stub.infos.find((m) => m.includes('repository root')) ?? '';
    const provenance = /registered in Core \((.*)\)\./.exec(prompt)?.[1] ?? '';
    expect(provenance).toBe('/repo/at\\u202Elas');
    session.dispose();
  });

  it("an unmatched project's repositories are listed revealed in the warning", async () => {
    const core = new ScriptedCore();
    core.p1Repositories = ['/repo/x\u202Ey', '/repo/z\u2028w'];
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    const { session } = makeSession(core, state);
    stub.workspaceFolders = [{ uri: Uri.file('/repo/other'), name: 'other' }];
    await session.attach();
    await settle();
    await session.reviewChanges('task-a');
    const prompt = stub.infos.find((m) => m.includes('repository root')) ?? '';
    const warning = /no open folder matches the project's repositories in Core \((.*)\)\./.exec(prompt)?.[1] ?? '';
    expect(warning).toContain('/repo/x\\u202Ey');
    expect(warning).toContain('/repo/z\\u2028w');
    expect(warning).not.toMatch(/[\u202E\u2028]/);
    session.dispose();
  });
});

describe('stale responses after a project switch (review W1)', () => {
  function startInP1(): { core: ScriptedCore; state: MemoryState } {
    const core = new ScriptedCore();
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    state.values.set('sandpane.ui.selectedSandbox', 'atlas-box');
    return { core, state };
  }

  it("a task.list for project A that answers after switching to B never paints A's tasks", async () => {
    const { core, state } = startInP1();
    core.hold = (f) => f.method === 'task.list' && f.params['projectId'] === 'p1';
    const { session } = makeSession(core, state);
    void session.attach();
    await settle();
    expect(core.calls('task.list').map((f) => f.params['projectId'])).toEqual(['p1']);
    core.hold = null;

    session.selectSandbox('nova-live'); // → project p2
    await settle();
    core.release(); // p1's task.list finally answers
    await settle();
    const snap = session.snapshot();
    expect(snap.header.project).toBe('Nova Demo');
    expect(snap.tasks.map((t) => t.taskId)).toEqual(['task-b']);
    expect(snap.lines.map((l) => l.text)).toEqual(['from p2']);
    session.dispose();
  });

  it("a task.subscribe for project A that answers after switching to B never paints A's events", async () => {
    const { core, state } = startInP1();
    core.hold = (f) => f.method === 'task.subscribe' && f.params['projectId'] === 'p1';
    const { session } = makeSession(core, state);
    void session.attach();
    await settle();
    expect(core.calls('task.subscribe').map((f) => f.params['projectId'])).toEqual(['p1']);
    core.hold = null;

    session.selectSandbox('nova-live');
    await settle();
    core.release();
    await settle();
    const snap = session.snapshot();
    expect(snap.lines.map((l) => l.text)).toEqual(['from p2']);
    expect(snap.tasks.map((t) => t.taskId)).toEqual(['task-b']);
    session.dispose();
  });
});

describe('double sends (review W3, S4)', () => {
  async function readyInBox() {
    const core = new ScriptedCore();
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    state.values.set('sandpane.ui.selectedSandbox', 'atlas-box');
    const { session } = makeSession(core, state);
    await session.attach();
    await settle();
    return { core, session };
  }

  it('two concurrent sends create ONE conversation and send ONE message', async () => {
    const { core, session } = await readyInBox();
    session.handleWebviewMessage({ type: 'selectSandbox', name: 'atlas-unrecorded' }); // drop c1: new conversation needed
    session.handleWebviewMessage({ type: 'selectSandbox', name: 'atlas-box' });
    const plan = session.previewContext(false);
    const first = session.send('hello', false, plan.planId);
    const second = session.send('hello', false, plan.planId);
    expect(session.snapshot().sending).toBe(true);
    await Promise.all([first, second]);
    await settle();
    expect(core.calls('conversation.create')).toHaveLength(1);
    expect(core.calls('conversation.send')).toHaveLength(1);
    expect(session.snapshot().sending).toBe(false);
    session.dispose();
  });

  it('a list reviewed while a send was in flight is not discarded by that send (S4)', async () => {
    const { core, session } = await readyInBox();
    const plan = session.previewContext(false);
    core.hold = (f) => f.method === 'conversation.send';
    const sending = session.send('hello', false, plan.planId);
    await settle();
    const next = session.previewContext(true); // the user prepares the next message
    core.hold = null;
    core.release();
    await sending;
    await settle();
    expect(session.snapshot().contextPlan?.planId).toBe(next.planId);
    session.dispose();
  });
});

describe('sandbox selection is validated against Core (S3)', () => {
  it('ignores a sandbox name Core did not list', async () => {
    const core = new ScriptedCore();
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    state.values.set('sandpane.ui.selectedSandbox', 'atlas-box');
    const { session } = makeSession(core, state);
    await session.attach();
    await settle();
    session.handleWebviewMessage({ type: 'selectSandbox', name: 'not-a-core-sandbox' });
    expect(session.snapshot().selectedSandbox).toBe('atlas-box');
    expect(state.values.get('sandpane.ui.selectedSandbox')).toBe('atlas-box');
    expect(session.snapshot().status?.text).toMatch(/not listed by Core/);
    session.dispose();
  });
});

describe('A1 sandbox lifecycle: stop / remove / create agent', () => {
  async function online(core = new ScriptedCore()) {
    const made = makeSession(core);
    await made.session.attach();
    await settle();
    return { core, ...made };
  }

  it('stop is refused visibly — no sandbox.stop frame — when Core does not advertise it', async () => {
    const core = new ScriptedCore();
    core.methods = PRE_A1_METHODS;
    const { session } = await online(core);
    stub.answers.set('Stop sandbox', 'Stop sandbox');
    expect(await session.stopSandbox('atlas-box')).toBeUndefined();
    expect(core.calls('sandbox.stop')).toHaveLength(0);
    expect(stub.warnings.at(-1)).toMatch(/not supported by the attached Sandpane Core.*"sandbox\.stop"/);
    session.dispose();
  });

  it('stop sends {name} only after the modal, then re-lists sandboxes', async () => {
    const { core, session } = await online();
    stub.answers.set('Stop sandbox', 'Stop sandbox');
    const listsBefore = core.calls('sandbox.list').length;
    await session.stopSandbox('atlas-box');
    const call = stub.warningCalls.find((c) => c.items.includes('Stop sandbox'));
    expect(call?.options?.modal).toBe(true);
    expect(core.calls('sandbox.stop').map((f) => f.params)).toEqual([{ name: 'atlas-box' }]);
    expect(core.calls('sandbox.list').length).toBe(listsBefore + 1);
    expect(session.snapshot().status?.text).toContain('sbx now reports state: stopped');
    session.dispose();
  });

  it('FUTURE Core path: stop counts active tasks once Core records task.sandboxName', async () => {
    const core = new ScriptedCore();
    core.taskSandboxNames = true;
    const { session } = await online(core);
    await session.stopSandbox('atlas-box');
    const listed = core.calls('task.list').at(-1);
    expect(listed?.params['projectId']).toBeUndefined();
    expect(listed?.params['statuses']).not.toContain('completed');
    const call = stub.warningCalls.find((c) => c.items.includes('Stop sandbox'));
    expect(call?.message).toBe('Stop sandbox "atlas-box"? 1 active task(s) use it.');
    expect(call?.options?.detail).toContain('WARNING: 1 active task(s) recorded by Core run in this sandbox');
    session.dispose();
  });

  it('real Core shape (tasks without sandboxName): active tasks "cannot be checked", never "none"', async () => {
    const { core, session } = await online();
    await session.stopSandbox('atlas-box');
    expect(core.calls('task.list').length).toBeGreaterThan(0);
    const call = stub.warningCalls.find((c) => c.items.includes('Stop sandbox'));
    expect(call?.message).toBe('Stop sandbox "atlas-box"?');
    expect(call?.options?.detail).toContain(
      'Active tasks in this sandbox cannot be checked: Core does not yet record which sandbox a task uses.',
    );
    expect(call?.options?.detail).not.toContain('no active task');
    session.dispose();
  });

  it('stop and remove address an sbx-named sandbox the create rule would refuse (W3)', async () => {
    const core = new ScriptedCore();
    core.confirmation = { ...core.confirmation, target: { name: 'Atlas.Demo', id: 'b5ebec73-e2ae-471a-811a-e011cfb1948e' } };
    const { session } = await online(core);
    stub.answers.set('Stop sandbox', 'Stop sandbox');
    stub.answers.set('Remove sandbox', 'Remove sandbox');
    await session.stopSandbox('Atlas.Demo');
    expect(core.calls('sandbox.stop').map((f) => f.params)).toEqual([{ name: 'Atlas.Demo' }]);
    await session.removeSandbox('Atlas.Demo');
    expect(core.calls('sandbox.remove').map((f) => f.params)).toEqual([
      { name: 'Atlas.Demo' },
      { name: 'Atlas.Demo', confirmToken: TOKEN },
    ]);
    session.dispose();
  });

  it('stop cancelled in the modal sends nothing', async () => {
    const { core, session } = await online();
    await session.stopSandbox('atlas-box');
    expect(core.calls('sandbox.stop')).toHaveLength(0);
    expect(session.snapshot().status?.text).toBe('Stop not confirmed; nothing was sent.');
    session.dispose();
  });

  it('an absent re-query shows the state as UNKNOWN, never "stopped"', async () => {
    const core = new ScriptedCore();
    core.stopAnswer = { ok: { stopped: true } };
    const { session } = await online(core);
    stub.answers.set('Stop sandbox', 'Stop sandbox');
    await session.stopSandbox('atlas-box');
    const status = session.snapshot().status;
    expect(status?.tone).toBe('info');
    expect(status?.text).toContain('UNKNOWN');
    expect(status?.text).not.toMatch(/reports state: stopped/);
    session.dispose();
  });

  it('remove is refused visibly — no sandbox.remove frame — when not advertised', async () => {
    const core = new ScriptedCore();
    core.methods = PRE_A1_METHODS;
    const { session } = await online(core);
    stub.answers.set('Remove sandbox', 'Remove sandbox');
    expect(await session.removeSandbox('atlas-box')).toBe(false);
    expect(core.calls('sandbox.remove')).toHaveLength(0);
    expect(stub.warnings.at(-1)).toMatch(/"sandbox\.remove"/);
    session.dispose();
  });

  it('remove cancelled: step 1 only — step 2 is never sent', async () => {
    const { core, session } = await online();
    // No scripted answer for "Remove sandbox" ⇒ the modal is dismissed.
    expect(await session.removeSandbox('atlas-box')).toBe(false);
    const frames = core.calls('sandbox.remove');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.params).toEqual({ name: 'atlas-box' });
    expect(session.snapshot().status?.text).toMatch(/nothing was sent/);
    session.dispose();
  });

  it('remove confirmed: step 2 carries exactly the step-1 token, then the list is re-read', async () => {
    const { core, session } = await online();
    session.selectSandbox('atlas-box');
    stub.answers.set('Remove sandbox', 'Remove sandbox');
    const listsBefore = core.calls('sandbox.list').length;
    expect(await session.removeSandbox('atlas-box')).toBe(true);
    const frames = core.calls('sandbox.remove');
    expect(frames.map((f) => f.params)).toEqual([{ name: 'atlas-box' }, { name: 'atlas-box', confirmToken: TOKEN }]);
    expect(core.calls('sandbox.list').length).toBe(listsBefore + 1);
    const snap = session.snapshot();
    expect(snap.sandboxes.map((s) => s.name)).not.toContain('atlas-box');
    expect(snap.selectedSandbox).toBeNull();
    expect(snap.status?.tone).toBe('ok');
    // The modal showed identity, impact and expiry, and was native + modal.
    const call = stub.warningCalls.find((c) => c.items.includes('Remove sandbox'));
    expect(call?.options?.modal).toBe(true);
    expect(call?.message).toBe('Remove sandbox "atlas-box"?');
    expect(call?.options?.detail).toContain('sbx id: b5ebec73-e2ae-471a-811a-e011cfb1948e');
    expect(call?.options?.detail).toContain('• removes sandbox atlas-box');
    expect(call?.options?.detail).toContain('• its sbx-clone workspace is deleted');
    expect(call?.options?.detail).toContain('(in about 120 s)');
    session.dispose();
  });

  it('a confirmation that expires while the modal is open is never sent (W1)', async () => {
    const { core, session } = await online();
    // The user clicks "Remove sandbox" only after Core's expiry has passed.
    stub.answers.set('Remove sandbox', 'Remove sandbox');
    // Read 1 builds the modal (12:00:00, "in about 120 s"); read 2 is the
    // click — by then Core's expiry (12:02:00) has passed.
    clock.after = { reads: 1, now: Date.parse('2026-10-10T12:02:00Z') };
    expect(await session.removeSandbox('atlas-box')).toBe(false);
    const detail = stub.warningCalls.find((c) => c.items.includes('Remove sandbox'))?.options?.detail ?? '';
    expect(detail).toContain('(in about 120 s)');
    expect(clock.reads).toEqual([Date.parse('2026-10-10T12:00:00Z'), Date.parse('2026-10-10T12:02:00Z')]);
    expect(core.calls('sandbox.remove').map((f) => f.params)).toEqual([{ name: 'atlas-box' }]);
    expect(session.snapshot().status?.text).toBe('Confirmation expired — nothing was sent; run Remove again.');
    session.dispose();
  });

  it('an unparseable expiry fails closed: no step 2 (W1)', async () => {
    const core = new ScriptedCore();
    core.confirmation = { ...core.confirmation, expiresAt: 'soon' };
    const { session } = await online(core);
    stub.answers.set('Remove sandbox', 'Remove sandbox');
    expect(await session.removeSandbox('atlas-box')).toBe(false);
    expect(core.calls('sandbox.remove')).toHaveLength(1);
    const detail = stub.warningCalls.find((c) => c.items.includes('Remove sandbox'))?.options?.detail ?? '';
    expect(detail).toContain('cannot be used');
    expect(session.snapshot().status?.text).toBe('Confirmation expired — nothing was sent; run Remove again.');
    session.dispose();
  });

  it('external: NOT CONFIRMED AS CREATED BY SANDPANE leads the modal title and body', async () => {
    const core = new ScriptedCore();
    core.confirmation = { ...core.confirmation, external: true };
    const { session } = await online(core);
    await session.removeSandbox('atlas-box');
    const call = stub.warningCalls.find((c) => c.items.includes('Remove sandbox'));
    expect(call?.message.startsWith('NOT CONFIRMED AS CREATED BY SANDPANE')).toBe(true);
    expect(call?.options?.detail?.startsWith('NOT CONFIRMED AS CREATED BY SANDPANE')).toBe(true);
    expect(call?.options?.detail).toContain('Core cannot confirm Sandpane created this sandbox (no Sandpane binding is recorded for this sbx id).');
    expect(call?.options?.detail).not.toContain('created outside');
    expect(core.calls('sandbox.remove')).toHaveLength(1);
    session.dispose();
  });

  it('hostile impact lines are shown escaped, on one line each', async () => {
    const core = new ScriptedCore();
    const rlo = String.fromCodePoint(0x202e);
    core.confirmation = {
      ...core.confirmation,
      impact: [`deletes ${rlo}fdp.exe`, 'removes atlas-box' + String.fromCodePoint(10) + 'Nothing is deleted, safe to confirm'],
    };
    const { session } = await online(core);
    await session.removeSandbox('atlas-box');
    const detail = stub.warningCalls.find((c) => c.items.includes('Remove sandbox'))?.options?.detail ?? '';
    expect(detail).not.toContain(rlo);
    expect(detail).toContain('deletes ' + String.fromCodePoint(92) + 'u202Efdp.exe');
    expect(detail.split(String.fromCodePoint(10))).not.toContain('Nothing is deleted, safe to confirm');
    expect(detail).toContain('WARNING: text from Core contained invisible or control characters');
    session.dispose();
  });

  it('a step-1 answer for a different target is never presented and never confirmed', async () => {
    const core = new ScriptedCore();
    core.confirmation = { ...core.confirmation, target: { name: 'nova-live', id: 'x' } };
    const { session } = await online(core);
    stub.answers.set('Remove sandbox', 'Remove sandbox');
    expect(await session.removeSandbox('atlas-box')).toBe(false);
    expect(stub.warningCalls.some((c) => c.items.includes('Remove sandbox'))).toBe(false);
    expect(core.calls('sandbox.remove')).toHaveLength(1);
    expect(stub.errors.at(-1)).toMatch(/step 2 is not sent/);
    session.dispose();
  });

  it('a refused token (VALIDATION_FAILED) is explained and nothing is retried', async () => {
    const core = new ScriptedCore();
    core.removeAnswer = { err: { code: 'VALIDATION_FAILED', message: 'confirmation token is invalid or expired' } };
    const { session } = await online(core);
    stub.answers.set('Remove sandbox', 'Remove sandbox');
    expect(await session.removeSandbox('atlas-box')).toBe(false);
    expect(core.calls('sandbox.remove')).toHaveLength(2);
    expect(stub.errors.at(-1)).toContain('Core refused the confirmation');
    expect(stub.errors.at(-1)).toContain('Nothing was removed');
    session.dispose();
  });

  it('a same-named replacement (CONFLICT) is explained', async () => {
    const core = new ScriptedCore();
    core.removeAnswer = { err: { code: 'CONFLICT', message: 'sandbox identity changed' } };
    const { session } = await online(core);
    stub.answers.set('Remove sandbox', 'Remove sandbox');
    await session.removeSandbox('atlas-box');
    expect(stub.errors.at(-1)).toContain('same-named replacement');
    expect(core.calls('sandbox.remove')).toHaveLength(2);
    session.dispose();
  });

  it('Core error text is shown with hidden characters escaped', async () => {
    const core = new ScriptedCore();
    const rlo = String.fromCodePoint(0x202e);
    core.removeAnswer = { err: { code: 'NOT_FOUND', message: `gone ${rlo}[ok](command:evil)` } };
    const { session } = await online(core);
    stub.answers.set('Remove sandbox', 'Remove sandbox');
    await session.removeSandbox('atlas-box');
    const shown = stub.errors.at(-1) ?? '';
    expect(shown).not.toContain(rlo);
    expect(shown).toContain(String.fromCodePoint(92) + 'u202E');
    expect(shown).not.toContain('](command:');
    session.dispose();
  });

  it('create: a non-shell agent is sent only when "sandbox-create-agent" is advertised; default shell is omitted', async () => {
    const { core, session } = await online();
    await session.createSandbox({ name: 'atlas-agent', projectId: 'p1', workspaceMode: 'mountless', agent: 'codex' });
    await session.createSandbox({ name: 'atlas-shell', projectId: 'p1', workspaceMode: 'mountless' });
    const sent = core.calls('sandbox.create').map((f) => f.params);
    expect(sent[0]).toMatchObject({ name: 'atlas-agent', agent: 'codex' });
    expect(Object.keys(sent[1] ?? {})).not.toContain('agent');
    session.dispose();

    // A1 methods advertised but NOT the feature: the method list is no longer
    // used as a marker (A2 replaced that inference).
    const old = new ScriptedCore();
    old.features = ['idempotency-keys'];
    const pre = await online(old);
    expect(
      await pre.session.createSandbox({ name: 'atlas-agent', projectId: 'p1', workspaceMode: 'mountless', agent: 'codex' }),
    ).toBeUndefined();
    expect(old.calls('sandbox.create')).toHaveLength(0);
    expect(stub.warnings.at(-1)).toMatch(/does not advertise the "sandbox-create-agent" feature/);
    pre.session.dispose();
  });
});

describe('A2 idempotency keys: create / send', () => {
  const KEY = /^[0-9a-f]{32}$/;
  const createInput = { name: 'atlas-new', projectId: 'p1', workspaceMode: 'mountless' as const };

  async function online(core = new ScriptedCore()) {
    const made = makeSession(core);
    await made.session.attach();
    await settle();
    return { core, ...made };
  }

  /** Select a p1 sandbox and send once (writable gate answered). */
  async function sendOnce(session: SandpaneSession, text = 'explain the auth flow') {
    session.selectSandbox('atlas-box');
    const plan = session.previewContext(false);
    stub.answers.set('Send anyway', 'Send anyway');
    await session.send(text, false, plan.planId, 'command');
  }

  /** Fire the client deadline of the (held) request whose timeout is `ms`. */
  function expire(timers: FakeTimers, ms: number): void {
    const timer = timers.pending.find((t) => t.ms === ms);
    if (!timer) throw new Error(`no pending ${ms} ms timer`);
    timers.clear(timer.id);
    timer.fn();
  }

  it('sends a fresh 32-hex key per create and per send when "idempotency-keys" is advertised', async () => {
    const { core, session } = await online();
    await session.createSandbox(createInput);
    await session.createSandbox({ ...createInput, name: 'atlas-new-2' });
    const createKeys = core.calls('sandbox.create').map((f) => f.params['idempotencyKey']);
    expect(createKeys).toHaveLength(2);
    for (const key of createKeys) expect(key).toMatch(KEY);
    expect(createKeys[0]).not.toBe(createKeys[1]);

    await sendOnce(session, 'first');
    await sendOnce(session, 'second');
    const sendKeys = core.calls('conversation.send').map((f) => f.params['idempotencyKey']);
    expect(sendKeys).toHaveLength(2);
    for (const key of sendKeys) expect(key).toMatch(KEY);
    expect(sendKeys[0]).not.toBe(sendKeys[1]);
    // Never derived from content: identical text gets a different key.
    await sendOnce(session, 'first');
    expect(core.calls('conversation.send').at(-1)?.params['idempotencyKey']).not.toBe(sendKeys[0]);
    session.dispose();
  });

  it('sends NO key to a Core without the feature (pre-A2), and ignores unknown feature strings', async () => {
    const pre = new ScriptedCore();
    pre.features = undefined;
    const a = await online(pre);
    await a.session.createSandbox(createInput);
    await sendOnce(a.session);
    expect(Object.keys(pre.calls('sandbox.create')[0]?.params ?? {})).not.toContain('idempotencyKey');
    expect(Object.keys(pre.calls('conversation.send')[0]?.params ?? {})).not.toContain('idempotencyKey');
    a.session.dispose();

    const future = new ScriptedCore();
    future.features = ['some-future-feature', 'idempotency-keys'];
    const b = await online(future);
    await b.session.createSandbox(createInput);
    expect(future.calls('sandbox.create')[0]?.params['idempotencyKey']).toMatch(KEY);
    expect(b.session.snapshot().connection).toBe('online');
    b.session.dispose();
  });

  it('a keyed create with an unknown outcome is NOT retried automatically', async () => {
    const core = new ScriptedCore();
    core.hold = (f) => f.method === 'sandbox.create';
    const { session, timers } = await online(core);
    const pending = session.createSandbox(createInput);
    await settle();
    expire(timers, 330_000);
    await pending;
    await settle();
    expect(core.calls('sandbox.create')).toHaveLength(1);
    const offered = stub.errorCalls.at(-1);
    expect(offered?.items).toEqual(['Retry safely']);
    expect(offered?.message).toContain('outcome UNKNOWN');
    session.dispose();
  });

  it('"Retry safely" resends the identical create with the SAME key; a replay is announced and re-read', async () => {
    const core = new ScriptedCore();
    let first = true;
    // Core finished the first create but the answer never arrived.
    core.hold = (f) => {
      if (f.method !== 'sandbox.create' || !first) return false;
      first = false;
      return true;
    };
    const { session, timers } = await online(core);
    stub.answers.set('Retry safely', 'Retry safely');
    const pending = session.createSandbox(createInput);
    await settle();
    expire(timers, 330_000);
    await pending;
    const listsBefore = core.calls('sandbox.list').length;
    await settle(30);
    const frames = core.calls('sandbox.create');
    expect(frames).toHaveLength(2);
    expect(frames[1]?.params).toEqual(frames[0]?.params);
    expect(frames[1]?.params['idempotencyKey']).toMatch(KEY);
    expect(core.calls('sandbox.list').length).toBe(listsBefore + 1);
    expect(session.snapshot().status).toEqual({
      tone: 'info',
      text: 'Core returned the result of your earlier identical request (replayed). It may be out of date; refreshing from Core.',
    });
    expect(session.snapshot().status?.text).not.toMatch(/created/);
    session.dispose();
  });

  it('a keyed send with an unknown outcome retries only on click, same key and content; the replay re-reads task.list', async () => {
    const core = new ScriptedCore();
    let first = true;
    core.hold = (f) => {
      if (f.method !== 'conversation.send' || !first) return false;
      first = false;
      return true;
    };
    const { session, timers } = await online(core);
    stub.answers.set('Retry safely', 'Retry safely');
    const sending = sendOnce(session);
    await settle();
    expire(timers, 15_000);
    await sending;
    const taskLists = core.calls('task.list').length;
    await settle(30);
    const frames = core.calls('conversation.send');
    expect(frames).toHaveLength(2);
    expect(frames[1]?.params).toEqual(frames[0]?.params);
    expect(core.calls('task.list').length).toBeGreaterThan(taskLists);
    expect(session.snapshot().status?.text).toBe(
      'Core returned the result of your earlier identical request (replayed). It may be out of date; refreshing from Core.',
    );
    // The replayed summary's status is never painted as current state.
    expect(session.snapshot().tasks.map((t) => t.taskId)).not.toContain(
      `task-new-${core.requests.indexOf(frames[0] as Frame) + 1}`,
    );
    session.dispose();
  });

  /** A keyed create whose answer never arrives; the Retry button is clicked by hand. */
  async function unknownCreate(core: ScriptedCore) {
    let first = true;
    core.hold = (f) => {
      if (f.method !== 'sandbox.create' || !first) return false;
      first = false;
      return true;
    };
    stub.manual.add('Retry safely');
    const made = await online(core);
    const pending = made.session.createSandbox(createInput);
    await settle();
    expire(made.timers, 330_000);
    await pending;
    await settle();
    expect(stub.clicks).toHaveLength(1);
    return made;
  }

  it('W1: "Retry safely" re-probes at click time — reconnected to a Core without keys, nothing is sent', async () => {
    const core = new ScriptedCore();
    const { session } = await unknownCreate(core);
    const probes = core.calls('system.probe').length;
    // Core restarts as a build without idempotency keys; the cached probe is stale.
    core.features = undefined;
    core.drop();
    await settle();
    stub.clicks.shift()?.('Retry safely');
    await settle(30);
    expect(core.calls('system.probe').length).toBeGreaterThan(probes);
    expect(core.calls('sandbox.create')).toHaveLength(1);
    expect(stub.errors.at(-1)).toBe(
      'Not retried: the connected Core does not advertise idempotency keys, so a retry could run it twice. ' +
        'Nothing was sent — check state first.',
    );
    session.dispose();
  });

  it('W1: the click-time gate also refuses on a live connection whose Core changed features', async () => {
    const core = new ScriptedCore();
    const { session } = await unknownCreate(core);
    core.features = ['sandbox-create-agent'];
    stub.clicks.shift()?.('Retry safely');
    await settle(30);
    expect(core.calls('sandbox.create')).toHaveLength(1);
    expect(stub.errors.at(-1)).toMatch(/^Not retried: the connected Core does not advertise idempotency keys/);
    session.dispose();
  });

  it('W2: the retry attaches first when the connection dropped, then resends the same key', async () => {
    const core = new ScriptedCore();
    const { session } = await unknownCreate(core);
    core.drop();
    await settle();
    stub.clicks.shift()?.('Retry safely');
    await settle(40);
    const frames = core.calls('sandbox.create');
    expect(frames).toHaveLength(2);
    expect(frames[1]?.params).toEqual(frames[0]?.params);
    expect(session.snapshot().status?.text).toMatch(/replayed/);
    session.dispose();
  });

  it('W2: a retry that cannot reach Core keeps the UNKNOWN context and offers "Retry safely" again (same key)', async () => {
    const core = new ScriptedCore();
    const { session } = await unknownCreate(core);
    core.drop();
    core.refuseConnect = true;
    await settle();
    stub.clicks.shift()?.('Retry safely');
    await settle(30);
    expect(core.calls('sandbox.create')).toHaveLength(1);
    const reoffered = stub.errorCalls.at(-1);
    expect(reoffered?.items).toEqual(['Retry safely']);
    expect(reoffered?.message).toContain('outcome UNKNOWN');
    expect(reoffered?.message).toContain('could not reach Core');
    expect(reoffered?.message).not.toMatch(/Core is not attached/);
    expect(stub.clicks).toHaveLength(1);
    // Core comes back; the second click resends the identical request.
    core.refuseConnect = false;
    stub.clicks.shift()?.('Retry safely');
    await settle(40);
    const frames = core.calls('sandbox.create');
    expect(frames).toHaveLength(2);
    expect(frames[1]?.params).toEqual(frames[0]?.params);
    session.dispose();
  });

  it('I1: the retry copy says Core may also refuse', async () => {
    const core = new ScriptedCore();
    const { session } = await unknownCreate(core);
    expect(stub.errorCalls.at(-1)?.message).toContain(
      'Core runs it at most once; otherwise it returns the earlier result or refuses',
    );
    session.dispose();
  });

  it('without a key (pre-A2) an unknown outcome offers NO "Retry safely" and says check first', async () => {
    const core = new ScriptedCore();
    core.features = undefined;
    core.forced.set('sandbox.create', { code: 'INTERNAL', message: 'sbx create failed after it started' });
    const { session } = await online(core);
    await session.createSandbox(createInput);
    const shown = stub.errorCalls.at(-1);
    expect(shown?.items).not.toContain('Retry safely');
    expect(shown?.message).toContain('Check before trying again');
    expect(core.calls('sandbox.create')).toHaveLength(1);
    session.dispose();
  });

  it('a keyed INTERNAL failure is an unknown outcome and offers "Retry safely"', async () => {
    const core = new ScriptedCore();
    core.forced.set('sandbox.create', { code: 'INTERNAL', message: 'sbx create timed out after 300s' });
    const { session } = await online(core);
    await session.createSandbox(createInput);
    await settle();
    expect(stub.errorCalls.at(-1)?.items).toEqual(['Retry safely']);
    expect(core.calls('sandbox.create')).toHaveLength(1);
    session.dispose();
  });

  it.each([
    ['mismatch', 'idempotency key was already used with different parameters; nothing was run', /Nothing was run\./],
    ['pending', 'an operation with this idempotency key is still in progress; nothing was run', /Nothing was run/],
    ['name lock', 'another operation on sandbox "atlas-new" is in progress; nothing was run', /another operation on this sandbox is in progress\. Nothing was run\./],
  ])('CONFLICT %s: plain copy says nothing was run, shows Core\'s message, no retry, no new key', async (_label, message, copy) => {
    const core = new ScriptedCore();
    core.forced.set('sandbox.create', { code: 'CONFLICT', message });
    const { session } = await online(core);
    await session.createSandbox(createInput);
    await settle();
    const shown = stub.errorCalls.at(-1);
    expect(shown?.message).toMatch(copy);
    expect(shown?.message).toContain(`Core said: CONFLICT: ${message}`);
    expect(shown?.items).not.toContain('Retry safely');
    expect(core.calls('sandbox.create')).toHaveLength(1);
    session.dispose();
  });

  it('CONFLICT outcome-unknown: never says "nothing was run", re-reads state, no retry', async () => {
    const message =
      'the outcome of the earlier request with this idempotency key is unknown (Core restarted or sbx failed while it ran); re-read state before retrying with a new key';
    const core = new ScriptedCore();
    core.forced.set('conversation.send', { code: 'CONFLICT', message });
    const { session } = await online(core);
    const taskLists = core.calls('task.list').length;
    await sendOnce(session);
    await settle();
    const shown = stub.errorCalls.at(-1);
    expect(shown?.message).toContain('Outcome unknown');
    expect(shown?.message).toContain('a retry needs a new request');
    expect(shown?.message).toContain(message);
    expect(shown?.message).not.toMatch(/nothing was run/i);
    expect(session.snapshot().status?.text ?? '').not.toMatch(/nothing was run/i);
    expect(shown?.items).not.toContain('Retry safely');
    expect(core.calls('conversation.send')).toHaveLength(1);
    expect(core.calls('task.list').length).toBeGreaterThan(taskLists);
    session.dispose();
  });
});

describe('A3a project lifecycle', () => {
  async function online(core = new ScriptedCore(), state = new MemoryState()) {
    const made = makeSession(core, state);
    await made.session.attach();
    await settle();
    return { core, ...made };
  }
  const atlas = { id: 'p1', name: 'Atlas Demo', description: '', createdAt: '' };
  const archivedAtlas = { ...atlas, archivedAt: '2026-10-10T11:00:00Z' };

  it('every action is refused visibly — no frame — when this Core does not advertise it', async () => {
    const core = new ScriptedCore();
    core.methods = PRE_A3A_METHODS;
    const { session } = await online(core);
    await session.renameProject(atlas, 'Atlas Renamed');
    await session.archiveProject(atlas);
    await session.addRepository(atlas, '/repo/atlas');
    await session.deleteProject(atlas);
    await session.toggleShowArchived();
    for (const m of ['project.update', 'project.archive', 'project.add_repository', 'project.delete']) {
      expect(core.calls(m), m).toHaveLength(0);
    }
    expect(stub.warnings.filter((w) => /not supported by the attached Sandpane Core/.test(w))).toHaveLength(5);
    expect(session.showingArchivedProjects).toBe(false);
    session.dispose();
  });

  it('rename / description / archive / unarchive / repositories send exact frames, then re-read project.list', async () => {
    const { core, session } = await online();
    const lists = (): number => core.calls('project.list').length;
    let before = lists();
    await session.renameProject(atlas, 'Atlas Renamed');
    expect(core.calls('project.update').at(-1)?.params).toEqual({ projectId: 'p1', name: 'Atlas Renamed' });
    expect(lists()).toBe(before + 1);
    await session.editProjectDescription(atlas, 'line one\nline two');
    expect(core.calls('project.update').at(-1)?.params).toEqual({ projectId: 'p1', description: 'line one\nline two' });
    await session.editProjectDescription(atlas, '');
    expect(core.calls('project.update').at(-1)?.params).toEqual({ projectId: 'p1', description: '' });
    expect(session.snapshot().status?.text).toMatch(/cleared/);
    await session.addRepository(atlas, '/repo/atlas');
    expect(core.calls('project.add_repository').at(-1)?.params).toEqual({ projectId: 'p1', path: '/repo/atlas' });
    await session.removeRepository(atlas, '/repo/atlas');
    expect(core.calls('project.remove_repository').at(-1)?.params).toEqual({ projectId: 'p1', path: '/repo/atlas' });
    before = lists();
    await session.archiveProject(atlas);
    expect(core.calls('project.archive').at(-1)?.params).toEqual({ projectId: 'p1' });
    expect(lists()).toBe(before + 1);
    await session.unarchiveProject(archivedAtlas);
    expect(core.calls('project.unarchive').at(-1)?.params).toEqual({ projectId: 'p1' });
    session.dispose();
  });

  it('an archived project: edits are disabled with Core\'s reason (nothing sent); unarchive and delete stay available', async () => {
    const { core, session } = await online();
    await session.renameProject(archivedAtlas, 'x1');
    await session.editProjectDescription(archivedAtlas, 'x');
    await session.addRepository(archivedAtlas, '/repo/atlas');
    await session.removeRepository(archivedAtlas, '/repo/atlas');
    expect(core.calls('project.update')).toHaveLength(0);
    expect(core.calls('project.add_repository')).toHaveLength(0);
    expect(core.calls('project.remove_repository')).toHaveLength(0);
    expect(stub.warnings.at(-1)).toContain('"project is archived; unarchive it first; nothing was changed"');
    expect(stub.warnings.at(-1)).toContain('Nothing was sent.');
    await session.unarchiveProject(archivedAtlas);
    expect(core.calls('project.unarchive')).toHaveLength(1);
    await session.deleteProject(archivedAtlas);
    expect(core.calls('project.delete')).toHaveLength(1);
    session.dispose();
  });

  it('"show archived" sends includeArchived:true only when on, persists as a UI preference, and labels archived projects', async () => {
    const core = new ScriptedCore();
    core.archived.add('p1');
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    const { session } = await online(core, state);
    expect(core.calls('project.list').every((f) => f.params['includeArchived'] === undefined)).toBe(true);
    await session.toggleShowArchived();
    expect(core.calls('project.list').at(-1)?.params).toEqual({ includeArchived: true });
    expect(state.values.get('sandpane.ui.showArchivedProjects')).toBe(true);
    expect(session.snapshot().header.project).toBe('Atlas Demo · ARCHIVED');
    const options = await session.listProjectOptions();
    expect(options.find((o) => o.id === 'p1')?.description).toMatch(/^ARCHIVED · /);
    await session.toggleShowArchived();
    expect(core.calls('project.list').at(-1)?.params).toEqual({});
    session.dispose();
  });

  it('delete: step 1 {projectId} → native modal; confirm sends step 2 with that token; state is forgotten', async () => {
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    state.values.set('sandpane.ui.conversation', { id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', sandboxName: null });
    const { core, session } = await online(new ScriptedCore(), state);
    stub.answers.set('Delete project', 'Delete project');
    expect(await session.deleteProject(atlas)).toBe(true);
    expect(core.calls('project.delete').map((f) => f.params)).toEqual([
      { projectId: 'p1' },
      { projectId: 'p1', confirmToken: TOKEN },
    ]);
    const modal = stub.warningCalls.find((c) => c.items.includes('Delete project'));
    expect(modal?.options?.modal).toBe(true);
    expect(modal?.message).toBe('Delete project "Atlas Demo"?');
    expect(modal?.options?.detail).toContain('Project id: p1');
    expect(modal?.options?.detail).toContain('• task branches in the host repositories are left in place');
    expect(modal?.options?.detail).toContain('(in about 120 s)');
    expect(modal?.options?.detail).not.toContain(TOKEN);
    expect(modal?.options?.detail).not.toContain('NOT CONFIRMED AS CREATED');
    const snap = session.snapshot();
    expect(snap.header.project).not.toBe('Atlas Demo');
    expect(state.values.has('sandpane.ui.selectedProject')).toBe(false);
    expect(state.values.has('sandpane.ui.conversation')).toBe(false);
    expect(snap.conversation).toBeNull();
    expect(snap.status?.text).toMatch(/^Core deleted project "Atlas Demo" \(its Core records only/);
    session.dispose();
  });

  it('delete cancelled sends step 1 only; an expired confirmation at click time sends nothing more', async () => {
    const { core, session } = await online();
    expect(await session.deleteProject(atlas)).toBe(false);
    expect(core.calls('project.delete')).toHaveLength(1);
    expect(session.snapshot().status?.text).toMatch(/nothing was sent/);

    stub.answers.set('Delete project', 'Delete project');
    clock.after = { reads: clock.reads.length + 1, now: Date.parse('2026-10-10T12:02:00Z') };
    expect(await session.deleteProject(atlas)).toBe(false);
    expect(core.calls('project.delete').filter((f) => f.params['confirmToken'] !== undefined)).toHaveLength(0);
    expect(session.snapshot().status?.text).toBe('Confirmation expired — nothing was sent; run Delete Project again.');
    session.dispose();
  });

  it('a step-1 confirmation for another project id is never presented and never confirmed', async () => {
    const core = new ScriptedCore();
    core.confirmationTargetId = 'p2';
    const { session } = await online(core);
    stub.answers.set('Delete project', 'Delete project');
    expect(await session.deleteProject(atlas)).toBe(false);
    expect(core.calls('project.delete').map((f) => f.params)).toEqual([{ projectId: 'p1' }]);
    expect(stub.warningCalls.some((c) => c.items.includes('Delete project'))).toBe(false);
    expect(stub.errors.at(-1)).toMatch(/Nothing was deleted/);
    session.dispose();
  });

  it.each([
    ['CONFLICT', 'project has tasks that are not finished; cancel or finish them first; nothing was deleted', 'The project has unfinished tasks. Cancel or finish them first; nothing was deleted.'],
    ['CONFLICT', 'project has sandboxes; remove them first; nothing was deleted', 'The project still has sandboxes. Remove them first; nothing was deleted.'],
    ['CONFLICT', 'a sandbox is being created for this project; try again when it finishes; nothing was deleted', 'A sandbox is being created for this project. Try again when it finishes; nothing was deleted.'],
    ['VALIDATION_FAILED', 'confirmation token is invalid, expired, already used, or not for this action and target; request a new confirmation', 'Core refused the confirmation (invalid, expired or already used). Nothing was deleted — run Delete Project again for a fresh confirmation.'],
    ['NOT_FOUND', 'project not found', 'Core has no such project (it may have been deleted); nothing was changed.'],
  ])('delete step 2 %s "%s" → honest copy, no retry', async (code, message, copy) => {
    const core = new ScriptedCore();
    core.forced.set('project.delete', { code, message });
    const { session } = await online(core);
    stub.answers.set('Delete project', 'Delete project');
    expect(await session.deleteProject(atlas)).toBe(false);
    expect(core.calls('project.delete')).toHaveLength(2);
    expect(stub.errors.at(-1)).toContain(copy);
    expect(stub.errors.at(-1)).toContain(`Core said: ${code}: ${message}`);
    session.dispose();
  });

  it('delete step 2 INTERNAL is UNKNOWN (never "nothing was deleted"); Core\'s list then settles it', async () => {
    const core = new ScriptedCore();
    core.forced.set('project.delete', { code: 'INTERNAL', message: 'database is locked' });
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    const { session } = await online(core, state);
    stub.answers.set('Delete project', 'Delete project');
    expect(await session.deleteProject(atlas)).toBe(false);
    const shown = stub.errors.at(-1) ?? '';
    expect(shown).toContain('Outcome UNKNOWN');
    expect(shown).not.toMatch(/nothing was deleted/i);
    expect(core.calls('project.list').at(-2)?.params).toEqual({ includeArchived: true });
    expect(core.calls('project.delete')).toHaveLength(2);
    // The fake did not delete it. Core ANSWERED (INTERNAL), so that request
    // finished: "not deleted" is earned.
    expect(session.snapshot().status?.text).toBe(
      'Core still lists the project as of this re-read — it was not deleted (Core answered the delete request, so that request has finished).',
    );
    expect(state.values.get('sandpane.ui.selectedProject')).toBe('p1');
    session.dispose();
  });

  it.each([
    ['project.update', 'VALIDATION_FAILED', 'project is archived; unarchive it first; nothing was changed', 'This project is archived. Unarchive it first; nothing was changed.'],
    ['project.remove_repository', 'CONFLICT', 'repository is used by a task or sandbox of this project; nothing was removed', 'A task or sandbox of this project uses that repository; nothing was removed.'],
    ['project.remove_repository', 'CONFLICT', 'a sandbox is being created for this project; try again when it finishes; nothing was removed', 'A sandbox is being created for this project. Try again when it finishes; nothing was removed.'],
    ['project.remove_repository', 'NOT_FOUND', 'repository is not registered with this project; nothing was removed', 'That repository is not registered with this project; nothing was removed.'],
  ])('%s %s "%s" → honest copy', async (method, code, message, copy) => {
    const core = new ScriptedCore();
    core.forced.set(method, { code, message });
    const { session } = await online(core);
    if (method === 'project.update') await session.renameProject(atlas, 'Atlas Renamed');
    else await session.removeRepository(atlas, '/repo/atlas');
    expect(stub.errors.at(-1)).toContain(copy);
    session.dispose();
  });

  it('W1: delete step 2 with no answer (timeout): "still lists as of this re-read", never "not deleted"', async () => {
    const core = new ScriptedCore();
    core.forced.set('project.delete', { code: 'INTERNAL', message: 'never delivered' });
    core.hold = (f) => f.method === 'project.delete' && f.params['confirmToken'] !== undefined;
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    const made = makeSession(core, state);
    await made.session.attach();
    await settle();
    stub.answers.set('Delete project', 'Delete project');
    const pending = made.session.deleteProject(atlas);
    await settle();
    const timer = made.timers.pending.find((t) => t.ms === 15_000);
    if (!timer) throw new Error('no pending 15 s timer');
    made.timers.clear(timer.id);
    timer.fn();
    expect(await pending).toBe(false);
    await settle();
    expect(stub.errors.at(-1)).toContain('Outcome UNKNOWN');
    const text = made.session.snapshot().status?.text ?? '';
    expect(text).toBe(
      'Core still lists the project as of this re-read. Core never answered the delete request, so it may still finish — re-read before acting; not retried.',
    );
    expect(text).not.toMatch(/not deleted/);
    expect(core.calls('project.delete')).toHaveLength(2);
    expect(state.values.get('sandpane.ui.selectedProject')).toBe('p1');
    made.session.dispose();
  });

  it('W1: delete step 2 connection closed and no re-read possible: the outcome stays UNKNOWN', async () => {
    const core = new ScriptedCore();
    core.hold = (f) => f.method === 'project.delete' && f.params['confirmToken'] !== undefined;
    core.refuseConnect = false;
    const { session } = await online(core);
    stub.answers.set('Delete project', 'Delete project');
    const pending = session.deleteProject(atlas);
    await settle();
    core.refuseConnect = true;
    core.drop();
    expect(await pending).toBe(false);
    await settle();
    expect(stub.errors.at(-1)).toContain('Outcome UNKNOWN');
    const text = session.snapshot().status?.text ?? '';
    expect(text).toBe('The project list could not be re-read after the unknown outcome; whether the project was deleted is UNKNOWN.');
    expect(text).not.toMatch(/not deleted/);
    session.dispose();
  });

  it('Info: delete step 2 NOT_FOUND (deleted elsewhere) forgets the project like deleted:true', async () => {
    const core = new ScriptedCore();
    core.forced.set('project.delete', { code: 'NOT_FOUND', message: 'project not found' });
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    state.values.set('sandpane.ui.conversation', { id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', sandboxName: null });
    const { session } = await online(core, state);
    stub.answers.set('Delete project', 'Delete project');
    expect(await session.deleteProject(atlas)).toBe(false);
    expect(stub.errors.at(-1)).toContain('Core has no such project (it may have been deleted); nothing was changed.');
    expect(state.values.has('sandpane.ui.selectedProject')).toBe(false);
    expect(state.values.has('sandpane.ui.conversation')).toBe(false);
    expect(session.snapshot().conversation).toBeNull();
    expect(core.calls('project.delete')).toHaveLength(2);
    session.dispose();
  });

  it('delete step 2 INTERNAL after Core did delete: the re-read settles it and client state is dropped, no retry', async () => {
    const core = new ScriptedCore();
    core.forced.set('project.delete', { code: 'INTERNAL', message: 'database is locked' });
    core.deleteBeforeForcedError = true;
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    state.values.set('sandpane.ui.conversation', { id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', sandboxName: null });
    const { session } = await online(core, state);
    stub.answers.set('Delete project', 'Delete project');
    expect(await session.deleteProject(atlas)).toBe(false);
    expect(stub.errors.at(-1)).toContain('Outcome UNKNOWN');
    expect(stub.errors.at(-1)).not.toMatch(/nothing was deleted/i);
    expect(core.calls('project.delete')).toHaveLength(2);
    const snap = session.snapshot();
    expect(snap.status?.text).toBe('Core no longer lists the project after the unknown outcome — the delete took effect.');
    expect(state.values.has('sandpane.ui.selectedProject')).toBe(false);
    expect(state.values.has('sandpane.ui.conversation')).toBe(false);
    expect(snap.conversation).toBeNull();
    expect(snap.header.project).not.toMatch(/Atlas Demo/);
    session.dispose();
  });

  it('archiving the selected project while archived ones are hidden deselects it (never a stale unlabeled header)', async () => {
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    const { session } = await online(new ScriptedCore(), state);
    expect(session.snapshot().header.project).toBe('Atlas Demo');
    await session.archiveProject(atlas);
    const snap = session.snapshot();
    expect(snap.header.project).not.toMatch(/^Atlas Demo$/);
    expect(state.values.has('sandpane.ui.selectedProject')).toBe(false);
    expect(snap.status?.text).toContain('It is hidden from lists and was deselected');
    session.dispose();
  });

  it('archiving the selected project while archived ones are shown keeps it selected, labeled ARCHIVED', async () => {
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    const { session } = await online(new ScriptedCore(), state);
    await session.toggleShowArchived();
    await session.archiveProject(atlas);
    expect(session.snapshot().header.project).toBe('Atlas Demo · ARCHIVED');
    session.dispose();
  });

  it('refuseIfArchived (the command pre-check): archived → refusal with Core\'s reason, nothing sent; live → false', async () => {
    const { core, session } = await online();
    const before = core.requests.length;
    expect(session.refuseIfArchived(atlas, 'Rename project')).toBe(false);
    expect(session.refuseIfArchived(archivedAtlas, 'Rename project')).toBe(true);
    expect(stub.warnings.at(-1)).toBe(
      'Rename project is not available: Core refuses changes to an archived project ("project is archived; unarchive it first; nothing was changed"). Unarchive it first. Nothing was sent.',
    );
    expect(core.requests.length).toBe(before);
    session.dispose();
  });

  it('a project mutation with no answer is UNKNOWN and re-reads, never "nothing was changed"', async () => {
    const core = new ScriptedCore();
    core.forced.set('project.archive', { code: 'INTERNAL', message: 'disk I/O error' });
    const { session } = await online(core);
    const lists = core.calls('project.list').length;
    await session.archiveProject(atlas);
    await settle();
    expect(stub.errors.at(-1)).toContain('Outcome UNKNOWN');
    expect(stub.errors.at(-1)).not.toMatch(/nothing was changed/i);
    expect(core.calls('project.list').length).toBeGreaterThan(lists);
    session.dispose();
  });

  it('sandbox.create refused because the repository was unregistered mid-create gets plain copy', async () => {
    const core = new ScriptedCore();
    core.features = undefined;
    core.forced.set('sandbox.create', {
      code: 'CONFLICT',
      message: 'the repository was unregistered from this project while the sandbox was being prepared; nothing was run',
    });
    const { session } = await online(core);
    await session.createSandbox({ name: 'atlas-new', projectId: 'p1', workspaceMode: 'mountless' });
    expect(stub.errors.at(-1)).toContain(
      'The repository was unregistered from the project while the sandbox was being prepared; nothing was run.',
    );
    session.dispose();
  });
});

describe('A3b conversation lifecycle', () => {
  const ARCHIVED_MSG = 'conversation is archived; unarchive it first; nothing was changed';
  const PROJECT_ARCHIVED_MSG = 'project is archived; unarchive it first; nothing was changed';

  /** Online session scoped to p1; `c1` optionally selected (sandbox scope: none). */
  async function online(core = new ScriptedCore(), state = new MemoryState(), opts: { selectC1?: boolean } = {}) {
    if (!state.values.has('sandpane.ui.selectedProject')) state.values.set('sandpane.ui.selectedProject', 'p1');
    if (opts.selectC1) {
      state.values.set('sandpane.ui.conversation', { id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', sandboxName: null });
    }
    const made = makeSession(core, state);
    const logged: string[] = [];
    made.session.setOutputChannel({ appendLine: (line: string) => logged.push(line) } as unknown as vscode.OutputChannel);
    await made.session.attach();
    await settle();
    return { core, logged, ...made };
  }
  const row = (session: SandpaneSession, id: string) => session.snapshot().conversations.rows.find((r) => r.id === id);
  const archivedRow = (id: string, title: string): Record<string, unknown> => ({
    id, projectId: 'p1', title, agentId: 'codex', createdAt: '', archivedAt: '2026-10-11T10:00:00Z',
  });
  const A3B_FRAMES = ['conversation.rename', 'conversation.archive', 'conversation.unarchive', 'conversation.delete', 'conversation.export'];

  it('every action is refused visibly — no frame — when this Core does not advertise it', async () => {
    const core = new ScriptedCore();
    core.methods = PRE_A3B_METHODS;
    const { session } = await online(core);
    await session.renameConversation('c1');
    await session.archiveConversation('c1');
    await session.unarchiveConversation('c1');
    await session.deleteConversation('c1');
    await session.exportConversation('c1');
    await session.toggleShowArchivedConversations();
    for (const m of A3B_FRAMES) expect(core.calls(m), m).toHaveLength(0);
    expect(stub.warnings.filter((w) => /not supported by the attached Sandpane Core/.test(w))).toHaveLength(6);
    expect(stub.inputCalls).toHaveLength(0);
    expect(stub.saveCalls).toHaveLength(0);
    expect(core.calls('conversation.list').every((f) => !('includeArchived' in f.params))).toBe(true);
    const r = row(session, 'c1');
    for (const action of ['rename', 'archive', 'export', 'delete'] as const) {
      expect(r?.actions[action].enabled, action).toBe(false);
      expect(r?.actions[action].reason, action).toMatch(/not supported by the attached Sandpane Core/);
    }
    expect(session.snapshot().conversations.showArchivedSupported).toBe(false);
    session.dispose();
  });

  it('"show archived" sends includeArchived:true only when on (and advertised), persists as a UI preference, labels archived rows', async () => {
    const core = new ScriptedCore();
    core.conversations.set('c2', archivedRow('c2', 'Old'));
    const { session, state } = await online(core);
    expect(session.snapshot().conversations.rows.map((r) => r.id)).toEqual(['c1']);
    expect(core.calls('conversation.list').every((f) => !('includeArchived' in f.params))).toBe(true);

    await session.toggleShowArchivedConversations();
    expect(core.calls('conversation.list').at(-1)?.params).toEqual({ projectId: 'p1', includeArchived: true });
    expect(state.values.get('sandpane.ui.showArchivedConversations')).toBe(true);
    const old = row(session, 'c2');
    expect(old?.archived).toBe(true);
    expect(old?.statusNote).toContain('ARCHIVED');
    expect(old?.actions.rename).toEqual({ enabled: false, reason: expect.stringContaining(ARCHIVED_MSG) as unknown });
    expect(old?.actions.unarchive.enabled).toBe(true);
    expect(row(session, 'c1')?.archived).toBe(false);

    await session.toggleShowArchivedConversations();
    expect(core.calls('conversation.list').at(-1)?.params).toEqual({ projectId: 'p1' });
    expect(session.snapshot().conversations.rows.map((r) => r.id)).toEqual(['c1']);
    session.dispose();
  });

  it('without conversation.archive advertised, "show archived" is refused and includeArchived is never sent', async () => {
    const core = new ScriptedCore();
    core.methods = ALL_METHODS.filter((m) => m !== 'conversation.archive');
    const { session } = await online(core);
    await session.toggleShowArchivedConversations();
    expect(session.snapshot().conversations.showArchived).toBe(false);
    expect(core.calls('conversation.list').every((f) => !('includeArchived' in f.params))).toBe(true);
    expect(stub.warnings.at(-1)).toMatch(/"conversation\.archive"/);
    session.dispose();
  });

  it('rename: native input box with Core\'s validator, exact frame, then conversation.list is re-read', async () => {
    const { core, session } = await online();
    stub.inputs.push('Auth v2');
    const before = core.calls('conversation.list').length;
    await session.renameConversation('c1');
    const call = stub.inputCalls[0];
    expect(call?.value).toBe('Auth');
    expect(call?.validateInput?.('   ')).toMatch(/whitespace-only/);
    expect(call?.validateInput?.('a\nb')).toMatch(/Core would refuse this title/);
    expect(call?.validateInput?.('Auth v2')).toBeUndefined();
    expect(core.calls('conversation.rename').map((f) => f.params)).toEqual([{ conversationId: 'c1', title: 'Auth v2' }]);
    expect(core.calls('conversation.list').length).toBeGreaterThan(before);
    expect(row(session, 'c1')?.title).toBe('Auth v2');
    expect(session.snapshot().status?.text).toBe('Conversation renamed to "Auth v2" in Core.');
    session.dispose();
  });

  it('rename cancelled or unchanged sends nothing; a stored title Core would refuse is not prefilled', async () => {
    const core = new ScriptedCore();
    (core.conversations.get('c1') as Record<string, unknown>)['title'] = 'Auth\tlegacy';
    const { session } = await online(core);
    stub.inputs.push(undefined);
    await session.renameConversation('c1');
    expect(stub.inputCalls[0]?.value).toBe('');
    stub.inputs.push('Auth\tlegacy');
    await session.renameConversation('c1');
    expect(core.calls('conversation.rename')).toHaveLength(0);
    expect(session.snapshot().status?.text).toMatch(/nothing was sent/);
    session.dispose();
  });

  it('an archived conversation: send and rename are disabled with Core\'s reason; nothing is sent; history stays shown', async () => {
    const core = new ScriptedCore();
    (core.conversations.get('c1') as Record<string, unknown>)['archivedAt'] = '2026-10-11T10:00:00Z';
    const state = new MemoryState();
    state.values.set('sandpane.ui.showArchivedConversations', true);
    const { session } = await online(core, state, { selectC1: true });
    const snap = session.snapshot();
    expect(snap.conversation).toMatchObject({ id: 'c1', archived: true });
    expect(snap.composerBlocked).toContain(ARCHIVED_MSG);
    expect(snap.lines.map((l) => l.text)).toEqual(['from p1']);
    await session.renameConversation('c1');
    expect(stub.inputCalls).toHaveLength(0);
    expect(stub.warnings.at(-1)).toContain(ARCHIVED_MSG);
    const plan = session.previewContext(false);
    await session.send('hello', false, plan.planId);
    expect(core.calls('conversation.send')).toHaveLength(0);
    expect(core.calls('conversation.create')).toHaveLength(0);
    expect(session.snapshot().status?.text).toContain(ARCHIVED_MSG);
    for (const m of ['conversation.rename']) expect(core.calls(m)).toHaveLength(0);
    session.dispose();
  });

  it('archived project AND archived conversation: the PROJECT reason comes first; unarchive is refused locally', async () => {
    const core = new ScriptedCore();
    core.archived.add('p1');
    (core.conversations.get('c1') as Record<string, unknown>)['archivedAt'] = '2026-10-11T10:00:00Z';
    const state = new MemoryState();
    state.values.set('sandpane.ui.showArchivedProjects', true);
    state.values.set('sandpane.ui.showArchivedConversations', true);
    const { session } = await online(core, state, { selectC1: true });
    expect(session.snapshot().composerBlocked).toContain(PROJECT_ARCHIVED_MSG);
    expect(session.snapshot().composerBlocked).not.toContain(ARCHIVED_MSG);
    await session.renameConversation('c1');
    expect(stub.warnings.at(-1)).toContain(PROJECT_ARCHIVED_MSG);
    await session.unarchiveConversation('c1');
    expect(stub.warnings.at(-1)).toContain(PROJECT_ARCHIVED_MSG);
    expect(row(session, 'c1')?.actions.unarchive).toEqual({ enabled: false, reason: expect.stringContaining(PROJECT_ARCHIVED_MSG) as unknown });
    // Archive and delete stay allowed in an archived project.
    expect(row(session, 'c1')?.actions.delete.enabled).toBe(true);
    for (const m of ['conversation.rename', 'conversation.unarchive']) expect(core.calls(m), m).toHaveLength(0);
    session.dispose();
  });

  it('archiving the selected conversation while archived ones are hidden deselects it and clears the preference', async () => {
    const { core, session, state } = await online(new ScriptedCore(), new MemoryState(), { selectC1: true });
    expect(session.snapshot().conversation?.id).toBe('c1');
    await session.archiveConversation('c1');
    expect(core.calls('conversation.archive').map((f) => f.params)).toEqual([{ conversationId: 'c1' }]);
    expect(session.snapshot().conversation).toBeNull();
    expect(state.values.has('sandpane.ui.conversation')).toBe(false);
    expect(session.snapshot().status?.text).toMatch(/archived in Core.*hidden from the list/);
    session.dispose();
  });

  it('archiving while archived ones are shown keeps it selected, labeled; unarchive re-enables send', async () => {
    const state = new MemoryState();
    state.values.set('sandpane.ui.showArchivedConversations', true);
    const { core, session } = await online(new ScriptedCore(), state, { selectC1: true });
    await session.archiveConversation('c1');
    expect(session.snapshot().conversation).toMatchObject({ id: 'c1', archived: true });
    expect(session.snapshot().composerBlocked).toContain(ARCHIVED_MSG);
    await session.unarchiveConversation('c1');
    expect(core.calls('conversation.unarchive').map((f) => f.params)).toEqual([{ conversationId: 'c1' }]);
    expect(session.snapshot().conversation).toMatchObject({ id: 'c1', archived: false });
    expect(session.snapshot().composerBlocked).toBeNull();
    session.dispose();
  });

  it('a send Core refuses because the conversation was archived elsewhere gets honest copy and re-reads the list', async () => {
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedSandbox', 'atlas-box');
    state.values.set('sandpane.ui.conversation', { id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', sandboxName: 'atlas-box' });
    const { core, session } = await online(new ScriptedCore(), state);
    (core.conversations.get('c1') as Record<string, unknown>)['archivedAt'] = '2026-10-11T10:00:00Z';
    const lists = core.calls('conversation.list').length;
    const plan = session.previewContext(true);
    await session.send('edit it', true, plan.planId);
    await settle();
    expect(core.calls('conversation.send')).toHaveLength(1);
    expect(stub.errors.at(-1)).toContain('This conversation is archived. Unarchive it first; nothing was changed.');
    expect(stub.errors.at(-1)).not.toMatch(/conversation not found/);
    expect(core.calls('conversation.list').length).toBeGreaterThan(lists);
    session.dispose();
  });

  it('a new conversation\'s title is derived Core-valid from a multi-line first message (no \\n, cut by code point)', async () => {
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedSandbox', 'atlas-box');
    const { core, session } = await online(new ScriptedCore(), state);
    const text = `fix\nthe\tbug ${'a'.repeat(70)}${String.fromCodePoint(0x1f600)}tail`;
    const plan = session.previewContext(true);
    await session.send(text, true, plan.planId);
    await settle();
    const title = String(core.calls('conversation.create')[0]?.params['title']);
    expect(title).not.toMatch(/[\n\t]/);
    expect(Array.from(title).length).toBeLessThanOrEqual(80);
    expect(title.startsWith('fix the bug ')).toBe(true);
    expect(core.calls('conversation.send')).toHaveLength(1);
    session.dispose();
  });

  it('"sandbox chosen at creation" appears only when the feature is advertised; a missing sandbox is flagged', async () => {
    const core = new ScriptedCore();
    core.features = ['idempotency-keys', 'sandbox-create-agent', 'conversation-sandbox-id'];
    (core.conversations.get('c1') as Record<string, unknown>)['sandboxId'] = 'gone-box';
    core.conversations.set('c3', { id: 'c3', projectId: 'p1', title: 'Box', agentId: 'codex', createdAt: '', sandboxId: 'atlas-box' });
    core.conversations.set('c4', { id: 'c4', projectId: 'p1', title: 'None', agentId: 'codex', createdAt: '' });
    const { session } = await online(core);
    expect(row(session, 'c1')?.sandboxLabel).toBe('sandbox chosen at creation: gone-box (not in the current sandbox list)');
    expect(row(session, 'c3')?.sandboxLabel).toBe('sandbox chosen at creation: atlas-box');
    expect(row(session, 'c4')?.sandboxLabel).toBe('no sandbox recorded at creation');
    session.dispose();

    const noSbx = new ScriptedCore();
    noSbx.features = ['conversation-sandbox-id'];
    noSbx.sandboxListError = { code: 'NOT_INSTALLED', message: 'sbx CLI not found' };
    (noSbx.conversations.get('c1') as Record<string, unknown>)['sandboxId'] = 'atlas-box';
    const failed = await online(noSbx);
    expect(row(failed.session, 'c1')?.sandboxLabel).toBe('sandbox chosen at creation: atlas-box (the sandbox list could not be read)');
    failed.session.dispose();

    const older = new ScriptedCore();
    (older.conversations.get('c1') as Record<string, unknown>)['sandboxId'] = 'atlas-box';
    const second = await online(older);
    expect(row(second.session, 'c1')?.sandboxLabel).toBeNull();
    second.session.dispose();
  });

  it('selecting a conversation from the list: only ids Core listed; "" starts a new one', async () => {
    const { session, state } = await online();
    session.selectConversation('c1');
    expect(session.snapshot().conversation?.id).toBe('c1');
    expect(row(session, 'c1')?.selected).toBe(true);
    expect((state.values.get('sandpane.ui.conversation') as { id: string }).id).toBe('c1');
    session.selectConversation('c-unknown');
    expect(session.snapshot().conversation?.id).toBe('c1');
    expect(session.snapshot().status?.text).toMatch(/not listed by Core/);
    session.selectConversation('');
    expect(session.snapshot().conversation).toBeNull();
    expect(state.values.has('sandpane.ui.conversation')).toBe(false);
    session.dispose();
  });

  it('webview messages route to the actions; an unlisted id sends nothing', async () => {
    const { core, session } = await online();
    session.handleWebviewMessage({ type: 'conversationAction', action: 'archive', conversationId: 'c-unknown' });
    await settle();
    expect(core.calls('conversation.archive')).toHaveLength(0);
    session.handleWebviewMessage({ type: 'conversationAction', action: 'archive', conversationId: 'c1' });
    await settle();
    expect(core.calls('conversation.archive')).toHaveLength(1);
    session.handleWebviewMessage({ type: 'toggleArchivedConversations' });
    await settle();
    expect(session.snapshot().conversations.showArchived).toBe(true);
    session.dispose();
  });

  // --- delete (A1 two-step pattern) ---

  it('delete: step 1 {conversationId} → native modal; confirm sends step 2 with that token; client state and its tasks are dropped', async () => {
    const { core, session, state } = await online(new ScriptedCore(), new MemoryState(), { selectC1: true });
    expect(session.snapshot().tasks.map((t) => t.taskId)).toEqual(['task-a']);
    stub.answers.set('Delete conversation', 'Delete conversation');
    expect(await session.deleteConversation('c1')).toBe(true);
    expect(core.calls('conversation.delete').map((f) => f.params)).toEqual([
      { conversationId: 'c1' },
      { conversationId: 'c1', confirmToken: TOKEN },
    ]);
    const modal = stub.warningCalls.find((c) => c.items.includes('Delete conversation'));
    expect(modal?.options?.modal).toBe(true);
    expect(modal?.message).toBe('Delete conversation "Auth"?');
    expect(modal?.options?.detail).toContain('Conversation id: c1');
    expect(modal?.options?.detail).toContain('• 3 messages and 1 task are deleted');
    expect(modal?.options?.detail).not.toContain(TOKEN);
    await settle();
    const snap = session.snapshot();
    expect(snap.conversation).toBeNull();
    expect(state.values.has('sandpane.ui.conversation')).toBe(false);
    expect(snap.conversations.rows.map((r) => r.id)).toEqual([]);
    expect(snap.tasks.map((t) => t.taskId)).toEqual([]);
    expect(snap.status?.text).toMatch(/^Core deleted conversation "Auth" \(its Core records only/);
    session.dispose();
  });

  it('delete cancelled sends step 1 only; an expired confirmation at click time sends nothing more', async () => {
    const { core, session } = await online();
    expect(await session.deleteConversation('c1')).toBe(false);
    expect(core.calls('conversation.delete')).toHaveLength(1);
    expect(session.snapshot().status?.text).toMatch(/nothing was sent/);
    stub.answers.set('Delete conversation', 'Delete conversation');
    clock.after = { reads: clock.reads.length + 1, now: Date.parse('2026-10-10T12:02:00Z') };
    expect(await session.deleteConversation('c1')).toBe(false);
    expect(core.calls('conversation.delete').filter((f) => f.params['confirmToken'] !== undefined)).toHaveLength(0);
    expect(session.snapshot().status?.text).toBe('Confirmation expired — nothing was sent; run Delete Conversation again.');
    session.dispose();
  });

  it('an unreadable expiry fails closed at click time (nothing sent)', async () => {
    const core = new ScriptedCore();
    core.conversationConfirmation = { ...core.conversationConfirmation, expiresAt: 'soon' };
    const { session } = await online(core);
    stub.answers.set('Delete conversation', 'Delete conversation');
    expect(await session.deleteConversation('c1')).toBe(false);
    expect(core.calls('conversation.delete')).toHaveLength(1);
    session.dispose();
  });

  it.each([
    ['CONFLICT', 'conversation has tasks that are not finished; cancel or finish them first; nothing was deleted', 'The conversation has unfinished tasks. Cancel or finish them first; nothing was deleted.'],
    ['VALIDATION_FAILED', 'confirmation token is invalid, expired, already used, or not for this action and target; request a new confirmation', 'Core refused the confirmation (invalid, expired or already used). Nothing was deleted — run Delete Conversation again for a fresh confirmation.'],
  ])('delete step 2 %s "%s" → honest copy, no retry, selection kept', async (code, message, copy) => {
    const core = new ScriptedCore();
    core.forced.set('conversation.delete', { code, message });
    const { session, state } = await online(core, new MemoryState(), { selectC1: true });
    stub.answers.set('Delete conversation', 'Delete conversation');
    expect(await session.deleteConversation('c1')).toBe(false);
    expect(core.calls('conversation.delete')).toHaveLength(2);
    expect(stub.errors.at(-1)).toContain(copy);
    expect(stub.errors.at(-1)).toContain(`Core said: ${code}: ${message}`);
    expect(state.values.has('sandpane.ui.conversation')).toBe(true);
    session.dispose();
  });

  it('delete step 1 CONFLICT (unfinished tasks) → copy, no modal, nothing deleted', async () => {
    const core = new ScriptedCore();
    core.forced.set('conversation.delete.step1', { code: 'CONFLICT', message: 'conversation has tasks that are not finished; cancel or finish them first; nothing was deleted' });
    const { session } = await online(core);
    expect(await session.deleteConversation('c1')).toBe(false);
    expect(stub.warningCalls.some((c) => c.items.includes('Delete conversation'))).toBe(false);
    expect(stub.errors.at(-1)).toContain('The conversation has unfinished tasks. Cancel or finish them first; nothing was deleted.');
    session.dispose();
  });

  it('delete step 2 NOT_FOUND (deleted elsewhere) forgets the conversation like deleted:true', async () => {
    const core = new ScriptedCore();
    core.forced.set('conversation.delete', { code: 'NOT_FOUND', message: 'conversation not found' });
    core.deleteConversationBeforeForcedError = true;
    const { session, state } = await online(core, new MemoryState(), { selectC1: true });
    stub.answers.set('Delete conversation', 'Delete conversation');
    expect(await session.deleteConversation('c1')).toBe(false);
    expect(stub.errors.at(-1)).toContain('Core has no such conversation (it may have been deleted); nothing was changed.');
    expect(state.values.has('sandpane.ui.conversation')).toBe(false);
    expect(session.snapshot().conversation).toBeNull();
    session.dispose();
  });

  it('delete step 2 INTERNAL is UNKNOWN (never "nothing was deleted"); a project-scoped includeArchived re-read settles it', async () => {
    const core = new ScriptedCore();
    core.forced.set('conversation.delete', { code: 'INTERNAL', message: 'database is locked' });
    const { session, state } = await online(core, new MemoryState(), { selectC1: true });
    stub.answers.set('Delete conversation', 'Delete conversation');
    expect(await session.deleteConversation('c1')).toBe(false);
    const shown = stub.errors.at(-1) ?? '';
    expect(shown).toContain('Outcome UNKNOWN');
    expect(shown).not.toMatch(/nothing was deleted/i);
    expect(core.calls('conversation.list').some((f) => JSON.stringify(f.params) === JSON.stringify({ projectId: 'p1', limit: 500, includeArchived: true }))).toBe(true);
    expect(core.calls('conversation.delete')).toHaveLength(2);
    expect(session.snapshot().status?.text).toBe(
      'Core still lists the conversation as of this re-read — it was not deleted (Core answered the delete request, so that request has finished).',
    );
    expect(state.values.has('sandpane.ui.conversation')).toBe(true);
    session.dispose();
  });

  it('delete step 2 INTERNAL after Core did delete: the re-read settles it and client state is dropped, no retry', async () => {
    const core = new ScriptedCore();
    core.forced.set('conversation.delete', { code: 'INTERNAL', message: 'database is locked' });
    core.deleteConversationBeforeForcedError = true;
    const { session, state } = await online(core, new MemoryState(), { selectC1: true });
    stub.answers.set('Delete conversation', 'Delete conversation');
    expect(await session.deleteConversation('c1')).toBe(false);
    expect(core.calls('conversation.delete')).toHaveLength(2);
    expect(session.snapshot().status?.text).toBe('Core no longer lists this conversation; the outcome of this request was not confirmed.');
    expect(session.snapshot().status?.text).not.toMatch(/took effect/);
    expect(state.values.has('sandpane.ui.conversation')).toBe(false);
    expect(session.snapshot().conversation).toBeNull();
    session.dispose();
  });

  it('delete step 2 with no answer (timeout): "still lists as of this re-read", never "not deleted"', async () => {
    const core = new ScriptedCore();
    core.forced.set('conversation.delete', { code: 'INTERNAL', message: 'never delivered' });
    core.hold = (f) => f.method === 'conversation.delete' && f.params['confirmToken'] !== undefined;
    const { session, timers } = await online(core);
    stub.answers.set('Delete conversation', 'Delete conversation');
    const pending = session.deleteConversation('c1');
    await settle();
    const timer = timers.pending.find((t) => t.ms === 15_000);
    if (!timer) throw new Error('no pending 15 s timer');
    timers.clear(timer.id);
    timer.fn();
    expect(await pending).toBe(false);
    await settle();
    expect(stub.errors.at(-1)).toContain('Outcome UNKNOWN');
    const text = session.snapshot().status?.text ?? '';
    expect(text).toBe(
      'Core still lists the conversation as of this re-read. Core never answered the delete request, so it may still finish — re-read before acting; not retried.',
    );
    expect(core.calls('conversation.delete')).toHaveLength(2);
    session.dispose();
  });

  it('an unknown outcome whose re-read returns a FULL page without the id stays UNKNOWN (absence from a full page is no proof)', async () => {
    const core = new ScriptedCore();
    core.forced.set('conversation.delete', { code: 'INTERNAL', message: 'database is locked' });
    core.deleteConversationBeforeForcedError = true;
    for (let i = 0; i < 500; i += 1) {
      core.conversations.set(`f${i}`, { id: `f${i}`, projectId: 'p1', title: `F${i}`, agentId: 'codex', createdAt: '' });
    }
    const { session, state } = await online(core, new MemoryState(), { selectC1: true });
    stub.answers.set('Delete conversation', 'Delete conversation');
    expect(await session.deleteConversation('c1')).toBe(false);
    expect(session.snapshot().status?.text).toMatch(/full page.*UNKNOWN/);
    expect(state.values.has('sandpane.ui.conversation')).toBe(true);
    session.dispose();
  });

  it('Info 1: without conversation.archive the settle re-read is live-only — absence proves nothing, the conversation is NOT forgotten', async () => {
    const core = new ScriptedCore();
    core.methods = ALL_METHODS.filter((m) => m !== 'conversation.archive');
    core.forced.set('conversation.delete', { code: 'INTERNAL', message: 'database is locked' });
    // Core archived it (not deleted) — a live-only list cannot tell the difference.
    const { session, state } = await online(core, new MemoryState(), { selectC1: true });
    (core.conversations.get('c1') as Record<string, unknown>)['archivedAt'] = '2026-10-11T10:00:00Z';
    stub.answers.set('Delete conversation', 'Delete conversation');
    expect(await session.deleteConversation('c1')).toBe(false);
    const settleList = core.calls('conversation.list').find((f) => f.params['limit'] === 500);
    expect(settleList?.params).toEqual({ projectId: 'p1', limit: 500 });
    const text = session.snapshot().status?.text ?? '';
    expect(text).toMatch(/UNKNOWN/);
    expect(text).not.toMatch(/took effect|no longer lists/);
    expect(state.values.has('sandpane.ui.conversation')).toBe(true);
    expect(session.snapshot().conversation?.id).toBe('c1');
    session.dispose();
  });

  it('Info 2: delete and export are single-flight — a second request while one is in flight sends nothing', async () => {
    const core = new ScriptedCore();
    const { session } = await online(core);
    core.hold = (f) => f.method === 'conversation.delete' && f.params['confirmToken'] === undefined;
    const first = session.deleteConversation('c1');
    expect(await session.deleteConversation('c1')).toBe(false);
    expect(await session.exportConversation('c1')).toBe(false);
    session.handleWebviewMessage({ type: 'conversationAction', action: 'delete', conversationId: 'c1' });
    await settle();
    expect(core.calls('conversation.delete')).toHaveLength(1);
    expect(core.calls('conversation.export')).toHaveLength(0);
    expect(stub.warnings.filter((w) => /already in progress/.test(w)).length).toBeGreaterThanOrEqual(2);
    core.hold = null;
    core.release();
    expect(await first).toBe(false); // modal not confirmed
    // Once the first finished, the next one runs normally.
    stub.saveUri = undefined;
    expect(await session.exportConversation('c1')).toBe(false);
    expect(core.calls('conversation.export')).toHaveLength(1);
    session.dispose();
  });

  // --- export ---

  it('export: pages are collected, the native save dialog proposes <redacted-title>-export.json, the file is written ONLY to the chosen URI', async () => {
    const core = new ScriptedCore();
    const page = (seqs: number[], truncated: boolean, next: number, byKind: Record<string, number>) => ({
      format: 'sandpane.conversation-export.v1',
      exportedAt: '2026-10-11T12:00:00Z',
      conversation: { id: 'c1', projectId: 'p1', title: '[REDACTED:token] Auth', agentId: 'codex', createdAt: '' },
      messages: seqs.map((n) => ({ id: `m${n}`, conversationId: 'c1', role: 'user', content: `PRIVATE-BODY-${n}`, sequence: n })),
      truncated,
      nextSequence: next,
      redaction: { bestEffort: true, replacements: Object.values(byKind).reduce((a, b) => a + b, 0), byKind },
    });
    core.exportPages = [page([1, 2], true, 2, { token: 2 }), page([3], false, 3, { jwt: 1, token: 1 })];
    const { session, logged } = await online(core);
    stub.saveUri = Uri.file('/chosen/dir/my-export.json');
    expect(await session.exportConversation('c1')).toBe(true);
    expect(core.calls('conversation.export').map((f) => f.params)).toEqual([
      { conversationId: 'c1', afterSequence: 0 },
      { conversationId: 'c1', afterSequence: 2 },
    ]);
    const dialog = stub.saveCalls[0];
    expect(dialog?.defaultUri?.fsPath.endsWith('/REDACTED-token-Auth-export.json')).toBe(true);
    expect(dialog?.filters).toEqual({ JSON: ['json'] });
    expect(dialog?.title).toContain('Redaction is best-effort; review the export before sharing it.');
    expect(stub.fileWrites).toHaveLength(1);
    expect(stub.fileWrites[0]?.uri).toBe(stub.saveUri);
    const file = JSON.parse(new TextDecoder().decode(stub.fileWrites[0]?.bytes)) as Record<string, unknown>;
    expect(file['complete']).toBe(true);
    expect(file['redaction']).toEqual({ bestEffort: true, replacements: 4, byKind: { jwt: 1, token: 3 } });
    expect((file['messages'] as unknown[]).length).toBe(3);
    expect(file['note']).toBe('Redaction is best-effort; review before sharing. Task events, artifacts and verification output are not included.');
    const status = session.snapshot().status?.text ?? '';
    expect(status).toContain('4 redaction replacement(s)');
    expect(status).toContain('Redaction is best-effort; review the export before sharing it.');
    expect(status).toContain('/chosen/dir/my-export.json');
    // The export content is never logged.
    expect(logged.join('\n')).not.toContain('PRIVATE-BODY');
    session.dispose();
  });

  it('export: cancelling the save dialog writes nothing', async () => {
    const { core, session } = await online();
    stub.saveUri = undefined;
    expect(await session.exportConversation('c1')).toBe(false);
    expect(core.calls('conversation.export')).toHaveLength(1);
    expect(stub.saveCalls).toHaveLength(1);
    expect(stub.fileWrites).toHaveLength(0);
    expect(session.snapshot().status?.text).toMatch(/nothing was written/);
    session.dispose();
  });

  it('export: a page failure writes no file and never asks where to save', async () => {
    const core = new ScriptedCore();
    core.forced.set('conversation.export', { code: 'INTERNAL', message: 'redaction engine unavailable; nothing was exported (Core never exports unredacted text)' });
    const { session } = await online(core);
    stub.saveUri = Uri.file('/chosen/x.json');
    expect(await session.exportConversation('c1')).toBe(false);
    expect(stub.saveCalls).toHaveLength(0);
    expect(stub.fileWrites).toHaveLength(0);
    expect(stub.errors.at(-1)).toMatch(/No file was written/);
    session.dispose();
  });

  it('export: a cursor that does not advance is written as a disclosed PARTIAL export (complete:false)', async () => {
    const core = new ScriptedCore();
    const base = {
      format: 'sandpane.conversation-export.v1',
      exportedAt: '2026-10-11T12:00:00Z',
      conversation: { id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', createdAt: '' },
      redaction: { bestEffort: true, replacements: 0, byKind: {} },
    };
    core.exportPages = [
      { ...base, messages: [{ id: 'm1', conversationId: 'c1', role: 'user', content: 'x', sequence: 1 }], truncated: true, nextSequence: 1 },
      { ...base, messages: [], truncated: true, nextSequence: 1 },
    ];
    const { session } = await online(core);
    stub.saveUri = Uri.file('/chosen/partial.json');
    expect(await session.exportConversation('c1')).toBe(true);
    const file = JSON.parse(new TextDecoder().decode(stub.fileWrites[0]?.bytes)) as Record<string, unknown>;
    expect(file['complete']).toBe(false);
    expect(stub.saveCalls[0]?.title).toMatch(/PARTIAL/);
    expect(session.snapshot().status?.text).toMatch(/PARTIAL/);
    session.dispose();
  });

  it('export: a failed write is reported honestly', async () => {
    const { session } = await online();
    stub.saveUri = Uri.file('/read-only/x.json');
    stub.writeError = new Error('EACCES: permission denied');
    expect(await session.exportConversation('c1')).toBe(false);
    expect(stub.errors.at(-1)).toMatch(/could not be written/);
    expect(session.snapshot().status?.text).not.toMatch(/Redacted export written to/);
    session.dispose();
  });
});

describe('A4 conversation.send mode', () => {
  const MODE_FEATURES = ['idempotency-keys', 'sandbox-create-agent', 'conversation-sandbox-id', 'conversation-send-mode'];

  async function online(core = new ScriptedCore()) {
    const made = makeSession(core);
    await made.session.attach();
    await settle();
    return { core, ...made };
  }

  function modeCore(): ScriptedCore {
    const core = new ScriptedCore();
    core.features = [...MODE_FEATURES];
    return core;
  }

  async function sendWith(session: SandpaneSession, mode: 'task' | 'discuss', text = 'explain the auth flow') {
    session.selectSandbox('atlas-box');
    const plan = session.previewContext(false);
    stub.answers.set('Send anyway', 'Send anyway');
    await session.send(text, false, plan.planId, 'command', mode);
  }

  /** Fire the client deadline of the (held) request whose timeout is `ms`. */
  function expire(timers: FakeTimers, ms: number): void {
    const timer = timers.pending.find((t) => t.ms === ms);
    if (!timer) throw new Error(`no pending ${ms} ms timer`);
    timers.clear(timer.id);
    timer.fn();
  }

  it('advertised: Task sends NO mode key; Discuss sends "mode":"discuss"', async () => {
    const { core, session } = await online(modeCore());
    expect(session.snapshot().sendModeSupported).toBe(true);
    await sendWith(session, 'task');
    await sendWith(session, 'discuss');
    const frames = core.calls('conversation.send');
    expect(frames).toHaveLength(2);
    expect(Object.keys(frames[0]?.params ?? {})).not.toContain('mode');
    expect(frames[1]?.params['mode']).toBe('discuss');
    session.dispose();
  });

  it('not advertised: Task sends no mode key; Discuss is refused visibly and nothing is sent', async () => {
    const { core, session } = await online();
    expect(session.snapshot().sendModeSupported).toBe(false);
    await sendWith(session, 'task');
    expect(core.calls('conversation.send')).toHaveLength(1);
    expect(Object.keys(core.calls('conversation.send')[0]?.params ?? {})).not.toContain('mode');
    await sendWith(session, 'discuss');
    expect(core.calls('conversation.send')).toHaveLength(1);
    expect(session.snapshot().status?.tone).toBe('error');
    expect(session.snapshot().status?.text).toMatch(/^Not sent: .*does not advertise "conversation-send-mode"/);
    expect(session.snapshot().status?.text).toMatch(/record a discussion as a task/);
    session.dispose();
  });

  it('Discuss re-probes before sending: a Core that dropped the feature gets no frame (no conversation is created)', async () => {
    const core = modeCore();
    const { session } = await online(core);
    const probes = core.calls('system.probe').length;
    const creates = core.calls('conversation.create').length;
    // The cached probe still says "supported"; Core now is a pre-A4 build.
    core.features = ['idempotency-keys', 'sandbox-create-agent'];
    await sendWith(session, 'discuss');
    expect(core.calls('system.probe').length).toBeGreaterThan(probes);
    expect(core.calls('conversation.send')).toHaveLength(0);
    expect(core.calls('conversation.create')).toHaveLength(creates);
    expect(session.snapshot().status?.text).toMatch(/^Not sent: /);
    expect(session.snapshot().sendModeSupported).toBe(false);
    session.dispose();
  });

  it('Discuss with the writable intent is refused (a discussion never asks for a writable workspace)', async () => {
    const { core, session } = await online(modeCore());
    session.selectSandbox('atlas-box');
    const plan = session.previewContext(true);
    stub.answers.set('Send anyway', 'Send anyway');
    await session.send('do it', true, plan.planId, 'command', 'discuss');
    expect(core.calls('conversation.send')).toHaveLength(0);
    expect(session.snapshot().status?.text).toMatch(/^Not sent: Discuss .*writable/);
    session.dispose();
  });

  it('"Retry safely" resends the identical Discuss params, mode and key included', async () => {
    const core = modeCore();
    let first = true;
    core.hold = (f) => {
      if (f.method !== 'conversation.send' || !first) return false;
      first = false;
      return true;
    };
    const { session, timers } = await online(core);
    stub.answers.set('Retry safely', 'Retry safely');
    const sending = sendWith(session, 'discuss');
    await settle();
    expire(timers, 15_000);
    await sending;
    await settle(30);
    const frames = core.calls('conversation.send');
    expect(frames).toHaveLength(2);
    expect(frames[1]?.params).toEqual(frames[0]?.params);
    expect(frames[1]?.params['mode']).toBe('discuss');
    expect(frames[1]?.params['idempotencyKey']).toMatch(/^[0-9a-f]{32}$/);
    session.dispose();
  });

  it('"Retry safely" of a Discuss send is refused when the re-probed Core no longer advertises send mode', async () => {
    const core = modeCore();
    let first = true;
    core.hold = (f) => {
      if (f.method !== 'conversation.send' || !first) return false;
      first = false;
      return true;
    };
    stub.manual.add('Retry safely');
    const { session, timers } = await online(core);
    const sending = sendWith(session, 'discuss');
    await settle();
    expire(timers, 15_000);
    await sending;
    await settle();
    // Core restarts as an A2-A3b build: keys yes, send mode no.
    core.features = ['idempotency-keys', 'sandbox-create-agent'];
    stub.clicks.shift()?.('Retry safely');
    await settle(30);
    expect(core.calls('conversation.send')).toHaveLength(1);
    expect(stub.errors.at(-1)).toMatch(/^Not retried: the connected Core does not advertise "conversation-send-mode"/);
    expect(stub.errors.at(-1)).toMatch(/Nothing was sent/);
    // "Retry safely" is withdrawn: the refusal offers no button, and nothing is pending.
    expect(stub.errorCalls.at(-1)?.items).toEqual([]);
    expect(stub.clicks).toHaveLength(0);
    session.dispose();
  });

  it("Core's VALIDATION_FAILED mode refusal is shown with honest copy", async () => {
    const core = modeCore();
    core.forced.set('conversation.send', { code: 'VALIDATION_FAILED', message: 'mode must be "task" or "discuss"' });
    const { session } = await online(core);
    await sendWith(session, 'discuss');
    expect(stub.errors.at(-1)).toContain('Core refused the send mode');
    expect(stub.errors.at(-1)).toContain('Core said: VALIDATION_FAILED: mode must be "task" or "discuss"');
    session.dispose();
  });

  it('task rows carry the send mode (open string) and the chat-chosen name, revealed and capped', async () => {
    const core = modeCore();
    core.taskChosenNames = true;
    core.taskMode = `plan\u202E${'x'.repeat(300)}`;
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    const { session } = makeSession(core, state);
    await session.attach();
    await settle();
    const row = session.snapshot().tasks.find((t) => t.taskId === 'task-a');
    expect(row?.mode).toMatch(/^plan/);
    expect(row?.mode).not.toContain('\u202E');
    expect(row?.mode).toMatch(/\u2026 \(truncated\)$/);
    expect((row?.mode ?? '').length).toBeLessThanOrEqual(64 + '\u2026 (truncated)'.length);
    expect(row?.chosenSandboxName).toBe('atlas-box');
    session.dispose();
  });

  it('a task with ONLY chosenSandboxName leaves the stop copy at "cannot be checked" (never a count)', async () => {
    const core = modeCore();
    core.taskChosenNames = true;
    const { session } = await online(core);
    await session.stopSandbox('atlas-box');
    expect(core.calls('task.list').length).toBeGreaterThan(0);
    const call = stub.warningCalls.find((c) => c.items.includes('Stop sandbox'));
    expect(call?.message).toBe('Stop sandbox "atlas-box"?');
    expect(call?.options?.detail).toContain(
      'Active tasks in this sandbox cannot be checked: Core does not yet record which sandbox a task uses.',
    );
    expect(call?.options?.detail).not.toMatch(/active task\(s\) (use it|recorded by Core run)/);
    session.dispose();
  });

  it('I1: a reconnect to a pre-A4 Core between the re-probe and the send refuses the Discuss send (never downgraded)', async () => {
    const core = modeCore();
    const { session } = await online(core);
    core.hold = (f) => f.method === 'conversation.create';
    const sending = sendWith(session, 'discuss');
    await settle();
    expect(core.calls('conversation.create')).toHaveLength(1);
    // While the create is in flight, the client re-probes a Core without the feature.
    core.features = ['idempotency-keys', 'sandbox-create-agent'];
    core.hold = null;
    await session.refresh();
    expect(session.snapshot().sendModeSupported).toBe(false);
    core.release();
    await sending;
    await settle();
    expect(core.calls('conversation.send')).toHaveLength(0);
    expect(session.snapshot().status?.tone).toBe('error');
    expect(session.snapshot().status?.text).toMatch(/^Not sent: .*does not advertise "conversation-send-mode"/);
    session.dispose();
  });

  it('I4: a non-string TaskSummary.mode is shown as unreadable, never echoed', async () => {
    const core = modeCore();
    core.taskChosenNames = true;
    core.taskMode = 7;
    const state = new MemoryState();
    state.values.set('sandpane.ui.selectedProject', 'p1');
    const { session } = makeSession(core, state);
    await session.attach();
    await settle();
    const row = session.snapshot().tasks.find((t) => t.taskId === 'task-a');
    expect(row?.mode).toBe('(unreadable value from Core \u2014 not shown)');
    expect(row?.mode).not.toContain('7');
    session.dispose();
  });

  it("sandbox.remove step 1 shows Core's 'could not be read' A4 impact variant", async () => {
    const core = modeCore();
    const line =
      'the number of unfinished tasks sent from chats that chose this sandbox name could not be read; removing it does not cancel them';
    core.confirmation = { ...core.confirmation, impact: ['removes sandbox atlas-box', line] };
    const { session } = await online(core);
    expect(await session.removeSandbox('atlas-box')).toBe(false);
    const call = stub.warningCalls.find((c) => c.items.includes('Remove sandbox'));
    expect(call?.options?.detail).toContain(`\u2022 ${line}`);
    session.dispose();
  });

  it("sandbox.remove step 1 shows Core's A4 impact line about chat-chosen names", async () => {
    const core = modeCore();
    const line =
      '2 unfinished task(s) were sent from chats that chose this sandbox name; removing it does not cancel them';
    core.confirmation = { ...core.confirmation, impact: ['removes sandbox atlas-box', line] };
    const { session } = await online(core);
    expect(await session.removeSandbox('atlas-box')).toBe(false);
    const call = stub.warningCalls.find((c) => c.items.includes('Remove sandbox'));
    expect(call?.options?.detail).toContain(`\u2022 ${line}`);
    session.dispose();
  });
});

describe('A5 git.diff: per-file patch view', () => {
  async function online(core = new ScriptedCore()) {
    const made = makeSession(core);
    const logged: string[] = [];
    made.session.setOutputChannel({ appendLine: (line: string) => logged.push(line) } as unknown as vscode.OutputChannel);
    await made.session.attach();
    await settle();
    return { core, logged, ...made };
  }

  /** Fire the client deadline of the (held) request whose timeout is `ms`. */
  function expire(timers: FakeTimers, ms: number): void {
    const timer = timers.pending.find((t) => t.ms === ms);
    if (!timer) throw new Error(`no pending ${ms} ms timer`);
    timers.clear(timer.id);
    timer.fn();
  }

  it('not advertised: refused visibly \u2014 no git.review / git.diff frame, no picker', async () => {
    const core = new ScriptedCore();
    core.methods = PRE_A5_METHODS;
    const { session } = await online(core);
    stub.pickIndex = 0;
    expect(await session.showTaskPatch('task-a')).toBe(false);
    expect(core.calls('git.review')).toHaveLength(0);
    expect(core.calls('git.diff')).toHaveLength(0);
    expect(stub.quickPickCalls).toHaveLength(0);
    expect(stub.warnings.at(-1)).toMatch(/"git\.diff"/);
    expect(session.snapshot().gitDiffSupported).toBe(false);
    session.dispose();
  });

  it('advertised: review \u2192 pick one entry \u2192 git.diff {taskId, path, status} exact \u2192 read-only sandpane-diff document, nothing written', async () => {
    const { core, session, logged } = await online();
    expect(session.snapshot().gitDiffSupported).toBe(true);
    stub.pickIndex = 0;
    expect(await session.showTaskPatch('task-a')).toBe(true);
    expect(core.calls('git.review')).toHaveLength(1);
    expect(core.calls('git.diff').map((f) => f.params)).toEqual([{ taskId: 'task-a', path: 'src/a#b?.ts', status: 'modified' }]);
    expect(stub.quickPickCalls[0]?.items.map((i) => i.label)).toEqual(['src/a#b?.ts', 'notes #1.txt']);
    const opened = stub.openedDocuments[0];
    expect(opened?.uri.scheme).toBe('sandpane-diff');
    expect(stub.shownDocuments).toHaveLength(1);
    const text = session.patchDocuments.provideTextDocumentContent(opened!.uri);
    expect(text).toContain('path: src/a#b?.ts');
    expect(text).toContain('+new');
    // Display only: no file write, no apply, no command that touches the repo.
    expect(stub.fileWrites).toHaveLength(0);
    expect(core.calls('git.apply')).toHaveLength(0);
    expect(stub.commands.map((c) => c.command)).not.toContain('vscode.diff');
    // Patch content is never logged.
    expect(logged.join('\n')).not.toContain(core.diffSecret);
    session.dispose();
  });

  it('a path with tab, newline and quotes listed twice: the picked entry travels byte-exact with its own status; labels are revealed', async () => {
    const core = new ScriptedCore();
    const path = 'dir/a\tb\n"c" \u00e9.txt';
    core.reviewChanges = [
      { path, status: 'deleted' },
      { path, status: 'untracked' },
    ];
    const { session } = await online(core);
    stub.pickIndex = 1;
    expect(await session.showTaskPatch('task-a')).toBe(true);
    expect(core.calls('git.diff')[0]?.params).toEqual({ taskId: 'task-a', path, status: 'untracked' });
    const labels = stub.quickPickCalls[0]?.items.map((i) => i.label) ?? [];
    for (const label of labels) expect(label).not.toMatch(/[\n\t]/);
    expect(labels[0]).toContain('dir/a\\tb\\n"c"');
    session.dispose();
  });

  it('renames are listed as old \u2192 new; dismissing the picker sends no git.diff', async () => {
    const core = new ScriptedCore();
    core.reviewChanges = [{ path: 'new.ts', status: 'renamed', oldPath: 'old.ts' }];
    const { session } = await online(core);
    expect(await session.showTaskPatch('task-a')).toBe(false);
    expect(stub.quickPickCalls[0]?.items[0]?.label).toBe('old.ts \u2192 new.ts');
    expect(core.calls('git.diff')).toHaveLength(0);
    session.dispose();
  });

  it('flags are disclosed in the document; binary is never called "no changes"', async () => {
    const core = new ScriptedCore();
    core.diffAnswer = { path: 'src/a#b?.ts', status: 'modified', patch: '', binary: true, truncated: true, lossy: true };
    const { session } = await online(core);
    stub.pickIndex = 0;
    await session.showTaskPatch('task-a');
    const text = session.patchDocuments.provideTextDocumentContent(stub.openedDocuments[0]!.uri);
    expect(text).toContain('treated as binary (possibly by repository attributes)');
    expect(text).toContain('diff truncated at 262144 bytes');
    expect(text).toContain('not valid UTF-8');
    expect(text).not.toMatch(/no changes/i);
    session.dispose();
  });

  it("Core's exact refusals get honest copy (path no longer listed; no Git context on review)", async () => {
    const core = new ScriptedCore();
    core.forced.set('git.diff', { code: 'VALIDATION_FAILED', message: "path is not in this task's change list; nothing was read" });
    const { session } = await online(core);
    stub.pickIndex = 0;
    expect(await session.showTaskPatch('task-a')).toBe(false);
    expect(stub.errors.at(-1)).toMatch(/no longer in the task's change list/);
    expect(stub.openedDocuments).toHaveLength(0);

    core.forced.set('git.review', { code: 'VALIDATION_FAILED', message: 'task has no Git context (repo binding + base_commit)' });
    expect(await session.showTaskPatch('task-a')).toBe(false);
    expect(stub.errors.at(-1)).toMatch(/no Git context/);
    expect(core.calls('git.diff')).toHaveLength(1);
    session.dispose();
  });

  it('a git.diff timeout (45 s) says Core did not answer and that nothing was changed', async () => {
    const core = new ScriptedCore();
    core.hold = (f) => f.method === 'git.diff';
    const { session, timers } = await online(core);
    stub.pickIndex = 0;
    const pending = session.showTaskPatch('task-a');
    await settle();
    expire(timers, 45_000);
    expect(await pending).toBe(false);
    expect(stub.errors.at(-1)).toContain('Core did not answer in time \u2014 no file was changed (git.diff is read-only).');
    // The whole notification never claims Core state or an unknown outcome.
    expect(stub.errors.at(-1)).not.toMatch(/UNKNOWN|may still (finish|run)|was (applied|changed) by Core/i);
    session.dispose();
  });

  it('a malformed git.diff answer opens nothing and is not echoed', async () => {
    const core = new ScriptedCore();
    core.diffAnswer = { path: 'src/a#b?.ts', status: 'modified', patch: 5, secret: 'ECHO-ME' };
    const { session, logged } = await online(core);
    stub.pickIndex = 0;
    expect(await session.showTaskPatch('task-a')).toBe(false);
    expect(stub.openedDocuments).toHaveLength(0);
    expect(stub.errors.at(-1)).toMatch(/not in the expected shape/);
    expect([...stub.errors, ...logged].join('\n')).not.toContain('ECHO-ME');
    session.dispose();
  });

  it('the webview Diff button reaches the same gated flow', async () => {
    const { core, session } = await online();
    stub.pickIndex = 0;
    session.handleWebviewMessage({ type: 'showTaskPatch', taskId: 'task-a' });
    await settle(20);
    expect(core.calls('git.diff')).toHaveLength(1);
    session.dispose();
  });

  it('apply listing reveals exact paths and discloses uninspected paths (never "complete")', async () => {
    const core = new ScriptedCore();
    core.reviewChanges = [{ path: 'evil\nline.txt', status: 'added' }];
    core.reviewExtra = { repoPath: '/repo/atlas', uninspected: ['sub'] };
    const { session } = await online(core);
    await session.applyTask('task-a');
    const call = stub.warningCalls.find((c) => c.items.includes('Apply via Core'));
    expect(call?.message).toContain('evil\\nline.txt');
    expect(call?.message).not.toContain('evil\nline.txt');
    expect(call?.message).toContain('1 paths were not inspected');
    expect(call?.message).toContain('repository (from Core): /repo/atlas');
    session.dispose();
  });
});

describe('A5 review uses Core\'s repoPath and exact paths', () => {
  it("prefers the open folder that IS Core's repoPath, and the URIs keep a real tab/newline byte-exact", async () => {
    const core = new ScriptedCore();
    const path = 'dir/new\nline\t.ts';
    core.reviewChanges = [{ path, status: 'modified' }];
    core.reviewExtra = { repoPath: '/repo/nova' };
    const { session } = makeSession(core);
    stub.workspaceFolders = [
      { uri: Uri.file('/repo/atlas'), name: 'atlas' },
      { uri: Uri.file('/repo/nova'), name: 'nova' },
    ];
    stub.answers.set('Yes, use this folder', 'Yes, use this folder');
    await session.attach();
    await settle();
    await session.reviewChanges('task-a');
    expect(stub.infos.at(-1)).toContain('/repo/nova\n');
    expect(stub.infos.at(-1)).toContain("the task's repository as reported by Core");
    expect(stub.infos.at(-1)).not.toMatch(/pre-A5/);
    const diff = stub.commands.find((c) => c.command === 'vscode.diff');
    const [left, right, title] = diff?.args as [StubUri, StubUri, string];
    expect(left.path).toBe(`/repo/nova/${path}`);
    expect(right.path).toBe(`/repo/nova/${path}`);
    expect(title).not.toMatch(/[\n\t]/);
    expect(session.snapshot().status?.text).toContain('repository (from Core): /repo/nova');
    session.dispose();
  });
});
