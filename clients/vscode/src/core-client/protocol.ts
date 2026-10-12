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
 *
 * A3a (design §3.2) added the six project lifecycle methods; their segments
 * stay lowercase snake_case (`project.add_repository`).
 *
 * A3b (design §3.3) added the five conversation lifecycle methods; they sit
 * right after `conversation.history` in `Method::ALL` (27 in total then; A5's
 * `git.diff` makes 28).
 *
 * A7 (design §3.7) added the six verification methods right after
 * `git.apply` (34 in total). None takes a command string: `verification.run`
 * names an APPROVED command by id, never argv.
 */
export const CORE_METHODS = [
  'system.probe',
  'project.create',
  'project.list',
  'project.update',
  'project.archive',
  'project.unarchive',
  'project.delete',
  'project.add_repository',
  'project.remove_repository',
  'sandbox.list',
  'sandbox.create',
  'sandbox.stop',
  'sandbox.remove',
  'conversation.create',
  'conversation.send',
  'conversation.list',
  'conversation.history',
  'conversation.rename',
  'conversation.archive',
  'conversation.unarchive',
  'conversation.delete',
  'conversation.export',
  'task.cancel',
  'task.list',
  'task.subscribe',
  'git.review',
  // A5 (§3.5): read-only, display-only patch for ONE `git.review` entry.
  'git.diff',
  'git.apply',
  // A7 (§3.7): read-only list / result / context; approve, revoke and run are
  // writes, each reached only from a confirmed user gesture.
  'verification.list',
  'verification.approve',
  'verification.revoke',
  'verification.run',
  'verification.result',
  'project.context',
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
  /** `null` = unknown (Core could not read a captured `Status:` line). */
  daemonRunning?: boolean | null;
  /**
   * A8a (additive): whether `verification.run` may spawn `sbx exec` for the
   * probed version — the same predicate as Core's version gate. Absent when the
   * version is unknown or sbx is not installed ("this Core does not say").
   */
  execVerified?: boolean;
  /**
   * A8a (additive): whether the probed version NUMBER equals one whose fixtures
   * Sandpane captured (macOS arm64; build not compared). Evidence, never a
   * support claim. Absent when the version is unknown or sbx is not installed.
   */
  versionCaptured?: boolean;
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
 *  - `sandbox-create-agent`: `sandbox.create` honours `agent`;
 *  - `conversation-sandbox-id` (A3b): `conversation.create` persists
 *    `sandboxId` and every `Conversation` carries it when one was stored. Only
 *    then may `Conversation.sandboxId` be read as "the sandbox NAME chosen at
 *    creation" — never as a live binding.
 */
export const KNOWN_FEATURES = [
  'idempotency-keys',
  'sandbox-create-agent',
  'conversation-sandbox-id',
  // A4 (§3.4): `conversation.send` honours `mode`. Send it ONLY when this is
  // advertised: a pre-A4 Core drops the field and records a discussion as a task.
  'conversation-send-mode',
  // A6 (§3.6): `git.apply` applies reviewed host_worktree entries (reviewId +
  // entries). Without it Apply stays in its "not implemented" state.
  'git-apply',
  // A7 (§3.7): the verification surface (list / approve / revoke / run /
  // result and project.context). The UI is enabled ONLY when advertised.
  // Running is additionally gated by Core on a PROVEN sbx version.
  'verification',
] as const;

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
  /**
   * A3a, additive: RFC 3339 time the project was archived; ABSENT when live.
   * Archived = Core refuses conversation.create/send, sandbox.create,
   * project.update and the repository methods until it is unarchived.
   */
  archivedAt?: string | null;
}

/** `project.list` params (A3a). Absent / `{}` = live projects only. */
export interface ProjectListParams {
  includeArchived?: boolean;
}

/** `project.update` (A3a): at least one of `name` / `description`. */
export interface ProjectUpdateParams {
  projectId: string;
  name?: string;
  /** Empty string clears the description. */
  description?: string;
}

