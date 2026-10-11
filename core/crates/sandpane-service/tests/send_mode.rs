//! A4 — `conversation.send` mode (design 2026-10-09 §3.4): the optional
//! `mode` ("task" | "discuss"), its normalization before the A2 fingerprint,
//! the exact refusal for any other value, `TaskSummary.mode` /
//! `chosenSandboxName` on send, replay and `task.list` (and `sandboxName`
//! kept at its pre-A4 binding-only meaning — review C1/C2), the stored
//! `tasks.mode` / `tasks.chosen_sandbox_name` (migration v7), the scaffold
//! event naming the mode,
//! and the internal-API refusal of a discuss task with a writable workspace.
//! Real disposable Git repositories; every RPC goes through the production
//! dispatch (`handle_line`). No sbx is located or run here.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sandpane_core::sbx::SbxLocator;
use sandpane_core::Database;
use sandpane_protocol::{ErrorCode, WorkspaceMode, PROTOCOL_VERSION};
use sandpane_service::{
    create_task, create_task_with_mode, CoreConfig, SendMode, ServerInner, TaskWorkspaceRequest,
};

// §3.4 — clients match on these exact strings.
const MSG_BAD_MODE: &str = r#"mode must be "task" or "discuss""#;
const MSG_DISCUSS_WORKSPACE: &str =
    "a discuss task never gets a writable workspace; nothing was run";

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn init_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "sandpane@test.invalid"]);
    git(dir, &["config", "user.name", "Sandpane Test"]);
    std::fs::write(dir.join("app.txt"), "base\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "base"]);
}

fn frame(seq: u32, method: &str, params: serde_json::Value) -> String {
    serde_json::json!({
        "v": PROTOCOL_VERSION, "id": seq.to_string(), "method": method, "params": params
    })
    .to_string()
}

