//! End-to-end service tests over a REAL Unix socket with NDJSON framing.
//!
//! These exercise the same code path a client uses: connect, write a frame,
//! read the correlated response. SBX scenarios use an explicitly-labeled
//! STAND-IN executable (a test double, NOT the real Docker SBX CLI): it
//! answers only the argument vectors the real `sbx v0.47.0` accepts, with
//! output strings copied from the captured fixtures
//! (`sandpane-core/tests/fixtures/sbx/captured/v0.47.0/`), and logs every argv
//! it receives so tests assert the EXACT vectors Core executed. It proves our
//! exec/parse/classify/re-query paths, not real SBX behavior.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::params;
use sandpane_core::idempotency;
use sandpane_core::sbx::SbxLocator;
use sandpane_core::{Database, EventLog};
use sandpane_protocol::{ConversationSendParams, Method, SandboxCreateSpec};
use sandpane_service::confirm::{ConfirmationBinding, CONFIRMATION_TTL};
use sandpane_service::{serve_connection, CoreConfig, ServerInner};

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
    let db = Database::open(&db_path).unwrap();
    let inner = ServerInner::new(db, locator);
    serve_inner(inner, dir)
}

/// Serve an already-built [`ServerInner`] (custom `CoreConfig`) on a socket
/// inside `dir`.
fn serve_inner(inner: Arc<ServerInner>, dir: tempfile::TempDir) -> TestServer {
    let socket_path = dir.path().join("test.sock");
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
        // Shown with --nocapture: the real frames quoted in reports.
        println!(">> {frame}\n<< {}", line.trim_end());
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

/// Stand-in for `sbx v0.47.0` (see module docs). `list_json` is what
/// `ls --json` prints (real row shape: `name`/`status`/…); `create_error`, when
/// set, is printed to stderr by `create` with exit 1 (real error format);
/// `ls_error` likewise for `ls`. `stop`/`rm` print `stop.err`/`rm.err` with
/// exit 1 when present; on success they move `ls.after-stop.json` /
/// `ls.after-rm.json` (when present) over `ls.json`, so the post-mutation
/// re-query sees the new state; `rm.sleep` makes `rm` take ~1 s (a window
/// for concurrency tests). Every invocation's argv is appended to
/// `argv.log` (one line per call, args separated by U+001F).
struct FakeSbx {
    dir: tempfile::TempDir,
}

impl FakeSbx {
    fn locator(&self) -> SbxLocator {
        SbxLocator::with_search(None, vec![self.dir.path().to_path_buf()])
    }

    /// Forget the argv log so a test can assert ONLY what a later step ran.
    fn reset_calls(&self) {
        let _ = std::fs::remove_file(self.dir.path().join("argv.log"));
    }

    /// Replace what `ls --json` prints from now on (a data file, never code).
    fn set_ls(&self, json: &str) {
        std::fs::write(self.dir.path().join("ls.json"), format!("{json}\n")).unwrap();
    }

    /// What `ls --json` prints after the next successful `rm` / `stop`.
    fn ls_after(&self, verb: &str, json: &str) {
        std::fs::write(
            self.dir.path().join(format!("ls.after-{verb}.json")),
            format!("{json}\n"),
        )
        .unwrap();
    }

    /// Make `verb` fail with this stderr (exit 1), as the real CLI does.
    fn fail(&self, verb: &str, stderr: &str) {
        std::fs::write(
            self.dir.path().join(format!("{verb}.err")),
            format!("{stderr}\n"),
        )
        .unwrap();
    }

    fn calls(&self) -> Vec<Vec<String>> {
        std::fs::read_to_string(self.dir.path().join("argv.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| {
                l.split('\u{1f}')
                    .filter(|a| !a.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .collect()
    }
}

/// The stand-in's program text is a FIXED literal: every variable input
/// (list JSON, error texts) is a data file beside it, read via `$0`, so no
/// value is ever interpolated into script source.
const FAKE_SBX_SCRIPT: &str = r#"#!/bin/sh
d=$(dirname "$0")
for a in "$@"; do printf '%s\037' "$a" >> "$d/argv.log"; done
printf '\n' >> "$d/argv.log"
case "$*" in
  'version') echo 'sbx version: v0.47.0 0411f50ee4700fe7bd37e6e7e3aced563e850ca9' ;;
  'daemon status --json') cat "$d/daemon.json" ;;
  'ls --json')
    if [ -f "$d/ls.err" ]; then cat "$d/ls.err" >&2; exit 1; fi
    cat "$d/ls.json" ;;
  create\ *)
    if [ -f "$d/create.sleep" ]; then sleep 5; fi
    if [ -f "$d/create.err" ]; then cat "$d/create.err" >&2; exit 1; fi
    exit 0 ;;
  stop\ *)
    if [ -f "$d/stop.err" ]; then cat "$d/stop.err" >&2; exit 1; fi
    if [ -f "$d/ls.after-stop.json" ]; then mv "$d/ls.after-stop.json" "$d/ls.json"; fi
    exit 0 ;;
  rm\ *)
    if [ -f "$d/rm.sleep" ]; then sleep 1; fi
    if [ -f "$d/rm.err" ]; then cat "$d/rm.err" >&2; exit 1; fi
    if [ -f "$d/ls.after-rm.json" ]; then mv "$d/ls.after-rm.json" "$d/ls.json"; fi
    exit 0 ;;
  *) echo 'unsupported by stand-in' >&2; exit 64 ;;
esac
"#;

fn fake_sbx(list_json: &str, create_error: Option<&str>, ls_error: Option<&str>) -> FakeSbx {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("ls.json"), format!("{list_json}\n")).unwrap();
    // Captured state/daemon_status_running_json.txt (sanitized).
    std::fs::write(
        dir.path().join("daemon.json"),
        "{\n  \"status\": \"running\",\n  \"socket\": \"$HOME/.sbx/run/d/sandboxd.sock\"\n}\n",
    )
    .unwrap();
    if let Some(e) = create_error {
        std::fs::write(dir.path().join("create.err"), format!("{e}\n")).unwrap();
    }
    if let Some(e) = ls_error {
        std::fs::write(dir.path().join("ls.err"), format!("{e}\n")).unwrap();
    }
    let path = dir.path().join("sbx");
    std::fs::write(&path, FAKE_SBX_SCRIPT).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    FakeSbx { dir }
}

/// A real, committed Git repository (project.create requires a Git top
/// level, security W1). Returns the tempdir and its CANONICAL path string.
fn git_repo() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
    };
    run(&["init", "-q", "-b", "main"]);
    run(&["config", "user.email", "sandpane@test.invalid"]);
    run(&["config", "user.name", "Sandpane Test"]);
    std::fs::write(dir.path().join("README.md"), "demo\n").unwrap();
    run(&["add", "."]);
    run(&["commit", "-qm", "base"]);
    let canonical = std::fs::canonicalize(dir.path())
        .unwrap()
        .display()
        .to_string();
    (dir, canonical)
}

const ROWS_RUNNING_STOPPED: &str = r#"{"sandboxes":[{"name":"atlas-auth","id":"b5ebec73-e2ae-471a-811a-e011cfb1948e","agent":"shell","status":"running","last_used_at":"2026-10-09T17:31:30.035041Z","workspaces":["/x"],"created_at":"2026-10-09T17:31:28Z"},{"name":"nova-search","id":"c5ebec73-e2ae-471a-811a-e011cfb1948e","agent":"shell","status":"stopped","last_used_at":"2026-10-09T17:31:30Z","workspaces":[],"created_at":"2026-10-09T17:31:28Z"}]}"#;

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
    // The honest scaffold event names the unverified adapter gate with a
    // policy refusal (review 0015 bug 9) — not a sign-in prompt.
    assert_eq!(arr[3]["payload"]["code"], "PERMISSION_DENIED");
    assert!(arr[3]["payload"]["message"]
        .as_str()
        .unwrap()
        .contains("no verified agent adapter"));
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
    let fake = fake_sbx(r#"{"sandboxes":[]}"#, None, None);
    let mut s = start_server(fake.locator());
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
        "default",
        "x",
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
    assert!(
        fake.calls().is_empty(),
        "nothing reached sbx: {:?}",
        fake.calls()
    );
}

#[test]
fn sandbox_list_and_create_with_stand_in_executable() {
    let fake = fake_sbx(ROWS_RUNNING_STOPPED, None, None);
    let mut s = start_server(fake.locator());

    let list = s.ok("1", "sandbox.list", serde_json::json!({}));
    let arr = list.as_array().unwrap();
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["name"], "atlas-auth");
    // Real rows carry `status` (captured crud/02); it becomes probedState.
    assert_eq!(arr[0]["probedState"], "running");
    assert_eq!(arr[1]["probedState"], "stopped");
    assert!(arr[0]["boundProjectId"].is_null(), "not bound yet");

    // A writable workspace mode requires a REGISTERED repository path
    // (mount containment, review 0004 Critical #2).
    let (_repo, repo_path) = git_repo();
    let project = s.ok(
        "2",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo_path]}),
    );
    let created = s.ok(
        "3",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-auth",
            "projectId": project["id"],
            "workspaceMode": "sbx_clone",
            "repoPath": repo_path
        }),
    );
    // Exit 0 is NOT trusted: state comes from the re-query.
    assert_eq!(created["probedState"], "running");
    assert_eq!(created["boundProjectId"], project["id"]);

    // The EXACT vectors Core executed, in order: ls (list), create with
    // --clone for sbx_clone (bug 3), then the post-mutation ls re-query.
    let calls = fake.calls();
    assert_eq!(
        calls,
        vec![
            vec!["ls".to_string(), "--json".into()],
            vec![
                "create".to_string(),
                "--clone".into(),
                "--name".into(),
                "atlas-auth".into(),
                "shell".into(),
                repo_path.clone()
            ],
            vec!["ls".to_string(), "--json".into()],
        ]
    );

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

    // Bug 10: sandbox.list now reports the bound project from the binding row.
    let list = s.ok("4", "sandbox.list", serde_json::json!({}));
    let bound = list
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "atlas-auth")
        .unwrap()
        .clone();
    assert_eq!(bound["boundProjectId"], project["id"]);
    let unbound = list
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "nova-search")
        .unwrap()
        .clone();
    assert!(unbound["boundProjectId"].is_null());
}

#[test]
fn direct_mount_and_mountless_emit_the_real_create_vectors() {
    let fake = fake_sbx(r#"{"sandboxes":[]}"#, None, None);
    let mut s = start_server(fake.locator());
    let (_repo, repo_path) = git_repo();
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo_path]}),
    );
    let live = s.ok(
        "2",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-live", "projectId": project["id"],
            "workspaceMode": "direct_mount", "repoPath": repo_path
        }),
    );
    assert_eq!(live["workspaceMode"], "direct_mount");
    // Not in the re-queried list → state unknown (null), never guessed.
    assert!(live["probedState"].is_null());
    s.ok(
        "3",
        "sandbox.create",
        serde_json::json!({"name": "atlas-scratch", "projectId": project["id"], "workspaceMode": "mountless"}),
    );
    let creates: Vec<Vec<String>> = fake
        .calls()
        .into_iter()
        .filter(|c| c.first().map(String::as_str) == Some("create"))
        .collect();
    assert_eq!(
        creates,
        vec![
            vec![
                "create".to_string(),
                "--name".into(),
                "atlas-live".into(),
                "shell".into(),
                repo_path.clone()
            ],
            vec![
                "create".to_string(),
                "--name".into(),
                "atlas-scratch".into(),
                "shell".into()
            ],
        ]
    );
}

#[test]
fn host_worktree_is_refused_as_not_implemented_before_any_exec() {
    let fake = fake_sbx(r#"{"sandboxes":[]}"#, None, None);
    let mut s = start_server(fake.locator());
    let (_repo, repo_path) = git_repo();
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo_path]}),
    );
    let err = s.err(
        "2",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-wt", "projectId": project["id"],
            "workspaceMode": "host_worktree", "repoPath": repo_path
        }),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    assert!(err["message"].as_str().unwrap().contains("not implemented"));
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());
}

/// Bug 5: real captured sbx errors become structured codes with remediation
/// in `details` (an existing v1 envelope field).
#[test]
fn sbx_failures_are_classified_with_remediation_details() {
    let policy = fake_sbx(
        r#"{"sandboxes":[]}"#,
        Some("error: global network policy has not been initialized\n  try: sbx policy init <allow-all|balanced|deny-all>"),
        None,
    );
    let mut s = start_server(policy.locator());
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": []}),
    );
    let err = s.err(
        "2",
        "sandbox.create",
        serde_json::json!({"name": "atlas-x", "projectId": project["id"], "workspaceMode": "mountless"}),
    );
    assert_eq!(err["code"], "PERMISSION_DENIED");
    assert!(err["message"]
        .as_str()
        .unwrap()
        .contains("sbx policy init <allow-all|balanced|deny-all>"));
    assert_eq!(
        err["details"]["hint"],
        "sbx policy init <allow-all|balanced|deny-all>"
    );
    // No binding is recorded for a failed create.
    let n: i64 = s
        .inner
        .lock_db()
        .conn()
        .query_row("SELECT COUNT(*) FROM sandbox_bindings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);

    let auth = fake_sbx(
        "",
        Some("error: not signed in to Docker\n  try: sbx login"),
        Some("error: not signed in to Docker\n  try: sbx login"),
    );
    let mut s = start_server(auth.locator());
    let err = s.err("3", "sandbox.list", serde_json::json!({}));
    assert_eq!(err["code"], "PROVIDER_AUTH_REQUIRED");
    assert!(err["message"].as_str().unwrap().contains("sbx login"));
    assert_eq!(err["details"]["provider"], "docker");
    assert_eq!(err["details"]["hint"], "sbx login");
    let project = s.ok(
        "4",
        "project.create",
        serde_json::json!({"name": "Nova Demo", "repositories": []}),
    );
    let err = s.err(
        "5",
        "sandbox.create",
        serde_json::json!({"name": "nova-x", "projectId": project["id"], "workspaceMode": "mountless"}),
    );
    assert_eq!(err["code"], "PROVIDER_AUTH_REQUIRED");
}

