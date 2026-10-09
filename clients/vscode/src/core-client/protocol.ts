/**
 * Frame + payload types mirrored from `sandpane-protocol`
 * (core/crates/sandpane-protocol/src/lib.rs — source of truth) and the
 * `schemas/*.schema.json` files. Payload fields are camelCase because the Rust
 * structs carry `#[serde(rename_all = "camelCase")]`; enums that are statuses or
 * modes are snake_case; error codes are SCREAMING_SNAKE (see events.ts).
 *
 * Hand-synced at scaffold stage; generated bindings + a CI drift check are P1/P7
 * deliverables (schemas/README.md "Sync status").
 */

import type { ErrorCode, TaskStatus } from './events';

/** `sandpane_protocol::PROTOCOL_VERSION` — negotiated in `system.probe`. */
export const PROTOCOL_VERSION = 1;

/**
 * `sandpane_service::MAX_FRAME_BYTES` — the client refuses to send or buffer
 * more than this (AGENTS.md rule 9: bounded IPC frames).
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * `sandpane_service::DEFAULT_LIST_LIMIT` — rows Core returns when a bounded read
 * asks for no limit. The client does not substitute it into the payload: it
 * leaves `limit` absent so Core's own default is the one that applies.
 */
export const DEFAULT_LIST_LIMIT = 200;

/**
 * `sandpane_service::MAX_LIST_LIMIT` — hard ceiling on rows from any single
 * bounded read. A larger request is clamped by Core, never honoured, so the
 * client clamps identically before sending (a local clamp is a display
 * preference; Core's clamp is the authority).
 */
export const MAX_LIST_LIMIT = 500;

/**
 * `sandpane_service::MAX_HISTORY_BYTES` — the content ceiling behind
 * `conversation.history`'s `truncated` flag. Only used to explain a truncation
 * to the user; Core measures the actual serialized bytes.
 */
export const MAX_HISTORY_BYTES = 2 * 1024 * 1024;

/** `sandpane_service::MAX_SUBSCRIBE_CURSORS` — entries in an `afterSequences` map. */
export const MAX_SUBSCRIBE_CURSORS = 4096;

/** `sandpane_service::MAX_CURSOR_KEY_LEN` — byte length of an `afterSequences` key. */
export const MAX_CURSOR_KEY_LEN = 100;

/**
 * `sandpane_service::MAX_SCOPING_ID_LEN` — length bound on an id that merely
 * scopes a read (`projectId`, `conversationId`). Core validates it through
 * `Validator::display_text`; the client mirrors that before sending.
 */
export const MAX_SCOPING_ID_LEN = 200;

/**
 * The complete, allowlisted RPC surface (`sandpane_protocol::Method`), in the
 * order of Rust's `Method::ALL` — the single list that backs
 * `CoreCapabilities.methods`. Unknown methods are impossible to call; there is
 * deliberately no free-form execution method (specs/02 §2).
 */
export const CORE_METHODS = [
  'system.probe',
  'project.create',
  'project.list',
  'sandbox.list',
  'sandbox.create',
  'conversation.create',
  'conversation.send',
  'conversation.list',
  'conversation.history',
  'task.cancel',
  'task.list',
  'task.subscribe',
  'git.review',
  'git.apply',
] as const;

export type CoreMethodName = (typeof CORE_METHODS)[number];

export function isCoreMethodName(value: unknown): value is CoreMethodName {
  return typeof value === 'string' && (CORE_METHODS as readonly string[]).includes(value);
}

/**
 * Feature discovery: does THIS Core instance advertise `method`?
 *
 * `CoreCapabilities.methods` is derived from Rust's `Method::ALL`, so it is what
 * the running service actually dispatches — a version number is not. An absent
 * or empty list means the Core predates method advertisement, so nothing beyond
 * the original surface may be assumed. Clients call this instead of guessing a
 * capability from `protocolVersion`.
 */
