//! A6 — `git.apply` for reviewed `host_worktree` entries (design 2026-10-09
//! §3.6). The first path that writes into the user's own repository
//! (AGENTS.md rule 7, specs/06 §6).
//!
//! The apply is bound to the exact content Core hashed at review, never
//! merges into the user's edits, never writes beyond a symlink, and is
//! recorded durably (the service appends the events). The pipeline:
//!
//! 1. [`ReviewStore::resolve`] — every entry must be a member of a review
//!    Core produced (R4), copied verbatim; a path listed twice is refused.
//! 2. [`prepare`] — item 3 entry validation from Core alone (base side from
//!    `ls-tree` under `--git-dir=<common>`, task side from the `openat` walk,
//!    content hashed by Core); item 4 snapshot from objects only in a
//!    Core-owned temp index, the C1 exact-set check, the patch WITHOUT a
//!    pathspec; item 5 host gates (submodules, HEAD, touched-path status,
//!    W3 hidden entries, C2 leading paths, R5 filters); `git apply --check`.
//!    NO git process on this path reads the task worktree (C3): task-side
//!    calls run in a [`GitDirSession`] from Core's temp dir.
//! 3. [`write`] — `git apply --index` under its own limit (W1/R6).
//! 4. [`verify`] — W2: the host index holds exactly the snapshot entries for
//!    the touched paths and their work-tree files match the index.
//! 5. [`reconcile`] — restart reconciliation of an unterminated start.
//!
//! Every refusal message is a stable string ending "; nothing was written";
//! the W1/W2/R6 outcomes have their own wording (never "nothing was
//! written").

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sandpane_protocol::{FileChange, FileChangeStatus, ModeChange};

use crate::diff::{self, HostLeaf, TaskEntry, UntrackedError};
use crate::git::{
    ApplyCheck, ApplyWrite, CacheEntry, GitDirSession, GitError, GitMode, GitRunner,
    LiteralPathspec, RawPath, TreeEntry,
};
use crate::objects::{self, ObjectError, ObjectFormat};
use crate::process::RunLimits;

/// Files larger than this are not hashed and cannot be applied ("too large
/// to apply", §3.6 item 3).
pub const APPLY_FILE_CAP: usize = 32 * 1024 * 1024;
/// At most this many entries per apply (part of the item 6 budget).
pub const MAX_APPLY_ENTRIES: usize = 1000;
/// The total patch size cap (item 6 budget).
pub const MAX_APPLY_PATCH_BYTES: usize = 64 * 1024 * 1024;
/// Everything before the write must finish within this, or nothing is
/// written (item 6 budget: the whole chain fits inside the 45 s client
/// deadline).
pub const APPLY_PREPARE_BUDGET: Duration = Duration::from_secs(20);
/// The write's OWN limit (not the QUERY kill).
pub const APPLY_WRITE_TIMEOUT: Duration = Duration::from_secs(15);
/// Reviews kept per task (R4); older ones are forgotten.
pub const REVIEWS_KEPT_PER_TASK: usize = 8;
/// W-B: each post-write verification call is capped at this (two calls).
pub const APPLY_VERIFY_TIMEOUT: Duration = Duration::from_secs(3);
/// The clients' `git.apply` deadline (desktop proxy 43 s; §3.6 item 10).
pub const CLIENT_APPLY_DEADLINE: Duration = Duration::from_secs(45);

/// W-B: the time limits of one `git.apply` call. Production uses
/// [`ApplyLimits::default`]; tests inject shorter values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApplyLimits {
    /// One deadline, from the request's start, for everything before the
    /// durable start: context checks, validation, gates, snapshot, check.
    pub prepare_budget: Duration,
    /// Upper bound of `git apply --check` (also bounded by what is left of
    /// `prepare_budget`).
    pub check_timeout: Duration,
    /// The `git apply` call's own limit (R6).
    pub write_timeout: Duration,
    /// One deadline for the whole write phase: the configuration read that
    /// precedes `git apply`, and `git apply` itself.
    pub write_budget: Duration,
    /// I-N1: `git apply` is started only with at least this much of the
    /// write phase left.
    pub write_floor: Duration,
    /// Each post-write verification call (W2).
    pub verify_timeout: Duration,
    /// One deadline for the whole verification phase (two host calls, each
    /// preceded by a configuration read).
    pub verify_budget: Duration,
}

impl Default for ApplyLimits {
    fn default() -> Self {
        Self {
            prepare_budget: APPLY_PREPARE_BUDGET,
            check_timeout: RunLimits::QUERY.timeout,
            write_timeout: APPLY_WRITE_TIMEOUT,
            write_budget: APPLY_WRITE_TIMEOUT,
            write_floor: Duration::from_secs(5),
            verify_timeout: APPLY_VERIFY_TIMEOUT,
            verify_budget: Duration::from_secs(6),
        }
    }
}

impl ApplyLimits {
    /// The runner for the write phase: its own calls (the configuration
    /// read) capped at [`RunLimits::PROBE`]'s timeout (I-N1), every process
    /// bounded by ONE phase deadline. `git apply` gets explicit limits.
    pub fn write_runner(&self, git: &GitRunner, now: std::time::Instant) -> GitRunner {
        git.with_limits(RunLimits {
            timeout: RunLimits::PROBE.timeout,
            ..git.limits
        })
        .with_deadline(now + self.write_budget)
    }

    /// The runner for the verification phase: each call capped at
    /// `verify_timeout`, the phase bounded by ONE deadline.
    pub fn verify_runner(&self, git: &GitRunner, now: std::time::Instant) -> GitRunner {
        git.with_limits(RunLimits {
            timeout: self.verify_timeout,
            ..git.limits
        })
        .with_deadline(now + self.verify_budget)
    }
}
/// Tasks whose reviews are kept (oldest task evicted first).
pub const REVIEW_TASKS_KEPT: usize = 256;
/// At most this many paths are named in one message / `conflictedFiles`.
pub const PATHS_IN_MESSAGE: usize = 20;
pub const MAX_CONFLICTED_FILES: usize = 100;

const NOTHING_WRITTEN: &str = "; nothing was written";

// --- Stable messages (clients match on these) ------------------------------

/// Pre-A6 shape or no review binding (VALIDATION_FAILED).
pub const MSG_NEEDS_REVIEW: &str = "git.apply needs reviewId and a non-empty entries list copied \
     from a git.review answer; nothing was written";
/// `selectedFiles`, alone or with `entries` (VALIDATION_FAILED).
pub const MSG_SELECTED_FILES: &str = "selectedFiles is not accepted: send reviewId and entries \
     copied from a git.review answer instead; nothing was written";
/// More than [`MAX_APPLY_ENTRIES`] entries (VALIDATION_FAILED).
pub const MSG_TOO_MANY_ENTRIES: &str =
    "at most 1000 entries can be applied at once; nothing was written";
/// §3.6 item 3 (exact wording).
pub const MSG_ENTRIES_NOT_REVIEWED: &str =
    "entries do not match a review Core produced; review again; nothing was written";
/// §3.6 item 1.
pub const MSG_DIRECT_MOUNT: &str = "this task worked directly in your repository; its changes \
     are already in your working tree, so there is nothing to apply; nothing was written";
/// §3.6 item 6: `git apply --check` failed.
pub const MSG_CHECK_FAILED: &str = "the patch does not apply cleanly; nothing was written";
/// Item 6 budget.
pub const MSG_PATCH_TOO_LARGE: &str = "the selected changes are too large to apply in one step \
     (the patch exceeds 64 MiB); nothing was written";
/// Item 6 budget.
pub const MSG_PREPARE_TOO_SLOW: &str = "preparing the apply took longer than its 20 s budget; \
     apply fewer files at once; nothing was written";
