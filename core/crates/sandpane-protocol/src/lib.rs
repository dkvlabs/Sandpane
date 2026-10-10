//! Sandpane Core protocol — versioned RPC envelope, method payloads, events, errors.
//!
//! These are **Sandpane-owned** types (docs/specs/02_ARCHITECTURE_AND_DATA.md §2, §4).
//! They are never to be confused with official Docker SBX, Codex, or Claude wire formats.
//! Wire format: newline-delimited JSON over a Unix domain socket / Windows named pipe.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Bumped on any breaking frame/semantics change; negotiated in `system.probe`.
pub const PROTOCOL_VERSION: u32 = 1;

/// Semantic version reported in [`CoreCapabilities`].
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

// ---------------------------------------------------------------------------
// RPC envelope
// ---------------------------------------------------------------------------

/// Client → service request frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    /// Protocol version the client speaks.
    pub v: u32,
    /// Client-chosen correlation id; echoed verbatim in the response.
    pub id: String,
    /// Dotted method name; see [`Method`].
    pub method: String,
    /// Method-specific payload (`{}` when empty).
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Service → client response frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    pub v: u32,
    pub id: String,
    #[serde(flatten)]
    pub outcome: RpcOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RpcOutcome {
    Ok(serde_json::Value),
    Err(RpcError),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
    /// Optional structured details (never secrets, never full prompt content).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl RpcResponse {
    pub fn ok(id: impl Into<String>, result: serde_json::Value) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id: id.into(),
            outcome: RpcOutcome::Ok(result),
        }
    }

    pub fn err(id: impl Into<String>, code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id: id.into(),
            outcome: RpcOutcome::Err(RpcError {
                code,
                message: message.into(),
                details: None,
            }),
        }
    }
}

/// Structured error codes (docs/specs/02 §2). Transport-level failures use `INTERNAL`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    NotInstalled,
    DaemonDown,
    UnsupportedSbxVersion,
    ProviderAuthRequired,
    Conflict,
    TaskInterrupted,
    PermissionDenied,
    ValidationFailed,
    NotFound,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotInstalled => "NOT_INSTALLED",
            Self::DaemonDown => "DAEMON_DOWN",
            Self::UnsupportedSbxVersion => "UNSUPPORTED_SBX_VERSION",
            Self::ProviderAuthRequired => "PROVIDER_AUTH_REQUIRED",
            Self::Conflict => "CONFLICT",
            Self::TaskInterrupted => "TASK_INTERRUPTED",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::ValidationFailed => "VALIDATION_FAILED",
            Self::NotFound => "NOT_FOUND",
            Self::Internal => "INTERNAL",
        }
    }
}

/// Known RPC methods (docs/specs/02 §2 contract). Unknown methods are rejected
/// with `VALIDATION_FAILED` — there is deliberately no free-form execution
/// method. Every addition here is additive for protocol v1 (no existing wire
/// value is renamed or removed) and must land in `parse`, `as_str`, [`Method::ALL`]
/// and `schemas/rpc-request.schema.json` together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Method {
    #[serde(rename = "system.probe")]
    SystemProbe,
    #[serde(rename = "project.create")]
    ProjectCreate,
    #[serde(rename = "project.list")]
    ProjectList,
    #[serde(rename = "project.update")]
    ProjectUpdate,
    #[serde(rename = "project.archive")]
    ProjectArchive,
    #[serde(rename = "project.unarchive")]
    ProjectUnarchive,
    #[serde(rename = "project.delete")]
    ProjectDelete,
    #[serde(rename = "project.add_repository")]
    ProjectAddRepository,
    #[serde(rename = "project.remove_repository")]
    ProjectRemoveRepository,
    #[serde(rename = "sandbox.list")]
    SandboxList,
    #[serde(rename = "sandbox.create")]
    SandboxCreate,
    #[serde(rename = "sandbox.stop")]
    SandboxStop,
    #[serde(rename = "sandbox.remove")]
    SandboxRemove,
    #[serde(rename = "conversation.create")]
    ConversationCreate,
    #[serde(rename = "conversation.send")]
    ConversationSend,
    #[serde(rename = "conversation.list")]
    ConversationList,
    #[serde(rename = "conversation.history")]
    ConversationHistory,
    #[serde(rename = "task.cancel")]
    TaskCancel,
    #[serde(rename = "task.list")]
    TaskList,
    #[serde(rename = "task.subscribe")]
    TaskSubscribe,
    #[serde(rename = "git.review")]
    GitReview,
    #[serde(rename = "git.apply")]
    GitApply,
}

impl Method {
    /// The complete supported surface, in wire order. This is the single list
    /// that backs feature discovery (`CoreCapabilities.methods`): it is derived
    /// from the enum rather than hand-written, and `dispatch` must match
    /// exhaustively over the same enum, so an advertised method always really
    /// exists and a handled method is always advertised.
    pub const ALL: [Method; 22] = [
        Self::SystemProbe,
        Self::ProjectCreate,
        Self::ProjectList,
        Self::ProjectUpdate,
        Self::ProjectArchive,
        Self::ProjectUnarchive,
        Self::ProjectDelete,
        Self::ProjectAddRepository,
        Self::ProjectRemoveRepository,
        Self::SandboxList,
        Self::SandboxCreate,
        Self::SandboxStop,
        Self::SandboxRemove,
        Self::ConversationCreate,
        Self::ConversationSend,
        Self::ConversationList,
        Self::ConversationHistory,
        Self::TaskCancel,
        Self::TaskList,
        Self::TaskSubscribe,
        Self::GitReview,
        Self::GitApply,
    ];