/// Backlog 6: system.probe runs `sbx version` + `sbx daemon status --json`
/// and NEVER `ls` (which auto-starts the daemon).
#[test]
fn probe_reports_version_and_daemon_without_listing() {
    let fake = fake_sbx(r#"{"sandboxes":[]}"#, None, None);
    let mut s = start_server(fake.locator());
    let caps = s.ok("1", "system.probe", serde_json::json!({}));
    assert_eq!(caps["sbx"]["installed"], true);
    assert_eq!(caps["sbx"]["version"], "0.47.0");
    assert_eq!(caps["sbx"]["daemonRunning"], true);
    let bin = fake.dir.path().join("sbx").display().to_string();
    assert_eq!(caps["sbx"]["binaryPath"], bin);
    assert_eq!(
        fake.calls(),
        vec![
            vec!["version".to_string()],
            vec!["daemon".to_string(), "status".into(), "--json".into()]
        ]
    );
}

#[test]
fn project_create_registers_only_canonical_git_toplevels() {
    let mut s = start_server(no_sbx());
    // Not a Git repository → refused.
    let plain = tempfile::tempdir().unwrap();
    let err = s.err(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [plain.path().display().to_string()]}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    // A subdirectory of a repository → refused (must be the top level).
    let (repo, repo_path) = git_repo();
    std::fs::create_dir(repo.path().join("src")).unwrap();
    let err = s.err(
        "2",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo.path().join("src").display().to_string()]}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    assert!(err["message"].as_str().unwrap().contains("top level"));
    // Root, home and system trees → PERMISSION_DENIED (never reaches git).
    let home = std::env::var("HOME").unwrap();
    for bad in ["/", home.as_str(), "/etc", "/usr"] {
        let err = s.err(
            "3",
            "project.create",
            serde_json::json!({"name": "Atlas Demo", "repositories": [bad]}),
        );
        assert_eq!(err["code"], "PERMISSION_DENIED", "{bad}");
    }
    // A symlink to the repository is stored as the CANONICAL path.
    let links = tempfile::tempdir().unwrap();
    let link = links.path().join("atlas-link");
    std::os::unix::fs::symlink(repo.path(), &link).unwrap();
    let created = s.ok(
        "4",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [link.display().to_string()]}),
    );
    assert_eq!(created["repositories"][0], repo_path);
    // Nothing partial was stored by the refused attempts.
    let n: i64 = s
        .inner
        .lock_db()
        .conn()
        .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn sandbox_create_enforces_mount_containment() {
    let fake = fake_sbx(r#"{"sandboxes":[]}"#, None, None);
    let mut s = start_server(fake.locator());

    let (registered, registered_path) = git_repo();
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [registered_path]}),
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
        serde_json::json!({"name": "atlas-x", "projectId": pid, "workspaceMode": "direct_mount"}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    assert!(fake.calls().is_empty(), "refusals never reach sbx");

    // Review S-g: a SUBDIRECTORY of the registered repository is refused —
    // only the registered root itself may be mounted, so no agent-writable
    // path component lies between Core's canonicalize and sbx's own resolve.
    let sub = registered.path().join("src");
    std::fs::create_dir_all(&sub).unwrap();
    let err = s.err(
        "5",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-sub", "projectId": pid,
            "workspaceMode": "sbx_clone", "repoPath": sub.display().to_string()
        }),
    );
    assert_eq!(err["code"], "PERMISSION_DENIED");
    assert!(fake.calls().is_empty(), "refusals never reach sbx");
    // The registered root itself (given via a non-canonical spelling) is
    // accepted, and the CANONICAL path reaches the argument vector.
    let ok = s.ok(
        "5b",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-ok", "projectId": pid,
            "workspaceMode": "sbx_clone",
            "repoPath": registered.path().join("src/..").display().to_string()
        }),
    );
    assert_eq!(ok["name"], "atlas-ok");
    let create = fake
        .calls()
        .into_iter()
        .find(|c| c.first().map(String::as_str) == Some("create"))
        .unwrap();
    assert_eq!(create.last().unwrap(), &registered_path);

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

/// Review finding (bb5cc8f): the hardened status/diff pass
/// `--ignore-submodules=dirty`, so uncommitted work INSIDE a submodule is
/// invisible. `git.review` must not return a silently partial change list
/// (the protocol has no "incomplete" field) and `git.apply` must abort.
#[test]
fn git_review_and_apply_refuse_repo_with_submodule() {
    let mut s = start_server(no_sbx());
    let dir = tempfile::tempdir().unwrap();
    let origin = dir.path().join("lib-origin");
    let repo = dir.path().join("host");
    let git = |cwd: &std::path::Path, args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    for d in [&origin, &repo] {
        std::fs::create_dir(d).unwrap();
        git(d, &["init", "-q", "-b", "main"]);
        git(d, &["config", "user.email", "sandpane@test.invalid"]);
        git(d, &["config", "user.name", "Sandpane Test"]);
        std::fs::write(d.join("app.txt"), "base\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-qm", "base"]);
    }
    git(
        &repo,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            &origin.display().to_string(),
            "vendor/lib",
        ],
    );
    git(&repo, &["commit", "-qm", "add submodule"]);
    let base = git(&repo, &["rev-parse", "HEAD"]);
    // Uncommitted user work inside the submodule work tree.
    std::fs::write(repo.join("vendor/lib/app.txt"), "uncommitted\n").unwrap();

    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Nova Demo", "repositories": [repo.display().to_string()]}),
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
    {
        let db = s.inner.db.lock().unwrap();
        db.conn()
            .execute(
                "INSERT INTO tasks (id, conversation_id, repo_id, base_commit, status, created_at, updated_at)
                 VALUES ('task-sub-1',?1,?2,?3,'queued','t','t')",
                rusqlite::params![conv["id"].as_str().unwrap(), repo_id, base],
            )
            .unwrap();
    }

    let err = s.err(
        "3",
        "git.review",
        serde_json::json!({"taskId": "task-sub-1"}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED", "got: {err}");
    let msg = err["message"].as_str().unwrap();
    assert!(msg.contains("vendor/lib"), "names the submodule: {msg}");
    assert!(msg.contains("cannot verify"), "{msg}");

    let apply = s.ok(
        "4",
        "git.apply",
        serde_json::json!({"taskId": "task-sub-1", "expectedBase": base}),
    );
    assert_eq!(apply["applied"], false);
    let reason = apply["abortReason"].as_str().unwrap();
    assert!(reason.contains("vendor/lib"), "got: {reason}");
    assert!(reason.contains("submodule"), "got: {reason}");
    assert_eq!(
        std::fs::read_to_string(repo.join("vendor/lib/app.txt")).unwrap(),
        "uncommitted\n",
        "submodule work must survive"
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
    // Canonical Git top levels (W1 stores the canonical path).
    let (_repo_a, path_a) = git_repo();
    let (_repo_b, path_b) = git_repo();
    let paths = vec![path_a, path_b];
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
    let fake = fake_sbx(ROWS_RUNNING_STOPPED, None, None);
    let mut s = start_server(fake.locator());

    let (repo, repo_path) = git_repo();
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo_path]}),
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
    let list_json = r#"{"sandboxes":[{"name":"legacy-mount","status":"running"},{"name":"never-bound","status":"running"}]}"#;
    let fake = fake_sbx(list_json, None, None);
    let mut s = start_server(fake.locator());
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

/// Bug 1 (review 0015): EVERY TaskStatus seeded as a crashed daemon left it;
/// a fresh ServerInner reconciles exactly the live states (including
/// `awaiting_input` and `verifying`, both missed before) to `interrupted`
/// with a durable event, and leaves `awaiting_review` + terminal states alone.
#[test]
fn restart_reconciliation_is_exhaustive_over_every_status() {
    use sandpane_core::task::{TaskStateMachine, ALL_STATUSES};
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("core.sqlite3");
    let wire = |st: sandpane_protocol::TaskStatus| {
        serde_json::to_value(st)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    };
    {
        let db = Database::open(&db_path).unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
                 INSERT INTO conversations (id,project_id,agent_id,created_at) VALUES ('c1','p1','codex','t');",
            )
            .unwrap();
        for st in ALL_STATUSES {
            db.conn()
                .execute(
                    "INSERT INTO tasks (id,conversation_id,status,created_at,updated_at) VALUES (?1,'c1',?1,'t','t')",
                    rusqlite::params![wire(*st)],
                )
                .unwrap();
        }
    }
    let s = start_server_at(no_sbx(), dir, db_path);
    let db = s.inner.lock_db();
    for st in ALL_STATUSES {
        let id = wire(*st);
        let now: String = db
            .conn()
            .query_row("SELECT status FROM tasks WHERE id=?1", [&id], |r| r.get(0))
            .unwrap();
        let events: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM task_events WHERE task_id=?1 AND kind='status.changed'
                 AND payload LIKE '%reconciledAfterRestart%'",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        if TaskStateMachine::reconciled_on_restart(*st) {
            assert_eq!(now, "interrupted", "{id} must be reconciled");
            assert_eq!(events, 1, "{id} needs one durable reconciliation event");
        } else {
            assert_eq!(now, id, "{id} must be left untouched");
            assert_eq!(events, 0, "{id}");
        }
    }
    for (id, expected) in [
        ("awaiting_input", "interrupted"),
        ("verifying", "interrupted"),
        ("awaiting_review", "awaiting_review"),
    ] {
        let now: String = db
            .conn()
            .query_row("SELECT status FROM tasks WHERE id=?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(now, expected, "{id}");
    }
}

/// Security W3: an abbreviated (even 1-char) base can no longer satisfy the
/// apply gate; only the exact full object id is accepted as an assertion.
#[test]
fn git_apply_requires_a_full_object_id() {
    let mut s = start_server(no_sbx());
    for short in ["3", "abc1234", "0123456789abcdef0123456789abcdef0123456"] {
        let err = s.err(
            "1",
            "git.apply",
            serde_json::json!({"taskId": "t-any", "expectedBase": short}),
        );
        assert_eq!(err["code"], "VALIDATION_FAILED", "{short}");
    }
}

/// Security S7: connections beyond the cap get a structured refusal, and an
/// idle connection is closed after the idle timeout (clients reconnect).
#[test]
fn connection_cap_and_idle_timeout() {
    use sandpane_service::runtime::ConnectionLimits;
    let dir = tempfile::tempdir().unwrap();
    let socket_path = dir.path().join("cap.sock");
    let inner = ServerInner::new(Database::open_in_memory().unwrap(), no_sbx());
    let listener = UnixListener::bind(&socket_path).unwrap();
    let limits = ConnectionLimits {
        max_connections: 1,
        idle_timeout: std::time::Duration::from_millis(1000),
        write_timeout: std::time::Duration::from_secs(5),
    };
    std::thread::spawn(move || sandpane_service::serve_listener(inner, listener, limits));

    let mut first = UnixStream::connect(&socket_path).unwrap();
    let mut first_reader = BufReader::new(first.try_clone().unwrap());
    writeln!(
        first,
        r#"{{"v":1,"id":"a","method":"system.probe","params":{{}}}}"#
    )
    .unwrap();
    let mut line = String::new();
    first_reader.read_line(&mut line).unwrap();
    assert!(line.contains("\"ok\""), "{line}");

    // Second concurrent connection → refused with a frame, then closed.
    let second = UnixStream::connect(&socket_path).unwrap();
    let mut second_reader = BufReader::new(second);
    let mut refused = String::new();
    second_reader.read_line(&mut refused).unwrap();
    assert!(refused.contains("too many connections"), "{refused}");

    // The first connection idles past the timeout → server closes it (EOF).
    first
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    let mut rest = String::new();
    let n = first_reader.read_line(&mut rest).unwrap();
    assert_eq!(n, 0, "idle connection must be closed, got {rest:?}");

    // Its slot is released: a new connection is served again.
    std::thread::sleep(std::time::Duration::from_millis(50));
    let mut third = UnixStream::connect(&socket_path).unwrap();
    let mut third_reader = BufReader::new(third.try_clone().unwrap());
    writeln!(
        third,
        r#"{{"v":1,"id":"c","method":"system.probe","params":{{}}}}"#
    )
    .unwrap();
    let mut ok = String::new();
    third_reader.read_line(&mut ok).unwrap();
    assert!(ok.contains("\"ok\""), "{ok}");
}

