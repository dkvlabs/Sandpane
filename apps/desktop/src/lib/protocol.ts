/**
 * Sandpane Core protocol — TypeScript mirror of `core/crates/sandpane-protocol`
 * (and the `MAX_FRAME_BYTES` cap from `core/crates/sandpane-service`).
 *
 * Naming fidelity rules, enforced by these declarations:
 * - struct fields are `camelCase` on the wire (`#[serde(rename_all = "camelCase")]`),
 *   so `created_at` in Rust is `createdAt` here;
 * - enum variants of `TaskStatus` / `WorkspaceMode` / `FileChangeStatus` /
 *   `ContextRefKind` are `snake_case` strings;
 * - `ErrorCode` is `SCREAMING_SNAKE_CASE`;
 * - `AgentEvent` is a tagged union discriminated by `type` with dotted names.
 *
 * If the Rust types or `schemas/*.json` change, this file and the schema must be
 * updated together (AGENTS.md §Code Review rule 8). There is no codegen in this
 * scaffold; drift is checked by the unit suites in `tests/protocol-fixture`
 * assertions against documented wire strings.
 */

/** Bumped on any breaking frame/semantics change; negotiated via `system.probe`. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Hard cap on one NDJSON frame. Mirrors
 * `sandpane_service::MAX_FRAME_BYTES` (4 MiB). Clients refuse to buffer beyond
 * it rather than growing without bound.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * `sandpane_service::DEFAULT_LIST_LIMIT` — rows Core returns when a bounded read
 * asks for no limit. The client never substitutes it into a payload: leaving
 * `limit` absent means Core's own default is the one that applies.
 */
export const DEFAULT_LIST_LIMIT = 200;

/**
 * `sandpane_service::MAX_LIST_LIMIT` — hard ceiling on rows from any single
 * bounded read. Core clamps an oversized request rather than honouring it, so
 * the client clamps identically *before writing the frame* (AGENTS rule 2:
 * validate before the argument) and the two verdicts cannot disagree.
 */
export const MAX_LIST_LIMIT = 500;

/**
 * `sandpane_service::MAX_HISTORY_BYTES` — the content ceiling behind
 * `conversation.history`'s `truncated` flag. Used only to explain a truncation
 * to the user; Core measures the actual serialized bytes.
 */
export const MAX_HISTORY_BYTES = 2 * 1024 * 1024;

/** `sandpane_service::MAX_SUBSCRIBE_CURSORS` — entries in an `afterSequences` map. */
export const MAX_SUBSCRIBE_CURSORS = 4096;

/** `sandpane_service::MAX_CURSOR_KEY_LEN` — BYTE length of an `afterSequences` key. */
export const MAX_CURSOR_KEY_LEN = 100;

/**
 * `sandpane_service::MAX_SCOPING_ID_LEN` — length bound on an id that merely
 * scopes a read (`projectId`, `conversationId`). Core runs it through
 * `Validator::display_text`, which refuses an empty value; the client mirrors
 * that so a typo'd blank id is a local, structured refusal instead of a
 * silently empty list that reads as "no tasks".
 */
export const MAX_SCOPING_ID_LEN = 200;

// ---------------------------------------------------------------------------
// Error codes + methods
// ---------------------------------------------------------------------------

/** Structured error codes. Transport-level failures use `INTERNAL`. */
export type ErrorCode =
  | "NOT_INSTALLED"
  | "DAEMON_DOWN"
  | "UNSUPPORTED_SBX_VERSION"
  | "PROVIDER_AUTH_REQUIRED"
  | "CONFLICT"
  | "TASK_INTERRUPTED"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "INTERNAL";

export const ERROR_CODES: readonly ErrorCode[] = [
  "NOT_INSTALLED",
  "DAEMON_DOWN",
  "UNSUPPORTED_SBX_VERSION",
  "PROVIDER_AUTH_REQUIRED",
  "CONFLICT",
  "TASK_INTERRUPTED",
  "PERMISSION_DENIED",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "INTERNAL",
];

