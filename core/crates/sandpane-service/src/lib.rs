//! Sandpane Core service library: connection handling and request dispatch.
//!
//! Transport: Unix domain socket, newline-delimited JSON frames
//! (docs/specs/02 §2). Single instance per OS user enforced by the socket
//! handshake (a live connect to an existing socket means another Core owns
//! this user session). No TCP listener. No free-form execution method —
//! [`sandpane_protocol::Method`] is the complete, allowlisted surface.
//!
//! Windows named pipes are a P1 transport deliverable; this scaffold serves
//! Unix sockets only and says so instead of pretending (see `main.rs`).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::params;
use sandpane_core::sbx::{SbxCommandBuilder, SbxLocator};
use sandpane_core::scheduler::{Admission, Scheduler};
use sandpane_core::task::TaskStateMachine;
use sandpane_core::validation::Validator;
use sandpane_core::{git as scoregit, Database, EventLog};
use sandpane_protocol::{
    AgentCapability, AgentEvent, ApplyResult, ChangeSet, Conversation, ConversationCreateParams,
    ConversationHistoryParams, ConversationHistoryResult, ConversationListParams,
    ConversationSendParams, CoreCapabilities, ErrorCode, FileChange, FileChangeStatus,
    GitApplyParams, MessageRecord, Method, Project, ProjectCreateParams, RpcRequest, RpcResponse,
    SandboxCreateSpec, SandboxSummary, SbxStatus, TaskEvent, TaskListParams, TaskStatus,
    TaskSubscribeParams, TaskSummary, WorkspaceMode, CORE_VERSION, PROTOCOL_VERSION,
};

/// Bounded frame size: refuse oversized input instead of buffering forever
/// (docs/specs/02 §2 "bounded responses").
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Rows returned by a list/history method when the caller asks for no limit.
pub const DEFAULT_LIST_LIMIT: u32 = 200;

/// Hard ceiling on rows from any single bounded read method. A larger request
/// is clamped, never honoured — an unbounded set is not a valid response
/// (docs/specs/02 §2).
pub const MAX_LIST_LIMIT: u32 = 500;

/// Total-bytes ceiling for the stored message content `conversation.history`
/// may put in one response. Deliberately half of [`MAX_FRAME_BYTES`]: the
/// headroom absorbs the envelope plus the one row that is ALWAYS allowed through
/// so paging cannot stall. That exception is safe because `conversation.send` is
/// the only writer of `messages` and caps content at 65 536 CHARACTERS
/// (`Validator::display_text(…, 64 * 1024)` counts chars, not bytes) — at most
/// ~256 KiB UTF-8, ~512 KiB once JSON-escaped. A future writer that stores larger
/// rows must bound its own row size, or this ceiling stops describing the frame
/// that leaves the socket.
pub const MAX_HISTORY_BYTES: usize = 2 * 1024 * 1024;

/// Maximum entries in a `task.subscribe` `afterSequences` map (bounded input).
pub const MAX_SUBSCRIBE_CURSORS: usize = 4096;

/// Response ceiling for one `task.subscribe` replay. The transport refuses an
/// inbound frame above [`MAX_FRAME_BYTES`] and every client reader refuses an
/// inbound frame above the same size, so a replay that would serialize past
/// this ceiling CANNOT be delivered — it used to be built anyway, producing a
/// frame the client rejects and disconnects over, with a retry that could never
/// converge. Core now measures it and answers a structured, actionable refusal
/// instead. A limit/truncation envelope on this method is the real fix and
/// needs its own additive protocol decision (docs/specs/02 §2).
pub const MAX_SUBSCRIBE_BYTES: usize = MAX_FRAME_BYTES - 64 * 1024;

/// Maximum length of a task id used as an `afterSequences` key. Core ids are
/// UUIDs (36 chars); the bound only stops an absurdly large map key.
pub const MAX_CURSOR_KEY_LEN: usize = 100;

/// Maximum length of an id that merely SCOPES a read (`projectId`,
/// `conversationId`). Core ids are UUIDs; this only refuses absurd input.
pub const MAX_SCOPING_ID_LEN: usize = 200;

pub struct ServerInner {
    pub db: Mutex<Database>,
    pub scheduler: Mutex<Scheduler>,
    pub sbx_locator: SbxLocator,
    pub instance_id: String,
    pub git: scoregit::GitRunner,
}

impl ServerInner {
    pub fn new(db: Database, sbx_locator: SbxLocator) -> Arc<Self> {
        // RESTART RECONCILIATION (specs/02 §1/§4, T09): any task row left in
        // an in-flight state belongs to a dead daemon instance. Every such
        // task becomes `interrupted` — durable event + row update — BEFORE
        // any client can observe it. Nothing is ever auto-resumed, and the
        // scheduler starts empty alongside it.
        reconcile_after_restart(&db);
        Arc::new(Self {
            db: Mutex::new(db),
            scheduler: Mutex::new(Scheduler::reconciliation_baseline()),
            sbx_locator,
            instance_id: uuid::Uuid::new_v4().to_string(),
            git: scoregit::GitRunner::default(),
        })
    }

