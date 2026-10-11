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
    #[serde(rename = "conversation.rename")]
    ConversationRename,
    #[serde(rename = "conversation.archive")]
    ConversationArchive,
    #[serde(rename = "conversation.unarchive")]
    ConversationUnarchive,
    #[serde(rename = "conversation.delete")]
    ConversationDelete,
    #[serde(rename = "conversation.export")]
    ConversationExport,
    #[serde(rename = "task.cancel")]
    TaskCancel,
    #[serde(rename = "task.list")]
    TaskList,
    #[serde(rename = "task.subscribe")]
    TaskSubscribe,
    #[serde(rename = "git.review")]
    GitReview,
    /// A5 (§3.5 item 3): one file's patch from a task's change list.
    #[serde(rename = "git.diff")]
    GitDiff,
    #[serde(rename = "git.apply")]
    GitApply,
    /// A7 (§3.7 item 1): the project's live approved verification commands.
    #[serde(rename = "verification.list")]
    VerificationList,
    /// A7: approve an exact user-entered argv + label (secret-checked).
    #[serde(rename = "verification.approve")]
    VerificationApprove,
    /// A7: tombstone an approved command (never deleted).
    #[serde(rename = "verification.revoke")]
    VerificationRevoke,
    /// A7: run an approved command in the task's sandbox (asynchronous).
    #[serde(rename = "verification.run")]
    VerificationRun,
    /// A7: one run's state and (redacted, capped) output.
    #[serde(rename = "verification.result")]
    VerificationResult,
    /// A7 (§3.7 item 9): read-only manifest detection + approved commands.
    #[serde(rename = "project.context")]
    ProjectContext,
}

impl Method {
    /// The complete supported surface, in wire order. This is the single list
    /// that backs feature discovery (`CoreCapabilities.methods`): it is derived
    /// from the enum rather than hand-written, and `dispatch` must match
    /// exhaustively over the same enum, so an advertised method always really
    /// exists and a handled method is always advertised.
    pub const ALL: [Method; 34] = [
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
        Self::ConversationRename,
        Self::ConversationArchive,
        Self::ConversationUnarchive,
        Self::ConversationDelete,
        Self::ConversationExport,
        Self::TaskCancel,
        Self::TaskList,
        Self::TaskSubscribe,
        Self::GitReview,
        Self::GitDiff,
        Self::GitApply,
        Self::VerificationList,
        Self::VerificationApprove,
        Self::VerificationRevoke,
        Self::VerificationRun,
        Self::VerificationResult,
        Self::ProjectContext,
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
            "conversation.rename" => Self::ConversationRename,
            "conversation.archive" => Self::ConversationArchive,
            "conversation.unarchive" => Self::ConversationUnarchive,
            "conversation.delete" => Self::ConversationDelete,
            "conversation.export" => Self::ConversationExport,
            "task.cancel" => Self::TaskCancel,
            "task.list" => Self::TaskList,
            "task.subscribe" => Self::TaskSubscribe,
            "git.review" => Self::GitReview,
            "git.diff" => Self::GitDiff,
            "git.apply" => Self::GitApply,
            "verification.list" => Self::VerificationList,
            "verification.approve" => Self::VerificationApprove,
            "verification.revoke" => Self::VerificationRevoke,
            "verification.run" => Self::VerificationRun,
            "verification.result" => Self::VerificationResult,
            "project.context" => Self::ProjectContext,
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
            Self::ConversationRename => "conversation.rename",
            Self::ConversationArchive => "conversation.archive",
            Self::ConversationUnarchive => "conversation.unarchive",
            Self::ConversationDelete => "conversation.delete",
            Self::ConversationExport => "conversation.export",
            Self::TaskCancel => "task.cancel",
            Self::TaskList => "task.list",
            Self::TaskSubscribe => "task.subscribe",
            Self::GitReview => "git.review",
            Self::GitDiff => "git.diff",
            Self::GitApply => "git.apply",
            Self::VerificationList => "verification.list",
            Self::VerificationApprove => "verification.approve",
            Self::VerificationRevoke => "verification.revoke",
            Self::VerificationRun => "verification.run",
            Self::VerificationResult => "verification.result",
            Self::ProjectContext => "project.context",
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
/// * `conversation-sandbox-id` — `conversation.create` persists `sandboxId`
///   and every `Conversation` carries it when one was stored (A3b, §3.3
///   item 2). Without it a client cannot tell "no sandbox was chosen" from
///   "an older Core discarded the choice".
/// * `conversation-send-mode` — `conversation.send` honours `mode`
///   (`"task"` | `"discuss"`) and new tasks carry `TaskSummary.mode` (A4,
///   §3.4 item 1). A pre-A4 Core silently drops `mode` and would treat a
///   discussion as a task, so clients send it only when advertised.
/// * `git-apply` — `git.apply` applies reviewed `host_worktree` entries
///   (A6, design 2026-10-09 §3.6): `git.review` answers carry `reviewId`,
///   `hostHooksPath` and per-entry `taskBlob` / `taskMode`, `git.diff`
///   carries `taskBlob` / `taskMode`, and `git.apply` takes `reviewId` +
///   `entries` and answers the additive `ApplyResult` fields. Without it a
///   client keeps Apply in its "not implemented" state (§3.6 item 10).
/// * `verification` — the A7 verification surface (design 2026-10-09 §3.7):
///   `verification.list` / `approve` / `revoke` / `run` / `result` and
///   `project.context`. Clients enable the verification UI only when it is
///   advertised. Running is additionally gated on a PROVEN sbx version:
///   `verification.run` answers `UNSUPPORTED_SBX_VERSION` for every sbx
///   version whose `exec` argument passing is not captured (all of them in
///   A7) — the feature is real, running is gated on proof.
pub const FEATURES: [&str; 6] = [
    "idempotency-keys",
    "sandbox-create-agent",
    "conversation-sandbox-id",
    "conversation-send-mode",
    "git-apply",
    "verification",
];

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
/// (`project.delete`, A3a) or a CONVERSATION target (`conversation.delete`,
/// A3b) `external` is always `false`: both exist only in Core, and `target.id`
/// is the project / conversation id (`target.name` — the project name or the
/// stored conversation title — is display only: a rename between the steps
/// does not invalidate the token). Not a proof of human
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub agent_id: String,
    pub created_at: String,
    /// A3b (additive): RFC 3339 UTC instant the conversation was archived;
    /// ABSENT when it is live (and from a Core older than A3b). An archived
    /// conversation refuses `conversation.send` and `conversation.rename`
    /// (`VALIDATION_FAILED`); history, export and task reads keep working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    /// A3b (additive): the sandbox NAME chosen when the conversation was
    /// created — a stored name, NOT a binding or an identity: Core does not
    /// check that the sandbox still exists, and a same-named replacement is
    /// indistinguishable. Absent when none was chosen, for rows created before
    /// A3b, and from an older Core; rely on it only when `system.probe`
    /// advertises the `conversation-sandbox-id` feature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_id: Option<String>,
}

/// `conversation.rename` params (A3b). `title`: 1..=200 characters, the
/// `project.name` refusals (every control character including newline and
/// tab, line/paragraph separators, bidi controls); empty or whitespace-only
/// is refused. Refused on an archived conversation or project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRenameParams {
    pub conversation_id: String,
    pub title: String,
}

