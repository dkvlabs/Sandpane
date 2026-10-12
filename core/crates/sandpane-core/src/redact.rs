//! Best-effort secret redaction for `conversation.export` (A3b, design of
//! record `docs/plans/2026-10-09-protocol-v1-additions.md` §3.3 item 6;
//! specs/06 "redact tokens, Authorization headers, .env values, SSH keys and
//! private URLs").
//!
//! BEST EFFORT, honestly: these are patterns, not a secret detector. Host
//! names and paths are NOT redacted; a secret in an unrecognised shape passes
//! through. Every export surface says "Redaction is best-effort; review the
//! export before sharing it."
//!
//! Guarantees this module does make (and tests pin):
//!
//! * **Never longer.** Each redacted span becomes `[REDACTED:<kind>]` when the
//!   span is at least that many BYTES long, otherwise one `*` per character
//!   of the span. Markers and `*` are ASCII that JSON never escapes, so the
//!   output is never longer than the input — in bytes AND in serialized JSON
//!   bytes. `conversation.export` relies on this: it counts its byte ceiling
//!   over the RAW rows under the DB lock and redacts afterwards.
//! * **Bounded matching cost.** Patterns are fixed and trusted; the `regex`
//!   crate guarantees no catastrophic backtracking (finite automata). It does
//!   NOT promise strictly linear iteration — its docs give `find_iter` a
//!   worst case of O(m·n²) — but matching is measured roughly linear on
//!   hostile 1-2 MiB inputs (test `hostile_megabyte_inputs_complete_promptly`).
//!   Patterns are compiled ONCE ([`LazyLock`]) with explicit size limits, and
//!   only `find` is used — never capture groups, so no slower capture engine
//!   runs over a long span. Word boundaries are ASCII (`(?-u:\b)`) so the
//!   lazy DFA never has to give up on non-ASCII text.
//! * **One pass, overlaps merged, no double counting.** Every kind is matched
//!   against the ORIGINAL text. Overlapping candidate spans are MERGED into
//!   one region (never dropped: a private-key block that starts inside an
//!   env / header value on its BEGIN line is redacted whole), which is
//!   replaced once and counted once, attributed to the highest-priority kind
//!   it contains. A merged region is at least as long as each part, so the
//!   never-longer rule holds; a marker is never re-matched by another kind.
//! * **Fail closed.** If the patterns cannot be compiled, [`redact`] returns
//!   [`RedactorUnavailable`] and the caller must refuse to export rather than
//!   emit unredacted text.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};

/// Kind names, in tie-break PRIORITY order (a span of an earlier kind wins
/// over an equally-placed span of a later one). These strings are the
/// `byKind` keys of the wire `ExportRedaction`.
pub const KINDS: [&str; 7] = [
    "private-key",
    "auth-header",
    "url-credentials",
    "url-secret-param",
    "jwt",
    "token",
    "env-secret",
];

/// Compiled-program ceiling per pattern (bytes). The patterns are small; the
/// limit only turns an accidental blow-up into a compile error (fail closed).
pub const PATTERN_SIZE_LIMIT: usize = 1 << 20;
/// Lazy-DFA cache ceiling per pattern (bytes).
pub const PATTERN_DFA_SIZE_LIMIT: usize = 2 << 20;

/// The redaction patterns could not be compiled; nothing may be exported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactorUnavailable(pub String);

impl std::fmt::Display for RedactorUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "redaction patterns unavailable: {}", self.0)
    }
}

impl std::error::Error for RedactorUnavailable {}

/// Replacement counts per kind. Only kinds that replaced something appear.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RedactionCounts {
    by_kind: BTreeMap<&'static str, u64>,
}

impl RedactionCounts {
    pub fn total(&self) -> u64 {
        self.by_kind.values().sum()
    }

    /// Kind → count; zero-count kinds are absent.
    pub fn by_kind(&self) -> &BTreeMap<&'static str, u64> {
        &self.by_kind
    }

    pub fn get(&self, kind: &str) -> u64 {
        self.by_kind.get(kind).copied().unwrap_or(0)
    }

    fn add(&mut self, kind: &'static str) {
        *self.by_kind.entry(kind).or_insert(0) += 1;
    }
}

/// The marker a span of `kind` is replaced with when it is long enough.
pub fn marker(kind: &str) -> String {
    format!("[REDACTED:{kind}]")
}

