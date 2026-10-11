//! A6 — `git.apply` for reviewed `host_worktree` entries (design 2026-10-09
//! §3.6), and the A6 additions to `git.review` / `git.diff` on
//! `host_worktree` tasks (content binding, R4 review ids, C4 single read,
//! `hostHooksPath`). The apply pipeline itself lives in
//! `sandpane_core::apply`; this module owns the request shape, the task
//! context, the writer lock (W6), the durable events (W7) and restart
//! reconciliation.

use std::path::{Path, PathBuf};
use std::time::Instant;

use rusqlite::params;
use sandpane_core::apply::{self, ApplyError, PathState, Prepared, Reconciled};
use sandpane_core::diff::{self, TaskEntry};
use sandpane_core::git::ApplyWrite;
use sandpane_core::validation::Validator;
use sandpane_core::{git as scoregit, workspace, Database, EventLog};
use sandpane_protocol::{
    ApplyResult, ErrorCode, FileChange, FileChangeStatus, GitApplyParams, GitDiffResult,
    WorkspaceMode,
};

use crate::{
    git_context, internal, now_rfc3339, workspace_mode_from_stored, ReconciliationFailed,
    ServerInner, SvcError, SvcFailure, TaskGitContext, MSG_MOUNTLESS_REVIEW, MSG_NO_GIT_CONTEXT,
    MSG_NO_WORKTREE, MSG_NO_WORKTREE_ROOT, MSG_SBX_CLONE_REVIEW, MSG_WORKTREE_REMOVED,
};

/// Event kinds (open strings, not enum values; §3.6 item 8).
pub const EVENT_APPLY_STARTED: &str = "git.apply.started";
pub const EVENT_APPLIED: &str = "git.applied";
pub const EVENT_APPLY_FAILED: &str = "git.apply.failed";
pub const EVENT_APPLY_RECONCILED: &str = "git.apply.reconciled";

/// Longest `reviewId` accepted (Core issues 36-char UUIDs).
pub const MAX_REVIEW_ID_LEN: usize = 128;

/// A Core-owned `0700` temporary directory under `<data>/tmp`, removed on
/// drop. Never in the task worktree or the user's repository.
pub(crate) struct CoreTemp {
    path: PathBuf,
}

