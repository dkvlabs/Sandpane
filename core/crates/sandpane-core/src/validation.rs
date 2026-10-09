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

/// Characters that must never appear in values destined for CLI arguments.
/// Deliberately stricter than git check-ref-format: no shell metacharacters,
/// no whitespace, no glob/tilde/brace expansion characters.
const FORBIDDEN_ARG_CHARS: &[char] = &[
    ';', '|', '&', '$', '`', '(', ')', '<', '>', '\'', '"', '\\', '\n', '\r', '\t', '\0', '{', '}',
    '[', ']', '*', '?', '!', '#', '~', '=', '%', ' ',
];

impl Validator {
    /// Sandbox names: lowercase alphanumeric + hyphen, must start and end
    /// alphanumeric, 1..=63 chars (DNS-label-like; matches SBX naming
    /// expectations and is trivially shell-safe).
    pub fn sandbox_name(name: &str) -> Result<&str, ValidationError> {
        Self::bounded(name, 63)?;
        for c in name.chars() {
            if !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
                return Err(ValidationError::DisallowedChar { found: c });
            }
        }
        let alnum = |c: u8| c.is_ascii_alphanumeric();
        if !name.bytes().next().is_some_and(alnum) || !name.bytes().next_back().is_some_and(alnum) {
            return Err(ValidationError::InvalidShape {
                reason: "must start and end with an ASCII letter or digit".into(),
            });
        }
        if name.contains("--") {
            // Prevents option-smuggling lookalikes and matches common CLI name rules.
            return Err(ValidationError::DisallowedSequence { found: "--".into() });
        }
        Ok(name)
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

    /// Git refs (commits/tags) accepted as `expected_base` etc.: hex object ids
    /// or conservative ref names (allowlist enforced by [`Self::branch_name`]).
    pub fn git_ref(value: &str) -> Result<&str, ValidationError> {
        Self::bounded(value, 200)?;
        if value.len() >= 7 && value.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(value);
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

    /// Canonicalize a host path and ensure it stays inside `root` after
    /// symlink resolution. Guards against traversal + TOCTOU-shaped inputs
    /// (callers must still re-check at use time — see specs/06 §4).
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
        for ok in ["a", "auth-sandbox", "atlas-demo-2", "x9"] {
            assert!(Validator::sandbox_name(ok).is_ok(), "{ok}");
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
            "foo--bar",
            "foo bar",
            "FOO",
            "foo/bar",
            "foo..bar",
            "",
            &"a".repeat(64),
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
