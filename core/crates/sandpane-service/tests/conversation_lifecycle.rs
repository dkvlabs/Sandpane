//! A3b — conversation lifecycle (design 2026-10-09 §3.3):
//! `conversation.rename`, `conversation.archive` / `conversation.unarchive`,
//! `conversation.delete` (two-step confirmation token bound to the
//! conversation id), `conversation.export` (redacted, paged, bounded),
//! `conversation.list includeArchived`, the persisted `sandboxId`, and the
//! archived-conversation refusals on both send paths. Real disposable Git
//! repositories; every RPC goes through the production dispatch
//! (`handle_line`). No sbx is located or run here.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use sandpane_core::sbx::SbxLocator;
use sandpane_core::Database;
use sandpane_protocol::{WorkspaceMode, PROTOCOL_VERSION};
use sandpane_service::confirm::TOKEN_REJECTED_MESSAGE;
use sandpane_service::{
    create_task, CoreConfig, ServerInner, TaskWorkspaceRequest, TestHook, MAX_HISTORY_BYTES,
};

// §3.3 item 8 — clients match on these exact strings.
const MSG_CONV_ARCHIVED: &str = "conversation is archived; unarchive it first; nothing was changed";
const MSG_CONV_HAS_TASKS: &str =
    "conversation has tasks that are not finished; cancel or finish them first; nothing was deleted";
const MSG_CONV_NOT_FOUND: &str = "conversation not found";
const MSG_PROJECT_ARCHIVED: &str = "project is archived; unarchive it first; nothing was changed";

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