impl CoreTemp {
    pub(crate) fn new(inner: &ServerInner) -> Result<Self, String> {
        let root = inner
            .worktrees_root
            .as_deref()
            .and_then(Path::parent)
            .ok_or_else(|| "this Core instance was started without its data directory".to_string())?
            .join("tmp");
        #[cfg(unix)]
        crate::runtime::ensure_private_data_dir(&root).map_err(|e| e.to_string())?;
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        let mut b = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(&dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        let path = std::fs::canonicalize(&dir)
            .map_err(|e| format!("cannot resolve {}: {e}", dir.display()))?;
        Ok(Self { path })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for CoreTemp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// The host repository's object format, read once from its COMMON dir's
/// config by a `--git-dir`-pinned call from a Core temp dir (R3).
fn host_object_format(
    inner: &ServerInner,
    repo: &Path,
) -> Result<(sandpane_core::objects::ObjectFormat, PathBuf), SvcError> {
    let common = inner
        .git
        .common_dir(repo)
        .map_err(|e| (ErrorCode::Internal, e.to_string()))?;
    let tmp = CoreTemp::new(inner).map_err(|e| (ErrorCode::Internal, e))?;
    let format = inner
        .git
        .git_dir_session(&common, tmp.path())
        .map_err(|e| (ErrorCode::Internal, e.to_string()))?
        .format();
    Ok((format, common))
}

/// A6 additions to a `host_worktree` review: `taskBlob`/`taskMode` per
/// entry from Core's own read (item 3), a fresh `reviewId` remembered in
/// memory (R4), and the repo-relative `hostHooksPath` (item 9).
pub(crate) struct HostWorktreeReview {
    pub review_id: String,
    pub host_hooks_path: Option<String>,
}

pub(crate) fn enrich_review(
    inner: &ServerInner,
    task_id: &str,
    repo: &Path,
    worktree: &Path,
    raw: &[scoregit::RawChange],
    changes: &mut [FileChange],
) -> Result<HostWorktreeReview, SvcError> {
    let (format, _common) = host_object_format(inner, repo)?;
    for (c, r) in changes.iter_mut().zip(raw) {
        if c.status == FileChangeStatus::Deleted || !r.exact {
            continue;
        }
        if let Some((blob, mode)) = apply::task_blob_for(worktree, &c.path, format) {
            c.task_blob = Some(blob);
            c.task_mode = Some(mode);
        }
    }
    let review_id = uuid::Uuid::new_v4().to_string();
    inner.lock_reviews().record(task_id, &review_id, changes);
    let host_hooks_path = inner
        .git
        .effective_hooks_path(repo)
        .ok()
        .flatten()
        .and_then(|v| apply::repo_relative_hooks_path(repo, &v));
    Ok(HostWorktreeReview {
        review_id,
        host_hooks_path,
    })
}

/// `git.diff` on a `host_worktree` task (C4): the task file is read ONCE
/// (full content up to the apply cap), hashed, and the display rendered from
/// those same bytes. The base side comes from objects; tracked entries are
/// diffed between two Core-owned temp files with `diff --no-index` under
/// `--git-dir=<common>` (R2); untracked entries are synthesized as before.
/// `binary` is decided from the bytes read. Header names of tracked patches
/// are temp names (`a/base`, `b/task`); clients take names from JSON.
pub(crate) fn host_worktree_diff(
    inner: &ServerInner,
    repo: &Path,
    worktree: &Path,
    base: &str,
    entry: scoregit::RawChange,
    status: FileChangeStatus,
    cap: usize,
) -> Result<GitDiffResult, SvcError> {
    let refused = |m: String| {
        (
            ErrorCode::ValidationFailed,
            format!("{m}; nothing was read"),
        )
    };
    // A `deleted` entry's task side is absent by definition (the file may
    // still be on disk as a separate `untracked` entry after `git rm
    // --cached`): nothing is read for it.
    let read = if status == FileChangeStatus::Deleted {
        Ok(TaskEntry::Absent)
    } else {
        diff::read_task_entry(worktree, &entry.path, apply::APPLY_FILE_CAP)
    };
    let task = match read {
        Ok(t) => t,
        Err(diff::UntrackedError::Escapes(m))
        | Err(diff::UntrackedError::NotAFile(m))
        | Err(diff::UntrackedError::Changed(m)) => return Err(refused(m)),
        Err(diff::UntrackedError::Io(e)) => {
            return Err((
                ErrorCode::Internal,
                format!("reading {:?} failed: {e}", entry.path),
            ))
        }
    };
    let common = inner
        .git
        .common_dir(repo)
        .map_err(|e| (ErrorCode::Internal, e.to_string()))?;
    let tmp = CoreTemp::new(inner).map_err(|e| (ErrorCode::Internal, e))?;
    let session = inner
        .git
        .git_dir_session(&common, tmp.path())
        .map_err(|e| (ErrorCode::Internal, e.to_string()))?;
    let format = session.format();
    // ONE read: hash (full content only) and display come from `task`.
    let (task_bytes, task_mode, over_cap): (Option<&[u8]>, Option<&str>, bool) = match &task {
        TaskEntry::Absent => (None, None, false),
        TaskEntry::File {
            bytes, over_cap, ..
        } => (
            Some(bytes),
            task.git_mode().map(|m| m.git_mode()),
            *over_cap,
        ),
        TaskEntry::Symlink { target } => (Some(target), Some("120000"), false),
    };
    let (task_blob, task_mode_out) = match (task_bytes, over_cap) {
        (Some(bytes), false) => match sandpane_core::objects::blob_id(format, bytes) {
            Ok(oid) => (Some(oid), task_mode.map(str::to_string)),
            Err(_) => (None, None),
        },
        _ => (None, None),
    };
    if status == FileChangeStatus::Untracked {
        let bytes = task_bytes.unwrap_or(&[]);
        let mode = task
            .git_mode()
            .unwrap_or(sandpane_core::diff::NewFileMode::Regular);
        let binary = diff::is_binary(bytes);
        let (patch, truncated, lossy) = if binary {
            (String::new(), false, false)
        } else {
            let (bounded, truncated) =
                diff::new_file_patch_within(&entry.path, mode, bytes, over_cap, cap);
            let (text, lossy) = diff::decode_display(&bounded);
            (text, truncated, lossy)
        };
        return Ok(GitDiffResult {
            path: entry.path,
            old_path: None,
            status,
            patch,
            binary,
            truncated,
            lossy,
            base_blob: None,
            task_blob,
            task_mode: task_mode_out,
        });
    }
    // Tracked: the base side from objects (exact path lookup).
    let tree = session
        .ls_tree_full(base)
        .map_err(|e| (ErrorCode::Internal, e.to_string()))?;
    let base_side = entry.old_path.as_deref().unwrap_or(&entry.path);
    let base_entry = match status {
        FileChangeStatus::Added => None,
        _ => match tree.get(base_side) {
            Some(t) => Some(t.clone()),
            None => {
                return Err((
                    ErrorCode::Internal,
                    format!("{base_side:?} is listed as {status:?} but is not in the base tree"),
                ))
            }
        },
    };
    let (base_bytes, base_over_cap) = match &base_entry {
        Some(t) if t.kind == "blob" => {
            let (bytes, over) = session
                .cat_blob_capped(&t.oid, apply::APPLY_FILE_CAP)
                .map_err(|e| (ErrorCode::Internal, e.to_string()))?;
            (Some(bytes), over)
        }
        _ => (None, false),
    };
    let binary = base_bytes.as_deref().is_some_and(diff::is_binary)
        || task_bytes.is_some_and(diff::is_binary);
    let (patch, truncated, lossy) = if binary {
        (String::new(), false, false)
    } else if over_cap || base_over_cap {
        // A side larger than Core reads (32 MiB) cannot be diffed honestly
        // from a partial read: no hunks, and the answer says it is cut.
        (String::new(), true, false)
    } else {
        let cwd = tmp.path().join("cwd");
        std::fs::create_dir(&cwd).map_err(internal)?;
        let render = inner
            .git
            .git_dir_session(&common, &cwd)
            .map_err(|e| (ErrorCode::Internal, e.to_string()))?;
        let a = match (&base_entry, &base_bytes) {
            (Some(t), Some(bytes)) => {
                write_side(&cwd.join("base"), bytes, &t.mode).map_err(internal)?;
                "base"
            }
            _ => "/dev/null",
        };
        let b = match (task_bytes, task_mode) {
            (Some(bytes), Some(mode)) => {
                write_side(&cwd.join("task"), bytes, mode).map_err(internal)?;
                "task"
            }
            _ => "/dev/null",
        };
        let (bytes, more) = render
            .diff_no_index_display(a, b, cap)
            .map_err(|e| (ErrorCode::Internal, e.to_string()))?;
        let (cut, truncated) = diff::cut_display(&bytes, cap, more);
        let (text, lossy) = diff::decode_display(&cut);
        (text, truncated, lossy)
    };
    Ok(GitDiffResult {
        path: entry.path,
        old_path: entry.old_path,
        status,
        patch,
        binary,
        truncated,
        lossy,
        base_blob: base_entry.map(|t| t.oid),
        task_blob,
        task_mode: task_mode_out,
    })
}

/// One side of a display diff in Core's temp dir, with its git mode (a
/// symlink side is recreated as a symlink holding the same target text —
/// `diff --no-index` reads link text, never follows it).
fn write_side(path: &Path, bytes: &[u8], mode: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::PermissionsExt;
        if mode == "120000" {
            return std::os::unix::fs::symlink(std::ffi::OsStr::from_bytes(bytes), path);
        }
        std::fs::write(path, bytes)?;
        let bits = if mode == "100755" { 0o700 } else { 0o600 };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(bits))
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        std::fs::write(path, bytes)
    }
}

/// The writer lock on the host repository, released on drop (W6). Taken by
/// `git.apply` and by a worktree discard, so the two exclude each other and
/// any writer task bound to the repository path.
pub(crate) struct RepoWriterLock<'a> {
    inner: &'a ServerInner,
    key: String,
    holder: String,
}

