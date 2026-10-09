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

/** The complete, allowlisted RPC surface (`sandpane_protocol::Method`). */
export const CORE_METHODS = [
  'system.probe',
  'project.create',
  'project.list',
  'sandbox.list',
  'sandbox.create',
  'conversation.create',
  'conversation.send',
  'task.cancel',
  'task.subscribe',
  'git.review',
  'git.apply',
] as const;

export type CoreMethodName = (typeof CORE_METHODS)[number];

export function isCoreMethodName(value: unknown): value is CoreMethodName {
  return typeof value === 'string' && (CORE_METHODS as readonly string[]).includes(value);
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

export interface TaskSubscribeParams {
  projectId?: string | null;
  taskId?: string | null;
  /** Replay strictly after this per-task sequence. */
  afterSequence: number;
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