    /// Poison-tolerant locking: one panicked handler must not brick the
    /// daemon for every other client (specs/02 §1 "Core outlives clients").
    pub fn lock_db(&self) -> MutexGuard<'_, Database> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn lock_scheduler(&self) -> MutexGuard<'_, Scheduler> {
        self.scheduler.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Task statuses that cannot survive the process that was driving them.
pub const RECONCILABLE_STATUSES: &[&str] = &[
    "created",
    "queued",
    "preparing",
    "running",
    "awaiting_input",
];

/// Marks every in-flight task `interrupted` with a durable event. Returns the
/// affected task ids (used by main.rs startup logging and tests).
pub fn reconcile_after_restart(db: &Database) -> Vec<String> {
    let mut out = Vec::new();
    let placeholders = RECONCILABLE_STATUSES
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let stale: Vec<(String, String)> = match db.conn().prepare(&format!(
        "SELECT id, status FROM tasks WHERE status IN ({placeholders}) ORDER BY created_at"
    )) {
        Ok(mut stmt) => {
            let rows = stmt.query_map(
                rusqlite::params_from_iter(RECONCILABLE_STATUSES.iter()),
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            );
            match rows {
                Ok(rows) => rows.filter_map(Result::ok).collect(),
                Err(e) => {
                    eprintln!("sandpane-service: reconciliation query failed: {e}");
                    return out;
                }
            }
        }
        Err(e) => {
            eprintln!("sandpane-service: reconciliation prepare failed: {e}");
            return out;
        }
    };
    for (task_id, status_str) in stale {
        let Ok(status) =
            serde_json::from_value::<TaskStatus>(serde_json::Value::String(status_str.clone()))
        else {
            eprintln!(
                "sandpane-service: unknown status {status_str:?} for task {task_id}; skipped"
            );
            continue;
        };
        let mut machine = TaskStateMachine::from_status(status);
        if machine.transition(TaskStatus::Interrupted).is_err() {
            eprintln!("sandpane-service: reconciliation refused for {task_id} ({status_str})");
            continue;
        }
        let now = now_rfc3339();
        let tx = match db.conn().unchecked_transaction() {
            Ok(tx) => tx,
            Err(e) => {
                eprintln!("sandpane-service: reconciliation tx begin failed: {e}");
                continue;
            }
        };
        let step = (|| -> Result<(), sandpane_core::DbError> {
            let log = EventLog::from_conn(&tx);
            log.append(
                &task_id,
                "status.changed",
                &serde_json::json!({ "to": TaskStatus::Interrupted, "reconciledAfterRestart": true }),
                &now,
            )?;
            tx.execute(
                "UPDATE tasks SET status='interrupted', updated_at=?2 WHERE id=?1",
                params![task_id, now],
            )?;
            Ok(())
        })();
        let result = step.and_then(|()| tx.commit().map_err(sandpane_core::DbError::from));
        match result {
            Ok(()) => out.push(task_id),
            Err(e) => eprintln!("sandpane-service: reconciliation of {task_id} failed: {e}"),
        }
    }
    if !out.is_empty() {
        eprintln!(
            "sandpane-service: reconciled {} stale task(s) to interrupted: {}",
            out.len(),
            out.join(", ")
        );
    }
    out
}

// ---------------------------------------------------------------------------
// Time: dependency-free RFC3339 UTC (civil-from-days algorithm).
// ---------------------------------------------------------------------------

pub fn now_rfc3339() -> String {
    rfc3339_from_unix(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    )
}

pub fn rfc3339_from_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Handle one NDJSON frame; returns the response frame. Never panics on bad
/// input — malformed frames get a correlated error where possible.
pub fn handle_line(inner: &ServerInner, line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return err_frame("", ErrorCode::ValidationFailed, "empty frame");
    }
    let req: RpcRequest = match serde_json::from_str(trimmed) {
        Ok(r) => r,
        Err(e) => {
            return err_frame(
                "",
                ErrorCode::ValidationFailed,
                format!("malformed frame: {e}"),
            )
        }
    };
    if req.v != PROTOCOL_VERSION {
        return err_frame(
            &req.id,
            ErrorCode::ValidationFailed,
            format!(
                "protocol version mismatch: client {} vs core {}",
                req.v, PROTOCOL_VERSION
            ),
        );
    }
    let Some(method) = Method::parse(&req.method) else {
        return err_frame(
            &req.id,
            ErrorCode::ValidationFailed,
            format!("unknown method {:?}", req.method),
        );
    };
    let resp = dispatch(inner, method, req.id, req.params);
    serde_json::to_string(&resp).unwrap()
}

fn err_frame(id: &str, code: ErrorCode, message: impl Into<String>) -> String {
    serde_json::to_string(&RpcResponse::err(id, code, message)).unwrap()
}

fn dispatch(
    inner: &ServerInner,
    method: Method,
    id: String,
    params: serde_json::Value,
) -> RpcResponse {
    let result =
        match method {
            Method::SystemProbe => system_probe(inner),
            Method::ProjectCreate => {
                parse_params::<ProjectCreateParams>(params).and_then(|p| project_create(inner, p))
            }
            Method::ProjectList => project_list(inner),
            Method::SandboxList => sandbox_list(inner),
            Method::SandboxCreate => {
                parse_params::<SandboxCreateSpec>(params).and_then(|p| sandbox_create(inner, p))
            }
            Method::ConversationCreate => parse_params::<ConversationCreateParams>(params)
                .and_then(|p| conversation_create(inner, p)),
            Method::ConversationSend => parse_params::<ConversationSendParams>(params)
                .and_then(|p| conversation_send(inner, p)),
            Method::ConversationList => parse_params::<ConversationListParams>(params)
                .and_then(|p| conversation_list(inner, p)),
            Method::ConversationHistory => parse_params::<ConversationHistoryParams>(params)
                .and_then(|p| conversation_history(inner, p)),
            Method::TaskCancel => match string_param(&params, "taskId") {
                Some(t) => task_cancel(inner, t),
                None => Err((ErrorCode::ValidationFailed, "taskId required".into())),
            },
            Method::TaskList => {
                parse_params::<TaskListParams>(params).and_then(|p| task_list(inner, p))
            }
            Method::TaskSubscribe => {
                parse_params::<TaskSubscribeParams>(params).and_then(|p| task_subscribe(inner, p))
            }
            Method::GitReview => match string_param(&params, "taskId") {
                Some(t) => git_review(inner, t),
                None => Err((ErrorCode::ValidationFailed, "taskId required".into())),
            },
            Method::GitApply => {
                parse_params::<GitApplyParams>(params).and_then(|p| git_apply(inner, p))
            }
        };
    match result {
        Ok(value) => RpcResponse::ok(id, value),
        Err((code, message)) => RpcResponse::err(id, code, message),
    }
}

type SvcError = (ErrorCode, String);

fn parse_params<T: serde::de::DeserializeOwned>(params: serde_json::Value) -> Result<T, SvcError> {
    serde_json::from_value(params)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("invalid params: {e}")))
}

fn string_param(params: &serde_json::Value, key: &str) -> Option<String> {
    params.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

fn internal<E: std::fmt::Display>(e: E) -> SvcError {
    (ErrorCode::Internal, e.to_string())
}

/// Rows to return for a bounded read: absent → [`DEFAULT_LIST_LIMIT`], out of
/// range → clamped into `1..=MAX_LIST_LIMIT`. `limit` is a `u32` on the wire, so
/// a negative value is refused at parse time (`VALIDATION_FAILED`) instead of
/// being silently reinterpreted here.
fn clamp_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT) as usize
}

/// The bare snake_case string `tasks.status` stores, derived from serde so a
/// query value can never drift from the wire names `schemas/` and the drift
/// gate compare.
fn task_status_stored(status: TaskStatus) -> Result<String, SvcError> {
    match serde_json::to_value(status) {
        Ok(serde_json::Value::String(s)) => Ok(s),
        Ok(other) => Err((
            ErrorCode::Internal,
            format!("task status serialized to {other:?}, expected a bare name"),
        )),
        Err(e) => Err(internal(e)),
    }
}

/// Read a stored status back into the enum. A value Core does not define is an
/// INTERNAL error naming the task — it is never normalized into a status that
/// happens to exist (specs/02 §4: transitions and states are Core's own).
fn task_status_from_stored(stored: &str, task_id: &str) -> Result<TaskStatus, SvcError> {
    serde_json::from_value::<TaskStatus>(serde_json::Value::String(stored.to_string())).map_err(
        |_| {
            (
                ErrorCode::Internal,
                format!("task {task_id} stores status {stored:?}, which is not a Core task status"),
            )
        },
    )
}

/// Decode a stored `sandbox_bindings.workspace_mode`.
///
/// Two stored shapes are recognised, both of them the row's OWN recorded value:
/// the bare snake_case name written today, and the JSON-quoted form that
/// `sandbox.create` wrote before review 0004 #4 was fixed (no migration exists
/// for those rows, so a pre-fix database would otherwise report an undisclosed
/// absence for a live-writable `direct_mount` mount).
///
/// Anything else yields `None` — the field stays ABSENT. Core never turns a
/// value it cannot read into a mode, because `direct_mount` is a live-writable
/// claim (specs/02 §7). The unreadable row is surfaced on stderr.
fn workspace_mode_from_stored(stored: &str) -> Option<WorkspaceMode> {
    if let Ok(mode) =
        serde_json::from_value::<WorkspaceMode>(serde_json::Value::String(stored.to_string()))
    {
        return Some(mode);
    }
    if let Ok(unquoted) = serde_json::from_str::<String>(stored) {
        if let Ok(mode) =
            serde_json::from_value::<WorkspaceMode>(serde_json::Value::String(unquoted))
        {
            return Some(mode);
        }
    }
    eprintln!("sandpane-service: stored workspace_mode {stored:?} is not a Core mode");
    None
}

/// ids that scope a read must at least be ids: non-empty, no control characters,
/// bounded length — the same validator every other stored value passes through,
/// so a typo'd empty `projectId` is a structured refusal instead of a silently
/// empty list that looks like "no tasks".
fn validate_scoping_id(kind: &str, value: &str) -> Result<(), SvcError> {
    Validator::display_text(value, MAX_SCOPING_ID_LEN)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("{kind}: {e}")))?;
    Ok(())
}

