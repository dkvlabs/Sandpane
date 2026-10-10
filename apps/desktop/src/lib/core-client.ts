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
  MAX_SUBSCRIBE_CURSORS,
  PROTOCOL_VERSION,
  isMethod,
  type Conversation,
  type ConversationHistoryParams,
  type ConversationHistoryResult,
  type ConversationListParams,
  type ChangeSet,
  type ConfirmationRequest,
  type ConversationSendParams,
  type CoreCapabilities,
  type ErrorCode,
  type Method,
  type RpcOkFrame,
  type SandboxCreateSpec,
  type SandboxStopResult,
  type SandboxSummary,
  type TaskEvent,
  type TaskListParams,
  type TaskSubscribeParams,
  type TaskSummary,
} from "./protocol";
import { FrameTooLargeError, MalformedFrameError, encodeFrame } from "./framing";
import {
  decodeChangeSet,
  decodeConversationHistory,
  decodeConversations,
  decodeCoreCapabilities,
  decodeSandboxRemoveResult,
  decodeSandboxStopResult,
  decodeSandboxSummaries,
  decodeSandboxSummary,
  decodeTaskEvents,
  decodeTaskSummaries,
  decodeTaskSummary,
} from "./decode";
import {
  CoreValidationError,
  buildConversationHistoryParams,
  buildConversationListParams,
  buildSandboxRemoveConfirmParams,
  buildSandboxRemoveRequestParams,
  buildSandboxStopParams,
  buildTaskListParams,
  checkIdempotencyKey,
  buildTaskSubscribeParams,
} from "./guards";

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
  /** The native proxy found no Core listening on the per-user socket. */
  | "CORE_UNREACHABLE"
  /** The socket path is not a private socket owned by this user; nothing was sent. */
  | "SOCKET_UNTRUSTED"
  /** Core refused the connection itself (e.g. peer is another OS user) before handling it. */
  | "CORE_REFUSED_CONNECTION"
  | "TRANSPORT_CLOSED"
  | "TRANSPORT_UNAVAILABLE"
  | "FRAME_TOO_LARGE"
  | "MALFORMED_FRAME"
  | "VERSION_MISMATCH"
  | "METHOD_NOT_ALLOWED"
  /** This client refused a param before writing a frame. Not a Core verdict. */
  | "INVALID_PARAMS"
  /** Core refused a replay too large to fit one frame — recoverable, do not retry. */
  | "REPLAY_TOO_LARGE";

export type ErrorSource = "core" | "client";

/**
 * Display code for a Core `err` frame whose `code` this desktop build does not
 * recognise (a newer Core added one). It is NOT a protocol `ErrorCode` and is
 * never written to the wire: the error stays `source: "core"`, Core's own
 * message is kept verbatim, and the raw code travels in
 * `details.unrecognizedCode`. Replacing it with a client `MALFORMED_FRAME`
 * would hide Core's real verdict; reusing `INTERNAL` would claim one Core
 * never made.
 */
export const UNRECOGNIZED_CORE_CODE = "UNRECOGNIZED_CORE_CODE" as const;
export type UnrecognizedCoreCode = typeof UNRECOGNIZED_CORE_CODE;

/** A Core `err` payload as this client parsed it (code may be unrecognised). */
export interface ParsedErrPayload {
  code: ErrorCode | UnrecognizedCoreCode;
  message: string;
  details?: unknown;
}

/** A response envelope after `parseResponseFrame`. */
export type ParsedResponseFrame =
  | RpcOkFrame
  | { v: number; id: string; ok?: never; err: ParsedErrPayload };

/**
 * One error type for both failure planes: `source: "core"` carries a structured
 * protocol `ErrorCode`, `source: "client"` a transport/framing failure. UI copy
 * must show which plane failed — "Core is not running" is not "SBX is missing".
 */
export class CoreRequestError extends Error {
  constructor(
    readonly source: ErrorSource,
    readonly code: ErrorCode | ClientErrorCode | UnrecognizedCoreCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CoreRequestError";
  }

  get isCoreError(): boolean {
    return this.source === "core";
  }

  /**
   * True when a state-changing request reached Core but its answer was lost, so
   * Core may already have applied it. The UI must say "re-read state" instead
   * of offering a blind retry (a second `conversation.send` would queue a second
   * task; a second `git.apply` would re-run a one-time confirmation).
   */
  get mayHaveBeenApplied(): boolean {
    const details = this.details;
    return (
      typeof details === "object" &&
      details !== null &&
      (details as Record<string, unknown>).mayHaveBeenApplied === true
    );
  }
}