    /// Wire names of every method in [`Method::ALL`] — derived, never a list a
    /// caller could keep stale.
    pub fn wire_names() -> Vec<&'static str> {
        Self::ALL.iter().copied().map(Self::as_str).collect()
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "system.probe" => Self::SystemProbe,
            "project.create" => Self::ProjectCreate,
            "project.list" => Self::ProjectList,
            "project.update" => Self::ProjectUpdate,
            "project.archive" => Self::ProjectArchive,
            "project.unarchive" => Self::ProjectUnarchive,
            "project.delete" => Self::ProjectDelete,
            "project.add_repository" => Self::ProjectAddRepository,
            "project.remove_repository" => Self::ProjectRemoveRepository,
            "sandbox.list" => Self::SandboxList,
            "sandbox.create" => Self::SandboxCreate,
            "sandbox.stop" => Self::SandboxStop,
            "sandbox.remove" => Self::SandboxRemove,
            "conversation.create" => Self::ConversationCreate,
            "conversation.send" => Self::ConversationSend,
            "conversation.list" => Self::ConversationList,
            "conversation.history" => Self::ConversationHistory,
            "task.cancel" => Self::TaskCancel,
            "task.list" => Self::TaskList,
            "task.subscribe" => Self::TaskSubscribe,
            "git.review" => Self::GitReview,
            "git.apply" => Self::GitApply,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SystemProbe => "system.probe",
            Self::ProjectCreate => "project.create",
            Self::ProjectList => "project.list",
            Self::ProjectUpdate => "project.update",
            Self::ProjectArchive => "project.archive",
            Self::ProjectUnarchive => "project.unarchive",
            Self::ProjectDelete => "project.delete",
            Self::ProjectAddRepository => "project.add_repository",
            Self::ProjectRemoveRepository => "project.remove_repository",
            Self::SandboxList => "sandbox.list",
            Self::SandboxCreate => "sandbox.create",
            Self::SandboxStop => "sandbox.stop",
            Self::SandboxRemove => "sandbox.remove",
            Self::ConversationCreate => "conversation.create",
            Self::ConversationSend => "conversation.send",
            Self::ConversationList => "conversation.list",
            Self::ConversationHistory => "conversation.history",
            Self::TaskCancel => "task.cancel",
            Self::TaskList => "task.list",
            Self::TaskSubscribe => "task.subscribe",
            Self::GitReview => "git.review",
            Self::GitApply => "git.apply",
        }
    }
}

/// Optional protocol features this Core implements, advertised in
/// `CoreCapabilities.features` (design 2026-10-09 §3.1 item 9). Feature
/// strings name ADDITIVE behaviour a client cannot infer from the method list
/// (a new optional request field is silently dropped by a Core that predates
/// it). Additive only: never renamed, removed or reused. Clients must ignore
/// strings they do not know.
///
/// * `idempotency-keys` — `sandbox.create` / `conversation.send` honour
///   `idempotencyKey` (A2).
/// * `sandbox-create-agent` — `sandbox.create` honours `agent` (A1).
pub const FEATURES: [&str; 2] = ["idempotency-keys", "sandbox-create-agent"];

/// [`FEATURES`] as owned strings — the one derivation `system.probe` uses.
pub fn feature_names() -> Vec<String> {
    FEATURES.iter().map(|f| f.to_string()).collect()
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// `system.probe` response: identity + capability discovery (docs/specs/02 §2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCapabilities {
    pub protocol_version: u32,
    pub core_version: String,
    pub instance_id: String,
    /// SBX CLI presence; `None` when not installed/located.
    pub sbx: Option<SbxStatus>,
    /// Agent adapters compiled into this core and their verification state.
    pub agents: Vec<AgentCapability>,
    pub platform: String,
    /// Wire names of every method THIS core actually dispatches, derived from
    /// [`Method::ALL`] (never a hand-written list that can drift). Clients use
    /// this for feature discovery — e.g. whether `task.list` exists — instead
    /// of assuming it from a version number (`#[serde(default)]` so a response
    /// from a pre-discovery core still deserializes).
    #[serde(default)]
    pub methods: Vec<String>,
    /// Optional features this Core implements, from [`FEATURES`] (A2,
    /// additive; `#[serde(default)]`: absent from a pre-A2 Core = none).
    #[serde(default)]
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SbxStatus {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub daemon_running: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapability {
    pub id: String,
    /// True only after the adapter passed its in-SBX feasibility gate (P0).
    pub verified: bool,
    pub supports_streaming: bool,
    pub supports_cancel: bool,
    /// Native-session resume is advertised ONLY after restart tests pass.
    pub supports_resume: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub created_at: String,
    /// Repository host paths registered with this project (the `repositories`
    /// table's `canonical_path` column), ordered by insertion. An IDE uses these
    /// to resolve a folder to a Core project. NOTE, honestly: the stored value
    /// is what the caller registered — `project.create` requires an ABSOLUTE
    /// path but Core canonicalizes (resolves symlinks) at mount time in
    /// `sandbox.create`, not at registration. A client comparing a folder path
    /// must therefore canonicalize both sides before matching, not string-compare.
    /// `#[serde(default)]` keeps responses from an older Core deserializable
    /// (additive v1 field).
    #[serde(default)]
    pub repositories: Vec<String>,
    /// A3a (additive): RFC 3339 UTC instant the project was archived; ABSENT
    /// when it is not archived (and from a Core older than A3a). An archived
    /// project refuses `conversation.create`, `conversation.send`,
    /// `sandbox.create`, `project.update` and the repository methods; reads
    /// keep working. `project.list` returns archived projects only when asked
    /// with `includeArchived: true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

/// `project.list` params (A3a, additive). Every field is optional and an
/// older client sends none at all (params absent → `null`), which means
/// "live projects only" — today's behaviour.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_archived: Option<bool>,
}

impl ProjectListParams {
    /// Parse the wire `params`: `null` (absent) is the default.
    pub fn from_wire(params: serde_json::Value) -> Result<Self, serde_json::Error> {
        if params.is_null() {
            return Ok(Self::default());
        }
        serde_json::from_value(params)
    }

    pub fn include_archived(&self) -> bool {
        self.include_archived.unwrap_or(false)
    }
}

/// `project.update` params (A3a). At least one of `name` / `description`.
/// `name`: display text, at most 120 characters (the `project.create` rule).
/// `description`: at most 2000 characters, newlines allowed, every other
/// control character refused; `""` clears it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdateParams {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// `project.archive` / `project.unarchive` params (A3a). Both idempotent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIdParams {
    pub project_id: String,
}

/// `project.delete` params (A3a, two-step confirmation, design §2). Without
/// `confirmToken` Core deletes nothing and answers a [`ConfirmationRequest`]
/// (action `project.delete`, target `{name, id}`); with it, Core re-checks the
/// preconditions and deletes the project's rows. The token is bound to the
/// project ID: a rename between the steps does not invalidate it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeleteParams {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_token: Option<String>,
}

