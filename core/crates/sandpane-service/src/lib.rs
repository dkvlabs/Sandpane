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

pub mod confirm;
mod conversation_lifecycle;
pub use conversation_lifecycle::{
    CONVERSATION_DELETE_ACTION, MSG_CONVERSATION_ARCHIVED, MSG_CONVERSATION_HAS_TASKS,
    MSG_CONVERSATION_NOT_FOUND, MSG_TITLE_BLANK, UNTITLED_CONVERSATION,
};
pub mod inflight;
mod project_lifecycle;
pub use project_lifecycle::{
    MSG_PROJECT_ARCHIVED, MSG_PROJECT_CREATE_IN_FLIGHT, MSG_PROJECT_HAS_SANDBOXES,
    MSG_PROJECT_HAS_TASKS, MSG_PROJECT_NOT_FOUND, MSG_REPOSITORY_IN_USE,
    MSG_REPOSITORY_NOT_REGISTERED, MSG_REPOSITORY_REMOVE_WHILE_CREATING,
    MSG_REPOSITORY_UNREGISTERED_DURING_CREATE, MSG_UPDATE_NEEDS_A_FIELD, PROJECT_DELETE_ACTION,
};
pub mod runtime;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::params;
use sandpane_core::idempotency::{self, Lookup};
use sandpane_core::process::RunLimits;
use sandpane_core::sbx::{
    classify_failure, parse_daemon_status_json, parse_list_json, RemovalConfirmation,
    SbxCommandBuilder, SbxListEntry, SbxLocator, SbxSandboxStatus, SbxVersion, SbxWorkspace,
};
use sandpane_core::scheduler::{Admission, Scheduler};
use sandpane_core::task::{TaskStateMachine, ALL_STATUSES};
use sandpane_core::validation::Validator;
use sandpane_core::workspace::{self, WorkspaceError};
use sandpane_core::{git as scoregit, Database, EventLog};
use sandpane_protocol::{
    AgentCapability, AgentEvent, ApplyResult, ChangeSet, ConfirmationRequest, ConfirmationTarget,
    ConversationCreateParams, ConversationDeleteParams, ConversationExportParams,
    ConversationHistoryParams, ConversationHistoryResult, ConversationIdParams,
    ConversationListParams, ConversationRenameParams, ConversationSendParams, CoreCapabilities,
    ErrorCode, FileChange, FileChangeStatus, GitApplyParams, MessageRecord, Method, Project,
    ProjectCreateParams, ProjectDeleteParams, ProjectIdParams, ProjectRepositoryParams,
    ProjectUpdateParams, RpcRequest, RpcResponse, SandboxCreateSpec, SandboxRemoveParams,
    SandboxRemoveResult, SandboxStopParams, SandboxStopResult, SandboxSummary, SbxStatus,
    TaskEvent, TaskListParams, TaskStatus, TaskSubscribeParams, TaskSummary, WorkspaceMode,
    CORE_VERSION, PROTOCOL_VERSION,
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

/// Bounds for each class of sbx invocation (see [`RunLimits`]).
#[derive(Debug, Clone, Copy)]
pub struct SbxLimits {
    pub probe: RunLimits,
    pub query: RunLimits,
    pub mutation: RunLimits,
}

impl Default for SbxLimits {
    fn default() -> Self {
        Self {
            probe: RunLimits::PROBE,
            query: RunLimits::QUERY,
            mutation: RunLimits::MUTATION,
        }
    }
}

/// Construction-time configuration for [`ServerInner`].
/// TEST SEAM (review C1): called by `sandbox.create` right after its key
/// claim commits and BEFORE the per-project in-flight guard is taken — the
/// window in which a concurrent `project.archive` / `project.delete` /
/// `project.remove_repository` can land, forcing the post-claim re-check to
/// refuse. No Core lock is held when it runs, so it may issue requests.
/// Production (`main.rs`) never sets it.
#[derive(Clone)]
pub struct CreateClaimHook(pub Arc<dyn Fn(&ServerInner) + Send + Sync>);

impl std::fmt::Debug for CreateClaimHook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CreateClaimHook(..)")
    }
}

/// TEST SEAM for the A3b paths (`CoreConfig::test_before_task_write`,
/// `CoreConfig::test_before_export_redaction`). Called with NO Core lock
/// held, so it may issue requests. Production (`main.rs`) never sets one.
#[derive(Clone)]
pub struct TestHook(pub Arc<dyn Fn(&ServerInner) + Send + Sync>);

impl std::fmt::Debug for TestHook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TestHook(..)")
    }
}

#[derive(Debug, Clone, Default)]
pub struct CoreConfig {
    pub sbx_limits: SbxLimits,
    /// Core-owned directory that holds per-task Git worktrees
    /// (`<data_dir>/worktrees`, created 0700 on first use). `None` = worktree
    /// allocation is unavailable and refused with a structured error (tests
    /// and embedders that never asked for it).
    pub worktrees_root: Option<PathBuf>,
    /// CANDIDATE for the user's own global excludes file (resolved by
    /// `main.rs` with `sandpane_core::git::user_excludes_candidate`, i.e.
    /// from global git config only). Vetted at startup by
    /// `accept_excludes_file` against every registered repository and the
    /// worktree root; rejected or `None` → `/dev/null` (fail safe). Re-vetted
    /// whenever `project.create` registers repositories, and revoked for good
    /// if one of them contains it.
    pub user_excludes_file: Option<PathBuf>,
    /// Lifetime of destructive-action confirmation tokens. `None` = the design
    /// value [`confirm::CONFIRMATION_TTL`] (120 s); a value is CLAMPED to at
    /// most that, so configuration can only shorten it (tests use zero to
    /// prove expiry without sleeping out the full window).
    pub confirmation_ttl: Option<std::time::Duration>,
    /// Test seam only — see [`CreateClaimHook`]. `None` in production.
    #[doc(hidden)]
    pub test_after_create_claim: Option<CreateClaimHook>,
    /// Test seam only (A3b): called by `conversation.send` / [`create_task`]
    /// AFTER the early conversation check and BEFORE the task's write
    /// transaction — the window in which a concurrent `conversation.archive`
    /// or `conversation.delete` can land, forcing the in-transaction re-check
    /// to refuse. `None` in production.
    #[doc(hidden)]
    pub test_before_task_write: Option<TestHook>,
    /// Test seam only (A3b): called by `conversation.export` after the page
    /// was read and the DB mutex RELEASED, immediately before redaction runs.
    /// `None` in production.
    #[doc(hidden)]
    pub test_before_export_redaction: Option<TestHook>,
}

pub struct ServerInner {
    pub db: Mutex<Database>,
    pub scheduler: Mutex<Scheduler>,
    pub sbx_locator: SbxLocator,
    pub sbx_limits: SbxLimits,
    pub instance_id: String,
    pub git: scoregit::GitRunner,
    pub worktrees_root: Option<PathBuf>,
    /// Pending destructive-action confirmations (design 2026-10-09 §2):
    /// memory only, bounded, single-use; they die with Core.
    pub confirmations: Mutex<confirm::ConfirmationStore>,
    pub confirmation_ttl: std::time::Duration,
    /// Sandbox names with a create / confirmed remove in flight (review W2).
    pub sandbox_ops: inflight::SandboxOpLocks,
    /// `sandbox.create` calls in flight per project (A3a §3.2 item 4):
    /// `project.delete` refuses while a project's count is above zero.
    pub project_creates: inflight::ProjectCreates,
    /// Test seam ([`CreateClaimHook`]); `None` in production.
    test_after_create_claim: Option<CreateClaimHook>,
    /// Test seams ([`TestHook`]); `None` in production.
    test_before_task_write: Option<TestHook>,
    pub(crate) test_before_export_redaction: Option<TestHook>,
}

impl ServerInner {
    pub fn new(db: Database, sbx_locator: SbxLocator) -> Arc<Self> {
        Self::with_sbx_limits(db, sbx_locator, SbxLimits::default())
    }

    /// [`Self::new`] with explicit sbx limits (tests shrink the deadlines).
    pub fn with_sbx_limits(
        db: Database,
        sbx_locator: SbxLocator,
        sbx_limits: SbxLimits,
    ) -> Arc<Self> {
        Self::with_config(
            db,
            sbx_locator,
            CoreConfig {
                sbx_limits,
                ..CoreConfig::default()
            },
        )
    }

    /// [`Self::try_with_config`] for tests and embedders that treat a failed
    /// restart reconciliation as a bug: it panics with the reason instead of
    /// serving unreconciled state. `main.rs` uses the fallible form.
    pub fn with_config(db: Database, sbx_locator: SbxLocator, config: CoreConfig) -> Arc<Self> {
        Self::try_with_config(db, sbx_locator, config)
            .unwrap_or_else(|e| panic!("sandpane-service: refusing to start: {e}"))
    }

    /// Full constructor (`main.rs` passes `<data_dir>/worktrees`).
    ///
    /// FAIL CLOSED (A2 review W3): if restart reconciliation cannot be made
    /// durable — tasks to `interrupted`, `pending` idempotency keys to
    /// `unknown` — this returns an error and no server exists. Serving
    /// anyway would let a dead daemon's `running` task or `pending` key be
    /// observed (or retried) as if it were live.
    pub fn try_with_config(
        db: Database,
        sbx_locator: SbxLocator,
        config: CoreConfig,
    ) -> Result<Arc<Self>, ReconciliationFailed> {
        // RESTART RECONCILIATION (specs/02 §1/§4, T09): any task row left in
        // an in-flight state belongs to a dead daemon instance. Every such
        // task becomes `interrupted` — durable event + row update — BEFORE
        // any client can observe it. Nothing is ever auto-resumed, and the
        // scheduler starts empty alongside it.
        reconcile_after_restart(&db)?;
        // A2 (§3.1 items 6, 8): same rule for idempotency claims — a
        // `pending` row belongs to a dead Core, so its outcome is `unknown`,
        // never fabricated; then retention runs. Before any client connects.
        reconcile_idempotency_after_restart(&db)?;
        let excludes_file = vetted_excludes_file(
            &db,
            config.user_excludes_file.as_deref(),
            config.worktrees_root.as_deref(),
        );
        let inner = Arc::new(Self {
            db: Mutex::new(db),
            scheduler: Mutex::new(Scheduler::reconciliation_baseline()),
            sbx_locator,
            sbx_limits: config.sbx_limits,
            instance_id: uuid::Uuid::new_v4().to_string(),
            git: scoregit::GitRunner::with_excludes_file(excludes_file),
            worktrees_root: config.worktrees_root,
            confirmations: Mutex::new(confirm::ConfirmationStore::new()),
            sandbox_ops: inflight::SandboxOpLocks::new(),
            project_creates: inflight::ProjectCreates::new(),
            test_after_create_claim: config.test_after_create_claim,
            test_before_task_write: config.test_before_task_write,
            test_before_export_redaction: config.test_before_export_redaction,
            confirmation_ttl: config
                .confirmation_ttl
                .unwrap_or(confirm::CONFIRMATION_TTL)
                .min(confirm::CONFIRMATION_TTL),
        });
        // Read-only: report what a crash may have left behind; never delete.
        if inner.worktrees_root.is_some() {
            let orphans = report_orphaned_task_workspaces(&inner);
            for dir in &orphans.worktree_dirs {
                eprintln!(
                    "sandpane-service: worktree directory {} has no live task; left in place \
                     (inspect and remove it manually if it holds nothing you need)",
                    dir.display()
                );
            }
            for (repo, branch) in &orphans.branches {
                eprintln!(
                    "sandpane-service: branch {branch} in {repo} has no live task; left in place"
                );
            }
        }
        Ok(inner)
    }

    /// Poison-tolerant locking: one panicked handler must not brick the
    /// daemon for every other client (specs/02 §1 "Core outlives clients").
    pub fn lock_db(&self) -> MutexGuard<'_, Database> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn lock_scheduler(&self) -> MutexGuard<'_, Scheduler> {
        self.scheduler.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn lock_confirmations(&self) -> MutexGuard<'_, confirm::ConfirmationStore> {
        self.confirmations.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Locations an excludes file must not lie in: every registered repository,
/// plus `extra` (repositories about to be registered) and Core's worktree
/// root — all agent-writable.
fn excludes_forbidden_roots(
    db: &Database,
    extra: &[String],
    worktrees_root: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    let mut stmt = db
        .conn()
        .prepare("SELECT canonical_path FROM repositories")
        .map_err(|e| format!("repository query: {e}"))?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| format!("repository query: {e}"))?;
    let mut forbidden = Vec::new();
    for row in rows {
        forbidden.push(PathBuf::from(
            row.map_err(|e| format!("repository query: {e}"))?,
        ));
    }
    forbidden.extend(extra.iter().map(PathBuf::from));
    if let Some(root) = worktrees_root {
        forbidden.push(root.to_path_buf());
    }
    Ok(forbidden)
}

fn current_uid() -> u32 {
    #[cfg(unix)]
    let uid = runtime::euid();
    #[cfg(not(unix))]
    let uid = 0;
    uid
}

/// Vet the user-excludes candidate at startup. Forbidden locations are every
/// registered repository and Core's worktree root (agent-writable). A
/// rejection is reported ONCE on stderr and falls back to `/dev/null`.
/// [`revet_excludes_for_new_repositories`] repeats the check on registration.
fn vetted_excludes_file(
    db: &Database,
    candidate: Option<&Path>,
    worktrees_root: Option<&Path>,
) -> PathBuf {
    let fallback = PathBuf::from("/dev/null");
    let Some(candidate) = candidate else {
        return fallback;
    };
    let forbidden = match excludes_forbidden_roots(db, &[], worktrees_root) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("sandpane-service: user excludes not used ({e})");
            return fallback;
        }
    };
    match scoregit::accept_excludes_file(candidate, &forbidden, current_uid()) {
        Ok(accepted) => accepted,
        Err(reason) => {
            eprintln!(
                "sandpane-service: not using global excludes file {}: {reason}; reviews and the \
                 dirty gate ignore NO extra files (fail safe)",
                candidate.display()
            );
            fallback
        }
    }
}

/// Re-vet the excludes file in force against the CURRENT repositories plus
/// `new_repositories` (about to be registered) and the worktree root. A
/// repository registered after startup may contain the user's global excludes
/// file (a dotfiles repo); an agent writing there must not decide what the
/// reviews and dirty gates of OTHER repositories ignore. On any failure the
/// file is revoked for every repository (one-way, fail safe) and reported once.
/// The per-call lexical guard in [`scoregit::GitRunner::effective_excludes`]
/// stays as a second line.
fn revet_excludes_for_new_repositories(
    inner: &ServerInner,
    db: &Database,
    new_repositories: &[String],
) {
    let current = inner.git.active_excludes_file();
    if current == Path::new("/dev/null") {
        return;
    }
    let verdict = excludes_forbidden_roots(db, new_repositories, inner.worktrees_root.as_deref())
        .and_then(|forbidden| scoregit::accept_excludes_file(&current, &forbidden, current_uid()));
    if let Err(reason) = verdict {
        if inner.git.revoke_excludes() {
            eprintln!(
                "sandpane-service: no longer using global excludes file {}: {reason}; reviews and \
                 the dirty gate ignore NO extra files from now on (fail safe)",
                current.display()
            );
        }
    }
}

