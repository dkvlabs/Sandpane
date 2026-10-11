//! A7 verification commands — the Core-side pure rules (design of record
//! `docs/plans/2026-10-09-protocol-v1-additions.md` §3.7): the approval
//! secret check (C1, item 2), the outcome a finished `sbx exec` maps to
//! (items 5–6, W2/I3/I-f) and the redaction of captured output before it is
//! stored (item 6, I5). Nothing here spawns or stores anything.

use std::process::ExitStatus;

use crate::process::{PartialOutput, RunEnding};
use crate::redact::{self, RedactionCounts, RedactorUnavailable};

/// Outcome strings (§3.7 item 5). OPEN strings on the wire, never an enum
/// (§1 rule 2); `running` is what `verification.result` answers in flight.
pub const OUTCOME_RUNNING: &str = "running";
pub const OUTCOME_EXITED: &str = "exited";
pub const OUTCOME_SIGNALED: &str = "signaled";
pub const OUTCOME_TIMED_OUT: &str = "timed_out";
pub const OUTCOME_SPAWN_FAILED: &str = "spawn_failed";
pub const OUTCOME_READ_FAILED: &str = "read_failed";
pub const OUTCOME_POSSIBLY_SBX_ERROR: &str = "possibly_sbx_error";
pub const OUTCOME_INTERRUPTED: &str = "interrupted";

/// `RedactorUnavailable` at approve (§3.7 item 2).
pub const MSG_SECRET_CHECK_UNAVAILABLE: &str =
    "the secret check is unavailable, so nothing was approved";

/// I-g: a harmless argument shaped like a secret is refused too, with no
/// override; this is the advice that goes with the refusal (in the error's
/// `details.hint`, so the message itself stays the exact design template).
pub const SECRET_REFUSAL_HINT: &str = "if this is not a secret, rename the argument or move it \
     into a script; approved commands cannot hold secrets and there is no override";

/// Why an approval was refused by the secret check (C1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalRefusal {
    /// `argv[number - 1]` matched these redaction kinds (`number` counts
    /// from 1: the program is argument 1).
    Argument {
        number: usize,
        kinds: Vec<&'static str>,
    },
    /// The label matched these redaction kinds.
    Label { kinds: Vec<&'static str> },
    /// The elements TOGETHER (joined with spaces, or as JSON) matched.
    Combined { kinds: Vec<&'static str> },
    /// The redaction patterns could not be compiled: fail closed.
    RedactorUnavailable,
}

impl ApprovalRefusal {
    /// The exact user-facing message (§3.7 item 2).
    pub fn message(&self) -> String {
        match self {
            Self::Argument { number, kinds } => format!(
                "argument {number} looks like a secret ({}); approved commands cannot hold \
                 secrets; nothing was approved",
                kinds.join(", ")
            ),
            Self::Label { kinds } => format!(
                "the label looks like a secret ({}); approved commands cannot hold secrets; \
                 nothing was approved",
                kinds.join(", ")
            ),
            Self::Combined { kinds } => format!(
                "the arguments together look like a secret ({}); approved commands cannot hold \
                 secrets; nothing was approved",
                kinds.join(", ")
            ),
            Self::RedactorUnavailable => MSG_SECRET_CHECK_UNAVAILABLE.to_string(),
        }
    }
}

/// The C1 secret check with the production redactor.
pub fn check_approval(label: &str, argv: &[String]) -> Result<(), ApprovalRefusal> {
    check_approval_with(label, argv, redact::redact)
}

/// The C1 secret check (§3.7 item 2): every argv element, then the label,
/// goes through `redactor`; ANY replacement refuses the approval, naming the
/// kinds (in [`redact::KINDS`] priority order). A redactor failure refuses
/// too (fail closed). Only argv proven clean here is ever stored, put in an
/// event or returned.
pub fn check_approval_with<F>(
    label: &str,
    argv: &[String],
    redactor: F,
) -> Result<(), ApprovalRefusal>
where
    F: Fn(&str, &mut RedactionCounts) -> Result<String, RedactorUnavailable>,
{
    let kinds_in = |text: &str| -> Result<Vec<&'static str>, ApprovalRefusal> {
        let mut counts = RedactionCounts::default();
        redactor(text, &mut counts).map_err(|_| ApprovalRefusal::RedactorUnavailable)?;
        Ok(redact::KINDS
            .iter()
            .copied()
            .filter(|k| counts.get(k) > 0)
            .collect())
    };
    for (i, a) in argv.iter().enumerate() {
        let kinds = kinds_in(a)?;
        if !kinds.is_empty() {
            return Err(ApprovalRefusal::Argument {
                number: i + 1,
                kinds,
            });
        }
    }
    let kinds = kinds_in(label)?;
    if !kinds.is_empty() {
        return Err(ApprovalRefusal::Label { kinds });
    }
    // Security review W3: a secret split across elements (`-H`,
    // `Authorization:`, `Bearer`, `<token>`) passes each element alone; the
    // elements TOGETHER — space-joined and as JSON — are checked as well.
    let json = serde_json::to_string(argv).map_err(|_| ApprovalRefusal::RedactorUnavailable)?;
    let mut kinds = kinds_in(&argv.join(" "))?;
    for k in kinds_in(&json)? {
        if !kinds.contains(&k) {
            kinds.push(k);
        }
    }
    if !kinds.is_empty() {
        kinds.sort_by_key(|k| redact::KINDS.iter().position(|x| x == k));
        return Err(ApprovalRefusal::Combined { kinds });
    }
    Ok(())
}

