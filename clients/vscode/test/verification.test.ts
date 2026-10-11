/**
 * A7 (design 2026-10-09 §3.7): verification commands + `project.context`.
 *  - wire: exact frames for the six methods, argv elements byte-exact (tab,
 *    newline, quote, non-ASCII, a leading-space element, an empty element);
 *  - deadlines: list / approve / revoke / result use the default deadline,
 *    `project.context` and `verification.run` the 45 s one;
 *  - validators: never stricter than Core (bytes counted in UTF-8, Rust
 *    trim, no client-side secret check), and a refusal never echoes a value;
 *  - drift: methods, feature, bounds, every Core message the copy keys on,
 *    event kinds, outcomes, wire fields, deadlines — against the Rust sources;
 *  - decode: tolerant of absence, outcome / kinds are open strings;
 *  - copy: each outcome (exit 0 is never "passed" nor green), each
 *    disclosure, the secret / frame / UNSUPPORTED_SBX_VERSION refusals, a lost
 *    run answer ("may have started");
 *  - rendering: ESC, OSC 8, OSC 52, CR and bidi characters in output, label,
 *    argv and notes are revealed (never raw) and no `$(` / `](` survives.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CoreCommands,
  CoreValidationError,
  GIT_QUERY_TIMEOUT_MS,
  MAX_VERIFICATION_ARGS,
  MAX_VERIFICATION_ARG_BYTES,
  MAX_VERIFICATION_ARGV_BYTES,
  MAX_VERIFICATION_LABEL_CHARS,
  PROJECT_CONTEXT_TIMEOUT_MS,
  VERIFICATION_RUN_TIMEOUT_MS,
  validateVerificationArgv,
  validateVerificationLabel,
} from '../src/core-client/commands';
import { CoreRpcError, CoreTransportError } from '../src/core-client/connection';
import { VERIFICATION_EVENT_KINDS, type ErrorCode } from '../src/core-client/events';
import { CORE_METHODS, KNOWN_FEATURES, PROTOCOL_VERSION } from '../src/core-client/protocol';
import type { SandboxSummary, VerificationResult } from '../src/core-client/protocol';
import {
  APPROVE_BINDING_SENTENCE,
  APPROVE_NO_SECRETS,
  DIRECT_MOUNT_WARNING,
  HOST_WORKTREE_WARNING,
  MSG_COMMAND_NOT_FOUND,
  MSG_COMMAND_NO_LONGER_PASSES,
  MSG_COMMAND_OTHER_PROJECT,
  MSG_COMMAND_REVOKED,
  MSG_CONVERSATION_VERIFICATION_RUNNING,
  MSG_PROJECT_VERIFICATION_RUNNING,
  MSG_RUN_NOT_FOUND,
  MSG_RUN_SECRET_CHECK_UNAVAILABLE,
  MSG_SANDBOX_VERIFICATION_RUNNING,
  MSG_SECRET_CHECK_UNAVAILABLE,
  MSG_TASK_NOT_FOUND,
  MSG_TOO_MANY_COMMANDS,
  MSG_VERIFICATION_CORE_BUSY,
  MSG_VERIFICATION_IDENTITY,
  MSG_VERIFICATION_NOT_BOUND,
  MSG_VERIFICATION_SANDBOX_BUSY,
  MSG_VERIFICATION_SANDBOX_CHANGED,
  MSG_VERIFICATION_SHUTTING_DOWN,
  MSG_VERIFICATION_TASK_BUSY,
  MSG_VERSION_UNREADABLE,
  NOT_BOUND_REASON,
  OUTCOMES,
  RUN_SCOPE_SENTENCE,
  SECRET_REFUSAL_HINT,
  UNSUPPORTED_VERSION_COPY,
  VERIFICATION_FEATURE,
  VERIFICATION_LANGUAGE,
  VERIFICATION_SCHEME,
  VERIFICATION_TEMPLATES,
  approveConfirmationView,
  argvInputValue,
  argvLiteral,
  confirmStepItems,
  finishedEventSummary,
  outcomeCopy,
  parseArgvInput,
  parseProjectContext,
  parseRunStarted,
  parseVerificationList,
  parseVerificationResult,
  renderResultDocument,
  MSG_PROJECT_ARCHIVED_FOR_VERIFICATION,
  MSG_CONVERSATION_ARCHIVED_FOR_VERIFICATION,
  VERIFICATION_EXTENSION,
  approvedCopy,
  resultDisclosures,
  revokeConfirmationView,
  runBinding,
  runConfirmationView,
  startedEventText,
  verificationErrorView,
} from '../src/vscode/verification';
import { matchesTemplate } from '../src/vscode/gitApply';
import { makeHarness } from './helpers/fakeCore';

const repoRoot = resolve(process.cwd(), '..', '..');
const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), 'utf8');
const rustProtocol = read('core/crates/sandpane-protocol/src/lib.rs');
const serviceVerification = read('core/crates/sandpane-service/src/verification.rs');
const coreVerification = read('core/crates/sandpane-core/src/verification.rs');
const validationRs = read('core/crates/sandpane-core/src/validation.rs');
const processRs = read('core/crates/sandpane-core/src/process.rs');

const ESC = '\u001b';
const BEL = '\u0007';
const RLO = '\u202e';
/** A string the redactor treats as a secret, built at runtime (never a literal token). */
const SECRET_LIKE = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
/** The six A7 methods, in Method::ALL order. */
const A7_METHODS = [
  'verification.list',
  'verification.approve',
  'verification.revoke',
  'verification.run',
  'verification.result',
  'project.context',
];

const rpc = (code: string, message: string, details?: unknown): CoreRpcError =>
  new CoreRpcError({ code: code as ErrorCode, message, ...(details !== undefined ? { details } : {}) }, 'r1');

/** Rust `\`-newline string continuations joined (whitespace after them dropped). */
const joined = (source: string): string => source.replace(/\\\n\s*/g, '');

