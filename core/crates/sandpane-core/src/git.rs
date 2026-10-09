//! Git workspace safety (docs/specs/02 §7, docs/specs/06 §6).
//!
//! Arg-vector builders + a minimal real runner. Apply is always an explicit
//! Git operation with base/dirty checks — never a silent file overwrite.
//!
//! HARDENED INVOCATION (review 0015 bug 2 / security W2, W-1, W-2): the
//! repositories Core inspects can be written by a sandboxed agent
//! (`direct_mount` exposes the host `.git/` live), so repo-local config and
//! attributes are UNTRUSTED. Every invocation through [`GitRunner::run`]:
//! - strips every inherited `GIT_*` variable, then sets
//!   `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`,
//!   `GIT_NO_LAZY_FETCH=1` and `GIT_ALLOW_PROTOCOL=none` (env beats repo config:
//!   a partial-clone/promisor repo can no longer lazy-fetch through a
//!   repo-chosen `core.sshCommand`, `protocol.<x>.allow=always`, credential
//!   helper or askpass — no transport is reachable; a missing object fails
//!   the command instead);
//! - sets `GIT_ATTR_SOURCE=<empty tree>` so the WORKTREE `.gitattributes`
//!   files are not consulted, and `-c core.attributesFile=/dev/null`;
//! - overrides `core.fsmonitor`, `core.hooksPath` (post-checkout on
//!   `worktree add`), `diff.external`, `submodule.recurse=false`,
//!   `status.submoduleSummary=false`, `diff.submodule=short`, and blanks every
//!   `filter.<driver>.{clean,smudge,process}` visible in the repo config
//!   (`required=false`), enumerated with `git config --get-regexp`, which
//!   executes nothing;
//! - `status`/`diff` pass `--ignore-submodules=dirty`: a submodule's own
//!   config/attributes (invisible to the superproject's enumeration) are never
//!   loaded, while gitlink commit changes stay visible;
//! - `diff` passes `--no-ext-diff --no-textconv`; revisions end with
//!   `--end-of-options`, pathspecs with `--`;
//! - runs through [`crate::process::run_bounded`] (timeout, output caps).
//!
//! WHAT IS NOT CLOSED (recorded residual): `$GIT_DIR/info/attributes` is still
//! read (no git knob disables it; verified on git 2.56). A filter driver that
//! is referenced from there AND whose `filter.<name>.*` config is written by
//! the agent in the window between the enumeration call and the executing
//! call would run. Both writes require write access to `.git/`, i.e. a
//! `direct_mount` agent racing a review.
//!
//! Correctness trade-offs (fail-safe direction): filters are blanked and
//! worktree attributes ignored, so filter-managed (e.g. LFS) and
//! eol-normalized files are compared in raw/stored form — a review may list a
//! file as modified that attribute-aware git would not, never the reverse;
//! worktree checkout does not smudge.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::process::{run_bounded, RunLimits};
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

/// Config overrides applied to EVERY git invocation (before the subcommand).
pub const HARDENING_CONFIG: &[&str] = &[
    "core.fsmonitor=false",
    "core.hooksPath=/dev/null",
    "diff.external=",
    "core.quotePath=false",
    "core.attributesFile=/dev/null",
    "submodule.recurse=false",
    "status.submoduleSummary=false",
    "diff.submodule=short",
];

/// Environment set on every git invocation after all `GIT_*` are removed.
pub const HARDENING_ENV: &[(&str, &str)] = &[
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_NO_LAZY_FETCH", "1"),
    ("GIT_ALLOW_PROTOCOL", "none"),
];

/// The empty tree object id (virtual in every repository) per object format.
pub const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
pub const EMPTY_TREE_SHA256: &str =
    "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/// Fixed git executable (PATH-resolved by the OS; overridable for tests).
pub struct GitRunner {
    pub program: PathBuf,
    pub limits: RunLimits,
}

impl Default for GitRunner {
    fn default() -> Self {
        Self {
            program: PathBuf::from("git"),
            limits: RunLimits::QUERY,
        }
    }
}