/// W-A: the selected entries' new content exceeds the cap; checked while
/// reading, before any temp copy or object is written.
pub const MSG_CONTENT_TOO_LARGE: &str = "the selected files hold more than 64 MiB of new content, \
     too much to apply in one step; apply fewer files at once; nothing was written";
/// I-N1: less than the floor was left of the write phase; `git apply` was
/// not started.
pub const MSG_WRITE_TOO_LATE: &str = "git apply was not started (too little of its time budget \
     was left to finish it safely); nothing was written";
/// W-B: the write phase ran out (or failed) before `git apply` started —
/// only a read-only configuration read ran.
pub const MSG_WRITE_NOT_RUN: &str = "git apply was not started (reading the repository's \
     configuration timed out or failed); nothing was written";
/// I3: `git apply --check` did not answer (killed, failed to start, or an
/// unexpected exit) — distinct from [`MSG_CHECK_FAILED`].
pub const MSG_CHECK_UNAVAILABLE: &str =
    "git could not check the patch (timed out or failed); nothing was written";
/// Item 5: the host repository has no commit.
pub const MSG_HOST_UNBORN: &str =
    "your repository has no commit, so it is not at the task's base; nothing was written";
/// Item 5 (host `confirm_work_tree`).
pub const MSG_HOST_WORK_TREE_REDIRECTED: &str = "git does not place your repository's work tree \
     at its root (is a repository-local core.worktree set?); nothing was written";

fn q(path: &str) -> String {
    format!("{path:?}")
}

fn list(paths: &[String]) -> String {
    let shown: Vec<String> = paths.iter().take(PATHS_IN_MESSAGE).map(|p| q(p)).collect();
    let more = paths.len().saturating_sub(PATHS_IN_MESSAGE);
    if more > 0 {
        format!("{} (and {more} more)", shown.join(", "))
    } else {
        shown.join(", ")
    }
}

/// §3.6 item 3: presence, type, hash or mode differ from the review.
pub fn msg_changed(path: &str) -> String {
    format!(
        "{} changed since it was reviewed; review it again{NOTHING_WRITTEN}",
        q(path)
    )
}
/// A path listed twice (as `path` or `oldPath`).
pub fn msg_listed_twice(path: &str) -> String {
    format!(
        "{} is listed more than once in entries{NOTHING_WRITTEN}",
        q(path)
    )
}
/// A non-deleted entry without a reviewed content id.
pub fn msg_no_content(path: &str) -> String {
    format!(
        "{} has no reviewed content id (it was over the 32 MiB apply cap, or not a file Core \
         could read, when it was reviewed), so it is too large or unsupported to apply\
         {NOTHING_WRITTEN}",
        q(path)
    )
}
/// Mode 120000 on the task side.
pub fn msg_symlink(path: &str) -> String {
    format!("{}: symlinks are never applied{NOTHING_WRITTEN}", q(path))
}
/// A gitlink anywhere in the entry.
pub fn msg_gitlink(path: &str) -> String {
    format!(
        "{}: submodule entries (gitlinks) are never applied{NOTHING_WRITTEN}",
        q(path)
    )
}
/// R7: the base side is a symlink.
pub fn msg_base_symlink(path: &str) -> String {
    format!(
        "{} is a symlink in the base commit; deleting or replacing a tracked symlink is not \
         supported{NOTHING_WRITTEN}",
        q(path)
    )
}
/// sha1dc detected a collision attack in the content.
pub fn msg_collision(path: &str) -> String {
    format!(
        "{}: the content appears to be part of a SHA-1 collision attack{NOTHING_WRITTEN}",
        q(path)
    )
}
/// C1 exact-set mismatch (exact wording).
pub fn msg_snapshot_differs(path: &str) -> String {
    format!(
        "{}: the snapshot differs from the reviewed entries{NOTHING_WRITTEN}",
        q(path)
    )
}
/// C2 (exact wording).
pub fn msg_leading_path(path: &str) -> String {
    format!(
        "{} lies under a symlink or a file in your working tree{NOTHING_WRITTEN}",
        q(path)
    )
}
/// Item 5: touched paths are not clean in the host.
pub fn msg_dirty(paths: &[String]) -> String {
    format!(
        "{} in your working tree have uncommitted changes or are untracked or ignored files\
         {NOTHING_WRITTEN}",
        list(paths)
    )
}
/// W3.
pub fn msg_hidden(paths: &[String]) -> String {
    format!(
        "{} are flagged assume-unchanged or skip-worktree in your index, which hides changes\
         {NOTHING_WRITTEN}",
        list(paths)
    )
}
/// R5.
pub fn msg_filtered(path: &str, filter: &str) -> String {
    format!(
        "{} has the filter attribute {filter:?} (for example Git LFS) in your repository; Core \
         never runs filters, so it would receive raw content{NOTHING_WRITTEN}",
        q(path)
    )
}
/// Item 5: HEAD moved.
pub fn msg_head_moved(head: &str, base: &str) -> String {
    format!("your repository's HEAD is {head}, not the task's base {base}{NOTHING_WRITTEN}")
}
/// The client's `expectedBase` is not the task's recorded base.
pub fn msg_expected_base(expected: &str, base: &str) -> String {
    format!(
        "base diverged: the task's recorded base is {base}, the client expected {expected}\
         {NOTHING_WRITTEN}"
    )
}
/// A context/mode refusal reusing the review wording (§3.6 item 1).
pub fn msg_context(review_message: &str) -> String {
    format!("{review_message}{NOTHING_WRITTEN}")
}
/// W1 (exact wording).
pub fn msg_write_failed(repo: &str) -> String {
    format!(
        "the write failed after git's checks passed; some files may have been written or staged \
         — check `git status` in {repo}"
    )
}
/// W1 + R6.
pub fn msg_write_killed(repo: &str) -> String {
    format!(
        "{}; `.git/index.lock` may remain — remove it only after checking that no git process \
         is running",
        msg_write_failed(repo)
    )
}
/// W-B: post-write verification could not finish (a partial outcome).
pub fn msg_verify_unavailable(repo: &str) -> String {
    format!("could not verify the staged content — check `git status` in {repo}")
}
/// W-C: a live direct_mount sandbox (or unfinished direct_mount task) can
/// change the repository while Core writes. `what` names it.
pub fn msg_mounted(what: &str) -> String {
    format!(
        "{what}: a sandbox mounts this repository directly and can change it while Core writes; \
         stop or remove it first{NOTHING_WRITTEN}"
    )
}
/// W2 (exact wording).
pub fn msg_verify_failed(repo: &str) -> String {
    format!(
        "files were changed, but the staged content differs from the reviewed content — check \
         `git status` in {repo}"
    )
}

/// Why an apply did not happen (before any host write).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyError {
    /// Malformed request: VALIDATION_FAILED.
    Invalid(String),
    /// A gate refused: `applied: false` + `abortReason`; nothing written.
    Refused {
        reason: String,
        conflicted_files: Vec<String>,
    },
    /// Core or git failed before any host write: INTERNAL ("…; nothing was
    /// written").
    Internal(String),
}

impl ApplyError {
    pub fn refused(reason: impl Into<String>) -> Self {
        Self::Refused {
            reason: reason.into(),
            conflicted_files: vec![],
        }
    }

    fn internal(what: &str, e: impl std::fmt::Display) -> Self {
        Self::Internal(format!("{what}: {e}{NOTHING_WRITTEN}"))
    }
}

// --- Reviews (R4) ----------------------------------------------------------

/// The last [`REVIEWS_KEPT_PER_TASK`] `host_worktree` reviews per task, in
/// memory only (a Core restart means review again). "Reviewed" means "Core
/// listed it": `git.review` never lists ignored files.
#[derive(Debug, Default)]
pub struct ReviewStore {
    by_task: HashMap<String, VecDeque<(String, Vec<FileChange>)>>,
    task_order: VecDeque<String>,
}