/// Core over a temp data dir with a worktree root, one project ("Atlas
/// Demo") with one registered repository and one conversation created with
/// `sandboxId: "atlas-auth"`.
struct Env {
    _dir: tempfile::TempDir,
    inner: Arc<ServerInner>,
    repo: PathBuf,
    root: PathBuf,
    project_id: String,
    conversation_id: String,
    seq: u32,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let repo = base.join("Atlas Demo repo");
        init_repo(&repo);
        let root = base.join("data").join("worktrees");
        let db = Database::open(&base.join("core.sqlite3")).unwrap();
        let config = CoreConfig {
            worktrees_root: Some(root.clone()),
            ..CoreConfig::default()
        };
        let inner = ServerInner::with_config(db, SbxLocator::with_search(None, vec![]), config);
        let mut env = Self {
            _dir: dir,
            inner,
            repo,
            root,
            project_id: String::new(),
            conversation_id: String::new(),
            seq: 0,
        };
        let project = env.ok(
            "project.create",
            serde_json::json!({"name": "Atlas Demo", "repositories": [env.repo_str()]}),
        );
        env.project_id = project["id"].as_str().unwrap().to_string();
        let conv = env.ok(
            "conversation.create",
            serde_json::json!({
                "projectId": env.project_id, "agentId": "codex",
                "sandboxId": "atlas-auth", "title": "Atlas chat"
            }),
        );
        env.conversation_id = conv["id"].as_str().unwrap().to_string();
        env
    }

    fn repo_str(&self) -> String {
        self.repo.display().to_string()
    }

    fn rpc(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        self.seq += 1;
        let f = frame(self.seq, method, params);
        let out = sandpane_service::handle_line(&self.inner, &f);
        println!(">> {f}\n<< {out}");
        serde_json::from_str(&out).unwrap()
    }

    fn ok(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let resp = self.rpc(method, params);
        assert!(resp.get("ok").is_some(), "{method} failed: {resp}");
        resp["ok"].clone()
    }

    fn err(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let resp = self.rpc(method, params);
        assert!(
            resp.get("err").is_some(),
            "{method} unexpectedly ok: {resp}"
        );
        resp["err"].clone()
    }

    fn send(&mut self, extra: serde_json::Value) -> serde_json::Value {
        let mut params =
            serde_json::json!({"conversationId": self.conversation_id, "content": "hi"});
        for (k, v) in extra.as_object().unwrap() {
            params[k] = v.clone();
        }
        self.ok("conversation.send", params)
    }

    fn count(&self, sql: &str) -> i64 {
        let db = self.inner.lock_db();
        db.conn().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn exec(&self, sql: &str) {
        self.inner.lock_db().conn().execute_batch(sql).unwrap();
    }

    fn task_row(&self, id: &str) -> (Option<String>, Option<String>, String) {
        let db = self.inner.lock_db();
        db.conn()
            .query_row(
                "SELECT mode, chosen_sandbox_name, status FROM tasks WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
    }

    /// `(kind, payload)` of every durable event of a task, in order.
    fn events(&self, task_id: &str) -> Vec<(String, serde_json::Value)> {
        let db = self.inner.lock_db();
        let mut stmt = db
            .conn()
            .prepare("SELECT kind, payload FROM task_events WHERE task_id = ?1 ORDER BY sequence")
            .unwrap();
        let rows = stmt
            .query_map([task_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap()
            .map(|r| {
                let (k, p) = r.unwrap();
                (k, serde_json::from_str(&p).unwrap())
            })
            .collect();
        rows
    }

    fn snapshot(&self) -> Vec<(&'static str, i64)> {
        [
            "conversations",
            "messages",
            "tasks",
            "task_events",
            "idempotency_keys",
        ]
        .iter()
        .map(|t| (*t, self.count(&format!("SELECT COUNT(*) FROM {t}"))))
        .collect()
    }
}

fn event<'a>(events: &'a [(String, serde_json::Value)], kind: &str) -> &'a serde_json::Value {
    &events
        .iter()
        .find(|(k, _)| k == kind)
        .unwrap_or_else(|| panic!("no {kind} event in {events:?}"))
        .1
}

// ---------------------------------------------------------------------------
// Wire: normalization, refusal, replay
// ---------------------------------------------------------------------------

/// Absent, explicit "task" and `null` are ONE request for A2: each replays
/// the other with the same key (never CONFLICT). "discuss" under the same
/// key is a different request (CONFLICT, nothing written).
#[test]
fn absent_explicit_task_and_null_mode_replay_each_other_and_discuss_conflicts() {
    let mut env = Env::new();
    let first = env.send(serde_json::json!({"idempotencyKey": "k-absent"}));
    assert_eq!(first["mode"], "task", "{first}");
    assert_eq!(first["chosenSandboxName"], "atlas-auth", "{first}");
    assert!(first.get("sandboxName").is_none(), "{first}");
    assert!(first.get("replayed").is_none(), "{first}");
    for mode in [serde_json::json!("task"), serde_json::Value::Null] {
        let again = env.send(serde_json::json!({"idempotencyKey": "k-absent", "mode": mode}));
        assert_eq!(again["replayed"], true, "{again}");
        assert_eq!(again["id"], first["id"], "{again}");
        // The stored FIRST response, marker added.
        let mut stripped = again.clone();
        stripped.as_object_mut().unwrap().remove("replayed");
        assert_eq!(stripped, first);
    }
    // The other direction: explicit "task" first, absent second.
    let first2 = env.send(serde_json::json!({"idempotencyKey": "k-task", "mode": "task"}));
    let again2 = env.send(serde_json::json!({"idempotencyKey": "k-task"}));
    assert_eq!(again2["replayed"], true, "{again2}");
    assert_eq!(again2["id"], first2["id"]);
    assert_eq!(env.count("SELECT COUNT(*) FROM tasks"), 2);

    let before = env.snapshot();
    let cid = env.conversation_id.clone();
    let err = env.err(
        "conversation.send",
        serde_json::json!({"conversationId": cid, "content": "hi",
                       "idempotencyKey": "k-absent", "mode": "discuss"}),
    );
    assert_eq!(err["code"], "CONFLICT", "{err}");
    assert_eq!(err["message"], sandpane_service::IDEM_MSG_MISMATCH, "{err}");
    assert_eq!(env.snapshot(), before, "a CONFLICT writes nothing");
}

/// Anything but "task" / "discuss" is refused with the exact message before
/// anything is written — not even the A2 key row.
#[test]
fn invalid_modes_are_refused_exactly_before_anything_is_written() {
    let mut env = Env::new();
    let before = env.snapshot();
    let cid = env.conversation_id.clone();
    for bad in ["Task", "DISCUSS", "", " task", "task ", "chat", "plan"] {
        let err = env.err(
            "conversation.send",
            serde_json::json!({"conversationId": cid, "content": "hi",
                           "idempotencyKey": format!("bad-{}", bad.len()), "mode": bad}),
        );
        assert_eq!(err["code"], "VALIDATION_FAILED", "{bad:?}: {err}");
        assert_eq!(err["message"], MSG_BAD_MODE, "{bad:?}: {err}");
    }
    // Unkeyed too.
    let err = env.err(
        "conversation.send",
        serde_json::json!({"conversationId": cid, "content": "hi", "mode": "chat"}),
    );
    assert_eq!(err["message"], MSG_BAD_MODE, "{err}");
    // A non-string mode is a malformed frame: VALIDATION_FAILED all the same.
    let err = env.err(
        "conversation.send",
        serde_json::json!({"conversationId": cid, "content": "hi", "mode": 1}),
    );
    assert_eq!(err["code"], "VALIDATION_FAILED", "{err}");
    assert_eq!(env.snapshot(), before, "nothing written for any bad mode");
}

/// A discuss send is stored as discuss, stays queued, and records the same
/// honest PERMISSION_DENIED scaffold event — which names the mode.
#[test]
fn discuss_send_stays_queued_with_permission_denied_and_the_mode_is_recorded() {
    let mut env = Env::new();
    let d = env.send(serde_json::json!({"mode": "discuss"}));
    assert_eq!(d["status"], "queued", "{d}");
    assert_eq!(d["mode"], "discuss", "{d}");
    assert_eq!(d["chosenSandboxName"], "atlas-auth", "{d}");
    assert!(d.get("sandboxName").is_none(), "{d}");
    assert!(
        d.get("taskBranch").is_none() && d.get("baseCommit").is_none(),
        "{d}"
    );
    let id = d["id"].as_str().unwrap();
    assert_eq!(
        env.task_row(id),
        (
            Some("discuss".into()),
            Some("atlas-auth".into()),
            "queued".into()
        )
    );
    let events = env.events(id);
    let kinds: Vec<&str> = events.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "task.created",
            "message.user",
            "status.changed",
            "adapter.unavailable"
        ]
    );
    assert_eq!(event(&events, "task.created")["mode"], "discuss");
    let scaffold = event(&events, "adapter.unavailable");
    assert_eq!(scaffold["code"], "PERMISSION_DENIED", "{scaffold}");
    let msg = scaffold["message"].as_str().unwrap();
    assert!(
        msg.starts_with("no verified agent adapter for 'codex'"),
        "{msg}"
    );
    assert!(msg.contains("discuss"), "{msg}");

    let t = env.send(serde_json::json!({}));
    assert_eq!(t["mode"], "task", "{t}");
    let tid = t["id"].as_str().unwrap();
    assert_eq!(env.task_row(tid).0.as_deref(), Some("task"));
    let events = env.events(tid);
    assert_eq!(event(&events, "task.created")["mode"], "task");
    let msg = event(&events, "adapter.unavailable")["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(msg.contains("task") && !msg.contains("discuss"), "{msg}");
}

