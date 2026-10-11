//! A7 — verification commands and `project.context` (design of record
//! `docs/plans/2026-10-09-protocol-v1-additions.md` §3.7).
//!
//! A verification run executes ONE user-approved argv vector inside the
//! task's sandbox through `sbx exec -- <name> <argv…>`. Nothing ever runs on
//! the host. The pure rules (secret check, outcome mapping, output
//! redaction) live in `sandpane_core::verification`; this module owns the
//! requests, the gates, the durable events, the in-memory run registry, the
//! worker, graceful shutdown and restart reconciliation.
//!
//! LOCK ORDER (I-a): scheduler (taken and RELEASED: the `direct_mount`
//! writer lock is a scheduler entry, not a held mutex) → DB mutex →
//! registry / `sandbox_ops` / `project_creates` (leaves). The registry
//! mutex is only ever taken while holding the DB guard or with nothing
//! held, never the other way round, and never across a subprocess.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use sandpane_core::process::{self, ChildSlot, RunLimits};
use sandpane_core::redact::RedactionCounts;
use sandpane_core::sbx::{
    classify_failure, exec_env, exec_verified, parse_list_json, SbxCommand, SbxCommandBuilder,
    SbxExecContext, SbxSandboxStatus, SbxVersion,
};
use sandpane_core::validation::Validator;
use sandpane_core::verification::{self as vcore, ApprovalRefusal};
use sandpane_core::{context, idempotency, EventLog};
use sandpane_protocol::{
    DetectedManifest, ErrorCode, Method, OutputRedaction, ProjectContextParams,
    ProjectContextResult, RepositoryContext, VerificationApproveParams, VerificationApproveResult,
    VerificationCommand, VerificationListParams, VerificationListResult, VerificationResult,
    VerificationResultParams, VerificationRevokeParams, VerificationRevokeResult,
    VerificationRunParams, VerificationRunResult, WorkspaceMode,
};

use crate::git_apply::{repo_lock_key, CoreTemp};
use crate::{
    idempotency_cutoff, internal, keyed_call, locate_sbx, now_rfc3339, process_failure,
    project_lifecycle, validate_scoping_id, workspace_mode_from_stored, workspace_mode_wire,
    ReconciliationFailed, ServerInner, SvcFailure, MSG_CONVERSATION_ARCHIVED,
};

/// Event kinds (open strings; §3.7 item 5). Interruption is
/// `verification.finished {outcome: "interrupted"}` — there is no separate
/// kind.
pub const EVENT_VERIFICATION_STARTED: &str = "verification.started";
pub const EVENT_VERIFICATION_FINISHED: &str = "verification.finished";

/// Live (not revoked) commands one project may hold (§3.7 item 1).
pub const MAX_COMMANDS_PER_PROJECT: i64 = 50;

/// Runs in flight across Core (§3.7 item 4, W7). Per task and per sandbox
/// the limit is one.
pub const MAX_CONCURRENT_VERIFICATIONS: usize = 4;

// ---- exact user-facing messages (§3.7 items 1, 3, 4, 5) -------------------

pub const MSG_VERIFICATION_NOT_BOUND: &str = "this task is not bound to a sandbox; nothing was run";
pub const MSG_VERIFICATION_SANDBOX_CHANGED: &str =
    "the task's sandbox changed since you confirmed; nothing was run";
pub const MSG_VERIFICATION_IDENTITY: &str =
    "Core cannot confirm the sandbox's identity; nothing was run";
pub const MSG_VERIFICATION_TASK_BUSY: &str =
    "a verification is already running for this task; wait for it to finish; nothing was run";
pub const MSG_VERIFICATION_SANDBOX_BUSY: &str =
    "a verification is already running in this sandbox; wait for it to finish; nothing was run";
pub const MSG_VERIFICATION_CORE_BUSY: &str = "a verification is already running in each of \
     Core's 4 verification slots; wait for one to finish; nothing was run";
pub const MSG_VERIFICATION_SHUTTING_DOWN: &str = "Core is shutting down; nothing was run";
pub const MSG_COMMAND_NOT_FOUND: &str = "verification command not found";
pub const MSG_COMMAND_REVOKED: &str = "this verification command was revoked; nothing was run";
pub const MSG_COMMAND_OTHER_PROJECT: &str =
    "this verification command belongs to another project; nothing was run";
pub const MSG_RUN_NOT_FOUND: &str = "verification run not found";
pub const MSG_TASK_NOT_FOUND: &str = "task not found";
pub const MSG_TOO_MANY_COMMANDS: &str = "this project already has 50 approved verification \
     commands, the most it can hold; revoke one first; nothing was approved";
pub const MSG_VERSION_UNREADABLE: &str = "sbx exec argument passing has not been verified for \
     this sbx (Core could not read its version); nothing was run";
pub const MSG_PROJECT_VERIFICATION_RUNNING: &str = "a verification is running for a task of this \
     project; wait for it to finish; nothing was deleted";
pub const MSG_CONVERSATION_VERIFICATION_RUNNING: &str = "a verification is running for a task of \
     this conversation; wait for it to finish; nothing was deleted";
/// W3: a stored command that the current approval check refuses (it was
/// approved under an older, weaker check) is refused at run start.
pub const MSG_COMMAND_NO_LONGER_PASSES: &str =
    "this command no longer passes the secret check; revoke it; nothing was run";
/// W3 (with W1): a stored command whose label or argv the current shape
/// check refuses (e.g. control characters stored before that check).
pub fn msg_command_shape_no_longer_passes(why: &str) -> String {
    format!("this command no longer passes the argument checks ({why}); revoke it; nothing was run")
}
/// W3: the run-start recheck could not run the redactor.
pub const MSG_RUN_SECRET_CHECK_UNAVAILABLE: &str =
    "the secret check is unavailable, so nothing was run";
/// W1 backstop: the largest response these methods may answer. The
/// transport and every client reader refuse a frame above
/// [`crate::MAX_FRAME_BYTES`]; the 64 KiB headroom absorbs the envelope
/// (the same headroom as [`crate::MAX_SUBSCRIBE_BYTES`]).
pub const MAX_RESPONSE_BYTES: usize = crate::MAX_FRAME_BYTES - 64 * 1024;
/// How many repositories a `project.context` frame refusal lists in
/// `details.repositories` (largest first), so the refusal stays small.
const FRAME_REFUSAL_MAX_REPOSITORIES: usize = 20;
pub const MSG_SANDBOX_VERIFICATION_RUNNING: &str =
    "a verification is running in this sandbox; wait for it to finish; nothing was deleted";

/// The version gate (§3.7 item 3).
pub fn msg_exec_unverified(version: &SbxVersion) -> String {
    format!("sbx exec argument passing has not been verified for sbx {version}; nothing was run")
}

/// A stopped (or otherwise not running) sandbox (§3.7 item 4).
pub fn msg_sandbox_not_running(name: &str) -> String {
    format!(
        "sandbox \"{name}\" is not running; sbx exec would start it; start it with `sbx run` in \
         a terminal; nothing was run"
    )
}

