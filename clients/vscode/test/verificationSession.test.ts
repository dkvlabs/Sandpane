/**
 * A7 session wiring against a scripted Core (the unit under test is the
 * session and its gesture handlers, not Core) and the recording `vscode` stub.
 *
 *  - gating: the UI is enabled only when `verification` is advertised; an A6
 *    Core gets a visibly unsupported Verification and no A7 frame at all;
 *  - gesture-only: the command handlers IGNORE every argument (argv,
 *    commandId, runId smuggled through `executeCommand` / `command:` URIs);
 *    every dialog is filled from a fresh Core read;
 *  - approve / revoke / run confirmations (modal + a Cancel-first step);
 *  - the run's `expected*` come from the task's binding and `sandbox.list`,
 *    never `chosenSandboxName`; a fresh key per gesture, reused only by
 *    "Retry safely";
 *  - results: events are display-only; the output opens in a read-only
 *    `sandpane-verification:` document, revealed;
 *  - stop and delete copy while a run is in flight; nothing secret is logged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { SandpaneSession } from '../src/session';
import type { CoreTransport, TransportHandlers } from '../src/core-client/connection';
import { parseWebviewMessage } from '../src/webview/bridge';
import { verificationCommandHandlers, VERIFICATION_COMMAND_IDS } from '../src/vscode/verificationCommands';
import { FakeTimers, flush } from './helpers/fakeCore';
import { stub } from './helpers/vscodeStub';

interface Frame {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

type Reply = { ok: unknown } | { err: { code: string; message: string; details?: unknown } };

const A6_METHODS = [
  'system.probe', 'project.create', 'project.list',
  'project.update', 'project.archive', 'project.unarchive', 'project.delete',
  'project.add_repository', 'project.remove_repository',
  'sandbox.list', 'sandbox.create', 'sandbox.stop', 'sandbox.remove',
  'conversation.create', 'conversation.send', 'conversation.list', 'conversation.history',
  'conversation.rename', 'conversation.archive', 'conversation.unarchive', 'conversation.delete', 'conversation.export',
  'task.cancel', 'task.list', 'task.subscribe', 'git.review', 'git.diff', 'git.apply',
];
const A7_METHODS = [
  ...A6_METHODS,
  'verification.list', 'verification.approve', 'verification.revoke', 'verification.run', 'verification.result', 'project.context',
];
const A6_FEATURES = ['idempotency-keys', 'sandbox-create-agent', 'conversation-sandbox-id', 'conversation-send-mode', 'git-apply'];
const A7_FEATURES = [...A6_FEATURES, 'verification'];
const KEY = /^[0-9a-f]{32}$/;
const ESC = '\u001b';
const BEL = '\u0007';
const RLO = '\u202e';
const SECRET_LIKE = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const TOKEN = '0123456789abcdef'.repeat(4);

/** Scripted A7 Core: project p1 with one task, two sandboxes, approved commands, events. */
class VCore {
  readonly requests: Frame[] = [];
  methods: string[] = A7_METHODS;
  features: string[] = A7_FEATURES;
  commands: Record<string, unknown>[] = [
    { id: 'cmd-1', projectId: 'p1', label: 'unit tests', argv: ['cargo', 'test'], approvedAt: '2026-10-12T09:00:00Z' },
    { id: 'cmd-2', projectId: 'p1', label: `lint ${RLO}x`, argv: ['npm', 'run', 'lint', `a${'\t'}b`], approvedAt: '2026-10-12T09:01:00Z' },
  ];
  context: Record<string, unknown> = {
    repositories: [
      {
        repoPath: '/repo/atlas',
        detected: [
          {
            manifest: 'package.json',
            suggestedCommands: [['npm', 'run', 'test'], ['npm', 'run', 'lint']],
            notes: [`npm run test runs: vitest ${ESC}]8;;https://evil${ESC}\\`, 'NOTE-MARKER this is the file in your registered repository now'],
          },
        ],
        unreadable: ['Cargo.toml'],
      },
    ],
    approved: [],
  };
  /** task.list rows (Core never binds over the wire; tests set sandboxName to simulate A4b). */
  task: Record<string, unknown> = { id: 'task-a', conversationId: 'c1', status: 'awaiting_review', chosenSandboxName: 'atlas-box' };
  sandboxes: Record<string, unknown>[] = [
    { name: 'atlas-box', probedState: 'running', boundProjectId: 'p1', workspaceMode: 'sbx_clone' },
    { name: 'nova-live', probedState: 'running', boundProjectId: 'p1', workspaceMode: 'direct_mount' },
  ];
  events: { taskId: string; sequence: number; kind: string; payload: unknown; timestamp: string }[] = [
    { taskId: 'task-a', sequence: 1, kind: 'status.changed', payload: { to: 'awaiting_review' }, timestamp: 't1' },
  ];
  results = new Map<string, Record<string, unknown>>();
  /** What verification.run answers (default: the real A7 answer for every sbx). */
  runReply: (frame: Frame) => Reply = () => ({
    err: { code: 'UNSUPPORTED_SBX_VERSION', message: 'sbx exec argument passing has not been verified for sbx 0.47.0; nothing was run' },
  });
  readonly forced = new Map<string, { code: string; message: string; details?: unknown }>();
  /** When set, verification.revoke answers this instead of `{revoked: true}`. */
  revokeAnswer: unknown = null;
  hold: ((frame: Frame) => boolean) | null = null;
  private held: (() => void)[] = [];
  private readonly live: TransportHandlers[] = [];

  release(): void {
    const pending = this.held;
    this.held = [];
    for (const deliver of pending) deliver();
  }

  calls(method: string): Frame[] {
    return this.requests.filter((r) => r.method === method);
  }

  a7Frames(): Frame[] {
    return this.requests.filter((r) => r.method.startsWith('verification.') || r.method === 'project.context');
  }