/// Security W1 for rows written BEFORE registration was hardened: a stored
/// repository row for HOME must not authorize a mount under HOME. The
/// denylist is re-applied to registered roots at sandbox.create time.
#[test]
fn legacy_overbroad_repository_row_never_authorizes_a_mount() {
    let fake = fake_sbx(r#"{"sandboxes":[]}"#, None, None);
    let mut s = start_server(fake.locator());
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": []}),
    );
    let pid = project["id"].as_str().unwrap().to_string();
    let home = std::fs::canonicalize(std::env::var("HOME").unwrap()).unwrap();
    {
        let db = s.inner.lock_db();
        db.conn()
            .execute(
                "INSERT INTO repositories (id, project_id, canonical_path) VALUES ('legacy-home', ?1, ?2)",
                params![pid, home.display().to_string()],
            )
            .unwrap();
    }
    // Any existing directory under HOME would be "contained" by that row.
    let under_home = std::fs::read_dir(&home)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.is_dir() && !p.file_name().unwrap().to_string_lossy().starts_with('.'))
        .unwrap_or_else(|| home.clone());
    let err = s.err(
        "2",
        "sandbox.create",
        serde_json::json!({
            "name": "atlas-home", "projectId": pid,
            "workspaceMode": "direct_mount",
            "repoPath": under_home.display().to_string()
        }),
    );
    assert_eq!(err["code"], "PERMISSION_DENIED", "{err}");
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());
}

/// Review S-c: when `sbx create` outlives its deadline (killed) the sandbox
/// may still have been created. Core re-queries `ls --json` and records the
/// binding of a sandbox that exists instead of orphaning it; an absent one
/// is reported as a timeout, never as success.
#[test]
fn create_timeout_requeries_and_never_orphans_a_created_sandbox() {
    use sandpane_core::process::RunLimits;
    use sandpane_service::SbxLimits;
    let fast = SbxLimits {
        mutation: RunLimits {
            timeout: std::time::Duration::from_millis(300),
            ..RunLimits::MUTATION
        },
        ..SbxLimits::default()
    };
    // The sandbox shows up in `ls` although `create` never returned.
    let fake = fake_sbx(
        r#"{"sandboxes":[{"name":"atlas-slow","status":"running"}]}"#,
        None,
        None,
    );
    std::fs::write(fake.dir.path().join("create.sleep"), "").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("t.sqlite3")).unwrap();
    let inner = ServerInner::with_sbx_limits(db, fake.locator(), fast);
    let project = sandpane_service::handle_line(
        &inner,
        r#"{"v":1,"id":"1","method":"project.create","params":{"name":"Atlas Demo","repositories":[]}}"#,
    );
    let project: serde_json::Value = serde_json::from_str(&project).unwrap();
    let pid = project["ok"]["id"].as_str().unwrap().to_string();
    let call = |name: &str| -> serde_json::Value {
        let frame = serde_json::json!({"v":1,"id":"2","method":"sandbox.create",
            "params":{"name": name, "projectId": pid, "workspaceMode": "mountless"}});
        serde_json::from_str(&sandpane_service::handle_line(&inner, &frame.to_string())).unwrap()
    };
    let start = std::time::Instant::now();
    let found = call("atlas-slow");
    assert!(
        start.elapsed() < std::time::Duration::from_secs(4),
        "deadline enforced"
    );
    assert_eq!(found["ok"]["probedState"], "running", "{found}");
    let n: i64 = inner
        .lock_db()
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM sandbox_bindings WHERE sandbox_name='atlas-slow'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "the created sandbox is bound, not orphaned");
    // A sandbox that is NOT present after the timeout is an error.
    let missing = call("atlas-missing");
    assert_eq!(missing["err"]["code"], "INTERNAL", "{missing}");
    assert!(missing["err"]["message"]
        .as_str()
        .unwrap()
        .contains("timed out"));
}

// ---------------------------------------------------------------------------
// A1: sandbox.stop, two-step sandbox.remove, SandboxCreateSpec.agent
// ---------------------------------------------------------------------------

const ATLAS_ID: &str = "b5ebec73-e2ae-471a-811a-e011cfb1948e";
const ATLAS_REPLACEMENT_ID: &str = "d0d0d0d0-e2ae-471a-811a-e011cfb1948e";
const NOVA_ID: &str = "c5ebec73-e2ae-471a-811a-e011cfb1948e";
const EMPTY_LS: &str = r#"{"sandboxes":[]}"#;
/// Captured `errors/stop_not_found.txt` / `errors/rm_not_found.txt` shape.
const NOT_FOUND_ERR: &str = "error: sandbox 'atlas-auth' not found\n  try: sbx ls";

fn ls_with_atlas(id: &str, status: &str) -> String {
    format!(
        r#"{{"sandboxes":[{{"name":"atlas-auth","id":"{id}","agent":"shell","status":"{status}","last_used_at":"2026-10-09T17:31:30Z","workspaces":[],"created_at":"2026-10-09T17:31:28Z"}}]}}"#
    )
}

fn v(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}

/// Record a Sandpane binding for `atlas-auth` (mountless) through the real
/// `sandbox.create` path, then forget the argv it produced.
fn bind_atlas(s: &mut TestServer, fake: &FakeSbx) -> serde_json::Value {
    let project = s.ok(
        "bind-p",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": []}),
    );
    s.ok(
        "bind-c",
        "sandbox.create",
        serde_json::json!({"name": "atlas-auth", "projectId": project["id"], "workspaceMode": "mountless"}),
    );
    fake.reset_calls();
    project
}

fn binding_rows(s: &TestServer) -> Vec<(String, Option<String>)> {
    let db = s.inner.lock_db();
    let mut stmt = db
        .conn()
        .prepare("SELECT sandbox_name, removed_at FROM sandbox_bindings ORDER BY rowid")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    rows
}

#[test]
fn sandbox_stop_runs_the_exact_vector_and_reports_the_requeried_state() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    fake.ls_after("stop", &ls_with_atlas(ATLAS_ID, "stopped"));
    let mut s = start_server(fake.locator());
    let out = s.ok(
        "1",
        "sandbox.stop",
        serde_json::json!({"name": "atlas-auth"}),
    );
    assert_eq!(out["stopped"], true);
    // State comes from the re-query, never from exit 0.
    assert_eq!(out["requeried"]["name"], "atlas-auth");
    assert_eq!(out["requeried"]["probedState"], "stopped");
    assert_eq!(out["requeried"]["agent"], "shell");
    assert_eq!(
        fake.calls(),
        vec![v(&["stop", "atlas-auth"]), v(&["ls", "--json"])]
    );
}

#[test]
fn sandbox_stop_not_found_and_unlisted_after_stop_are_honest() {
    let fake = fake_sbx(EMPTY_LS, None, None);
    let mut s = start_server(fake.locator());
    // Exit 0 but the re-query does not list it: requeried is ABSENT.
    let out = s.ok(
        "1",
        "sandbox.stop",
        serde_json::json!({"name": "atlas-auth"}),
    );
    assert_eq!(out, serde_json::json!({"stopped": true}));
    // The real not-found error text becomes NOT_FOUND, and no re-query runs.
    fake.fail("stop", NOT_FOUND_ERR);
    fake.reset_calls();
    let err = s.err(
        "2",
        "sandbox.stop",
        serde_json::json!({"name": "atlas-auth"}),
    );
    assert_eq!(err["code"], "NOT_FOUND");
    assert_eq!(fake.calls(), vec![v(&["stop", "atlas-auth"])]);
}

#[test]
fn stop_and_remove_refuse_hostile_names_before_any_exec() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    for evil in [
        "a;rm -rf /",
        "$(whoami)",
        "--force",
        "a b",
        "default",
        "x",
        "",
    ] {
        for method in ["sandbox.stop", "sandbox.remove"] {
            let err = s.err("1", method, serde_json::json!({"name": evil}));
            assert_eq!(err["code"], "VALIDATION_FAILED", "{method} {evil:?}");
        }
    }
    let err = s.err("2", "sandbox.remove", serde_json::json!({}));
    assert_eq!(err["code"], "VALIDATION_FAILED");
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());
}

