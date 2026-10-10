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
//!   loaded, while gitlink commit changes stay visible. Because that also hides
//!   uncommitted work INSIDE a submodule, the dirty gate
//!   ([`GitRunner::is_dirty`], hence [`preconditions_for_apply`]) and the
//!   review change list ([`GitRunner::change_list`]) first scan the INDEX for
//!   gitlinks (`ls-files --stage -z -- :(top)`, mode 160000, index only — never
//!   a submodule work tree) and REFUSE with [`GitError::SubmodulesPresent`]
//!   naming the paths when any exist (fail closed, never a false "clean");
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
//!
//! Submodule trade-off (review of bb5cc8f): Sandpane cannot verify submodule
//! work trees safely, so ANY repository whose index holds a gitlink — dirty or
//! clean, including a task worktree created from such a repo — is refused by
//! the dirty gate, every apply precondition, and `git.review` (the protocol's
//! `ChangeSet` has no "incomplete" marker; adding one is the follow-up that
//! would let review return a flagged partial list instead of refusing). This
//! is fail-closed: submodule users lose review/apply, never get a false clean.
//! What the gitlink scan does NOT catch: an untracked nested repository (no
//! gitlink) is still listed by status/`ls-files --others` as an untracked
//! directory (dirty gate trips; review shows `dir/`, not its contents). The
//! scan lists every tracked file, so it runs with a raised stdout cap
//! ([`SUBMODULE_SCAN_MAX_STDOUT`], ≈700k files); a larger index fails closed
//! (truncated output is refused) and blocks review/apply for that repo.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

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
    /// The index contains gitlinks (submodules). The hardened status/diff
    /// never enter a submodule work tree (`--ignore-submodules=dirty`), so
    /// uncommitted work inside one is invisible: Core refuses rather than
    /// report "clean" or a partial change list (review of bb5cc8f).
    #[error("{}", submodule_refusal(.0))]
    SubmodulesPresent(Vec<String>),
}

/// At most this many submodule paths are named in a refusal message (keeps a
/// pathological repo from producing an oversized error frame).
pub const SUBMODULE_PATHS_IN_MESSAGE: usize = 20;

/// stdout cap for the index-wide gitlink scan. `ls-files --stage` lists EVERY
/// tracked file (~90 bytes each), so the 4 MiB `QUERY` cap would refuse clean
/// repositories above ~45k files; 64 MiB covers roughly 700k. Larger indexes
/// fail closed (the scan refuses truncated output).
pub const SUBMODULE_SCAN_MAX_STDOUT: usize = 64 * 1024 * 1024;

fn submodule_refusal(paths: &[String]) -> String {
    let shown: Vec<String> = paths
        .iter()
        .take(SUBMODULE_PATHS_IN_MESSAGE)
        .map(|p| format!("{p:?}"))
        .collect();
    let more = paths.len().saturating_sub(SUBMODULE_PATHS_IN_MESSAGE);
    let extra = if more > 0 {
        format!(" (and {more} more)")
    } else {
        String::new()
    };
    format!(
        "repository contains submodule(s) {}{extra}; Sandpane cannot verify submodule work \
         trees safely (it never enters them), so it refuses rather than risk overwriting \
         uncommitted work or reporting an incomplete change list",
        shown.join(", ")
    )
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
    // Review C2: repo config `status.showUntrackedFiles=no` hid untracked
    // work from the dirty gate AND from git's own cleanliness check inside
    // `worktree remove` (`-c` propagates to git's internal status via
    // GIT_CONFIG_PARAMETERS).
    "status.showUntrackedFiles=normal",
    // Review S2: never trust stat-only "unchanged" shortcuts.
    "core.ignoreStat=false",
];
// `core.excludesFile` is NOT a fixed entry: every command gets
// `-c core.excludesFile=<GitRunner::excludes_file>` (see
// [`GitRunner::hardened_command`]) so a repo-chosen excludes file can never
// reclassify work as ignored (review W2), while the USER's own global
// excludes — resolved outside repo config by [`user_excludes_candidate`] and
// vetted by [`accept_excludes_file`] — still apply.

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
    /// The excludes file passed as `-c core.excludesFile=…` on EVERY call:
    /// `/dev/null` by default, or the user's own global excludes file once
    /// the service resolved and accepted it at startup. Private, like
    /// [`Self::excludes_revoked`], so no caller can read it past a revocation
    /// or undo one: use [`Self::with_excludes_file`],
    /// [`Self::active_excludes_file`] and [`Self::revoke_excludes`].
    excludes_file: PathBuf,
    /// Set once the service found [`Self::excludes_file`] no longer
    /// acceptable (a repository registered later contains it). One-way: from
    /// then on every call uses `/dev/null` until Core restarts and re-vets.
    excludes_revoked: AtomicBool,
}

impl Default for GitRunner {
    fn default() -> Self {
        Self {
            program: PathBuf::from("git"),
            limits: RunLimits::QUERY,
            excludes_file: PathBuf::from("/dev/null"),
            excludes_revoked: AtomicBool::new(false),
        }
    }
}

/// Environment for resolving the user's global excludes file.
#[derive(Debug, Clone, Default)]
pub struct ExcludesEnv {
    pub home: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
}

/// The user's global excludes file as GIT resolves it, without consulting any
/// repository: `git config --global --get --path core.excludesFile` (global
/// scope = `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config` only, system
/// config off) run from the neutral cwd `/` under the usual hardening, with
/// `HOME`/`XDG_CONFIG_HOME` taken from `env`. Unset → git's documented
/// default, `$XDG_CONFIG_HOME/git/ignore` or `~/.config/git/ignore`. `None`
/// when there is no home directory. The result is only a CANDIDATE: it must
/// pass [`accept_excludes_file`]. Run once (at startup), never per call.
pub fn user_excludes_candidate(
    runner: &GitRunner,
    env: &ExcludesEnv,
) -> Result<Option<PathBuf>, GitError> {
    let non_empty = |p: &Option<PathBuf>| p.clone().filter(|p| !p.as_os_str().is_empty());
    let Some(home) = non_empty(&env.home) else {
        return Ok(None);
    };
    let xdg = non_empty(&env.xdg_config_home);
    let args: Vec<String> = ["config", "--global", "--get", "--path", "core.excludesFile"]
        .iter()
        .map(|a| a.to_string())
        .collect();
    let mut cmd = runner.hardened_command(
        Path::new("/"),
        &[],
        None,
        &args,
        std::env::vars_os().map(|(k, _)| k),
    );
    cmd.env("HOME", &home);
    match &xdg {
        Some(x) => cmd.env("XDG_CONFIG_HOME", x),
        None => cmd.env_remove("XDG_CONFIG_HOME"),
    };
    let out = run_bounded(cmd, &runner.limits).map_err(|e| GitError::Exec(e.to_string()))?;
    match out.status.code() {
        Some(0) if !out.stdout_truncated => {
            let value = out.stdout_lossy();
            let value = value.trim_end_matches(['\n', '\r']);
            if !value.is_empty() {
                return Ok(Some(PathBuf::from(value)));
            }
        }
        Some(1) => {}
        _ => {
            return Err(GitError::Exec(format!(
                "git config --global (excludes) exited {}: {}",
                out.status,
                out.stderr_lossy().trim()
            )))
        }
    }
    Ok(Some(match xdg {
        Some(x) => x.join("git").join("ignore"),
        None => home.join(".config").join("git").join("ignore"),
    }))
}