/**
 * The complete allowlisted method surface (`sandpane_protocol::Method`), in the
 * order of Rust's `Method::ALL` — the list that backs
 * `CoreCapabilities.methods`. Deliberately there is no free-form execution
 * method — a client must never invent one, and an unknown name is rejected by
 * Core with `VALIDATION_FAILED`.
 *
 * `conversation.list`, `conversation.history` and `task.list` are ADDITIVE v1
 * methods: a pre-revision Core does not dispatch them, so callers feature-detect
 * with `coreAdvertisesMethod` instead of assuming (AGENTS rule 5). So are the A1
 * lifecycle methods `sandbox.stop` and `sandbox.remove` (design 2026-10-09 §3).
 * There is deliberately NO `sandbox.start`: sbx v0.47 has no `start` command.
 */
export const METHODS = [
  "system.probe",
  "project.create",
  "project.list",
  "sandbox.list",
  "sandbox.create",
  "sandbox.stop",
  "sandbox.remove",
  "conversation.create",
  "conversation.send",
  "conversation.list",
  "conversation.history",
  "task.cancel",
  "task.list",
  "task.subscribe",
  "git.review",
  "git.apply",
] as const;

export type Method = (typeof METHODS)[number];

export function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value);
}

/**
 * Feature discovery: does THIS Core advertise `method` in `system.probe`?
 *
 * `CoreCapabilities.methods` is derived from Rust's `Method::ALL`, so it is what
 * the running service actually dispatches — a protocol version number is not.
 * An absent or empty list means the Core predates method advertisement, which
 * means "not advertised", never "assume yes".
 */
export function coreAdvertisesMethod(
  capabilities: Pick<CoreCapabilities, "methods"> | null | undefined,
  method: Method,
): boolean {
  const advertised = capabilities?.methods;
  return Array.isArray(advertised) && advertised.includes(method);
}

// ---------------------------------------------------------------------------
// RPC frames
// ---------------------------------------------------------------------------

/** Client → Core request frame. */
export interface RpcRequest<M extends Method = Method> {
  v: number;
  id: string;
  method: M;
  params: unknown;
}