/// One RPC against `inner` from inside a test hook (no Env available).
fn call(inner: &ServerInner, method: &str, params: serde_json::Value) -> serde_json::Value {
    let out = sandpane_service::handle_line(inner, &frame(9000, method, params));
    println!(">> (hook) {method}\n<< {out}");
    serde_json::from_str(&out).unwrap()
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
        Self::with(|_| {})
    }

    fn with(configure: impl FnOnce(&mut CoreConfig)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let repo = base.join("Atlas Demo repo");
        init_repo(&repo);
        let root = base.join("data").join("worktrees");
        let db = Database::open(&base.join("core.sqlite3")).unwrap();
        let mut config = CoreConfig {
            worktrees_root: Some(root.clone()),
            ..CoreConfig::default()
        };
        configure(&mut config);
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
        if out.len() < 4096 {
            println!(">> {f}\n<< {out}");
        } else {
            println!(">> {method}\n<< ({} bytes)", out.len());
        }
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

    fn cid(&self) -> serde_json::Value {
        serde_json::json!({"conversationId": self.conversation_id})
    }

    fn count(&self, sql: &str) -> i64 {
        let db = self.inner.lock_db();
        db.conn().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn exec(&self, sql: &str) {
        self.inner.lock_db().conn().execute_batch(sql).unwrap();
    }

    fn snapshot(&self) -> Vec<(&'static str, i64)> {
        TABLES
            .iter()
            .map(|t| (*t, self.count(&format!("SELECT COUNT(*) FROM {t}"))))
            .collect()
    }

    /// The conversation as `conversation.list {includeArchived: true}` shows it.
    fn listed(&mut self, id: &str) -> serde_json::Value {
        let list = self.ok(
            "conversation.list",
            serde_json::json!({"includeArchived": true}),
        );
        list.as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .cloned()
            .expect("conversation listed")
    }

    fn new_conversation(&mut self, title: &str) -> String {
        let c = self.ok(
            "conversation.create",
            serde_json::json!({"projectId": self.project_id, "agentId": "codex", "title": title}),
        );
        c["id"].as_str().unwrap().to_string()
    }

    fn token(&mut self, conversation_id: &str) -> String {
        self.ok(
            "conversation.delete",
            serde_json::json!({"conversationId": conversation_id}),
        )["confirmation"]["token"]
            .as_str()
            .unwrap()
            .to_string()
    }
}

const TABLES: [&str; 14] = [
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
    "project_context",
    "workflows",
    "client_state",
    "idempotency_keys",
];

fn keys(v: &serde_json::Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

// ---------------------------------------------------------------------------
// rename / create titles / sandboxId
// ---------------------------------------------------------------------------

#[test]
fn rename_returns_the_conversation_and_persists_it() {
    let mut env = Env::new();
    let before = env.listed(&env.conversation_id.clone());
    let c = env.ok(
        "conversation.rename",
        serde_json::json!({"conversationId": env.conversation_id, "title": "Renamed — ü 漢字"}),
    );
    assert_eq!(
        keys(&c),
        [
            "agentId",
            "createdAt",
            "id",
            "projectId",
            "sandboxId",
            "title"
        ],
        "no archivedAt on a live conversation: {c}"
    );
    assert_eq!(c["title"], "Renamed — ü 漢字");
    assert_eq!(c["sandboxId"], "atlas-auth", "sandboxId survives a rename");
    assert_eq!(c["createdAt"], before["createdAt"]);
    assert_eq!(env.listed(&env.conversation_id.clone()), c, "persisted");
    // 200 characters is the inclusive maximum.
    let max = "é".repeat(200);
    let c = env.ok(
        "conversation.rename",
        serde_json::json!({"conversationId": env.conversation_id, "title": max}),
    );
    assert_eq!(c["title"], max.as_str());
}

#[test]
fn rename_validation_corpus_and_not_found_change_nothing() {
    let mut env = Env::new();
    let before = env.snapshot();
    let listed = env.listed(&env.conversation_id.clone());
    for bad in [
        "",
        "   ",
        "\t",
        "\n",
        "a\nb",
        "a\tb",
        "a\u{2028}b",
        "a\u{2029}b",
        "a\u{202E}b",
        "a\u{200F}b",
        "a\u{2066}b",
        "a\u{85}b",
        "a\u{7f}b",
        &"x".repeat(201),
    ] {
        let e = env.err(
            "conversation.rename",
            serde_json::json!({"conversationId": env.conversation_id, "title": bad}),
        );
        assert_eq!(e["code"], "VALIDATION_FAILED", "{bad:?}: {e}");
    }
    let e = env.err(
        "conversation.rename",
        serde_json::json!({"conversationId": env.conversation_id}),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED", "title is required");
    let e = env.err(
        "conversation.rename",
        serde_json::json!({"conversationId": "no-such-conversation", "title": "x"}),
    );
    assert_eq!(e["code"], "NOT_FOUND");
    assert_eq!(e["message"], MSG_CONV_NOT_FOUND);
    assert_eq!(env.snapshot(), before);
    assert_eq!(
        env.listed(&env.conversation_id.clone()),
        listed,
        "unchanged"
    );
}

/// §3.3 item 7: `conversation.create` uses `Validator::conversation_title`;
/// empty / whitespace-only still becomes "Untitled conversation".
#[test]
fn create_applies_the_new_title_rule() {
    let mut env = Env::new();
    let pid = env.project_id.clone();
    for title in [None, Some(""), Some("   \t ")] {
        let mut params = serde_json::json!({"projectId": pid, "agentId": "codex"});
        if let Some(t) = title {
            params["title"] = serde_json::json!(t);
        }
        let c = env.ok("conversation.create", params);
        assert_eq!(c["title"], "Untitled conversation", "{title:?}");
        assert!(c.get("sandboxId").is_none(), "none chosen: {c}");
        assert!(c.get("archivedAt").is_none(), "{c}");
    }
    let ok = env.ok(
        "conversation.create",
        serde_json::json!({"projectId": pid, "agentId": "codex", "title": "x".repeat(200)}),
    );
    assert_eq!(ok["title"].as_str().unwrap().len(), 200);
    let before = env.count("SELECT COUNT(*) FROM conversations");
    // `display_text` used to accept `\n` / `\t` / C1 / bidi; no longer.
    for bad in [
        "a\nb",
        "a\tb",
        "a\u{85}b",
        "a\u{202E}b",
        "a\u{2028}b",
        &"x".repeat(201),
    ] {
        let e = env.err(
            "conversation.create",
            serde_json::json!({"projectId": pid, "agentId": "codex", "title": bad}),
        );
        assert_eq!(e["code"], "VALIDATION_FAILED", "{bad:?}: {e}");
    }
    assert_eq!(env.count("SELECT COUNT(*) FROM conversations"), before);
}

/// §3.3 items 2-3: the validated sandbox NAME is persisted and returned by
/// every method that returns a `Conversation`; absent when none was chosen.
#[test]
fn sandbox_id_round_trips_through_create_list_rename_archive_and_export() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    let stored: Option<String> = {
        let db = env.inner.lock_db();
        db.conn()
            .query_row(
                "SELECT sandbox_id FROM conversations WHERE id=?1",
                [&cid],
                |r| r.get(0),
            )
            .unwrap()
    };
    assert_eq!(
        stored.as_deref(),
        Some("atlas-auth"),
        "persisted in v6 column"
    );
    assert_eq!(env.listed(&cid)["sandboxId"], "atlas-auth");
    let default_list = env.ok(
        "conversation.list",
        serde_json::json!({"projectId": env.project_id}),
    );
    assert_eq!(default_list[0]["sandboxId"], "atlas-auth");
    let r = env.ok(
        "conversation.rename",
        serde_json::json!({"conversationId": cid, "title": "t2"}),
    );
    assert_eq!(r["sandboxId"], "atlas-auth");
    let a = env.ok("conversation.archive", env.cid());
    assert_eq!(a["sandboxId"], "atlas-auth");
    let x = env.ok("conversation.export", env.cid());
    assert_eq!(x["conversation"]["sandboxId"], "atlas-auth");
    let u = env.ok("conversation.unarchive", env.cid());
    assert_eq!(u["sandboxId"], "atlas-auth");
    // Invalid sandbox names are still refused at create.
    let e = env.err(
        "conversation.create",
        serde_json::json!({"projectId": env.project_id, "agentId": "codex", "sandboxId": "bad name;rm"}),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED");
}

// ---------------------------------------------------------------------------
// archive / unarchive / list / history
// ---------------------------------------------------------------------------

#[test]
fn archive_and_unarchive_are_idempotent_and_list_filters() {
    let mut env = Env::new();
    let cid = env.cid();
    let a = env.ok("conversation.archive", cid.clone());
    let stamp = a["archivedAt"].as_str().expect("archivedAt").to_string();
    assert_eq!(stamp.len(), "2026-10-11T00:00:00Z".len(), "{stamp}");
    assert_eq!(
        keys(&a),
        [
            "agentId",
            "archivedAt",
            "createdAt",
            "id",
            "projectId",
            "sandboxId",
            "title"
        ]
    );
    let again = env.ok("conversation.archive", cid.clone());
    assert_eq!(again, a, "idempotent: archivedAt is never re-stamped");

    // Older clients (no includeArchived) never see archived conversations.
    let pid = env.project_id.clone();
    for params in [
        serde_json::json!({}),
        serde_json::json!({"projectId": pid}),
        serde_json::json!({"projectId": pid, "includeArchived": false}),
    ] {
        assert_eq!(
            env.ok("conversation.list", params.clone()),
            serde_json::json!([]),
            "{params}"
        );
    }
    let all = env.ok(
        "conversation.list",
        serde_json::json!({"projectId": pid, "includeArchived": true}),
    );
    assert_eq!(all, serde_json::json!([a]));

    let u = env.ok("conversation.unarchive", cid.clone());
    assert!(u.get("archivedAt").is_none(), "{u}");
    assert_eq!(
        env.ok("conversation.unarchive", cid.clone()),
        u,
        "idempotent"
    );
    assert_eq!(
        env.ok("conversation.list", serde_json::json!({}))[0]["id"],
        env.conversation_id.as_str()
    );
    for m in [
        "conversation.archive",
        "conversation.unarchive",
        "conversation.history",
        "conversation.export",
        "conversation.delete",
    ] {
        let e = env.err(
            m,
            serde_json::json!({"conversationId": "no-such-conversation"}),
        );
        assert_eq!(e["code"], "NOT_FOUND", "{m}: {e}");
        assert_eq!(e["message"], MSG_CONV_NOT_FOUND, "{m}");
    }
}

#[test]
fn archived_conversation_refuses_send_and_rename_and_changes_nothing() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": cid, "content": "before"}),
    );
    env.ok("conversation.archive", env.cid());
    let before = env.snapshot();
    for (method, params) in [
        (
            "conversation.send",
            serde_json::json!({"conversationId": cid, "content": "hello"}),
        ),
        (
            "conversation.send",
            serde_json::json!({"conversationId": cid, "content": "hello", "idempotencyKey": "arch-k"}),
        ),
        (
            "conversation.rename",
            serde_json::json!({"conversationId": cid, "title": "nope"}),
        ),
    ] {
        let e = env.err(method, params);
        assert_eq!(e["code"], "VALIDATION_FAILED", "{method}: {e}");
        assert_eq!(e["message"], MSG_CONV_ARCHIVED, "{method}: {e}");
    }
    assert_eq!(env.snapshot(), before, "nothing changed, no key stored");
    // Reads keep working, and history no longer answers NOT_FOUND.
    let h = env.ok("conversation.history", env.cid());
    assert_eq!(h["messages"][0]["content"], "before");
    env.ok("conversation.export", env.cid());
    env.ok(
        "task.list",
        serde_json::json!({"projectId": env.project_id}),
    );
    // After unarchive the refused key is free and sending works again.
    env.ok("conversation.unarchive", env.cid());
    let s = env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": cid, "content": "hello", "idempotencyKey": "arch-k"}),
    );
    assert!(s.get("replayed").is_none(), "a first response: {s}");
}

