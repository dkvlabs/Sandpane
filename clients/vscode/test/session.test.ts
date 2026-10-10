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

/** `Method::ALL` order — what an A3a Core advertises (22 methods). */
const ALL_METHODS = [
  'system.probe', 'project.create', 'project.list',
  'project.update', 'project.archive', 'project.unarchive', 'project.delete',
  'project.add_repository', 'project.remove_repository',
  'sandbox.list', 'sandbox.create',
  'sandbox.stop', 'sandbox.remove',
  'conversation.create', 'conversation.send', 'conversation.list', 'conversation.history',
  'task.cancel', 'task.list', 'task.subscribe', 'git.review', 'git.apply',
];

/** A pre-A3a Core: the 16 methods before the project lifecycle. */
const PRE_A3A_METHODS = ALL_METHODS.filter((m) => !/^project\.(update|archive|unarchive|delete|add_repository|remove_repository)$/.test(m));

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
  /** Future-Core shape: task.list rows carry `sandboxName`. Today's Core never sets it. */
  taskSandboxNames = false;
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
            .map(([id, project]) => ({
              id,
              conversationId: project === 'p1' ? 'c1' : 'c2',
              status: 'queued',
              // Real Core never fills sandboxName (tasks.sandbox_binding_id is
              // never written); `taskSandboxNames` simulates a future Core.
              ...(this.taskSandboxNames ? { sandboxName: project === 'p1' ? 'atlas-box' : 'nova-live' } : {}),
            })),
        };
      case 'conversation.list':
        return { ok: p['projectId'] === 'p1' ? [{ id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', createdAt: '' }] : [] };
      case 'task.subscribe': {
        const project = p['projectId'];
        const taskId = p['taskId'];
        const cursors = (p['afterSequences'] ?? {}) as Record<string, number>;
        const out = [...this.events.entries()]
          .filter(([id]) => this.taskProject.get(id) === project && (taskId === undefined || taskId === id))
          .flatMap(([id, list]) =>
            list.filter((e) => e.sequence > (taskId ? Number(p['afterSequence']) : (cursors[id] ?? Number(p['afterSequence'])))),
          );
        return { ok: out };
      }
      case 'conversation.create':
        this.convCounter += 1;
        return { ok: { id: `conv-new-${this.convCounter}`, projectId: p['projectId'], title: 't', agentId: 'codex', createdAt: '' } };
      case 'conversation.send': {
        const stored = this.replayFor(frame);
        if (stored) return stored;
        const forced = this.takeForced(frame.method);
        if (forced) return forced;
        return this.remember(frame, { id: `task-new-${this.requests.length}`, conversationId: p['conversationId'], status: 'queued' });
      }
      case 'git.review':
        return {
          ok: {
            taskId: p['taskId'],
            baseCommit: 'b71995fc1e0f4a3c8f0d7b1a2e3c4d5e6f708192',
            hostDirty: false,
            changes: [
              { path: 'src/a#b?.ts', status: 'modified' },
              { path: 'notes #1.txt', status: 'untracked' },
            ],
          },
        };
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
