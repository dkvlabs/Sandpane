//! End-to-end service tests over a REAL Unix socket with NDJSON framing.
//!
//! These exercise the same code path a client uses: connect, write a frame,
//! read the correlated response. SBX scenarios use an explicitly-labeled
//! stand-in executable (NOT the real Docker SBX CLI, which is absent on this
//! host — see docs/compatibility.md); they prove OUR exec/parse/re-query
//! paths, not real SBX behavior.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;

use rusqlite::params;
use sandpane_core::sbx::SbxLocator;
use sandpane_core::{Database, EventLog};
use sandpane_protocol::Method;
use sandpane_service::{serve_connection, ServerInner};

struct TestServer {
    client: UnixStream,
    reader: BufReader<UnixStream>,
    inner: Arc<ServerInner>,
    _dir: tempfile::TempDir,
    _handle: std::thread::JoinHandle<()>,
}

fn start_server(locator: SbxLocator) -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.sqlite3");
    start_server_at(locator, dir, db_path)
}

/// Bind the socket inside `dir` and open (migrating + RESTART-RECONCILING)
/// the database at `db_path` — ServerInner::new runs production reconciliation
/// on every open, which is exactly what the restart test exercises.
fn start_server_at(
    locator: SbxLocator,
    dir: tempfile::TempDir,
    db_path: std::path::PathBuf,
) -> TestServer {
    let socket_path = dir.path().join("test.sock");
    let db = Database::open(&db_path).unwrap();
    let inner = ServerInner::new(db, locator);
    let listener = UnixListener::bind(&socket_path).unwrap();
    let serve_inner = Arc::clone(&inner);
    let handle = std::thread::spawn(move || {
        for stream in listener.incoming() {
            let inner = Arc::clone(&serve_inner);
            std::thread::spawn(move || serve_connection(inner, stream.unwrap()));
        }
    });
    let client = UnixStream::connect(&socket_path).unwrap();
    let reader_stream = client.try_clone().unwrap();
    TestServer {
        client,
        reader: BufReader::new(reader_stream),
        inner,
        _dir: dir,
        _handle: handle,
    }
}

impl TestServer {
    fn rpc(&mut self, id: &str, method: &str, params: serde_json::Value) -> serde_json::Value {
        let frame = serde_json::json!({"v": 1, "id": id, "method": method, "params": params});
        writeln!(self.client, "{}", frame).unwrap();
        let mut line = String::new();
        self.reader.read_line(&mut line).unwrap();
        let resp: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(resp["id"], id, "response must correlate request id");
        assert_eq!(resp["v"], 1);
        resp
    }

    fn ok(&mut self, id: &str, method: &str, params: serde_json::Value) -> serde_json::Value {
        let resp = self.rpc(id, method, params);
        assert!(resp.get("ok").is_some(), "expected ok-frame: {resp}");
        resp["ok"].clone()
    }

    fn err(&mut self, id: &str, method: &str, params: serde_json::Value) -> serde_json::Value {
        let resp = self.rpc(id, method, params);
        assert!(resp.get("err").is_some(), "expected err-frame: {resp}");
        resp["err"].clone()
    }
}

fn no_sbx() -> SbxLocator {
    SbxLocator::with_search(None, vec![])
}

/// Stand-in executable that mimics the ILLUSTRATIVE fixture shapes. Clearly a
/// test double: it is a shell script in a temp dir, never presented as sbx.
fn fake_sbx_dir(list_json: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let script = format!(
        "#!/bin/sh\ncase \"$1 $2\" in\n\"sandbox list\") cat <<'FIXTURE'\n{list_json}\nFIXTURE\n;;\n\"sandbox create\") exit 0 ;;\n\"sandbox inspect\") cat <<'FIXTURE'\n{list_json}\nFIXTURE\n;;\n*) echo 'unsupported' >&2; exit 64 ;;\nesac\n"
    );
    let path = dir.path().join("sbx");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    dir
}

#[test]
fn probe_reports_protocol_and_honest_capabilities() {
    let mut s = start_server(no_sbx());
    let caps = s.ok("p1", "system.probe", serde_json::json!({}));
    assert_eq!(caps["protocolVersion"], 1);
    assert!(!caps["instanceId"].as_str().unwrap().is_empty());
    assert_eq!(caps["sbx"]["installed"], false);
    // P0 gate not passed → nothing advertised as verified.
    assert_eq!(caps["agents"][0]["id"], "codex");
    assert_eq!(caps["agents"][0]["verified"], false);
    assert_eq!(caps["agents"][0]["supportsResume"], false);
}

#[test]
fn full_task_lifecycle_over_socket() {
    let mut s = start_server(no_sbx());
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": []}),
    );
    let project_id = project["id"].as_str().unwrap().to_string();

    let list = s.ok("2", "project.list", serde_json::json!({}));
    assert_eq!(list.as_array().unwrap().len(), 1);

    let conv = s.ok(
        "3",
        "conversation.create",
        serde_json::json!({"projectId": project_id, "agentId": "codex", "title": "Authentication flow"}),
    );
    let conv_id = conv["id"].as_str().unwrap().to_string();

    // Hostile content is inert data end to end.
    let task = s.ok(
        "4",
        "conversation.send",
        serde_json::json!({"conversationId": conv_id, "content": "fix auth; rm -rf / $(whoami) `id`"}),
    );
    assert_eq!(task["status"], "queued");
    let task_id = task["id"].as_str().unwrap().to_string();

    // Durable event replay from the beginning.
    let events = s.ok(
        "5",
        "task.subscribe",
        serde_json::json!({"taskId": task_id, "afterSequence": 0}),
    );
    let arr = events.as_array().unwrap();
    let kinds: Vec<&str> = arr.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        vec![
            "task.created",
            "message.user",
            "status.changed",
            "adapter.unavailable"
        ]
    );
    // Content survived as data, unescaped and unexecuted.
    let user_msg = &arr[1]["payload"];
    assert_eq!(user_msg["text"], "fix auth; rm -rf / $(whoami) `id`");
    // The honest scaffold event names the unverified adapter gate.
    assert_eq!(arr[3]["payload"]["code"], "PROVIDER_AUTH_REQUIRED");
    let sequences: Vec<i64> = arr
        .iter()
        .map(|e| e["sequence"].as_i64().unwrap())
        .collect();
    assert_eq!(sequences, vec![1, 2, 3, 4]);

    // Idempotent reconnect: after the last sequence there is nothing new.
    let tail = s.ok(
        "6",
        "task.subscribe",
        serde_json::json!({"taskId": task_id, "afterSequence": 4}),
    );
    assert_eq!(tail.as_array().unwrap().len(), 0);

    // Project-wide subscription also finds the task events.
    let project_events = s.ok(
        "7",
        "task.subscribe",
        serde_json::json!({"projectId": project_id, "afterSequence": 0}),
    );
    assert_eq!(project_events.as_array().unwrap().len(), 4);

    // Cancel: queued -> cancelled, event appended.
    let cancel = s.ok("8", "task.cancel", serde_json::json!({"taskId": task_id}));
    assert_eq!(cancel["requested"], true);
    let after = s.ok(
        "9",
        "task.subscribe",
        serde_json::json!({"taskId": task_id, "afterSequence": 4}),
    );
    let arr = after.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["kind"], "status.changed");
    assert_eq!(arr[0]["payload"]["to"], "cancelled");

    // Terminal state: second cancel is a structured CONFLICT, not a panic.
    let err = s.err("10", "task.cancel", serde_json::json!({"taskId": task_id}));
    assert_eq!(err["code"], "CONFLICT");
}

