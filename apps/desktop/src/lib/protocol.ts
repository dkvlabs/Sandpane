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
 * The six A3a project-lifecycle methods (design §3.2) are additive too, and so
 * are the five A3b conversation-lifecycle methods (design §3.3), which sit right
 * after `conversation.history` — not at the end. A5's `git.diff` (design §3.5)
 * sits between `git.review` and `git.apply` (28 in all).
 */
export const METHODS = [
  "system.probe",
  "project.create",
  "project.list",
  "project.update",
  "project.archive",
  "project.unarchive",
  "project.delete",
  "project.add_repository",
  "project.remove_repository",
  "sandbox.list",
  "sandbox.create",
  "sandbox.stop",
  "sandbox.remove",
  "conversation.create",
  "conversation.send",
  "conversation.list",
  "conversation.history",
  "conversation.rename",
  "conversation.archive",
  "conversation.unarchive",
  "conversation.delete",
  "conversation.export",
  "task.cancel",
  "task.list",
  "task.subscribe",
  "git.review",
  "git.diff",
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
 * `conversation.create` persists `sandboxId` and every `Conversation` carries
 * it when one was stored (A3b, §3.3 item 2). Without it a client cannot tell
 * "no sandbox was chosen" from "an older Core discarded the choice".
 */
export const FEATURE_CONVERSATION_SANDBOX_ID = "conversation-sandbox-id" as const;
/**
 * `conversation.send` honours `mode` (`"task"` | `"discuss"`) and new tasks
 * carry `TaskSummary.mode` (A4, §3.4 item 1). A pre-A4 Core silently drops
 * `mode` and would treat a discussion as a task, so `mode` is sent ONLY when
 * this is advertised.
 */
export const FEATURE_CONVERSATION_SEND_MODE = "conversation-send-mode" as const;
/**
 * A6 (design 2026-10-09 §3.6): `git.apply` applies reviewed `host_worktree`
 * entries (`reviewId` + `entries`), `git.review` / `git.diff` carry
 * `reviewId`, `hostHooksPath`, `taskBlob` and `taskMode`. Apply is enabled ONLY
 * when this is advertised; otherwise the review stays read-only here.
 */
export const FEATURE_GIT_APPLY = "git-apply" as const;

/**
 * Every feature this desktop build knows, in Rust `FEATURES` order
 * (drift-tested against `sandpane_protocol::FEATURES` and the schema's
 * `features.items.examples`). Unknown advertised strings are ignored.
 */
export const KNOWN_FEATURES = [
  FEATURE_IDEMPOTENCY_KEYS,
  FEATURE_SANDBOX_CREATE_AGENT,
  FEATURE_CONVERSATION_SANDBOX_ID,
  FEATURE_CONVERSATION_SEND_MODE,
  FEATURE_GIT_APPLY,
] as const;
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
  /**
   * A3a (additive): RFC 3339 instant the project was archived. ABSENT when it
   * is live, and from a Core older than A3a. Core refuses
   * `conversation.create` / `conversation.send` / `sandbox.create` /
   * `project.update` and the repository methods on an archived project.
   */
  archivedAt?: string;
}

/** The six A3a project-lifecycle methods, in `Method::ALL` order. */
export const PROJECT_LIFECYCLE_METHODS = [
  "project.update",
  "project.archive",
  "project.unarchive",
  "project.delete",
  "project.add_repository",
  "project.remove_repository",
] as const;

export type ProjectLifecycleMethod = (typeof PROJECT_LIFECYCLE_METHODS)[number];

/** `project.update` params (A3a): at least one of `name` / `description`. */
export interface ProjectUpdateParams {
  projectId: string;
  name?: string;
  /** `""` clears the description. */
  description?: string;
}

/**
 * `project.delete` result as this client decodes it: exactly one of
 * `confirmation` (step 1, nothing changed) or `deleted: true` (step 2).
 */