/// I3: stdout is empty and stderr carries the captured sbx error shape — its
/// first non-empty line starts with `error:` (captured v0.47.0 format
/// `error: <msg>` + `  try: <hint>`). Then the exit status may be sbx's own,
/// not the command's.
pub fn looks_like_sbx_error(stdout: &[u8], stderr: &[u8]) -> bool {
    if !stdout.is_empty() {
        return false;
    }
    String::from_utf8_lossy(stderr)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .is_some_and(|l| l.starts_with("error:"))
}

/// The outcome string and exit code for a finished run (§3.7 items 5–6).
/// `exitCode` is the exit status of `sbx exec` (C-2 UNVERIFIED), kept for
/// `exited` and `possibly_sbx_error` (I-f) only.
///
/// `WaitFailed` (Core could not wait for the child) maps to `read_failed`:
/// the design's outcome list has no separate value, and in both cases Core
/// could not observe the run to its end.
pub fn classify(out: &PartialOutput) -> (&'static str, Option<i32>) {
    match &out.ending {
        RunEnding::TimedOut => (OUTCOME_TIMED_OUT, None),
        RunEnding::ReadFailed(_) | RunEnding::WaitFailed(_) => (OUTCOME_READ_FAILED, None),
        RunEnding::Cancelled => (OUTCOME_INTERRUPTED, None),
        RunEnding::Exited(status) => classify_exit(*status, &out.stdout, &out.stderr),
    }
}

fn classify_exit(status: ExitStatus, stdout: &[u8], stderr: &[u8]) -> (&'static str, Option<i32>) {
    match status.code() {
        // No code: a signal ended it (W2) — never a made-up number.
        None => (OUTCOME_SIGNALED, None),
        Some(code) if looks_like_sbx_error(stdout, stderr) => {
            (OUTCOME_POSSIBLY_SBX_ERROR, Some(code))
        }
        Some(code) => (OUTCOME_EXITED, Some(code)),
    }
}

/// Captured bytes as they are stored (§3.7 item 6, I5): decoded lossily
/// (U+FFFD for invalid UTF-8), then redacted with the best-effort redactor
/// BEFORE storage. `Err` = the redactor is unavailable: nothing may be
/// stored, and nothing raw is kept.
pub fn redact_output(
    bytes: &[u8],
    counts: &mut RedactionCounts,
) -> Result<String, RedactorUnavailable> {
    redact_output_with(bytes, counts, redact::redact)
}

