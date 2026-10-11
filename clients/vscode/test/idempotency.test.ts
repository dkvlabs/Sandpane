/**
 * A2 idempotency keys, client side (design 2026-10-09 §3.1): key format and
 * validation (exactly Core's rule), wire shape, CONFLICT classification and
 * copy, unknown-outcome detection, and that nothing is retried automatically.
 * Drift against the Rust source lives in protocolWire.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { CoreRpcError, CoreTransportError } from '../src/core-client/connection';
import {
  CoreCommands,
  CoreValidationError,
  MAX_IDEMPOTENCY_KEY_LEN,
  validateIdempotencyKey,
} from '../src/core-client/commands';
import {
  IDEM_CONFLICT_MISMATCH,
  IDEM_CONFLICT_PENDING,
  IDEM_CONFLICT_UNKNOWN,
  REPLAY_NOTICE,
  RETRY_SAFELY,
  classifyKeyedConflict,
  isProvablyUnsent,
  isUnknownOutcome,
  keyedConflictCopy,
  newIdempotencyKey,
  IDEMPOTENCY_RETENTION_MS,
  SAFE_RETRY_WINDOW_MS,
  safeRetryWindowOpen,
} from '../src/core-client/idempotency';
import { KNOWN_FEATURES, PROTOCOL_VERSION, coreAdvertisesFeature } from '../src/core-client/protocol';
import { makeHarness } from './helpers/fakeCore';

const rpc = (code: string, message: string) => new CoreRpcError({ code: code as 'CONFLICT', message }, 'r1');

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

describe('keys: format, validation, wire', () => {
  it('a fresh key is 32 lowercase hex chars (128 CSPRNG bits) and never repeats', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{32}$/);
      expect(validateIdempotencyKey(key)).toBe(key);
    }
  });

  it('accepts exactly Core\'s rule: 1..=128 of [A-Za-z0-9._-]', () => {
    for (const ok of ['k', 'AZaz09._-', '0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'a'.repeat(MAX_IDEMPOTENCY_KEY_LEN)]) {
      expect(validateIdempotencyKey(ok)).toBe(ok);
    }
    for (const bad of ['', 'a'.repeat(129), 'has space', 'semi;colon', 'slash/x', 'café', 'x\u202Ey', 'tab\tx']) {
      expect(() => validateIdempotencyKey(bad), bad).toThrow(CoreValidationError);
    }
    expect(MAX_IDEMPOTENCY_KEY_LEN).toBe(128);
  });

  it('create and send carry the key only when given one; an invalid key never leaves', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    const created = await frameOf((c) =>
      c.sandboxCreate({ name: 'atlas-box', projectId: 'p1', workspaceMode: 'mountless', idempotencyKey: key }),
    );
    expect(created.frame?.params).toEqual({ name: 'atlas-box', projectId: 'p1', workspaceMode: 'mountless', idempotencyKey: key });
    const sent = await frameOf((c) =>
      c.conversationSend({ conversationId: 'c1', content: 'hi', attachments: [], idempotencyKey: key }),
    );
    expect(sent.frame?.params).toEqual({ conversationId: 'c1', content: 'hi', attachments: [], idempotencyKey: key });
    const unkeyed = await frameOf((c) => c.conversationSend({ conversationId: 'c1', content: 'hi', attachments: [] }));
    expect(Object.keys(unkeyed.frame?.params as object)).not.toContain('idempotencyKey');
    const bad = await frameOf((c) =>
      c.sandboxCreate({ name: 'atlas-box', projectId: 'p1', workspaceMode: 'mountless', idempotencyKey: 'no spaces' }),
    );
    expect(bad.frame).toBeUndefined();
    expect(bad.error).toBeInstanceOf(CoreValidationError);
  });

  it('a timed-out keyed create is not resent by the connection, even after a reconnect', async () => {
    const h = makeHarness({ requestTimeoutMs: 15_000 });
    await h.conn.connect();
    const commands = new CoreCommands(h.conn);
    const pending = commands
      .sandboxCreate({ name: 'atlas-box', projectId: 'p1', workspaceMode: 'mountless', idempotencyKey: 'k-1' })
      .catch((error: unknown) => error);
    const timer = h.timers.pending.find((t) => t.ms === 330_000);
    timer?.fn();
    expect(isUnknownOutcome(await pending)).toBe(true);
    h.transport.emitClose();
    h.timers.runAll();
    await Promise.resolve();
    const creates = h.transports
      .flatMap((t) => t.sentFrames() as { method: string }[])
      .filter((f) => f.method === 'sandbox.create');
    expect(creates).toHaveLength(1);
  });
});

describe('features', () => {
  it('reads features absent-tolerantly and ignores unknown strings', () => {
    expect(KNOWN_FEATURES).toEqual([
      'idempotency-keys',
      'sandbox-create-agent',
      'conversation-sandbox-id',
      'conversation-send-mode',
      'git-apply',
      'verification',
    ]);
    expect(coreAdvertisesFeature({}, 'idempotency-keys')).toBe(false);
    expect(coreAdvertisesFeature(null, 'idempotency-keys')).toBe(false);
    expect(coreAdvertisesFeature({ features: ['x-future', 'idempotency-keys'] }, 'idempotency-keys')).toBe(true);
    expect(coreAdvertisesFeature({ features: ['x-future'] }, 'sandbox-create-agent')).toBe(false);
    // A malformed value from Core is "not advertised", never a crash.
    expect(coreAdvertisesFeature({ features: 'idempotency-keys' as unknown as string[] }, 'idempotency-keys')).toBe(false);
  });
});

describe('CONFLICT classification and copy', () => {
  it('maps the three keyed messages and the A1 name lock by exact prefix', () => {
    expect(classifyKeyedConflict(rpc('CONFLICT', IDEM_CONFLICT_MISMATCH))).toBe('mismatch');
    expect(classifyKeyedConflict(rpc('CONFLICT', IDEM_CONFLICT_PENDING))).toBe('pending');
    expect(classifyKeyedConflict(rpc('CONFLICT', IDEM_CONFLICT_UNKNOWN))).toBe('unknown');
    expect(
      classifyKeyedConflict(rpc('CONFLICT', 'another operation on sandbox "atlas-box" is in progress; nothing was run')),
    ).toBe('name-lock');
    // Other conflicts and other codes are not keyed conflicts.
    expect(classifyKeyedConflict(rpc('CONFLICT', 'task is not cancellable in state completed'))).toBeNull();
    expect(classifyKeyedConflict(rpc('VALIDATION_FAILED', IDEM_CONFLICT_MISMATCH))).toBeNull();
    expect(classifyKeyedConflict(new Error(IDEM_CONFLICT_MISMATCH))).toBeNull();
  });

  it('1, 2 and the name lock say nothing was run; 3 never does and asks for a re-read', () => {
    for (const kind of ['mismatch', 'pending', 'name-lock'] as const) {
      expect(keyedConflictCopy(kind)).toMatch(/Nothing was run/);
    }
    const unknown = keyedConflictCopy('unknown');
    expect(unknown).not.toMatch(/nothing was run/i);
    expect(unknown).toContain('Outcome unknown');
    expect(unknown).toContain('Re-read state first');
    expect(unknown).toContain('a retry needs a new request');
  });
});

describe('unknown outcome detection', () => {
  it('timeout, a dropped connection, a failed write and INTERNAL are unknown; provably-unsent and verdicts are not', () => {
    expect(isUnknownOutcome(new CoreTransportError('timeout', 't'))).toBe(true);
    expect(isUnknownOutcome(new CoreTransportError('closed', 'c'))).toBe(true);
    expect(isUnknownOutcome(new CoreTransportError('send_failed', 's'))).toBe(true);
    expect(isUnknownOutcome(rpc('INTERNAL', 'sbx create failed'))).toBe(true);
    expect(isUnknownOutcome(new CoreTransportError('not_connected', 'n'))).toBe(false);
    expect(isUnknownOutcome(new CoreTransportError('untrusted_socket', 'u'))).toBe(false);
    expect(isUnknownOutcome(rpc('VALIDATION_FAILED', 'bad'))).toBe(false);
    expect(isUnknownOutcome(rpc('CONFLICT', IDEM_CONFLICT_UNKNOWN))).toBe(false);
    expect(isUnknownOutcome(new CoreValidationError('name', 'empty'))).toBe(false);
  });

  it('provably-unsent failures are exactly the ones where no frame left', () => {
    for (const reason of ['not_connected', 'untrusted_socket', 'unsupported_platform'] as const) {
      expect(isProvablyUnsent(new CoreTransportError(reason, 'x'))).toBe(true);
      expect(isUnknownOutcome(new CoreTransportError(reason, 'x'))).toBe(false);
    }
    for (const reason of ['timeout', 'closed', 'send_failed'] as const) {
      expect(isProvablyUnsent(new CoreTransportError(reason, 'x'))).toBe(false);
    }
    expect(isProvablyUnsent(rpc('INTERNAL', 'x'))).toBe(false);
  });

  it('pins the shared user-facing strings', () => {
    expect(RETRY_SAFELY).toBe('Retry safely');
    expect(REPLAY_NOTICE).toBe(
      'Core returned the result of your earlier identical request (replayed). It may be out of date; refreshing from Core.',
    );
  });
});

describe('"Retry safely" window (Core keeps keys for RETENTION_SECS)', () => {
  it('drift: the retention is Core\'s RETENTION_SECS and the window is one hour shorter', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const rust = readFileSync(resolve(__dirname, '..', '..', '..', 'core', 'crates', 'sandpane-core', 'src', 'idempotency.rs'), 'utf8');
    const m = /pub const RETENTION_SECS: u64 = 24 \* 60 \* 60;/.exec(rust);
    expect(m).not.toBeNull();
    expect(IDEMPOTENCY_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
    expect(SAFE_RETRY_WINDOW_MS).toBe(23 * 60 * 60 * 1000);
  });

  it('open only from the first send until 23 h after it; unknown first-send time is closed', () => {
    const t = Date.parse('2026-10-12T12:00:00Z');
    expect(safeRetryWindowOpen(t, t)).toBe(true);
    expect(safeRetryWindowOpen(t, t + SAFE_RETRY_WINDOW_MS - 1)).toBe(true);
    expect(safeRetryWindowOpen(t, t + SAFE_RETRY_WINDOW_MS)).toBe(false);
    expect(safeRetryWindowOpen(undefined, t)).toBe(false);
    // A clock that jumped far backwards cannot prove the age: closed.
    expect(safeRetryWindowOpen(t, t - 2 * 60 * 60 * 1000)).toBe(false);
  });
});
