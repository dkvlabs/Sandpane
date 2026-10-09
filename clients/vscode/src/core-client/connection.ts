/**
 * Core IPC client: NDJSON framing + request/response correlation + reconnect.
 *
 * Deliberately **free of `vscode` imports** so it is unit-testable against a
 * fake duplex transport (specs/03 §4 "Reconnection — Sequence catch-up"). The
 * real transport (`node:net` on the Core socket) lives in `transport.ts`.
 *
 * Wire facts this implements (core/crates/sandpane-service/src/lib.rs):
 *  - one JSON frame per line, `\n` terminated;
 *  - request  `{v, id, method, params}`;
 *  - response `{v, id, ok}` **or** `{v, id, err:{code,message,details?}}`;
 *  - the service bounds a frame at MAX_FRAME_BYTES and refuses larger ones;
 *  - the service is strictly request/response today — it never pushes. Any
 *    non-correlated line is routed to the notification seam below, which is
 *    forward-compat only, not a claimed capability.
 */

import {
  ERROR_CODES,
  type ErrorCode,
} from './events';
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  isCoreMethodName,
  type CoreMethodName,
  type RpcErrorEnvelope,
  type RpcResponseFrame,
} from './protocol';

// ---------------------------------------------------------------------------
// Errors surfaced to callers
// ---------------------------------------------------------------------------

export class FrameTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(
      `frame is ${bytes} bytes, over the ${maxBytes} byte IPC ceiling (MAX_FRAME_BYTES) — ` +
        'nothing was sent',
    );
    this.name = 'FrameTooLargeError';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export class UnknownMethodError extends Error {
  constructor(method: string) {
    super(
      `"${method}" is not a Sandpane Core method. The RPC surface is an allowlist ` +
        '(11 typed methods); there is no free-form execution method (specs/02 §2).',
    );
    this.name = 'UnknownMethodError';
  }
}

/** A structured `err` envelope returned by Core. */
export class CoreRpcError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly requestId: string;

  constructor(envelope: RpcErrorEnvelope, requestId: string) {
    super(`${envelope.code}: ${envelope.message}`);
    this.name = 'CoreRpcError';
    this.code = envelope.code;
    this.details = envelope.details;
    this.requestId = requestId;
  }
}

export type TransportFailureReason =
  | 'not_connected'
  | 'closed'
  | 'timeout'
  | 'send_failed'
  | 'unsupported_platform';

export class CoreTransportError extends Error {
  readonly reason: TransportFailureReason;

  constructor(reason: TransportFailureReason, message: string) {
    super(message);
    this.name = 'CoreTransportError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Framing codec
// ---------------------------------------------------------------------------

const JSON_ENCODE = new TextEncoder();
const JSON_DECODE = new TextDecoder('utf-8');
const NEWLINE = 0x0a;

/** Serialize one frame and terminate it with `\n`. Never emits a raw newline. */
export function encodeFrame(value: unknown, maxBytes: number = MAX_FRAME_BYTES): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError('frame is not JSON-serializable (undefined/function/symbol)');
  }
  // JSON.stringify escapes control characters, so a body can never smuggle a
  // second line into the stream. Belt-and-braces check (specs/02 §2 framing).
  if (json.indexOf('\n') !== -1 || json.indexOf('\r') !== -1) {
    throw new TypeError('internal: encoded frame contains a raw line break');
  }
  const bytes = JSON_ENCODE.encode(json);
  if (bytes.byteLength > maxBytes) {
    throw new FrameTooLargeError(bytes.byteLength, maxBytes);
  }
  const out = new Uint8Array(bytes.byteLength + 1);
  out.set(bytes, 0);
  out[bytes.byteLength] = NEWLINE;
  return out;
}

export type FrameDecodeFailure = {
  reason: 'invalid_json' | 'frame_too_large' | 'invalid_frame' | 'resynced';
  message: string;
};

/** Server-pushed frame shape. Core does not emit these in this build. */
export interface RpcNotificationFrame {
  v: number;
  method: string;
  params?: unknown;
}

export type InboundFrame =
  | { kind: 'response'; response: RpcResponseFrame }
  | { kind: 'notification'; notification: RpcNotificationFrame };

export type FramerEvent =
  | { kind: 'frame'; frame: InboundFrame }
  | { kind: 'error'; error: FrameDecodeFailure };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseError(message: string): FrameDecodeFailure {
  return { reason: 'invalid_frame', message };
}