/// Stored names of the task statuses that cannot survive the process that
/// was driving them — DERIVED from [`TaskStateMachine::reconciled_on_restart`]
/// over every status (review 0015 bug 1: the old hand-written list missed
/// `verifying` and named `awaiting_input`, which then had no legal edge and
/// was silently skipped).
pub fn reconcilable_statuses() -> Vec<String> {
    ALL_STATUSES
        .iter()
        .copied()
        .filter(|s| TaskStateMachine::reconciled_on_restart(*s))
        .filter_map(|s| task_status_stored(s).ok())
        .collect()
}

/// Restart reconciliation could not be made durable; Core must not serve
/// (A2 review W3). The message names what failed (never row contents).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciliationFailed(pub String);

impl std::fmt::Display for ReconciliationFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ReconciliationFailed {}

/// Marks every in-flight task `interrupted` with a durable event. Returns the
/// affected task ids (used by main.rs startup logging and tests).
///
/// Any database failure is an error (fail closed, review W3): a task left
/// `running` by a dead daemon must never be served as if it were live. A row
/// whose status Core cannot parse is not in-flight by definition and is
/// skipped with a log line.
pub fn reconcile_after_restart(db: &Database) -> Result<Vec<String>, ReconciliationFailed> {
    let fail = |what: &str, e: &dyn std::fmt::Display| {
        ReconciliationFailed(format!("task restart reconciliation failed ({what}): {e}"))
    };
    let mut out = Vec::new();
    let statuses = reconcilable_statuses();
    let placeholders = statuses.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let stale: Vec<(String, String)> = {
        let mut stmt = db
            .conn()
            .prepare(&format!(
                "SELECT id, status FROM tasks WHERE status IN ({placeholders}) ORDER BY created_at"
            ))
            .map_err(|e| fail("prepare", &e))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(statuses.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| fail("query", &e))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| fail("read row", &e))?
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
            // Unreachable: `reconcilable_statuses` is derived from the same
            // table. Refusing here would be a state-machine bug, not data.
            return Err(ReconciliationFailed(format!(
                "task restart reconciliation refused for {task_id} ({status_str})"
            )));
        }
        let now = now_rfc3339();
        let tx = db
            .conn()
            .unchecked_transaction()
            .map_err(|e| fail("begin", &e))?;
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
        step.and_then(|()| tx.commit().map_err(sandpane_core::DbError::from))
            .map_err(|e| fail(&format!("task {task_id}"), &e))?;
        out.push(task_id);
    }
    if !out.is_empty() {
        eprintln!(
            "sandpane-service: reconciled {} stale task(s) to interrupted: {}",
            out.len(),
            out.join(", ")
        );
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Idempotency keys (A2, design 2026-10-09 §3.1)
//
// INVARIANT: a replay — any request whose key is already stored — never runs
// sbx and never writes a second message/task/event. It is answered from the
// `idempotency_keys` row alone: the stored result (`done`, same params) or one
// of the three CONFLICT messages below. No new error code is introduced.
// ---------------------------------------------------------------------------

pub const IDEM_MSG_MISMATCH: &str =
    "idempotency key was already used with different parameters; nothing was run";
pub const IDEM_MSG_PENDING: &str =
    "an operation with this idempotency key is still in progress; nothing was run";
pub const IDEM_MSG_UNKNOWN: &str = "the outcome of the earlier request with this idempotency key \
     is unknown (Core restarted or sbx failed while it ran); re-read state before retrying with \
     a new key";

/// Startup half of §3.1 items 6 and 8: `pending` → `unknown`, then prune.
///
/// FAIL CLOSED (review W3): if `pending` rows cannot be marked `unknown`,
/// this is an error and Core does not serve — a dead Core's claim would
/// otherwise read as "in progress" (or, after expiry, as free). A failed
/// PRUNE only logs: it deletes old `done`/`unknown` rows, so leaving them
/// changes nothing a client can observe except the table size, and the next
/// claim prunes again.
pub fn reconcile_idempotency_after_restart(db: &Database) -> Result<(), ReconciliationFailed> {
    let now = now_rfc3339();
    match idempotency::reconcile_pending_to_unknown(db.conn(), &now) {
        Ok(0) => {}
        Ok(n) => eprintln!(
            "sandpane-service: {n} idempotency key(s) were in flight when Core stopped; \
             marked unknown (refused with that key for the 24 h retention window)"
        ),
        Err(e) => {
            return Err(ReconciliationFailed(format!(
                "idempotency restart reconciliation failed (pending -> unknown): {e}"
            )))
        }
    }
    if let Err(e) = idempotency::prune(db.conn(), &idempotency_cutoff(), idempotency::MAX_ROWS) {
        eprintln!(
            "sandpane-service: idempotency retention prune failed: {e} \
             (expired keys kept; the next keyed request prunes again)"
        );
    }
    Ok(())
}

/// RFC 3339 instant before which stored keys are expired (24 h).
fn idempotency_cutoff() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    rfc3339_from_unix(now.saturating_sub(idempotency::RETENTION_SECS))
}

/// A validated key plus the fingerprint of the typed params it guards.
struct KeyedCall {
    method: &'static str,
    key: String,
    hash: String,
}

/// Validate `key` (VALIDATION_FAILED before anything runs) and fingerprint
/// the typed params. `without_key` must be the params with the key removed.
fn keyed_call<T: serde::Serialize>(
    method: Method,
    key: Option<&str>,
    without_key: &T,
) -> Result<Option<KeyedCall>, SvcFailure> {
    let Some(key) = key else { return Ok(None) };
    Validator::idempotency_key(key).map_err(|e| {
        SvcFailure::from((ErrorCode::ValidationFailed, format!("idempotencyKey: {e}")))
    })?;
    let hash = idempotency::fingerprint(without_key).map_err(internal)?;
    Ok(Some(KeyedCall {
        method: method.as_str(),
        key: key.to_string(),
        hash,
    }))
}

impl KeyedCall {
    /// The stored answer for this key, or `None` when the key is free.
    fn stored_answer(&self, inner: &ServerInner) -> Option<Result<serde_json::Value, SvcFailure>> {
        let found = {
            let db = inner.lock_db();
            idempotency::lookup(db.conn(), self.method, &self.key, &self.hash)
        };
        let conflict = |m: &str| Some(Err(SvcFailure::from((ErrorCode::Conflict, m.to_string()))));
        match found {
            Err(e) => Some(Err(internal(e).into())),
            Ok(Lookup::Absent) => None,
            Ok(Lookup::Done(json)) => Some(replay_of(&json)),
            Ok(Lookup::ParamsMismatch) => conflict(IDEM_MSG_MISMATCH),
            Ok(Lookup::Pending) => conflict(IDEM_MSG_PENDING),
            Ok(Lookup::Unknown) => conflict(IDEM_MSG_UNKNOWN),
        }
    }

    /// After losing an insert race the row exists: answer from it. (Absent
    /// again would mean it was released meanwhile — reported as in progress
    /// rather than re-run.)
    fn answer_after_race(&self, inner: &ServerInner) -> Result<serde_json::Value, SvcFailure> {
        self.stored_answer(inner).unwrap_or_else(|| {
            Err(SvcFailure::from((
                ErrorCode::Conflict,
                IDEM_MSG_PENDING.to_string(),
            )))
        })
    }
}

/// A replay (review W1): the FIRST response exactly as stored, plus
/// `"replayed": true`. The stored JSON never carries the marker (the first
/// response serializes `replayed: None` as absent), so it is added here and
/// only here. A replay is not current state: clients re-read with
/// `task.list` / `sandbox.list`.
fn replay_of(stored: &str) -> Result<serde_json::Value, SvcFailure> {
    let mut v: serde_json::Value = serde_json::from_str(stored).map_err(|e| {
        SvcFailure::from(internal(format!(
            "stored idempotent result unreadable: {e}"
        )))
    })?;
    match v.as_object_mut() {
        Some(obj) => {
            obj.insert("replayed".to_string(), serde_json::Value::Bool(true));
            Ok(v)
        }
        None => Err(internal("stored idempotent result is not an object").into()),
    }
}

/// A committed `pending` claim (`sandbox.create`, §3.1 item 4). Resolved
/// explicitly — `done` inside the binding transaction ([`Self::disarm`]
/// afterwards), [`Self::release`] when nothing ran, [`Self::unknown`] when sbx
/// may have acted. BACKSTOP: dropped unresolved (a panic mid-operation),
/// it marks the row `unknown`, so it is not reported as "in progress" for
/// the life of the process and is not re-run with that key within the 24 h
/// retention window.
struct PendingClaim<'a> {
    inner: &'a ServerInner,
    method: &'static str,
    key: String,
    resolved: bool,
}

enum ClaimOutcome<'a> {
    Claimed(PendingClaim<'a>),
    /// Lost the race to a concurrent request: its stored answer.
    Answered(Result<serde_json::Value, SvcFailure>),
}

impl KeyedCall {
    /// Prune, then commit a `pending` claim — a short transaction of its own;
    /// the DB lock is released before any subprocess runs.
    fn claim<'a>(&self, inner: &'a ServerInner) -> Result<ClaimOutcome<'a>, SvcFailure> {
        let won = {
            let db = inner.lock_db();
            let tx = db.conn().unchecked_transaction().map_err(internal)?;
            idempotency::prune(&tx, &idempotency_cutoff(), idempotency::MAX_ROWS)
                .map_err(internal)?;
            let won = idempotency::claim(&tx, self.method, &self.key, &self.hash, &now_rfc3339())
                .map_err(internal)?;
            tx.commit().map_err(internal)?;
            won
        };
        if !won {
            return Ok(ClaimOutcome::Answered(self.answer_after_race(inner)));
        }
        Ok(ClaimOutcome::Claimed(PendingClaim {
            inner,
            method: self.method,
            key: self.key.clone(),
            resolved: false,
        }))
    }
}

impl PendingClaim<'_> {
    /// Nothing ran: delete the claim so the key stays retryable.
    ///
    /// On failure the row stays `pending` — FAIL CLOSED: the key is refused
    /// as "in progress" (nothing re-runs) until restart reconciliation marks
    /// it `unknown`.
    fn release(mut self) {
        self.resolved = true;
        let db = self.inner.lock_db();
        if let Err(e) = idempotency::release(db.conn(), self.method, &self.key) {
            eprintln!(
                "sandpane-service: releasing idempotency claim for {} failed: {e}; the key stays \
                 pending (refused as in progress, nothing re-runs) until Core restarts and marks \
                 it unknown",
                self.method
            );
        }
    }

    /// sbx may have acted: `unknown` — refused with this key within the 24 h
    /// retention window.
    fn unknown(mut self) {
        self.resolved = true;
        mark_claim_unknown(self.inner, self.method, &self.key);
    }

    /// Completed as `done` inside the caller's transaction.
    fn disarm(mut self) {
        self.resolved = true;
    }
}

impl Drop for PendingClaim<'_> {
    fn drop(&mut self) {
        if !self.resolved {
            mark_claim_unknown(self.inner, self.method, &self.key);
        }
    }
}

/// On failure the row stays `pending` — FAIL CLOSED: refused as "in
/// progress" (nothing re-runs) until restart reconciliation marks it
/// `unknown` (and if THAT fails, Core refuses to start).
fn mark_claim_unknown(inner: &ServerInner, method: &str, key: &str) {
    let db = inner.lock_db();
    if let Err(e) = idempotency::mark_unknown(db.conn(), method, key, &now_rfc3339()) {
        eprintln!(
            "sandpane-service: marking idempotency claim for {method} unknown failed: {e}; the \
             key stays pending (refused as in progress, nothing re-runs) until Core restarts and \
             marks it unknown"
        );
    }
}

/// The send-side write (§3.1 item 3): inserted as `done` INSIDE
/// `write_new_task`'s transaction.
pub(crate) struct KeyedWrite<'a> {
    method: &'static str,
    key: &'a str,
    hash: &'a str,
    result_json: String,
}

/// Why a task write produced nothing (review I4: a typed variant, not a
/// message match).
#[derive(Debug)]
enum TaskWriteError {
    /// An ordinary failure, sent to the client as is.
    Failed(SvcFailure),
    /// `write_new_task` lost the key insert race to a concurrent request with
    /// the same key and rolled the WHOLE write back. Never sent to a client:
    /// the caller re-answers from the winner's row.
    KeyRace,
}

impl From<SvcFailure> for TaskWriteError {
    fn from(f: SvcFailure) -> Self {
        Self::Failed(f)
    }
}