/// A `direct_mount` run refused because the repository writer lock is held
/// (W7, I-b).
pub fn msg_verification_repo_busy(repo: &str, holder: &str) -> String {
    format!(
        "{repo} is busy: {holder} holds its writer lock (a running writer task, an apply, a \
         worktree discard or another verification); a verification is already running or the \
         repository is being written; nothing was run"
    )
}

/// The holder name a `direct_mount` run uses on the repository writer lock.
pub fn verification_lock_holder(run_id: &str) -> String {
    format!("verification.run:{run_id}")
}

// ---------------------------------------------------------------------------
// The in-memory run registry
// ---------------------------------------------------------------------------

/// One run in flight. Memory only; it dies with Core (restart reconciliation
/// closes what a dead Core left open).
#[derive(Debug, Clone)]
pub(crate) struct RunEntry {
    pub task_id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub sandbox_name: String,
    pub started_sequence: i64,
    pub started: Instant,
    pub slot: Arc<ChildSlot>,
}

#[derive(Debug, Default)]
struct RegistryState {
    runs: HashMap<String, RunEntry>,
    shutting_down: bool,
}

/// Runs in flight (W7). LEAF mutex: taken only while holding the DB guard
/// (start, terminal write, delete preconditions, shutdown) or with nothing
/// else held (reads), never across a subprocess.
#[derive(Debug, Default)]
pub struct VerificationRegistry {
    state: Mutex<RegistryState>,
}

impl VerificationRegistry {
    fn lock(&self) -> MutexGuard<'_, RegistryState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The CONFLICT a new run on (`task_id`, `sandbox`) would get, if any.
    fn admission_refusal(&self, task_id: &str, sandbox: &str) -> Option<SvcFailure> {
        let st = self.lock();
        let refuse = |m: &str| Some(SvcFailure::from((ErrorCode::Conflict, m.to_string())));
        if st.shutting_down {
            return Some(SvcFailure::from((
                ErrorCode::Internal,
                MSG_VERIFICATION_SHUTTING_DOWN.to_string(),
            )));
        }
        if st.runs.values().any(|r| r.task_id == task_id) {
            return refuse(MSG_VERIFICATION_TASK_BUSY);
        }
        if st.runs.values().any(|r| r.sandbox_name == sandbox) {
            return refuse(MSG_VERIFICATION_SANDBOX_BUSY);
        }
        if st.runs.len() >= MAX_CONCURRENT_VERIFICATIONS {
            return refuse(MSG_VERIFICATION_CORE_BUSY);
        }
        None
    }

    fn insert(&self, run_id: String, entry: RunEntry) {
        self.lock().runs.insert(run_id, entry);
    }

    fn remove(&self, run_id: &str) {
        self.lock().runs.remove(run_id);
    }

    pub(crate) fn running_for_project(&self, project_id: &str) -> bool {
        self.lock()
            .runs
            .values()
            .any(|r| r.project_id == project_id)
    }

    pub(crate) fn running_for_conversation(&self, conversation_id: &str) -> bool {
        self.lock()
            .runs
            .values()
            .any(|r| r.conversation_id == conversation_id)
    }

    pub(crate) fn running_in_sandbox(&self, name: &str) -> bool {
        self.lock().runs.values().any(|r| r.sandbox_name == name)
    }