/// §3.3 item 4: in an archived project only reads, `conversation.archive`
/// and `conversation.delete` are allowed.
#[test]
fn archived_project_allows_only_reads_archive_and_delete() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    let other = env.new_conversation("Second");
    env.ok(
        "conversation.archive",
        serde_json::json!({"conversationId": other}),
    );
    env.ok(
        "project.archive",
        serde_json::json!({"projectId": env.project_id}),
    );
    let before = env.snapshot();
    for (method, params) in [
        (
            "conversation.rename",
            serde_json::json!({"conversationId": cid, "title": "x"}),
        ),
        (
            "conversation.unarchive",
            serde_json::json!({"conversationId": other}),
        ),
        // Both archived: the PROJECT message (its unarchive comes first).
        (
            "conversation.rename",
            serde_json::json!({"conversationId": other, "title": "x"}),
        ),
        (
            "conversation.send",
            serde_json::json!({"conversationId": other, "content": "x"}),
        ),
        (
            "conversation.send",
            serde_json::json!({"conversationId": cid, "content": "x"}),
        ),
    ] {
        let e = env.err(method, params.clone());
        assert_eq!(e["code"], "VALIDATION_FAILED", "{method} {params}: {e}");
        assert_eq!(e["message"], MSG_PROJECT_ARCHIVED, "{method} {params}");
    }
    assert_eq!(env.snapshot(), before);
    env.ok("conversation.history", env.cid());
    env.ok("conversation.export", env.cid());
    env.ok(
        "conversation.list",
        serde_json::json!({"includeArchived": true}),
    );
    let a = env.ok("conversation.archive", env.cid());
    assert!(a.get("archivedAt").is_some());
    let t = env.token(&cid);
    let d = env.ok(
        "conversation.delete",
        serde_json::json!({"conversationId": cid, "confirmToken": t}),
    );
    assert_eq!(d, serde_json::json!({"deleted": true}));
}

// ---------------------------------------------------------------------------
// send paths: keyed replay, in-transaction re-check
// ---------------------------------------------------------------------------

/// §3.3 item 4: the key lookup runs BEFORE the archived/existence checks, so
/// a keyed replay to an archived or deleted conversation returns the stored
/// first response plus `replayed: true` (a replay is not current state).
#[test]
fn keyed_replay_to_an_archived_or_deleted_conversation_returns_the_stored_response() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    let send =
        serde_json::json!({"conversationId": cid, "content": "hi", "idempotencyKey": "rk-1"});
    let first = env.ok("conversation.send", send.clone());
    env.ok("conversation.archive", env.cid());
    let replay = env.ok("conversation.send", send.clone());
    assert_eq!(replay["replayed"], true, "{replay}");
    assert_eq!(replay["id"], first["id"]);
    // Delete it (finish the task first), then replay again.
    env.ok("task.cancel", serde_json::json!({"taskId": first["id"]}));
    let t = env.token(&cid);
    env.ok(
        "conversation.delete",
        serde_json::json!({"conversationId": cid, "confirmToken": t}),
    );
    let replay = env.ok("conversation.send", send);
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["id"], first["id"]);
    assert_eq!(replay["conversationId"], cid.as_str());
    assert_eq!(
        env.count("SELECT COUNT(*) FROM tasks"),
        0,
        "nothing written"
    );
}