/// `conversation.archive` / `conversation.unarchive` params (A3b). Both are
/// idempotent (an archived conversation keeps its original `archivedAt`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationIdParams {
    pub conversation_id: String,
}

/// `conversation.delete` params (A3b, two-step confirmation, design §2).
/// Without `confirmToken` Core deletes nothing and answers a
/// [`ConfirmationRequest`] (action `conversation.delete`, target
/// `{name: <stored title>, id}`, `external: false`); with it, Core re-checks
/// the preconditions and deletes the conversation's rows. The token is bound
/// to the conversation ID: a rename between the steps does not invalidate it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDeleteParams {
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_token: Option<String>,
}

/// `conversation.delete` result: exactly one field — `confirmation` (step 1,
/// nothing changed) or `deleted: true` (step 2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDeleteResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation: Option<ConfirmationRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

/// `conversation.export` params (A3b) — the same paging as
/// `conversation.history`: messages strictly after `afterSequence` (negative
/// normalised to 0), `limit` clamped to `1..=500` (default 200), plus the
/// history byte ceiling.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExportParams {
    pub conversation_id: String,
    #[serde(default)]
    pub after_sequence: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// The `format` tag of every `conversation.export` page.
pub const CONVERSATION_EXPORT_FORMAT: &str = "sandpane.conversation-export.v1";

/// What best-effort redaction replaced in one export page (A3b §3.3 item 6).
/// `byKind` maps a kind name (`auth-header`, `private-key`, `token`, `jwt`,
/// `env-secret`, `url-credentials`, `url-secret-param`) to its replacement
/// count on THIS page; a kind with zero replacements is OMITTED (never listed
/// with 0), so `byKind` is `{}` when nothing was replaced. `replacements` is
/// the sum of `byKind`. Every page carries the (redacted) conversation title,
/// but the title's replacements are COUNTED only on the first page
/// (`afterSequence` absent or 0): clients can simply sum `replacements` and
/// `byKind` over all pages. Overlapping matches are merged into one
/// replacement, attributed to the most specific kind (e.g. a private key in
/// an env value counts as `private-key`). `bestEffort` is always `true`:
/// redaction is pattern-based and can miss secrets — review the export
/// before sharing it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRedaction {
    pub best_effort: bool,
    pub replacements: u64,
    pub by_kind: std::collections::BTreeMap<String, u64>,
}

/// `conversation.export` result (A3b): ONE page of a redacted export. Scope:
/// the conversation metadata and its messages only — task events, artifacts
/// and verification output are NOT included. `conversation.title` and every
/// `messages[].content` are redacted; there is no unredacted mode.
/// `truncated` / `nextSequence` follow `conversation.history`'s rules: page
/// until `truncated` is false, requiring `nextSequence` to strictly increase.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExportResult {
    /// Always [`CONVERSATION_EXPORT_FORMAT`].
    pub format: String,
    /// RFC 3339 UTC.
    pub exported_at: String,
    pub conversation: Conversation,
    pub messages: Vec<MessageRecord>,
    pub truncated: bool,
    pub next_sequence: i64,
    pub redaction: ExportRedaction,
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
    /// A4 (additive, §3.4 item 1): `"task"` (the default when absent; `null`
    /// reads as absent) or `"discuss"`. A `discuss` task never gets a
    /// writable workspace. Any other STRING value is refused by Core with
    /// `VALIDATION_FAILED` and the exact message `mode must be "task" or
    /// "discuss"` — it is a plain string on the wire so that this refusal is
    /// Core's message, not a decode error. A NON-string `mode` (number,
    /// object, …) fails params decoding instead: still `VALIDATION_FAILED`,
    /// but with the generic serde decode message, not the exact one. Core normalizes
    /// an explicit `"task"` to absent BEFORE the idempotency fingerprint, so
    /// every A2 hash is unchanged and "task" vs absent replays. Send it only
    /// when `system.probe` advertises `conversation-send-mode`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
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
    /// A3b (additive): also list archived conversations. Absent/false = live
    /// only — what an older client (which never sends it) always gets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_archived: Option<bool>,
}