/** `project.delete` result: `confirmation` for step 1, `deleted: true` for step 2. */
export interface ProjectDeleteResult {
  confirmation?: ConfirmationRequest | null;
  deleted?: boolean | null;
}

/** `project.add_repository` / `project.remove_repository` (A3a). */
export interface ProjectRepositoryParams {
  projectId: string;
  path: string;
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
  /**
   * A3b, additive: RFC 3339 time the conversation was archived; ABSENT when
   * live (and from an older Core). Archived = Core refuses `conversation.send`
   * and `conversation.rename`; history, export and task reads keep working.
   */
  archivedAt?: string | null;
  /**
   * A3b, additive: the sandbox NAME chosen when the conversation was created —
   * a stored name, NOT a binding: Core does not check it still exists and a
   * same-named replacement is indistinguishable. Absent when none was stored
   * (also for rows created before A3b and from an older Core). Read it only
   * when Core advertises the `conversation-sandbox-id` feature.
   */
  sandboxId?: string | null;
}

/** `conversation.rename` params (A3b). Title: `Validator::conversation_title`, not blank. */
export interface ConversationRenameParams {
  conversationId: string;
  title: string;
}

/** `conversation.delete` result: `confirmation` for step 1, `deleted: true` for step 2. */
export interface ConversationDeleteResult {
  confirmation?: ConfirmationRequest | null;
  deleted?: boolean | null;
}

/** `conversation.export` params (A3b) — `conversation.history`'s paging. */
export interface ConversationExportParams {
  conversationId: string;
  /** Messages strictly after this sequence; negative is normalised to 0. */
  afterSequence: number;
  /** Rows per page; Core clamps to 1..=500 and defaults to 200. */
  limit?: number | null;
}

/** `sandpane_protocol::CONVERSATION_EXPORT_FORMAT` — the `format` of every export page. */
export const CONVERSATION_EXPORT_FORMAT = 'sandpane.conversation-export.v1';

/**
 * What best-effort redaction replaced on ONE export page. `byKind` OMITS kinds
 * with zero replacements (absent = 0); `replacements` is the sum of `byKind`.
 * The title is redacted on every page but counted only on the first, so a
 * client sums pages directly. `bestEffort` is always true: redaction is
 * pattern-based and can miss secrets.
 */
export interface ExportRedaction {
  bestEffort: boolean;
  replacements: number;
  byKind: Record<string, number>;
}

/**
 * `conversation.export` result: ONE page of an always-redacted export. Scope:
 * conversation metadata and messages only — task events, artifacts and
 * verification output are NOT included. Page until `truncated` is false,
 * requiring `nextSequence` to strictly increase.
 */
export interface ConversationExportResult {
  format: string;
  exportedAt: string;
  conversation: Conversation;
  messages: MessageRecord[];
  truncated: boolean;
  nextSequence: number;
  redaction: ExportRedaction;
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
  /**
   * A4 (§3.4): the requested send mode; absent = "task". The wrapper sends the
   * key ONLY for "discuss" (Task frames stay byte-identical to A2/A3b), and
   * callers pass "discuss" only when Core advertises `conversation-send-mode`.
   */
  mode?: SendMode;
}

/**
 * A4: the two values `conversation.send` accepts (case-sensitive). Core
 * answers anything else with VALIDATION_FAILED `mode must be "task" or
 * "discuss"`. NOT the type of `TaskSummary.mode`, which is an open string.
 */