/// `project.delete` result: exactly one field — `confirmation` (step 1,
/// nothing changed) or `deleted: true` (step 2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeleteResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation: Option<ConfirmationRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

/// `project.add_repository` / `project.remove_repository` params (A3a).
/// `path` is a host path: add canonicalizes it to a registrable Git top
/// level (the `project.create` rules); remove matches the stored canonical
/// path or the canonicalized input. Neither touches the host repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepositoryParams {
    pub project_id: String,
    pub path: String,
}

/// `project.create` params.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateParams {
    pub name: String,
    #[serde(default)]
    pub repositories: Vec<String>,
}

/// `sandbox.create` params — every field is validated before reaching any CLI
/// argument vector (docs/specs/06 §4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCreateSpec {
    pub name: String,
    pub project_id: String,
    pub workspace_mode: WorkspaceMode,
    /// Host path of the repository to bind; canonicalized + validated by core.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    /// Built-in sbx agent to create the sandbox with (A1, additive). Absent →
    /// Core uses the provider-free `shell` agent. Core accepts ONLY an exact
    /// built-in agent name from the captured `sbx create --help` of the pinned
    /// version (`claude, codex, copilot, cursor, devin, docker-agent, droid,
    /// gemini, kiro, opencode, shell`); sandbox-kit references (local
    /// directories, ZIPs, git URLs, OCI refs) run third-party code and are
    /// refused with `VALIDATION_FAILED`. Accepting a provider agent is NOT a
    /// claim that Sandpane has verified it: verification state lives only in
    /// `CoreCapabilities.agents`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Retry-safety key (A2, additive): 1..=128 chars of `[A-Za-z0-9._-]`.
    /// Core stores key → result durably for 24 h, namespaced by method; a
    /// replay with the same params runs nothing and returns the FIRST
    /// response unchanged plus `replayed: true` — it is not current state;
    /// re-read with `task.list` / `sandbox.list`. The same key with different
    /// params is `CONFLICT`. Send it only when `system.probe` advertises the
    /// `idempotency-keys` feature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSummary {
    pub name: String,
    /// SBX is the source of truth; this is the last probed state, never assumed.
    pub probed_state: Option<String>,
    pub bound_project_id: Option<String>,
    /// Workspace mapping mode as recorded in Core's newest `sandbox_bindings`
    /// row for this name — `direct_mount` means the mount is LIVE-WRITABLE and
    /// UIs must label it as such (specs/04 §3, specs/02 §7). It is the recorded
    /// binding, NOT a live SBX verification: SBX owns sandbox state and is
    /// probed for `probedState`, while the mode is what Core was asked to bind.
    /// A client rendering `probedState` present with no mode must show the mode
    /// as UNVERIFIED, never as safe. Absent means Core has no readable binding
    /// row for this name; the mode is never guessed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_mode: Option<WorkspaceMode>,
    /// The agent sbx itself reports for this sandbox in `ls --json` (A1,
    /// additive). A probed FACT about the sandbox, never a verification claim:
    /// whether Sandpane has verified an adapter for it is only ever stated by
    /// `CoreCapabilities.agents[].verified`. Absent when sbx did not report one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// A2 (additive): `true` ONLY when this response is a REPLAY of an
    /// earlier keyed request. A replay returns the FIRST response unchanged
    /// plus `replayed: true`; it is not current state — re-read with
    /// `task.list` / `sandbox.list`. Absent on every first response (and
    /// never stored as part of the remembered result).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replayed: Option<bool>,
}

/// `sandbox.stop` params (A1). Not destructive: no confirmation token.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStopParams {
    pub name: String,
}

/// `sandbox.stop` result. `stopped: true` only says `sbx stop` exited 0;
/// the state is whatever the post-stop `sbx ls --json` re-query reports in
/// `requeried` (specs/02 §5: exit 0 never means desired state). `requeried`
/// is ABSENT when the sandbox is no longer listed or the re-query could not be
/// read — clients then show the state as unknown, never as "stopped".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStopResult {
    pub stopped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requeried: Option<SandboxSummary>,
}

/// `sandbox.remove` params (A1, two-step confirmation, design 2026-10-09 §2).
/// Without `confirmToken` Core changes nothing and answers a
/// [`ConfirmationRequest`]; with it, Core re-checks the target identity and
/// removes the sandbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxRemoveParams {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_token: Option<String>,
}

/// Identity a confirmation token is bound to: the sandbox name AND the sbx
/// `id` of the sandbox that carried that name when the token was issued, so a
/// same-named replacement is refused with `CONFLICT`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationTarget {
    pub name: String,
    pub id: String,
}

/// Server-side destructive-action confirmation (design 2026-10-09 §2). The
/// token is 256-bit random, single-use, held in Core memory only and expires
/// at `expiresAt` (120 s after issue). `action` is the dotted method the token
/// is valid for. `external: true` means Core cannot confirm Sandpane created
/// this sandbox: there is no live binding recorded for THIS sbx id — no
/// binding at all, a binding that predates sbx-id tracking or has no recorded
/// id, or a binding for an earlier sandbox with a different id. Every client
/// must show it prominently together with `impact`. For a PROJECT target
/// (`project.delete`, A3a) `external` is always `false`: a project exists only
/// in Core, and `target.id` is the project id (`target.name` is display only —
/// a rename between the steps does not invalidate the token). Not a proof of human
/// presence: see design 2026-10-09 §2.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationRequest {
    pub token: String,
    /// RFC 3339 UTC.
    pub expires_at: String,
    pub action: String,
    pub target: ConfirmationTarget,
    pub impact: Vec<String>,
    pub external: bool,
}

