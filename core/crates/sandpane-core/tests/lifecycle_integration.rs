//! Cross-module integration: SQLite + event log + state machine + scheduler,
//! including the crash-reconciliation rule from docs/specs/02 §4:
//! after a Core restart, tasks still marked `running` become `interrupted`;
//! nothing is silently auto-resumed, and the scheduler starts empty.

use rusqlite::params;
use sandpane_core::db::Database;
use sandpane_core::events::EventLog;
use sandpane_core::scheduler::{Admission, Limits, Scheduler};
use sandpane_core::task::TaskStateMachine;
use sandpane_protocol::{TaskStatus, WorkspaceMode};

fn seed(db: &Database, task_id: &str) {
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
            "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at)
             VALUES (?1,'c1','created','t','t')",
            params![task_id],
        )
        .unwrap();
}

fn advance(db: &Database, machine: &mut TaskStateMachine, task_id: &str, to: TaskStatus, ts: &str) {
    machine.transition(to).expect("legal transition");
    let log = EventLog::new(db);
    log.append(
        task_id,
        "status.changed",
        &serde_json::json!({ "to": to }),
        ts,
    )
    .unwrap();
    db.conn()
        .execute(
            "UPDATE tasks SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![
                task_id,
                serde_json::to_string(&to).unwrap().replace('"', ""),
                ts
            ],
        )
        .unwrap();
}

#[test]
fn lifecycle_events_replay_in_order_with_sequences() {
    let db = Database::open_in_memory().unwrap();
    seed(&db, "t1");
    let mut machine = TaskStateMachine::new();
    let log = EventLog::new(&db);
    log.append("t1", "task.created", &serde_json::json!({}), "ts0")
        .unwrap();

    advance(&db, &mut machine, "t1", TaskStatus::Queued, "ts1");
    advance(&db, &mut machine, "t1", TaskStatus::Preparing, "ts2");
    advance(&db, &mut machine, "t1", TaskStatus::Running, "ts3");

    let events = log.replay_task("t1", 0).unwrap();
    let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(
        kinds,
        vec![
            "task.created",
            "status.changed",
            "status.changed",
            "status.changed"
        ]
    );
    let seqs: Vec<i64> = events.iter().map(|e| e.sequence).collect();
    assert_eq!(seqs, vec![1, 2, 3, 4]);
    // Statuses in event payloads follow the lifecycle.
    assert_eq!(events[1].payload["to"], "queued");
    assert_eq!(events[3].payload["to"], "running");

    // Checkpoint replay: strictly after sequence 2.
    let tail = log.replay_task("t1", 2).unwrap();
    assert_eq!(tail.len(), 2);
    assert_eq!(tail[0].sequence, 3);
}

#[test]
fn crash_reconciliation_marks_running_tasks_interrupted() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("core.sqlite3");

    // --- Session 1: task advances to running, then the process "crashes". ---
    {
        let db = Database::open(&db_path).unwrap();
        seed(&db, "t1");
        let mut machine = TaskStateMachine::new();
        advance(&db, &mut machine, "t1", TaskStatus::Queued, "ts1");
        advance(&db, &mut machine, "t1", TaskStatus::Preparing, "ts2");
        advance(&db, &mut machine, "t1", TaskStatus::Running, "ts3");
        // Scheduler held a writer lock at crash time.
        let mut sched = Scheduler::new(Limits::default());
        sched
            .mark_running("t1", "p1", Some("/repo/atlas"), WorkspaceMode::HostWorktree)
            .unwrap();
        assert_eq!(sched.writer_lock_holder("/repo/atlas"), Some("t1"));
        // (crash: db + scheduler dropped WITHOUT cleanup)
    }

    // --- Session 2: restart reconciles; nothing auto-resumes. ---
    let db = Database::open(&db_path).unwrap();
    let stale: Vec<String> = {
        let mut stmt = db
            .conn()
            .prepare("SELECT id FROM tasks WHERE status IN ('running','queued','preparing')")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(stale, vec!["t1".to_string()]);

    for task_id in &stale {
        let mut machine = TaskStateMachine::from_status(TaskStatus::Running);
        advance(&db, &mut machine, task_id, TaskStatus::Interrupted, "ts9");
    }

    let status: String = db
        .conn()
        .query_row("SELECT status FROM tasks WHERE id='t1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(status, "interrupted");

    // The event log survived the crash and shows the full history including
    // the reconciliation event (durable append-only log).
    let log = EventLog::new(&db);
    let events = log.replay_task("t1", 0).unwrap();
    assert_eq!(events.len(), 4);
    assert_eq!(events[3].payload["to"], "interrupted");

    // Fresh scheduler starts EMPTY: the old lock is gone, a new task can be
    // admitted on the same workspace, and the interrupted task is terminal —
    // its machine refuses any "resume".
    let sched = Scheduler::reconciliation_baseline();
    assert_eq!(sched.writer_lock_holder("/repo/atlas"), None);
    assert_eq!(
        sched.admit("t2", "p1", Some("/repo/atlas"), WorkspaceMode::HostWorktree),
        Admission::Admitted
    );
    let mut dead = TaskStateMachine::from_status(TaskStatus::Interrupted);
    assert!(dead.is_terminal());
    assert!(dead.transition(TaskStatus::Running).is_err());
    assert!(dead.transition(TaskStatus::Queued).is_err());
}

#[test]
fn writer_lock_serializes_two_writable_tasks_across_modules() {
    let db = Database::open_in_memory().unwrap();
    seed(&db, "t1");
    db.conn()
        .execute(
            "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at)
             VALUES ('t2','c1','created','t','t')",
            [],
        )
        .unwrap();

    let mut sched = Scheduler::new(Limits {
        max_global_running: 4,
        max_per_project_running: 4,
    });
    sched
        .mark_running("t1", "p1", Some("/repo/atlas"), WorkspaceMode::DirectMount)
        .unwrap();
    // Second writer on the SAME writable workspace is queued, never raced.
    assert_eq!(
        sched.admit("t2", "p1", Some("/repo/atlas"), WorkspaceMode::DirectMount),
        Admission::QueuedWriterLock
    );
    // Independent writer on a separate worktree proceeds (specs/02 §4).
    assert_eq!(
        sched.admit(
            "t3",
            "p1",
            Some("/repo/atlas-wt"),
            WorkspaceMode::HostWorktree
        ),
        Admission::Admitted
    );

    // t1 finishes (rejected by the user, say): lock frees, t2 admitted.
    let mut m1 = TaskStateMachine::from_status(TaskStatus::Running);
    advance(&db, &mut m1, "t1", TaskStatus::Verifying, "ts1");
    advance(&db, &mut m1, "t1", TaskStatus::AwaitingReview, "ts2");
    advance(&db, &mut m1, "t1", TaskStatus::Rejected, "ts3");
    sched.mark_finished("t1");
    assert_eq!(
        sched.admit("t2", "p1", Some("/repo/atlas"), WorkspaceMode::DirectMount),
        Admission::Admitted
    );
}