#[test]
fn sandbox_remove_two_step_flow_removes_and_marks_the_binding() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    bind_atlas(&mut s, &fake);

    // Step 1: describe + issue. Nothing changes; only `ls` runs.
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    assert!(step1.get("removed").is_none(), "{step1}");
    let c = &step1["confirmation"];
    let token = c["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);
    assert!(token
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_eq!(c["action"], "sandbox.remove");
    assert_eq!(
        c["target"],
        serde_json::json!({"name": "atlas-auth", "id": ATLAS_ID})
    );
    assert_eq!(c["external"], false);
    let expires = c["expiresAt"].as_str().unwrap();
    assert!(expires.ends_with('Z') && expires.len() == 20, "{expires}");
    let impact: Vec<&str> = c["impact"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap())
        .collect();
    assert!(
        impact.iter().any(|l| l.contains("atlas-auth")),
        "{impact:?}"
    );
    assert!(impact.iter().any(|l| l.contains("mountless")), "{impact:?}");
    assert_eq!(fake.calls(), vec![v(&["ls", "--json"])]);
    assert_eq!(binding_rows(&s), vec![("atlas-auth".into(), None)]);

    // Step 2: token + identity re-check, then `rm --force`, then re-query.
    fake.reset_calls();
    fake.ls_after("rm", EMPTY_LS);
    let step2 = s.ok(
        "2",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(step2, serde_json::json!({"removed": true}));
    assert_eq!(
        fake.calls(),
        vec![
            v(&["ls", "--json"]),
            v(&["rm", "--force", "atlas-auth"]),
            v(&["ls", "--json"])
        ]
    );
    // Marked removed, never deleted.
    let rows = binding_rows(&s);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].1.is_some(), "binding marked removed: {rows:?}");

    // Reuse: single-use, so nothing runs.
    fake.reset_calls();
    let err = s.err(
        "3",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());

    // A NEW same-named sandbox never inherits the removed binding.
    fake.set_ls(&ls_with_atlas(ATLAS_REPLACEMENT_ID, "running"));
    let list = s.ok("4", "sandbox.list", serde_json::json!({}));
    let row = &list.as_array().unwrap()[0];
    assert_eq!(row["name"], "atlas-auth");
    assert!(row.get("workspaceMode").is_none(), "{row}");
    assert!(row["boundProjectId"].is_null(), "{row}");
    // …and a confirmation for it is flagged external.
    let again = s.ok(
        "5",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    assert_eq!(again["confirmation"]["external"], true);
    assert_eq!(again["confirmation"]["target"]["id"], ATLAS_REPLACEMENT_ID);
}

/// A4 §3.4 item 3 (describe, never refuse): step 1 names the unfinished
/// tasks sent from chats that chose this sandbox NAME. Other names, chats
/// with no name and finished tasks are not counted; the line disappears when
/// none is left; step 2 still removes while tasks are unfinished; and
/// `sandbox.stop` is unchanged.
#[test]
fn sandbox_remove_step_one_counts_unfinished_tasks_sent_from_chats_that_chose_the_name() {
    const LINE: &str = "unfinished task(s) were sent from chats that chose this sandbox name; \
                        removing it does not cancel them";
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let project = bind_atlas(&mut s, &fake);
    let impact = |s: &mut TestServer, id: &str| -> (Vec<String>, String) {
        let step1 = s.ok(
            id,
            "sandbox.remove",
            serde_json::json!({"name": "atlas-auth"}),
        );
        let c = &step1["confirmation"];
        (
            c["impact"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l.as_str().unwrap().to_string())
                .collect(),
            c["token"].as_str().unwrap().to_string(),
        )
    };
    let (baseline, _) = impact(&mut s, "b0");
    assert!(
        !baseline.iter().any(|l| l.contains("unfinished")),
        "{baseline:?}"
    );

    let chat = |s: &mut TestServer, id: &str, sandbox: Option<&str>| -> String {
        let mut p =
            serde_json::json!({"projectId": project["id"], "agentId": "codex", "title": id});
        if let Some(name) = sandbox {
            p["sandboxId"] = serde_json::json!(name);
        }
        s.ok(id, "conversation.create", p)["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let send = |s: &mut TestServer, id: &str, conv: &str, mode: &str| -> String {
        s.ok(
            id,
            "conversation.send",
            serde_json::json!({"conversationId": conv, "content": "x", "mode": mode}),
        )["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let atlas_chat = chat(&mut s, "c1", Some("atlas-auth"));
    let nova_chat = chat(&mut s, "c2", Some("nova-search"));
    let plain_chat = chat(&mut s, "c3", None);
    let t1 = send(&mut s, "s1", &atlas_chat, "task");
    let t2 = send(&mut s, "s2", &atlas_chat, "discuss");
    send(&mut s, "s3", &nova_chat, "task");
    send(&mut s, "s4", &plain_chat, "task");

    let (two, _) = impact(&mut s, "i2");
    let expected2 = format!("2 {LINE}");
    assert_eq!(
        two.iter()
            .filter(|l| l.contains("unfinished"))
            .collect::<Vec<_>>(),
        vec![&expected2],
        "{two:?}"
    );
    // Additive: every other line is exactly the baseline.
    let others: Vec<String> = two.iter().filter(|l| **l != expected2).cloned().collect();
    assert_eq!(others, baseline);

    s.ok("x1", "task.cancel", serde_json::json!({"taskId": &t1}));
    let (one, _) = impact(&mut s, "i1");
    assert!(one.contains(&format!("1 {LINE}")), "{one:?}");
    s.ok("x2", "task.cancel", serde_json::json!({"taskId": &t2}));
    let (zero, _) = impact(&mut s, "i0");
    assert_eq!(zero, baseline, "no line once nothing is unfinished");

    // Never refuses: stop and remove both proceed with an unfinished task.
    send(&mut s, "s5", &atlas_chat, "task");
    fake.ls_after("stop", &ls_with_atlas(ATLAS_ID, "stopped"));
    let stopped = s.ok(
        "st",
        "sandbox.stop",
        serde_json::json!({"name": "atlas-auth"}),
    );
    assert_eq!(stopped["stopped"], true, "{stopped}");
    let (again, token) = impact(&mut s, "i3");
    assert!(again.contains(&format!("1 {LINE}")), "{again:?}");
    fake.ls_after("rm", EMPTY_LS);
    let removed = s.ok(
        "rm",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(removed, serde_json::json!({"removed": true}));
}

/// Step-1 impact lines of `sandbox.remove` for `atlas-auth` (+ the token).
fn atlas_remove_impact(s: &mut TestServer, id: &str) -> (Vec<String>, String) {
    let step1 = s.ok(
        id,
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let c = &step1["confirmation"];
    (
        c["impact"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap().to_string())
            .collect(),
        c["token"].as_str().unwrap().to_string(),
    )
}

const UNFINISHED_LINE: &str = "unfinished task(s) were sent from chats that chose this sandbox \
                               name; removing it does not cancel them";

/// Review I7 (fail-closed): a task whose stored status Core cannot read is
/// counted as unfinished — the line over-reports, never hides.
#[test]
fn sandbox_remove_counts_an_unreadable_task_status_as_unfinished() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let project = bind_atlas(&mut s, &fake);
    let conv = s.ok(
        "c",
        "conversation.create",
        serde_json::json!({"projectId": project["id"], "agentId": "codex", "title": "c",
                           "sandboxId": "atlas-auth"}),
    );
    s.inner
        .lock_db()
        .conn()
        .execute(
            "INSERT INTO tasks (id, conversation_id, chosen_sandbox_name, status, created_at,
                                updated_at)
             VALUES ('t-garbled', ?1, 'atlas-auth', 'not-a-status', 't', 't')",
            [conv["id"].as_str().unwrap()],
        )
        .unwrap();
    let (impact, _) = atlas_remove_impact(&mut s, "i");
    assert!(
        impact.contains(&format!("1 {UNFINISHED_LINE}")),
        "{impact:?}"
    );
}

/// Review I7 (cross-project): chats in TWO projects that chose the same
/// sandbox name are both counted (a name is not scoped to a project).
#[test]
fn sandbox_remove_counts_unfinished_tasks_across_projects() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let atlas = bind_atlas(&mut s, &fake);
    let nova = s.ok(
        "p2",
        "project.create",
        serde_json::json!({"name": "Nova Demo", "repositories": []}),
    );
    for (i, project) in [&atlas, &nova].into_iter().enumerate() {
        let conv = s.ok(
            &format!("c{i}"),
            "conversation.create",
            serde_json::json!({"projectId": project["id"], "agentId": "codex", "title": "c",
                               "sandboxId": "atlas-auth"}),
        );
        s.ok(
            &format!("s{i}"),
            "conversation.send",
            serde_json::json!({"conversationId": conv["id"], "content": "x"}),
        );
    }
    let (impact, _) = atlas_remove_impact(&mut s, "i");
    assert!(
        impact.contains(&format!("2 {UNFINISHED_LINE}")),
        "{impact:?}"
    );
}

/// Review I1: if the count cannot be read, step 1 still answers (never
/// INTERNAL, never a refusal) and says so honestly; step 2 still removes.
/// The read failure is injected for real: the column the count reads is
/// dropped from the live database, so the query fails inside Core.
#[test]
fn sandbox_remove_step_one_survives_an_unreadable_unfinished_count() {
    const UNREADABLE: &str = "the number of unfinished tasks sent from chats that chose this \
                              sandbox name could not be read; removing it does not cancel them";
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    bind_atlas(&mut s, &fake);
    let (baseline, _) = atlas_remove_impact(&mut s, "b");
    s.inner
        .lock_db()
        .conn()
        .execute_batch(
            "DROP INDEX idx_tasks_chosen_sandbox_name;
             ALTER TABLE tasks DROP COLUMN chosen_sandbox_name;",
        )
        .unwrap();
    let (impact, token) = atlas_remove_impact(&mut s, "i");
    let mut expected = baseline.clone();
    expected.push(UNREADABLE.to_string());
    assert_eq!(impact, expected);
    fake.ls_after("rm", EMPTY_LS);
    let removed = s.ok(
        "rm",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(removed, serde_json::json!({"removed": true}));
}

#[test]
fn sandbox_remove_flags_a_sandbox_not_created_by_sandpane() {
    let fake = fake_sbx(ROWS_RUNNING_STOPPED, None, None);
    let mut s = start_server(fake.locator());
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "nova-search"}),
    );
    let c = &step1["confirmation"];
    assert_eq!(c["external"], true);
    assert_eq!(c["target"]["id"], NOVA_ID);
    assert!(
        c["impact"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l.as_str().unwrap().contains("not created by Sandpane")),
        "{c}"
    );
    assert_eq!(fake.calls(), vec![v(&["ls", "--json"])]);
}

#[test]
fn sandbox_remove_step_one_for_a_missing_sandbox_is_not_found() {
    let fake = fake_sbx(EMPTY_LS, None, None);
    let mut s = start_server(fake.locator());
    let err = s.err(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    assert_eq!(err["code"], "NOT_FOUND");
    assert!(s.inner.lock_confirmations().is_empty(), "no token issued");
}

#[test]
fn sandbox_remove_refuses_to_bind_a_row_without_an_sbx_id() {
    let fake = fake_sbx(
        r#"{"sandboxes":[{"name":"atlas-auth","status":"running"}]}"#,
        None,
        None,
    );
    let mut s = start_server(fake.locator());
    let err = s.err(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    // Fail closed: an sbx row without an id gives Core nothing to bind.
    assert_eq!(err["code"], "INTERNAL");
    assert!(
        err["message"].as_str().unwrap().contains("no usable id"),
        "{err}"
    );
    assert!(
        s.inner.lock_confirmations().is_empty(),
        "no identity, no token"
    );
}

/// `rm` is NEVER invoked for a missing, wrong, malformed, reused, expired,
/// other-action or other-target token — and nothing else runs either.
#[test]
fn sandbox_remove_never_runs_rm_without_a_valid_token() {
    let fake = fake_sbx(ROWS_RUNNING_STOPPED, None, None);
    let mut s = start_server(fake.locator());
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let token = step1["confirmation"]["token"].as_str().unwrap().to_string();
    fake.reset_calls();

    let wrong = "0".repeat(64);
    let other_action = s
        .inner
        .lock_confirmations()
        .issue(
            ConfirmationBinding {
                action: "project.delete".into(),
                name: "atlas-auth".into(),
                id: ATLAS_ID.into(),
            },
            Instant::now(),
            CONFIRMATION_TTL,
        )
        .unwrap();
    for (label, name, tok) in [
        ("wrong", "atlas-auth", wrong.as_str()),
        ("malformed", "atlas-auth", "not-a-token; rm -rf /"),
        ("empty", "atlas-auth", ""),
        ("other action", "atlas-auth", other_action.as_str()),
        // Presenting atlas-auth's token for another sandbox burns it…
        ("other target", "nova-search", token.as_str()),
        // …so it is now a reused token for its own target too.
        ("reused", "atlas-auth", token.as_str()),
    ] {
        let err = s.err(
            label,
            "sandbox.remove",
            serde_json::json!({"name": name, "confirmToken": tok}),
        );
        assert_eq!(err["code"], "VALIDATION_FAILED", "{label}");
        // The message never says which part mismatched.
        let msg = err["message"].as_str().unwrap();
        assert!(
            !msg.contains(ATLAS_ID) && !msg.contains("project.delete"),
            "{msg}"
        );
    }
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());
}

#[test]
fn expired_token_never_runs_rm() {
    let fake = fake_sbx(ROWS_RUNNING_STOPPED, None, None);
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("t.sqlite3")).unwrap();
    let inner = ServerInner::with_config(
        db,
        fake.locator(),
        CoreConfig {
            // Test-only: a zero lifetime, so the token is expired on arrival.
            confirmation_ttl: Some(Duration::ZERO),
            ..CoreConfig::default()
        },
    );
    let mut s = serve_inner(inner, dir);
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let token = step1["confirmation"]["token"].as_str().unwrap().to_string();
    fake.reset_calls();
    std::thread::sleep(Duration::from_millis(5));
    let err = s.err(
        "2",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());
}

#[test]
fn same_named_replacement_is_a_conflict_and_never_removed() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let token = step1["confirmation"]["token"].as_str().unwrap().to_string();
    // Between the steps the sandbox was replaced by another with the same name.
    fake.set_ls(&ls_with_atlas(ATLAS_REPLACEMENT_ID, "running"));
    fake.reset_calls();
    let err = s.err(
        "2",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(err["code"], "CONFLICT");
    assert_eq!(fake.calls(), vec![v(&["ls", "--json"])]);
    // The token was consumed by that attempt.
    fake.set_ls(&ls_with_atlas(ATLAS_ID, "running"));
    fake.reset_calls();
    let err = s.err(
        "3",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());
}

#[test]
fn sandbox_gone_between_steps_is_not_found_and_never_removed() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let token = step1["confirmation"]["token"].as_str().unwrap().to_string();
    fake.set_ls(EMPTY_LS);
    fake.reset_calls();
    let err = s.err(
        "2",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(err["code"], "NOT_FOUND");
    assert_eq!(fake.calls(), vec![v(&["ls", "--json"])]);
}

#[test]
fn rm_exit_zero_but_still_listed_is_not_reported_as_removed() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    bind_atlas(&mut s, &fake);
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let token = step1["confirmation"]["token"].as_str().unwrap().to_string();
    // No ls.after-rm.json: the re-query still lists the sandbox.
    let err = s.err(
        "2",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(err["code"], "INTERNAL");
    assert_eq!(binding_rows(&s), vec![("atlas-auth".into(), None)]);
}

#[test]
fn rm_failure_is_classified_and_the_binding_stays_in_force() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    bind_atlas(&mut s, &fake);
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let token = step1["confirmation"]["token"].as_str().unwrap().to_string();
    fake.fail("rm", NOT_FOUND_ERR);
    fake.reset_calls();
    let err = s.err(
        "2",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    // Step-2 invariant: once `rm` has run, never VALIDATION_FAILED /
    // CONFLICT / NOT_FOUND (those mean "nothing ran"). sbx's own words stay
    // in details.
    assert_eq!(err["code"], "INTERNAL");
    assert_eq!(
        err["details"]["sbxError"], "sandbox 'atlas-auth' not found",
        "{err}"
    );
    let rms = fake
        .calls()
        .into_iter()
        .filter(|c| c.first().map(String::as_str) == Some("rm"))
        .count();
    assert_eq!(rms, 1);
    assert_eq!(binding_rows(&s), vec![("atlas-auth".into(), None)]);
}

#[test]
fn post_rm_requery_failure_is_internal_and_the_binding_stays_live() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    bind_atlas(&mut s, &fake);
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let token = step1["confirmation"]["token"].as_str().unwrap().to_string();
    // `rm` exits 0, then the re-query prints unparseable output (which
    // `sbx_list` reports as VALIDATION_FAILED on its own).
    fake.ls_after("rm", "this is not json");
    fake.reset_calls();
    let err = s.err(
        "2",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(err["code"], "INTERNAL", "{err}");
    let msg = err["message"].as_str().unwrap();
    assert!(msg.contains("removal is unconfirmed"), "{msg}");
    assert_eq!(
        fake.calls(),
        vec![
            v(&["ls", "--json"]),
            v(&["rm", "--force", "atlas-auth"]),
            v(&["ls", "--json"])
        ],
        "rm ran exactly once"
    );
    assert_eq!(binding_rows(&s), vec![("atlas-auth".into(), None)]);
}

#[test]
fn sandbox_create_agent_is_an_exact_built_in_and_defaults_to_shell() {
    let fake = fake_sbx(EMPTY_LS, None, None);
    let mut s = start_server(fake.locator());
    let project = s.ok(
        "1",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": []}),
    );
    // Kit references and anything else outside the captured built-in list are
    // refused before any exec.
    for bad in [
        "./my-kit",
        "/opt/kits/agent",
        "kit.zip",
        "https://github.com/example/kit.git",
        "docker.io/example/kit:1",
        "oci://example/kit",
        "Shell",
        "",
        "--cloud",
        "shell --cloud",
    ] {
        let err = s.err(
            "2",
            "sandbox.create",
            serde_json::json!({"name": "atlas-kit", "projectId": project["id"],
                               "workspaceMode": "mountless", "agent": bad}),
        );
        assert_eq!(err["code"], "VALIDATION_FAILED", "{bad:?}");
    }
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());

    let created = s.ok(
        "3",
        "sandbox.create",
        serde_json::json!({"name": "atlas-codex", "projectId": project["id"],
                           "workspaceMode": "mountless", "agent": "codex"}),
    );
    // Accepting a provider agent is not a verification claim.
    assert!(created.get("verified").is_none(), "{created}");
    s.ok(
        "4",
        "sandbox.create",
        serde_json::json!({"name": "atlas-default", "projectId": project["id"],
                           "workspaceMode": "mountless"}),
    );
    let creates: Vec<Vec<String>> = fake
        .calls()
        .into_iter()
        .filter(|c| c.first().map(String::as_str) == Some("create"))
        .collect();
    assert_eq!(
        creates,
        vec![
            v(&["create", "--name", "atlas-codex", "codex"]),
            v(&["create", "--name", "atlas-default", "shell"]),
        ]
    );
    assert!(
        fake.calls().iter().flatten().all(|a| a != "--cloud"),
        "--cloud is never passed"
    );
}

