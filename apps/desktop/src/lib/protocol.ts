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
 * The complete allowlisted method surface (`sandpane_protocol::Method`).
 * Deliberately there is no free-form execution method — a client must never
 * invent one, and an unknown name is rejected by Core with `VALIDATION_FAILED`.
 */
export const METHODS = [
  "system.probe",
  "project.create",
  "project.list",
  "sandbox.list",
  "sandbox.create",
  "conversation.create",
  "conversation.send",
  "task.cancel",
  "task.subscribe",
  "git.review",
  "git.apply",
] as const;

export type Method = (typeof METHODS)[number];

export function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value);
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
}

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
}

export interface SandboxSummary {
  name: string;
  /** Last probed state — never assumed, never inferred from a cached row. */
  probedState: string | null;
  boundProjectId: string | null;
}

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
}

export interface TaskSubscribeParams {
  projectId?: string;
  taskId?: string;
  /** Replay everything strictly after this per-task sequence number. */
  afterSequence: number;
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
  status: TaskStatus;
  sandboxName?: string | null;
  taskBranch?: string | null;
  baseCommit?: string | null;
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

export interface FileChange {
  path: string;
  status: FileChangeStatus;
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