/// The in-transaction (authoritative) check in `write_new_task`: an archive
/// that lands AFTER the early check is refused with the exact message and
/// nothing — message, task, events, key — is written.
#[test]
fn in_transaction_send_check_refuses_an_archive_that_lands_after_the_early_check() {
    let fired = Arc::new(AtomicUsize::new(0));
    let f = fired.clone();
    let target: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let t = target.clone();
    let mut env = Env::with(|c| {
        c.test_before_task_write = Some(TestHook(Arc::new(move |inner: &ServerInner| {
            let id = t.lock().unwrap().clone();
            if !id.is_empty() && f.fetch_add(1, Ordering::SeqCst) == 0 {
                let r = call(
                    inner,
                    "conversation.archive",
                    serde_json::json!({"conversationId": id}),
                );
                assert!(r.get("ok").is_some(), "{r}");
            }
        })));
    });
    *target.lock().unwrap() = env.conversation_id.clone();
    let before = env.snapshot();
    let e = env.err(
        "conversation.send",
        serde_json::json!({"conversationId": env.conversation_id, "content": "x", "idempotencyKey": "race-k"}),
    );
    assert_eq!(fired.load(Ordering::SeqCst), 1, "the hook ran");
    assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
    assert_eq!(e["message"], MSG_CONV_ARCHIVED);
    let mut after = env.snapshot();
    // The archive itself is the only change (archived_at on the same row).
    after.retain(|(t, _)| *t != "conversations");
    let mut expect = before;
    expect.retain(|(t, _)| *t != "conversations");
    assert_eq!(after, expect, "no message, task, event or key written");
}

/// §3.3 item 5: a delete that lands between send's early check and its
/// write leaves send NOT_FOUND (its transaction re-checks existence).
#[test]
fn in_transaction_send_check_answers_not_found_when_a_delete_lands_first() {
    let fired = Arc::new(AtomicUsize::new(0));
    let f = fired.clone();
    let target: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let t = target.clone();
    let mut env = Env::with(|c| {
        c.test_before_task_write = Some(TestHook(Arc::new(move |inner: &ServerInner| {
            let id = t.lock().unwrap().clone();
            if !id.is_empty() && f.fetch_add(1, Ordering::SeqCst) == 0 {
                let r = call(
                    inner,
                    "conversation.delete",
                    serde_json::json!({"conversationId": id}),
                );
                let token = r["ok"]["confirmation"]["token"]
                    .as_str()
                    .unwrap()
                    .to_string();
                let r = call(
                    inner,
                    "conversation.delete",
                    serde_json::json!({"conversationId": id, "confirmToken": token}),
                );
                assert_eq!(r["ok"], serde_json::json!({"deleted": true}), "{r}");
            }
        })));
    });
    *target.lock().unwrap() = env.conversation_id.clone();
    let e = env.err(
        "conversation.send",
        serde_json::json!({"conversationId": env.conversation_id, "content": "x"}),
    );
    assert_eq!(fired.load(Ordering::SeqCst), 1);
    assert_eq!(e["code"], "NOT_FOUND", "{e}");
    assert_eq!(e["message"], MSG_CONV_NOT_FOUND);
    assert_eq!(env.count("SELECT COUNT(*) FROM messages"), 0);
    assert_eq!(env.count("SELECT COUNT(*) FROM tasks"), 0);
}

// ---------------------------------------------------------------------------
// conversation.delete
// ---------------------------------------------------------------------------

/// Every row that belongs to conversation `cid`, per table.
fn conversation_rows(env: &Env, cid: &str) -> Vec<(&'static str, i64)> {
    let tasks = format!("(SELECT id FROM tasks WHERE conversation_id='{cid}')");
    [
        (
            "conversations",
            format!("SELECT COUNT(*) FROM conversations WHERE id='{cid}'"),
        ),
        (
            "messages",
            format!("SELECT COUNT(*) FROM messages WHERE conversation_id='{cid}'"),
        ),
        (
            "agent_sessions",
            format!("SELECT COUNT(*) FROM agent_sessions WHERE conversation_id='{cid}'"),
        ),
        (
            "tasks",
            format!("SELECT COUNT(*) FROM tasks WHERE conversation_id='{cid}'"),
        ),
        (
            "task_events",
            format!("SELECT COUNT(*) FROM task_events WHERE task_id IN {tasks}"),
        ),
        (
            "task_artifacts",
            format!("SELECT COUNT(*) FROM task_artifacts WHERE task_id IN {tasks}"),
        ),
        (
            "verifications",
            format!("SELECT COUNT(*) FROM verifications WHERE task_id IN {tasks}"),
        ),
        (
            "client_state.selected_conversation",
            format!("SELECT COUNT(*) FROM client_state WHERE selected_conversation='{cid}'"),
        ),
    ]
    .into_iter()
    .map(|(t, sql)| (t, env.count(&sql)))
    .collect()
}

/// Seed the rows no protocol method writes yet, for task `task` of `cid`.
fn seed_dependents(env: &Env, cid: &str, task: &str, client: &str) {
    env.exec(&format!(
        "INSERT INTO task_artifacts (id, task_id, kind, file_path) VALUES ('art-{task}', '{task}', 'log', '/x');
         INSERT INTO verifications (id, task_id, command_label, created_at) VALUES ('ver-{task}', '{task}', 'test', 't');
         INSERT INTO agent_sessions (id, conversation_id, provider) VALUES ('ses-{cid}', '{cid}', 'codex');
         INSERT INTO client_state (client_id, project_id, selected_conversation) VALUES ('{client}', '{}', '{cid}');",
        env.project_id
    ));
}

