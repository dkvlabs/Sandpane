//! Strict input validation — the first line of defense against command
//! injection, path traversal, and argument smuggling (docs/specs/06 §4).
//!
//! Nothing here executes anything; these are pure predicates + canonicalizers.

use std::path::{Component, Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("value is empty")]
    Empty,
    #[error("value exceeds max length {max}")]
    TooLong { max: usize },
    #[error("value contains a disallowed character: {found:?}")]
    DisallowedChar { found: char },
    #[error("value contains a disallowed sequence: {found:?}")]
    DisallowedSequence { found: String },
    #[error("value has an invalid shape: {reason}")]
    InvalidShape { reason: String },
    #[error("path is not absolute: {path}")]
    NotAbsolute { path: String },
    #[error("path escapes its allowed root")]
    PathEscapesRoot,
}

pub struct Validator;

/// System trees that are never registrable as repositories (security W1).
/// `/private/var` (macOS temp dirs) is deliberately NOT listed.
pub const SYSTEM_TREES: &[&str] = &[
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/dev",
    "/proc",
    "/sys",
    "/boot",
    "/System",
    "/Library",
    "/private/etc",
    "/cores",
];

/// Built-in agents listed by the captured `sbx v0.47.0 create --help`
/// ("Available agents: …", fixture `help/create.txt`).
pub const SBX_AGENTS_V0_47: &[&str] = &[
    "claude",
    "codex",
    "copilot",
    "cursor",
    "devin",
    "docker-agent",
    "droid",
    "gemini",
    "kiro",
    "opencode",
    "shell",
];

/// Characters that must never appear in values destined for CLI arguments.
/// Deliberately stricter than git check-ref-format: no shell metacharacters,
/// no whitespace, no glob/tilde/brace expansion characters.
const FORBIDDEN_ARG_CHARS: &[char] = &[
    ';', '|', '&', '$', '`', '(', ')', '<', '>', '\'', '"', '\\', '\n', '\r', '\t', '\0', '{', '}',
    '[', ']', '*', '?', '!', '#', '~', '=', '%', ' ',
];

impl Validator {
    /// Sandbox names, per the rule `sbx v0.47.0 create --help` documents for
    /// `--name` (captured fixture `help/create.txt`): "at least two
    /// characters, starting with a letter or number, containing only letters,
    /// numbers, hyphens and periods … 'default' is reserved". Uppercase and
    /// periods are therefore accepted so Core can ADDRESS sandboxes SBX
    /// itself named (its default is `<agent>-<workdir>`). The 128-char bound
    /// is Sandpane's own sanity limit (sbx documents none). A leading letter
    /// or digit means no value can ever be read as an option.
    pub fn sandbox_name(name: &str) -> Result<&str, ValidationError> {
        Self::bounded(name, 128)?;
        for c in name.chars() {
            if !(c.is_ascii_alphanumeric() || c == '-' || c == '.') {
                return Err(ValidationError::DisallowedChar { found: c });
            }
        }
        if name.chars().count() < 2 {
            return Err(ValidationError::InvalidShape {
                reason: "sandbox name must be at least two characters".into(),
            });
        }
        if !name
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        {
            return Err(ValidationError::InvalidShape {
                reason: "sandbox name must start with an ASCII letter or digit".into(),
            });
        }
        if name.eq_ignore_ascii_case("default") {
            return Err(ValidationError::InvalidShape {
                reason: "'default' is a reserved sandbox name".into(),
            });
        }
        Ok(name)
    }

    /// Built-in agent for `sbx create AGENT`, from the captured `sbx v0.47.0
    /// create --help` "Available agents" line. Sandbox-kit references (paths,
    /// ZIPs, git/OCI refs) are deliberately NOT accepted.
    pub fn sbx_agent(agent: &str) -> Result<&str, ValidationError> {
        if SBX_AGENTS_V0_47.contains(&agent) {
            Ok(agent)
        } else {
            Err(ValidationError::InvalidShape {
                reason: format!("{agent:?} is not a built-in sbx v0.47 agent"),
            })
        }
    }

    /// A client-chosen idempotency key (A2, design 2026-10-09 §3.1):
    /// 1..=128 chars of `[A-Za-z0-9._-]` — enough for 128-bit random hex or
    /// base64url, nothing that could be mistaken for markup or a path.
    pub fn idempotency_key(key: &str) -> Result<&str, ValidationError> {
        Self::reported_token(key, 128, |c| {
            c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'
        })
    }