export interface RpcErrorPayload {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/** Core → client success frame (`RpcOutcome::Ok` flattened). */
export interface RpcOkFrame {
  v: number;
  id: string;
  ok: unknown;
  err?: never;
}

/** Core → client failure frame (`RpcOutcome::Err` flattened). */
export interface RpcErrFrame {
  v: number;
  id: string;
  ok?: never;
  err: RpcErrorPayload;
}

export type RpcResponseFrame = RpcOkFrame | RpcErrFrame;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** `system.probe` result: identity + capability discovery. */
export interface CoreCapabilities {
  protocolVersion: number;
  coreVersion: string;
  /** Unique per running Core instance; changes across restarts. */
  instanceId: string;
  /** `null`/absent when SBX was never located. */
  sbx: SbxStatus | null;
  agents: AgentCapability[];
  platform: string;
  /**
   * Wire names of every method THIS Core dispatches (`Method::ALL`). Feature
   * discovery goes through `coreAdvertisesMethod`, never a version guess.
   * Optional because a pre-discovery Core omits it (`#[serde(default)]`); an
   * absent/empty list means "not advertised", not "all".
   */
  methods?: string[];
  /**
   * Optional protocol features THIS Core implements (A2, additive): behaviour a
   * client cannot infer from `methods`, because a Core that predates a request
   * field silently drops it. Absent on a pre-A2 Core = nothing advertised.
   * Unknown strings are kept but never acted on (`coreAdvertisesFeature`).
   */
  features?: string[];
}

/** `sandbox.create` / `conversation.send` honour `idempotencyKey` (A2). */
export const FEATURE_IDEMPOTENCY_KEYS = "idempotency-keys" as const;
/** `sandbox.create` honours `agent` (A1). */
export const FEATURE_SANDBOX_CREATE_AGENT = "sandbox-create-agent" as const;

/**
 * Every feature this desktop build knows, in Rust `FEATURES` order
 * (drift-tested against `sandpane_protocol::FEATURES` and the schema's
 * `features.items.examples`). Unknown advertised strings are ignored.
 */
export const KNOWN_FEATURES = [FEATURE_IDEMPOTENCY_KEYS, FEATURE_SANDBOX_CREATE_AGENT] as const;
export type KnownFeature = (typeof KNOWN_FEATURES)[number];

/** Does THIS Core advertise `feature`? Absent/empty list = no. */
export function coreAdvertisesFeature(
  capabilities: Pick<CoreCapabilities, "features"> | null | undefined,
  feature: KnownFeature,
): boolean {
  const advertised = capabilities?.features;
  return Array.isArray(advertised) && advertised.includes(feature);
}

/**
 * Core's idempotency-key rule (A2): 1..=128 characters of `[A-Za-z0-9._-]`.
 * Exactly Core's — never stricter — so a key Core accepts is never refused here.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface SbxStatus {
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  daemonRunning: boolean | null;
}

export interface AgentCapability {
  id: string;
  /** True only after the adapter passed its in-SBX feasibility gate (P0). */
  verified: boolean;
  supportsStreaming: boolean;
  supportsCancel: boolean;
  /** Native-session resume is advertised ONLY after restart tests pass. */
  supportsResume: boolean;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  /**
   * Host paths registered with this project (`repositories.canonical_path`,
   * insertion-ordered). Optional: a pre-revision Core omits it.
   *
   * Honest caveat carried from the Rust doc — the stored value is what the
   * CALLER registered. `project.create` requires an absolute path, and Core
   * canonicalizes (resolves symlinks) at `sandbox.create` mount time, not at
   * registration. A client matching a folder against these must canonicalize
   * both sides; a plain string compare is not proof of identity.
   */
  repositories?: string[];
}

export interface ProjectCreateParams {
  name: string;
  repositories: string[];
}

export interface SandboxCreateSpec {
  name: string;
  projectId: string;
  workspaceMode: WorkspaceMode;
  repoPath?: string;
  /**
   * Built-in sbx agent the sandbox is created with (A1, additive). Absent →
   * Core uses the provider-free `shell`. Only an exact member of `SBX_AGENTS`
   * may ever be sent; Core refuses anything else (kit references run
   * third-party code). Accepting a provider agent is NOT a verification claim.
   */
  agent?: SbxAgent;
  /**
   * Retry-safety key (A2). Sent ONLY when Core advertises `idempotency-keys`;
   * one fresh key per user action, reused only by an explicit "Retry safely".
   */
  idempotencyKey?: string;
}

/**
 * Built-in agents of the captured `sbx v0.47.0 create --help`, mirrored from
 * `sandpane_core::validation::SBX_AGENTS_V0_47` and the `agent` enum of
 * `schemas/sandbox-create-spec.schema.json` (drift-tested against both).
 */
export const SBX_AGENTS = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "devin",
  "docker-agent",
  "droid",
  "gemini",
  "kiro",
  "opencode",
  "shell",
] as const;

export type SbxAgent = (typeof SBX_AGENTS)[number];

/** Core's default when `agent` is absent: the provider-free shell. */
export const DEFAULT_SBX_AGENT: SbxAgent = "shell";

export function isSbxAgent(value: unknown): value is SbxAgent {
  return typeof value === "string" && (SBX_AGENTS as readonly string[]).includes(value);
}