impl From<SvcError> for TaskWriteError {
    fn from(e: SvcError) -> Self {
        Self::Failed(e.into())
    }
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
    let result: Result<serde_json::Value, SvcFailure> = match method {
        Method::SystemProbe => system_probe(inner).map_err(Into::into),
        Method::ProjectCreate => parse_params::<ProjectCreateParams>(params)
            .and_then(|p| project_create(inner, p))
            .map_err(Into::into),
        Method::ProjectList => project_lifecycle::project_list(inner, params).map_err(Into::into),
        Method::ProjectUpdate => parse_params::<ProjectUpdateParams>(params)
            .and_then(|p| project_lifecycle::project_update(inner, p))
            .map_err(Into::into),
        Method::ProjectArchive => parse_params::<ProjectIdParams>(params)
            .and_then(|p| project_lifecycle::project_set_archived(inner, p, true))
            .map_err(Into::into),
        Method::ProjectUnarchive => parse_params::<ProjectIdParams>(params)
            .and_then(|p| project_lifecycle::project_set_archived(inner, p, false))
            .map_err(Into::into),
        Method::ProjectDelete => parse_params::<ProjectDeleteParams>(params)
            .map_err(SvcFailure::from)
            .and_then(|p| project_lifecycle::project_delete(inner, p)),
        Method::ProjectAddRepository => parse_params::<ProjectRepositoryParams>(params)
            .and_then(|p| project_lifecycle::project_add_repository(inner, p))
            .map_err(Into::into),
        Method::ProjectRemoveRepository => parse_params::<ProjectRepositoryParams>(params)
            .and_then(|p| project_lifecycle::project_remove_repository(inner, p))
            .map_err(Into::into),
        Method::SandboxList => sandbox_list(inner),
        Method::SandboxCreate => parse_params::<SandboxCreateSpec>(params)
            .map_err(SvcFailure::from)
            .and_then(|p| sandbox_create(inner, p)),
        Method::SandboxStop => parse_params::<SandboxStopParams>(params)
            .map_err(SvcFailure::from)
            .and_then(|p| sandbox_stop(inner, p)),
        Method::SandboxRemove => parse_params::<SandboxRemoveParams>(params)
            .map_err(SvcFailure::from)
            .and_then(|p| sandbox_remove(inner, p)),
        Method::ConversationCreate => parse_params::<ConversationCreateParams>(params)
            .and_then(|p| conversation_create(inner, p))
            .map_err(Into::into),
        Method::ConversationSend => parse_params::<ConversationSendParams>(params)
            .map_err(SvcFailure::from)
            .and_then(|p| conversation_send(inner, p)),
        Method::ConversationList => parse_params::<ConversationListParams>(params)
            .and_then(|p| conversation_list(inner, p))
            .map_err(Into::into),
        Method::ConversationHistory => parse_params::<ConversationHistoryParams>(params)
            .and_then(|p| conversation_history(inner, p))
            .map_err(Into::into),
        Method::ConversationRename => parse_params::<ConversationRenameParams>(params)
            .and_then(|p| conversation_lifecycle::conversation_rename(inner, p))
            .map_err(Into::into),
        Method::ConversationArchive => parse_params::<ConversationIdParams>(params)
            .and_then(|p| conversation_lifecycle::conversation_set_archived(inner, p, true))
            .map_err(Into::into),
        Method::ConversationUnarchive => parse_params::<ConversationIdParams>(params)
            .and_then(|p| conversation_lifecycle::conversation_set_archived(inner, p, false))
            .map_err(Into::into),
        Method::ConversationDelete => parse_params::<ConversationDeleteParams>(params)
            .map_err(SvcFailure::from)
            .and_then(|p| conversation_lifecycle::conversation_delete(inner, p)),
        Method::ConversationExport => parse_params::<ConversationExportParams>(params)
            .and_then(|p| conversation_lifecycle::conversation_export(inner, p))
            .map_err(Into::into),
        Method::TaskCancel => match string_param(&params, "taskId") {
            Some(t) => task_cancel(inner, t).map_err(Into::into),
            None => Err((ErrorCode::ValidationFailed, "taskId required".to_string()).into()),
        },
        Method::TaskList => parse_params::<TaskListParams>(params)
            .and_then(|p| task_list(inner, p))
            .map_err(Into::into),
        Method::TaskSubscribe => parse_params::<TaskSubscribeParams>(params)
            .and_then(|p| task_subscribe(inner, p))
            .map_err(Into::into),
        Method::GitReview => match string_param(&params, "taskId") {
            Some(t) => git_review(inner, t).map_err(Into::into),
            None => Err((ErrorCode::ValidationFailed, "taskId required".to_string()).into()),
        },
        Method::GitApply => parse_params::<GitApplyParams>(params)
            .and_then(|p| git_apply(inner, p))
            .map_err(Into::into),
    };
    match result {
        Ok(value) => RpcResponse::ok(id, value),
        Err(f) => {
            let mut resp = RpcResponse::err(id, f.code, f.message);
            if let sandpane_protocol::RpcOutcome::Err(e) = &mut resp.outcome {
                // `details` is part of the v1 error envelope already
                // (schemas/rpc-response.schema.json) — no wire change.
                e.details = f.details;
            }
            resp
        }
    }
}

type SvcError = (ErrorCode, String);

/// A structured failure that may carry `details` (remediation hints such as
/// `sbx login`). Every plain [`SvcError`] converts into one.
#[derive(Debug, Clone)]
pub struct SvcFailure {
    pub code: ErrorCode,
    pub message: String,
    pub details: Option<serde_json::Value>,
}

impl From<SvcError> for SvcFailure {
    fn from((code, message): SvcError) -> Self {
        Self {
            code,
            message,
            details: None,
        }
    }
}

impl From<sandpane_core::sbx::SbxFailure> for SvcFailure {
    fn from(f: sandpane_core::sbx::SbxFailure) -> Self {
        Self {
            code: f.code,
            message: f.message,
            details: Some(f.details),
        }
    }
}

/// The agent `sandbox.create` passes to `sbx create` when the spec names none
/// (`SandboxCreateSpec.agent` absent): the neutral, provider-free built-in
/// `shell` agent (the agent of the real captured CRUD round trip). A named
/// agent must be an EXACT built-in from the captured `create --help`
/// (`Validator::sbx_agent`); accepting a provider agent is never a claim that
/// Sandpane verified it — that is stated only by `system.probe` `agents`.
pub const DEFAULT_SANDBOX_AGENT: &str = "shell";

/// The action string `sandbox.remove` confirmation tokens are bound to.
pub const SANDBOX_REMOVE_ACTION: &str = "sandbox.remove";

/// Map a bounded-runner failure to a structured error.
fn process_failure(what: &str, e: sandpane_core::process::ProcessError) -> SvcFailure {
    SvcFailure::from((ErrorCode::Internal, format!("{what}: {e}")))
}

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

/// Version + daemon probe for an installed sbx: `sbx version` and
/// `sbx daemon status --json`, both under [`RunLimits::PROBE`] (3 s, 64 KiB each).
/// Deliberately NOT `sbx ls`, which auto-starts the daemon (captured
/// `state/ls_json_autostarts_daemon.txt`) — a probe must not change state.
/// Any failure (timeout, non-zero exit, unparseable output) reports the field
/// as unknown (`null`), never a guess.
pub fn probe_sbx(program: &Path, limits: &RunLimits) -> (Option<String>, Option<bool>) {
    let version = SbxCommandBuilder::version(program)
        .run(limits)
        .ok()
        .filter(|o| o.status.success() && !o.stdout_truncated)
        .and_then(|o| SbxVersion::parse(&o.stdout_lossy()).ok())
        .map(|v| v.to_string());
    let daemon_running = SbxCommandBuilder::daemon_status_json(program)
        .run(limits)
        .ok()
        .filter(|o| o.status.success() && !o.stdout_truncated)
        .and_then(|o| parse_daemon_status_json(&o.stdout_lossy()));
    (version, daemon_running)
}

fn system_probe(inner: &ServerInner) -> Result<serde_json::Value, SvcError> {
    // No DB lock is held while the probe subprocesses run.
    let sbx = match inner.sbx_locator.locate_with_source() {
        Ok((path, _source)) => {
            let (version, daemon_running) = probe_sbx(&path, &inner.sbx_limits.probe);
            SbxStatus {
                installed: true,
                // The RESOLVED binary (security S8). Its source (env override
                // vs PATH) has no v1 wire field; main.rs logs it at startup.
                binary_path: Some(path.display().to_string()),
                version,
                daemon_running,
            }
        }
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
        // Derived from the single const list, like `methods` (A2).
        features: sandpane_protocol::feature_names(),
    };
    serde_json::to_value(caps).map_err(internal)
}

/// Security W1: resolve a requested repository to the canonical path Core
/// will store. The path must exist, canonicalize (symlinks resolved), be the
/// TOP LEVEL of a Git work tree (hardened `git rev-parse --show-toplevel`), be
/// valid UTF-8, and pass [`Validator::registrable_repository`] (never `/`,
/// home or its ancestors, `~/.*`, or system trees). Registration is what later
/// authorizes a (possibly live-writable) mount, so it is fail-closed.
pub fn canonical_repository(
    git: &scoregit::GitRunner,
    raw: &str,
    home: &Path,
) -> Result<String, SvcError> {
    let requested = Path::new(raw);
    if !requested.is_absolute() {
        return Err((
            ErrorCode::ValidationFailed,
            format!("repository path must be absolute: {raw}"),
        ));
    }
    let canonical = std::fs::canonicalize(requested).map_err(|e| {
        (
            ErrorCode::ValidationFailed,
            format!("repository path not usable: {raw}: {e}"),
        )
    })?;
    let home_c = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    Validator::registrable_repository(&canonical, &home_c)
        .map_err(|e| (ErrorCode::PermissionDenied, e.to_string()))?;
    let toplevel = git.show_toplevel(&canonical).map_err(|e| {
        (
            ErrorCode::ValidationFailed,
            format!("{} is not a Git repository: {e}", canonical.display()),
        )
    })?;
    let toplevel_c = std::fs::canonicalize(&toplevel).unwrap_or(toplevel);
    if toplevel_c != canonical {
        return Err((
            ErrorCode::ValidationFailed,
            format!(
                "{} is inside a Git repository but is not its top level ({}); register the \
                 repository root",
                canonical.display(),
                toplevel_c.display()
            ),
        ));
    }
    canonical.to_str().map(str::to_string).ok_or_else(|| {
        (
            ErrorCode::ValidationFailed,
            "repository path must be valid UTF-8".to_string(),
        )
    })
}

fn project_create(
    inner: &ServerInner,
    p: ProjectCreateParams,
) -> Result<serde_json::Value, SvcError> {
    Validator::project_name(&p.name)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("project name: {e}")))?;
    // Resolve every repository BEFORE taking the DB lock (git subprocesses).
    let home = runtime::home_dir();
    let mut repositories = Vec::with_capacity(p.repositories.len());
    for repo in &p.repositories {
        let canonical = canonical_repository(&inner.git, repo, &home)?;
        if !repositories.contains(&canonical) {
            repositories.push(canonical);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339();
    let db = inner.lock_db();
    // Before any row exists (so before any task can target these
    // repositories): stop using an excludes file that lies inside one of them.
    revet_excludes_for_new_repositories(inner, &db, &repositories);
    // One transaction: project + repository rows are all-or-nothing.
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    tx.execute(
        "INSERT INTO projects (id, name, description, created_at) VALUES (?1,?2,?3,?4)",
        params![id, p.name, "", now],
    )
    .map_err(internal)?;
    for repo in &repositories {
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
        // The canonical paths Core actually stored (W1), not the raw input.
        repositories,
        archived_at: None,
    };
    serde_json::to_value(project).map_err(internal)
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

fn locate_sbx(inner: &ServerInner) -> Result<PathBuf, SvcFailure> {
    inner.sbx_locator.locate().map_err(|_| {
        SvcFailure::from((
            ErrorCode::NotInstalled,
            "sbx executable not found".to_string(),
        ))
    })
}

/// Run `sbx ls --json` and parse it. A non-zero exit is classified against
/// the captured error texts; truncated or unparseable output fails loudly.
fn sbx_list(
    program: &Path,
    limits: &RunLimits,
) -> Result<Vec<sandpane_core::sbx::SbxListEntry>, SvcFailure> {
    let out = SbxCommandBuilder::list(program)
        .run(limits)
        .map_err(|e| process_failure("sbx ls", e))?;
    if !out.status.success() {
        return Err(classify_failure(&out.status.to_string(), &out.stderr_lossy()).into());
    }
    if out.stdout_truncated {
        return Err(SvcFailure::from((
            ErrorCode::ValidationFailed,
            "sbx ls --json output exceeded the size cap; refusing a partial list".to_string(),
        )));
    }
    parse_list_json(&out.stdout_lossy())
        .map_err(|e| SvcFailure::from((ErrorCode::ValidationFailed, e.to_string())))
}

fn sandbox_list(inner: &ServerInner) -> Result<serde_json::Value, SvcFailure> {
    let program = locate_sbx(inner)?;
    // Subprocess first, DB lock after: never hold the lock across sbx.
    let entries = sbx_list(&program, &inner.sbx_limits.query)?;
    // SBX stays the source of truth for WHICH sandboxes exist; Core only joins
    // out what it recorded itself: the workspace mode (specs/02 §7 —
    // `direct_mount` means live-writable and UIs must label it, so the value
    // has to be real) and the bound project (review 0015 bug 10).
    let db = inner.lock_db();
    let bindings = live_bindings(&db)?;
    let summaries: Vec<SandboxSummary> = entries
        .into_iter()
        .map(|e| summarize(e, &bindings))
        .collect();
    serde_json::to_value(summaries).map_err(|e| internal(e).into())
}

/// One probed `ls` row joined with the binding Core has IN FORCE for that
/// sandbox (see [`binding_for_entry`]; removed bindings never count).
fn summarize(e: SbxListEntry, bindings: &HashMap<String, Vec<BindingRow>>) -> SandboxSummary {
    let binding = bindings
        .get(&e.name)
        .and_then(|rows| binding_for_entry(rows, e.id.as_deref()));
    SandboxSummary {
        probed_state: Some(e.status.as_str().to_string()),
        bound_project_id: binding.map(|b| b.project_id.clone()),
        workspace_mode: binding.and_then(|b| workspace_mode_from_stored(&b.mode)),
        agent: e.agent,
        name: e.name,
        // Live state, never a replay.
        replayed: None,
    }
}

/// A live (`removed_at IS NULL`) `sandbox_bindings` row.
struct BindingRow {
    project_id: String,
    mode: String,
    /// sbx `id` of the sandbox the binding was made for (schema v4); `None`
    /// on rows written before A1 (or when the post-create re-query failed).
    sbx_id: Option<String>,
}

/// The binding that describes the probed sandbox with sbx id `sbx_id`
/// (review W1): a row recorded for EXACTLY that id; otherwise — only when the
/// newest live row has no recorded sbx id (written before A1, or its
/// post-create re-query failed) — that row, matched by name as before A1. A row recorded for a different sbx id (an earlier sandbox that
/// had the same name) never describes a replacement.
fn binding_for_entry<'a>(rows: &'a [BindingRow], sbx_id: Option<&str>) -> Option<&'a BindingRow> {
    rows.iter()
        .find(|b| b.sbx_id.is_some() && b.sbx_id.as_deref() == sbx_id)
        .or_else(|| rows.first().filter(|b| b.sbx_id.is_none()))
}

/// Every live binding row per sandbox name, newest first (recorded
/// `created_at`, insertion order `rowid` as tie-break). Rows marked removed by
/// `sandbox.remove` (schema v4) are excluded, so a new sandbox reusing a
/// removed sandbox's name never inherits the removed one's (possibly
/// live-writable) mode. A name with no live row is absent, so the fields are
/// omitted on the wire.
fn live_bindings(db: &Database) -> Result<HashMap<String, Vec<BindingRow>>, SvcError> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT sandbox_name, workspace_mode, project_id, sbx_id FROM sandbox_bindings
             WHERE removed_at IS NULL
             ORDER BY created_at DESC, rowid DESC",
        )
        .map_err(internal)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                BindingRow {
                    mode: r.get(1)?,
                    project_id: r.get(2)?,
                    sbx_id: r.get(3)?,
                },
            ))
        })
        .map_err(internal)?;
    let mut out: HashMap<String, Vec<BindingRow>> = HashMap::new();
    for row in rows {
        let (name, binding) = row.map_err(internal)?;
        out.entry(name).or_default().push(binding);
    }
    Ok(out)
}