impl<'a> RepoWriterLock<'a> {
    /// `Err(current holder)` when someone else holds it (never re-entrant).
    pub(crate) fn take(inner: &'a ServerInner, key: &str, holder: String) -> Result<Self, String> {
        // Bound first so the scheduler guard is dropped before the body.
        let taken = inner.lock_scheduler().try_lock_writer(key, &holder);
        taken.map(|()| Self {
            inner,
            key: key.to_string(),
            holder,
        })
    }
}

impl Drop for RepoWriterLock<'_> {
    fn drop(&mut self) {
        self.inner
            .lock_scheduler()
            .unlock_writer(&self.key, &self.holder);
    }
}

/// The writer-lock key of a registered repository: derived EXACTLY like the
/// key task admission uses for a `direct_mount` writer
/// (`registered_repository` → `fs::canonicalize(stored)`), so the two can
/// never name the same repository differently. Falls back to the stored
/// (already canonical) string when it cannot be resolved.
pub(crate) fn repo_lock_key(stored: &str) -> String {
    std::fs::canonicalize(stored)
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_else(|| stored.to_string())
}

/// W6: another writer, apply or discard holds the repository.
pub fn msg_locked(repo: &str, holder: &str) -> String {
    format!(
        "{repo} is busy: {holder} holds its writer lock (a running writer task, another apply or \
         a worktree discard); nothing was written"
    )
}

/// The holder name an operation uses on the repository writer lock.
pub(crate) fn apply_lock_holder(task_id: &str) -> String {
    format!("git.apply:{task_id}")
}

/// W-N1: the holder prefix of a direct_mount `sandbox.create` in flight.
const CREATE_LOCK_PREFIX: &str = "sandbox.create:";

/// W-N1: the holder name a direct_mount `sandbox.create` uses on the
/// repository writer lock it mounts.
pub(crate) fn create_lock_holder(sandbox: &str) -> String {
    format!("{CREATE_LOCK_PREFIX}{sandbox}")
}