  transportFactory = (): CoreTransport => {
    let handlers: TransportHandlers | null = null;
    return {
      start: (h: TransportHandlers) => {
        handlers = h;
        this.live.push(h);
        return Promise.resolve();
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

  private answer(frame: Frame): Reply {
    const p = frame.params;
    const forced = this.forced.get(frame.method);
    if (forced) {
      this.forced.delete(frame.method);
      return { err: forced };
    }
    switch (frame.method) {
      case 'system.probe':
        return {
          ok: {
            protocolVersion: 1,
            coreVersion: '0.1.0-test',
            instanceId: 'inst-1',
            platform: 'darwin',
            sbx: { installed: true },
            agents: [{ id: 'codex', verified: true, supportsStreaming: false, supportsCancel: false, supportsResume: false }],
            methods: this.methods,
            features: this.features,
          },
        };
      case 'project.list':
        return { ok: [{ id: 'p1', name: 'Atlas Demo', description: '', createdAt: '', repositories: ['/repo/atlas'] }] };
      case 'sandbox.list':
        return { ok: this.sandboxes };
      case 'task.list':
        return { ok: [this.task] };
      case 'conversation.list':
        return { ok: [{ id: 'c1', projectId: 'p1', title: 'Auth', agentId: 'codex', createdAt: '' }] };
      case 'task.subscribe': {
        const after = typeof p['taskId'] === 'string' ? Number(p['afterSequence']) : Number((p['afterSequences'] as Record<string, number> | undefined)?.['task-a'] ?? p['afterSequence']);
        return { ok: this.events.filter((e) => e.sequence > after) };
      }
      case 'verification.list':
        return { ok: { commands: this.commands } };
      case 'project.context':
        return { ok: { ...this.context, approved: this.commands } };
      case 'verification.approve': {
        const existing = this.commands.find((c) => JSON.stringify(c['argv']) === JSON.stringify(p['argv']));
        if (existing) return { ok: { command: existing } };
        const command = { id: `cmd-${this.commands.length + 1}`, projectId: p['projectId'], label: p['label'], argv: p['argv'], approvedAt: 't' };
        this.commands = [...this.commands, command];
        return { ok: { command } };
      }
      case 'verification.revoke':
        if (this.revokeAnswer !== null) return { ok: this.revokeAnswer };
        this.commands = this.commands.filter((c) => c['id'] !== p['commandId']);
        return { ok: { revoked: true } };
      case 'verification.run':
        return this.runReply(frame);
      case 'verification.result': {
        const result = this.results.get(String(p['runId']));
        return result ? { ok: result } : { err: { code: 'NOT_FOUND', message: 'verification run not found' } };
      }
      case 'sandbox.stop':
        return { ok: { stopped: true, requeried: { name: p['name'], probedState: 'stopped', workspaceMode: 'sbx_clone' } } };
      case 'sandbox.remove':
        return { ok: { confirmation: { token: TOKEN, expiresAt: '2026-10-12T12:02:00Z', action: 'sandbox.remove', target: { name: p['name'], id: 'b5ebec73' }, impact: ['removes it'], external: false } } };
      case 'project.delete':
        return { ok: { confirmation: { token: TOKEN, expiresAt: '2026-10-12T12:02:00Z', action: 'project.delete', target: { name: 'Atlas Demo', id: p['projectId'] }, impact: [], external: false } } };
      case 'conversation.delete':
        return { ok: { confirmation: { token: TOKEN, expiresAt: '2026-10-12T12:02:00Z', action: 'conversation.delete', target: { name: 'Auth', id: p['conversationId'] }, impact: [], external: false } } };
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

async function settle(rounds = 16): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await flush();
}

async function online(core = new VCore()) {
  const timers = new FakeTimers();
  const context = { workspaceState: new MemoryState() } as unknown as vscode.ExtensionContext;
  const session = new SandpaneSession(context, {
    transportFactory: core.transportFactory,
    setTimer: timers.set,
    clearTimer: timers.clear,
    now: () => clock.now,
  });
  const logged: string[] = [];
  session.setOutputChannel({ appendLine: (line: string) => logged.push(line) } as unknown as vscode.OutputChannel);
  await session.attach();
  await settle();
  return { core, session, timers, logged };
}

function expire(timers: FakeTimers, ms: number): void {
  const timer = timers.pending.find((t) => t.ms === ms);
  if (!timer) throw new Error(`no pending ${ms} ms timer`);
  timers.clear(timer.id);
  timer.fn();
}

const modals = () => stub.warningCalls.filter((c) => c.options?.modal === true);

/** Bind task-a to `sandbox` (what A4b will do; today's Core never does it over the wire). */
function bind(core: VCore, sandbox: string): void {
  core.task = { ...core.task, sandboxName: sandbox };
}

/** Session wall clock (the "Retry safely" window reads it); tests move it. */
const clock = { now: Date.parse('2026-10-12T12:00:00Z') };
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  stub.reset();
  clock.now = Date.parse('2026-10-12T12:00:00Z');
});
afterEach(() => stub.reset());

describe('A7 gating on the "verification" feature', () => {
  it('an A6 Core (28 methods, no feature): Verification is visibly unsupported; no A7 frame from load or from any gesture', async () => {
    const core = new VCore();
    core.methods = A6_METHODS;
    core.features = A6_FEATURES;
    const { session } = await online(core);
    const snap = session.snapshot();
    expect(snap.verification.supported).toBe(false);
    expect(snap.verification.note).toMatch(/not supported by the attached Sandpane Core/);
    expect(snap.tasks[0]?.verification?.runEnabled).toBe(false);
    const handlers = verificationCommandHandlers(session);
    for (const id of Object.values(VERIFICATION_COMMAND_IDS)) await handlers[id]();
    await session.runVerificationOnTask('task-a');
    await session.showVerificationResults('task-a');
    expect(core.a7Frames()).toHaveLength(0);
    expect(stub.quickPickCalls).toHaveLength(0);
    expect(modals()).toHaveLength(0);
    expect(stub.warnings.at(-1)).toMatch(/does not advertise "verification\.|not supported by the attached Sandpane Core/);
    session.dispose();
  });

  it('the methods without the feature, and the feature without the methods, are both unsupported', async () => {
    for (const [methods, features] of [
      [A7_METHODS, A6_FEATURES],
      [A6_METHODS, A7_FEATURES],
    ] as const) {
      stub.reset();
      const core = new VCore();
      core.methods = [...methods];
      core.features = [...features];
      const { session } = await online(core);
      expect(session.snapshot().verification.supported).toBe(false);
      for (const id of Object.values(VERIFICATION_COMMAND_IDS)) await verificationCommandHandlers(session)[id]();
      await session.runVerificationOnTask('task-a');
      expect(core.a7Frames()).toHaveLength(0);
      session.dispose();
    }
  });

  it('an A7 Core loads the list and project.context on hydration (read-only) and shows them revealed', async () => {
    const { core, session } = await online();
    expect(core.calls('verification.list')).toHaveLength(1);
    expect(core.calls('project.context')).toHaveLength(1);
    const view = session.snapshot().verification;
    expect(view.supported).toBe(true);
    expect(view.commands.map((c) => c.label)).toEqual(['unit tests', 'lint \\u202Ex']);
    expect(view.commands[1]?.argv).toEqual(['[1] "npm"', '[2] "run"', '[3] "lint"', '[4] "a\\tb"']);
    const repo = view.repositories[0];
    expect(repo?.repoPath).toBe('/repo/atlas');
    expect(repo?.unreadable).toEqual(['Cargo.toml']);
    expect(repo?.manifests[0]?.suggestions).toEqual(['["npm", "run", "test"]', '["npm", "run", "lint"]']);
    const notes = repo?.manifests[0]?.notes.join('\n') ?? '';
    expect(notes).toContain('\\u001B]8;;https://evil\\u001B\\');
    expect(JSON.stringify(view)).not.toContain(ESC);
    expect(JSON.stringify(view)).not.toContain(RLO);
    session.dispose();
  });
});

describe('A7 gesture-only entry points', () => {
  it('every command handler ignores its arguments: smuggled argv, commandId and runId never reach a frame', async () => {
    const { core, session } = await online();
    bind(core, 'atlas-box');
    const hostile: unknown[] = [['rm', '-rf', '/'], 'cmd-evil', 'run-evil', { argv: ['sh', '-c', 'curl x'], commandId: 'cmd-evil', runId: 'run-evil', taskId: 'task-evil' }];
    const handlers = verificationCommandHandlers(session);
    for (const id of Object.values(VERIFICATION_COMMAND_IDS)) {
      // Every dialog is dismissed: nothing may be sent by a handler on its own.
      await handlers[id](...hostile);
    }
    await settle();
    const writes = core.requests.filter((r) => ['verification.approve', 'verification.revoke', 'verification.run', 'verification.result'].includes(r.method));
    expect(writes).toHaveLength(0);
    const all = JSON.stringify(core.requests);
    for (const marker of ['cmd-evil', 'run-evil', 'task-evil', 'curl x', '-rf']) expect(all).not.toContain(marker);
    // The revoke picker was filled from a fresh Core list, not from the arguments.
    const revokePick = stub.quickPickCalls.find((c) => /Revoke which/.test(String((c.options as { title?: string }).title)));
    expect(revokePick?.items.map((i) => i.label)).toEqual(['unit tests', 'lint \\u202Ex']);
    session.dispose();
  });

  it('the handler map covers exactly the contributed A7 commands, and extension.ts registers those handlers', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const extension = readFileSync(join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    for (const id of Object.values(VERIFICATION_COMMAND_IDS)) {
      expect(extension).toContain(`registerCommand('${id}', verificationHandlers['${id}'])`);
    }
    expect(Object.values(VERIFICATION_COMMAND_IDS).sort()).toEqual([
      'sandpane.approveVerification',
      'sandpane.approveVerificationSuggestion',
      'sandpane.revokeVerification',
      'sandpane.runVerification',
      'sandpane.showVerificationResult',
    ]);
  });

  it('static pin: the dialog flows are reached only from gesture entry points (never a load, poll, event or reconnect)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '..', 'src', 'session.ts'), 'utf8');
    const lines = source.split('\n');
    /** The class method whose body contains line `index` (2-space-indented declaration). */
    const enclosing = (index: number): string => {
      for (let i = index; i >= 0; i -= 1) {
        const m = /^  (?:private |readonly )?(?:async )?([A-Za-z]+)\(/.exec(lines[i] ?? '');
        if (m) return m[1] ?? '?';
      }
      return '?';
    };
    const callers = (call: string): string[] =>
      [...new Set(lines.flatMap((line, i) => (line.includes(`this.${call}(`) ? [enclosing(i)] : [])))].sort();
    expect(callers('approveVerificationCommand')).toEqual(['runVerificationAction']);
    expect(callers('approveVerificationSuggestion')).toEqual(['runVerificationAction']);
    expect(callers('revokeVerificationCommand')).toEqual(['runVerificationAction']);
    expect(callers('runVerificationAction')).toEqual(['handleWebviewMessage']);
    expect(callers('runVerificationOnTask')).toEqual(['handleWebviewMessage', 'runVerificationFromPicker']);
    expect(callers('retryVerificationRun')).toEqual(['offerVerificationRetry']);
    expect(callers('showVerificationResults')).toEqual(['handleWebviewMessage']);
    // The only result read outside a picker is the "Show result" button of a finish notification.
    expect(callers('openVerificationResult')).toEqual(['notifyFinishedRuns', 'pickAndOpenRun']);
    // No terminal or pseudoterminal anywhere in the A7 path.
    for (const file of ['session.ts', 'vscode/verification.ts', 'vscode/verificationCommands.ts', 'extension.ts']) {
      expect(readFileSync(join(__dirname, '..', 'src', file), 'utf8'), file).not.toMatch(/createTerminal|Pseudoterminal|sendText\(/);
    }
  });

  it('webview messages carry no argv, commandId or runId: smuggled fields are dropped', () => {
    expect(parseWebviewMessage({ type: 'verificationAction', action: 'revoke', commandId: 'cmd-evil', argv: ['x'] })).toEqual({
      type: 'verificationAction',
      action: 'revoke',
    });
    expect(parseWebviewMessage({ type: 'verificationAction', action: 'run-shell' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'runVerification', taskId: 'task-a', commandId: 'cmd-evil', argv: ['x'] })).toEqual({
      type: 'runVerification',
      taskId: 'task-a',
    });
    expect(parseWebviewMessage({ type: 'showVerificationResults', taskId: 'task-a', runId: 'run-evil' })).toEqual({
      type: 'showVerificationResults',
      taskId: 'task-a',
    });
    expect(parseWebviewMessage({ type: 'runVerification' })).toBeUndefined();
  });
});

describe('A7 approve', () => {
  it('label + JSON argv → modal lists every element revealed + both warnings → Cancel-first step → the exact frame', async () => {
    const { core, session } = await online();
    const argv = ['printf', '[%s]\n', ' lead', '', `x${RLO}y`, 'say "hi"', 'é中'];
    stub.inputs.push('  my check ', JSON.stringify(argv));
    stub.answers.set('Approve', 'Approve');
    stub.pickQueue.push(1);
    await verificationCommandHandlers(session)[VERIFICATION_COMMAND_IDS.approve]();
    await settle();
    const modal = modals()[0];
    const text = `${modal?.message}\n${modal?.options?.detail}`;
    expect(modal?.items).toEqual(['Approve']);
    expect(text).toContain('(7 arguments)');
    expect(text).toContain('[2] "[%s]\\n"');
    expect(text).toContain('[3] " lead"');
    expect(text).toContain('[4] ""');
    expect(text).toContain('[5] "x\\u202Ey"');
    expect(text).toContain('Do not put tokens or passwords in arguments.');
    expect(text).toContain('Approval binds this exact argument list, not what it executes.');
    expect(text).not.toContain(RLO);
    // The second step: Cancel is the first (active) item.
    const step = stub.quickPickCalls.at(-1);
    expect(step?.items[0]?.label).toMatch(/^Cancel/);
    expect(step?.items[1]?.label).toBe('Approve exactly these 7 arguments');
    const frames = core.calls('verification.approve');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.params).toEqual({ projectId: 'p1', label: 'my check', argv });
    // The list was re-read after the approval.
    expect(core.calls('verification.list').length).toBeGreaterThanOrEqual(2);
    expect(session.snapshot().status?.text).toMatch(/Approved/);
    session.dispose();
  });

  it('Cancel at the second step, a dismissed modal, Escape at either input, or an invalid list send nothing', async () => {
    const { core, session } = await online();
    const approve = verificationCommandHandlers(session)[VERIFICATION_COMMAND_IDS.approve];
    stub.inputs.push('check', '["cargo", "test"]');
    stub.answers.set('Approve', 'Approve');
    stub.pickQueue.push(0); // Cancel
    await approve();
    stub.inputs.push('check', '["cargo", "test"]');
    stub.answers.delete('Approve'); // modal dismissed
    await approve();
    stub.inputs.push(undefined);
    await approve();
    stub.inputs.push('check', undefined);
    await approve();
    await settle();
    expect(core.calls('verification.approve')).toHaveLength(0);
    // The argv field explains a non-list input (never a shell split).
    const argvBox = stub.inputCalls.find((c) => /JSON array/.test(String(c.prompt)));
    expect(argvBox?.validateInput?.('npm run test')).toMatch(/JSON array of strings/);
    expect(argvBox?.validateInput?.('["-rf"]')).toMatch(/argument 1 \(the program\) must not start with '-'/);
    expect(argvBox?.validateInput?.('["cargo", "test"]')).toBeFalsy();
    session.dispose();
  });

  it('approve a suggestion: fresh project.context → picker → argv prefilled EXACTLY (editable list) → notes in the modal → frame', async () => {
    const { core, session } = await online();
    const contextCalls = core.calls('project.context').length;
    stub.pickQueue.push(0); // the first suggestion
    stub.inputs.push('npm test'); // label; then Escape at the (prefilled) argv field
    stub.answers.set('Approve', 'Approve');
    await session.approveVerificationSuggestion();
    await settle();
    expect(core.calls('project.context')).toHaveLength(contextCalls + 1);
    const pick = stub.quickPickCalls[0];
    expect(pick?.items.map((i) => i.label)).toEqual(['["npm", "run", "test"]', '["npm", "run", "lint"]']);
    const argvBox = stub.inputCalls.find((c) => /JSON array/.test(String(c.prompt)));
    expect(argvBox?.value).toBe('["npm", "run", "test"]');
    // Escape at the argv field: nothing was sent.
    expect(core.calls('verification.approve')).toHaveLength(0);

    stub.reset();
    stub.pickQueue.push(0, 1);
    stub.inputs.push('npm test', '["npm", "run", "test"]');
    stub.answers.set('Approve', 'Approve');
    await session.approveVerificationSuggestion();
    await settle();
    const modal = modals()[0];
    const text = `${modal?.message}\n${modal?.options?.detail}`;
    expect(text).toContain('Notes from Core about this suggestion:');
    expect(text).toContain('npm run test runs: vitest \\u001B]8;;https://evil\\u001B\\');
    expect(text).not.toContain(ESC);
    expect(core.calls('verification.approve').at(-1)?.params).toEqual({ projectId: 'p1', label: 'npm test', argv: ['npm', 'run', 'test'] });
    session.dispose();
  });

  it("a secret refusal shows Core's message and details.hint as advice; nothing secret is logged", async () => {
    const { core, session, logged } = await online();
    core.forced.set('verification.approve', {
      code: 'VALIDATION_FAILED',
      message: 'argument 2 looks like a secret (github-token); approved commands cannot hold secrets; nothing was approved',
      details: { hint: 'if this is not a secret, rename the argument or move it into a script; approved commands cannot hold secrets and there is no override' },
    });
    stub.inputs.push('push', JSON.stringify(['gh', SECRET_LIKE]));
    stub.answers.set('Approve', 'Approve');
    stub.pickQueue.push(1);
    await verificationCommandHandlers(session)[VERIFICATION_COMMAND_IDS.approve]();
    await settle();
    expect(core.calls('verification.approve')).toHaveLength(1);
    const shown = stub.errors.at(-1) ?? '';
    expect(shown).toContain('argument 2 looks like a secret (github-token)');
    expect(shown).toContain("Core's advice: if this is not a secret, rename the argument or move it into a script");
    expect(shown).not.toMatch(/run it yourself/);
    expect(logged.join('\n')).not.toContain(SECRET_LIKE);
    session.dispose();
  });
});

describe('A7 revoke', () => {
  it('picker from a fresh verification.list → modal (not destructive) → Cancel-first step → {commandId} of the picked row', async () => {
    const { core, session } = await online();
    const lists = core.calls('verification.list').length;
    // Cancel at the second step first: nothing is sent.
    stub.pickQueue.push(1, 0);
    stub.answers.set('Revoke', 'Revoke');
    await verificationCommandHandlers(session)[VERIFICATION_COMMAND_IDS.revoke]('cmd-1');
    await settle();
    expect(core.calls('verification.revoke')).toHaveLength(0);
    expect(stub.quickPickCalls.at(-1)?.items[0]?.label).toMatch(/^Cancel/);
    stub.reset();
    stub.pickQueue.push(1, 1);
    stub.answers.set('Revoke', 'Revoke');
    await verificationCommandHandlers(session)[VERIFICATION_COMMAND_IDS.revoke]('cmd-1');
    await settle();
    expect(core.calls('verification.list').length).toBeGreaterThan(lists);
    expect(modals()[0]?.items).toEqual(['Revoke']);
    expect(modals()[0]?.options?.detail).toContain('Nothing is deleted.');
    expect(core.calls('verification.revoke').map((f) => f.params)).toEqual([{ commandId: 'cmd-2' }]);
    session.dispose();
  });
});

describe('A7 run', () => {
  it('an unbound task (chosenSandboxName only — today\'s wire) is disabled with the reason; nothing is sent', async () => {
    const { core, session } = await online();
    const row = session.snapshot().tasks[0];
    expect(row?.verification?.runEnabled).toBe(false);
    expect(row?.verification?.runReason).toBe('this task is not bound to a sandbox');
    await session.runVerificationOnTask('task-a');
    await settle();
    expect(core.calls('verification.run')).toHaveLength(0);
    expect(stub.warnings.at(-1)).toMatch(/this task is not bound to a sandbox.*Nothing was sent/);
    session.dispose();
  });

  it('a bound task: modal (sandbox, mode, direct_mount warning, scope sentence) → Cancel-first step → expected* from the binding + sandbox.list; a fresh key per gesture', async () => {
    const { core, session } = await online();
    bind(core, 'nova-live'); // chosenSandboxName stays "atlas-box": never used
    await session.refresh();
    await settle();
    expect(session.snapshot().tasks[0]?.verification?.runEnabled).toBe(true);
    for (let i = 0; i < 2; i += 1) {
      stub.pickQueue.push(0, 1); // command "unit tests", then "Run …"
      stub.answers.set('Run', 'Run');
      await session.runVerificationOnTask('task-a');
      await settle();
    }
    const modal = modals()[0];
    const text = `${modal?.message}\n${modal?.options?.detail}`;
    expect(modal?.items).toEqual(['Run']);
    expect(text).toContain('nova-live');
    expect(text).toContain('workspace mode: direct_mount');
    expect(text).toContain('this sandbox mounts your repository directly; the command can change your working tree');
    expect(text).toContain("Runs in sbx's default working directory inside the sandbox");
    expect(stub.quickPickCalls.at(-1)?.items[0]?.label).toMatch(/^Cancel/);
    const frames = core.calls('verification.run');
    expect(frames).toHaveLength(2);
    expect(frames[0]?.params).toMatchObject({
      taskId: 'task-a',
      commandId: 'cmd-1',
      expectedSandboxName: 'nova-live',
      expectedWorkspaceMode: 'direct_mount',
    });
    expect(String(frames[0]?.params['idempotencyKey'])).toMatch(KEY);
    expect(frames[0]?.params['idempotencyKey']).not.toBe(frames[1]?.params['idempotencyKey']);
    // The run read the binding fresh at click time.
    expect(core.calls('task.list').length).toBeGreaterThanOrEqual(3);
    session.dispose();
  });

  it('Cancel at the second step or a dismissed modal sends nothing', async () => {
    const { core, session } = await online();
    bind(core, 'atlas-box');
    stub.pickQueue.push(0, 0);
    stub.answers.set('Run', 'Run');
    await session.runVerificationOnTask('task-a');
    stub.pickQueue.push(0);
    stub.answers.delete('Run');
    await session.runVerificationOnTask('task-a');
    await settle();
    expect(core.calls('verification.run')).toHaveLength(0);
    session.dispose();
  });

  it('UNSUPPORTED_SBX_VERSION (every real sbx in A7) reads as "running is disabled until captured", never a failure of the command', async () => {
    const { core, session } = await online();
    bind(core, 'atlas-box');
    stub.pickQueue.push(0, 1);
    stub.answers.set('Run', 'Run');
    await session.runVerificationOnTask('task-a');
    await settle();
    expect(core.calls('verification.run')).toHaveLength(1);
    const shown = [...stub.warnings, ...stub.errors].at(-1) ?? '';
    expect(shown).toContain("Running is disabled until this sbx version's `sbx exec` behaviour has been captured and verified; your approved commands are kept.");
    expect(shown).not.toMatch(/\bfailed\b/i);
    expect(stub.errorCalls.some((c) => c.items.includes('Retry safely'))).toBe(false);
    session.dispose();
  });

  it('a lost answer offers "Retry safely"; only the click resends the SAME params and key; a replay is announced', async () => {
    const core = new VCore();
    bind(core, 'atlas-box');
    let first = true;
    core.hold = (f) => {
      if (f.method !== 'verification.run' || !first) return false;
      first = false;
      return true;
    };
    core.runReply = (frame) => ({ ok: { runId: 'run-1', startedSequence: 2, ...(first ? {} : { replayed: true }) } });
    const { session, timers } = await online(core);
    stub.pickQueue.push(0, 1);
    stub.answers.set('Run', 'Run');
    stub.manual.add('Retry safely');
    const pending = session.runVerificationOnTask('task-a');
    await settle();
    expire(timers, 45_000);
    await pending;
    await settle();
    const offered = stub.errorCalls.at(-1);
    expect(offered?.items).toEqual(['Retry safely']);
    expect(offered?.message).toMatch(/may have started/);
    expect(offered?.message).not.toMatch(/nothing was run/i);
    expect(core.calls('verification.run')).toHaveLength(1); // never automatic
    stub.clicks.shift()?.('Retry safely');
    await settle(30);
    const frames = core.calls('verification.run');
    expect(frames).toHaveLength(2);
    expect(frames[1]?.params).toEqual(frames[0]?.params);
    expect(stub.infos.join('\n')).toMatch(/replayed/);
    session.dispose();
  });

  it('single-flight per task: a second Run while the first is open is refused visibly', async () => {
    const core = new VCore();
    bind(core, 'atlas-box');
    core.hold = (f) => f.method === 'verification.run';
    core.runReply = () => ({ ok: { runId: 'run-1', startedSequence: 2 } });
    const { session } = await online(core);
    stub.pickQueue.push(0, 1);
    stub.answers.set('Run', 'Run');
    const first = session.runVerificationOnTask('task-a');
    await settle();
    await session.runVerificationOnTask('task-a');
    expect(stub.warnings.at(-1)).toMatch(/already being started for this task/);
    core.release();
    await first;
    await settle();
    expect(core.calls('verification.run')).toHaveLength(1);
    session.dispose();
  });
});

describe('A7 results (events are display-only; output in a read-only document)', () => {
  function withRun(core: VCore, finished: boolean): void {
    core.events = [
      ...core.events,
      {
        taskId: 'task-a',
        sequence: 2,
        kind: 'verification.started',
        payload: { runId: 'run-1', commandId: 'cmd-1', label: 'unit tests', argv: ['cargo', 'test'], sandbox: 'atlas-box', workspaceMode: 'sbx_clone' },
        timestamp: 't2',
      },
      ...(finished
        ? [{
            taskId: 'task-a',
            sequence: 3,
            kind: 'verification.finished',
            payload: { runId: 'run-1', startedSequence: 2, outcome: 'exited', exitCode: 0, stdoutBytes: 10, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, redactions: { bestEffort: true, replacements: 0, byKind: {} }, elapsedMs: 900 },
            timestamp: 't3',
          }]
        : []),
    ];
    core.results.set('run-1', {
      runId: 'run-1', taskId: 'task-a', commandId: 'cmd-1', label: 'unit tests', argv: ['cargo', 'test'], sandbox: 'atlas-box',
      workspaceMode: 'sbx_clone', outcome: finished ? 'exited' : 'running', ...(finished ? { exitCode: 0, elapsedMs: 900, finishedAt: 't3' } : {}),
      stdout: `OUTPUT-MARKER ok\r\n${ESC}]52;c;SGVsbG8=${BEL}${RLO}x\n`, stderr: '', stdoutTruncated: false, stderrTruncated: false,
      redactions: { bestEffort: true, replacements: 1, byKind: { 'github-token': 1 } }, startedAt: 't2',
    });
  }

  it('the events never change the task status; the row shows the outcome copy (exit 0 is not "passed")', async () => {
    const core = new VCore();
    withRun(core, true);
    const { session } = await online(core);
    const snap = session.snapshot();
    expect(snap.tasks[0]?.status).toBe('awaiting_review');
    const runs = snap.tasks[0]?.verification?.runs ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('exit status 0 (as reported by sbx exec)');
    expect(runs[0]).not.toMatch(/passed|success/i);
    expect(snap.lines.some((l) => /^verification started: unit tests/.test(l.text))).toBe(true);
    session.dispose();
  });

  it('Results… picks a run named by Core events and opens a revealed read-only sandpane-verification: document', async () => {
    const core = new VCore();
    withRun(core, true);
    const { session, logged } = await online(core);
    stub.pickQueue.push(0);
    await verificationCommandHandlers(session)[VERIFICATION_COMMAND_IDS.showResult]('run-evil');
    await settle();
    // No task was given to the command: it asked for one first, then the run.
    expect(core.calls('verification.result')).toHaveLength(0);
    stub.reset();
    stub.pickQueue.push(0);
    await session.showVerificationResults('task-a');
    await settle();
    expect(core.calls('verification.result').map((f) => f.params)).toEqual([{ runId: 'run-1' }]);
    const doc = stub.openedDocuments.at(-1);
    expect(doc?.uri.scheme).toBe('sandpane-verification');
    // W3b: the dedicated extension opens it in the verification language directly — no plaintext first.
    expect(doc?.uri.path.endsWith('.sandpane-verification')).toBe(true);
    expect(doc?.languageId).toBe('sandpane-verification-output');
    expect(stub.languageChanges).toHaveLength(0);
    expect(stub.shownDocuments).toHaveLength(1);
    const provider = session.verificationDocuments;
    const text = provider.provideTextDocumentContent(doc?.uri ?? { path: '' });
    expect(text).toContain('OUTPUT-MARKER ok\\r');
    expect(text).toContain('\\u001B]52;c;SGVsbG8=\\u0007\\u202Ex');
    for (const raw of [ESC, BEL, RLO, '\r']) expect(text).not.toContain(raw);
    expect(text).toContain('1 value was redacted (best effort)');
    // Output is never logged.
    expect(logged.join('\n')).not.toContain('OUTPUT-MARKER');
    session.dispose();
  });

  it('a run still in flight says "still running"; no timer polls verification.result', async () => {
    const core = new VCore();
    withRun(core, false);
    const { session, timers } = await online(core);
    expect(session.snapshot().tasks[0]?.verification?.runs[0]).toMatch(/still running|no result yet/);
    stub.pickQueue.push(0);
    await session.showVerificationResults('task-a');
    await settle();
    const text = session.verificationDocuments.provideTextDocumentContent(stub.openedDocuments.at(-1)?.uri ?? { path: '' });
    expect(text).toContain('still running (Core has recorded no result yet)');
    const before = core.calls('verification.result').length;
    timers.runAll();
    await settle();
    expect(core.calls('verification.result')).toHaveLength(before);
    session.dispose();
  });

  it('stop: a run in flight in that sandbox (started, not finished) is named in the stop confirmation', async () => {
    const core = new VCore();
    withRun(core, false);
    const { session } = await online(core);
    await session.stopSandbox('atlas-box');
    expect(modals().at(-1)?.options?.detail).toContain('a verification is running in this sandbox; stopping it ends the run');
    await session.stopSandbox('nova-live');
    expect(modals().at(-1)?.options?.detail).not.toContain('a verification is running in this sandbox');
    session.dispose();
  });
});

describe('A7 delete refusals while a run is in flight', () => {
  it('sandbox.remove / project.delete / conversation.delete: "a verification is running …; nothing was deleted" is told honestly', async () => {
    const { core, session } = await online();
    core.forced.set('sandbox.remove', { code: 'CONFLICT', message: 'a verification is running in this sandbox; wait for it to finish; nothing was deleted' });
    await session.removeSandbox('atlas-box');
    expect(stub.errors.at(-1)).toMatch(/A verification is running in this sandbox.*Nothing was deleted/s);
    expect(stub.errors.at(-1)).not.toMatch(/same-named replacement/);

    core.forced.set('project.delete', { code: 'CONFLICT', message: 'a verification is running for a task of this project; wait for it to finish; nothing was deleted' });
    await session.deleteProject({ id: 'p1', name: 'Atlas Demo', description: '', createdAt: '' });
    // Case-sensitive: the client's own sentence (capitalised), not only Core's echoed text.
    expect(stub.errors.at(-1)).toMatch(/A verification is running for a task of this project.*Nothing was deleted/s);

    core.forced.set('conversation.delete', { code: 'CONFLICT', message: 'a verification is running for a task of this conversation; wait for it to finish; nothing was deleted' });
    await session.deleteConversation('c1');
    expect(stub.errors.at(-1)).toMatch(/A verification is running for a task of this conversation.*Nothing was deleted/s);
    session.dispose();
  });
});

describe('A7 review fixes (session)', () => {
  it('W1: an approve on an archived project names it (not "label or arguments"); an archived run names the conversation', async () => {
    const { core, session } = await online();
    core.forced.set('verification.approve', { code: 'VALIDATION_FAILED', message: 'project is archived; unarchive it first; nothing was changed' });
    stub.inputs.push('check', '["cargo", "test"]');
    stub.answers.set('Approve', 'Approve');
    stub.pickQueue.push(1);
    await session.approveVerificationCommand();
    await settle();
    expect(stub.errors.at(-1)).toContain('Not approved — this project is archived; unarchive it first.');
    expect(stub.errors.at(-1)).not.toContain('label or the arguments');

    bind(core, 'atlas-box');
    core.runReply = () => ({ err: { code: 'VALIDATION_FAILED', message: 'conversation is archived; unarchive it first; nothing was changed' } });
    stub.pickQueue.push(0, 1);
    stub.answers.set('Run', 'Run');
    await session.runVerificationOnTask('task-a');
    await settle();
    expect(stub.errors.at(-1)).toContain("Not run — the task's conversation is archived; unarchive it first.");
    expect(stub.errorCalls.at(-1)?.items).toEqual([]);
    session.dispose();
  });

  it('W2: revoked:false (or anything but true) is an UNCONFIRMED outcome: error tone, "may not have been revoked", list re-read', async () => {
    for (const answer of [{ revoked: false }, { revoked: 'yes' }, {}]) {
      stub.reset();
      const core = new VCore();
      core.revokeAnswer = answer;
      const { session } = await online(core);
      stub.pickQueue.push(0, 1);
      stub.answers.set('Revoke', 'Revoke');
      await session.revokeVerificationCommand();
      await settle();
      const lists = core.calls('verification.list').length;
      expect(core.calls('verification.revoke')).toHaveLength(1);
      expect(session.snapshot().status?.tone).toBe('error');
      expect(session.snapshot().status?.text).toMatch(/may not have been revoked/);
      expect(session.snapshot().status?.text).not.toMatch(/already revoked/);
      expect(stub.errors.at(-1)).toMatch(/may not have been revoked/);
      // Re-read: hydration + the revoke picker + the re-read after the answer.
      expect(lists).toBeGreaterThanOrEqual(3);
      session.dispose();
    }
  });

  it('W3: the output opens with the dedicated extension (no plaintext first) and discloses links unless editor.links is off for the language', async () => {
    const core = new VCore();
    core.events = [
      ...core.events,
      { taskId: 'task-a', sequence: 2, kind: 'verification.started', payload: { runId: 'run-1', label: 'unit tests', argv: ['cargo', 'test'], sandbox: 'atlas-box', workspaceMode: 'sbx_clone' }, timestamp: 't2' },
    ];
    core.results.set('run-1', {
      runId: 'run-1', taskId: 'task-a', commandId: 'cmd-1', label: 'unit tests', argv: ['cargo', 'test'], sandbox: 'atlas-box',
      workspaceMode: 'sbx_clone', outcome: 'running', stdout: 'see https://example.invalid', stderr: '', stdoutTruncated: false,
      stderrTruncated: false, redactions: { bestEffort: true, replacements: 0, byKind: {} }, startedAt: 't2',
    });
    const { session } = await online(core);
    // No language-scoped value (e.g. a workspace override removed it): links are disclosed.
    stub.pickQueue.push(0);
    await session.showVerificationResults('task-a');
    await settle();
    const doc = stub.openedDocuments.at(-1);
    expect(doc?.uri.path.endsWith('.sandpane-verification')).toBe(true);
    expect(doc?.languageId).toBe('sandpane-verification-output');
    expect(stub.languageChanges).toHaveLength(0);
    expect(stub.configScopes).toContainEqual({ section: 'editor', languageId: 'sandpane-verification-output' });
    const linked = session.verificationDocuments.provideTextDocumentContent(doc?.uri ?? { path: '' });
    expect(linked).toContain('Link detection is enabled by a setting');
    expect(linked).not.toMatch(/run, linked or written/);
    // editor.links === false for the language: the header may say "not linked".
    stub.languageConfig.set('sandpane-verification-output:editor.links', false);
    stub.pickQueue.push(0);
    await session.showVerificationResults('task-a');
    await settle();
    const quiet = session.verificationDocuments.provideTextDocumentContent(stub.openedDocuments.at(-1)?.uri ?? { path: '' });
    expect(quiet).toContain('Nothing in this view is run, linked or written to your repository.');
    // "true" or any other value is NOT "off".
    stub.languageConfig.set('sandpane-verification-output:editor.links', 'false');
    stub.pickQueue.push(0);
    await session.showVerificationResults('task-a');
    await settle();
    expect(session.verificationDocuments.provideTextDocumentContent(stub.openedDocuments.at(-1)?.uri ?? { path: '' })).toContain(
      'Link detection is enabled by a setting',
    );
    session.dispose();
  });

  it('I3: the Results… picker title reveals the task id ($( broken)', async () => {
    const core = new VCore();
    const taskId = '$(bug)aaaa-task';
    core.events = [
      { taskId, sequence: 1, kind: 'verification.started', payload: { runId: 'run-9', label: 'x', argv: ['x'], sandbox: 'atlas-box', workspaceMode: 'sbx_clone' }, timestamp: 't' },
    ];
    const { session } = await online(core);
    await session.showVerificationResults(taskId);
    await settle();
    const title = String((stub.quickPickCalls.at(-1)?.options as { title?: string } | undefined)?.title);
    expect(title).toContain('$ (bug)');
    expect(title).not.toContain('$(');
    session.dispose();
  });

  it('I4: a background (timer) refresh never re-reads project.context; an explicit refresh does; two reads never overlap', async () => {
    const core = new VCore();
    const { session } = await online(core);
    const contexts = core.calls('project.context').length;
    const lists = core.calls('verification.list').length;
    await session.refresh({ background: true });
    await settle();
    expect(core.calls('project.context')).toHaveLength(contexts);
    expect(core.calls('verification.list').length).toBeGreaterThan(lists);
    await session.refresh();
    await settle();
    expect(core.calls('project.context')).toHaveLength(contexts + 1);

    core.hold = (f) => f.method === 'project.context';
    void session.refresh();
    await settle();
    stub.pickQueue.push(undefined);
    const detect = session.approveVerificationSuggestion();
    await settle();
    // The Detect read joins the refresh's read in flight: still ONE frame.
    expect(core.calls('project.context')).toHaveLength(contexts + 2);
    core.release();
    await detect;
    await settle();
    expect(core.calls('project.context')).toHaveLength(contexts + 2);
    expect(stub.quickPickCalls.length).toBeGreaterThan(0);

    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const extension = readFileSync(join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    expect(extension).toContain('session.refresh({ background: true })');
    session.dispose();
  });

  it('I6 static pin: the approve / revoke / run frames are sent only after the confirmation, from one place each', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '..', 'src', 'session.ts'), 'utf8');
    const lines = source.split('\n');
    const methodStart = (index: number): number => {
      for (let i = index; i >= 0; i -= 1) if (/^  (?:private |readonly )?(?:async )?[A-Za-z]+\(/.test(lines[i] ?? '')) return i;
      return -1;
    };
    const sites = (call: string) =>
      lines.flatMap((line, i) => (line.includes(`this.commands.${call}(`) ? [{ i, start: methodStart(i) }] : []));
    const name = (start: number) => /^  (?:private |readonly )?(?:async )?([A-Za-z]+)\(/.exec(lines[start] ?? '')?.[1];
    const approve = sites('verificationApprove');
    const revoke = sites('verificationRevoke');
    const run = sites('verificationRun');
    expect(approve.map((s) => name(s.start))).toEqual(['confirmAndApprove']);
    expect(revoke.map((s) => name(s.start))).toEqual(['revokeVerificationCommand']);
    expect(run.map((s) => name(s.start))).toEqual(['attemptVerificationRun']);
    for (const site of [...approve, ...revoke]) {
      const body = lines.slice(site.start, site.i).join('\n');
      expect(body).toMatch(/await this\.confirmVerification\(/);
    }
    expect(callersOf(source, 'attemptVerificationRun')).toEqual(['retryVerificationRun', 'runVerificationFlow']);
    // runVerificationFlow sends only after its confirmation.
    const flow = source.slice(source.indexOf('private async runVerificationFlow('), source.indexOf('private async attemptVerificationRun('));
    expect(flow.indexOf('await this.confirmVerification(')).toBeGreaterThan(-1);
    expect(flow.indexOf('await this.confirmVerification(')).toBeLessThan(flow.indexOf('this.attemptVerificationRun('));
  });

  it('I7: an approve that returns the existing command (byte-equal argv) says "already approved as «label»"', async () => {
    const { core, session } = await online();
    stub.inputs.push('another name', '["cargo", "test"]');
    stub.answers.set('Approve', 'Approve');
    stub.pickQueue.push(1);
    await session.approveVerificationCommand();
    await settle();
    expect(core.calls('verification.approve')).toHaveLength(1);
    expect(session.snapshot().status?.text).toContain('This command was already approved as «unit tests»; nothing new was approved.');
    session.dispose();
  });

  it('#9: "Retry safely" only within 23 h of the first send; a late click (and a late re-offer) says too late and sends nothing', async () => {
    const core = new VCore();
    bind(core, 'atlas-box');
    core.hold = (f) => f.method === 'verification.run';
    const { session, timers } = await online(core);
    stub.pickQueue.push(0, 1);
    stub.answers.set('Run', 'Run');
    stub.manual.add('Retry safely');
    const pending = session.runVerificationOnTask('task-a');
    await settle();
    expire(timers, 45_000);
    await pending;
    await settle();
    expect(stub.errorCalls.at(-1)?.items).toEqual(['Retry safely']);
    // 22 h later the click is still inside the window: resent (and lost again).
    clock.now += 22 * HOUR;
    stub.clicks.shift()?.('Retry safely');
    await settle(30);
    expect(core.calls('verification.run')).toHaveLength(2);
    // The re-offer comes 1 h + 1 ms later: past the window, no button.
    clock.now += HOUR + 1;
    expire(timers, 45_000);
    await settle(30);
    const late = stub.errorCalls.at(-1);
    expect(late?.items).toEqual([]);
    expect(late?.message).toContain('Too late to retry safely — the earlier run may have started; check Results before running again');
    session.dispose();
  });

  it('#9: a click that lands after 23 h re-checks the window and sends nothing', async () => {
    const core = new VCore();
    bind(core, 'atlas-box');
    core.hold = (f) => f.method === 'verification.run';
    const { session, timers } = await online(core);
    stub.pickQueue.push(0, 1);
    stub.answers.set('Run', 'Run');
    stub.manual.add('Retry safely');
    const pending = session.runVerificationOnTask('task-a');
    await settle();
    expire(timers, 45_000);
    await pending;
    await settle();
    clock.now += 23 * HOUR;
    stub.clicks.shift()?.('Retry safely');
    await settle(30);
    expect(core.calls('verification.run')).toHaveLength(1);
    expect(stub.errors.at(-1)).toContain('Too late to retry safely — the earlier run may have started; check Results before running again');
    session.dispose();
  });
});

/** Methods (2-space-indented declarations) of `source` that call `this.<name>(`. */
function callersOf(source: string, method: string): string[] {
  const lines = source.split('\n');
  const out = new Set<string>();
  lines.forEach((line, index) => {
    if (!line.includes(`this.${method}(`)) return;
    for (let i = index; i >= 0; i -= 1) {
      const m = /^  (?:private |readonly )?(?:async )?([A-Za-z]+)\(/.exec(lines[i] ?? '');
      if (m) {
        out.add(m[1] ?? '?');
        return;
      }
    }
  });
  return [...out].sort();
}
