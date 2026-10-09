/**
 * Transport-agnostic Core client.
 *
 * Same wire contract as the other Sandpane clients: NDJSON
 * `{v,id,...}` frames, `id` correlation, and incremental task-event replay via
 * `task.subscribe(afterSequence)` (docs/specs/02 §2, §3). The byte transport is
 * injected — `src/transport/tauri.ts` in the native shell, an in-memory duplex
 * in tests — so this module never touches Node/Tauri APIs itself.
 *
 * It is a thin typed client by design: no project/task business logic lives
 * here, and no method outside the documented allowlist can be sent
 * (`isMethod` guards every call).
 */

import {
  ERROR_CODES,
  PROTOCOL_VERSION,
  isMethod,
  type CoreCapabilities,
  type ErrorCode,
  type Method,
  type RpcResponseFrame,
  type TaskEvent,
  type TaskSubscribeParams,
} from "./protocol";
import { FrameTooLargeError, MalformedFrameError, encodeFrame } from "./framing";
import { decodeCoreCapabilities, decodeTaskEvents } from "./decode";

/** The only thing the client needs from a transport. */
export interface CoreTransport {
  /** Identifies the transport in honest UI copy (e.g. `tauri`, `memory`). */
  readonly kind: string;
  /** Send one complete NDJSON frame including its trailing newline. */
  write(frame: string): void | Promise<void>;
  /** Receive one complete line (no trailing newline). Returns unsubscribe. */
  onLine(handler: (line: string) => void): () => void;
  /** Transport closed / became unavailable. Returns unsubscribe. */
  onClose(handler: (reason: string) => void): () => void;
  close(): void;
}

export type ClientErrorCode =
  | "TIMEOUT"
  | "TRANSPORT_CLOSED"
  | "TRANSPORT_UNAVAILABLE"
  | "FRAME_TOO_LARGE"
  | "MALFORMED_FRAME"
  | "VERSION_MISMATCH"
  | "METHOD_NOT_ALLOWED";

export type ErrorSource = "core" | "client";

/**
 * One error type for both failure planes: `source: "core"` carries a structured
 * protocol `ErrorCode`, `source: "client"` a transport/framing failure. UI copy
 * must show which plane failed — "Core is not running" is not "SBX is missing".
 */
export class CoreRequestError extends Error {
  constructor(
    readonly source: ErrorSource,
    readonly code: ErrorCode | ClientErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CoreRequestError";
  }

  get isCoreError(): boolean {
    return this.source === "core";
  }
}

export function coreErrorCode(err: unknown): ErrorCode | null {
  return err instanceof CoreRequestError && err.isCoreError
    ? (err.code as ErrorCode)
    : null;
}

export interface CoreClientOptions {
  /** RPC deadline. Defaults to 15s — long enough for a probed `sandbox.list`. */
  requestTimeoutMs?: number;
  /** Override the id factory in tests for deterministic ids. */
  nextId?: () => string;
  /** Override the clock in tests. */
  now?: () => number;
}

export type ProbeOutcome =
  | { kind: "attached"; capabilities: CoreCapabilities }
  | { kind: "version_mismatch"; coreProtocolVersion: number }
  | { kind: "unreachable"; error: CoreRequestError };

/** Correlates a pending request with its eventual response frame. */
interface Pending {
  resolve: (frame: RpcResponseFrame) => void;
  reject: (err: CoreRequestError) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: Method;
}

export class CoreClient {
  private readonly pending = new Map<string, Pending>();
  private readonly lineUnsub: () => void;
  private readonly closeUnsub: () => void;
  private readonly subscriptions = new Set<TaskSubscription>();
  private closed = false;
  private sequence = 0;
  /** Count of response frames whose `id` matched nothing pending. */
  private orphanResponses = 0;
  private readonly requestTimeoutMs: number;
  private readonly nextId: () => string;
  private readonly now: () => number;

  constructor(
    private readonly transport: CoreTransport,
    options: CoreClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.now = options.now ?? (() => Date.now());
    this.nextId =
      options.nextId ??
      (() => {
        this.sequence += 1;
        return `desk-${this.now().toString(36)}-${this.sequence}`;
      });
    this.lineUnsub = transport.onLine((line) => this.handleLine(line));
    this.closeUnsub = transport.onClose((reason) => this.handleClose(reason));
  }

  get transportKind(): string {
    return this.transport.kind;
  }

