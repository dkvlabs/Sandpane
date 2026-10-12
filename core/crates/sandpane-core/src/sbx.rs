//! SBX CLI adapter (docs/specs/02 §5, docs/specs/06 §2/§4).
//!
//! This module NEVER executes a shell. Every command is a fixed executable +
//! argument vector built by [`SbxCommandBuilder`]; every external value passes
//! [`crate::validation`] first. Command/flag shapes are pinned to the REAL
//! `sbx v0.47.0` captured under
//! `tests/fixtures/sbx/captured/v0.47.0/` (`fixture_status: captured`): a unit
//! test asserts every subcommand and flag emitted here appears in the
//! corresponding captured `--help`, and parsers are tested against captured
//! state/error/CRUD outputs. The older top-level `tests/fixtures/sbx/list.json`
//! stays labeled illustrative and no longer drives any parser expectation.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use sandpane_protocol::ErrorCode;
use serde::Deserialize;
use thiserror::Error;

use crate::process::{run_bounded, BoundedOutput, ProcessError, RunLimits};
use crate::validation::{ValidationError, Validator};

#[derive(Debug, Error)]
pub enum SbxError {
    #[error(
        "sbx executable not found (set SANDPANE_SBX_PATH or install Docker Sandboxes separately)"
    )]
    NotInstalled,
    #[error("invalid input: {0}")]
    Validation(#[from] ValidationError),
    #[error("unsupported by the pinned sbx version: {0}")]
    UnsupportedVersion(String),
    #[error("could not parse sbx output: {0}")]
    Parse(String),
}

/// Where the located binary came from (security S8: surfaced, never silent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SbxSource {
    /// `SANDPANE_SBX_PATH` (explicit user-confirmed override).
    EnvOverride,
    /// First executable `sbx` on the absolute `PATH` entries.
    SearchPath,
}

impl SbxSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EnvOverride => "SANDPANE_SBX_PATH",
            Self::SearchPath => "PATH",
        }
    }
}

/// Locates a trusted `sbx` binary. Never trusts a repo-local executable or a
/// path supplied by an agent without user confirmation (specs/06 §4).
#[derive(Debug, Clone)]
pub struct SbxLocator {
    /// Explicit user-confirmed override.
    pub override_path: Option<PathBuf>,
    /// Directories searched when no override is set (PATH entries).
    pub search_path: Vec<PathBuf>,
}

impl SbxLocator {
    /// Build from the environment: `SANDPANE_SBX_PATH` override + `PATH`.
    pub fn from_env() -> Self {
        let override_path = std::env::var_os("SANDPANE_SBX_PATH").map(PathBuf::from);
        let search_path = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .filter(|p| p.is_absolute())
            .collect();
        Self {
            override_path,
            search_path,
        }
    }

    /// Test/controlled constructor (no ambient environment).
    pub fn with_search(override_path: Option<PathBuf>, search_path: Vec<PathBuf>) -> Self {
        Self {
            override_path,
            search_path,
        }
    }

    pub fn locate(&self) -> Result<PathBuf, SbxError> {
        self.locate_with_source().map(|(p, _)| p)
    }

    /// The resolved binary and which configuration selected it. Only regular
    /// files with an execute bit qualify (review 0004 #12); a dangling or
    /// non-executable override is `NotInstalled`, never a silent fallback to
    /// PATH.
    pub fn locate_with_source(&self) -> Result<(PathBuf, SbxSource), SbxError> {
        if let Some(p) = &self.override_path {
            if is_executable_file(p) {
                return Ok((p.clone(), SbxSource::EnvOverride));
            }
            return Err(SbxError::NotInstalled);
        }
        for dir in &self.search_path {
            let candidate = dir.join("sbx");
            if is_executable_file(&candidate) {
                return Ok((candidate, SbxSource::SearchPath));
            }
        }
        Err(SbxError::NotInstalled)
    }
}

fn is_executable_file(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Parsed `sbx version` (captured v0.47.0 shape:
/// `sbx version: v0.47.0 0411f50…`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SbxVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    /// The semver pre-release identifier (`rc.1` in `v0.47.0-rc.1`), kept so
    /// a pre-release never compares equal to its release (A8a review W2).
    /// `+build` metadata is dropped.
    pub pre: Option<String>,
}

impl SbxVersion {
    /// Finds the first whitespace token of the form `[v]N.N.N[-suffix]`.
    /// Commit hashes (which may start with a digit) never match because they
    /// carry no dots. Fails loudly rather than guessing (specs/08 §3).
    pub fn parse(output: &str) -> Result<Self, SbxError> {
        output
            .split_whitespace()
            .find_map(Self::parse_token)
            .ok_or_else(|| SbxError::Parse(format!("no version token in {output:?}")))
    }

    fn parse_token(token: &str) -> Option<Self> {
        let t = token.strip_prefix('v').unwrap_or(token);
        let mut parts = t.splitn(3, '.');
        let major = parts.next()?;
        let minor = parts.next()?;
        let patch = parts.next()?;
        let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
        // patch may carry a pre-release/build suffix like `2-beta`.
        let patch_digits: String = patch.chars().take_while(|c| c.is_ascii_digit()).collect();
        let rest = &patch[patch_digits.len()..];
        if !digits(major) || !digits(minor) || patch_digits.is_empty() {
            return None;
        }
        if !(rest.is_empty() || rest.starts_with('-') || rest.starts_with('+')) {
            return None;
        }
        let pre = match rest.strip_prefix('-') {
            None => None,
            Some(r) => {
                let id = r.split('+').next().unwrap_or("");
                let ok = !id.is_empty()
                    && id.len() <= 64
                    && id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
                if !ok {
                    return None;
                }
                Some(id.to_string())
            }
        };
        Some(Self {
            major: major.parse().ok()?,
            minor: minor.parse().ok()?,
            patch: patch_digits.parse().ok()?,
            pre,
        })
    }

    pub fn at_least(&self, major: u32, minor: u32) -> bool {
        (self.major, self.minor) >= (major, minor)
    }
}

impl std::fmt::Display for SbxVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(pre) = &self.pre {
            write!(f, "-{pre}")?;
        }
        Ok(())
    }
}

/// sbx versions for which `sbx exec` argument passing is PROVEN (A7, design
/// 2026-10-09 §3.7 items 3 and 11): a version is added only after captures
/// C-1 (argument passing), C-2 (exit status), C-5 (working directory) and
/// C-7 (user) exist for it. EMPTY in A7 — no version is proven yet, so Core
/// never spawns `sbx exec` in production; `verification.run` answers
/// `UNSUPPORTED_SBX_VERSION`. Integration tests add their fake's version
/// through a `CoreConfig` test seam only.
pub const VERIFIED_EXEC_VERSIONS: &[SbxVersion] = &[];

/// Whether `version` may run `sbx exec`: listed in
/// [`VERIFIED_EXEC_VERSIONS`] or in `extra` (the test seam; empty in
/// production).
pub fn exec_verified(version: &SbxVersion, extra: &[SbxVersion]) -> bool {
    VERIFIED_EXEC_VERSIONS
        .iter()
        .chain(extra.iter())
        .any(|v| v == version)
}