export const SEND_MODES = ['task', 'discuss'] as const;
export type SendMode = (typeof SEND_MODES)[number];

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
  /**
   * A3b: also list archived conversations. Sent only when true (and callers
   * send it only when Core advertises `conversation.archive`; an older Core
   * would silently ignore it).
   */
  includeArchived?: boolean;
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
   * A4: the send mode the task was created with — an OPEN string ("task" /
   * "discuss" today; an unknown value is displayed as-is, never a decode
   * failure). Absent on tasks created before A4.
   */
  mode?: string | null;
  /**
   * A4: the sandbox NAME the task's chat chose, stored at send time. NOT a
   * binding and NOT where the task runs; never feeds stop/remove counts,
   * isolation labels or scope logic (that is `sandboxName`'s job).
   */
  chosenSandboxName?: string | null;
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
  /** A5: EXACT (NUL-parsed) — real tab / newline characters, never C-quoted. */
  path: string;
  status: FileChangeStatus;
  /** A5: the pre-rename path; present only for `renamed`. */
  oldPath?: string | null;
  /**
   * A6 (host_worktree only): the git blob id of the task-side content Core
   * read itself (40 or 64 hex). Absent for `deleted` entries and for files
   * over the 32 MiB apply cap. An open string: decode tolerantly.
   */
  taskBlob?: string | null;
  /** A6 (host_worktree only): `"100644" | "100755" | "120000"` — an open string. */
  taskMode?: string | null;
}

export interface ChangeSet {
  taskId: string;
  baseCommit: string;
  hostDirty: boolean;
  changes: FileChange[];
  /** A5: the canonical host repository root of the task (displayable). */
  repoPath?: string | null;
  /**
   * A5: paths Core did NOT inspect. Never produced in A5; if ever non-empty,
   * the change set is incomplete and must never be presented as complete.
   */
  uninspected?: string[] | null;
  /**
   * A6 (host_worktree only): an opaque id for THIS answer. `git.apply` takes
   * entries copied verbatim from the review that produced it; Core keeps it in
   * memory only, so after a Core restart the user reviews again.
   */
  reviewId?: string | null;
  /** A6: the host's effective `core.hooksPath`, only when repo-relative. */
  hostHooksPath?: string | null;
}

/** A5: `git.diff` byte bounds (sandpane_core::diff). Core clamps to 1..=MAX. */
export const MAX_DIFF_BYTES = 524_288;
export const DEFAULT_DIFF_BYTES = 262_144;

/**
 * A5 `git.diff` params. `path` is passed byte-for-byte as `git.review`
 * returned it (never trimmed, normalized or validated here — Core gates it
 * against the change list); `status` is ALWAYS the entry's status, so a path
 * listed twice is unambiguous.
 */
export interface GitDiffParams {
  taskId: string;
  path: string;
  status: FileChangeStatus;
  /** Omitted ⇒ Core's default (262 144). Never above 524 288. */
  maxBytes?: number;
}

/**
 * A5 `git.diff` result: UNTRUSTED display-only text. Never rendered as HTML
 * or Markdown, never executed, never applied or written into the repository.
 */
export interface GitDiffResult {
  path: string;
  oldPath?: string | null;
  status: FileChangeStatus;
  patch: string;
  binary: boolean;
  truncated: boolean;
  lossy: boolean;
  baseBlob?: string | null;
  /**
   * A6 (host_worktree only): the blob id of the task-side bytes this patch was
   * rendered from (ONE read). A client MUST NOT send an apply whose entry
   * `taskBlob` differs.
   */
  taskBlob?: string | null;
  /** A6: the task-side mode of that same read. */
  taskMode?: string | null;
}

/**
 * A6 `git.apply` params (§3.6). `entries` are the FileChange objects of ONE
 * `git.review` answer, copied VERBATIM (never rebuilt or normalized), and
 * `reviewId` is that answer's id. The pre-A6 `selectedFiles` is gone: an A6
 * Core refuses it, and this client never sends it.
 */
export interface GitApplyParams {
  taskId: string;
  /** The task's full recorded base oid (a mismatch aborts, specs/06 §6). */
  expectedBase: string;
  reviewId: string;
  entries: readonly FileChange[];
}

/** A6: an executable-bit change made by an apply (open strings). */
export interface ModeChange {
  path: string;
  from: string;
  to: string;
}

