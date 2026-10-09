import { describe, expect, it } from 'vitest';
import {
  CoreRpcError,
  CoreTransportError,
  FrameTooLargeError,
  UnknownMethodError,
  nextBackoffDelay,
} from '../src/core-client/connection';
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, type CoreMethodName } from '../src/core-client/protocol';
import { makeHarness, flush } from './helpers/fakeCore';

describe('CoreConnection request/response correlation', () => {
  it('writes one frame per request and resolves the matching response', async () => {
    const h = makeHarness();
    await h.conn.connect();
    expect(h.conn.connectionState).toBe('online');

    const pending = h.conn.request<{ protocolVersion: number }>('system.probe', {});
    const sent = h.transport.lastRequest();
    expect(sent).toEqual({ v: PROTOCOL_VERSION, id: 'test-1', method: 'system.probe', params: {} });

    // Two requests in flight, answered out of order: correlation is by id.
    const second = h.conn.request<string[]>('project.list', {});
    expect(h.transport.sentFrames()[1]).toMatchObject({ id: 'test-2', method: 'project.list' });

    h.transport.respond({ v: 1, id: 'test-2', ok: [{ id: 'p1', name: 'Atlas Demo' }] });
    h.transport.respond({ v: 1, id: 'test-1', ok: { protocolVersion: 1 } });

    await expect(second).resolves.toEqual([{ id: 'p1', name: 'Atlas Demo' }]);
    await expect(pending).resolves.toEqual({ protocolVersion: 1 });
  });

  it('rejects with the structured Core error, verbatim code', async () => {
    const h = makeHarness();
    await h.conn.connect();
    const failing = h.conn.request('sandbox.list', {});
    h.transport.respond({
      v: 1,
      id: 'test-1',
      err: { code: 'NOT_INSTALLED', message: 'sbx executable not found' },
    });
    const error = await failing.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreRpcError);
    expect((error as CoreRpcError).code).toBe('NOT_INSTALLED');
    expect((error as CoreRpcError).message).toContain('NOT_INSTALLED');
  });

  it('fails a request on timeout and drops a response that arrives later', async () => {
    const h = makeHarness({ requestTimeoutMs: 1_000 });
    await h.conn.connect();
    const failing = h.conn.request('git.review', { taskId: 't' });
    h.timers.runAll(); // the request timer
    const error = await failing.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreTransportError);
    expect((error as CoreTransportError).reason).toBe('timeout');
    // Late answer: must not resurrect anything or throw.
    h.transport.respond({ v: 1, id: 'test-1', ok: { changes: [] } });
    expect(h.conn.connectionState).toBe('online');
  });

  it('refuses a method outside the allowlisted surface', async () => {
    const h = makeHarness();
    await h.conn.connect();
    // Casting is the point: a caller with user input cannot reach a shell method.
    expect(() => h.conn.request('shell.exec' as unknown as CoreMethodName, { cmd: 'ls' })).toThrowError(
      UnknownMethodError,
    );
    expect(h.transport.writes).toHaveLength(0);
  });

  it('does not send an oversized frame', async () => {
    const h = makeHarness();
    await h.conn.connect();
    const error = await h.conn
      .request('conversation.send', {
        conversationId: 'c',
        content: 'x'.repeat(MAX_FRAME_BYTES),
        attachments: [],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FrameTooLargeError);
    expect(h.transport.writes).toHaveLength(0);
  });

  it('rejects when Core is not attached', async () => {
    const h = makeHarness();
    const error = await h.conn.request('project.list', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreTransportError);
    expect((error as CoreTransportError).reason).toBe('not_connected');
  });

  it('routes a pushed frame to the notification seam and never to a request', async () => {
    const h = makeHarness();
    await h.conn.connect();
    h.transport.respond({ v: 1, method: 'task.pushed', params: { taskId: 't' } });
    expect(h.notifications).toEqual([{ v: 1, method: 'task.pushed', params: { taskId: 't' } }]);
    // A notification with no pending id must not resolve anything (above: no throw).
  });

  it('reports a decode failure rather than guessing', async () => {
    const h = makeHarness();
    await h.conn.connect();
    h.transport.emit('{"v":1,"id":"1","ok":1,"err":{"code":"INTERNAL","message":"m"}}\n');
    expect(h.decodeErrors.map((e) => e.reason)).toEqual(['invalid_frame']);
  });
});