#[test]
fn delete_two_step_removes_every_dependent_row_and_never_touches_the_host() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    // A finished host_worktree task (worktree dir + sandpane/<id> branch)...
    let task = create_task(
        &env.inner,
        &cid,
        "implement the feature",
        Some(TaskWorkspaceRequest {
            mode: WorkspaceMode::HostWorktree,
            repo_path: Some(env.repo_str()),
        }),
    )
    .unwrap_or_else(|f| panic!("create_task: {:?} {}", f.code, f.message));
    env.ok("task.cancel", serde_json::json!({"taskId": task.id}));
    // ...and a keyed task we then cancel (its key row must survive).
    let sent = env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": cid, "content": "second", "idempotencyKey": "del-k"}),
    );
    env.ok("task.cancel", serde_json::json!({"taskId": sent["id"]}));
    seed_dependents(&env, &cid, &task.id, "vscode");
    // A bystander conversation in the SAME project, fully populated.
    let by = env.new_conversation("Bystander");
    let by_sent = env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": by, "content": "bystander"}),
    );
    seed_dependents(&env, &by, by_sent["id"].as_str().unwrap(), "desktop");
    let bystander_before = conversation_rows(&env, &by);
    assert!(
        bystander_before.iter().all(|(_, n)| *n > 0),
        "{bystander_before:?}"
    );
    let owned_before = conversation_rows(&env, &cid);
    assert_eq!(
        owned_before,
        vec![
            ("conversations", 1),
            ("messages", 2),
            ("agent_sessions", 1),
            ("tasks", 2),
            ("task_events", owned_before[4].1),
            ("task_artifacts", 1),
            ("verifications", 1),
            ("client_state.selected_conversation", 1),
        ]
    );
    assert!(owned_before[4].1 >= 6, "events seeded: {owned_before:?}");

    let worktree: PathBuf = {
        let db = env.inner.lock_db();
        let p: String = db
            .conn()
            .query_row(
                "SELECT worktree_path FROM tasks WHERE id=?1",
                [&task.id],
                |r| r.get(0),
            )
            .unwrap();
        PathBuf::from(p)
    };
    assert!(worktree.starts_with(&env.root) && worktree.is_dir());
    let head_before = git(&env.repo, &["rev-parse", "HEAD"]);
    let branches_before = git(&env.repo, &["branch", "--list", "sandpane/*"]);
    assert!(!branches_before.is_empty());
    let keys_before = env.count("SELECT COUNT(*) FROM idempotency_keys");

    // Step 1: describes, changes nothing.
    let snapshot = env.snapshot();
    let step1 = env.ok("conversation.delete", env.cid());
    assert_eq!(keys(&step1), ["confirmation"], "{step1}");
    let c = &step1["confirmation"];
    assert_eq!(
        keys(c),
        [
            "action",
            "expiresAt",
            "external",
            "impact",
            "target",
            "token"
        ]
    );
    assert_eq!(c["action"], "conversation.delete");
    assert_eq!(
        c["target"],
        serde_json::json!({"name": "Atlas chat", "id": cid})
    );
    assert_eq!(c["external"], false);
    let token = c["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);
    let impact: Vec<&str> = c["impact"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap())
        .collect();
    assert_eq!(
        impact,
        vec![
            "deletes conversation Atlas chat and all of its Core records; this cannot be undone",
            "2 messages and 2 tasks are deleted, with their task events, artifacts and \
             verification records",
            "1 Core-allocated worktree directory and 1 task branch in host repositories are left \
             in place; Core never touches host files, worktrees or branches",
            "the sandbox chosen at creation (atlas-auth) is not touched",
        ]
    );
    assert_eq!(env.snapshot(), snapshot, "step 1 changed nothing");

    // Step 2: a rename between the steps does not invalidate the token.
    env.ok(
        "conversation.rename",
        serde_json::json!({"conversationId": cid, "title": "Atlas chat renamed"}),
    );
    let step2 = env.ok(
        "conversation.delete",
        serde_json::json!({"conversationId": cid, "confirmToken": token}),
    );
    assert_eq!(step2, serde_json::json!({"deleted": true}));
    for (table, n) in conversation_rows(&env, &cid) {
        assert_eq!(n, 0, "{table} still holds rows of the deleted conversation");
    }
    // client_state: the row survives, only the selection is cleared.
    assert_eq!(
        env.count(
            "SELECT COUNT(*) FROM client_state WHERE client_id='vscode' \
             AND selected_conversation IS NULL"
        ),
        1
    );
    assert_eq!(
        conversation_rows(&env, &by),
        bystander_before,
        "bystander untouched"
    );
    assert_eq!(
        env.count("SELECT COUNT(*) FROM projects"),
        1,
        "project kept"
    );
    assert_eq!(env.count("SELECT COUNT(*) FROM repositories"), 1);
    assert_eq!(
        env.count("SELECT COUNT(*) FROM idempotency_keys"),
        keys_before,
        "idempotency rows are not touched"
    );
    // The host is untouched: worktree dir, task branch, HEAD and files.
    assert!(worktree.is_dir(), "worktree left in place");
    assert_eq!(git(&env.repo, &["rev-parse", "HEAD"]), head_before);
    assert_eq!(
        git(&env.repo, &["branch", "--list", "sandpane/*"]),
        branches_before
    );
    assert_eq!(
        std::fs::read_to_string(env.repo.join("app.txt")).unwrap(),
        "base\n"
    );
    for m in [
        "conversation.history",
        "conversation.export",
        "conversation.archive",
        "conversation.delete",
    ] {
        let e = env.err(m, env.cid());
        assert_eq!(e["code"], "NOT_FOUND", "{m}");
    }
}