#[test]
fn protocol_violations_are_structured() {
    let mut s = start_server(no_sbx());
    // Unknown method (no free-form execution surface exists).
    let err = s.err("a", "shell.exec", serde_json::json!({"cmd": "ls"}));
    assert_eq!(err["code"], "VALIDATION_FAILED");
    // Wrong protocol version.
    let frame = r#"{"v":99,"id":"b","method":"system.probe","params":{}}"#;
    writeln!(s.client, "{frame}").unwrap();
    let mut line = String::new();
    s.reader.read_line(&mut line).unwrap();
    let resp: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(resp["id"], "b");
    assert!(resp["err"]["message"]
        .as_str()
        .unwrap()
        .contains("protocol version mismatch"));
    // Unknown conversation → NOT_FOUND.
    let err = s.err(
        "c",
        "conversation.send",
        serde_json::json!({"conversationId": "nope", "content": "hi"}),
    );
    assert_eq!(err["code"], "NOT_FOUND");
    // Invalid params shape → VALIDATION_FAILED.
    let err = s.err(
        "d",
        "conversation.send",
        serde_json::json!({"wrong": "shape"}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    // Connection still healthy after all violations.
    let caps = s.ok("e", "system.probe", serde_json::json!({}));
    assert_eq!(caps["protocolVersion"], 1);
}

#[test]
fn sandbox_name_injection_never_reaches_exec() {
    let fake = fake_sbx_dir(r#"{"sandboxes":[]}"#);
    let locator = SbxLocator::with_search(None, vec![fake.path().to_path_buf()]);
    let mut s = start_server(locator);
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": []}),
    );
    let project_id = project["id"].as_str().unwrap();
    for evil in [
        "a;touch /tmp/sandpane-pwned",
        "$(whoami)",
        "a|b",
        "--privileged",
        "a b",
    ] {
        let err = s.err(
            "2",
            "sandbox.create",
            serde_json::json!({
                "name": evil,
                "projectId": project_id,
                "workspaceMode": "mountless"
            }),
        );
        assert_eq!(err["code"], "VALIDATION_FAILED", "name {evil:?}");
    }
    assert!(!Path::new("/tmp/sandpane-pwned").exists());
}

#[test]
fn sandbox_list_and_create_with_stand_in_executable() {
    let list_json = r#"{"sandboxes":[{"name":"atlas-auth","state":"running"},{"name":"nova-search","state":"stopped"}]}"#;
    let fake = fake_sbx_dir(list_json);
    let locator = SbxLocator::with_search(None, vec![fake.path().to_path_buf()]);
    let mut s = start_server(locator);

    let list = s.ok("1", "sandbox.list", serde_json::json!({}));
    let arr = list.as_array().unwrap();
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["name"], "atlas-auth");
    assert_eq!(arr[0]["probedState"], "running");

    // A writable workspace mode requires a REGISTERED repository path
    // (mount containment, review 0004 Critical #2).
    let repo_dir = tempfile::tempdir().unwrap();
    let project = s.ok(
        "2",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo_dir.path().display().to_string()]}),
    );
    let created = s.ok(
        "3",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-auth",
            "projectId": project["id"],
            "workspaceMode": "sbx_clone",
            "repoPath": repo_dir.path().display().to_string()
        }),
    );
    // Exit 0 is NOT trusted: state comes from the re-query.
    assert_eq!(created["probedState"], "running");
    assert_eq!(created["boundProjectId"], project["id"]);

    // A binding row exists, with the BARE snake_case mode (no JSON quotes)
    // so live-writable queries by mode work (review 0004 #4).
    let (count, mode): (i64, String) = s
        .inner
        .db
        .lock()
        .unwrap()
        .conn()
        .query_row(
            "SELECT COUNT(*), MAX(workspace_mode) FROM sandbox_bindings",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(mode, "sbx_clone");
}

#[test]
fn sandbox_create_enforces_mount_containment() {
    let list_json = r#"{"sandboxes":[]}"#;
    let fake = fake_sbx_dir(list_json);
    let locator = SbxLocator::with_search(None, vec![fake.path().to_path_buf()]);
    let mut s = start_server(locator);

    let registered = tempfile::tempdir().unwrap();
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [registered.path().display().to_string()]}),
    );
    let pid = project["id"].as_str().unwrap();

    // Arbitrary host path (exists, but is NOT registered) → PERMISSION_DENIED,
    // never reaches the CLI.
    let err = s.err(
        "2",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-evil", "projectId": pid,
            "workspaceMode": "direct_mount", "repoPath": "/tmp"
        }),
    );
    assert_eq!(err["code"], "PERMISSION_DENIED");

    // Symlink INSIDE the registered repo pointing at /etc: canonicalization
    // resolves it before the containment compare, so the escape is refused
    // (specs/06 §4 "account for symlinks").
    std::os::unix::fs::symlink("/etc", registered.path().join("escape-link")).unwrap();
    let err = s.err(
        "3",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-evil2", "projectId": pid,
            "workspaceMode": "direct_mount",
            "repoPath": registered.path().join("escape-link").display().to_string()
        }),
    );
    assert_eq!(err["code"], "PERMISSION_DENIED");

    // Writable mode with NO repoPath → structured refusal.
    let err = s.err(
        "4",
        "sandbox.create",
        serde_json::json!({"name": "atlas-x", "projectId": pid, "workspaceMode": "host_worktree"}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");

    // A SUBPATH of the registered repository is contained → accepted.
    let sub = registered.path().join("src");
    std::fs::create_dir_all(&sub).unwrap();
    let ok = s.ok(
        "5",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-ok", "projectId": pid,
            "workspaceMode": "sbx_clone", "repoPath": sub.display().to_string()
        }),
    );
    assert_eq!(ok["name"], "atlas-ok");

    // Mountless + repoPath → refused (no path by definition).
    let err = s.err(
        "6",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-m", "projectId": pid,
            "workspaceMode": "mountless", "repoPath": sub.display().to_string()
        }),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
}