/// sbx versions whose fixtures are in the tree
/// (`tests/fixtures/sbx/captured/v{X.Y.Z}/`; design 2026-10-09 §3.8 item 1,
/// I3). Drift-tested against the directory names. A statement about
/// EVIDENCE, never a support claim: the captures come from one macOS arm64
/// host, and only the version NUMBER is known (the build is not recorded in
/// [`SbxVersion`]).
pub const CAPTURED_VERSIONS: &[SbxVersion] = &[SbxVersion {
    major: 0,
    minor: 47,
    patch: 0,
    pre: None,
}];

/// Whether `version`'s NUMBER equals one in [`CAPTURED_VERSIONS`]. The build
/// is not compared (`SbxVersion` drops the commit), and the captures are from
/// one macOS arm64 host — so `true` means "same version number as Sandpane's
/// captured fixtures", nothing more. A pre-release (`0.47.0-rc.1`) never
/// matches its release (review W2): equality includes [`SbxVersion::pre`].
pub fn version_captured(version: &SbxVersion) -> bool {
    CAPTURED_VERSIONS.contains(version)
}

/// Environment variables passed to sbx on the A7 verification path (W4):
/// the environment is CLEARED, then only these (plus every `LC_*`) are
/// copied from Core's own environment, so host tokens never reach sbx.
pub const EXEC_ENV_ALLOWLIST: [&str; 6] = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"];

/// The allowlisted subset of `vars` (W4), in input order.
pub fn exec_env<I>(vars: I) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    vars.into_iter()
        .filter(|(k, _)| {
            let k = k.as_encoded_bytes();
            EXEC_ENV_ALLOWLIST.iter().any(|a| a.as_bytes() == k) || k.starts_with(b"LC_")
        })
        .collect()
}

/// ONE execution context for every sbx invocation on the verification path
/// (R2): the exec itself, the identity gate's `ls --json` and the version
/// probe all run with exactly this environment (cleared, then
/// [`exec_env`]) and this Core-owned empty `0700` working directory, so the
/// gates cannot consult a different daemon or context than the exec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SbxExecContext {
    pub cwd: PathBuf,
    pub env: Vec<(OsString, OsString)>,
}

/// A fully-built, injection-safe SBX invocation: fixed program + argument
/// vector, ready for `std::process::Command`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SbxCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl SbxCommand {
    /// Execute under the bounded runner (timeout, output caps, process-group
    /// kill). Never through a shell.
    pub fn run(&self, limits: &RunLimits) -> Result<BoundedOutput, ProcessError> {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args);
        run_bounded(cmd, limits)
    }

    /// The `Command` for this invocation inside `ctx` (R2): environment
    /// CLEARED then set to `ctx.env`, working directory `ctx.cwd`. Never a
    /// shell.
    pub fn command_in(&self, ctx: &SbxExecContext) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args)
            .env_clear()
            .envs(ctx.env.iter().map(|(k, v)| (k, v)))
            .current_dir(&ctx.cwd);
        cmd
    }

    /// [`Self::run`] inside `ctx` (A7 gates: version probe, `ls --json`).
    pub fn run_in(
        &self,
        ctx: &SbxExecContext,
        limits: &RunLimits,
    ) -> Result<BoundedOutput, ProcessError> {
        run_bounded(self.command_in(ctx), limits)
    }
}