impl ConversationListParams {
    pub fn include_archived(&self) -> bool {
        self.include_archived.unwrap_or(false)
    }
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
    /// A4 (additive, §3.4 item 1): the mode the task was created with —
    /// `"task"` or `"discuss"` today — present on every task created from A4
    /// on, ABSENT on older rows. An OPEN string: clients display an unknown
    /// value as-is and never fail to decode it (§1 rule 2: no strict enum).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// A4 (additive, §3.4 item 3): the sandbox NAME the task's chat chose
    /// (`Conversation.sandboxId`), copied when the task was sent. Present
    /// only when the chat chose one; absent on tasks created before A4.
    /// A stored name — NOT a binding, NOT an identity, and it NEVER means the
    /// task runs (or ran) in that sandbox: no task can run in a sandbox in
    /// this build. Never feed it into isolation labels, stop/remove impact
    /// counts or scope logic; that is `sandbox_name`'s job (review C1/C2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chosen_sandbox_name: Option<String>,
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
    /// A5 (additive, §3.5 item 2): the canonical HOST repository root of the
    /// task — the integration target that `host_dirty` describes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    /// A5 (additive, §3.5 item 2): paths Core could not inspect. Defined but
    /// NEVER produced in A5 — a repository with submodules is still refused
    /// with `VALIDATION_FAILED`, never returned as a partial list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uninspected: Option<Vec<String>>,
    /// A6 (additive, §3.6 item 3, R4): an opaque id for this answer, set
    /// only for `host_worktree` tasks. Core keeps the last 8 per task in
    /// memory (a Core restart means review again); `git.apply` accepts only
    /// entries copied verbatim from a review Core produced. Not a
    /// human-presence token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_id: Option<String>,
    /// A6 (additive, §3.6 item 9): the host repository's effective
    /// `core.hooksPath`, reported ONLY when it is repo-relative (a path under
    /// the repository root, in repo-relative form). Clients flag applied
    /// paths under it as "runs automatically".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_hooks_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Exactly as git reports it (A5: NUL-separated, never C-quoted).
    pub path: String,
    pub status: FileChangeStatus,
    /// A5 (additive, §3.5 item 2): the pre-rename path, set ONLY for
    /// `renamed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// A6 (additive, §3.6 item 3): the git blob id of the task-side content
    /// Core itself read (`H("blob <len>\0" + bytes)`, SHA-1 with collision
    /// detection or SHA-256 per the repository's object format). Only for
    /// `host_worktree` tasks; absent for `deleted` entries, for files over
    /// the 32 MiB apply cap ("too large to apply") and for entries Core
    /// could not read as a file or symlink.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_blob: Option<String>,
    /// A6 (additive, §3.6 item 3): `"100644"`, `"100755"` or `"120000"`,
    /// from `lstat` of the task-side entry; present exactly when
    /// `task_blob` is. An open string, not an enum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_mode: Option<String>,
}

/// `git.diff` params (A5, §3.5 item 3). Read-only.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffParams {
    pub task_id: String,
    /// Must equal, byte for byte, the `path` of an entry in the task's
    /// change list as `git.review` returns it (recomputed at call time). No
    /// other form (prefix, glob, `..`) is accepted.
    pub path: String,
    /// Clamped by Core to 1..=524288; default 262144.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    /// The entry's `status` as `git.review` lists it. Optional; REQUIRED in
    /// effect when the path is listed more than once (e.g. `deleted` and
    /// `untracked` after `git rm --cached`) — without it Core refuses
    /// rather than pick one. When given, path AND status must match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<FileChangeStatus>,
}

/// `git.diff` result (A5, §3.5 item 3). `patch` is UNTRUSTED text: display
/// it, never render or execute it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub path: String,
    /// Set only for `renamed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: FileChangeStatus,
    /// A unified diff of at most `maxBytes` bytes; empty when `binary`.
    pub patch: String,
    pub binary: bool,
    /// More existed than `maxBytes`; the patch ends at a line (or, for one
    /// long line, a character) boundary.
    pub truncated: bool,
    /// Non-UTF-8 bytes were replaced with U+FFFD.
    pub lossy: bool,
    /// The base-side blob id; absent for `added` and `untracked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_blob: Option<String>,
    /// A6 (additive, §3.6 item 3, C4): for `host_worktree` tasks, the blob
    /// id of the task-side bytes this patch was rendered from (ONE read).
    /// A client MUST NOT send an apply whose entry `taskBlob` differs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_blob: Option<String>,
    /// A6 (additive): the task-side mode for that same read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_mode: Option<String>,
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
    /// Pre-A6 field. REFUSED by an A6 Core (`VALIDATION_FAILED`), alone or
    /// together with `entries`: a list of bare paths binds no content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_files: Option<Vec<String>>,
    /// Client's recorded base; a mismatch aborts (specs/06 §6).
    pub expected_base: String,
    /// A6 (additive, §3.6 item 3): the `reviewId` of the `git.review`
    /// answer the entries were copied from. Required by an A6 Core.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_id: Option<String>,
    /// A6 (additive, §3.6 item 3): the entries to apply, copied VERBATIM
    /// from that review (`path`, `status`, `oldPath`, `taskBlob`,
    /// `taskMode`). Required and non-empty; an empty list never means "all".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<FileChange>>,
}

