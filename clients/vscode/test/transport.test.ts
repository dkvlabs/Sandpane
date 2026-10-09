/**
 * Real-socket regression for the connect-deadline semantics (review 0006 #1).
 * The peer here is a plain node:net server — the unit under test is OUR
 * transport's timer behavior on a healthy idle connection, not Core.
 */

import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSocketTransport } from '../src/core-client/transport';

describe('socket transport connect deadline', () => {
  let server: Server | null = null;
  let dir: string | null = null;

  afterEach(() => {
    server?.close();
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('keeps an idle connected socket alive well past connectTimeoutMs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sandpane-transport-idle-'));
    const path = join(dir, 'sandpane.sock');
    server = createServer();
    // Quiet peer: accepts and never writes.
    await new Promise<void>((res) => server!.listen(path, res));

    const transport = createSocketTransport({ path, connectTimeoutMs: 100 });
    let closes = 0;
    await transport.start({ onData: () => {}, onClose: () => { closes += 1; } });

    // 8x the window with zero traffic: before the fix the inactivity timer
    // destroyed the socket here (~4 reconnect churns per 15 s at 3000 ms).
    await new Promise((res) => setTimeout(res, 800));
    expect(closes).toBe(0);
    expect(() => transport.write(new Uint8Array([0x7b]))).not.toThrow();
    transport.close();
  }, 15_000);

  it('reports one close exactly when the transport is closed deliberately', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sandpane-transport-close-'));
    const path = join(dir, 'sandpane.sock');
    server = createServer();
    await new Promise<void>((res) => server!.listen(path, res));

    const transport = createSocketTransport({ path, connectTimeoutMs: 100 });
    let closes = 0;
    await transport.start({ onData: () => {}, onClose: () => { closes += 1; } });
    transport.close();
    await new Promise((res) => setTimeout(res, 100));
    expect(closes).toBeLessThanOrEqual(1);
  }, 15_000);
});
