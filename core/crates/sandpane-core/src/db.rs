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
pub const LATEST_SCHEMA_VERSION: i64 = 8;

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

/// Schema v3 (C3, task Git context): v1 already carries `repo_id`,
/// `base_commit`, `task_branch` and `workspace_mode` on `tasks`; v3 adds the
/// Core-owned worktree directory a `host_worktree` task was given and when
/// Core removed it. The path is KEPT after removal (audit trail; the
/// `worktree_removed_at` marker says it is gone). One directory per task is
/// enforced by a partial unique index — every existing row is NULL, so the
/// index cannot fail on upgrade.
const MIGRATION_V3: &str = r#"
ALTER TABLE tasks ADD COLUMN worktree_path TEXT;
ALTER TABLE tasks ADD COLUMN worktree_removed_at TEXT;
CREATE UNIQUE INDEX idx_tasks_worktree_path ON tasks(worktree_path)
    WHERE worktree_path IS NOT NULL;
"#;

/// Schema v4 (A1, `sandbox.remove`): a binding is MARKED removed when Core
/// removed its sandbox through the confirmed two-step flow — the row is kept
/// (audit trail; tasks may still reference it) and never deleted. Reads that
/// report a binding as in force (`sandbox.list` mode/project join, the
/// `external` check) consider only rows with `removed_at IS NULL`, so a new
/// sandbox that reuses the name never inherits the removed one's mode. Every
/// existing row is NULL (still in force) after the upgrade.
///
/// `sbx_id` records the sbx `id` of the sandbox the binding was made for
/// (from the post-create `ls --json` re-query), so "did Sandpane create THIS
/// sandbox" is answered by identity, not by name (review W1). Pre-A1 rows
/// stay NULL — never back-filled or guessed — and are reported as unable to
/// confirm Sandpane created the sandbox.
const MIGRATION_V4: &str = r#"
ALTER TABLE sandbox_bindings ADD COLUMN removed_at TEXT;
ALTER TABLE sandbox_bindings ADD COLUMN sbx_id TEXT;
"#;

/// Schema v5 (A2, design 2026-10-09 §3.1): durable idempotency keys.
/// One row per (method, key) — keys are namespaced by method. `params_hash`
/// is the SHA-256 fingerprint of the typed params (never the params: prompt
/// text is not stored twice). `state` is `pending` (claimed, running),
/// `done` (succeeded; `result_json` holds the exact result) or `unknown`
/// (Core restarted, or sbx failed, while it ran — refused with that key
/// within the 24 h retention window). Timestamps are fixed-width RFC 3339 UTC, so text order is time
/// order for the 24 h retention prune.
const MIGRATION_V5: &str = r#"
CREATE TABLE idempotency_keys (
    method       TEXT NOT NULL,
    key          TEXT NOT NULL,
    params_hash  TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('pending', 'done', 'unknown')),
    result_json  TEXT CHECK (state <> 'done' OR result_json IS NOT NULL),
    created_at   TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (method, key)
);
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);
"#;

/// Schema v6 (A3b, design 2026-10-09 §3.3 item 3): the sandbox NAME chosen
/// when a conversation was created (`conversation.create` validates it with
/// `Validator::sandbox_name`; it was previously discarded). A stored name,
/// not a binding or identity: nothing checks the sandbox still exists. Rows
/// created before v6 stay NULL — never back-filled or guessed.
const MIGRATION_V6: &str = r#"
ALTER TABLE conversations ADD COLUMN sandbox_id TEXT;
"#;

/// Schema v7 (A4, design 2026-10-09 §3.4): per task, the send `mode`
/// (`"task"` | `"discuss"`) and `chosen_sandbox_name` — the sandbox NAME
/// copied from the conversation's `sandbox_id` when the task was sent. Both
/// are stored facts about the request. `chosen_sandbox_name` is NOT a
/// binding and never means "runs in" (that is `sandbox_binding_id`; review
/// C1/C2). Indexed for the `sandbox.remove` impact count (review I2). Rows
/// created before v7 stay NULL — never back-filled or guessed.
const MIGRATION_V7: &str = r#"
ALTER TABLE tasks ADD COLUMN mode TEXT;
ALTER TABLE tasks ADD COLUMN chosen_sandbox_name TEXT;
CREATE INDEX idx_tasks_chosen_sandbox_name ON tasks(chosen_sandbox_name);
"#;