/// A6 (§3.6 item 7): an executable-bit change made by an apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeChange {
    pub path: String,
    /// Git mode before (`"100644"`), as an open string.
    pub from: String,
    /// Git mode after (`"100755"`), as an open string.
    pub to: String,
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
    /// A6 (additive): the entry paths written into the working tree and
    /// staged (nothing is committed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_files: Option<Vec<String>>,
    /// A6 (additive): executable-bit changes among the applied entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_changes: Option<Vec<ModeChange>>,
    /// A6 (additive): the tree Core built from the reviewed objects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_tree: Option<String>,
    /// A6 (additive): `true` ONLY when files may have been written although
    /// `applied` is false — the write failed or was killed after git's
    /// checks passed (W1), or post-write verification found staged content
    /// that differs from the reviewed content (W2). Absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial: Option<bool>,
}

// ---------------------------------------------------------------------------
// A7 — verification commands + project.context (design 2026-10-09 §3.7)
// ---------------------------------------------------------------------------

/// A user-approved exact argv (§3.7 item 1). `argv` is UNTRUSTED display
/// text for clients (shown revealed, element by element), proven free of
/// secret-shaped strings at approve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationCommand {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub argv: Vec<String>,
    pub approved_at: String,
}

/// `verification.list` / `project.context` params.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationListParams {
    pub project_id: String,
}

/// `verification.list` result: live commands ordered by `approvedAt`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationListResult {
    pub commands: Vec<VerificationCommand>,
}

/// `verification.approve` params (§3.7 item 2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationApproveParams {
    pub project_id: String,
    pub label: String,
    pub argv: Vec<String>,
}

/// `verification.approve` result. Approving a byte-equal live argv again
/// returns the existing command, label unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationApproveResult {
    pub command: VerificationCommand,
}

/// `verification.revoke` params.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRevokeParams {
    pub command_id: String,
}

/// `verification.revoke` result (idempotent).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRevokeResult {
    pub revoked: bool,
}

/// `verification.run` params (§3.7 items 1 and 5). Never argv, never a
/// path: only an approved command can run. The two `expected*` values are
/// what the run dialog showed the user; Core compares them with the task's
/// binding. Field order is the A2 fingerprint order; `idempotencyKey` is
/// skipped when absent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRunParams {
    pub task_id: String,
    pub command_id: String,
    pub expected_sandbox_name: String,
    pub expected_workspace_mode: WorkspaceMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

/// `verification.run` result: the run started (asynchronously).
/// `startedSequence` is the `verification.started` task event's sequence.
/// A keyed replay is the FIRST response plus `replayed: true`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRunResult {
    pub run_id: String,
    pub started_sequence: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replayed: Option<bool>,
}

/// `verification.result` params.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResultParams {
    pub run_id: String,
}

/// What best-effort redaction did to a run's stored output (§3.7 item 6).
/// `outputWithheld: true` = the redactor was unavailable, so NO output was
/// stored (stdout/stderr are empty) — never raw output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputRedaction {
    pub best_effort: bool,
    pub replacements: u64,
    pub by_kind: std::collections::BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_withheld: Option<bool>,
}

impl Default for OutputRedaction {
    fn default() -> Self {
        Self {
            best_effort: true,
            replacements: 0,
            by_kind: std::collections::BTreeMap::new(),
            output_withheld: None,
        }
    }
}

/// `verification.result` (§3.7 item 1, W1). `outcome` is an OPEN string:
/// `running`, `exited`, `signaled`, `timed_out`, `spawn_failed`,
/// `read_failed`, `possibly_sbx_error`, `interrupted` today; clients must
/// show an unknown value as-is. `exitCode` is the exit status of `sbx exec`
/// (UNVERIFIED that it is the command's own, C-2); present for `exited`
/// and `possibly_sbx_error` only. `stdout`/`stderr` are capped (64 KiB
/// each), decoded lossily and redacted (best effort) BEFORE storage, and
/// are UNTRUSTED text. `elapsedMs` / `finishedAt` are absent while running.
/// `outputIncomplete: true` = `sbx exec` exited but its output pipes were
/// still held open (an escaped descendant) after the kill grace, so the
/// stored output may be missing a tail; the exit status is kept as is.
/// Absent otherwise.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub run_id: String,
    pub task_id: String,
    pub command_id: String,
    pub label: String,
    pub argv: Vec<String>,
    pub sandbox: String,
    pub workspace_mode: String,
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub redactions: OutputRedaction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_incomplete: Option<bool>,
}

/// `project.context` params.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContextParams {
    pub project_id: String,
}

/// One detected root manifest (§3.7 item 9). Suggestions and notes are
/// UNTRUSTED display strings: never auto-approved, never run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedManifest {
    pub manifest: String,
    pub suggested_commands: Vec<Vec<String>>,
    pub notes: Vec<String>,
}

/// One registered repository's detection. `unreadable` lists root file
/// names nothing was taken from (`"."` = the root itself).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryContext {
    pub repo_path: String,
    pub detected: Vec<DetectedManifest>,
    pub unreadable: Vec<String>,
}