fn same_change(a: &FileChange, b: &FileChange) -> bool {
    a.path == b.path
        && a.status == b.status
        && a.old_path == b.old_path
        && a.task_blob == b.task_blob
        && a.task_mode == b.task_mode
}

/// A reviewed entry, re-validated as raw repository paths. Only
/// [`ReviewStore::resolve`] builds one.
#[derive(Debug, Clone)]
pub struct ReviewedEntry {
    change: FileChange,
    path: RawPath,
    old_path: Option<RawPath>,
}

impl ReviewedEntry {
    pub fn change(&self) -> &FileChange {
        &self.change
    }
}

impl ReviewStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Remember one review answer for `task_id` under `review_id`.
    pub fn record(&mut self, task_id: &str, review_id: &str, changes: &[FileChange]) {
        if !self.by_task.contains_key(task_id) {
            self.task_order.push_back(task_id.to_string());
            while self.task_order.len() > REVIEW_TASKS_KEPT {
                if let Some(old) = self.task_order.pop_front() {
                    self.by_task.remove(&old);
                }
            }
        }
        let q = self.by_task.entry(task_id.to_string()).or_default();
        q.push_back((review_id.to_string(), changes.to_vec()));
        while q.len() > REVIEWS_KEPT_PER_TASK {
            q.pop_front();
        }
    }

    /// Every entry must be a member of review `review_id` of `task_id` with
    /// identical `path`, `status`, `oldPath`, `taskBlob` and `taskMode`; no
    /// path may be listed twice (as `path` or `oldPath`).
    pub fn resolve(
        &self,
        task_id: &str,
        review_id: &str,
        entries: &[FileChange],
    ) -> Result<Vec<ReviewedEntry>, ApplyError> {
        let not_reviewed = || ApplyError::refused(MSG_ENTRIES_NOT_REVIEWED);
        let review = self
            .by_task
            .get(task_id)
            .and_then(|q| q.iter().find(|(id, _)| id == review_id))
            .map(|(_, changes)| changes)
            .ok_or_else(not_reviewed)?;
        if !entries
            .iter()
            .all(|e| review.iter().any(|r| same_change(e, r)))
        {
            return Err(not_reviewed());
        }
        let mut seen: Vec<&str> = Vec::new();
        for e in entries {
            for p in std::iter::once(e.path.as_str()).chain(e.old_path.as_deref()) {
                if seen.contains(&p) {
                    return Err(ApplyError::refused(msg_listed_twice(p)));
                }
                seen.push(p);
            }
        }
        entries
            .iter()
            .map(|e| {
                let bad = |_| ApplyError::refused(msg_no_content(&e.path));
                Ok(ReviewedEntry {
                    change: e.clone(),
                    path: RawPath::new(&e.path).map_err(bad)?,
                    old_path: e
                        .old_path
                        .as_deref()
                        .map(RawPath::new)
                        .transpose()
                        .map_err(bad)?,
                })
            })
            .collect()
    }
}

// --- Review-side content binding (item 3) ----------------------------------

/// `(taskBlob, taskMode)` for `rel` in the task worktree, from Core's own
/// read (A6 item 3): `None` when absent, over [`APPLY_FILE_CAP`], not a
/// file or symlink, unreadable, or a detected SHA-1 collision.
pub fn task_blob_for(worktree: &Path, rel: &str, format: ObjectFormat) -> Option<(String, String)> {
    match diff::read_task_entry(worktree, rel, APPLY_FILE_CAP).ok()? {
        TaskEntry::File { over_cap: true, .. } | TaskEntry::Absent => None,
        entry @ TaskEntry::File { .. } | entry @ TaskEntry::Symlink { .. } => {
            let mode = entry.git_mode()?.git_mode().to_string();
            let bytes = match &entry {
                TaskEntry::File { bytes, .. } => bytes,
                TaskEntry::Symlink { target } => target,
                TaskEntry::Absent => return None,
            };
            Some((objects::blob_id(format, bytes).ok()?, mode))
        }
    }
}

/// The effective `core.hooksPath` in repo-relative form, or `None` when it
/// is not inside the repository root (§3.6 item 9). A relative value is
/// relative to the work-tree root (where hooks run); an absolute one counts
/// only when it lies under `repo_root` (lexically). `..` escaping the root,
/// `~` (home-relative) and an empty result are `None`.
pub fn repo_relative_hooks_path(repo_root: &Path, value: &str) -> Option<String> {
    if value.is_empty() || value.starts_with('~') || value.contains('\0') {
        return None;
    }
    let candidate = if Path::new(value).is_absolute() {
        Path::new(value).strip_prefix(repo_root).ok()?.to_path_buf()
    } else {
        PathBuf::from(value)
    };
    let mut parts: Vec<String> = Vec::new();
    for c in candidate.components() {
        match c {
            std::path::Component::Normal(s) => parts.push(s.to_str()?.to_string()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                parts.pop()?;
            }
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

// --- Prepare (items 3, 4, 5, 6 --check) ------------------------------------

/// Inputs of [`prepare`]. Paths are canonical; `worktree` was verified by
/// the caller WITHOUT running git in it (registered in the host's worktree
/// list, a real directory under Core's root).
pub struct ApplyInputs<'a> {
    pub runner: &'a GitRunner,
    /// The registered host repository root.
    pub repo: &'a Path,
    /// Its canonical common git dir (from the registered repository).
    pub common_dir: &'a Path,
    /// The task worktree (read only by Core, through `openat`).
    pub worktree: &'a Path,
    /// A Core-owned `0700` temporary directory, empty.
    pub tmp: &'a Path,
    /// The task's recorded base (full object id).
    pub base: &'a str,
    pub entries: Vec<ReviewedEntry>,
    /// Upper bound of `git apply --check` (W-B); `runner` additionally
    /// bounds it by the request's deadline.
    pub check_timeout: Duration,
    /// Called right before `git apply --check` (a test seam; production
    /// passes a no-op).
    pub before_check: &'a dyn Fn(),
}

/// The post-state Core expects for one touched path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathState {
    pub path: String,
    /// `(mode, oid)` in the index; `None` = absent.
    pub entry: Option<(String, String)>,
}

/// Everything [`write`] and [`verify`] need; the patch lives in `tmp`.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub snapshot_tree: String,
    pub patch: PathBuf,
    pub applied_files: Vec<String>,
    pub mode_changes: Vec<ModeChange>,
    /// Every touched path (entry paths and rename old paths), in order.
    pub touched: Vec<String>,
    /// Index state after a complete apply, per touched path.
    pub expected: Vec<PathState>,
    /// Index state before (the base), per touched path.
    pub before: Vec<PathState>,
    touched_raw: Vec<RawPath>,
}

/// One validated entry: what it creates and where.
struct Planned {
    entry: ReviewedEntry,
    /// New content for added/modified/renamed: mode, oid, temp file.
    new: Option<(GitMode, String, PathBuf)>,
    /// Base mode of the path whose mode a modify/rename changes.
    base_mode: Option<String>,
}

fn zero_oid(format: ObjectFormat) -> String {
    "0".repeat(format.hex_len())
}

/// Items 3-5 and `git apply --check`. Writes NOTHING into the host
/// repository: not its work tree, not its index, and (W-N2) not its object
/// store — snapshot objects go to a quarantine under `tmp` that the caller
/// removes with `tmp`.
pub fn prepare(inputs: ApplyInputs<'_>) -> Result<Prepared, ApplyError> {
    let runner = inputs.runner;
    // W-B: once the request's deadline has passed, whatever failed is
    // reported as the budget refusal (every git call was cut short by it).
    prepare_within(inputs).map_err(|e| {
        if runner.deadline_passed() {
            ApplyError::refused(MSG_PREPARE_TOO_SLOW)
        } else {
            e
        }
    })
}