/// How `sbx create` maps the workspace (captured `create --help`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SbxWorkspace<'a> {
    /// `sbx create AGENT` — no host workspace bind mount.
    None,
    /// `sbx create AGENT PATH` — LIVE-WRITABLE bind mount of PATH
    /// (Sandpane `direct_mount`).
    BindMount(&'a Path),
    /// `sbx create --clone AGENT PATH` — "private in-container clone of the
    /// host Git repository (mounted read-only)"; commits reach the host only
    /// through the `sandbox-<name>` git remote (Sandpane `sbx_clone`).
    Clone(&'a Path),
}

/// Evidence that the server-enforced two-step confirmation for removing
/// exactly this sandbox completed (sbx-cli-integration rule 6). `sbx rm`
/// prompts unless `--force` is given, and Core is non-interactive, so
/// `--force` is only ever emitted together with this value.
///
/// The only constructor call in Core is `sandbox.remove` step 2 in
/// `sandpane-service`, AFTER a single-use, unexpired, 256-bit confirmation
/// token issued by step 1 was consumed and the sandbox's sbx `id` was
/// re-checked against the id the token is bound to (design 2026-10-09 §2).
///
/// What it is NOT: proof that a human was present. Any same-user process can
/// speak the Core socket, call step 1 and replay the returned token into step
/// 2; the socket's same-user authentication cannot tell that process from a
/// client UI (the specs/06 §3 malicious same-user attacker). The two steps
/// stop a single accidental or stale request and bind the action to the
/// target identity the user was shown — nothing more.
#[derive(Debug)]
pub struct RemovalConfirmation {
    sandbox: String,
}

impl RemovalConfirmation {
    /// Call ONLY after the server-enforced two-step confirmation for removing
    /// `sandbox` completed (never on a single request's say-so alone).
    pub fn user_confirmed(sandbox: &str) -> Self {
        Self {
            sandbox: sandbox.to_string(),
        }
    }
}

/// Typed command builders for the documented sandbox lifecycle. Each builder
/// validates its inputs; the resulting vectors must be passed to
/// `Command::new(program).args(args)` — never to a shell.
///
/// There is deliberately NO `start` builder: sbx v0.47.0 has no `start`; a
/// stopped sandbox is restarted with the INTERACTIVE `sbx run --name N`
/// (captured `crud/06_stop.txt`), which Core does not drive. `inspect` is a
/// hidden command and is not used; state comes from `ls --json`.
pub struct SbxCommandBuilder;

impl SbxCommandBuilder {
    /// `sbx version`
    pub fn version(program: &Path) -> SbxCommand {
        SbxCommand {
            program: program.to_path_buf(),
            args: vec!["version".into()],
        }
    }

    /// `sbx daemon status` (TEXT form) — the read-only daemon probe used by
    /// `system.probe` (design 2026-10-09 §3.8 item 1). Its output is captured
    /// for BOTH states (`state/daemon_status_running.txt`,
    /// `state/daemon_status_stopped.txt`); parse it with
    /// [`parse_daemon_status_text`]. NOT `ls`, which auto-starts the daemon
    /// (captured `state/ls_json_autostarts_daemon.txt`).
    pub fn daemon_status(program: &Path) -> SbxCommand {
        SbxCommand {
            program: program.to_path_buf(),
            args: vec!["daemon".into(), "status".into()],
        }
    }

    /// `sbx daemon status --json`. UNUSED by the probe since A8a and kept as
    /// a unit-tested fallback only: its output is captured for a RUNNING
    /// daemon alone — the stopped JSON form is not captured (C-14).
    pub fn daemon_status_json(program: &Path) -> SbxCommand {
        SbxCommand {
            program: program.to_path_buf(),
            args: vec!["daemon".into(), "status".into(), "--json".into()],
        }
    }

    /// `sbx ls --json` (may auto-start the daemon; use only for operations
    /// the user asked for, never for passive probing). Evidence (orchestrator,
    /// 2026-10-09, this host, sbx v0.47.0): with `sandboxd` stopped,
    /// `sbx ls --json | cat` auto-started the daemon and returned in ~2 s —
    /// the started daemon did NOT keep the output pipe open, so the bounded
    /// runner neither waits for nor group-kills it.
    pub fn list(program: &Path) -> SbxCommand {
        SbxCommand {
            program: program.to_path_buf(),
            args: vec!["ls".into(), "--json".into()],
        }
    }

    /// `sbx create [--clone] --name NAME AGENT [PATH]`.
    pub fn create(
        program: &Path,
        name: &str,
        agent: &str,
        workspace: SbxWorkspace<'_>,
    ) -> Result<SbxCommand, SbxError> {
        Validator::sandbox_name(name)?;
        Validator::sbx_agent(agent)?;
        let mut args: Vec<String> = vec!["create".into()];
        let path = match workspace {
            SbxWorkspace::None => None,
            SbxWorkspace::BindMount(p) => Some(Validator::sbx_workspace_path(p)?),
            SbxWorkspace::Clone(p) => {
                args.push("--clone".into());
                Some(Validator::sbx_workspace_path(p)?)
            }
        };
        args.push("--name".into());
        args.push(name.into());
        args.push(agent.into());
        if let Some(p) = path {
            args.push(p.into());
        }
        Ok(SbxCommand {
            program: program.to_path_buf(),
            args,
        })
    }

    /// `sbx stop NAME`.
    pub fn stop(program: &Path, name: &str) -> Result<SbxCommand, SbxError> {
        Validator::sandbox_name(name)?;
        Ok(SbxCommand {
            program: program.to_path_buf(),
            args: vec!["stop".into(), name.into()],
        })
    }

    /// `sbx rm --force NAME` — destructive; requires a server-recorded
    /// [`RemovalConfirmation`] for exactly `name`, and callers must re-probe
    /// state afterwards (specs/02 §5).
    pub fn remove(
        program: &Path,
        name: &str,
        confirmation: &RemovalConfirmation,
    ) -> Result<SbxCommand, SbxError> {
        Validator::sandbox_name(name)?;
        if confirmation.sandbox != name {
            return Err(SbxError::Validation(ValidationError::InvalidShape {
                reason: format!(
                    "removal confirmation names {:?}, not {name:?}",
                    confirmation.sandbox
                ),
            }));
        }
        Ok(SbxCommand {
            program: program.to_path_buf(),
            args: vec!["rm".into(), "--force".into(), name.into()],
        })
    }

    /// `sbx exec -- NAME ARGV…` (A7, design 2026-10-09 §3.7 item 3). EXACTLY
    /// that: no `-i`/`-t`/`-u`/`-e`/`-w`/`--privileged`/`--cloud`. The `--`
    /// comes BEFORE the sandbox name: the cobra v1.10.2 / pflag v1.0.10
    /// probe showed that with it there, no later element is ever read as an
    /// sbx flag under interspersed or non-interspersed parsing (without it,
    /// interspersed parsing would take `-u root --privileged --cloud` from
    /// the user's argv; with `NAME --`, non-interspersed parsing passes the
    /// `--` into the command). UNVERIFIED against the real sbx until C-1.
    ///
    /// `argv` is the user-approved vector, passed through byte for byte: it
    /// is validated for SHAPE only ([`Validator::verification_argv`]) and is
    /// deliberately NOT run through the metacharacter tripwire — no shell is
    /// involved, and the user approved those exact bytes.
    pub fn exec(program: &Path, name: &str, argv: &[String]) -> Result<SbxCommand, SbxError> {
        Validator::sandbox_name(name)?;
        Validator::verification_argv(argv)?;
        let mut args: Vec<String> = Vec::with_capacity(argv.len() + 3);
        args.push("exec".into());
        args.push("--".into());
        args.push(name.into());
        args.extend(argv.iter().cloned());
        Ok(SbxCommand {
            program: program.to_path_buf(),
            args,
        })
    }
}

/// Probed sandbox status from an `ls --json` row. Only the two values seen in
/// real captures are named; anything else is an explicit `Unknown`, never a
/// guess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SbxSandboxStatus {
    Running,
    Stopped,
    Unknown,
}

impl SbxSandboxStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Unknown => "unknown",
        }
    }
}

/// One row of `sbx ls --json` (captured `crud/02_ls_json_after_create.txt`:
/// `name`, `id`, `agent`, `status`, `last_used_at`, `workspaces`,
/// `created_at`). Only the fields Core uses are read; unknown fields are
/// ignored. `id` is the sandbox's sbx identity — it is what a destructive
/// confirmation is bound to, so a same-named replacement is detectable.
/// `id` and `agent` are ABSENT when sbx printed none or a value outside the
/// captured shapes ([`Validator::sbx_sandbox_id`],
/// [`Validator::sbx_reported_agent`]) — never invented, never relayed raw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SbxListEntry {
    pub name: String,
    pub id: Option<String>,
    pub status: SbxSandboxStatus,
    pub agent: Option<String>,
    /// The `workspaces` array (A7 W5 identity gate): `None` when absent or
    /// not an array of strings (unknown — the gate fails closed). Only the
    /// `direct_mount` shape (one host path) is captured.
    pub workspaces: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct RawListRow {
    name: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    workspaces: Option<serde_json::Value>,
}