/// Optional project scope, validated when present. `None` means unscoped;
/// `Some("")` is a client bug and is refused (see [`validate_scoping_id`]).
fn optional_scoping_id(kind: &str, value: &Option<String>) -> Result<(), SvcError> {
    match value {
        Some(v) => validate_scoping_id(kind, v),
        None => Ok(()),
    }
}

/// Validate the optional per-task cursor map (bounded input): a sane number of
/// entries and non-empty, id-sized keys. Values are normalised by the caller.
fn validate_cursor_map(map: &HashMap<String, i64>) -> Result<(), SvcError> {
    if map.len() > MAX_SUBSCRIBE_CURSORS {
        return Err((
            ErrorCode::ValidationFailed,
            format!(
                "afterSequences has {} entries, the bound is {MAX_SUBSCRIBE_CURSORS}",
                map.len()
            ),
        ));
    }
    for key in map.keys() {
        if key.is_empty() || key.len() > MAX_CURSOR_KEY_LEN {
            return Err((
                ErrorCode::ValidationFailed,
                format!("afterSequences key must be 1..={MAX_CURSOR_KEY_LEN} bytes"),
            ));
        }
    }
    Ok(())
}

fn system_probe(inner: &ServerInner) -> Result<serde_json::Value, SvcError> {
    let sbx = match inner.sbx_locator.locate() {
        Ok(path) => SbxStatus {
            installed: true,
            binary_path: Some(path.display().to_string()),
            version: None, // probed lazily by sandbox operations
            daemon_running: None,
        },
        Err(_) => SbxStatus {
            installed: false,
            binary_path: None,
            version: None,
            daemon_running: None,
        },
    };
    let caps = CoreCapabilities {
        protocol_version: PROTOCOL_VERSION,
        core_version: CORE_VERSION.to_string(),
        instance_id: inner.instance_id.clone(),
        sbx: Some(sbx),
        agents: vec![AgentCapability {
            id: "codex".into(),
            // HONEST scaffold state: the in-SBX Codex feasibility gate (P0)
            // has not passed, so nothing is advertised as verified.
            verified: false,
            supports_streaming: false,
            supports_cancel: false,
            supports_resume: false,
        }],
        platform: std::env::consts::OS.to_string(),
        // Feature discovery: ONE derivation — `Method::wire_names()` is built
        // from `Method::ALL` over the same enum `dispatch` matches exhaustively
        // over, so an advertised method always really exists and a handled
        // method is always advertised. Never a hand-written list.
        methods: Method::wire_names()
            .into_iter()
            .map(str::to_string)
            .collect(),
    };
    serde_json::to_value(caps).map_err(internal)
}

fn project_create(
    inner: &ServerInner,
    p: ProjectCreateParams,
) -> Result<serde_json::Value, SvcError> {
    Validator::display_text(&p.name, 120)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("project name: {e}")))?;
    for repo in &p.repositories {
        if !Path::new(repo).is_absolute() {
            return Err((
                ErrorCode::ValidationFailed,
                format!("repository path must be absolute: {repo}"),
            ));
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    let db = inner.lock_db();
    // One transaction: project + repository rows are all-or-nothing.
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    tx.execute(
        "INSERT INTO projects (id, name, description, created_at) VALUES (?1,?2,?3,?4)",
        params![id, p.name, "", now],
    )
    .map_err(internal)?;
    for repo in &p.repositories {
        tx.execute(
            "INSERT INTO repositories (id, project_id, canonical_path) VALUES (?1,?2,?3)",
            params![uuid::Uuid::new_v4().to_string(), id, repo],
        )
        .map_err(internal)?;
    }
    tx.commit().map_err(internal)?;
    let project = Project {
        id,
        name: p.name,
        description: String::new(),
        created_at: now,
        repositories: p.repositories,
    };
    serde_json::to_value(project).map_err(internal)
}

fn project_list(inner: &ServerInner) -> Result<serde_json::Value, SvcError> {
    let db = inner.lock_db();
    // One extra pass over `repositories` grouped in Rust, rather than a
    // correlated subquery per project row: the table holds a handful of paths
    // per project (specs/02 §3) and this keeps the read to two prepared
    // statements. It is a full scan of that small table — no index on
    // repositories.project_id exists in schema v1.
    let repos = project_repository_paths(&db)?;
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, name, description, created_at FROM projects
             WHERE archived_at IS NULL ORDER BY created_at",
        )
        .map_err(internal)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(internal)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, description, created_at) = row.map_err(internal)?;
        out.push(Project {
            repositories: repos.get(&id).cloned().unwrap_or_default(),
            id,
            name,
            description,
            created_at,
        });
    }
    serde_json::to_value(out).map_err(internal)
}

/// `repositories.canonical_path` grouped by project id, in insertion order
/// (`rowid`), which is the order the user registered them in.
fn project_repository_paths(db: &Database) -> Result<HashMap<String, Vec<String>>, SvcError> {
    let mut stmt = db
        .conn()
        .prepare("SELECT project_id, canonical_path FROM repositories ORDER BY rowid ASC")
        .map_err(internal)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(internal)?;
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (project_id, path) = row.map_err(internal)?;
        out.entry(project_id).or_default().push(path);
    }
    Ok(out)
}