/** Parse one complete line into a validated inbound frame. */
export function decodeLine(line: string): { ok: true; frame: InboundFrame } | { ok: false; error: FrameDecodeFailure } {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (trimmed.length === 0) {
    // Tolerated blank line (server writes `writeln!`, a stray blank is inert).
    return { ok: false, error: { reason: 'invalid_json', message: 'empty line' } };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      error: { reason: 'invalid_json', message: `not JSON: ${String(e)}` },
    };
  }
  if (!isPlainObject(value)) {
    return { ok: false, error: parseError('frame is not a JSON object') };
  }
  const v = value['v'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return { ok: false, error: parseError('frame.v must be a positive integer') };
  }
  const hasOk = Object.prototype.hasOwnProperty.call(value, 'ok');
  const hasErr = Object.prototype.hasOwnProperty.call(value, 'err');
  if (hasOk || hasErr) {
    const id = value['id'];
    if (typeof id !== 'string') {
      return { ok: false, error: parseError('response frame.id must be a string') };
    }
    if (hasOk && hasErr) {
      return { ok: false, error: parseError('response carries both ok and err') };
    }
    if (hasOk) {
      return { ok: true, frame: { kind: 'response', response: { v, id, ok: value['ok'] } } };
    }
    const err = value['err'];
    if (!isPlainObject(err)) {
      return { ok: false, error: parseError('err must be an object') };
    }
    const code = err['code'];
    const message = err['message'];
    if (typeof code !== 'string' || !(ERROR_CODES as readonly string[]).includes(code)) {
      return { ok: false, error: parseError(`unknown error code: ${String(code)}`) };
    }
    if (typeof message !== 'string') {
      return { ok: false, error: parseError('err.message must be a string') };
    }
    const envelope: RpcErrorEnvelope = {
      code: code as ErrorCode,
      message,
      ...(typeof err['details'] === 'undefined' ? {} : { details: err['details'] }),
    };
    return { ok: true, frame: { kind: 'response', response: { v, id, err: envelope } } };
  }
  const method = value['method'];
  if (typeof method === 'string') {
    const params = value['params'];
    return {
      ok: true,
      frame: {
        kind: 'notification',
        notification: typeof params === 'undefined' ? { v, method } : { v, method, params },
      },
    };
  }
  return { ok: false, error: parseError('frame has neither ok/err nor method') };
}

/**
 * Incremental NDJSON reader. Byte-level buffering (not string concat) so a
 * multibyte character split across TCP/socket chunks decodes correctly, and so
 * oversized input is dropped rather than buffered (AGENTS.md rule 9).
 */