export type ProjectDeleteResult =
  | { kind: "confirmation"; confirmation: ConfirmationRequest }
  | { kind: "deleted" };

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
  /**
   * A3b (additive): RFC 3339 instant the conversation was archived. ABSENT
   * when it is live, and from a Core older than A3b. Core refuses
   * `conversation.send` and `conversation.rename` on an archived conversation;
   * history, export and task reads keep working.
   */
  archivedAt?: string;
  /**
   * A3b (additive): the sandbox NAME chosen when the conversation was created
   * — a stored name, NOT a binding or an identity (Core does not check it
   * still exists; a same-named replacement looks identical). Rely on it only
   * when `system.probe` advertises `conversation-sandbox-id`.
   */
  sandboxId?: string;
}

/** The five A3b conversation-lifecycle methods, in `Method::ALL` order. */
export const CONVERSATION_LIFECYCLE_METHODS = [
  "conversation.rename",
  "conversation.archive",
  "conversation.unarchive",
  "conversation.delete",
  "conversation.export",
] as const;

export type ConversationLifecycleMethod = (typeof CONVERSATION_LIFECYCLE_METHODS)[number];

/** `conversation.rename` params (A3b). */
export interface ConversationRenameParams {
  conversationId: string;
  title: string;
}

/**
 * `conversation.delete` result as this client decodes it: exactly one of
 * `confirmation` (step 1, nothing changed) or `deleted: true` (step 2).
 */
export type ConversationDeleteResult =
  | { kind: "confirmation"; confirmation: ConfirmationRequest }
  | { kind: "deleted" };

/** `conversation.export` params (A3b): `conversation.history`'s paging. */
export interface ConversationExportParams {
  conversationId: string;
  afterSequence?: number;
  limit?: number;
}

/** The `format` tag of every `conversation.export` page (drift-tested). */
export const CONVERSATION_EXPORT_FORMAT = "sandpane.conversation-export.v1" as const;

/**
 * Redaction kind names Core reports in `byKind`, in Core's tie-break priority
 * order (`sandpane_core::redact::KINDS`, drift-tested). Display only: a kind
 * Core adds later is kept and shown, never refused.
 */
export const REDACTION_KINDS = [
  "private-key",
  "auth-header",
  "url-credentials",
  "url-secret-param",
  "jwt",
  "token",
  "env-secret",
] as const;

/**
 * What best-effort redaction replaced. `byKind` OMITS kinds with zero
 * replacements (absent = 0). The title's replacements count only on the first
 * page, so pages are summed directly.
 */
export interface ExportRedaction {
  bestEffort: true;
  replacements: number;
  byKind: Record<string, number>;
}

/**
 * One `conversation.export` page (A3b). Always redacted (best-effort); scope is
 * the conversation metadata and its messages only — task events, artifacts and
 * verification output are NOT included. `truncated` / `nextSequence` follow
 * `conversation.history`'s rules.
 */
export interface ConversationExportPage {
  format: typeof CONVERSATION_EXPORT_FORMAT;
  exportedAt: string;
  conversation: Conversation;
  messages: MessageRecord[];
  truncated: boolean;
  nextSequence: number;
  redaction: ExportRedaction;
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
  /**
   * A4: absent means `"task"`. This build sends only `"discuss"`, and only
   * when `conversation-send-mode` is advertised (see `send-mode.ts`).
   */
  mode?: SendMode;
}

/** The send modes Core accepts (A4, case-sensitive; drift-tested). */
export const SEND_MODES = ["task", "discuss"] as const;
export type SendMode = (typeof SEND_MODES)[number];

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
  /**
   * A3b (additive): also list archived conversations. Sent ONLY as `true`, and
   * only to a Core that advertises `conversation.archive`; absent = live only.
   */
  includeArchived?: boolean;
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
   * A4: the mode the task was created with — an OPEN string (`"task"` /
   * `"discuss"` today; anything else is displayed as-is). Absent on tasks
   * created before A4.
   */
  mode?: string;
  /**
   * A4: the sandbox NAME the task's chat chose at creation, copied at send
   * time. NOT a binding and NOT where the task runs: it never feeds the
   * isolation label, the stop/remove counts or any scope logic — that is
   * `sandboxName`'s job, which A4 does not change.
   */
  chosenSandboxName?: string;
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
  /** A5: the host repository root `hostDirty` describes (display only). */
  repoPath?: string;
  /**
   * A5: paths Core could not inspect. Never produced by an A5 Core; if one is
   * ever non-empty the change set is NOT complete and is never called so.
   */
  uninspected?: string[];
  /**
   * A6: an opaque id for THIS answer (host_worktree tasks only). Core keeps
   * the last few per task in memory; a Core restart means review again.
   * `git.apply` sends it with entries copied verbatim from this answer.
   */
  reviewId?: string;
  /**
   * A6: the host's effective `core.hooksPath`, ONLY when it is repo-relative.
   * Applied paths under it are flagged "runs automatically".
   */
  hostHooksPath?: string;
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
  /** A5: the pre-rename path, only for `renamed`. Exact, like `path`. */
  oldPath?: string;
  /**
   * A6: the blob id of the task-side bytes Core hashed at review (40 or 64
   * hex). Absent for `deleted`, for files over 32 MiB, and for anything Core
   * could not read as a file. An open string: never validated here.
   */
  taskBlob?: string;
  /** A6: `"100644"`, `"100755"` or `"120000"`, as an OPEN string. */
  taskMode?: string;
}