fn sandbox_list(inner: &ServerInner) -> Result<serde_json::Value, SvcError> {
    let program = inner.sbx_locator.locate().map_err(|_| {
        (
            ErrorCode::NotInstalled,
            "sbx executable not found".to_string(),
        )
    })?;
    let cmd = SbxCommandBuilder::list(&program, true);
    let out = std::process::Command::new(&cmd.program)
        .args(&cmd.args)
        .output()
        .map_err(|e| (ErrorCode::Internal, format!("sbx exec failed: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // A stopped daemon must surface as DAEMON_DOWN, not a generic failure.
        let code = if stderr.contains("daemon") || stderr.contains("connect") {
            ErrorCode::DaemonDown
        } else {
            ErrorCode::Internal
        };
        return Err((
            code,
            format!("sbx exited {}: {}", out.status, stderr.trim()),
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let entries = sandpane_core::sbx::parse_list_json(&stdout)
        .map_err(|e| (ErrorCode::ValidationFailed, e.to_string()))?;
    // SBX stays the source of truth for WHICH sandboxes exist; Core only joins
    // out the workspace mode it recorded itself (specs/02 §7 — `direct_mount`
    // means live-writable and UIs must label it, so the value has to be real).
    let db = inner.lock_db();
    let modes = binding_workspace_modes(&db)?;
    let summaries: Vec<SandboxSummary> = entries
        .into_iter()
        .map(|e| SandboxSummary {
            name: e.name.clone(),
            probed_state: Some(e.state),
            bound_project_id: None,
            workspace_mode: modes
                .get(&e.name)
                .and_then(|m| workspace_mode_from_stored(m)),
        })
        .collect();
    serde_json::to_value(summaries).map_err(internal)
}

/// Newest recorded `workspace_mode` per sandbox name. Ordering is the recorded
/// `created_at` with insertion order (`rowid`) as tie-break, so the value
/// reported is the binding that is currently in force rather than an arbitrary
/// one. A name Core has no row for is absent from this map, so the field is
/// omitted on the wire.
fn binding_workspace_modes(db: &Database) -> Result<HashMap<String, String>, SvcError> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT sandbox_name, workspace_mode FROM sandbox_bindings
             ORDER BY created_at DESC, rowid DESC",
        )
        .map_err(internal)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(internal)?;
    let mut out: HashMap<String, String> = HashMap::new();
    for row in rows {
        let (name, mode) = row.map_err(internal)?;
        // First seen per name = newest (DESC order); later, older rows lose.
        out.entry(name).or_insert(mode);
    }
    Ok(out)
}

fn sandbox_create(
    inner: &ServerInner,
    spec: SandboxCreateSpec,
) -> Result<serde_json::Value, SvcError> {
    Validator::sandbox_name(&spec.name)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("sandbox name: {e}")))?;
    // MOUNT CONTAINMENT (specs/06 §3 "overly broad mounts", §4 canonicalize +
    // validate before use): a writable workspace path must resolve (symlinks
    // included) to a repository REGISTERED with this project — never an
    // arbitrary host path. Mountless mode carries no path by definition.
    let mount: Option<PathBuf> = if matches!(spec.workspace_mode, WorkspaceMode::Mountless) {
        if spec.repo_path.is_some() {
            return Err((
                ErrorCode::ValidationFailed,
                "mountless workspace takes no repository path".into(),
            ));
        }
        None
    } else {
        let Some(raw) = &spec.repo_path else {
            return Err((
                ErrorCode::ValidationFailed,
                format!(
                    "{:?} workspace requires a registered repoPath",
                    spec.workspace_mode
                ),
            ));
        };
        let candidate = std::fs::canonicalize(raw).map_err(|e| {
            (
                ErrorCode::ValidationFailed,
                format!("repoPath not usable: {e}"),
            )
        })?;
        let registered: Vec<PathBuf> = {
            let db = inner.lock_db();
            let mut stmt = db
                .conn()
                .prepare("SELECT canonical_path FROM repositories WHERE project_id = ?1")
                .map_err(internal)?;
            let rows = stmt
                .query_map(params![spec.project_id], |r| r.get::<_, String>(0))
                .map_err(internal)?;
            let paths: Vec<PathBuf> = rows
                .filter_map(|row| row.ok())
                .filter_map(|p| std::fs::canonicalize(&p).ok())
                .collect();
            paths
        };
        if registered.is_empty() {
            return Err((
                ErrorCode::ValidationFailed,
                "project has no registered repositories to mount".into(),
            ));
        }
        if !registered.iter().any(|root| candidate.starts_with(root)) {
            return Err((
                ErrorCode::PermissionDenied,
                "repoPath is not a repository registered with this project".into(),
            ));
        }
        Some(candidate)
    };
    {
        let db = inner.lock_db();
        let exists: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE id = ?1",
                params![spec.project_id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if exists == 0 {
            return Err((ErrorCode::NotFound, "project not found".into()));
        }
    }
    let program = inner.sbx_locator.locate().map_err(|_| {
        (
            ErrorCode::NotInstalled,
            "sbx executable not found".to_string(),
        )
    })?;
    let cmd = SbxCommandBuilder::create(&program, &spec.name, mount.as_deref())
        .map_err(|e| (ErrorCode::ValidationFailed, e.to_string()))?;
    let out = std::process::Command::new(&cmd.program)
        .args(&cmd.args)
        .output()
        .map_err(|e| (ErrorCode::Internal, format!("sbx exec failed: {e}")))?;
    if !out.status.success() {
        return Err((
            ErrorCode::Internal,
            format!(
                "sbx exited {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        ));
    }
    // RE-QUERY after mutation: exit 0 never means desired state (specs/02 §5).
    let probed_state = probe_sandbox_state(&program, &spec.name);
    {
        let db = inner.lock_db();
        // Bare wire name (snake_case, unquoted) — matches tasks.status storage
        // so P3/P5 can query live-writable workspaces by mode.
        let mode_str = workspace_mode_wire(&spec.workspace_mode).to_string();
        db.conn()
            .execute(
                "INSERT INTO sandbox_bindings (id, project_id, sandbox_name, workspace_mode, created_at)
                 VALUES (?1,?2,?3,?4,?5)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    spec.project_id,
                    spec.name,
                    mode_str,
                    now_rfc3339()
                ],
            )
            .map_err(internal)?;
    }
    let summary = SandboxSummary {
        name: spec.name,
        probed_state,
        bound_project_id: Some(spec.project_id),
        // The mode Core just recorded for this binding — the caller asked for
        // it explicitly, so it is a fact, not a guess (specs/02 §7:
        // direct_mount is live-writable).
        workspace_mode: Some(spec.workspace_mode),
    };
    serde_json::to_value(summary).map_err(internal)
}

/// Bare snake_case wire name for a workspace mode (no JSON quotes).
fn workspace_mode_wire(mode: &WorkspaceMode) -> &'static str {
    match mode {
        WorkspaceMode::DirectMount => "direct_mount",
        WorkspaceMode::SbxClone => "sbx_clone",
        WorkspaceMode::HostWorktree => "host_worktree",
        WorkspaceMode::Mountless => "mountless",
    }
}

fn probe_sandbox_state(program: &Path, name: &str) -> Option<String> {
    let list_cmd = SbxCommandBuilder::list(program, true);
    let out = std::process::Command::new(&list_cmd.program)
        .args(&list_cmd.args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let entries =
        sandpane_core::sbx::parse_list_json(&String::from_utf8_lossy(&out.stdout)).ok()?;
    entries
        .into_iter()
        .find(|e| e.name == name)
        .map(|e| e.state)
}

fn conversation_create(
    inner: &ServerInner,
    p: ConversationCreateParams,
) -> Result<serde_json::Value, SvcError> {
    Validator::display_text(&p.agent_id, 64)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("agent id: {e}")))?;
    if let Some(sb) = &p.sandbox_id {
        Validator::sandbox_name(sb)
            .map_err(|e| (ErrorCode::ValidationFailed, format!("sandbox id: {e}")))?;
    }
    let title = if p.title.trim().is_empty() {
        "Untitled conversation".to_string()
    } else {
        Validator::display_text(&p.title, 200)
            .map_err(|e| (ErrorCode::ValidationFailed, format!("title: {e}")))?
            .to_string()
    };
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    {
        let db = inner.lock_db();
        let exists: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE id = ?1",
                params![p.project_id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if exists == 0 {
            return Err((ErrorCode::NotFound, "project not found".into()));
        }
        db.conn()
            .execute(
                "INSERT INTO conversations (id, project_id, title, agent_id, created_at)
                 VALUES (?1,?2,?3,?4,?5)",
                params![id, p.project_id, title, p.agent_id, now],
            )
            .map_err(internal)?;
    }
    let conv = Conversation {
        id,
        project_id: p.project_id,
        title,
        agent_id: p.agent_id,
        created_at: now,
    };
    serde_json::to_value(conv).map_err(internal)
}

fn conversation_send(
    inner: &ServerInner,
    p: ConversationSendParams,
) -> Result<serde_json::Value, SvcError> {
    Validator::display_text(&p.content, 64 * 1024)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("content: {e}")))?;
    let (project_id, agent_id) = {
        let db = inner.lock_db();
        db.conn()
            .query_row(
                "SELECT project_id, agent_id FROM conversations
                 WHERE id = ?1 AND archived_at IS NULL",
                params![p.conversation_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .map_err(|_| (ErrorCode::NotFound, "conversation not found".to_string()))?
    };

    let task_id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    let mut machine = TaskStateMachine::new();

    // Durable events BEFORE any subscriber could be notified (specs/02 §4),
    // and atomically: message + task row + events commit or roll back as one
    // unit so the append-only log can never disagree with tasks.status.
    {
        let db = inner.lock_db();
        // created -> queued is decided up front (pure logic) so the whole
        // write unit is one transaction.
        let to = machine
            .transition(TaskStatus::Queued)
            .map_err(|e| (ErrorCode::Internal, e.to_string()))?;
        let tx = db.conn().unchecked_transaction().map_err(internal)?;
        {
            let log = EventLog::from_conn(&tx);
            tx.execute(
                "INSERT INTO messages (id, conversation_id, role, content, sequence)
                 VALUES (?1,?2,'user',?3,
                         COALESCE((SELECT MAX(sequence) FROM messages WHERE conversation_id = ?2),0)+1)",
                params![uuid::Uuid::new_v4().to_string(), p.conversation_id, p.content],
            )
            .map_err(internal)?;
            tx.execute(
                "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at)
                 VALUES (?1,?2,'created',?3,?3)",
                params![task_id, p.conversation_id, now],
            )
            .map_err(internal)?;
            log.append(
                &task_id,
                "task.created",
                &serde_json::json!({ "conversationId": p.conversation_id }),
                &now,
            )
            .map_err(internal)?;
            let msg = AgentEvent::MessageDelta {
                text: p.content.clone(),
            };
            log.append(
                &task_id,
                "message.user",
                &serde_json::to_value(msg).map_err(internal)?,
                &now,
            )
            .map_err(internal)?;
            log.append(
                &task_id,
                "status.changed",
                &serde_json::json!({ "to": to }),
                &now,
            )
            .map_err(internal)?;
            tx.execute(
                "UPDATE tasks SET status='queued', updated_at=?2 WHERE id=?1",
                params![task_id, now],
            )
            .map_err(internal)?;
        }
        tx.commit().map_err(internal)?;
    }

    // Admission is policy-only in the scaffold: no verified agent adapter
    // exists yet (P0 Codex gate), so the task stays queued and says so.
    let admission = {
        let sched = inner.lock_scheduler();
        sched.admit(&task_id, &project_id, None, WorkspaceMode::Mountless)
    };
    {
        let db = inner.lock_db();
        let log = EventLog::new(&db);
        let now2 = now_rfc3339();
        match admission {
            Admission::Admitted => {
                // The honest scaffold event: adapter unavailable, task queued.
                let ev = AgentEvent::Error {
                    code: ErrorCode::ProviderAuthRequired,
                    message: format!(
                        "no verified adapter for agent '{agent_id}' in this build; \
                         the in-SBX feasibility gate (P0) has not passed — task stays queued"
                    ),
                };
                log.append(
                    &task_id,
                    "adapter.unavailable",
                    &serde_json::to_value(ev).map_err(internal)?,
                    &now2,
                )
                .map_err(internal)?;
            }
            other => {
                log.append(
                    &task_id,
                    "scheduler.deferred",
                    &serde_json::json!({ "reason": format!("{other:?}") }),
                    &now2,
                )
                .map_err(internal)?;
            }
        }
    }

    let summary = TaskSummary {
        id: task_id,
        conversation_id: p.conversation_id,
        status: TaskStatus::Queued,
        sandbox_name: None,
        task_branch: None,
        base_commit: None,
    };
    serde_json::to_value(summary).map_err(internal)
}

fn task_cancel(inner: &ServerInner, task_id: String) -> Result<serde_json::Value, SvcError> {
    let now = now_rfc3339();
    let db = inner.lock_db();
    let current: String = db
        .conn()
        .query_row(
            "SELECT status FROM tasks WHERE id = ?1",
            params![task_id],
            |r| r.get(0),
        )
        .map_err(|_| (ErrorCode::NotFound, "task not found".to_string()))?;
    let status: TaskStatus = task_status_from_stored(&current, &task_id)?;
    let mut machine = TaskStateMachine::from_status(status);
    machine
        .transition(TaskStatus::Cancelled)
        .map_err(|e| (ErrorCode::Conflict, e.to_string()))?;
    // Event + row update commit atomically (see conversation_send).
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    {
        let log = EventLog::from_conn(&tx);
        log.append(
            &task_id,
            "status.changed",
            &serde_json::json!({ "to": TaskStatus::Cancelled }),
            &now,
        )
        .map_err(internal)?;
        tx.execute(
            "UPDATE tasks SET status='cancelled', updated_at=?2 WHERE id=?1",
            params![task_id, now],
        )
        .map_err(internal)?;
    }
    tx.commit().map_err(internal)?;
    // NOTE (deferred to P2, recorded in the changelog): releasing scheduler
    // writer locks on cancel needs the workspace-key column that task
    // provisioning (P2) introduces; the scaffold scheduler takes no locks,
    // so there is nothing to release yet.
    Ok(serde_json::json!({ "requested": true }))
}

fn task_subscribe(
    inner: &ServerInner,
    p: TaskSubscribeParams,
) -> Result<serde_json::Value, SvcError> {
    if let Some(map) = &p.after_sequences {
        validate_cursor_map(map)?;
    }
    let db = inner.lock_db();
    let log = EventLog::new(&db);
    // (task, cursor) pairs: a single `taskId` request keeps the legacy scalar
    // cursor (the map is deliberately ignored there, so a client sending both
    // changes nothing — see `TaskSubscribeParams`). Otherwise each task replays
    // from its OWN cursor; sequences are per task and start at 1, so one shared
    // scalar skips the unseen events of every task behind it (the recorded v1
    // gap). A task missing from a supplied map replays from 0 = full history;
    // with no map at all the legacy shared scalar applies unchanged.
    let targets: Vec<(String, i64)> = match &p.task_id {
        Some(task_id) => vec![(task_id.clone(), p.after_sequence)],
        None => query_task_ids(&db, p.project_id.as_deref())?
            .into_iter()
            .map(|tid| {
                let cursor = match &p.after_sequences {
                    Some(map) => map.get(&tid).copied().unwrap_or(0).max(0),
                    None => p.after_sequence,
                };
                (tid, cursor)
            })
            .collect(),
    };

    // Bounded response (specs/02 §2). The array shape of `task.subscribe` cannot
    // disclose truncation, and both ends of the transport refuse a frame above
    // `MAX_FRAME_BYTES`, so an over-ceiling replay used to be built anyway: the
    // client dropped the connection over an undeliverable frame and its retry
    // could never converge. Core now stops gathering and refuses structurally,
    // naming what the caller can do. A limit/truncation envelope for this method
    // is a separate additive protocol decision.
    let mut events: Vec<TaskEvent> = Vec::new();
    let mut replay_bytes = 0usize;
    let mut replayed_tasks = 0usize;
    for (task_id, cursor) in targets {
        let chunk = log.replay_task(&task_id, cursor).map_err(internal)?;
        if !chunk.is_empty() {
            replayed_tasks += 1;
            replay_bytes += replay_frame_bytes(&chunk);
            events.extend(chunk);
        }
        if replay_bytes > MAX_SUBSCRIBE_BYTES {
            return Err((
                ErrorCode::ValidationFailed,
                format!(
                    "replay of {replayed_tasks} task(s) passed the {MAX_SUBSCRIBE_BYTES}-byte \
                     ceiling this frame shape can carry ({replay_bytes} bytes so far); narrow \
                     the request (single taskId, a higher afterSequence, or per-task \
                     afterSequences) — task.subscribe has no truncation envelope yet \
                     (docs/specs/02 §2)"
                ),
            ));
        }
    }
    serde_json::to_value(events).map_err(internal)
}

/// Serialized size of one replay chunk — the same JSON the frame carries, plus
/// the array separator. A payload that cannot serialize counts as over the
/// ceiling rather than as zero bytes (fail closed, never silently shrink).
fn replay_frame_bytes(events: &[TaskEvent]) -> usize {
    events
        .iter()
        .map(|e| {
            serde_json::to_string(e)
                .map(|s| s.len() + 1)
                .unwrap_or(MAX_SUBSCRIBE_BYTES + 1)
        })
        .sum()
}

/// `task.list` — read-only discovery of Core task state (docs/compatibility.md
/// v1 gap 1). Tasks are reached through their conversation for project
/// scoping, exactly as `task.subscribe` scopes a project-wide replay.
fn task_list(inner: &ServerInner, p: TaskListParams) -> Result<serde_json::Value, SvcError> {
    let limit = clamp_limit(p.limit);
    optional_scoping_id("projectId", &p.project_id)?;
    // Filter values are Core's OWN stored status names; an unknown status is
    // rejected by the params type before it ever reaches this query.
    //
    // Bounded by construction: `TaskStatus` is a closed 12-state lifecycle and
    // duplicates mean nothing in an IN-list, so collapsing them caps the bound
    // placeholder count at 12 + 2 no matter how many entries the caller sent
    // (SQLite's variable limit can then never turn a big request into an
    // `INTERNAL` from a failed `prepare`).
    let mut statuses: Vec<String> = Vec::new();
    for status in &p.statuses {
        let stored = task_status_stored(*status)?;
        if !statuses.contains(&stored) {
            statuses.push(stored);
        }
    }

    // Static SQL; the only thing interpolated is the COUNT of `?n`
    // placeholders (same reviewed pattern as `reconcile_after_restart`) — no
    // caller value is ever formatted into the statement.
    let mut sql = String::from(
        "SELECT t.id, t.conversation_id, t.status, t.created_at, t.task_branch,
                t.base_commit, sb.sandbox_name
         FROM tasks t
         JOIN conversations c ON c.id = t.conversation_id
         LEFT JOIN sandbox_bindings sb ON sb.id = t.sandbox_binding_id
         WHERE (?1 IS NULL OR c.project_id = ?1)",
    );
    if !statuses.is_empty() {
        let placeholders = (2..=(statuses.len() + 1))
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(" AND t.status IN ({placeholders})"));
    }
    let limit_idx = statuses.len() + 2;
    sql.push_str(&format!(
        " ORDER BY t.created_at ASC, t.id ASC LIMIT ?{limit_idx}"
    ));
    let limit_i64 = limit as i64;

    let db = inner.lock_db();
    let mut stmt = db.conn().prepare(&sql).map_err(internal)?;
    // Every caller value is BOUND (project id, status names, limit) — never
    // interpolated into the statement text.
    let mut args: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(statuses.len() + 2);
    args.push(&p.project_id);
    for status in &statuses {
        args.push(status);
    }
    args.push(&limit_i64);
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(internal)?;
    let mut out: Vec<TaskSummary> = Vec::new();
    for row in rows {
        let (id, conversation_id, stored_status, task_branch, base_commit, sandbox_name) =
            row.map_err(internal)?;
        out.push(TaskSummary {
            sandbox_name,
            task_branch,
            base_commit,
            id: id.clone(),
            conversation_id,
            status: task_status_from_stored(&stored_status, &id)?,
        });
    }
    serde_json::to_value(out).map_err(internal)
}

/// `conversation.list` — chat enumeration, previously impossible (v1 gap 1).
fn conversation_list(
    inner: &ServerInner,
    p: ConversationListParams,
) -> Result<serde_json::Value, SvcError> {
    let limit = clamp_limit(p.limit);
    optional_scoping_id("projectId", &p.project_id)?;
    let limit_i64 = limit as i64;
    let db = inner.lock_db();
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, project_id, title, agent_id, created_at FROM conversations
             WHERE archived_at IS NULL AND (?1 IS NULL OR project_id = ?1)
             ORDER BY created_at ASC, id ASC LIMIT ?2",
        )
        .map_err(internal)?;
    let rows = stmt
        .query_map(params![p.project_id, limit_i64], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: r.get(2)?,
                agent_id: r.get(3)?,
                created_at: r.get(4)?,
            })
        })
        .map_err(internal)?;
    let out = rows.collect::<Result<Vec<_>, _>>().map_err(internal)?;
    serde_json::to_value(out).map_err(internal)
}

