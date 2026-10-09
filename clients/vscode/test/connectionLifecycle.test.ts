/**
 * Connection lifecycle regressions (VS Code review bugs 2, 11, 12a):
 *  - connect() during a pending reconnect must not open a second socket;
 *  - callbacks from a superseded transport must never touch the live one;
 *  - an `err` envelope with a code this client cannot name still rejects its
 *    own pending request immediately (no 15 s timeout), raw code preserved.
 */

import { describe, expect, it } from 'vitest';
import { CoreConnection, CoreRpcError, decodeLine } from '../src/core-client/connection';
import { FakeTimers, FakeTransport, flush, makeHarness } from './helpers/fakeCore';

describe('connect() while a reconnect is pending (bug 2)', () => {
  it('cancels the pending backoff timer and opens exactly one new transport', async () => {
    const h = makeHarness();
    h.failConnect = true;
    await h.conn.connect().catch(() => undefined);
    expect(h.conn.connectionState).toBe('reconnecting');
    expect(h.timers.pending).toHaveLength(1);

    h.failConnect = false;
    await h.conn.connect();
    expect(h.conn.connectionState).toBe('online');
    expect(h.transports).toHaveLength(2);
    // The backoff timer that would have opened a THIRD socket is gone.
    expect(h.timers.pending).toHaveLength(0);
    h.timers.runAll();
    await flush();
    expect(h.transports).toHaveLength(2);
  });

  it('shares one in-flight open between concurrent connect() calls', async () => {
    const h = makeHarness();
    const a = h.conn.connect();
    const b = h.conn.connect();
    await Promise.all([a, b]);
    expect(h.transports).toHaveLength(1);
    expect(h.conn.connectionState).toBe('online');
  });

  it('closes the superseded transport when a new one is opened', async () => {
    const h = makeHarness();
    await h.conn.connect();
    const first = h.transport;
    first.emitClose(new Error('core restarted'));
    expect(h.conn.connectionState).toBe('reconnecting');
    await h.conn.connect();
    expect(h.transports).toHaveLength(2);
    expect(first.closed).toBe(true);
  });
});

describe('stale transport callbacks are ignored (bug 2)', () => {
  it('a late close from an old transport does not drop the live connection', async () => {
    const h = makeHarness();
    await h.conn.connect();
    const old = h.transport;
    old.emitClose(new Error('drop'));
    h.timers.runNext();
    await flush();
    expect(h.conn.connectionState).toBe('online');
    const live = h.transport;
    expect(live).not.toBe(old);

    const pending = h.conn.request<string>('project.list', {});
    // The superseded socket fires its close (again) and even some data.
    old.emitClose(new Error('late close of the old socket'));
    old.respond({ v: 1, id: 'test-1', ok: 'from the wrong socket' });
    expect(h.conn.connectionState).toBe('online');
    expect(h.timers.pending.filter((t) => t.ms !== 5_000)).toHaveLength(0); // no reconnect armed

    live.respond({ v: 1, id: 'test-1', ok: 'from the live socket' });
    await expect(pending).resolves.toBe('from the live socket');
  });

  it('a failed start that later reports close schedules only one reconnect', async () => {
    const h = makeHarness();
    h.failConnect = true;
    await h.conn.connect().catch(() => undefined);
    const failed = h.transport;
    expect(h.timers.pending).toHaveLength(1);
    // Real sockets emit 'close' after the connect error: must be inert.
    failed.emitClose(new Error('close after ECONNREFUSED'));
    expect(h.timers.pending).toHaveLength(1);
  });
});

describe('unrecognized error codes still correlate (bug 11)', () => {
  it('decodes an err with an unknown code as a response, keeping the raw code', () => {
    const parsed = decodeLine('{"v":1,"id":"r1","err":{"code":"BRAND_NEW","message":"later Core"}}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.frame.kind === 'response') {
      expect(parsed.frame.response.err?.code).toBe('INTERNAL');
      expect(parsed.frame.response.err?.message).toContain('BRAND_NEW');
      expect(parsed.frame.response.err?.message).toContain('later Core');
      expect(parsed.frame.response.err?.details).toMatchObject({ unrecognizedCode: 'BRAND_NEW' });
    }
  });

  it('rejects the pending request immediately instead of timing out', async () => {
    const h = makeHarness({ requestTimeoutMs: 15_000 });
    await h.conn.connect();
    const pending = h.conn.request('project.list', {});
    h.transport.respond({ v: 1, id: 'test-1', err: { code: 'RATE_LIMITED', message: 'slow down' } });
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreRpcError);
    expect((error as CoreRpcError).message).toContain('RATE_LIMITED');
    expect(h.timers.pending).toHaveLength(0); // the request timer was cleared
  });

  it('an err without a message still rejects its request', async () => {
    const h = makeHarness();
    await h.conn.connect();
    const pending = h.conn.request('project.list', {});
    h.transport.respond({ v: 1, id: 'test-1', err: { code: 'INTERNAL' } });
    await expect(pending).rejects.toBeInstanceOf(CoreRpcError);
  });
});

describe('a drop while the reconnect hook is still loading', () => {
  it('the backoff timer opens a NEW transport instead of reusing the finished open', async () => {
    const timers = new FakeTimers();
    const transports: FakeTransport[] = [];
    const pendingHooks: (() => void)[] = [];
    const conn = new CoreConnection({
      transportFactory: () => {
        const t = new FakeTransport();
        transports.push(t);
        return t;
      },
      setTimer: timers.set,
      clearTimer: timers.clear,
      rng: () => 0.5,
      // A slow resubscribe/load that is still pending when the socket drops.
      onReconnect: () => new Promise<void>((resolve) => { pendingHooks.push(resolve); }),
    });
    const connecting = conn.connect();
    await flush();
    expect(conn.connectionState).toBe('online');
    transports[0]?.emitClose(new Error('drop during load'));
    expect(conn.connectionState).toBe('reconnecting');
    timers.runNext();
    await flush();
    expect(transports).toHaveLength(2);
    expect(conn.connectionState).toBe('online');
    for (const release of pendingHooks) release();
    await connecting;
    conn.dispose();
  });
});