export class NdjsonFramer {
  private buffer: Uint8Array = new Uint8Array(0);
  private discarding = false;
  private discardedBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes > 0 ? maxBytes : MAX_FRAME_BYTES;
  }

  /** Feed a raw chunk; returns the frames/errors that became complete. */
  push(chunk: Uint8Array): FramerEvent[] {
    const events: FramerEvent[] = [];
    if (this.discarding) {
      this.consumeDiscard(chunk, events);
      return events;
    }
    this.buffer = concatBytes(this.buffer, chunk);
    for (;;) {
      const idx = this.buffer.indexOf(NEWLINE);
      if (idx === -1) {
        if (this.buffer.byteLength > this.maxBytes) {
          events.push({
            kind: 'error',
            error: {
              reason: 'frame_too_large',
              message: `frame exceeded ${this.maxBytes} bytes without a line break; discarding`,
            },
          });
          // Count what is thrown away, then stop retaining it (bounded memory).
          this.discardedBytes += this.buffer.byteLength;
          this.buffer = new Uint8Array(0);
          this.discarding = true;
          return events;
        }
        return events;
      }
      if (idx > this.maxBytes) {
        // Complete-but-oversized line, exactly the case Core rejects with
        // VALIDATION_FAILED "frame too large". Discard the line, keep the stream.
        this.discardedBytes += idx;
        events.push({
          kind: 'error',
          error: {
            reason: 'frame_too_large',
            message: `frame of ${idx} bytes exceeds the ${this.maxBytes} byte ceiling; line discarded`,
          },
        });
        this.buffer = this.buffer.slice(idx + 1);
        continue;
      }
      const lineBytes = this.buffer.subarray(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      events.push(this.emitLine(lineBytes));
      if (this.discarding) {
        return events;
      }
    }
  }

  /** Drop any partial line (used on transport close). */
  reset(): void {
    this.buffer = new Uint8Array(0);
    this.discarding = false;
    this.discardedBytes = 0;
  }

  /** Bytes thrown away by the last over-limit frame (diagnostics only). */
  get discardedByteCount(): number {
    return this.discardedBytes;
  }

  private emitLine(lineBytes: Uint8Array): FramerEvent {
    const parsed = decodeLine(JSON_DECODE.decode(lineBytes));
    return parsed.ok
      ? { kind: 'frame', frame: parsed.frame }
      : { kind: 'error', error: parsed.error };
  }

  /** Scan for the next newline while throwing bytes away — memory-bounded. */
  private consumeDiscard(chunk: Uint8Array, events: FramerEvent[]): void {
    const idx = chunk.indexOf(NEWLINE);
    if (idx === -1) {
      this.discardedBytes += chunk.byteLength;
      return;
    }
    this.discardedBytes += idx;
    this.discarding = false;
    events.push({
      kind: 'error',
      error: { reason: 'resynced', message: 'resynchronized on the next line after the oversized frame' },
    });
    const rest = chunk.subarray(idx + 1);
    if (rest.byteLength > 0) {
      this.push(rest).forEach((e) => events.push(e));
    }
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

export interface TransportHandlers {
  onData(chunk: Uint8Array): void;
  onClose(error?: Error): void;
}

/** Injected duplex so tests never touch a socket. Real one: `transport.ts`. */
export interface CoreTransport {
  start(handlers: TransportHandlers): Promise<void> | void;
  write(bytes: Uint8Array): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Reconnect backoff (pure)
// ---------------------------------------------------------------------------

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  factor: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 250, maxMs: 10_000, factor: 2 };

/**
 * Exponential backoff with half-open jitter. `attempt` is 1-based. Deterministic
 * when `rng` is supplied, which is what makes the reconnect path testable.
 */
export function nextBackoffDelay(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  rng: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const capped = Math.min(policy.maxMs, policy.baseMs * Math.pow(policy.factor, safeAttempt - 1));
  const jitter = 0.5 + Math.min(1, Math.max(0, rng())) * 0.5;
  return Math.round(capped * jitter);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export type ConnectionState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface CoreConnectionOptions {
  /** A fresh transport per attempt (a socket cannot be restarted). */
  transportFactory: () => CoreTransport;
  maxFrameBytes?: number;
  requestTimeoutMs?: number;
  /** Always PROTOCOL_VERSION in v1; the seam exists for version negotiation. */
  requestedProtocolVersion?: number;
  backoff?: BackoffPolicy;
  rng?: () => number;
  /** Id prefix; defaults to a counter + Math.random. */
  randomIdPrefix?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onStateChange?: (state: ConnectionState, detail?: string) => void;
  onNotification?: (frame: RpcNotificationFrame) => void;
  onDecodeError?: (error: FrameDecodeFailure) => void;
  /** Fired after every successful (re)connect — resubscribe from a checkpoint. */
  onReconnect?: () => void | Promise<void>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: unknown;
  method: string;
}

const nodeSetTimer = (fn: () => void, ms: number): unknown => {
  const handle = setTimeout(fn, ms);
  // Never keep the extension host alive for a pending RPC.
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref(): void }).unref();
  }
  return handle;
};

export class CoreConnection {
  private readonly opts: Required<
    Pick<CoreConnectionOptions, 'maxFrameBytes' | 'requestTimeoutMs' | 'backoff'>
  > &
    CoreConnectionOptions;
  private readonly framer: NdjsonFramer;
  private readonly pending = new Map<string, PendingRequest>();
  private transport: CoreTransport | null = null;
  private state: ConnectionState = 'idle';
  private attempt = 0;
  private idCounter = 0;
  private reconnectTimer: unknown = undefined;
  private disposed = false;
  /** Set when Core answered with a different protocol version. */
  private peerVersion: number | null = null;