/// `project.context` result; `approved` repeats `verification.list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContextResult {
    pub repositories: Vec<RepositoryContext>,
    pub approved: Vec<VerificationCommand>,
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
    /// lifecycle methods (lowercase snake_case segments, design §3.2 item 1);
    /// A3b added the five conversation lifecycle methods (§3.3 item 1).
    #[test]
    fn all_twenty_seven_methods_round_trip() {
        const EXPECTED: [&str; 34] = [
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
            // A7 (§3.7 item 1), in this order after git.apply.
            "verification.list",
            "verification.approve",
            "verification.revoke",
            "verification.run",
            "verification.result",
            "project.context",
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
        assert_eq!(
            FEATURES,
            [
                "idempotency-keys",
                "sandbox-create-agent",
                "conversation-sandbox-id",
                "conversation-send-mode",
                "git-apply",
                "verification"
            ]
        );
        assert_eq!(
            feature_names(),
            vec![
                "idempotency-keys".to_string(),
                "sandbox-create-agent".to_string(),
                "conversation-sandbox-id".to_string(),
                "conversation-send-mode".to_string(),
                "git-apply".to_string(),
                "verification".to_string()
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
            serde_json::json!([
                "idempotency-keys",
                "sandbox-create-agent",
                "conversation-sandbox-id",
                "conversation-send-mode",
                "git-apply",
                "verification"
            ])
        );
    }

    /// A7 (§3.7 item 1): the wire shapes clients will build and read.
    #[test]
    fn a7_verification_wire_shapes() {
        let cmd = VerificationCommand {
            id: "vc".into(),
            project_id: "p".into(),
            label: "unit tests".into(),
            argv: vec!["npm".into(), "run".into(), "test".into()],
            approved_at: "2026-10-11T00:00:00Z".into(),
        };
        assert_eq!(
            serde_json::to_value(&cmd).unwrap(),
            serde_json::json!({"id": "vc", "projectId": "p", "label": "unit tests",
                               "argv": ["npm", "run", "test"], "approvedAt": "2026-10-11T00:00:00Z"})
        );
        let list: VerificationListParams =
            serde_json::from_value(serde_json::json!({"projectId": "p"})).unwrap();
        assert_eq!(list.project_id, "p");
        let a: VerificationApproveParams = serde_json::from_value(
            serde_json::json!({"projectId": "p", "label": "t", "argv": ["make"]}),
        )
        .unwrap();
        assert_eq!(a.argv, vec!["make".to_string()]);
        let r: VerificationRevokeParams =
            serde_json::from_value(serde_json::json!({"commandId": "vc"})).unwrap();
        assert_eq!(r.command_id, "vc");
        assert_eq!(
            serde_json::to_value(VerificationRevokeResult { revoked: true }).unwrap(),
            serde_json::json!({"revoked": true})
        );
        // run: the key is optional and skipped when absent (A2 hash rule).
        let run: VerificationRunParams = serde_json::from_value(serde_json::json!({
            "taskId": "t", "commandId": "vc", "expectedSandboxName": "atlas-auth",
            "expectedWorkspaceMode": "direct_mount"
        }))
        .unwrap();
        assert_eq!(run.expected_workspace_mode, WorkspaceMode::DirectMount);
        assert_eq!(run.idempotency_key, None);
        assert_eq!(
            serde_json::to_value(&run).unwrap(),
            serde_json::json!({"taskId": "t", "commandId": "vc",
                "expectedSandboxName": "atlas-auth", "expectedWorkspaceMode": "direct_mount"})
        );
        assert!(
            serde_json::from_value::<VerificationRunParams>(serde_json::json!({
                "taskId": "t", "commandId": "vc", "expectedSandboxName": "a",
                "expectedWorkspaceMode": "bogus"
            }))
            .is_err()
        );
        let started = VerificationRunResult {
            run_id: "r".into(),
            started_sequence: 4,
            replayed: None,
        };
        assert_eq!(
            serde_json::to_value(&started).unwrap(),
            serde_json::json!({"runId": "r", "startedSequence": 4})
        );
        let _: VerificationResultParams =
            serde_json::from_value(serde_json::json!({"runId": "r"})).unwrap();
        // result: exitCode/finishedAt absent while running; outcome is an
        // OPEN string; output never interpreted.
        let running = VerificationResult {
            run_id: "r".into(),
            task_id: "t".into(),
            command_id: "vc".into(),
            label: "tests".into(),
            argv: vec!["make".into()],
            sandbox: "atlas-auth".into(),
            workspace_mode: "mountless".into(),
            outcome: "running".into(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            redactions: OutputRedaction::default(),
            elapsed_ms: None,
            started_at: "s".into(),
            finished_at: None,
            output_incomplete: None,
        };
        let v = serde_json::to_value(&running).unwrap();
        assert!(
            v.get("exitCode").is_none() && v.get("finishedAt").is_none(),
            "{v}"
        );
        assert!(v.get("elapsedMs").is_none(), "{v}");
        assert!(v.get("outputIncomplete").is_none(), "{v}");
        assert_eq!(
            v["redactions"],
            serde_json::json!({"bestEffort": true, "replacements": 0, "byKind": {}})
        );
        let done: VerificationResult = serde_json::from_value(serde_json::json!({
            "runId": "r", "taskId": "t", "commandId": "vc", "label": "tests", "argv": ["make"],
            "sandbox": "atlas-auth", "workspaceMode": "mountless", "outcome": "some_future_outcome",
            "exitCode": 7, "stdout": "o", "stderr": "e", "stdoutTruncated": true,
            "stderrTruncated": false,
            "redactions": {"bestEffort": true, "replacements": 1, "byKind": {"token": 1},
                           "outputWithheld": true},
            "elapsedMs": 12, "startedAt": "s", "finishedAt": "f", "outputIncomplete": true
        }))
        .unwrap();
        assert_eq!(done.outcome, "some_future_outcome");
        assert_eq!(done.output_incomplete, Some(true));
        assert_eq!(done.redactions.output_withheld, Some(true));
        // project.context
        let ctx = ProjectContextResult {
            repositories: vec![RepositoryContext {
                repo_path: "/r".into(),
                detected: vec![DetectedManifest {
                    manifest: "package.json".into(),
                    suggested_commands: vec![vec!["npm".into(), "run".into(), "test".into()]],
                    notes: vec!["n".into()],
                }],
                unreadable: vec!["go.mod".into()],
            }],
            approved: vec![cmd],
        };
        let v = serde_json::to_value(&ctx).unwrap();
        assert_eq!(v["repositories"][0]["repoPath"], "/r");
        assert_eq!(
            v["repositories"][0]["detected"][0]["suggestedCommands"],
            serde_json::json!([["npm", "run", "test"]])
        );
        assert_eq!(v["approved"][0]["id"], "vc");
        let _: ProjectContextParams =
            serde_json::from_value(serde_json::json!({"projectId": "p"})).unwrap();
    }

    /// A3b: `archivedAt` / `sandboxId` are additive — absent when unset (and
    /// from an older Core), camelCase when present.
    #[test]
    fn conversation_additive_fields_are_absent_tolerant() {
        let old: Conversation = serde_json::from_value(serde_json::json!({
            "id": "c", "projectId": "p", "title": "t", "agentId": "codex", "createdAt": "ts"
        }))
        .unwrap();
        assert_eq!(
            (old.archived_at.as_deref(), old.sandbox_id.as_deref()),
            (None, None)
        );
        let v = serde_json::to_value(&old).unwrap();
        assert!(
            v.get("archivedAt").is_none() && v.get("sandboxId").is_none(),
            "{v}"
        );
        let set = Conversation {
            archived_at: Some("2026-10-11T00:00:00Z".into()),
            sandbox_id: Some("atlas-auth".into()),
            ..old
        };
        let v = serde_json::to_value(&set).unwrap();
        assert_eq!(v["archivedAt"], "2026-10-11T00:00:00Z");
        assert_eq!(v["sandboxId"], "atlas-auth");
        // conversation.list: includeArchived optional, default false.
        let l: ConversationListParams = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!l.include_archived());
        assert!(!serde_json::to_string(&l)
            .unwrap()
            .contains("includeArchived"));
        let l: ConversationListParams =
            serde_json::from_value(serde_json::json!({"includeArchived": true})).unwrap();
        assert!(l.include_archived());
    }

    /// A3b: params and result shapes of the five conversation methods.
    #[test]
    fn conversation_lifecycle_wire_shapes() {
        let r: ConversationRenameParams =
            serde_json::from_value(serde_json::json!({"conversationId": "c", "title": "T"}))
                .unwrap();
        assert_eq!((r.conversation_id.as_str(), r.title.as_str()), ("c", "T"));
        assert!(serde_json::from_value::<ConversationRenameParams>(
            serde_json::json!({"conversationId": "c"})
        )
        .is_err());
        let i: ConversationIdParams =
            serde_json::from_value(serde_json::json!({"conversationId": "c"})).unwrap();
        assert_eq!(i.conversation_id, "c");
        let d: ConversationDeleteParams =
            serde_json::from_value(serde_json::json!({"conversationId": "c"})).unwrap();
        assert_eq!(d.confirm_token, None);
        let step2 = ConversationDeleteResult {
            confirmation: None,
            deleted: Some(true),
        };
        assert_eq!(
            serde_json::to_value(&step2).unwrap(),
            serde_json::json!({"deleted": true})
        );
        let e: ConversationExportParams =
            serde_json::from_value(serde_json::json!({"conversationId": "c"})).unwrap();
        assert_eq!((e.after_sequence, e.limit), (0, None));
        let mut by_kind = std::collections::BTreeMap::new();
        by_kind.insert("token".to_string(), 2u64);
        let res = ConversationExportResult {
            format: CONVERSATION_EXPORT_FORMAT.to_string(),
            exported_at: "ts".into(),
            conversation: serde_json::from_value(serde_json::json!({
                "id": "c", "projectId": "p", "title": "t", "agentId": "codex", "createdAt": "ts"
            }))
            .unwrap(),
            messages: vec![],
            truncated: false,
            next_sequence: 0,
            redaction: ExportRedaction {
                best_effort: true,
                replacements: 2,
                by_kind,
            },
        };
        let v = serde_json::to_value(&res).unwrap();
        assert_eq!(v["format"], "sandpane.conversation-export.v1");
        let mut keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "conversation",
                "exportedAt",
                "format",
                "messages",
                "nextSequence",
                "redaction",
                "truncated"
            ]
        );
        assert_eq!(
            v["redaction"],
            serde_json::json!({"bestEffort": true, "replacements": 2, "byKind": {"token": 2}})
        );
    }

    /// A4 §3.4 item 1: `mode` is optional on send (absent = "task", never
    /// serialized when absent, so A2 fingerprints are unchanged) and an OPEN
    /// string on `TaskSummary` (an unknown value decodes, never fails).
    #[test]
    fn send_mode_and_task_mode_are_optional_open_strings() {
        let old: ConversationSendParams =
            serde_json::from_value(serde_json::json!({"conversationId": "c", "content": "hi"}))
                .unwrap();
        assert_eq!(old.mode, None);
        assert!(!serde_json::to_string(&old).unwrap().contains("mode"));
        let discuss: ConversationSendParams = serde_json::from_value(
            serde_json::json!({"conversationId": "c", "content": "hi", "mode": "discuss"}),
        )
        .unwrap();
        assert_eq!(discuss.mode.as_deref(), Some("discuss"));
        assert_eq!(serde_json::to_value(&discuss).unwrap()["mode"], "discuss");
        // Any string parses: Core (not serde) refuses unknown values, with
        // the exact §3.4 message.
        let odd: ConversationSendParams = serde_json::from_value(
            serde_json::json!({"conversationId": "c", "content": "hi", "mode": "Task"}),
        )
        .unwrap();
        assert_eq!(odd.mode.as_deref(), Some("Task"));

        let t: TaskSummary =
            serde_json::from_str(r#"{"id":"t1","conversationId":"c1","status":"queued"}"#).unwrap();
        assert_eq!(t.mode, None);
        assert!(!serde_json::to_string(&t).unwrap().contains("mode"));
        let future: TaskSummary = serde_json::from_str(
            r#"{"id":"t1","conversationId":"c1","status":"queued","mode":"plan-later"}"#,
        )
        .unwrap();
        assert_eq!(future.mode.as_deref(), Some("plan-later"));
        assert_eq!(serde_json::to_value(&future).unwrap()["mode"], "plan-later");
    }

    /// A4 review C1/C2: the chat's chosen sandbox name is its OWN field
    /// (`chosenSandboxName`), never folded into `sandboxName` (the binding a
    /// task runs in, which shipped clients turn into isolation labels and
    /// stop/remove impact counts).
    #[test]
    fn chosen_sandbox_name_is_separate_from_sandbox_name_and_optional() {
        let t: TaskSummary =
            serde_json::from_str(r#"{"id":"t1","conversationId":"c1","status":"queued"}"#).unwrap();
        assert_eq!(t.chosen_sandbox_name, None);
        assert!(!serde_json::to_string(&t).unwrap().contains("hosenSandbox"));
        let chosen = TaskSummary {
            chosen_sandbox_name: Some("atlas-auth".into()),
            ..t
        };
        let v = serde_json::to_value(&chosen).unwrap();
        assert_eq!(v["chosenSandboxName"], "atlas-auth");
        assert!(v.get("sandboxName").is_none(), "{v}");
        let back: TaskSummary = serde_json::from_value(v).unwrap();
        assert_eq!(back.chosen_sandbox_name.as_deref(), Some("atlas-auth"));
        assert_eq!(back.sandbox_name, None);
    }

    /// A5 §3.5 item 2: the three ChangeSet/FileChange fields are optional
    /// and absent when unset (a pre-A5 ChangeSet still decodes).
    #[test]
    fn change_set_a5_fields_are_optional() {
        let old: ChangeSet = serde_json::from_str(
            r#"{"taskId":"t","baseCommit":"b","hostDirty":false,
                "changes":[{"path":"p","status":"modified"}]}"#,
        )
        .unwrap();
        assert_eq!(old.repo_path, None);
        assert_eq!(old.uninspected, None);
        assert_eq!(old.changes[0].old_path, None);
        let v = serde_json::to_value(&old).unwrap();
        assert!(
            v.get("repoPath").is_none() && v.get("uninspected").is_none(),
            "{v}"
        );
        assert!(v["changes"][0].get("oldPath").is_none(), "{v}");
        let new = ChangeSet {
            repo_path: Some("/r".into()),
            uninspected: Some(vec!["vendor/lib".into()]),
            changes: vec![FileChange {
                path: "new".into(),
                status: FileChangeStatus::Renamed,
                old_path: Some("old".into()),
                task_blob: None,
                task_mode: None,
            }],
            ..old
        };
        let v = serde_json::to_value(&new).unwrap();
        assert_eq!(v["repoPath"], "/r");
        assert_eq!(v["uninspected"][0], "vendor/lib");
        assert_eq!(v["changes"][0]["oldPath"], "old");
    }

    /// A5 §3.5 item 3: `git.diff` params and result wire shapes.
    #[test]
    fn git_diff_params_and_result_shapes() {
        let p: GitDiffParams = serde_json::from_str(r#"{"taskId":"t","path":"a b.txt"}"#).unwrap();
        assert_eq!(p.max_bytes, None);
        let p: GitDiffParams =
            serde_json::from_str(r#"{"taskId":"t","path":"p","maxBytes":0}"#).unwrap();
        assert_eq!(p.max_bytes, Some(0));
        assert!(serde_json::from_str::<GitDiffParams>(r#"{"taskId":"t"}"#).is_err());
        // A5 security I2: optional `status` disambiguates a path listed twice.
        assert_eq!(p.status, None);
        let p: GitDiffParams =
            serde_json::from_str(r#"{"taskId":"t","path":"p","status":"untracked"}"#).unwrap();
        assert_eq!(p.status, Some(FileChangeStatus::Untracked));
        assert!(serde_json::from_str::<GitDiffParams>(
            r#"{"taskId":"t","path":"p","status":"copied"}"#
        )
        .is_err());
        assert!(serde_json::to_value(&p).unwrap()["status"] == "untracked");
        let r = GitDiffResult {
            path: "p".into(),
            old_path: None,
            status: FileChangeStatus::Untracked,
            patch: String::new(),
            binary: true,
            truncated: false,
            lossy: false,
            base_blob: None,
            task_blob: None,
            task_mode: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"path":"p","status":"untracked","patch":"",
                               "binary":true,"truncated":false,"lossy":false})
        );
        let r = GitDiffResult {
            old_path: Some("o".into()),
            base_blob: Some("b".repeat(40)),
            status: FileChangeStatus::Renamed,
            ..r
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["oldPath"], "o");
        assert_eq!(v["baseBlob"], "b".repeat(40));
        assert_eq!(Method::parse("git.diff"), Some(Method::GitDiff));
    }

    /// A6 §3.6 items 3, 7, 9: every new field is additive — absent when
    /// unset, tolerated when missing (pre-A6 wire), round-trips when set.
    #[test]
    fn a6_git_apply_fields_are_additive() {
        // Pre-A6 frames still parse; nothing new is serialized when unset.
        let old: ChangeSet = serde_json::from_str(
            r#"{"taskId":"t","baseCommit":"b","hostDirty":false,
                "changes":[{"path":"p","status":"modified"}]}"#,
        )
        .unwrap();
        assert_eq!(
            (old.review_id.as_deref(), old.host_hooks_path.as_deref()),
            (None, None)
        );
        assert_eq!(old.changes[0].task_blob, None);
        assert_eq!(old.changes[0].task_mode, None);
        let v = serde_json::to_value(&old).unwrap();
        assert!(
            v.get("reviewId").is_none() && v.get("hostHooksPath").is_none(),
            "{v}"
        );
        assert!(
            v["changes"][0].get("taskBlob").is_none() && v["changes"][0].get("taskMode").is_none(),
            "{v}"
        );
        let new = ChangeSet {
            review_id: Some("r-1".into()),
            host_hooks_path: Some(".husky".into()),
            changes: vec![FileChange {
                path: "run.sh".into(),
                status: FileChangeStatus::Untracked,
                old_path: None,
                task_blob: Some("a".repeat(40)),
                task_mode: Some("100755".into()),
            }],
            ..old
        };
        let v = serde_json::to_value(&new).unwrap();
        assert_eq!(v["reviewId"], "r-1");
        assert_eq!(v["hostHooksPath"], ".husky");
        assert_eq!(v["changes"][0]["taskBlob"], "a".repeat(40));
        assert_eq!(v["changes"][0]["taskMode"], "100755");

        // git.apply params: the pre-A6 shape still parses (Core then refuses
        // it as malformed for A6); entries reuse the reviewed FileChange.
        let p: GitApplyParams = serde_json::from_str(&format!(
            r#"{{"taskId":"t","expectedBase":"{}"}}"#,
            "b".repeat(40)
        ))
        .unwrap();
        assert_eq!((p.review_id.as_deref(), p.entries.is_none()), (None, true));
        assert!(serde_json::to_value(&p).unwrap().get("entries").is_none());
        let p: GitApplyParams = serde_json::from_value(serde_json::json!({
            "taskId": "t", "expectedBase": "b".repeat(40), "reviewId": "r-1",
            "entries": [{"path": "n", "status": "renamed", "oldPath": "o",
                         "taskBlob": "c".repeat(40), "taskMode": "100644"}]
        }))
        .unwrap();
        assert_eq!(p.review_id.as_deref(), Some("r-1"));
        let e = &p.entries.as_ref().unwrap()[0];
        assert_eq!(
            (e.old_path.as_deref(), e.task_mode.as_deref()),
            (Some("o"), Some("100644"))
        );

        // ApplyResult: pre-A6 shape unchanged; new fields only when set.
        let r = ApplyResult {
            applied: false,
            abort_reason: Some("x".into()),
            conflicted_files: vec![],
            applied_files: None,
            mode_changes: None,
            snapshot_tree: None,
            partial: None,
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            serde_json::json!({"applied": false, "abortReason": "x", "conflictedFiles": []})
        );
        let old: ApplyResult = serde_json::from_str(r#"{"applied":true}"#).unwrap();
        assert_eq!((old.partial, old.snapshot_tree), (None, None));
        let r = ApplyResult {
            applied: true,
            abort_reason: None,
            applied_files: Some(vec!["run.sh".into()]),
            mode_changes: Some(vec![ModeChange {
                path: "run.sh".into(),
                from: "100644".into(),
                to: "100755".into(),
            }]),
            snapshot_tree: Some("d".repeat(40)),
            partial: Some(true),
            ..r
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["appliedFiles"][0], "run.sh");
        assert_eq!(
            v["modeChanges"][0],
            serde_json::json!({"path": "run.sh", "from": "100644", "to": "100755"})
        );
        assert_eq!(v["snapshotTree"], "d".repeat(40));
        assert_eq!(v["partial"], true);

        // git.diff: taskBlob/taskMode are additive.
        let d: GitDiffResult = serde_json::from_str(
            r#"{"path":"p","status":"modified","patch":"","binary":false,"truncated":false,"lossy":false}"#,
        )
        .unwrap();
        assert_eq!(
            (d.task_blob.as_deref(), d.task_mode.as_deref()),
            (None, None)
        );
        assert!(serde_json::to_value(&d).unwrap().get("taskBlob").is_none());
        let d = GitDiffResult {
            task_blob: Some("e".repeat(64)),
            task_mode: Some("100644".into()),
            ..d
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["taskBlob"], "e".repeat(64));
        assert_eq!(v["taskMode"], "100644");
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