/// Claim `name` for a create / confirmed remove (review W2). Refused — with
/// nothing run — while another such operation on the same name is in flight.
fn claim_sandbox_name<'a>(
    inner: &'a ServerInner,
    name: &str,
) -> Result<inflight::SandboxOpGuard<'a>, SvcFailure> {
    inner.sandbox_ops.try_acquire(name).ok_or_else(|| {
        SvcFailure::from((
            ErrorCode::Conflict,
            format!("another operation on sandbox {name:?} is in progress; nothing was run"),
        ))
    })
}

fn sandbox_create(
    inner: &ServerInner,
    spec: SandboxCreateSpec,
) -> Result<serde_json::Value, SvcFailure> {
    // A2 §3.1 item 4, step 1 (validate) — the key first, so an invalid key is
    // VALIDATION_FAILED before anything else is read or run.
    let keyed = {
        let mut without_key = spec.clone();
        without_key.idempotency_key = None;
        keyed_call(
            Method::SandboxCreate,
            spec.idempotency_key.as_deref(),
            &without_key,
        )?
    };
    Validator::sandbox_name(&spec.name).map_err(|e| {
        SvcFailure::from((ErrorCode::ValidationFailed, format!("sandbox name: {e}")))
    })?;
    // Agent: an EXACT built-in from the captured `sbx create --help`, refused
    // before anything else runs. Kit references (local dirs, ZIPs, git URLs,
    // OCI refs) execute third-party code and are never accepted; `--cloud`
    // is never emitted by the builder.
    let agent = spec.agent.as_deref().unwrap_or(DEFAULT_SANDBOX_AGENT);
    Validator::sbx_agent(agent)
        .map_err(|e| SvcFailure::from((ErrorCode::ValidationFailed, format!("agent: {e}"))))?;
    // host_worktree needs Core-allocated worktrees (git-safe-tasks) that do
    // not exist yet. Refuse BEFORE touching anything, rather than fall back to
    // a live bind mount of the host tree under a "safe" label.
    if matches!(spec.workspace_mode, WorkspaceMode::HostWorktree) {
        return Err(SvcFailure::from((
            ErrorCode::ValidationFailed,
            "workspace mode host_worktree is not implemented for sandbox.create in this build: \
             Core allocates per-task worktrees, but protocol v1 cannot bind a sandbox to a \
             task's worktree; use sbx_clone, direct_mount (live-writable) or mountless"
                .to_string(),
        )));
    }
    // MOUNT CONTAINMENT (specs/06 §3 "overly broad mounts", §4 canonicalize +
    // validate before use): a workspace path must canonicalize (symlinks
    // resolved) to a path inside a repository REGISTERED with this project.
    // Registered paths are themselves canonical Git top levels that passed the
    // W1 denylist at project.create; they are re-canonicalized here so a row
    // written before W1 is still compared canonically.
    let mount: Option<(PathBuf, String)> =
        if matches!(spec.workspace_mode, WorkspaceMode::Mountless) {
            if spec.repo_path.is_some() {
                return Err(SvcFailure::from((
                    ErrorCode::ValidationFailed,
                    "mountless workspace takes no repository path".to_string(),
                )));
            }
            None
        } else {
            let Some(raw) = &spec.repo_path else {
                return Err(SvcFailure::from((
                    ErrorCode::ValidationFailed,
                    format!(
                        "{} workspace requires a registered repoPath",
                        workspace_mode_wire(&spec.workspace_mode)
                    ),
                )));
            };
            let candidate = std::fs::canonicalize(raw).map_err(|e| {
                SvcFailure::from((
                    ErrorCode::ValidationFailed,
                    format!("repoPath not usable: {e}"),
                ))
            })?;
            // (repository row id, canonical root) — the id is recorded on the
            // binding (review W1(a)) so remove_repository can see the mount.
            let rows: Vec<(String, String)> = {
                let db = inner.lock_db();
                let mut stmt = db
                    .conn()
                    .prepare("SELECT id, canonical_path FROM repositories WHERE project_id = ?1")
                    .map_err(internal)?;
                let rows = stmt
                    .query_map(params![spec.project_id], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })
                    .map_err(internal)?
                    .filter_map(|row| row.ok())
                    .collect();
                rows
            };
            // Canonicalized with the DB lock released (filesystem only).
            let registered: Vec<(String, PathBuf)> = rows
                .into_iter()
                .filter_map(|(id, p)| std::fs::canonicalize(&p).ok().map(|c| (id, c)))
                .collect();
            if registered.is_empty() {
                return Err(SvcFailure::from((
                    ErrorCode::ValidationFailed,
                    "project has no registered repositories to mount".to_string(),
                )));
            }
            // EXACT ROOT ONLY (review S-g): the canonical candidate must EQUAL a
            // registered repository root, not merely lie beneath it. sbx resolves
            // the path again on its own; with a subdirectory, an agent with write
            // access inside the repo could swap a path component for a symlink
            // between Core's canonicalize and sbx's resolve. The root's own
            // components are outside the repository's contents. (A residual
            // remains if the root's PARENT chain is attacker-writable — it is the
            // user's own directory tree, not a sandbox mount.)
            // The W1 denylist is RE-APPLIED to every stored root: a row written
            // before registration was hardened (e.g. `$HOME` itself) never
            // authorizes a mount.
            let home = runtime::home_dir();
            let home_c = std::fs::canonicalize(&home).unwrap_or(home);
            let Some((repo_id, _)) = registered.iter().find(|(_, root)| {
                candidate == *root && Validator::registrable_repository(root, &home_c).is_ok()
            }) else {
                return Err(SvcFailure::from((
                    ErrorCode::PermissionDenied,
                    "repoPath must be exactly a repository root registered with this project (an \
                 allowed repository location); subdirectories are not mountable"
                        .to_string(),
                )));
            };
            Some((candidate, repo_id.clone()))
        };
    // The host path sbx mounts, and the registered repository row it is.
    let (mount, mount_repo_id): (Option<PathBuf>, Option<String>) = match mount {
        Some((path, repo_id)) => (Some(path), Some(repo_id)),
        None => (None, None),
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
            return Err(SvcFailure::from((
                ErrorCode::NotFound,
                "project not found".to_string(),
            )));
        }
    }
    // Step 2: look the key up BEFORE the name lock, so a replay of a finished
    // create returns the stored result rather than CONFLICT (and runs nothing).
    //
    // DOCUMENTED ASYMMETRY (A3a review I3, design §3.2): the project-exists
    // check in step 1 runs BEFORE this lookup, so a replay after
    // `project.delete` is NOT_FOUND; a replay after `project.archive` is
    // still answered from the stored row (the archived check comes after
    // this lookup). `conversation.send` looks its key up first, so its
    // replay is answered even after delete.
    if let Some(kc) = &keyed {
        if let Some(answer) = kc.stored_answer(inner) {
            return answer;
        }
    }
    // A3a §3.2 item 3: an archived project refuses — AFTER the lookup, so a
    // replay of a create that finished before archiving is still answered
    // from its stored result; BEFORE the claim, so no key row is written and
    // sbx never runs.
    project_lifecycle::require_live_project(inner.lock_db().conn(), &spec.project_id)
        .map_err(SvcFailure::from)?;
    // Step 3: held until this function returns (through the binding insert),
    // so a confirmed remove of the same name cannot interleave (review W2).
    //
    // Review I5: two CONCURRENT creates with the same key and the same name
    // both pass step 2 (nothing stored yet); the one that loses THIS lock
    // gets A1's CONFLICT "another operation on sandbox … is in progress;
    // nothing was run" — not the key's stored result, which does not exist
    // until the winner finishes. Nothing runs twice either way; a retry after
    // the winner completes is a replay.
    let _name_claim = claim_sandbox_name(inner, &spec.name)?;
    // Step 4: commit a `pending` claim (its own short transaction).
    let pending = match &keyed {
        None => None,
        Some(kc) => match kc.claim(inner)? {
            ClaimOutcome::Claimed(p) => Some(p),
            ClaimOutcome::Answered(answer) => return answer,
        },
    };
    // A3a §3.2 item 4: count this create against its project from here (the
    // committed claim; for an unkeyed create, the same point — before sbx
    // runs) until this function returns: binding written, failure, or
    // unwind (the guard's Drop). INCREMENT FIRST, THEN RE-CHECK under the DB
    // mutex: either `project.delete` (which reads the count under the DB
    // mutex inside its delete transaction) sees this create and refuses, or
    // this re-check sees the project gone and nothing runs. The count's
    // mutex is a leaf (see `inflight::ProjectCreates`); no other Core lock is
    // held while it is taken here.
    if let Some(hook) = &inner.test_after_create_claim {
        (hook.0)(inner);
    }
    let _in_flight = inner.project_creates.enter(&spec.project_id);
    // REVIEW C1: the re-check's result is bound FIRST, in its own statement,
    // so the DB guard is dropped before the refusal path runs —
    // `PendingClaim::release` locks the DB mutex again, and an `if let`
    // scrutinee's temporary guard (edition 2021) would live through the
    // body: a self-deadlock that wedged every later request.
    let recheck = {
        let db = inner.lock_db();
        project_lifecycle::recheck_create_target(
            db.conn(),
            &spec.project_id,
            mount_repo_id.as_deref(),
        )
    };
    if let Err(e) = recheck {
        // Deleted, archived, or its repository unregistered since the first
        // checks: nothing ran, so the claim is released (key reusable).
        if let Some(p) = pending {
            p.release();
        }
        return Err(e.into());
    }
    // Steps 5-6: run `sbx create`, then bind + complete the claim together.
    let completion = keyed.as_ref().map(|kc| (kc.method, kc.key.as_str()));
    match create_and_bind(
        inner,
        &spec,
        agent,
        mount.as_deref(),
        mount_repo_id.as_deref(),
        completion,
    ) {
        Ok(v) => {
            if let Some(p) = pending {
                p.disarm();
            }
            Ok(v)
        }
        // §3.1 item 7: only a failure KNOWN to precede the subprocess frees
        // the key; anything after `sbx create` started may have created the
        // sandbox, so the key becomes `unknown` and is never run twice.
        Err(CreateFailure::BeforeStart(f)) => {
            if let Some(p) = pending {
                p.release();
            }
            Err(f)
        }
        Err(CreateFailure::AfterStart(f)) => {
            if let Some(p) = pending {
                p.unknown();
            }
            Err(f)
        }
    }
}

/// Where a `sandbox.create` failure happened relative to the subprocess.
enum CreateFailure {
    /// Nothing ran (sbx not located, argv refused, spawn failed).
    BeforeStart(SvcFailure),
    /// `sbx create` started: it may have created the sandbox.
    AfterStart(SvcFailure),
}