#[test]
fn delete_impact_without_tasks_or_sandbox() {
    let mut env = Env::new();
    let id = env.new_conversation("Empty");
    let c = env.ok(
        "conversation.delete",
        serde_json::json!({"conversationId": id}),
    );
    assert_eq!(
        c["confirmation"]["impact"],
        serde_json::json!([
            "deletes conversation Empty and all of its Core records; this cannot be undone",
            "0 messages and 0 tasks are deleted, with their task events, artifacts and \
             verification records",
            "0 Core-allocated worktree directories and 0 task branches in host repositories are \
             left in place; Core never touches host files, worktrees or branches",
            "no sandbox was chosen at creation; no sandbox is touched",
        ])
    );
}

#[test]
fn delete_token_rules_refuse_and_delete_nothing() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    let other = env.new_conversation("Other");
    let before = env.snapshot();
    let step2 = |t: &str| serde_json::json!({"conversationId": cid, "confirmToken": t});
    for t in ["", "not-a-token", &"0".repeat(64)] {
        let e = env.err("conversation.delete", step2(t));
        assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
        assert_eq!(e["message"], TOKEN_REJECTED_MESSAGE);
    }
    // A token bound to ANOTHER conversation id is refused and burned.
    let other_token = env.token(&other);
    let e = env.err("conversation.delete", step2(&other_token));
    assert_eq!(e["code"], "VALIDATION_FAILED");
    let e = env.err(
        "conversation.delete",
        serde_json::json!({"conversationId": other, "confirmToken": other_token}),
    );
    assert_eq!(
        e["code"], "VALIDATION_FAILED",
        "burned by the mismatched attempt"
    );
    // A project.delete token is not a conversation.delete token.
    let ptoken = env.ok(
        "project.delete",
        serde_json::json!({"projectId": env.project_id}),
    )["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let e = env.err(
        "conversation.delete",
        serde_json::json!({"conversationId": env.project_id, "confirmToken": ptoken}),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED");
    assert_eq!(env.snapshot(), before, "nothing deleted");

    // Expired token (TTL shortened through CoreConfig).
    let mut short = Env::with(|c| c.confirmation_ttl = Some(std::time::Duration::from_millis(50)));
    let scid = short.conversation_id.clone();
    let t = short.token(&scid);
    std::thread::sleep(std::time::Duration::from_millis(120));
    let e = short.err(
        "conversation.delete",
        serde_json::json!({"conversationId": scid, "confirmToken": t}),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED");
    assert_eq!(
        short.count("SELECT COUNT(*) FROM conversations"),
        1,
        "not deleted"
    );
}

#[test]
fn delete_precondition_is_checked_at_both_steps() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    // Step 1 refuses while a task is not terminal (fail closed on unknown).
    for status in [
        "created",
        "queued",
        "running",
        "awaiting_review",
        "not-a-status",
    ] {
        env.exec(&format!(
            "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at) \
             VALUES ('t-{status}', '{cid}', '{status}', 't', 't')"
        ));
        let e = env.err("conversation.delete", env.cid());
        assert_eq!(e["code"], "CONFLICT", "{status}: {e}");
        assert_eq!(e["message"], MSG_CONV_HAS_TASKS, "{status}");
        env.exec(&format!("DELETE FROM tasks WHERE id='t-{status}'"));
    }
    for status in [
        "completed",
        "rejected",
        "failed",
        "cancelled",
        "interrupted",
    ] {
        env.exec(&format!(
            "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at) \
             VALUES ('t-{status}', '{cid}', '{status}', 't', 't')"
        ));
    }
    // A non-terminal task of ANOTHER conversation does not block this one.
    let other = env.new_conversation("Other");
    env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": other, "content": "queued elsewhere"}),
    );
    let t = env.token(&cid);
    // Step 2 re-checks inside the delete transaction: a task created between
    // the steps refuses the delete, and nothing is deleted.
    env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": cid, "content": "late"}),
    );
    let before = env.snapshot();
    let e = env.err(
        "conversation.delete",
        serde_json::json!({"conversationId": cid, "confirmToken": t}),
    );
    assert_eq!(e["code"], "CONFLICT");
    assert_eq!(e["message"], MSG_CONV_HAS_TASKS);
    assert_eq!(env.snapshot(), before, "nothing deleted");
    // The token was burned by the refused attempt.
    env.exec(&format!(
        "UPDATE tasks SET status='cancelled' WHERE conversation_id='{cid}'"
    ));
    let e = env.err(
        "conversation.delete",
        serde_json::json!({"conversationId": cid, "confirmToken": t}),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED");
    // With every task terminal, the two steps delete it.
    let t = env.token(&cid);
    env.ok(
        "conversation.delete",
        serde_json::json!({"conversationId": cid, "confirmToken": t}),
    );
    assert_eq!(
        conversation_rows(&env, &cid)
            .iter()
            .map(|r| r.1)
            .sum::<i64>(),
        0
    );
}

// ---------------------------------------------------------------------------
// conversation.export
// ---------------------------------------------------------------------------

const GH: &str = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