describe('reconnect with backoff + resubscribe', () => {
  it('reconnects, resubscribes, and restarts the backoff after a healthy connection', async () => {
    const h = makeHarness();
    await h.conn.connect();
    const first = h.conn.request('project.list', {});
    h.transport.emitClose(new Error('core restarted'));

    await expect(first).rejects.toBeInstanceOf(CoreTransportError);
    expect(h.conn.connectionState).toBe('reconnecting');
    expect(h.reconnectHooks).toHaveLength(1); // the initial connect

    h.timers.runNext(); // attempt 2
    await flush(); // the transport handshake settles in a microtask
    expect(h.timers.fired).toEqual([188]); // 250 base × 0.75 jitter
    expect(h.conn.connectionState).toBe('online');
    expect(h.reconnectHooks).toHaveLength(2); // resubscribe ran on reconnect

    // A drop after a working connection must not inherit the old failure count.
    h.transport.emitClose();
    h.timers.runNext();
    await flush();
    expect(h.timers.fired).toEqual([188, 188]);
    expect(h.transports).toHaveLength(3);
  });

  it('grows the delay while every attempt keeps failing', async () => {
    const h = makeHarness();
    h.failConnect = true;
    const error = await h.conn.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreTransportError);
    expect((error as CoreTransportError).reason).toBe('not_connected');
    expect(h.conn.connectionState).toBe('reconnecting');
    expect(h.timers.pending).toHaveLength(1);

    h.timers.runNext();
    await flush();
    expect(h.conn.connectionState).toBe('reconnecting');
    h.timers.runNext();
    await flush();
    h.timers.runNext();
    await flush();
    expect(h.timers.fired).toEqual([188, 375, 750]);
    expect(h.transports).toHaveLength(4); // every attempt got a fresh transport
  });

  it('computes exponential backoff with a ceiling and half-open jitter', () => {
    const policy = { baseMs: 250, maxMs: 4_000, factor: 2 };
    const fixed = () => 0.5; // jitter multiplier 0.75
    expect(nextBackoffDelay(1, policy, fixed)).toBe(188);
    expect(nextBackoffDelay(2, policy, fixed)).toBe(375);
    expect(nextBackoffDelay(3, policy, fixed)).toBe(750);
    expect(nextBackoffDelay(4, policy, fixed)).toBe(1_500);
    expect(nextBackoffDelay(5, policy, fixed)).toBe(3_000);
    expect(nextBackoffDelay(6, policy, fixed)).toBe(3_000); // capped at maxMs * 0.75
    expect(nextBackoffDelay(0, policy, fixed)).toBe(188); // attempts are 1-based
    expect(nextBackoffDelay(1, policy, () => 0)).toBe(125);
    expect(nextBackoffDelay(1, policy, () => 1)).toBe(250);
  });

  it('dispose releases the UI without retrying, and is the only reason pending calls fail', async () => {
    const h = makeHarness();
    await h.conn.connect();
    const pending = h.conn.request('task.subscribe', { afterSequence: 0 });
    h.conn.dispose();
    await expect(pending).rejects.toThrow(/client detached/);
    expect(h.conn.connectionState).toBe('offline');
    expect(h.timers.pending).toHaveLength(0);
    // A detached client cannot keep hammering Core.
    h.timers.runAll();
    expect(h.transports).toHaveLength(1);
    await expect(h.conn.connect()).rejects.toBeInstanceOf(CoreTransportError);
  });
});
