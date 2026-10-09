//! Git workspace safety (docs/specs/02 §7, docs/specs/06 §6).
//!
//! Arg-vector builders + a minimal real runner. Apply is always an explicit
//! Git operation with base/dirty checks — never a silent file overwrite.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::validation::{ValidationError, Validator};

#[derive(Debug, Error)]
pub enum GitError {
    #[error("invalid input: {0}")]
    Validation(#[from] ValidationError),
    #[error("git execution failed: {0}")]
    Exec(String),
    #[error("repository is dirty; refusing to proceed: {0}")]
    DirtyHostState(String),
    #[error("base revision diverged: expected {expected}, found {found}")]
    BaseDiverged { expected: String, found: String },
}

/// Fixed git executable (PATH-resolved by the OS; overridable for tests).
pub struct GitRunner {
    pub program: PathBuf,
}

impl Default for GitRunner {
    fn default() -> Self {
        Self {
            program: PathBuf::from("git"),
        }
    }
}

impl GitRunner {
    /// Run a builder-produced vector in `cwd`. No shell is involved.
    pub fn run(&self, cwd: &Path, args: &[String]) -> Result<String, GitError> {
        Validator::assert_no_shell_metachars(args).map_err(GitError::Validation)?;
        let out = Command::new(&self.program)
            .args(args)
            .current_dir(cwd)
            .output()
            .map_err(|e| GitError::Exec(e.to_string()))?;
        if !out.status.success() {
            return Err(GitError::Exec(format!(
                "git {} exited {}: {}",
                args.first().map(String::as_str).unwrap_or("?"),
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub fn rev_parse_head(&self, repo: &Path) -> Result<String, GitError> {
        let out = self.run(repo, &GitArgs::rev_parse_head())?;
        Ok(out.trim().to_string())
    }

    /// Porcelain status → true when the working tree has ANY uncommitted
    /// change (staged, unstaged, or untracked).
    pub fn is_dirty(&self, repo: &Path) -> Result<bool, GitError> {
        let out = self.run(repo, &GitArgs::status_porcelain())?;
        Ok(!out.trim().is_empty())
    }

    /// Actual change list vs a base revision, including untracked files
    /// (marked `untracked` — they are in NO git diff and must not be silently
    /// missed; specs/08 T15). The diff compares `base` against the WORKING
    /// TREE, so committed, staged, and unstaged modifications all appear.
    /// Renames are reported as `renamed` at their NEW path (T15 requires the
    /// full set: new/deleted/renamed/untracked).
    pub fn change_list(&self, repo: &Path, base_commit: &str) -> Result<Vec<RawChange>, GitError> {
        Validator::git_ref(base_commit)?;
        let tracked = self.run(repo, &GitArgs::diff_name_status(base_commit))?;
        let mut changes = Vec::new();
        for line in tracked.lines() {
            let mut fields = line.split('\t');
            let (Some(code), Some(first_path)) = (fields.next(), fields.next()) else {
                continue;
            };
            let status = match code.chars().next() {
                Some('A') | Some('C') => "added",
                Some('M') | Some('T') => "modified",
                Some('D') => "deleted",
                Some('R') => "renamed",
                // U (unmerged), X (conflict), B, L: surface as modified so a
                // review never silently drops a touched file.
                _ => "modified",
            };
            // Rename/copy lines carry the old path first and the new path
            // second; every other line carries one path.
            let path = match (status, fields.next()) {
                ("renamed" | "added", Some(second)) => second,
                _ => first_path,
            };
            changes.push(RawChange {
                path: path.to_string(),
                status: status.to_string(),
            });
        }
        let untracked = self.run(repo, &GitArgs::ls_files_others())?;
        for line in untracked.lines() {
            if !line.trim().is_empty() {
                changes.push(RawChange {
                    path: line.to_string(),
                    status: "untracked".to_string(),
                });
            }
        }
        Ok(changes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawChange {
    pub path: String,
    pub status: String,
}

/// Pure argument-vector builders (unit-testable without a repo).
pub struct GitArgs;

impl GitArgs {
    pub fn rev_parse_head() -> Vec<String> {
        vec!["rev-parse".into(), "HEAD".into()]
    }

    pub fn status_porcelain() -> Vec<String> {
        vec!["status".into(), "--porcelain".into()]
    }

    /// `git -c core.quotePath=false diff --name-status <base>` — base vs
    /// working tree (committed, staged, and unstaged modifications all
    /// appear). `core.quotePath=false` keeps non-ASCII paths verbatim instead
    /// of C-escaped, so review paths match real filenames (finding #10).
    pub fn diff_name_status(base: &str) -> Vec<String> {
        vec![
            "-c".into(),
            "core.quotePath=false".into(),
            "diff".into(),
            "--name-status".into(),
            base.into(),
        ]
    }

    pub fn ls_files_others() -> Vec<String> {
        vec![
            "-c".into(),
            "core.quotePath=false".into(),
            "ls-files".into(),
            "--others".into(),
            "--exclude-standard".into(),
        ]
    }

    /// Create an isolated task worktree: `git worktree add <path> -b <branch> <base>`.
    pub fn worktree_add(
        path: &Path,
        branch: &str,
        base_commit: &str,
    ) -> Result<Vec<String>, GitError> {
        Validator::branch_name(branch)?;
        Validator::git_ref(base_commit)?;
        if !path.is_absolute() {
            return Err(GitError::Validation(ValidationError::NotAbsolute {
                path: path.display().to_string(),
            }));
        }
        Ok(vec![
            "worktree".into(),
            "add".into(),
            path.display().to_string(),
            "-b".into(),
            branch.into(),
            base_commit.into(),
        ])
    }
}

/// Pre-integration safety gate (specs/06 §6 "Before integrating changes"):
/// verify the host tree is clean and HEAD still matches the recorded base.
/// `expected_base` is a full or abbreviated object id; callers needing ref
/// names must resolve them with `rev-parse` first (recorded limitation).
///
/// KNOWN SCOPE LIMIT (P4 work, review 0004 #8): the clean-tree gate is
/// correct for `sbx_clone`/`host_worktree` but structurally blocks apply for
/// `direct_mount`, whose host tree is dirty BY DESIGN (specs/02 §7). P4 must
/// scope the dirty gate to the paths a patch touches — do not "fix" this by
/// weakening the review/change side.
pub fn preconditions_for_apply(
    runner: &GitRunner,
    repo: &Path,
    expected_base: &str,
) -> Result<(), GitError> {
    Validator::git_ref(expected_base)?;
    if runner.is_dirty(repo)? {
        return Err(GitError::DirtyHostState(
            "uncommitted host changes present".into(),
        ));
    }
    let head = runner.rev_parse_head(repo)?;
    if !head.starts_with(expected_base) {
        return Err(GitError::BaseDiverged {
            expected: expected_base.into(),
            found: head,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_builders_are_exact() {
        assert_eq!(GitArgs::rev_parse_head(), vec!["rev-parse", "HEAD"]);
        assert_eq!(GitArgs::status_porcelain(), vec!["status", "--porcelain"]);
        assert_eq!(
            GitArgs::diff_name_status("abc123"),
            vec![
                "-c",
                "core.quotePath=false",
                "diff",
                "--name-status",
                "abc123"
            ]
        );
        assert_eq!(
            GitArgs::ls_files_others(),
            vec![
                "-c",
                "core.quotePath=false",
                "ls-files",
                "--others",
                "--exclude-standard"
            ]
        );
    }

    #[test]
    fn worktree_add_validates_inputs() {
        let ok =
            GitArgs::worktree_add(Path::new("/tmp/wt/task-1"), "sandpane/task-1", "main").unwrap();
        assert_eq!(
            ok,
            vec![
                "worktree",
                "add",
                "/tmp/wt/task-1",
                "-b",
                "sandpane/task-1",
                "main"
            ]
        );
        assert!(GitArgs::worktree_add(Path::new("/tmp/wt"), "a..b", "main").is_err());
        assert!(GitArgs::worktree_add(Path::new("/tmp/wt"), "ok-branch", "$(evil)").is_err());
        assert!(GitArgs::worktree_add(Path::new("relative/wt"), "ok", "main").is_err());
    }

    // --- Real-git tests (disposable temp repos) -----------------------------

    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
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
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "sandpane@test.invalid"]);
        run(&["config", "user.name", "Sandpane Test"]);
        std::fs::write(dir.join("file.txt"), "base\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "base commit"]);
    }

    #[test]
    fn rev_parse_and_dirty_detection_on_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let runner = GitRunner::default();
        let head = runner.rev_parse_head(dir.path()).unwrap();
        assert_eq!(head.len(), 40);
        assert!(!runner.is_dirty(dir.path()).unwrap());

        std::fs::write(dir.path().join("file.txt"), "modified\n").unwrap();
        assert!(runner.is_dirty(dir.path()).unwrap());

        // Untracked-only changes count as dirty too (T15).
        let out = Command::new("git")
            .args(["checkout", "-q", "--", "."])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(!runner.is_dirty(dir.path()).unwrap());
        std::fs::write(dir.path().join("untracked.txt"), "x\n").unwrap();
        assert!(runner.is_dirty(dir.path()).unwrap());
    }

    #[test]
    fn change_list_includes_uncommitted_and_untracked() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let runner = GitRunner::default();
        let base = runner.rev_parse_head(dir.path()).unwrap();
        std::fs::write(dir.path().join("file.txt"), "changed\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "new\n").unwrap();
        // Nothing committed: the base-vs-working-tree diff must still surface
        // the modification, and ls-files the untracked file (T15).
        let changes = runner.change_list(dir.path(), &base).unwrap();
        assert!(changes.contains(&RawChange {
            path: "file.txt".into(),
            status: "modified".into()
        }));
        assert!(changes.contains(&RawChange {
            path: "new.txt".into(),
            status: "untracked".into()
        }));
    }

    #[test]
    fn change_list_reports_renames_at_new_path() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let runner = GitRunner::default();
        let base = runner.rev_parse_head(dir.path()).unwrap();
        std::fs::rename(dir.path().join("file.txt"), dir.path().join("renamed.txt")).unwrap();
        // Stage both sides so git's rename detection has full information.
        let out = Command::new("git")
            .args(["add", "-A"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(out.status.success());
        let changes = runner.change_list(dir.path(), &base).unwrap();
        assert!(
            changes.contains(&RawChange {
                path: "renamed.txt".into(),
                status: "renamed".into()
            }),
            "{changes:?}"
        );
    }

    #[test]
    fn change_list_keeps_non_ascii_paths_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let runner = GitRunner::default();
        let base = runner.rev_parse_head(dir.path()).unwrap();
        std::fs::write(dir.path().join("日本.txt"), "x\n").unwrap();
        let changes = runner.change_list(dir.path(), &base).unwrap();
        assert!(
            changes
                .iter()
                .any(|c| c.path == "日本.txt" && c.status == "untracked"),
            "{changes:?}"
        );
    }

    #[test]
    fn apply_preconditions_block_dirty_and_diverged() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let runner = GitRunner::default();
        let base = runner.rev_parse_head(dir.path()).unwrap();

        // Clean + matching base → OK.
        preconditions_for_apply(&runner, dir.path(), &base).unwrap();

        // Dirty host → blocked, changes untouched.
        std::fs::write(dir.path().join("dirty.txt"), "user work\n").unwrap();
        assert!(matches!(
            preconditions_for_apply(&runner, dir.path(), &base),
            Err(GitError::DirtyHostState(_))
        ));
        assert!(dir.path().join("dirty.txt").exists());

        // Base diverged → blocked.
        let _ = std::fs::remove_file(dir.path().join("dirty.txt"));
        let wrong = "0".repeat(40);
        assert!(matches!(
            preconditions_for_apply(&runner, dir.path(), &wrong),
            Err(GitError::BaseDiverged { .. })
        ));
    }
}