fn string_array(v: Option<serde_json::Value>) -> Option<Vec<String>> {
    match v? {
        serde_json::Value::Array(items) => items
            .into_iter()
            .map(|i| match i {
                serde_json::Value::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

#[derive(Deserialize)]
struct RawList {
    sandboxes: Vec<RawListRow>,
}

/// The one non-JSON preamble observed on `ls --json` output: printed when the
/// command auto-starts the daemon (captured
/// `state/ls_json_autostarts_daemon.txt`; which stream carried it was not
/// recorded, so it is tolerated on stdout).
const LS_DAEMON_START_PREAMBLE: &str = "Starting sandboxd daemon...";

/// Parse `sbx ls --json` stdout: `{"sandboxes": [...]}`. Fails loudly on any
/// other shape (including a bare array, which no real capture shows).
pub fn parse_list_json(output: &str) -> Result<Vec<SbxListEntry>, SbxError> {
    let mut body = output.trim_start();
    if let Some(rest) = body.strip_prefix(LS_DAEMON_START_PREAMBLE) {
        body = rest.trim_start();
    }
    let raw: RawList = serde_json::from_str(body).map_err(|e| SbxError::Parse(e.to_string()))?;
    Ok(raw
        .sandboxes
        .into_iter()
        .map(|r| SbxListEntry {
            name: r.name,
            // Relayed to clients, so only the captured shapes pass; anything
            // else is ABSENT (review I4/I5), never relayed or rewritten.
            id: r.id.filter(|id| Validator::sbx_sandbox_id(id).is_ok()),
            status: match r.status.as_deref() {
                Some("running") => SbxSandboxStatus::Running,
                Some("stopped") => SbxSandboxStatus::Stopped,
                _ => SbxSandboxStatus::Unknown,
            },
            agent: r.agent.filter(|a| Validator::sbx_reported_agent(a).is_ok()),
            workspaces: string_array(r.workspaces),
        })
        .collect())
}

/// Parse the TEXT form of `sbx daemon status` (design 2026-10-09 §3.8
/// item 1, rule W8). Captured shapes (v0.47.0):
///
/// ```text
/// Status: running            Status: stopped
/// Socket: …                  Socket: … (not connected)
/// Logs: …
/// ```
///
/// After stripping ONE trailing `\n` (any `\r` anywhere → `None`), line 1
/// must be exactly `Status: running` (`Some(true)`) or `Status: stopped`
/// (`Some(false)`), and no later line may begin with `Status:`. Anything
/// else — including a `Starting…` preamble, which means the probe changed
/// machine state — is `None` (unknown). The `Socket:` / `Logs:` lines carry
/// home-directory paths and are never parsed or kept. The exit-status-0 and
/// not-truncated checks belong to the caller.
pub fn parse_daemon_status_text(stdout: &str) -> Option<bool> {
    if stdout.contains('\r') {
        return None;
    }
    let text = stdout.strip_suffix('\n').unwrap_or(stdout);
    // `split('\n')`, never `.lines()`, which silently accepts `\r\n` line
    // ends (any `\r` is already refused above; this keeps the rule local).
    let mut lines = text.split('\n');
    let running = match lines.next()? {
        "Status: running" => true,
        "Status: stopped" => false,
        _ => return None,
    };
    if lines.any(|l| l.starts_with("Status:")) {
        return None;
    }
    Some(running)
}

/// Parse `sbx daemon status --json` (captured
/// `state/daemon_status_running_json.txt`): `"running"` → `Some(true)`,
/// `"stopped"` → `Some(false)`, anything else (other values, non-JSON — the
/// stopped capture exists only in TEXT form) → `None` (unknown). UNUSED by
/// the probe since A8a (it reads [`parse_daemon_status_text`]); kept as a
/// unit-tested fallback. The `"stopped"` arm is illustrative: that JSON form
/// is not captured (C-14).
pub fn parse_daemon_status_json(output: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(output.trim()).ok()?;
    match v.get("status")?.as_str()? {
        "running" => Some(true),
        "stopped" => Some(false),
        _ => None,
    }
}

/// A classified sbx failure ready to become a structured RPC error.
#[derive(Debug, Clone, PartialEq)]
pub struct SbxFailure {
    pub code: ErrorCode,
    pub message: String,
    /// Structured remediation (`hint`, `provider`, `sbxError`). Never secrets:
    /// only sbx's own bounded `error:`/`try:` lines.
    pub details: serde_json::Value,
}

/// Remediation sbx prints for an uninitialized network policy (captured
/// `errors/create_policy_not_initialized.txt`). The choice is the USER's —
/// Core never runs `policy init` itself.
pub const POLICY_INIT_HINT: &str = "sbx policy init <allow-all|balanced|deny-all>";
pub const LOGIN_HINT: &str = "sbx login";

const MAX_ERROR_TEXT: usize = 512;

fn bounded_line(s: &str) -> String {
    let cleaned: String = s.chars().filter(|c| !c.is_control()).collect();
    if cleaned.chars().count() > MAX_ERROR_TEXT {
        let mut t: String = cleaned.chars().take(MAX_ERROR_TEXT).collect();
        t.push('…');
        t
    } else {
        cleaned
    }
}

/// Classify a failed sbx invocation from its stderr against the REAL v0.47.0
/// error format (`error: <msg>` + `  try: <hint>`, exit 1):
/// - `not signed in to Docker` → `PROVIDER_AUTH_REQUIRED` (provider docker,
///   hint `sbx login`);
/// - `global network policy has not been initialized` → `PERMISSION_DENIED`
///   with the `sbx policy init <allow-all|balanced|deny-all>` remediation;
/// - `sandbox '…' not found` → `NOT_FOUND`;
/// - daemon unreachable → `DAEMON_DOWN`. HEURISTIC: no daemon-down error
///   text has been captured (with the daemon stopped, `ls` either auto-starts
///   it or reports sign-in first), so this matches only an `error:` line that
///   names the daemon/socket together with a connection failure;
/// - anything else → `INTERNAL`.
pub fn classify_failure(exit: &str, stderr: &str) -> SbxFailure {
    let error_line = stderr
        .lines()
        .find_map(|l| l.trim().strip_prefix("error:").map(str::trim))
        .map(bounded_line);
    let hint = stderr
        .lines()
        .find_map(|l| l.trim().strip_prefix("try:").map(str::trim))
        .map(bounded_line);
    let msg = error_line
        .clone()
        .unwrap_or_else(|| bounded_line(stderr.trim()));
    let lower = msg.to_ascii_lowercase();
    let mut details = serde_json::json!({ "sbxError": msg });
    if let Some(h) = &hint {
        details["hint"] = serde_json::Value::String(h.clone());
    }

    if lower.contains("not signed in to docker") {
        details["provider"] = "docker".into();
        details["hint"] = LOGIN_HINT.into();
        return SbxFailure {
            code: ErrorCode::ProviderAuthRequired,
            message: format!("Docker sign-in required: sbx reports \"{msg}\" (try: {LOGIN_HINT})"),
            details,
        };
    }
    if lower.contains("global network policy has not been initialized") {
        details["hint"] = POLICY_INIT_HINT.into();
        return SbxFailure {
            code: ErrorCode::PermissionDenied,
            message: format!(
                "sbx refuses to create sandboxes until the global network policy is \
                 initialized; this is a persistent machine-wide choice the user must make: \
                 {POLICY_INIT_HINT}"
            ),
            details,
        };
    }
    if lower.starts_with("sandbox '") && lower.ends_with("' not found") {
        return SbxFailure {
            code: ErrorCode::NotFound,
            message: format!("sbx: {msg}"),
            details,
        };
    }
    let daemon_word = lower.contains("daemon") || lower.contains("sandboxd");
    let conn_failure = [
        "not running",
        "connection refused",
        "cannot connect",
        "could not connect",
        "unreachable",
        "no such file or directory",
    ]
    .iter()
    .any(|p| lower.contains(p));
    if error_line.is_some() && daemon_word && conn_failure {
        return SbxFailure {
            code: ErrorCode::DaemonDown,
            message: format!("sbx daemon not reachable: {msg} (check: sbx daemon status)"),
            details,
        };
    }
    SbxFailure {
        code: ErrorCode::Internal,
        message: format!("sbx exited {exit}: {msg}"),
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: &str = "tests/fixtures/sbx/captured/v0.47.0";

    fn prog() -> PathBuf {
        PathBuf::from("/usr/local/bin/sbx")
    }

    fn fixture(rel: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(CAP).join(rel);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// Captured files wrap the real output with a `$ sbx …` command line and
    /// a trailing `exit=…` line; strip both to get the command's own output.
    fn body(capture: &str) -> String {
        capture
            .lines()
            .filter(|l| !l.starts_with("$ ") && !l.starts_with("exit="))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn exec_file(dir: &Path, name: &str, mode: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join(name);
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(mode)).unwrap();
        bin
    }

    #[test]
    fn captured_meta_is_labeled_captured() {
        let meta = fixture("_meta.json");
        assert!(meta.contains("\"fixture_status\": \"captured\""));
        assert!(meta.contains("\"sbx_version\": \"v0.47.0\""));
    }

    #[test]
    fn locator_finds_executable_in_search_path_and_reports_source() {
        let dir = tempfile::tempdir().unwrap();
        let bin = exec_file(dir.path(), "sbx", 0o755);
        let loc = SbxLocator::with_search(None, vec![dir.path().to_path_buf()]);
        assert_eq!(
            loc.locate_with_source().unwrap(),
            (bin, SbxSource::SearchPath)
        );
    }

    #[test]
    fn locator_skips_non_executable_files() {
        let dir = tempfile::tempdir().unwrap();
        exec_file(dir.path(), "sbx", 0o644);
        let loc = SbxLocator::with_search(None, vec![dir.path().to_path_buf()]);
        assert!(matches!(loc.locate(), Err(SbxError::NotInstalled)));
        let loc = SbxLocator::with_search(Some(dir.path().join("sbx")), vec![]);
        assert!(matches!(loc.locate(), Err(SbxError::NotInstalled)));
    }

    #[test]
    fn locator_reports_not_installed() {
        let loc = SbxLocator::with_search(None, vec![PathBuf::from("/nonexistent-dir-xyz")]);
        assert!(matches!(loc.locate(), Err(SbxError::NotInstalled)));
        // A dangling override is also NotInstalled, never a silent fallback.
        let loc = SbxLocator::with_search(Some(PathBuf::from("/nonexistent/sbx")), vec![]);
        assert!(matches!(loc.locate(), Err(SbxError::NotInstalled)));
    }

    #[test]
    fn locator_prefers_confirmed_override() {
        let dir = tempfile::tempdir().unwrap();
        let bin = exec_file(dir.path(), "custom-sbx", 0o755);
        exec_file(dir.path(), "sbx", 0o755);
        let loc = SbxLocator::with_search(Some(bin.clone()), vec![dir.path().to_path_buf()]);
        assert_eq!(
            loc.locate_with_source().unwrap(),
            (bin, SbxSource::EnvOverride)
        );
    }

    #[test]
    fn version_parsing_against_real_capture() {
        let v = SbxVersion::parse(&fixture("state/version.txt")).unwrap();
        assert_eq!(
            v,
            SbxVersion {
                major: 0,
                minor: 47,
                patch: 0,
                pre: None
            }
        );
        assert_eq!(v.to_string(), "0.47.0");
        assert!(v.at_least(0, 47));
        assert!(!v.at_least(0, 48));
    }

    #[test]
    fn version_parsing_shapes() {
        assert_eq!(
            SbxVersion::parse("1.2.3-beta").unwrap(),
            SbxVersion {
                major: 1,
                minor: 2,
                patch: 3,
                pre: Some("beta".into())
            }
        );
        assert_eq!(
            SbxVersion::parse("1.2.3-beta").unwrap().to_string(),
            "1.2.3-beta"
        );
        // `+build` metadata is dropped; a pre-release keeps its identifier.
        assert_eq!(SbxVersion::parse("v1.2.3+abc").unwrap().pre, None);
        assert_eq!(
            SbxVersion::parse("v1.2.3-rc.1+abc").unwrap().pre.as_deref(),
            Some("rc.1")
        );
        // A malformed pre-release identifier is refused, not guessed.
        assert!(SbxVersion::parse("1.2.3-").is_err());
        assert!(SbxVersion::parse("1.2.3-b@d").is_err());
        // A digit-leading commit hash is never mistaken for the version.
        assert!(SbxVersion::parse("sbx version: 0411f50ee4700fe7").is_err());
        assert!(SbxVersion::parse("no digits here").is_err());
        assert!(SbxVersion::parse("v1.2").is_err());
        assert!(SbxVersion::parse("1.2.x").is_err());
    }

    #[test]
    fn builders_produce_exact_vectors() {
        let p = prog();
        assert_eq!(SbxCommandBuilder::version(&p).args, vec!["version"]);
        assert_eq!(
            SbxCommandBuilder::daemon_status(&p).args,
            vec!["daemon", "status"]
        );
        assert_eq!(
            SbxCommandBuilder::daemon_status_json(&p).args,
            vec!["daemon", "status", "--json"]
        );
        assert_eq!(SbxCommandBuilder::list(&p).args, vec!["ls", "--json"]);
        let repo = Path::new("/repo/atlas");
        assert_eq!(
            SbxCommandBuilder::create(&p, "atlas-auth", "shell", SbxWorkspace::BindMount(repo))
                .unwrap()
                .args,
            vec!["create", "--name", "atlas-auth", "shell", "/repo/atlas"]
        );
        assert_eq!(
            SbxCommandBuilder::create(&p, "atlas-auth", "codex", SbxWorkspace::Clone(repo))
                .unwrap()
                .args,
            vec![
                "create",
                "--clone",
                "--name",
                "atlas-auth",
                "codex",
                "/repo/atlas"
            ]
        );
        assert_eq!(
            SbxCommandBuilder::create(&p, "atlas-auth", "shell", SbxWorkspace::None)
                .unwrap()
                .args,
            vec!["create", "--name", "atlas-auth", "shell"]
        );
        assert_eq!(
            SbxCommandBuilder::stop(&p, "atlas-auth").unwrap().args,
            vec!["stop", "atlas-auth"]
        );
        let ok = RemovalConfirmation::user_confirmed("atlas-auth");
        assert_eq!(
            SbxCommandBuilder::remove(&p, "atlas-auth", &ok)
                .unwrap()
                .args,
            vec!["rm", "--force", "atlas-auth"]
        );
    }

    #[test]
    fn removal_requires_confirmation_for_the_same_sandbox() {
        let other = RemovalConfirmation::user_confirmed("nova-search");
        assert!(SbxCommandBuilder::remove(&prog(), "atlas-auth", &other).is_err());
    }

    /// Every subcommand and flag Sandpane emits must exist in the REAL
    /// captured `--help` of that command: the usage line names the command
    /// path, and each `--flag` appears as a token in its Flags section.
    #[test]
    fn every_emitted_token_exists_in_captured_help() {
        let p = prog();
        let repo = Path::new("/repo/atlas");
        let ok = RemovalConfirmation::user_confirmed("atlas-auth");
        let cases: Vec<(&str, &str, SbxCommand)> = vec![
            (
                "help/version.txt",
                "sbx version",
                SbxCommandBuilder::version(&p),
            ),
            (
                "help/daemon_status.txt",
                "sbx daemon status",
                SbxCommandBuilder::daemon_status(&p),
            ),
            (
                "help/daemon_status.txt",
                "sbx daemon status",
                SbxCommandBuilder::daemon_status_json(&p),
            ),
            ("help/ls.txt", "sbx ls", SbxCommandBuilder::list(&p)),
            (
                "help/create.txt",
                "sbx create",
                SbxCommandBuilder::create(&p, "atlas-auth", "shell", SbxWorkspace::Clone(repo))
                    .unwrap(),
            ),
            (
                "help/stop.txt",
                "sbx stop",
                SbxCommandBuilder::stop(&p, "atlas-auth").unwrap(),
            ),
            (
                "help/rm.txt",
                "sbx rm",
                SbxCommandBuilder::remove(&p, "atlas-auth", &ok).unwrap(),
            ),
        ];
        for (file, usage_prefix, cmd) in cases {
            let help = fixture(file);
            let usage_ok = help
                .lines()
                .skip_while(|l| l.trim() != "Usage:")
                .skip(1)
                .take_while(|l| !l.trim().is_empty())
                .any(|l| l.trim().starts_with(usage_prefix));
            assert!(
                usage_ok,
                "{file}: usage line for {usage_prefix:?} not found"
            );
            // Subcommand words are the usage prefix minus "sbx".
            let words: Vec<&str> = usage_prefix.split_whitespace().skip(1).collect();
            assert_eq!(&cmd.args[..words.len()], words.as_slice(), "{file}");
            let flags: Vec<&str> = help
                .lines()
                .skip_while(|l| l.trim() != "Flags:")
                .skip(1)
                .take_while(|l| !l.trim().is_empty())
                .flat_map(|l| l.split(|c: char| c.is_whitespace() || c == ','))
                .filter(|t| t.starts_with("--"))
                .collect();
            for a in cmd.args.iter().filter(|a| a.starts_with('-')) {
                assert!(
                    flags.contains(&a.as_str()),
                    "{file}: emitted flag {a} is not in the captured Flags section ({flags:?})"
                );
            }
        }
    }

    #[test]
    fn builders_reject_injection_and_bad_inputs() {
        let p = prog();
        for evil in [
            "a;rm -rf /",
            "$(whoami)",
            "`id`",
            "a|b",
            "--privileged",
            "a b",
            "foo\nbar",
            "default",
            "x",
        ] {
            assert!(
                SbxCommandBuilder::create(&p, evil, "shell", SbxWorkspace::None).is_err(),
                "{evil:?}"
            );
            assert!(SbxCommandBuilder::stop(&p, evil).is_err(), "{evil:?}");
        }
        // Agent must be a captured built-in agent, never a kit path/ref.
        assert!(SbxCommandBuilder::create(&p, "ok-name", "./kit", SbxWorkspace::None).is_err());
        // Relative, ':'-carrying (would be read as a `:ro` spec) paths rejected.
        for bad in ["relative/path", "/repo/docs:ro"] {
            assert!(SbxCommandBuilder::create(
                &p,
                "ok-name",
                "shell",
                SbxWorkspace::BindMount(Path::new(bad))
            )
            .is_err());
        }
    }

    #[test]
    fn built_vectors_pass_metachar_tripwire() {
        let c = SbxCommandBuilder::create(
            &prog(),
            "auth-sandbox",
            "shell",
            SbxWorkspace::BindMount(Path::new("/repo/atlas")),
        )
        .unwrap();
        Validator::assert_no_shell_metachars(&c.args).unwrap();
    }

    #[test]
    fn list_parsing_from_real_captures() {
        assert!(parse_list_json(&body(&fixture("state/ls_json_empty.txt")))
            .unwrap()
            .is_empty());
        // The daemon-autostart preamble seen on a real `ls --json`.
        assert!(
            parse_list_json(&body(&fixture("state/ls_json_autostarts_daemon.txt")))
                .unwrap()
                .is_empty()
        );
        let running = parse_list_json(&body(&fixture("crud/02_ls_json_after_create.txt"))).unwrap();
        assert_eq!(
            running,
            vec![SbxListEntry {
                name: "sandpane-p0-probe".into(),
                id: Some("b5ebec73-e2ae-471a-811a-e011cfb1948e".into()),
                status: SbxSandboxStatus::Running,
                agent: Some("shell".into()),
                workspaces: Some(vec!["$SCRATCH/empty-ws".into()]),
            }]
        );
        let stopped = parse_list_json(&body(&fixture("crud/07_ls_json_stopped.txt"))).unwrap();
        assert_eq!(stopped[0].status, SbxSandboxStatus::Stopped);
        assert!(
            parse_list_json(&body(&fixture("crud/09_ls_json_after_rm.txt")))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn unknown_status_is_explicit_and_illustrative_shape_no_longer_matches() {
        let rows = parse_list_json(
            r#"{"sandboxes":[{"name":"a1","status":"paused","extra":1},{"name":"b2"}]}"#,
        )
        .unwrap();
        assert_eq!(rows[0].status, SbxSandboxStatus::Unknown);
        assert_eq!(rows[1].status, SbxSandboxStatus::Unknown);
        // A row without `id` parses with the identity ABSENT, never invented.
        assert_eq!(rows[1].id, None);
        // The hand-written illustrative list.json used `state`, which no real
        // capture has: it now parses only to Unknown, never to a guessed value.
        let meta = include_str!("../tests/fixtures/sbx/_meta.json");
        assert!(meta.contains("\"fixture_status\": \"illustrative\""));
        let illustrative =
            parse_list_json(include_str!("../tests/fixtures/sbx/list.json")).unwrap();
        assert!(illustrative
            .iter()
            .all(|e| e.status == SbxSandboxStatus::Unknown));
    }

    /// Review I4/I5: `id` and `agent` are relayed to clients (confirmation
    /// target, summary), so values outside the captured shapes are dropped
    /// to `None` — never relayed, never "cleaned up" into something else.
    #[test]
    fn malformed_id_and_agent_are_dropped_not_relayed() {
        let rows = parse_list_json(
            r#"{"sandboxes":[
                {"name":"a1","id":"b5ebec73\nforged","agent":"shell\n(verified)","status":"running"},
                {"name":"b2","id":"ok-id-1","agent":"docker-agent","status":"stopped"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(rows[0].id, None);
        assert_eq!(rows[0].agent, None);
        assert_eq!(rows[0].status, SbxSandboxStatus::Running, "row itself kept");
        assert_eq!(rows[1].id.as_deref(), Some("ok-id-1"));
        assert_eq!(rows[1].agent.as_deref(), Some("docker-agent"));
    }

    #[test]
    fn list_parsing_fails_loudly_on_garbage() {
        assert!(parse_list_json("not json").is_err());
        assert!(parse_list_json("{\"unexpected\": true}").is_err());
        assert!(parse_list_json("[{\"name\":\"a1\",\"status\":\"running\"}]").is_err());
        assert!(parse_list_json("Some other preamble\n{\"sandboxes\":[]}").is_err());
    }

    #[test]
    fn daemon_status_parsing() {
        assert_eq!(
            parse_daemon_status_json(&fixture("state/daemon_status_running_json.txt")),
            Some(true)
        );
        assert_eq!(
            parse_daemon_status_json(&body(&fixture("crud/05_daemon_status_json.txt"))),
            Some(true)
        );
        // ILLUSTRATIVE, not captured: the stopped JSON form was never
        // recorded (design 2026-10-09 §3.8 item 1, capture C-14). This arm
        // only pins the parser's own mapping; the probe no longer uses the
        // JSON form at all (it reads the captured TEXT form).
        assert_eq!(
            parse_daemon_status_json(r#"{"status":"stopped"}"#),
            Some(false)
        );
        // The stopped capture exists only as TEXT: unknown, not "stopped".
        assert_eq!(
            parse_daemon_status_json(&fixture("state/daemon_status_stopped.txt")),
            None
        );
        assert_eq!(parse_daemon_status_json(r#"{"status":"starting"}"#), None);
    }

    /// §3.8 W8: both captured text forms read as a clean state.
    #[test]
    fn daemon_status_text_parses_both_captures() {
        // The running capture is the raw output (no `$ ` / `exit=` lines),
        // ending in a newline.
        let running = fixture("state/daemon_status_running.txt");
        assert!(running.ends_with('\n'));
        assert_eq!(parse_daemon_status_text(&running), Some(true));
        // The stopped capture carries a trailing `exit=0` ANNOTATION line
        // (the recorder's, not sbx output); `body` drops it.
        let stopped = fixture("state/daemon_status_stopped.txt");
        assert_eq!(stopped.lines().last(), Some("exit=0"));
        assert_eq!(parse_daemon_status_text(&body(&stopped)), Some(false));
    }

    /// §3.8 W8: anything that is not exactly the captured shape is unknown.
    /// Hostile inputs are raw literals — never routed through `body`, whose
    /// `.lines()` would silently drop a `\r`.
    #[test]
    fn daemon_status_text_refuses_everything_else() {
        let hostile = [
            "",
            "\n",
            "Status: starting\n",
            "Status: running \n",
            " Status: running\n",
            "status: running\n",
            "Status:running\n",
            "Status: running\r\n",
            "Status: running\r\nSocket: x\r\n",
            "Status: running\nSocket: x\r\n",
            "Status: stopped\r",
            "Starting sandboxd daemon...\nStatus: running\n",
            "\nStatus: running\n",
            "extra\nStatus: running\nSocket: x\n",
            "Status: running\nStatus: stopped\n",
            "Status: stopped\nSocket: x\nStatus: running\n",
            "Status: running\nStatus:\n",
            "Status: running\n\nStatus: running\n",
            "{\"status\":\"running\"}\n",
        ];
        for input in hostile {
            assert_eq!(parse_daemon_status_text(input), None, "{input:?}");
        }
        // Exactly ONE trailing newline is stripped; later non-`Status:` lines
        // (the captured Socket:/Logs:) are ignored, never kept.
        assert_eq!(parse_daemon_status_text("Status: running"), Some(true));
        assert_eq!(parse_daemon_status_text("Status: stopped\n"), Some(false));
        assert_eq!(
            parse_daemon_status_text("Status: running\nSocket: $HOME/x.sock\nLogs: $HOME/l\n"),
            Some(true)
        );
    }

    /// §3.8 I3: `CAPTURED_VERSIONS` is exactly the set of version
    /// directories under `captured/` — adding or dropping a capture set
    /// without updating the const (or vice versa) fails here.
    #[test]
    fn captured_versions_match_fixture_directories() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sbx/captured");
        let mut dirs: Vec<String> = std::fs::read_dir(&root)
            .unwrap_or_else(|e| panic!("{}: {e}", root.display()))
            .map(|e| e.unwrap())
            .filter(|e| e.file_type().unwrap().is_dir())
            .map(|e| e.file_name().into_string().unwrap())
            .collect();
        dirs.sort();
        for d in &dirs {
            let v = d
                .strip_prefix('v')
                .unwrap_or_else(|| panic!("captured dir {d:?} is not vX.Y.Z"));
            let parts: Vec<&str> = v.split('.').collect();
            assert!(
                parts.len() == 3
                    && parts
                        .iter()
                        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())),
                "captured dir {d:?} is not vX.Y.Z"
            );
        }
        let mut consts: Vec<String> = CAPTURED_VERSIONS.iter().map(|v| format!("v{v}")).collect();
        consts.sort();
        assert_eq!(dirs, consts);
        assert_eq!(consts, vec!["v0.47.0"]);
    }

    /// The version NUMBER only: the build/commit is not compared
    /// (`SbxVersion` drops it), so a different 0.47.0 build still matches.
    #[test]
    fn version_captured_compares_the_number_only() {
        let v047 = SbxVersion::parse(&fixture("state/version.txt")).unwrap();
        assert!(version_captured(&v047));
        let other_build = SbxVersion::parse("sbx version: v0.47.0 deadbeefcafe").unwrap();
        assert!(version_captured(&other_build));
        for (major, minor, patch) in [(0, 47, 1), (0, 48, 0), (1, 47, 0), (0, 46, 0)] {
            assert!(!version_captured(&SbxVersion {
                major,
                minor,
                patch,
                pre: None
            }));
        }
        // Review W2: a pre-release is never "the same version number".
        let rc = SbxVersion::parse("sbx version: v0.47.0-rc.1 deadbeef").unwrap();
        assert!(!version_captured(&rc));
        assert!(!exec_verified(&rc, std::slice::from_ref(&v047)));
    }

    #[test]
    fn classifies_real_captured_errors() {
        let auth = classify_failure(
            "1",
            &body(&fixture("errors/ls_not_signed_in_daemon_stopped.txt")),
        );
        assert_eq!(auth.code, ErrorCode::ProviderAuthRequired);
        assert!(auth.message.contains("sbx login"), "{}", auth.message);
        assert_eq!(auth.details["provider"], "docker");
        assert_eq!(auth.details["hint"], "sbx login");

        let policy = classify_failure(
            "1",
            &body(&fixture("errors/create_policy_not_initialized.txt")),
        );
        assert_eq!(policy.code, ErrorCode::PermissionDenied);
        assert!(
            policy.message.contains(POLICY_INIT_HINT),
            "{}",
            policy.message
        );
        assert_eq!(policy.details["hint"], POLICY_INIT_HINT);

        for f in [
            "errors/stop_not_found.txt",
            "errors/rm_not_found.txt",
            "crud/10_rm_missing.txt",
        ] {
            let nf = classify_failure("1", &body(&fixture(f)));
            assert_eq!(nf.code, ErrorCode::NotFound, "{f}");
            assert_eq!(nf.details["hint"], "sbx ls", "{f}");
        }
    }

    #[test]
    fn daemon_heuristic_is_narrow_and_default_is_internal() {
        let d = classify_failure(
            "1",
            "error: cannot connect to sandboxd daemon: connection refused\n",
        );
        assert_eq!(d.code, ErrorCode::DaemonDown);
        // The old `contains("connect")` heuristic would misfire on these.
        for other in [
            "error: something about (not connected) socket\n",
            "Status: stopped\nSocket: $HOME/.sbx/run/d/sandboxd.sock (not connected)\n",
            "error: image pull failed\n",
            "",
        ] {
            assert_eq!(
                classify_failure("1", other).code,
                ErrorCode::Internal,
                "{other:?}"
            );
        }
        // Output is bounded and control characters are stripped.
        let long = format!("error: {}\u{7}\n", "x".repeat(5000));
        let f = classify_failure("1", &long);
        assert!(f.message.chars().count() < 700);
        assert!(!f.message.contains('\u{7}'));
    }

    // ---- A7 (design 2026-10-09 §3.7 item 3) ----

    fn sv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// The exact argv shape: `exec`, `--`, NAME, argv… — nothing else (no
    /// -i/-t/-u/-e/-w/--privileged/--cloud), `--` BEFORE the name.
    #[test]
    fn exec_builder_emits_exactly_exec_dashdash_name_argv() {
        let c = SbxCommandBuilder::exec(
            &prog(),
            "atlas-auth",
            &sv(&[
                "printf",
                "[%s]\n",
                "-u",
                "--privileged",
                "-e",
                "X=y",
                "a b",
                "$(id)",
                "*",
                "--",
            ]),
        )
        .unwrap();
        assert_eq!(
            c.args,
            sv(&[
                "exec",
                "--",
                "atlas-auth",
                "printf",
                "[%s]\n",
                "-u",
                "--privileged",
                "-e",
                "X=y",
                "a b",
                "$(id)",
                "*",
                "--"
            ])
        );
        assert_eq!(c.program, prog());
        // Every element after `--` is passed through byte for byte.
        let only = SbxCommandBuilder::exec(&prog(), "nova.v2", &sv(&["make"])).unwrap();
        assert_eq!(only.args, sv(&["exec", "--", "nova.v2", "make"]));
    }

    #[test]
    fn exec_builder_validates_name_and_argv_first() {
        for bad_name in ["-u", "--privileged", "a", "default", "a b", "x;y"] {
            assert!(
                SbxCommandBuilder::exec(&prog(), bad_name, &sv(&["make"])).is_err(),
                "{bad_name:?}"
            );
        }
        assert!(SbxCommandBuilder::exec(&prog(), "atlas-auth", &[]).is_err());
        assert!(SbxCommandBuilder::exec(&prog(), "atlas-auth", &sv(&["-rf"])).is_err());
        assert!(SbxCommandBuilder::exec(&prog(), "atlas-auth", &sv(&[""])).is_err());
    }

    /// `exec` and the usage words come from the captured help; the ONLY
    /// option-shaped token Core itself emits is `--`, before the name
    /// (`--` is the end-of-options marker, not a Flags-section entry).
    #[test]
    fn exec_shape_matches_captured_help() {
        let help = fixture("help/exec.txt");
        assert!(help
            .lines()
            .any(|l| l.trim() == "sbx exec [flags] SANDBOX COMMAND [ARG...]"));
        let c =
            SbxCommandBuilder::exec(&prog(), "atlas-auth", &sv(&["tool", "-x", "--y"])).unwrap();
        assert_eq!(c.args[0], "exec");
        assert_eq!(c.args[1], "--");
        assert_eq!(c.args[2], "atlas-auth");
        // The captured help really does offer the flags Core never passes.
        for f in [
            "--interactive",
            "--tty",
            "--user",
            "--env",
            "--workdir",
            "--privileged",
            "--cloud",
        ] {
            assert!(help.contains(f), "{f} not in captured help");
        }
    }

    #[test]
    fn verified_exec_versions_is_empty_in_production() {
        assert!(VERIFIED_EXEC_VERSIONS.is_empty());
        let v047 = SbxVersion::parse(&fixture("state/version.txt")).unwrap();
        assert!(!exec_verified(&v047, &[]));
        assert!(exec_verified(&v047, std::slice::from_ref(&v047)));
        let other = SbxVersion {
            major: 0,
            minor: 47,
            patch: 1,
            pre: None,
        };
        assert!(!exec_verified(&other, std::slice::from_ref(&v047)));
    }

    /// W4: cleared environment + allowlist (PATH, HOME, USER, LOGNAME,
    /// TMPDIR, LANG, LC_*). Host tokens never reach sbx.
    #[test]
    fn exec_env_keeps_only_the_allowlist() {
        use std::ffi::OsString;
        let vars: Vec<(OsString, OsString)> = [
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/Users/demo"),
            ("USER", "demo"),
            ("LOGNAME", "demo"),
            ("TMPDIR", "/tmp/x"),
            ("LANG", "en_US.UTF-8"),
            ("LC_ALL", "C"),
            ("LC_CTYPE", "UTF-8"),
            ("GITHUB_TOKEN", "ghp_canary"),
            ("AWS_SECRET_ACCESS_KEY", "canary"),
            ("SSH_AUTH_SOCK", "/tmp/agent"),
            ("DOCKER_HOST", "tcp://x"),
            ("SANDPANE_SBX_PATH", "/x/sbx"),
            ("PATHX", "no"),
            ("LCX", "no"),
            ("lang", "no"),
        ]
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect();
        let kept: Vec<String> = exec_env(vars)
            .into_iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            kept,
            sv(&["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"])
        );
    }

    /// R2: one context drives every invocation — cleared env, the allowlist,
    /// the Core-owned cwd.
    #[test]
    fn command_in_context_clears_env_and_sets_cwd() {
        use std::ffi::OsString;
        let ctx = SbxExecContext {
            cwd: PathBuf::from("/core/tmp/run"),
            env: vec![(OsString::from("PATH"), OsString::from("/bin"))],
        };
        let cmd = SbxCommandBuilder::version(&prog()).command_in(&ctx);
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/core/tmp/run")));
        let envs: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(envs, vec![("PATH".to_string(), Some("/bin".to_string()))]);
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), vec!["version"]);
    }

    /// `workspaces` is parsed now (W5 identity gate). Absent or not an array
    /// of strings → `None` (unknown: the gate fails closed).
    #[test]
    fn list_rows_carry_workspaces_when_present() {
        let running = parse_list_json(&body(&fixture("crud/02_ls_json_after_create.txt"))).unwrap();
        assert_eq!(running[0].workspaces, Some(sv(&["$SCRATCH/empty-ws"])));
        let rows = parse_list_json(
            r#"{"sandboxes":[
                {"name":"a1","workspaces":[]},
                {"name":"b2"},
                {"name":"c3","workspaces":"/x"},
                {"name":"d4","workspaces":["/x", 1]}
            ]}"#,
        )
        .unwrap();
        assert_eq!(rows[0].workspaces, Some(vec![]));
        assert_eq!(rows[1].workspaces, None);
        assert_eq!(rows[2].workspaces, None);
        assert_eq!(rows[3].workspaces, None);
    }
}