/// Schema v8 (A7, design 2026-10-09 §3.7 item 7): user-approved
/// verification commands and their runs.
///
/// `verification_commands` — an exact argv (`argv_json`, a JSON array of
/// strings proven clean of secrets at approve) plus its label. A revoke
/// TOMBSTONES the row (`revoked_at`), never deletes it, so older events'
/// `commandId` still resolves; the partial unique index allows one LIVE row
/// per (project, argv) — approving the same argv again returns that row.
///
/// `verification_runs` — one row per `verification.run`. `status` is
/// `running` until exactly ONE terminal write (`UPDATE … WHERE status =
/// 'running'`) makes it `finished` (or `interrupted` at shutdown / restart
/// reconciliation); `outcome` is the open outcome string. `stdout`/`stderr`
/// hold the capped (64 KiB) output AFTER best-effort redaction — the only
/// place output is kept (never in events). `sandbox_name`, `workspace_mode`,
/// `argv_json` and `label` are copied at start, so later revokes or relabels
/// never change what a run says it ran. `elapsed_ms` is an addition to the
/// §3.7 item 7 column list (the result's `elapsedMs` needs millisecond
/// precision that the RFC 3339 timestamps do not have).
///
/// The unused pre-A7 `verifications` table stays as is. Explicit delete
/// order (A3a/A3b): runs before tasks; commands before projects (`ON DELETE
/// CASCADE` is only a backstop).
const MIGRATION_V8: &str = r#"
CREATE TABLE verification_commands (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    argv_json   TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    revoked_at  TEXT
);
CREATE UNIQUE INDEX idx_verification_commands_live_argv
    ON verification_commands(project_id, argv_json) WHERE revoked_at IS NULL;
CREATE INDEX idx_verification_commands_project
    ON verification_commands(project_id, approved_at);

CREATE TABLE verification_runs (
    id               TEXT PRIMARY KEY,
    task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    command_id       TEXT NOT NULL REFERENCES verification_commands(id) ON DELETE CASCADE,
    sandbox_name     TEXT NOT NULL,
    workspace_mode   TEXT NOT NULL,
    argv_json        TEXT NOT NULL,
    label            TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('running', 'finished', 'interrupted')),
    exit_code        INTEGER,
    outcome          TEXT,
    stdout           TEXT NOT NULL DEFAULT '',
    stderr           TEXT NOT NULL DEFAULT '',
    stdout_truncated INTEGER NOT NULL DEFAULT 0,
    stderr_truncated INTEGER NOT NULL DEFAULT 0,
    redactions_json  TEXT,
    started_sequence INTEGER NOT NULL,
    started_at       TEXT NOT NULL,
    finished_at      TEXT,
    elapsed_ms       INTEGER,
    output_incomplete INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_verification_runs_task ON verification_runs(task_id);
