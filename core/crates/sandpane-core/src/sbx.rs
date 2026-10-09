//! SBX CLI adapter (docs/specs/02 §5, docs/specs/06 §2/§4).
//!
//! This module NEVER executes a shell. Every command is a fixed executable +
//! argument vector built by [`SbxCommand`]; every external value passes
//! [`crate::validation`] first. Command/flag shapes here are ILLUSTRATIVE
//! until pinned against a real CLI during P0 (docs/compatibility.md) — the
//! fixtures under `tests/fixtures/sbx/` are hand-written samples marked
//! `"fixture_status": "illustrative"`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

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
        if let Some(p) = &self.override_path {
            if p.is_file() {
                return Ok(p.clone());
            }
            return Err(SbxError::NotInstalled);
        }
        for dir in &self.search_path {
            let candidate = dir.join("sbx");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        Err(SbxError::NotInstalled)
    }
}

/// Version parsing from `sbx --version` style output. Fixture-backed; the
/// exact real format is a P0 capture task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SbxVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl SbxVersion {
    /// Parse from illustrative fixture shapes like `sbx version 0.4.2` or
    /// plain `0.4.2`. Fails loudly rather than guessing (specs/08 §3).
    pub fn parse(output: &str) -> Result<Self, SbxError> {
        let token = output
            .split_whitespace()
            .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .ok_or_else(|| SbxError::Parse(format!("no version token in {output:?}")))?;
        let mut parts = token.trim_start_matches('v').split('.');
        let (Some(major), Some(minor), Some(patch)) = (parts.next(), parts.next(), parts.next())
        else {
            return Err(SbxError::Parse(format!("not semver-ish: {token:?}")));
        };
        // patch may carry a suffix like `2-beta`; keep the leading digits.
        let patch_digits: String = patch.chars().take_while(|c| c.is_ascii_digit()).collect();
        Ok(Self {
            major: major.parse().map_err(|_| SbxError::Parse(token.into()))?,
            minor: minor.parse().map_err(|_| SbxError::Parse(token.into()))?,
            patch: patch_digits
                .parse()
                .map_err(|_| SbxError::Parse(token.into()))?,
        })
    }

    pub fn at_least(&self, major: u32, minor: u32) -> bool {
        (self.major, self.minor) >= (major, minor)
    }
}

/// A fully-built, injection-safe SBX invocation: fixed program + argument
/// vector, ready for `std::process::Command`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SbxCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Typed command builders for the documented sandbox lifecycle. Each builder
/// validates its inputs; the resulting vectors must be passed to
/// `Command::new(program).args(args)` — never to a shell.
pub struct SbxCommandBuilder;

impl SbxCommandBuilder {
    pub fn list(program: &Path, json: bool) -> SbxCommand {
        let mut args = vec!["sandbox".to_string(), "list".to_string()];
        if json {
            // Illustrative flag; pin against the real CLI during P0.
            args.push("--format".to_string());
            args.push("json".to_string());
        }
        SbxCommand {
            program: program.to_path_buf(),
            args,
        }
    }

    pub fn create(
        program: &Path,
        name: &str,
        workspace_mode_mount: Option<&Path>,
    ) -> Result<SbxCommand, SbxError> {
        Validator::sandbox_name(name)?;
        let mut args = vec![
            "sandbox".to_string(),
            "create".to_string(),
            "--name".to_string(),
            name.to_string(),
        ];
        if let Some(mount) = workspace_mode_mount {
            if !mount.is_absolute() {
                return Err(SbxError::Validation(ValidationError::NotAbsolute {
                    path: mount.display().to_string(),
                }));
            }
            args.push("--mount".to_string());
            args.push(mount.display().to_string());
        }
        Ok(SbxCommand {
            program: program.to_path_buf(),
            args,
        })
    }

    pub fn start(program: &Path, name: &str) -> Result<SbxCommand, SbxError> {
        Validator::sandbox_name(name)?;
        Ok(SbxCommand {
            program: program.to_path_buf(),
            args: vec!["sandbox".into(), "start".into(), name.into()],
        })
    }

    pub fn stop(program: &Path, name: &str) -> Result<SbxCommand, SbxError> {
        Validator::sandbox_name(name)?;
        Ok(SbxCommand {
            program: program.to_path_buf(),
            args: vec!["sandbox".into(), "stop".into(), name.into()],
        })
    }

    /// Destructive: callers must have recorded explicit user confirmation AND
    /// re-probed state before invoking (specs/02 §5, specs/06 §4).
    pub fn remove(program: &Path, name: &str) -> Result<SbxCommand, SbxError> {
        Validator::sandbox_name(name)?;
        Ok(SbxCommand {
            program: program.to_path_buf(),
            args: vec!["sandbox".into(), "remove".into(), name.into()],
        })
    }

    pub fn inspect(program: &Path, name: &str, json: bool) -> Result<SbxCommand, SbxError> {
        Validator::sandbox_name(name)?;
        let mut args = vec!["sandbox".into(), "inspect".into(), name.into()];
        if json {
            args.push("--format".into());
            args.push("json".into());
        }
        Ok(SbxCommand {
            program: program.to_path_buf(),
            args,
        })
    }