#[test]
fn export_is_redacted_with_the_documented_shape() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    env.ok(
        "conversation.rename",
        serde_json::json!({"conversationId": cid, "title": format!("deploy with {GH}")}),
    );
    for content in [
        format!("my token is {GH} ok"),
        "PASSWORD=hunter2\nclone https://u:p@h.invalid/".to_string(),
        "nothing secret — ü".to_string(),
    ] {
        env.ok(
            "conversation.send",
            serde_json::json!({"conversationId": cid, "content": content}),
        );
    }
    let x = env.ok("conversation.export", env.cid());
    assert_eq!(
        keys(&x),
        [
            "conversation",
            "exportedAt",
            "format",
            "messages",
            "nextSequence",
            "redaction",
            "truncated"
        ]
    );
    assert_eq!(x["format"], "sandpane.conversation-export.v1");
    assert_eq!(x["exportedAt"].as_str().unwrap().len(), 20);
    assert_eq!(x["conversation"]["title"], "deploy with [REDACTED:token]");
    assert_eq!(x["conversation"]["id"], cid.as_str());
    let contents: Vec<&str> = x["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["content"].as_str().unwrap())
        .collect();
    assert_eq!(
        contents,
        [
            "my token is [REDACTED:token] ok",
            "PASSWORD=*******\nclone https://***@h.invalid/",
            "nothing secret — ü",
        ]
    );
    assert_eq!(
        keys(&x["messages"][0]),
        ["content", "conversationId", "id", "role", "sequence"]
    );
    assert_eq!(x["truncated"], false);
    assert_eq!(x["nextSequence"], 3);
    assert_eq!(
        x["redaction"],
        serde_json::json!({
            "bestEffort": true, "replacements": 4,
            "byKind": {"env-secret": 1, "token": 2, "url-credentials": 1}
        })
    );
    // Nothing was redacted in storage: history is verbatim.
    let h = env.ok("conversation.history", env.cid());
    assert_eq!(h["messages"][0]["content"], format!("my token is {GH} ok"));
    // An empty page past the end: nothing replaced, byKind empty.
    let empty = env.ok(
        "conversation.export",
        serde_json::json!({"conversationId": cid, "afterSequence": 3}),
    );
    assert_eq!(empty["messages"], serde_json::json!([]));
    assert_eq!(empty["nextSequence"], 3);
    // The title is redacted on every page but COUNTED only on the first
    // (afterSequence absent or 0), so clients can sum pages.
    assert_eq!(
        empty["conversation"]["title"],
        "deploy with [REDACTED:token]"
    );
    assert_eq!(
        empty["redaction"],
        serde_json::json!({"bestEffort": true, "replacements": 0, "byKind": {}})
    );
}

#[test]
fn export_pages_by_limit_with_strictly_increasing_next_sequence() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    for i in 0..5 {
        env.ok(
            "conversation.send",
            serde_json::json!({"conversationId": cid, "content": format!("m{i}")}),
        );
    }
    env.ok("conversation.archive", env.cid());
    let mut after = 0;
    let mut seen = vec![];
    for page in 0.. {
        assert!(page < 10, "paging did not converge");
        let x = env.ok(
            "conversation.export",
            serde_json::json!({"conversationId": cid, "afterSequence": after, "limit": 2}),
        );
        let n = x["nextSequence"].as_i64().unwrap();
        for m in x["messages"].as_array().unwrap() {
            seen.push(m["content"].as_str().unwrap().to_string());
        }
        if x["truncated"] == false {
            break;
        }
        assert!(n > after, "nextSequence strictly increases");
        after = n;
    }
    assert_eq!(
        seen,
        ["m0", "m1", "m2", "m3", "m4"],
        "archived conversation exportable"
    );
    // limit is clamped (0 -> 1), negative afterSequence normalised.
    let x = env.ok(
        "conversation.export",
        serde_json::json!({"conversationId": cid, "afterSequence": -5, "limit": 0}),
    );
    assert_eq!(x["messages"].as_array().unwrap().len(), 1);
    assert_eq!(x["truncated"], true);
}

/// Coordinator decision: title replacements are counted on the first page
/// only, so summing every page counts a secret in the title exactly once.
#[test]
fn export_counts_title_replacements_on_the_first_page_only() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    env.ok(
        "conversation.rename",
        serde_json::json!({"conversationId": cid, "title": format!("ship {GH}")}),
    );
    for content in [
        "plain zero".to_string(),
        "plain one".to_string(),
        format!("key {GH}"),
    ] {
        env.ok(
            "conversation.send",
            serde_json::json!({"conversationId": cid, "content": content}),
        );
    }
    let p1 = env.ok(
        "conversation.export",
        serde_json::json!({"conversationId": cid, "limit": 2}),
    );
    assert_eq!(p1["truncated"], true);
    let p2 = env.ok(
        "conversation.export",
        serde_json::json!({"conversationId": cid, "afterSequence": p1["nextSequence"], "limit": 2}),
    );
    assert_eq!(p2["truncated"], false);
    for p in [&p1, &p2] {
        assert_eq!(
            p["conversation"]["title"], "ship [REDACTED:token]",
            "every page"
        );
    }
    assert_eq!(
        p1["redaction"]["byKind"],
        serde_json::json!({"token": 1}),
        "title"
    );
    assert_eq!(
        p2["redaction"]["byKind"],
        serde_json::json!({"token": 1}),
        "message"
    );
    let sum = p1["redaction"]["replacements"].as_u64().unwrap()
        + p2["redaction"]["replacements"].as_u64().unwrap();
    assert_eq!(sum, 2, "title once + one message");
}