/**
 * `git.diff` params (A5). `path` is an entry's `path` from `git.review`,
 * byte for byte; `status` is that entry's status (always sent: a path can be
 * listed twice). `maxBytes` is clamped to 1..=524288 (default 262144).
 */
export interface GitDiffParams {
  taskId: string;
  path: string;
  status: FileChangeStatus;
  maxBytes?: number;
}

/**
 * `git.diff` result (A5). `patch` is UNTRUSTED display text: never rendered as
 * HTML or Markdown, never executed, never applied. File names come from
 * `path` / `oldPath` only, never from the patch header.
 */
export interface GitDiffResult {
  path: string;
  oldPath?: string;
  status: FileChangeStatus | "unknown";
  /** CLIENT-SIDE ONLY: Core's raw status when this build does not know it. */
  unrecognizedStatus?: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
  lossy: boolean;
  baseBlob?: string;
  /**
   * A6 (host_worktree): the blob id of the task-side bytes THIS patch was
   * rendered from. When it differs from the reviewed entry's `taskBlob`, the
   * client MUST NOT send an apply for that review.
   */
  taskBlob?: string;
  /** A6: the task-side mode of that same read (open string). */
  taskMode?: string;
}

/**
 * One `git.apply` entry: the five wire fields of a `FileChange`, copied
 * VERBATIM from the `git.review` answer that produced `reviewId`. Never the
 * client-only `unrecognizedStatus`, never the client-only `"unknown"` status.
 */
export interface ApplyEntry {
  path: string;
  status: FileChangeStatus;
  oldPath?: string;
  taskBlob?: string;
  taskMode?: string;
}

/**
 * `git.apply` params (A6). `selectedFiles` is deliberately NOT part of this
 * type: an A6 Core refuses it, alone or together with `entries`.
 */
export interface GitApplyParams {
  taskId: string;
  /** The task's full recorded base oid; a mismatch aborts the apply in Core. */
  expectedBase: string;
  /** The `reviewId` of the `git.review` answer the entries were copied from. */
  reviewId: string;
  /** 1..=1000 entries, verbatim from that answer. */
  entries: ApplyEntry[];
}

/** A6: an executable-bit change made by an apply (modes are open strings). */
export interface ModeChange {
  path: string;
  from: string;
  to: string;
}

export interface ApplyResult {
  applied: boolean;
  abortReason?: string | null;
  conflictedFiles: string[];
  /** A6: the entry paths written into the working tree and staged. */
  appliedFiles?: string[];
  /** A6: executable-bit changes among the applied entries. */
  modeChanges?: ModeChange[];
  /** A6: the tree Core built from the reviewed objects. */
  snapshotTree?: string;
  /**
   * A6: `true` when files MAY have been written although `applied` is false
   * (W1/W2). CLIENT-SIDE: a `partial` that is present but not a boolean also
   * decodes to `true` — a possible partial is never shown as "nothing written".
   */
  partial?: boolean;
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
  // A6 (design §3.6 item 8): durable apply records. Their payloads are OPEN
  // (every field optional); they never change the task's status.
  "git.apply.started",
  "git.applied",
  "git.apply.failed",
  "git.apply.reconciled",
] as const;