export interface SandboxSummary {
  name: string;
  /** Last probed state — never assumed, never inferred from a cached row. */
  probedState: string | null;
  boundProjectId: string | null;
  /**
   * The workspace mode recorded in Core's newest `sandbox_bindings` row for this
   * name — a RECORD of what Core was asked to bind, not a live SBX verification.
   * `direct_mount` is LIVE-WRITABLE and must be labelled as such (specs/02 §7).
   *
   * `null` means Core has no readable binding row (or an unreadable stored
   * value). A UI showing a probed state with no mode must render the mode as
   * UNVERIFIED and treat it as live-writable — never blank-as-safe.
   */
  workspaceMode: WorkspaceMode | null;
  /**
   * CLIENT-SIDE ONLY (never on the wire): the raw `workspaceMode` string when
   * Core sent a mode this desktop build does not recognise — a newer Core added
   * one. `workspaceMode` is then `null`, so every view lands on the UNVERIFIED,
   * live-writable reading (rule 4) and never on an isolation claim; this field
   * exists only so the UI can say what Core actually sent.
   */
  unrecognizedWorkspaceMode?: string;
  /**
   * The agent sbx itself reports for this sandbox in `ls --json` (A1,
   * additive). A probed FACT, never a verification claim — verification lives
   * only in `CoreCapabilities.agents[].verified`. Absent when sbx reported none
   * or the Core predates A1; the key is then omitted, never invented.
   */
  agent?: string;
  /**
   * A2: present (`true`) ONLY when this is a REPLAY of an earlier keyed
   * `sandbox.create` — the FIRST response, unchanged. It is NOT current state:
   * the sandbox may since have been stopped or removed; re-read `sandbox.list`.
   */
  replayed?: true;
  /** CLIENT-SIDE ONLY: Core sent a non-boolean `replayed` — maybe a replay. */
  replayedUncertain?: true;
}

/** `sandbox.stop` params (A1). Not destructive: no confirmation token. */
export interface SandboxStopParams {
  name: string;
}

/**
 * `sandbox.stop` result. `stopped: true` only says `sbx stop` exited 0. The
 * state is whatever the post-stop re-query reported in `requeried`; ABSENT
 * means the sandbox is no longer listed or the re-query failed, and the UI must
 * show the state as UNKNOWN — never assume "stopped".
 */
export interface SandboxStopResult {
  stopped: boolean;
  requeried?: SandboxSummary;
}

/** `sandbox.remove` params (A1, two-step confirmation; design 2026-10-09 §2). */
export interface SandboxRemoveParams {
  name: string;
  /** Step 2 only. Step 1 omits the key entirely. */
  confirmToken?: string;
}

/** The identity a confirmation token is bound to (name AND sbx id). */
export interface ConfirmationTarget {
  name: string;
  id: string;
}

/**
 * Core's server-side destructive-action confirmation. The token is 256-bit,
 * single-use, memory-only in Core, and expires at `expiresAt` (RFC 3339 UTC).
 * `external: true` means Core cannot confirm Sandpane created the target: no
 * Sandpane binding is recorded for this sbx id. That covers a sandbox made
 * outside Sandpane, a pre-A1 binding with no recorded id, and a binding that
 * belongs to an earlier sandbox with a different sbx id — so clients must NOT
 * claim "created outside Sandpane". Shown prominently with every `impact` line.
 */
export interface ConfirmationRequest {
  /** 64 lowercase hex characters. Never logged, routed or persisted. */
  token: string;
  expiresAt: string;
  action: string;
  target: ConfirmationTarget;
  impact: string[];
  external: boolean;
}

/** Token shape Core issues (256 bits as lowercase hex). */
export const CONFIRM_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * `sandbox.remove` result as this client decodes it: exactly one of the two
 * wire fields is present — `confirmation` (step 1, nothing changed) or
 * `removed: true` (step 2).
 */
export type SandboxRemoveResult =
  | { kind: "confirmation"; confirmation: ConfirmationRequest }
  | { kind: "removed" };

export type WorkspaceMode =
  | "direct_mount"
  | "sbx_clone"
  | "host_worktree"
  | "mountless";

export const WORKSPACE_MODES: readonly WorkspaceMode[] = [
  "direct_mount",
  "sbx_clone",
  "host_worktree",
  "mountless",
];

