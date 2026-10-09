//! Append-only, replayable task event log (docs/specs/02 §3-§4).
//!
//! Events are written durably BEFORE subscribers are notified; clients
//! reconnect with `after_sequence` and catch up deterministically.

use rusqlite::{params, Connection};
use sandpane_protocol::TaskEvent;

use crate::db::{Database, DbError};

pub struct EventLog<'a> {
    conn: &'a Connection,
}

impl<'a> EventLog<'a> {
    pub fn new(db: &'a Database) -> Self {
        Self { conn: db.conn() }
    }

    /// Build a log scoped to an in-flight transaction's connection, so
    /// event appends and the matching state writes commit atomically.
    pub fn from_conn(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Append an event; assigns the next per-task sequence number from the
    /// task's durable HIGH-WATER MARK (`tasks.last_event_seq`, schema v2), not
    /// from `MAX(sequence)` of the surviving rows — after `prune_before`
    /// removed the newest events, MAX+1 re-issued numbers clients had already
    /// seen, so a reconnect could skip or mis-order events (review 0015 bug 8).
    /// A failed insert after the bump leaves a gap, which is harmless; reuse
    /// never happens. `timestamp` is RFC3339 UTC supplied by the caller (core
    /// owns the clock so replays are stable).
    pub fn append(
        &self,
        task_id: &str,
        kind: &str,
        payload: &serde_json::Value,
        timestamp: &str,
    ) -> Result<TaskEvent, DbError> {
        // MAX(...) with the surviving rows is defensive: it keeps sequences
        // unique even if a row was ever inserted without bumping the mark.
        let next: i64 = self.conn.query_row(
            "UPDATE tasks SET last_event_seq = MAX(last_event_seq,
                 COALESCE((SELECT MAX(sequence) FROM task_events WHERE task_id = ?1), 0)) + 1
             WHERE id = ?1
             RETURNING last_event_seq",
            params![task_id],
            |r| r.get(0),
        )?;
        let payload_str = serde_json::to_string(payload).unwrap_or_else(|_| "null".into());
        self.conn.execute(
            "INSERT INTO task_events (task_id, sequence, kind, payload, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![task_id, next, kind, payload_str, timestamp],
        )?;
        Ok(TaskEvent {
            task_id: task_id.to_string(),
            sequence: next,
            kind: kind.to_string(),
            payload: payload.clone(),
            timestamp: timestamp.to_string(),
        })
    }

    /// Replay events for one task strictly after `after_sequence`.
    pub fn replay_task(
        &self,
        task_id: &str,
        after_sequence: i64,
    ) -> Result<Vec<TaskEvent>, DbError> {
        let mut stmt = self.conn.prepare(
            "SELECT task_id, sequence, kind, payload, timestamp FROM task_events
             WHERE task_id = ?1 AND sequence > ?2 ORDER BY sequence ASC",
        )?;
        let rows = stmt.query_map(params![task_id, after_sequence], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (task_id, sequence, kind, payload, timestamp) = row?;
            out.push(TaskEvent {
                task_id,
                sequence,
                kind,
                payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
                timestamp,
            });
        }
        Ok(out)
    }

    /// Bounded retention: delete events for a task below a keep-from sequence.
    /// Used only by explicit user-controlled cleanup, never silently.
    pub fn prune_before(&self, task_id: &str, keep_from_sequence: i64) -> Result<usize, DbError> {
        let n = self.conn.execute(
            "DELETE FROM task_events WHERE task_id = ?1 AND sequence < ?2",
            params![task_id, keep_from_sequence],
        )?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn with_task<F: FnOnce(&Database)>(f: F) {
        let db = Database::open_in_memory().unwrap();
        db.conn()
            .execute(
                "INSERT INTO projects (id, name, created_at) VALUES ('p1','Atlas Demo','t')",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO conversations (id, project_id, agent_id, created_at) VALUES ('c1','p1','codex','t')",
                [],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at) VALUES ('t1','c1','created','t','t')",
                [],
            )
            .unwrap();
        f(&db);
    }