#[test]
fn restart_reconciliation_interrupts_stale_tasks_in_production_path() {
    // Review 0004 Critical #1: reconciliation must live in SERVER CODE, not
    // only in test helpers. Seed a DB file with in-flight tasks the way a
    // crashed daemon left them, then construct a NEW ServerInner (the same
    // code path main.rs runs) over the same file.
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("core.sqlite3");
    {
        let db = Database::open(&db_path).unwrap();
        db.conn()
            .execute(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t')",
                [],
            )
            .unwrap();
        db.conn()
            .execute("INSERT INTO conversations (id,project_id,agent_id,created_at) VALUES ('c1','p1','codex','t')", [])
            .unwrap();
        for (id, status) in [
            ("t-run", "running"),
            ("t-queued", "queued"),
            ("t-done", "completed"),
        ] {
            db.conn()
                .execute(
                    "INSERT INTO tasks (id,conversation_id,status,created_at,updated_at) VALUES (?1,'c1',?2,'t','t')",
                    rusqlite::params![id, status],
                )
                .unwrap();
        }
    }
    // New daemon instance over the same file: ServerInner::new runs the
    // production reconciliation (the exact path main.rs takes).
    let s = start_server_at(no_sbx(), dir, db_path);
    let db = s.inner.lock_db();
    let status: (String, String, String) = db
        .conn()
        .query_row(
            "SELECT (SELECT status FROM tasks WHERE id='t-run'),
                    (SELECT status FROM tasks WHERE id='t-queued'),
                    (SELECT status FROM tasks WHERE id='t-done')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(status.0, "interrupted", "running task must be reconciled");
    assert_eq!(
        status.1, "interrupted",
        "queued task (orphaned scheduler) must be reconciled"
    );
    assert_eq!(status.2, "completed", "terminal states are never touched");

    // Durable reconciliation events exist for the interrupted tasks.
    let n: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM task_events WHERE task_id='t-run' AND kind='status.changed'
             AND payload LIKE '%interrupted%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn non_utf8_frame_gets_structured_refusal() {
    let s = start_server(no_sbx());
    let mut stream = UnixStream::connect(s._dir.path().join("test.sock")).unwrap();
    stream
        .write_all(b"{\"v\":1,\"id\":\"\xff\xfe\",\"method\":}\n")
        .unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let got = reader.read_line(&mut line).unwrap();
    assert!(got > 0, "connection closed with no response frame");
    let resp: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(resp["err"]["code"], "VALIDATION_FAILED");
    assert!(line.contains("UTF-8"), "got: {line}");
}

#[test]
fn sandbox_list_without_sbx_is_not_installed() {
    let mut s = start_server(no_sbx());
    let err = s.err("1", "sandbox.list", serde_json::json!({}));
    assert_eq!(err["code"], "NOT_INSTALLED");
}

#[test]
fn git_review_and_apply_gates_on_real_repo() {
    let mut s = start_server(no_sbx());
    // Real disposable git repo.
    let repo_dir = tempfile::tempdir().unwrap();
    let repo = repo_dir.path();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "sandpane@test.invalid"]);
    git(&["config", "user.name", "Sandpane Test"]);
    std::fs::write(repo.join("app.txt"), "base\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "base"]);
    let base = git(&["rev-parse", "HEAD"]);

    // Wire a task WITH Git context directly through the service DB (clients
    // cannot fabricate this; the scaffold has no workspace-provisioning RPC yet).
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo.display().to_string()]}),
    );
    let project_id = project["id"].as_str().unwrap().to_string();
    let repo_id: String = {
        let db = s.inner.db.lock().unwrap();
        db.conn()
            .query_row(
                "SELECT id FROM repositories WHERE project_id = ?1",
                rusqlite::params![project_id],
                |r| r.get(0),
            )
            .unwrap()
    };
    let conv = s.ok(
        "2",
        "conversation.create",
        serde_json::json!({"projectId": project_id, "agentId": "codex"}),
    );
    let task_id: String = {
        let db = s.inner.db.lock().unwrap();
        let id = "task-git-1".to_string();
        db.conn()
            .execute(
                "INSERT INTO tasks (id, conversation_id, repo_id, base_commit, status, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,'queued','t','t')",
                rusqlite::params![id, conv["id"].as_str().unwrap(), repo_id, base],
            )
            .unwrap();
        id
    };

    // Simulate an agent change set WITHOUT committing: one working-tree
    // modification + one untracked file (the real agent-workflow shape).
    std::fs::write(repo.join("app.txt"), "feature\n").unwrap();
    std::fs::write(repo.join("notes.txt"), "untracked work\n").unwrap();

    let review = s.ok("3", "git.review", serde_json::json!({"taskId": task_id}));
    assert_eq!(review["baseCommit"], base);
    assert_eq!(review["hostDirty"], true); // uncommitted + untracked present
    let changes = review["changes"].as_array().unwrap();
    assert!(changes
        .iter()
        .any(|c| c["path"] == "app.txt" && c["status"] == "modified"));
    assert!(changes
        .iter()
        .any(|c| c["path"] == "notes.txt" && c["status"] == "untracked"));

    // Apply with a DIVERGED expected base aborts structurally.
    let wrong_base = "1".repeat(40);
    let apply = s.ok(
        "4",
        "git.apply",
        serde_json::json!({"taskId": task_id, "expectedBase": wrong_base}),
    );
    assert_eq!(apply["applied"], false);
    assert!(apply["abortReason"]
        .as_str()
        .unwrap()
        .contains("base diverged"));

    // Apply with the correct base hits the dirty-host gate — user work untouched.
    let apply = s.ok(
        "5",
        "git.apply",
        serde_json::json!({"taskId": task_id, "expectedBase": base}),
    );
    assert_eq!(apply["applied"], false);
    assert!(apply["abortReason"]
        .as_str()
        .unwrap()
        .contains("precondition failed"));
    assert!(repo.join("notes.txt").exists(), "host work must survive");

    // Clean host at the recorded base → honest P4 scaffold abort (never a fake apply).
    let git_restore = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(out.status.success());
    };
    git_restore(&["checkout", "-q", "--", "app.txt"]);
    std::fs::remove_file(repo.join("notes.txt")).unwrap();
    let apply = s.ok(
        "6",
        "git.apply",
        serde_json::json!({"taskId": task_id, "expectedBase": base}),
    );
    assert_eq!(apply["applied"], false);
    assert!(apply["abortReason"]
        .as_str()
        .unwrap()
        .contains("P4 deliverable"));

    // Task without Git context → structured VALIDATION_FAILED, not a panic.
    let task2 = s.ok(
        "7",
        "conversation.send",
        serde_json::json!({"conversationId": conv["id"], "content": "hello"}),
    );
    let err = s.err(
        "8",
        "git.review",
        serde_json::json!({"taskId": task2["id"]}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");

    // FAIL-CLOSED (review 0004 #9): apply on a task without Git context is
    // refused with an explicit reason — never a silent fall-through.
    let apply = s.ok(
        "9",
        "git.apply",
        serde_json::json!({"taskId": task2["id"], "expectedBase": base}),
    );
    assert_eq!(apply["applied"], false);
    assert!(
        apply["abortReason"]
            .as_str()
            .unwrap()
            .contains("no Git context"),
        "got: {apply}"
    );
}

#[test]
fn oversized_frame_is_refused_without_hanging() {
    let s = start_server(no_sbx());
    // One-shot connection: send a frame larger than the cap, expect refusal.
    let mut stream = UnixStream::connect(s._dir.path().join("test.sock")).unwrap();
    stream
        .write_all(&vec![b'x'; sandpane_service::MAX_FRAME_BYTES + 10])
        .unwrap();
    stream.write_all(b"\n").unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.contains("frame too large"), "got: {line}");
}