    pub fn version(program: &Path) -> SbxCommand {
        SbxCommand {
            program: program.to_path_buf(),
            args: vec!["--version".into()],
        }
    }
}

/// Illustrative shape of `sbx sandbox list --format json` output. Fields are
/// guesses until a real capture replaces them (fixture_status discipline).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SbxListEntry {
    pub name: String,
    pub state: String,
}

pub fn parse_list_json(output: &str) -> Result<Vec<SbxListEntry>, SbxError> {
    // Accept either a bare array or {"sandboxes": [...]} — both illustrative.
    if let Ok(entries) = serde_json::from_str::<Vec<SbxListEntry>>(output) {
        return Ok(entries);
    }
    let wrapper: serde_json::Value =
        serde_json::from_str(output).map_err(|e| SbxError::Parse(e.to_string()))?;
    let arr = wrapper
        .get("sandboxes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| SbxError::Parse("no sandboxes array".into()))?;
    serde_json::from_value(arr.clone().into()).map_err(|e| SbxError::Parse(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prog() -> PathBuf {
        PathBuf::from("/usr/local/bin/sbx")
    }

    #[test]
    fn locator_finds_binary_in_search_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("sbx");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        let loc = SbxLocator::with_search(None, vec![dir.path().to_path_buf()]);
        assert_eq!(loc.locate().unwrap(), bin);
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
        let bin = dir.path().join("custom-sbx");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        let loc = SbxLocator::with_search(Some(bin.clone()), vec![dir.path().to_path_buf()]);
        assert_eq!(loc.locate().unwrap(), bin);
    }

    #[test]
    fn version_parsing() {
        assert_eq!(
            SbxVersion::parse("sbx version 0.4.2").unwrap(),
            SbxVersion {
                major: 0,
                minor: 4,
                patch: 2
            }
        );
        assert_eq!(
            SbxVersion::parse("1.2.3-beta").unwrap(),
            SbxVersion {
                major: 1,
                minor: 2,
                patch: 3
            }
        );
        assert!(SbxVersion::parse("no digits here").is_err());
        let v = SbxVersion::parse("0.4.2").unwrap();
        assert!(v.at_least(0, 4));
        assert!(!v.at_least(0, 5));
    }

    #[test]
    fn builders_produce_exact_vectors() {
        let p = prog();
        assert_eq!(
            SbxCommandBuilder::list(&p, true).args,
            vec!["sandbox", "list", "--format", "json"]
        );
        let c =
            SbxCommandBuilder::create(&p, "auth-sandbox", Some(Path::new("/repo/atlas"))).unwrap();
        assert_eq!(
            c.args,
            vec![
                "sandbox",
                "create",
                "--name",
                "auth-sandbox",
                "--mount",
                "/repo/atlas"
            ]
        );
        assert_eq!(
            SbxCommandBuilder::stop(&p, "auth-sandbox").unwrap().args,
            vec!["sandbox", "stop", "auth-sandbox"]
        );
        assert_eq!(
            SbxCommandBuilder::remove(&p, "auth-sandbox").unwrap().args,
            vec!["sandbox", "remove", "auth-sandbox"]
        );
    }

    #[test]
    fn builders_reject_injection_in_names() {
        let p = prog();
        for evil in [
            "a;rm -rf /",
            "$(whoami)",
            "`id`",
            "a|b",
            "--privileged",
            "a b",
            "foo\nbar",
        ] {
            assert!(
                SbxCommandBuilder::create(&p, evil, None).is_err(),
                "{evil:?}"
            );
            assert!(SbxCommandBuilder::start(&p, evil).is_err(), "{evil:?}");
            assert!(
                SbxCommandBuilder::inspect(&p, evil, false).is_err(),
                "{evil:?}"
            );
        }
        // Relative mount paths rejected.
        assert!(
            SbxCommandBuilder::create(&p, "ok-name", Some(Path::new("relative/path"))).is_err()
        );
    }

    #[test]
    fn built_vectors_pass_metachar_tripwire() {
        let p = prog();
        let c =
            SbxCommandBuilder::create(&p, "auth-sandbox", Some(Path::new("/repo/atlas"))).unwrap();
        Validator::assert_no_shell_metachars(&c.args).unwrap();
    }

    #[test]
    fn list_parsing_from_illustrative_fixture() {
        let fixture = include_str!("../tests/fixtures/sbx/list.json");
        let meta = include_str!("../tests/fixtures/sbx/_meta.json");
        // The fixture must declare itself illustrative until a real capture exists.
        assert!(meta.contains("\"fixture_status\": \"illustrative\""));
        let entries = parse_list_json(fixture).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "atlas-auth");
        assert_eq!(entries[1].state, "stopped");
    }

    #[test]
    fn list_parsing_fails_loudly_on_garbage() {
        assert!(parse_list_json("not json").is_err());
        assert!(parse_list_json("{\"unexpected\": true}").is_err());
    }
}
