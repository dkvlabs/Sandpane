//! Sandpane Core protocol — versioned RPC envelope, method payloads, events, errors.
//!
//! These are **Sandpane-owned** types (docs/specs/02_ARCHITECTURE_AND_DATA.md §2, §4).
//! They are never to be confused with official Docker SBX, Codex, or Claude wire formats.
//! Wire format: newline-delimited JSON over a Unix domain socket / Windows named pipe.

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
/// with `VALIDATION_FAILED` — there is deliberately no free-form execution method.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Method {
    #[serde(rename = "system.probe")]
    SystemProbe,
    #[serde(rename = "project.create")]
    ProjectCreate,
    #[serde(rename = "project.list")]
    ProjectList,
    #[serde(rename = "sandbox.list")]
    SandboxList,
    #[serde(rename = "sandbox.create")]
    SandboxCreate,
    #[serde(rename = "conversation.create")]
    ConversationCreate,
    #[serde(rename = "conversation.send")]
    ConversationSend,
    #[serde(rename = "task.cancel")]
    TaskCancel,
    #[serde(rename = "task.subscribe")]
    TaskSubscribe,
    #[serde(rename = "git.review")]
    GitReview,
    #[serde(rename = "git.apply")]
    GitApply,
}

impl Method {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "system.probe" => Self::SystemProbe,
            "project.create" => Self::ProjectCreate,
            "project.list" => Self::ProjectList,
            "sandbox.list" => Self::SandboxList,
            "sandbox.create" => Self::SandboxCreate,
            "conversation.create" => Self::ConversationCreate,
            "conversation.send" => Self::ConversationSend,
            "task.cancel" => Self::TaskCancel,
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
            Self::SandboxList => "sandbox.list",
            Self::SandboxCreate => "sandbox.create",
            Self::ConversationCreate => "conversation.create",
            Self::ConversationSend => "conversation.send",
            Self::TaskCancel => "task.cancel",
            Self::TaskSubscribe => "task.subscribe",
            Self::GitReview => "git.review",
            Self::GitApply => "git.apply",
        }
    }
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSummary {
    pub name: String,
    /// SBX is the source of truth; this is the last probed state, never assumed.
    pub probed_state: Option<String>,
    pub bound_project_id: Option<String>,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSubscribeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Replay everything strictly after this per-task sequence number.
    #[serde(default)]
    pub after_sequence: i64,
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