/// `conversation.history` — bounded transcript read with disclosure of BOTH
/// bounds (specs/02 §2 "bounded responses … with truncation disclosure").
fn conversation_history(
    inner: &ServerInner,
    p: ConversationHistoryParams,
) -> Result<serde_json::Value, SvcError> {
    let limit = clamp_limit(p.limit);
    validate_scoping_id("conversationId", &p.conversation_id)?;
    // A negative cursor is meaningless (sequences start at 1); normalise it
    // rather than passing a nonsense bound to SQLite.
    let after = p.after_sequence.max(0);
    let db = inner.lock_db();
    // Existence first: an unknown (or archived) conversation is a structured
    // NOT_FOUND, never an empty-but-successful answer that looks like "no
    // messages". The id is bound, never interpolated.
    let known: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM conversations WHERE id = ?1 AND archived_at IS NULL",
            params![p.conversation_id],
            |r| r.get(0),
        )
        .map_err(internal)?;
    if known == 0 {
        return Err((ErrorCode::NotFound, "conversation not found".into()));
    }

    // Read one row MORE than the caller asked for: that probe row proves the
    // scan was cut short without materialising the whole transcript.
    let fetch = limit as i64 + 1;
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT id, conversation_id, role, content, sequence FROM messages
             WHERE conversation_id = ?1 AND sequence > ?2 ORDER BY sequence ASC LIMIT ?3",
        )
        .map_err(internal)?;
    let rows = stmt
        .query_map(params![p.conversation_id, after, fetch], |r| {
            Ok(MessageRecord {
                id: r.get(0)?,
                conversation_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                sequence: r.get(4)?,
            })
        })
        .map_err(internal)?;

    let mut messages: Vec<MessageRecord> = Vec::with_capacity(limit.min(64));
    let mut content_bytes: usize = 0;
    let mut truncated = false;
    for row in rows {
        let record = row.map_err(internal)?;
        if messages.len() >= limit {
            truncated = true; // the probe row proves more rows exist
            break;
        }
        // Byte bound over the ACTUAL serialized row bytes (keys, quotes and JSON
        // escapes included), so the ceiling describes the frame that goes on the
        // wire rather than an undercount of hostile content. The FIRST row is
        // always allowed through — see [`MAX_HISTORY_BYTES`] for why that cannot
        // overflow the frame cap — so paging can never stall on an oversize row.
        let row_bytes = serde_json::to_string(&record)
            .map(|s| s.len())
            .map_err(internal)?;
        if !messages.is_empty() && content_bytes + row_bytes > MAX_HISTORY_BYTES {
            truncated = true;
            break;
        }
        content_bytes += row_bytes;
        messages.push(record);
    }
    let next_sequence = messages.last().map(|m| m.sequence).unwrap_or(after);
    let result = ConversationHistoryResult {
        messages,
        truncated,
        next_sequence,
    };
    serde_json::to_value(result).map_err(internal)
}