  get inFlightCount(): number {
    return this.pending.size;
  }

  get orphanResponseCount(): number {
    return this.orphanResponses;
  }

  /** Send one allowlisted RPC and await its correlated response frame. */
  async request<M extends Method>(
    method: M,
    params: unknown = {},
  ): Promise<unknown> {
    if (!isMethod(method)) {
      throw new CoreRequestError(
        "client",
        "METHOD_NOT_ALLOWED",
        `"${method}" is not a Sandpane Core method — there is no free-form execution method`,
      );
    }
    if (this.closed) {
      throw new CoreRequestError(
        "client",
        "TRANSPORT_CLOSED",
        "the Core connection is closed; reattach before sending requests",
      );
    }
    const id = this.nextId();
    const frame = { v: PROTOCOL_VERSION, id, method, params };
    let encoded: string;
    try {
      encoded = encodeFrame(frame);
    } catch (err) {
      if (err instanceof FrameTooLargeError) {
        throw new CoreRequestError(
          "client",
          "FRAME_TOO_LARGE",
          `request for ${method} exceeds the NDJSON frame cap`,
          { byteLength: err.byteLength },
        );
      }
      throw err;
    }

    const response = await new Promise<RpcResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CoreRequestError(
            "client",
            "TIMEOUT",
            `${method} did not answer within ${this.requestTimeoutMs} ms`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      void Promise.resolve(this.transport.write(encoded)).catch((err: unknown) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.reject(
          new CoreRequestError(
            "client",
            "TRANSPORT_UNAVAILABLE",
            `the desktop could not write to Core: ${String(err)}`,
          ),
        );
      });
    });

    if ("err" in response && response.err !== undefined) {
      throw new CoreRequestError(
        "core",
        response.err.code,
        response.err.message,
        response.err.details,
      );
    }
    return response.ok;
  }

  /**
   * `system.probe` — identity and capability negotiation. Never throws for a
   * reachable-but-old Core: a protocol mismatch is reported as a distinct
   * outcome so the UI can say "Core speaks v2, this desktop speaks v1".
   */
  async probe(): Promise<ProbeOutcome> {
    try {
      const raw = await this.request("system.probe", {});
      const capabilities = decodeCoreCapabilities(raw);
      if (capabilities.protocolVersion !== PROTOCOL_VERSION) {
        return {
          kind: "version_mismatch",
          coreProtocolVersion: capabilities.protocolVersion,
        };
      }
      return { kind: "attached", capabilities };
    } catch (err) {
      return { kind: "unreachable", error: asCoreRequestError(err) };
    }
  }

  // -- typed convenience wrappers (still one RPC each, no logic) ----------

  listProjects() {
    return this.request("project.list", {});
  }

  createProject(params: { name: string; repositories: string[] }) {
    return this.request("project.create", params);
  }

  listSandboxes() {
    return this.request("sandbox.list", {});
  }

  createSandbox(spec: unknown) {
    return this.request("sandbox.create", spec);
  }

  createConversation(params: unknown) {
    return this.request("conversation.create", params);
  }

  sendMessage(params: unknown) {
    return this.request("conversation.send", params);
  }

  cancelTask(taskId: string) {
    return this.request("task.cancel", { taskId });
  }

  reviewTask(taskId: string) {
    return this.request("git.review", { taskId });
  }

  applyChanges(params: unknown) {
    return this.request("git.apply", params);
  }

  /** One replay pass of durable task events. */
  async replayTaskEvents(params: TaskSubscribeParams): Promise<TaskEvent[]> {
    const raw = await this.request("task.subscribe", {
      ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
      ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
      afterSequence: params.afterSequence,
    });
    return decodeTaskEvents(raw);
  }

  /**
   * Start a replaying subscription. Core has no server-initiated push frame in
   * this build, so liveness comes from repeated `task.subscribe` passes keyed by
   * `afterSequence`; the checkpoint makes each pass idempotent, which is what
   * lets a reconnect (or a UI restart) catch up without duplicating events.
   */
  subscribeTasks(options: TaskSubscriptionOptions): TaskSubscription {
    const sub = new TaskSubscription(this, options);
    this.subscriptions.add(sub);
    sub.start();
    return sub;
  }

  /** Tear down every request/response association (UI detach never cancels tasks). */
  close(): void {
    this.closed = true;
    for (const sub of [...this.subscriptions]) sub.stop();
    this.subscriptions.clear();
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(
        new CoreRequestError(
          "client",
          "TRANSPORT_CLOSED",
          `the ${this.transport.kind} transport closed while ${p.method} was in flight`,
        ),
      );
    }
    this.lineUnsub();
    this.closeUnsub();
    this.transport.close();
  }

  private handleLine(line: string): void {
    let frame: RpcResponseFrame;
    try {
      frame = parseResponseFrame(line);
    } catch (err) {
      // A frame we cannot parse still carries an id most of the time. Fail the
      // request it belongs to rather than letting it hang until the deadline;
      // only a truly unattributable frame is counted as an orphan.
      const id = extractFrameId(line);
      const p = id === null ? undefined : this.pending.get(id);
      if (!p) {
        this.orphanResponses += 1;
        return;
      }
      this.pending.delete(id as string);
      if (p.timer) clearTimeout(p.timer);
      p.reject(
        new CoreRequestError(
          "client",
          "MALFORMED_FRAME",
          `${p.method} received a frame that is not a valid response: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
      return;
    }
    const p = this.pending.get(frame.id);
    if (!p) {
      this.orphanResponses += 1;
      return;
    }
    this.pending.delete(frame.id);
    if (p.timer) clearTimeout(p.timer);
    p.resolve(frame);
  }

  private handleClose(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(
        new CoreRequestError(
          "client",
          "TRANSPORT_CLOSED",
          `Core connection closed (${reason}) while ${p.method} was in flight`,
        ),
      );
    }
    // Subscriptions keep their checkpoints and simply fail their next pass;
    // the caller decides whether to reattach.
  }
}

/** Parse a Core response envelope. Kept here so `framing.ts` stays dependency-light. */
export function parseResponseFrame(line: string): RpcResponseFrame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (err) {
    throw new MalformedFrameError(`frame is not valid JSON: ${String(err)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MalformedFrameError("response frame must be a JSON object");
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.v !== "number" || typeof rec.id !== "string") {
    throw new MalformedFrameError('response frame needs numeric "v" and string "id"');
  }
  const hasOk = "ok" in rec;
  const hasErr = "err" in rec;
  if (hasOk === hasErr) {
    throw new MalformedFrameError(
      "response frame must carry exactly one of ok/err (got " +
        `${hasOk ? "ok" : "none"}/${hasErr ? "err" : "none"})`,
    );
  }
  if (hasOk) return { v: rec.v, id: rec.id, ok: rec.ok };
  const errValue = rec.err;
  if (typeof errValue !== "object" || errValue === null) {
    throw new MalformedFrameError("err payload must be an object");
  }
  const e = errValue as Record<string, unknown>;
  if (
    typeof e.code !== "string" ||
    typeof e.message !== "string" ||
    !isErrorCode(e.code)
  ) {
    throw new MalformedFrameError("err payload needs a known code and string message");
  }
  return {
    v: rec.v,
    id: rec.id,
    err: {
      code: e.code as ErrorCode,
      message: e.message,
      ...(e.details === undefined ? {} : { details: e.details }),
    },
  };
}

function extractFrameId(line: string): string | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const id = (value as Record<string, unknown>).id;
      if (typeof id === "string") return id;
    }
  } catch {
    // fall through
  }
  return null;
}

