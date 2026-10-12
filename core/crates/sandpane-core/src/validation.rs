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

/// `project.update` description cap (A3a §3.2 item 1), in characters.
pub const MAX_PROJECT_DESCRIPTION_CHARS: usize = 2000;

/// Project name cap (`project.create` / `project.update`), in characters.
pub const MAX_PROJECT_NAME_CHARS: usize = 120;

/// Conversation title cap (`conversation.create` / `conversation.rename`,
/// A3b §3.3 item 7), in characters.
pub const MAX_CONVERSATION_TITLE_CHARS: usize = 200;

/// `verification.approve` label cap (A7 §3.7 item 2), in characters, after
/// leading/trailing whitespace is trimmed.
pub const MAX_VERIFICATION_LABEL_CHARS: usize = 80;
/// `verification.approve` argv element count cap (A7 §3.7 item 2).
pub const MAX_VERIFICATION_ARGS: usize = 64;
/// Per-element byte cap of an approved argv (A7 §3.7 item 2).
pub const MAX_VERIFICATION_ARG_BYTES: usize = 4096;
/// Whole-argv byte cap of an approved argv (A7 §3.7 item 2).
pub const MAX_VERIFICATION_ARGV_BYTES: usize = 16 * 1024;

/// Invisible characters a verification LABEL refuses (A7 §3.7 item 2, "no
/// bidi or invisible format characters"), beyond [`is_spoofing_format_char`]:
/// every Unicode general-category Cf (format) character as of Unicode 15.1,
/// plus the default-ignorable non-Cf characters that render as nothing
/// (combining grapheme joiner U+034F, the Hangul fillers U+115F/U+1160/
/// U+3164/U+FFA0, Khmer U+17B4/U+17B5, Mongolian free variation selectors
/// U+180B-180D/U+180F). Emoji/variation selectors U+FE00-FE0F and
/// U+E0100-E01EF are deliberately NOT refused (they only select a glyph of
/// the visible character before them, e.g. "✅").
fn is_invisible_format_char(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08E2}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{110BD}'
            | '\u{110CD}'
            | '\u{13430}'..='\u{1343F}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
            | '\u{034F}'
            | '\u{115F}'
            | '\u{1160}'
            | '\u{17B4}'
            | '\u{17B5}'
            | '\u{180B}'..='\u{180D}'
            | '\u{180F}'
            | '\u{3164}'
            | '\u{FFA0}'
    )
}