// ---------------------------------------------------------------------------
// A1 security follow-up (review W1, W2, I4, I5)
// ---------------------------------------------------------------------------

fn binding_rows_full(s: &TestServer) -> Vec<(String, Option<String>, Option<String>)> {
    let db = s.inner.lock_db();
    let mut stmt = db
        .conn()
        .prepare("SELECT id, sbx_id, removed_at FROM sandbox_bindings ORDER BY rowid")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    rows
}

/// A binding row written the pre-A1 way (no sbx identity).
fn insert_legacy_binding(s: &TestServer, row_id: &str, mode: &str) {
    let db = s.inner.lock_db();
    db.conn()
        .execute_batch(
            "INSERT OR IGNORE INTO projects (id,name,created_at) VALUES ('p-legacy','Nova Demo','t')",
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO sandbox_bindings (id,project_id,sandbox_name,workspace_mode,created_at)
             VALUES (?1,'p-legacy','atlas-auth',?2,'2026-01-01T00:00:00Z')",
            params![row_id, mode],
        )
        .unwrap();
}

fn impact_lines(confirmation: &serde_json::Value) -> Vec<String> {
    confirmation["impact"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn create_records_the_probed_sbx_id_on_the_binding() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    bind_atlas(&mut s, &fake);
    let rows = binding_rows_full(&s);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1.as_deref(), Some(ATLAS_ID));
}

#[test]
fn legacy_binding_without_sbx_id_is_external_with_a_disclosure() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    insert_legacy_binding(&s, "legacy-1", "direct_mount");
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let c = &step1["confirmation"];
    assert_eq!(
        c["external"], true,
        "Core cannot confirm Sandpane created it"
    );
    let impact = impact_lines(c);
    assert!(
        impact.iter().any(|l| l.contains("has no recorded sbx id")),
        "{impact:?}"
    );
    assert!(
        !impact.iter().any(|l| l.contains("workspace mode")),
        "no mode claim without an id-matched binding: {impact:?}"
    );
    // Removing the only sandbox with that name retires the legacy row too.
    fake.ls_after("rm", EMPTY_LS);
    s.ok(
        "2",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": c["token"]}),
    );
    let rows = binding_rows_full(&s);
    assert!(rows[0].2.is_some(), "legacy row marked removed: {rows:?}");
}

#[test]
fn a_binding_for_an_earlier_same_named_sandbox_never_vouches_for_a_replacement() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    bind_atlas(&mut s, &fake);
    // Out of band: the sandbox was removed and recreated under the same name.
    fake.set_ls(&ls_with_atlas(ATLAS_REPLACEMENT_ID, "running"));

    // sandbox.list no longer lends the old binding's mode/project to it.
    let list = s.ok("1", "sandbox.list", serde_json::json!({}));
    let row = &list.as_array().unwrap()[0];
    assert!(row.get("workspaceMode").is_none(), "{row}");
    assert!(row["boundProjectId"].is_null(), "{row}");

    let step1 = s.ok(
        "2",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let c = &step1["confirmation"];
    assert_eq!(c["external"], true);
    assert_eq!(c["target"]["id"], ATLAS_REPLACEMENT_ID);
    let impact = impact_lines(c);
    assert!(
        !impact.iter().any(|l| l.contains("workspace mode")),
        "{impact:?}"
    );
    // Removing the replacement leaves the earlier sandbox's binding alone:
    // only rows bound to the removed sbx id are marked.
    fake.ls_after("rm", EMPTY_LS);
    s.ok(
        "3",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": c["token"]}),
    );
    let rows = binding_rows_full(&s);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1.as_deref(), Some(ATLAS_ID));
    assert_eq!(rows[0].2, None, "{rows:?}");
}

#[test]
fn legacy_binding_still_joins_sandbox_list_by_name() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    insert_legacy_binding(&s, "legacy-1", "direct_mount");
    let list = s.ok("1", "sandbox.list", serde_json::json!({}));
    // Unchanged pre-A1 behaviour for rows with no sbx identity.
    assert_eq!(list[0]["workspaceMode"], "direct_mount");
    assert_eq!(list[0]["boundProjectId"], "p-legacy");
}

#[test]
fn an_operation_in_flight_on_a_name_refuses_create_and_remove_running_nothing() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let project = s.ok(
        "p",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": []}),
    );
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let token = step1["confirmation"]["token"].as_str().unwrap().to_string();
    fake.reset_calls();

    let inner = Arc::clone(&s.inner);
    let guard = inner.sandbox_ops.try_acquire("atlas-auth").unwrap();
    let err = s.err(
        "2",
        "sandbox.create",
        serde_json::json!({"name": "atlas-auth", "projectId": project["id"], "workspaceMode": "mountless"}),
    );
    assert_eq!(err["code"], "CONFLICT");
    assert!(
        err["message"].as_str().unwrap().contains("in progress"),
        "{err}"
    );
    let err = s.err(
        "3",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(err["code"], "CONFLICT");
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());
    // Another name is unaffected.
    s.ok(
        "4",
        "sandbox.create",
        serde_json::json!({"name": "nova-search", "projectId": project["id"], "workspaceMode": "mountless"}),
    );
    drop(guard);
    // The refused attempt still consumed the token (every attempt burns it).
    let err = s.err(
        "5",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED");
    assert!(!s.inner.sandbox_ops.is_held("atlas-auth"));
}

#[test]
fn removal_marks_only_the_binding_rows_captured_before_rm() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    bind_atlas(&mut s, &fake);
    let step1 = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    let token = step1["confirmation"]["token"].as_str().unwrap().to_string();
    fake.ls_after("rm", EMPTY_LS);
    std::fs::write(fake.dir.path().join("rm.sleep"), "").unwrap();
    fake.reset_calls();

    let inner = Arc::clone(&s.inner);
    let worker = std::thread::spawn(move || {
        let out = s.ok(
            "2",
            "sandbox.remove",
            serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
        );
        (s, out)
    });
    // Wait until `rm` is running, then write a row the way an out-of-lock
    // writer would. The DB mutex must be free while the subprocess runs.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !fake
        .calls()
        .iter()
        .any(|c| c.first().map(String::as_str) == Some("rm"))
    {
        assert!(Instant::now() < deadline, "rm never started");
        std::thread::sleep(Duration::from_millis(10));
    }
    {
        let db = inner.lock_db();
        db.conn()
            .execute(
                "INSERT INTO sandbox_bindings (id,project_id,sandbox_name,workspace_mode,created_at,sbx_id)
                 SELECT 'late-row', project_id, 'atlas-auth', 'mountless', '2099-01-01T00:00:00Z', ?1
                 FROM sandbox_bindings LIMIT 1",
                params![ATLAS_REPLACEMENT_ID],
            )
            .unwrap();
    }
    let (s, out) = worker.join().unwrap();
    assert_eq!(out, serde_json::json!({"removed": true}));
    let rows = binding_rows_full(&s);
    assert_eq!(rows.len(), 2);
    assert!(rows[0].2.is_some(), "captured row marked: {rows:?}");
    assert_eq!(rows[1].0, "late-row");
    assert_eq!(rows[1].2, None, "row inserted after the capture untouched");
}

#[test]
fn sbx_id_with_a_newline_is_refused_fail_closed() {
    let fake = fake_sbx(
        r#"{"sandboxes":[{"name":"atlas-auth","id":"b5ebec73\nforged","agent":"shell","status":"running"}]}"#,
        None,
        None,
    );
    let mut s = start_server(fake.locator());
    let err = s.err(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    );
    assert_eq!(err["code"], "INTERNAL");
    assert!(
        err["message"].as_str().unwrap().contains("no usable id"),
        "{err}"
    );
    assert!(!err.to_string().contains("forged"), "never relayed: {err}");
    assert!(s.inner.lock_confirmations().is_empty());
}

#[test]
fn a_spoofing_agent_string_from_sbx_is_dropped_from_summaries() {
    let fake = fake_sbx(
        r#"{"sandboxes":[{"name":"atlas-auth","id":"b5ebec73-e2ae-471a-811a-e011cfb1948e","agent":"shell\n(verified by Sandpane)","status":"running"},{"name":"nova-search","id":"c5ebec73-e2ae-471a-811a-e011cfb1948e","agent":"docker-agent","status":"stopped"}]}"#,
        None,
        None,
    );
    let mut s = start_server(fake.locator());
    let list = s.ok("1", "sandbox.list", serde_json::json!({}));
    assert!(list[0].get("agent").is_none(), "{}", list[0]);
    assert_eq!(list[1]["agent"], "docker-agent");
}

// ---------------------------------------------------------------------------
// A2: idempotency keys (design 2026-10-09 §3.1)
// ---------------------------------------------------------------------------

const MSG_MISMATCH: &str =
    "idempotency key was already used with different parameters; nothing was run";
const MSG_PENDING: &str =
    "an operation with this idempotency key is still in progress; nothing was run";
const MSG_UNKNOWN: &str = "the outcome of the earlier request with this idempotency key is unknown (Core restarted or sbx failed while it ran); re-read state before retrying with a new key";

/// Fingerprint exactly as Core computes it: the TYPED params with the key
/// removed.
fn create_hash(params: &serde_json::Value) -> String {
    let mut spec: SandboxCreateSpec = serde_json::from_value(params.clone()).unwrap();
    spec.idempotency_key = None;
    idempotency::fingerprint(&spec).unwrap()
}

fn send_hash(params: &serde_json::Value) -> String {
    let mut p: ConversationSendParams = serde_json::from_value(params.clone()).unwrap();
    p.idempotency_key = None;
    idempotency::fingerprint(&p).unwrap()
}

/// A replay is the first response plus `replayed: true` (review W1).
fn assert_is_replay_of(replay: &serde_json::Value, first: &serde_json::Value) {
    assert!(
        first.get("replayed").is_none(),
        "first response is never marked: {first}"
    );
    assert_eq!(replay["replayed"], true, "{replay}");
    let mut stripped = replay.clone();
    stripped.as_object_mut().unwrap().remove("replayed");
    assert_eq!(&stripped, first, "otherwise the FIRST response, unchanged");
}

fn key_rows(s: &TestServer) -> Vec<(String, String, String)> {
    let db = s.inner.lock_db();
    let mut stmt = db
        .conn()
        .prepare("SELECT method, key, state FROM idempotency_keys ORDER BY rowid")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    rows
}

/// Row counts of everything a `conversation.send` writes.
fn write_counts(s: &TestServer) -> [i64; 4] {
    let db = s.inner.lock_db();
    let n = |t: &str| -> i64 {
        db.conn()
            .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
            .unwrap()
    };
    [
        n("messages"),
        n("tasks"),
        n("task_events"),
        n("idempotency_keys"),
    ]
}

fn create_calls(fake: &FakeSbx) -> usize {
    fake.calls()
        .iter()
        .filter(|c| c.first().map(String::as_str) == Some("create"))
        .count()
}

fn new_project(s: &mut TestServer) -> String {
    let p = s.ok(
        "proj",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": []}),
    );
    p["id"].as_str().unwrap().to_string()
}

#[test]
fn features_are_advertised_from_the_single_const_list() {
    let mut s = start_server(no_sbx());
    let caps = s.ok("1", "system.probe", serde_json::json!({}));
    assert_eq!(
        caps["features"],
        serde_json::json!(sandpane_protocol::FEATURES.to_vec())
    );
    assert_eq!(
        caps["features"],
        serde_json::json!([
            "idempotency-keys",
            "sandbox-create-agent",
            "conversation-sandbox-id",
            "conversation-send-mode"
        ])
    );
}

/// INVARIANT under test: a replay never runs sbx (the argv log gains no
/// line) and returns the stored result.
#[test]
fn keyed_create_replay_returns_the_stored_result_and_runs_sbx_once() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let project = new_project(&mut s);
    let params = serde_json::json!({"name": "atlas-auth", "projectId": project,
        "workspaceMode": "mountless", "idempotencyKey": "create-key-1"});
    let first = s.ok("1", "sandbox.create", params.clone());
    assert_eq!(first["probedState"], "running");
    let calls_after_first = fake.calls();
    assert_eq!(create_calls(&fake), 1);
    let replay = s.ok("2", "sandbox.create", params);
    assert_is_replay_of(&replay, &first);
    assert_eq!(fake.calls(), calls_after_first, "replay ran nothing");
    assert_eq!(
        key_rows(&s),
        vec![(
            "sandbox.create".into(),
            "create-key-1".into(),
            "done".into()
        )]
    );
    // One binding, not two.
    assert_eq!(binding_rows(&s).len(), 1);
}