/// One kind's compiled pattern. `full` finds the whole match; when only part
/// of it is secret, `keep_prefix` (anchored at the start of the matched text)
/// measures the leading bytes to keep and `keep_suffix` the trailing bytes —
/// no capture groups, so only the fast search engines ever run.
struct Pattern {
    kind: &'static str,
    full: Regex,
    keep_prefix: Option<Regex>,
    keep_suffix: usize,
}

/// `(kind, full pattern, kept-prefix pattern, kept suffix bytes)`, one per
/// entry of [`KINDS`] (same order = priority).
const PATTERN_SOURCES: [(&str, &str, Option<&str>, usize); 7] = [
    // PEM private-key blocks; an unterminated block runs to the end.
    (
        "private-key",
        r"(?s)-----BEGIN[ A-Z0-9]*PRIVATE KEY-----.*?(?:-----END[ A-Z0-9]*PRIVATE KEY-----|\z)",
        None,
        0,
    ),
    // `Authorization` / `Proxy-Authorization` header values (to end of line).
    (
        "auth-header",
        r#"(?i)(?-u:\b)(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*[^ \t\r\n][^\r\n]*"#,
        Some(r#"(?i)\A(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*"#),
        0,
    ),
    // The `user:pass` userinfo of a URL (scheme, host and path kept); the
    // user name may be empty (`redis://:password@host`).
    (
        "url-credentials",
        r"(?-u:\b)[A-Za-z][A-Za-z0-9+.-]*://[^/\s:@?#]*:[^/\s@?#]*@",
        Some(r"\A[A-Za-z][A-Za-z0-9+.-]*://"),
        1,
    ),
    // Query values of secret-bearing parameters (the name is kept): the exact
    // names below, plus any name containing one of env-secret's keywords
    // (same list, case-insensitive) — env-secret never starts after `?`/`&`,
    // so query pairs are this kind's alone.
    (
        "url-secret-param",
        r#"(?i)[?&](?:token|access_token|api_key|apikey|key|secret|password|sig|signature|x-amz-signature|x-amz-credential|[A-Za-z0-9_.-]*(?:secret|token|password|passwd|api_key|access_key|private_key|credential)[A-Za-z0-9_.-]*)=[^&#\s"'<>]+"#,
        Some(r"\A[^=]*="),
        0,
    ),
    // JWTs: three base64url segments beginning `eyJ`.
    (
        "jwt",
        r"(?-u:\b)eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
        None,
        0,
    ),
    // Well-known token prefixes: GitHub, GitLab, Slack, OpenAI/Anthropic,
    // AWS access key id, Google API key, npm, Hugging Face, Docker.
    (
        "token",
        r"(?-u:\b)(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|dckr_pat_[A-Za-z0-9_-]{20,})",
        None,
        0,
    ),
    // `NAME=value` / `NAME: value` lines where NAME contains a secret-ish
    // word (case-insensitive); only the value — the REST OF THE LINE — is
    // replaced. NAME starts at a line start or after a character that is not
    // `?`, `&` or a name character (that character is kept): a URL query
    // pair belongs to url-secret-param alone, so an env match never swallows
    // a query value, loses the tie to it, and hides a later `NAME=value`.
    (
        "env-secret",
        r#"(?im)(?:^|[^?&A-Za-z0-9_.-])["']?[A-Za-z0-9_.-]*(?:secret|token|password|passwd|api_key|access_key|private_key|credential)[A-Za-z0-9_.-]*["']?[ \t]*[=:][ \t]*[^ \t\r\n][^\r\n]*"#,
        Some(
            r#"(?i)\A[^?&A-Za-z0-9_.-]?["']?[A-Za-z0-9_.-]*(?:secret|token|password|passwd|api_key|access_key|private_key|credential)[A-Za-z0-9_.-]*["']?[ \t]*[=:][ \t]*"#,
        ),
        0,
    ),
];

fn compile(source: &str) -> Result<Regex, RedactorUnavailable> {
    RegexBuilder::new(source)
        .size_limit(PATTERN_SIZE_LIMIT)
        .dfa_size_limit(PATTERN_DFA_SIZE_LIMIT)
        .build()
        .map_err(|e| RedactorUnavailable(e.to_string()))
}

/// Compiled once per process. `Err` = fail closed (see the module docs).
static PATTERNS: LazyLock<Result<Vec<Pattern>, RedactorUnavailable>> = LazyLock::new(|| {
    PATTERN_SOURCES
        .iter()
        .map(|(kind, full, prefix, suffix)| {
            Ok(Pattern {
                kind,
                full: compile(full)?,
                keep_prefix: prefix.map(compile).transpose()?,
                keep_suffix: *suffix,
            })
        })
        .collect()
});

/// A candidate replacement: byte span of `text` plus its kind's priority.
struct Span {
    start: usize,
    end: usize,
    priority: usize,
    kind: &'static str,
}

/// Redact `text`, adding what was replaced to `counts`. See the module docs
/// for the guarantees (never longer, bounded matching cost, overlaps merged,
/// fail closed).
pub fn redact(text: &str, counts: &mut RedactionCounts) -> Result<String, RedactorUnavailable> {
    let patterns = PATTERNS.as_ref().map_err(Clone::clone)?;
    let mut spans: Vec<Span> = Vec::new();
    for (priority, p) in patterns.iter().enumerate() {
        for m in p.full.find_iter(text) {
            let matched = m.as_str();
            let keep_front = p
                .keep_prefix
                .as_ref()
                .and_then(|re| re.find(matched))
                .map_or(0, |k| k.end());
            let start = m.start() + keep_front;
            let end = m.end().saturating_sub(p.keep_suffix).max(start);
            // Both cuts fall on ASCII bytes the patterns themselves matched,
            // so they are char boundaries; an empty span replaces nothing.
            if end > start && text.is_char_boundary(start) && text.is_char_boundary(end) {
                spans.push(Span {
                    start,
                    end,
                    priority,
                    kind: p.kind,
                });
            }
        }
    }
    // Earliest start first; on a tie the higher-priority (more specific)
    // kind, then the longer span.
    spans.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then(a.priority.cmp(&b.priority))
            .then(b.end.cmp(&a.end))
    });
    // MERGE overlapping spans (review C1): a span that starts inside the
    // current region extends it to the larger end — it is never dropped —
    // and the region keeps the highest-priority kind among its parts.
    let mut regions: Vec<Span> = Vec::new();
    for s in spans {
        match regions.last_mut() {
            Some(r) if s.start < r.end => {
                r.end = r.end.max(s.end);
                if s.priority < r.priority {
                    r.priority = s.priority;
                    r.kind = s.kind;
                }
            }
            _ => regions.push(s),
        }
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for r in regions {
        out.push_str(&text[cursor..r.start]);
        let secret = &text[r.start..r.end];
        let m = marker(r.kind);
        // THE length rule: the marker only when the region is at least as
        // many BYTES long; otherwise one ASCII `*` per character (<= its
        // bytes).
        if secret.len() >= m.len() {
            out.push_str(&m);
        } else {
            out.extend(std::iter::repeat_n('*', secret.chars().count()));
        }
        counts.add(r.kind);
        cursor = r.end;
    }
    out.push_str(&text[cursor..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str) -> (String, RedactionCounts) {
        let mut c = RedactionCounts::default();
        let out = redact(text, &mut c).expect("patterns compile");
        (out, c)
    }

    fn assert_unchanged(text: &str) {
        let (out, c) = run(text);
        assert_eq!(out, text, "near-miss was redacted");
        assert_eq!(c.total(), 0, "{text:?}: {c:?}");
    }

    fn assert_redacts(text: &str, expected: &str, kind: &str, n: u64) {
        let (out, c) = run(text);
        assert_eq!(out, expected, "input {text:?}");
        assert_eq!(c.get(kind), n, "{text:?}: {c:?}");
        assert_eq!(c.total(), n, "only {kind} expected: {c:?}");
        assert_never_longer(text, &out);
    }

    fn assert_never_longer(input: &str, output: &str) {
        assert!(output.len() <= input.len(), "{input:?} -> {output:?}");
        let (i, o) = (
            serde_json::to_string(input).unwrap(),
            serde_json::to_string(output).unwrap(),
        );
        assert!(o.len() <= i.len(), "json {i} -> {o}");
    }

    #[test]
    fn patterns_compile_with_the_size_limits_and_kinds_are_pinned() {
        let mut c = RedactionCounts::default();
        assert!(redact("", &mut c).is_ok());
        assert_eq!(
            KINDS,
            [
                "private-key",
                "auth-header",
                "url-credentials",
                "url-secret-param",
                "jwt",
                "token",
                "env-secret"
            ]
        );
        assert_eq!(marker("jwt"), "[REDACTED:jwt]");
    }

    #[test]
    fn auth_header_values_are_redacted_and_the_name_kept() {
        assert_redacts(
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
            "Authorization: [REDACTED:auth-header]",
            "auth-header",
            1,
        );
        assert_redacts(
            "curl -H 'Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA=='",
            "curl -H 'Proxy-Authorization: [REDACTED:auth-header]",
            "auth-header",
            1,
        );
        assert_redacts(
            "{\"authorization\": \"Bearer xyzxyzxyzxyzxyzxyz\"}",
            "{\"authorization\": [REDACTED:auth-header]",
            "auth-header",
            1,
        );
        // Short value: one `*` per character (never longer than input).
        assert_redacts(
            "Authorization: Bearer x",
            "Authorization: ********",
            "auth-header",
            1,
        );
        // Near misses: the word without a separator and value.
        assert_unchanged("the authorization flow is documented");
        assert_unchanged("Authorization:   \nnext line");
    }

    #[test]
    fn private_key_blocks_are_redacted_whole_and_unterminated_to_the_end() {
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3\n\
                   -----END RSA PRIVATE KEY-----";
        assert_redacts(
            &format!("key:\n{pem}\nafter"),
            "key:\n[REDACTED:private-key]\nafter",
            "private-key",
            1,
        );
        assert_redacts(
            "x -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nno end here",
            "x [REDACTED:private-key]",
            "private-key",
            1,
        );
        // Two blocks: two replacements; text between them survives.
        let two = format!("{pem}\nmiddle\n{pem}");
        assert_redacts(
            &two,
            "[REDACTED:private-key]\nmiddle\n[REDACTED:private-key]",
            "private-key",
            2,
        );
        // Near misses: public material and a bare BEGIN line without a key.
        assert_unchanged("-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----");
        assert_unchanged("-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+g");
    }

    #[test]
    fn well_known_token_prefixes_are_redacted() {
        let cases = [
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "gho_ABCDEFGHIJKLMNOPQRST1234",
            "ghu_ABCDEFGHIJKLMNOPQRST1234",
            "ghs_ABCDEFGHIJKLMNOPQRST1234",
            "ghr_ABCDEFGHIJKLMNOPQRST1234",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
            "glpat-abcdefghijklmnopqrst",
            "xoxb-1234567890-abcdefghij",
            "sk-proj-abcdefghijklmnopqrstuvwxyz",
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
            "AKIAIOSFODNN7EXAMPLE",
            "AIzaSyA-abcdefghijklmnopqrstuvwxyz01234",
            "npm_abcdefghijklmnopqrstuvwxyz0123456789",
            "hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "dckr_pat_abcdefghijklmnopqrstuvwx",
        ];
        for tok in cases {
            assert_redacts(
                &format!("use {tok} now"),
                "use [REDACTED:token] now",
                "token",
                1,
            );
        }
        // Near misses: too short, wrong case/class, or glued to a word.
        for near in [
            "ghp_short",
            "sk-short-key",
            "task-abcdefghijklmnopqrstuvwxyz0123",
            "risk-abcdefghijklmnopqrstuvwxyz0123",
            "AKIAiosfodnn7example",
            "AKIAIOSFODNN7EXAMP",
            "npm_install_is_a_command",
            "hf_hub_download",
            "the skeleton key",
            "xox-not-slack",
        ] {
            assert_unchanged(&format!("text {near} text"));
        }
    }

    /// Review C1: a private-key block that starts INSIDE an earlier span
    /// (an env / YAML / header value on its BEGIN line) must never be
    /// discarded as an "overlap": overlapping spans are MERGED, and the merged
    /// region is attributed to the highest-priority kind (private-key).
    #[test]
    fn a_private_key_inside_an_earlier_span_is_merged_never_dropped() {
        let cases = [
            "PRIVATE_KEY=\"-----BEGIN RSA PRIVATE KEY-----\nMIIEbodyone\nbodytwo\n-----END RSA PRIVATE KEY-----\"",
            "PRIVATE_KEY='-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEbodyone\nbodytwo\n-----END OPENSSH PRIVATE KEY-----'",
            "SSH_PRIVATE_KEY: \"-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEbodyone\nbodytwo\n-----END OPENSSH PRIVATE KEY-----\"",
            "password: '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIEbodyone\nbodytwo\n-----END ENCRYPTED PRIVATE KEY-----'",
            "Authorization: x -----BEGIN PRIVATE KEY-----\nMIIEbodyone\nbodytwo\n-----END PRIVATE KEY-----",
            "token: -----BEGIN EC PRIVATE KEY-----\nMIIEbodyone\nbodytwo\n-----END EC PRIVATE KEY-----",
            "see https://h.invalid/?key=-----BEGIN PRIVATE KEY-----\nMIIEbodyone\nbodytwo\n-----END PRIVATE KEY-----",
            // Unterminated, after an env value: redacted to the end.
            "PRIVATE_KEY=\"-----BEGIN RSA PRIVATE KEY-----\nMIIEbodyone\nbodytwo",
        ];
        for text in cases {
            let (out, c) = run(text);
            assert!(
                !out.contains("MIIEbodyone") && !out.contains("bodytwo"),
                "key body leaked: {text:?} -> {out:?}"
            );
            assert_eq!(c.get("private-key"), 1, "{text:?}: {c:?}");
            assert_eq!(c.total(), 1, "one merged region, counted once: {c:?}");
            assert!(out.contains("[REDACTED:private-key]"), "{out:?}");
            assert_never_longer(text, &out);
        }
        let (out, _) = run(cases[0]);
        assert_eq!(out, "PRIVATE_KEY=[REDACTED:private-key]\"");
        let (out, _) = run(cases[4]);
        assert_eq!(out, "Authorization: [REDACTED:private-key]");
    }

    #[test]
    fn jwts_are_redacted() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36P";
        assert_redacts(
            &format!("token was {jwt}."),
            "token was [REDACTED:jwt].",
            "jwt",
            1,
        );
        assert_unchanged("eyJhbGciOiJIUzI1NiJ9.only-two");
        assert_unchanged("version 1.2.3 and eyJ alone");
    }

    #[test]
    fn env_secret_values_are_redacted_and_names_kept() {
        assert_redacts(
            "DB_PASSWORD=correct-horse-battery-staple",
            "DB_PASSWORD=[REDACTED:env-secret]",
            "env-secret",
            1,
        );
        assert_redacts(
            "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
            "export AWS_SECRET_ACCESS_KEY=[REDACTED:env-secret]",
            "env-secret",
            1,
        );
        assert_redacts(
            "client_credential: abcdefghijklmnopqrstuvwxyz",
            "client_credential: [REDACTED:env-secret]",
            "env-secret",
            1,
        );
        assert_redacts("my_api_key = x1", "my_api_key = **", "env-secret", 1);
        assert_redacts("passwd: hunter2", "passwd: *******", "env-secret", 1);
        // §3.3 item 6: the value is the REST OF THE LINE — a value with
        // spaces never leaks its tail.
        assert_redacts(
            "DB_PASSWORD=correct horse battery staple",
            "DB_PASSWORD=[REDACTED:env-secret]",
            "env-secret",
            1,
        );
        assert_redacts(
            "X-Auth-Token: Bearer abc123",
            "X-Auth-Token: *************",
            "env-secret",
            1,
        );
        // One per line; a quoted JSON value is redacted with its quotes.
        assert_redacts(
            "TOKEN=a\nSECRET=bb\n{\"password\": \"hunter2\"}",
            "TOKEN=*\nSECRET=**\n{\"password\": **********",
            "env-secret",
            3,
        );
        // A URL query pair belongs to url-secret-param alone: the env name
        // never starts right after `?` / `&`, so a later NAME=value on the
        // same line is still found.
        let (out, c) = run("see ?token=abc&page=2 then PASSWORD=x");
        assert_eq!(out, "see ?token=***&page=2 then PASSWORD=*");
        assert_eq!((c.get("url-secret-param"), c.get("env-secret")), (1, 1));
        // Case-insensitive name match; value to end of line only.
        assert_redacts(
            "Private_Key=abcdefghijklmnopqrstuvwxyz\nnext=line",
            "Private_Key=[REDACTED:env-secret]\nnext=line",
            "env-secret",
            1,
        );
        // Near misses: no keyword in the name, or no value.
        assert_unchanged("DATABASE_HOST=db.internal");
        assert_unchanged("PASSWORD=\nUSER=bob");
        assert_unchanged("we rotated the secret yesterday");
    }

    #[test]
    fn url_credentials_userinfo_is_redacted_host_and_path_kept() {
        assert_redacts(
            "clone https://alice:s3cr3t-passw0rd-long@git.example.invalid/repo.git",
            "clone https://[REDACTED:url-credentials]@git.example.invalid/repo.git",
            "url-credentials",
            1,
        );
        assert_redacts(
            "postgres://u:p@db.invalid/x",
            "postgres://***@db.invalid/x",
            "url-credentials",
            1,
        );
        // Review W1: an EMPTY user name still carries a password.
        for (text, expect) in [
            (
                "https://:s3cr3tpassword@host.invalid/",
                "https://***************@host.invalid/",
            ),
            (
                "redis://:supersecretpassword@cache:6379/0",
                "redis://********************@cache:6379/0",
            ),
        ] {
            assert_redacts(text, expect, "url-credentials", 1);
        }
        // Near misses: no password, or not a URL.
        assert_unchanged("ssh://git@host.invalid/x");
        assert_unchanged("https://example.invalid/a:b");
        assert_unchanged("ssh://git@github.com/owner/repo");
        assert_unchanged("mail alice@example.invalid about https://example.invalid/a:b");
    }

    #[test]
    fn url_secret_params_are_redacted_other_params_kept() {
        assert_redacts(
            "https://h.invalid/p?id=7&token=abcdefghijklmnopqrstuvwxyz0123&page=2",
            "https://h.invalid/p?id=7&token=[REDACTED:url-secret-param]&page=2",
            "url-secret-param",
            1,
        );
        assert_redacts(
            "https://b.invalid/o?X-Amz-Credential=AKID%2F2026&X-Amz-Signature=deadbeefdeadbeefdeadbeefdeadbeef",
            "https://b.invalid/o?X-Amz-Credential=***********&X-Amz-Signature=[REDACTED:url-secret-param]",
            "url-secret-param",
            2,
        );
        for name in [
            "access_token",
            "api_key",
            "apikey",
            "key",
            "secret",
            "password",
            "sig",
            "signature",
        ] {
            let (out, c) = run(&format!("https://h.invalid/?{name}=v"));
            assert_eq!(out, format!("https://h.invalid/?{name}=*"));
            assert_eq!(c.get("url-secret-param"), 1, "{name}");
        }
        // Review W2: any parameter whose NAME contains an env-secret keyword
        // (case-insensitive) — the env pattern never starts after `?`/`&`.
        for name in [
            "client_secret",
            "db_password",
            "refresh_token",
            "id_token",
            "X-Api_Key",
            "Passwd",
        ] {
            let (out, c) = run(&format!("https://h.invalid/cb?{name}=v1&state=ok"));
            assert_eq!(
                out,
                format!("https://h.invalid/cb?{name}=**&state=ok"),
                "{name}"
            );
            assert_eq!((c.get("url-secret-param"), c.total()), (1, 1), "{name}");
        }
        // Near misses: a non-secret param, and a param whose name merely
        // ends in a listed one.
        assert_unchanged("https://h.invalid/?page=2&sort=asc");
        assert_unchanged("https://h.invalid/?monkey=banana");
    }

    #[test]
    fn multiple_matches_per_message_and_kind_priority() {
        let text = "a ghp_abcdefghijklmnopqrstuvwxyz0123 b \
                    https://h.invalid/?sig=abcdef c GITHUB_TOKEN=ghp_zyxwvutsrqponmlkjihgfedcba9876";
        let (out, c) = run(text);
        assert_eq!(
            out,
            "a [REDACTED:token] b https://h.invalid/?sig=****** c GITHUB_TOKEN=[REDACTED:token]"
        );
        // The env value IS a token: the more specific kind wins the tie and
        // the span is counted once.
        assert_eq!(c.get("token"), 2);
        assert_eq!(c.get("url-secret-param"), 1);
        assert_eq!(c.get("env-secret"), 0);
        assert_eq!(c.total(), 3);
        assert!(c.by_kind().keys().all(|k| c.get(k) > 0), "no zero kinds");
        assert_never_longer(text, &out);
    }

    #[test]
    fn non_ascii_text_around_matches_is_preserved() {
        let text = "Schlüssel: ghp_abcdefghijklmnopqrstuvwxyz0123 — 秘密 PASSWORD=pä🔑 ✓";
        let (out, c) = run(text);
        // The env value runs to the end of the line: "pä🔑 ✓" = 5 chars.
        assert_eq!(out, "Schlüssel: [REDACTED:token] — 秘密 PASSWORD=*****");
        assert_eq!((c.get("token"), c.get("env-secret")), (1, 1));
        assert_never_longer(text, &out);
        // A multi-byte span shorter (in bytes) than the marker: one `*` per
        // CHARACTER, so 3 chars / 9 bytes -> 3 bytes.
        let (out, _) = run("passwd=秘密鍵");
        assert_eq!(out, "passwd=***");
    }

    /// The marker is used only when the span is at least as long (bytes) as
    /// the marker; one byte shorter falls back to stars.
    #[test]
    fn marker_length_rule_boundary() {
        let m = marker("env-secret"); // 21 bytes
        let exact = "v".repeat(m.len());
        let (out, _) = run(&format!("PASSWORD={exact}"));
        assert_eq!(out, format!("PASSWORD={m}"));
        let short = "v".repeat(m.len() - 1);
        let (out, _) = run(&format!("PASSWORD={short}"));
        assert_eq!(out, format!("PASSWORD={}", "*".repeat(m.len() - 1)));
    }

    /// §3.3 item 6: a page made of SHORT matches (every span shorter than its
    /// marker) is never longer than its input, per message and as a page, in
    /// bytes and in serialized JSON bytes.
    #[test]
    fn a_page_of_short_matches_is_never_longer_than_its_input() {
        let page: Vec<String> = (0..200)
            .map(|i| {
                format!(
                    "{i}: ?key=a&sig=bb&token=c\nPASSWORD=x\npasswd: yz\n\
                     https://u:p@h.invalid/\n\"secret\": \"é\"\nünï=ok\nAuthorization: q"
                )
            })
            .collect();
        let mut counts = RedactionCounts::default();
        let out: Vec<String> = page
            .iter()
            .map(|m| redact(m, &mut counts).unwrap())
            .collect();
        for (i, o) in page.iter().zip(&out) {
            assert_never_longer(i, o);
            assert_ne!(i, o, "every message had matches");
        }
        assert!(
            serde_json::to_string(&out).unwrap().len()
                <= serde_json::to_string(&page).unwrap().len()
        );
        assert_eq!(counts.total(), 200 * 8, "{counts:?}");
        for kind in [
            "url-secret-param",
            "env-secret",
            "url-credentials",
            "auth-header",
        ] {
            assert!(counts.get(kind) > 0, "{kind}: {counts:?}");
        }
        assert!(out.iter().all(|o| !o.contains("[REDACTED")), "all short");
    }

    /// Hostile 1-2 MiB inputs finish promptly (linear time). The bound is
    /// generous for unoptimised debug builds; a super-linear engine takes
    /// minutes on these shapes.
    #[test]
    fn hostile_megabyte_inputs_complete_promptly() {
        let mib = 1024 * 1024;
        let shapes: Vec<String> = vec![
            "-----BEGIN PRIVATE KEY-----".repeat(mib / 27),
            "eyJ".repeat(mib / 3),
            "sk-".repeat(2 * mib / 3),
            "a".repeat(2 * mib),
            "PASSWORD".repeat(mib / 8),
            "?key=&key=".repeat(mib / 10),
            "Authorization:".repeat(mib / 14),
            "https://a:".repeat(mib / 10),
            "token=x ".repeat(mib / 8),
            "é".repeat(mib / 2),
            "PASSWORD=x\n".repeat(mib / 11),
            "\n".repeat(2 * mib),
            "?token=".repeat(mib / 7),
        ];
        let start = std::time::Instant::now();
        for s in &shapes {
            let t = std::time::Instant::now();
            let mut c = RedactionCounts::default();
            let out = redact(s, &mut c).unwrap();
            assert!(out.len() <= s.len());
            eprintln!(
                "hostile shape {:?}... ({} bytes): {:?}, {} replacements",
                &s[..12.min(s.len())],
                s.len(),
                t.elapsed(),
                c.total()
            );
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(60),
            "hostile inputs took {elapsed:?}"
        );
    }
}