/// Review C1/C2 pin (§3.4 item 3): a task sent from a chat that chose a
/// sandbox carries that name ONLY as `chosenSandboxName`; `sandboxName`
/// (the sandbox a task is bound to / runs in, which shipped clients turn
/// into a verified isolation label and stop/remove impact counts) stays
/// ABSENT — on the send response, its replay, and `task.list`.
#[test]
fn a_chat_chosen_sandbox_never_fills_sandbox_name() {
    let mut env = Env::new();
    for extra in [
        serde_json::json!({}),
        serde_json::json!({"mode": "discuss"}),
        serde_json::json!({"idempotencyKey": "pin-c1"}),
    ] {
        let sent = env.send(extra.clone());
        assert_eq!(sent["chosenSandboxName"], "atlas-auth", "{extra}: {sent}");
        assert!(sent.get("sandboxName").is_none(), "{extra}: {sent}");
    }
    let replay = env.send(serde_json::json!({"idempotencyKey": "pin-c1"}));
    assert_eq!(replay["replayed"], true);
    assert!(replay.get("sandboxName").is_none(), "{replay}");
    let list = env.ok("task.list", serde_json::json!({}));
    let list = list.as_array().unwrap();
    assert_eq!(list.len(), 3);
    for t in list {
        assert_eq!(t["chosenSandboxName"], "atlas-auth", "{t}");
        assert!(t.get("sandboxName").is_none(), "{t}");
    }
    assert_eq!(
        env.count("SELECT COUNT(*) FROM tasks WHERE sandbox_binding_id IS NOT NULL"),
        0,
        "no binding was invented"
    );
}

