//! Durable idempotency keys (A2, design of record
//! `docs/plans/2026-10-09-protocol-v1-additions.md` §3.1).
//!
//! Storage is the `idempotency_keys` table (schema v5); this module is the
//! only code that reads or writes it. Every function takes a
//! [`rusqlite::Connection`] (a `Transaction` derefs to one), so callers decide
//! the transaction: `conversation.send` writes its `done` row inside the same
//! transaction as the message/task/event rows; `sandbox.create` commits a
//! short `pending` claim before the subprocess and completes it afterwards.
//!
//! The params are never stored, only a SHA-256 fingerprint of their canonical
//! serialization ([`fingerprint`]), so prompt text is not retained twice.

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Rows older than this are pruned (§3.1 item 8).
pub const RETENTION_SECS: u64 = 24 * 60 * 60;

/// Row cap; the oldest `done`/`unknown` rows go first (§3.1 item 8).
pub const MAX_ROWS: usize = 10_000;

/// What a lookup found for (method, key) given this request's fingerprint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    /// No row: the key is free.
    Absent,
    /// Same params, finished: the stored result JSON, returned verbatim.
    Done(String),
    /// The key was used with DIFFERENT params (whatever its state).
    ParamsMismatch,
    /// Same params, still running.
    Pending,
    /// Same params, outcome unknown (Core restarted / sbx failed mid-run).
    Unknown,
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Version tag prefixed to every fingerprint input. Bump it deliberately
/// (to `-v2`) if the canonical form ever has to change; stored keys from the
/// old version then simply stop matching (CONFLICT, never a wrong replay).
pub const FINGERPRINT_TAG: &[u8] = b"sandpane-idem-v1\n";

/// Fingerprint of typed params: SHA-256 of [`FINGERPRINT_TAG`] followed by
/// their canonical `serde_json` serialization (struct field order; this
/// workspace's `serde_json` has no `preserve_order`). Callers pass the params
/// with `idempotency_key` = None.
///
/// RULE for protocol changes: every NEW optional field on a keyed request
/// type MUST use `skip_serializing_if = "Option::is_none"` (or an equivalent
/// skip for its empty value), so a request that omits it hashes exactly as it
/// did before the field existed. Otherwise adding a field silently turns
/// every stored key into a params mismatch.
pub fn fingerprint<T: Serialize>(params: &T) -> Result<String, serde_json::Error> {
    let mut input = FINGERPRINT_TAG.to_vec();
    serde_json::to_writer(&mut input, params)?;
    Ok(sha256_hex(&input))
}

pub fn lookup(
    conn: &Connection,
    method: &str,
    key: &str,
    params_hash: &str,
) -> rusqlite::Result<Lookup> {
    let row = conn.query_row(
        "SELECT params_hash, state, result_json FROM idempotency_keys
         WHERE method = ?1 AND key = ?2",
        params![method, key],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    );
    let (hash, state, result) = match row {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(Lookup::Absent),
        Err(e) => return Err(e),
    };
    if hash != params_hash {
        return Ok(Lookup::ParamsMismatch);
    }
    Ok(match (state.as_str(), result) {
        ("done", Some(json)) => Lookup::Done(json),
        ("pending", _) => Lookup::Pending,
        // `unknown`, or any row Core cannot read as a finished success: not
        // replayed and not re-run with this key within the 24 h retention
        // window (after the prune the key is free again).
        _ => Lookup::Unknown,
    })
}

/// Insert a `pending` claim. `false` = the (method, key) row already exists
/// (a concurrent request won the race): re-run [`lookup`].
pub fn claim(
    conn: &Connection,
    method: &str,
    key: &str,
    params_hash: &str,
    now: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO idempotency_keys (method, key, params_hash, state, created_at)
         VALUES (?1, ?2, ?3, 'pending', ?4)",
        params![method, key, params_hash, now],
    )?;
    Ok(n == 1)
}

/// `pending` → `done` with the exact result. `false` if no pending row.
pub fn complete(
    conn: &Connection,
    method: &str,
    key: &str,
    result_json: &str,
    now: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE idempotency_keys SET state = 'done', result_json = ?3, completed_at = ?4
         WHERE method = ?1 AND key = ?2 AND state = 'pending'",
        params![method, key, result_json, now],
    )?;
    Ok(n == 1)
}

/// Insert a row directly as `done` (atomic-with-the-write callers).
/// `false` = the (method, key) row already exists; the caller must abort its
/// transaction and re-run [`lookup`].
pub fn insert_done(
    conn: &Connection,
    method: &str,
    key: &str,
    params_hash: &str,
    result_json: &str,
    now: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO idempotency_keys
             (method, key, params_hash, state, result_json, created_at, completed_at)
         VALUES (?1, ?2, ?3, 'done', ?4, ?5, ?5)",
        params![method, key, params_hash, result_json, now],
    )?;
    Ok(n == 1)
}