/// Review I3: a cancel + full delete that lands AFTER send committed its task
/// but BEFORE the post-commit scaffold event is appended. No new seam: the
/// test holds the scheduler mutex, which send takes between its commit and
/// that append (`task.cancel` / `conversation.delete` never take it). Send
/// must answer the summary it already built, never INTERNAL.
#[test]
fn send_answers_its_summary_when_the_task_is_deleted_before_the_post_commit_event() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    let inner = env.inner.clone();
    let held = inner.lock_scheduler();
    let (inner2, cid2) = (env.inner.clone(), cid.clone());
    let sender = std::thread::spawn(move || {
        call(
            &inner2,
            "conversation.send",
            serde_json::json!({"conversationId": cid2, "content": "racing"}),
        )
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let task_id = loop {
        let found: Option<String> = {
            let db = env.inner.lock_db();
            db.conn()
                .query_row(
                    "SELECT id FROM tasks WHERE conversation_id = ?1",
                    [&cid],
                    |r| r.get(0),
                )
                .ok()
        };
        if let Some(id) = found {
            break id;
        }
        assert!(std::time::Instant::now() < deadline, "send never committed");
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    // Send is now blocked on the scheduler, after its commit.
    env.ok("task.cancel", serde_json::json!({"taskId": task_id}));
    let t = env.token(&cid);
    env.ok(
        "conversation.delete",
        serde_json::json!({"conversationId": cid, "confirmToken": t}),
    );
    drop(held);
    let r = sender.join().unwrap();
    assert!(r.get("ok").is_some(), "send must not fail: {r}");
    assert_eq!(r["ok"]["id"], task_id.as_str());
    assert_eq!(r["ok"]["status"], "queued", "the summary it built");
    assert_eq!(env.count("SELECT COUNT(*) FROM tasks"), 0);
    assert_eq!(
        env.count("SELECT COUNT(*) FROM task_events"),
        0,
        "no orphan event"
    );
}

/// The byte ceiling is counted over the RAW rows (under the DB lock), so a
/// page whose rows would shrink under redaction still stops where the raw
/// rows reach `MAX_HISTORY_BYTES`; the first oversize row always passes.
#[test]
fn export_byte_ceiling_counts_raw_rows_and_the_first_oversize_row_passes() {
    let mut env = Env::new();
    let cid = env.conversation_id.clone();
    // Rows larger than any send allows (direct inserts): each is one
    // unterminated PEM block, so it redacts to a 24-byte marker.
    let row = |n: usize| format!("-----BEGIN PRIVATE KEY-----{}", "A".repeat(n));
    let big = MAX_HISTORY_BYTES * 2 / 5; // three of these exceed the ceiling
    {
        let db = env.inner.lock_db();
        for seq in 1..=4 {
            db.conn()
                .execute(
                    "INSERT INTO messages (id, conversation_id, role, content, sequence) \
                     VALUES (?1, ?2, 'user', ?3, ?4)",
                    rusqlite::params![format!("m{seq}"), cid, row(big), seq],
                )
                .unwrap();
        }
    }
    let x = env.ok("conversation.export", env.cid());
    let msgs = x["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 2, "raw rows counted: 2 fit, the 3rd does not");
    assert_eq!(x["truncated"], true);
    assert_eq!(x["nextSequence"], 2);
    assert!(msgs
        .iter()
        .all(|m| m["content"] == "[REDACTED:private-key]"));
    assert_eq!(x["redaction"]["byKind"]["private-key"], 2);
    // History agrees on the same page boundary.
    let h = env.ok("conversation.history", env.cid());
    assert_eq!(h["messages"].as_array().unwrap().len(), 2);
    // A first row larger than the whole ceiling still passes, alone.
    env.exec(&format!(
        "UPDATE messages SET content = '{}' WHERE id = 'm3'",
        row(MAX_HISTORY_BYTES + 1024)
    ));
    let x = env.ok(
        "conversation.export",
        serde_json::json!({"conversationId": cid, "afterSequence": 2}),
    );
    assert_eq!(x["messages"].as_array().unwrap().len(), 1);
    assert_eq!(x["truncated"], true);
    assert_eq!(x["nextSequence"], 3);
}

/// §3.3 item 6: redaction runs AFTER the DB lock is released.
#[test]
fn export_redaction_runs_with_the_db_lock_released() {
    let checked = Arc::new(AtomicBool::new(false));
    let free = Arc::new(AtomicBool::new(false));
    let (c, f) = (checked.clone(), free.clone());
    let mut env = Env::with(|cfg| {
        cfg.test_before_export_redaction = Some(TestHook(Arc::new(move |inner: &ServerInner| {
            c.store(true, Ordering::SeqCst);
            f.store(inner.db.try_lock().is_ok(), Ordering::SeqCst);
        })));
    });
    env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": env.conversation_id, "content": GH}),
    );
    env.ok("conversation.export", env.cid());
    assert!(checked.load(Ordering::SeqCst), "hook ran");
    assert!(
        free.load(Ordering::SeqCst),
        "DB mutex was held during redaction"
    );
}

#[test]
fn probe_advertises_the_conversation_lifecycle_methods_and_feature() {
    let mut env = Env::new();
    let p = env.ok("system.probe", serde_json::json!({}));
    let methods: Vec<&str> = p["methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.as_str().unwrap())
        .collect();
    assert_eq!(methods.len(), 27);
    for m in [
        "conversation.rename",
        "conversation.archive",
        "conversation.unarchive",
        "conversation.delete",
        "conversation.export",
    ] {
        assert!(methods.contains(&m), "{m} not advertised");
    }
    assert!(p["features"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("conversation-sandbox-id")));
}