fn query_task_ids(db: &Database, project_id: Option<&str>) -> Result<Vec<String>, SvcError> {
    let conn = db.conn();
    let ids = match project_id {
        Some(pid) => {
            let mut stmt = conn
                .prepare(
                    "SELECT t.id FROM tasks t JOIN conversations c ON c.id = t.conversation_id
                     WHERE c.project_id = ?1 ORDER BY t.created_at",
                )
                .map_err(internal)?;
            let rows = stmt
                .query_map(params![pid], |r| r.get::<_, String>(0))
                .map_err(internal)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(internal)?
        }
        None => {
            let mut stmt = conn
                .prepare("SELECT id FROM tasks ORDER BY created_at")
                .map_err(internal)?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(internal)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(internal)?
        }
    };
    Ok(ids)
}

/// Load a task's real Git context (repo path + recorded base commit).
fn git_context(inner: &ServerInner, task_id: &str) -> Result<(String, String), SvcError> {
    let db = inner.lock_db();
    let row = db
        .conn()
        .query_row(
            "SELECT r.canonical_path, t.base_commit FROM tasks t
             LEFT JOIN repositories r ON r.id = t.repo_id
             WHERE t.id = ?1",
            params![task_id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .map_err(|_| (ErrorCode::NotFound, "task not found".to_string()))?;
    match row {
        (Some(path), Some(base)) => Ok((path, base)),
        _ => Err((
            ErrorCode::ValidationFailed,
            "task has no Git context (repo binding + base_commit)".to_string(),
        )),
    }
}

fn git_review(inner: &ServerInner, task_id: String) -> Result<serde_json::Value, SvcError> {
    let (repo_path, base_commit) = git_context(inner, &task_id)?;
    let repo = Path::new(&repo_path);
    let dirty = inner.git.is_dirty(repo).map_err(internal)?;
    let changes = inner
        .git
        .change_list(repo, &base_commit)
        .map_err(|e| (ErrorCode::Internal, e.to_string()))?;
    let change_set = ChangeSet {
        task_id,
        base_commit,
        host_dirty: dirty,
        changes: changes
            .into_iter()
            .map(|c| FileChange {
                path: c.path,
                status: match c.status.as_str() {
                    "added" => FileChangeStatus::Added,
                    "deleted" => FileChangeStatus::Deleted,
                    "renamed" => FileChangeStatus::Renamed,
                    "untracked" => FileChangeStatus::Untracked,
                    _ => FileChangeStatus::Modified,
                },
            })
            .collect(),
    };
    serde_json::to_value(change_set).map_err(internal)
}

fn git_apply(inner: &ServerInner, p: GitApplyParams) -> Result<serde_json::Value, SvcError> {
    Validator::git_ref(&p.expected_base)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("expected base: {e}")))?;
    // Real precondition enforcement: when the task carries a Git context, the
    // dirty-host and base-divergence gates run for real and abort structurally
    // (specs/06 §6). The merge/patch application itself is a P4 deliverable,
    // so a passing precondition check still ends in an honest abort here.
    // FAIL-CLOSED: no usable Git context aborts the apply — it never falls
    // through to the "preconditions passed" branch (review finding #9).
    match git_context(inner, &p.task_id) {
        Ok((repo_path, base_commit)) => {
            if base_commit != p.expected_base && !base_commit.starts_with(&p.expected_base) {
                let result = ApplyResult {
                    applied: false,
                    abort_reason: Some(format!(
                        "base diverged: task recorded {base_commit}, client expected {}",
                        p.expected_base
                    )),
                    conflicted_files: vec![],
                };
                return serde_json::to_value(result).map_err(internal);
            }
            if let Err(e) = scoregit::preconditions_for_apply(
                &inner.git,
                Path::new(&repo_path),
                &p.expected_base,
            ) {
                let result = ApplyResult {
                    applied: false,
                    abort_reason: Some(format!("precondition failed: {e}")),
                    conflicted_files: vec![],
                };
                return serde_json::to_value(result).map_err(internal);
            }
        }
        Err((code, msg)) => {
            let result = ApplyResult {
                applied: false,
                abort_reason: Some(format!(
                    "apply refused: no Git context for task ({code:?}): {msg}"
                )),
                conflicted_files: vec![],
            };
            return serde_json::to_value(result).map_err(internal);
        }
    }
    let result = ApplyResult {
        applied: false,
        abort_reason: Some(
            "apply is a P4 deliverable; preconditions passed but merge/patch application \
             is not implemented in this scaffold"
                .to_string(),
        ),
        conflicted_files: vec![],
    };
    serde_json::to_value(result).map_err(internal)
}