/// Unicode format characters that can hide or reorder displayed text
/// (review I1): line/paragraph separators (Zl/Zp) and the bidi controls —
/// LRM/RLM, ALM, the embeddings/overrides U+202A-202E and the isolates
/// U+2066-2069.
fn is_spoofing_format_char(c: char) -> bool {
    matches!(
        c,
        '\u{2028}' | '\u{2029}' | '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{202A}'
            ..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

/// A character Core never shows unescaped in Core-built display text (A9
/// maintenance `detail` / `reason`, I8): every invisible format character
/// and every bidi / line-separator spoofing character above.
pub(crate) fn is_hidden_or_spoofing_char(c: char) -> bool {
    is_invisible_format_char(c) || is_spoofing_format_char(c)
}

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

    /// A project description (A3a §3.2 item 1), stored, never a CLI arg.
    /// At most [`MAX_PROJECT_DESCRIPTION_CHARS`] characters; `\n` is the ONLY
    /// control character allowed (tab, CR, DEL and the C1 range are refused,
    /// unlike [`Self::display_text`]); line/paragraph separators and bidi
    /// controls are refused too (review I1); empty is allowed and clears it.
    pub fn project_description(value: &str) -> Result<&str, ValidationError> {
        if value.chars().count() > MAX_PROJECT_DESCRIPTION_CHARS {
            return Err(ValidationError::TooLong {
                max: MAX_PROJECT_DESCRIPTION_CHARS,
            });
        }
        if let Some(c) = value
            .chars()
            .find(|c| (c.is_control() && *c != '\n') || is_spoofing_format_char(*c))
        {
            return Err(ValidationError::DisallowedChar { found: c });
        }
        Ok(value)
    }

    /// A project name (`project.create` and `project.update`, review I1):
    /// non-empty, at most [`MAX_PROJECT_NAME_CHARS`] characters, and NO
    /// control character at all (every Cc: C0 including `\n` and `\t`, DEL,
    /// C1), no line/paragraph separator and no bidi control — a name is shown
    /// on one line in every client and in confirmation dialogs. Names stored
    /// before this rule are not rewritten.
    pub fn project_name(value: &str) -> Result<&str, ValidationError> {
        Self::bounded(value, MAX_PROJECT_NAME_CHARS)?;
        if let Some(c) = value
            .chars()
            .find(|c| c.is_control() || is_spoofing_format_char(*c))
        {
            return Err(ValidationError::DisallowedChar { found: c });
        }
        Ok(value)
    }

    /// A conversation title (A3b §3.3 item 7, `conversation.create` and
    /// `conversation.rename`): non-empty, at most
    /// [`MAX_CONVERSATION_TITLE_CHARS`] characters, with exactly the
    /// [`Self::project_name`] refusals — a title is shown on one line in every
    /// client and in the delete confirmation's impact line 0. Whitespace-only
    /// handling is the caller's (create substitutes "Untitled conversation",
    /// rename refuses). Titles stored before this rule are not rewritten.
    pub fn conversation_title(value: &str) -> Result<&str, ValidationError> {
        Self::bounded(value, MAX_CONVERSATION_TITLE_CHARS)?;
        if let Some(c) = value
            .chars()
            .find(|c| c.is_control() || is_spoofing_format_char(*c))
        {
            return Err(ValidationError::DisallowedChar { found: c });
        }
        Ok(value)
    }

    /// A verification command LABEL (A7 §3.7 item 2): leading and trailing
    /// whitespace is trimmed, then 1..=[`MAX_VERIFICATION_LABEL_CHARS`]
    /// characters with NO control character (every Cc), no line/paragraph
    /// separator, no bidi control and no invisible format character
    /// ([`is_invisible_format_char`]). Returns the trimmed label.
    pub fn verification_label(raw: &str) -> Result<String, ValidationError> {
        let label = raw.trim();
        Self::bounded(label, MAX_VERIFICATION_LABEL_CHARS)?;
        if let Some(c) = label
            .chars()
            .find(|c| c.is_control() || is_spoofing_format_char(*c) || is_invisible_format_char(*c))
        {
            return Err(ValidationError::DisallowedChar { found: c });
        }
        Ok(label.to_string())
    }

    /// The SHAPE of an approved argv (A7 §3.7 item 2) — nothing is
    /// interpreted: no shell, no splitting, no globbing, no path or
    /// allowlist check on `argv[0]`, and shell metacharacters are plain data
    /// (the vector is never given to a shell). 1..=[`MAX_VERIFICATION_ARGS`]
    /// elements; each at most [`MAX_VERIFICATION_ARG_BYTES`] bytes and all
    /// together at most [`MAX_VERIFICATION_ARGV_BYTES`]; no NUL and no other
    /// control character except TAB and LF (C0, DEL and C1 are refused:
    /// security review W1; a Rust `String` is valid UTF-8 already);
    /// `argv[0]` non-empty and not starting
    /// with `-` (hygiene only, I1: after `sbx exec --` no element can become
    /// an sbx flag). The secret check is separate
    /// (`sandpane_core::verification::check_approval`).
    pub fn verification_argv(argv: &[String]) -> Result<(), ValidationError> {
        let shape = |reason: String| Err(ValidationError::InvalidShape { reason });
        if argv.is_empty() || argv.len() > MAX_VERIFICATION_ARGS {
            return shape(format!(
                "argv must have 1 to {MAX_VERIFICATION_ARGS} elements (it has {})",
                argv.len()
            ));
        }
        let mut total = 0usize;
        for (i, a) in argv.iter().enumerate() {
            let n = i + 1;
            if a.len() > MAX_VERIFICATION_ARG_BYTES {
                return shape(format!(
                    "argument {n} is longer than {MAX_VERIFICATION_ARG_BYTES} bytes"
                ));
            }
            if a.contains('\0') {
                return shape(format!("argument {n} contains a NUL character"));
            }
            // Security review W1: C0 controls other than TAB and LF, DEL and
            // C1 controls are refused (each serializes as a 6-byte `\u00XX`
            // escape; they are also unreadable in every confirmation).
            if a.chars().any(|c| c.is_control() && c != '\t' && c != '\n') {
                return shape(format!("argument {n} contains a control character"));
            }
            total += a.len();
        }
        if total > MAX_VERIFICATION_ARGV_BYTES {
            return shape(format!(
                "argv is longer than {MAX_VERIFICATION_ARGV_BYTES} bytes in total"
            ));
        }
        if argv[0].is_empty() {
            return shape("argument 1 (the program) is empty".into());
        }
        if argv[0].starts_with('-') {
            return shape("argument 1 (the program) must not start with '-'".into());
        }
        Ok(())
    }

    /// Message content and other human text destined
    /// for storage (not for CLI args). Non-empty, at most `max` characters.
    /// Refuses the C0 controls EXCEPT `\n` and `\t`, and DEL; it does NOT
    /// refuse C1 controls, line/paragraph separators or bidi controls (use
    /// [`Self::project_name`] / [`Self::project_description`] where those
    /// matter). Other Unicode is allowed.
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

    /// A3a §3.2 item 1: ≤ 2000 CHARACTERS, newlines allowed, every other
    /// control character refused (tab, CR, DEL, C1), empty allowed (clears).
    #[test]
    fn project_description_allows_newlines_and_empty_refuses_other_controls() {
        assert_eq!(Validator::project_description("").unwrap(), "");
        assert!(Validator::project_description("line one\nline two — ü 漢字").is_ok());
        let max = "é".repeat(MAX_PROJECT_DESCRIPTION_CHARS);
        assert!(
            Validator::project_description(&max).is_ok(),
            "chars, not bytes"
        );
        assert!(matches!(
            Validator::project_description(&format!("{max}x")),
            Err(ValidationError::TooLong {
                max: MAX_PROJECT_DESCRIPTION_CHARS
            })
        ));
        for bad in [
            "a\tb",
            "a\rb",
            "a\u{0}b",
            "a\u{7f}b",
            "a\u{85}b",
            "a\u{9b}b",
            "a\u{1b}[31m",
        ] {
            assert!(
                matches!(
                    Validator::project_description(bad),
                    Err(ValidationError::DisallowedChar { .. })
                ),
                "accepted: {bad:?}"
            );
        }
    }

    /// Review I1: characters that can hide or reorder what a user is shown.
    const SPOOFING: [char; 13] = [
        '\u{2028}', '\u{2029}', '\u{200E}', '\u{200F}', '\u{061C}', '\u{202A}', '\u{202B}',
        '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}', '\u{2067}', '\u{2069}',
    ];

    /// Review I1: project names refuse every Cc (newline and tab included),
    /// C1, line/paragraph separators and bidi controls; ≤ 120 chars, non-empty.
    #[test]
    fn project_name_refuses_controls_separators_and_bidi() {
        assert_eq!(
            Validator::project_name("Atlas Demo — ü 漢字").unwrap(),
            "Atlas Demo — ü 漢字"
        );
        assert!(Validator::project_name(&"é".repeat(MAX_PROJECT_NAME_CHARS)).is_ok());
        assert!(matches!(
            Validator::project_name(&"é".repeat(MAX_PROJECT_NAME_CHARS + 1)),
            Err(ValidationError::TooLong { .. })
        ));
        assert!(matches!(
            Validator::project_name(""),
            Err(ValidationError::Empty)
        ));
        let mut bad: Vec<String> = ["\n", "\t", "\r", "\u{0}", "\u{7f}", "\u{85}", "\u{9b}"]
            .iter()
            .map(|c| format!("a{c}b"))
            .collect();
        bad.extend(SPOOFING.iter().map(|c| format!("a{c}b")));
        bad.push("a\u{2068}b".into()); // FSI, U+2066-2069 range
        for v in &bad {
            assert!(
                matches!(
                    Validator::project_name(v),
                    Err(ValidationError::DisallowedChar { .. })
                ),
                "accepted: {v:?}"
            );
        }
    }

    /// A3b §3.3 item 7: conversation titles — 1..=200 chars, the project-name
    /// refusals (every Cc incl. `\n`/`\t`, C1, U+2028/2029, LRM/RLM, ALM,
    /// U+202A-202E, U+2066-2069).
    #[test]
    fn conversation_title_uses_the_project_name_refusals_at_200_chars() {
        assert_eq!(
            Validator::conversation_title("Atlas Demo — ü 漢字 ✓").unwrap(),
            "Atlas Demo — ü 漢字 ✓"
        );
        assert!(Validator::conversation_title(&"é".repeat(MAX_CONVERSATION_TITLE_CHARS)).is_ok());
        assert_eq!(MAX_CONVERSATION_TITLE_CHARS, 200);
        assert!(matches!(
            Validator::conversation_title(&"x".repeat(201)),
            Err(ValidationError::TooLong { max: 200 })
        ));
        assert!(matches!(
            Validator::conversation_title(""),
            Err(ValidationError::Empty)
        ));
        let mut bad: Vec<String> = ["\n", "\t", "\r", "\u{0}", "\u{7f}", "\u{85}", "\u{9b}"]
            .iter()
            .map(|c| format!("a{c}b"))
            .collect();
        bad.extend(SPOOFING.iter().map(|c| format!("a{c}b")));
        bad.extend(["a\u{2066}b".to_string(), "a\u{2069}b".to_string()]);
        for v in &bad {
            assert!(
                matches!(
                    Validator::conversation_title(v),
                    Err(ValidationError::DisallowedChar { .. })
                ),
                "accepted: {v:?}"
            );
        }
    }

    /// Review I1: descriptions keep `\n` but also refuse separators and bidi.
    #[test]
    fn project_description_refuses_separators_and_bidi() {
        assert!(Validator::project_description("one\ntwo").is_ok());
        for c in SPOOFING.iter().chain(['\u{2068}'].iter()) {
            let v = format!("a{c}b");
            assert!(
                matches!(
                    Validator::project_description(&v),
                    Err(ValidationError::DisallowedChar { .. })
                ),
                "accepted: {v:?}"
            );
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

    /// A7 §3.7 item 2: the label is trimmed, 1..=80 characters, and refuses
    /// every control character, line/paragraph separators, bidi controls and
    /// invisible format characters.
    #[test]
    fn verification_label_trims_bounds_and_refuses_invisible_text() {
        assert_eq!(
            Validator::verification_label("  unit tests \t").unwrap(),
            "unit tests"
        );
        assert_eq!(
            Validator::verification_label("✅ tests").unwrap(),
            "✅ tests"
        );
        let max = "a".repeat(MAX_VERIFICATION_LABEL_CHARS);
        assert_eq!(Validator::verification_label(&max).unwrap(), max);
        for bad in [
            String::new(),
            "   ".to_string(),
            "a".repeat(MAX_VERIFICATION_LABEL_CHARS + 1),
            "tests\nnow".into(),
            "tests\u{7}".into(),
            "te\u{85}sts".into(),
            "tests\u{1b}[31m".into(),
            "a\u{2028}b".into(),
            "a\u{202E}b".into(),
            "a\u{2066}b".into(),
            "a\u{200B}b".into(),
            "a\u{200D}b".into(),
            "a\u{2060}b".into(),
            "a\u{FEFF}b".into(),
            "a\u{00AD}b".into(),
            "a\u{034F}b".into(),
            "a\u{3164}b".into(),
            "a\u{E0041}b".into(),
            "a\u{180E}b".into(),
        ] {
            assert!(
                Validator::verification_label(&bad).is_err(),
                "accepted {bad:?}"
            );
        }
    }

    /// A7 §3.7 item 2: argv shape — 1..=64 elements, each <= 4096 bytes,
    /// all together <= 16 KiB, no NUL, argv[0] non-empty and not `-`-led.
    /// Nothing else is interpreted (metacharacters are DATA here).
    #[test]
    fn verification_argv_shape_rules() {
        let ok = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(Validator::verification_argv(&ok(&["npm", "run", "test"])).is_ok());
        assert!(Validator::verification_argv(&ok(&["sh", "-c", "a && b | c $(d) `e`"])).is_ok());
        assert!(
            Validator::verification_argv(&ok(&["printf", "[%s]\n", "-u", "--privileged", ""]))
                .is_ok()
        );
        let many: Vec<String> = (0..MAX_VERIFICATION_ARGS)
            .map(|i| format!("a{i}"))
            .collect();
        assert!(Validator::verification_argv(&many).is_ok());
        let too_many: Vec<String> = (0..=MAX_VERIFICATION_ARGS)
            .map(|i| format!("a{i}"))
            .collect();
        assert!(Validator::verification_argv(&too_many).is_err());
        assert!(Validator::verification_argv(&[]).is_err());
        assert!(Validator::verification_argv(&ok(&[""])).is_err());
        assert!(Validator::verification_argv(&ok(&["-rf"])).is_err());
        assert!(Validator::verification_argv(&ok(&["--", "x"])).is_err());
        assert!(Validator::verification_argv(&ok(&["make", "a\0b"])).is_err());
        let long = "x".repeat(MAX_VERIFICATION_ARG_BYTES);
        assert!(Validator::verification_argv(&["echo".into(), long.clone()]).is_ok());
        assert!(Validator::verification_argv(&["echo".into(), format!("{long}y")]).is_err());
        // Multi-byte: the bound is BYTES, not characters.
        let wide = "é".repeat(MAX_VERIFICATION_ARG_BYTES / 2 + 1);
        assert!(Validator::verification_argv(&["echo".into(), wide]).is_err());
        let quarter = "x".repeat(MAX_VERIFICATION_ARG_BYTES);
        let total: Vec<String> = std::iter::once("echo".to_string())
            .chain(std::iter::repeat_n(quarter, 4))
            .collect();
        assert!(
            Validator::verification_argv(&total).is_err(),
            "> 16 KiB in total"
        );
    }

    /// Security review W1: every C0 control except TAB and LF, DEL and every
    /// C1 control is refused in any element (each would serialize as a
    /// 6-byte `\u00XX` escape and could push a list past the frame cap).
    #[test]
    fn verification_argv_refuses_control_characters() {
        let v = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(Validator::verification_argv(&v(&["printf", "a\tb\n"])).is_ok());
        for c in [
            '\u{1}', '\u{1b}', '\r', '\u{7f}', '\u{80}', '\u{85}', '\u{9b}', '\u{9f}',
        ] {
            let e = Validator::verification_argv(&v(&["echo", &format!("a{c}b")])).unwrap_err();
            assert_eq!(
                e.to_string(),
                "value has an invalid shape: argument 2 contains a control character",
                "{c:?}"
            );
        }
        let e = Validator::verification_argv(&v(&["x\u{1}"])).unwrap_err();
        assert!(e
            .to_string()
            .ends_with("argument 1 contains a control character"));
        // Non-control multi-byte text stays allowed.
        assert!(Validator::verification_argv(&v(&["echo", "\u{a0}é漢"])).is_ok());
    }
}