/// `sandbox.remove` result: exactly one of the two fields is present —
/// `confirmation` for step 1 (nothing changed), `removed: true` for step 2.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxRemoveResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation: Option<ConfirmationRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<bool>,
}

/// Workspace mapping modes (docs/specs/02 §7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    /// Host tree writable immediately — must be labeled live-writable in UIs.
    DirectMount,
    SbxClone,
    HostWorktree,
    Mountless,
}

/// `conversation.create` params.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCreateParams {
    pub project_id: String,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_id: Option<String>,
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub agent_id: String,
    pub created_at: String,
}

/// `conversation.send` params. Content is data, never a command (specs/02 §2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSendParams {
    pub conversation_id: String,
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<ContextRef>,
    /// Retry-safety key (A2, additive) — same rules as
    /// [`SandboxCreateSpec::idempotency_key`]: a replay returns the FIRST
    /// response (the `TaskSummary` the first request created) unchanged plus
    /// `replayed: true`; it is not current state — re-read with `task.list`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRef {
    pub kind: ContextRefKind,
    /// Path or identifier — validated, canonicalized; never executed.
    pub target: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextRefKind {
    File,
    Selection,
    Diagnostics,
    DiffRange,
}

/// `task.subscribe` params.
///
/// CURSOR AMBIGUITY (resolved by this revision, specs/02 §2): event sequences
/// are per task and start at 1, so one scalar cursor cannot describe several
/// tasks. The two cursors apply to different request shapes:
///
/// * `taskId` present → replay that ONE task from the scalar `afterSequence`
///   (unchanged legacy behaviour; `afterSequences` is IGNORED on this path, so
///   a client that sends both keeps its old semantics).
/// * `taskId` absent (project-wide or global replay) → when `afterSequences` is
///   present, EACH task is replayed from its own cursor (`afterSequences[taskId]`,
///   defaulting to 0 — i.e. the full history — for tasks missing from the map);
///   when it is absent, every task falls back to the shared scalar
///   `afterSequence`, exactly as before.
///
/// Clients that keep per-task checkpoints should therefore send the map with
/// `projectId` and no `taskId`. CONSEQUENCE TO PLAN FOR: a map that names only
/// some tasks means the UNNAMED ones replay in full (cursor 0), so a client
/// catching up a large project should name every task it has already seen.
/// Core refuses a replay that cannot fit one IPC frame rather than sending a
/// frame a client must reject, and says so with `VALIDATION_FAILED`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSubscribeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Replay everything strictly after this sequence. Scalar semantics per the
    /// table above: the cursor of a single `taskId` request, else the fallback
    /// shared cursor of a project-wide replay when `after_sequences` is absent.
    #[serde(default)]
    pub after_sequence: i64,
    /// Per-task replay cursors for a project-wide (or global) replay: task id →
    /// last sequence the client has durably seen for THAT task. Sequences are
    /// not comparable across tasks, so a shared scalar can skip events of a
    /// low-sequence task (recorded v1 gap, docs/compatibility.md). Negative
    /// values are normalised to 0 by Core; the map is ignored when `task_id`
    /// is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_sequences: Option<HashMap<String, i64>>,
}

/// `task.list` params — read-only discovery of Core task state.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListParams {
    /// Scope to one project (tasks reached through that project's
    /// conversations). Absent = every task Core knows about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Only tasks currently in one of these statuses. Statuses are Core's own
    /// stored values; an unknown status string is rejected, never normalized.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub statuses: Vec<TaskStatus>,
    /// Rows to return. Core clamps to `1..=500` and defaults to 200 — the
    /// response is always bounded (specs/02 §2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// `conversation.list` params — read-only chat enumeration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationListParams {
    /// Scope to one project. Absent = every conversation Core knows about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Rows to return; clamped to `1..=500`, default 200.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// `conversation.history` params — bounded transcript read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationHistoryParams {
    pub conversation_id: String,
    /// Return messages strictly after this per-conversation sequence. Negative
    /// values are normalised to 0 by Core.
    #[serde(default)]
    pub after_sequence: i64,
    /// Rows to return; clamped to `1..=500`, default 200. Core additionally
    /// stops on a total-bytes ceiling, so a single message larger than the
    /// ceiling never overflows the 4 MiB frame cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// One stored chat message (`messages` table). Content is data, never a
/// command; Core returns it verbatim (specs/02 §3).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub sequence: i64,
}

/// `conversation.history` response. Both bounds are disclosed: when the row
/// limit or the byte ceiling stopped the scan, `truncated` is true and
/// `next_sequence` is the last sequence actually returned, so the caller can
/// page forward without losing rows (specs/02 §2 "bounded responses … with
/// truncation disclosure").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationHistoryResult {
    pub messages: Vec<MessageRecord>,
    pub truncated: bool,
    /// Highest sequence returned, or the request cursor when nothing was
    /// returned — ready-made input for the next call's `afterSequence`.
    pub next_sequence: i64,
}

/// Durable, replayable task event (specs/02 §3 `task_events`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub task_id: String,
    pub sequence: i64,
    pub kind: String,
    pub payload: serde_json::Value,
    pub timestamp: String,
}

/// Normalized agent event union (specs/02 §4). A Sandpane format; adapters must
/// normalize only what they can verify and mark unsupported events explicitly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    #[serde(rename = "message.delta")]
    MessageDelta { text: String },
    #[serde(rename = "tool.started")]
    ToolStarted { name: String, id: String },
    #[serde(rename = "tool.finished")]
    ToolFinished {
        id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    #[serde(rename = "file.changed")]
    FileChanged { path: String },
    #[serde(rename = "approval.required")]
    ApprovalRequired {
        #[serde(rename = "requestId")]
        request_id: String,
        description: String,
    },
    #[serde(rename = "task.completed")]
    TaskCompleted { ok: bool },
    #[serde(rename = "error")]
    Error { code: ErrorCode, message: String },
    /// Adapter could not verify a provider event; surfaced, never guessed.
    #[serde(rename = "unsupported.event")]
    UnsupportedEvent {
        #[serde(rename = "providerType")]
        provider_type: String,
    },
}