const KNOWN_ERROR_CODES = new Set<string>(ERROR_CODES);

function isErrorCode(code: string): boolean {
  return KNOWN_ERROR_CODES.has(code);
}

export function asCoreRequestError(err: unknown): CoreRequestError {
  if (err instanceof CoreRequestError) return err;
  if (err instanceof FrameTooLargeError) {
    return new CoreRequestError("client", "FRAME_TOO_LARGE", err.message);
  }
  if (err instanceof MalformedFrameError) {
    return new CoreRequestError("client", "MALFORMED_FRAME", err.message);
  }
  return new CoreRequestError(
    "client",
    "TRANSPORT_UNAVAILABLE",
    err instanceof Error ? err.message : String(err),
  );
}

// ---------------------------------------------------------------------------
// Replay subscription
// ---------------------------------------------------------------------------

export interface TaskSubscriptionOptions {
  taskId?: string;
  projectId?: string;
  /** First-pass checkpoint. Default 0 = full replay from the beginning. */
  afterSequence?: number;
  /** Called with only newly seen events (never a duplicate, never a gap-fill guess). */
  onEvents: (events: TaskEvent[]) => void;
  /** A sequence jump means events exist that this client did not see. */
  onGap?: (info: { taskId: string; from: number; to: number }) => void;
  onError?: (err: CoreRequestError) => void;
  onState?: (state: SubscriptionState) => void;
  pollIntervalMs?: number;
  /** Cap on the backoff applied after consecutive failures. */
  maxIntervalMs?: number;
}