export interface ConversationCreateParams {
  projectId: string;
  agentId: string;
  sandboxId?: string;
  title: string;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  agentId: string;
  createdAt: string;
}

export interface ContextRef {
  kind: ContextRefKind;
  /** Path or identifier — validated and never executed. */
  target: string;
}

export type ContextRefKind = "file" | "selection" | "diagnostics" | "diff_range";

export interface ConversationSendParams {
  conversationId: string;
  content: string;
  attachments: ContextRef[];
  /** Retry-safety key (A2); same rules as `SandboxCreateSpec.idempotencyKey`. */
  idempotencyKey?: string;
}

/**
 * `task.subscribe` params. Cursor rules mirrored exactly from
 * `TaskSubscribeParams` in Rust (the v1 cursor-ambiguity resolution):
 *
 * * `taskId` present → that ONE task replays from the scalar `afterSequence`;
 *   `afterSequences` is IGNORED by Core, so this client never puts it on the
 *   wire alongside a `taskId` (sending it would suggest it does something).
 * * `taskId` absent → with `afterSequences`, EACH task replays from its OWN
 *   cursor (`afterSequences[taskId]`, missing ⇒ 0 = full history); without it,
 *   every task falls back to the shared scalar exactly as before.
 *
 * Consequence to plan for: a map naming only SOME tasks means the unnamed ones
 * replay IN FULL, so a client catching up a large project must name every task
 * it has already seen.
 */
export interface TaskSubscribeParams {
  projectId?: string;
  taskId?: string;
  /** Replay everything strictly after this per-task sequence number. */
  afterSequence: number;
  /**
   * task id → last sequence durably seen for THAT task. Sequences are per task
   * and start at 1, so a shared scalar cannot describe several tasks — that was
   * the recorded v1 gap. Ignored when `taskId` is set.
   */
  afterSequences?: Record<string, number>;
}

/**
 * `task.list` params — read-only discovery of Core task state.
 * ADDITIVE v1 method: feature-detect before calling against an unknown Core.
 */
export interface TaskListParams {
  /** Scope to one project (tasks reached through its conversations). Absent = all. */
  projectId?: string;
  /**
   * Only tasks currently in one of these statuses. These are Core's OWN stored
   * values; an unknown status string is refused, never normalized.
   */
  statuses?: readonly TaskStatus[];
  /** Rows to return; Core clamps to 1..=500 and defaults to 200. */
  limit?: number;
}

/** `conversation.list` params — read-only chat enumeration (ADDITIVE v1). */
export interface ConversationListParams {
  /** Scope to one project. Absent = every conversation Core knows about. */
  projectId?: string;
  /** Rows to return; Core clamps to 1..=500 and defaults to 200. */
  limit?: number;
}

/** `conversation.history` params — bounded transcript read (ADDITIVE v1). */
export interface ConversationHistoryParams {
  conversationId: string;
  /** Return messages strictly after this per-conversation sequence. */
  afterSequence?: number;
  /**
   * Rows to return; Core clamps to 1..=500, defaults to 200, and additionally
   * stops on a total-bytes ceiling so one huge row cannot overflow the frame.
   */
  limit?: number;
}

/** One stored chat message (`messages` table). Content is data, never a command. */
export interface MessageRecord {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  sequence: number;
}

/**
 * `conversation.history` result — an OBJECT, not an array. Both bounds are
 * disclosed: `truncated` is true when the row limit OR the byte ceiling cut the
 * scan short, and `nextSequence` is the last sequence actually returned (or the
 * request cursor when nothing was returned) — ready-made input for the next page.
 */
export interface ConversationHistoryResult {
  messages: MessageRecord[];
  truncated: boolean;
  nextSequence: number;
}

/** Durable, replayable task event (`task_events`). */
export interface TaskEvent {
  taskId: string;
  sequence: number;
  kind: string;
  payload: unknown;
  timestamp: string;
}