fn prepare_within(inputs: ApplyInputs<'_>) -> Result<Prepared, ApplyError> {
    let cwd = inputs.tmp.join("cwd");
    let data = inputs.tmp.join("data");
    let quarantine = inputs.tmp.join("objects");
    for d in [&cwd, &data, &quarantine] {
        std::fs::create_dir(d).map_err(|e| ApplyError::internal("creating Core's temp dir", e))?;
    }
    // C3: every task-side git call is pinned to the HOST common dir and
    // runs from Core's temp dir; the object format is read once (R3).
    // W-N2: every object the snapshot creates goes to the quarantine; the
    // host's objects are only read (alternate). The host `git apply` later
    // needs none of them: the `--binary --full-index` patch carries every
    // postimage, and every preimage is a base object the host already has.
    let session = inputs
        .runner
        .git_dir_session_quarantined(inputs.common_dir, &cwd, &quarantine)
        .map_err(|e| ApplyError::internal("opening the repository", e))?;
    let format = session.format();
    let base_tree = session
        .ls_tree_full(inputs.base)
        .map_err(|e| ApplyError::internal("reading the base tree", e))?;

    let planned = validate_entries(&inputs, &base_tree, format, &data)?;

    let mut touched: Vec<String> = Vec::new();
    let mut touched_raw: Vec<RawPath> = Vec::new();
    let mut expected = Vec::new();
    let mut before = Vec::new();
    let base_state = |p: &str| base_tree.get(p).map(|t| (t.mode.clone(), t.oid.clone()));
    for p in &planned {
        if let Some(old) = &p.entry.old_path {
            touched.push(old.as_str().to_string());
            touched_raw.push(old.clone());
            expected.push(PathState {
                path: old.as_str().to_string(),
                entry: None,
            });
            before.push(PathState {
                path: old.as_str().to_string(),
                entry: base_state(old.as_str()),
            });
        }
        let path = p.entry.path.as_str().to_string();
        touched.push(path.clone());
        touched_raw.push(p.entry.path.clone());
        expected.push(PathState {
            path: path.clone(),
            entry: p
                .new
                .as_ref()
                .map(|(m, oid, _)| (m.as_str().to_string(), oid.clone())),
        });
        before.push(PathState {
            path: path.clone(),
            entry: base_state(&path),
        });
    }
    let mode_changes = planned
        .iter()
        .filter_map(|p| {
            let (mode, _, _) = p.new.as_ref()?;
            let from = p.base_mode.as_ref()?;
            (from != mode.as_str()).then(|| ModeChange {
                path: p.entry.path.as_str().to_string(),
                from: from.clone(),
                to: mode.as_str().to_string(),
            })
        })
        .collect();

    // W-A: the host gates run BEFORE any object is written into the host
    // store (`hash-object -w`), and again after the snapshot so a change in
    // between is still caught.
    host_gates(&inputs, &planned, &touched_raw)?;
    let (snapshot_tree, patch) = build_snapshot(&session, inputs.base, &planned, format, &data)?;
    host_gates(&inputs, &planned, &touched_raw)?;

    if inputs.runner.deadline_passed() {
        return Err(ApplyError::refused(MSG_PREPARE_TOO_SLOW));
    }
    (inputs.before_check)();
    let check_limits = RunLimits {
        timeout: inputs.check_timeout.min(RunLimits::QUERY.timeout),
        ..inputs.runner.limits
    };
    match inputs
        .runner
        .apply_check(inputs.repo, &patch, &check_limits)
    {
        ApplyCheck::Applies => {}
        ApplyCheck::DoesNotApply(stderr) => {
            return Err(ApplyError::Refused {
                reason: MSG_CHECK_FAILED.to_string(),
                conflicted_files: conflicted_from_git_message(&stderr, &touched),
            })
        }
        ApplyCheck::CouldNotCheck(_) => return Err(ApplyError::refused(MSG_CHECK_UNAVAILABLE)),
    }
    Ok(Prepared {
        snapshot_tree,
        patch,
        applied_files: planned
            .iter()
            .map(|p| p.entry.path.as_str().to_string())
            .collect(),
        mode_changes,
        touched,
        expected,
        before,
        touched_raw,
    })
}

