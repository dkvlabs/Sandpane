/**
 * The real transport: a `node:net` connection to the Core Unix domain socket.
 * Kept apart from `connection.ts` so the framing/correlation logic stays
 * vscode-free AND socket-free, and can be unit-tested with a fake duplex.
 */

import { createConnection, type Socket } from 'node:net';
import { CoreTransportError, type CoreTransport, type TransportHandlers } from './connection';
import { unsupportedPlatformReason } from './paths';

export interface SocketTransportOptions {
  /** Absolute path of the Core socket (see paths.coreSocketPath). */
  path: string;
  connectTimeoutMs?: number;
  platform?: NodeJS.Platform | string;
}

export function createSocketTransport(options: SocketTransportOptions): CoreTransport {
  const platform = options.platform ?? process.platform;
  let socket: Socket | null = null;

  return {
    start(handlers: TransportHandlers): Promise<void> {
      const blocked = unsupportedPlatformReason(platform);
      if (blocked) {
        return Promise.reject(new CoreTransportError('unsupported_platform', blocked));
      }
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        let closedNotified = false;
        const notifyClose = (error?: Error): void => {
          if (closedNotified) return;
          closedNotified = true;
          handlers.onClose(error);
        };
        const sock = createConnection({ path: options.path });
        socket = sock;
        // net.Socket.setTimeout is an INACTIVITY timer that stays armed after
        // connect — one knob for two jobs made healthy idle connections churn
        // and killed any Core reply slower than the window (review 0006 #1).
        // The connect deadline is a wall-clock timer cleared at settle;
        // post-connect liveness belongs to the connection layer (request
        // timeouts + close detection), not to a silent-socket destroy.
        let deadline: NodeJS.Timeout | undefined;
        if (options.connectTimeoutMs) {
          deadline = setTimeout(() => {
            if (settled) return;
            settled = true;
            closedNotified = true; // start() rejects; do not also fire onClose
            sock.destroy();
            reject(
              new CoreTransportError(
                'timeout',
                `connect to the Core socket timed out after ${options.connectTimeoutMs}ms`,
              ),
            );
          }, options.connectTimeoutMs);
          deadline.unref();
        }
        sock.on('connect', () => {
          if (deadline) clearTimeout(deadline);
          settled = true;
          resolve();
        });
        sock.on('data', (chunk: Buffer) => {
          handlers.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        });
        sock.on('error', (err: Error) => {
          if (!settled) {
            settled = true;
            reject(err);
          } else {
            notifyClose(err);
          }
        });
        sock.on('close', () => {
          if (socket === sock) socket = null;
          notifyClose();
        });
      });
    },
    write(bytes: Uint8Array): void {
      if (!socket || socket.destroyed) {
        throw new CoreTransportError('not_connected', 'socket is not writable');
      }
      // Write the frame as one buffer; no string interpolation involved.
      socket.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
    close(): void {
      const sock = socket;
      socket = null;
      sock?.destroy();
    },
  };
}