/// `task.list` shows the stored mode and chosen sandbox name; pre-v7 rows
/// (NULL) show neither; `sandboxName` comes from the task's binding ONLY
/// (never merged with the chat's choice — review I3).
#[test]
fn task_list_reports_mode_and_chosen_sandbox_name_separately_from_sandbox_name() {
    let mut env = Env::new();
    let d = env.send(serde_json::json!({"mode": "discuss"}));
    let t = env.send(serde_json::json!({"mode": "task"}));
    // A conversation created without a sandbox name.
    let plain = env.ok(
        "conversation.create",
        serde_json::json!({"projectId": env.project_id, "agentId": "codex", "title": "plain"}),
    );
    let plain_id = plain["id"].as_str().unwrap().to_string();
    let p = env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": plain_id, "content": "x"}),
    );
    assert_eq!(p["mode"], "task", "{p}");
    assert!(p.get("sandboxName").is_none(), "{p}");
    assert!(p.get("chosenSandboxName").is_none(), "{p}");
    // Rows written before v7: no mode, no chosen name; one carries a
    // (legacy) binding. One row has BOTH a binding and a chosen name: the
    // two fields stay independent.
    env.exec(&format!(
        "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at)
             VALUES ('zz-legacy-plain', '{c}', 'queued', '9999', '9999');
         INSERT INTO sandbox_bindings (id, project_id, sandbox_name, workspace_mode, created_at)
             VALUES ('b-legacy', '{p}', 'nova-search', 'mountless', 't');
         INSERT INTO tasks (id, conversation_id, sandbox_binding_id, status, created_at, updated_at)
             VALUES ('zz-legacy-bound', '{c}', 'b-legacy', 'queued', '9999', '9999');
         INSERT INTO tasks (id, conversation_id, sandbox_binding_id, chosen_sandbox_name,
                            status, created_at, updated_at)
             VALUES ('zz-both', '{c}', 'b-legacy', 'atlas-auth', 'queued', '9999', '9999');",
        c = env.conversation_id,
        p = env.project_id
    ));
    let list = env.ok("task.list", serde_json::json!({}));
    let by_id = |id: &str| -> serde_json::Value {
        list.as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == id)
            .cloned()
            .unwrap_or_else(|| panic!("{id} not listed: {list}"))
    };
    let ld = by_id(d["id"].as_str().unwrap());
    assert_eq!(ld["mode"], "discuss");
    assert_eq!(ld["chosenSandboxName"], "atlas-auth");
    assert!(ld.get("sandboxName").is_none(), "{ld}");
    let lt = by_id(t["id"].as_str().unwrap());
    assert_eq!(lt["mode"], "task");
    assert_eq!(lt["chosenSandboxName"], "atlas-auth");
    assert!(lt.get("sandboxName").is_none(), "{lt}");
    let lp = by_id(p["id"].as_str().unwrap());
    assert_eq!(lp["mode"], "task");
    assert!(lp.get("sandboxName").is_none(), "{lp}");
    assert!(lp.get("chosenSandboxName").is_none(), "{lp}");
    let legacy = by_id("zz-legacy-plain");
    assert!(legacy.get("mode").is_none(), "{legacy}");
    assert!(legacy.get("sandboxName").is_none(), "{legacy}");
    assert!(legacy.get("chosenSandboxName").is_none(), "{legacy}");
    let bound = by_id("zz-legacy-bound");
    assert!(bound.get("mode").is_none(), "{bound}");
    assert_eq!(bound["sandboxName"], "nova-search", "{bound}");
    assert!(bound.get("chosenSandboxName").is_none(), "{bound}");
    let both = by_id("zz-both");
    assert_eq!(both["sandboxName"], "nova-search", "binding only: {both}");
    assert_eq!(both["chosenSandboxName"], "atlas-auth", "{both}");
    // The send result is exactly what task.list shows for a fresh task.
    let mut sent = d.clone();
    let listed = ld.clone();
    sent.as_object_mut().unwrap().remove("replayed");
    assert_eq!(sent, listed);
}