/// Item 3: required state per status, from Core alone; entry policy; the
/// hash binding. Each new content is written to a `0600` temp file.
fn validate_entries(
    inputs: &ApplyInputs<'_>,
    base_tree: &BTreeMap<String, TreeEntry>,
    format: ObjectFormat,
    data: &Path,
) -> Result<Vec<Planned>, ApplyError> {
    let mut planned = Vec::new();
    // W-A: new-side bytes read so far, capped BEFORE any temp copy or
    // object write.
    let total = std::cell::Cell::new(0usize);
    for (i, entry) in inputs.entries.iter().enumerate() {
        // W-B: the request's one deadline, checked per entry.
        if inputs.runner.deadline_passed() {
            return Err(ApplyError::refused(MSG_PREPARE_TOO_SLOW));
        }
        let c = &entry.change;
        let path = c.path.as_str();
        let changed = || ApplyError::refused(msg_changed(path));
        // Policy first: symlinks are never applied.
        if c.task_mode.as_deref() == Some("120000") {
            return Err(ApplyError::refused(msg_symlink(path)));
        }
        let base_of = |p: &str| -> Result<Option<&TreeEntry>, ApplyError> {
            match base_tree.get(p) {
                Some(t) if t.mode == "160000" || t.kind == "commit" => {
                    Err(ApplyError::refused(msg_gitlink(p)))
                }
                Some(t) if t.mode == "120000" => Err(ApplyError::refused(msg_base_symlink(p))),
                Some(t) if t.kind != "blob" => Err(ApplyError::refused(msg_changed(p))),
                other => Ok(other),
            }
        };
        let read = |p: &str| -> Result<TaskEntry, ApplyError> {
            match diff::read_task_entry(inputs.worktree, p, APPLY_FILE_CAP) {
                Ok(e) => Ok(e),
                Err(UntrackedError::Io(e)) => Err(ApplyError::internal(
                    &format!("reading {} in the task worktree", q(p)),
                    e,
                )),
                Err(_) => Err(ApplyError::refused(msg_changed(p))),
            }
        };
        // The new side, for every status but `deleted`.
        let new_side = |base_present: bool| -> Result<(GitMode, String, PathBuf), ApplyError> {
            let (Some(blob), Some(mode)) = (c.task_blob.as_deref(), c.task_mode.as_deref()) else {
                return Err(ApplyError::refused(msg_no_content(path)));
            };
            let _ = base_present;
            let (bytes, git_mode) = match read(path)? {
                TaskEntry::File {
                    over_cap: false,
                    bytes,
                    executable,
                } => (
                    bytes,
                    if executable {
                        GitMode::Executable
                    } else {
                        GitMode::Regular
                    },
                ),
                TaskEntry::Symlink { .. } => return Err(ApplyError::refused(msg_symlink(path))),
                _ => return Err(changed()),
            };
            total.set(total.get().saturating_add(bytes.len()));
            if total.get() > MAX_APPLY_PATCH_BYTES {
                return Err(ApplyError::refused(MSG_CONTENT_TOO_LARGE));
            }
            let oid = objects::blob_id(format, &bytes).map_err(|e| match e {
                ObjectError::Sha1Collision => ApplyError::refused(msg_collision(path)),
                other => ApplyError::internal("hashing", other),
            })?;
            if !oid.eq_ignore_ascii_case(blob) || git_mode.as_str() != mode {
                return Err(changed());
            }
            let file = data.join(format!("blob-{i}"));
            write_private(&file, &bytes)
                .map_err(|e| ApplyError::internal("writing Core's temp file", e))?;
            Ok((git_mode, oid, file))
        };
        let plan = match c.status {
            FileChangeStatus::Added | FileChangeStatus::Untracked => {
                if base_of(path)?.is_some() {
                    return Err(changed());
                }
                Planned {
                    new: Some(new_side(false)?),
                    base_mode: None,
                    entry: entry.clone(),
                }
            }
            FileChangeStatus::Modified => {
                let Some(base) = base_of(path)? else {
                    return Err(changed());
                };
                Planned {
                    new: Some(new_side(true)?),
                    base_mode: Some(base.mode.clone()),
                    entry: entry.clone(),
                }
            }
            FileChangeStatus::Deleted => {
                if c.task_blob.is_some() || c.task_mode.is_some() || base_of(path)?.is_none() {
                    return Err(changed());
                }
                if read(path)? != TaskEntry::Absent {
                    return Err(changed());
                }
                Planned {
                    new: None,
                    base_mode: None,
                    entry: entry.clone(),
                }
            }
            FileChangeStatus::Renamed => {
                let Some(old) = c.old_path.as_deref() else {
                    return Err(changed());
                };
                let Some(old_base) = base_of(old)? else {
                    return Err(ApplyError::refused(msg_changed(old)));
                };
                if base_of(path)?.is_some() {
                    return Err(changed());
                }
                if read(old)? != TaskEntry::Absent {
                    return Err(ApplyError::refused(msg_changed(old)));
                }
                Planned {
                    new: Some(new_side(false)?),
                    base_mode: Some(old_base.mode.clone()),
                    entry: entry.clone(),
                }
            }
        };
        planned.push(plan);
    }
    Ok(planned)
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// The touched path git's message names, else the first one.
fn named_path<'a>(message: &str, candidates: &'a [&'a str]) -> &'a str {
    candidates
        .iter()
        .filter(|p| message.contains(**p))
        .max_by_key(|p| p.len())
        .or(candidates.first())
        .copied()
        .unwrap_or("")
}

/// Item 4: snapshot from objects only (temp index), exact-set check (C1),
/// patch without a pathspec (R1).
fn build_snapshot(
    session: &GitDirSession<'_>,
    base: &str,
    planned: &[Planned],
    format: ObjectFormat,
    data: &Path,
) -> Result<(String, PathBuf), ApplyError> {
    // hash-object -w --no-filters must print exactly taskBlob.
    let with_new: Vec<&Planned> = planned.iter().filter(|p| p.new.is_some()).collect();
    let files: Vec<PathBuf> = with_new
        .iter()
        .filter_map(|p| p.new.as_ref().map(|(_, _, f)| f.clone()))
        .collect();
    if !files.is_empty() {
        let oids = session
            .hash_object_write(&files)
            .map_err(|e| ApplyError::internal("writing the snapshot objects", e))?;
        for (p, oid) in with_new.iter().zip(&oids) {
            let (_, want, _) = p.new.as_ref().expect("filtered");
            if !oid.eq_ignore_ascii_case(want) {
                return Err(ApplyError::refused(msg_snapshot_differs(
                    p.entry.path.as_str(),
                )));
            }
        }
    }
    let index = data.join("index");
    session
        .read_tree(&index, base)
        .map_err(|e| ApplyError::internal("reading the base into Core's index", e))?;
    // Removals first (a dir/file swap needs the old side gone), never
    // `--replace`: an update-index failure is "changed since reviewed" (R8).
    let removed: Vec<RawPath> = planned
        .iter()
        .flat_map(|p| match p.entry.change.status {
            FileChangeStatus::Deleted => vec![p.entry.path.clone()],
            FileChangeStatus::Renamed => p.entry.old_path.clone().into_iter().collect(),
            _ => vec![],
        })
        .collect();
    let removed_names: Vec<&str> = removed.iter().map(RawPath::as_str).collect();
    session.update_index_remove(&index, &removed).map_err(|e| {
        ApplyError::refused(msg_changed(named_path(&e.to_string(), &removed_names)))
    })?;
    let mut adds = Vec::new();
    for p in &with_new {
        let (mode, oid, _) = p.new.as_ref().expect("filtered");
        adds.push(
            CacheEntry::new(*mode, oid, p.entry.path.clone())
                .map_err(|e| ApplyError::internal("building the snapshot", e))?,
        );
    }
    let added_names: Vec<&str> = with_new.iter().map(|p| p.entry.path.as_str()).collect();
    session
        .update_index_add(&index, &adds)
        .map_err(|e| ApplyError::refused(msg_changed(named_path(&e.to_string(), &added_names))))?;
    let snapshot = session
        .write_tree(&index)
        .map_err(|e| ApplyError::internal("writing the snapshot tree", e))?;

    // C1: the WHOLE base→snapshot difference must be exactly the entries.
    let raw = session
        .diff_tree_raw(base, &snapshot)
        .map_err(|e| ApplyError::internal("comparing the snapshot", e))?;
    if let Some(path) = exact_set_mismatch(planned, &raw, format) {
        return Err(ApplyError::refused(msg_snapshot_differs(&path)));
    }
    let patch = session
        .diff_tree_patch(base, &snapshot, MAX_APPLY_PATCH_BYTES)
        .map_err(|e| ApplyError::internal("generating the patch", e))?
        .ok_or_else(|| ApplyError::refused(MSG_PATCH_TOO_LARGE))?;
    let patch_file = data.join("apply.patch");
    write_private(&patch_file, &patch).map_err(|e| ApplyError::internal("writing the patch", e))?;
    Ok((snapshot, patch_file))
}

/// C1: the first path (sorted) where the raw base→snapshot diff and the
/// selected entries differ, or `None` when they are exactly equal. A rename
/// is a delete of `oldPath` plus an add of `path`; a typechange (`T`)
/// counts as a modify.
fn exact_set_mismatch(
    planned: &[Planned],
    raw: &[crate::git::RawDiffEntry],
    format: ObjectFormat,
) -> Option<String> {
    let zero = zero_oid(format);
    let mut want: BTreeMap<String, (char, String, String)> = BTreeMap::new();
    for p in planned {
        let new = p
            .new
            .as_ref()
            .map(|(m, o, _)| (m.as_str().to_string(), o.to_ascii_lowercase()));
        match p.entry.change.status {
            FileChangeStatus::Added | FileChangeStatus::Untracked => {
                let (m, o) = new?;
                want.insert(p.entry.path.as_str().into(), ('A', m, o));
            }
            FileChangeStatus::Modified => {
                let (m, o) = new?;
                want.insert(p.entry.path.as_str().into(), ('M', m, o));
            }
            FileChangeStatus::Deleted => {
                want.insert(
                    p.entry.path.as_str().into(),
                    ('D', "000000".into(), zero.clone()),
                );
            }
            FileChangeStatus::Renamed => {
                let old = p.entry.old_path.as_ref()?;
                want.insert(old.as_str().into(), ('D', "000000".into(), zero.clone()));
                let (m, o) = new?;
                want.insert(p.entry.path.as_str().into(), ('A', m, o));
            }
        }
    }
    let mut got: BTreeMap<String, (char, String, String)> = BTreeMap::new();
    for r in raw {
        if !r.exact {
            return Some(r.path.clone());
        }
        let status = if r.status == 'T' { 'M' } else { r.status };
        if got
            .insert(
                r.path.clone(),
                (status, r.new_mode.clone(), r.new_oid.clone()),
            )
            .is_some()
        {
            return Some(r.path.clone());
        }
    }
    let keys: std::collections::BTreeSet<&String> = want.keys().chain(got.keys()).collect();
    let first = keys
        .into_iter()
        .find(|k| want.get(*k) != got.get(*k))
        .cloned();
    first
}

/// Item 5 host gates (host repository, hardened runner, work tree pinned).
fn host_gates(
    inputs: &ApplyInputs<'_>,
    planned: &[Planned],
    touched: &[RawPath],
) -> Result<(), ApplyError> {
    let runner = inputs.runner;
    let repo = inputs.repo;
    // confirm_work_tree on the host root.
    let top = runner
        .show_toplevel(repo)
        .ok()
        .and_then(|t| std::fs::canonicalize(t).ok());
    if top.as_deref() != Some(repo) {
        return Err(ApplyError::refused(MSG_HOST_WORK_TREE_REDIRECTED));
    }
    // The repo-wide submodule scan.
    match runner.refuse_submodules(repo) {
        Ok(()) => {}
        Err(e @ GitError::SubmodulesPresent(_)) => {
            return Err(ApplyError::refused(format!("{e}{NOTHING_WRITTEN}")))
        }
        Err(e) => return Err(ApplyError::internal("scanning for submodules", e)),
    }
    // HEAD == the recorded base (exact full oid).
    match runner
        .head_oid(repo)
        .map_err(|e| ApplyError::internal("reading HEAD", e))?
    {
        None => return Err(ApplyError::refused(MSG_HOST_UNBORN)),
        Some(head) if !head.eq_ignore_ascii_case(inputs.base) => {
            return Err(ApplyError::refused(msg_head_moved(&head, inputs.base)))
        }
        Some(_) => {}
    }
    // Every touched path is clean, untracked-free and ignored-free.
    let specs: Vec<LiteralPathspec> = touched.iter().map(RawPath::literal).collect();
    let dirty = runner
        .status_touched(repo, &specs)
        .map_err(|e| ApplyError::internal("checking your working tree", e))?;
    if !dirty.is_empty() {
        return Err(ApplyError::refused(msg_dirty(&dirty)));
    }
    // W3: hidden index entries among the touched paths.
    let hidden = runner
        .index_hidden_entries(repo)
        .map_err(|e| ApplyError::internal("reading index flags", e))?;
    let related = |h: &str, t: &str| {
        h == t || h.starts_with(&format!("{t}/")) || t.starts_with(&format!("{h}/"))
    };
    let hidden: Vec<String> = hidden
        .into_iter()
        .filter(|h| touched.iter().any(|t| related(h, t.as_str())))
        .collect();
    if !hidden.is_empty() {
        return Err(ApplyError::refused(msg_hidden(&hidden)));
    }
    // C2: Core walks the host work tree itself.
    for p in planned {
        let mut checks: Vec<(&str, HostLeaf)> = Vec::new();
        match p.entry.change.status {
            FileChangeStatus::Added | FileChangeStatus::Untracked => {
                checks.push((p.entry.path.as_str(), HostLeaf::MustBeAbsent))
            }
            FileChangeStatus::Modified | FileChangeStatus::Deleted => {
                checks.push((p.entry.path.as_str(), HostLeaf::MustBeRegularFile))
            }
            FileChangeStatus::Renamed => {
                if let Some(old) = &p.entry.old_path {
                    checks.push((old.as_str(), HostLeaf::MustBeRegularFile));
                }
                checks.push((p.entry.path.as_str(), HostLeaf::MustBeAbsent));
            }
        }
        for (path, want) in checks {
            if diff::check_host_path(repo, path, want).is_err() {
                return Err(ApplyError::refused(msg_leading_path(path)));
            }
        }
    }
    // R5: filtered paths, from the host's own attributes.
    let attrs = runner
        .check_attr_filter(repo, touched)
        .map_err(|e| ApplyError::internal("reading your .gitattributes", e))?;
    if let Some((path, value)) = attrs
        .iter()
        .find(|(_, v)| v != "unspecified" && v != "unset")
    {
        return Err(ApplyError::refused(msg_filtered(path, value)));
    }
    Ok(())
}

/// The touched paths a `git apply` error names (exact matches only, capped).
pub fn conflicted_from_git_message(message: &str, touched: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in touched {
        let named = message.contains(&format!("error: {t}: "))
            || message.contains(&format!("patch failed: {t}:"));
        if named && !out.contains(t) {
            out.push(t.clone());
            if out.len() >= MAX_CONFLICTED_FILES {
                break;
            }
        }
    }
    out
}

// --- Write and verify (item 6) ---------------------------------------------

/// The write: `git apply --index` under [`APPLY_WRITE_TIMEOUT`].
pub fn write(runner: &GitRunner, repo: &Path, prepared: &Prepared) -> Result<ApplyWrite, GitError> {
    write_with_limits(
        runner,
        repo,
        prepared,
        &RunLimits {
            timeout: APPLY_WRITE_TIMEOUT,
            ..runner.limits
        },
        ApplyLimits::default().write_floor,
    )
}

/// [`write`] under explicit limits (tests shrink the timeout to prove R6).
pub fn write_with_limits(
    runner: &GitRunner,
    repo: &Path,
    prepared: &Prepared,
    limits: &RunLimits,
    floor: Duration,
) -> Result<ApplyWrite, GitError> {
    runner.apply_write(repo, &prepared.patch, limits, floor)
}

/// W2: the host index holds exactly the expected entries for every touched
/// path (oid and mode; deleted paths absent) and the touched work-tree files
/// match the index (`diff-files`). `Ok(false)` = mismatch.
pub fn verify(runner: &GitRunner, repo: &Path, prepared: &Prepared) -> Result<bool, GitError> {
    let specs: Vec<LiteralPathspec> = prepared.touched_raw.iter().map(RawPath::literal).collect();
    if !index_matches(runner, repo, &specs, &prepared.expected)? {
        return Ok(false);
    }
    Ok(runner.diff_files_names(repo, &specs)?.is_empty())
}

fn index_matches(
    runner: &GitRunner,
    repo: &Path,
    specs: &[LiteralPathspec],
    want: &[PathState],
) -> Result<bool, GitError> {
    let index = runner.ls_files_stage(repo, specs)?;
    Ok(want.iter().all(|w| {
        let exact: Vec<&crate::git::IndexEntry> =
            index.iter().filter(|e| e.path == w.path).collect();
        match &w.entry {
            None => exact.is_empty(),
            Some((mode, oid)) => {
                exact.len() == 1
                    && exact[0].stage == 0
                    && &exact[0].mode == mode
                    && exact[0].oid.eq_ignore_ascii_case(oid)
            }
        }
    }))
}

// --- Restart reconciliation (item 8) ---------------------------------------

/// What an unterminated `git.apply.started` turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reconciled {
    Applied,
    Partial,
    NotApplied,
}

impl Reconciled {
    pub fn as_str(self) -> &'static str {
        match self {
            Reconciled::Applied => "applied",
            Reconciled::Partial => "partial",
            Reconciled::NotApplied => "not_applied",
        }
    }
}