    #[test]
    fn append_assigns_increasing_sequences() {
        with_task(|db| {
            let log = EventLog::new(db);
            let e1 = log
                .append("t1", "status.changed", &json!({"to": "queued"}), "ts1")
                .unwrap();
            let e2 = log
                .append("t1", "message.delta", &json!({"text": "hi"}), "ts2")
                .unwrap();
            assert_eq!(e1.sequence, 1);
            assert_eq!(e2.sequence, 2);
        });
    }

    #[test]
    fn replay_from_checkpoint_is_ordered_and_exclusive() {
        with_task(|db| {
            let log = EventLog::new(db);
            for i in 0..5 {
                log.append("t1", "message.delta", &json!({"text": i}), "ts")
                    .unwrap();
            }
            let all = log.replay_task("t1", 0).unwrap();
            assert_eq!(all.len(), 5);
            let tail = log.replay_task("t1", 3).unwrap();
            assert_eq!(tail.len(), 2);
            assert_eq!(tail[0].sequence, 4);
            assert_eq!(tail[1].sequence, 5);
            // Idempotent reconnect: replaying the same checkpoint twice yields the same set.
            let tail2 = log.replay_task("t1", 3).unwrap();
            assert_eq!(tail.len(), tail2.len());
        });
    }

    #[test]
    fn events_are_isolated_per_task() {
        with_task(|db| {
            db.conn()
                .execute(
                    "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at) VALUES ('t2','c1','created','t','t')",
                    [],
                )
                .unwrap();
            let log = EventLog::new(db);
            log.append("t1", "k", &json!({}), "ts").unwrap();
            log.append("t2", "k", &json!({}), "ts").unwrap();
            assert_eq!(log.replay_task("t1", 0).unwrap().len(), 1);
            assert_eq!(log.replay_task("t2", 0).unwrap()[0].sequence, 1);
        });
    }

    #[test]
    fn unicode_and_hostile_payloads_roundtrip() {
        with_task(|db| {
            let log = EventLog::new(db);
            let payload = json!({"text": "日本語 ✓ ; rm -rf / $(whoami) `id`"});
            log.append("t1", "message.delta", &payload, "ts").unwrap();
            let back = log.replay_task("t1", 0).unwrap();
            assert_eq!(back[0].payload, payload);
        });
    }

    /// Bug 8: pruning (or deleting) the newest events must never let a later
    /// append reuse a sequence number a client may already have seen.
    #[test]
    fn sequences_are_never_reused_after_prune() {
        with_task(|db| {
            let log = EventLog::new(db);
            for _ in 0..4 {
                log.append("t1", "k", &json!({}), "ts").unwrap();
            }
            // Prune EVERYTHING (keep-from beyond the newest).
            assert_eq!(log.prune_before("t1", 100).unwrap(), 4);
            let e = log.append("t1", "k", &json!({}), "ts").unwrap();
            assert_eq!(e.sequence, 5, "sequence reused after prune");
            let hw: i64 = db
                .conn()
                .query_row("SELECT last_event_seq FROM tasks WHERE id='t1'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(hw, 5);
        });
    }

    #[test]
    fn append_to_unknown_task_fails() {
        with_task(|db| {
            assert!(EventLog::new(db)
                .append("missing", "k", &json!({}), "ts")
                .is_err());
        });
    }

    #[test]
    fn prune_is_explicit_and_bounded() {
        with_task(|db| {
            let log = EventLog::new(db);
            for _ in 0..4 {
                log.append("t1", "k", &json!({}), "ts").unwrap();
            }
            let removed = log.prune_before("t1", 3).unwrap();
            assert_eq!(removed, 2);
            let rest = log.replay_task("t1", 0).unwrap();
            assert_eq!(rest.len(), 2);
            assert_eq!(rest[0].sequence, 3);
        });
    }
}