/// Run `sbx create`, re-query, then write the binding — and, when keyed,
/// complete the `pending` claim as `done` with the exact result IN THE SAME
/// TRANSACTION. No DB lock is held while sbx runs.
fn create_and_bind(
    inner: &ServerInner,
    spec: &SandboxCreateSpec,
    agent: &str,
    mount: Option<&Path>,
    mount_repo_id: Option<&str>,
    completion: Option<(&str, &str)>,
) -> Result<serde_json::Value, CreateFailure> {
    use CreateFailure::{AfterStart, BeforeStart};
    let program = locate_sbx(inner).map_err(BeforeStart)?;
    let workspace = match (&spec.workspace_mode, mount) {
        (WorkspaceMode::DirectMount, Some(p)) => SbxWorkspace::BindMount(p),
        (WorkspaceMode::SbxClone, Some(p)) => SbxWorkspace::Clone(p),
        _ => SbxWorkspace::None,
    };
    let cmd = SbxCommandBuilder::create(&program, &spec.name, agent, workspace).map_err(|e| {
        BeforeStart(SvcFailure::from((
            ErrorCode::ValidationFailed,
            e.to_string(),
        )))
    })?;
    let probed = match cmd.run(&inner.sbx_limits.mutation) {
        Ok(out) if out.status.success() => {
            // RE-QUERY after mutation: exit 0 never means desired state
            // (specs/02 §5).
            probe_sandbox_entry(&program, &spec.name, &inner.sbx_limits.query)
        }
        Ok(out) => {
            // Classified against the real captured errors: not signed in →
            // PROVIDER_AUTH_REQUIRED, policy not initialized →
            // PERMISSION_DENIED with the `sbx policy init …` remediation, etc.
            // (review 0015 bug 5).
            return Err(AfterStart(
                classify_failure(&out.status.to_string(), &out.stderr_lossy()).into(),
            ));
        }
        Err(sandpane_core::process::ProcessError::TimedOut(after)) => {
            // Review S-c: the create was killed at its deadline (or a
            // descendant held its output open), but the sandbox may exist.
            // SBX is the source of truth: re-query, and bind what exists
            // rather than orphan it. Absent → an honest timeout error.
            match probe_sandbox_entry(&program, &spec.name, &inner.sbx_limits.query) {
                Some(entry) => {
                    eprintln!(
                        "sandpane-service: sbx create {} exceeded {after:?}; sandbox exists \
                         on re-query ({}) and is being bound",
                        spec.name,
                        entry.status.as_str()
                    );
                    Some(entry)
                }
                None => {
                    return Err(AfterStart(SvcFailure::from((
                        ErrorCode::Internal,
                        format!(
                            "sbx create timed out after {after:?} and sandbox {:?} is not \
                             present on re-query",
                            spec.name
                        ),
                    ))))
                }
            }
        }
        // Could not even start: nothing ran.
        Err(e @ sandpane_core::process::ProcessError::Spawn(_)) => {
            return Err(BeforeStart(process_failure("sbx create", e)))
        }
        Err(e) => return Err(AfterStart(process_failure("sbx create", e))),
    };
    let summary = SandboxSummary {
        name: spec.name.clone(),
        probed_state: probed.as_ref().map(|e| e.status.as_str().to_string()),
        bound_project_id: Some(spec.project_id.clone()),
        // The mode Core just recorded for this binding — the caller asked for
        // it explicitly, so it is a fact, not a guess (specs/02 §7:
        // direct_mount is live-writable).
        workspace_mode: Some(spec.workspace_mode),
        // What sbx REPORTS on the re-query (absent when not listed) — a probed
        // fact, not a verification claim.
        agent: probed.as_ref().and_then(|e| e.agent.clone()),
        // The FIRST response: stored without the replay marker (W1).
        replayed: None,
    };
    let value = serde_json::to_value(&summary).map_err(|e| AfterStart(internal(e).into()))?;
    let write = || -> Result<(), SvcError> {
        let db = inner.lock_db();
        let tx = db.conn().unchecked_transaction().map_err(internal)?;
        let now = now_rfc3339();
        // Bare wire name (snake_case, unquoted) — matches tasks.status storage
        // so P3/P5 can query live-writable workspaces by mode.
        let mode_str = workspace_mode_wire(&spec.workspace_mode).to_string();
        tx.execute(
            "INSERT INTO sandbox_bindings
                 (id, project_id, sandbox_name, workspace_mode, created_at, sbx_id, repo_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                uuid::Uuid::new_v4().to_string(),
                spec.project_id,
                spec.name,
                mode_str,
                now,
                // The identity sbx reports on the re-query (shape-checked at
                // parse). NULL when it could not be probed: such a row is then
                // treated like a pre-A1 one, never as a match.
                probed.as_ref().and_then(|e| e.id.clone()),
                // Review W1(a): the registered repository this sandbox mounts
                // (direct_mount / sbx_clone); NULL for mountless.
                mount_repo_id
            ],
        )
        .map_err(internal)?;
        if let Some((method, key)) = completion {
            if !idempotency::complete(&tx, method, key, &value.to_string(), &now)
                .map_err(internal)?
            {
                // The claim is no longer pending (cannot normally happen:
                // pending rows are never pruned). The sandbox exists, so the
                // binding is still committed; the key stays as it is.
                eprintln!(
                    "sandpane-service: idempotency claim for sandbox {:?} was not pending at \
                     completion; binding recorded, key left unchanged",
                    spec.name
                );
            }
        }
        tx.commit().map_err(internal)?;
        Ok(())
    };
    write().map_err(|e| AfterStart(e.into()))?;
    Ok(value)
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

/// Post-mutation re-query. `None` = not listed or could not be determined
/// (never guessed).
fn probe_sandbox_entry(program: &Path, name: &str, limits: &RunLimits) -> Option<SbxListEntry> {
    sbx_list(program, limits)
        .ok()?
        .into_iter()
        .find(|e| e.name == name)
}

fn validate_sandbox_name(name: &str) -> Result<(), SvcFailure> {
    Validator::sandbox_name(name).map_err(|e| {
        SvcFailure::from((ErrorCode::ValidationFailed, format!("sandbox name: {e}")))
    })?;
    Ok(())
}

/// `sandbox.stop` (A1): `sbx stop NAME`, then the `ls --json` re-query
/// (specs/02 §5). Not destructive — state is preserved and `sbx run --name`
/// restarts it — so no confirmation token.
fn sandbox_stop(
    inner: &ServerInner,
    p: SandboxStopParams,
) -> Result<serde_json::Value, SvcFailure> {
    validate_sandbox_name(&p.name)?;
    let program = locate_sbx(inner)?;
    let cmd = SbxCommandBuilder::stop(&program, &p.name)
        .map_err(|e| SvcFailure::from((ErrorCode::ValidationFailed, e.to_string())))?;
    let out = cmd
        .run(&inner.sbx_limits.mutation)
        .map_err(|e| process_failure("sbx stop", e))?;
    if !out.status.success() {
        return Err(classify_failure(&out.status.to_string(), &out.stderr_lossy()).into());
    }
    // Absent when no longer listed OR the re-query failed: the client shows
    // the state as unknown, never assumes "stopped".
    let requeried = match sbx_list(&program, &inner.sbx_limits.query) {
        Ok(entries) => match entries.into_iter().find(|e| e.name == p.name) {
            Some(entry) => {
                let db = inner.lock_db();
                Some(summarize(entry, &live_bindings(&db)?))
            }
            None => None,
        },
        Err(f) => {
            eprintln!(
                "sandpane-service: sbx stop {} exited 0 but the re-query failed: {}",
                p.name, f.message
            );
            None
        }
    };
    serde_json::to_value(SandboxStopResult {
        stopped: true,
        requeried,
    })
    .map_err(|e| internal(e).into())
}

/// `sandbox.remove` (A1): two-step server-side confirmation (design
/// 2026-10-09 §2, sbx-cli-integration rule 6).
fn sandbox_remove(
    inner: &ServerInner,
    p: SandboxRemoveParams,
) -> Result<serde_json::Value, SvcFailure> {
    validate_sandbox_name(&p.name)?;
    let result = match p.confirm_token {
        None => SandboxRemoveResult {
            confirmation: Some(issue_remove_confirmation(inner, &p.name)?),
            removed: None,
        },
        Some(token) => {
            remove_confirmed(inner, &p.name, &token)?;
            SandboxRemoveResult {
                confirmation: None,
                removed: Some(true),
            }
        }
    };
    serde_json::to_value(result).map_err(|e| internal(e).into())
}

/// Step 1: look the sandbox up in SBX (the source of truth), describe the
/// impact, issue a token bound to (action, name, sbx id). Changes nothing.
fn issue_remove_confirmation(
    inner: &ServerInner,
    name: &str,
) -> Result<ConfirmationRequest, SvcFailure> {
    let program = locate_sbx(inner)?;
    let entry = sbx_list(&program, &inner.sbx_limits.query)?
        .into_iter()
        .find(|e| e.name == name)
        .ok_or_else(|| {
            SvcFailure::from((
                ErrorCode::NotFound,
                format!("sandbox {name:?} is not listed by sbx"),
            ))
        })?;
    // Fail closed: without the sbx id there is no identity to bind, and a
    // same-named replacement could not be told apart.
    // `parse_list_json` already dropped ids outside the captured shape
    // (review I4); re-checked here because this is what the token binds.
    let id = entry
        .id
        .clone()
        .filter(|id| Validator::sbx_sandbox_id(id).is_ok())
        .ok_or_else(|| {
            SvcFailure::from((
                ErrorCode::Internal,
                format!(
                    "sbx ls reports no usable id for sandbox {name:?}; refusing to issue a \
                     removal confirmation that cannot be bound to the sandbox identity"
                ),
            ))
        })?;
    let rows = {
        let db = inner.lock_db();
        live_bindings(&db)?.remove(name).unwrap_or_default()
    };
    // `external` is decided by IDENTITY (review W1): Sandpane vouches only for
    // a live binding recorded for exactly this sbx id.
    let matched = rows
        .iter()
        .find(|b| b.sbx_id.as_deref() == Some(id.as_str()));
    let impact = removal_impact(name, &id, &entry.status, matched, &rows);
    let ttl = inner.confirmation_ttl;
    let token = inner
        .lock_confirmations()
        .issue(
            confirm::ConfirmationBinding {
                action: SANDBOX_REMOVE_ACTION.to_string(),
                name: name.to_string(),
                id: id.clone(),
            },
            std::time::Instant::now(),
            ttl,
        )
        .map_err(|e| {
            SvcFailure::from((
                ErrorCode::Internal,
                format!("OS random source unavailable for a confirmation token: {e}"),
            ))
        })?;
    // Wall-clock rendering of the monotonic deadline, floored to the second
    // so it never promises more time than the token really has.
    let expires_unix = (std::time::SystemTime::now() + ttl)
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(ConfirmationRequest {
        token,
        expires_at: rfc3339_from_unix(expires_unix),
        action: SANDBOX_REMOVE_ACTION.to_string(),
        target: ConfirmationTarget {
            name: name.to_string(),
            id,
        },
        impact,
        external: matched.is_none(),
    })
}

/// Short, human impact lines for the confirmation dialog. Only what Core
/// knows: the probed state and its own bindings (never a guess about
/// contents). The workspace-mode line appears ONLY for a binding recorded for
/// exactly this sbx id (review W1).
fn removal_impact(
    name: &str,
    id: &str,
    status: &SbxSandboxStatus,
    matched: Option<&BindingRow>,
    live_rows: &[BindingRow],
) -> Vec<String> {
    let mut lines = vec![format!(
        "removes sandbox {name} (sbx id {id}) and everything inside it; this cannot be undone"
    )];
    if *status == SbxSandboxStatus::Running {
        lines.push("the sandbox is running; anything running inside it is terminated".into());
    }
    match matched {
        Some(b) => {
            lines.push(match workspace_mode_from_stored(&b.mode) {
                Some(WorkspaceMode::DirectMount) => "workspace mode direct_mount: host files \
                     already written through the live-writable mount stay on the host"
                    .to_string(),
                Some(WorkspaceMode::SbxClone) => "workspace mode sbx_clone: work in the \
                     sandbox's private clone that was not fetched to the host is lost"
                    .to_string(),
                Some(WorkspaceMode::Mountless) => {
                    "workspace mode mountless: no host workspace was mounted".to_string()
                }
                Some(WorkspaceMode::HostWorktree) => "workspace mode host_worktree: the \
                     Core-allocated host worktree is not touched by this removal"
                    .to_string(),
                None => "workspace mode unknown (Core cannot read its binding row)".to_string(),
            });
            lines.push(format!(
                "the Sandpane binding to project {} is marked removed (kept for audit)",
                b.project_id
            ));
        }
        None if live_rows.iter().any(|b| b.sbx_id.is_none()) => lines.push(
            "a Sandpane binding with this name exists but has no recorded sbx id; Core \
             cannot confirm Sandpane created this sandbox (that binding is marked removed \
             with it)"
                .into(),
        ),
        None if !live_rows.is_empty() => lines.push(
            "not created by Sandpane: the Sandpane binding with this name belongs to an \
             earlier sandbox (a different sbx id) and is not affected"
                .into(),
        ),
        None => lines.push(
            "not created by Sandpane: Core has no binding for this sandbox and cannot describe \
             what it holds"
                .into(),
        ),
    }
    lines
}

/// Enforce the step-2 invariant on a failure that happened after `sbx rm`
/// was spawned: a code clients read as "refused, nothing ran"
/// (`VALIDATION_FAILED`, `CONFLICT`, `NOT_FOUND`) becomes `INTERNAL`, with
/// the original message prefixed and `details` kept. Other classified codes
/// (`PROVIDER_AUTH_REQUIRED`, `PERMISSION_DENIED`, `DAEMON_DOWN`, `INTERNAL`)
/// carry their remediation and pass through.
fn after_rm(f: SvcFailure, what: &str) -> SvcFailure {
    match f.code {
        ErrorCode::ValidationFailed | ErrorCode::Conflict | ErrorCode::NotFound => SvcFailure {
            code: ErrorCode::Internal,
            message: format!(
                "{what} after it ran ({}); removal is unconfirmed and the Sandpane binding is \
                 left in force",
                f.message
            ),
            details: f.details,
        },
        _ => f,
    }
}

/// Step 2: consume the token FIRST (every attempt burns it), re-check the
/// target identity against SBX, only then `sbx rm --force NAME`, then
/// re-query. The sandbox name is claimed (review W2) from before the identity
/// re-check through the binding UPDATE, so no Core create/remove of the same
/// name interleaves; the binding rows to retire are CAPTURED before `rm` and
/// only those are marked. RESIDUAL RACE (disclosed): `rm` acts on a name, so
/// a same-named replacement created OUT OF BAND (e.g. `sbx` in a terminal)
/// between the re-check and `rm` would be the one removed; sbx v0.47 offers
/// no remove-by-id to close it.
fn remove_confirmed(inner: &ServerInner, name: &str, token: &str) -> Result<(), SvcFailure> {
    let bound = inner
        .lock_confirmations()
        .consume(
            token,
            SANDBOX_REMOVE_ACTION,
            name,
            std::time::Instant::now(),
        )
        .map_err(|_| {
            SvcFailure::from((
                ErrorCode::ValidationFailed,
                confirm::TOKEN_REJECTED_MESSAGE.to_string(),
            ))
        })?;
    let _name_claim = claim_sandbox_name(inner, name)?;
    let program = locate_sbx(inner)?;
    let entry = sbx_list(&program, &inner.sbx_limits.query)?
        .into_iter()
        .find(|e| e.name == name)
        .ok_or_else(|| {
            SvcFailure::from((
                ErrorCode::NotFound,
                format!("sandbox {name:?} is no longer listed by sbx; nothing was removed"),
            ))
        })?;
    if entry.id.as_deref() != Some(bound.id.as_str()) {
        return Err(SvcFailure::from((
            ErrorCode::Conflict,
            format!(
                "sandbox {name:?} is not the sandbox that was confirmed (its sbx id changed); \
                 nothing was removed — request a new confirmation"
            ),
        )));
    }
    // Capture BEFORE `rm` exactly the rows this removal retires: live rows
    // for this name recorded for the confirmed sbx id, plus rows with no
    // recorded id (pre-A1 or a failed re-query; the only sandbox they could describe is the one being removed or
    // one already gone). A row written later is never touched (review W2).
    let captured: Vec<String> = {
        let db = inner.lock_db();
        let mut stmt = db
            .conn()
            .prepare(
                "SELECT id FROM sandbox_bindings
                 WHERE sandbox_name = ?1 AND removed_at IS NULL
                   AND (sbx_id = ?2 OR sbx_id IS NULL)",
            )
            .map_err(internal)?;
        let ids = stmt
            .query_map(params![name, bound.id], |r| r.get::<_, String>(0))
            .map_err(internal)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(internal)?;
        ids
    };
    let confirmation = RemovalConfirmation::user_confirmed(name);
    let cmd = SbxCommandBuilder::remove(&program, name, &confirmation)
        .map_err(|e| SvcFailure::from((ErrorCode::ValidationFailed, e.to_string())))?;
    // ---- STEP-2 INVARIANT: `VALIDATION_FAILED`, `CONFLICT` and `NOT_FOUND`
    // are returned ONLY above this line, i.e. before `sbx rm` runs, because
    // clients read them as "refused, nothing ran". From here on (rm
    // spawned) every failure is `INTERNAL` — or another code that cannot be
    // read as "nothing ran" — with sbx's own text kept in `details`.
    let out = cmd
        .run(&inner.sbx_limits.mutation)
        .map_err(|e| process_failure("sbx rm", e))?;
    if !out.status.success() {
        let f = classify_failure(&out.status.to_string(), &out.stderr_lossy());
        return Err(after_rm(f.into(), "sbx rm failed"));
    }
    // RE-QUERY: exit 0 is not proof. Gone (or only a different same-named
    // sandbox listed) → the confirmed sandbox is removed.
    match sbx_list(&program, &inner.sbx_limits.query) {
        Ok(entries) => {
            if entries
                .iter()
                .any(|e| e.name == name && e.id.as_deref() == Some(bound.id.as_str()))
            {
                return Err(SvcFailure::from((
                    ErrorCode::Internal,
                    format!(
                        "sbx rm exited 0 but sandbox {name:?} is still listed; its Sandpane \
                         binding is left in force"
                    ),
                )));
            }
        }
        Err(f) => {
            // Always INTERNAL: `sbx_list` alone may say VALIDATION_FAILED
            // (output over cap / unparseable), which here would falsely
            // read as "token refused, nothing ran".
            return Err(SvcFailure {
                code: ErrorCode::Internal,
                message: format!(
                    "sbx rm exited 0 but the re-query failed ({}); removal is unconfirmed and \
                     the Sandpane binding is left in force",
                    f.message
                ),
                details: f.details,
            });
        }
    }
    let db = inner.lock_db();
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    let removed_at = now_rfc3339();
    for row_id in &captured {
        tx.execute(
            "UPDATE sandbox_bindings SET removed_at = ?1 WHERE id = ?2 AND removed_at IS NULL",
            params![removed_at, row_id],
        )
        .map_err(internal)?;
    }
    tx.commit().map_err(internal)?;
    Ok(())
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
    // A3b §3.3 item 7: `Validator::conversation_title`; empty or
    // whitespace-only still becomes "Untitled conversation".
    let title = conversation_lifecycle::title_for_create(&p.title)?;
    let id = uuid::Uuid::new_v4().to_string();
    let conv = {
        let db = inner.lock_db();
        // A3a: exists AND not archived, in the same critical section as the
        // insert (cannot race project.archive / project.delete).
        project_lifecycle::require_live_project(db.conn(), &p.project_id)?;
        // A3b §3.3 item 3: the validated sandbox NAME is persisted (it used
        // to be discarded) — a stored name, never a binding.
        db.conn()
            .execute(
                "INSERT INTO conversations (id, project_id, title, agent_id, created_at, sandbox_id)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![id, p.project_id, title, p.agent_id, now_rfc3339(), p.sandbox_id],
            )
            .map_err(internal)?;
        conversation_lifecycle::load_conversation(db.conn(), &id)?
    };
    serde_json::to_value(conv).map_err(internal)
}

/// How a new task maps onto a registered repository. INTERNAL API: protocol
/// v1's `conversation.send` cannot express it yet, so the wire path always
/// passes `None` (no Git context).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskWorkspaceRequest {
    pub mode: WorkspaceMode,
    /// A repository root registered with the conversation's project
    /// (`None` only for `mountless`).
    pub repo_path: Option<String>,
}