  constructor(options: CoreConnectionOptions) {
    this.opts = {
      maxFrameBytes: MAX_FRAME_BYTES,
      requestTimeoutMs: 15_000,
      backoff: DEFAULT_BACKOFF,
      ...options,
    };
    this.framer = new NdjsonFramer(this.opts.maxFrameBytes);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get protocolVersionSeen(): number | null {
    return this.peerVersion;
  }

  /** Open the transport. Reconnects are handled internally afterwards. */
  async connect(): Promise<void> {
    if (this.disposed) {
      throw new CoreTransportError('closed', 'connection has been disposed');
    }
    if (this.state === 'online' || this.state === 'connecting') return;
    await this.openTransport('connecting');
  }

  /**
   * Typed RPC call. Rejects with `CoreRpcError` (structured Core error),
   * `CoreTransportError` (not connected / timeout / closed) or throws
   * `UnknownMethodError` / `FrameTooLargeError` before anything is written.
   */
  request<T>(method: CoreMethodName, params: unknown = {}): Promise<T> {
    if (!isCoreMethodName(method)) {
      // Runtime guard: the type is a union, but callers may pass user input.
      throw new UnknownMethodError(String(method));
    }
    if (!this.transport || (this.state !== 'online' && this.state !== 'connecting')) {
      return Promise.reject(
        new CoreTransportError(
          'not_connected',
          'Sandpane Core is not attached. Start the service and use "Sandpane: Refresh Sandboxes" or reload the window.',
        ),
      );
    }
    const id = this.nextId();
    const frame = { v: this.opts.requestedProtocolVersion ?? PROTOCOL_VERSION, id, method, params };
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame(frame, this.opts.maxFrameBytes);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (this.pending.delete(id)) {
          reject(
            new CoreTransportError(
              'timeout',
              `Core did not answer "${method}" within ${this.opts.requestTimeoutMs}ms. The request id is dropped; nothing is retried blindly.`,
            ),
          );
        }
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });
      try {
        this.transport?.write(bytes);
      } catch (e) {
        this.clearTimer(timer);
        this.pending.delete(id);
        reject(
          new CoreTransportError('send_failed', `write failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    });
  }

  /**
   * UI detach. Closes our socket and fails in-flight calls — it does **not**
   * cancel anything: tasks live in Core, which outlives clients (specs/03 §2.6).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const [, entry] of this.pending) {
      this.clearTimer(entry.timer);
      entry.reject(new CoreTransportError('closed', 'client detached — Core keeps running'));
    }
    this.pending.clear();
    const t = this.transport;
    this.transport = null;
    this.framer.reset();
    try {
      t?.close();
    } catch {
      /* already gone */
    }
    this.setState('offline', 'disposed');
  }

  // -- internals ----------------------------------------------------------

  private nextId(): string {
    this.idCounter += 1;
    const prefix = this.opts.randomIdPrefix?.() ?? `sp${Math.floor(Math.random() * 1e6)}`;
    return `${prefix}-${this.idCounter}`;
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return (this.opts.setTimer ?? nodeSetTimer)(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    if (handle === undefined || handle === null) return;
    const clear = this.opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    clear(handle);
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state, detail);
  }

  private async openTransport(transition: 'connecting' | 'reconnecting'): Promise<void> {
    this.setState(transition, this.attempt > 0 ? `attempt ${this.attempt + 1}` : undefined);
    const transport = this.opts.transportFactory();
    this.transport = transport;
    this.framer.reset();
    try {
      await transport.start({
        onData: (chunk) => this.handleChunk(chunk),
        onClose: (error) => this.handleClose(error),
      });
    } catch (e) {
      this.transport = null;
      const message = e instanceof Error ? e.message : String(e);
      this.scheduleReconnect(`connect failed: ${message}`);
      throw new CoreTransportError('not_connected', `cannot reach Sandpane Core: ${message}`);
    }
    this.attempt = 0;
    this.setState('online');
    try {
      await this.opts.onReconnect?.();
    } catch {
      // Resubscribe failures are reported by the subscription itself, never fatal.
    }
  }

  private handleChunk(chunk: Uint8Array): void {
    for (const event of this.framer.push(chunk)) {
      if (event.kind === 'error') {
        this.opts.onDecodeError?.(event.error);
        continue;
      }
      const frame = event.frame;
      if (frame.kind === 'notification') {
        // Forward-compat seam: this build of Core never pushes frames, so live
        // updates come from replay (catchup.ts), not from here.
        this.opts.onNotification?.(frame.notification);
        continue;
      }
      this.handleResponse(frame.response);
    }
  }

  private handleResponse(response: RpcResponseFrame): void {
    this.peerVersion = response.v;
    if (response.v !== PROTOCOL_VERSION) {
      this.opts.onDecodeError?.({
        reason: 'invalid_frame',
        message: `Core answered with protocol v${response.v}, this client speaks v${PROTOCOL_VERSION}`,
      });
    }
    const entry = this.pending.get(response.id);
    if (!entry) {
      // Orphan response (timed out or duplicated): drop it, never re-apply it.
      return;
    }
    this.pending.delete(response.id);
    this.clearTimer(entry.timer);
    if (response.err) {
      entry.reject(new CoreRpcError(response.err, response.id));
    } else {
      entry.resolve(response.ok);
    }
  }

  private handleClose(error?: Error): void {
    if (this.disposed) return;
    this.framer.reset();
    this.transport = null;
    const detail = error?.message ?? 'socket closed by Core';
    for (const [, entry] of this.pending) {
      this.clearTimer(entry.timer);
      entry.reject(
        new CoreTransportError('closed', `connection lost while awaiting "${entry.method}" — ${detail}`),
      );
    }
    this.pending.clear();
    this.scheduleReconnect(detail);
  }

  private scheduleReconnect(detail: string): void {
    if (this.disposed) return;
    this.attempt += 1;
    this.setState('reconnecting', detail);
    const delay = nextBackoffDelay(this.attempt, this.opts.backoff, this.opts.rng ?? Math.random);
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      void this.openTransport('reconnecting').catch(() => {
        // openTransport already scheduled the next attempt.
      });
    }, delay);
  }
}