/// Vet an excludes-file candidate. Accepted only as the CANONICAL path of an
/// existing regular file (a dotfiles symlink is followed, then judged by its
/// target), absolute, UTF-8 without control characters, owned by `uid`, not
/// writable by group or others — and neither is its directory — and not inside
/// any of `forbidden_roots` (registered repositories, Core's worktree root):
/// an agent- or other-user-writable file must never decide what is ignored.
/// Callers fall back to `/dev/null` on `Err` (fail safe: more files show as
/// untracked, never fewer). The service re-runs this whenever a repository is
/// registered, because a later repository may contain the file.
pub fn accept_excludes_file(
    candidate: &Path,
    forbidden_roots: &[PathBuf],
    uid: u32,
) -> Result<PathBuf, String> {
    if !candidate.is_absolute() {
        return Err(format!("{} is not an absolute path", candidate.display()));
    }
    let canonical = std::fs::canonicalize(candidate)
        .map_err(|e| format!("{} is not usable: {e}", candidate.display()))?;
    let Some(text) = canonical.to_str() else {
        return Err(format!("{} is not valid UTF-8", canonical.display()));
    };
    if text.chars().any(|c| c.is_control()) {
        return Err(format!("{text:?} contains control characters"));
    }
    let meta =
        std::fs::symlink_metadata(&canonical).map_err(|e| format!("{text} is not usable: {e}"))?;
    if !meta.file_type().is_file() {
        return Err(format!("{text} is not a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != uid {
            return Err(format!("{text} is owned by uid {}, not {uid}", meta.uid()));
        }
        if meta.mode() & 0o022 != 0 {
            return Err(format!(
                "{text} is writable by group or others (mode {:o})",
                meta.mode() & 0o777
            ));
        }
        // Whoever can write the directory can replace the file.
        if let Some(parent) = canonical.parent() {
            let pmeta = std::fs::metadata(parent)
                .map_err(|e| format!("{} is not usable: {e}", parent.display()))?;
            if pmeta.mode() & 0o022 != 0 {
                return Err(format!(
                    "{text} lies in {}, which is writable by group or others (mode {:o})",
                    parent.display(),
                    pmeta.mode() & 0o777
                ));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = uid;
    for root in forbidden_roots {
        let root_c = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        if canonical.starts_with(&root_c) {
            return Err(format!(
                "{text} lies inside {} (a repository or Sandpane's worktree root), which an \
                 agent may write",
                root_c.display()
            ));
        }
    }
    Ok(canonical)
}

impl GitRunner {
    /// The default runner, passing `excludes_file` (already vetted by
    /// [`accept_excludes_file`]) on every call.
    pub fn with_excludes_file(excludes_file: PathBuf) -> Self {
        Self {
            excludes_file,
            ..Self::default()
        }
    }

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
            .chain(std::iter::once(format!(
                "core.excludesFile={}",
                self.effective_excludes(cwd)
            )))
            .chain(extra_config.iter().cloned())
        {
            cmd.arg("-c").arg(c);
        }
        cmd.args(args).current_dir(cwd);
        cmd
    }

    /// The excludes file for a call in `cwd`: the configured one unless it is
    /// not an absolute control-free UTF-8 path or lies INSIDE `cwd` (a
    /// repository registered after startup) — then `/dev/null`. Lexical and
    /// pure: Core passes canonical repository/worktree roots as `cwd`, and the
    /// accepted excludes path is canonical.
    pub fn effective_excludes(&self, cwd: &Path) -> String {
        let path = self.active_excludes_file();
        match path.to_str() {
            Some(p)
                if path.is_absolute()
                    && !p.chars().any(|c| c.is_control())
                    && !path.starts_with(cwd) =>
            {
                p.to_string()
            }
            _ => "/dev/null".to_string(),
        }
    }

    /// The excludes file in force for every call: the configured one, or
    /// `/dev/null` once revoked.
    pub fn active_excludes_file(&self) -> PathBuf {
        if self.excludes_revoked.load(Ordering::SeqCst) {
            PathBuf::from("/dev/null")
        } else {
            self.excludes_file.clone()
        }
    }

    /// Stop using the configured excludes file for good. Returns `true` for
    /// the call that actually revoked it (so the caller reports it once).
    pub fn revoke_excludes(&self) -> bool {
        !self.excludes_revoked.swap(true, Ordering::SeqCst)
    }

    /// Run a builder-produced vector in `cwd` under the full hardening. No
    /// shell is involved. The metacharacter tripwire applies to every
    /// NON-path argument; absolute path arguments were validated by their
    /// builder (absolute, UTF-8, no control characters) and may legitimately
    /// contain spaces or shell-looking characters (review S-b).
    pub fn run(&self, cwd: &Path, args: &[String]) -> Result<String, GitError> {
        self.run_with_limits(cwd, args, &self.limits)
    }

    /// [`Self::run`] under explicit output/time limits (same hardening).
    /// Mutations such as `worktree add` use [`RunLimits::MUTATION`]: a
    /// QUERY-class timeout mid-checkout would leave a half-made worktree.
    pub fn run_with_limits(
        &self,
        cwd: &Path,
        args: &[String],
        limits: &RunLimits,
    ) -> Result<String, GitError> {
        let non_paths: Vec<String> = args
            .iter()
            .filter(|a| !Path::new(a.as_str()).is_absolute())
            .cloned()
            .collect();
        Validator::assert_no_shell_metachars(&non_paths).map_err(GitError::Validation)?;
        let repo = self.repo_overrides(cwd)?;
        self.exec(cwd, &repo.config, Some(repo.empty_tree), args, limits)
    }

    fn exec(
        &self,
        cwd: &Path,
        extra: &[String],
        attr_source: Option<&str>,
        args: &[String],
        limits: &RunLimits,
    ) -> Result<String, GitError> {
        let cmd = self.hardened_command(
            cwd,
            extra,
            attr_source,
            args,
            std::env::vars_os().map(|(k, _)| k),
        );
        let out = run_bounded(cmd, limits).map_err(|e| GitError::Exec(e.to_string()))?;
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
                limits.max_stdout
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

    /// `refs/heads/<branch>` → its object id, or `None` when the branch does
    /// not exist. Any other failure is an error (never read as "absent").
    pub fn branch_oid(&self, repo: &Path, branch: &str) -> Result<Option<String>, GitError> {
        self.quiet_oid(repo, &GitArgs::rev_parse_branch(branch)?)
    }

    /// `HEAD` as a full object id, or `None` when HEAD is unborn (no commit).
    pub fn head_oid(&self, repo: &Path) -> Result<Option<String>, GitError> {
        self.quiet_oid(repo, &GitArgs::rev_parse_head_quiet())
    }

    fn quiet_oid(&self, repo: &Path, args: &[String]) -> Result<Option<String>, GitError> {
        match self.run_quiet(repo, args)? {
            Some(out) => {
                let oid = out.trim().to_string();
                Validator::full_object_id(&oid)?;
                Ok(Some(oid))
            }
            None => Ok(None),
        }
    }

    /// The target of `refs/heads/<branch>` when it is a SYMBOLIC ref, else
    /// `None` (regular or absent). Review C1 tamper signal.
    pub fn symbolic_ref_target(
        &self,
        repo: &Path,
        branch: &str,
    ) -> Result<Option<String>, GitError> {
        Ok(self
            .run_quiet(repo, &GitArgs::symbolic_ref_target(branch)?)?
            .map(|t| t.trim().to_string()))
    }

    /// Index paths whose tags hide modifications (assume-unchanged or
    /// skip-worktree), repo-wide. Raised stdout cap like the gitlink scan.
    pub fn index_hidden_entries(&self, repo: &Path) -> Result<Vec<String>, GitError> {
        let limits = RunLimits {
            max_stdout: SUBMODULE_SCAN_MAX_STDOUT.max(self.limits.max_stdout),
            ..self.limits
        };
        let out = self.run_with_limits(repo, &GitArgs::ls_files_flags(), &limits)?;
        hidden_entries_from_ls_files_v(&out)
    }

    /// Ignored untracked entries of the work tree containing `dir`.
    pub fn ignored_entries(&self, dir: &Path) -> Result<Vec<String>, GitError> {
        let out = self.run(dir, &GitArgs::ls_files_ignored())?;
        Ok(out
            .split('\0')
            .filter(|e| !e.is_empty())
            .map(str::to_string)
            .collect())
    }

    /// Run a query whose "absent" answer is a QUIET exit 1 (no output, no
    /// stderr): `Ok(Some(stdout))` on exit 0, `Ok(None)` on quiet exit 1,
    /// an error otherwise (a failure is never read as "absent").
    fn run_quiet(&self, repo: &Path, args: &[String]) -> Result<Option<String>, GitError> {
        Validator::assert_no_shell_metachars(args).map_err(GitError::Validation)?;
        let repo_o = self.repo_overrides(repo)?;
        let cmd = self.hardened_command(
            repo,
            &repo_o.config,
            Some(repo_o.empty_tree),
            args,
            std::env::vars_os().map(|(k, _)| k),
        );
        let out = run_bounded(cmd, &self.limits).map_err(|e| GitError::Exec(e.to_string()))?;
        let sub = args.first().map(String::as_str).unwrap_or("?");
        match out.status.code() {
            Some(0) if !out.stdout_truncated => Ok(Some(out.stdout_lossy())),
            Some(1) if out.stdout.is_empty() && out.stderr.is_empty() => Ok(None),
            _ => Err(GitError::Exec(format!(
                "git {sub} exited {}: {}",
                out.status,
                out.stderr_lossy().trim()
            ))),
        }
    }

    /// Every registered worktree of `repo` (see [`parse_worktree_list`]).
    pub fn worktree_list(&self, repo: &Path) -> Result<Vec<WorktreeEntry>, GitError> {
        let out = self.run(repo, &GitArgs::worktree_list())?;
        parse_worktree_list(&out)
    }

    /// Canonical absolute common git dir of the repository containing `dir`.
    pub fn common_dir(&self, dir: &Path) -> Result<PathBuf, GitError> {
        let out = self.run(dir, &GitArgs::git_common_dir())?;
        let line = out.trim_end_matches(['\n', '\r']);
        if line.is_empty() || line.contains('\n') {
            return Err(GitError::Exec(format!(
                "unexpected rev-parse output {out:?}"
            )));
        }
        // Relative output is relative to the cwd git ran in (`dir`).
        std::fs::canonicalize(dir.join(line))
            .map_err(|e| GitError::Exec(format!("common dir {line:?} not usable: {e}")))
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

    /// Every gitlink (mode 160000, any stage) in the INDEX, repo-wide. Reads
    /// only the index through the hardened runner — never a submodule's work
    /// tree, config, or attributes. The index is authoritative: a gitlink
    /// present only in HEAD is a staged deletion, which status reports.
    pub fn submodule_paths(&self, repo: &Path) -> Result<Vec<String>, GitError> {
        let limits = RunLimits {
            max_stdout: SUBMODULE_SCAN_MAX_STDOUT.max(self.limits.max_stdout),
            ..self.limits
        };
        let out = self.run_with_limits(repo, &GitArgs::ls_files_stage(), &limits)?;
        gitlink_paths_from_ls_files_stage(&out)
    }

    /// Fail closed on submodules (see [`GitError::SubmodulesPresent`]).
    pub fn refuse_submodules(&self, repo: &Path) -> Result<(), GitError> {
        let paths = self.submodule_paths(repo)?;
        if paths.is_empty() {
            Ok(())
        } else {
            Err(GitError::SubmodulesPresent(paths))
        }
    }

    /// Porcelain status → true when the working tree has ANY uncommitted
    /// change (staged, unstaged, or untracked). Refuses
    /// ([`GitError::SubmodulesPresent`]) when the repository has submodules:
    /// their work trees are not inspected, so "clean" could not be vouched for.
    pub fn is_dirty(&self, repo: &Path) -> Result<bool, GitError> {
        self.refuse_submodules(repo)?;
        let out = self.run(repo, &GitArgs::status_porcelain())?;
        Ok(!out.trim().is_empty())
    }

    /// Actual change list vs a base revision, including untracked files
    /// (marked `untracked` — they are in NO git diff and must not be silently
    /// missed; specs/08 T15). The diff compares `base` against the WORKING
    /// TREE, so committed, staged, and unstaged modifications all appear.
    /// Renames are reported as `renamed` at their NEW path (T15 requires the
    /// full set: new/deleted/renamed/untracked). Refuses
    /// ([`GitError::SubmodulesPresent`]) when the repository has submodules —
    /// never a silently partial list.
    pub fn change_list(&self, repo: &Path, base_commit: &str) -> Result<Vec<RawChange>, GitError> {
        Validator::git_ref(base_commit)?;
        self.refuse_submodules(repo)?;
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

/// Parse `git ls-files --stage -z` (`<mode> SP <oid> SP <stage> TAB <path>`
/// NUL-terminated) into the deduplicated gitlink (mode `160000`) paths, in
/// index order. A malformed entry fails CLOSED.
pub fn gitlink_paths_from_ls_files_stage(out: &str) -> Result<Vec<String>, GitError> {
    let mut paths: Vec<String> = Vec::new();
    for entry in out.split('\0').filter(|e| !e.is_empty()) {
        let Some((meta, path)) = entry.split_once('\t') else {
            return Err(GitError::Exec(format!(
                "unexpected ls-files --stage entry {entry:?}"
            )));
        };
        let mut fields = meta.split(' ');
        let (Some(mode), Some(_oid), Some(_stage), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return Err(GitError::Exec(format!(
                "unexpected ls-files --stage entry {entry:?}"
            )));
        };
        if mode == "160000" && !paths.iter().any(|p| p == path) {
            paths.push(path.to_string());
        }
    }
    Ok(paths)
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
    /// gitlink commit changes are still reported. Submodule-internal dirt is
    /// therefore invisible here — callers go through [`GitRunner::is_dirty`],
    /// which refuses submodule repositories first.
    pub fn status_porcelain() -> Vec<String> {
        vec![
            "status".into(),
            "--porcelain".into(),
            "--ignore-submodules=dirty".into(),
            // Belt and braces with `status.showUntrackedFiles=normal`.
            "--untracked-files=normal".into(),
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

    /// Index listing used ONLY for the gitlink (submodule) scan. Reads the
    /// index, never a work tree; `:(top)` makes it repo-wide from any cwd.
    pub fn ls_files_stage() -> Vec<String> {
        vec![
            "ls-files".into(),
            "--stage".into(),
            "-z".into(),
            "--full-name".into(),
            "--".into(),
            ":(top)".into(),
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

    /// Every worktree of the repository (NUL-separated porcelain). Reads
    /// git's administrative files only; never a work tree's contents.
    pub fn worktree_list() -> Vec<String> {
        vec![
            "worktree".into(),
            "list".into(),
            "--porcelain".into(),
            "-z".into(),
        ]
    }

    /// `git worktree remove -- <path>` — deliberately WITHOUT `--force`: git
    /// itself refuses a worktree holding modified or untracked files, a
    /// second guard behind Core's own dirty check.
    pub fn worktree_remove(path: &Path) -> Result<Vec<String>, GitError> {
        let path_str = absolute_path_arg(path)?;
        Ok(vec![
            "worktree".into(),
            "remove".into(),
            "--".into(),
            path_str,
        ])
    }

    /// Atomic compare-and-delete of `refs/heads/<branch>`: git deletes the
    /// ref only while it still equals `old` (a FULL object id), so a branch
    /// that gained commits after Core looked is never deleted.
    pub fn update_ref_delete(branch: &str, old: &str) -> Result<Vec<String>, GitError> {
        Validator::branch_name(branch)?;
        Validator::full_object_id(old)?;
        Ok(vec![
            "update-ref".into(),
            // Review C1: operate on the ref ITSELF, never on what a
            // (tampered) symbolic ref points at.
            "--no-deref".into(),
            "-d".into(),
            "--end-of-options".into(),
            format!("refs/heads/{branch}"),
            old.into(),
        ])
    }

    /// Index listing with tags (`-v`): a lowercase tag marks an
    /// assume-unchanged entry, `S` a skip-worktree entry — both hide
    /// modifications from `status` (review S2). Reads the index only.
    pub fn ls_files_flags() -> Vec<String> {
        vec![
            "ls-files".into(),
            "-v".into(),
            "-z".into(),
            "--full-name".into(),
            "--".into(),
            ":(top)".into(),
        ]
    }

    /// Untracked files that the exclude rules IGNORE (whole ignored
    /// directories collapsed to `dir/`): exactly what `worktree remove`
    /// would delete without asking (review W2).
    pub fn ls_files_ignored() -> Vec<String> {
        vec![
            "ls-files".into(),
            "-z".into(),
            "--others".into(),
            "--ignored".into(),
            "--exclude-standard".into(),
            "--directory".into(),
            "--".into(),
        ]
    }

    /// `symbolic-ref -q refs/heads/<branch>`: exit 0 + target when the ref is
    /// SYMBOLIC; quiet exit 1 when it is a regular ref or absent.
    pub fn symbolic_ref_target(branch: &str) -> Result<Vec<String>, GitError> {
        Validator::branch_name(branch)?;
        Ok(vec![
            "symbolic-ref".into(),
            "-q".into(),
            "--end-of-options".into(),
            format!("refs/heads/{branch}"),
        ])
    }

    /// Every `refs/heads/sandpane/*` branch, short names, one per line.
    pub fn list_task_branches() -> Vec<String> {
        vec![
            "for-each-ref".into(),
            "--format=%(refname:short)".into(),
            "--end-of-options".into(),
            "refs/heads/sandpane/".into(),
        ]
    }

    /// `rev-parse --verify --quiet HEAD`: quiet exit 1 when HEAD is unborn.
    pub fn rev_parse_head_quiet() -> Vec<String> {
        vec![
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            "--end-of-options".into(),
            "HEAD".into(),
        ]
    }

    /// Resolve `refs/heads/<branch>`; `--quiet` makes a missing ref exit 1
    /// with no output (see [`GitRunner::branch_oid`]).
    pub fn rev_parse_branch(branch: &str) -> Result<Vec<String>, GitError> {
        Validator::branch_name(branch)?;
        Ok(vec![
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            "--end-of-options".into(),
            format!("refs/heads/{branch}"),
        ])
    }

    /// The repository's COMMON git dir (shared by all of its worktrees);
    /// git may print it relative to the cwd (see [`GitRunner::common_dir`]).
    /// Not `--path-format=absolute`: `=` trips the argument tripwire.
    pub fn git_common_dir() -> Vec<String> {
        vec!["rev-parse".into(), "--git-common-dir".into()]
    }

    /// Create an isolated task worktree: `git worktree add <path> -b <branch> <base>`.
    pub fn worktree_add(
        path: &Path,
        branch: &str,
        base_commit: &str,
    ) -> Result<Vec<String>, GitError> {
        Validator::branch_name(branch)?;
        Validator::git_ref(base_commit)?;
        let path_str = absolute_path_arg(path)?;
        Ok(vec![
            "worktree".into(),
            "add".into(),
            "-b".into(),
            branch.into(),
            "--".into(),
            path_str,
            base_commit.into(),
        ])
    }
}

/// One entry of `git worktree list --porcelain -z`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: String,
    pub head: Option<String>,
    /// Full ref (`refs/heads/...`) when a branch is checked out.
    pub branch: Option<String>,
}

/// Parse `git worktree list --porcelain -z`: NUL-terminated attribute lines,
/// an empty line between entries. Unknown attributes (`locked`, `prunable`,
/// `bare`, `detached`) are ignored; an attribute before any `worktree` line
/// fails CLOSED.
pub fn parse_worktree_list(out: &str) -> Result<Vec<WorktreeEntry>, GitError> {
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for field in out.split('\0') {
        if field.is_empty() {
            if let Some(e) = current.take() {
                entries.push(e);
            }
            continue;
        }
        if let Some(path) = field.strip_prefix("worktree ") {
            if let Some(e) = current.take() {
                entries.push(e);
            }
            current = Some(WorktreeEntry {
                path: path.to_string(),
                head: None,
                branch: None,
            });
            continue;
        }
        let Some(entry) = current.as_mut() else {
            return Err(GitError::Exec(format!(
                "unexpected worktree list field {field:?}"
            )));
        };
        if let Some(head) = field.strip_prefix("HEAD ") {
            entry.head = Some(head.to_string());
        } else if let Some(branch) = field.strip_prefix("branch ") {
            entry.branch = Some(branch.to_string());
        }
    }
    if let Some(e) = current.take() {
        entries.push(e);
    }
    Ok(entries)
}

/// Parse `git ls-files -v -z` (`<tag> SP <path>` NUL-terminated) into the
/// paths whose tag hides modifications: a lowercase tag (assume-unchanged)
/// or `S` (skip-worktree). A malformed entry fails CLOSED.
pub fn hidden_entries_from_ls_files_v(out: &str) -> Result<Vec<String>, GitError> {
    let mut paths = Vec::new();
    for entry in out.split('\0').filter(|e| !e.is_empty()) {
        let mut chars = entry.chars();
        let (Some(tag), Some(' ')) = (chars.next(), chars.next()) else {
            return Err(GitError::Exec(format!(
                "unexpected ls-files -v entry {entry:?}"
            )));
        };
        if tag.is_ascii_lowercase() || tag == 'S' {
            let path = chars.as_str().to_string();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    Ok(paths)
}

/// A Core-chosen absolute path as an argument: absolute, UTF-8, no control
/// characters (it is exempt from the metacharacter tripwire in
/// [`GitRunner::run`], so it is validated here).
fn absolute_path_arg(path: &Path) -> Result<String, GitError> {
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
    Ok(path_str.to_string())
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
            vec![
                "status",
                "--porcelain",
                "--ignore-submodules=dirty",
                "--untracked-files=normal"
            ]
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
        // Index-only scan (never enters a submodule work tree), repo-wide
        // regardless of cwd via the `:(top)` pathspec.
        assert_eq!(
            GitArgs::ls_files_stage(),
            vec!["ls-files", "--stage", "-z", "--full-name", "--", ":(top)"]
        );
    }

    #[test]
    fn gitlink_paths_are_parsed_from_ls_files_stage() {
        let sha = "a".repeat(40);
        let out = format!(
            "100644 {sha} 0\tfile.txt\0\
             160000 {sha} 0\tvendor/lib\0\
             120000 {sha} 0\tlink\0\
             160000 {sha} 1\tconflicted\0\
             160000 {sha} 2\tconflicted\0\
             160000 {sha} 0\twith\ttab and space\0"
        );
        assert_eq!(
            gitlink_paths_from_ls_files_stage(&out).unwrap(),
            vec!["vendor/lib", "conflicted", "with\ttab and space"]
        );
        assert!(gitlink_paths_from_ls_files_stage("").unwrap().is_empty());
        // A malformed entry fails CLOSED (never silently "no submodules").
        assert!(gitlink_paths_from_ls_files_stage("garbage\0").is_err());
    }

    #[test]
    fn submodule_refusal_message_names_paths_escaped_and_capped() {
        let e = GitError::SubmodulesPresent(vec!["sub".into(), "bad\nname".into()]);
        let msg = e.to_string();
        assert!(msg.contains("\"sub\""), "{msg}");
        assert!(msg.contains("bad\\nname"), "control chars escaped: {msg}");
        assert!(!msg.contains("bad\nname"), "{msg}");
        assert!(msg.contains("cannot verify submodule work trees"), "{msg}");
        assert!(msg.contains("uncommitted"), "{msg}");

        let many: Vec<String> = (0..100).map(|i| format!("m{i}")).collect();
        let msg = GitError::SubmodulesPresent(many).to_string();
        assert!(msg.contains("\"m19\""), "{msg}");
        assert!(!msg.contains("\"m20\""), "list capped: {msg}");
        assert!(msg.contains("80 more"), "{msg}");
    }

    #[test]
    fn task_worktree_arg_builders_are_exact_and_validated() {
        let oid = "a".repeat(40);
        assert_eq!(
            GitArgs::worktree_list(),
            vec!["worktree", "list", "--porcelain", "-z"]
        );
        assert_eq!(
            GitArgs::worktree_remove(Path::new("/data/worktrees/t 1")).unwrap(),
            vec!["worktree", "remove", "--", "/data/worktrees/t 1"]
        );
        assert!(GitArgs::worktree_remove(Path::new("rel/wt")).is_err());
        // Control characters in a path are refused (same rule as `worktree add`).
        assert!(GitArgs::worktree_remove(Path::new("/a\nb")).is_err());
        assert!(GitArgs::worktree_remove(Path::new("/a\u{7}b")).is_err());
        // No `--force`, ever: git's own clean check stays a second guard.
        assert!(!GitArgs::worktree_remove(Path::new("/w"))
            .unwrap()
            .iter()
            .any(|a| a.starts_with("-f") || a == "--force"));
        // Compare-and-delete: the old value is a FULL oid.
        assert_eq!(
            GitArgs::update_ref_delete("sandpane/t-1", &oid).unwrap(),
            vec![
                "update-ref",
                "--no-deref",
                "-d",
                "--end-of-options",
                "refs/heads/sandpane/t-1",
                oid.as_str()
            ]
        );
        assert!(GitArgs::update_ref_delete("sandpane/t-1", &oid[..12]).is_err());
        assert!(GitArgs::update_ref_delete("a..b", &oid).is_err());
        assert_eq!(
            GitArgs::rev_parse_branch("sandpane/t-1").unwrap(),
            vec![
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                "refs/heads/sandpane/t-1"
            ]
        );
        assert!(GitArgs::rev_parse_branch("-x").is_err());
        assert_eq!(
            GitArgs::git_common_dir(),
            vec!["rev-parse", "--git-common-dir"]
        );
    }

    /// Review C2 / S2 / W2: repo config must not hide work from any check.
    #[test]
    fn hardening_pins_untracked_visibility_stat_and_excludes() {
        for must in ["status.showUntrackedFiles=normal", "core.ignoreStat=false"] {
            assert!(HARDENING_CONFIG.contains(&must), "{must}");
        }
        // Every command pins core.excludesFile (default /dev/null).
        let cmd = GitRunner::default().hardened_command(
            Path::new("/repo"),
            &[],
            None,
            &GitArgs::status_porcelain(),
            Vec::<OsString>::new(),
        );
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(
            args.windows(2)
                .any(|w| w[0] == "-c" && w[1] == "core.excludesFile=/dev/null"),
            "{args:?}"
        );
        assert!(GitArgs::status_porcelain().contains(&"--untracked-files=normal".to_string()));
        // C1: the compare-and-delete never dereferences a symbolic ref.
        let oid = "a".repeat(40);
        assert!(GitArgs::update_ref_delete("sandpane/t-1", &oid)
            .unwrap()
            .contains(&"--no-deref".to_string()));
        assert_eq!(
            GitArgs::ls_files_flags(),
            vec!["ls-files", "-v", "-z", "--full-name", "--", ":(top)"]
        );
        assert_eq!(
            GitArgs::ls_files_ignored(),
            vec![
                "ls-files",
                "-z",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "--",
            ]
        );
        assert_eq!(
            GitArgs::symbolic_ref_target("sandpane/t-1").unwrap(),
            vec![
                "symbolic-ref",
                "-q",
                "--end-of-options",
                "refs/heads/sandpane/t-1"
            ]
        );
    }

    /// Review C2 (pre-existing): the HOST dirty gate (hostDirty, apply
    /// preconditions) honoured `status.showUntrackedFiles=no`.
    #[test]
    fn host_dirty_gate_sees_untracked_files_despite_repo_config() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        git_plain(dir.path(), &["config", "status.showUntrackedFiles", "no"]);
        let runner = GitRunner::default();
        let base = runner.rev_parse_head(dir.path()).unwrap();
        std::fs::write(dir.path().join("user-work.txt"), "x\n").unwrap();
        assert!(runner.is_dirty(dir.path()).unwrap());
        assert!(matches!(
            preconditions_for_apply(&runner, dir.path(), &base),
            Err(GitError::DirtyHostState(_))
        ));
    }

    #[test]
    fn worktree_list_porcelain_z_is_parsed() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let out = format!(
            "worktree /repo/main\0HEAD {a}\0branch refs/heads/main\0\0\
             worktree /data/wt/t 1\0HEAD {b}\0branch refs/heads/sandpane/t1\0\0\
             worktree /data/wt/det\0HEAD {b}\0detached\0prunable gitdir file points to non-existent location\0\0"
        );
        assert_eq!(
            parse_worktree_list(&out).unwrap(),
            vec![
                WorktreeEntry {
                    path: "/repo/main".into(),
                    head: Some(a.clone()),
                    branch: Some("refs/heads/main".into())
                },
                WorktreeEntry {
                    path: "/data/wt/t 1".into(),
                    head: Some(b.clone()),
                    branch: Some("refs/heads/sandpane/t1".into())
                },
                WorktreeEntry {
                    path: "/data/wt/det".into(),
                    head: Some(b.clone()),
                    branch: None
                },
            ]
        );
        assert!(parse_worktree_list("").unwrap().is_empty());
        // An attribute before any `worktree` line fails closed.
        assert!(parse_worktree_list("HEAD x\0\0").is_err());
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
        expected.push("-c".into());
        expected.push("core.excludesFile=/dev/null".into());
        expected.extend(
            [
                "-c",
                "filter.lfs.clean=",
                "status",
                "--porcelain",
                "--ignore-submodules=dirty",
                "--untracked-files=normal",
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
        // The hardened status/diff vectors themselves still never enter the
        // submodule (run directly: the public gates now refuse submodule
        // repos before reaching status/diff, which would make this vacuous).
        let _ = runner.run(&top, &GitArgs::status_porcelain()).unwrap();
        let _ = runner.run(&top, &GitArgs::diff_name_status(&base)).unwrap();
        // And the public gates refuse (fail closed) — also without the filter.
        assert!(matches!(
            runner.is_dirty(&top),
            Err(GitError::SubmodulesPresent(_))
        ));
        assert!(matches!(
            runner.change_list(&top, &base),
            Err(GitError::SubmodulesPresent(_))
        ));
        assert_eq!(fired(&traps), Vec::<String>::new(), "submodule filter ran");
    }

    /// Builds `<dir>/top` with a committed submodule at `sub` (cloned from
    /// `<dir>/sub-origin`); returns (top, base commit).
    fn repo_with_submodule(dir: &Path) -> (PathBuf, String) {
        let origin = dir.join("sub-origin");
        let top = dir.join("top");
        for d in [&origin, &top] {
            std::fs::create_dir(d).unwrap();
        }
        init_repo(&origin);
        init_repo(&top);
        let out = Command::new("git")
            .args([
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                &origin.display().to_string(),
                "sub",
            ])
            .current_dir(&top)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "submodule add: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        git_plain(&top, &["commit", "-qm", "add submodule"]);
        let base = GitRunner::default().rev_parse_head(&top).unwrap();
        (top, base)
    }

    /// Review finding (bb5cc8f): `--ignore-submodules=dirty` hides
    /// uncommitted work inside a submodule, so the dirty gate reported clean.
    /// Fail closed: any gitlink in the index refuses the dirty gate, the apply
    /// preconditions, and the change list — naming the submodule.
    #[test]
    fn submodule_with_uncommitted_work_refuses_dirty_gate_apply_and_review() {
        let dir = tempfile::tempdir().unwrap();
        let (top, base) = repo_with_submodule(dir.path());
        let checkout = top.join("sub");
        std::fs::write(checkout.join("file.txt"), "uncommitted submodule work\n").unwrap();
        std::fs::write(checkout.join("scratch.txt"), "untracked in submodule\n").unwrap();

        // Control: plain git sees the submodule as modified...
        let plain = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&top)
            .output()
            .unwrap();
        let plain = String::from_utf8_lossy(&plain.stdout).into_owned();
        assert!(plain.contains("sub"), "control: plain status {plain:?}");
        // ...while the hardened status vector is blind to it (the hazard).
        let runner = GitRunner::default();
        let hardened = runner.run(&top, &GitArgs::status_porcelain()).unwrap();
        assert!(hardened.trim().is_empty(), "hardened status {hardened:?}");

        let refused = |r: Result<(), GitError>| match r {
            Err(GitError::SubmodulesPresent(paths)) => {
                assert_eq!(paths, vec!["sub".to_string()]);
            }
            other => panic!("expected SubmodulesPresent, got {other:?}"),
        };
        refused(runner.is_dirty(&top).map(|_| ()));
        refused(runner.change_list(&top, &base).map(|_| ()));
        refused(preconditions_for_apply(&runner, &top, &base));
        let msg = runner.is_dirty(&top).unwrap_err().to_string();
        assert!(msg.contains("\"sub\""), "{msg}");

        // A cwd below the top level cannot hide the submodule.
        let docs = top.join("docs");
        std::fs::create_dir(&docs).unwrap();
        refused(runner.is_dirty(&docs).map(|_| ()));

        // User work in the submodule is untouched.
        assert_eq!(
            std::fs::read_to_string(checkout.join("file.txt")).unwrap(),
            "uncommitted submodule work\n"
        );
        assert!(checkout.join("scratch.txt").exists());
    }

    /// Even a CLEAN submodule refuses: Core cannot inspect submodule work
    /// trees safely, so it never vouches for one.
    #[test]
    fn clean_submodule_still_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let (top, base) = repo_with_submodule(dir.path());
        let runner = GitRunner::default();
        assert!(matches!(
            preconditions_for_apply(&runner, &top, &base),
            Err(GitError::SubmodulesPresent(_))
        ));
    }

    #[test]
    fn plain_repo_has_no_submodules() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let runner = GitRunner::default();
        assert!(runner.submodule_paths(dir.path()).unwrap().is_empty());
        // An untracked `.gitmodules` alone is not a gitlink (and is reported
        // as ordinary untracked dirt, never hidden).
        std::fs::write(dir.path().join(".gitmodules"), "[submodule \"x\"]\n").unwrap();
        assert!(runner.submodule_paths(dir.path()).unwrap().is_empty());
        assert!(runner.is_dirty(dir.path()).unwrap());
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

    // --- User global excludes (orchestrator follow-up to review W2) --------

    fn euid_now() -> u32 {
        // SAFETY: geteuid has no preconditions and cannot fail.
        unsafe { libc::geteuid() }
    }

    /// A user's OWN global ignore (e.g. `.DS_Store`) is honoured by the host
    /// dirty gate and the review change list once Core resolved it.
    #[test]
    fn user_global_excludes_are_honoured_by_dirty_gate_and_review() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let repo = base.join("repo");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        let global = base.join("global-ignore");
        std::fs::write(&global, ".DS_Store\n").unwrap();
        let runner = GitRunner {
            excludes_file: global,
            ..GitRunner::default()
        };
        let head = runner.rev_parse_head(&repo).unwrap();
        std::fs::write(repo.join(".DS_Store"), "finder\n").unwrap();
        assert!(!runner.is_dirty(&repo).unwrap());
        assert!(runner.change_list(&repo, &head).unwrap().is_empty());
        std::fs::write(repo.join("work.txt"), "work\n").unwrap();
        assert!(runner.is_dirty(&repo).unwrap());
        let changes = runner.change_list(&repo, &head).unwrap();
        assert_eq!(changes.len(), 1, "{changes:?}");
        assert_eq!(changes[0].path, "work.txt");
    }

    /// Repo-local `core.excludesFile` (agent-writable) still cannot hide work
    /// when a user global excludes file is in force: Core's `-c` wins.
    #[test]
    fn repo_local_excludes_cannot_hide_work_with_user_excludes_set() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let repo = base.join("repo");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        let global = base.join("global-ignore");
        std::fs::write(&global, ".DS_Store\n").unwrap();
        let agent = base.join("agent-ignore");
        std::fs::write(&agent, "*.txt\n").unwrap();
        git_plain(
            &repo,
            &["config", "core.excludesFile", &agent.display().to_string()],
        );
        let runner = GitRunner {
            excludes_file: global,
            ..GitRunner::default()
        };
        std::fs::write(repo.join("work.txt"), "work\n").unwrap();
        assert!(runner.is_dirty(&repo).unwrap());
    }

    /// An excludes file (or its directory) that another local user could
    /// write is refused: whoever writes it decides what reviews ignore.
    #[cfg(unix)]
    #[test]
    fn group_or_world_writable_excludes_files_or_directories_are_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let home = base.join("home");
        std::fs::create_dir(&home).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
        let file = home.join("ignore");
        std::fs::write(&file, ".DS_Store\n").unwrap();
        let uid = euid_now();
        let set = |p: &Path, mode: u32| {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap()
        };
        set(&file, 0o644);
        assert_eq!(accept_excludes_file(&file, &[], uid).unwrap(), file);
        set(&file, 0o666);
        assert!(
            accept_excludes_file(&file, &[], uid).is_err(),
            "world-writable file"
        );
        set(&file, 0o664);
        assert!(
            accept_excludes_file(&file, &[], uid).is_err(),
            "group-writable file"
        );
        set(&file, 0o644);
        set(&home, 0o777);
        assert!(
            accept_excludes_file(&file, &[], uid).is_err(),
            "world-writable directory"
        );
        set(&home, 0o775);
        assert!(
            accept_excludes_file(&file, &[], uid).is_err(),
            "group-writable directory"
        );
        set(&home, 0o755);
        assert_eq!(accept_excludes_file(&file, &[], uid).unwrap(), file);
    }

    /// Revocation is one-way and applies to every later call, in any cwd.
    #[test]
    fn a_revoked_excludes_file_is_never_used_again() {
        let runner = GitRunner {
            excludes_file: PathBuf::from("/opt/sandpane-test/git/ignore"),
            ..GitRunner::default()
        };
        assert_eq!(
            runner.effective_excludes(Path::new("/repo/atlas")),
            "/opt/sandpane-test/git/ignore"
        );
        assert!(runner.revoke_excludes(), "first revocation reports itself");
        assert!(!runner.revoke_excludes(), "later ones do not");
        assert_eq!(
            runner.effective_excludes(Path::new("/repo/atlas")),
            "/dev/null"
        );
        assert_eq!(runner.active_excludes_file(), PathBuf::from("/dev/null"));
    }

    /// Per-call guard: an excludes file that lies inside the directory git
    /// runs in (a repository registered after startup) is never used.
    #[test]
    fn excludes_file_inside_the_working_directory_is_not_used() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let repo = base.join("repo");
        std::fs::create_dir(&repo).unwrap();
        init_repo(&repo);
        let inside = repo.join("ignore-everything");
        std::fs::write(&inside, "*\n").unwrap();
        let runner = GitRunner {
            excludes_file: inside,
            ..GitRunner::default()
        };
        std::fs::write(repo.join("work.txt"), "work\n").unwrap();
        assert!(runner.is_dirty(&repo).unwrap());
    }

    #[test]
    fn excludes_candidates_are_accepted_only_when_safe() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let repo = base.join("repo");
        let root = base.join("data").join("worktrees");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let forbidden = vec![repo.clone(), root.clone()];
        let uid = euid_now();
        let ok = base.join("global-ignore");
        std::fs::write(&ok, ".DS_Store\n").unwrap();
        assert_eq!(accept_excludes_file(&ok, &forbidden, uid).unwrap(), ok);
        // A dotfiles-style symlink to a safe file resolves to that file.
        let link_ok = base.join("link-ok");
        std::os::unix::fs::symlink(&ok, &link_ok).unwrap();
        assert_eq!(accept_excludes_file(&link_ok, &forbidden, uid).unwrap(), ok);
        // Inside a registered repository or the worktrees root.
        let in_repo = repo.join("ignore");
        std::fs::write(&in_repo, "*\n").unwrap();
        assert!(accept_excludes_file(&in_repo, &forbidden, uid).is_err());
        let in_root = root.join("ignore");
        std::fs::write(&in_root, "*\n").unwrap();
        assert!(accept_excludes_file(&in_root, &forbidden, uid).is_err());
        // A symlink pointing INTO the repository.
        let link_in = base.join("link-in");
        std::os::unix::fs::symlink(&in_repo, &link_in).unwrap();
        assert!(accept_excludes_file(&link_in, &forbidden, uid).is_err());
        // Relative, missing, a directory, control characters, foreign owner.
        assert!(accept_excludes_file(Path::new("rel/ignore"), &forbidden, uid).is_err());
        assert!(accept_excludes_file(&base.join("missing"), &forbidden, uid).is_err());
        assert!(accept_excludes_file(&base, &forbidden, uid).is_err());
        assert!(accept_excludes_file(&base.join("a\nb"), &forbidden, uid).is_err());
        assert!(accept_excludes_file(&ok, &forbidden, uid.wrapping_add(1)).is_err());
    }

    /// Resolution reads GLOBAL config only (`~/.gitconfig`,
    /// `$XDG_CONFIG_HOME/git/config`), from a neutral cwd, and falls back to
    /// git's documented default `$XDG_CONFIG_HOME/git/ignore` or
    /// `~/.config/git/ignore`.
    #[test]
    fn user_excludes_candidate_follows_global_config_and_git_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let home = std::fs::canonicalize(dir.path()).unwrap();
        let runner = GitRunner::default();
        // Unset → defaults.
        let env = ExcludesEnv {
            home: Some(home.clone()),
            xdg_config_home: None,
        };
        assert_eq!(
            user_excludes_candidate(&runner, &env).unwrap(),
            Some(home.join(".config/git/ignore"))
        );
        let xdg = home.join("xdg");
        std::fs::create_dir_all(xdg.join("git")).unwrap();
        let env_xdg = ExcludesEnv {
            home: Some(home.clone()),
            xdg_config_home: Some(xdg.clone()),
        };
        assert_eq!(
            user_excludes_candidate(&runner, &env_xdg).unwrap(),
            Some(xdg.join("git/ignore"))
        );
        // Configured in ~/.gitconfig, with `~` expanded by `--path`.
        std::fs::write(
            home.join(".gitconfig"),
            "[core]\n\texcludesFile = ~/my-ignore\n",
        )
        .unwrap();
        assert_eq!(
            user_excludes_candidate(&runner, &env).unwrap(),
            Some(home.join("my-ignore"))
        );
        // No home at all → no candidate.
        assert_eq!(
            user_excludes_candidate(&runner, &ExcludesEnv::default()).unwrap(),
            None
        );
    }
}