// ---------------------------------------------------------------------------
// Connection serving
// ---------------------------------------------------------------------------

/// Serve one connection to completion (thread-per-connection; the accept loop
/// lives in main.rs). UI detach never cancels tasks: dropping this reader only
/// ends the subscription — DB/scheduler state is untouched.
#[cfg(unix)]
pub fn serve_connection(inner: Arc<ServerInner>, stream: std::os::unix::net::UnixStream) {
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let mut writer = std::io::BufWriter::new(write_half);
    let mut buf_reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        // Bound memory: read at most MAX_FRAME_BYTES + 1 for the over-limit check.
        let mut limited = buf_reader.by_ref().take(MAX_FRAME_BYTES as u64 + 1);
        match limited.read_line(&mut line) {
            Ok(0) => break, // EOF: client detached
            Ok(_) => {
                if line.len() > MAX_FRAME_BYTES {
                    let resp = err_frame("", ErrorCode::ValidationFailed, "frame too large");
                    let _ = writeln!(writer, "{resp}");
                    let _ = writer.flush();
                    break;
                }
                let response = handle_line(&inner, &line);
                // NDJSON: each response frame must reach the client before we
                // read the next request — flush every frame, never let it sit
                // in the BufWriter (that would deadlock a request/response client).
                if writeln!(writer, "{response}").is_err() || writer.flush().is_err() {
                    break;
                }
            }
            Err(e) => {
                // Non-UTF-8 frames get a structured refusal like malformed
                // JSON does — never a silent disconnect (specs/02 §2).
                if e.kind() == std::io::ErrorKind::InvalidData {
                    let resp = err_frame("", ErrorCode::ValidationFailed, "invalid UTF-8 frame");
                    let _ = writeln!(writer, "{resp}");
                    let _ = writer.flush();
                }
                break;
            }
        }
    }
    let _ = writer.flush();
}

/// Socket path policy: explicit `SANDPANE_SOCKET` override, else a per-user
/// private directory (0700) under the platform app-data location. NEVER TCP.
pub fn default_socket_path() -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("SANDPANE_SOCKET") {
        return std::path::PathBuf::from(p);
    }
    data_dir().join("sandpane.sock")
}

/// Database path policy: explicit `SANDPANE_DB` override, else the same
/// per-user private data directory.
pub fn default_db_path() -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("SANDPANE_DB") {
        return std::path::PathBuf::from(p);
    }
    data_dir().join("sandpane.sqlite3")
}