export function coreAdvertisesMethod(
  capabilities: Pick<CoreCapabilities, 'methods'> | null | undefined,
  method: CoreMethodName,
): boolean {
  const advertised = capabilities?.methods;
  return Array.isArray(advertised) && advertised.includes(method);
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** `{v, id, method, params}` — client → Core. */
export interface RpcRequestFrame {
  v: number;
  id: string;
  method: string;
  params: unknown;
}

export interface RpcErrorEnvelope {
  code: ErrorCode;
  message: string;
  /** Structured details; Core guarantees no secrets and no full prompt content. */
  details?: unknown;
}

/** `{v, id, ok}` — flattened `RpcOutcome::Ok`. */
export interface RpcOkFrame {
  v: number;
  id: string;
  ok: unknown;
  err?: undefined;
}

/** `{v, id, err}` — flattened `RpcOutcome::Err`. */
export interface RpcErrFrame {
  v: number;
  id: string;
  err: RpcErrorEnvelope;
  ok?: undefined;
}

export type RpcResponseFrame = RpcOkFrame | RpcErrFrame;

export type RpcFrame = RpcRequestFrame | RpcOkFrame | RpcErrFrame;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** `system.probe` result (`CoreCapabilities`). */
export interface SbxStatus {
  installed: boolean;
  binaryPath?: string | null;
  version?: string | null;
  daemonRunning?: boolean | null;
}

export interface AgentCapability {
  id: string;
  /** True ONLY after the adapter passed its in-SBX feasibility gate (P0). */
  verified: boolean;
  supportsStreaming: boolean;
  supportsCancel: boolean;
  supportsResume: boolean;
}

export interface CoreCapabilities {
  protocolVersion: number;
  coreVersion: string;
  /** Changes across restarts — clients use it to detect a new Core instance. */
  instanceId: string;
  sbx?: SbxStatus | null;
  agents: AgentCapability[];
  platform: string;
  /**
   * Wire names of every method THIS Core dispatches (`Method::ALL`), for feature
   * discovery — use `coreAdvertisesMethod` rather than assuming from a version.
   * Optional because a pre-discovery Core omits it (`#[serde(default)]`); an
   * empty/absent list means "not advertised", never "all".
   */
  methods?: string[];
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  /**
   * Host paths registered with this project (the `repositories` table's
   * `canonical_path`, insertion-ordered). Optional: a pre-revision Core omits it.
   * Honest caveat from the Rust doc: Core requires an ABSOLUTE path at
   * `project.create` but canonicalizes (resolves symlinks) only at
   * `sandbox.create` mount time, so a client matching a folder against these
   * must canonicalize BOTH sides — never plain string-compare.
   */
  repositories?: string[];
}

export interface ProjectCreateParams {
  name: string;
  repositories: string[];
}

/** specs/02 §7 workspace mapping modes. `direct_mount` is live-writable. */
export const WORKSPACE_MODES = ['direct_mount', 'sbx_clone', 'host_worktree', 'mountless'] as const;

export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return typeof value === 'string' && (WORKSPACE_MODES as readonly string[]).includes(value);
}

/** `sandbox.create` params (`SandboxCreateSpec`). */
export interface SandboxCreateSpec {
  name: string;
  projectId: string;
  workspaceMode: WorkspaceMode;
  repoPath?: string | null;
}

export interface SandboxSummary {
  name: string;
  /** Last probed SBX state; SBX is the source of truth, never assumed. */
  probedState?: string | null;
  boundProjectId?: string | null;
  /**
   * The workspace mode recorded in Core's newest `sandbox_bindings` row for this
   * name — a RECORD of what Core was asked to bind, not a live SBX verification.
   * `direct_mount` means the mount is LIVE-WRITABLE and must be labeled that way
   * (specs/02 §7, specs/04 §3).
   *
   * ABSENT (`undefined`/`null`) means Core has no readable binding row — the
   * mode is never guessed. A UI that shows `probedState` with no mode must
   * render the mode as UNVERIFIED, never as safe.
   */
  workspaceMode?: WorkspaceMode | null;
}

export interface ConversationCreateParams {
  projectId: string;
  agentId: string;
  sandboxId?: string | null;
  title?: string;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  agentId: string;
  createdAt: string;
}

export const CONTEXT_REF_KINDS = ['file', 'selection', 'diagnostics', 'diff_range'] as const;

export type ContextRefKind = (typeof CONTEXT_REF_KINDS)[number];

/**
 * `ContextRef` — a *reference*, not a body: protocol v1 carries `kind` +
 * `target` only, so attachment content is resolved by Core from the target.
 */