impl GitRunner {
    /// Build the hardened command (pure; no I/O). `ambient_env_keys` is the
    /// set of variable names in Core's own environment — every `GIT_*` one is
    /// explicitly removed. `extra_config` carries per-repo overrides such as
    /// blanked filter drivers.
    pub fn hardened_command<I>(
        &self,
        cwd: &Path,
        extra_config: &[String],
        attr_source: Option<&str>,
        args: &[String],
        ambient_env_keys: I,
    ) -> Command
    where
        I: IntoIterator<Item = OsString>,
    {
        let mut cmd = Command::new(&self.program);
        for key in ambient_env_keys {
            if key.to_string_lossy().starts_with("GIT_") {
                cmd.env_remove(key);
            }
        }
        for (k, v) in HARDENING_ENV {
            cmd.env(k, v);
        }
        if let Some(tree) = attr_source {
            cmd.env("GIT_ATTR_SOURCE", tree);
        }
        for c in HARDENING_CONFIG
            .iter()
            .map(|c| c.to_string())
            .chain(extra_config.iter().cloned())
        {
            cmd.arg("-c").arg(c);
        }
        cmd.args(args).current_dir(cwd);
        cmd
    }

    /// Run a builder-produced vector in `cwd` under the full hardening. No
    /// shell is involved. The metacharacter tripwire applies to every
    /// NON-path argument; absolute path arguments were validated by their
    /// builder (absolute, UTF-8, no control characters) and may legitimately
    /// contain spaces or shell-looking characters (review S-b).
    pub fn run(&self, cwd: &Path, args: &[String]) -> Result<String, GitError> {
        let non_paths: Vec<String> = args
            .iter()
            .filter(|a| !Path::new(a.as_str()).is_absolute())
            .cloned()
            .collect();
        Validator::assert_no_shell_metachars(&non_paths).map_err(GitError::Validation)?;
        let repo = self.repo_overrides(cwd)?;
        self.exec(cwd, &repo.config, Some(repo.empty_tree), args)
    }

    fn exec(
        &self,
        cwd: &Path,
        extra: &[String],
        attr_source: Option<&str>,
        args: &[String],
    ) -> Result<String, GitError> {
        let cmd = self.hardened_command(
            cwd,
            extra,
            attr_source,
            args,
            std::env::vars_os().map(|(k, _)| k),
        );
        let out = run_bounded(cmd, &self.limits).map_err(|e| GitError::Exec(e.to_string()))?;
        let sub = args.first().map(String::as_str).unwrap_or("?");
        if !out.status.success() {
            return Err(GitError::Exec(format!(
                "git {sub} exited {}: {}",
                out.status,
                out.stderr_lossy().trim()
            )));
        }
        if out.stdout_truncated {
            // Never act on a partial change list / partial status.
            return Err(GitError::Exec(format!(
                "git {sub} output exceeded {} bytes; refusing truncated output",
                self.limits.max_stdout
            )));
        }
        Ok(out.stdout_lossy())
    }

    /// One read-only `git config --get-regexp` call: the filter drivers to
    /// blank (`-c filter.<driver>.{clean,smudge,process}=`,
    /// `required=false`) and the object format (for the empty-tree attribute
    /// source). Unsafe driver names / unknown formats fail CLOSED.
    fn repo_overrides(&self, cwd: &Path) -> Result<RepoOverrides, GitError> {
        let query: Vec<String> = vec![
            "config".into(),
            "--null".into(),
            "--get-regexp".into(),
            "^(filter\\.|extensions\\.objectformat$)".into(),
        ];
        let cmd =
            self.hardened_command(cwd, &[], None, &query, std::env::vars_os().map(|(k, _)| k));
        let out = run_bounded(cmd, &self.limits).map_err(|e| GitError::Exec(e.to_string()))?;
        // `git config --get-regexp` exits 1 when nothing matches.
        match out.status.code() {
            Some(0) => {}
            Some(1) if out.stdout.is_empty() => return repo_overrides_from_config(""),
            _ => {
                return Err(GitError::Exec(format!(
                    "git config (filter enumeration) exited {}: {}",
                    out.status,
                    out.stderr_lossy().trim()
                )))
            }
        }
        if out.stdout_truncated {
            return Err(GitError::Exec("filter enumeration output truncated".into()));
        }
        repo_overrides_from_config(&out.stdout_lossy())
    }

