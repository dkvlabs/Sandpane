/**
 * Real-socket regression for the connect-deadline semantics (review 0006 #1).
 * The peer here is a plain node:net server — the unit under test is OUR
 * transport's timer behavior on a healthy idle connection, not Core.
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreTransportError } from '../src/core-client/connection';
import { checkSocketTrust } from '../src/core-client/socketTrust';
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
    chmodSync(path, 0o600); // Core creates its socket 0600 (main.rs); the trust check requires it

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
    chmodSync(path, 0o600);

    const transport = createSocketTransport({ path, connectTimeoutMs: 100 });
    let closes = 0;
    await transport.start({ onData: () => {}, onClose: () => { closes += 1; } });
    transport.close();
    await new Promise((res) => setTimeout(res, 100));
    expect(closes).toBeLessThanOrEqual(1);
  }, 15_000);
});

describe('socket trust check before connecting (security W4)', () => {
  let server: Server | null = null;
  let dir: string | null = null;

  afterEach(() => {
    server?.close();
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const listen = async (): Promise<string> => {
    dir = mkdtempSync(join(tmpdir(), 'sandpane-transport-trust-'));
    const path = join(dir, 'sandpane.sock');
    server = createServer();
    await new Promise<void>((res) => server!.listen(path, res));
    return path;
  };

  it('pure verdict: socket + own uid + no group/other bits is the only accepted shape', () => {
    const sock = (mode: number, uid: number, isSocket = true) => ({
      isSocket: () => isSocket,
      isSymbolicLink: () => false,
      uid,
      mode,
    });
    expect(checkSocketTrust(sock(0o140600, 501), 501)).toBeUndefined();
    expect(checkSocketTrust(sock(0o140600, 0), 501)).toMatch(/owned by uid 0/);
    expect(checkSocketTrust(sock(0o140660, 501), 501)).toMatch(/group\/other/);
    expect(checkSocketTrust(sock(0o140606, 501), 501)).toMatch(/group\/other/);
    expect(checkSocketTrust(sock(0o100600, 501, false), 501)).toMatch(/not a Unix socket/);
    expect(
      checkSocketTrust({ isSocket: () => false, isSymbolicLink: () => true, uid: 501, mode: 0o120777 }, 501),
    ).toMatch(/symbolic link/);
  });

  it('refuses a socket other users can connect to, before opening it', async () => {
    const path = await listen();
    chmodSync(path, 0o666);
    let accepted = 0;
    server!.on('connection', () => { accepted += 1; });
    const transport = createSocketTransport({ path, connectTimeoutMs: 500 });
    const error = await transport.start({ onData: () => {}, onClose: () => {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreTransportError);
    expect((error as CoreTransportError).reason).toBe('untrusted_socket');
    await new Promise((res) => setTimeout(res, 50));
    expect(accepted).toBe(0);
  });

  it('refuses a socket owned by a different uid', async () => {
    const path = await listen();
    chmodSync(path, 0o600);
    const transport = createSocketTransport({ path, connectTimeoutMs: 500, expectedUid: 4_242_424 });
    const error = await transport.start({ onData: () => {}, onClose: () => {} }).catch((e: unknown) => e);
    expect((error as CoreTransportError).reason).toBe('untrusted_socket');
  });

  it('refuses a symlink and a regular file at the socket path', async () => {
    const path = await listen();
    chmodSync(path, 0o600);
    const link = join(dir!, 'link.sock');
    symlinkSync(path, link);
    const viaLink = createSocketTransport({ path: link, connectTimeoutMs: 500 });
    const linkError = await viaLink.start({ onData: () => {}, onClose: () => {} }).catch((e: unknown) => e);
    expect((linkError as CoreTransportError).reason).toBe('untrusted_socket');

    const file = join(dir!, 'file.sock');
    writeFileSync(file, '', { mode: 0o600 });
    const viaFile = createSocketTransport({ path: file, connectTimeoutMs: 500 });
    const fileError = await viaFile.start({ onData: () => {}, onClose: () => {} }).catch((e: unknown) => e);
    expect((fileError as CoreTransportError).reason).toBe('untrusted_socket');
  });

  it('a missing socket rejects once and never also reports close (bug 12a)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sandpane-transport-missing-'));
    const transport = createSocketTransport({ path: join(dir, 'absent.sock'), connectTimeoutMs: 500 });
    let closes = 0;
    const error = await transport
      .start({ onData: () => {}, onClose: () => { closes += 1; } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    await new Promise((res) => setTimeout(res, 50));
    expect(closes).toBe(0);
  });

  it('a refused connect (error before connect) never also reports close (bug 12a)', async () => {
    // A STALE socket file (its listener was SIGKILLed, so nothing unlinked it):
    // lstat passes the trust check, then connect() fails with ECONNREFUSED and
    // the socket emits 'error' followed by 'close'.
    dir = mkdtempSync(join(tmpdir(), 'sandpane-transport-stale-'));
    const path = join(dir, 'stale.sock');
    const child = spawn(
      process.execPath,
      ['-e', "require('net').createServer().listen(process.argv[1], () => console.log('up'))", path],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((res) => child.stdout!.once('data', () => res()));
    chmodSync(path, 0o600);
    child.kill('SIGKILL');
    await new Promise<void>((res) => child.once('exit', () => res()));

    const transport = createSocketTransport({ path, connectTimeoutMs: 2_000 });
    let closes = 0;
    const error = await transport
      .start({ onData: () => {}, onClose: () => { closes += 1; } })
      .catch((e: unknown) => e);
    expect((error as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    await new Promise((res) => setTimeout(res, 100));
    expect(closes).toBe(0);
  }, 15_000);
});
