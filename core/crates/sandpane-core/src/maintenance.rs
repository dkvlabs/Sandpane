//! A9 maintenance — the pure, file-system-free rules (design 2026-10-09
//! §3.9): the item-id grammar (W2, the allowlist every client-supplied id
//! passes before anything else), the length-prefixed SHA-256 digest a
//! cleanup token is bound to, the strict cutoff grammar, the migration
//! backup name grammar and the escaping of Core-built display text (I8).
//!
//! Nothing here touches the file system or the database, and nothing here
//! ever turns an id into a path: the service looks ids up in its own fresh
//! inventory only.

use sha2::{Digest, Sha256};

/// Longest item id accepted (bytes).
pub const MAX_ITEM_ID_LEN: usize = 512;
/// Most ids one `maintenance.cleanup` call may name (§3.9 item 1).
pub const MAX_CLEANUP_ITEMS: usize = 500;
/// Bound on Core-built `detail` / `reason` strings (bytes, I8).
pub const MAX_DISPLAY_BYTES: usize = 512;

pub const ID_PREFIX_TEMP: &str = "temp:";
pub const ID_PREFIX_DB_BACKUP: &str = "dbBackup:";
pub const ID_PREFIX_VERIFICATION_OUTPUT: &str = "verificationOutput:";
pub const ID_PREFIX_WORKTREE: &str = "worktree:";
pub const ID_PREFIX_FOREIGN: &str = "foreign:";

/// A parsed item id. Parsing proves only the GRAMMAR; whether the item
/// exists (and is removable) is decided by Core's own fresh inventory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemId {
    /// `temp:<lowercase UUID v4>`.
    Temp(uuid::Uuid),
    /// `dbBackup:<file name>` — a single path component, never a path.
    DbBackup(String),
    /// `verificationOutput:<YYYY-MM-DDTHH:MM:SSZ>` with its Unix seconds.
    VerificationOutput { cutoff: String, unix: u64 },
    /// `worktree:<task id>` (report-only).
    Worktree(String),
    /// `foreign:<n>` (never removable).
    Foreign(u32),
}

/// Why an id was refused (one message for every grammar failure).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdRefused;

/// Parse one id against the §3.9 W2 grammar.
pub fn parse_item_id(id: &str) -> Result<ItemId, IdRefused> {
    if id.len() > MAX_ITEM_ID_LEN {
        return Err(IdRefused);
    }
    if let Some(rest) = id.strip_prefix(ID_PREFIX_TEMP) {
        return temp_uuid(rest).map(ItemId::Temp).ok_or(IdRefused);
    }
    if let Some(rest) = id.strip_prefix(ID_PREFIX_DB_BACKUP) {
        let plain = !rest.is_empty()
            && rest.len() <= 255
            && rest != "."
            && rest != ".."
            && !rest.contains('/')
            && !rest.contains('\\')
            && !rest
                .chars()
                .any(|c| c.is_control() || crate::validation::is_hidden_or_spoofing_char(c));
        return if plain {
            Ok(ItemId::DbBackup(rest.to_string()))
        } else {
            Err(IdRefused)
        };
    }
    if let Some(rest) = id.strip_prefix(ID_PREFIX_VERIFICATION_OUTPUT) {
        return parse_cutoff(rest)
            .map(|unix| ItemId::VerificationOutput {
                cutoff: rest.to_string(),
                unix,
            })
            .ok_or(IdRefused);
    }
    if let Some(rest) = id.strip_prefix(ID_PREFIX_WORKTREE) {
        let ok = (1..=64).contains(&rest.len())
            && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        return if ok {
            Ok(ItemId::Worktree(rest.to_string()))
        } else {
            Err(IdRefused)
        };
    }
    if let Some(rest) = id.strip_prefix(ID_PREFIX_FOREIGN) {
        return canonical_decimal(rest, true)
            .and_then(|n| u32::try_from(n).ok())
            .map(ItemId::Foreign)
            .ok_or(IdRefused);
    }
    Err(IdRefused)
}

/// Canonical decimal: ASCII digits only, at most 9, no leading zero
/// (`"0"` itself only when `allow_zero`).
fn canonical_decimal(s: &str, allow_zero: bool) -> Option<u64> {
    if s.is_empty() || s.len() > 9 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if s.starts_with('0') && !(allow_zero && s == "0") {
        return None;
    }
    s.parse().ok()
}