pub fn data_dir() -> std::path::PathBuf {
    if cfg!(target_os = "macos") {
        home_dir().join("Library/Application Support/sandpane")
    } else {
        std::env::var_os("XDG_STATE_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".local/state/sandpane"))
    }
}

fn home_dir() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inner() -> Arc<ServerInner> {
        ServerInner::new(
            Database::open_in_memory().unwrap(),
            SbxLocator::with_search(None, vec![]),
        )
    }

    fn call(i: &ServerInner, id: &str, method: &str, params: serde_json::Value) -> RpcResponse {
        let line = serde_json::to_string(&RpcRequest {
            v: PROTOCOL_VERSION,
            id: id.into(),
            method: method.into(),
            params,
        })
        .unwrap();
        serde_json::from_str(&handle_line(i, &line)).unwrap()
    }

    #[test]
    fn rfc3339_known_values() {
        assert_eq!(rfc3339_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix(86_399), "1970-01-01T23:59:59Z");
        assert_eq!(rfc3339_from_unix(1_700_000_000), "2023-11-14T22:13:20Z");
        // Month boundary after a non-leap February: 2025-03-01T00:00:00Z.
        assert_eq!(rfc3339_from_unix(1_740_787_200), "2025-03-01T00:00:00Z");
        // Leap day: 2024-02-29T00:00:00Z.
        assert_eq!(rfc3339_from_unix(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn probe_reports_honest_capabilities() {
        let i = inner();
        let resp = call(&i, "1", "system.probe", serde_json::json!({}));
        match resp.outcome {
            sandpane_protocol::RpcOutcome::Ok(v) => {
                assert_eq!(v["protocolVersion"], 1);
                assert_eq!(v["agents"][0]["verified"], false);
                assert_eq!(v["sbx"]["installed"], false);
            }
            other => panic!("expected ok, got {other:?}"),
        }
    }

    #[test]
    fn unknown_and_hostile_methods_rejected() {
        let i = inner();
        for m in ["shell.exec", "system.probe; ls", "", "TASK.CANCEL"] {
            let resp = call(&i, "x", m, serde_json::json!({}));
            match resp.outcome {
                sandpane_protocol::RpcOutcome::Err(e) => {
                    assert_eq!(e.code, ErrorCode::ValidationFailed)
                }
                _ => panic!("{m} accepted"),
            }
        }
    }

    #[test]
    fn malformed_and_wrong_version_frames() {
        let i = inner();
        let bad = handle_line(&i, "not json{{");
        assert!(bad.contains("VALIDATION_FAILED"));
        let wrong_v = handle_line(
            &i,
            r#"{"v":99,"id":"a","method":"system.probe","params":{}}"#,
        );
        assert!(wrong_v.contains("protocol version mismatch"));
        let empty = handle_line(&i, "   ");
        assert!(empty.contains("empty frame"));
    }

    #[test]
    fn sandbox_list_not_installed_is_structured() {
        let i = inner();
        let resp = call(&i, "2", "sandbox.list", serde_json::json!({}));
        match resp.outcome {
            sandpane_protocol::RpcOutcome::Err(e) => assert_eq!(e.code, ErrorCode::NotInstalled),
            _ => panic!("expected NOT_INSTALLED"),
        }
    }

    #[test]
    fn list_limits_are_always_bounded() {
        // Absent → default; out of range → clamped into the bound; never an
        // unbounded set and never a zero-row "success".
        assert_eq!(clamp_limit(None), DEFAULT_LIST_LIMIT as usize);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(1)), 1);
        assert_eq!(clamp_limit(Some(MAX_LIST_LIMIT)), MAX_LIST_LIMIT as usize);
        assert_eq!(clamp_limit(Some(u32::MAX)), MAX_LIST_LIMIT as usize);
        // The response ceiling must sit strictly under the transport frame cap —
        // checked at compile time, not at runtime.
        const _: () = assert!(MAX_HISTORY_BYTES < MAX_FRAME_BYTES);
    }

    #[test]
    fn status_filter_uses_core_stored_wire_names() {
        // The IN-list values are exactly the bare snake_case names `tasks.status`
        // stores — the same strings `TaskStatus`' serde produces.
        for status in [
            TaskStatus::Created,
            TaskStatus::Queued,
            TaskStatus::Preparing,
            TaskStatus::Running,
            TaskStatus::Verifying,
            TaskStatus::AwaitingInput,
            TaskStatus::AwaitingReview,
            TaskStatus::Completed,
            TaskStatus::Rejected,
            TaskStatus::Failed,
            TaskStatus::Cancelled,
            TaskStatus::Interrupted,
        ] {
            let stored = task_status_stored(status).unwrap();
            assert_eq!(
                stored,
                serde_json::to_value(status).unwrap().as_str().unwrap(),
                "stored name must equal the wire name"
            );
            assert_eq!(task_status_from_stored(&stored, "t1").unwrap(), status);
        }
        // A stored value Core does not define is a loud INTERNAL, never a
        // silent normalization into a status that happens to exist.
        let err = task_status_from_stored("half_finished", "t9").unwrap_err();
        assert_eq!(err.0, ErrorCode::Internal);
        assert!(err.1.contains("t9") && err.1.contains("half_finished"));
    }

    #[test]
    fn cursor_map_input_is_bounded() {
        let mut ok_map = HashMap::new();
        ok_map.insert("task-a".to_string(), 3i64);
        assert!(validate_cursor_map(&ok_map).is_ok());

        let mut empty_key = HashMap::new();
        empty_key.insert("".to_string(), 0i64);
        assert_eq!(
            validate_cursor_map(&empty_key).unwrap_err().0,
            ErrorCode::ValidationFailed
        );

        let mut long_key = HashMap::new();
        long_key.insert("x".repeat(MAX_CURSOR_KEY_LEN + 1), 0i64);
        assert_eq!(
            validate_cursor_map(&long_key).unwrap_err().0,
            ErrorCode::ValidationFailed
        );

        let huge: HashMap<String, i64> = (0..=MAX_SUBSCRIBE_CURSORS)
            .map(|i| (format!("t{i}"), 0i64))
            .collect();
        assert_eq!(
            validate_cursor_map(&huge).unwrap_err().0,
            ErrorCode::ValidationFailed
        );
    }

    #[test]
    fn workspace_mode_is_reported_only_when_core_can_read_it() {
        assert_eq!(
            workspace_mode_from_stored("direct_mount"),
            Some(WorkspaceMode::DirectMount)
        );
        assert_eq!(
            workspace_mode_from_stored("sbx_clone"),
            Some(WorkspaceMode::SbxClone)
        );
        // Never guessed: an unreadable stored value yields NO mode (absent
        // field), not a stand-in. The JSON-quoted form is the pre-review-0004
        // storage shape — still the row's OWN recorded value, so it decodes.
        assert_eq!(
            workspace_mode_from_stored(r#""direct_mount""#),
            Some(WorkspaceMode::DirectMount)
        );
        assert_eq!(workspace_mode_from_stored("live_writable"), None);
        assert_eq!(workspace_mode_from_stored("direct mount"), None);
        assert_eq!(workspace_mode_from_stored(r#""some_other_project""#), None);
        assert_eq!(workspace_mode_from_stored(""), None);
    }

    #[test]
    fn scoping_ids_are_validated_not_guessed() {
        assert!(validate_scoping_id("projectId", "3f9a1c22-0000-4000-8000-abcdef012345").is_ok());
        assert!(optional_scoping_id("projectId", &None).is_ok());
        // An empty id would otherwise scope the read to nothing and answer `[]`
        // — indistinguishable from "this project has no tasks".
        assert_eq!(
            validate_scoping_id("projectId", "").unwrap_err().0,
            ErrorCode::ValidationFailed
        );
        assert_eq!(
            optional_scoping_id("projectId", &Some(String::new()))
                .unwrap_err()
                .0,
            ErrorCode::ValidationFailed
        );
        assert_eq!(
            validate_scoping_id("conversationId", &"c".repeat(MAX_SCOPING_ID_LEN + 1))
                .unwrap_err()
                .0,
            ErrorCode::ValidationFailed
        );
        // Control characters are refused (same validator every stored value uses).
        assert_eq!(
            validate_scoping_id("projectId", "p1\u{0}injected")
                .unwrap_err()
                .0,
            ErrorCode::ValidationFailed
        );
    }

    #[test]
    fn oversized_replay_is_refused_structurally() {
        // A replay that cannot fit one IPC frame used to be built anyway and
        // then rejected by the client's own reader. The estimate must fail
        // CLOSED, and the ceiling must be below the frame cap.
        const _: () = assert!(MAX_SUBSCRIBE_BYTES < MAX_FRAME_BYTES);
        let small = vec![TaskEvent {
            task_id: "t".into(),
            sequence: 1,
            kind: "message.delta".into(),
            payload: serde_json::json!({"text": "hi"}),
            timestamp: "2026-10-09T00:00:00Z".into(),
        }];
        assert!(replay_frame_bytes(&small) > 0);
        assert!(replay_frame_bytes(&small) < MAX_SUBSCRIBE_BYTES);
        assert_eq!(replay_frame_bytes(&[]), 0);
    }
}
