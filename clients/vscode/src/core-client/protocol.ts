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
 *
 * A1 (design 2026-10-09 §3) added `sandbox.stop` and `sandbox.remove`. There is
 * deliberately NO `sandbox.start`: sbx v0.47 has no start command, so the UI
 * shows it as visibly unsupported instead of inventing one.
 */
export const CORE_METHODS = [
  'system.probe',
  'project.create',
  'project.list',
  'sandbox.list',
  'sandbox.create',
  'sandbox.stop',
  'sandbox.remove',
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
  /**
   * A2, additive: protocol features THIS Core implements (`sandpane_protocol::
   * FEATURES`) — behaviour a client cannot infer from `methods`, because a
   * pre-A2 Core silently drops an unknown request field. Absent on an older
   * Core = nothing advertised. Unknown strings are ignored, never an error.
   */
  features?: string[];
}

/**
 * The features this client understands (Rust `FEATURES`, schema
 * `core-capabilities.features.items.examples`; drift-tested).
 *  - `idempotency-keys`: `sandbox.create` / `conversation.send` honour
 *    `idempotencyKey` (a replay returns the first result, never runs twice);
 *  - `sandbox-create-agent`: `sandbox.create` honours `agent`.
 */
export const KNOWN_FEATURES = ['idempotency-keys', 'sandbox-create-agent'] as const;

export type CoreFeature = (typeof KNOWN_FEATURES)[number];

/**
 * Does THIS Core advertise `feature`? Absent / malformed `features` means no;
 * strings this client does not know are simply never asked about.
 */
export function coreAdvertisesFeature(
  capabilities: Pick<CoreCapabilities, 'features'> | null | undefined,
  feature: CoreFeature,
): boolean {
  const advertised: unknown = capabilities?.features;
  return Array.isArray(advertised) && advertised.some((f) => f === feature);
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
  /**
   * A1, additive: built-in sbx agent the sandbox is created with. Absent → Core
   * uses the provider-free `shell`. Must be one of `SBX_AGENTS` exactly; Core
   * refuses anything else (incl. sandbox-kit references) with VALIDATION_FAILED.
   * Accepting a provider agent is NOT a verification claim — that lives only in
   * `CoreCapabilities.agents[].verified`.
   */
  agent?: string;
  /**
   * A2, additive: 1..=128 chars of `[A-Za-z0-9._-]`. Sent ONLY when Core
   * advertises the `idempotency-keys` feature (an older Core would drop it and
   * the key would promise a safety that does not exist).
   */
  idempotencyKey?: string;
}

/**
 * The exact built-in agents of the captured sbx v0.47.0 `create --help`
 * (`SBX_AGENTS_V0_47` in sandpane-core, `schemas/sandbox-create-spec.schema.json`
 * `agent.enum`). Order matches the schema.
 */
export const SBX_AGENTS = [
  'claude',
  'codex',
  'copilot',
  'cursor',
  'devin',
  'docker-agent',
  'droid',
  'gemini',
  'kiro',
  'opencode',
  'shell',
] as const;

export type SbxAgent = (typeof SBX_AGENTS)[number];

/** Core's `DEFAULT_SANDBOX_AGENT`: what an absent `agent` means. */
export const DEFAULT_SBX_AGENT: SbxAgent = 'shell';

export function isSbxAgent(value: unknown): value is SbxAgent {
  return typeof value === 'string' && (SBX_AGENTS as readonly string[]).includes(value);
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
  /**
   * A1, additive: the agent sbx itself reports in `ls --json`. A probed FACT,
   * never a verification claim. Absent when sbx did not report one.
   */
  agent?: string | null;
  /**
   * A2: `true` when this is the STORED first response to an earlier identical
   * keyed `sandbox.create` — not current state (the sandbox may since have been
   * stopped or removed). Clients re-read `sandbox.list`. Absent on first responses.
   */
  replayed?: boolean | null;
}

/** `sandbox.stop` params (A1). Not destructive: no confirmation token. */
export interface SandboxStopParams {
  name: string;
}

/**
 * `sandbox.stop` result. `stopped: true` only says `sbx stop` exited 0. The
 * state is whatever the post-stop re-query reports in `requeried`; when
 * `requeried` is ABSENT the sandbox is no longer listed or the re-query failed,
 * and the state must be shown as UNKNOWN — never assumed "stopped".
 */
export interface SandboxStopResult {
  stopped: boolean;
  requeried?: SandboxSummary | null;
}

/**
 * `sandbox.remove` params (A1, two-step server-side confirmation, design
 * 2026-10-09 §2). Without `confirmToken` Core changes nothing and answers a
 * `ConfirmationRequest`; with it, Core re-checks the target identity and acts.
 */
export interface SandboxRemoveParams {
  name: string;
  confirmToken?: string;
}

/** Identity a confirmation token is bound to: the name AND the sbx `id`. */
export interface ConfirmationTarget {
  name: string;
  id: string;
}

/**
 * Server-side destructive-action confirmation. `token` is 256-bit random
 * (64 lowercase hex), single-use, in Core memory only, valid until `expiresAt`
 * (RFC 3339, 120 s after issue). `external: true` = Core has no Sandpane
 * binding recorded for this sbx id (this also covers a pre-A1 binding without
 * an id, or a binding for an earlier sandbox of the same name). It does NOT
 * prove who created the sandbox; clients show "NOT CONFIRMED AS CREATED BY
 * SANDPANE" prominently.
 */
export interface ConfirmationRequest {
  token: string;
  expiresAt: string;
  action: string;
  target: ConfirmationTarget;
  impact: string[];
  external: boolean;
}

/** `sandbox.remove` result: `confirmation` for step 1, `removed: true` for step 2. */
export interface SandboxRemoveResult {
  confirmation?: ConfirmationRequest | null;
  removed?: boolean | null;
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
  /** A2: see `SandboxCreateSpec.idempotencyKey`; same rule, same gating. */
  idempotencyKey?: string;
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
  /**
   * A2: `true` when this is the STORED first response to an earlier identical
   * keyed `conversation.send`. Its `status` is NOT current (the task may since
   * have been reconciled, e.g. to `interrupted`); clients re-read `task.list`.
   */
  replayed?: boolean | null;
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