/// `name` as a lowercase, hyphenated UUID v4 — exactly what `CoreTemp`
/// creates (`Uuid::new_v4().to_string()`), nothing else.
pub fn temp_uuid(name: &str) -> Option<uuid::Uuid> {
    let u = uuid::Uuid::parse_str(name).ok()?;
    let canonical = u.get_version_num() == 4
        && u.get_variant() == uuid::Variant::RFC4122
        && u.hyphenated().to_string() == name;
    canonical.then_some(u)
}

/// The token digest (§3.9 item 1, W2): SHA-256 over the ids sorted by
/// bytes, each prefixed by its byte length as a big-endian u32. Lowercase
/// hex. The order of `ids` does not matter; duplicates do.
pub fn items_digest(ids: &[String]) -> String {
    let mut sorted: Vec<&String> = ids.iter().collect();
    sorted.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let mut h = Sha256::new();
    for id in sorted {
        // Ids are bounded far below u32::MAX by the frame cap; saturate
        // rather than wrap if that ever stops being true.
        let len = u32::try_from(id.len()).unwrap_or(u32::MAX);
        h.update(len.to_be_bytes());
        h.update(id.as_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Format Unix seconds exactly as Core emits timestamps
/// (`YYYY-MM-DDTHH:MM:SSZ`).
pub fn format_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Howard Hinnant's civil_from_days (the algorithm Core's
/// `rfc3339_from_unix` uses).
fn civil_from_days(days: i64) -> (i64, u64, u64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    (if mo <= 2 { y + 1 } else { y }, mo, d)
}

/// Inverse of [`civil_from_days`] (Hinnant's days_from_civil).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parse a cutoff STRICTLY: it must be the exact form [`format_utc`]
/// emits and re-serialise byte for byte (§3.9 item 2).
pub fn parse_cutoff(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() != 20 {
        return None;
    }
    let shape = b"dddd-dd-ddTdd:dd:ddZ";
    for (c, want) in b.iter().zip(shape.iter()) {
        let ok = if *want == b'd' {
            c.is_ascii_digit()
        } else {
            c == want
        };
        if !ok {
            return None;
        }
    }
    let num = |r: std::ops::Range<usize>| -> i64 {
        b[r].iter()
            .fold(0i64, |acc, d| acc * 10 + i64::from(d - b'0'))
    };
    let (y, mo, d) = (num(0..4), num(5..7), num(8..10));
    let (hh, mm, ss) = (num(11..13), num(14..16), num(17..19));
    if y < 1970 || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    if hh > 23 || mm > 59 || ss > 59 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    let secs = u64::try_from(days * 86_400 + hh * 3600 + mm * 60 + ss).ok()?;
    // Byte-for-byte re-serialisation rejects impossible dates (Feb 30…).
    (format_utc(secs) == s).then_some(secs)
}

/// A migration backup name beside `db_file_name`: exactly
/// `<db>.pre-v<N>.bak` (k = 0) or `<db>.pre-v<N>.bak.<k>` (k >= 1), with
/// canonical decimal N >= 1 and k (no sign, no leading zero). Returns
/// `(N, k)`.
pub fn parse_backup_name(db_file_name: &str, name: &str) -> Option<(u64, u64)> {
    let rest = name.strip_prefix(db_file_name)?.strip_prefix(".pre-v")?;
    let dot = rest.find(".bak")?;
    let n = canonical_decimal(&rest[..dot], false)?;
    let tail = &rest[dot + ".bak".len()..];
    if tail.is_empty() {
        return Some((n, 0));
    }
    let k = canonical_decimal(tail.strip_prefix('.')?, false)?;
    Some((n, k))
}

/// Core-built display text (I8): invalid UTF-8 and every control character
/// (C0, DEL, C1) and bidi / invisible format character replaced by U+FFFD,
/// then bounded to [`MAX_DISPLAY_BYTES`] bytes on a character boundary
/// (an ellipsis marks a cut).
pub fn escape_display(bytes: &[u8]) -> String {
    escape_display_with_limit(bytes, MAX_DISPLAY_BYTES)
}

/// [`escape_display`] with another byte bound (display-only paths use a
/// larger one). `max` below 3 bytes leaves room for nothing but the cut.
pub fn escape_display_with_limit(bytes: &[u8], max: usize) -> String {
    let mut out: String = String::from_utf8_lossy(bytes)
        .chars()
        .map(|c| {
            if c.is_control() || crate::validation::is_hidden_or_spoofing_char(c) {
                '\u{fffd}'
            } else {
                c
            }
        })
        .collect();
    if out.len() > max {
        let ellipsis = '\u{2026}';
        let mut cut = max.saturating_sub(ellipsis.len_utf8());
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push(ellipsis);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: &str = "3f9a1c22-0000-4000-8000-abcdef012345";

    #[test]
    fn temp_ids_are_lowercase_uuid_v4_only() {
        assert_eq!(
            parse_item_id(&format!("temp:{U}")),
            Ok(ItemId::Temp(uuid::Uuid::parse_str(U).unwrap()))
        );
        assert_eq!(temp_uuid(U), Some(uuid::Uuid::parse_str(U).unwrap()));
        for bad in [
            U.to_ascii_uppercase(),
            // version 1
            "3f9a1c22-0000-1000-8000-abcdef012345".to_string(),
            // simple / braced / urn forms
            U.replace('-', ""),
            format!("{{{U}}}"),
            format!("urn:uuid:{U}"),
            format!("{U}.live"),
            format!("../{U}"),
            String::new(),
        ] {
            assert_eq!(temp_uuid(&bad), None, "{bad}");
            assert_eq!(
                parse_item_id(&format!("temp:{bad}")),
                Err(IdRefused),
                "{bad}"
            );
        }
    }

    #[test]
    fn db_backup_ids_are_one_plain_component() {
        assert_eq!(
            parse_item_id("dbBackup:core.sqlite3.pre-v9.bak"),
            Ok(ItemId::DbBackup("core.sqlite3.pre-v9.bak".into()))
        );
        for bad in [
            "dbBackup:",
            "dbBackup:.",
            "dbBackup:..",
            "dbBackup:../core.sqlite3.pre-v9.bak",
            "dbBackup:/etc/passwd",
            "dbBackup:a\u{0}b",
            "dbBackup:a\nb",
            "dbBackup:a\u{202e}b",
        ] {
            assert_eq!(parse_item_id(bad), Err(IdRefused), "{bad:?}");
        }
        let long = format!("dbBackup:{}", "a".repeat(300));
        assert_eq!(parse_item_id(&long), Err(IdRefused));
    }

    #[test]
    fn verification_output_ids_need_a_canonical_cutoff() {
        assert_eq!(
            parse_item_id("verificationOutput:2026-09-12T08:30:00Z"),
            Ok(ItemId::VerificationOutput {
                cutoff: "2026-09-12T08:30:00Z".into(),
                unix: 1_789_201_800
            })
        );
        for bad in [
            "verificationOutput:",
            "verificationOutput:2026-09-12T08:30:00+00:00",
            "verificationOutput:2026-09-12T08:30:00.000Z",
            "verificationOutput:2026-09-12t08:30:00z",
            "verificationOutput:2026-9-12T08:30:00Z",
            "verificationOutput:2026-09-31T08:30:00Z",
            "verificationOutput:2026-02-29T00:00:00Z",
            "verificationOutput:2026-09-12T24:00:00Z",
            "verificationOutput:2026-09-12T08:60:00Z",
            "verificationOutput:2026-09-12T08:30:60Z",
            "verificationOutput: 2026-09-12T08:30:00Z",
            "verificationOutput:+2026-09-12T08:30:00Z",
            "verificationOutput:1969-12-31T23:59:59Z",
            "verificationOutput:２０２６-09-12T08:30:00Z",
        ] {
            assert_eq!(parse_item_id(bad), Err(IdRefused), "{bad}");
        }
    }

    #[test]
    fn cutoff_round_trips_byte_for_byte() {
        for secs in [
            0u64,
            1,
            86_399,
            86_400,
            951_782_400,
            1_789_201_800,
            4_102_444_799,
        ] {
            let s = format_utc(secs);
            assert_eq!(parse_cutoff(&s), Some(secs), "{s}");
        }
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(parse_cutoff("2024-02-29T12:00:00Z"), Some(1_709_208_000));
        assert_eq!(parse_cutoff("2023-02-29T12:00:00Z"), None);
    }

    #[test]
    fn worktree_and_foreign_ids() {
        assert_eq!(
            parse_item_id(&format!("worktree:{U}")),
            Ok(ItemId::Worktree(U.into()))
        );
        assert_eq!(parse_item_id("foreign:0"), Ok(ItemId::Foreign(0)));
        assert_eq!(parse_item_id("foreign:17"), Ok(ItemId::Foreign(17)));
        for bad in [
            "worktree:",
            "worktree:../x",
            "worktree:a/b",
            "foreign:",
            "foreign:01",
            "foreign:-1",
            "foreign:+1",
            "foreign:99999999999",
            "foreign:x",
            "unknown:1",
            "temp",
            "",
            "TEMP:3f9a1c22-0000-4000-8000-abcdef012345",
        ] {
            assert_eq!(parse_item_id(bad), Err(IdRefused), "{bad}");
        }
        let long = format!("worktree:{}", "a".repeat(MAX_ITEM_ID_LEN));
        assert_eq!(parse_item_id(&long), Err(IdRefused));
    }

    #[test]
    fn digest_is_order_free_length_prefixed_and_set_exact() {
        let a = vec!["temp:x".to_string(), "dbBackup:y".to_string()];
        let b = vec!["dbBackup:y".to_string(), "temp:x".to_string()];
        assert_eq!(items_digest(&a), items_digest(&b), "reordered, same digest");
        // Known answer: sorted ["dbBackup:y", "temp:x"], each u32-BE length
        // prefixed.
        let mut input = Vec::new();
        for id in ["dbBackup:y", "temp:x"] {
            input.extend_from_slice(&(id.len() as u32).to_be_bytes());
            input.extend_from_slice(id.as_bytes());
        }
        let want: String = Sha256::digest(&input)
            .iter()
            .map(|x| format!("{x:02x}"))
            .collect();
        assert_eq!(items_digest(&a), want);
        assert_eq!(want.len(), 64);
        // Subset, superset and duplicates all differ.
        let subset = vec!["temp:x".to_string()];
        let superset = vec![
            "temp:x".to_string(),
            "dbBackup:y".to_string(),
            "temp:z".to_string(),
        ];
        let dup = vec![
            "temp:x".to_string(),
            "dbBackup:y".to_string(),
            "temp:x".to_string(),
        ];
        for other in [&subset, &superset, &dup] {
            assert_ne!(items_digest(other), items_digest(&a), "{other:?}");
        }
        // Length prefixes keep concatenation ambiguity out:
        // ["ab", "c"] vs ["a", "bc"].
        assert_ne!(
            items_digest(&["ab".to_string(), "c".to_string()]),
            items_digest(&["a".to_string(), "bc".to_string()])
        );
    }

    #[test]
    fn backup_names_are_exact() {
        let db = "core.sqlite3";
        assert_eq!(
            parse_backup_name(db, "core.sqlite3.pre-v9.bak"),
            Some((9, 0))
        );
        assert_eq!(
            parse_backup_name(db, "core.sqlite3.pre-v2.bak.1"),
            Some((2, 1))
        );
        assert_eq!(
            parse_backup_name(db, "core.sqlite3.pre-v12.bak.30"),
            Some((12, 30))
        );
        for bad in [
            "core.sqlite3",
            "core.sqlite3.pre-v9.bak.",
            "core.sqlite3.pre-v9.bak.0",
            "core.sqlite3.pre-v9.bak.01",
            "core.sqlite3.pre-v09.bak",
            "core.sqlite3.pre-v0.bak",
            "core.sqlite3.pre-v.bak",
            "core.sqlite3.pre-v9.bak.1.2",
            "core.sqlite3.pre-v9.bakx",
            "core.sqlite3.pre-v9.bak-wal",
            "core.sqlite3.pre-v+9.bak",
            "other.sqlite3.pre-v9.bak",
            "xcore.sqlite3.pre-v9.bak",
            "core.sqlite3.pre-v9.BAK",
            "core.sqlite3.pre-v99999999999999999999.bak",
        ] {
            assert_eq!(parse_backup_name(db, bad), None, "{bad}");
        }
    }

    #[test]
    fn display_text_is_escaped_and_bounded() {
        assert_eq!(escape_display(b"plain name"), "plain name");
        assert_eq!(
            escape_display(b"a\nb\x1bc\x7fd"),
            "a\u{fffd}b\u{fffd}c\u{fffd}d"
        );
        assert_eq!(escape_display(b"a\xffb"), "a\u{fffd}b");
        assert_eq!(
            escape_display("x\u{202e}y\u{200b}z\u{85}w".as_bytes()),
            "x\u{fffd}y\u{fffd}z\u{fffd}w"
        );
        let long = escape_display(&[b'a'; 2000]);
        assert!(long.len() <= MAX_DISPLAY_BYTES, "{}", long.len());
        assert!(long.ends_with('\u{2026}'));
        let multi = escape_display("é".repeat(400).as_bytes());
        assert!(multi.len() <= MAX_DISPLAY_BYTES);
        assert!(multi.is_char_boundary(multi.len()));
    }
}