/// W-N1: a direct_mount create refused because an apply, a discard or a
/// writing task holds the repository.
pub fn msg_create_repo_busy(repo: &str, holder: &str) -> String {
    format!(
        "{repo} is busy: {holder} holds its writer lock (a running writer task, an apply or a \
         worktree discard), and a direct_mount sandbox could change it while that runs; try \
         again when it finishes; nothing was created"
    )
}

/// W-N1: a direct_mount create refused because another direct_mount create
/// of the same repository is in flight.
pub fn msg_create_mount_in_progress(repo: &str, sandbox: &str) -> String {
    format!(
        "{repo} is busy: sandbox {sandbox:?} is being created with a direct mount of it; try \
         again when that create finishes; nothing was created"
    )
}

/// The CONFLICT a direct_mount create gets when the repository writer lock
/// is held (W-N1).
pub(crate) fn create_locked(repo: &str, holder: &str) -> SvcFailure {
    let message = match holder.strip_prefix(CREATE_LOCK_PREFIX) {
        Some(sandbox) => msg_create_mount_in_progress(repo, sandbox),
        None => msg_create_repo_busy(repo, holder),
    };
    SvcFailure::from((ErrorCode::Conflict, message))
}

/// W-N1: an apply refused because a direct_mount sandbox of the repository
/// is being created.
pub fn msg_mount_being_created(repo: &str, sandbox: &str) -> String {
    format!(
        "{repo} is busy: sandbox {sandbox:?} is being created with a direct mount of it and \
         could change it while Core writes; nothing was written"
    )
}

/// The CONFLICT an apply gets when the repository writer lock is held.
fn apply_locked(repo: &str, holder: &str) -> SvcFailure {
    let message = match holder.strip_prefix(CREATE_LOCK_PREFIX) {
        Some(sandbox) => msg_mount_being_created(repo, sandbox),
        None => msg_locked(repo, holder),
    };
    SvcFailure::from((ErrorCode::Conflict, message))
}

fn aborted(reason: impl Into<String>, conflicted: Vec<String>) -> ApplyResult {
    ApplyResult {
        applied: false,
        abort_reason: Some(reason.into()),
        conflicted_files: conflicted,
        applied_files: None,
        mode_changes: None,
        snapshot_tree: None,
        partial: None,
    }
}

fn to_value(r: ApplyResult) -> Result<serde_json::Value, SvcFailure> {
    serde_json::to_value(r).map_err(|e| SvcFailure::from(internal(e)))
}

fn invalid(m: &str) -> SvcFailure {
    SvcFailure::from((ErrorCode::ValidationFailed, m.to_string()))
}