/// Outcome of [`discard_task_worktree`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeDiscard {
    pub task_id: String,
    pub worktree_path: String,
    pub task_branch: Option<String>,
    pub directory_was_present: bool,
    pub branch_deleted: bool,
    /// The worktree had already been removed by an earlier discard.
    pub already_removed: bool,
}

/// Create a task for one user message, optionally bound to a repository
/// workspace (specs/02 §3/§4/§7). Everything Git-side happens BEFORE the
/// durable write and outside the DB lock: the base commit is read (exact full
/// OID) and, for `host_worktree`, the Core-owned worktree is allocated. Then
/// message + task row (with its Git context) + events commit as one
/// transaction. If that write fails, the just-created (pristine) worktree and
/// branch are removed again.
///
/// - `None` — no Git context (the `conversation.send` wire default; protocol
///   v1 has no field to request one, so no workspace is ever implied).
/// - `mountless` — no repository.
/// - `direct_mount` — base recorded; NO branch, NO worktree: the agent works
///   in the live host tree (`liveWritable: true` in the event).
/// - `sbx_clone` — NO base recorded (the host HEAD is not verified against
///   the sandbox's private clone) and nothing created on the host.
/// - `host_worktree` — base, `sandpane/<task-id>` branch and
///   `<worktrees_root>/<task-id>` worktree. This isolates working-tree FILES
///   only: the worktree shares the user's common `.git` (refs, config, hooks,
///   objects) and is NOT repository-metadata isolation. Preconditions before
///   any sandbox is bound to it are listed in `sandpane_core::workspace`.
pub fn create_task(
    inner: &ServerInner,
    conversation_id: &str,
    content: &str,
    workspace: Option<TaskWorkspaceRequest>,
) -> Result<TaskSummary, SvcFailure> {
    create_task_keyed(inner, conversation_id, content, workspace, None).map_err(|e| match e {
        TaskWriteError::Failed(f) => f,
        // Unkeyed writes insert no key row, so they cannot lose a key race.
        TaskWriteError::KeyRace => internal("unkeyed task write reported a key race").into(),
    })
}