// ---------------------------------------------------------------------------
// Discovery revision: task.list / conversation.list / conversation.history,
// per-task replay cursors, project repositories, sandbox workspaceMode,
// feature discovery (docs/compatibility.md "Protocol v1 gaps").
// ---------------------------------------------------------------------------

/// Seed stored chat rows directly through the real `messages` table. This is
/// test-only data setup (the read path under test is `conversation.history`);
/// the row shape matches what `conversation.send` writes.
fn seed_messages(server: &TestServer, conversation_id: &str, contents: &[&str]) {
    let db = server.inner.lock_db();
    for (i, content) in contents.iter().enumerate() {
        db.conn()
            .execute(
                "INSERT INTO messages (id, conversation_id, role, content, sequence)
                 VALUES (?1,?2,'user',?3,?4)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    conversation_id,
                    content,
                    (i + 1) as i64
                ],
            )
            .unwrap();
    }
}

/// Create a project + conversation and return their ids.
fn make_project_and_conversation(
    server: &mut TestServer,
    name: &str,
    repos: Vec<String>,
) -> (String, String) {
    let project = server.ok(
        "p",
        "project.create",
        serde_json::json!({"name": name, "repositories": repos}),
    );
    let project_id = project["id"].as_str().unwrap().to_string();
    let conv = server.ok(
        "c",
        "conversation.create",
        serde_json::json!({"projectId": project_id, "agentId": "codex", "title": "chat"}),
    );
    (project_id, conv["id"].as_str().unwrap().to_string())
}

/// Append `n` durable events to a task through the PRODUCTION append path.
fn append_events(server: &TestServer, task_id: &str, n: usize) {
    append_events_with(server, task_id, n, "message.delta", &serde_json::json!({}))
}

/// Same, with a caller-chosen kind/payload — used to build a replay whose frame
/// really does exceed the transport cap.
fn append_events_with(
    server: &TestServer,
    task_id: &str,
    n: usize,
    kind: &str,
    payload: &serde_json::Value,
) {
    let db = server.inner.lock_db();
    let log = EventLog::new(&db);
    for i in 0..n {
        let mut payload = payload.clone();
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("i".to_string(), serde_json::json!(i));
        }
        log.append(task_id, kind, &payload, "2026-10-09T00:00:00Z")
            .unwrap();
    }
}

fn insert_task(server: &TestServer, conversation_id: &str, task_id: &str, created_at: &str) {
    let db = server.inner.lock_db();
    db.conn()
        .execute(
            "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at)
             VALUES (?1,?2,'queued',?3,?3)",
            params![task_id, conversation_id, created_at],
        )
        .unwrap();
}