CREATE INDEX idx_verification_runs_status ON verification_runs(status);
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
        if current < 3 {
            self.apply_migration(3, MIGRATION_V3)?;
        }
        if current < 4 {
            self.apply_migration(4, MIGRATION_V4)?;
        }
        if current < 5 {
            self.apply_migration(5, MIGRATION_V5)?;
        }
        if current < 6 {
            self.apply_migration(6, MIGRATION_V6)?;
        }
        if current < 7 {
            self.apply_migration(7, MIGRATION_V7)?;
        }
        if current < 8 {
            self.apply_migration(8, MIGRATION_V8)?;
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
            "idx_tasks_worktree_path",
            "idempotency_keys",
            "idx_idempotency_keys_created",
            "verification_commands",
            "verification_runs",
            "idx_verification_commands_live_argv",
            "idx_verification_runs_task",
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
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
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
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        assert!(!dir.path().join("core.sqlite3.pre-v2.bak.1").exists());
    }

    /// C3 migration: a REAL v2 file (built with the v1 + v2 SQL, a task row
    /// carrying Git context written the v1 way) upgrades forward to v3: rows
    /// intact, the new task-worktree columns present and NULL, a consistent
    /// backup of the v2 file taken, and one worktree path per task enforced.
    #[test]
    fn v2_database_migrates_forward_to_v3_preserving_rows_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite3");
        let base = "a".repeat(40);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.execute_batch(MIGRATION_V2).unwrap();
            conn.pragma_update(None, "user_version", 2).unwrap();
            conn.execute_batch(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
                 INSERT INTO repositories (id,project_id,canonical_path) VALUES ('r1','p1','/repo/atlas');
                 INSERT INTO conversations (id,project_id,agent_id,created_at) VALUES ('c1','p1','codex','t');",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO tasks (id,conversation_id,repo_id,base_commit,task_branch,workspace_mode,status,created_at,updated_at,last_event_seq)
                 VALUES ('t1','c1','r1',?1,'sandpane/t1','direct_mount','queued','t','t',1)",
                [&base],
            )
            .unwrap();
            conn.execute_batch("INSERT INTO task_events VALUES ('t1',1,'k','{}','ts');")
                .unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        let row: (String, String, String, Option<String>, Option<String>, i64) = db
            .conn()
            .query_row(
                "SELECT repo_id, base_commit, task_branch, worktree_path, worktree_removed_at,
                        last_event_seq FROM tasks WHERE id='t1'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "r1".into(),
                base.clone(),
                "sandpane/t1".into(),
                None,
                None,
                1
            )
        );
        // The v2 file was backed up before the upgrade and is still v2.
        let backup = dir.path().join("core.sqlite3.pre-v3.bak");
        assert!(backup.exists());
        let b = Connection::open(&backup).unwrap();
        let v: i64 = b
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 2);
        // One worktree directory per task (partial unique index; NULLs free).
        db.conn()
            .execute_batch(
                "INSERT INTO tasks (id,conversation_id,status,created_at,updated_at) VALUES ('t2','c1','queued','t','t');
                 INSERT INTO tasks (id,conversation_id,status,created_at,updated_at) VALUES ('t3','c1','queued','t','t');
                 UPDATE tasks SET worktree_path='/wt/x' WHERE id='t2';",
            )
            .unwrap();
        assert!(db
            .conn()
            .execute("UPDATE tasks SET worktree_path='/wt/x' WHERE id='t3'", [])
            .is_err());
        drop(db);
        // Re-open: idempotent, no second backup.
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        assert!(!dir.path().join("core.sqlite3.pre-v3.bak.1").exists());
    }

    /// A1 migration: a REAL v3 file (v1+v2+v3 SQL, a binding row written the
    /// pre-A1 way) upgrades forward to v4: the binding row is intact with
    /// `removed_at` NULL (still in force), a consistent backup of the v3 file
    /// is taken, and marking a binding removed is an UPDATE, never a delete.
    #[test]
    fn v3_database_migrates_forward_to_v4_with_removed_at_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATION_V1).unwrap();
            conn.execute_batch(MIGRATION_V2).unwrap();
            conn.execute_batch(MIGRATION_V3).unwrap();
            conn.pragma_update(None, "user_version", 3).unwrap();
            conn.execute_batch(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
                 INSERT INTO sandbox_bindings (id,project_id,sandbox_name,workspace_mode,created_at)
                     VALUES ('b1','p1','atlas-auth','direct_mount','t');",
            )
            .unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        let row: (String, String, Option<String>) = db
            .conn()
            .query_row(
                "SELECT sandbox_name, workspace_mode, removed_at FROM sandbox_bindings WHERE id='b1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("atlas-auth".into(), "direct_mount".into(), None));
        // Pre-A1 rows carry no sbx identity: NULL, never back-filled or guessed.
        let sbx_id: Option<String> = db
            .conn()
            .query_row(
                "SELECT sbx_id FROM sandbox_bindings WHERE id='b1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sbx_id, None);
        let backup = dir.path().join("core.sqlite3.pre-v4.bak");
        assert!(backup.exists());
        let b = Connection::open(&backup).unwrap();
        let v: i64 = b
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 3);
        db.conn()
            .execute(
                "UPDATE sandbox_bindings SET removed_at='t2' WHERE sandbox_name='atlas-auth'",
                [],
            )
            .unwrap();
        let kept: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM sandbox_bindings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "a removed binding is marked, never deleted");
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        assert!(!dir.path().join("core.sqlite3.pre-v4.bak.1").exists());
    }

    /// A2 migration: a REAL v4 file (v1..v4 SQL, a binding row) upgrades
    /// forward to v5: existing rows intact, the `idempotency_keys` table
    /// present and empty, a consistent `.pre-v5.bak` of the v4 file taken,
    /// keys unique per (method, key), and the state/result invariants
    /// enforced by CHECK constraints.
    #[test]
    fn v4_database_migrates_forward_to_v5_with_idempotency_keys_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            for sql in [MIGRATION_V1, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", 4).unwrap();
            conn.execute_batch(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
                 INSERT INTO sandbox_bindings (id,project_id,sandbox_name,workspace_mode,created_at,sbx_id)
                     VALUES ('b1','p1','atlas-auth','mountless','t','b5ebec73');",
            )
            .unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        let binding: String = db
            .conn()
            .query_row(
                "SELECT sbx_id FROM sandbox_bindings WHERE id='b1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(binding, "b5ebec73");
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM idempotency_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        let backup = dir.path().join("core.sqlite3.pre-v5.bak");
        assert!(backup.exists());
        let b = Connection::open(&backup).unwrap();
        let v: i64 = b
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 4);
        let c = db.conn();
        c.execute(
            "INSERT INTO idempotency_keys (method,key,params_hash,state,created_at)
             VALUES ('sandbox.create','k1','h','pending','t')",
            [],
        )
        .unwrap();
        // Same key under ANOTHER method is a separate row (namespaced).
        c.execute(
            "INSERT INTO idempotency_keys (method,key,params_hash,state,result_json,created_at)
             VALUES ('conversation.send','k1','h','done','{}','t')",
            [],
        )
        .unwrap();
        // Same (method, key) twice is refused.
        assert!(c
            .execute(
                "INSERT INTO idempotency_keys (method,key,params_hash,state,created_at)
                 VALUES ('sandbox.create','k1','h2','pending','t')",
                [],
            )
            .is_err());
        // Unknown state, and `done` without a result, are refused.
        for bad in [
            "INSERT INTO idempotency_keys (method,key,params_hash,state,created_at) VALUES ('m','k2','h','running','t')",
            "INSERT INTO idempotency_keys (method,key,params_hash,state,created_at) VALUES ('m','k3','h','done','t')",
        ] {
            assert!(c.execute(bad, []).is_err(), "{bad}");
        }
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        assert!(!dir.path().join("core.sqlite3.pre-v5.bak.1").exists());
    }

    /// A3b migration: a REAL v5 file (v1..v5 SQL, a conversation written the
    /// pre-A3b way) upgrades forward to v6: the row intact with `sandbox_id`
    /// NULL (never back-filled), a consistent `.pre-v6.bak` of the v5 file
    /// taken, and the new column writable.
    #[test]
    fn v5_database_migrates_forward_to_v6_with_conversation_sandbox_id_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            for sql in [
                MIGRATION_V1,
                MIGRATION_V2,
                MIGRATION_V3,
                MIGRATION_V4,
                MIGRATION_V5,
            ] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", 5).unwrap();
            conn.execute_batch(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
                 INSERT INTO conversations (id,project_id,title,agent_id,created_at)
                     VALUES ('c1','p1','Old chat','codex','t');
                 INSERT INTO idempotency_keys (method,key,params_hash,state,result_json,created_at)
                     VALUES ('conversation.send','k1','h','done','{}','t');",
            )
            .unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        let row: (String, Option<String>, Option<String>) = db
            .conn()
            .query_row(
                "SELECT title, archived_at, sandbox_id FROM conversations WHERE id='c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("Old chat".into(), None, None), "never back-filled");
        let keys: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM idempotency_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(keys, 1, "v5 rows intact");
        let backup = dir.path().join("core.sqlite3.pre-v6.bak");
        assert!(backup.exists());
        let b = Connection::open(&backup).unwrap();
        let v: i64 = b
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 5);
        let has_col: i64 = b
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('conversations') WHERE name='sandbox_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_col, 0, "the backup is the untouched v5 schema");
        db.conn()
            .execute(
                "UPDATE conversations SET sandbox_id='atlas-auth' WHERE id='c1'",
                [],
            )
            .unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        assert!(!dir.path().join("core.sqlite3.pre-v6.bak.1").exists());
    }

    /// A4 migration: a REAL v6 file (v1..v6 SQL, a task row written the
    /// pre-A4 way) upgrades forward to v7: the row intact with `mode` and
    /// `chosen_sandbox_name` NULL (never back-filled), a consistent
    /// `.pre-v7.bak` of the v6 file taken, both new columns writable, the
    /// count index present, and no `sandbox_name` column overloading the
    /// binding's meaning.
    #[test]
    fn v6_database_migrates_forward_to_v7_with_task_mode_and_chosen_sandbox_name_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            for sql in [
                MIGRATION_V1,
                MIGRATION_V2,
                MIGRATION_V3,
                MIGRATION_V4,
                MIGRATION_V5,
                MIGRATION_V6,
            ] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", 6).unwrap();
            conn.execute_batch(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
                 INSERT INTO conversations (id,project_id,title,agent_id,created_at,sandbox_id)
                     VALUES ('c1','p1','Chat','codex','t','atlas-auth');
                 INSERT INTO tasks (id,conversation_id,status,created_at,updated_at)
                     VALUES ('t1','c1','queued','t','t');",
            )
            .unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        let row: (String, Option<String>, Option<String>) = db
            .conn()
            .query_row(
                "SELECT status, mode, chosen_sandbox_name FROM tasks WHERE id='t1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("queued".into(), None, None), "never back-filled");
        let backup = dir.path().join("core.sqlite3.pre-v7.bak");
        assert!(backup.exists());
        let b = Connection::open(&backup).unwrap();
        let v: i64 = b
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 6);
        let cols: i64 = b
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tasks')
                 WHERE name IN ('mode','chosen_sandbox_name','sandbox_name')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cols, 0, "the backup is the untouched v6 schema");
        db.conn()
            .execute(
                "UPDATE tasks SET mode='discuss', chosen_sandbox_name='atlas-auth' WHERE id='t1'",
                [],
            )
            .unwrap();
        // Review I2: the remove-impact count is indexed.
        let idx: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM pragma_index_list('tasks') l
                 JOIN pragma_index_info(l.name) i
                 WHERE i.name = 'chosen_sandbox_name'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1, "an index on tasks(chosen_sandbox_name)");
        // v7 never added a column that overloads the binding's name.
        let overloaded: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = 'sandbox_name'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(overloaded, 0);
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), LATEST_SCHEMA_VERSION);
        assert!(!dir.path().join("core.sqlite3.pre-v7.bak.1").exists());
    }

    /// A7 migration: a REAL v7 file (v1..v7 SQL, a project + task written
    /// the pre-A7 way) upgrades forward to v8: rows intact, the two
    /// verification tables present and empty, a consistent `.pre-v8.bak` of
    /// the v7 file taken, the unused pre-A7 `verifications` table kept as
    /// is, one LIVE command per (project, argv) enforced, and the run
    /// status set constrained.
    #[test]
    fn v7_database_migrates_forward_to_v8_with_verification_tables_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            for sql in [
                MIGRATION_V1,
                MIGRATION_V2,
                MIGRATION_V3,
                MIGRATION_V4,
                MIGRATION_V5,
                MIGRATION_V6,
                MIGRATION_V7,
            ] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", 7).unwrap();
            conn.execute_batch(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
                 INSERT INTO conversations (id,project_id,title,agent_id,created_at)
                     VALUES ('c1','p1','Chat','codex','t');
                 INSERT INTO tasks (id,conversation_id,status,created_at,updated_at,mode)
                     VALUES ('t1','c1','queued','t','t','task');
                 INSERT INTO verifications (id,task_id,command_label,created_at)
                     VALUES ('v-old','t1','legacy','t');",
            )
            .unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(LATEST_SCHEMA_VERSION, 8);
        assert_eq!(db.schema_version().unwrap(), 8);
        let c = db.conn();
        let one = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            one("SELECT COUNT(*) FROM tasks WHERE id='t1' AND mode='task'"),
            1
        );
        assert_eq!(
            one("SELECT COUNT(*) FROM verifications"),
            1,
            "pre-A7 table kept"
        );
        assert_eq!(one("SELECT COUNT(*) FROM verification_commands"), 0);
        assert_eq!(one("SELECT COUNT(*) FROM verification_runs"), 0);
        let backup = dir.path().join("core.sqlite3.pre-v8.bak");
        assert!(backup.exists());
        let b = Connection::open(&backup).unwrap();
        let v: i64 = b
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 7);
        let tables: i64 = b
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('verification_commands', 'verification_runs')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0, "the backup is the untouched v7 schema");
        // Columns exactly as §3.7 item 7 lists them (+ elapsed_ms).
        let cols = |t: &str| -> Vec<String> {
            let mut st = c
                .prepare(&format!(
                    "SELECT name FROM pragma_table_info('{t}') ORDER BY cid"
                ))
                .unwrap();
            st.query_map([], |r| r.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        assert_eq!(
            cols("verification_commands"),
            [
                "id",
                "project_id",
                "label",
                "argv_json",
                "approved_at",
                "revoked_at"
            ]
        );
        assert_eq!(
            cols("verification_runs"),
            [
                "id",
                "task_id",
                "command_id",
                "sandbox_name",
                "workspace_mode",
                "argv_json",
                "label",
                "status",
                "exit_code",
                "outcome",
                "stdout",
                "stderr",
                "stdout_truncated",
                "stderr_truncated",
                "redactions_json",
                "started_sequence",
                "started_at",
                "finished_at",
                "elapsed_ms",
                "output_incomplete"
            ]
        );
        c.execute_batch(
            "INSERT INTO verification_commands (id,project_id,label,argv_json,approved_at)
                 VALUES ('vc1','p1','tests','[\"make\",\"test\"]','t');",
        )
        .unwrap();
        // The same argv twice while live is refused by the index…
        assert!(c
            .execute(
                "INSERT INTO verification_commands (id,project_id,label,argv_json,approved_at)
                 VALUES ('vc2','p1','again','[\"make\",\"test\"]','t')",
                [],
            )
            .is_err());
        // …but allowed once the first is revoked (tombstone, never deleted).
        c.execute(
            "UPDATE verification_commands SET revoked_at='t2' WHERE id='vc1'",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO verification_commands (id,project_id,label,argv_json,approved_at)
             VALUES ('vc2','p1','again','[\"make\",\"test\"]','t')",
            [],
        )
        .unwrap();
        let run = |id: &str, status: &str| {
            c.execute(
                "INSERT INTO verification_runs (id,task_id,command_id,sandbox_name,workspace_mode,
                     argv_json,label,status,started_sequence,started_at)
                 VALUES (?1,'t1','vc1','atlas-auth','mountless','[]','tests',?2,1,'t')",
                rusqlite::params![id, status],
            )
        };
        run("r1", "running").unwrap();
        assert!(run("r2", "paused").is_err(), "status is constrained");
        // A run references its task and command (foreign keys on).
        assert!(c
            .execute(
                "INSERT INTO verification_runs (id,task_id,command_id,sandbox_name,workspace_mode,
                     argv_json,label,status,started_sequence,started_at)
                 VALUES ('r3','nope','vc1','a','mountless','[]','x','running',1,'t')",
                [],
            )
            .is_err());
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), 8);
        assert!(!dir.path().join("core.sqlite3.pre-v8.bak.1").exists());
    }

    /// A database written by a NEWER Core (v9) is refused untouched — no
    /// pragma, no backup, no migration (no silent downgrade).
    #[test]
    fn v9_database_is_refused_by_a_v8_core() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", 9).unwrap();
        }
        let err = Database::open(&path).unwrap_err();
        assert!(
            matches!(
                err,
                DbError::TooNew {
                    found: 9,
                    supported: 8
                }
            ),
            "{err}"
        );
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            names.iter().all(|n| !n.contains(".bak")),
            "no backup taken: {names:?}"
        );
        let conn = Connection::open(&path).unwrap();
        let v: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, 9, "left untouched");
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