/// [`create_task`] with an optional A2 key: its `done` row (holding the
/// returned `TaskSummary`) is written in the SAME transaction as the
/// message, task and event rows (§3.1 item 3).
fn create_task_keyed(
    inner: &ServerInner,
    conversation_id: &str,
    content: &str,
    workspace: Option<TaskWorkspaceRequest>,
    keyed: Option<&KeyedCall>,
) -> Result<TaskSummary, TaskWriteError> {
    Validator::display_text(content, 64 * 1024)
        .map_err(|e| SvcFailure::from((ErrorCode::ValidationFailed, format!("content: {e}"))))?;
    let (project_id, agent_id) = {
        let db = inner.lock_db();
        // EARLY check, BEFORE any worktree is allocated: the conversation
        // exists, its project is not archived (A3a) and it is not archived
        // itself (A3b §3.3 item 4). `write_new_task` re-checks the same rule
        // inside its transaction (authoritative).
        let project_id =
            conversation_lifecycle::require_writable_conversation(db.conn(), conversation_id)
                .map_err(SvcFailure::from)?;
        let agent_id: String = db
            .conn()
            .query_row(
                "SELECT agent_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        (project_id, agent_id)
    };

    let task_id = uuid::Uuid::new_v4().to_string();
    let prepared = match workspace {
        None => None,
        Some(req) => Some(prepare_task_workspace(inner, &project_id, &task_id, req)?),
    };

    // The result is fully determined before the write, so the key row can
    // carry it inside the same transaction.
    let summary = TaskSummary {
        id: task_id.clone(),
        conversation_id: conversation_id.to_string(),
        status: TaskStatus::Queued,
        sandbox_name: None,
        task_branch: prepared.as_ref().and_then(|p| p.task_branch.clone()),
        base_commit: prepared.as_ref().and_then(|p| p.base_commit.clone()),
        // The FIRST response: stored without the replay marker (W1).
        replayed: None,
    };
    let keyed_write = match keyed {
        None => None,
        Some(kc) => Some(KeyedWrite {
            method: kc.method,
            key: &kc.key,
            hash: &kc.hash,
            result_json: serde_json::to_string(&summary).map_err(internal)?,
        }),
    };
    // Test seam (A3b): no Core lock is held here.
    if let Some(hook) = &inner.test_before_task_write {
        (hook.0)(inner);
    }
    let written = write_new_task(
        inner,
        &task_id,
        conversation_id,
        content,
        prepared.as_ref(),
        keyed_write.as_ref(),
    );
    if let Err(e) = written {
        if let (Some(p), Some(root)) = (&prepared, &inner.worktrees_root) {
            if let (Some(repo), Some(wt), Some(branch), Some(base)) = (
                &p.repo_path,
                &p.worktree_path,
                &p.task_branch,
                &p.base_commit,
            ) {
                if let Err(re) =
                    workspace::remove_worktree(&inner.git, Path::new(repo), root, wt, branch, base)
                {
                    eprintln!(
                        "sandpane-service: task {task_id}: rollback of worktree {} failed: {re}",
                        wt.display()
                    );
                }
            }
        }
        return Err(e);
    }

    // Admission is policy-only in the scaffold: no verified agent adapter
    // exists yet (P0 Codex gate), so the task stays queued and says so. The
    // writer-lock key is the directory the task would write: its own
    // worktree, or the live host tree for direct_mount. sbx_clone writes a
    // private in-sandbox clone (the sandbox is its key, unknown here).
    let (mode, workspace_key) = match &prepared {
        Some(p) => match p.mode {
            WorkspaceMode::HostWorktree => (
                p.mode,
                p.worktree_path.as_ref().map(|w| w.display().to_string()),
            ),
            WorkspaceMode::DirectMount => (p.mode, p.repo_path.clone()),
            other => (other, None),
        },
        None => (WorkspaceMode::Mountless, None),
    };
    let admission = {
        let sched = inner.lock_scheduler();
        sched.admit(&task_id, &project_id, workspace_key.as_deref(), mode)
    };
    {
        let db = inner.lock_db();
        // Review I3: the write committed and the DB mutex was released, so a
        // racing `task.cancel` + `conversation.delete` (or `project.delete`)
        // may have removed the task by now. Then there is nothing to attach
        // the scaffold event to; the request itself succeeded, so answer the
        // summary already built (like a replay, it is not current state)
        // instead of INTERNAL. Checked under the same guard as the append.
        let still_exists: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE id = ?1",
                params![task_id],
                |r| r.get(0),
            )
            .map_err(internal)?;
        if still_exists == 0 {
            return Ok(summary);
        }
        let log = EventLog::new(&db);
        let now2 = now_rfc3339();
        match admission {
            Admission::Admitted => {
                // The honest scaffold event: adapter unavailable, task queued.
                // PERMISSION_DENIED (review 0015 bug 9): the request is
                // well-formed, but Core's policy refuses to drive an agent
                // that has no verified adapter (AGENTS.md rule 5). It used to
                // claim PROVIDER_AUTH_REQUIRED, which falsely tells the user
                // that signing in would help. VALIDATION_FAILED was rejected
                // because nothing in the request is malformed.
                let ev = AgentEvent::Error {
                    code: ErrorCode::PermissionDenied,
                    message: format!(
                        "no verified agent adapter for '{agent_id}' in this build: \
                         the in-SBX feasibility gate (P0) has not passed, so Core will not run it \
                         — task stays queued"
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

    Ok(summary)
}

/// A task's resolved Git context, ready to be stored.
struct PreparedWorkspace {
    mode: WorkspaceMode,
    repo_id: Option<String>,
    repo_path: Option<String>,
    base_commit: Option<String>,
    task_branch: Option<String>,
    worktree_path: Option<PathBuf>,
}

fn prepare_task_workspace(
    inner: &ServerInner,
    project_id: &str,
    task_id: &str,
    req: TaskWorkspaceRequest,
) -> Result<PreparedWorkspace, SvcFailure> {
    let vf = |m: String| SvcFailure::from((ErrorCode::ValidationFailed, m));
    if matches!(req.mode, WorkspaceMode::Mountless) {
        if req.repo_path.is_some() {
            return Err(vf("mountless task takes no repository path".into()));
        }
        return Ok(PreparedWorkspace {
            mode: req.mode,
            repo_id: None,
            repo_path: None,
            base_commit: None,
            task_branch: None,
            worktree_path: None,
        });
    }
    let Some(raw) = req.repo_path else {
        return Err(vf(format!(
            "{} task requires a registered repository path",
            workspace_mode_wire(&req.mode)
        )));
    };
    let (repo_id, repo) = registered_repository(inner, project_id, &raw)?;
    let repo_str = repo.to_str().map(str::to_string);
    // sbx_clone (review W4): the isolated tree is the sandbox's private
    // clone; the host HEAD now is NOT verified to be what that clone starts
    // from, so Core records no base at all rather than one that looks
    // verified. direct_mount / host_worktree record the host HEAD exactly.
    // A repository with no commit is VALIDATION_FAILED; any other git failure
    // is INTERNAL (review S4).
    let base = match req.mode {
        WorkspaceMode::SbxClone => None,
        _ => Some(workspace::record_base(&inner.git, &repo).map_err(workspace_failure)?),
    };
    let (task_branch, worktree_path) = match (req.mode, &base) {
        (WorkspaceMode::HostWorktree, Some(base)) => {
            let Some(root) = &inner.worktrees_root else {
                return Err(vf(
                    "host_worktree tasks need Core's worktree directory, which this Core \
                     instance was started without"
                        .into(),
                ));
            };
            ensure_worktree_root(root).map_err(|m| {
                SvcFailure::from((ErrorCode::Internal, format!("worktree root: {m}")))
            })?;
            let wt = workspace::allocate_worktree(&inner.git, &repo, root, task_id, base)
                .map_err(workspace_failure)?;
            (Some(wt.task_branch), Some(wt.path))
        }
        _ => (None, None),
    };
    Ok(PreparedWorkspace {
        mode: req.mode,
        repo_id: Some(repo_id),
        repo_path: repo_str,
        base_commit: base,
        task_branch,
        worktree_path,
    })
}

#[cfg(unix)]
fn ensure_worktree_root(root: &Path) -> Result<(), String> {
    runtime::ensure_private_data_dir(root).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn ensure_worktree_root(_root: &Path) -> Result<(), String> {
    Err("task worktrees are only supported on Unix hosts in this build".into())
}

/// Resolve a requested repository to a root REGISTERED with the project:
/// the canonical request must EQUAL a registered root (re-canonicalized and
/// re-checked against the W1 denylist, as `sandbox.create` does).
fn registered_repository(
    inner: &ServerInner,
    project_id: &str,
    raw: &str,
) -> Result<(String, PathBuf), SvcFailure> {
    let requested = Path::new(raw);
    if !requested.is_absolute() {
        return Err(SvcFailure::from((
            ErrorCode::ValidationFailed,
            format!("repository path must be absolute: {raw}"),
        )));
    }
    let candidate = std::fs::canonicalize(requested).map_err(|e| {
        SvcFailure::from((
            ErrorCode::ValidationFailed,
            format!("repository path not usable: {e}"),
        ))
    })?;
    let rows: Vec<(String, String)> = {
        let db = inner.lock_db();
        let mut stmt = db
            .conn()
            .prepare("SELECT id, canonical_path FROM repositories WHERE project_id = ?1")
            .map_err(internal)?;
        let rows = stmt
            .query_map(params![project_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(internal)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(internal)?
    };
    let home = runtime::home_dir();
    let home_c = std::fs::canonicalize(&home).unwrap_or(home);
    for (id, stored) in rows {
        let Ok(root) = std::fs::canonicalize(&stored) else {
            continue;
        };
        if root == candidate && Validator::registrable_repository(&root, &home_c).is_ok() {
            return Ok((id, root));
        }
    }
    Err(SvcFailure::from((
        ErrorCode::PermissionDenied,
        "repository path must be exactly a repository root registered with this task's \
         project; subdirectories and unregistered repositories are refused"
            .to_string(),
    )))
}

/// Structured mapping for task-workspace failures.
fn workspace_failure(e: WorkspaceError) -> SvcFailure {
    let code = match &e {
        WorkspaceError::Git(scoregit::GitError::Exec(_)) => ErrorCode::Internal,
        WorkspaceError::Git(scoregit::GitError::DirtyHostState(_))
        | WorkspaceError::Git(scoregit::GitError::BaseDiverged { .. })
        | WorkspaceError::PathExists(_)
        | WorkspaceError::UncommittedChanges(_)
        | WorkspaceError::HeadMoved { .. }
        | WorkspaceError::BranchAdvanced { .. }
        | WorkspaceError::BranchCheckedOutElsewhere { .. }
        | WorkspaceError::SymbolicTaskRef { .. }
        | WorkspaceError::IndexFlagsHideChanges { .. }
        | WorkspaceError::IgnoredFiles { .. } => ErrorCode::Conflict,
        WorkspaceError::Git(scoregit::GitError::SubmodulesPresent(_))
        | WorkspaceError::Git(scoregit::GitError::Validation(_))
        | WorkspaceError::Validation(_)
        | WorkspaceError::RootOverlapsRepository { .. }
        | WorkspaceError::NotTaskWorktree { .. }
        | WorkspaceError::NoCommit(_) => ErrorCode::ValidationFailed,
    };
    SvcFailure::from((code, e.to_string()))
}

/// The durable unit for a new task: message, task row (with its Git context)
/// and the created/message/queued events, in ONE transaction, so the
/// append-only log never disagrees with `tasks` (specs/02 §4).
fn write_new_task(
    inner: &ServerInner,
    task_id: &str,
    conversation_id: &str,
    content: &str,
    prepared: Option<&PreparedWorkspace>,
    keyed: Option<&KeyedWrite<'_>>,
) -> Result<(), TaskWriteError> {
    let now = now_rfc3339();
    let mut machine = TaskStateMachine::new();
    // created -> queued is decided up front (pure logic) so the whole write
    // unit is one transaction.
    let to = machine
        .transition(TaskStatus::Queued)
        .map_err(|e| (ErrorCode::Internal, e.to_string()))?;
    let mut created = serde_json::json!({ "conversationId": conversation_id });
    let mut mode_str: Option<&'static str> = None;
    let mut worktree_str: Option<String> = None;
    if let Some(p) = prepared {
        mode_str = Some(workspace_mode_wire(&p.mode));
        worktree_str = match &p.worktree_path {
            Some(w) => Some(w.to_str().map(str::to_string).ok_or_else(|| {
                (
                    ErrorCode::ValidationFailed,
                    "worktree path must be valid UTF-8".to_string(),
                )
            })?),
            None => None,
        };
        let map = created.as_object_mut().expect("json object");
        map.insert("workspaceMode".into(), serde_json::json!(mode_str));
        // specs/02 §7: direct_mount edits reach the host immediately.
        map.insert(
            "liveWritable".into(),
            serde_json::json!(matches!(p.mode, WorkspaceMode::DirectMount)),
        );
        for (key, value) in [
            ("repoId", &p.repo_id),
            ("repoPath", &p.repo_path),
            ("baseCommit", &p.base_commit),
            ("taskBranch", &p.task_branch),
            ("worktreePath", &worktree_str),
        ] {
            if let Some(v) = value {
                map.insert(key.into(), serde_json::json!(v));
            }
        }
    }
    let db = inner.lock_db();
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    // A3a/A3b (authoritative, same transaction as every write below): the
    // conversation still exists — a project.delete or conversation.delete
    // that landed since the early check is NOT_FOUND, never an FK INTERNAL —
    // its project is not archived and it is not archived itself (cannot race
    // project.archive / conversation.archive). Nothing is written otherwise.
    conversation_lifecycle::require_writable_conversation(&tx, conversation_id)?;
    {
        let log = EventLog::from_conn(&tx);
        tx.execute(
            "INSERT INTO messages (id, conversation_id, role, content, sequence)
             VALUES (?1,?2,'user',?3,
                     COALESCE((SELECT MAX(sequence) FROM messages WHERE conversation_id = ?2),0)+1)",
            params![uuid::Uuid::new_v4().to_string(), conversation_id, content],
        )
        .map_err(internal)?;
        tx.execute(
            "INSERT INTO tasks (id, conversation_id, repo_id, base_commit, task_branch,
                                workspace_mode, worktree_path, status, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,'created',?8,?8)",
            params![
                task_id,
                conversation_id,
                prepared.and_then(|p| p.repo_id.clone()),
                prepared.and_then(|p| p.base_commit.clone()),
                prepared.and_then(|p| p.task_branch.clone()),
                mode_str,
                worktree_str,
                now
            ],
        )
        .map_err(internal)?;
        log.append(task_id, "task.created", &created, &now)
            .map_err(internal)?;
        let msg = AgentEvent::MessageDelta {
            text: content.to_string(),
        };
        log.append(
            task_id,
            "message.user",
            &serde_json::to_value(msg).map_err(internal)?,
            &now,
        )
        .map_err(internal)?;
        log.append(
            task_id,
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
        if let Some(k) = keyed {
            // A2 §3.1 items 3 and 8: retention, then the `done` row — in this
            // same transaction, so a crash leaves both or neither. Losing the
            // insert race returns early: `tx` drops and EVERYTHING above
            // rolls back.
            idempotency::prune(&tx, &idempotency_cutoff(), idempotency::MAX_ROWS)
                .map_err(internal)?;
            if !idempotency::insert_done(&tx, k.method, k.key, k.hash, &k.result_json, &now)
                .map_err(internal)?
            {
                return Err(TaskWriteError::KeyRace);
            }
        }
    }
    tx.commit().map_err(internal)?;
    Ok(())
}

/// Remove a FINISHED task's Core-allocated worktree and `sandpane/<id>`
/// branch — never the user's tree, never work. Distinct from `task.cancel`
/// (cancel keeps the worktree; specs/02 §4 separates the operations).
/// INTERNAL API: the wire method needs the server-side confirmation token of
/// the protocol-additions design (§2), which protocol v1 does not have yet.
///
/// Refuses (CONFLICT) while the task is not terminal, when the worktree has
/// uncommitted/untracked changes, when its HEAD or the branch moved past the
/// recorded base (commits are work), or when the branch is checked out
/// elsewhere; VALIDATION_FAILED when the task has no Core worktree (e.g.
/// `direct_mount`). Idempotent once removed.
pub fn discard_task_worktree(
    inner: &ServerInner,
    task_id: &str,
) -> Result<WorktreeDiscard, SvcFailure> {
    type Row = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Row = {
        let db = inner.lock_db();
        db.conn()
            .query_row(
                "SELECT t.status, t.workspace_mode, t.worktree_path, t.worktree_removed_at,
                        t.task_branch, t.base_commit, r.canonical_path
                 FROM tasks t LEFT JOIN repositories r ON r.id = t.repo_id WHERE t.id = ?1",
                params![task_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .map_err(|_| SvcFailure::from((ErrorCode::NotFound, "task not found".to_string())))?
    };
    let (status, mode, worktree, removed_at, branch, base, repo) = row;
    let Some(worktree) = worktree else {
        let why = if mode.as_deref() == Some("direct_mount") {
            "it is a direct_mount task: it works in the live host tree, and Core never removes \
             host files"
        } else {
            "it was never given a Core-allocated worktree"
        };
        return Err(SvcFailure::from((
            ErrorCode::ValidationFailed,
            format!("task {task_id} has no worktree to discard: {why}"),
        )));
    };
    if removed_at.is_some() {
        return Ok(WorktreeDiscard {
            task_id: task_id.to_string(),
            worktree_path: worktree,
            task_branch: branch,
            directory_was_present: false,
            branch_deleted: false,
            already_removed: true,
        });
    }
    let status = task_status_from_stored(&status, task_id)?;
    if !TaskStateMachine::from_status(status).is_terminal() {
        return Err(SvcFailure::from((
            ErrorCode::Conflict,
            format!(
                "task {task_id} is {}; only a finished task's worktree can be discarded \
                 (cancel it first)",
                task_status_stored(status)?
            ),
        )));
    }
    let (Some(branch), Some(base), Some(repo)) = (branch, base, repo) else {
        return Err(SvcFailure::from((
            ErrorCode::Internal,
            format!("task {task_id} has a worktree but an incomplete Git context"),
        )));
    };
    let Some(root) = &inner.worktrees_root else {
        return Err(SvcFailure::from((
            ErrorCode::ValidationFailed,
            "this Core instance was started without its worktree directory".to_string(),
        )));
    };
    // The scheduler's writer lock is keyed by the worktree path; a holder
    // means something may still be writing there (precondition 2 in
    // `sandpane_core::workspace`). Core does not yet stop/unmount a bound
    // sandbox — none can be bound to a worktree in protocol v1.
    // Bound first so the scheduler guard is dropped before the body (review
    // C1 audit: no lock guard lives in an `if let` scrutinee).
    let holder = inner
        .lock_scheduler()
        .writer_lock_holder(&worktree)
        .map(ToOwned::to_owned);
    if let Some(holder) = holder {
        return Err(SvcFailure::from((
            ErrorCode::Conflict,
            format!("task {holder} holds the writer lock on {worktree}; refusing to discard it"),
        )));
    }
    let plan = workspace::plan_worktree_removal(
        &inner.git,
        Path::new(&repo),
        root,
        Path::new(&worktree),
        &branch,
        &base,
    )
    .map_err(workspace_failure)?;
    // Durable INTENT before the first side effect (review S1): after a crash
    // or a failed step the log says what Core was doing.
    {
        let db = inner.lock_db();
        EventLog::new(&db)
            .append(
                task_id,
                "workspace.removing",
                &serde_json::json!({
                    "worktreePath": worktree,
                    "taskBranch": branch,
                    "directoryPresent": plan.directory_present,
                    "branchExists": plan.branch_exists,
                }),
                &now_rfc3339(),
            )
            .map_err(internal)?;
    }
    let removed = match workspace::execute_worktree_removal(&inner.git, &plan) {
        Ok(r) => r,
        Err(e) => {
            let failure = workspace_failure(e);
            let db = inner.lock_db();
            if let Err(le) = EventLog::new(&db).append(
                task_id,
                "workspace.removal_failed",
                &serde_json::json!({ "worktreePath": worktree, "error": failure.message }),
                &now_rfc3339(),
            ) {
                eprintln!("sandpane-service: task {task_id}: recording removal failure: {le}");
            }
            return Err(failure);
        }
    };
    let now = now_rfc3339();
    let db = inner.lock_db();
    let tx = db.conn().unchecked_transaction().map_err(internal)?;
    let changed = tx
        .execute(
            "UPDATE tasks SET worktree_removed_at=?2, updated_at=?2
             WHERE id=?1 AND worktree_removed_at IS NULL",
            params![task_id, now],
        )
        .map_err(internal)?;
    if changed == 1 {
        EventLog::from_conn(&tx)
            .append(
                task_id,
                "workspace.removed",
                &serde_json::json!({
                    "worktreePath": worktree,
                    "taskBranch": branch,
                    "directoryWasPresent": removed.directory_was_present,
                    "branchDeleted": removed.branch_deleted,
                }),
                &now,
            )
            .map_err(internal)?;
    }
    tx.commit().map_err(internal)?;
    Ok(WorktreeDiscard {
        task_id: task_id.to_string(),
        worktree_path: worktree,
        task_branch: Some(branch),
        directory_was_present: removed.directory_was_present,
        branch_deleted: removed.branch_deleted,
        already_removed: changed == 0,
    })
}

/// Task workspaces Core finds with no task row behind them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrphanReport {
    pub worktree_dirs: Vec<PathBuf>,
    /// (repository path, branch name)
    pub branches: Vec<(String, String)>,
}

/// READ-ONLY reconciliation (review W3): list directories under the worktree
/// root and `sandpane/*` branches in registered repositories that no live
/// task row accounts for (a crash between `worktree add` and the durable
/// write, a removal that failed half-way, or manual edits). Reports only —
/// NEVER deletes: whatever is there may hold work. Git failures on one
/// repository are logged and skipped.
pub fn report_orphaned_task_workspaces(inner: &ServerInner) -> OrphanReport {
    let mut report = OrphanReport::default();
    let (live_paths, live_branches, repos) = {
        let db = inner.lock_db();
        let collect = |sql: &str| -> Vec<String> {
            match db.conn().prepare(sql) {
                Ok(mut stmt) => stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map(|rows| rows.filter_map(Result::ok).collect())
                    .unwrap_or_default(),
                Err(e) => {
                    eprintln!("sandpane-service: orphan scan query failed: {e}");
                    Vec::new()
                }
            }
        };
        (
            collect(
                "SELECT worktree_path FROM tasks
                 WHERE worktree_path IS NOT NULL AND worktree_removed_at IS NULL",
            ),
            collect(
                "SELECT task_branch FROM tasks
                 WHERE task_branch IS NOT NULL AND worktree_removed_at IS NULL",
            ),
            collect("SELECT DISTINCT canonical_path FROM repositories ORDER BY canonical_path"),
        )
    };
    if let Some(root) = &inner.worktrees_root {
        if let (Ok(root_c), Ok(entries)) = (std::fs::canonicalize(root), std::fs::read_dir(root)) {
            let mut dirs: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|e| root_c.join(e.file_name()))
                .filter(|p| !live_paths.iter().any(|l| Path::new(l) == p))
                .collect();
            dirs.sort();
            report.worktree_dirs = dirs;
        }
    }
    for repo in repos {
        match inner
            .git
            .run(Path::new(&repo), &scoregit::GitArgs::list_task_branches())
        {
            Ok(out) => {
                for branch in out.lines().map(str::trim).filter(|b| !b.is_empty()) {
                    if !live_branches.iter().any(|l| l == branch) {
                        report.branches.push((repo.clone(), branch.to_string()));
                    }
                }
            }
            Err(e) => eprintln!("sandpane-service: orphan scan of {repo} skipped: {e}"),
        }
    }
    report
}

fn conversation_send(
    inner: &ServerInner,
    p: ConversationSendParams,
) -> Result<serde_json::Value, SvcFailure> {
    let keyed = {
        let mut without_key = p.clone();
        without_key.idempotency_key = None;
        keyed_call(
            Method::ConversationSend,
            p.idempotency_key.as_deref(),
            &without_key,
        )?
    };
    // A replay is answered from the key row alone: nothing is written.
    //
    // DOCUMENTED ASYMMETRY (A3a review I3, design §3.2): this lookup runs
    // BEFORE any project check, so a keyed replay of a send that completed
    // earlier returns its stored result (`replayed: true`) even after the
    // project was archived or deleted — the stored result is history, not
    // current state. `sandbox.create` instead checks that the project exists
    // BEFORE its lookup, so its replay after `project.delete` is NOT_FOUND
    // (after `project.archive` it is still answered from the row).
    if let Some(kc) = &keyed {
        if let Some(answer) = kc.stored_answer(inner) {
            return answer;
        }
    }
    // Protocol v1 carries no workspace selection, so the wire path creates a
    // task WITHOUT Git context — never an implied worktree or live mount.
    match create_task_keyed(inner, &p.conversation_id, &p.content, None, keyed.as_ref()) {
        Ok(summary) => serde_json::to_value(summary).map_err(|e| internal(e).into()),
        // Lost the key insert race: the whole write rolled back; answer from
        // the winner's row (a replay, or CONFLICT if it is not `done`).
        Err(TaskWriteError::KeyRace) => match &keyed {
            Some(kc) => kc.answer_after_race(inner),
            None => Err(internal("unkeyed task write reported a key race").into()),
        },
        Err(TaskWriteError::Failed(f)) => Err(f),
    }
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
            // Live state, never a replay.
            replayed: None,
        });
    }
    serde_json::to_value(out).map_err(internal)
}

/// `conversation.list` — chat enumeration, previously impossible (v1 gap 1).
/// A3b: archived conversations only with `includeArchived: true`.
fn conversation_list(
    inner: &ServerInner,
    p: ConversationListParams,
) -> Result<serde_json::Value, SvcError> {
    let limit = clamp_limit(p.limit);
    optional_scoping_id("projectId", &p.project_id)?;
    let out = {
        let db = inner.lock_db();
        conversation_lifecycle::list_conversations(
            db.conn(),
            p.project_id.as_deref(),
            p.include_archived(),
            limit as i64,
        )?
    };
    serde_json::to_value(out).map_err(internal)
}

/// `conversation.history` — bounded transcript read with disclosure of BOTH
/// bounds (specs/02 §2 "bounded responses … with truncation disclosure").
/// A3b: archived conversations are served too (an unknown one is NOT_FOUND).
fn conversation_history(
    inner: &ServerInner,
    p: ConversationHistoryParams,
) -> Result<serde_json::Value, SvcError> {
    let limit = clamp_limit(p.limit);
    validate_scoping_id("conversationId", &p.conversation_id)?;
    // A negative cursor is meaningless (sequences start at 1); normalise it
    // rather than passing a nonsense bound to SQLite.
    let after = p.after_sequence.max(0);
    let result = {
        let db = inner.lock_db();
        // Existence first: an unknown conversation is a structured NOT_FOUND,
        // never an empty-but-successful answer that looks like "no messages".
        conversation_lifecycle::load_conversation(db.conn(), &p.conversation_id)?;
        read_message_page(db.conn(), &p.conversation_id, after, limit)?
    };
    serde_json::to_value(result).map_err(internal)
}

/// One page of a conversation's messages — THE paging rule shared by
/// `conversation.history` and `conversation.export` (A3b §3.3 item 6), run
/// under the DB lock over the RAW stored rows.
fn read_message_page(
    conn: &rusqlite::Connection,
    conversation_id: &str,
    after: i64,
    limit: usize,
) -> Result<ConversationHistoryResult, SvcError> {
    // Read one row MORE than the caller asked for: that probe row proves the
    // scan was cut short without materialising the whole transcript.
    let fetch = limit as i64 + 1;
    let mut stmt = conn
        .prepare(
            "SELECT id, conversation_id, role, content, sequence FROM messages
             WHERE conversation_id = ?1 AND sequence > ?2 ORDER BY sequence ASC LIMIT ?3",
        )
        .map_err(internal)?;
    let rows = stmt
        .query_map(params![conversation_id, after, fetch], |r| {
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
        // Export redacts AFTER this count; redaction never lengthens a row, so
        // the count still bounds the redacted page.
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
    Ok(ConversationHistoryResult {
        messages,
        truncated,
        next_sequence,
    })
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

/// A task's stored Git context.
struct TaskGitContext {
    /// The registered HOST repository (the integration target).
    repo_path: String,
    /// Absent for `sbx_clone` tasks (no verified base; review W4).
    base_commit: Option<String>,
    workspace_mode: Option<String>,
    worktree_path: Option<String>,
    worktree_removed: bool,
}

/// Load a task's real Git context (repo path + recorded base commit, plus
/// its workspace mode and Core worktree when it has one).
fn git_context(inner: &ServerInner, task_id: &str) -> Result<TaskGitContext, SvcError> {
    let db = inner.lock_db();
    type Row = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Row = db
        .conn()
        .query_row(
            "SELECT r.canonical_path, t.base_commit, t.workspace_mode, t.worktree_path,
                    t.worktree_removed_at
             FROM tasks t
             LEFT JOIN repositories r ON r.id = t.repo_id
             WHERE t.id = ?1",
            params![task_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|_| (ErrorCode::NotFound, "task not found".to_string()))?;
    match row {
        (Some(repo_path), base_commit, workspace_mode, worktree_path, removed)
            if base_commit.is_some() || workspace_mode.is_some() =>
        {
            Ok(TaskGitContext {
                repo_path,
                base_commit,
                workspace_mode,
                worktree_path,
                worktree_removed: removed.is_some(),
            })
        }
        _ => Err((
            ErrorCode::ValidationFailed,
            "task has no Git context (repo binding + base_commit)".to_string(),
        )),
    }
}

/// The directory whose changes ARE the task's work, by workspace mode:
/// - `host_worktree` → its Core worktree, after proving it is still this
///   repository's task worktree; a removed/missing one is refused — never a
///   fall-back to the host tree, which would attribute the user's own edits
///   to the task;
/// - `direct_mount` (and legacy rows with no mode) → the live host tree;
/// - `sbx_clone` → refused: the work lives in the sandbox's private clone.
fn review_target(inner: &ServerInner, ctx: &TaskGitContext) -> Result<PathBuf, SvcError> {
    let repo = Path::new(&ctx.repo_path);
    let mode = match &ctx.workspace_mode {
        None => None,
        Some(stored) => Some(workspace_mode_from_stored(stored).ok_or_else(|| {
            (
                ErrorCode::Internal,
                format!("task stores workspace mode {stored:?}, which is not a Core mode"),
            )
        })?),
    };
    match mode {
        None | Some(WorkspaceMode::DirectMount) => Ok(repo.to_path_buf()),
        Some(WorkspaceMode::HostWorktree) => {
            if ctx.worktree_removed {
                return Err((
                    ErrorCode::ValidationFailed,
                    "the task's worktree was removed (discarded); there is nothing left to \
                     review"
                        .to_string(),
                ));
            }
            let Some(wt) = &ctx.worktree_path else {
                return Err((
                    ErrorCode::ValidationFailed,
                    "host_worktree task has no allocated worktree".to_string(),
                ));
            };
            let Some(root) = &inner.worktrees_root else {
                return Err((
                    ErrorCode::ValidationFailed,
                    "this Core instance was started without its worktree directory".to_string(),
                ));
            };
            workspace::verify_task_worktree(&inner.git, repo, root, Path::new(wt)).map_err(
                |e| {
                    let f = workspace_failure(e);
                    (f.code, f.message)
                },
            )?;
            Ok(PathBuf::from(wt))
        }
        Some(WorkspaceMode::SbxClone) => Err((
            ErrorCode::ValidationFailed,
            "review of sbx_clone tasks is not implemented: the agent's commits live in the \
             sandbox's private clone (reachable through the sandbox-<name> Git remote), so the \
             host tree would show none of them"
                .to_string(),
        )),
        Some(WorkspaceMode::Mountless) => Err((
            ErrorCode::ValidationFailed,
            "mountless task has no repository to review".to_string(),
        )),
    }
}

fn git_review(inner: &ServerInner, task_id: String) -> Result<serde_json::Value, SvcError> {
    let ctx = git_context(inner, &task_id)?;
    let target = review_target(inner, &ctx)?;
    let Some(base_commit) = ctx.base_commit else {
        return Err((
            ErrorCode::ValidationFailed,
            "task has no Git context (repo binding + base_commit)".to_string(),
        ));
    };
    let repo = Path::new(&ctx.repo_path);
    // A repository with submodules is REFUSED (VALIDATION_FAILED, naming the
    // submodule paths): Core never enters submodule work trees, and the
    // ChangeSet has no "incomplete" field, so returning a list would silently
    // under-report the agent's changes and the host's dirty state.
    // `hostDirty` describes the HOST repository (the integration target);
    // the change list comes from the task's own workspace.
    let dirty = inner.git.is_dirty(repo).map_err(review_git_error)?;
    let changes = inner
        .git
        .change_list(&target, &base_commit)
        .map_err(review_git_error)?;
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

/// `git.review` error mapping: a submodule refusal is a structured
/// VALIDATION_FAILED (the repository shape is unsupported, not a Core
/// fault); everything else stays INTERNAL.
fn review_git_error(e: scoregit::GitError) -> SvcError {
    match e {
        scoregit::GitError::SubmodulesPresent(_) => (ErrorCode::ValidationFailed, e.to_string()),
        other => (ErrorCode::Internal, other.to_string()),
    }
}

fn git_apply(inner: &ServerInner, p: GitApplyParams) -> Result<serde_json::Value, SvcError> {
    // Security W3: the client's base assertion must be a FULL object id and
    // must equal the Core-recorded base EXACTLY — no prefix matching, so a
    // 1-character "base" can never satisfy the gate.
    Validator::full_object_id(&p.expected_base)
        .map_err(|e| (ErrorCode::ValidationFailed, format!("expected base: {e}")))?;
    // Real precondition enforcement: when the task carries a Git context, the
    // dirty-host and base-divergence gates run for real and abort structurally
    // (specs/06 §6). The merge/patch application itself is a P4 deliverable,
    // so a passing precondition check still ends in an honest abort here.
    // FAIL-CLOSED: no usable Git context aborts the apply — it never falls
    // through to the "preconditions passed" branch (review finding #9).
    match git_context(inner, &p.task_id) {
        Ok(TaskGitContext {
            repo_path,
            base_commit: Some(base_commit),
            ..
        }) => {
            if !base_commit.eq_ignore_ascii_case(&p.expected_base) {
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
            // The CORE-RECORDED base drives the host check, never the
            // client's value.
            if let Err(e) =
                scoregit::preconditions_for_apply(&inner.git, Path::new(&repo_path), &base_commit)
            {
                let result = ApplyResult {
                    applied: false,
                    abort_reason: Some(format!("precondition failed: {e}")),
                    conflicted_files: vec![],
                };
                return serde_json::to_value(result).map_err(internal);
            }
        }
        Ok(TaskGitContext {
            base_commit: None, ..
        }) => {
            let result = ApplyResult {
                applied: false,
                abort_reason: Some(
                    "apply refused: no Git context for task (no verified base commit)".to_string(),
                ),
                conflicted_files: vec![],
            };
            return serde_json::to_value(result).map_err(internal);
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

/// Serve one connection to completion (thread-per-connection) with the
/// default [`runtime::ConnectionLimits`]. UI detach never cancels tasks:
/// dropping this reader only ends the subscription — DB/scheduler state is
/// untouched.
#[cfg(unix)]
pub fn serve_connection(inner: Arc<ServerInner>, stream: std::os::unix::net::UnixStream) {
    serve_connection_with(inner, stream, &runtime::ConnectionLimits::default());
}

/// [`serve_connection`] with explicit limits. Security S3: the peer must be
/// this same OS user (`getpeereid` / `SO_PEERCRED`), else the connection gets
/// one PERMISSION_DENIED frame and is closed. Security S7: an idle read
/// timeout and a write timeout bound how long a client can pin a thread.
#[cfg(unix)]
pub fn serve_connection_with(
    inner: Arc<ServerInner>,
    stream: std::os::unix::net::UnixStream,
    limits: &runtime::ConnectionLimits,
) {
    if !runtime::peer_allowed(runtime::peer_uid(&stream), runtime::euid()) {
        let mut s = &stream;
        let resp = err_frame(
            "",
            ErrorCode::PermissionDenied,
            "connection refused: peer is not the Core's OS user",
        );
        let _ = writeln!(s, "{resp}");
        return;
    }
    let _ = stream.set_read_timeout(Some(limits.idle_timeout));
    let _ = stream.set_write_timeout(Some(limits.write_timeout));
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
                // JSON does — never a silent disconnect (specs/02 §2). An idle
                // timeout (WouldBlock/TimedOut) just closes the connection;
                // clients reconnect.
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

/// Releases one active-connection slot when dropped (including on unwind).
#[cfg(unix)]
struct ConnectionSlot(Arc<std::sync::atomic::AtomicUsize>);

#[cfg(unix)]
impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Accept loop with a concurrent-connection cap (security S7). A connect
/// beyond the cap receives one structured `INTERNAL` "too many connections"
/// frame and is closed instead of spawning an unbounded thread.
#[cfg(unix)]
pub fn serve_listener(
    inner: Arc<ServerInner>,
    listener: std::os::unix::net::UnixListener,
    limits: runtime::ConnectionLimits,
) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let active = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                eprintln!("sandpane-service: accept failed: {e}");
                continue;
            }
        };
        if active.fetch_add(1, Ordering::SeqCst) >= limits.max_connections {
            active.fetch_sub(1, Ordering::SeqCst);
            let _ = stream.set_write_timeout(Some(limits.write_timeout));
            let mut s = &stream;
            let resp = err_frame(
                "",
                ErrorCode::Internal,
                format!(
                    "too many connections (limit {}); retry later",
                    limits.max_connections
                ),
            );
            let _ = writeln!(s, "{resp}");
            continue;
        }
        let inner = Arc::clone(&inner);
        // Review S-f: the slot is released by a drop guard, so a panicking
        // handler (unwinding) cannot leak it.
        let slot = ConnectionSlot(Arc::clone(&active));
        std::thread::spawn(move || {
            let _slot = slot;
            serve_connection_with(inner, stream, &limits);
        });
    }
}

/// Socket path policy: explicit `SANDPANE_SOCKET` override, else
/// `<data_dir>/sandpane.sock`. NEVER TCP. See [`runtime::socket_path_for`].
pub fn default_socket_path() -> std::path::PathBuf {
    runtime::socket_path_for(&runtime::PathEnv::from_process()).0
}

/// Database path policy: explicit `SANDPANE_DB` override, else the same
/// per-user private data directory.
pub fn default_db_path() -> std::path::PathBuf {
    runtime::db_path_for(&runtime::PathEnv::from_process())
}

/// Sandpane's own per-user data directory (security W5: always ends in
/// `sandpane`, matching every client). See [`runtime::data_dir_for`].
pub fn data_dir() -> std::path::PathBuf {
    runtime::data_dir_for(&runtime::PathEnv::from_process())
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

    /// Review S-f: a handler that panics still releases its connection slot.
    #[test]
    fn connection_slot_is_released_on_panic() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let active = Arc::new(AtomicUsize::new(1));
        let slot = ConnectionSlot(Arc::clone(&active));
        let r = std::thread::spawn(move || {
            let _slot = slot;
            panic!("handler bug");
        })
        .join();
        assert!(r.is_err());
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    /// A2 backstop: a handler that panics while holding an unresolved
    /// `pending` claim leaves the key `unknown` (refused), never `pending`
    /// for the life of the process and never free to re-run.
    #[test]
    fn a_claim_dropped_by_a_panic_is_marked_unknown() {
        let i = inner();
        let kc = KeyedCall {
            method: "sandbox.create",
            key: "boom".into(),
            hash: "h".into(),
        };
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let ClaimOutcome::Claimed(_claim) = kc.claim(&i).unwrap() else {
                panic!("expected a fresh claim");
            };
            panic!("handler bug mid-create");
        }));
        assert!(r.is_err());
        let state: String = i
            .lock_db()
            .conn()
            .query_row(
                "SELECT state FROM idempotency_keys WHERE method='sandbox.create' AND key='boom'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "unknown");
        match kc.stored_answer(&i) {
            Some(Err(f)) => {
                assert_eq!(f.code, ErrorCode::Conflict);
                assert_eq!(f.message, IDEM_MSG_UNKNOWN);
            }
            other => panic!("expected the unknown CONFLICT, got {other:?}"),
        }
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