#[test]
fn keyed_send_replay_returns_the_same_task_and_writes_nothing() {
    let mut s = start_server(no_sbx());
    let (_p, conv) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    let params = serde_json::json!({"conversationId": conv, "content": "add tests",
        "idempotencyKey": "send-key-1"});
    let first = s.ok("1", "conversation.send", params.clone());
    let task_id = first["id"].as_str().unwrap().to_string();
    let counts = write_counts(&s);
    assert_eq!(counts[3], 1, "the key row was written with the task");
    let replay = s.ok("2", "conversation.send", params);
    assert_is_replay_of(&replay, &first);
    assert_eq!(replay["id"], task_id.as_str());
    assert_eq!(write_counts(&s), counts, "no second message/task/event/key");
}

#[test]
fn same_key_with_different_params_is_conflict_and_runs_nothing() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let project = new_project(&mut s);
    s.ok(
        "1",
        "sandbox.create",
        serde_json::json!({"name": "atlas-auth", "projectId": project,
            "workspaceMode": "mountless", "idempotencyKey": "k"}),
    );
    let calls = fake.calls();
    let err = s.err(
        "2",
        "sandbox.create",
        serde_json::json!({"name": "atlas-other", "projectId": project,
            "workspaceMode": "mountless", "idempotencyKey": "k"}),
    );
    assert_eq!(err["code"], "CONFLICT");
    assert_eq!(err["message"], MSG_MISMATCH);
    assert_eq!(fake.calls(), calls);

    let (_p, conv) = make_project_and_conversation(&mut s, "Nova Demo", vec![]);
    s.ok(
        "3",
        "conversation.send",
        serde_json::json!({"conversationId": conv, "content": "one", "idempotencyKey": "k"}),
    );
    let counts = write_counts(&s);
    let err = s.err(
        "4",
        "conversation.send",
        serde_json::json!({"conversationId": conv, "content": "two", "idempotencyKey": "k"}),
    );
    assert_eq!(err["code"], "CONFLICT");
    assert_eq!(err["message"], MSG_MISMATCH);
    assert_eq!(write_counts(&s), counts);
}

#[test]
fn a_pending_key_is_conflict_in_progress_and_runs_nothing() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let project = new_project(&mut s);
    let params = serde_json::json!({"name": "atlas-auth", "projectId": project,
        "workspaceMode": "mountless", "idempotencyKey": "busy"});
    {
        let db = s.inner.lock_db();
        assert!(idempotency::claim(
            db.conn(),
            "sandbox.create",
            "busy",
            &create_hash(&params),
            "2099-01-01T00:00:00Z"
        )
        .unwrap());
    }
    fake.reset_calls();
    let err = s.err("1", "sandbox.create", params);
    assert_eq!(err["code"], "CONFLICT");
    assert_eq!(err["message"], MSG_PENDING);
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());
}

#[test]
fn restart_turns_a_pending_key_unknown_before_serving_and_it_is_refused() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("core.sqlite3");
    let project_id = "p-restart";
    let params = serde_json::json!({"name": "atlas-auth", "projectId": project_id,
        "workspaceMode": "mountless", "idempotencyKey": "mid-flight"});
    {
        // A previous Core died between claim and completion.
        let db = Database::open(&db_path).unwrap();
        db.conn()
            .execute(
                "INSERT INTO projects (id,name,created_at) VALUES (?1,'Atlas Demo','t')",
                params![project_id],
            )
            .unwrap();
        assert!(idempotency::claim(
            db.conn(),
            "sandbox.create",
            "mid-flight",
            &create_hash(&params),
            "2099-01-01T00:00:00Z"
        )
        .unwrap());
        // And an expired row that the startup prune must drop.
        assert!(idempotency::insert_done(
            db.conn(),
            "sandbox.create",
            "ancient",
            "h",
            "{}",
            "2000-01-01T00:00:00Z"
        )
        .unwrap());
    }
    let mut s = start_server_at(fake.locator(), dir, db_path);
    // Production startup already reconciled — before any frame is served.
    assert_eq!(
        key_rows(&s),
        vec![(
            "sandbox.create".into(),
            "mid-flight".into(),
            "unknown".into()
        )]
    );
    let err = s.err("1", "sandbox.create", params);
    assert_eq!(err["code"], "CONFLICT");
    assert_eq!(err["message"], MSG_UNKNOWN);
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());
}

#[test]
fn a_failure_before_sbx_runs_frees_the_key() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let project = new_project(&mut s);
    let params = serde_json::json!({"name": "atlas-auth", "projectId": project,
        "workspaceMode": "mountless", "idempotencyKey": "retry-me"});
    // sbx not installed (not executable): fails before anything runs.
    let bin = fake.dir.path().join("sbx");
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
    let err = s.err("1", "sandbox.create", params.clone());
    assert_eq!(err["code"], "NOT_INSTALLED");
    assert!(key_rows(&s).is_empty(), "claim deleted: key reusable");
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    s.ok("2", "sandbox.create", params);
    assert_eq!(create_calls(&fake), 1);
    assert_eq!(key_rows(&s)[0].2, "done");
}

#[test]
fn a_failure_after_sbx_started_marks_the_key_unknown_and_refuses_retry() {
    let fake = fake_sbx(
        &ls_with_atlas(ATLAS_ID, "running"),
        Some("error: global network policy has not been initialized\n  try: sbx policy init <allow-all|balanced|deny-all>"),
        None,
    );
    let mut s = start_server(fake.locator());
    let project = new_project(&mut s);
    let params = serde_json::json!({"name": "atlas-auth", "projectId": project,
        "workspaceMode": "mountless", "idempotencyKey": "maybe-made"});
    let err = s.err("1", "sandbox.create", params.clone());
    assert_eq!(
        err["code"], "PERMISSION_DENIED",
        "sbx's own classified error"
    );
    assert_eq!(key_rows(&s)[0].2, "unknown");
    let calls = fake.calls();
    let err = s.err("2", "sandbox.create", params);
    assert_eq!(err["code"], "CONFLICT");
    assert_eq!(err["message"], MSG_UNKNOWN);
    assert_eq!(fake.calls(), calls, "never run twice");
    assert_eq!(create_calls(&fake), 1);
}

#[test]
fn keys_are_namespaced_by_method() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let (project, conv) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    s.ok(
        "1",
        "sandbox.create",
        serde_json::json!({"name": "atlas-auth", "projectId": project,
            "workspaceMode": "mountless", "idempotencyKey": "shared"}),
    );
    s.ok(
        "2",
        "conversation.send",
        serde_json::json!({"conversationId": conv, "content": "hi", "idempotencyKey": "shared"}),
    );
    assert_eq!(
        key_rows(&s),
        vec![
            ("sandbox.create".into(), "shared".into(), "done".into()),
            ("conversation.send".into(), "shared".into(), "done".into()),
        ]
    );
}

#[test]
fn retention_prunes_expired_and_over_cap_rows_but_never_pending() {
    let mut s = start_server(no_sbx());
    let (_p, conv) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    {
        let db = s.inner.lock_db();
        let tx = db.conn().unchecked_transaction().unwrap();
        idempotency::insert_done(
            &tx,
            "conversation.send",
            "expired",
            "h",
            "{}",
            "2000-01-01T00:00:00Z",
        )
        .unwrap();
        idempotency::claim(
            &tx,
            "sandbox.create",
            "old-pending",
            "h",
            "2000-01-01T00:00:01Z",
        )
        .unwrap();
        // Fill to the cap with recent rows.
        for i in 0..idempotency::MAX_ROWS {
            idempotency::insert_done(
                &tx,
                "conversation.send",
                &format!("filler-{i:05}"),
                "h",
                "{}",
                &format!("2099-01-01T00:{:02}:{:02}Z", (i / 60) % 60, i % 60),
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }
    s.ok(
        "1",
        "conversation.send",
        serde_json::json!({"conversationId": conv, "content": "hi", "idempotencyKey": "fresh"}),
    );
    let db = s.inner.lock_db();
    let count = |sql: &str| -> i64 { db.conn().query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(
        count("SELECT COUNT(*) FROM idempotency_keys WHERE key='expired'"),
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM idempotency_keys WHERE key='old-pending' AND state='pending'"),
        1,
        "pending is never pruned while Core runs"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM idempotency_keys WHERE key='fresh'"),
        1
    );
    assert!(
        count("SELECT COUNT(*) FROM idempotency_keys") <= idempotency::MAX_ROWS as i64,
        "cap enforced"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM idempotency_keys WHERE key='filler-00000'"),
        0,
        "oldest done row went first"
    );
}

#[test]
fn invalid_keys_are_refused_before_anything_runs() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let (project, conv) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    let counts = write_counts(&s);
    let long = "a".repeat(129);
    for bad in ["", "has space", "a/b", "ünï", long.as_str()] {
        let err = s.err(
            "1",
            "sandbox.create",
            serde_json::json!({"name": "atlas-auth", "projectId": project,
                "workspaceMode": "mountless", "idempotencyKey": bad}),
        );
        assert_eq!(err["code"], "VALIDATION_FAILED", "{bad:?}");
        let err = s.err(
            "2",
            "conversation.send",
            serde_json::json!({"conversationId": conv, "content": "hi", "idempotencyKey": bad}),
        );
        assert_eq!(err["code"], "VALIDATION_FAILED", "{bad:?}");
    }
    assert!(fake.calls().is_empty(), "{:?}", fake.calls());
    assert_eq!(write_counts(&s), counts);
}

#[test]
fn absent_key_behaves_as_before_and_writes_no_key_row() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let (project, conv) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    let params = serde_json::json!({"name": "atlas-auth", "projectId": project, "workspaceMode": "mountless"});
    s.ok("1", "sandbox.create", params.clone());
    s.ok("2", "sandbox.create", params);
    assert_eq!(create_calls(&fake), 2, "no key, no replay protection");
    let a = s.ok(
        "3",
        "conversation.send",
        serde_json::json!({"conversationId": conv, "content": "x"}),
    );
    let b = s.ok(
        "4",
        "conversation.send",
        serde_json::json!({"conversationId": conv, "content": "x"}),
    );
    assert_ne!(a["id"], b["id"]);
    assert!(key_rows(&s).is_empty());
}

#[test]
fn fingerprints_used_by_tests_match_core() {
    // Guard for the helpers above: the key is excluded from the fingerprint.
    let a = serde_json::json!({"conversationId": "c", "content": "x", "idempotencyKey": "k1"});
    let b = serde_json::json!({"conversationId": "c", "content": "x", "idempotencyKey": "k2"});
    assert_eq!(send_hash(&a), send_hash(&b));
}

/// §3.1 item 7, timeout branch: a keyed create killed at its deadline is
/// `done` when the re-query finds the sandbox (bound, replayable) and
/// `unknown` when it does not — sbx may still have made it, so that key is
/// never run again.
#[test]
fn keyed_create_timeout_is_done_when_found_and_unknown_when_not() {
    use sandpane_core::process::RunLimits;
    use sandpane_service::SbxLimits;
    let fast = SbxLimits {
        mutation: RunLimits {
            timeout: Duration::from_millis(300),
            ..RunLimits::MUTATION
        },
        ..SbxLimits::default()
    };
    let fake = fake_sbx(
        r#"{"sandboxes":[{"name":"atlas-slow","id":"a1b2","status":"running"}]}"#,
        None,
        None,
    );
    std::fs::write(fake.dir.path().join("create.sleep"), "").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("t.sqlite3")).unwrap();
    let inner = ServerInner::with_sbx_limits(db, fake.locator(), fast);
    let mut s = serve_inner(inner, dir);
    let project = new_project(&mut s);
    let call = |s: &mut TestServer, name: &str, key: &str| {
        s.rpc(
            "c",
            "sandbox.create",
            serde_json::json!({"name": name, "projectId": project,
                "workspaceMode": "mountless", "idempotencyKey": key}),
        )
    };
    let found = call(&mut s, "atlas-slow", "slow-found");
    assert_eq!(found["ok"]["probedState"], "running", "{found}");
    let missing = call(&mut s, "atlas-missing", "slow-missing");
    assert_eq!(missing["err"]["code"], "INTERNAL", "{missing}");
    assert_eq!(
        key_rows(&s),
        vec![
            ("sandbox.create".into(), "slow-found".into(), "done".into()),
            (
                "sandbox.create".into(),
                "slow-missing".into(),
                "unknown".into()
            ),
        ]
    );
    let calls = fake.calls();
    let replay = call(&mut s, "atlas-slow", "slow-found");
    assert_is_replay_of(&replay["ok"], &found["ok"]);
    let retry = call(&mut s, "atlas-missing", "slow-missing");
    assert_eq!(retry["err"]["code"], "CONFLICT");
    assert_eq!(retry["err"]["message"], MSG_UNKNOWN);
    assert_eq!(fake.calls(), calls, "neither replay ran sbx");
}

// ---------------------------------------------------------------------------
// A2 security follow-up (review W1, W3, I4 + disclosed untested paths)
// ---------------------------------------------------------------------------

