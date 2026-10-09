//! SQLite persistence: schema, forward-only migrations, single-writer access
//! (docs/specs/02 §3). WAL mode, foreign keys ON.
//!
//! Sandpane stores its OWN project/task/conversation state here — never a
//! duplicate authoritative SBX sandbox inventory.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("migration {version} failed: {reason}")]
    Migration { version: i64, reason: String },
    #[error("database schema version {found} is newer than supported {supported}; refusing to run (no silent downgrade)")]
    TooNew { found: i64, supported: i64 },
}

#[derive(Debug)]
pub struct Database {
    conn: Connection,
    /// File path for on-disk databases (None for in-memory); used to take a
    /// backup before upgrading an existing schema.
    path: Option<PathBuf>,
}

/// Newest schema version this build understands.
pub const LATEST_SCHEMA_VERSION: i64 = 2;

/// Schema v1: the entity set from specs/02 §3.
const MIGRATION_V1: &str = r#"
CREATE TABLE projects (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    archived_at   TEXT
);

CREATE TABLE repositories (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    canonical_path TEXT NOT NULL,
    remote_url     TEXT
);

CREATE TABLE sandbox_bindings (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sandbox_name   TEXT NOT NULL,
    workspace_mode TEXT NOT NULL,
    repo_id        TEXT REFERENCES repositories(id),
    created_at     TEXT NOT NULL
);

CREATE TABLE conversations (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '',
    agent_id    TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    archived_at TEXT
);

CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    sequence        INTEGER NOT NULL
);

CREATE TABLE agent_sessions (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL,
    native_session_id   TEXT,
    capability_snapshot TEXT
);