/// `pending` → `unknown` (the operation may have had an effect).
pub fn mark_unknown(
    conn: &Connection,
    method: &str,
    key: &str,
    now: &str,
) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "UPDATE idempotency_keys SET state = 'unknown', completed_at = ?3
         WHERE method = ?1 AND key = ?2 AND state = 'pending'",
        params![method, key, now],
    )?;
    Ok(n == 1)
}

/// Delete a `pending` claim whose operation provably never started, so the
/// key stays retryable. Never deletes `done`/`unknown` rows.
pub fn release(conn: &Connection, method: &str, key: &str) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "DELETE FROM idempotency_keys WHERE method = ?1 AND key = ?2 AND state = 'pending'",
        params![method, key],
    )?;
    Ok(n == 1)
}

/// Startup: every leftover `pending` row becomes `unknown` (§3.1 item 6 —
/// never fabricate an outcome). Returns how many rows changed.
pub fn reconcile_pending_to_unknown(conn: &Connection, now: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE idempotency_keys SET state = 'unknown', completed_at = ?1
         WHERE state = 'pending'",
        params![now],
    )
}

/// Retention: delete non-`pending` rows created before `cutoff`, then, while
/// more than `cap - 1` rows remain, the oldest non-`pending` rows — leaving
/// room for one insert. `pending` rows are never pruned. Returns rows deleted.
pub fn prune(conn: &Connection, cutoff: &str, cap: usize) -> rusqlite::Result<usize> {
    let mut deleted = conn.execute(
        "DELETE FROM idempotency_keys WHERE state <> 'pending' AND created_at < ?1",
        params![cutoff],
    )?;
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM idempotency_keys", [], |r| r.get(0))?;
    let keep = cap.saturating_sub(1) as i64;
    let excess = total - keep;
    if excess > 0 {
        deleted += conn.execute(
            "DELETE FROM idempotency_keys WHERE rowid IN (
                 SELECT rowid FROM idempotency_keys WHERE state <> 'pending'
                 ORDER BY created_at, rowid LIMIT ?1)",
            params![excess],
        )?;
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    const M: &str = "sandbox.create";

    fn state(db: &Database, method: &str, key: &str) -> Option<(String, Option<String>)> {
        db.conn()
            .query_row(
                "SELECT state, result_json FROM idempotency_keys WHERE method=?1 AND key=?2",
                params![method, key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
    }

    fn count(db: &Database) -> i64 {
        db.conn()
            .query_row("SELECT COUNT(*) FROM idempotency_keys", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn sha256_known_answers() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn fingerprint_is_the_hash_of_the_canonical_serialization() {
        #[derive(Serialize)]
        struct P<'a> {
            name: &'a str,
            n: u32,
        }
        let a = fingerprint(&P {
            name: "atlas",
            n: 1,
        })
        .unwrap();
        // Versioned input (review I2): tag line, then the canonical JSON.
        assert_eq!(
            a,
            sha256_hex(b"sandpane-idem-v1\n{\"name\":\"atlas\",\"n\":1}")
        );
        assert_ne!(
            a,
            sha256_hex(br#"{"name":"atlas","n":1}"#),
            "untagged differs"
        );
        assert_eq!(a.len(), 64);
        assert_ne!(
            a,
            fingerprint(&P {
                name: "atlas",
                n: 2
            })
            .unwrap()
        );
    }

    #[test]
    fn claim_complete_and_lookup_outcomes() {
        let db = Database::open_in_memory().unwrap();
        let c = db.conn();
        assert_eq!(lookup(c, M, "k", "h1").unwrap(), Lookup::Absent);
        assert!(claim(c, M, "k", "h1", "2026-10-10T00:00:00Z").unwrap());
        assert_eq!(lookup(c, M, "k", "h1").unwrap(), Lookup::Pending);
        // Different params under the same key, whatever the state.
        assert_eq!(lookup(c, M, "k", "h2").unwrap(), Lookup::ParamsMismatch);
        // A second claim loses the race.
        assert!(!claim(c, M, "k", "h1", "2026-10-10T00:00:01Z").unwrap());
        assert!(complete(c, M, "k", r#"{"ok":1}"#, "2026-10-10T00:00:02Z").unwrap());
        assert_eq!(
            lookup(c, M, "k", "h1").unwrap(),
            Lookup::Done(r#"{"ok":1}"#.into())
        );
        assert_eq!(lookup(c, M, "k", "h2").unwrap(), Lookup::ParamsMismatch);
        // Completing twice, or releasing / unknown-marking a done row: no-op.
        assert!(!complete(c, M, "k", "{}", "t").unwrap());
        assert!(!release(c, M, "k").unwrap());
        assert!(!mark_unknown(c, M, "k", "t").unwrap());
        assert_eq!(state(&db, M, "k").unwrap().0, "done");
    }

    #[test]
    fn keys_are_namespaced_by_method() {
        let db = Database::open_in_memory().unwrap();
        let c = db.conn();
        assert!(insert_done(c, "conversation.send", "k", "h", "{}", "t").unwrap());
        assert_eq!(lookup(c, M, "k", "h").unwrap(), Lookup::Absent);
        assert!(claim(c, M, "k", "h", "t").unwrap());
        assert!(!insert_done(c, "conversation.send", "k", "h", "{}", "t").unwrap());
        assert_eq!(count(&db), 2);
    }

    #[test]
    fn release_only_frees_a_pending_claim_and_unknown_is_sticky() {
        let db = Database::open_in_memory().unwrap();
        let c = db.conn();
        assert!(claim(c, M, "free", "h", "t").unwrap());
        assert!(release(c, M, "free").unwrap());
        assert_eq!(lookup(c, M, "free", "h").unwrap(), Lookup::Absent);
        assert!(claim(c, M, "lost", "h", "t").unwrap());
        assert!(mark_unknown(c, M, "lost", "t2").unwrap());
        assert_eq!(lookup(c, M, "lost", "h").unwrap(), Lookup::Unknown);
        assert!(!release(c, M, "lost").unwrap(), "unknown is never freed");
        assert!(!complete(c, M, "lost", "{}", "t").unwrap(), "nor completed");
        assert_eq!(lookup(c, M, "lost", "h").unwrap(), Lookup::Unknown);
    }

    #[test]
    fn restart_turns_every_pending_row_unknown_and_nothing_else() {
        let db = Database::open_in_memory().unwrap();
        let c = db.conn();
        assert!(claim(c, M, "p1", "h", "t").unwrap());
        assert!(claim(c, "conversation.send", "p2", "h", "t").unwrap());
        assert!(insert_done(c, M, "d", "h", "{}", "t").unwrap());
        assert_eq!(reconcile_pending_to_unknown(c, "t9").unwrap(), 2);
        assert_eq!(state(&db, M, "p1").unwrap().0, "unknown");
        assert_eq!(state(&db, "conversation.send", "p2").unwrap().0, "unknown");
        assert_eq!(state(&db, M, "d").unwrap().0, "done");
        assert_eq!(reconcile_pending_to_unknown(c, "t9").unwrap(), 0);
    }

    #[test]
    fn prune_drops_expired_then_oldest_and_never_pending() {
        let db = Database::open_in_memory().unwrap();
        let c = db.conn();
        // Old rows: one done, one unknown, one pending.
        assert!(insert_done(c, M, "old-done", "h", "{}", "2026-10-08T00:00:00Z").unwrap());
        assert!(claim(c, M, "old-unknown", "h", "2026-10-08T00:00:01Z").unwrap());
        assert!(mark_unknown(c, M, "old-unknown", "t").unwrap());
        assert!(claim(c, M, "old-pending", "h", "2026-10-08T00:00:02Z").unwrap());
        // Fresh rows.
        for (i, k) in ["a", "b", "c", "d"].iter().enumerate() {
            let at = format!("2026-10-10T00:00:0{i}Z");
            assert!(insert_done(c, M, k, "h", "{}", &at).unwrap());
        }
        // Age prune at cutoff 2026-10-09 with a generous cap.
        assert_eq!(prune(c, "2026-10-09T00:00:00Z", 100).unwrap(), 2);
        assert!(state(&db, M, "old-done").is_none());
        assert!(state(&db, M, "old-unknown").is_none());
        assert_eq!(state(&db, M, "old-pending").unwrap().0, "pending");
        assert_eq!(count(&db), 5);
        // Cap 3: room for one insert → at most 2 rows remain, oldest
        // non-pending first; the pending row survives even over the cap.
        assert_eq!(prune(c, "2026-10-09T00:00:00Z", 3).unwrap(), 3);
        assert_eq!(state(&db, M, "old-pending").unwrap().0, "pending");
        assert_eq!(state(&db, M, "d").unwrap().0, "done");
        assert!(state(&db, M, "a").is_none() && state(&db, M, "c").is_none());
        assert_eq!(count(&db), 2);
    }
}