export type TaskStatus =
  | "created"
  | "queued"
  | "preparing"
  | "running"
  | "verifying"
  | "awaiting_input"
  | "awaiting_review"
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled"
  | "interrupted";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "created",
  "queued",
  "preparing",
  "running",
  "verifying",
  "awaiting_input",
  "awaiting_review",
  "completed",
  "rejected",
  "failed",
  "cancelled",
  "interrupted",
];

export interface TaskSummary {
  id: string;
  conversationId: string;
  /**
   * Core's stored status. `"unknown"` is a CLIENT-SIDE decode result, never a
   * wire value: Core sent a status this desktop build does not recognise (a
   * newer Core added one). It is never mapped onto a known state — not terminal,
   * not running, not reviewable — and the raw string is kept in
   * `unrecognizedStatus` so the UI can show exactly what Core said.
   */
  status: TaskStatus | "unknown";
  /** CLIENT-SIDE ONLY: Core's raw status string when `status` is `"unknown"`. */
  unrecognizedStatus?: string;
  sandboxName?: string | null;
  taskBranch?: string | null;
  baseCommit?: string | null;
  /**
   * A2: present (`true`) ONLY when this is a REPLAY of an earlier keyed
   * `conversation.send` — the task as FIRST created. Its status is NOT current
   * (it may since have been reconciled to `interrupted`); re-read `task.list`.
   */
  replayed?: true;
  /** CLIENT-SIDE ONLY: Core sent a non-boolean `replayed` — maybe a replay. */
  replayedUncertain?: true;
}

/** `git.review` result: the ACTUAL change set vs the task base revision. */
export interface ChangeSet {
  taskId: string;
  baseCommit: string;
  hostDirty: boolean;
  changes: FileChange[];
}

export type FileChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

/** `sandpane_protocol::FileChangeStatus`, in declared order (drift-tested). */
export const FILE_CHANGE_STATUSES: readonly FileChangeStatus[] = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "untracked",
];

export interface FileChange {
  path: string;
  /**
   * `"unknown"` is a CLIENT-SIDE decode result, never a wire value: Core sent a
   * file status this build does not recognise. Such a file is listed (with
   * `unrecognizedStatus`) but is never selectable for apply, and its presence
   * blocks a whole-set apply that would carry it along implicitly.
   */
  status: FileChangeStatus | "unknown";
  /** CLIENT-SIDE ONLY: Core's raw status string when `status` is `"unknown"`. */
  unrecognizedStatus?: string;
}

export interface GitApplyParams {
  taskId: string;
  selectedFiles?: string[] | null;
  /** Client's recorded base; a mismatch aborts the apply in Core. */
  expectedBase: string;
}

export interface ApplyResult {
  applied: boolean;
  abortReason?: string | null;
  conflictedFiles: string[];
}

/** Normalized agent event union (`specs/02 §4`), discriminated by `type`. */
export type AgentEvent =
  | { type: "message.delta"; text: string }
  | { type: "tool.started"; name: string; id: string }
  | { type: "tool.finished"; id: string; ok: boolean; summary?: string }
  | { type: "file.changed"; path: string }
  | { type: "approval.required"; requestId: string; description: string }
  | { type: "task.completed"; ok: boolean }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "unsupported.event"; providerType: string };

export const AGENT_EVENT_TYPES = [
  "message.delta",
  "tool.started",
  "tool.finished",
  "file.changed",
  "approval.required",
  "task.completed",
  "error",
  "unsupported.event",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    typeof type === "string" &&
    (AGENT_EVENT_TYPES as readonly string[]).includes(type)
  );
}

/**
 * Task-event kinds emitted directly by Core (not normalized agent events).
 * Anything else is surfaced as unrecognised rather than guessed.
 */
export const CORE_EVENT_KINDS = [
  "task.created",
  "status.changed",
  "message.user",
  "adapter.unavailable",
  "scheduler.deferred",
] as const;