/// A key stored by a PRE-A4 Core (hash computed before `mode` existed, result
/// without `mode` / `sandboxName`) keeps replaying through the production
/// path — for an absent and an explicit "task" mode — exactly as stored,
/// never re-run and never back-filled. "discuss" under it is CONFLICT.
#[test]
fn a_pre_a4_stored_send_key_replays_unchanged_through_the_wire() {
    // Pinned at f44ab4c (see `send_mode_normalization_keeps_pre_a4_fingerprints`).
    const PRE_A4_HASH: &str = "fcb9565997fbd5e6ec9cd4970cfa44829ca4fc6aae358f02c3ba69a422212efe";
    const STORED: &str = r#"{"id":"t-pre-a4","conversationId":"conv-pinned","status":"queued"}"#;
    let mut env = Env::new();
    env.exec(&format!(
        "INSERT INTO conversations (id, project_id, title, agent_id, created_at, sandbox_id)
             VALUES ('conv-pinned', '{p}', 'pinned', 'codex', 't', 'atlas-auth');
         INSERT INTO idempotency_keys (method, key, params_hash, state, result_json, created_at,
                                       completed_at)
             VALUES ('conversation.send', 'pre-a4-key', '{PRE_A4_HASH}', 'done', '{STORED}',
                     strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'));",
        p = env.project_id
    ));
    let before = env.snapshot();
    let mut expected: serde_json::Value = serde_json::from_str(STORED).unwrap();
    expected["replayed"] = serde_json::json!(true);
    for extra in [
        serde_json::json!({}),
        serde_json::json!({"mode": "task"}),
        serde_json::json!({"mode": null}),
    ] {
        let mut params = serde_json::json!({
            "conversationId": "conv-pinned", "content": "hello", "idempotencyKey": "pre-a4-key"
        });
        for (k, v) in extra.as_object().unwrap() {
            params[k] = v.clone();
        }
        let out = env.ok("conversation.send", params);
        assert_eq!(out, expected, "{extra}: no mode / sandboxName added");
    }
    let err = env.err(
        "conversation.send",
        serde_json::json!({"conversationId": "conv-pinned", "content": "hello",
                           "idempotencyKey": "pre-a4-key", "mode": "discuss"}),
    );
    assert_eq!(err["code"], "CONFLICT", "{err}");
    assert_eq!(env.snapshot(), before, "nothing re-run or written");
}

// ---------------------------------------------------------------------------
// Internal API: a discuss task never gets a writable workspace
// ---------------------------------------------------------------------------

#[test]
fn discuss_with_a_writable_workspace_is_refused_and_nothing_is_run() {
    let env = Env::new();
    let before = env.snapshot();
    let branches_before = git(&env.repo, &["branch", "--list"]);
    for mode in [
        WorkspaceMode::DirectMount,
        WorkspaceMode::SbxClone,
        WorkspaceMode::HostWorktree,
    ] {
        let e = create_task_with_mode(
            &env.inner,
            &env.conversation_id,
            "talk only",
            Some(TaskWorkspaceRequest {
                mode,
                repo_path: Some(env.repo_str()),
            }),
            SendMode::Discuss,
        )
        .unwrap_err();
        assert_eq!(
            e.code,
            ErrorCode::ValidationFailed,
            "{mode:?}: {}",
            e.message
        );
        assert_eq!(e.message, MSG_DISCUSS_WORKSPACE, "{mode:?}");
    }
    assert_eq!(env.snapshot(), before, "no rows written");
    assert_eq!(git(&env.repo, &["branch", "--list"]), branches_before);
    assert!(
        !env.root.exists() || std::fs::read_dir(&env.root).unwrap().next().is_none(),
        "no worktree directory allocated"
    );
    assert_eq!(git(&env.repo, &["worktree", "list"]).lines().count(), 1);

    // None and mountless are fine for discuss.
    for ws in [
        None,
        Some(TaskWorkspaceRequest {
            mode: WorkspaceMode::Mountless,
            repo_path: None,
        }),
    ] {
        let s = create_task_with_mode(
            &env.inner,
            &env.conversation_id,
            "talk only",
            ws,
            SendMode::Discuss,
        )
        .unwrap();
        assert_eq!(s.mode.as_deref(), Some("discuss"));
        assert_eq!(s.chosen_sandbox_name.as_deref(), Some("atlas-auth"));
        assert_eq!(s.sandbox_name, None);
        assert!(s.task_branch.is_none() && s.base_commit.is_none());
        assert_eq!(env.task_row(&s.id).0.as_deref(), Some("discuss"));
    }

    // A task (the `create_task` wrapper) still gets its worktree.
    let s = create_task(
        &env.inner,
        &env.conversation_id,
        "work",
        Some(TaskWorkspaceRequest {
            mode: WorkspaceMode::HostWorktree,
            repo_path: Some(env.repo_str()),
        }),
    )
    .unwrap();
    assert_eq!(s.mode.as_deref(), Some("task"));
    assert!(s.task_branch.is_some(), "{s:?}");
    assert_eq!(
        env.task_row(&s.id),
        (
            Some("task".into()),
            Some("atlas-auth".into()),
            "queued".into()
        )
    );
}