/// Task lifecycle states (specs/02 §4). Transitions are enforced in Core.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Created,
    Queued,
    Preparing,
    Running,
    Verifying,
    AwaitingInput,
    AwaitingReview,
    Completed,
    Rejected,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub conversation_id: String,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    /// A2 (additive): `true` ONLY when this response is a REPLAY of an
    /// earlier keyed request. A replay returns the FIRST response unchanged
    /// plus `replayed: true`; it is not current state — re-read with
    /// `task.list` / `sandbox.list`. Absent on every first response (and
    /// never stored as part of the remembered result).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replayed: Option<bool>,
}

/// `git.review` response: the ACTUAL change set vs the task base revision.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub task_id: String,
    pub base_commit: String,
    pub host_dirty: bool,
    pub changes: Vec<FileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: FileChangeStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

/// `git.apply` params. Apply is an explicit Git operation, never a file overwrite.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitApplyParams {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_files: Option<Vec<String>>,
    /// Client's recorded base; a mismatch aborts (specs/06 §6).
    pub expected_base: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub applied: bool,
    /// Reason when not applied: base diverged, host dirty, conflict, validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abort_reason: Option<String>,
    #[serde(default)]
    pub conflicted_files: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrip() {
        let req = RpcRequest {
            v: PROTOCOL_VERSION,
            id: "req-1".into(),
            method: "conversation.send".into(),
            params: serde_json::json!({"conversationId": "c1", "content": "hi; rm -rf /"}),
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: RpcRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.method, "conversation.send");
        // Hostile content survives as inert data.
        assert_eq!(back.params["content"], "hi; rm -rf /");
    }

    #[test]
    fn response_variants_roundtrip() {
        let ok = RpcResponse::ok("1", serde_json::json!({"taskId": "t1"}));
        let err = RpcResponse::err("2", ErrorCode::NotInstalled, "sbx not found");
        for r in [ok, err] {
            let s = serde_json::to_string(&r).unwrap();
            let back: RpcResponse = serde_json::from_str(&s).unwrap();
            assert_eq!(back.v, PROTOCOL_VERSION);
        }
    }

    #[test]
    fn error_codes_serialize_screaming_snake() {
        let s = serde_json::to_string(&ErrorCode::UnsupportedSbxVersion).unwrap();
        assert_eq!(s, "\"UNSUPPORTED_SBX_VERSION\"");
        let s = serde_json::to_string(&ErrorCode::TaskInterrupted).unwrap();
        assert_eq!(s, "\"TASK_INTERRUPTED\"");
    }

    #[test]
    fn method_parse_rejects_unknown() {
        assert_eq!(Method::parse("system.probe"), Some(Method::SystemProbe));
        assert_eq!(Method::parse("git.apply"), Some(Method::GitApply));
        // No free-form execution method exists.
        assert_eq!(Method::parse("shell.exec"), None);
        assert_eq!(Method::parse("system.probe; ls"), None);
    }

    /// THE wire-name pin for the drift gate (`scripts/schema_drift.py` reads
    /// these exact strings out of `as_str`): all 16 methods must round-trip
    /// through `parse`, `as_str` and serde, and `Method::ALL` must cover every
    /// one of them exactly once — `CoreCapabilities.methods` is derived from it.
    /// A1 added `sandbox.stop` and `sandbox.remove`; there is deliberately NO
    /// `sandbox.start` (sbx v0.47 has no `start`). A3a added the six project
    /// lifecycle methods (lowercase snake_case segments, design §3.2 item 1).
    #[test]
    fn all_twenty_two_methods_round_trip() {
        const EXPECTED: [&str; 22] = [
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
            "task.cancel",
            "task.list",
            "task.subscribe",
            "git.review",
            "git.apply",
        ];
        assert_eq!(Method::ALL.len(), EXPECTED.len());
        assert_eq!(Method::wire_names(), EXPECTED.to_vec());
        for name in EXPECTED {
            let m = Method::parse(name).unwrap_or_else(|| panic!("{name} does not parse"));
            assert_eq!(m.as_str(), name, "{name}: as_str disagrees with parse");
            // serde name of the enum == the dotted wire name.
            let json = serde_json::to_string(&m).unwrap();
            assert_eq!(json, format!("\"{name}\""), "{name}: serde rename drift");
            let back: Method = serde_json::from_str(&json).unwrap();
            assert_eq!(back, m);
            assert_eq!(Method::parse(m.as_str()), Some(m));
        }
        // ALL must list every variant exactly once (no duplicate cursor target,
        // no method dispatched but unadvertised).
        let mut seen: Vec<&str> = Method::ALL.iter().map(|m| m.as_str()).collect();
        let total = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), total, "duplicate wire name in Method::ALL");
        // Derived list must equal the pinned set (order included).
        let mut derived = Method::wire_names();
        derived.sort_unstable();
        let mut expected = EXPECTED.to_vec();
        expected.sort_unstable();
        assert_eq!(derived, expected);
        assert_eq!(
            Method::parse("sandbox.start"),
            None,
            "sbx v0.47 has no start"
        );
        assert_eq!(
            Method::parse("project.addRepository"),
            None,
            "camelCase segments are not wire names"
        );
    }

    /// A3a: `archivedAt` is additive — absent when not archived (and from an
    /// older Core), present as RFC 3339 when archived.
    #[test]
    fn project_archived_at_is_absent_tolerant() {
        let old: Project = serde_json::from_value(serde_json::json!({
            "id": "p", "name": "Atlas Demo", "createdAt": "t"
        }))
        .unwrap();
        assert_eq!(old.archived_at, None);
        let live = serde_json::to_value(&old).unwrap();
        assert!(live.get("archivedAt").is_none(), "{live}");
        let archived = Project {
            archived_at: Some("2026-10-10T00:00:00Z".into()),
            ..old
        };
        assert_eq!(
            serde_json::to_value(&archived).unwrap()["archivedAt"],
            "2026-10-10T00:00:00Z"
        );
    }

    /// A3a: `project.list` params are optional; absent/`{}` = live only.
    #[test]
    fn project_list_params_default_to_live_only() {
        let p: ProjectListParams = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!p.include_archived());
        let p = ProjectListParams::from_wire(serde_json::Value::Null).unwrap();
        assert!(!p.include_archived());
        let p = ProjectListParams::from_wire(serde_json::json!({"includeArchived": true})).unwrap();
        assert!(p.include_archived());
    }

    /// A3a: project.delete result — exactly one of the two fields per step.
    #[test]
    fn project_delete_result_shapes() {
        let step2 = ProjectDeleteResult {
            confirmation: None,
            deleted: Some(true),
        };
        assert_eq!(
            serde_json::to_value(&step2).unwrap(),
            serde_json::json!({"deleted": true})
        );
        let params: ProjectDeleteParams =
            serde_json::from_value(serde_json::json!({"projectId": "p"})).unwrap();
        assert_eq!(params.confirm_token, None);
        let upd: ProjectUpdateParams =
            serde_json::from_value(serde_json::json!({"projectId": "p", "description": ""}))
                .unwrap();
        assert_eq!((upd.name, upd.description.as_deref()), (None, Some("")));
        let repo: ProjectRepositoryParams =
            serde_json::from_value(serde_json::json!({"projectId": "p", "path": "/r"})).unwrap();
        assert_eq!(repo.path, "/r");
        let _: ProjectIdParams =
            serde_json::from_value(serde_json::json!({"projectId": "p"})).unwrap();
    }

    /// A2: the single source of `CoreCapabilities.features`. Pinned here and,
    /// as a value set, against `core-capabilities.schema.json` by the drift
    /// gate. Additive only: a feature string is never renamed or reused.
    #[test]
    fn features_list_is_pinned() {
        assert_eq!(FEATURES, ["idempotency-keys", "sandbox-create-agent"]);
        assert_eq!(
            feature_names(),
            vec![
                "idempotency-keys".to_string(),
                "sandbox-create-agent".to_string()
            ]
        );
        // A pre-A2 Core omits `features`: still parses, as "nothing advertised".
        let old = r#"{"protocolVersion":1,"coreVersion":"0.1.0","instanceId":"i","sbx":null,"agents":[],"platform":"macos","methods":[]}"#;
        let c: CoreCapabilities = serde_json::from_str(old).unwrap();
        assert!(c.features.is_empty());
        let c = CoreCapabilities {
            features: feature_names(),
            ..c
        };
        assert_eq!(
            serde_json::to_value(&c).unwrap()["features"],
            serde_json::json!(["idempotency-keys", "sandbox-create-agent"])
        );
    }

    /// A2 review W1: a replay is marked, the first response never is.
    #[test]
    fn replayed_is_absent_tolerant_on_both_keyed_results() {
        let s: SandboxSummary =
            serde_json::from_str(r#"{"name":"a1","probedState":null,"boundProjectId":null}"#)
                .unwrap();
        assert_eq!(s.replayed, None);
        assert!(!serde_json::to_string(&s).unwrap().contains("replayed"));
        let r = SandboxSummary {
            replayed: Some(true),
            ..s
        };
        assert_eq!(serde_json::to_value(&r).unwrap()["replayed"], true);
        let t: TaskSummary =
            serde_json::from_str(r#"{"id":"t1","conversationId":"c1","status":"queued"}"#).unwrap();
        assert_eq!(t.replayed, None);
        assert!(!serde_json::to_string(&t).unwrap().contains("replayed"));
        let r = TaskSummary {
            replayed: Some(true),
            ..t
        };
        assert_eq!(serde_json::to_value(&r).unwrap()["replayed"], true);
    }

    #[test]
    fn idempotency_key_is_optional_on_create_and_send() {
        let spec: SandboxCreateSpec = serde_json::from_value(serde_json::json!({
            "name": "atlas-auth", "projectId": "p1", "workspaceMode": "mountless"
        }))
        .unwrap();
        assert_eq!(spec.idempotency_key, None);
        assert!(!serde_json::to_string(&spec)
            .unwrap()
            .contains("idempotencyKey"));
        let keyed: SandboxCreateSpec = serde_json::from_value(serde_json::json!({
            "name": "atlas-auth", "projectId": "p1", "workspaceMode": "mountless",
            "idempotencyKey": "k-1"
        }))
        .unwrap();
        assert_eq!(keyed.idempotency_key.as_deref(), Some("k-1"));
        assert_eq!(
            serde_json::to_value(&keyed).unwrap()["idempotencyKey"],
            "k-1"
        );

        let send: ConversationSendParams = serde_json::from_value(serde_json::json!({
            "conversationId": "c1", "content": "hi"
        }))
        .unwrap();
        assert_eq!(send.idempotency_key, None);
        assert!(!serde_json::to_string(&send)
            .unwrap()
            .contains("idempotencyKey"));
        let keyed: ConversationSendParams = serde_json::from_value(serde_json::json!({
            "conversationId": "c1", "content": "hi", "idempotencyKey": "k-2"
        }))
        .unwrap();
        assert_eq!(keyed.idempotency_key.as_deref(), Some("k-2"));
    }

    #[test]
    fn sandbox_create_spec_agent_is_optional_and_additive() {
        // A pre-A1 client omits `agent` entirely: still a valid spec.
        let old: SandboxCreateSpec = serde_json::from_value(serde_json::json!({
            "name": "atlas-auth", "projectId": "p1", "workspaceMode": "mountless"
        }))
        .unwrap();
        assert_eq!(old.agent, None);
        assert!(!serde_json::to_string(&old).unwrap().contains("agent"));
        let new: SandboxCreateSpec = serde_json::from_value(serde_json::json!({
            "name": "atlas-auth", "projectId": "p1", "workspaceMode": "mountless",
            "agent": "codex"
        }))
        .unwrap();
        assert_eq!(new.agent.as_deref(), Some("codex"));
        assert_eq!(serde_json::to_value(&new).unwrap()["agent"], "codex");
    }

    #[test]
    fn sandbox_summary_agent_is_absent_tolerant() {
        let s: SandboxSummary =
            serde_json::from_str(r#"{"name":"a1","probedState":null,"boundProjectId":null}"#)
                .unwrap();
        assert_eq!(s.agent, None);
        assert!(!serde_json::to_string(&s).unwrap().contains("agent"));
        let with = SandboxSummary {
            agent: Some("shell".into()),
            ..s
        };
        assert_eq!(serde_json::to_value(&with).unwrap()["agent"], "shell");
    }

    #[test]
    fn sandbox_stop_wire_shapes() {
        let p: SandboxStopParams =
            serde_json::from_value(serde_json::json!({"name": "atlas-auth"})).unwrap();
        assert_eq!(p.name, "atlas-auth");
        assert!(serde_json::from_value::<SandboxStopParams>(serde_json::json!({})).is_err());
        let gone = SandboxStopResult {
            stopped: true,
            requeried: None,
        };
        assert_eq!(
            serde_json::to_string(&gone).unwrap(),
            r#"{"stopped":true}"#,
            "absent requeried is omitted, never null"
        );
        let still = SandboxStopResult {
            stopped: true,
            requeried: Some(SandboxSummary {
                name: "atlas-auth".into(),
                probed_state: Some("stopped".into()),
                bound_project_id: None,
                workspace_mode: None,
                agent: Some("shell".into()),
                replayed: None,
            }),
        };
        let v = serde_json::to_value(&still).unwrap();
        assert_eq!(v["requeried"]["probedState"], "stopped");
        let back: SandboxStopResult = serde_json::from_value(v).unwrap();
        assert!(back.stopped);
    }

    #[test]
    fn sandbox_remove_wire_shapes() {
        let step1: SandboxRemoveParams =
            serde_json::from_value(serde_json::json!({"name": "atlas-auth"})).unwrap();
        assert_eq!(step1.confirm_token, None);
        let step2: SandboxRemoveParams =
            serde_json::from_value(serde_json::json!({"name": "atlas-auth", "confirmToken": "ab"}))
                .unwrap();
        assert_eq!(step2.confirm_token.as_deref(), Some("ab"));

        let issued = SandboxRemoveResult {
            confirmation: Some(ConfirmationRequest {
                token: "t".into(),
                expires_at: "2026-10-10T00:02:00Z".into(),
                action: "sandbox.remove".into(),
                target: ConfirmationTarget {
                    name: "atlas-auth".into(),
                    id: "b5ebec73-e2ae-471a-811a-e011cfb1948e".into(),
                },
                impact: vec!["removes sandbox atlas-auth".into()],
                external: true,
            }),
            removed: None,
        };
        let v = serde_json::to_value(&issued).unwrap();
        assert_eq!(v["confirmation"]["expiresAt"], "2026-10-10T00:02:00Z");
        assert_eq!(v["confirmation"]["action"], "sandbox.remove");
        assert_eq!(
            v["confirmation"]["target"]["id"],
            "b5ebec73-e2ae-471a-811a-e011cfb1948e"
        );
        assert_eq!(v["confirmation"]["external"], true);
        assert!(v.get("removed").is_none(), "step 1 never says removed");

        let done = SandboxRemoveResult {
            confirmation: None,
            removed: Some(true),
        };
        assert_eq!(serde_json::to_string(&done).unwrap(), r#"{"removed":true}"#);
        let back: SandboxRemoveResult = serde_json::from_str(r#"{"removed":true}"#).unwrap();
        assert!(back.confirmation.is_none());
    }

    #[test]
    fn additive_fields_deserialize_from_pre_revision_wire() {
        // A response frame from an OLDER Core must still parse: every field
        // added by this revision has a serde default, and none was renamed.
        let old_project = r#"{"id":"p1","name":"Atlas Demo","description":"","createdAt":"t"}"#;
        let p: Project = serde_json::from_str(old_project).unwrap();
        assert!(p.repositories.is_empty());

        let old_sandbox = r#"{"name":"atlas-auth","probedState":"running","boundProjectId":null}"#;
        let s: SandboxSummary = serde_json::from_str(old_sandbox).unwrap();
        assert_eq!(s.workspace_mode, None);
        // Absent, not guessed: `None` is not serialized at all.
        assert!(!serde_json::to_string(&s).unwrap().contains("workspaceMode"));

        let old_caps = r#"{"protocolVersion":1,"coreVersion":"0.1.0","instanceId":"i","sbx":null,"agents":[],"platform":"macos"}"#;
        let c: CoreCapabilities = serde_json::from_str(old_caps).unwrap();
        assert!(c.methods.is_empty());

        let old_sub = r#"{"projectId":"p1","afterSequence":3}"#;
        let t: TaskSubscribeParams = serde_json::from_str(old_sub).unwrap();
        assert_eq!(t.after_sequences, None);
        assert_eq!(t.after_sequence, 3);
    }

    #[test]
    fn task_subscribe_per_task_cursors_wire_shape() {
        let mut map = HashMap::new();
        map.insert("task-a".to_string(), 5i64);
        map.insert("task-b".to_string(), 2i64);
        let p = TaskSubscribeParams {
            project_id: Some("p1".into()),
            task_id: None,
            after_sequence: 0,
            after_sequences: Some(map),
        };
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["afterSequences"]["task-a"], 5);
        assert_eq!(json["afterSequences"]["task-b"], 2);
        let back: TaskSubscribeParams = serde_json::from_value(json).unwrap();
        assert_eq!(back.after_sequences.unwrap().get("task-a"), Some(&5));
        // Absent map is omitted entirely (additive, not a required field).
        let legacy = TaskSubscribeParams {
            project_id: Some("p1".into()),
            task_id: None,
            after_sequence: 4,
            after_sequences: None,
        };
        assert!(!serde_json::to_string(&legacy)
            .unwrap()
            .contains("afterSequences"));
    }

    #[test]
    fn list_and_history_params_accept_empty_object() {
        // `{}` must deserialize for every new read method (all fields optional
        // except conversation.history's required conversationId).
        let t: TaskListParams = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(t.project_id, None);
        assert!(t.statuses.is_empty());
        assert_eq!(t.limit, None);
        let c: ConversationListParams = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(c.limit, None);
        let h: ConversationHistoryParams =
            serde_json::from_value(serde_json::json!({"conversationId": "c1"})).unwrap();
        assert_eq!(h.after_sequence, 0);
        assert_eq!(h.limit, None);
        let missing = serde_json::from_value::<ConversationHistoryParams>(serde_json::json!({}));
        assert!(missing.is_err(), "conversationId is required");
        // Statuses are Core's own stored values — an unknown one is rejected,
        // never normalized into something else.
        let bad = serde_json::from_value::<TaskListParams>(
            serde_json::json!({"statuses": ["half_finished"]}),
        );
        assert!(bad.is_err());
        // Negative limit is not representable (u32) — rejected at parse time.
        let neg = serde_json::from_value::<TaskListParams>(serde_json::json!({"limit": -5}));
        assert!(neg.is_err());
    }

    #[test]
    fn history_result_wire_shape_is_camel_case_object() {
        let r = ConversationHistoryResult {
            messages: vec![MessageRecord {
                id: "m1".into(),
                conversation_id: "c1".into(),
                role: "user".into(),
                content: "hi".into(),
                sequence: 1,
            }],
            truncated: true,
            next_sequence: 1,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["messages"][0]["conversationId"], "c1");
        assert_eq!(v["messages"][0]["sequence"], 1);
        assert_eq!(v["truncated"], true);
        assert_eq!(v["nextSequence"], 1);
        let back: ConversationHistoryResult = serde_json::from_value(v).unwrap();
        assert_eq!(back.messages[0].content, "hi");
    }

    #[test]
    fn project_and_sandbox_additive_fields_wire_shape() {
        let p = Project {
            id: "p1".into(),
            name: "Atlas Demo".into(),
            description: String::new(),
            created_at: "t".into(),
            repositories: vec!["/repos/atlas".into()],
            archived_at: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["repositories"][0], "/repos/atlas");
        assert_eq!(v["id"], "p1"); // existing fields keep their names
        assert_eq!(v["createdAt"], "t");

        let s = SandboxSummary {
            name: "atlas-auth".into(),
            probed_state: Some("running".into()),
            bound_project_id: Some("p1".into()),
            workspace_mode: Some(WorkspaceMode::DirectMount),
            agent: None,
            replayed: None,
        };
        let v = serde_json::to_value(&s).unwrap();
        // Reuses the established snake_case enum names (specs/02 §7).
        assert_eq!(v["workspaceMode"], "direct_mount");
        assert_eq!(v["probedState"], "running");
    }

    #[test]
    fn agent_event_tagged_union_roundtrip() {
        let events = vec![
            AgentEvent::MessageDelta {
                text: "he…llo".into(),
            },
            AgentEvent::ToolStarted {
                name: "read_file".into(),
                id: "t1".into(),
            },
            AgentEvent::ToolFinished {
                id: "t1".into(),
                ok: true,
                summary: None,
            },
            AgentEvent::FileChanged {
                path: "src/ünicode/ファイル.rs".into(),
            },
            AgentEvent::ApprovalRequired {
                request_id: "a1".into(),
                description: "run tests".into(),
            },
            AgentEvent::TaskCompleted { ok: true },
            AgentEvent::Error {
                code: ErrorCode::ProviderAuthRequired,
                message: "auth needed".into(),
            },
            AgentEvent::UnsupportedEvent {
                provider_type: "codex.weird".into(),
            },
        ];
        for e in events {
            let s = serde_json::to_string(&e).unwrap();
            let back: AgentEvent = serde_json::from_str(&s).unwrap();
            assert_eq!(
                serde_json::to_value(&back).unwrap(),
                serde_json::to_value(&e).unwrap()
            );
        }
        // Wire shape matches the documented TS union (specs/02 §4).
        let s = serde_json::to_string(&AgentEvent::MessageDelta { text: "x".into() }).unwrap();
        assert_eq!(s, r#"{"type":"message.delta","text":"x"}"#);
        // Schema conformance pins (agent-event.schema.json field names —
        // camelCase, not snake_case; container rename_all would not do this).
        let s = serde_json::to_string(&AgentEvent::ApprovalRequired {
            request_id: "a1".into(),
            description: "d".into(),
        })
        .unwrap();
        assert_eq!(
            s,
            r#"{"type":"approval.required","requestId":"a1","description":"d"}"#
        );
        let s = serde_json::to_string(&AgentEvent::UnsupportedEvent {
            provider_type: "codex.weird".into(),
        })
        .unwrap();
        assert_eq!(
            s,
            r#"{"type":"unsupported.event","providerType":"codex.weird"}"#
        );
    }

    #[test]
    fn task_status_wire_names() {
        let s = serde_json::to_string(&TaskStatus::AwaitingReview).unwrap();
        assert_eq!(s, "\"awaiting_review\"");
    }

    #[test]
    fn workspace_mode_wire_names() {
        for (m, expect) in [
            (WorkspaceMode::DirectMount, "\"direct_mount\""),
            (WorkspaceMode::SbxClone, "\"sbx_clone\""),
            (WorkspaceMode::HostWorktree, "\"host_worktree\""),
            (WorkspaceMode::Mountless, "\"mountless\""),
        ] {
            assert_eq!(serde_json::to_string(&m).unwrap(), expect);
        }
    }
}
