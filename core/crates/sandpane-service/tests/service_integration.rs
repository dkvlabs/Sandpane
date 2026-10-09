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

use sandpane_core::sbx::SbxLocator;
use sandpane_core::Database;
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