/// `git.apply` (§3.6). Malformed params are VALIDATION_FAILED; an unknown
/// task NOT_FOUND; writer-lock contention CONFLICT; every gate refusal the
/// structured `applied: false` + `abortReason` (stable constants, "…;
/// nothing was written"); W1/W2 `applied: false` + `partial: true`.
pub(crate) fn git_apply(
    inner: &ServerInner,
    p: GitApplyParams,
) -> Result<serde_json::Value, SvcFailure> {
    // W-B: ONE deadline for everything before the durable start; every git
    // call on that path runs through `git`, bounded by it.
    let limits = inner.test_apply_limits.unwrap_or_default();
    let git = inner
        .git
        .with_deadline(Instant::now() + limits.prepare_budget);
    let too_slow = || to_value(aborted(apply::MSG_PREPARE_TOO_SLOW, vec![]));
    // Security W3: a FULL object id, compared exactly (never a prefix).
    Validator::full_object_id(&p.expected_base).map_err(|e| {
        SvcFailure::from((ErrorCode::ValidationFailed, format!("expected base: {e}")))
    })?;
    if p.selected_files.is_some() {
        return Err(invalid(apply::MSG_SELECTED_FILES));
    }
    let (Some(review_id), Some(entries)) = (p.review_id.as_deref(), p.entries.as_ref()) else {
        return Err(invalid(apply::MSG_NEEDS_REVIEW));
    };
    if entries.is_empty() || review_id.is_empty() || review_id.len() > MAX_REVIEW_ID_LEN {
        return Err(invalid(apply::MSG_NEEDS_REVIEW));
    }
    if entries.len() > apply::MAX_APPLY_ENTRIES {
        return Err(invalid(apply::MSG_TOO_MANY_ENTRIES));
    }
    let ctx = match git_context(inner, &p.task_id) {
        Ok(ctx) => ctx,
        Err((ErrorCode::NotFound, m)) => return Err(SvcFailure::from((ErrorCode::NotFound, m))),
        Err((_, m)) => return to_value(aborted(apply::msg_context(&m), vec![])),
    };
    let worktree = match apply_target(inner, &ctx) {
        Ok(wt) => wt,
        Err(reason) => return to_value(aborted(reason, vec![])),
    };
    let Some(base) = ctx.base_commit.clone() else {
        return to_value(aborted(apply::msg_context(MSG_NO_GIT_CONTEXT), vec![]));
    };
    // The CORE-RECORDED base drives every check, never the client's value.
    if !base.eq_ignore_ascii_case(&p.expected_base) {
        return to_value(aborted(
            apply::msg_expected_base(&p.expected_base, &base),
            vec![],
        ));
    }
    let resolved = match inner.lock_reviews().resolve(&p.task_id, review_id, entries) {
        Ok(r) => r,
        Err(e) => return apply_error(e),
    };
    let repo = PathBuf::from(&ctx.repo_path);
    let lock_key = repo_lock_key(&ctx.repo_path);
    let _lock = RepoWriterLock::take(inner, &lock_key, apply_lock_holder(&p.task_id))
        .map_err(|holder| apply_locked(&ctx.repo_path, &holder))?;
    // W-C: a live direct_mount sandbox (or unfinished direct_mount task)
    // on this repository could write while Core writes.
    refuse_direct_mounts(inner, &lock_key)?;
    // C3: the worktree is verified from the HOST side only.
    let root = inner
        .worktrees_root
        .as_deref()
        .ok_or_else(|| invalid(&apply::msg_context(MSG_NO_WORKTREE_ROOT)))?;
    if let Err(e) = workspace::verify_task_worktree_from_host(&git, &repo, root, &worktree) {
        if git.deadline_passed() {
            return too_slow();
        }
        return to_value(aborted(format!("{e}; nothing was written"), vec![]));
    }
    let common = match git.common_dir(&repo) {
        Ok(c) => c,
        Err(_) if git.deadline_passed() => return too_slow(),
        Err(e) => {
            return Err(SvcFailure::from((
                ErrorCode::Internal,
                format!("reading the repository's git dir: {e}; nothing was written"),
            )))
        }
    };
    let tmp = CoreTemp::new(inner).map_err(|e| {
        SvcFailure::from((ErrorCode::Internal, format!("{e}; nothing was written")))
    })?;
    let before_check = || {
        if let Some(hook) = &inner.test_apply_before_check {
            (hook.0)(inner);
        }
    };
    let prepared = match apply::prepare(apply::ApplyInputs {
        runner: &git,
        repo: &repo,
        common_dir: &common,
        worktree: &worktree,
        tmp: tmp.path(),
        base: &base,
        entries: resolved,
        check_timeout: limits.check_timeout,
        before_check: &before_check,
    }) {
        Ok(p) => p,
        Err(e) => return apply_error(e),
    };
    if let Some(hook) = &inner.test_apply_before_start {
        (hook.0)(inner);
    }
    // W-B: the budget is re-checked right before the durable start; past
    // it, nothing has been written yet. W-C is re-checked too.
    if git.deadline_passed() {
        return too_slow();
    }
    refuse_direct_mounts(inner, &lock_key)?;

    // W7: durable start BEFORE the first host write (rule 4).
    let started_payload = serde_json::json!({
        "files": prepared.applied_files,
        "baseCommit": base,
        "snapshotTree": prepared.snapshot_tree,
        "repoPath": ctx.repo_path,
        "entries": entries,
        "expected": states_json(&prepared.expected),
        "before": states_json(&prepared.before),
    });
    let started_sequence = {
        let db = inner.lock_db();
        EventLog::new(&db)
            .append(
                &p.task_id,
                EVENT_APPLY_STARTED,
                &started_payload,
                &now_rfc3339(),
            )
            .map_err(|e| {
                SvcFailure::from((
                    ErrorCode::Internal,
                    format!("recording the apply start failed: {e}; nothing was written"),
                ))
            })?
            .sequence
    };
    if let Some(hook) = &inner.test_apply_before_write {
        (hook.0)(inner);
    }
    // W-B: ONE deadline for the write phase (configuration read + `git
    // apply`); `git apply` itself is also capped at `write_timeout`.
    let writer = limits.write_runner(&inner.git, Instant::now());
    let write = apply::write_with_limits(
        &writer,
        &repo,
        &prepared,
        &sandpane_core::process::RunLimits {
            timeout: limits.write_timeout,
            ..inner.git.limits
        },
        limits.write_floor,
    );
    let result = match write {
        Ok(ApplyWrite::Written) => {
            if let Some(hook) = &inner.test_apply_after_write {
                (hook.0)(inner);
            }
            // W-B: each verification call is capped, and the phase has ONE
            // deadline.
            let verifier = limits.verify_runner(&inner.git, Instant::now());
            match apply::verify(&verifier, &repo, &prepared) {
                Ok(true) => ApplyResult {
                    applied: true,
                    abort_reason: None,
                    conflicted_files: vec![],
                    applied_files: Some(prepared.applied_files.clone()),
                    mode_changes: Some(prepared.mode_changes.clone()),
                    snapshot_tree: Some(prepared.snapshot_tree.clone()),
                    partial: None,
                },
                Ok(false) => partial(&prepared, apply::msg_verify_failed(&ctx.repo_path)),
                Err(_) => partial(&prepared, apply::msg_verify_unavailable(&ctx.repo_path)),
            }
        }
        // Only read-only steps ran: honestly "nothing was written".
        Ok(ApplyWrite::NotRun(_)) => ApplyResult {
            applied: false,
            abort_reason: Some(apply::MSG_WRITE_NOT_RUN.to_string()),
            conflicted_files: vec![],
            applied_files: None,
            mode_changes: None,
            snapshot_tree: None,
            partial: None,
        },
        Ok(ApplyWrite::TooLittleTime) => aborted(apply::MSG_WRITE_TOO_LATE, vec![]),
        Ok(ApplyWrite::Failed(_)) | Err(_) => {
            partial(&prepared, apply::msg_write_failed(&ctx.repo_path))
        }
        Ok(ApplyWrite::Killed) => partial(&prepared, apply::msg_write_killed(&ctx.repo_path)),
    };
    // W7: the outcome is durable BEFORE the response.
    let (kind, payload) = if result.applied {
        (
            EVENT_APPLIED,
            serde_json::json!({
                "startedSequence": started_sequence,
                "files": prepared.applied_files,
                "snapshotTree": prepared.snapshot_tree,
                "modeChanges": prepared.mode_changes,
            }),
        )
    } else {
        (
            EVENT_APPLY_FAILED,
            serde_json::json!({
                "startedSequence": started_sequence,
                "files": prepared.applied_files,
                "snapshotTree": prepared.snapshot_tree,
                "reason": result.abort_reason,
                "partial": result.partial.unwrap_or(false),
            }),
        )
    };
    {
        let db = inner.lock_db();
        EventLog::new(&db)
            .append(&p.task_id, kind, &payload, &now_rfc3339())
            .map_err(|e| {
                SvcFailure::from((
                    ErrorCode::Internal,
                    format!(
                        "git ran, but Core could not record the outcome ({e}) — check `git \
                         status` in {}",
                        ctx.repo_path
                    ),
                ))
            })?;
    }
    to_value(result)
}