/**
 * Default RPC deadline. It must stay LONGER than the native proxy's own budget
 * (`PROXY_DEADLINE_MS` in src-tauri/src/ipc_client.rs, 12 000 ms): the proxy
 * then always reports its verdict — sent or not, answered or not — before the
 * webview gives up. `tests/protocol-drift.test.ts` enforces the ordering.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Per-method deadlines for calls Core may legitimately run long: `sandbox.create`
 * can pull an image for up to 300 s and `sandbox.list` can take up to 30 s;
 * `sandbox.stop` (stop + re-query) can take about 330 s, and `sandbox.remove`
 * step 2 (identity re-check + `rm --force`) a little longer. Each stays above
 * the proxy's own budget for that method (`proxy_deadline_ms` in ipc_client.rs:
 * 320 s / 40 s / 350 s / 390 s), per-method drift-tested.
 */
export const METHOD_TIMEOUT_MS: Readonly<Partial<Record<Method, number>>> = {
  "sandbox.create": 330_000,
  "sandbox.list": 45_000,
  "sandbox.stop": 360_000,
  "sandbox.remove": 400_000,
};

/** The webview deadline for one method with the default options. */
export function requestTimeoutFor(method: Method): number {
  return METHOD_TIMEOUT_MS[method] ?? DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Methods with no server-side effect. Mirrors `replay_safe` in
 * src-tauri/src/ipc_client.rs exactly (drift-tested). For every OTHER method a
 * lost answer is reported as "may have been applied — re-read state".
 *
 * `sandbox.stop` and `sandbox.remove` are deliberately absent — including
 * remove's step 1: it mints a single-use token in Core, and step 2 acts. Neither
 * step is ever re-sent automatically.
 */
export const REPLAY_SAFE_METHODS: ReadonlySet<Method> = new Set<Method>([
  "system.probe",
  "project.list",
  "sandbox.list",
  "task.list",
  "conversation.list",
  "conversation.history",
  "task.subscribe",
  "git.review",
]);

export function isReplaySafe(method: Method): boolean {
  return REPLAY_SAFE_METHODS.has(method);
}

/** Copy appended to a lost answer for a state-changing method. */
export const MAY_HAVE_BEEN_APPLIED_COPY =
  "The request was already handed to Core, so it may have been applied — re-read state before retrying.";

/**
 * A rejection from the native proxy (`core_request_frame`). Tauri rejects an
 * `invoke` with the serialized `ProxyError` OBJECT, not an `Error`, so this is
 * decoded explicitly rather than stringified to "[object Object]".
 */
export class ProxyTransportError extends Error {
  constructor(
    readonly proxyCode: string,
    message: string,
    readonly mayHaveBeenApplied: boolean,
  ) {
    super(message);
    this.name = "ProxyTransportError";
  }
}

export function decodeProxyRejection(err: unknown): ProxyTransportError {
  if (err instanceof ProxyTransportError) return err;
  if (typeof err === "object" && err !== null && !(err instanceof Error)) {
    const rec = err as Record<string, unknown>;
    if (typeof rec.code === "string" && typeof rec.message === "string") {
      return new ProxyTransportError(
        rec.code,
        rec.message,
        rec.mayHaveBeenApplied === true,
      );
    }
  }
  if (err instanceof Error) return new ProxyTransportError("TRANSPORT", err.message, false);
  return new ProxyTransportError("TRANSPORT", String(err), false);
}

/** Map a proxy code onto the client error plane; unknown codes stay a transport failure. */
const PROXY_CODE_MAP: Record<string, ClientErrorCode> = {
  TIMEOUT: "TIMEOUT",
  CORE_UNREACHABLE: "CORE_UNREACHABLE",
  CONNECTION_CLOSED: "TRANSPORT_CLOSED",
  CORE_REFUSED_CONNECTION: "CORE_REFUSED_CONNECTION",
  SOCKET_UNTRUSTED: "SOCKET_UNTRUSTED",
  FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
  MALFORMED_FRAME: "MALFORMED_FRAME",
  RESPONSE_ID_MISMATCH: "MALFORMED_FRAME",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  PROTOCOL_VERSION: "VERSION_MISMATCH",
  VALIDATION_FAILED: "INVALID_PARAMS",
};

function proxyFailure(method: Method, err: unknown): CoreRequestError {
  const proxy = decodeProxyRejection(err);
  const code = PROXY_CODE_MAP[proxy.proxyCode] ?? "TRANSPORT_UNAVAILABLE";
  return new CoreRequestError(
    "client",
    code,
    code === "TRANSPORT_UNAVAILABLE"
      ? `the desktop could not exchange ${method} with Core (${proxy.proxyCode}): ${proxy.message}`
      : proxy.message,
    { proxyCode: proxy.proxyCode, mayHaveBeenApplied: proxy.mayHaveBeenApplied },
  );
}

/** The protocol `ErrorCode` of a Core verdict; `null` for client or unrecognised codes. */
export function coreErrorCode(err: unknown): ErrorCode | null {
  return err instanceof CoreRequestError && err.isCoreError && isErrorCode(err.code)
    ? (err.code as ErrorCode)
    : null;
}

export interface CoreClientOptions {
  /** Default RPC deadline. Defaults to `DEFAULT_REQUEST_TIMEOUT_MS` (above the proxy budget). */
  requestTimeoutMs?: number;
  /** Per-method deadlines; defaults to `METHOD_TIMEOUT_MS`. */
  methodTimeoutsMs?: Readonly<Partial<Record<Method, number>>>;
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
  resolve: (frame: ParsedResponseFrame) => void;
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
  private readonly methodTimeoutsMs: Readonly<Partial<Record<Method, number>>>;
  private readonly nextId: () => string;
  private readonly now: () => number;

  constructor(
    private readonly transport: CoreTransport,
    options: CoreClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.methodTimeoutsMs = options.methodTimeoutsMs ?? METHOD_TIMEOUT_MS;
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

  /** The deadline this client applies to `method`. */
  timeoutFor(method: Method): number {
    return this.methodTimeoutsMs[method] ?? this.requestTimeoutMs;
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

    const response = await new Promise<ParsedResponseFrame>((resolve, reject) => {
      const timeoutMs = this.timeoutFor(method);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      void Promise.resolve(this.transport.write(encoded)).catch((err: unknown) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        p.reject(proxyFailure(method, err));
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

  /**
   * `sandbox.create`, decoded. An `idempotencyKey` (A2) is checked against
   * Core's rule before the frame is written. A response with `replayed: true`
   * is the FIRST create's answer, not current state — the caller re-reads.
   */
  async createSandboxSummary(spec: SandboxCreateSpec): Promise<SandboxSummary> {
    const params = preflight(() => checkIdempotencyKey(spec));
    return this.keyedWrite("sandbox.create", params, decodeSandboxSummary);
  }

  /**
   * One `sandbox.create` / `conversation.send` exchange with honest failure
   * semantics for a write (A2 review W3/W4):
   * - Core answered `ok` but the answer cannot be decoded → Core may have
   *   applied it: an unknown outcome (`mayHaveBeenApplied`), never a plain
   *   "client error, retry". The payload is never echoed.
   * - Core `INTERNAL` → also an unknown outcome (sbx/Core may have acted).
   * Every such error records whether the request carried an idempotency key,
   * so the copy can say whether a retry is safe.
   */
  private async keyedWrite<P extends { idempotencyKey?: string }, R>(
    method: "sandbox.create" | "conversation.send",
    params: P,
    decode: (value: unknown) => R,
  ): Promise<R> {
    const keyed = typeof params.idempotencyKey === "string";
    let raw: unknown;
    try {
      raw = await this.request(method, params);
    } catch (err) {
      throw markWriteOutcome(asCoreRequestError(err), keyed);
    }
    try {
      return decode(raw);
    } catch {
      throw new CoreRequestError(
        "client",
        "MALFORMED_FRAME",
        `Core answered ${method}, but this desktop build could not read the answer. ${MAY_HAVE_BEEN_APPLIED_COPY}`,
        { mayHaveBeenApplied: true, idempotencyKeyed: keyed },
      );
    }
  }

  createConversation(params: unknown) {
    return this.request("conversation.create", params);
  }

  sendMessage(params: unknown) {
    return this.request("conversation.send", params);
  }

  /**
   * `conversation.send`, decoded. Core has APPLIED the send once it answers
   * `ok`, so the returned `TaskSummary` must decode even when its status is one
   * this build does not recognise — failing here would report an accepted task
   * as failed and invite a duplicate send.
   */
  async sendConversationMessage(params: ConversationSendParams): Promise<TaskSummary> {
    const checked = preflight(() => checkIdempotencyKey(params));
    return this.keyedWrite("conversation.send", checked, decodeTaskSummary);
  }

  /** `sandbox.list`, decoded (an unrecognised workspace mode reads as UNVERIFIED). */
  async listSandboxSummaries(): Promise<SandboxSummary[]> {
    return decodeSandboxSummaries(await this.request("sandbox.list", {}));
  }

  /**
   * `sandbox.stop` (A1, feature-gated on `system.probe`). Not destructive, so no
   * token. The result's `requeried` row is the post-stop state; when it is
   * ABSENT the state is unknown — never read it as "stopped". Not replay-safe:
   * a lost answer says "may have been applied", and nothing retries it.
   */
  async stopSandbox(name: string): Promise<SandboxStopResult> {
    const params = preflight(() => buildSandboxStopParams(name));
    return decodeSandboxStopResult(await this.request("sandbox.stop", params));
  }

  /**
   * `sandbox.remove` STEP 1: sends exactly `{ name }`. Core changes nothing and
   * answers a confirmation (token, expiry, impact, external). The confirmation
   * must name the sandbox that was asked about; anything else is refused so a
   * token can never be confirmed against the wrong target.
   */
  async requestSandboxRemoval(name: string): Promise<ConfirmationRequest> {
    const params = preflight(() => buildSandboxRemoveRequestParams(name));
    const result = decodeSandboxRemoveResult(await this.request("sandbox.remove", params));
    if (result.kind !== "confirmation") {
      throw new CoreRequestError(
        "client",
        "MALFORMED_FRAME",
        "sandbox.remove step 1 answered `removed` without a confirmation token; re-read the sandbox list",
        { mayHaveBeenApplied: true },
      );
    }
    if (result.confirmation.target.name !== params.name) {
      throw new CoreRequestError(
        "client",
        "MALFORMED_FRAME",
        "sandbox.remove confirmation names a different sandbox than the one requested; nothing was confirmed",
      );
    }
    return result.confirmation;
  }

  /**
   * `sandbox.remove` STEP 2: sends `{ name, confirmToken }` with the token from
   * step 1. Only a decoded `removed: true` is a success. Core answers a bad,
   * expired or reused token with `VALIDATION_FAILED`, a same-named replacement
   * with `CONFLICT`, and a vanished sandbox with `NOT_FOUND`. Never retried.
   */
  async confirmSandboxRemoval(name: string, confirmToken: string): Promise<{ removed: true }> {
    const params = preflight(() => buildSandboxRemoveConfirmParams(name, confirmToken));
    const result = decodeSandboxRemoveResult(await this.request("sandbox.remove", params));
    if (result.kind !== "removed") {
      throw new CoreRequestError(
        "client",
        "MALFORMED_FRAME",
        "sandbox.remove step 2 answered with a new confirmation instead of `removed`; nothing is reported as removed",
      );
    }
    return { removed: true };
  }

  /** `git.review`, decoded (an unrecognised file status is listed, never applied). */
  async reviewChangeSet(taskId: string): Promise<ChangeSet> {
    return decodeChangeSet(await this.request("git.review", { taskId }));
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

  /**
   * `task.list` — read-only discovery of Core task state (ADDITIVE v1: a
   * pre-revision Core does not dispatch it, so callers feature-detect with
   * `coreAdvertisesMethod(capabilities, "task.list")` first).
   *
   * Statuses are displayed exactly as Core stores them; this client computes no
   * transitions (AGENTS rule 3). Params are guarded before the frame is written.
   */
  async listTasks(params: TaskListParams = {}): Promise<TaskSummary[]> {
    return decodeTaskSummaries(
      await this.request("task.list", preflight(() => buildTaskListParams(params))),
    );
  }

  /**
   * `conversation.list` — chat enumeration (ADDITIVE v1, feature-gated).
   * Core excludes archived conversations, so this is what a sidebar may reopen.
   */
  async listConversations(
    params: ConversationListParams = {},
  ): Promise<Conversation[]> {
    return decodeConversations(
      await this.request(
        "conversation.list",
        preflight(() => buildConversationListParams(params)),
      ),
    );
  }

  /**
   * `conversation.history` — bounded transcript read (ADDITIVE v1, feature-gated).
   * Returns an OBJECT with `truncated` + `nextSequence`; the caller must surface a
   * truncation rather than present a partial page as the whole conversation.
   */
  async getConversationHistory(
    params: ConversationHistoryParams,
  ): Promise<ConversationHistoryResult> {
    return decodeConversationHistory(
      await this.request(
        "conversation.history",
        preflight(() => buildConversationHistoryParams(params)),
      ),
    );
  }

  /**
   * One replay pass of durable task events.
   *
   * The payload is built by `buildTaskSubscribeParams`, which mirrors Core's
   * cursor rules exactly: a `taskId` request replays that ONE task from the
   * scalar and never carries a map (Core ignores it); a scope-wide request
   * replays each task from its own `afterSequences` cursor when the caller holds
   * per-task checkpoints, and falls back to the shared scalar when it does not.
   */
  async replayTaskEvents(params: TaskSubscribeParams): Promise<TaskEvent[]> {
    const raw = await this.request(
      "task.subscribe",
      preflight(() => buildTaskSubscribeParams(params)),
    );
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
    let frame: ParsedResponseFrame;
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

/**
 * Annotate a failed keyed-write exchange: record `idempotencyKeyed`, and treat a
 * Core `INTERNAL` as an unknown outcome. Every other verdict is kept as is.
 */
function markWriteOutcome(err: CoreRequestError, keyed: boolean): CoreRequestError {
  const details =
    typeof err.details === "object" && err.details !== null && !Array.isArray(err.details)
      ? (err.details as Record<string, unknown>)
      : err.details === undefined
        ? {}
        : { coreDetails: err.details };
  const unknown = err.mayHaveBeenApplied || (err.isCoreError && err.code === "INTERNAL");
  return new CoreRequestError(err.source, err.code, err.message, {
    ...details,
    ...(unknown ? { mayHaveBeenApplied: true } : {}),
    idempotencyKeyed: keyed,
  });
}

/**
 * The client-side deadline error. For a state-changing method the frame was
 * already handed to the transport, so the copy must not suggest a plain retry.
 */
export function timeoutError(method: Method, timeoutMs: number): CoreRequestError {
  const applied = !isReplaySafe(method);
  return new CoreRequestError(
    "client",
    "TIMEOUT",
    applied
      ? `${method} did not answer within ${timeoutMs} ms. ${MAY_HAVE_BEEN_APPLIED_COPY}`
      : `${method} did not answer within ${timeoutMs} ms`,
    { mayHaveBeenApplied: applied },
  );
}

/**
 * Parse a Core response envelope. Kept here so `framing.ts` stays dependency-light.
 *
 * An `err` frame with a well-formed but UNRECOGNISED code (a newer Core) is
 * kept as Core's verdict under `UNRECOGNIZED_CORE_CODE` — message verbatim, raw
 * code in `details.unrecognizedCode` — instead of failing as a malformed frame.
 * A non-string or empty code, or a non-string message, is still malformed.
 */
export function parseResponseFrame(line: string): ParsedResponseFrame {
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
  if (typeof e.code !== "string" || e.code.length === 0 || typeof e.message !== "string") {
    throw new MalformedFrameError("err payload needs a non-empty string code and string message");
  }
  if (isErrorCode(e.code)) {
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
  return {
    v: rec.v,
    id: rec.id,
    err: {
      code: UNRECOGNIZED_CORE_CODE,
      message: e.message,
      details: unrecognizedCodeDetails(e.code, e.details),
    },
  };
}

/**
 * Keep Core's own `details` next to the raw code. An object is spread (so
 * `hint`/`provider` stay where `describeCoreError` reads them) with
 * `unrecognizedCode` added; any other present value is nested as `coreDetails`.
 */
function unrecognizedCodeDetails(code: string, details: unknown): Record<string, unknown> {
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    return { ...(details as Record<string, unknown>), unrecognizedCode: code };
  }
  return details === undefined
    ? { unrecognizedCode: code }
    : { unrecognizedCode: code, coreDetails: details };
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
  if (err instanceof CoreValidationError) {
    // This client refused it; Core never saw the request. The UI must say which
    // plane failed, so this is a `source: "client"` error, not a fake Core code.
    return new CoreRequestError("client", "INVALID_PARAMS", err.message, {
      field: err.field,
    });
  }
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

/**
 * Build a request payload behind the guard wall.
 *
 * A refusal must reach the caller as the same `CoreRequestError` shape every
 * other failure uses (so React Query error handling stays uniform), while still
 * being identifiable as `source: "client"` — Core never saw this request. The
 * payload is built BEFORE `request()` runs, so nothing is written on a refusal.
 */
function preflight<T>(build: () => T): T {
  try {
    return build();
  } catch (err) {
    if (err instanceof CoreValidationError) throw asCoreRequestError(err);
    throw err;
  }
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
  /**
   * Core refused THIS scope's replay as too large to fit one frame
   * (`VALIDATION_FAILED` naming the byte ceiling). The subscription stops
   * pulling — re-asking can never succeed — and the view says so.
   */
  onReplayRefused?: (reason: string) => void;
  onState?: (state: SubscriptionState) => void;
  pollIntervalMs?: number;
  /** Cap on the backoff applied after consecutive failures. */
  maxIntervalMs?: number;
}

export type SubscriptionState =
  | { kind: "idle" }
  | { kind: "polling" }
  | { kind: "backoff"; attempt: number; reason: string }
  /** Core refused the replay as undeliverable; polling is stopped, not failed. */
  | { kind: "refused"; reason: string }
  | { kind: "stopped" };

/**
 * Core's structured refusal of a replay that cannot fit one IPC frame
 * (`task.subscribe` has no truncation envelope, so it answers `VALIDATION_FAILED`
 * naming the byte ceiling instead of emitting a frame both ends would reject).
 *
 * Detection is deliberately narrow: the code must be Core's `VALIDATION_FAILED`
 * AND the message must name the replay ceiling, so an ordinary validation failure
 * is never mislatched as "stop polling".
 */
export function isOversizedReplayRefusal(err: unknown): boolean {
  const error = asCoreRequestError(err);
  if (error.code !== "VALIDATION_FAILED") return false;
  return /task\.subscribe/i.test(error.message) && /ceiling/i.test(error.message);
}

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
  /** Core's verbatim refusal text when the last replay was too large; else null. */
  private replayRefusal: string | null = null;
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
    if (this.replayRefusal !== null) {
      return { kind: "refused", reason: this.replayRefusal };
    }
    if (this.failures > 0) {
      return {
        kind: "backoff",
        attempt: this.failures,
        reason: "the last task.subscribe pass failed",
      };
    }
    return this.running ? { kind: "polling" } : { kind: "idle" };
  }

  /**
   * Core's refusal text when the last replay could not fit one frame, else null.
   * A refused replay is NOT retried: re-asking for the same scope can never
   * succeed, so polling stops until the caller narrows the request.
   */
  get replayRefused(): string | null {
    return this.replayRefusal;
  }

  /**
   * Re-arm after the caller narrowed the request (single `taskId`, a higher
   * cursor, or a smaller project). Nothing is fetched until the next tick.
   */
  clearReplayRefusal(): void {
    this.replayRefusal = null;
    this.failures = 0;
    if (!this.stopped && this.timer === null) {
      this.options.onState?.(this.state);
      this.tick();
    } else {
      this.options.onState?.(this.state);
    }
  }

  /** Highest checkpoint held, for tests and for status copy. */
  lastSequence(taskId: string): number | undefined {
    return this.checkpoints.get(taskId);
  }

  /** Every checkpoint held (display-only copy; Core stays the authority). */
  checkpointSnapshot(): Record<string, number> {
    return Object.fromEntries(this.checkpoints.entries());
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

  /**
   * Run one replay pass immediately from the held per-task cursors.
   *
   * The poll loop covers the ordinary case; this is the explicit pull behind a
   * "Re-check Core" action and behind a reconnect hydration, and it resumes from
   * the cursors already held, so it never re-floods what was delivered.
   *
   * A latched oversized refusal is honored: pulling the SAME scope again could
   * never fit one frame, so this resolves without writing a request. The caller
   * narrows first (`clearReplayRefusal` after a smaller scope), then pulls.
   */
  async catchUpNow(): Promise<void> {
    if (this.stopped || this.replayRefusal !== null) return;
    // Join a pull already in flight instead of returning early: an explicit
    // "catch up now" that silently no-ops because the poll loop happened to
    // start a moment earlier would leave the caller believing it is current.
    if (this.pass) {
      await this.pass;
      return;
    }
    await this.runPass();
  }

  /** Seed a checkpoint (used when `task.list` hydration proves a task exists). */
  noteSequence(taskId: string, sequence: number): void {
    const held = this.checkpoints.get(taskId) ?? 0;
    if (sequence > held) this.checkpoints.set(taskId, sequence);
  }

  private pass: Promise<void> | null = null;

  private tick(): void {
    if (this.stopped) return;
    // A refused replay is not a transient failure: re-sending the same scope can
    // never fit a frame, so the loop stops instead of hammering Core.
    if (this.replayRefusal !== null) return;
    this.pass = this.runPass().finally(() => {
      this.pass = null;
      if (this.stopped || this.replayRefusal !== null) return;
      const delay = this.failures === 0
        ? this.interval
        : Math.min(this.interval * 2 ** Math.min(this.failures, 4), this.maxInterval);
      this.timer = setTimeout(() => this.tick(), delay);
    });
  }

  private async runPass(): Promise<void> {
    // Re-entrant safety: a tick that fires while a pass is still running shares
    // that pass instead of dropping it or racing a second frame on the socket.
    if (this.inFlight) {
      await this.pass;
      return;
    }
    this.inFlight = true;
    try {
      const events = await this.client.replayTaskEvents(this.passParams());
      this.failures = 0;
      this.deliver(events);
    } catch (err) {
      if (isOversizedReplayRefusal(err)) {
        const refusal = asCoreRequestError(err);
        this.replayRefusal = refusal.message;
        this.options.onError?.(
          new CoreRequestError(
            "core",
            "REPLAY_TOO_LARGE",
            refusal.message,
            refusal.details,
          ),
        );
        // Not counted as a backoff attempt: this one needs the caller to narrow
        // the request, so a retry would be a storm against a fixed verdict.
        this.options.onReplayRefused?.(refusal.message);
        return;
      }
      this.failures += 1;
      this.options.onError?.(asCoreRequestError(err));
    } finally {
      this.inFlight = false;
      this.options.onState?.(this.state);
    }
  }

  /**
   * The cursor set for one pass, honoring Core's rules exactly.
   *
   * Task-scoped: that task's own checkpoint as the scalar (a map would be
   * ignored by Core, so none is built).
   *
   * Scope-wide (project or global): once ANY checkpoint is held, the checkpoints
   * go out as `afterSequences` so each task resumes from its OWN cursor. The
   * shared scalar is only the floor for the very first pass, when there is
   * nothing to map — which is the legacy behaviour, unchanged.
   *
   * Bounded to `MAX_SUBSCRIBE_CURSORS`: when the checkpoint is larger than the
   * bound, the OLDEST entries are the ones dropped, so those tasks replay IN
   * FULL. That is the safe direction — nothing is skipped, the checkpoint simply
   * re-drops a redelivery — and `cursorsDropped` reports the count so the UI can
   * say so instead of hiding it.
   */
  private passParams(): TaskSubscribeParams {
    const scope = {
      ...(this.options.taskId !== undefined ? { taskId: this.options.taskId } : {}),
      ...(this.options.projectId !== undefined
        ? { projectId: this.options.projectId }
        : {}),
    };
    if (this.options.taskId !== undefined) {
      return {
        ...scope,
        afterSequence: this.checkpoints.get(this.options.taskId) ?? this.options.afterSequence ?? 0,
      };
    }
    const cursors = this.scopeCursors();
    return {
      ...scope,
      afterSequence: this.options.afterSequence ?? 0,
      ...(cursors === undefined ? {} : { afterSequences: cursors }),
    };
  }

  /** Number of checkpoints left out of the last `afterSequences` map, if any. */
  get cursorsDropped(): number {
    return this.dropped;
  }

  private dropped = 0;

  private scopeCursors(): Record<string, number> | undefined {
    if (this.checkpoints.size === 0) return undefined;
    const entries = [...this.checkpoints.entries()];
    if (entries.length > MAX_SUBSCRIBE_CURSORS) {
      this.dropped = entries.length - MAX_SUBSCRIBE_CURSORS;
      return Object.fromEntries(entries.slice(this.dropped));
    }
    this.dropped = 0;
    return Object.fromEntries(entries);
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