export interface ContextRef {
  kind: ContextRefKind;
  target: string;
}

/** `conversation.send` params. Content is data and is never executed (specs/02 §2). */
export interface ConversationSendParams {
  conversationId: string;
  content: string;
  attachments: ContextRef[];
}

/**
 * `task.subscribe` params. Cursor semantics resolved by protocol v1 — mirror
 * `TaskSubscribeParams` in Rust exactly:
 *
 * * `taskId` present → that ONE task replays from the scalar `afterSequence`;
 *   `afterSequences` is IGNORED on this path (the wrapper omits it from the wire
 *   so the client never sends something Core will discard).
 * * `taskId` absent → with `afterSequences` each task replays from its OWN
 *   cursor (`afterSequences[taskId]`, missing ⇒ 0 = full history); without it
 *   every task falls back to the shared scalar, exactly as before.
 *
 * Consequence to plan for: a map naming only SOME tasks means the unnamed ones
 * replay IN FULL, so a client catching up a large project must name every task
 * it has already seen. Core refuses a replay that cannot fit one IPC frame with
 * `VALIDATION_FAILED` rather than emitting an undeliverable frame.
 */
export interface TaskSubscribeParams {
  projectId?: string | null;
  taskId?: string | null;
  /** Replay strictly after this per-task sequence. */
  afterSequence: number;
  /**
   * task id → last sequence durably seen for THAT task. Sequences are not
   * comparable across tasks, which is why a shared scalar can skip events
   * (the recorded v1 gap, docs/compatibility.md).
   */
  afterSequences?: Record<string, number> | null;
}

/** `task.list` params — read-only discovery of Core task state. */
export interface TaskListParams {
  /** Scope to one project (tasks reached through its conversations). Absent = all. */
  projectId?: string | null;
  /**
   * Only tasks currently in one of these statuses. These are Core's OWN stored
   * values; an unknown status string is refused, never normalized.
   */
  statuses?: readonly TaskStatus[];
  /** Rows to return; Core clamps to 1..=500 and defaults to 200. */
  limit?: number | null;
}

/** `conversation.list` params — read-only chat enumeration. */
export interface ConversationListParams {
  /** Scope to one project. Absent = every conversation Core knows about. */
  projectId?: string | null;
  /** Rows to return; Core clamps to 1..=500 and defaults to 200. */
  limit?: number | null;
}

/** `conversation.history` params — bounded transcript read. */
export interface ConversationHistoryParams {
  conversationId: string;
  /** Return messages strictly after this per-conversation sequence. */
  afterSequence?: number | null;
  /**
   * Rows to return; Core clamps to 1..=500 and defaults to 200, and additionally
   * stops on a total-bytes ceiling so one huge row cannot overflow the frame.
   */
  limit?: number | null;
}

/** One stored chat message (the `messages` table). Content is data, never a command. */
export interface MessageRecord {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  sequence: number;
}

/**
 * `conversation.history` result. BOTH bounds are disclosed: when the row limit
 * or the byte ceiling cut the scan short, `truncated` is true and `nextSequence`
 * is the last sequence actually returned — ready-made input for the next call.
 */
export interface ConversationHistoryResult {
  messages: MessageRecord[];
  truncated: boolean;
  /** Highest sequence returned, or the request cursor when nothing was returned. */
  nextSequence: number;
}

export interface TaskSummary {
  id: string;
  conversationId: string;
  status: TaskStatus;
  sandboxName?: string | null;
  taskBranch?: string | null;
  baseCommit?: string | null;
}

/** `git.review` result (`ChangeSet`) — the actual change set vs the task base. */
export const FILE_CHANGE_STATUSES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'untracked',
] as const;

export type FileChangeStatus = (typeof FILE_CHANGE_STATUSES)[number];

export interface FileChange {
  path: string;
  status: FileChangeStatus;
}

export interface ChangeSet {
  taskId: string;
  baseCommit: string;
  hostDirty: boolean;
  changes: FileChange[];
}

/** `git.apply` params — explicit Git operation with a base check (specs/06 §6). */
export interface GitApplyParams {
  taskId: string;
  selectedFiles?: string[] | null;
  expectedBase: string;
}

export interface ApplyResult {
  applied: boolean;
  abortReason?: string | null;
  conflictedFiles: string[];
}