/// The stored result is the FIRST response without the replay marker.
#[test]
fn stored_result_never_contains_the_replay_marker() {
    let mut s = start_server(no_sbx());
    let (_p, conv) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    let params = serde_json::json!({"conversationId": conv, "content": "x", "idempotencyKey": "m"});
    s.ok("1", "conversation.send", params.clone());
    s.ok("2", "conversation.send", params);
    let stored: String = s
        .inner
        .lock_db()
        .conn()
        .query_row("SELECT result_json FROM idempotency_keys", [], |r| r.get(0))
        .unwrap();
    assert!(!stored.contains("replayed"), "{stored}");
}

/// (a) Two clients send the same keyed message at the same moment: exactly
/// one task and one message exist afterwards; each caller gets the task (the
/// loser as a replay) or a CONFLICT — never a second task.
#[test]
fn concurrent_same_key_sends_create_exactly_one_task() {
    let mut s = start_server(no_sbx());
    let (_p, conv) = make_project_and_conversation(&mut s, "Atlas Demo", vec![]);
    let before = write_counts(&s);
    let frame = serde_json::json!({"v":1,"id":"r","method":"conversation.send",
        "params":{"conversationId": conv, "content": "race", "idempotencyKey": "race-key"}})
    .to_string();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let inner = Arc::clone(&s.inner);
            let barrier = Arc::clone(&barrier);
            let frame = frame.clone();
            std::thread::spawn(move || {
                barrier.wait();
                serde_json::from_str::<serde_json::Value>(&sandpane_service::handle_line(
                    &inner, &frame,
                ))
                .unwrap()
            })
        })
        .collect();
    let out: Vec<serde_json::Value> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let after = write_counts(&s);
    assert_eq!(after[0] - before[0], 1, "one message row");
    assert_eq!(after[1] - before[1], 1, "one task row");
    assert_eq!(after[3] - before[3], 1, "one key row");
    let oks: Vec<&serde_json::Value> = out.iter().filter_map(|o| o.get("ok")).collect();
    assert!(!oks.is_empty(), "{out:?}");
    for o in &oks {
        assert_eq!(o["id"], oks[0]["id"], "same task for every success");
    }
    // W1 on the race-loser path: exactly one FIRST response (no marker);
    // any other success is a replay.
    let firsts = oks.iter().filter(|o| o.get("replayed").is_none()).count();
    assert_eq!(firsts, 1, "{out:?}");
    for o in oks.iter().filter(|o| o.get("replayed").is_some()) {
        assert_eq!(o["replayed"], true, "{o}");
    }
    for o in out.iter().filter_map(|o| o.get("err")) {
        assert_eq!(o["code"], "CONFLICT", "{o}");
    }
}

/// (b) `sbx` was located but could not be started (here: a bad interpreter
/// line): nothing ran, so the claim is released and the key is reusable.
#[test]
fn spawn_failure_releases_the_key() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let project = new_project(&mut s);
    let bin = fake.dir.path().join("sbx");
    std::fs::write(&bin, "#!/nonexistent/sandpane-test-interpreter\n").unwrap();
    let params = serde_json::json!({"name": "atlas-auth", "projectId": project,
        "workspaceMode": "mountless", "idempotencyKey": "spawn-fail"});
    let err = s.err("1", "sandbox.create", params.clone());
    assert_eq!(err["code"], "INTERNAL", "{err}");
    assert!(
        err["message"].as_str().unwrap().contains("could not start"),
        "{err}"
    );
    assert!(key_rows(&s).is_empty(), "claim released");
    std::fs::write(&bin, FAKE_SBX_SCRIPT).unwrap();
    s.ok("2", "sandbox.create", params);
    assert_eq!(create_calls(&fake), 1);
}

/// (c) Startup retention also enforces the row cap.
#[test]
fn startup_prune_enforces_the_row_cap() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("core.sqlite3");
    {
        let db = Database::open(&db_path).unwrap();
        let tx = db.conn().unchecked_transaction().unwrap();
        for i in 0..idempotency::MAX_ROWS + 5 {
            idempotency::insert_done(
                &tx,
                "conversation.send",
                &format!("k-{i:05}"),
                "h",
                "{}",
                &format!(
                    "2099-01-01T{:02}:{:02}:{:02}Z",
                    i / 3600,
                    (i / 60) % 60,
                    i % 60
                ),
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }
    let s = start_server_at(no_sbx(), dir, db_path);
    let db = s.inner.lock_db();
    let count = |sql: &str| -> i64 { db.conn().query_row(sql, [], |r| r.get(0)).unwrap() };
    assert!(count("SELECT COUNT(*) FROM idempotency_keys") < idempotency::MAX_ROWS as i64);
    assert_eq!(
        count("SELECT COUNT(*) FROM idempotency_keys WHERE key='k-00000'"),
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM idempotency_keys WHERE key='k-10004'"),
        1,
        "newest kept"
    );
}

/// A DB whose reconciliation UPDATEs are blocked by triggers (the stand-in
/// for an I/O or corruption failure). `which` = "keys" or "tasks".
fn db_with_blocked_reconciliation(path: &Path, which: &str) {
    let db = Database::open(path).unwrap();
    let c = db.conn();
    match which {
        "keys" => {
            idempotency::claim(c, "sandbox.create", "stuck", "h", "2099-01-01T00:00:00Z").unwrap();
            c.execute_batch(
                "CREATE TRIGGER block_keys BEFORE UPDATE ON idempotency_keys
                 BEGIN SELECT RAISE(ABORT, 'test: reconciliation blocked'); END;",
            )
            .unwrap();
        }
        _ => {
            c.execute_batch(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
                 INSERT INTO conversations (id,project_id,agent_id,created_at) VALUES ('c1','p1','codex','t');
                 INSERT INTO tasks (id,conversation_id,status,created_at,updated_at) VALUES ('t1','c1','running','t','t');
                 CREATE TRIGGER block_tasks BEFORE UPDATE ON tasks
                 BEGIN SELECT RAISE(ABORT, 'test: reconciliation blocked'); END;",
            )
            .unwrap();
        }
    }
}

/// W3: Core must not serve with unreconciled state — the library refuses.
#[test]
fn startup_fails_closed_when_reconciliation_fails() {
    for which in ["keys", "tasks"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite3");
        db_with_blocked_reconciliation(&path, which);
        let db = Database::open(&path).unwrap();
        let r = ServerInner::try_with_config(db, no_sbx(), CoreConfig::default());
        let err = match r {
            Ok(_) => panic!("{which}: Core started with unreconciled state"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("reconcil"), "{which}: {err}");
    }
}

/// W3, production binary: it exits non-zero with a clear stderr line and
/// never serves. sbx is pointed at a nonexistent path, so nothing executes.
#[test]
fn service_binary_refuses_to_serve_when_reconciliation_fails() {
    for which in ["keys", "tasks"] {
        let dir = tempfile::tempdir().unwrap();
        let run_dir = dir.path().join("run");
        std::fs::create_dir(&run_dir).unwrap();
        std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let db_path = dir.path().join("core.sqlite3");
        db_with_blocked_reconciliation(&db_path, which);
        let socket = run_dir.join("core.sock");
        let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_sandpane-service"))
            .env("HOME", dir.path())
            .env("XDG_STATE_HOME", dir.path().join("state"))
            .env("SANDPANE_DB", &db_path)
            .env("SANDPANE_SOCKET", &socket)
            .env("SANDPANE_SBX_PATH", dir.path().join("no-such-sbx"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(st) = child.try_wait().unwrap() {
                break st;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                panic!("{which}: service kept running with unreconciled state");
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let mut stderr = String::new();
        std::io::Read::read_to_string(&mut child.stderr.take().unwrap(), &mut stderr).unwrap();
        assert_eq!(status.code(), Some(1), "{which}: {stderr}");
        assert!(stderr.contains("refusing to start"), "{which}: {stderr}");
        assert!(stderr.contains("reconcil"), "{which}: {stderr}");
        assert!(!socket.exists(), "{which}: no socket left to connect to");
    }
}

// ---------------------------------------------------------------------------
// A3a (design §3.2): sbx-backed project lifecycle paths
// ---------------------------------------------------------------------------

const MSG_PROJECT_ARCHIVED: &str = "project is archived; unarchive it first; nothing was changed";
const MSG_CREATE_IN_FLIGHT: &str =
    "a sandbox is being created for this project; try again when it finishes; nothing was deleted";

/// `sandbox.create` on an archived project is refused before sbx runs and
/// before any key is claimed; a keyed replay of a create that finished
/// before archiving is still answered from its stored result.
#[test]
fn sandbox_create_on_an_archived_project_runs_nothing() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let project = new_project(&mut s);
    let done = serde_json::json!({"name": "atlas-auth", "projectId": project,
        "workspaceMode": "mountless", "idempotencyKey": "before"});
    let first = s.ok("1", "sandbox.create", done.clone());
    s.ok(
        "2",
        "project.archive",
        serde_json::json!({"projectId": project}),
    );
    fake.reset_calls();
    let replay = s.ok("3", "sandbox.create", done);
    assert_eq!(replay["replayed"], true, "{replay}");
    assert_eq!(replay["name"], first["name"]);
    for (id, params) in [
        (
            "4",
            serde_json::json!({"name": "nova-search", "projectId": project, "workspaceMode": "mountless"}),
        ),
        (
            "5",
            serde_json::json!({"name": "nova-search", "projectId": project,
                "workspaceMode": "mountless", "idempotencyKey": "after"}),
        ),
    ] {
        let e = s.err(id, "sandbox.create", params);
        assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
        assert_eq!(e["message"], MSG_PROJECT_ARCHIVED);
    }
    assert!(fake.calls().is_empty(), "sbx never ran: {:?}", fake.calls());
    assert_eq!(
        key_rows(&s),
        vec![(
            "sandbox.create".to_string(),
            "before".to_string(),
            "done".to_string()
        )],
        "the refused key was never claimed"
    );
}

/// The in-flight guard (§3.2 item 4): while `sbx create` runs for a
/// project, `project.delete` refuses at step 1 AND step 2 with CONFLICT and
/// deletes nothing; archive is not blocked; once the create finished, delete
/// is refused for the live binding as usual.
#[test]
fn project_delete_refuses_while_a_sandbox_create_is_in_flight() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let project = new_project(&mut s);
    let pid = serde_json::json!({"projectId": project});
    // A token issued while nothing is in flight.
    let early = s.ok("t", "project.delete", pid.clone())["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    std::fs::write(fake.dir.path().join("create.sleep"), "").unwrap();
    let inner = Arc::clone(&s.inner);
    let frame = serde_json::json!({"v":1,"id":"c","method":"sandbox.create",
        "params":{"name":"atlas-auth","projectId": project,"workspaceMode":"mountless"}})
    .to_string();
    let creator = std::thread::spawn(move || {
        serde_json::from_str::<serde_json::Value>(&sandpane_service::handle_line(&inner, &frame))
            .unwrap()
    });
    // Wait until the stand-in is really executing `create`.
    let deadline = Instant::now() + Duration::from_secs(4);
    while create_calls(&fake) == 0 {
        assert!(Instant::now() < deadline, "create never started");
        std::thread::sleep(Duration::from_millis(20));
    }
    let before = write_counts(&s);
    let e = s.err("1", "project.delete", pid.clone());
    assert_eq!(e["code"], "CONFLICT", "{e}");
    assert_eq!(e["message"], MSG_CREATE_IN_FLIGHT);
    let e = s.err(
        "2",
        "project.delete",
        serde_json::json!({"projectId": project, "confirmToken": early}),
    );
    assert_eq!(e["code"], "CONFLICT", "{e}");
    assert_eq!(e["message"], MSG_CREATE_IN_FLIGHT);
    // Archive is reversible and not blocked.
    s.ok("3", "project.archive", pid.clone());
    s.ok("4", "project.unarchive", pid.clone());
    assert_eq!(write_counts(&s), before);
    assert!(std::fs::metadata(fake.dir.path().join("create.sleep")).is_ok());
    let created = creator.join().unwrap();
    assert!(
        created.get("ok").is_some(),
        "the create completed: {created}"
    );
    assert_eq!(binding_rows(&s).len(), 1, "bound to the surviving project");
    let e = s.err("5", "project.delete", pid);
    assert_eq!(e["code"], "CONFLICT");
    assert_eq!(
        e["message"],
        "project has sandboxes; remove them first; nothing was deleted"
    );
}

/// A `sandbox.remove` token is not a `project.delete` token (wrong action):
/// refused with the uniform message, burned, and nothing is deleted or run.
#[test]
fn a_sandbox_remove_token_never_deletes_a_project() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let project = new_project(&mut s);
    let token = s.ok(
        "1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    )["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let e = s.err(
        "2",
        "project.delete",
        serde_json::json!({"projectId": project, "confirmToken": token}),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
    assert_eq!(
        e["message"],
        sandpane_service::confirm::TOKEN_REJECTED_MESSAGE
    );
    let listed = s.ok("3", "project.list", serde_json::json!({}));
    assert_eq!(listed[0]["id"], project.as_str(), "not deleted");
    let e = s.err(
        "4",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    assert_eq!(
        e["code"], "VALIDATION_FAILED",
        "burned by the wrong-action attempt"
    );
    assert!(
        fake.calls()
            .iter()
            .all(|c| c.first().map(String::as_str) != Some("rm")),
        "rm never ran: {:?}",
        fake.calls()
    );
}

// ---------------------------------------------------------------------------
// A3a security review C1 / W1: post-claim re-check and repository bindings
// ---------------------------------------------------------------------------

const MSG_REPO_IN_USE: &str =
    "repository is used by a task or sandbox of this project; nothing was removed";
const MSG_REMOVE_WHILE_CREATING: &str =
    "a sandbox is being created for this project; try again when it finishes; nothing was removed";
const MSG_REPO_UNREGISTERED_DURING_CREATE: &str = "the repository was unregistered from this \
     project while the sandbox was being prepared; nothing was run";

/// A server whose `sandbox.create` calls `hook` right after its key claim
/// commits and before the in-flight guard — the window in which a
/// concurrent archive / delete / remove_repository can land. `slot` carries
/// values the hook needs once the test has created them (project id, path).
fn server_with_claim_hook(
    fake: &FakeSbx,
    slot: Arc<std::sync::Mutex<Vec<String>>>,
    hook: fn(&ServerInner, &[String]),
) -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("t.sqlite3")).unwrap();
    let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let inner = ServerInner::with_config(
        db,
        fake.locator(),
        CoreConfig {
            test_after_create_claim: Some(sandpane_service::CreateClaimHook(Arc::new(
                move |inner: &ServerInner| {
                    if !fired.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        let values = slot.lock().unwrap().clone();
                        hook(inner, &values);
                    }
                },
            ))),
            ..CoreConfig::default()
        },
    );
    serve_inner(inner, dir)
}

/// Run one frame on a worker thread; panic if Core does not answer within
/// `secs` (a self-deadlock wedges every later request).
fn call_with_timeout(
    inner: &Arc<ServerInner>,
    frame: serde_json::Value,
    secs: u64,
) -> serde_json::Value {
    let (tx, rx) = std::sync::mpsc::channel();
    let inner = Arc::clone(inner);
    let line = frame.to_string();
    std::thread::spawn(move || {
        let out = sandpane_service::handle_line(&inner, &line);
        let _ = tx.send(out);
    });
    let out = rx
        .recv_timeout(Duration::from_secs(secs))
        .unwrap_or_else(|_| panic!("Core did not answer within {secs}s: deadlocked"));
    println!(">> {frame}\n<< {out}");
    serde_json::from_str(&out).unwrap()
}

fn hook_rpc(inner: &ServerInner, method: &str, params: serde_json::Value) -> serde_json::Value {
    let frame = serde_json::json!({"v":1,"id":"hook","method":method,"params":params});
    let out = sandpane_service::handle_line(inner, &frame.to_string());
    println!("(hook) >> {frame}\n(hook) << {out}");
    serde_json::from_str(&out).unwrap()
}

/// Drive a keyed create whose post-claim re-check fails, assert the outcome,
/// that sbx never ran, that the key was released, and that Core still answers.
fn assert_recheck_refuses(
    hook: fn(&ServerInner, &[String]),
    mode: &str,
    expect_code: &str,
    expect_message: &str,
) {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let slot = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut s = server_with_claim_hook(&fake, Arc::clone(&slot), hook);
    let (_repo_dir, repo) = git_repo();
    let p = s.ok(
        "p",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo]}),
    );
    let pid = p["id"].as_str().unwrap().to_string();
    *slot.lock().unwrap() = vec![pid.clone(), repo.clone()];
    let mut params = serde_json::json!({"name": "atlas-auth", "projectId": pid,
        "workspaceMode": mode, "idempotencyKey": "recheck"});
    if mode != "mountless" {
        params["repoPath"] = serde_json::json!(repo);
    }
    let resp = call_with_timeout(
        &s.inner,
        serde_json::json!({"v":1,"id":"c","method":"sandbox.create","params": params}),
        10,
    );
    assert_eq!(resp["err"]["code"], expect_code, "{resp}");
    assert_eq!(resp["err"]["message"], expect_message, "{resp}");
    assert_eq!(create_calls(&fake), 0, "sbx never ran: {:?}", fake.calls());
    assert!(
        key_rows(&s).is_empty(),
        "claim released: {:?}",
        key_rows(&s)
    );
    // Core is not wedged: a follow-up request is answered promptly.
    let probe = call_with_timeout(
        &s.inner,
        serde_json::json!({"v":1,"id":"f","method":"project.list","params":{"includeArchived": true}}),
        10,
    );
    assert!(probe.get("ok").is_some(), "{probe}");
}