CREATE TABLE tasks (
    id                 TEXT PRIMARY KEY,
    conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sandbox_binding_id TEXT REFERENCES sandbox_bindings(id),
    repo_id            TEXT REFERENCES repositories(id),
    base_commit        TEXT,
    task_branch        TEXT,
    workspace_mode     TEXT,
    status             TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE TABLE task_events (
    task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sequence  INTEGER NOT NULL,
    kind      TEXT NOT NULL,
    payload   TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    PRIMARY KEY (task_id, sequence)
);

CREATE TABLE task_artifacts (
    id        TEXT PRIMARY KEY,
    task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind      TEXT NOT NULL,
    file_path TEXT NOT NULL,
    checksum  TEXT
);

CREATE TABLE verifications (
    id             TEXT PRIMARY KEY,
    task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    command_label  TEXT NOT NULL,
    exit_code      INTEGER,
    output_artifact TEXT,
    created_at     TEXT NOT NULL
);

CREATE TABLE presets (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    -- Warning (specs/06 §5): configuration_json must never hold provider
    -- secrets; secrets belong to OS credential storage, not this table.
    configuration_json TEXT NOT NULL,
    version           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE project_context (
    project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    rules_json  TEXT NOT NULL,
    approved_at TEXT
);

CREATE TABLE workflows (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    definition_json TEXT NOT NULL
);

CREATE TABLE client_state (
    client_id           TEXT NOT NULL,
    project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    selected_conversation TEXT,
    PRIMARY KEY (client_id, project_id)
);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'user'
);

CREATE INDEX idx_tasks_status_updated ON tasks(status, updated_at);
-- Deviation note (review 0004 #24): specs/02 §3 names this index
-- conversations(project_id, updated_at); the conversations table has no
-- updated_at column, so archived_at (the recency proxy that exists) is
-- indexed instead. Deliberate; do not "correct" back without adding the column.
CREATE INDEX idx_conversations_project_updated ON conversations(project_id, archived_at);
CREATE INDEX idx_task_events_task_seq ON task_events(task_id, sequence);
CREATE INDEX idx_messages_conversation_seq ON messages(conversation_id, sequence);
"#;

/// Schema v2 (review 0015 bug 8): per-task event-sequence HIGH-WATER MARK so
/// pruning the newest events can never cause a sequence to be re-issued.
/// Backfilled from the events that exist at upgrade time.
const MIGRATION_V2: &str = r#"
ALTER TABLE tasks ADD COLUMN last_event_seq INTEGER NOT NULL DEFAULT 0;
UPDATE tasks SET last_event_seq =
    COALESCE((SELECT MAX(sequence) FROM task_events WHERE task_events.task_id = tasks.id), 0);
"#;

impl Database {
    /// Open (or create) the database at `path` and migrate to the latest
    /// schema. Refuses databases from a newer schema version.
    pub fn open(path: &Path) -> Result<Self, DbError> {
        let conn = Connection::open(path)?;
        let db = Self {
            conn,
            path: Some(path.to_path_buf()),
        };
        db.migrate()?;
        Ok(db)
    }

    /// In-memory database for tests.
    pub fn open_in_memory() -> Result<Self, DbError> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn, path: None };
        db.migrate()?;
        Ok(db)
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Current user_version pragma.
    pub fn schema_version(&self) -> Result<i64, DbError> {
        Ok(self
            .conn
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    /// Forward-only migration runner. Each version's SQL runs inside its own
    /// transaction; a failure rolls back that step and leaves the previous
    /// version intact.
    pub fn migrate(&self) -> Result<(), DbError> {
        // Version gate FIRST: refusing a too-new database must not have
        // already mutated its pragmas.
        let current = self.schema_version()?;
        if current > LATEST_SCHEMA_VERSION {
            return Err(DbError::TooNew {
                found: current,
                supported: LATEST_SCHEMA_VERSION,
            });
        }
        // journal_mode/busy_timeout pragmas RETURN rows; execute_batch handles
        // that where execute/pragma_update would error.
        self.conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
        )?;
        // Upgrading an EXISTING on-disk schema: take a consistent backup
        // first (core-protocol skill: migrations are backed up atomically).
        // A fresh database (version 0) has nothing to protect.
        if (1..LATEST_SCHEMA_VERSION).contains(&current) {
            self.backup_before_upgrade(current)?;
        }
        if current < 1 {
            self.apply_migration(1, MIGRATION_V1)?;
        }
        if current < 2 {
            self.apply_migration(2, MIGRATION_V2)?;
        }
        Ok(())
    }

    /// `VACUUM INTO` a sibling file `<db>.pre-v<N>.bak[.k]` — a transactionally
    /// consistent copy; an existing backup is never overwritten.
    fn backup_before_upgrade(&self, from_version: i64) -> Result<(), DbError> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let base = format!("{}.pre-v{}.bak", path.display(), from_version + 1);
        let mut target = PathBuf::from(&base);
        let mut k = 1;
        while target.exists() {
            target = PathBuf::from(format!("{base}.{k}"));
            k += 1;
        }
        let target_str = target.to_str().ok_or_else(|| DbError::Migration {
            version: from_version + 1,
            reason: "backup path is not valid UTF-8".into(),
        })?;
        self.conn
            .execute("VACUUM INTO ?1", rusqlite::params![target_str])
            .map_err(|e| DbError::Migration {
                version: from_version + 1,
                reason: format!("pre-migration backup failed: {e}"),
            })?;
        Ok(())
    }

    fn apply_migration(&self, version: i64, sql: &str) -> Result<(), DbError> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| DbError::Migration {
                version,
                reason: e.to_string(),
            })?;
        tx.execute_batch(sql).map_err(|e| DbError::Migration {
            version,
            reason: e.to_string(),
        })?;
        tx.pragma_update(None, "user_version", version)
            .map_err(|e| DbError::Migration {
                version,
                reason: e.to_string(),
            })?;
        tx.commit().map_err(|e| DbError::Migration {
            version,
            reason: e.to_string(),
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_creates_all_tables_and_indexes() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        let names: Vec<String> = db
            .conn()
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for expected in [
            "projects",
            "repositories",
            "sandbox_bindings",
            "conversations",
            "messages",
            "agent_sessions",
            "tasks",
            "task_events",
            "task_artifacts",
            "verifications",
            "presets",
            "project_context",
            "workflows",
            "client_state",
            "settings",
            "idx_tasks_status_updated",
            "idx_conversations_project_updated",
            "idx_task_events_task_seq",
            "idx_messages_conversation_seq",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing {expected}");
        }
    }

    #[test]
    fn foreign_keys_enforced() {
        let db = Database::open_in_memory().unwrap();
        // tasks references conversations; inserting an orphan must fail.
        let r = db.conn().execute(
            "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at) VALUES ('t1','missing','created','now','now')",
            [],
        );
        assert!(r.is_err());
    }

    #[test]
    fn wal_and_idempotent_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sandpane.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .execute(
                    "INSERT INTO projects (id, name, created_at) VALUES ('p1','Atlas Demo','2026-10-09')",
                    [],
                )
                .unwrap();
        }
        // Reopening migrates nothing new and preserves data.
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        let mode: String = db
            .conn()
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    /// Bug 8 migration: a REAL v1 file (built with the v1 SQL, events
    /// present, newest pruned) upgrades forward to v2 with the high-water mark
    /// backfilled, a backup taken, and no sequence reuse afterwards.
    #[test]
    fn v1_database_migrates_forward_to_v2_with_backfill_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute_batch(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
                 INSERT INTO conversations (id,project_id,agent_id,created_at) VALUES ('c1','p1','codex','t');
                 INSERT INTO tasks (id,conversation_id,status,created_at,updated_at) VALUES ('t1','c1','queued','t','t');
                 INSERT INTO tasks (id,conversation_id,status,created_at,updated_at) VALUES ('t2','c1','queued','t','t');
                 INSERT INTO task_events VALUES ('t1',1,'k','{}','ts');
                 INSERT INTO task_events VALUES ('t1',2,'k','{}','ts');
                 INSERT INTO task_events VALUES ('t1',3,'k','{}','ts');",
            )
            .unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), 2);
        let hw = |id: &str| -> i64 {
            db.conn()
                .query_row("SELECT last_event_seq FROM tasks WHERE id=?1", [id], |r| {
                    r.get(0)
                })
                .unwrap()
        };
        assert_eq!(hw("t1"), 3);
        assert_eq!(hw("t2"), 0);
        // Backup of the v1 file exists and is still v1.
        let backup = dir.path().join("core.sqlite3.pre-v2.bak");
        assert!(backup.exists());
        let b = Connection::open(&backup).unwrap();
        let v: i64 = b
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
        // Prune the newest event, append: never reuses 3.
        let log = crate::events::EventLog::new(&db);
        log.prune_before("t1", 4).unwrap();
        let e = log.append("t1", "k", &serde_json::json!({}), "ts").unwrap();
        assert_eq!(e.sequence, 4);
        drop(db);
        // Re-open: idempotent, no second backup for an up-to-date schema.
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), 2);
        assert!(!dir.path().join("core.sqlite3.pre-v2.bak.1").exists());
    }

    #[test]
    fn newer_schema_refuses_downgrade() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("future.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", 99).unwrap();
        }
        let err = Database::open(&path).unwrap_err();
        assert!(matches!(err, DbError::TooNew { found: 99, .. }));
    }
}
