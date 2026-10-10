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
        Some(Self {
            major: major.parse().ok()?,
            minor: minor.parse().ok()?,
            patch: patch_digits.parse().ok()?,
        })
    }

    pub fn at_least(&self, major: u32, minor: u32) -> bool {
        (self.major, self.minor) >= (major, minor)
    }
}

impl std::fmt::Display for SbxVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
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

    /// `sbx daemon status --json` — a read-only probe. NOT `ls`, which
    /// auto-starts the daemon (captured `state/ls_json_autostarts_daemon.txt`).
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
        })
        .collect())
}

/// Parse `sbx daemon status --json` (captured
/// `state/daemon_status_running_json.txt`): `"running"` → `Some(true)`,
/// `"stopped"` → `Some(false)`, anything else (other values, non-JSON — the
/// stopped capture exists only in TEXT form) → `None` (unknown).
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
                patch: 0
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
                patch: 3
            }
        );
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
}