    /// An sbx sandbox `id` as printed by `ls --json`, restricted to the
    /// captured shape (a UUID: `[A-Za-z0-9-]{1,64}`). It is echoed to clients
    /// as the confirmation target identity, so anything else (newlines,
    /// spaces, punctuation) is refused rather than relayed (review I4).
    pub fn sbx_sandbox_id(id: &str) -> Result<&str, ValidationError> {
        Self::reported_token(id, 64, |c| c.is_ascii_alphanumeric() || c == '-')
    }

    /// The agent name sbx REPORTS for a sandbox in `ls --json`: a plain token
    /// `[A-Za-z0-9._-]{1,64}`. Deliberately a charset check, not the
    /// built-in allowlist — sbx may report an agent Sandpane would never
    /// create (e.g. a kit the user installed), and that is still a true fact
    /// to show; what is refused is text that could spoof UI (review I5).
    pub fn sbx_reported_agent(agent: &str) -> Result<&str, ValidationError> {
        Self::reported_token(agent, 64, |c| {
            c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_'
        })
    }

    fn reported_token(
        s: &str,
        max: usize,
        ok: impl Fn(char) -> bool,
    ) -> Result<&str, ValidationError> {
        if s.is_empty() {
            return Err(ValidationError::Empty);
        }
        if s.len() > max {
            return Err(ValidationError::TooLong { max });
        }
        if let Some(c) = s.chars().find(|c| !ok(*c)) {
            return Err(ValidationError::DisallowedChar { found: c });
        }
        Ok(s)
    }

    /// A host workspace path for `sbx create AGENT PATH`: absolute, valid
    /// UTF-8, no control characters, and no `:` — sbx parses `PATH:ro` as a
    /// read-only mount spec (captured `create --help` example), so a colon in
    /// the path would change the mount's meaning.
    pub fn sbx_workspace_path(path: &Path) -> Result<&str, ValidationError> {
        let Some(s) = path.to_str() else {
            return Err(ValidationError::InvalidShape {
                reason: "workspace path must be valid UTF-8".into(),
            });
        };
        if !path.is_absolute() {
            return Err(ValidationError::NotAbsolute { path: s.into() });
        }
        Self::bounded(s, 4096)?;
        for c in s.chars() {
            if c == ':' || c.is_control() {
                return Err(ValidationError::DisallowedChar { found: c });
            }
        }
        Ok(s)
    }

    /// Security W1: may this CANONICAL path be registered as a project
    /// repository (and therefore later bind-mounted, possibly live-writable)?
    /// Refuses `/`, the home directory and every ancestor of it, anything
    /// under a hidden top-level entry of home (`~/.ssh`, `~/.config`, …), and
    /// system trees. Pure: callers canonicalize `candidate` and `home` first
    /// and separately require the path to be a Git work-tree top level.
    pub fn registrable_repository(candidate: &Path, home: &Path) -> Result<(), ValidationError> {
        let refuse = |why: &str| {
            Err(ValidationError::InvalidShape {
                reason: format!("{} cannot be registered: {why}", candidate.display()),
            })
        };
        if !candidate.is_absolute() {
            return Err(ValidationError::NotAbsolute {
                path: candidate.display().to_string(),
            });
        }
        if candidate.parent().is_none() {
            return refuse("the filesystem root");
        }
        if home.starts_with(candidate) {
            return refuse("the home directory or one of its ancestors");
        }
        if let Ok(rest) = candidate.strip_prefix(home) {
            if let Some(Component::Normal(first)) = rest.components().next() {
                if first.to_string_lossy().starts_with('.') {
                    return refuse("a hidden directory in home (credentials/config live there)");
                }
            }
        }
        for sys in SYSTEM_TREES {
            if candidate.starts_with(sys) {
                return refuse("a system directory");
            }
        }
        Ok(())
    }

    /// A FULL Git object id (SHA-1: 40 hex, SHA-256: 64 hex). Used for every
    /// base-commit ASSERTION: an abbreviation is not an identity (security W3).
    pub fn full_object_id(value: &str) -> Result<&str, ValidationError> {
        if (value.len() == 40 || value.len() == 64) && value.chars().all(|c| c.is_ascii_hexdigit())
        {
            Ok(value)
        } else {
            Err(ValidationError::InvalidShape {
                reason: "expected a full 40- or 64-hex-digit object id".into(),
            })
        }
    }

