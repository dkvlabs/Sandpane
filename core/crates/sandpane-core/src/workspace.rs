//! Task Git context: base revision, task branch and Core-owned task worktrees
//! (docs/specs/02 §3/§7, docs/specs/06 §6, git-safe-tasks skill).
//!
//! - **Base**: the FULL object id of the repository's `HEAD` when the task is
//!   created, read through the hardened [`GitRunner`] — never an abbreviation.
//! - **Branch**: `sandpane/<task-id>`, created by Core only for a
//!   `host_worktree` task, never checked out in the user's tree.
//! - **Worktree**: `<root>/<task-id>`, where `root` is Core's own private
//!   directory under its data dir (never inside the user's repository).
//!   `git worktree add -b <branch> -- <path> <base>` runs from the registered
//!   repository through the hardened runner (hooks, filters, fsmonitor,
//!   lazy-fetch all neutralized) under the MUTATION timeout.
//!
//! WHAT A TASK WORKTREE IS NOT (review W1/W4): a linked worktree isolates the
//! WORKING-TREE FILES only. It shares the user's common `.git` — refs, config,
//! hooks, objects, `info/exclude` — and its own `.git` file points back into
//! `<repo>/.git/worktrees/<id>`. Anything able to run git inside the worktree
//! with write access to that common dir can rewrite the user's branches,
//! plant `core.fsmonitor`/hooks that run on the user's next plain `git`
//! command, or tamper with the task ref (review C1). Core's hardening only
//! protects Core's OWN git invocations. Therefore `host_worktree` is NOT
//! repository-metadata isolation, and before ANY sandbox is ever bound to a
//! task worktree these preconditions must hold:
//! 1. the sandbox gets NO write access to `<common .git>` — a separate
//!    repository (clone/alternates) with a hardened fetch-back, or the
//!    binding is labeled exactly like `direct_mount` (live-writable host
//!    metadata);
//! 2. discard runs only with the sandbox stopped/unmounted and the workspace
//!    writer lock held (the scheduler lock keyed by the worktree path);
//! 3. removal never uses `--force`.
//!
//! Removal never destroys work. Every check runs BEFORE any side effect
//! ([`plan_worktree_removal`]): the task ref must not be SYMBOLIC (tamper
//! signal); the path must be a registered worktree of THIS repository under
//! the root; no index entry may be flagged assume-unchanged/skip-worktree
//! (they hide modifications); no modified, staged or untracked files (repo
//! config cannot hide untracked files: `status.showUntrackedFiles=normal`,
//! `--untracked-files=normal`); NO IGNORED files (git's "clean" excludes them
//! and `worktree remove` would delete them silently — refused until a
//! confirmation can bind the exact list; a repo-chosen `core.excludesFile` is
//! neutralized); `HEAD` and the branch still at the recorded base (commits are
//! work); the branch checked out nowhere else. Then
//! ([`execute_worktree_removal`]) `git worktree remove` (no `--force`: git
//! re-checks cleanliness) and an atomic, NON-dereferencing compare-and-delete
//! of the branch (`update-ref --no-deref -d <ref> <base>`). The user's
//! checked-out branch and working tree are never touched.
//!
//! Recorded trade-off: checkout does not smudge (filters are blanked by the
//! hardening), so LFS-managed files appear as pointer files in the worktree.

use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::git::{GitArgs, GitError, GitRunner};
use crate::process::RunLimits;
use crate::validation::{ValidationError, Validator};

/// Every branch Core creates for a task is `sandpane/<task-id>`.
pub const TASK_BRANCH_PREFIX: &str = "sandpane/";

/// Longest task id accepted as a branch/directory component (Core ids are
/// 36-char UUIDs).
pub const MAX_TASK_ID_LEN: usize = 64;

/// At most this many paths are named in a refusal message.
pub const PATHS_IN_MESSAGE: usize = 20;