/// Reconcile an unterminated start against the host index (never assumed):
/// `Applied` when the index holds every expected entry and the touched
/// files match it; `NotApplied` when the index still holds the base
/// entries and `git status` lists none of the touched paths; otherwise
/// `Partial`. Paths come from Core's own event payload and are re-validated.
pub fn reconcile(
    runner: &GitRunner,
    repo: &Path,
    expected: &[PathState],
    before: &[PathState],
) -> Result<Reconciled, GitError> {
    let mut specs = Vec::new();
    for s in expected.iter().chain(before) {
        specs.push(RawPath::new(&s.path)?.literal());
    }
    if index_matches(runner, repo, &specs, expected)?
        && runner.diff_files_names(repo, &specs)?.is_empty()
    {
        return Ok(Reconciled::Applied);
    }
    if index_matches(runner, repo, &specs, before)?
        && runner.status_touched(repo, &specs)?.is_empty()
    {
        return Ok(Reconciled::NotApplied);
    }
    Ok(Reconciled::Partial)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fc(path: &str, status: FileChangeStatus) -> FileChange {
        FileChange {
            path: path.into(),
            status,
            old_path: None,
            task_blob: None,
            task_mode: None,
        }
    }

    fn with_blob(mut c: FileChange, blob: &str, mode: &str) -> FileChange {
        c.task_blob = Some(blob.into());
        c.task_mode = Some(mode.into());
        c
    }

    fn planned(c: FileChange, new: Option<(GitMode, &str)>) -> Planned {
        Planned {
            entry: ReviewedEntry {
                path: RawPath::new(&c.path).unwrap(),
                old_path: c.old_path.as_deref().map(|p| RawPath::new(p).unwrap()),
                change: c,
            },
            new: new.map(|(m, o)| (m, o.to_string(), PathBuf::from("unused"))),
            base_mode: None,
        }
    }

    fn raw(status: char, path: &str, mode: &str, oid: &str) -> crate::git::RawDiffEntry {
        crate::git::RawDiffEntry {
            old_mode: "100644".into(),
            new_mode: mode.into(),
            old_oid: "1".repeat(40),
            new_oid: oid.into(),
            status,
            path: path.into(),
            exact: true,
        }
    }

    /// C1: the WHOLE base→snapshot difference must equal the selection —
    /// nothing more (a dir/file swap's unselected deletions), nothing less,
    /// no other mode or oid. A rename is delete + add; `T` counts as `M`.
    #[test]
    fn the_exact_set_check_refuses_anything_but_the_selection() {
        let f = ObjectFormat::Sha1;
        let (x, z) = ("a".repeat(40), "0".repeat(40));
        let add_d = planned(
            fc("d", FileChangeStatus::Untracked),
            Some((GitMode::Regular, &x)),
        );
        // The swap: git also dropped d/x and d/y, which were NOT selected.
        let swap = [
            raw('A', "d", "100644", &x),
            raw('D', "d/x", "000000", &z),
            raw('D', "d/y", "000000", &z),
        ];
        assert_eq!(
            exact_set_mismatch(std::slice::from_ref(&add_d), &swap, f),
            Some("d/x".to_string())
        );
        assert_eq!(
            exact_set_mismatch(std::slice::from_ref(&add_d), &swap[..1], f),
            None
        );
        // Less than selected, another oid, another mode.
        assert_eq!(
            exact_set_mismatch(std::slice::from_ref(&add_d), &[], f),
            Some("d".to_string())
        );
        let other_oid = [raw('A', "d", "100644", &"b".repeat(40))];
        assert!(exact_set_mismatch(std::slice::from_ref(&add_d), &other_oid, f).is_some());
        let other_mode = [raw('A', "d", "100755", &x)];
        assert!(exact_set_mismatch(std::slice::from_ref(&add_d), &other_mode, f).is_some());
        // A modify listed as an add (or vice versa) differs.
        let as_modify = [raw('M', "d", "100644", &x)];
        assert!(exact_set_mismatch(std::slice::from_ref(&add_d), &as_modify, f).is_some());
        // Rename = D oldPath + A path; a typechange counts as a modify.
        let mut ren = fc("new.txt", FileChangeStatus::Renamed);
        ren.old_path = Some("old.txt".into());
        let ren = planned(ren, Some((GitMode::Regular, &x)));
        let ok = [
            raw('D', "old.txt", "000000", &z),
            raw('A', "new.txt", "100644", &x),
        ];
        assert_eq!(exact_set_mismatch(std::slice::from_ref(&ren), &ok, f), None);
        assert_eq!(
            exact_set_mismatch(std::slice::from_ref(&ren), &ok[1..], f),
            Some("old.txt".to_string())
        );
        let modi = planned(
            fc("m", FileChangeStatus::Modified),
            Some((GitMode::Regular, &x)),
        );
        let t = [raw('T', "m", "100644", &x)];
        assert_eq!(exact_set_mismatch(std::slice::from_ref(&modi), &t, f), None);
        // A non-UTF-8 path git reported, or a path reported twice, fails.
        let mut bad = raw('M', "m", "100644", &x);
        bad.exact = false;
        assert!(exact_set_mismatch(std::slice::from_ref(&modi), &[bad], f).is_some());
        let twice = [raw('M', "m", "100644", &x), raw('M', "m", "100644", &x)];
        assert!(exact_set_mismatch(std::slice::from_ref(&modi), &twice, f).is_some());
        // Deletion expects the zero oid of the repository's format.
        let del = planned(fc("gone", FileChangeStatus::Deleted), None);
        let d1 = [raw('D', "gone", "000000", &z)];
        assert_eq!(exact_set_mismatch(std::slice::from_ref(&del), &d1, f), None);
        let d256 = [raw('D', "gone", "000000", &"0".repeat(64))];
        assert_eq!(
            exact_set_mismatch(std::slice::from_ref(&del), &d256, ObjectFormat::Sha256),
            None
        );
    }

    /// W-B: the three PHASE budgets (prepare + check, write, verify) fit the
    /// client's 45 s deadline with margin (≤ 41 s). Each host call also runs
    /// a configuration read first, so a phase is bounded by its budget, not
    /// by its per-call timeout times a call count.
    #[test]
    fn apply_limits_fit_the_client_deadline() {
        let l = ApplyLimits::default();
        assert_eq!(l.prepare_budget, Duration::from_secs(20));
        assert_eq!(l.write_timeout, Duration::from_secs(15));
        assert_eq!(l.write_budget, Duration::from_secs(15));
        assert_eq!(l.verify_timeout, Duration::from_secs(3));
        assert_eq!(l.verify_budget, Duration::from_secs(6));
        assert!(l.check_timeout <= RunLimits::QUERY.timeout);
        assert!(l.write_timeout <= l.write_budget);
        assert!(l.verify_timeout <= l.verify_budget);
        // I-N1: the write phase's configuration read is capped, and `git
        // apply` starts only with at least the floor left; both fit.
        assert_eq!(l.write_floor, Duration::from_secs(5));
        assert!(RunLimits::PROBE.timeout + l.write_floor <= l.write_budget);
        let total = l.prepare_budget + l.write_budget + l.verify_budget;
        assert!(total <= Duration::from_secs(41), "{total:?}");
        assert!(total < CLIENT_APPLY_DEADLINE);
    }

    /// W-B: each phase runner carries ONE deadline for the whole phase
    /// (every git process in it, configuration reads included).
    #[test]
    fn each_phase_runner_carries_one_deadline() {
        let l = ApplyLimits::default();
        let git = GitRunner::default();
        let now = std::time::Instant::now();
        let w = l.write_runner(&git, now);
        assert_eq!(w.deadline(), Some(now + l.write_budget));
        // I-N1: its own calls (the configuration read) are capped at PROBE.
        assert_eq!(w.limits.timeout, RunLimits::PROBE.timeout);
        assert_eq!(w.limits.max_stdout, git.limits.max_stdout);
        let v = l.verify_runner(&git, now);
        assert_eq!(v.deadline(), Some(now + l.verify_budget));
        assert_eq!(v.limits.timeout, l.verify_timeout);
        assert_eq!(git.deadline(), None);
    }

    /// R4: entries must be verbatim members of a review Core produced.
    #[test]
    fn review_membership_is_exact_and_bounded() {
        let a = "a".repeat(40);
        let mut store = ReviewStore::new();
        let review = vec![
            with_blob(fc("x.txt", FileChangeStatus::Modified), &a, "100644"),
            fc("gone.txt", FileChangeStatus::Deleted),
        ];
        store.record("t1", "r1", &review);
        assert_eq!(store.resolve("t1", "r1", &review).unwrap().len(), 2);
        assert_eq!(store.resolve("t1", "r1", &review[1..]).unwrap().len(), 1);
        for (task, rid, entries) in [
            ("t1", "nope", review.clone()),
            ("t2", "r1", review.clone()),
            (
                "t1",
                "r1",
                vec![with_blob(
                    fc("x.txt", FileChangeStatus::Modified),
                    &a,
                    "100755",
                )],
            ),
            (
                "t1",
                "r1",
                vec![with_blob(
                    fc("x.txt", FileChangeStatus::Modified),
                    &"b".repeat(40),
                    "100644",
                )],
            ),
            ("t1", "r1", vec![fc("x.txt", FileChangeStatus::Modified)]),
            (
                "t1",
                "r1",
                vec![fc("gone.txt", FileChangeStatus::Untracked)],
            ),
            ("t1", "r1", vec![fc("other.txt", FileChangeStatus::Deleted)]),
        ] {
            assert_eq!(
                store.resolve(task, rid, &entries).unwrap_err(),
                ApplyError::refused(MSG_ENTRIES_NOT_REVIEWED),
                "{task} {rid} {entries:?}"
            );
        }
        // A path listed twice (also via a rename's oldPath).
        let dup = vec![review[1].clone(), review[1].clone()];
        assert_eq!(
            store.resolve("t1", "r1", &dup).unwrap_err(),
            ApplyError::refused(msg_listed_twice("gone.txt"))
        );
        let mut ren = with_blob(fc("new.txt", FileChangeStatus::Renamed), &a, "100644");
        ren.old_path = Some("gone.txt".into());
        store.record("t1", "r2", &[ren.clone(), review[1].clone()]);
        assert_eq!(
            store
                .resolve("t1", "r2", &[ren, review[1].clone()])
                .unwrap_err(),
            ApplyError::refused(msg_listed_twice("gone.txt"))
        );
        // Only the last 8 reviews per task are kept.
        for i in 0..REVIEWS_KEPT_PER_TASK {
            store.record("t1", &format!("later-{i}"), &review);
        }
        assert!(store.resolve("t1", "r1", &review).is_err());
        assert!(store.resolve("t1", "later-7", &review).is_ok());
        // Bounded task count.
        for i in 0..REVIEW_TASKS_KEPT {
            store.record(&format!("other-{i}"), "r", &review);
        }
        assert!(store.resolve("t1", "later-7", &review).is_err());
    }

    #[test]
    fn hooks_path_is_reported_only_when_repo_relative() {
        let root = Path::new("/home/u/repo");
        for (value, want) in [
            (".husky", Some(".husky")),
            ("./.githooks/", Some(".githooks")),
            ("tools/../.hooks", Some(".hooks")),
            ("/home/u/repo/.husky/_", Some(".husky/_")),
            ("/home/u/hooks", None),
            ("../outside", None),
            ("~/hooks", None),
            ("", None),
            (".", None),
            ("/home/u/repo", None),
        ] {
            assert_eq!(
                repo_relative_hooks_path(root, value).as_deref(),
                want,
                "{value:?}"
            );
        }
    }

    #[test]
    fn conflicted_files_are_exact_touched_paths_only() {
        let touched = vec!["a.txt".to_string(), "dir/b c.txt".to_string()];
        let msg = "git apply exited 1: error: patch failed: dir/b c.txt:3\n\
                   error: dir/b c.txt: patch does not apply\nerror: other.txt: does not exist";
        assert_eq!(
            conflicted_from_git_message(msg, &touched),
            vec!["dir/b c.txt"]
        );
        assert!(conflicted_from_git_message("error: a.txtx: nope", &touched).is_empty());
    }

    /// Every refusal ends "; nothing was written"; W1/W2/R6 never do.
    #[test]
    fn message_constants_are_pinned() {
        assert_eq!(
            MSG_ENTRIES_NOT_REVIEWED,
            "entries do not match a review Core produced; review again; nothing was written"
        );
        assert_eq!(
            msg_changed("a b.txt"),
            "\"a b.txt\" changed since it was reviewed; review it again; nothing was written"
        );
        assert_eq!(
            msg_snapshot_differs("d"),
            "\"d\": the snapshot differs from the reviewed entries; nothing was written"
        );
        assert_eq!(
            msg_leading_path("node_modules/x"),
            "\"node_modules/x\" lies under a symlink or a file in your working tree; nothing \
             was written"
        );
        assert_eq!(
            MSG_CHECK_FAILED,
            "the patch does not apply cleanly; nothing was written"
        );
        assert_eq!(
            msg_write_failed("/r"),
            "the write failed after git's checks passed; some files may have been written or \
             staged — check `git status` in /r"
        );
        assert_eq!(
            msg_verify_failed("/r"),
            "files were changed, but the staged content differs from the reviewed content — \
             check `git status` in /r"
        );
        assert!(msg_write_killed("/r").starts_with(&msg_write_failed("/r")));
        assert!(msg_write_killed("/r").contains("index.lock"));
        // Review fixes W-A / I3 / W-B / W-C (exact wording).
        assert_eq!(
            MSG_CONTENT_TOO_LARGE,
            "the selected files hold more than 64 MiB of new content, too much to apply in one \
             step; apply fewer files at once; nothing was written"
        );
        assert_eq!(
            MSG_CHECK_UNAVAILABLE,
            "git could not check the patch (timed out or failed); nothing was written"
        );
        assert_eq!(
            msg_verify_unavailable("/r"),
            "could not verify the staged content — check `git status` in /r"
        );
        assert_eq!(
            msg_mounted("sandbox \"s\""),
            "sandbox \"s\": a sandbox mounts this repository directly and can change it while \
             Core writes; stop or remove it first; nothing was written"
        );
        assert_eq!(
            MSG_WRITE_NOT_RUN,
            "git apply was not started (reading the repository's configuration timed out or \
             failed); nothing was written"
        );
        assert_eq!(
            MSG_WRITE_TOO_LATE,
            "git apply was not started (too little of its time budget was left to finish it \
             safely); nothing was written"
        );
        for refusal in [
            MSG_WRITE_TOO_LATE.to_string(),
            MSG_WRITE_NOT_RUN.to_string(),
            MSG_CONTENT_TOO_LARGE.to_string(),
            MSG_CHECK_UNAVAILABLE.to_string(),
            msg_mounted("x"),
            MSG_NEEDS_REVIEW.to_string(),
            MSG_SELECTED_FILES.to_string(),
            MSG_TOO_MANY_ENTRIES.to_string(),
            MSG_ENTRIES_NOT_REVIEWED.to_string(),
            MSG_DIRECT_MOUNT.to_string(),
            MSG_CHECK_FAILED.to_string(),
            MSG_PATCH_TOO_LARGE.to_string(),
            MSG_PREPARE_TOO_SLOW.to_string(),
            MSG_HOST_UNBORN.to_string(),
            MSG_HOST_WORK_TREE_REDIRECTED.to_string(),
            msg_changed("p"),
            msg_listed_twice("p"),
            msg_no_content("p"),
            msg_symlink("p"),
            msg_gitlink("p"),
            msg_base_symlink("p"),
            msg_collision("p"),
            msg_snapshot_differs("p"),
            msg_leading_path("p"),
            msg_dirty(&["p".into()]),
            msg_hidden(&["p".into()]),
            msg_filtered("p", "lfs"),
            msg_head_moved("h", "b"),
            msg_expected_base("e", "b"),
            msg_context("task has no Git context (repo binding + base_commit)"),
        ] {
            assert!(refusal.ends_with("; nothing was written"), "{refusal}");
        }
        for partial in [
            msg_write_failed("/r"),
            msg_write_killed("/r"),
            msg_verify_failed("/r"),
        ] {
            assert!(!partial.contains("nothing was written"), "{partial}");
        }
        assert!(MSG_TOO_MANY_ENTRIES.contains(&MAX_APPLY_ENTRIES.to_string()));
    }
}