export interface ApplyResult {
  applied: boolean;
  abortReason?: string | null;
  conflictedFiles: string[];
  /** A6: the entry paths written into the working tree and staged (never committed). */
  appliedFiles?: string[] | null;
  /** A6: executable-bit changes among the applied entries. */
  modeChanges?: ModeChange[] | null;
  /** A6: the tree Core built from the reviewed objects. */
  snapshotTree?: string | null;
  /**
   * A6: `true` ONLY when files MAY have been written although `applied` is
   * false (the write failed or was killed after git's checks, or the staged
   * content could not be verified). Never success, never "nothing written".
   */
  partial?: boolean | null;
}

// ---------------------------------------------------------------------------
// A7 — verification commands + project.context (design 2026-10-09 §3.7)
// ---------------------------------------------------------------------------

/**
 * A user-approved exact argv (`VerificationCommand`). `label` and `argv` are
 * UNTRUSTED display text: shown revealed, element by element, never run here.
 */
export interface VerificationCommand {
  id: string;
  projectId: string;
  label: string;
  argv: string[];
  approvedAt: string;
}

/** `verification.list` result: live (not revoked) commands, by `approvedAt`. */
export interface VerificationListResult {
  commands: VerificationCommand[];
}

/** `verification.approve` params. Core trims the label and checks for secrets. */
export interface VerificationApproveParams {
  projectId: string;
  label: string;
  argv: readonly string[];
}

/**
 * `verification.run` params, in the A2 fingerprint order. Never argv: only an
 * approved command can run. `expectedSandboxName` is the task's BINDING
 * (`TaskSummary.sandboxName`, never `chosenSandboxName`) and
 * `expectedWorkspaceMode` that sandbox's `sandbox.list` mode — what the run
 * dialog showed the user.
 */
export interface VerificationRunParams {
  taskId: string;
  commandId: string;
  expectedSandboxName: string;
  expectedWorkspaceMode: WorkspaceMode;
  /** A2 rules: a fresh key per gesture, reused only by "Retry safely". */
  idempotencyKey?: string;
}

/** `verification.run` answer: the run STARTED (asynchronously). */
export interface VerificationRunResult {
  runId: string;
  /** Sequence of the durable `verification.started` task event. */
  startedSequence: number;
  /** A keyed replay of the FIRST answer; it never runs twice. */
  replayed?: boolean;
}

/**
 * What best-effort redaction did to a run's stored output. `outputWithheld`
 * = the redactor was unavailable, so NO output was stored.
 */
export interface OutputRedaction {
  bestEffort: boolean;
  replacements: number;
  byKind: Record<string, number>;
  outputWithheld?: boolean;
}

/**
 * `verification.result`. `outcome` is an OPEN string (`running`, `exited`,
 * `signaled`, `timed_out`, `spawn_failed`, `read_failed`,
 * `possibly_sbx_error`, `interrupted` today; an unknown value is shown
 * as-is). `exitCode` is the exit status of `sbx exec` (UNVERIFIED that it is
 * the command's own). `stdout` / `stderr` are capped, lossily decoded,
 * redacted before storage and UNTRUSTED.
 */
export interface VerificationResult {
  runId: string;
  taskId: string;
  commandId: string;
  label: string;
  argv: string[];
  sandbox: string;
  workspaceMode: string;
  outcome: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  redactions: OutputRedaction;
  elapsedMs?: number;
  startedAt: string;
  finishedAt?: string;
  outputIncomplete?: boolean;
}

/** One detected root manifest. Suggestions and notes are UNTRUSTED display strings. */
export interface DetectedManifest {
  manifest: string;
  suggestedCommands: string[][];
  notes: string[];
}

/** One registered repository's detection; `unreadable` = names nothing was taken from. */
export interface RepositoryContext {
  repoPath: string;
  detected: DetectedManifest[];
  unreadable: string[];
}

/** `project.context` result; `approved` repeats `verification.list`. */
export interface ProjectContextResult {
  repositories: RepositoryContext[];
  approved: VerificationCommand[];
}