    /// Git branch names for task branches (sandpane/<task-id> style enforced by
    /// callers; this validates safety, not the prefix policy).
    ///
    /// Allowlist `[A-Za-z0-9._/-]` + git structural rules: Sandpane only
    /// generates `sandpane/<id>` branches, and a strict allowlist keeps shell
    /// metacharacters out of every CLI argument vector by construction.
    /// Recorded trade-off (review 0004 #20): refs with `+` or `,` are refused
    /// too — acceptable while Core owns branch naming; a future user-ref
    /// surface needs its own resolver (`rev-parse`), not a wider allowlist.
    pub fn branch_name(name: &str) -> Result<&str, ValidationError> {
        Self::bounded(name, 200)?;
        for c in name.chars() {
            if !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | '.')) {
                return Err(ValidationError::DisallowedChar { found: c });
            }
        }
        for seq in ["..", "//", ".lock", "./", "/."] {
            if name.contains(seq) {
                return Err(ValidationError::DisallowedSequence { found: seq.into() });
            }
        }
        if name.starts_with('-')
            || name.starts_with('.')
            || name.ends_with('/')
            || name.ends_with('.')
        {
            return Err(ValidationError::InvalidShape {
                reason: "branch may not start with '-' or '.', end with '/' or '.'".into(),
            });
        }
        Ok(name)
    }

    /// Git revisions used as diff/worktree bases: hex object ids of at least
    /// 7 digits or conservative ref names (allowlist enforced by
    /// [`Self::branch_name`]). An all-hex value SHORTER than 7 is refused: it
    /// is an ambiguous abbreviation, not a name (security W3 — `"3"` used to
    /// pass as a "branch"). Base ASSERTIONS use [`Self::full_object_id`].
    pub fn git_ref(value: &str) -> Result<&str, ValidationError> {
        Self::bounded(value, 200)?;
        if value.chars().all(|c| c.is_ascii_hexdigit()) {
            if value.len() >= 7 {
                return Ok(value);
            }
            return Err(ValidationError::InvalidShape {
                reason: "abbreviated object id shorter than 7 hex digits".into(),
            });
        }
        Self::branch_name(value)
    }

    /// Project/conversation titles and other human text destined for storage
    /// (not for CLI args). Rejects only control characters; Unicode allowed.
    pub fn display_text(value: &str, max: usize) -> Result<&str, ValidationError> {
        Self::bounded(value, max)?;
        for c in value.chars() {
            if (c as u32) < 0x20 && c != '\n' && c != '\t' || c as u32 == 0x7f {
                return Err(ValidationError::DisallowedChar { found: c });
            }
        }
        Ok(value)
    }

    /// Ports: only the loopback-publishable range Sandpane supports.
    pub fn port(value: u16) -> Result<u16, ValidationError> {
        if value == 0 {
            return Err(ValidationError::InvalidShape {
                reason: "port 0 is not publishable".into(),
            });
        }
        Ok(value)
    }

    /// LEXICAL containment check: normalize `.`/`..` in both paths (no
    /// filesystem access, NO symlink resolution) and require `candidate` to
    /// stay under `root`. Callers handling real host paths must
    /// `std::fs::canonicalize` both sides first (as `sandbox.create` does) and
    /// re-check at use time (specs/06 §4); this alone does not stop a
    /// symlink escape (security S4).
    pub fn path_within_root(root: &Path, candidate: &Path) -> Result<PathBuf, ValidationError> {
        if !candidate.is_absolute() {
            return Err(ValidationError::NotAbsolute {
                path: candidate.display().to_string(),
            });
        }
        let root_c = Self::lexically_normalize(root);
        let cand_c = Self::lexically_normalize(candidate);
        if !cand_c.starts_with(&root_c) {
            return Err(ValidationError::PathEscapesRoot);
        }
        Ok(cand_c)
    }

    /// Lexical normalization: resolves `.`/`..` components without touching
    /// the filesystem (symlink resolution is the caller's job via
    /// `std::fs::canonicalize` where the path must exist).
    pub fn lexically_normalize(path: &Path) -> PathBuf {
        let mut out = PathBuf::new();
        for comp in path.components() {
            match comp {
                Component::CurDir => {}
                Component::ParentDir => {
                    if !out.pop() {
                        out.push("..");
                    }
                }
                other => out.push(other.as_os_str()),
            }
        }
        if out.as_os_str().is_empty() {
            out.push(".");
        }
        out
    }

    /// Defense-in-depth check used in tests/adapters: assert a fully-built
    /// argument vector contains no shell metacharacter sequences. Argument
    /// vectors are NEVER passed through a shell, so this is a tripwire, not a
    /// sanitizer.
    pub fn assert_no_shell_metachars(args: &[String]) -> Result<(), ValidationError> {
        for a in args {
            for seq in ["$(", "`", "&&", "||", ";\n", "\n"] {
                if a.contains(seq) {
                    return Err(ValidationError::DisallowedSequence { found: seq.into() });
                }
            }
        }
        Ok(())
    }

    fn bounded(value: &str, max: usize) -> Result<(), ValidationError> {
        if value.is_empty() {
            return Err(ValidationError::Empty);
        }
        if value.chars().count() > max {
            return Err(ValidationError::TooLong { max });
        }
        Ok(())
    }
}