fn list_paths(paths: &[String]) -> String {
    let shown: Vec<String> = paths
        .iter()
        .take(PATHS_IN_MESSAGE)
        .map(|p| format!("{p:?}"))
        .collect();
    let more = paths.len().saturating_sub(PATHS_IN_MESSAGE);
    if more > 0 {
        format!("{} (and {more} more)", shown.join(", "))
    } else {
        shown.join(", ")
    }
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("invalid input: {0}")]
    Validation(#[from] ValidationError),
    #[error(
        "worktree root {root} overlaps repository {repo}; task worktrees must live outside \
         the user's repository"
    )]
    RootOverlapsRepository { root: String, repo: String },
    #[error("worktree path {0} already exists; Sandpane never reuses a path")]
    PathExists(String),
    #[error("{path} is not a Sandpane task worktree of this repository: {reason}")]
    NotTaskWorktree { path: String, reason: String },
    #[error(
        "task worktree {0} has uncommitted changes (modified, staged or untracked files); \
         refusing to remove it — keep, commit or move that work first"
    )]
    UncommittedChanges(String),
    #[error(
        "task worktree {path} is at {found}, not its recorded base {expected}: it holds \
         commits Sandpane will not discard"
    )]
    HeadMoved {
        path: String,
        expected: String,
        found: String,
    },
    #[error(
        "task branch {branch} is at {found}, not its recorded base {expected}: it holds \
         commits Sandpane will not discard"
    )]
    BranchAdvanced {
        branch: String,
        expected: String,
        found: String,
    },
    #[error(
        "task branch {branch} is checked out in another worktree ({path}); refusing to delete it"
    )]
    BranchCheckedOutElsewhere { branch: String, path: String },
    #[error(
        "task branch {branch} has been turned into a symbolic ref to {target} (tampering \
         signal); Sandpane refuses to touch it or anything it points at"
    )]
    SymbolicTaskRef { branch: String, target: String },
    #[error(
        "task worktree {path} has index entries flagged assume-unchanged or skip-worktree ({}), \
         which hide modifications; refusing to remove it",
        list_paths(.entries)
    )]
    IndexFlagsHideChanges { path: String, entries: Vec<String> },
    #[error(
        "task worktree {path} contains ignored files ({}) that removal would delete; refusing \
         — move or delete them first",
        list_paths(.entries)
    )]
    IgnoredFiles { path: String, entries: Vec<String> },
    #[error("repository {0} has no commit yet, so there is no base to record")]
    NoCommit(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllocatedWorktree {
    pub base_commit: String,
    pub task_branch: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovedWorktree {
    /// False when the directory had already been deleted outside Core (only
    /// its stale registration was pruned).
    pub directory_was_present: bool,
    /// False when the branch no longer existed.
    pub branch_deleted: bool,
}

/// The outcome of a successful removal preflight: what
/// [`execute_worktree_removal`] will do. Lets a caller record durable intent
/// between the checks and the first side effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovalPlan {
    pub repo: PathBuf,
    pub worktree: PathBuf,
    pub task_branch: String,
    pub base_commit: String,
    pub directory_present: bool,
    /// The worktree is still registered (prune or remove needed).
    pub registered: bool,
    /// The (regular, base-pinned) branch exists and will be deleted.
    pub branch_exists: bool,
}

/// `sandpane/<task-id>`. The id must be a single conservative path/ref
/// component (`[A-Za-z0-9-]`, leading alphanumeric, ≤ 64) and the result must
/// pass [`Validator::branch_name`].
pub fn task_branch_for(task_id: &str) -> Result<String, WorkspaceError> {
    validate_task_id(task_id)?;
    let branch = format!("{TASK_BRANCH_PREFIX}{task_id}");
    Validator::branch_name(&branch)?;
    Ok(branch)
}

fn validate_task_id(task_id: &str) -> Result<(), ValidationError> {
    if task_id.is_empty() {
        return Err(ValidationError::Empty);
    }
    if task_id.len() > MAX_TASK_ID_LEN {
        return Err(ValidationError::TooLong {
            max: MAX_TASK_ID_LEN,
        });
    }
    if let Some(c) = task_id
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || *c == '-'))
    {
        return Err(ValidationError::DisallowedChar { found: c });
    }
    if !task_id.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return Err(ValidationError::InvalidShape {
            reason: "task id must start with a letter or digit".into(),
        });
    }
    Ok(())
}

/// The repository's current `HEAD` as a FULL object id (40 or 64 hex),
/// verified — the value Core records as the task's `base_commit`. An unborn
/// `HEAD` is [`WorkspaceError::NoCommit`]; any other failure stays a git
/// error.
pub fn record_base(runner: &GitRunner, repo: &Path) -> Result<String, WorkspaceError> {
    match runner.head_oid(repo)? {
        Some(oid) => Ok(oid),
        None => Err(WorkspaceError::NoCommit(repo.display().to_string())),
    }
}

/// Limits for worktree mutations: the runner's output caps with the
/// MUTATION timeout (a QUERY-class timeout mid-checkout or mid-delete would
/// leave a half-made or half-removed worktree).
fn mutation_limits(runner: &GitRunner) -> RunLimits {
    RunLimits {
        timeout: RunLimits::MUTATION.timeout,
        ..runner.limits
    }
}

/// Create `<root>/<task_id>` as a worktree of `repo` on a NEW branch
/// `sandpane/<task_id>` at exactly `base_commit` (a full object id). `root`
/// must already exist (the service creates it 0700). Refuses repositories
/// with submodules and every overlap/reuse case BEFORE any write; after the
/// write, re-reads the worktree `HEAD` and removes the fresh worktree again if
/// it is not exactly the base.
pub fn allocate_worktree(
    runner: &GitRunner,
    repo: &Path,
    root: &Path,
    task_id: &str,
    base_commit: &str,
) -> Result<AllocatedWorktree, WorkspaceError> {
    Validator::full_object_id(base_commit)?;
    let task_branch = task_branch_for(task_id)?;
    let repo_c = canonical(repo)?;
    let root_c = canonical(root)?;
    if root_c.starts_with(&repo_c) || repo_c.starts_with(&root_c) {
        return Err(WorkspaceError::RootOverlapsRepository {
            root: root_c.display().to_string(),
            repo: repo_c.display().to_string(),
        });
    }
    let path = root_c.join(task_id);
    if std::fs::symlink_metadata(&path).is_ok() {
        return Err(WorkspaceError::PathExists(path.display().to_string()));
    }
    // Earliest submodule refusal: never create a worktree Core could not
    // later review or clean up safely.
    runner.refuse_submodules(&repo_c)?;
    let args = GitArgs::worktree_add(&path, &task_branch, base_commit)?;
    runner.run_with_limits(&repo_c, &args, &mutation_limits(runner))?;
    // Re-query after the mutation: exit 0 is not proof of the desired state.
    let head = runner.rev_parse_head(&path)?;
    if !head.eq_ignore_ascii_case(base_commit) {
        if let Err(e) = remove_worktree(runner, &repo_c, &root_c, &path, &task_branch, &head) {
            eprintln!(
                "sandpane-core: cleanup of mis-allocated worktree {} failed: {e}",
                path.display()
            );
        }
        return Err(WorkspaceError::HeadMoved {
            path: path.display().to_string(),
            expected: base_commit.to_string(),
            found: head,
        });
    }
    Ok(AllocatedWorktree {
        base_commit: base_commit.to_string(),
        task_branch,
        path,
    })
}

