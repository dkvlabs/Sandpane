/**
 * Test doubles for the Core client. The transport is a pure duplex (nothing is
 * ever opened), and timers are manual so reconnect/timeout paths are asserted
 * without waiting. No VS Code API is involved anywhere in these tests.
 */

import {
  CoreConnection,
  decodeLine,
  type ConnectionState,
  type CoreTransport,
  type FrameDecodeFailure,
  type RpcNotificationFrame,
  type TransportHandlers,
} from '../../src/core-client/connection';

export interface RecordedTimer {
  id: number;
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

export class FakeTimers {
  private readonly timers = new Map<number, RecordedTimer>();
  private nextId = 1;
  readonly fired: number[] = [];

  set = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { id, fn, ms, cancelled: false });
    return id;
  };

  clear = (handle: unknown): void => {
    if (typeof handle === 'number') {
      const timer = this.timers.get(handle);
      if (timer) timer.cancelled = true;
    }
  };

  get pending(): RecordedTimer[] {
    return [...this.timers.values()].filter((t) => !t.cancelled);
  }

  /** Run every pending callback (once) — the reconnect test drives this. */
  runAll(): void {
    for (const timer of [...this.timers.values()]) {
      if (timer.cancelled) continue;
      this.timers.delete(timer.id);
      this.fired.push(timer.ms);
      timer.fn();
    }
  }

  runNext(): number | undefined {
    const timer = this.pending[0];
    if (!timer) return undefined;
    this.timers.delete(timer.id);
    this.fired.push(timer.ms);
    timer.fn();
    return timer.ms;
  }
}

export class FakeTransport implements CoreTransport {
  handlers: TransportHandlers | null = null;
  readonly writes: Uint8Array[] = [];
  startError: Error | null = null;
  closed = false;

  start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers;
    if (this.startError) return Promise.reject(this.startError);
    return Promise.resolve();
  }

  write(bytes: Uint8Array): void {
    if (this.closed) throw new Error('write on a closed transport');
    this.writes.push(bytes);
  }

  close(): void {
    this.closed = true;
  }

  /** Push raw bytes at the client as if Core had sent them. */
  emit(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.handlers?.onData(bytes);
  }

  emitClose(error?: Error): void {
    this.handlers?.onClose(error ?? new Error('socket closed'));
  }

  /** Frames the client has written, parsed back from the wire bytes. */
  sentFrames(): unknown[] {
    return this.writes.map((bytes) => {
      const text = decoder.decode(bytes);
      const parsed = decodeLine(text.endsWith('\n') ? text.slice(0, -1) : text);
      if (!parsed.ok) {
        throw new Error(`test: client wrote an invalid frame: ${parsed.error.message}`);
      }
      return JSON.parse(text.trim());
    });
  }

  lastRequest(): { v: number; id: string; method: string; params: unknown } {
    const frames = this.sentFrames();
    const last = frames[frames.length - 1];
    if (!last) throw new Error('no frame was written');
    return last as { v: number; id: string; method: string; params: unknown };
  }

  respond(json: unknown): void {
    this.emit(`${JSON.stringify(json)}\n`);
  }
}

export interface Harness {
  conn: CoreConnection;
  transports: FakeTransport[];
  timers: FakeTimers;
  states: ConnectionState[];
  decodeErrors: FrameDecodeFailure[];
  notifications: RpcNotificationFrame[];
  reconnectHooks: number[];
  /** When true, every transport handed out from now on fails to start. */
  failConnect: boolean;
  readonly transport: FakeTransport;
}

export function makeHarness(options?: {
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  rng?: () => number;
}): Harness {
  const transports: FakeTransport[] = [];
  const timers = new FakeTimers();
  const states: ConnectionState[] = [];
  const decodeErrors: FrameDecodeFailure[] = [];
  const notifications: RpcNotificationFrame[] = [];
  const reconnectHooks: number[] = [];
  const harness: Harness = {
    transports,
    timers,
    states,
    decodeErrors,
    notifications,
    reconnectHooks,
    failConnect: false,
    get transport(): FakeTransport {
      const t = transports[transports.length - 1];
      if (!t) throw new Error('no transport created yet');
      return t;
    },
    conn: undefined as unknown as CoreConnection,
  };
  const conn = new CoreConnection({
    transportFactory: () => {
      const t = new FakeTransport();
      if (harness.failConnect) {
        t.startError = new Error('connect refused (sandboxed test failure)');
      }
      transports.push(t);
      return t;
    },
    setTimer: timers.set,
    clearTimer: timers.clear,
    requestTimeoutMs: options?.requestTimeoutMs ?? 5_000,
    maxFrameBytes: options?.maxFrameBytes,
    rng: options?.rng ?? (() => 0.5),
    randomIdPrefix: () => 'test',
    onStateChange: (state) => states.push(state),
    onDecodeError: (error) => decodeErrors.push(error),
    onNotification: (frame) => notifications.push(frame),
    onReconnect: () => {
      reconnectHooks.push(reconnectHooks.length + 1);
    },
  });
  harness.conn = conn;
  return harness;
}

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

/**
 * Let the connection's async reconnect path settle after firing a fake timer:
 * `openTransport` resolves its transport in a microtask.
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