/// Convenience trait so `FORBIDDEN_ARG_CHARS` stays referenced (strict char
/// rejection for values that will become standalone CLI arguments).
pub fn contains_forbidden_arg_char(value: &str) -> Option<char> {
    value.chars().find(|c| FORBIDDEN_ARG_CHARS.contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_name_accepts_valid() {
        // Includes sbx's own default shape `<agent>-<workdir>` with uppercase
        // and periods (documented as legal by `sbx create --help`).
        for ok in [
            "ab",
            "auth-sandbox",
            "atlas-demo-2",
            "x9",
            "claude-My.Project",
            "Shell-atlas.v2",
            "defaults",
        ] {
            assert!(Validator::sandbox_name(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn sandbox_name_enforces_sbx_documented_rules() {
        // < 2 chars, reserved 'default' (any case), leading '-'/'.'.
        for bad in ["a", "7", "default", "DEFAULT", "Default", "-ab", ".ab"] {
            assert!(Validator::sandbox_name(bad).is_err(), "accepted: {bad:?}");
        }
        assert!(Validator::sandbox_name(&"a".repeat(128)).is_ok());
        assert!(Validator::sandbox_name(&"a".repeat(129)).is_err());
    }

    #[test]
    fn sbx_agent_allowlist_matches_captured_help() {
        let help = include_str!("../tests/fixtures/sbx/captured/v0.47.0/help/create.txt");
        let line = help
            .lines()
            .find_map(|l| l.strip_prefix("Available agents: "))
            .expect("captured create --help lists agents");
        let captured: Vec<&str> = line.split(", ").map(str::trim).collect();
        assert_eq!(captured, SBX_AGENTS_V0_47);
        for a in SBX_AGENTS_V0_47 {
            assert!(Validator::sbx_agent(a).is_ok());
        }
        for bad in ["", "Shell", "./my-kit", "../kit.zip", "--clone", "oci://x"] {
            assert!(Validator::sbx_agent(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn idempotency_key_charset_and_bounds() {
        let max = "a".repeat(128);
        for ok in [
            "k",
            "AZaz09._-",
            "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
            max.as_str(),
        ] {
            assert_eq!(Validator::idempotency_key(ok), Ok(ok), "{ok:?}");
        }
        let long = "a".repeat(129);
        for bad in [
            "",
            long.as_str(),
            "a b",
            "a/b",
            "a+b",
            "a=",
            "ä",
            "k\n",
            "a;rm",
        ] {
            assert!(Validator::idempotency_key(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn sbx_sandbox_id_accepts_only_the_captured_shape() {
        for ok in [
            "b5ebec73-e2ae-471a-811a-e011cfb1948e",
            "a",
            "ABC-123",
            &"a".repeat(64),
        ] {
            assert_eq!(Validator::sbx_sandbox_id(ok), Ok(ok), "{ok:?}");
        }
        for bad in [
            "",
            "b5ebec73\nforged",
            "id with space",
            "id;rm",
            "id.dot",
            "id_underscore",
            "ünïcode",
            &"a".repeat(65),
        ] {
            assert!(Validator::sbx_sandbox_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn sbx_reported_agent_accepts_only_a_plain_token() {
        for ok in [
            "shell",
            "docker-agent",
            "my.kit_v2",
            "Claude",
            &"a".repeat(64),
        ] {
            assert_eq!(Validator::sbx_reported_agent(ok), Ok(ok), "{ok:?}");
        }
        for bad in [
            "",
            "shell\n(verified)",
            "two words",
            "https://example.invalid/kit",
            "\u{1b}[31mred",
            &"a".repeat(65),
        ] {
            assert!(Validator::sbx_reported_agent(bad).is_err(), "{bad:?}");
        }
    }

    /// `schemas/sandbox-create-spec.schema.json` `agent.enum` is not part of
    /// the value-set drift gate, so it is pinned here to the same allowlist.
    #[test]
    fn schema_agent_enum_matches_the_allowlist() {
        let schema: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../schemas/sandbox-create-spec.schema.json"
        ))
        .unwrap();
        let listed: Vec<&str> = schema["properties"]["agent"]["enum"]
            .as_array()
            .expect("agent enum present")
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(listed, SBX_AGENTS_V0_47);
    }

    #[test]
    fn sbx_workspace_path_rules() {
        assert_eq!(
            Validator::sbx_workspace_path(Path::new("/repo/atlas")).unwrap(),
            "/repo/atlas"
        );
        for bad in ["relative/x", "/repo/docs:ro", "/a\nb", "/a:b/c"] {
            assert!(
                Validator::sbx_workspace_path(Path::new(bad)).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn registrable_repository_denylist() {
        let home = Path::new("/Users/dev");
        for ok in [
            "/Users/dev/code/atlas",
            "/Users/dev/projects/nova-demo",
            "/private/var/folders/x/T/tmp1/repo",
            "/opt/src/orbit",
        ] {
            assert!(
                Validator::registrable_repository(Path::new(ok), home).is_ok(),
                "{ok}"
            );
        }
        for bad in [
            "/",
            "/Users",
            "/Users/dev",
            "/Users/dev/.ssh",
            "/Users/dev/.config/git",
            "/etc",
            "/etc/x",
            "/usr/local/src/repo",
            "/System/Library",
            "/Library/x",
            "/private/etc/x",
            "relative/repo",
        ] {
            assert!(
                Validator::registrable_repository(Path::new(bad), home).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn full_object_id_is_exact_length_hex() {
        assert!(Validator::full_object_id(&"a".repeat(40)).is_ok());
        assert!(Validator::full_object_id(&"0".repeat(64)).is_ok());
        for bad in [
            "3",
            "abc1234",
            &"a".repeat(39),
            &"g".repeat(40),
            &"a".repeat(41),
        ] {
            assert!(Validator::full_object_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn sandbox_name_rejects_injection_corpus() {
        // T24: shell metacharacters, unicode tricks, option smuggling.
        for bad in [
            "foo; rm -rf /",
            "foo|bar",
            "foo$(whoami)",
            "foo`id`",
            "foo\nbar",
            "--privileged",
            "-x",
            "foo bar",
            "foo/bar",
            "foo:bar",
            "foo_bar",
            "",
            &"a".repeat(129),
        ] {
            assert!(Validator::sandbox_name(bad).is_err(), "accepted: {bad:?}");
        }
    }

    #[test]
    fn branch_name_rules() {
        assert!(Validator::branch_name("sandpane/task-001").is_ok());
        for bad in [
            "a..b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "-lead", "trail/",
            "trail.", "a//b", "x@{y", "ref.lock", "$(evil)", "a`b", "a;b", "a|b", "a&b", ".hidden",
            "./x", "a/./b",
        ] {
            assert!(Validator::branch_name(bad).is_err(), "accepted: {bad:?}");
        }
    }

    #[test]
    fn git_ref_accepts_hex_and_names() {
        assert!(Validator::git_ref("0123abc4567def").is_ok());
        assert!(Validator::git_ref("main").is_ok());
        assert!(Validator::git_ref("feat/x").is_ok());
        assert!(Validator::git_ref("$(git evil)").is_err());
        // Short all-hex values are ambiguous abbreviations, not names (W3).
        for short in ["3", "abc", "abc123"] {
            assert!(Validator::git_ref(short).is_err(), "{short}");
        }
    }

    #[test]
    fn display_text_allows_unicode_rejects_controls() {
        assert!(Validator::display_text("Implementación ✓ 日本語", 100).is_ok());
        assert!(Validator::display_text("has\u{0}nul", 100).is_err());
        assert!(Validator::display_text("new\nline\tok", 100).is_ok());
    }

    #[test]
    fn path_containment() {
        let root = Path::new("/home/u/projects/atlas");
        assert!(Validator::path_within_root(root, Path::new("/home/u/projects/atlas/src")).is_ok());
        assert!(
            Validator::path_within_root(root, Path::new("/home/u/projects/atlas/../../nova"))
                .is_err()
        );
        assert!(Validator::path_within_root(root, Path::new("relative/src")).is_err());
    }

    #[test]
    fn lexical_normalization() {
        let n = Validator::lexically_normalize(Path::new("/a/b/../c/./d"));
        assert_eq!(n, PathBuf::from("/a/c/d"));
    }

    #[test]
    fn metachar_tripwire() {
        assert!(Validator::assert_no_shell_metachars(&["ls".into(), "-la".into()]).is_ok());
        assert!(Validator::assert_no_shell_metachars(&["foo $(bar)".into()]).is_err());
    }

    #[test]
    fn forbidden_chars_cover_shell_surface() {
        assert_eq!(contains_forbidden_arg_char("safe-name_1"), None);
        assert_eq!(contains_forbidden_arg_char("a;b"), Some(';'));
        assert_eq!(contains_forbidden_arg_char("a b"), Some(' '));
    }
}