fn hook_archive(inner: &ServerInner, v: &[String]) {
    let r = hook_rpc(
        inner,
        "project.archive",
        serde_json::json!({"projectId": v[0]}),
    );
    assert!(r.get("ok").is_some(), "{r}");
}

fn hook_delete(inner: &ServerInner, v: &[String]) {
    let step1 = hook_rpc(
        inner,
        "project.delete",
        serde_json::json!({"projectId": v[0]}),
    );
    let token = step1["ok"]["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let r = hook_rpc(
        inner,
        "project.delete",
        serde_json::json!({"projectId": v[0], "confirmToken": token}),
    );
    assert_eq!(r["ok"]["deleted"], true, "{r}");
}

fn hook_remove_repository(inner: &ServerInner, v: &[String]) {
    let r = hook_rpc(
        inner,
        "project.remove_repository",
        serde_json::json!({"projectId": v[0], "path": v[1]}),
    );
    assert!(r.get("ok").is_some(), "{r}");
}

/// C1: archive lands between the archived check and the post-claim
/// re-check. Previously a self-deadlock (DB guard held across `release`).
#[test]
fn keyed_create_recheck_refuses_when_archived_meanwhile_and_never_deadlocks() {
    assert_recheck_refuses(
        hook_archive,
        "mountless",
        "VALIDATION_FAILED",
        "project is archived; unarchive it first; nothing was changed",
    );
}

/// C1: delete lands in the same window (the in-flight count is not yet
/// taken, so delete is allowed); the re-check sees the project gone.
#[test]
fn keyed_create_recheck_refuses_when_deleted_meanwhile_and_never_deadlocks() {
    assert_recheck_refuses(hook_delete, "mountless", "NOT_FOUND", "project not found");
}

/// W1(b): the mounted repository is unregistered in the same window; the
/// re-check refuses before sbx runs.
#[test]
fn keyed_create_recheck_refuses_when_its_repository_was_unregistered_meanwhile() {
    for mode in ["direct_mount", "sbx_clone"] {
        assert_recheck_refuses(
            hook_remove_repository,
            mode,
            "CONFLICT",
            MSG_REPO_UNREGISTERED_DURING_CREATE,
        );
    }
}

/// The released key is reusable after a refused re-check.
#[test]
fn a_key_refused_by_the_recheck_is_reusable() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let slot = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut s = server_with_claim_hook(&fake, Arc::clone(&slot), hook_archive);
    let pid = new_project(&mut s);
    *slot.lock().unwrap() = vec![pid.clone()];
    let params = serde_json::json!({"name": "atlas-auth", "projectId": pid,
        "workspaceMode": "mountless", "idempotencyKey": "again"});
    let e = s.err("1", "sandbox.create", params.clone());
    assert_eq!(e["code"], "VALIDATION_FAILED");
    s.ok(
        "2",
        "project.unarchive",
        serde_json::json!({"projectId": pid}),
    );
    let ok = s.ok("3", "sandbox.create", params);
    assert!(ok.get("replayed").is_none(), "a first response: {ok}");
    assert_eq!(create_calls(&fake), 1);
}

fn binding_repo_ids(s: &TestServer) -> Vec<(String, Option<String>)> {
    let db = s.inner.lock_db();
    let mut stmt = db
        .conn()
        .prepare("SELECT workspace_mode, repo_id FROM sandbox_bindings ORDER BY rowid")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    rows
}

fn repo_row_id(s: &TestServer, path: &str) -> String {
    s.inner
        .lock_db()
        .conn()
        .query_row(
            "SELECT id FROM repositories WHERE canonical_path = ?1",
            [path],
            |r| r.get(0),
        )
        .unwrap()
}

/// W1(a): a mounting binding records the registered repository it mounts;
/// mountless records none.
#[test]
fn create_records_the_mounted_repository_on_the_binding() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let (_d, repo) = git_repo();
    let p = s.ok(
        "p",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo]}),
    );
    for (i, mode) in ["direct_mount", "sbx_clone", "mountless"]
        .iter()
        .enumerate()
    {
        let mut params = serde_json::json!({"name": format!("atlas-{i}x"), "projectId": p["id"],
            "workspaceMode": mode});
        if *mode != "mountless" {
            params["repoPath"] = serde_json::json!(repo);
        }
        s.ok(&format!("c{i}"), "sandbox.create", params);
    }
    let rid = repo_row_id(&s, &repo);
    assert_eq!(
        binding_repo_ids(&s),
        vec![
            ("direct_mount".to_string(), Some(rid.clone())),
            ("sbx_clone".to_string(), Some(rid)),
            ("mountless".to_string(), None),
        ]
    );
}

/// W1(c): remove_repository refuses while a live binding mounts the repo;
/// once the sandbox is removed (binding kept for audit) the repository can
/// be unregistered and the audit row is detached from it (repo_id NULL).
#[test]
fn remove_repository_refuses_while_a_live_binding_mounts_it() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let (_d, repo) = git_repo();
    let p = s.ok(
        "p",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo]}),
    );
    s.ok(
        "c",
        "sandbox.create",
        serde_json::json!({"name": "atlas-auth", "projectId": p["id"],
            "workspaceMode": "direct_mount", "repoPath": repo}),
    );
    let remove = serde_json::json!({"projectId": p["id"], "path": repo});
    let e = s.err("r1", "project.remove_repository", remove.clone());
    assert_eq!(e["code"], "CONFLICT", "{e}");
    assert_eq!(e["message"], MSG_REPO_IN_USE);
    // Remove the sandbox (A1 token flow); its binding becomes an audit row.
    let token = s.ok(
        "x1",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth"}),
    )["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    fake.ls_after("rm", EMPTY_LS);
    s.ok(
        "x2",
        "sandbox.remove",
        serde_json::json!({"name": "atlas-auth", "confirmToken": token}),
    );
    let after = s.ok("r2", "project.remove_repository", remove);
    assert_eq!(after["repositories"], serde_json::json!([]));
    assert_eq!(
        binding_repo_ids(&s),
        vec![("direct_mount".to_string(), None)],
        "audit row kept, detached from the unregistered repository"
    );
}

/// W1(c): a LIVE mounting binding written before A3a (repo_id NULL) blocks
/// removal of every repository of its project (conservative); a live
/// mountless binding does not.
#[test]
fn remove_repository_is_conservative_about_pre_a3a_mounting_bindings() {
    let mut s = start_server(no_sbx());
    let (_d, repo) = git_repo();
    let p = s.ok(
        "p",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo]}),
    );
    let pid = p["id"].as_str().unwrap().to_string();
    let remove = serde_json::json!({"projectId": pid, "path": repo});
    s.inner
        .lock_db()
        .conn()
        .execute(
            "INSERT INTO sandbox_bindings (id, project_id, sandbox_name, workspace_mode, created_at)
             VALUES ('legacy', ?1, 'atlas-auth', 'sbx_clone', 't')",
            [&pid],
        )
        .unwrap();
    let e = s.err("1", "project.remove_repository", remove.clone());
    assert_eq!(e["code"], "CONFLICT", "{e}");
    assert_eq!(e["message"], MSG_REPO_IN_USE);
    s.inner
        .lock_db()
        .conn()
        .execute_batch("UPDATE sandbox_bindings SET workspace_mode='mountless' WHERE id='legacy'")
        .unwrap();
    s.ok("2", "project.remove_repository", remove);
}

/// W1(c): remove_repository refuses while a create for the project is in
/// flight (it may be about to mount the repository).
#[test]
fn remove_repository_refuses_while_a_sandbox_create_is_in_flight() {
    let fake = fake_sbx(&ls_with_atlas(ATLAS_ID, "running"), None, None);
    let mut s = start_server(fake.locator());
    let (_d, repo) = git_repo();
    let (_d2, other) = git_repo();
    let p = s.ok(
        "p",
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo, other]}),
    );
    std::fs::write(fake.dir.path().join("create.sleep"), "").unwrap();
    let inner = Arc::clone(&s.inner);
    let frame = serde_json::json!({"v":1,"id":"c","method":"sandbox.create",
        "params":{"name":"atlas-auth","projectId": p["id"],"workspaceMode":"mountless"}})
    .to_string();
    let creator = std::thread::spawn(move || sandpane_service::handle_line(&inner, &frame));
    let deadline = Instant::now() + Duration::from_secs(4);
    while create_calls(&fake) == 0 {
        assert!(Instant::now() < deadline, "create never started");
        std::thread::sleep(Duration::from_millis(20));
    }
    // Even a repository the create does not mount: Core cannot know yet.
    let e = s.err(
        "r",
        "project.remove_repository",
        serde_json::json!({"projectId": p["id"], "path": other}),
    );
    assert_eq!(e["code"], "CONFLICT", "{e}");
    assert_eq!(e["message"], MSG_REMOVE_WHILE_CREATING);
    creator.join().unwrap();
    s.ok(
        "r2",
        "project.remove_repository",
        serde_json::json!({"projectId": p["id"], "path": other}),
    );
}