/// [`redact_output`] with an injected redactor (tests).
pub fn redact_output_with<F>(
    bytes: &[u8],
    counts: &mut RedactionCounts,
    redactor: F,
) -> Result<String, RedactorUnavailable>
where
    F: Fn(&str, &mut RedactionCounts) -> Result<String, RedactorUnavailable>,
{
    let text = String::from_utf8_lossy(bytes);
    redactor(&text, counts)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Security review W3 (probe c1.rs): a secret split across elements
    /// passes the per-element check; the joined and JSON forms catch it.
    #[test]
    fn a_secret_split_across_elements_is_refused() {
        let opaque = "q7Zr2LkP9xVb3NcT8mWd4HfJ6sYa1GeU5oRi0tQk";
        let argv = v(&["curl", "-H", "Authorization:", "Bearer", opaque]);
        let r = check_approval("headers", &argv).unwrap_err();
        assert_eq!(
            r,
            ApprovalRefusal::Combined {
                kinds: vec!["auth-header"]
            }
        );
        assert_eq!(
            r.message(),
            "the arguments together look like a secret (auth-header); approved commands cannot \
             hold secrets; nothing was approved"
        );
        // An ordinary vector stays approvable.
        assert!(check_approval("tests", &v(&["curl", "-H", "Accept: text/plain", "x"])).is_ok());
    }
    use std::os::unix::process::ExitStatusExt;
    use std::time::Duration;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn unavailable(_: &str, _: &mut RedactionCounts) -> Result<String, RedactorUnavailable> {
        Err(RedactorUnavailable("test".into()))
    }

    #[test]
    fn clean_approvals_pass_the_secret_check() {
        assert_eq!(
            check_approval("unit tests", &v(&["npm", "run", "test"])),
            Ok(())
        );
        assert_eq!(
            check_approval("make check", &v(&["make", "check", "-j4", "--keep-going"])),
            Ok(())
        );
    }

    #[test]
    fn a_secret_argument_is_refused_with_its_number_and_kind() {
        let token = format!("ghp_{}", "a".repeat(36));
        let r = check_approval("deploy", &v(&["curl", "-H", &token])).unwrap_err();
        assert_eq!(
            r,
            ApprovalRefusal::Argument {
                number: 3,
                kinds: vec!["token"]
            }
        );
        assert_eq!(
            r.message(),
            "argument 3 looks like a secret (token); approved commands cannot hold secrets; \
             nothing was approved"
        );
        // I-g: harmless but secret-shaped is refused too (fail closed).
        let r = check_approval("x", &v(&["tool", "--password-file=/etc/pw"])).unwrap_err();
        assert!(
            matches!(r, ApprovalRefusal::Argument { number: 2, .. }),
            "{r:?}"
        );
        // The program itself is argument 1.
        let r = check_approval("x", &v(&["API_KEY=abc", "run"])).unwrap_err();
        assert!(
            matches!(r, ApprovalRefusal::Argument { number: 1, .. }),
            "{r:?}"
        );
    }

    #[test]
    fn a_secret_label_is_refused() {
        let r = check_approval("Authorization: Bearer abc123", &v(&["make"])).unwrap_err();
        assert_eq!(
            r.message(),
            "the label looks like a secret (auth-header); approved commands cannot hold \
             secrets; nothing was approved"
        );
    }

    #[test]
    fn an_unavailable_redactor_refuses_the_approval() {
        let r = check_approval_with("unit tests", &v(&["npm", "test"]), unavailable).unwrap_err();
        assert_eq!(r, ApprovalRefusal::RedactorUnavailable);
        assert_eq!(r.message(), MSG_SECRET_CHECK_UNAVAILABLE);
    }

    fn ended(ending: RunEnding, stdout: &[u8], stderr: &[u8]) -> PartialOutput {
        PartialOutput {
            ending,
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
            stdout_truncated: false,
            stderr_truncated: false,
            elapsed: Duration::from_millis(1),
            output_incomplete: false,
            group_signalled: false,
        }
    }

    #[test]
    fn outcomes_follow_the_design_list() {
        let code = |c: i32| ExitStatus::from_raw(c << 8);
        assert_eq!(
            classify(&ended(RunEnding::Exited(code(0)), b"ok\n", b"")),
            ("exited", Some(0))
        );
        assert_eq!(
            classify(&ended(RunEnding::Exited(code(7)), b"", b"boom\n")),
            ("exited", Some(7))
        );
        // I3 + I-f: the captured sbx error shape keeps its exit code.
        let sbx_err = b"error: sandbox 'atlas-auth' not found\n  try: sbx ls\n";
        assert_eq!(
            classify(&ended(RunEnding::Exited(code(1)), b"", sbx_err)),
            ("possibly_sbx_error", Some(1))
        );
        // With stdout present it is the command's own output.
        assert_eq!(
            classify(&ended(RunEnding::Exited(code(1)), b"x", sbx_err)),
            ("exited", Some(1))
        );
        // W2: a signal has no code.
        assert_eq!(
            classify(&ended(RunEnding::Exited(ExitStatus::from_raw(9)), b"", b"")),
            ("signaled", None)
        );
        assert_eq!(
            classify(&ended(RunEnding::TimedOut, b"part", b"")),
            ("timed_out", None)
        );
        assert_eq!(
            classify(&ended(RunEnding::ReadFailed("pipe".into()), b"part", b"")),
            ("read_failed", None)
        );
        assert_eq!(
            classify(&ended(RunEnding::WaitFailed("wait".into()), b"", b"")),
            ("read_failed", None)
        );
    }

    #[test]
    fn sbx_error_shape_needs_empty_stdout_and_a_leading_error_line() {
        assert!(looks_like_sbx_error(b"", b"\n  error: x\n"));
        assert!(!looks_like_sbx_error(b"", b"warning: x\nerror: y\n"));
        assert!(!looks_like_sbx_error(b"", b""));
        assert!(!looks_like_sbx_error(b"out", b"error: x\n"));
    }

    #[test]
    fn output_is_decoded_lossily_and_redacted_before_storage() {
        let token = format!("ghp_{}", "b".repeat(36));
        let raw = format!("ok {token}\n").into_bytes();
        let mut raw_bad = raw.clone();
        raw_bad.push(0xff);
        let mut counts = RedactionCounts::default();
        let stored = redact_output(&raw_bad, &mut counts).unwrap();
        assert!(!stored.contains(&token), "{stored}");
        assert!(stored.contains("[REDACTED:token]"), "{stored}");
        assert!(
            stored.ends_with('\u{FFFD}'),
            "lossy decode is visible: {stored:?}"
        );
        assert_eq!(counts.get("token"), 1);
        let mut c = RedactionCounts::default();
        assert!(redact_output_with(&raw, &mut c, unavailable).is_err());
    }
}