/// W-C: CONFLICT ([`apply::msg_mounted`]) while a non-removed sandbox
/// binding that mounts the repository directly, or an unfinished task that
/// works in it directly, exists for the same registered repository (same
/// canonical key, across projects). Fail-safe: a binding whose stored mode
/// Core cannot read, and a legacy task with no mode, count as direct.
/// I-N2: stored workspace modes Core reads as NOT live-writable (both the
/// bare and the pre-0004 JSON-quoted shapes); the SQL prefilter drops only
/// these. Anything else (NULL, unknown) reaches the Rust check.
const SAFE_MODES_STORED: [&str; 6] = [
    "host_worktree",
    "\"host_worktree\"",
    "sbx_clone",
    "\"sbx_clone\"",
    "mountless",
    "\"mountless\"",
];

/// I-N2: stored task statuses Core reads as terminal (statuses are stored
/// bare; any other shape is unreadable and counts as unfinished).
const TERMINAL_STATUSES_STORED: [&str; 5] = [
    "completed",
    "rejected",
    "failed",
    "cancelled",
    "interrupted",
];

fn refuse_direct_mounts(inner: &ServerInner, lock_key: &str) -> Result<(), SvcFailure> {
    type Binding = (String, Option<String>, Option<String>);
    type Task = (String, String, Option<String>, String);
    let db_err = |e: rusqlite::Error| SvcFailure::from(internal(e));
    let modes = rusqlite::params_from_iter(SAFE_MODES_STORED.iter());
    let (bindings, tasks): (Vec<Binding>, Vec<Task>) = {
        let db = inner.lock_db();
        // I-N3: LEFT JOIN — a binding whose repository is unknown (NULL
        // `repo_id`, or no such row) is still seen. I-N2: `x IS NULL OR x
        // NOT IN (...)`, never a bare NOT IN (NULL would drop the row).
        let mut stmt = db
            .conn()
            .prepare(
                "SELECT b.sandbox_name, b.workspace_mode, r.canonical_path
                 FROM sandbox_bindings b LEFT JOIN repositories r ON r.id = b.repo_id
                 WHERE b.removed_at IS NULL
                   AND (b.workspace_mode IS NULL
                        OR b.workspace_mode NOT IN (?1, ?2, ?3, ?4, ?5, ?6))",
            )
            .map_err(db_err)?;
        let bindings = stmt
            .query_map(modes, |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        let mut stmt = db
            .conn()
            .prepare(
                "SELECT t.id, t.status, t.workspace_mode, r.canonical_path
                 FROM tasks t JOIN repositories r ON r.id = t.repo_id
                 WHERE (t.workspace_mode IS NULL
                        OR t.workspace_mode NOT IN (?1, ?2, ?3, ?4, ?5, ?6))
                   AND (t.status IS NULL OR t.status NOT IN (?7, ?8, ?9, ?10, ?11))",
            )
            .map_err(db_err)?;
        let task_params = rusqlite::params_from_iter(
            SAFE_MODES_STORED
                .iter()
                .chain(TERMINAL_STATUSES_STORED.iter()),
        );
        let tasks = stmt
            .query_map(task_params, |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        (bindings, tasks)
    };
    // Fail-safe: no mode (legacy) or a mode Core cannot read counts as
    // direct. (The Rust check stays the authority; the SQL only prefilters.)
    let direct = |mode: Option<&str>| match mode {
        None => true,
        Some(m) => !matches!(
            workspace_mode_from_stored(m),
            Some(WorkspaceMode::HostWorktree | WorkspaceMode::SbxClone | WorkspaceMode::Mountless)
        ),
    };
    let conflict = |what: String| {
        Err(SvcFailure::from((
            ErrorCode::Conflict,
            apply::msg_mounted(&what),
        )))
    };
    for (name, mode, path) in bindings {
        // I-N3: an unknown repository matches (fail-safe).
        let same_repo = path.as_deref().is_none_or(|p| repo_lock_key(p) == lock_key);
        if direct(mode.as_deref()) && same_repo {
            return conflict(format!("sandbox {name:?}"));
        }
    }
    for (id, status, mode, path) in tasks {
        if !direct(mode.as_deref()) || repo_lock_key(&path) != lock_key {
            continue;
        }
        // A status Core cannot read counts as unfinished (fail-safe).
        let finished = crate::task_status_from_stored(&status, &id)
            .map(|s| sandpane_core::task::TaskStateMachine::from_status(s).is_terminal())
            .unwrap_or(false);
        if !finished {
            return conflict(format!("direct_mount task {id}"));
        }
    }
    Ok(())
}

fn partial(prepared: &Prepared, reason: String) -> ApplyResult {
    ApplyResult {
        applied: false,
        abort_reason: Some(reason),
        conflicted_files: vec![],
        applied_files: Some(prepared.applied_files.clone()),
        mode_changes: None,
        snapshot_tree: Some(prepared.snapshot_tree.clone()),
        partial: Some(true),
    }
}

fn apply_error(e: ApplyError) -> Result<serde_json::Value, SvcFailure> {
    match e {
        ApplyError::Invalid(m) => Err(SvcFailure::from((ErrorCode::ValidationFailed, m))),
        ApplyError::Refused {
            reason,
            conflicted_files,
        } => to_value(aborted(reason, conflicted_files)),
        ApplyError::Internal(m) => Err(SvcFailure::from((ErrorCode::Internal, m))),
    }
}

fn states_json(states: &[PathState]) -> serde_json::Value {
    serde_json::Value::Array(
        states
            .iter()
            .map(|s| match &s.entry {
                Some((mode, oid)) => serde_json::json!({"path": s.path, "mode": mode, "oid": oid}),
                None => serde_json::json!({"path": s.path}),
            })
            .collect(),
    )
}

fn states_from_json(v: &serde_json::Value) -> Option<Vec<PathState>> {
    v.as_array()?
        .iter()
        .map(|s| {
            let path = s.get("path")?.as_str()?.to_string();
            let entry = match (s.get("mode"), s.get("oid")) {
                (Some(m), Some(o)) => Some((m.as_str()?.to_string(), o.as_str()?.to_string())),
                (None, None) => None,
                _ => return None,
            };
            Some(PathState { path, entry })
        })
        .collect()
}

/// §3.6 item 1: which task tree an apply reads, refusing every mode but
/// `host_worktree` with the review wording (+ "; nothing was written"). No
/// git runs in the worktree here (C3).
fn apply_target(inner: &ServerInner, ctx: &TaskGitContext) -> Result<PathBuf, String> {
    let mode = match &ctx.workspace_mode {
        None => None,
        Some(stored) => Some(workspace_mode_from_stored(stored).ok_or_else(|| {
            apply::msg_context(&format!(
                "task stores workspace mode {stored:?}, which is not a Core mode"
            ))
        })?),
    };
    match mode {
        None | Some(WorkspaceMode::DirectMount) => Err(apply::MSG_DIRECT_MOUNT.to_string()),
        Some(WorkspaceMode::SbxClone) => Err(apply::msg_context(MSG_SBX_CLONE_REVIEW)),
        Some(WorkspaceMode::Mountless) => Err(apply::msg_context(MSG_MOUNTLESS_REVIEW)),
        Some(WorkspaceMode::HostWorktree) => {
            if ctx.worktree_removed {
                return Err(apply::msg_context(MSG_WORKTREE_REMOVED));
            }
            if inner.worktrees_root.is_none() {
                return Err(apply::msg_context(MSG_NO_WORKTREE_ROOT));
            }
            ctx.worktree_path
                .as_ref()
                .map(PathBuf::from)
                .ok_or_else(|| apply::msg_context(MSG_NO_WORKTREE))
        }
    }
}

/// Restart reconciliation of an unterminated `git.apply.started` (§3.6
/// item 8): the host index decides applied / partial / not applied — never
/// assumed. When git cannot answer, the outcome is `unknown` (recorded, so
/// the start is terminated, and still never assumed). A database failure
/// fails closed (Core does not serve).
pub fn reconcile_applies_after_restart(
    db: &Database,
    git: &scoregit::GitRunner,
) -> Result<Vec<(String, String)>, ReconciliationFailed> {
    let fail = |what: &str, e: &dyn std::fmt::Display| {
        ReconciliationFailed(format!("apply restart reconciliation failed ({what}): {e}"))
    };
    // A6 I2: an outcome names the start it ends (`startedSequence`); a
    // start is open unless an outcome or reconciliation names IT — a later
    // apply's outcome never closes an earlier orphaned start.
    let rows: Vec<(String, i64, String, String)> = {
        let mut stmt = db
            .conn()
            .prepare(
                "SELECT task_id, sequence, kind, payload FROM task_events
                 WHERE kind IN (?1, ?2, ?3, ?4)
                 ORDER BY task_id, sequence",
            )
            .map_err(|e| fail("prepare", &e))?;
        let rows = stmt
            .query_map(
                params![
                    EVENT_APPLY_STARTED,
                    EVENT_APPLIED,
                    EVENT_APPLY_FAILED,
                    EVENT_APPLY_RECONCILED
                ],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|e| fail("query", &e))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| fail("read row", &e))?
    };
    let closed: std::collections::HashSet<(String, i64)> = rows
        .iter()
        .filter(|(_, _, kind, _)| kind != EVENT_APPLY_STARTED)
        .filter_map(|(task, _, _, payload)| {
            let v: serde_json::Value = serde_json::from_str(payload).ok()?;
            Some((task.clone(), v.get("startedSequence")?.as_i64()?))
        })
        .collect();
    let open: Vec<(String, i64, String)> = rows
        .into_iter()
        .filter(|(task, seq, kind, _)| {
            kind == EVENT_APPLY_STARTED && !closed.contains(&(task.clone(), *seq))
        })
        .map(|(task, seq, _, payload)| (task, seq, payload))
        .collect();
    let mut out = Vec::new();
    for (task_id, sequence, payload) in open {
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap_or_default();
        let outcome = (|| {
            let repo = parsed.get("repoPath")?.as_str()?;
            let expected = states_from_json(parsed.get("expected")?)?;
            let before = states_from_json(parsed.get("before")?)?;
            apply::reconcile(git, Path::new(repo), &expected, &before).ok()
        })();
        let outcome = outcome.map(Reconciled::as_str).unwrap_or("unknown");
        EventLog::new(db)
            .append(
                &task_id,
                EVENT_APPLY_RECONCILED,
                &serde_json::json!({
                    "outcome": outcome,
                    "reconciledAfterRestart": true,
                    "startedSequence": sequence,
                    "files": parsed.get("files").cloned().unwrap_or_default(),
                }),
                &now_rfc3339(),
            )
            .map_err(|e| fail(&format!("task {task_id}"), &e))?;
        eprintln!(
            "sandpane-service: task {task_id}: an apply interrupted by a restart was reconciled \
             as {outcome}"
        );
        out.push((task_id, outcome.to_string()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// I-N2: the SQL prefilter may only drop what the Rust check would also
    /// let through — every excluded mode decodes to a non-direct mode, and
    /// every excluded status to a terminal one.
    #[test]
    fn the_sql_prefilter_excludes_only_what_rust_reads_as_safe() {
        for m in SAFE_MODES_STORED {
            assert!(
                matches!(
                    workspace_mode_from_stored(m),
                    Some(
                        WorkspaceMode::HostWorktree
                            | WorkspaceMode::SbxClone
                            | WorkspaceMode::Mountless
                    )
                ),
                "{m}"
            );
        }
        for s in TERMINAL_STATUSES_STORED {
            let status = crate::task_status_from_stored(s, "t").unwrap();
            assert!(
                sandpane_core::task::TaskStateMachine::from_status(status).is_terminal(),
                "{s}"
            );
        }
        assert!(matches!(
            workspace_mode_from_stored("\"direct_mount\""),
            Some(WorkspaceMode::DirectMount)
        ));
    }
}