/// Prove `worktree` is a Core task worktree of `repo` before trusting it: an
/// existing real directory (not a symlink) under `root`, registered in the
/// repository's own worktree list, whose top level is itself and whose
/// common git dir is the repository's. The worktree's `.git` file is
/// writable by whatever runs in it, so the repository side is authoritative.
pub fn verify_task_worktree(
    runner: &GitRunner,
    repo: &Path,
    root: &Path,
    worktree: &Path,
) -> Result<(), WorkspaceError> {
    let not_ours = |reason: &str| WorkspaceError::NotTaskWorktree {
        path: worktree.display().to_string(),
        reason: reason.to_string(),
    };
    let repo_c = canonical(repo)?;
    let root_c = canonical(root)?;
    under_root(&root_c, worktree).map_err(|_| not_ours("outside Sandpane's worktree root"))?;
    let meta = std::fs::symlink_metadata(worktree).map_err(|_| not_ours("directory is missing"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(not_ours("not a real directory"));
    }
    if canonical(worktree)? != worktree {
        return Err(not_ours("path is not canonical"));
    }
    let listed = runner.worktree_list(&repo_c)?;
    if !listed.iter().any(|e| Path::new(&e.path) == worktree) {
        return Err(not_ours("not registered in the repository's worktree list"));
    }
    let top = runner
        .show_toplevel(worktree)
        .map_err(|_| not_ours("not a Git work tree"))?;
    if canonical(&top)? != worktree {
        return Err(not_ours("its top level is a different directory"));
    }
    if runner.common_dir(worktree)? != runner.common_dir(&repo_c)? {
        return Err(not_ours("it belongs to a different repository"));
    }
    Ok(())
}

/// Every removal check, with NO side effect (see the module docs).
pub fn plan_worktree_removal(
    runner: &GitRunner,
    repo: &Path,
    root: &Path,
    worktree: &Path,
    task_branch: &str,
    base_commit: &str,
) -> Result<RemovalPlan, WorkspaceError> {
    Validator::full_object_id(base_commit)?;
    Validator::branch_name(task_branch)?;
    if !task_branch.starts_with(TASK_BRANCH_PREFIX) {
        return Err(WorkspaceError::Validation(ValidationError::InvalidShape {
            reason: format!("only {TASK_BRANCH_PREFIX}<task-id> branches are removable"),
        }));
    }
    let repo_c = canonical(repo)?;
    let root_c = canonical(root)?;
    under_root(&root_c, worktree)?;
    // Review C1: a symbolic task ref is tampering. Nothing below may read
    // through it (the worktree list reports the RESOLVED ref, rev-parse
    // dereferences), so refuse first.
    if let Some(target) = runner.symbolic_ref_target(&repo_c, task_branch)? {
        return Err(WorkspaceError::SymbolicTaskRef {
            branch: task_branch.to_string(),
            target,
        });
    }
    let listed = runner.worktree_list(&repo_c)?;
    let registered = listed.iter().any(|e| Path::new(&e.path) == worktree);
    let present = std::fs::symlink_metadata(worktree).is_ok();
    if present {
        verify_task_worktree(runner, &repo_c, &root_c, worktree)?;
        let hidden = runner.index_hidden_entries(worktree)?;
        if !hidden.is_empty() {
            return Err(WorkspaceError::IndexFlagsHideChanges {
                path: worktree.display().to_string(),
                entries: hidden,
            });
        }
        if runner.is_dirty(worktree)? {
            return Err(WorkspaceError::UncommittedChanges(
                worktree.display().to_string(),
            ));
        }
        let ignored = runner.ignored_entries(worktree)?;
        if !ignored.is_empty() {
            return Err(WorkspaceError::IgnoredFiles {
                path: worktree.display().to_string(),
                entries: ignored,
            });
        }
        let head = runner.rev_parse_head(worktree)?;
        if !head.eq_ignore_ascii_case(base_commit) {
            return Err(WorkspaceError::HeadMoved {
                path: worktree.display().to_string(),
                expected: base_commit.to_string(),
                found: head,
            });
        }
    }
    let full_ref = format!("refs/heads/{task_branch}");
    if let Some(other) = listed
        .iter()
        .find(|e| e.branch.as_deref() == Some(full_ref.as_str()) && Path::new(&e.path) != worktree)
    {
        return Err(WorkspaceError::BranchCheckedOutElsewhere {
            branch: task_branch.to_string(),
            path: other.path.clone(),
        });
    }
    // Not symbolic (checked above), so this read is of the ref itself.
    let tip = runner.branch_oid(&repo_c, task_branch)?;
    if let Some(tip) = &tip {
        if !tip.eq_ignore_ascii_case(base_commit) {
            return Err(WorkspaceError::BranchAdvanced {
                branch: task_branch.to_string(),
                expected: base_commit.to_string(),
                found: tip.clone(),
            });
        }
    }
    Ok(RemovalPlan {
        repo: repo_c,
        worktree: worktree.to_path_buf(),
        task_branch: task_branch.to_string(),
        base_commit: base_commit.to_string(),
        directory_present: present,
        registered,
        branch_exists: tip.is_some(),
    })
}

/// Carry out a [`RemovalPlan`]. git re-checks cleanliness (no `--force`) and
/// the branch delete is a non-dereferencing compare-and-delete, so anything
/// that changed since the plan makes this fail instead of destroying work.
pub fn execute_worktree_removal(
    runner: &GitRunner,
    plan: &RemovalPlan,
) -> Result<RemovedWorktree, WorkspaceError> {
    if plan.directory_present || plan.registered {
        runner.run_with_limits(
            &plan.repo,
            &GitArgs::worktree_remove(&plan.worktree)?,
            &mutation_limits(runner),
        )?;
    }
    if plan.branch_exists {
        runner.run_with_limits(
            &plan.repo,
            &GitArgs::update_ref_delete(&plan.task_branch, &plan.base_commit)?,
            &mutation_limits(runner),
        )?;
    }
    Ok(RemovedWorktree {
        directory_was_present: plan.directory_present,
        branch_deleted: plan.branch_exists,
    })
}

/// [`plan_worktree_removal`] then [`execute_worktree_removal`].
pub fn remove_worktree(
    runner: &GitRunner,
    repo: &Path,
    root: &Path,
    worktree: &Path,
    task_branch: &str,
    base_commit: &str,
) -> Result<RemovedWorktree, WorkspaceError> {
    let plan = plan_worktree_removal(runner, repo, root, worktree, task_branch, base_commit)?;
    execute_worktree_removal(runner, &plan)
}

fn canonical(path: &Path) -> Result<PathBuf, WorkspaceError> {
    std::fs::canonicalize(path).map_err(|e| {
        WorkspaceError::Git(GitError::Exec(format!(
            "path {} not usable: {e}",
            path.display()
        )))
    })
}

/// `candidate` must be a DIRECT child of the canonical root (`<root>/<id>`):
/// lexical check on an absolute path, so it also holds for a deleted
/// directory.
fn under_root(root_c: &Path, candidate: &Path) -> Result<(), WorkspaceError> {
    let normalized = Validator::path_within_root(root_c, candidate)?;
    if normalized.parent() != Some(root_c) {
        return Err(WorkspaceError::Validation(ValidationError::PathEscapesRoot));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const TASK: &str = "3f9a1c22-0000-4000-8000-abcdef012345";

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Plain git, success not required (used to probe for absence).
    fn git_ok(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
            .status
            .success()
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "sandpane@test.invalid"]);
        git(dir, &["config", "user.name", "Sandpane Test"]);
        std::fs::write(dir.join("file.txt"), "base\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "base commit"]);
    }

    /// `<tmp>/host` (a committed repo) and `<tmp>/worktrees` (Core's root),
    /// both canonical (macOS `/var` → `/private/var`).
    struct Fixture {
        _dir: tempfile::TempDir,
        repo: PathBuf,
        root: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let repo = base.join("host repo");
        let root = base.join("data dir").join("worktrees");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        init_repo(&repo);
        Fixture {
            _dir: dir,
            repo,
            root,
        }
    }

    fn sandpane_branches(repo: &Path) -> String {
        git(repo, &["branch", "--list", "sandpane/*"])
    }

    fn worktree_count(repo: &Path) -> usize {
        git(repo, &["worktree", "list", "--porcelain"])
            .lines()
            .filter(|l| l.starts_with("worktree "))
            .count()
    }

    fn allocate(f: &Fixture) -> (String, AllocatedWorktree) {
        let runner = GitRunner::default();
        let base = record_base(&runner, &f.repo).unwrap();
        let wt = allocate_worktree(&runner, &f.repo, &f.root, TASK, &base).unwrap();
        (base, wt)
    }

    #[test]
    fn task_branch_is_sandpane_prefixed_and_validated() {
        assert_eq!(task_branch_for(TASK).unwrap(), format!("sandpane/{TASK}"));
        for bad in ["", "../x", "a b", "x/y", "-x", "a;b", "t$(id)", "a..b"] {
            assert!(task_branch_for(bad).is_err(), "{bad:?} accepted");
        }
        assert!(task_branch_for(&"a".repeat(65)).is_err());
    }

    #[test]
    fn record_base_returns_the_exact_full_head_oid() {
        let f = fixture();
        let base = record_base(&GitRunner::default(), &f.repo).unwrap();
        assert_eq!(base, git(&f.repo, &["rev-parse", "HEAD"]));
        assert_eq!(base.len(), 40);
        crate::Validator::full_object_id(&base).unwrap();
        // A repository with no commit has no base to record.
        let empty = tempfile::tempdir().unwrap();
        git(empty.path(), &["init", "-q", "-b", "main"]);
        assert!(record_base(&GitRunner::default(), empty.path()).is_err());
    }

    #[test]
    fn allocation_creates_task_branch_and_worktree_at_the_exact_base() {
        let f = fixture();
        let host_head = git(&f.repo, &["rev-parse", "HEAD"]);
        let (base, wt) = allocate(&f);
        assert_eq!(wt.base_commit, base);
        assert_eq!(wt.task_branch, format!("sandpane/{TASK}"));
        assert_eq!(wt.path, f.root.join(TASK));
        assert_eq!(
            git(
                &f.repo,
                &["rev-parse", &format!("refs/heads/sandpane/{TASK}")]
            ),
            base
        );
        assert_eq!(git(&wt.path, &["rev-parse", "HEAD"]), base);
        assert_eq!(
            git(&wt.path, &["symbolic-ref", "HEAD"]),
            format!("refs/heads/sandpane/{TASK}")
        );
        assert_eq!(
            std::fs::read_to_string(wt.path.join("file.txt")).unwrap(),
            "base\n"
        );
        // The user's checkout is untouched: same branch, same commit.
        assert_eq!(git(&f.repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
        assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]), host_head);
        assert_eq!(worktree_count(&f.repo), 2);
        verify_task_worktree(&GitRunner::default(), &f.repo, &f.root, &wt.path).unwrap();
    }

    /// The worktree starts at the RECORDED base even when the host moved on.
    #[test]
    fn allocation_uses_the_recorded_base_not_the_current_head() {
        let f = fixture();
        let runner = GitRunner::default();
        let base = record_base(&runner, &f.repo).unwrap();
        std::fs::write(f.repo.join("file.txt"), "host moved on\n").unwrap();
        git(&f.repo, &["commit", "-qam", "later"]);
        let wt = allocate_worktree(&runner, &f.repo, &f.root, TASK, &base).unwrap();
        assert_eq!(git(&wt.path, &["rev-parse", "HEAD"]), base);
        assert_eq!(
            std::fs::read_to_string(wt.path.join("file.txt")).unwrap(),
            "base\n"
        );
        // An abbreviated base is not an identity (security W3).
        assert!(allocate_worktree(&runner, &f.repo, &f.root, "other-task", &base[..12]).is_err());
    }

    #[test]
    fn worktree_files_are_isolated_from_host_edits_in_both_directions() {
        let f = fixture();
        let runner = GitRunner::default();
        let (base, wt) = allocate(&f);
        // Host edits (user work) never reach the task worktree...
        std::fs::write(f.repo.join("file.txt"), "user edit\n").unwrap();
        std::fs::write(f.repo.join("user-notes.txt"), "untracked\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(wt.path.join("file.txt")).unwrap(),
            "base\n"
        );
        assert!(!wt.path.join("user-notes.txt").exists());
        assert!(!runner.is_dirty(&wt.path).unwrap());
        // ...and task edits never reach the host.
        std::fs::write(wt.path.join("file.txt"), "task edit\n").unwrap();
        std::fs::write(wt.path.join("task-new.txt"), "new\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(f.repo.join("file.txt")).unwrap(),
            "user edit\n"
        );
        assert!(!f.repo.join("task-new.txt").exists());
        let changes = runner.change_list(&wt.path, &base).unwrap();
        let mut paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["file.txt", "task-new.txt"]);
        assert_eq!(git(&f.repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
    }

    #[test]
    fn allocation_refuses_a_repository_with_submodules_before_any_write() {
        let f = fixture();
        let origin = f.root.parent().unwrap().join("lib-origin");
        std::fs::create_dir(&origin).unwrap();
        init_repo(&origin);
        git(
            &f.repo,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                &origin.display().to_string(),
                "vendor/lib",
            ],
        );
        git(&f.repo, &["commit", "-qm", "add submodule"]);
        let runner = GitRunner::default();
        let base = record_base(&runner, &f.repo).unwrap();
        match allocate_worktree(&runner, &f.repo, &f.root, TASK, &base) {
            Err(WorkspaceError::Git(GitError::SubmodulesPresent(paths))) => {
                assert_eq!(paths, vec!["vendor/lib".to_string()]);
            }
            other => panic!("expected SubmodulesPresent, got {other:?}"),
        }
        assert_eq!(sandpane_branches(&f.repo), "");
        assert!(!f.root.join(TASK).exists());
        assert_eq!(worktree_count(&f.repo), 1);
    }

    #[test]
    fn allocation_refuses_a_root_inside_the_repository() {
        let f = fixture();
        let runner = GitRunner::default();
        let base = record_base(&runner, &f.repo).unwrap();
        let inside = f.repo.join(".sandpane-worktrees");
        std::fs::create_dir(&inside).unwrap();
        assert!(matches!(
            allocate_worktree(&runner, &f.repo, &inside, TASK, &base),
            Err(WorkspaceError::RootOverlapsRepository { .. })
        ));
        assert_eq!(sandpane_branches(&f.repo), "");
        assert!(!inside.join(TASK).exists());
    }

    #[test]
    fn allocation_never_reuses_an_existing_path_or_branch() {
        let f = fixture();
        let runner = GitRunner::default();
        let base = record_base(&runner, &f.repo).unwrap();
        std::fs::create_dir(f.root.join(TASK)).unwrap();
        std::fs::write(f.root.join(TASK).join("keep.txt"), "x\n").unwrap();
        assert!(matches!(
            allocate_worktree(&runner, &f.repo, &f.root, TASK, &base),
            Err(WorkspaceError::PathExists(_))
        ));
        assert!(f.root.join(TASK).join("keep.txt").exists());
        assert_eq!(sandpane_branches(&f.repo), "");
        // A pre-existing branch of that name is refused by git, not reset.
        git(&f.repo, &["branch", "sandpane/other-task"]);
        assert!(allocate_worktree(&runner, &f.repo, &f.root, "other-task", &base).is_err());
        assert!(!f.root.join("other-task").exists());
    }

    #[test]
    fn removal_refuses_uncommitted_or_untracked_worktree_changes() {
        let f = fixture();
        let runner = GitRunner::default();
        let (base, wt) = allocate(&f);
        let branch = wt.task_branch.clone();
        std::fs::write(wt.path.join("file.txt"), "agent work\n").unwrap();
        match remove_worktree(&runner, &f.repo, &f.root, &wt.path, &branch, &base) {
            Err(e @ WorkspaceError::UncommittedChanges(_)) => {
                assert!(e.to_string().contains("uncommitted"), "{e}");
            }
            other => panic!("expected UncommittedChanges, got {other:?}"),
        }
        assert_eq!(
            std::fs::read_to_string(wt.path.join("file.txt")).unwrap(),
            "agent work\n"
        );
        git(&wt.path, &["checkout", "-q", "--", "file.txt"]);
        std::fs::write(wt.path.join("scratch.txt"), "untracked work\n").unwrap();
        assert!(matches!(
            remove_worktree(&runner, &f.repo, &f.root, &wt.path, &branch, &base),
            Err(WorkspaceError::UncommittedChanges(_))
        ));
        assert!(wt.path.join("scratch.txt").exists());
        assert!(git_ok(&f.repo, &["rev-parse", "--verify", &branch]));
        assert_eq!(worktree_count(&f.repo), 2);
    }

    /// Commits on the task branch are work too: never discarded silently.
    #[test]
    fn removal_refuses_when_the_task_branch_holds_commits() {
        let f = fixture();
        let runner = GitRunner::default();
        let (base, wt) = allocate(&f);
        std::fs::write(wt.path.join("file.txt"), "committed agent work\n").unwrap();
        git(&wt.path, &["commit", "-qam", "agent commit"]);
        let tip = git(&wt.path, &["rev-parse", "HEAD"]);
        assert!(matches!(
            remove_worktree(&runner, &f.repo, &f.root, &wt.path, &wt.task_branch, &base),
            Err(WorkspaceError::HeadMoved { .. })
        ));
        assert!(wt.path.exists());
        assert_eq!(git(&f.repo, &["rev-parse", &wt.task_branch]), tip);
    }

    #[test]
    fn removal_deletes_a_clean_worktree_and_its_branch_only() {
        let f = fixture();
        let runner = GitRunner::default();
        let host_head = git(&f.repo, &["rev-parse", "HEAD"]);
        let (base, wt) = allocate(&f);
        // Uncommitted USER work in the host repo must survive the cleanup.
        std::fs::write(f.repo.join("file.txt"), "user edit\n").unwrap();
        std::fs::write(f.repo.join("user-notes.txt"), "untracked\n").unwrap();
        let out =
            remove_worktree(&runner, &f.repo, &f.root, &wt.path, &wt.task_branch, &base).unwrap();
        assert_eq!(
            out,
            RemovedWorktree {
                directory_was_present: true,
                branch_deleted: true
            }
        );
        assert!(!wt.path.exists());
        assert_eq!(sandpane_branches(&f.repo), "");
        assert_eq!(worktree_count(&f.repo), 1);
        assert_eq!(git(&f.repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
        assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]), host_head);
        assert_eq!(
            std::fs::read_to_string(f.repo.join("file.txt")).unwrap(),
            "user edit\n"
        );
        assert!(f.repo.join("user-notes.txt").exists());
    }

    /// The worktree directory was deleted outside Core: nothing on disk to
    /// protect, so the stale registration and the (base-pinned) branch go.
    #[test]
    fn removal_handles_a_directory_deleted_outside_core() {
        let f = fixture();
        let runner = GitRunner::default();
        let (base, wt) = allocate(&f);
        std::fs::remove_dir_all(&wt.path).unwrap();
        let out =
            remove_worktree(&runner, &f.repo, &f.root, &wt.path, &wt.task_branch, &base).unwrap();
        assert!(!out.directory_was_present);
        assert!(out.branch_deleted);
        assert_eq!(sandpane_branches(&f.repo), "");
        assert_eq!(worktree_count(&f.repo), 1);
    }

    /// The user checked the task branch out in their own tree: the branch is
    /// theirs now; deleting it would orphan their HEAD.
    #[test]
    fn removal_refuses_a_branch_checked_out_in_another_worktree() {
        let f = fixture();
        let runner = GitRunner::default();
        let (base, wt) = allocate(&f);
        std::fs::remove_dir_all(&wt.path).unwrap();
        git(&f.repo, &["worktree", "prune"]);
        git(&f.repo, &["checkout", "-q", &wt.task_branch]);
        assert!(matches!(
            remove_worktree(&runner, &f.repo, &f.root, &wt.path, &wt.task_branch, &base),
            Err(WorkspaceError::BranchCheckedOutElsewhere { .. })
        ));
        assert_eq!(
            git(&f.repo, &["symbolic-ref", "HEAD"]),
            format!("refs/heads/{}", wt.task_branch)
        );
        assert!(git_ok(&f.repo, &["rev-parse", "--verify", &wt.task_branch]));
    }

    #[test]
    fn verification_rejects_paths_that_are_not_this_repos_task_worktree() {
        let f = fixture();
        let runner = GitRunner::default();
        let (_base, wt) = allocate(&f);
        // A different repository planted under the root.
        let foreign = f.root.join("foreign");
        std::fs::create_dir(&foreign).unwrap();
        init_repo(&foreign);
        assert!(matches!(
            verify_task_worktree(&runner, &f.repo, &f.root, &foreign),
            Err(WorkspaceError::NotTaskWorktree { .. })
        ));
        // A real worktree of the repo, but outside Core's root.
        let outside = f.root.parent().unwrap().join("outside-wt");
        git(
            &f.repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "elsewhere",
                &outside.display().to_string(),
            ],
        );
        assert!(verify_task_worktree(&runner, &f.repo, &f.root, &outside).is_err());
        // A removed directory.
        std::fs::remove_dir_all(&wt.path).unwrap();
        assert!(verify_task_worktree(&runner, &f.repo, &f.root, &wt.path).is_err());
        // Removal never touches a foreign directory under the root.
        assert!(remove_worktree(
            &runner,
            &f.repo,
            &f.root,
            &foreign,
            "sandpane/foreign",
            &git(&f.repo, &["rev-parse", "HEAD"])
        )
        .is_err());
        assert!(foreign.join("file.txt").exists());
    }

    /// Review C1 (PoC A): with write access to the shared common dir, the
    /// task ref can be turned into `ref: refs/heads/main`. A dereferencing
    /// read/delete then deleted the USER's branch. Refuse before any mutation.
    #[test]
    fn removal_refuses_a_symbolic_task_ref_and_never_touches_its_target() {
        let f = fixture();
        let runner = GitRunner::default();
        let (base, wt) = allocate(&f);
        git(
            &f.repo,
            &[
                "symbolic-ref",
                &format!("refs/heads/{}", wt.task_branch),
                "refs/heads/main",
            ],
        );
        match remove_worktree(&runner, &f.repo, &f.root, &wt.path, &wt.task_branch, &base) {
            Err(WorkspaceError::SymbolicTaskRef { target, .. }) => {
                assert_eq!(target, "refs/heads/main");
            }
            other => panic!("expected SymbolicTaskRef, got {other:?}"),
        }
        assert!(git_ok(
            &f.repo,
            &["rev-parse", "--verify", "-q", "refs/heads/main"]
        ));
        assert!(git_ok(&f.repo, &["rev-parse", "--verify", "-q", "HEAD"]));
        assert!(wt.path.exists(), "nothing removed");
    }

    /// Review C2 (PoC B): repo config `status.showUntrackedFiles=no` hid
    /// untracked work from the dirty check AND from git's own check inside
    /// `worktree remove`, so the work was deleted.
    #[test]
    fn removal_sees_untracked_work_even_when_repo_config_hides_it() {
        let f = fixture();
        git(&f.repo, &["config", "status.showUntrackedFiles", "no"]);
        let runner = GitRunner::default();
        let (base, wt) = allocate(&f);
        std::fs::write(wt.path.join("UNREVIEWED_WORK.txt"), "work\n").unwrap();
        assert!(matches!(
            remove_worktree(&runner, &f.repo, &f.root, &wt.path, &wt.task_branch, &base),
            Err(WorkspaceError::UncommittedChanges(_))
        ));
        assert!(wt.path.join("UNREVIEWED_WORK.txt").exists());
    }

    /// Review S2: index bits hide modifications from `status`. assume-unchanged
    /// (`ls-files -v` lowercase tag) and skip-worktree (`S`) both refuse.
    #[test]
    fn removal_refuses_index_entries_flagged_to_hide_changes() {
        for flag in ["--assume-unchanged", "--skip-worktree"] {
            let f = fixture();
            let runner = GitRunner::default();
            let (base, wt) = allocate(&f);
            git(&wt.path, &["update-index", flag, "file.txt"]);
            std::fs::write(wt.path.join("file.txt"), "hidden work\n").unwrap();
            match remove_worktree(&runner, &f.repo, &f.root, &wt.path, &wt.task_branch, &base) {
                Err(WorkspaceError::IndexFlagsHideChanges { entries, .. }) => {
                    assert_eq!(entries, vec!["file.txt".to_string()], "{flag}");
                }
                other => panic!("{flag}: expected IndexFlagsHideChanges, got {other:?}"),
            }
            assert_eq!(
                std::fs::read_to_string(wt.path.join("file.txt")).unwrap(),
                "hidden work\n"
            );
        }
    }

    /// Review W2: `worktree remove` deletes IGNORED files. Never silently:
    /// refuse while anything ignored exists (until a confirmation can bind
    /// the exact list).
    #[test]
    fn removal_refuses_ignored_files_instead_of_deleting_them() {
        let f = fixture();
        std::fs::write(f.repo.join(".gitignore"), "build/\n").unwrap();
        git(&f.repo, &["add", ".gitignore"]);
        git(&f.repo, &["commit", "-qm", "ignore build"]);
        let runner = GitRunner::default();
        let (base, wt) = allocate(&f);
        std::fs::create_dir(wt.path.join("build")).unwrap();
        std::fs::write(wt.path.join("build").join("out.bin"), "output\n").unwrap();
        match remove_worktree(&runner, &f.repo, &f.root, &wt.path, &wt.task_branch, &base) {
            Err(WorkspaceError::IgnoredFiles { entries, .. }) => {
                assert_eq!(entries, vec!["build/".to_string()]);
            }
            other => panic!("expected IgnoredFiles, got {other:?}"),
        }
        assert!(wt.path.join("build").join("out.bin").exists());
    }

    /// Review W2: a repo-configured `core.excludesFile` must not reclassify
    /// work as ignored — Core neutralizes it, so the file is plain untracked.
    #[test]
    fn repo_configured_excludes_file_cannot_hide_work() {
        let f = fixture();
        let excludes = f.root.parent().unwrap().join("agent-excludes");
        std::fs::write(&excludes, "*.txt\n").unwrap();
        git(
            &f.repo,
            &[
                "config",
                "core.excludesFile",
                &excludes.display().to_string(),
            ],
        );
        let runner = GitRunner::default();
        let (base, wt) = allocate(&f);
        std::fs::write(wt.path.join("work.txt"), "work\n").unwrap();
        assert!(matches!(
            remove_worktree(&runner, &f.repo, &f.root, &wt.path, &wt.task_branch, &base),
            Err(WorkspaceError::UncommittedChanges(_))
        ));
        let changes = runner.change_list(&wt.path, &base).unwrap();
        assert!(changes.iter().any(|c| c.path == "work.txt"), "{changes:?}");
    }

    /// Review S9: the branch moved on while the worktree HEAD stayed at base.
    #[test]
    fn removal_refuses_when_only_the_branch_advanced() {
        let f = fixture();
        let runner = GitRunner::default();
        let (base, wt) = allocate(&f);
        git(&wt.path, &["checkout", "-q", "--detach"]);
        std::fs::write(f.repo.join("file.txt"), "elsewhere\n").unwrap();
        git(&f.repo, &["commit", "-qam", "user commit"]);
        let moved = git(&f.repo, &["rev-parse", "HEAD"]);
        git(
            &f.repo,
            &[
                "update-ref",
                &format!("refs/heads/{}", wt.task_branch),
                &moved,
            ],
        );
        assert!(matches!(
            remove_worktree(&runner, &f.repo, &f.root, &wt.path, &wt.task_branch, &base),
            Err(WorkspaceError::BranchAdvanced { .. })
        ));
        assert_eq!(git(&f.repo, &["rev-parse", &wt.task_branch]), moved);
        assert!(wt.path.exists());
    }

    /// Review S9: non-ASCII repository and root paths round-trip through
    /// allocation, verification and removal (`core.quotePath=false`, `-z`).
    #[test]
    fn non_ascii_repository_and_root_paths_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let base_dir = std::fs::canonicalize(dir.path()).unwrap();
        let repo = base_dir.join("Dépôt 日本");
        let root = base_dir.join("données").join("worktrees");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        init_repo(&repo);
        let runner = GitRunner::default();
        let base = record_base(&runner, &repo).unwrap();
        let wt = allocate_worktree(&runner, &repo, &root, TASK, &base).unwrap();
        verify_task_worktree(&runner, &repo, &root, &wt.path).unwrap();
        let out = remove_worktree(&runner, &repo, &root, &wt.path, &wt.task_branch, &base).unwrap();
        assert!(out.directory_was_present && out.branch_deleted);
        assert!(!wt.path.exists());
    }

    /// Review S4: "no commit" is a distinct, structured outcome.
    #[test]
    fn record_base_reports_a_repository_without_commits_distinctly() {
        let empty = tempfile::tempdir().unwrap();
        git(empty.path(), &["init", "-q", "-b", "main"]);
        assert!(matches!(
            record_base(&GitRunner::default(), empty.path()),
            Err(WorkspaceError::NoCommit(_))
        ));
        // Not a repository at all is a git execution failure, not "no commit".
        let plain = tempfile::tempdir().unwrap();
        assert!(matches!(
            record_base(&GitRunner::default(), plain.path()),
            Err(WorkspaceError::Git(GitError::Exec(_)))
        ));
    }

    /// Review C1, second defence: a task ref that turns symbolic AFTER the
    /// preflight is deleted as the ref itself (`--no-deref`), never through
    /// to the branch it points at.
    #[test]
    fn execution_never_deletes_through_a_ref_made_symbolic_after_planning() {
        let f = fixture();
        let runner = GitRunner::default();
        let (base, wt) = allocate(&f);
        let plan =
            plan_worktree_removal(&runner, &f.repo, &f.root, &wt.path, &wt.task_branch, &base)
                .unwrap();
        git(
            &f.repo,
            &[
                "symbolic-ref",
                &format!("refs/heads/{}", wt.task_branch),
                "refs/heads/main",
            ],
        );
        let _ = execute_worktree_removal(&runner, &plan);
        assert!(git_ok(
            &f.repo,
            &["rev-parse", "--verify", "-q", "refs/heads/main"]
        ));
        assert!(git_ok(&f.repo, &["rev-parse", "--verify", "-q", "HEAD"]));
    }
}