/** A Rust `pub const NAME: &str = "…";` value. */
function rustConst(source: string, name: string): string {
  const m = new RegExp(`pub const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)";`).exec(source);
  if (!m?.[1]) throw new Error(`no \`pub const ${name}\``);
  return joined(m[1]).replace(/\\"/g, '"');
}

/** The first `format!("…"` after `anchor`, placeholders normalized to `{}`. */
function rustFormatAfter(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`no ${anchor}`);
  const m = /format!\(\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(joined(source.slice(start)));
  if (!m?.[1]) throw new Error(`no format! after ${anchor}`);
  return m[1].replace(/\\"/g, '"').replace(/\{[A-Za-z_]*(?::\?)?\}/g, '{}');
}

function struct(name: string): string {
  const start = rustProtocol.indexOf(`pub struct ${name} {`);
  if (start < 0) throw new Error(`no struct ${name}`);
  return rustProtocol.slice(start, rustProtocol.indexOf('\n}\n', start));
}

const camel = (snake: string): string => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Run one wrapper on a live fake connection; answer any written frame with `ok`. */
async function frameOf(call: (c: CoreCommands) => Promise<unknown>, ok: unknown = {}, requestTimeoutMs = 15_000) {
  const h = makeHarness({ requestTimeoutMs });
  await h.conn.connect();
  const commands = new CoreCommands(h.conn);
  const before = h.transport.writes.length;
  const promise = call(commands).catch((error: unknown) => error);
  await Promise.resolve();
  if (h.transport.writes.length === before) return { frame: undefined, error: await promise, timers: [] as number[] };
  const frame = h.transport.lastRequest();
  const timers = h.timers.pending.map((t) => t.ms);
  h.transport.respond({ v: PROTOCOL_VERSION, id: frame.id, ok });
  await promise;
  return { frame, error: undefined, timers };
}

const ARGV_WEIRD = ['printf', 'a\tb', 'line\nbreak', 'say "hi"', 'é中🙂', ' leading space', '', '$(id)', '*', '--privileged'];

describe('A7 wire: exact frames', () => {
  it('verification.list {projectId}, default deadline', async () => {
    const { frame, timers } = await frameOf((c) => c.verificationList('p1'), { commands: [] });
    expect(frame).toEqual({ v: PROTOCOL_VERSION, id: 'test-1', method: 'verification.list', params: { projectId: 'p1' } });
    expect(timers).toEqual([15_000]);
  });

  it('verification.approve {projectId, label, argv} with every argv element byte-exact (tab, newline, quote, non-ASCII, leading space, empty)', async () => {
    const { frame, timers } = await frameOf((c) =>
      c.verificationApprove({ projectId: 'p1', label: 'unit tests', argv: [...ARGV_WEIRD] }),
    );
    expect(frame).toEqual({
      v: PROTOCOL_VERSION,
      id: 'test-1',
      method: 'verification.approve',
      params: { projectId: 'p1', label: 'unit tests', argv: ARGV_WEIRD },
    });
    expect((frame?.params as { argv: string[] }).argv[5]).toBe(' leading space');
    expect(Object.keys(frame?.params as object)).toEqual(['projectId', 'label', 'argv']);
    expect(timers).toEqual([15_000]);
  });

  it('approve sends the label trimmed exactly like Rust str::trim (U+FEFF kept, U+3000 trimmed)', async () => {
    const { frame } = await frameOf((c) =>
      c.verificationApprove({ projectId: 'p1', label: '\u3000 unit tests \t', argv: ['cargo', 'test'] }),
    );
    expect((frame?.params as { label: string }).label).toBe('unit tests');
    expect(validateVerificationLabel('\ufeffx')).toBe('\ufeffx');
  });

  it('a smuggled extra field is never forwarded by approve / run', async () => {
    const approve = await frameOf((c) =>
      c.verificationApprove({ projectId: 'p1', label: 'x', argv: ['x'], shell: 'sh -c' } as never),
    );
    expect(Object.keys(approve.frame?.params as object)).toEqual(['projectId', 'label', 'argv']);
    const run = await frameOf((c) =>
      c.verificationRun({
        taskId: 't1',
        commandId: 'cmd-1',
        expectedSandboxName: 'atlas-box',
        expectedWorkspaceMode: 'sbx_clone',
        idempotencyKey: 'k1',
        argv: ['rm', '-rf', '/'],
      } as never),
    );
    expect(run.frame?.params).not.toHaveProperty('argv');
  });

  it('verification.revoke {commandId}, default deadline', async () => {
    const { frame, timers } = await frameOf((c) => c.verificationRevoke('cmd-1'), { revoked: true });
    expect(frame?.method).toBe('verification.revoke');
    expect(frame?.params).toEqual({ commandId: 'cmd-1' });
    expect(timers).toEqual([15_000]);
  });

  it('verification.run {taskId, commandId, expectedSandboxName, expectedWorkspaceMode, idempotencyKey} in fingerprint order, 45 s deadline', async () => {
    const { frame, timers } = await frameOf((c) =>
      c.verificationRun({
        taskId: 't1',
        commandId: 'cmd-1',
        expectedSandboxName: 'Atlas.Demo',
        expectedWorkspaceMode: 'direct_mount',
        idempotencyKey: '0123456789abcdef0123456789abcdef',
      }),
    );
    expect(frame?.method).toBe('verification.run');
    expect(Object.keys(frame?.params as object)).toEqual([
      'taskId',
      'commandId',
      'expectedSandboxName',
      'expectedWorkspaceMode',
      'idempotencyKey',
    ]);
    expect(frame?.params).toEqual({
      taskId: 't1',
      commandId: 'cmd-1',
      expectedSandboxName: 'Atlas.Demo',
      expectedWorkspaceMode: 'direct_mount',
      idempotencyKey: '0123456789abcdef0123456789abcdef',
    });
    expect(timers).toEqual([VERIFICATION_RUN_TIMEOUT_MS]);
    expect(VERIFICATION_RUN_TIMEOUT_MS).toBe(45_000);
  });

  it('verification.run refuses locally an unknown workspace mode, an invalid sandbox name and a bad key (never sends)', async () => {
    for (const bad of [
      { expectedWorkspaceMode: 'weird' },
      { expectedSandboxName: 'bad name' },
      { idempotencyKey: 'has space' },
      { commandId: '' },
    ]) {
      const { frame, error } = await frameOf((c) =>
        c.verificationRun({
          taskId: 't1',
          commandId: 'cmd-1',
          expectedSandboxName: 'atlas-box',
          expectedWorkspaceMode: 'sbx_clone',
          idempotencyKey: 'k1',
          ...bad,
        } as never),
      );
      expect(frame, JSON.stringify(bad)).toBeUndefined();
      expect(error).toBeInstanceOf(CoreValidationError);
    }
  });

  it('verification.result {runId}, default deadline', async () => {
    const { frame, timers } = await frameOf((c) => c.verificationResult('run-1'));
    expect(frame?.method).toBe('verification.result');
    expect(frame?.params).toEqual({ runId: 'run-1' });
    expect(timers).toEqual([15_000]);
  });

  it('project.context {projectId}, 45 s deadline (it reads files)', async () => {
    const { frame, timers } = await frameOf((c) => c.projectContext('p1'), { repositories: [], approved: [] });
    expect(frame?.method).toBe('project.context');
    expect(frame?.params).toEqual({ projectId: 'p1' });
    expect(timers).toEqual([45_000]);
    expect(PROJECT_CONTEXT_TIMEOUT_MS).toBe(GIT_QUERY_TIMEOUT_MS);
  });
});

describe('A7 validators: never stricter than Core, never echo a value', () => {
  const refused = (argv: unknown): string => {
    try {
      validateVerificationArgv(argv as string[]);
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      return (error as Error).message;
    }
    throw new Error(`accepted: ${JSON.stringify(argv)}`);
  };

  it('accepts what Core accepts: tab, newline, empty non-first, shell metacharacters, flags after argv[0], exact byte caps', () => {
    expect(validateVerificationArgv([...ARGV_WEIRD])).toEqual(ARGV_WEIRD);
    expect(validateVerificationArgv(['sh', '-c', 'a && b | c $(d) `e`'])).toHaveLength(3);
    // 2048 × "é" = 4096 UTF-8 bytes: exactly the per-element cap.
    expect(() => validateVerificationArgv(['echo', 'é'.repeat(2048)])).not.toThrow();
    expect(() => validateVerificationArgv(Array.from({ length: 64 }, (_, i) => `a${i}`))).not.toThrow();
    // 4 × 4096 = 16 KiB total — exactly the whole-argv cap.
    expect(() => validateVerificationArgv(['x'.repeat(4096), 'x'.repeat(4096), 'x'.repeat(4096), 'x'.repeat(4096)])).not.toThrow();
    // No client-side secret check: Core is the authority (and the live probe needs Core's verdict).
    expect(() => validateVerificationArgv(['gh', SECRET_LIKE])).not.toThrow();
    // Core does not refuse format characters in argv (they are revealed when shown).
    expect(() => validateVerificationArgv(['echo', `a${RLO}b`])).not.toThrow();
  });

  it('refuses what Core refuses, naming the argument NUMBER only', () => {
    expect(refused([])).toMatch(/1 to 64 elements/);
    expect(refused(Array.from({ length: 65 }, () => 'a'))).toMatch(/1 to 64 elements/);
    expect(refused([''])).toMatch(/argument 1 \(the program\) is empty/);
    expect(refused(['-rf'])).toMatch(/argument 1 \(the program\) must not start with '-'/);
    expect(refused(['make', 'a\u0000b'])).toMatch(/argument 2 contains a NUL character/);
    expect(refused(['make', `x${ESC}[31m`])).toMatch(/argument 2 contains a control character/);
    expect(refused(['make', 'a\rb'])).toMatch(/argument 2 contains a control character/);
    expect(refused(['make', 'a\u007fb'])).toMatch(/argument 2 contains a control character/);
    expect(refused(['make', 'a\u0085b'])).toMatch(/argument 2 contains a control character/);
    expect(refused(['echo', 'é'.repeat(2049)])).toMatch(/argument 2 is longer than 4096 bytes/);
    expect(refused(['x'.repeat(4096), 'x'.repeat(4096), 'x'.repeat(4096), 'x'.repeat(4096), 'y'])).toMatch(
      /longer than 16384 bytes in total/,
    );
    expect(refused(['echo', 'ok\ud800'])).toMatch(/argument 2/);
    expect(refused(['echo', 3])).toMatch(/argument 2/);
    // A refusal never echoes the value.
    const marker = 'VALUE-MARKER';
    expect(refused(['make', `${marker}${ESC}`])).not.toContain(marker);
  });

  it('labels: Rust trim, 1..=80 chars (code points), no control or bidi character', () => {
    expect(validateVerificationLabel('  unit tests ')).toBe('unit tests');
    expect(validateVerificationLabel('🙂'.repeat(80))).toBe('🙂'.repeat(80));
    for (const bad of ['', '   ', 'x'.repeat(81), 'a\nb', 'a\tb', `a${RLO}b`, 'a\u2028b', 'a\u0085b']) {
      expect(() => validateVerificationLabel(bad), JSON.stringify(bad)).toThrow(CoreValidationError);
    }
  });
});

describe('A7 drift: Rust sources', () => {
  it('the six methods sit after git.apply in Method::ALL order (34 in total)', () => {
    expect(CORE_METHODS).toHaveLength(34);
    expect(CORE_METHODS.slice(28)).toEqual(A7_METHODS);
    expect(CORE_METHODS[27]).toBe('git.apply');
    const all = rustProtocol.slice(rustProtocol.indexOf('pub const ALL: [Method; 34]'));
    const order = ['VerificationList', 'VerificationApprove', 'VerificationRevoke', 'VerificationRun', 'VerificationResult', 'ProjectContext'];
    let at = all.indexOf('Self::GitApply,');
    for (const variant of order) {
      const next = all.indexOf(`Self::${variant},`, at);
      expect(next, variant).toBeGreaterThan(at);
      at = next;
    }
  });

  it('"verification" is a known feature, last of Rust FEATURES (6)', () => {
    expect(VERIFICATION_FEATURE).toBe('verification');
    expect(KNOWN_FEATURES).toHaveLength(6);
    expect(KNOWN_FEATURES[5]).toBe('verification');
    expect(rustProtocol).toMatch(/pub const FEATURES: \[&str; 6\] = \[[\s\S]*"git-apply",\s*"verification",\s*\];/);
  });

  it('argv / label bounds equal sandpane-core validation.rs', () => {
    expect(validationRs).toContain(`pub const MAX_VERIFICATION_LABEL_CHARS: usize = ${MAX_VERIFICATION_LABEL_CHARS};`);
    expect(validationRs).toContain(`pub const MAX_VERIFICATION_ARGS: usize = ${MAX_VERIFICATION_ARGS};`);
    expect(validationRs).toContain(`pub const MAX_VERIFICATION_ARG_BYTES: usize = ${MAX_VERIFICATION_ARG_BYTES};`);
    expect(validationRs).toContain('pub const MAX_VERIFICATION_ARGV_BYTES: usize = 16 * 1024;');
    expect(MAX_VERIFICATION_ARGV_BYTES).toBe(16 * 1024);
    // The client's shape messages are Core's own wording (InvalidShape reasons).
    for (const fragment of [
      'argv must have 1 to {MAX_VERIFICATION_ARGS} elements (it has {})',
      'argument {n} is longer than {MAX_VERIFICATION_ARG_BYTES} bytes',
      'argument {n} contains a NUL character',
      'argument {n} contains a control character',
      'argv is longer than {MAX_VERIFICATION_ARGV_BYTES} bytes in total',
      "argument 1 (the program) is empty",
      "argument 1 (the program) must not start with '-'",
    ]) {
      expect(joined(validationRs), fragment).toContain(fragment);
    }
  });

  it('exact messages equal sandpane-service / sandpane-core verification.rs', () => {
    const pairs: [string, string, string][] = [
      [serviceVerification, 'MSG_VERIFICATION_NOT_BOUND', MSG_VERIFICATION_NOT_BOUND],
      [serviceVerification, 'MSG_VERIFICATION_SANDBOX_CHANGED', MSG_VERIFICATION_SANDBOX_CHANGED],
      [serviceVerification, 'MSG_VERIFICATION_IDENTITY', MSG_VERIFICATION_IDENTITY],
      [serviceVerification, 'MSG_VERIFICATION_TASK_BUSY', MSG_VERIFICATION_TASK_BUSY],
      [serviceVerification, 'MSG_VERIFICATION_SANDBOX_BUSY', MSG_VERIFICATION_SANDBOX_BUSY],
      [serviceVerification, 'MSG_VERIFICATION_CORE_BUSY', MSG_VERIFICATION_CORE_BUSY],
      [serviceVerification, 'MSG_VERIFICATION_SHUTTING_DOWN', MSG_VERIFICATION_SHUTTING_DOWN],
      [serviceVerification, 'MSG_COMMAND_NOT_FOUND', MSG_COMMAND_NOT_FOUND],
      [serviceVerification, 'MSG_COMMAND_REVOKED', MSG_COMMAND_REVOKED],
      [serviceVerification, 'MSG_COMMAND_OTHER_PROJECT', MSG_COMMAND_OTHER_PROJECT],
      [serviceVerification, 'MSG_RUN_NOT_FOUND', MSG_RUN_NOT_FOUND],
      [serviceVerification, 'MSG_TASK_NOT_FOUND', MSG_TASK_NOT_FOUND],
      [serviceVerification, 'MSG_TOO_MANY_COMMANDS', MSG_TOO_MANY_COMMANDS],
      [serviceVerification, 'MSG_VERSION_UNREADABLE', MSG_VERSION_UNREADABLE],
      [serviceVerification, 'MSG_PROJECT_VERIFICATION_RUNNING', MSG_PROJECT_VERIFICATION_RUNNING],
      [serviceVerification, 'MSG_CONVERSATION_VERIFICATION_RUNNING', MSG_CONVERSATION_VERIFICATION_RUNNING],
      [serviceVerification, 'MSG_SANDBOX_VERIFICATION_RUNNING', MSG_SANDBOX_VERIFICATION_RUNNING],
      [serviceVerification, 'MSG_COMMAND_NO_LONGER_PASSES', MSG_COMMAND_NO_LONGER_PASSES],
      [serviceVerification, 'MSG_RUN_SECRET_CHECK_UNAVAILABLE', MSG_RUN_SECRET_CHECK_UNAVAILABLE],
      [coreVerification, 'MSG_SECRET_CHECK_UNAVAILABLE', MSG_SECRET_CHECK_UNAVAILABLE],
      [coreVerification, 'SECRET_REFUSAL_HINT', SECRET_REFUSAL_HINT],
    ];
    for (const [source, name, value] of pairs) expect(value, name).toBe(rustConst(source, name));
  });

  it('message templates equal the Rust format strings', () => {
    expect(VERIFICATION_TEMPLATES.exec_unverified).toBe(rustFormatAfter(serviceVerification, 'pub fn msg_exec_unverified('));
    expect(VERIFICATION_TEMPLATES.sandbox_not_running).toBe(rustFormatAfter(serviceVerification, 'pub fn msg_sandbox_not_running('));
    expect(VERIFICATION_TEMPLATES.repo_busy).toBe(rustFormatAfter(serviceVerification, 'pub fn msg_verification_repo_busy('));
    expect(VERIFICATION_TEMPLATES.shape_no_longer_passes).toBe(
      rustFormatAfter(serviceVerification, 'pub fn msg_command_shape_no_longer_passes('),
    );
    expect(VERIFICATION_TEMPLATES.frame_refusal).toBe(rustFormatAfter(serviceVerification, 'fn frame_refusal('));
    expect(VERIFICATION_TEMPLATES.secret_argument).toBe(rustFormatAfter(coreVerification, 'Self::Argument { number, kinds } =>'));
    expect(VERIFICATION_TEMPLATES.secret_label).toBe(rustFormatAfter(coreVerification, 'Self::Label { kinds } =>'));
    expect(VERIFICATION_TEMPLATES.secret_combined).toBe(rustFormatAfter(coreVerification, 'Self::Combined { kinds } =>'));
  });

  it('event kinds and outcomes equal the Rust constants (open strings)', () => {
    expect(VERIFICATION_EVENT_KINDS.started).toBe(rustConst(serviceVerification, 'EVENT_VERIFICATION_STARTED'));
    expect(VERIFICATION_EVENT_KINDS.finished).toBe(rustConst(serviceVerification, 'EVENT_VERIFICATION_FINISHED'));
    for (const [name, value] of Object.entries(OUTCOMES)) {
      expect(value, name).toBe(rustConst(coreVerification, `OUTCOME_${name.toUpperCase()}`));
    }
    expect(Object.keys(OUTCOMES)).toHaveLength(8);
  });

  it('A7 wire fields exist in Rust (camelCase) and in the TS types', () => {
    const protocolTs = read('clients/vscode/src/core-client/protocol.ts');
    const fields: Record<string, string[]> = {
      VerificationCommand: ['id', 'project_id', 'label', 'argv', 'approved_at'],
      VerificationApproveParams: ['project_id', 'label', 'argv'],
      VerificationRunParams: ['task_id', 'command_id', 'expected_sandbox_name', 'expected_workspace_mode', 'idempotency_key'],
      VerificationRunResult: ['run_id', 'started_sequence', 'replayed'],
      OutputRedaction: ['best_effort', 'replacements', 'by_kind', 'output_withheld'],
      VerificationResult: [
        'run_id', 'task_id', 'command_id', 'label', 'argv', 'sandbox', 'workspace_mode', 'outcome', 'exit_code',
        'stdout', 'stderr', 'stdout_truncated', 'stderr_truncated', 'redactions', 'elapsed_ms', 'started_at',
        'finished_at', 'output_incomplete',
      ],
      DetectedManifest: ['manifest', 'suggested_commands', 'notes'],
      RepositoryContext: ['repo_path', 'detected', 'unreadable'],
      ProjectContextResult: ['repositories', 'approved'],
    };
    for (const [name, list] of Object.entries(fields)) {
      const body = struct(name);
      for (const field of list) {
        expect(body, `${name}.${field}`).toMatch(new RegExp(`pub ${field}:`));
        expect(protocolTs, `${name}.${camel(field)} in protocol.ts`).toMatch(new RegExp(`\\b${camel(field)}\\??:`));
      }
    }
  });

  it("45 s run deadline stays above Core's pre-start gates (sbx version PROBE + sbx ls QUERY)", () => {
    const secs = (name: string): number => {
      const start = processRs.indexOf(`pub const ${name}: RunLimits`);
      const m = /timeout: Duration::from_secs\((\d+)\)/.exec(processRs.slice(start));
      if (start < 0 || !m?.[1]) throw new Error(`no RunLimits::${name}`);
      return Number(m[1]);
    };
    expect(serviceVerification).toContain('.run_in(ctx, &inner.sbx_limits.probe)');
    expect(serviceVerification).toContain('.run_in(ctx, &inner.sbx_limits.query)');
    expect((secs('PROBE') + secs('QUERY')) * 1000).toBeLessThan(VERIFICATION_RUN_TIMEOUT_MS);
  });
});

describe('A7 decode (tolerant of absence; open strings)', () => {
  const cmd = { id: 'cmd-1', projectId: 'p1', label: 'unit tests', argv: ['cargo', 'test'], approvedAt: '2026-10-12T10:00:00Z' };

  it('verification.list: commands decoded; a malformed row or answer is null (never echoed)', () => {
    expect(parseVerificationList({ commands: [cmd] })).toEqual([cmd]);
    expect(parseVerificationList({ commands: [] })).toEqual([]);
    expect(parseVerificationList({ commands: [{ ...cmd, argv: 'cargo test' }] })).toBeNull();
    expect(parseVerificationList({})).toBeNull();
    expect(parseVerificationList([cmd])).toBeNull();
  });

  it('project.context: repositories, detected, suggestions (string[][]), notes, unreadable, approved', () => {
    const raw = {
      repositories: [
        {
          repoPath: '/repo/atlas',
          detected: [{ manifest: 'package.json', suggestedCommands: [['npm', 'run', 'test']], notes: ['npm run test runs: vitest'] }],
          unreadable: ['Cargo.toml'],
        },
      ],
      approved: [cmd],
    };
    expect(parseProjectContext(raw)).toEqual(raw);
    expect(parseProjectContext({ repositories: [{ repoPath: '/r', detected: [{ manifest: 'm', suggestedCommands: [[1]], notes: [] }], unreadable: [] }], approved: [] })).toBeNull();
    expect(parseProjectContext({ repositories: [] })).toBeNull();
  });

  it('verification.result: outcome is open; optional fields absent while running', () => {
    const running = {
      runId: 'run-1', taskId: 't1', commandId: 'cmd-1', label: 'unit tests', argv: ['cargo', 'test'], sandbox: 'atlas-box',
      workspaceMode: 'sbx_clone', outcome: 'running', stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
      redactions: { bestEffort: true, replacements: 0, byKind: {} }, startedAt: '2026-10-12T10:00:00Z',
    };
    expect(parseVerificationResult(running)).toEqual(running);
    const future = { ...running, outcome: 'quantum_state', exitCode: 3, elapsedMs: 10, finishedAt: 'x', outputIncomplete: true, extra: 1 };
    expect(parseVerificationResult(future)?.outcome).toBe('quantum_state');
    expect(parseVerificationResult(future)).not.toHaveProperty('extra');
    expect(parseVerificationResult({ ...running, stdout: 3 })).toBeNull();
    expect(parseVerificationResult({ ...running, redactions: null })).toBeNull();
  });

  it('verification.run answer: {runId, startedSequence, replayed?}', () => {
    expect(parseRunStarted({ runId: 'run-1', startedSequence: 7 })).toEqual({ runId: 'run-1', startedSequence: 7 });
    expect(parseRunStarted({ runId: 'run-1', startedSequence: 7, replayed: true })).toEqual({ runId: 'run-1', startedSequence: 7, replayed: true });
    expect(parseRunStarted({ runId: 'run-1' })).toBeNull();
  });
});

describe('A7 argv entry: an explicit list, never a shell split', () => {
  it('literals reveal hidden characters as \\uXXXX and round-trip byte-exact through the JSON input', () => {
    // Elements Core accepts (format characters are allowed in argv; controls other than TAB / LF are not).
    const argv = ['printf', 'a\tb', 'line\nbreak', 'say "hi"', 'é中🙂', ' lead', '', `x${RLO}y`, 'back\\slash', '$(id)', '[a](b)'];
    const value = argvInputValue(argv);
    // No raw hidden character, and no `$(` / `](`, in the editable text.
    for (const ch of ['\t', '\n', RLO, '$(', '](']) expect(value).not.toContain(ch);
    expect(value).toContain('\\u202E');
    expect(parseArgvInput(value)).toEqual({ ok: true, argv });
    // Elements Core refuses still serialize revealed and exact (JSON round trip).
    const refusedByCore = [`e${ESC}[31m`, '\u0085', '\ud800', '\u{E0041}'];
    const literal = argvInputValue(refusedByCore);
    for (const ch of [ESC, '\u0085', '\u{E0041}']) expect(literal).not.toContain(ch);
    expect(JSON.parse(literal)).toEqual(refusedByCore);
    expect(parseArgvInput(literal)).toMatchObject({ ok: false });
    expect(argvLiteral(' lead')).toBe('" lead"');
    expect(argvLiteral('')).toBe('""');
    expect(argvLiteral('  ')).toBe('"  "');
    expect(argvLiteral('a"b')).toBe('"a\\"b"');
  });

  it('a non-JSON or non-string-array input is refused with a reason (never split on spaces)', () => {
    expect(parseArgvInput('npm run test')).toMatchObject({ ok: false });
    expect(parseArgvInput('["npm", 1]')).toMatchObject({ ok: false });
    expect(parseArgvInput('{"a":1}')).toMatchObject({ ok: false });
    expect(parseArgvInput('[]')).toMatchObject({ ok: false });
    const bad = parseArgvInput('["make", "a\\u0000b"]');
    expect(bad.ok).toBe(false);
  });
});

describe('A7 outcomes: honest copy (I4: exit 0 is never "passed" or green)', () => {
  const neverJudged = (text: string): void => {
    expect(text).not.toMatch(/\bpass(ed)?\b|\bsuccess|\bsucceeded\b|\btests? failed\b|\bfailed\b/i);
  };

  it('exited: "exit status N (as reported by sbx exec)" for 0 and non-zero alike', () => {
    expect(outcomeCopy('exited', 0)).toBe('exit status 0 (as reported by sbx exec)');
    expect(outcomeCopy('exited', 7)).toBe('exit status 7 (as reported by sbx exec)');
    neverJudged(outcomeCopy('exited', 0));
    neverJudged(outcomeCopy('exited', 1));
  });

  it('each other outcome', () => {
    expect(outcomeCopy('signaled')).toBe('ended by a signal (no exit status)');
    expect(outcomeCopy('timed_out')).toBe('stopped after 10 minutes; the command may still be running inside the sandbox');
    expect(outcomeCopy('interrupted')).toBe(
      'Core restarted (or stopped) while this ran; the result is unknown; the command may still be running inside the sandbox',
    );
    expect(outcomeCopy('possibly_sbx_error', 1)).toBe(
      "possibly sbx's own error, or the command's own output (exit status 1 as reported by sbx exec)",
    );
    expect(outcomeCopy('spawn_failed')).toMatch(/could not start sbx exec/);
    expect(outcomeCopy('read_failed')).toMatch(/could not read the command's output/);
    expect(outcomeCopy('running')).toBe('still running (Core has recorded no result yet)');
    for (const outcome of Object.values(OUTCOMES)) {
      if (outcome === 'spawn_failed' || outcome === 'read_failed') continue;
      neverJudged(outcomeCopy(outcome, 0));
    }
  });

  it('an unknown outcome is shown as-is (revealed), never mapped', () => {
    expect(outcomeCopy(`weird${ESC}[32m`)).toBe('outcome "weird\\u001B[32m" (not known to this client; shown as Core reported it)');
  });

  it('disclosures: truncation, incomplete output, withheld output, redactions', () => {
    const all = resultDisclosures({
      stdoutTruncated: true,
      stderrTruncated: true,
      outputIncomplete: true,
      redactions: { bestEffort: true, replacements: 3, byKind: { 'auth-header': 3 }, outputWithheld: true },
    });
    expect(all).toContain('stdout was truncated at 64 KiB');
    expect(all).toContain('stderr was truncated at 64 KiB');
    expect(all).toContain('output may be incomplete: a process kept the output open after the command exited');
    expect(all).toContain('output was not stored because the secret check was unavailable');
    expect(all).toContain('3 values were redacted (best effort)');
    expect(resultDisclosures({ stdoutTruncated: false, stderrTruncated: false, redactions: { bestEffort: true, replacements: 0, byKind: {} } })).toEqual([]);
    expect(resultDisclosures({ redactions: { bestEffort: true, replacements: 1, byKind: {} } })).toContain('1 value was redacted (best effort)');
  });

  it('a finished event is summarized from its payload (output is never in events)', () => {
    const s = finishedEventSummary({ runId: 'run-1', startedSequence: 3, outcome: 'exited', exitCode: 0, stdoutBytes: 10, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: true, redactions: { bestEffort: true, replacements: 0, byKind: {} }, elapsedMs: 1200, reconciledAfterRestart: false });
    expect(s?.runId).toBe('run-1');
    expect(s?.text).toContain('exit status 0 (as reported by sbx exec)');
    expect(s?.text).toContain('stderr was truncated at 64 KiB');
    expect(finishedEventSummary({ outcome: 'exited' })).toBeNull();
    const reconciled = finishedEventSummary({ runId: 'r', startedSequence: 1, outcome: 'interrupted', reconciledAfterRestart: true });
    expect(reconciled?.text).toMatch(/Core restarted/);
  });

  it('a started event line names the label and argv revealed, never task status', () => {
    const text = startedEventText({ runId: 'r', commandId: 'c', label: `unit${ESC}]8;;https://x${ESC}\\`, argv: ['echo', `a${RLO}b`], sandbox: 'atlas-box', workspaceMode: 'sbx_clone' });
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(RLO);
    expect(text).toContain('\\u001B');
    expect(text).toMatch(/^verification started: /);
  });
});

describe('A7 error copy', () => {
  it('UNSUPPORTED_SBX_VERSION is not a failure of the command: running is disabled until captured; approvals are kept', () => {
    for (const message of [
      'sbx exec argument passing has not been verified for sbx 0.47.0; nothing was run',
      MSG_VERSION_UNREADABLE,
    ]) {
      const view = verificationErrorView(rpc('UNSUPPORTED_SBX_VERSION', message), 'verification.run');
      expect(view?.text).toContain(UNSUPPORTED_VERSION_COPY);
      expect(view?.text).toContain('Nothing was run.');
      expect(view?.text).not.toMatch(/\bfailed\b|upgrade/i);
      expect(view?.lostAnswer).toBe(false);
    }
    expect(UNSUPPORTED_VERSION_COPY).toBe(
      "Running is disabled until this sbx version's `sbx exec` behaviour has been captured and verified; your approved commands are kept.",
    );
  });

  it('a secret refusal shows Core\'s message AND details.hint as advice (not "run it yourself")', () => {
    const message = `argument 2 looks like a secret (github-token); approved commands cannot hold secrets; nothing was approved`;
    expect(matchesTemplate(message, VERIFICATION_TEMPLATES.secret_argument)).toBe(true);
    const view = verificationErrorView(rpc('VALIDATION_FAILED', message, { hint: SECRET_REFUSAL_HINT }), 'verification.approve');
    expect(view?.text).toContain('Not approved');
    expect(view?.text).toContain(message);
    expect(view?.text).toContain(SECRET_REFUSAL_HINT);
    expect(view?.text).not.toMatch(/run it yourself/);
    const label = verificationErrorView(
      rpc('VALIDATION_FAILED', 'the label looks like a secret (jwt); approved commands cannot hold secrets; nothing was approved', { hint: SECRET_REFUSAL_HINT }),
      'verification.approve',
    );
    expect(label?.text).toContain(SECRET_REFUSAL_HINT);
    const unavailable = verificationErrorView(rpc('VALIDATION_FAILED', MSG_SECRET_CHECK_UNAVAILABLE), 'verification.approve');
    expect(unavailable?.text).toMatch(/secret check is unavailable/);
  });

  it('frame refusals: Core\'s text revealed and capped, never retried', () => {
    const message =
      "the response would exceed the frame limit (5000000 bytes, the limit is 4128768); this run's stored output cannot be sent in one frame; nothing was returned";
    expect(matchesTemplate(message, VERIFICATION_TEMPLATES.frame_refusal)).toBe(true);
    const hostile = message.replace('stored output', `stored${ESC}]8;;x output`);
    const view = verificationErrorView(rpc('VALIDATION_FAILED', hostile, { runId: 'run-1' }), 'verification.result');
    expect(view?.text).toContain('too large to send in one Core frame');
    expect(view?.text).not.toContain(ESC);
    expect(view?.text).toContain('\\u001B');
    expect(view?.retrySafely).toBe(false);
  });

  it('gate refusals and conflicts say nothing was run, with Core\'s text', () => {
    for (const [code, message] of [
      ['VALIDATION_FAILED', MSG_VERIFICATION_NOT_BOUND],
      ['VALIDATION_FAILED', MSG_VERIFICATION_SANDBOX_CHANGED],
      ['VALIDATION_FAILED', 'sandbox "atlas-box" is not running; sbx exec would start it; start it with `sbx run` in a terminal; nothing was run'],
      ['CONFLICT', MSG_VERIFICATION_TASK_BUSY],
      ['CONFLICT', MSG_VERIFICATION_CORE_BUSY],
      ['CONFLICT', '/repo/atlas is busy: verification.run:x holds its writer lock (a running writer task, an apply, a worktree discard or another verification); a verification is already running or the repository is being written; nothing was run'],
    ] as const) {
      const view = verificationErrorView(rpc(code, message), 'verification.run');
      expect(view?.text, message).toContain('Nothing was run.');
      expect(view?.text).toContain(message.replace(/\$\(/g, '$ ('));
      expect(view?.lostAnswer).toBe(false);
    }
    expect(verificationErrorView(rpc('NOT_INSTALLED', 'sbx not found'), 'verification.run')?.text).toMatch(/sbx is not installed/);
    expect(verificationErrorView(rpc('NOT_FOUND', MSG_RUN_NOT_FOUND), 'verification.result')?.text).toMatch(/no such verification run/);
    expect(
      verificationErrorView(rpc('CONFLICT', 'idempotency key was already used with different parameters; nothing was run'), 'verification.run')?.text,
    ).toMatch(/already used with different parameters/);
  });

  it('a lost run answer: "may have started", Retry safely offered; never "nothing was run"', () => {
    const view = verificationErrorView(new CoreTransportError('timeout', 'request timed out'), 'verification.run');
    expect(view?.text).toMatch(/may have started/);
    expect(view?.text).not.toMatch(/nothing was run/i);
    expect(view?.lostAnswer).toBe(true);
    expect(view?.retrySafely).toBe(true);
    // Provably unsent: null (the caller says nothing was sent).
    expect(verificationErrorView(new CoreTransportError('not_connected', 'x'), 'verification.run')).toBeNull();
    expect(verificationErrorView(new CoreValidationError('argv', 'x'), 'verification.approve')).toBeNull();
    // A lost approve / revoke answer: may have happened; never retried.
    const approve = verificationErrorView(new CoreTransportError('timeout', 'x'), 'verification.approve');
    expect(approve?.text).toMatch(/may have been approved/);
    expect(approve?.retrySafely).toBe(false);
  });

  it('"$(" and "](" from Core text are broken in every view', () => {
    const view = verificationErrorView(rpc('VALIDATION_FAILED', 'sandbox "$(check)" [x](command:evil) nothing was run'), 'verification.run');
    expect(view?.text).not.toContain('$(');
    expect(view?.text).not.toContain('](');
  });
});

describe('A7 confirmations', () => {
  it('approve lists every element revealed and delimited (empty, leading-space, whitespace-only distinct), the count, the label and both warnings', () => {
    const view = approveConfirmationView({
      projectName: 'Atlas Demo',
      label: `unit ${RLO}tests`,
      argv: ['npm', 'run', '', ' x', '  ', `a${ESC}]52;c;QUJD${BEL}`],
      notes: [`npm run test runs: vitest ${ESC}]8;;https://evil${ESC}\\`],
    });
    const text = `${view.message}\n${view.detail}`;
    expect(view.button).toBe('Approve');
    expect(text).toContain('6 arguments');
    expect(text).toContain('[1] "npm"');
    expect(text).toContain('[3] ""');
    expect(text).toContain('[4] " x"');
    expect(text).toContain('[5] "  "');
    expect(text).toContain(APPROVE_NO_SECRETS);
    expect(text).toContain(APPROVE_BINDING_SENTENCE);
    expect(text).toContain('npm run test runs: vitest');
    for (const raw of [ESC, BEL, RLO]) expect(text).not.toContain(raw);
    expect(APPROVE_NO_SECRETS).toBe('Do not put tokens or passwords in arguments.');
    expect(APPROVE_BINDING_SENTENCE).toBe(
      'Approval binds this exact argument list, not what it executes. Commands such as `npm run test`, `make test` or ' +
        '`./gradlew test` run code from the repository that the agent can change after you approve.',
    );
  });

  it('the second step: Cancel first (the active item), then the explicit confirmation', () => {
    const items = confirmStepItems('Approve exactly these 3 arguments');
    expect(items[0]?.confirm).toBe(false);
    expect(items[0]?.label).toMatch(/^Cancel/);
    expect(items[1]?.confirm).toBe(true);
    expect(items).toHaveLength(2);
  });

  it('run shows the command, sandbox, mode, the fixed scope sentence and the direct_mount / host_worktree warnings', () => {
    const direct = runConfirmationView({
      taskId: 'task-abcdef12',
      label: 'unit tests',
      argv: ['cargo', 'test'],
      sandboxName: 'Atlas.Demo',
      workspaceMode: 'direct_mount',
    });
    const text = `${direct.message}\n${direct.detail}`;
    expect(direct.button).toBe('Run');
    expect(text).toContain('Atlas.Demo');
    expect(text).toContain('direct_mount');
    expect(text).toContain('[1] "cargo"');
    expect(text).toContain(DIRECT_MOUNT_WARNING);
    expect(text).toContain(RUN_SCOPE_SENTENCE);
    expect(DIRECT_MOUNT_WARNING).toBe(
      'this sandbox mounts your repository directly; the command can change your working tree, including `.git/hooks` that later run on your machine',
    );
    expect(RUN_SCOPE_SENTENCE).toBe(
      "Runs in sbx's default working directory inside the sandbox; the result is the exit status reported by sbx exec; not yet verified against a real sbx",
    );
    const worktree = runConfirmationView({ taskId: 't', label: 'l', argv: ['x'], sandboxName: 's1', workspaceMode: 'host_worktree' });
    expect(worktree.detail).toContain(HOST_WORKTREE_WARNING);
    expect(worktree.detail).not.toContain(DIRECT_MOUNT_WARNING);
    expect(runConfirmationView({ taskId: 't', label: 'l', argv: ['x'], sandboxName: 's1', workspaceMode: 'sbx_clone' }).detail).not.toContain(
      HOST_WORKTREE_WARNING,
    );
  });

  it('revoke is a plain confirmation naming the command (revealed)', () => {
    const view = revokeConfirmationView({ id: 'cmd-1', projectId: 'p1', label: `x${RLO}`, argv: ['make', 'test'], approvedAt: 't' });
    expect(view.button).toBe('Revoke');
    expect(`${view.message}\n${view.detail}`).toContain('[2] "test"');
    expect(`${view.message}\n${view.detail}`).not.toContain(RLO);
  });
});

describe('A7 run binding (never chosenSandboxName)', () => {
  const boxes: SandboxSummary[] = [
    { name: 'atlas-box', probedState: 'running', workspaceMode: 'sbx_clone' },
    { name: 'nova-live', probedState: 'running', workspaceMode: 'direct_mount' },
    { name: 'no-mode', probedState: 'running' },
    { name: 'odd-mode', probedState: 'running', workspaceMode: 'weird' as never },
  ];

  it('expected* come from TaskSummary.sandboxName and that sandbox.list entry', () => {
    expect(runBinding({ sandboxName: 'nova-live', chosenSandboxName: 'atlas-box' }, boxes)).toEqual({
      ok: true,
      sandboxName: 'nova-live',
      workspaceMode: 'direct_mount',
    });
  });

  it('no binding (chosenSandboxName only, null, empty): "this task is not bound to a sandbox"', () => {
    for (const task of [{ chosenSandboxName: 'atlas-box' }, { sandboxName: null }, { sandboxName: '' }]) {
      expect(runBinding(task, boxes), JSON.stringify(task)).toEqual({ ok: false, reason: NOT_BOUND_REASON });
    }
    expect(NOT_BOUND_REASON).toBe('this task is not bound to a sandbox');
  });

  it('a BOUND task is never called unbound: a missing list entry and a missing / unknown mode say so (revealed)', () => {
    expect(runBinding({ sandboxName: 'gone' }, boxes)).toEqual({
      ok: false,
      reason: 'the task\'s sandbox "gone" is not in Core\'s sandbox list',
    });
    for (const name of ['no-mode', 'odd-mode']) {
      expect(runBinding({ sandboxName: name }, boxes)).toEqual({
        ok: false,
        reason: `Core has no recorded workspace mode for the task's sandbox "${name}"`,
      });
    }
    const hostile = runBinding({ sandboxName: `x${'\u202e'}y` }, boxes);
    expect(hostile.ok).toBe(false);
    expect(JSON.stringify(hostile)).not.toContain('\u202e');
    expect(hostile.ok ? '' : hostile.reason).toContain('x\\u202Ey');
  });
});

describe('A7 output document (plain text, revealed, never a terminal)', () => {
  const base: VerificationResult = {
    runId: 'run-1',
    taskId: 'task-a',
    commandId: 'cmd-1',
    label: `unit${RLO}tests`,
    argv: ['sh', '-c', `printf '${ESC}]8;;https://evil${ESC}\\\\link'`],
    sandbox: 'atlas-box',
    workspaceMode: 'sbx_clone',
    outcome: 'exited',
    exitCode: 0,
    stdout: `ok\tcol\r\nline2 ${ESC}]8;;https://evil${ESC}\\click${ESC}]8;;${ESC}\\\n${ESC}]52;c;SGVsbG8=${BEL}copied\n${RLO}reversed\u2066x\u2069 $(pass) [a](command:workbench)\n`,
    stderr: `warn${ESC}[31m red\n`,
    stdoutTruncated: true,
    stderrTruncated: false,
    redactions: { bestEffort: true, replacements: 2, byKind: { 'github-token': 2 } },
    elapsedMs: 1500,
    startedAt: '2026-10-12T10:00:00Z',
    finishedAt: '2026-10-12T10:00:02Z',
    outputIncomplete: true,
  };

  it('every C0/C1 control except LF and TAB is escaped visibly (ESC, BEL, CR as \\r), bidi revealed; tabs and lines kept', () => {
    const text = renderResultDocument(base, { linksDisabled: true });
    for (const raw of [ESC, BEL, '\r', RLO, '\u2066', '\u2069']) expect(text).not.toContain(raw);
    expect(text).toContain('ok\tcol\\r');
    expect(text).toContain('\\u001B]8;;https://evil\\u001B\\click');
    expect(text).toContain('\\u001B]52;c;SGVsbG8=\\u0007copied');
    expect(text).toContain('\\u202Ereversed\\u2066x\\u2069');
    expect(text).toContain('warn\\u001B[31m red');
    expect(text.split('\n')).toContain('line2 \\u001B]8;;https://evil\\u001B\\click\\u001B]8;;\\u001B\\');
  });

  it('the header is honest: outcome copy, never "passed", every disclosure, label and argv revealed', () => {
    const text = renderResultDocument(base, { linksDisabled: true });
    expect(text).toContain('exit status 0 (as reported by sbx exec)');
    expect(text).not.toMatch(/\bpassed\b|\bsuccess/i);
    expect(text).toContain('stdout was truncated at 64 KiB');
    expect(text).toContain('output may be incomplete');
    expect(text).toContain('2 values were redacted (best effort)');
    expect(text).toContain('unit\\u202Etests');
    expect(text).toContain('[3] "printf \'\\u001B]8;;https://evil\\u001B\\\\\\\\link\'"');
    expect(text).toContain('read-only');
    expect(text).toContain(RUN_SCOPE_SENTENCE);
  });

  it('W3a: "not linked" is claimed ONLY when editor.links is off for the language; otherwise links are disclosed as untrusted', () => {
    const off = renderResultDocument(base, { linksDisabled: true });
    expect(off).toContain('Nothing in this view is run, linked or written to your repository.');
    const on = renderResultDocument(base, { linksDisabled: false });
    expect(on).not.toMatch(/\blinked\b/);
    expect(on).toContain('Link detection is enabled by a setting');
    expect(on).toContain('links in this output are untrusted');
  });

  it('a withheld or empty output says so; a running result says so', () => {
    const withheld = renderResultDocument(
      {
        ...base,
        stdout: '',
        stderr: '',
        redactions: { bestEffort: true, replacements: 0, byKind: {}, outputWithheld: true },
      },
      { linksDisabled: true },
    );
    expect(withheld).toContain('output was not stored because the secret check was unavailable');
    const running = renderResultDocument(
      { ...base, outcome: 'running', exitCode: undefined, stdout: '', stderr: '', finishedAt: undefined, elapsedMs: undefined },
      { linksDisabled: true },
    );
    expect(running).toContain('still running (Core has recorded no result yet)');
    expect(running).toContain('(no stdout)');
  });

  it('the document scheme and language are dedicated (not plaintext / diff / markdown)', () => {
    expect(VERIFICATION_SCHEME).toBe('sandpane-verification');
    expect(VERIFICATION_LANGUAGE).toBe('sandpane-verification-output');
    const manifest = JSON.parse(read('clients/vscode/package.json')) as {
      contributes: { languages?: { id: string }[]; configurationDefaults?: Record<string, Record<string, unknown>> };
    };
    expect(manifest.contributes.languages?.map((l) => l.id)).toContain(VERIFICATION_LANGUAGE);
    expect(manifest.contributes.configurationDefaults?.[`[${VERIFICATION_LANGUAGE}]`]?.['editor.links']).toBe(false);
  });
});

describe('A7 review fixes (pure)', () => {
  const projectLifecycle = read('core/crates/sandpane-service/src/project_lifecycle.rs');
  const conversationLifecycle = read('core/crates/sandpane-service/src/conversation_lifecycle.rs');

  it('W1 drift: the archived messages are Core\'s, and approve / run refuse with them', () => {
    expect(MSG_PROJECT_ARCHIVED_FOR_VERIFICATION).toBe(rustConst(projectLifecycle, 'MSG_PROJECT_ARCHIVED'));
    expect(MSG_CONVERSATION_ARCHIVED_FOR_VERIFICATION).toBe(rustConst(conversationLifecycle, 'MSG_CONVERSATION_ARCHIVED'));
    expect(projectLifecycle).toMatch(/Some\(r\) if r\.archived_at\.is_some\(\) => Err\(\(\s*ErrorCode::ValidationFailed,\s*MSG_PROJECT_ARCHIVED\.to_string\(\),/);
    // approve and run both call require_live_project; run also checks the conversation.
    expect((serviceVerification.match(/project_lifecycle::require_live_project\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(serviceVerification).toContain('return Err(invalid(MSG_CONVERSATION_ARCHIVED));');
  });

  it('W1: an archived project / conversation is named, never "Core refused the label or the arguments"', () => {
    const approve = verificationErrorView(rpc('VALIDATION_FAILED', MSG_PROJECT_ARCHIVED_FOR_VERIFICATION), 'verification.approve');
    expect(approve?.text).toContain('Not approved — this project is archived; unarchive it first.');
    expect(approve?.text).toContain('Nothing was changed.');
    expect(approve?.text).not.toContain('label or the arguments');
    const runProject = verificationErrorView(rpc('VALIDATION_FAILED', MSG_PROJECT_ARCHIVED_FOR_VERIFICATION), 'verification.run');
    expect(runProject?.text).toContain('Not run — this project is archived; unarchive it first.');
    expect(runProject?.text).not.toContain('Core refused before starting anything');
    const runConversation = verificationErrorView(rpc('VALIDATION_FAILED', MSG_CONVERSATION_ARCHIVED_FOR_VERIFICATION), 'verification.run');
    expect(runConversation?.text).toContain("Not run — the task's conversation is archived; unarchive it first.");
    expect(runConversation?.retrySafely).toBe(false);
  });

  it('I2 drift: the INTERNAL run refusals Core emits before anything starts end with "; nothing was run"', () => {
    expect(serviceVerification).toContain('internal(format!("{e}; nothing was run"))');
    expect(serviceVerification).toContain('internal("Core is shutting down; nothing was run")');
    expect(serviceVerification).toMatch(/ErrorCode::Internal,\s*MSG_VERIFICATION_SHUTTING_DOWN\.to_string\(\)/);
    expect(rustConst(serviceVerification, 'MSG_VERIFICATION_SHUTTING_DOWN')).toBe(MSG_VERIFICATION_SHUTTING_DOWN);
  });

  it('I2: an INTERNAL run error whose message says "nothing was run" is definite (no Retry safely); others may have started', () => {
    for (const message of [MSG_VERIFICATION_SHUTTING_DOWN, 'No space left on device (os error 28); nothing was run']) {
      const view = verificationErrorView(rpc('INTERNAL', message), 'verification.run');
      expect(view?.retrySafely, message).toBe(false);
      expect(view?.lostAnswer, message).toBe(false);
      expect(view?.text).toContain('Nothing was run.');
      expect(view?.text).not.toMatch(/may have started/);
    }
    const other = verificationErrorView(rpc('INTERNAL', 'database is locked'), 'verification.run');
    expect(other?.retrySafely).toBe(true);
    expect(other?.text).toMatch(/may have started/);
  });

  it('W3b: the output language owns a dedicated extension and the store uses it (never opened as plaintext first)', () => {
    const manifest = JSON.parse(read('clients/vscode/package.json')) as {
      contributes: { languages: { id: string; extensions?: string[] }[] };
    };
    const language = manifest.contributes.languages.find((l) => l.id === VERIFICATION_LANGUAGE);
    expect(language?.extensions).toEqual([VERIFICATION_EXTENSION]);
    expect(VERIFICATION_EXTENSION).toBe('.sandpane-verification');
  });

  it('I7: an approve answer that names an already-approved command says so', () => {
    expect(approvedCopy({ label: 'unit tests', argvCount: 2, projectName: 'Atlas Demo', existing: true })).toBe(
      'This command was already approved as «unit tests»; nothing new was approved.',
    );
    expect(approvedCopy({ label: 'u\u202et', argvCount: 1, projectName: 'Atlas Demo', existing: true })).toContain('«u\\u202Et»');
    expect(approvedCopy({ label: 'unit tests', argvCount: 2, projectName: 'Atlas Demo', existing: false })).toMatch(/^Approved "unit tests"/);
  });
});