    /// Number of runs in flight (tests and shutdown logging).
    pub fn len(&self) -> usize {
        self.lock().runs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn invalid(m: impl Into<String>) -> SvcFailure {
    SvcFailure::from((ErrorCode::ValidationFailed, m.into()))
}

fn conflict(m: impl Into<String>) -> SvcFailure {
    SvcFailure::from((ErrorCode::Conflict, m.into()))
}

fn not_found(m: &str) -> SvcFailure {
    SvcFailure::from((ErrorCode::NotFound, m.to_string()))
}

fn db_err(e: rusqlite::Error) -> SvcFailure {
    SvcFailure::from(internal(e))
}

fn to_value<T: serde::Serialize>(v: T) -> Result<serde_json::Value, SvcFailure> {
    serde_json::to_value(v).map_err(|e| SvcFailure::from(internal(e)))
}

/// Serialized size of `v` — the JSON the frame carries. A value that cannot
/// serialize counts as over every limit (fail closed, never as zero bytes).
fn json_len<T: serde::Serialize + ?Sized>(v: &T) -> usize {
    serde_json::to_string(v).map_or(usize::MAX, |s| s.len())
}

/// W1 backstop: the structured refusal for a response that would not fit
/// one frame. Nothing is sent but this small error.
fn frame_refusal(bytes: usize, what: &str, details: serde_json::Value) -> SvcFailure {
    SvcFailure {
        code: ErrorCode::ValidationFailed,
        message: format!(
            "the response would exceed the frame limit ({bytes} bytes, the limit is \
             {MAX_RESPONSE_BYTES}); {what}; nothing was returned"
        ),
        details: Some(details),
    }
}

/// A stored command row.
struct CommandRow {
    id: String,
    project_id: String,
    label: String,
    argv: Vec<String>,
    approved_at: String,
    revoked: bool,
}

impl CommandRow {
    fn wire(self) -> VerificationCommand {
        VerificationCommand {
            id: self.id,
            project_id: self.project_id,
            label: self.label,
            argv: self.argv,
            approved_at: self.approved_at,
        }
    }
}

fn argv_from_json(json: &str) -> Result<Vec<String>, SvcFailure> {
    serde_json::from_str(json)
        .map_err(|e| SvcFailure::from(internal(format!("stored argv unreadable: {e}"))))
}

fn command_row(conn: &Connection, id: &str) -> Result<Option<CommandRow>, SvcFailure> {
    let row = conn
        .query_row(
            "SELECT id, project_id, label, argv_json, approved_at, revoked_at
             FROM verification_commands WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(db_err)?;
    row.map(|(id, project_id, label, argv_json, approved_at, revoked)| {
        Ok(CommandRow {
            id,
            project_id,
            label,
            argv: argv_from_json(&argv_json)?,
            approved_at,
            revoked: revoked.is_some(),
        })
    })
    .transpose()
}

/// Live commands of a project, ordered by approval (`approved_at`, then
/// insertion order: the timestamp has one-second precision).
fn live_commands(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<VerificationCommand>, SvcFailure> {
    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, label, argv_json, approved_at FROM verification_commands
             WHERE project_id = ?1 AND revoked_at IS NULL
             ORDER BY approved_at, rowid",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    rows.into_iter()
        .map(|(id, project_id, label, argv_json, approved_at)| {
            Ok(VerificationCommand {
                id,
                project_id,
                label,
                argv: argv_from_json(&argv_json)?,
                approved_at,
            })
        })
        .collect()
}

fn project_exists(conn: &Connection, id: &str) -> Result<bool, SvcFailure> {
    conn.query_row("SELECT 1 FROM projects WHERE id = ?1", params![id], |_| {
        Ok(())
    })
    .optional()
    .map(|r| r.is_some())
    .map_err(db_err)
}

// ---------------------------------------------------------------------------
// verification.list / approve / revoke
// ---------------------------------------------------------------------------

/// `verification.list` (reads are allowed on archived projects).
pub(crate) fn verification_list(
    inner: &ServerInner,
    p: VerificationListParams,
) -> Result<serde_json::Value, SvcFailure> {
    validate_scoping_id("projectId", &p.project_id)?;
    let db = inner.lock_db();
    if !project_exists(db.conn(), &p.project_id)? {
        return Err(not_found(project_lifecycle::MSG_PROJECT_NOT_FOUND));
    }
    let commands = live_commands(db.conn(), &p.project_id)?;
    drop(db);
    let result = VerificationListResult { commands };
    let bytes = json_len(&result);
    if bytes > MAX_RESPONSE_BYTES {
        // Every id, largest command first: what to revoke.
        let mut sized: Vec<(usize, String)> = result
            .commands
            .into_iter()
            .map(|c| (json_len(&c), c.id))
            .collect();
        sized.sort_by_key(|(size, _)| std::cmp::Reverse(*size));
        let ids: Vec<String> = sized.into_iter().map(|(_, id)| id).collect();
        return Err(frame_refusal(
            bytes,
            "this project's approved commands are too large to list at once; revoke the \
             largest ones with verification.revoke (their ids are in details.commandIds, \
             largest first)",
            serde_json::json!({ "commandIds": ids }),
        ));
    }
    to_value(result)
}

/// `verification.approve` (§3.7 items 1–2). Shape, then the C1 secret check
/// (Core is the authority), then — under the DB mutex, in one transaction —
/// the project (exists, not archived: R4), the byte-equal dedupe (BEFORE
/// the cap, so re-approving at the limit returns the existing command) and
/// the 50-command cap.
pub(crate) fn verification_approve(
    inner: &ServerInner,
    p: VerificationApproveParams,
) -> Result<serde_json::Value, SvcFailure> {
    validate_scoping_id("projectId", &p.project_id)?;
    let label =
        Validator::verification_label(&p.label).map_err(|e| invalid(format!("label: {e}")))?;
    Validator::verification_argv(&p.argv).map_err(|e| invalid(format!("argv: {e}")))?;
    approval_secret_check(&label, &p.argv)?;
    let argv_json = serde_json::to_string(&p.argv).map_err(|e| SvcFailure::from(internal(e)))?;
    let db = inner.lock_db();
    let tx = db.conn().unchecked_transaction().map_err(db_err)?;
    project_lifecycle::require_live_project(&tx, &p.project_id)?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM verification_commands
             WHERE project_id = ?1 AND argv_json = ?2 AND revoked_at IS NULL",
            params![p.project_id, argv_json],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?;
    let id = match existing {
        Some(id) => id,
        None => {
            let live: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM verification_commands
                     WHERE project_id = ?1 AND revoked_at IS NULL",
                    params![p.project_id],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if live >= MAX_COMMANDS_PER_PROJECT {
                return Err(invalid(MSG_TOO_MANY_COMMANDS));
            }
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO verification_commands (id, project_id, label, argv_json, approved_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, p.project_id, label, argv_json, now_rfc3339()],
            )
            .map_err(db_err)?;
            id
        }
    };
    let row = command_row(&tx, &id)?.ok_or_else(|| not_found(MSG_COMMAND_NOT_FOUND))?;
    tx.commit().map_err(db_err)?;
    to_value(VerificationApproveResult {
        command: row.wire(),
    })
}

/// C1: refuse an approval whose argv or label looks like a secret. The
/// message is the exact design template; the I-g advice goes in
/// `details.hint`.
fn approval_secret_check(label: &str, argv: &[String]) -> Result<(), SvcFailure> {
    vcore::check_approval(label, argv).map_err(|refusal| {
        let hint = !matches!(refusal, ApprovalRefusal::RedactorUnavailable);
        SvcFailure {
            code: ErrorCode::ValidationFailed,
            message: refusal.message(),
            details: hint.then(|| serde_json::json!({ "hint": vcore::SECRET_REFUSAL_HINT })),
        }
    })
}

/// W3: the approval check (shape, then secrets) re-run on a stored command
/// at run start. Any refusal means the command must be revoked.
fn run_start_approval_check(label: &str, argv: &[String]) -> Result<(), SvcFailure> {
    Validator::verification_label(label)
        .map_err(|e| invalid(msg_command_shape_no_longer_passes(&format!("label: {e}"))))?;
    Validator::verification_argv(argv)
        .map_err(|e| invalid(msg_command_shape_no_longer_passes(&format!("argv: {e}"))))?;
    match vcore::check_approval(label, argv) {
        Ok(()) => Ok(()),
        Err(ApprovalRefusal::RedactorUnavailable) => Err(invalid(MSG_RUN_SECRET_CHECK_UNAVAILABLE)),
        Err(_) => Err(invalid(MSG_COMMAND_NO_LONGER_PASSES)),
    }
}

/// `verification.revoke`: tombstone (never delete), idempotent, always
/// allowed (it only narrows what can run; R4). A run already in flight is
/// not stopped.
pub(crate) fn verification_revoke(
    inner: &ServerInner,
    p: VerificationRevokeParams,
) -> Result<serde_json::Value, SvcFailure> {
    validate_scoping_id("commandId", &p.command_id)?;
    let db = inner.lock_db();
    let n = db
        .conn()
        .execute(
            "UPDATE verification_commands SET revoked_at = COALESCE(revoked_at, ?2)
             WHERE id = ?1",
            params![p.command_id, now_rfc3339()],
        )
        .map_err(db_err)?;
    if n == 0 {
        return Err(not_found(MSG_COMMAND_NOT_FOUND));
    }
    to_value(VerificationRevokeResult { revoked: true })
}

// ---------------------------------------------------------------------------
// verification.result
// ---------------------------------------------------------------------------

pub(crate) fn verification_result(
    inner: &ServerInner,
    p: VerificationResultParams,
) -> Result<serde_json::Value, SvcFailure> {
    validate_scoping_id("runId", &p.run_id)?;
    type Row = (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Option<i64>,
        Option<String>,
        String,
        String,
        bool,
        bool,
        Option<String>,
        String,
        Option<String>,
        Option<i64>,
        bool,
    );
    let row: Option<Row> = {
        let db = inner.lock_db();
        db.conn()
            .query_row(
                "SELECT task_id, command_id, label, argv_json, sandbox_name, workspace_mode,
                        status, exit_code, outcome, stdout, stderr, stdout_truncated,
                        stderr_truncated, redactions_json, started_at, finished_at, elapsed_ms,
                        output_incomplete
                 FROM verification_runs WHERE id = ?1",
                params![p.run_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                        r.get(10)?,
                        r.get(11)?,
                        r.get(12)?,
                        r.get(13)?,
                        r.get(14)?,
                        r.get(15)?,
                        r.get(16)?,
                        r.get(17)?,
                    ))
                },
            )
            .optional()
            .map_err(db_err)?
    };
    let Some((
        task_id,
        command_id,
        label,
        argv_json,
        sandbox,
        workspace_mode,
        status,
        exit_code,
        outcome,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        redactions_json,
        started_at,
        finished_at,
        elapsed_ms,
        output_incomplete,
    )) = row
    else {
        return Err(not_found(MSG_RUN_NOT_FOUND));
    };
    let running = status == "running";
    let outcome = if running {
        vcore::OUTCOME_RUNNING.to_string()
    } else {
        outcome.unwrap_or_else(|| vcore::OUTCOME_INTERRUPTED.to_string())
    };
    let redactions = redactions_json
        .and_then(|j| serde_json::from_str::<OutputRedaction>(&j).ok())
        .unwrap_or_default();
    let result = VerificationResult {
        run_id: p.run_id,
        task_id,
        command_id,
        label,
        argv: argv_from_json(&argv_json)?,
        sandbox,
        workspace_mode,
        outcome,
        exit_code: exit_code.and_then(|c| i32::try_from(c).ok()),
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        redactions,
        elapsed_ms: elapsed_ms.and_then(|m| u64::try_from(m).ok()),
        started_at,
        finished_at,
        output_incomplete: output_incomplete.then_some(true),
    };
    let bytes = json_len(&result);
    if bytes > MAX_RESPONSE_BYTES {
        return Err(frame_refusal(
            bytes,
            "this run's stored output cannot be sent in one frame",
            serde_json::json!({ "runId": result.run_id }),
        ));
    }
    to_value(result)
}

// ---------------------------------------------------------------------------
// project.context (§3.7 item 9)
// ---------------------------------------------------------------------------

/// Read-only, bounded, runs no tool. The repository list and the approved
/// commands are read under the DB mutex; the files are read after it is
/// released. Allowed on archived projects (a read).
pub(crate) fn project_context(
    inner: &ServerInner,
    p: ProjectContextParams,
) -> Result<serde_json::Value, SvcFailure> {
    validate_scoping_id("projectId", &p.project_id)?;
    let (repos, approved) = {
        let db = inner.lock_db();
        if !project_exists(db.conn(), &p.project_id)? {
            return Err(not_found(project_lifecycle::MSG_PROJECT_NOT_FOUND));
        }
        let mut stmt = db
            .conn()
            .prepare("SELECT canonical_path FROM repositories WHERE project_id = ?1 ORDER BY rowid")
            .map_err(db_err)?;
        let repos = stmt
            .query_map(params![p.project_id], |r| r.get::<_, String>(0))
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        (repos, live_commands(db.conn(), &p.project_id)?)
    };
    // DB mutex released: now read the files.
    let repositories = repos
        .into_iter()
        .map(|repo| {
            let found = context::detect(Path::new(&repo));
            RepositoryContext {
                repo_path: repo,
                detected: found
                    .detected
                    .into_iter()
                    .map(|d| DetectedManifest {
                        manifest: d.manifest,
                        suggested_commands: d.suggested_commands,
                        notes: d.notes,
                    })
                    .collect(),
                unreadable: found.unreadable,
            }
        })
        .collect();
    let result = ProjectContextResult {
        repositories,
        approved,
    };
    let bytes = json_len(&result);
    if bytes > MAX_RESPONSE_BYTES {
        return Err(context_frame_refusal(bytes, &result));
    }
    to_value(result)
}

/// W1 backstop for `project.context`: name the largest parts (each
/// repository path, summed over duplicate registrations, and the approved
/// commands) so the user knows what to remove or revoke.
fn context_frame_refusal(bytes: usize, result: &ProjectContextResult) -> SvcFailure {
    let mut repos: Vec<(String, usize)> = Vec::new();
    for r in &result.repositories {
        let size = json_len(r);
        match repos.iter_mut().find(|(path, _)| *path == r.repo_path) {
            Some((_, total)) => *total = total.saturating_add(size),
            None => repos.push((r.repo_path.clone(), size)),
        }
    }
    repos.sort_by_key(|(_, size)| std::cmp::Reverse(*size));
    let approved_bytes = json_len(&result.approved);
    let mut parts: Vec<(String, usize)> = repos
        .iter()
        .map(|(path, size)| (format!("repository {path}"), *size))
        .collect();
    parts.push(("the approved commands".to_string(), approved_bytes));
    parts.sort_by_key(|(_, size)| std::cmp::Reverse(*size));
    let largest = parts
        .iter()
        .take(3)
        .map(|(what, size)| format!("{what} ({size} bytes)"))
        .collect::<Vec<_>>()
        .join(", ");
    let listed: Vec<serde_json::Value> = repos
        .iter()
        .take(FRAME_REFUSAL_MAX_REPOSITORIES)
        .map(|(path, size)| serde_json::json!({ "repoPath": path, "bytes": size }))
        .collect();
    frame_refusal(
        bytes,
        &format!(
            "the largest parts are {largest}; remove repositories from the project or revoke \
             approved commands"
        ),
        serde_json::json!({
            "repositories": listed,
            "repositoryCount": result.repositories.len(),
            "approvedBytes": approved_bytes,
        }),
    )
}

// ---------------------------------------------------------------------------
// verification.run (§3.7 items 3–5)
// ---------------------------------------------------------------------------

/// Everything the DB gates established about one run request.
struct RunPlan {
    project_id: String,
    conversation_id: String,
    binding_id: String,
    sandbox_name: String,
    mode: WorkspaceMode,
    sbx_id: Option<String>,
    /// The workspace `sbx ls` must report (canonicalized), `None` for
    /// `mountless`.
    expected_workspace: Option<String>,
    /// The repository writer-lock key (`direct_mount` only).
    lock_key: Option<String>,
    label: String,
    argv: Vec<String>,
}

/// The DB gates (§3.7 item 4 + R4), read under the DB mutex.
fn plan_run(conn: &Connection, p: &VerificationRunParams) -> Result<RunPlan, SvcFailure> {
    type TaskRow = (String, String, Option<String>, Option<String>);
    let task: Option<TaskRow> = conn
        .query_row(
            "SELECT t.conversation_id, c.project_id, t.sandbox_binding_id, t.worktree_path
             FROM tasks t JOIN conversations c ON c.id = t.conversation_id
             WHERE t.id = ?1",
            params![p.task_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(db_err)?;
    let Some((conversation_id, project_id, binding_id, worktree_path)) = task else {
        return Err(not_found(MSG_TASK_NOT_FOUND));
    };
    let command =
        command_row(conn, &p.command_id)?.ok_or_else(|| not_found(MSG_COMMAND_NOT_FOUND))?;
    // R4: archived project, then archived conversation.
    project_lifecycle::require_live_project(conn, &project_id)?;
    let conv_archived: Option<String> = conn
        .query_row(
            "SELECT archived_at FROM conversations WHERE id = ?1",
            params![conversation_id],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if conv_archived.is_some() {
        return Err(invalid(MSG_CONVERSATION_ARCHIVED));
    }
    if command.revoked {
        return Err(invalid(MSG_COMMAND_REVOKED));
    }
    if command.project_id != project_id {
        return Err(invalid(MSG_COMMAND_OTHER_PROJECT));
    }
    // The binding (never `chosenSandboxName`, never the client).
    let Some(binding_id) = binding_id else {
        return Err(invalid(MSG_VERIFICATION_NOT_BOUND));
    };
    type BindingRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let binding: Option<BindingRow> = conn
        .query_row(
            "SELECT b.sandbox_name, b.workspace_mode, b.sbx_id, b.repo_id, r.canonical_path
             FROM sandbox_bindings b LEFT JOIN repositories r ON r.id = b.repo_id
             WHERE b.id = ?1 AND b.removed_at IS NULL",
            params![binding_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(db_err)?;
    let Some((sandbox_name, stored_mode, sbx_id, _repo_id, repo_path)) = binding else {
        return Err(invalid(MSG_VERIFICATION_NOT_BOUND));
    };
    // A mode Core cannot read is never guessed (direct_mount is a
    // live-writable claim): fail closed.
    let mode = workspace_mode_from_stored(&stored_mode)
        .ok_or_else(|| invalid(MSG_VERIFICATION_IDENTITY))?;
    if p.expected_sandbox_name != sandbox_name || p.expected_workspace_mode != mode {
        return Err(invalid(MSG_VERIFICATION_SANDBOX_CHANGED));
    }
    // Re-validated before it becomes an argument.
    Validator::sandbox_name(&sandbox_name).map_err(|e| invalid(format!("sandbox name: {e}")))?;
    let expected_workspace = match mode {
        WorkspaceMode::DirectMount | WorkspaceMode::SbxClone => Some(
            repo_path
                .clone()
                .ok_or_else(|| invalid(MSG_VERIFICATION_IDENTITY))?,
        ),
        WorkspaceMode::HostWorktree => {
            Some(worktree_path.ok_or_else(|| invalid(MSG_VERIFICATION_IDENTITY))?)
        }
        WorkspaceMode::Mountless => None,
    };
    let lock_key = match mode {
        WorkspaceMode::DirectMount => Some(repo_lock_key(
            repo_path
                .as_deref()
                .ok_or_else(|| invalid(MSG_VERIFICATION_IDENTITY))?,
        )),
        _ => None,
    };
    Ok(RunPlan {
        project_id,
        conversation_id,
        binding_id,
        sandbox_name,
        mode,
        sbx_id,
        expected_workspace,
        lock_key,
        label: command.label,
        argv: command.argv,
    })
}

/// The start transaction's authoritative re-checks (advisor items 1–2):
/// everything the DB gates read can have changed while the sbx gates ran
/// with no lock held.
fn recheck_in_tx(
    conn: &Connection,
    p: &VerificationRunParams,
    plan: &RunPlan,
) -> Result<(), SvcFailure> {
    let command =
        command_row(conn, &p.command_id)?.ok_or_else(|| not_found(MSG_COMMAND_NOT_FOUND))?;
    project_lifecycle::require_live_project(conn, &plan.project_id)?;
    let task: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT conversation_id, sandbox_binding_id FROM tasks WHERE id = ?1",
            params![p.task_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db_err)?;
    let Some((conversation_id, binding_id)) = task else {
        return Err(not_found(MSG_TASK_NOT_FOUND));
    };
    let conv_archived: Option<String> = conn
        .query_row(
            "SELECT archived_at FROM conversations WHERE id = ?1",
            params![conversation_id],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if conv_archived.is_some() {
        return Err(invalid(MSG_CONVERSATION_ARCHIVED));
    }
    if command.revoked {
        return Err(invalid(MSG_COMMAND_REVOKED));
    }
    if command.project_id != plan.project_id {
        return Err(invalid(MSG_COMMAND_OTHER_PROJECT));
    }
    if binding_id.as_deref() != Some(plan.binding_id.as_str()) {
        return Err(invalid(MSG_VERIFICATION_SANDBOX_CHANGED));
    }
    let live: Option<String> = conn
        .query_row(
            "SELECT sandbox_name FROM sandbox_bindings WHERE id = ?1 AND removed_at IS NULL",
            params![plan.binding_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?;
    if live.as_deref() != Some(plan.sandbox_name.as_str()) {
        return Err(invalid(MSG_VERIFICATION_NOT_BOUND));
    }
    Ok(())
}

/// The R2 execution context: one Core-owned empty 0700 directory and one
/// cleared-then-allowlisted environment for the version probe, the
/// identity gate's `ls --json` and the exec.
fn exec_context(inner: &ServerInner) -> Result<(CoreTemp, SbxExecContext), SvcFailure> {
    let temp = CoreTemp::new(inner)
        .map_err(|e| SvcFailure::from(internal(format!("{e}; nothing was run"))))?;
    let source: Vec<(OsString, OsString)> = match &inner.test_verification_env {
        Some(vars) => vars.clone(),
        None => std::env::vars_os().collect(),
    };
    let ctx = SbxExecContext {
        cwd: temp.path().to_path_buf(),
        env: exec_env(source),
    };
    Ok((temp, ctx))
}

/// The version gate (§3.7 item 3): only versions in `VERIFIED_EXEC_VERSIONS`
/// (empty in production) or the test seam may run `sbx exec`.
fn version_gate(
    inner: &ServerInner,
    program: &Path,
    ctx: &SbxExecContext,
) -> Result<(), SvcFailure> {
    let out = SbxCommandBuilder::version(program)
        .run_in(ctx, &inner.sbx_limits.probe)
        .map_err(|e| process_failure("sbx version", e))?;
    if !out.status.success() {
        return Err(classify_failure(&out.status.to_string(), &out.stderr_lossy()).into());
    }
    let version = SbxVersion::parse(&out.stdout_lossy()).map_err(|_| {
        SvcFailure::from((
            ErrorCode::UnsupportedSbxVersion,
            MSG_VERSION_UNREADABLE.to_string(),
        ))
    })?;
    if !exec_verified(&version, &inner.test_verified_exec_versions) {
        return Err(SvcFailure::from((
            ErrorCode::UnsupportedSbxVersion,
            msg_exec_unverified(&version),
        )));
    }
    Ok(())
}

fn canonical(path: &str) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// The identity gate (§3.7 item 4, W5): a fresh `sbx ls --json` must list
/// the bound name with exactly the bound sbx id, status exactly `running`
/// and the bound mount as its only workspace (canonicalized paths, I-d).
fn identity_gate(
    inner: &ServerInner,
    program: &Path,
    ctx: &SbxExecContext,
    plan: &RunPlan,
) -> Result<(), SvcFailure> {
    let identity = || invalid(MSG_VERIFICATION_IDENTITY);
    let Some(bound_id) = plan.sbx_id.as_deref() else {
        return Err(identity());
    };
    let out = SbxCommandBuilder::list(program)
        .run_in(ctx, &inner.sbx_limits.query)
        .map_err(|e| process_failure("sbx ls", e))?;
    if !out.status.success() {
        return Err(classify_failure(&out.status.to_string(), &out.stderr_lossy()).into());
    }
    if out.stdout_truncated {
        return Err(identity());
    }
    let entries = parse_list_json(&out.stdout_lossy()).map_err(|_| identity())?;
    let entry = entries
        .into_iter()
        .find(|e| e.name == plan.sandbox_name)
        .ok_or_else(identity)?;
    if entry.id.as_deref() != Some(bound_id) {
        return Err(identity());
    }
    let listed = entry.workspaces.as_ref().ok_or_else(identity)?;
    match &plan.expected_workspace {
        None => {
            if !listed.is_empty() {
                return Err(identity());
            }
        }
        Some(expected) => {
            let want = canonical(expected).ok_or_else(identity)?;
            let [only] = listed.as_slice() else {
                return Err(identity());
            };
            if canonical(only).as_ref() != Some(&want) {
                return Err(identity());
            }
        }
    }
    match entry.status {
        SbxSandboxStatus::Running => Ok(()),
        SbxSandboxStatus::Stopped => Err(invalid(msg_sandbox_not_running(&plan.sandbox_name))),
        SbxSandboxStatus::Unknown => Err(identity()),
    }
}

/// The `direct_mount` repository writer lock for the whole run, OWNED so the
/// worker thread can hold it; released on drop (every failure path, the
/// worker's end, a panic).
pub(crate) struct OwnedRepoLock {
    inner: Arc<ServerInner>,
    key: String,
    holder: String,
}

impl OwnedRepoLock {
    /// `Err(current holder)` when held. The scheduler mutex is taken and
    /// RELEASED here, before any DB transaction (I-a).
    fn take(inner: Arc<ServerInner>, key: &str, holder: String) -> Result<Self, String> {
        let taken = inner.lock_scheduler().try_lock_writer(key, &holder);
        taken.map(|()| Self {
            inner,
            key: key.to_string(),
            holder,
        })
    }
}

impl Drop for OwnedRepoLock {
    fn drop(&mut self) {
        self.inner
            .lock_scheduler()
            .unlock_writer(&self.key, &self.holder);
    }
}

/// The run's limits and kill grace (test seam: `None` in production).
fn run_limits(inner: &ServerInner) -> (RunLimits, Duration) {
    inner
        .test_verification_limits
        .unwrap_or((RunLimits::VERIFICATION, process::VERIFICATION_KILL_GRACE))
}

/// `verification.run` (§3.7 items 3–5). Asynchronous: answers
/// `{runId, startedSequence}` once the start is durable; a worker runs the
/// exec.
pub(crate) fn verification_run(
    inner: &ServerInner,
    p: VerificationRunParams,
) -> Result<serde_json::Value, SvcFailure> {
    // R1: keyed replay FIRST, before every other check — a stored result is
    // returned as is, even while the run is in flight or after a revoke.
    let without_key = VerificationRunParams {
        idempotency_key: None,
        ..p.clone()
    };
    let keyed = keyed_call(
        Method::VerificationRun,
        p.idempotency_key.as_deref(),
        &without_key,
    )?;
    if let Some(k) = &keyed {
        if let Some(answer) = k.stored_answer(inner) {
            return answer;
        }
    }
    validate_scoping_id("taskId", &p.task_id)?;
    validate_scoping_id("commandId", &p.command_id)?;
    Validator::sandbox_name(&p.expected_sandbox_name)
        .map_err(|e| invalid(format!("expectedSandboxName: {e}")))?;
    let plan = {
        let db = inner.lock_db();
        plan_run(db.conn(), &p)?
    };
    // W3: re-run the full approval check on the stored command before
    // anything else runs — a row approved under an older, weaker check
    // never reaches sbx.
    run_start_approval_check(&plan.label, &plan.argv)?;
    // Concurrency pre-check (the authoritative one is in the start tx).
    if let Some(refusal) = inner
        .verifications
        .admission_refusal(&p.task_id, &plan.sandbox_name)
    {
        return Err(refusal);
    }
    let program = locate_sbx(inner)?;
    let (temp, ctx) = exec_context(inner)?;
    version_gate(inner, &program, &ctx)?;
    identity_gate(inner, &program, &ctx, &plan)?;
    let exec = SbxCommandBuilder::exec(&program, &plan.sandbox_name, &plan.argv)
        .map_err(|e| invalid(format!("{e}; nothing was run")))?;
    let this = inner
        .self_weak
        .upgrade()
        .ok_or_else(|| SvcFailure::from(internal("Core is shutting down; nothing was run")))?;
    let run_id = uuid::Uuid::new_v4().to_string();
    // I-a: the writer lock through the scheduler (released), THEN the DB.
    let lock = match &plan.lock_key {
        Some(key) => Some(
            OwnedRepoLock::take(Arc::clone(&this), key, verification_lock_holder(&run_id))
                .map_err(|holder| conflict(msg_verification_repo_busy(key, &holder)))?,
        ),
        None => None,
    };
    if let Some(hook) = &inner.test_verification_before_start {
        (hook.0)(inner);
    }
    let slot = ChildSlot::new();
    let started = Instant::now();
    let started_sequence = {
        let db = inner.lock_db();
        let tx = db.conn().unchecked_transaction().map_err(db_err)?;
        recheck_in_tx(&tx, &p, &plan)?;
        if inner.sandbox_ops.is_held(&plan.sandbox_name) {
            return Err(conflict(format!(
                "another operation on sandbox {:?} is in progress; nothing was run",
                plan.sandbox_name
            )));
        }
        if let Some(refusal) = inner
            .verifications
            .admission_refusal(&p.task_id, &plan.sandbox_name)
        {
            return Err(refusal);
        }
        let now = now_rfc3339();
        let mode = workspace_mode_wire(&plan.mode);
        let event = EventLog::from_conn(&tx)
            .append(
                &p.task_id,
                EVENT_VERIFICATION_STARTED,
                &serde_json::json!({
                    "runId": run_id,
                    "commandId": p.command_id,
                    "label": plan.label,
                    "argv": plan.argv,
                    "sandbox": plan.sandbox_name,
                    "workspaceMode": mode,
                }),
                &now,
            )
            .map_err(|e| SvcFailure::from(internal(e)))?;
        let argv_json =
            serde_json::to_string(&plan.argv).map_err(|e| SvcFailure::from(internal(e)))?;
        tx.execute(
            "INSERT INTO verification_runs
                 (id, task_id, command_id, sandbox_name, workspace_mode, argv_json, label,
                  status, started_sequence, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, ?9)",
            params![
                run_id,
                p.task_id,
                p.command_id,
                plan.sandbox_name,
                mode,
                argv_json,
                plan.label,
                event.sequence,
                now
            ],
        )
        .map_err(db_err)?;
        if let Some(k) = &keyed {
            let result_json = serde_json::to_string(&VerificationRunResult {
                run_id: run_id.clone(),
                started_sequence: event.sequence,
                replayed: None,
            })
            .map_err(|e| SvcFailure::from(internal(e)))?;
            idempotency::prune(&tx, &idempotency_cutoff(), idempotency::MAX_ROWS)
                .map_err(db_err)?;
            if !idempotency::insert_done(&tx, k.method, &k.key, &k.hash, &result_json, &now)
                .map_err(db_err)?
            {
                // Lost the key race: EVERYTHING above rolls back (tx drops);
                // answer from the winner's row.
                drop(tx);
                drop(db);
                return k.answer_after_race(inner);
            }
        }
        tx.commit().map_err(db_err)?;
        // Registered under the same DB guard, only once the start is durable.
        inner.verifications.insert(
            run_id.clone(),
            RunEntry {
                task_id: p.task_id.clone(),
                project_id: plan.project_id.clone(),
                conversation_id: plan.conversation_id.clone(),
                sandbox_name: plan.sandbox_name.clone(),
                started_sequence: event.sequence,
                started,
                slot: Arc::clone(&slot),
            },
        );
        event.sequence
    };
    let (limits, grace) = run_limits(inner);
    let worker = Worker {
        inner: Arc::clone(&this),
        run_id: run_id.clone(),
        task_id: p.task_id.clone(),
        started_sequence,
        started,
        slot,
        grace,
        entered: false,
        done: false,
        _lock: lock,
        _temp: Some(temp),
    };
    let spawned = std::thread::Builder::new()
        .name(format!("verification-{run_id}"))
        .spawn(move || worker.run(exec, ctx, limits));
    if let Err(e) = spawned {
        // The worker (moved into the failed closure) was dropped before it
        // ran: its guard already wrote the `spawn_failed` terminal record.
        eprintln!("sandpane-service: verification {run_id}: worker thread not started: {e}");
    }
    to_value(VerificationRunResult {
        run_id,
        started_sequence,
        replayed: None,
    })
}

// ---------------------------------------------------------------------------
// The worker and the terminal record (R3)
// ---------------------------------------------------------------------------

/// What one terminal record says.
struct Terminal {
    outcome: &'static str,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    stdout_bytes: usize,
    stderr_bytes: usize,
    stdout_truncated: bool,
    stderr_truncated: bool,
    redactions: OutputRedaction,
    elapsed_ms: u64,
    /// W2: the process exited but its output was not fully drained.
    output_incomplete: bool,
}

impl Terminal {
    /// Nothing observed (spawn failure, worker failure).
    fn bare(outcome: &'static str, elapsed: Duration) -> Self {
        Self {
            outcome,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            stdout_bytes: 0,
            stderr_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            redactions: OutputRedaction::default(),
            output_incomplete: false,
            elapsed_ms: millis(elapsed),
        }
    }
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// Classify and redact a finished run (§3.7 item 6): output is decoded
/// lossily and redacted BEFORE storage; if the redactor is unavailable
/// nothing is stored and the result says so.
fn terminal_from(out: &process::PartialOutput) -> Terminal {
    let (outcome, exit_code) = vcore::classify(out);
    let mut counts = RedactionCounts::default();
    let redacted = vcore::redact_output(&out.stdout, &mut counts)
        .and_then(|so| vcore::redact_output(&out.stderr, &mut counts).map(|se| (so, se)));
    let (stdout, stderr, redactions) = match redacted {
        Ok((so, se)) => (
            so,
            se,
            OutputRedaction {
                best_effort: true,
                replacements: counts.total(),
                by_kind: counts
                    .by_kind()
                    .iter()
                    .map(|(k, v)| ((*k).to_string(), *v))
                    .collect(),
                output_withheld: None,
            },
        ),
        Err(_) => (
            String::new(),
            String::new(),
            OutputRedaction {
                output_withheld: Some(true),
                ..OutputRedaction::default()
            },
        ),
    };
    Terminal {
        outcome,
        exit_code,
        stdout,
        stderr,
        stdout_bytes: out.stdout.len(),
        stderr_bytes: out.stderr.len(),
        stdout_truncated: out.stdout_truncated,
        stderr_truncated: out.stderr_truncated,
        redactions,
        elapsed_ms: millis(out.elapsed),
        output_incomplete: out.output_incomplete,
    }
}

/// Write the run's terminal record IF it is still `running` (R3: the first
/// terminal record wins), append `verification.finished` only when a row
/// changed, and clear the registry entry — all under the DB guard. Returns
/// whether this call wrote the record.
fn write_terminal(
    inner: &ServerInner,
    run_id: &str,
    task_id: &str,
    started_sequence: i64,
    t: &Terminal,
) -> bool {
    let db = inner.lock_db();
    let write = || -> Result<bool, sandpane_core::DbError> {
        let tx = db.conn().unchecked_transaction()?;
        let now = now_rfc3339();
        let status = if t.outcome == vcore::OUTCOME_INTERRUPTED {
            "interrupted"
        } else {
            "finished"
        };
        let redactions_json = serde_json::to_string(&t.redactions).unwrap_or_default();
        let n = tx.execute(
            "UPDATE verification_runs SET status = ?2, outcome = ?3, exit_code = ?4,
                 stdout = ?5, stderr = ?6, stdout_truncated = ?7, stderr_truncated = ?8,
                 redactions_json = ?9, finished_at = ?10, elapsed_ms = ?11,
                 output_incomplete = ?12
             WHERE id = ?1 AND status = 'running'",
            params![
                run_id,
                status,
                t.outcome,
                t.exit_code,
                t.stdout,
                t.stderr,
                t.stdout_truncated,
                t.stderr_truncated,
                redactions_json,
                now,
                i64::try_from(t.elapsed_ms).unwrap_or(i64::MAX),
                t.output_incomplete
            ],
        )?;
        if n == 0 {
            return Ok(false);
        }
        let mut payload = serde_json::json!({
            "runId": run_id,
            "startedSequence": started_sequence,
            "outcome": t.outcome,
            "stdoutBytes": t.stdout_bytes,
            "stderrBytes": t.stderr_bytes,
            "stdoutTruncated": t.stdout_truncated,
            "stderrTruncated": t.stderr_truncated,
            "redactions": t.redactions,
            "elapsedMs": t.elapsed_ms,
        });
        if let Some(code) = t.exit_code {
            payload["exitCode"] = serde_json::json!(code);
        }
        if t.output_incomplete {
            payload["outputIncomplete"] = serde_json::json!(true);
        }
        EventLog::from_conn(&tx).append(task_id, EVENT_VERIFICATION_FINISHED, &payload, &now)?;
        tx.commit()?;
        Ok(true)
    };
    let wrote = write().unwrap_or_else(|e| {
        eprintln!(
            "sandpane-service: verification {run_id}: terminal record not written ({e}); the run \
             stays running until Core restarts and reconciles it as interrupted"
        );
        false
    });
    inner.verifications.remove(run_id);
    wrote
}

/// Mark one in-flight run interrupted (graceful shutdown): conditional, no
/// output counts. Caller holds nothing; this takes the DB guard.
fn write_interrupted(
    conn: &Connection,
    run_id: &str,
    task_id: &str,
    started_sequence: i64,
    elapsed: Duration,
) -> Result<bool, sandpane_core::DbError> {
    let tx = conn.unchecked_transaction()?;
    let now = now_rfc3339();
    let n = tx.execute(
        "UPDATE verification_runs SET status = 'interrupted', outcome = ?2, finished_at = ?3,
             elapsed_ms = ?4
         WHERE id = ?1 AND status = 'running'",
        params![
            run_id,
            vcore::OUTCOME_INTERRUPTED,
            now,
            i64::try_from(millis(elapsed)).unwrap_or(i64::MAX)
        ],
    )?;
    if n == 0 {
        return Ok(false);
    }
    EventLog::from_conn(&tx).append(
        task_id,
        EVENT_VERIFICATION_FINISHED,
        &serde_json::json!({
            "runId": run_id,
            "startedSequence": started_sequence,
            "outcome": vcore::OUTCOME_INTERRUPTED,
        }),
        &now,
    )?;
    tx.commit()?;
    Ok(true)
}

/// The worker. Owns the run's writer lock (`direct_mount`), its Core temp
/// directory and its process slot. DROP GUARD: dropped unfinished (a panic,
/// or a thread that never started) it stops the process group and writes a
/// terminal record, so the run never stays `running` and the registry is
/// cleared; the lock and the temp directory are released after that.
struct Worker {
    inner: Arc<ServerInner>,
    run_id: String,
    task_id: String,
    started_sequence: i64,
    started: Instant,
    slot: Arc<ChildSlot>,
    grace: Duration,
    /// `run` was entered (a drop before that means nothing was spawned).
    entered: bool,
    done: bool,
    _lock: Option<OwnedRepoLock>,
    _temp: Option<CoreTemp>,
}

impl Worker {
    fn run(mut self, exec: SbxCommand, ctx: SbxExecContext, limits: RunLimits) {
        self.entered = true;
        let terminal =
            match process::run_partial(exec.command_in(&ctx), &limits, self.grace, &self.slot) {
                Ok(out) => terminal_from(&out),
                Err(_) => Terminal::bare(vcore::OUTCOME_SPAWN_FAILED, self.started.elapsed()),
            };
        write_terminal(
            &self.inner,
            &self.run_id,
            &self.task_id,
            self.started_sequence,
            &terminal,
        );
        self.done = true;
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        // Never entered: nothing was spawned. Entered: Core lost sight of
        // the run (a panic) — `read_failed`, and its group is stopped.
        let outcome = if self.entered {
            process::terminate_slots(std::slice::from_ref(&self.slot), self.grace);
            vcore::OUTCOME_READ_FAILED
        } else {
            vcore::OUTCOME_SPAWN_FAILED
        };
        write_terminal(
            &self.inner,
            &self.run_id,
            &self.task_id,
            self.started_sequence,
            &Terminal::bare(outcome, self.started.elapsed()),
        );
    }
}

// ---------------------------------------------------------------------------
// Graceful shutdown and restart reconciliation (§3.7 item 5, W3)
// ---------------------------------------------------------------------------

impl ServerInner {
    /// Graceful shutdown of every verification in flight: under the DB guard,
    /// refuse new starts and append a terminal `verification.finished
    /// {outcome: "interrupted"}` for each run (conditional: a run that
    /// finished first keeps its own record); then, with NO lock held,
    /// SIGTERM each process group, wait up to `grace`, SIGKILL. Returns the
    /// number of runs interrupted by this call.
    pub fn shutdown_verifications(&self, grace: Duration) -> usize {
        let (slots, interrupted) = {
            let db = self.lock_db();
            let entries: Vec<(String, RunEntry)> = {
                let mut st = self.verifications.lock();
                st.shutting_down = true;
                st.runs
                    .iter()
                    .map(|(id, e)| (id.clone(), e.clone()))
                    .collect()
            };
            let mut interrupted = 0;
            for (run_id, e) in &entries {
                match write_interrupted(
                    db.conn(),
                    run_id,
                    &e.task_id,
                    e.started_sequence,
                    e.started.elapsed(),
                ) {
                    Ok(true) => interrupted += 1,
                    Ok(false) => {}
                    Err(err) => eprintln!(
                        "sandpane-service: verification {run_id}: interrupted record not \
                         written at shutdown ({err}); restart reconciliation will close it"
                    ),
                }
            }
            let slots: Vec<Arc<ChildSlot>> = entries.into_iter().map(|(_, e)| e.slot).collect();
            (slots, interrupted)
        };
        // DB guard released: never held across the grace period.
        process::terminate_slots(&slots, grace);
        interrupted
    }
}

/// Restart reconciliation (§3.7 item 5, W3): a `verification.started` with
/// no `verification.finished` naming its `startedSequence` (A6 I2) belongs
/// to a dead Core. It gets `verification.finished {outcome: "interrupted",
/// reconciledAfterRestart: true}` and its row becomes `interrupted`, in one
/// transaction. Stale pids are never signalled. Any database failure is an
/// error: Core does not serve (A2 item 7).
pub fn reconcile_verifications_after_restart(
    db: &sandpane_core::Database,
) -> Result<Vec<String>, ReconciliationFailed> {
    let fail = |what: &str, e: &dyn std::fmt::Display| {
        ReconciliationFailed(format!(
            "verification restart reconciliation failed ({what}): {e}"
        ))
    };
    let rows: Vec<(String, i64, String, String)> = {
        let mut stmt = db
            .conn()
            .prepare(
                "SELECT task_id, sequence, kind, payload FROM task_events
                 WHERE kind IN (?1, ?2) ORDER BY task_id, sequence",
            )
            .map_err(|e| fail("prepare", &e))?;
        let rows = stmt
            .query_map(
                params![EVENT_VERIFICATION_STARTED, EVENT_VERIFICATION_FINISHED],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|e| fail("query", &e))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| fail("read row", &e))?
    };
    let closed: HashSet<(String, i64)> = rows
        .iter()
        .filter(|(_, _, kind, _)| kind == EVENT_VERIFICATION_FINISHED)
        .filter_map(|(task, _, _, payload)| {
            let v: serde_json::Value = serde_json::from_str(payload).ok()?;
            Some((task.clone(), v.get("startedSequence")?.as_i64()?))
        })
        .collect();
    let mut out = Vec::new();
    for (task_id, sequence, kind, payload) in rows {
        if kind != EVENT_VERIFICATION_STARTED || closed.contains(&(task_id.clone(), sequence)) {
            continue;
        }
        let run_id = serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|v| v.get("runId")?.as_str().map(str::to_string))
            .unwrap_or_default();
        let now = now_rfc3339();
        let tx = db
            .conn()
            .unchecked_transaction()
            .map_err(|e| fail("begin", &e))?;
        let step = (|| -> Result<(), sandpane_core::DbError> {
            tx.execute(
                "UPDATE verification_runs SET status = 'interrupted', outcome = ?2,
                     finished_at = ?3
                 WHERE id = ?1 AND status = 'running'",
                params![run_id, vcore::OUTCOME_INTERRUPTED, now],
            )?;
            EventLog::from_conn(&tx).append(
                &task_id,
                EVENT_VERIFICATION_FINISHED,
                &serde_json::json!({
                    "runId": run_id,
                    "startedSequence": sequence,
                    "outcome": vcore::OUTCOME_INTERRUPTED,
                    "reconciledAfterRestart": true,
                }),
                &now,
            )?;
            Ok(())
        })();
        step.and_then(|()| tx.commit().map_err(sandpane_core::DbError::from))
            .map_err(|e| fail(&format!("task {task_id}"), &e))?;
        eprintln!(
            "sandpane-service: task {task_id}: verification {run_id} was running when Core \
             stopped; recorded as interrupted (the command may still be running inside the \
             sandbox)"
        );
        out.push(run_id);
    }
    // A `running` row with no open start (cannot happen: row and event share
    // one transaction) would be served as running forever: close it too.
    let n = db
        .conn()
        .execute(
            "UPDATE verification_runs SET status = 'interrupted', outcome = ?1, finished_at = ?2
             WHERE status = 'running'",
            params![vcore::OUTCOME_INTERRUPTED, now_rfc3339()],
        )
        .map_err(|e| fail("orphaned rows", &e))?;
    if n > 0 {
        eprintln!("sandpane-service: {n} verification run row(s) without a start event closed");
    }
    Ok(out)
}