    pub fn rev_parse_head(&self, repo: &Path) -> Result<String, GitError> {
        let out = self.run(repo, &GitArgs::rev_parse_head())?;
        Ok(out.trim().to_string())
    }

    /// Absolute path of the working tree's top level containing `dir`.
    pub fn show_toplevel(&self, dir: &Path) -> Result<PathBuf, GitError> {
        let out = self.run(dir, &GitArgs::show_toplevel())?;
        let line = out.trim_end_matches(['\n', '\r']);
        if line.is_empty() || line.contains('\n') {
            return Err(GitError::Exec(format!(
                "unexpected rev-parse output {out:?}"
            )));
        }
        Ok(PathBuf::from(line))
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

/// Per-repository hardening derived from its config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoOverrides {
    pub config: Vec<String>,
    pub empty_tree: &'static str,
}

/// Parse `git config --null --get-regexp` output (`key\nvalue\0` entries, or
/// `key\0` for valueless keys).
pub fn repo_overrides_from_config(out: &str) -> Result<RepoOverrides, GitError> {
    let mut names = String::new();
    let mut empty_tree = EMPTY_TREE_SHA1;
    for entry in out.split('\0').filter(|e| !e.is_empty()) {
        let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
        if key.eq_ignore_ascii_case("extensions.objectformat") {
            empty_tree = match value.trim().to_ascii_lowercase().as_str() {
                "sha1" => EMPTY_TREE_SHA1,
                "sha256" => EMPTY_TREE_SHA256,
                other => {
                    return Err(GitError::Exec(format!(
                        "refusing to run git: unknown object format {other:?}"
                    )))
                }
            };
        } else {
            names.push_str(key);
            names.push('\0');
        }
    }
    Ok(RepoOverrides {
        config: filter_overrides_from_names(&names)?,
        empty_tree,
    })
}

/// Turn NUL-separated `filter.<driver>.<key>` names into blanking overrides.
/// Pure so the fail-closed allowlist is unit-testable.
pub fn filter_overrides_from_names(nul_separated: &str) -> Result<Vec<String>, GitError> {
    let mut drivers: Vec<&str> = Vec::new();
    for key in nul_separated.split('\0').filter(|k| !k.is_empty()) {
        let Some(rest) = key.strip_prefix("filter.") else {
            continue;
        };
        let Some((driver, _subkey)) = rest.rsplit_once('.') else {
            continue;
        };
        if driver.is_empty()
            || !driver
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err(GitError::Exec(format!(
                "refusing to run git: filter driver name {driver:?} cannot be safely neutralized"
            )));
        }
        if !drivers.contains(&driver) {
            drivers.push(driver);
        }
    }
    let mut out = Vec::new();
    for d in drivers {
        for k in ["clean", "smudge", "process"] {
            out.push(format!("filter.{d}.{k}="));
        }
        out.push(format!("filter.{d}.required=false"));
    }
    Ok(out)
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
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--end-of-options".into(),
            "HEAD".into(),
        ]
    }

    pub fn show_toplevel() -> Vec<String> {
        vec!["rev-parse".into(), "--show-toplevel".into()]
    }

    /// `--ignore-submodules=dirty`: never enter a submodule's work tree
    /// (its config/attributes are invisible to Core's hardening, W-2);
    /// gitlink commit changes are still reported.
    pub fn status_porcelain() -> Vec<String> {
        vec![
            "status".into(),
            "--porcelain".into(),
            "--ignore-submodules=dirty".into(),
        ]
    }

    /// `git diff --no-ext-diff --no-textconv --name-status --end-of-options
    /// <base> --` — base vs working tree (committed, staged, and unstaged
    /// modifications all appear). `core.quotePath=false` (in
    /// [`HARDENING_CONFIG`]) keeps non-ASCII paths verbatim instead of
    /// C-escaped, so review paths match real filenames (finding #10). The
    /// trailing `--` makes `<base>` unambiguously a revision, never a path.
    pub fn diff_name_status(base: &str) -> Vec<String> {
        vec![
            "diff".into(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "--ignore-submodules=dirty".into(),
            "--name-status".into(),
            "--end-of-options".into(),
            base.into(),
            "--".into(),
        ]
    }

    pub fn ls_files_others() -> Vec<String> {
        vec![
            "ls-files".into(),
            "--others".into(),
            "--exclude-standard".into(),
            "--".into(),
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
        let Some(path_str) = path.to_str() else {
            return Err(GitError::Validation(ValidationError::InvalidShape {
                reason: "worktree path must be valid UTF-8".into(),
            }));
        };
        if let Some(c) = path_str.chars().find(|c| c.is_control()) {
            return Err(GitError::Validation(ValidationError::DisallowedChar {
                found: c,
            }));
        }
        Ok(vec![
            "worktree".into(),
            "add".into(),
            "-b".into(),
            branch.into(),
            "--".into(),
            path_str.into(),
            base_commit.into(),
        ])
    }
}

/// Pre-integration safety gate (specs/06 §6 "Before integrating changes"):
/// verify the host tree is clean and HEAD still matches the recorded base.
/// `expected_base` must be the FULL object id Core recorded (40 or 64 hex);
/// the comparison is exact — never a prefix match (security W3).
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
    Validator::full_object_id(expected_base)?;
    if runner.is_dirty(repo)? {
        return Err(GitError::DirtyHostState(
            "uncommitted host changes present".into(),
        ));
    }
    let head = runner.rev_parse_head(repo)?;
    if !head.eq_ignore_ascii_case(expected_base) {
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
        assert_eq!(
            GitArgs::rev_parse_head(),
            vec!["rev-parse", "--verify", "--end-of-options", "HEAD"]
        );
        assert_eq!(
            GitArgs::status_porcelain(),
            vec!["status", "--porcelain", "--ignore-submodules=dirty"]
        );
        assert_eq!(
            GitArgs::diff_name_status("abc1234"),
            vec![
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=dirty",
                "--name-status",
                "--end-of-options",
                "abc1234",
                "--"
            ]
        );
        assert_eq!(
            GitArgs::ls_files_others(),
            vec!["ls-files", "--others", "--exclude-standard", "--"]
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
                "-b",
                "sandpane/task-1",
                "--",
                "/tmp/wt/task-1",
                "main"
            ]
        );
        assert!(GitArgs::worktree_add(Path::new("/tmp/wt"), "a..b", "main").is_err());
        assert!(GitArgs::worktree_add(Path::new("/tmp/wt"), "ok-branch", "$(evil)").is_err());
        assert!(GitArgs::worktree_add(Path::new("relative/wt"), "ok", "main").is_err());
    }

    #[test]
    fn hardened_command_strips_git_env_and_sets_overrides() {
        let runner = GitRunner::default();
        let ambient = vec![
            OsString::from("GIT_DIR"),
            OsString::from("GIT_WORK_TREE"),
            OsString::from("GIT_CONFIG_GLOBAL"),
            OsString::from("HOME"),
        ];
        let cmd = runner.hardened_command(
            Path::new("/repo"),
            &["filter.lfs.clean=".to_string()],
            Some(EMPTY_TREE_SHA1),
            &GitArgs::status_porcelain(),
            ambient,
        );
        let envs: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        for removed in ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_GLOBAL"] {
            assert!(
                envs.contains(&(removed.to_string(), None)),
                "{removed} must be removed: {envs:?}"
            );
        }
        assert!(
            !envs.iter().any(|(k, _)| k == "HOME"),
            "non-GIT vars untouched"
        );
        for (k, v) in HARDENING_ENV {
            assert!(envs.contains(&(k.to_string(), Some(v.to_string()))), "{k}");
        }
        assert!(envs.contains(&(
            "GIT_ATTR_SOURCE".to_string(),
            Some(EMPTY_TREE_SHA1.to_string())
        )));
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let mut expected: Vec<String> = Vec::new();
        for c in HARDENING_CONFIG {
            expected.push("-c".into());
            expected.push(c.to_string());
        }
        expected.extend(
            [
                "-c",
                "filter.lfs.clean=",
                "status",
                "--porcelain",
                "--ignore-submodules=dirty",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        assert_eq!(args, expected);
        for must in [
            "core.fsmonitor=false",
            "core.hooksPath=/dev/null",
            "diff.external=",
            "core.attributesFile=/dev/null",
            "submodule.recurse=false",
        ] {
            assert!(HARDENING_CONFIG.contains(&must), "{must}");
        }
        for must in [("GIT_NO_LAZY_FETCH", "1"), ("GIT_ALLOW_PROTOCOL", "none")] {
            assert!(HARDENING_ENV.contains(&must), "{must:?}");
        }
    }

    #[test]
    fn repo_overrides_parse_object_format_and_filters() {
        let o = repo_overrides_from_config("").unwrap();
        assert_eq!(o.empty_tree, EMPTY_TREE_SHA1);
        assert!(o.config.is_empty());
        let o = repo_overrides_from_config(
            "filter.lfs.clean\ngit-lfs clean -- %f\0extensions.objectformat\nsha256\0filter.x.required\0",
        )
        .unwrap();
        assert_eq!(o.empty_tree, EMPTY_TREE_SHA256);
        assert!(o.config.contains(&"filter.lfs.clean=".to_string()));
        assert!(o.config.contains(&"filter.x.process=".to_string()));
        assert!(repo_overrides_from_config("extensions.objectformat\nmd5\0").is_err());
    }

    #[test]
    fn filter_driver_names_are_neutralized_or_refused() {
        let o = filter_overrides_from_names(
            "filter.lfs.clean\0filter.lfs.smudge\0filter.evil.x.clean\0",
        )
        .unwrap();
        assert_eq!(
            o,
            vec![
                "filter.lfs.clean=",
                "filter.lfs.smudge=",
                "filter.lfs.process=",
                "filter.lfs.required=false",
                "filter.evil.x.clean=",
                "filter.evil.x.smudge=",
                "filter.evil.x.process=",
                "filter.evil.x.required=false",
            ]
        );
        assert!(filter_overrides_from_names("").unwrap().is_empty());
        // A driver name that would break `-c key=value` parsing fails closed.
        for bad in [
            "filter.a=b.clean\0",
            "filter.a b.clean\0",
            "filter.a\nb.clean\0",
        ] {
            assert!(filter_overrides_from_names(bad).is_err(), "{bad:?}");
        }
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

    /// Writes a FIXED-content executable (no interpolated values) that
    /// touches `<its own path>-fired` via `$0`, then runs `tail`.
    fn marker_script(dir: &Path, name: &str, body: &'static str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join(name);
        std::fs::write(&script, body).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    fn fired(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with("-fired"))
            .collect();
        v.sort();
        v
    }

    fn git_plain(dir: &Path, args: &[&str]) {
        let _ = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
    }

    /// Security W2 / bug 2: a repository whose (agent-writable) config points
    /// core.fsmonitor, a clean filter and diff.external at programs. Plain git
    /// runs them (proving the trap is real); the hardened runner never does.
    #[test]
    fn hardened_runner_never_executes_repo_configured_programs() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let traps = dir.path().join("traps");
        std::fs::create_dir(&traps).unwrap();
        init_repo(&repo);
        let base = GitRunner::default().rev_parse_head(&repo).unwrap();
        let fsmon = marker_script(
            &traps,
            "fsmonitor",
            "#!/bin/sh\ntouch \"$0-fired\"\nexit 1\n",
        );
        let clean = marker_script(&traps, "clean", "#!/bin/sh\ntouch \"$0-fired\"\ncat\n");
        let ext = marker_script(&traps, "extdiff", "#!/bin/sh\ntouch \"$0-fired\"\nexit 0\n");
        let textconv = marker_script(
            &traps,
            "textconv",
            "#!/bin/sh\ntouch \"$0-fired\"\ncat \"$1\"\n",
        );
        let set = |k: &str, v: &Path| {
            git_plain(&repo, &["config", k, &v.display().to_string()]);
        };
        set("core.fsmonitor", &fsmon);
        set("filter.evil.clean", &clean);
        set("diff.external", &ext);
        set("diff.evil.textconv", &textconv);
        std::fs::write(repo.join(".gitattributes"), "*.txt filter=evil diff=evil\n").unwrap();
        std::fs::write(repo.join("file.txt"), "changed\n").unwrap();

        // Control: EVERY vector is live under plain git (review S-a).
        git_plain(&repo, &["status", "--porcelain"]);
        git_plain(&repo, &["diff", "HEAD"]);
        git_plain(&repo, &["diff", "--no-ext-diff", "HEAD"]);
        let live = fired(&traps);
        for trap in [
            "fsmonitor-fired",
            "extdiff-fired",
            "clean-fired",
            "textconv-fired",
        ] {
            assert!(
                live.contains(&trap.to_string()),
                "{trap} not live: {live:?}"
            );
        }
        for f in live {
            std::fs::remove_file(traps.join(f)).unwrap();
        }

        let runner = GitRunner::default();
        assert!(runner.is_dirty(&repo).unwrap());
        let changes = runner.change_list(&repo, &base).unwrap();
        assert!(changes.iter().any(|c| c.path == "file.txt"), "{changes:?}");
        assert_eq!(runner.rev_parse_head(&repo).unwrap(), base);
        let _ = runner.show_toplevel(&repo).unwrap();
        // A CONTENT-reading diff (patch) through the runner: the clean filter
        // would run here if filters/attributes were not neutralized.
        let patch: Vec<String> = ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"]
            .iter()
            .map(|a| a.to_string())
            .collect();
        let _ = runner.run(&repo, &patch).unwrap();
        assert_eq!(
            fired(&traps),
            Vec::<String>::new(),
            "hardened git executed a repo-configured program"
        );
    }

    /// Security W-1 (review PoC poc1): a partial-clone repository whose
    /// promisor remote uses ssh with `core.sshCommand` pointing at a trap, and
    /// a missing object, makes plain git lazy-fetch — executing the trap.
    /// `protocol.ssh.allow=always` in the repo defeats `-c protocol.allow=never`,
    /// which is why the fix is `GIT_NO_LAZY_FETCH` + `GIT_ALLOW_PROTOCOL`.
    #[test]
    fn hardened_runner_never_lazy_fetches_through_repo_ssh_command() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let traps = dir.path().join("traps");
        std::fs::create_dir(&traps).unwrap();
        init_repo(&repo);
        let base = GitRunner::default().rev_parse_head(&repo).unwrap();
        let tree = String::from_utf8(
            Command::new("git")
                .args(["rev-parse", "HEAD^{tree}"])
                .current_dir(&repo)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();
        let ssh = marker_script(&traps, "ssh", "#!/bin/sh\ntouch \"$0-fired\"\nexit 1\n");
        for (k, v) in [
            ("core.repositoryformatversion", "1"),
            ("extensions.partialClone", "origin"),
            ("remote.origin.url", "ssh://example.invalid/x"),
            ("remote.origin.promisor", "true"),
            ("protocol.ssh.allow", "always"),
        ] {
            git_plain(&repo, &["config", k, v]);
        }
        git_plain(
            &repo,
            &["config", "core.sshCommand", &ssh.display().to_string()],
        );
        std::fs::remove_file(repo.join(".git/objects").join(&tree[..2]).join(&tree[2..])).unwrap();

        // Control: plain git lazy-fetches over ssh and runs the trap.
        git_plain(&repo, &["status", "--porcelain"]);
        git_plain(&repo, &["diff", "--name-status", &base, "--"]);
        assert!(
            fired(&traps).contains(&"ssh-fired".to_string()),
            "control: lazy fetch did not fire {:?}",
            fired(&traps)
        );
        std::fs::remove_file(traps.join("ssh-fired")).unwrap();

        // Hardened: fails closed (missing object), never fetches.
        let runner = GitRunner::default();
        let _ = runner.is_dirty(&repo);
        let _ = runner.change_list(&repo, &base);
        let _ = runner.rev_parse_head(&repo);
        assert_eq!(
            fired(&traps),
            Vec::<String>::new(),
            "lazy fetch ran the trap"
        );
    }

    /// Security W-2 (review PoC poc2): a SUBMODULE's own config + attributes
    /// define a clean filter the superproject's filter enumeration cannot see;
    /// plain status/diff recurse into the dirty submodule and run it.
    #[test]
    fn hardened_runner_never_runs_submodule_filters() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub");
        let top = dir.path().join("top");
        let traps = dir.path().join("traps");
        for d in [&sub, &top, &traps] {
            std::fs::create_dir(d).unwrap();
        }
        init_repo(&sub);
        init_repo(&top);
        git_plain(
            &top,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                &sub.display().to_string(),
                "sub",
            ],
        );
        git_plain(&top, &["commit", "-qm", "add submodule"]);
        let base = GitRunner::default().rev_parse_head(&top).unwrap();
        let clean = marker_script(&traps, "clean", "#!/bin/sh\ntouch \"$0-fired\"\ncat\n");
        let checkout = top.join("sub");
        git_plain(
            &checkout,
            &["config", "filter.evil.clean", &clean.display().to_string()],
        );
        std::fs::write(checkout.join(".gitattributes"), "*.txt filter=evil\n").unwrap();
        // SAME-SIZE edit (as in the PoC): stat alone cannot tell it changed,
        // so git hashes the file — through the clean filter.
        std::fs::write(checkout.join("file.txt"), "BASE\n").unwrap();

        // Control: plain git recurses into the submodule and runs the filter.
        git_plain(&top, &["status", "--porcelain"]);
        git_plain(&top, &["diff", "--name-status", &base, "--"]);
        assert!(
            fired(&traps).contains(&"clean-fired".to_string()),
            "control: submodule filter did not fire {:?}",
            fired(&traps)
        );
        std::fs::remove_file(traps.join("clean-fired")).unwrap();

        let runner = GitRunner::default();
        let _ = runner.is_dirty(&top).unwrap();
        let _ = runner.change_list(&top, &base).unwrap();
        assert_eq!(fired(&traps), Vec::<String>::new(), "submodule filter ran");
    }

    /// GIT_ATTR_SOURCE=<empty tree> neutralizes WORKTREE `.gitattributes`
    /// even when filter blanking missed a driver (the enumerate-then-execute
    /// race: a driver configured after enumeration).
    #[test]
    fn attribute_source_neutralizes_worktree_attributes_without_blanking() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let traps = dir.path().join("traps");
        std::fs::create_dir(&traps).unwrap();
        init_repo(&repo);
        let clean = marker_script(&traps, "clean", "#!/bin/sh\ntouch \"$0-fired\"\ncat\n");
        git_plain(
            &repo,
            &["config", "filter.late.clean", &clean.display().to_string()],
        );
        std::fs::write(repo.join(".gitattributes"), "*.txt filter=late\n").unwrap();
        std::fs::write(repo.join("file.txt"), "changed\n").unwrap();
        let runner = GitRunner::default();
        let patch: Vec<String> = ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"]
            .iter()
            .map(|a| a.to_string())
            .collect();
        // Simulate the race: NO filter blanking, only the global hardening.
        let cmd = runner.hardened_command(
            &repo,
            &[],
            Some(EMPTY_TREE_SHA1),
            &patch,
            std::env::vars_os().map(|(k, _)| k),
        );
        let out = run_bounded(cmd, &RunLimits::QUERY).unwrap();
        assert!(out.status.success(), "{}", out.stderr_lossy());
        assert_eq!(fired(&traps), Vec::<String>::new());
        // Control: the same command WITHOUT the attribute source fires.
        let cmd = runner.hardened_command(
            &repo,
            &[],
            None,
            &patch,
            std::env::vars_os().map(|(k, _)| k),
        );
        let _ = run_bounded(cmd, &RunLimits::QUERY).unwrap();
        assert_eq!(fired(&traps), vec!["clean-fired".to_string()]);
    }

    /// Review S-b: Core-validated absolute PATH arguments may legitimately
    /// contain spaces and shell-looking characters (the repo itself lives
    /// under "DKV Labs"); the tripwire applies to non-path arguments only.
    #[test]
    fn worktree_paths_with_spaces_and_metachar_lookalikes_are_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("DKV Labs repo");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        let base = GitRunner::default().rev_parse_head(&repo).unwrap();
        let wt = dir.path().join("R&&D $(v2) a=b ~x").join("wt 1");
        let args = GitArgs::worktree_add(&wt, "sandpane/t-2", &base).unwrap();
        GitRunner::default().run(&repo, &args).unwrap();
        assert!(wt.join("file.txt").exists());
        // Non-path arguments still hit the tripwire.
        assert!(GitRunner::default()
            .run(&repo, &["log".to_string(), "$(id)".to_string()])
            .is_err());
        // Control characters in a path are refused by the builder.
        assert!(GitArgs::worktree_add(Path::new("/tmp/a\nb"), "ok", &base).is_err());
    }

    /// `worktree add` runs post-checkout hooks under plain git; hooksPath is
    /// pinned to /dev/null by the hardened runner.
    #[test]
    fn hardened_worktree_add_skips_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        let traps = dir.path().join("traps");
        std::fs::create_dir(&traps).unwrap();
        let hooks = repo.join(".git/hooks");
        marker_script(
            &hooks,
            "post-checkout",
            "#!/bin/sh\ntouch \"$0-fired\"\nexit 0\n",
        );
        let base = GitRunner::default().rev_parse_head(&repo).unwrap();
        // Control: plain git runs the hook.
        let control = dir.path().join("wt-control");
        git_plain(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "control",
                &control.display().to_string(),
                &base,
            ],
        );
        assert_eq!(fired(&hooks), vec!["post-checkout-fired".to_string()]);
        std::fs::remove_file(hooks.join("post-checkout-fired")).unwrap();
        let wt = dir.path().join("wt");
        let args = GitArgs::worktree_add(&wt, "sandpane/t-1", &base).unwrap();
        GitRunner::default().run(&repo, &args).unwrap();
        assert!(wt.join("file.txt").exists());
        assert_eq!(fired(&hooks), Vec::<String>::new());
        let _ = traps;
    }

    #[test]
    fn show_toplevel_reports_repo_root_from_subdir() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let top = GitRunner::default()
            .show_toplevel(&dir.path().join("sub"))
            .unwrap();
        assert_eq!(
            std::fs::canonicalize(top).unwrap(),
            std::fs::canonicalize(dir.path()).unwrap()
        );
        let not_repo = tempfile::tempdir().unwrap();
        assert!(GitRunner::default().show_toplevel(not_repo.path()).is_err());
    }

    #[test]
    fn apply_precondition_requires_exact_full_oid() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let runner = GitRunner::default();
        let base = runner.rev_parse_head(dir.path()).unwrap();
        // Abbreviations (including a 1-char "prefix") are no longer accepted
        // as a base assertion (security W3).
        for short in [&base[..1], &base[..7], &base[..39]] {
            assert!(
                matches!(
                    preconditions_for_apply(&runner, dir.path(), short),
                    Err(GitError::Validation(_))
                ),
                "{short}"
            );
        }
        preconditions_for_apply(&runner, dir.path(), &base).unwrap();
    }
}