export type SubscriptionState =
  | { kind: "idle" }
  | { kind: "polling" }
  | { kind: "backoff"; attempt: number; reason: string }
  | { kind: "stopped" };

/**
 * Owns per-task sequence checkpoints. One instance per active stream, cancelled
 * on view disposal (specs/05 §11 performance contract).
 */
export class TaskSubscription {
  /** taskId → highest sequence delivered. Survives a failed pass. */
  private readonly checkpoints = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private inFlight = false;
  private failures = 0;
  private readonly interval: number;
  private readonly maxInterval: number;

  constructor(
    private readonly client: CoreClient,
    private readonly options: TaskSubscriptionOptions,
  ) {
    this.interval = options.pollIntervalMs ?? 1_000;
    this.maxInterval = options.maxIntervalMs ?? 10_000;
    if (options.taskId) {
      this.checkpoints.set(options.taskId, options.afterSequence ?? 0);
    }
  }

  get state(): SubscriptionState {
    if (this.stopped) return { kind: "stopped" };
    if (this.failures > 0) {
      return {
        kind: "backoff",
        attempt: this.failures,
        reason: "the last task.subscribe pass failed",
      };
    }
    return this.running ? { kind: "polling" } : { kind: "idle" };
  }

  /** Highest checkpoint held, for tests and for status copy. */
  lastSequence(taskId: string): number | undefined {
    return this.checkpoints.get(taskId);
  }

  start(): void {
    if (this.stopped) return;
    this.running = true;
    this.options.onState?.(this.state);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.options.onState?.({ kind: "stopped" });
  }

  /** Reattach after a transport close: resumes from held checkpoints. */
  resume(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.start();
  }

  /** Wait for the in-flight pass to settle (tests; avoids arbitrary sleeps). */
  currentPass(): Promise<void> {
    return this.pass ?? Promise.resolve();
  }

  private pass: Promise<void> | null = null;

  private tick(): void {
    if (this.stopped) return;
    this.pass = this.runPass().finally(() => {
      this.pass = null;
      if (this.stopped) return;
      const delay = this.failures === 0
        ? this.interval
        : Math.min(this.interval * 2 ** Math.min(this.failures, 4), this.maxInterval);
      this.timer = setTimeout(() => this.tick(), delay);
    });
  }

  private async runPass(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const after = this.scopeAfterSequence();
      const events = await this.client.replayTaskEvents({
        ...(this.options.taskId !== undefined
          ? { taskId: this.options.taskId }
          : {}),
        ...(this.options.projectId !== undefined
          ? { projectId: this.options.projectId }
          : {}),
        afterSequence: after,
      });
      this.failures = 0;
      this.deliver(events);
    } catch (err) {
      this.failures += 1;
      this.options.onError?.(asCoreRequestError(err));
    } finally {
      this.inFlight = false;
      this.options.onState?.(this.state);
    }
  }

  /**
   * `task.subscribe` applies `afterSequence` per task, so the scope's minimum
   * checkpoint is what we ask for; anything already held is filtered locally.
   */
  private scopeAfterSequence(): number {
    if (this.checkpoints.size === 0) return this.options.afterSequence ?? 0;
    let min = Number.POSITIVE_INFINITY;
    for (const seq of this.checkpoints.values()) min = Math.min(min, seq);
    return Number.isFinite(min) ? min : this.options.afterSequence ?? 0;
  }

  private deliver(events: TaskEvent[]): void {
    if (events.length === 0) return;
    const fresh: TaskEvent[] = [];
    for (const event of events) {
      const seen = this.checkpoints.get(event.taskId) ?? this.options.afterSequence ?? 0;
      if (event.sequence > seen + 1 && seen > 0) {
        // Durable events exist between `seen` and `event.sequence` that this
        // pass did not return: report the hole instead of implying continuity.
        this.options.onGap?.({ taskId: event.taskId, from: seen, to: event.sequence });
      }
      if (event.sequence <= seen) continue;
      this.checkpoints.set(event.taskId, event.sequence);
      fresh.push(event);
    }
    if (fresh.length > 0) this.options.onEvents(fresh);
  }
}