#[test]
fn task_list_scopes_by_project_filters_by_status_and_clamps_limit() {
    let mut s = start_server(no_sbx());
    let (p1, c1) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    let (_p2, c2) = make_project_and_conversation(&mut s, "Nova Demo", vec![]);
    let t1 = s.ok(
        "s1",
        "conversation.send",
        serde_json::json!({"conversationId": c1, "content": "one"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    let t2 = s.ok(
        "s2",
        "conversation.send",
        serde_json::json!({"conversationId": c2, "content": "two"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    // Make the two projects hold different Core statuses.
    s.ok("x", "task.cancel", serde_json::json!({"taskId": &t1}));

    // Project scoping: only this project's task, with Core's stored status and
    // its real conversation id.
    let scoped = s.ok("l1", "task.list", serde_json::json!({"projectId": &p1}));
    let arr = scoped.as_array().unwrap();
    assert_eq!(arr.len(), 1, "got: {scoped}");
    assert_eq!(arr[0]["id"], t1);
    assert_eq!(arr[0]["conversationId"], c1);
    assert_eq!(arr[0]["status"], "cancelled", "status is Core state");

    // Unscoped = every task Core knows about.
    let all = s.ok("l2", "task.list", serde_json::json!({}));
    let ids: Vec<&str> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&t1.as_str()) && ids.contains(&t2.as_str()));

    // Status filter, single and multi-valued.
    let queued = s.ok(
        "l3",
        "task.list",
        serde_json::json!({"statuses": ["queued"]}),
    );
    let arr = queued.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["id"], t2);
    assert_eq!(arr[0]["status"], "queued");
    let either = s.ok(
        "l4",
        "task.list",
        serde_json::json!({"statuses": ["queued", "cancelled"]}),
    );
    assert_eq!(either.as_array().unwrap().len(), 2);
    // A status Core does not store is rejected — never normalized into one
    // that is (specs/02 §4).
    let err = s.err(
        "l5",
        "task.list",
        serde_json::json!({"statuses": ["half_finished"]}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    // A filter that repeats one status thousands of times is still a bounded
    // query: duplicates carry no meaning in an IN-list, so they collapse and the
    // answer is unchanged (no SQLite variable-limit blow-up).
    let spam: Vec<String> = (0..2_000).map(|_| "queued".to_string()).collect();
    let deduped = s.ok("l5b", "task.list", serde_json::json!({"statuses": spam}));
    let arr = deduped.as_array().unwrap();
    assert_eq!(arr.len(), 1, "got: {deduped}");
    assert_eq!(arr[0]["id"], t2);

    // Limit clamping: 0 is normalised up to a usable bound, an absurd limit is
    // clamped to MAX_LIST_LIMIT — the response is never an unbounded set.
    let zero = s.ok("l6", "task.list", serde_json::json!({"limit": 0}));
    assert_eq!(zero.as_array().unwrap().len(), 1);
    let huge = s.ok(
        "l7",
        "task.list",
        serde_json::json!({"limit": sandpane_service::MAX_LIST_LIMIT * 10}),
    );
    assert!(huge.as_array().unwrap().len() <= sandpane_service::MAX_LIST_LIMIT as usize);
    let mid = s.ok("l8", "task.list", serde_json::json!({"limit": 1}));
    assert_eq!(mid.as_array().unwrap().len(), 1);

    // Every caller value is BOUND (project id, status names, limit) — never
    // interpolated into the statement text. Also: an empty `projectId` is a
    // refusal, not a silent `[]` that looks like an empty project.
    let err = s.err("l10", "task.list", serde_json::json!({"projectId": ""}));
    assert_eq!(err["code"], "VALIDATION_FAILED");
    // …while an UNKNOWN project legitimately has no tasks.
    let none = s.ok(
        "l11",
        "task.list",
        serde_json::json!({"projectId": "no-such-project"}),
    );
    assert!(none.as_array().unwrap().is_empty());
}

#[test]
fn task_list_orders_by_created_at_then_id_deterministically() {
    // Deterministic seeding: `created_at` has SECOND resolution in Core, so
    // wall-clock tasks can straddle a boundary. Explicit distinct stamps plus
    // ids whose lexicographic order DISAGREES with the time order prove the
    // ORDER BY, and two tasks sharing a stamp prove the id tie-break.
    let mut s = start_server(no_sbx());
    let (pid, cid) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    let second = s.ok(
        "c",
        "conversation.create",
        serde_json::json!({"projectId": pid, "agentId": "codex", "title": "two"}),
    );
    let cid2 = second["id"].as_str().unwrap().to_string();
    // Newest-looking ids first in time order: zebra(01), apple(02), then the
    // tie pair (mango/xray) sharing 03.
    insert_task(&s, &cid, "zzz-earliest", "2026-10-09T00:00:01Z");
    insert_task(&s, &cid, "aaa-middle", "2026-10-09T00:00:02Z");
    insert_task(&s, &cid2, "tie-zulu", "2026-10-09T00:00:03Z");
    insert_task(&s, &cid2, "tie-alpha", "2026-10-09T00:00:03Z");

    let all = s.ok("l1", "task.list", serde_json::json!({"projectId": &pid}));
    let ids: Vec<&str> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![
            "zzz-earliest",
            "aaa-middle",
            // same created_at → id ASC decides
            "tie-alpha",
            "tie-zulu",
        ],
        "task.list must be ordered by (created_at, id)"
    );
    // Stable across calls (a set that reordered would make client paging lossy).
    let again = s.ok("l2", "task.list", serde_json::json!({"projectId": &pid}));
    assert_eq!(again, all);
    // Conversation scoping is real: the tie pair lives in the second
    // conversation but the same project, so a project query sees all four.
    assert_eq!(all.as_array().unwrap().len(), 4);
    let one_conversation: Vec<&serde_json::Value> = all
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["conversationId"] == cid)
        .collect();
    assert_eq!(one_conversation.len(), 2);
}

#[test]
fn conversation_list_scopes_by_project_and_clamps_limit() {
    let mut s = start_server(no_sbx());
    let (p1, _c1) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    let second = s.ok(
        "c2",
        "conversation.create",
        serde_json::json!({"projectId": p1, "agentId": "codex", "title": "second"}),
    );
    let (p2, _c2) = make_project_and_conversation(&mut s, "Nova Demo", vec![]);

    let scoped = s.ok(
        "l1",
        "conversation.list",
        serde_json::json!({"projectId": &p1}),
    );
    let arr = scoped.as_array().unwrap();
    assert_eq!(arr.len(), 2, "got: {scoped}");
    for c in arr {
        assert_eq!(c["projectId"], p1);
        assert!(!c["id"].as_str().unwrap().is_empty());
        assert_eq!(c["agentId"], "codex");
    }
    assert!(arr
        .iter()
        .any(|c| c["id"] == second["id"] && c["title"] == "second"));

    let all = s.ok("l2", "conversation.list", serde_json::json!({}));
    assert_eq!(all.as_array().unwrap().len(), 3);
    for c in all.as_array().unwrap() {
        assert!(c["projectId"] == p1 || c["projectId"] == p2);
    }

    let clamped = s.ok(
        "l3",
        "conversation.list",
        serde_json::json!({"limit": 999_999}),
    );
    assert!(clamped.as_array().unwrap().len() <= sandpane_service::MAX_LIST_LIMIT as usize);
    let one = s.ok("l4", "conversation.list", serde_json::json!({"limit": 1}));
    assert_eq!(one.as_array().unwrap().len(), 1);
}

#[test]
fn conversation_history_orders_pages_and_discloses_row_truncation() {
    let mut s = start_server(no_sbx());
    let (_p, cid) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    for content in ["m1", "m2", "m3", "m4"] {
        s.ok(
            "send",
            "conversation.send",
            serde_json::json!({"conversationId": &cid, "content": content}),
        );
    }

    // Full read: ascending sequence, no truncation, cursor = last row.
    let all = s.ok(
        "h1",
        "conversation.history",
        serde_json::json!({"conversationId": &cid}),
    );
    let msgs = all["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 4);
    assert_eq!(
        msgs.iter()
            .map(|m| m["sequence"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );
    assert_eq!(
        msgs.iter()
            .map(|m| m["content"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["m1", "m2", "m3", "m4"],
        "stored content comes back verbatim, in order"
    );
    assert_eq!(all["truncated"], false);
    assert_eq!(all["nextSequence"], 4);
    assert_eq!(msgs[0]["conversationId"], cid);
    assert_eq!(msgs[0]["role"], "user");
    assert!(!msgs[0]["id"].as_str().unwrap().is_empty());

    // Row-bounded page + forward paging from the disclosed cursor.
    let page1 = s.ok(
        "h2",
        "conversation.history",
        serde_json::json!({"conversationId": &cid, "limit": 2}),
    );
    assert_eq!(page1["messages"].as_array().unwrap().len(), 2);
    assert_eq!(page1["truncated"], true, "row limit stopped the scan");
    assert_eq!(page1["nextSequence"], 2);
    let page2 = s.ok(
        "h3",
        "conversation.history",
        serde_json::json!({
            "conversationId": &cid,
            "afterSequence": page1["nextSequence"],
            "limit": 2
        }),
    );
    let msgs = page2["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0]["content"], "m3");
    assert_eq!(page2["truncated"], false);
    assert_eq!(page2["nextSequence"], 4);

    // Past the end: nothing returned, cursor echoed back unchanged.
    let empty = s.ok(
        "h4",
        "conversation.history",
        serde_json::json!({"conversationId": &cid, "afterSequence": 4}),
    );
    assert!(empty["messages"].as_array().unwrap().is_empty());
    assert_eq!(empty["truncated"], false);
    assert_eq!(empty["nextSequence"], 4);

    // A negative cursor is normalised, not rejected into nonsense.
    let neg = s.ok(
        "h5",
        "conversation.history",
        serde_json::json!({"conversationId": &cid, "afterSequence": -7}),
    );
    assert_eq!(neg["messages"].as_array().unwrap().len(), 4);
}

#[test]
fn conversation_history_byte_ceiling_truncates_without_losing_rows() {
    let mut s = start_server(no_sbx());
    let (_p, cid) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    // 40 rows × 60 000 chars ≈ 2.4 MB of stored content — above the response
    // ceiling, and far below the row count that would be needed otherwise.
    let big = "x".repeat(60 * 1000);
    let contents: Vec<&str> = (0..40).map(|_| big.as_str()).collect();
    seed_messages(&s, &cid, &contents);

    let first = s.ok(
        "h1",
        "conversation.history",
        serde_json::json!({"conversationId": &cid, "limit": sandpane_service::MAX_LIST_LIMIT}),
    );
    let msgs = first["messages"].as_array().unwrap();
    assert!(
        msgs.len() < 40,
        "the byte ceiling must stop the scan, not the row limit ({} rows)",
        msgs.len()
    );
    assert_eq!(first["truncated"], true);
    let bytes: usize = msgs
        .iter()
        .map(|m| m["content"].as_str().unwrap().len())
        .sum();
    assert!(
        bytes <= sandpane_service::MAX_HISTORY_BYTES + big.len(),
        "response content {bytes} bytes exceeds the ceiling beyond one \
         progress-guarantee row"
    );

    // Disclosure is actionable: paging from nextSequence returns the rest with
    // nothing lost and nothing duplicated.
    let next = s.ok(
        "h2",
        "conversation.history",
        serde_json::json!({
            "conversationId": &cid,
            "afterSequence": first["nextSequence"],
            "limit": sandpane_service::MAX_LIST_LIMIT
        }),
    );
    let rest = next["messages"].as_array().unwrap();
    assert_eq!(
        rest.len(),
        40 - msgs.len(),
        "no row may be lost or repeated"
    );
    assert_eq!(next["truncated"], false);
    assert_eq!(rest[0]["sequence"].as_i64().unwrap(), msgs.len() as i64 + 1);
}

#[test]
fn conversation_history_error_paths_are_structured() {
    let mut s = start_server(no_sbx());
    // Unknown conversation → NOT_FOUND (never a panic, never an empty lie).
    let err = s.err(
        "e1",
        "conversation.history",
        serde_json::json!({"conversationId": "no-such-conversation"}),
    );
    assert_eq!(err["code"], "NOT_FOUND");
    // Missing required id → VALIDATION_FAILED.
    let err = s.err(
        "e2",
        "conversation.history",
        serde_json::json!({"afterSequence": 3}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    // An empty id is a refusal, not a conversation that happens to be empty.
    let err = s.err(
        "e2b",
        "conversation.history",
        serde_json::json!({"conversationId": ""}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    // Hostile id is just an id: bound parameter, unknown → NOT_FOUND.
    let err = s.err(
        "e3",
        "conversation.history",
        serde_json::json!({"conversationId": "x'; DROP TABLE messages; --"}),
    );
    assert_eq!(err["code"], "NOT_FOUND");
    // The connection is still healthy and a real, message-free conversation
    // answers with an empty bounded page (not an error, not a fabricated row).
    let (_p, cid) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    let empty = s.ok(
        "e4",
        "conversation.history",
        serde_json::json!({"conversationId": &cid}),
    );
    assert!(empty["messages"].as_array().unwrap().is_empty());
    assert_eq!(empty["truncated"], false);
    assert_eq!(empty["nextSequence"], 0);
    // And the injected id did not damage the messages table.
    s.ok("e5", "conversation.list", serde_json::json!({}));
}

#[test]
fn task_subscribe_per_task_cursors_repair_the_shared_scalar_skip() {
    let mut s = start_server(no_sbx());
    let (pid, cid) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    // THREE tasks with deliberately UNEVEN event counts: A=5, B=2, C=1.
    insert_task(&s, &cid, "task-a", "2026-10-09T00:00:01Z");
    insert_task(&s, &cid, "task-b", "2026-10-09T00:00:02Z");
    insert_task(&s, &cid, "task-c", "2026-10-09T00:00:03Z");
    append_events(&s, "task-a", 5);
    append_events(&s, "task-b", 2);
    append_events(&s, "task-c", 1);

    let grouped = |v: &serde_json::Value| -> std::collections::BTreeMap<String, Vec<i64>> {
        let mut m: std::collections::BTreeMap<String, Vec<i64>> = Default::default();
        for e in v.as_array().unwrap() {
            m.entry(e["taskId"].as_str().unwrap().to_string())
                .or_default()
                .push(e["sequence"].as_i64().unwrap());
        }
        m
    };

    // (a) THE RECORDED DEFECT: one shared scalar applied to every task means a
    // client that legitimately saw task-a up to 3 loses the unseen events of
    // the low-sequence tasks entirely.
    let legacy = s.ok(
        "c1",
        "task.subscribe",
        serde_json::json!({"projectId": &pid, "afterSequence": 3}),
    );
    let legacy = grouped(&legacy);
    assert_eq!(
        legacy.get("task-a").map(Vec::as_slice),
        Some(&[4i64, 5][..])
    );
    assert_eq!(
        legacy.get("task-b"),
        None,
        "documented v1 gap: the shared scalar skips task-b's unseen event 2"
    );
    assert_eq!(
        legacy.get("task-c"),
        None,
        "documented v1 gap: the shared scalar skips task-c's unseen event 1"
    );

    // (b) THE FIX: per-task cursors return exactly the unseen events of each
    // task; a task absent from the map replays from 0 (its full history).
    let fixed = s.ok(
        "c2",
        "task.subscribe",
        serde_json::json!({
            "projectId": &pid,
            "afterSequences": {"task-a": 3, "task-b": 1}
        }),
    );
    let fixed = grouped(&fixed);
    assert_eq!(fixed.get("task-a").map(Vec::as_slice), Some(&[4i64, 5][..]));
    assert_eq!(fixed.get("task-b").map(Vec::as_slice), Some(&[2i64][..]));
    assert_eq!(
        fixed.get("task-c").map(Vec::as_slice),
        Some(&[1i64][..]),
        "a task missing from the map defaults to cursor 0"
    );

    // (c) Legacy shapes are untouched: no map = shared scalar; explicit 0 =
    // the full replay.
    let full = s.ok(
        "c3",
        "task.subscribe",
        serde_json::json!({"projectId": &pid}),
    );
    assert_eq!(full.as_array().unwrap().len(), 8, "5 + 2 + 1 events");
    let scalar_only = s.ok(
        "c4",
        "task.subscribe",
        serde_json::json!({"projectId": &pid, "afterSequence": 4}),
    );
    assert_eq!(
        scalar_only.as_array().unwrap().len(),
        1,
        "only task-a seq 5"
    );

    // (d) Documented ambiguity: a single `taskId` request keeps scalar
    // semantics and ignores the map.
    let single = s.ok(
        "c5",
        "task.subscribe",
        serde_json::json!({
            "taskId": "task-a",
            "afterSequence": 3,
            "afterSequences": {"task-a": 0}
        }),
    );
    assert_eq!(
        single.as_array().unwrap().len(),
        2,
        "the scalar cursor must win for a single-task request"
    );

    // (e) Negative cursors are normalised to 0 rather than passed through.
    let neg = s.ok(
        "c6",
        "task.subscribe",
        serde_json::json!({"projectId": &pid, "afterSequences": {"task-a": -9}}),
    );
    assert_eq!(neg.as_array().unwrap().len(), 8);

    // (f) Bounded input: an absurd cursor map is refused structurally.
    let mut huge = serde_json::Map::new();
    for i in 0..sandpane_service::MAX_SUBSCRIBE_CURSORS + 1 {
        huge.insert(format!("task-{i}"), serde_json::json!(0));
    }
    let err = s.err(
        "c7",
        "task.subscribe",
        serde_json::json!({"projectId": &pid, "afterSequences": huge}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    // Empty keys are refused too (a zero-length id is not an id).
    let err = s.err(
        "c8",
        "task.subscribe",
        serde_json::json!({"projectId": &pid, "afterSequences": {"": 1}}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
}

#[test]
fn project_list_carries_registered_repository_paths_in_order() {
    let mut s = start_server(no_sbx());
    let repo_a = tempfile::tempdir().unwrap();
    let repo_b = tempfile::tempdir().unwrap();
    let paths = vec![
        repo_a.path().display().to_string(),
        repo_b.path().display().to_string(),
    ];
    let created = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": paths}),
    );
    // The create response already carries them (same field, same values).
    assert_eq!(created["repositories"].as_array().unwrap().len(), 2);
    assert_eq!(created["repositories"][0], paths[0]);

    let list = s.ok("2", "project.list", serde_json::json!({}));
    let arr = list.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(
        arr[0]["repositories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>(),
        paths,
        "registered paths come back in insertion order"
    );
    // Existing fields are untouched (additive revision).
    assert_eq!(arr[0]["name"], "Atlas Demo");
    assert!(!arr[0]["id"].as_str().unwrap().is_empty());
    assert!(!arr[0]["createdAt"].as_str().unwrap().is_empty());

    // A project without repositories reports an EMPTY list, not a missing
    // field and not a guess.
    let _bare = s.ok(
        "3",
        "project.create",
        serde_json::json!({"name": "Orbit Demo", "repositories": []}),
    );
    let list = s.ok("4", "project.list", serde_json::json!({}));
    let bare = list
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "Orbit Demo")
        .unwrap();
    assert_eq!(bare["repositories"].as_array().unwrap().len(), 0);
}

#[test]
fn sandbox_list_joins_workspace_mode_and_omits_it_when_unbound() {
    let list_json = r#"{"sandboxes":[{"name":"atlas-auth","state":"running"},{"name":"nova-search","state":"stopped"}]}"#;
    let fake = fake_sbx_dir(list_json);
    let locator = SbxLocator::with_search(None, vec![fake.path().to_path_buf()]);
    let mut s = start_server(locator);

    let repo = tempfile::tempdir().unwrap();
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo.path().display().to_string()]}),
    );
    let created = s.ok(
        "2",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-auth",
            "projectId": project["id"],
            "workspaceMode": "direct_mount",
            "repoPath": repo.path().display().to_string()
        }),
    );
    // The create response states the mode it just recorded.
    assert_eq!(created["workspaceMode"], "direct_mount");

    // sandbox.list joins it out of sandbox_bindings; an SBX sandbox Core has
    // no binding row for gets NO mode — never a guessed one.
    let list = s.ok("3", "sandbox.list", serde_json::json!({}));
    let arr = list.as_array().unwrap();
    assert_eq!(arr.len(), 2);
    let bound = arr
        .iter()
        .find(|e| e["name"] == "atlas-auth")
        .expect("atlas-auth listed by SBX");
    assert_eq!(
        bound["workspaceMode"], "direct_mount",
        "live-writable mode must be truthfully joined (specs/02 §7)"
    );
    let unbound = arr
        .iter()
        .find(|e| e["name"] == "nova-search")
        .expect("nova-search listed by SBX");
    assert!(
        unbound.get("workspaceMode").is_none(),
        "unbound sandbox must not report a mode: {unbound}"
    );
    assert_eq!(unbound["probedState"], "stopped", "probed state still real");
}

#[test]
fn probe_advertises_every_dispatched_method_and_nothing_else() {
    let mut s = start_server(no_sbx());
    let caps = s.ok("1", "system.probe", serde_json::json!({}));
    let advertised: Vec<&str> = caps["methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.as_str().unwrap())
        .collect();
    // Derived from the same enum dispatch matches exhaustively over.
    let expected: Vec<&str> = Method::ALL.iter().map(|m| m.as_str()).collect();
    assert_eq!(advertised, expected);
    for m in ["task.list", "conversation.list", "conversation.history"] {
        assert!(advertised.contains(&m), "{m} must be discoverable");
    }
    // NO FAKE CAPABILITY: every advertised name really reaches a dispatch
    // branch — an unhandled one would answer "unknown method".
    for m in &advertised {
        let resp = s.rpc("2", m, serde_json::json!({}));
        let msg = resp["err"]["message"].as_str().unwrap_or_default();
        assert!(
            !msg.contains("unknown method"),
            "{m} is advertised but dispatch rejected it: {msg}"
        );
    }
    // Unknown methods stay refused, so the advertised set is the whole surface.
    let err = s.err("3", "task.delete", serde_json::json!({}));
    assert_eq!(err["code"], "VALIDATION_FAILED");
    assert!(err["message"].as_str().unwrap().contains("unknown method"));
}

#[test]
fn oversized_replay_is_refused_structurally_instead_of_wedging_the_client() {
    // `task.subscribe` returns a bare array with NO way to disclose truncation,
    // and both ends of the transport refuse a frame above MAX_FRAME_BYTES. So an
    // over-ceiling replay must be refused with a structured, actionable error
    // rather than built and handed to a client that disconnects over it — a
    // failure whose retry could never converge.
    let mut s = start_server(no_sbx());
    let (pid, cid) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    insert_task(&s, &cid, "big-task", "2026-10-09T00:00:01Z");
    let blob = serde_json::json!({"text": "y".repeat(60 * 1000)});
    let mut events = 0usize;
    loop {
        append_events_with(&s, "big-task", 1, "message.delta", &blob);
        events += 1;
        if events * 60_000 > sandpane_service::MAX_SUBSCRIBE_BYTES {
            break;
        }
    }
    assert!(
        events >= 2,
        "the fixture must span several events to be a replay, not one row: {events}"
    );

    let err = s.err(
        "b1",
        "task.subscribe",
        serde_json::json!({"projectId": &pid, "afterSequence": 0}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    let msg = err["message"].as_str().unwrap();
    assert!(msg.contains("ceiling"), "got: {msg}");
    assert!(
        msg.contains("afterSequence"),
        "the refusal must tell the caller how to narrow the request: {msg}"
    );
    // The method itself still works when the request fits — nothing was lost,
    // and the cursor at the end of the log replays nothing.
    let tail = s.ok(
        "b2",
        "task.subscribe",
        serde_json::json!({"taskId": "big-task", "afterSequence": events}),
    );
    assert!(tail.as_array().unwrap().is_empty());
    // The connection survived the refusal (no disconnect, no wedge).
    let caps = s.ok("b3", "system.probe", serde_json::json!({}));
    assert_eq!(caps["protocolVersion"], 1);
}

#[test]
fn legacy_quoted_workspace_mode_row_is_still_reported_and_junk_stays_absent() {
    // Pre-review-0004 databases stored the JSON-QUOTED mode in
    // `sandbox_bindings.workspace_mode` and nothing migrated them. Those rows
    // still record a live-writable mount, so joining them out is the truthful
    // reading — hiding it would silently drop a live-writable warning
    // (specs/02 §7, specs/04 §3). A row Core genuinely cannot read stays an
    // ABSENCE; the mode is never invented.
    let list_json = r#"{"sandboxes":[{"name":"legacy-mount","state":"running"},{"name":"never-bound","state":"running"}]}"#;
    let fake = fake_sbx_dir(list_json);
    let locator = SbxLocator::with_search(None, vec![fake.path().to_path_buf()]);
    let mut s = start_server(locator);
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": []}),
    );
    let pid = project["id"].as_str().unwrap().to_string();
    {
        let db = s.inner.lock_db();
        db.conn()
            .execute(
                "INSERT INTO sandbox_bindings (id, project_id, sandbox_name, workspace_mode, created_at)
                 VALUES ('bind-legacy',?1,'legacy-mount','\"direct_mount\"','2026-10-09T00:00:00Z')",
                params![pid],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO sandbox_bindings (id, project_id, sandbox_name, workspace_mode, created_at)
                 VALUES ('bind-junk',?1,'never-bound','live_writable','2026-10-09T00:00:01Z')",
                params![pid],
            )
            .unwrap();
    }

    let list = s.ok("2", "sandbox.list", serde_json::json!({}));
    let arr = list.as_array().unwrap();
    let legacy = arr.iter().find(|e| e["name"] == "legacy-mount").unwrap();
    assert_eq!(legacy["workspaceMode"], "direct_mount", "got: {legacy}");
    let junk = arr
        .iter()
        .find(|e| e["name"] == "never-bound")
        .expect("never-bound listed by SBX");
    assert!(
        junk.get("workspaceMode").is_none(),
        "an unreadable mode is absent, never invented: {junk}"
    );
    assert_eq!(junk["probedState"], "running", "probed state stays real");
}

#[test]
fn history_first_row_exception_holds_for_multi_byte_content() {
    // `conversation.send` bounds content by CHARACTERS (65 536), so one row can
    // be ~3× that in UTF-8 bytes. The "first row always passes" paging escape
    // must still stay inside the frame cap and return the content verbatim.
    let mut s = start_server(no_sbx());
    let (_p, cid) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    let multibyte = "日本語".repeat(20_000); // 60 000 chars (under the cap), 180 000 bytes
    assert_eq!(multibyte.chars().count(), 60_000);
    assert_eq!(multibyte.len(), 180_000);
    s.ok(
        "m1",
        "conversation.send",
        serde_json::json!({"conversationId": &cid, "content": &multibyte}),
    );

    let page = s.ok(
        "m2",
        "conversation.history",
        serde_json::json!({"conversationId": &cid, "limit": 1}),
    );
    let msgs = page["messages"].as_array().unwrap();
    assert_eq!(
        msgs.len(),
        1,
        "a 180 KB multi-byte row must still be delivered"
    );
    assert_eq!(msgs[0]["content"].as_str().unwrap(), multibyte);
    assert_eq!(page["nextSequence"], 1);
    // And the whole frame really did stay under the transport cap.
    let frame = serde_json::to_string(&page).unwrap();
    assert!(
        frame.len() < sandpane_service::MAX_FRAME_BYTES,
        "history frame was {} bytes",
        frame.len()
    );
}
