//! A3a — project lifecycle (design 2026-10-09 §3.2): `project.update`,
//! `project.archive` / `project.unarchive`, `project.delete` (two-step
//! confirmation token bound to the project id), `project.add_repository`,
//! `project.remove_repository`, `project.list includeArchived`, and the
//! archived-project refusals. Real disposable Git repositories; every RPC goes
//! through the production dispatch (`handle_line`). No sbx is located or run
//! here (the locator searches nowhere); the sbx-backed A3a paths
//! (`sandbox.create` on an archived project, delete during an in-flight
//! create) live in `service_integration.rs` with its stand-in executable.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sandpane_core::sbx::SbxLocator;
use sandpane_core::Database;
use sandpane_protocol::{WorkspaceMode, PROTOCOL_VERSION};
use sandpane_service::confirm::TOKEN_REJECTED_MESSAGE;
use sandpane_service::{create_task, CoreConfig, ServerInner, TaskWorkspaceRequest};

// §3.2 item 8 — clients match on these exact strings.
const MSG_ARCHIVED: &str = "project is archived; unarchive it first; nothing was changed";
const MSG_HAS_TASKS: &str =
    "project has tasks that are not finished; cancel or finish them first; nothing was deleted";
const MSG_HAS_SANDBOXES: &str = "project has sandboxes; remove them first; nothing was deleted";
const MSG_REPO_IN_USE: &str =
    "repository is used by a task or sandbox of this project; nothing was removed";

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

/// Core over a temp data dir with a worktree root, one project ("Atlas
/// Demo") with one registered repository and one conversation.
struct Env {
    _dir: tempfile::TempDir,
    base: PathBuf,
    inner: Arc<ServerInner>,
    repo: PathBuf,
    root: PathBuf,
    project_id: String,
    conversation_id: String,
    seq: u32,
}

impl Env {
    fn new() -> Self {
        Self::with_ttl(None)
    }

    fn with_ttl(ttl: Option<std::time::Duration>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let repo = base.join("Atlas Demo repo");
        init_repo(&repo);
        let root = base.join("data").join("worktrees");
        let db = Database::open(&base.join("core.sqlite3")).unwrap();
        let inner = ServerInner::with_config(
            db,
            SbxLocator::with_search(None, vec![]),
            CoreConfig {
                worktrees_root: Some(root.clone()),
                confirmation_ttl: ttl,
                ..CoreConfig::default()
            },
        );
        let mut env = Self {
            _dir: dir,
            base,
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
            serde_json::json!({"projectId": env.project_id, "agentId": "codex"}),
        );
        env.conversation_id = conv["id"].as_str().unwrap().to_string();
        env
    }

    fn repo_str(&self) -> String {
        self.repo.display().to_string()
    }

    /// The raw response frame (printed so the report can quote real frames).
    fn rpc(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        self.seq += 1;
        let frame = serde_json::json!({
            "v": PROTOCOL_VERSION, "id": self.seq.to_string(), "method": method, "params": params
        });
        let out = sandpane_service::handle_line(&self.inner, &frame.to_string());
        println!(">> {frame}\n<< {out}");
        serde_json::from_str(&out).unwrap()
    }

    /// `params` absent from the frame entirely (what an older client sends).
    fn rpc_without_params(&mut self, method: &str) -> serde_json::Value {
        self.seq += 1;
        let frame = serde_json::json!({"v": PROTOCOL_VERSION, "id": self.seq.to_string(), "method": method});
        let out = sandpane_service::handle_line(&self.inner, &frame.to_string());
        println!(">> {frame}\n<< {out}");
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

    fn pid(&self) -> serde_json::Value {
        serde_json::json!({"projectId": self.project_id})
    }

    fn worktree_task(&self) -> sandpane_protocol::TaskSummary {
        create_task(
            &self.inner,
            &self.conversation_id,
            "implement the feature",
            Some(TaskWorkspaceRequest {
                mode: WorkspaceMode::HostWorktree,
                repo_path: Some(self.repo_str()),
            }),
        )
        .unwrap_or_else(|f| panic!("create_task failed: {:?} {}", f.code, f.message))
    }

    fn count(&self, sql: &str) -> i64 {
        let db = self.inner.lock_db();
        db.conn().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn exec(&self, sql: &str) {
        self.inner.lock_db().conn().execute_batch(sql).unwrap();
    }

    /// Every row count Core holds, by table — "nothing changed" means equal.
    fn snapshot(&self) -> Vec<(&'static str, i64)> {
        TABLES
            .iter()
            .map(|t| (*t, self.count(&format!("SELECT COUNT(*) FROM {t}"))))
            .collect()
    }

    fn project(&mut self) -> serde_json::Value {
        let list = self.ok("project.list", serde_json::json!({"includeArchived": true}));
        list.as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == self.project_id.as_str())
            .cloned()
            .expect("project listed")
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
// project.update
// ---------------------------------------------------------------------------

#[test]
fn project_update_renames_describes_and_clears() {
    let mut env = Env::new();
    let p = env.ok(
        "project.update",
        serde_json::json!({"projectId": env.project_id, "name": "Atlas Demo 2"}),
    );
    assert_eq!(p["name"], "Atlas Demo 2");
    assert_eq!(p["description"], "");
    assert_eq!(p["repositories"][0], env.repo_str().as_str());
    assert_eq!(
        keys(&p),
        ["createdAt", "description", "id", "name", "repositories"],
        "no archivedAt on a live project: {p}"
    );
    let p = env.ok(
        "project.update",
        serde_json::json!({"projectId": env.project_id, "description": "line one\nline two"}),
    );
    assert_eq!(p["name"], "Atlas Demo 2", "name untouched");
    assert_eq!(p["description"], "line one\nline two");
    assert_eq!(
        env.project()["description"],
        "line one\nline two",
        "persisted"
    );
    let p = env.ok(
        "project.update",
        serde_json::json!({"projectId": env.project_id, "description": ""}),
    );
    assert_eq!(p["description"], "", "empty clears it");
}

#[test]
fn project_update_refusals_change_nothing() {
    let mut env = Env::new();
    let before = env.project();
    for (params, code) in [
        (
            serde_json::json!({"projectId": env.project_id}),
            "VALIDATION_FAILED",
        ),
        (
            serde_json::json!({"projectId": env.project_id, "name": ""}),
            "VALIDATION_FAILED",
        ),
        (
            serde_json::json!({"projectId": env.project_id, "name": "x".repeat(121)}),
            "VALIDATION_FAILED",
        ),
        (
            serde_json::json!({"projectId": env.project_id, "name": "ok", "description": "a\tb"}),
            "VALIDATION_FAILED",
        ),
        (
            serde_json::json!({"projectId": env.project_id, "description": "x".repeat(2001)}),
            "VALIDATION_FAILED",
        ),
        (
            serde_json::json!({"projectId": "no-such-project", "name": "Nova Demo"}),
            "NOT_FOUND",
        ),
    ] {
        let e = env.err("project.update", params.clone());
        assert_eq!(e["code"], code, "{params}: {e}");
    }
    assert_eq!(env.project(), before);
}

// ---------------------------------------------------------------------------
// archive / unarchive / list
// ---------------------------------------------------------------------------

#[test]
fn archive_and_unarchive_are_idempotent_and_list_filters() {
    let mut env = Env::new();
    let pid = env.pid();
    let a = env.ok("project.archive", pid.clone());
    let stamp = a["archivedAt"].as_str().expect("archivedAt").to_string();
    assert_eq!(stamp.len(), "2026-10-10T00:00:00Z".len(), "{stamp}");
    let again = env.ok("project.archive", pid.clone());
    assert_eq!(again, a, "idempotent: archivedAt is never re-stamped");

    // Older clients (no params at all, or {}) never see archived projects.
    let none = env.rpc_without_params("project.list");
    assert_eq!(none["ok"], serde_json::json!([]), "{none}");
    assert_eq!(
        env.ok("project.list", serde_json::json!({})),
        serde_json::json!([])
    );
    assert_eq!(
        env.ok(
            "project.list",
            serde_json::json!({"includeArchived": false})
        ),
        serde_json::json!([])
    );
    let all = env.ok("project.list", serde_json::json!({"includeArchived": true}));
    assert_eq!(all[0]["archivedAt"], stamp.as_str());

    let u = env.ok("project.unarchive", pid.clone());
    assert!(u.get("archivedAt").is_none(), "{u}");
    assert_eq!(env.ok("project.unarchive", pid.clone()), u, "idempotent");
    assert_eq!(
        env.ok("project.list", serde_json::json!({}))[0]["id"],
        env.project_id.as_str()
    );

    for m in ["project.archive", "project.unarchive"] {
        let e = env.err(m, serde_json::json!({"projectId": "no-such-project"}));
        assert_eq!(e["code"], "NOT_FOUND", "{m}: {e}");
    }
}

#[test]
fn archived_project_refuses_mutations_with_the_exact_message_and_changes_nothing() {
    let mut env = Env::new();
    let (_other, other_repo) = {
        let d = tempfile::tempdir().unwrap();
        let r = std::fs::canonicalize(d.path())
            .unwrap()
            .join("Nova Demo repo");
        init_repo(&r);
        (d, r.display().to_string())
    };
    env.ok("project.archive", env.pid());
    let before = env.snapshot();
    let conv = env.conversation_id.clone();
    let pid = env.project_id.clone();
    for (method, params) in [
        (
            "conversation.create",
            serde_json::json!({"projectId": pid, "agentId": "codex"}),
        ),
        (
            "conversation.send",
            serde_json::json!({"conversationId": conv, "content": "hello"}),
        ),
        (
            "conversation.send",
            serde_json::json!({"conversationId": conv, "content": "hello", "idempotencyKey": "k1"}),
        ),
        (
            "project.update",
            serde_json::json!({"projectId": pid, "name": "Atlas Demo 2"}),
        ),
        (
            "project.add_repository",
            serde_json::json!({"projectId": pid, "path": other_repo}),
        ),
        (
            "project.remove_repository",
            serde_json::json!({"projectId": pid, "path": env.repo_str()}),
        ),
    ] {
        let e = env.err(method, params);
        assert_eq!(e["code"], "VALIDATION_FAILED", "{method}: {e}");
        assert_eq!(e["message"], MSG_ARCHIVED, "{method}: {e}");
    }
    assert_eq!(env.snapshot(), before, "nothing changed");
    // The archived refusal comes BEFORE any git subprocess: a path that is
    // not a repository still gets the archived message, not a git error.
    let plain = env.base.join("not a repo");
    std::fs::create_dir_all(&plain).unwrap();
    let e = env.err(
        "project.add_repository",
        serde_json::json!({"projectId": pid, "path": plain.display().to_string()}),
    );
    assert_eq!(e["message"], MSG_ARCHIVED, "{e}");
    // Reads keep working.
    env.ok("conversation.list", env.pid());
    env.ok(
        "conversation.history",
        serde_json::json!({"conversationId": conv}),
    );
    env.ok("task.list", env.pid());
}

/// A keyed send that completed BEFORE archiving is still answered from its
/// stored result (A2 lookup first); a NEW key is refused without being
/// burned, so it works after unarchive.
#[test]
fn archived_send_keeps_a2_replays_and_does_not_burn_a_refused_key() {
    let mut env = Env::new();
    let conv = env.conversation_id.clone();
    let send = |key: &str| serde_json::json!({"conversationId": conv, "content": "hello", "idempotencyKey": key});
    // No verified adapter: the task is created and stays queued (honest).
    let first = env.ok("conversation.send", send("before-archive"));
    env.ok("project.archive", env.pid());
    let replay = env.ok("conversation.send", send("before-archive"));
    assert_eq!(replay["replayed"], true, "{replay}");
    assert_eq!(replay["id"], first["id"]);
    let e = env.err("conversation.send", send("after-archive"));
    assert_eq!(e["message"], MSG_ARCHIVED);
    assert_eq!(
        env.count("SELECT COUNT(*) FROM idempotency_keys WHERE key='after-archive'"),
        0,
        "refused key not stored"
    );
    env.ok("project.unarchive", env.pid());
    let later = env.ok("conversation.send", send("after-archive"));
    assert!(later.get("replayed").is_none(), "a first response: {later}");
}

// ---------------------------------------------------------------------------
// project.delete
// ---------------------------------------------------------------------------

/// Seed a dependent row in every table no protocol method writes yet.
fn seed_unreachable_rows(env: &Env, task_id: &str, removed_binding: &str) {
    let (pid, conv) = (&env.project_id, &env.conversation_id);
    env.exec(&format!(
        "INSERT INTO task_artifacts (id, task_id, kind, file_path) VALUES ('art-{task_id}', '{task_id}', 'log', '/x');
         INSERT INTO verifications (id, task_id, command_label, created_at) VALUES ('ver-{task_id}', '{task_id}', 'test', 't');
         INSERT INTO agent_sessions (id, conversation_id, provider) VALUES ('ses-{conv}', '{conv}', 'codex');
         INSERT INTO project_context (project_id, rules_json) VALUES ('{pid}', '{{}}');
         INSERT INTO workflows (id, project_id, definition_json) VALUES ('wf-{pid}', '{pid}', '{{}}');
         INSERT INTO client_state (client_id, project_id) VALUES ('vscode', '{pid}');
         INSERT INTO sandbox_bindings (id, project_id, sandbox_name, workspace_mode, created_at, removed_at, sbx_id)
             VALUES ('{removed_binding}', '{pid}', 'atlas-auth', 'mountless', 't', 't2', 'b5ebec73-e2ae-471a-811a-e011cfb1948e');"
    ));
}

/// Every row this project owns, per table (0 after delete).
fn owned_rows(env: &Env, pid: &str) -> Vec<(&'static str, i64)> {
    let conv = format!("(SELECT id FROM conversations WHERE project_id='{pid}')");
    let tasks = format!("(SELECT id FROM tasks WHERE conversation_id IN {conv})");
    [
        (
            "projects",
            format!("SELECT COUNT(*) FROM projects WHERE id='{pid}'"),
        ),
        (
            "repositories",
            format!("SELECT COUNT(*) FROM repositories WHERE project_id='{pid}'"),
        ),
        (
            "sandbox_bindings",
            format!("SELECT COUNT(*) FROM sandbox_bindings WHERE project_id='{pid}'"),
        ),
        (
            "conversations",
            format!("SELECT COUNT(*) FROM conversations WHERE project_id='{pid}'"),
        ),
        (
            "messages",
            format!("SELECT COUNT(*) FROM messages WHERE conversation_id IN {conv}"),
        ),
        (
            "agent_sessions",
            format!("SELECT COUNT(*) FROM agent_sessions WHERE conversation_id IN {conv}"),
        ),
        (
            "tasks",
            format!("SELECT COUNT(*) FROM tasks WHERE conversation_id IN {conv}"),
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
            "project_context",
            format!("SELECT COUNT(*) FROM project_context WHERE project_id='{pid}'"),
        ),
        (
            "workflows",
            format!("SELECT COUNT(*) FROM workflows WHERE project_id='{pid}'"),
        ),
        (
            "client_state",
            format!("SELECT COUNT(*) FROM client_state WHERE project_id='{pid}'"),
        ),
    ]
    .into_iter()
    .map(|(t, sql)| (t, env.count(&sql)))
    .collect()
}

#[test]
fn project_delete_two_step_removes_every_row_and_never_touches_the_host() {
    let mut env = Env::new();
    let pid = env.project_id.clone();
    let conv = env.conversation_id.clone();
    // A finished host_worktree task (worktree dir + sandpane/<id> branch)...
    let task = env.worktree_task();
    env.ok("task.cancel", serde_json::json!({"taskId": task.id}));
    // ...a keyed queued task we then cancel, so message/event rows exist...
    let sent = env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": conv, "content": "second", "idempotencyKey": "del-k"}),
    );
    env.ok("task.cancel", serde_json::json!({"taskId": sent["id"]}));
    seed_unreachable_rows(&env, &task.id, "audit-binding");
    // A bystander project whose rows must all survive.
    let other = env.ok("project.create", serde_json::json!({"name": "Nova Demo"}));
    let other_id = other["id"].as_str().unwrap().to_string();
    let other_conv = env.ok(
        "conversation.create",
        serde_json::json!({"projectId": other_id, "agentId": "codex"}),
    );
    env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": other_conv["id"], "content": "bystander"}),
    );
    let bystander_before = owned_rows(&env, &other_id);

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
    assert!(
        worktree.starts_with(&env.root),
        "Core-allocated under the root"
    );
    assert!(
        worktree.is_dir(),
        "worktree allocated: {}",
        worktree.display()
    );
    let head_before = git(&env.repo, &["rev-parse", "HEAD"]);
    let branches_before = git(&env.repo, &["branch", "--list", "sandpane/*"]);
    assert!(!branches_before.is_empty());
    let owned_before = owned_rows(&env, &pid);
    assert!(
        owned_before.iter().all(|(_, n)| *n > 0),
        "every table seeded: {owned_before:?}"
    );
    let keys_before = env.count("SELECT COUNT(*) FROM idempotency_keys");

    // Step 1: describes, changes nothing.
    let snapshot = env.snapshot();
    let step1 = env.ok("project.delete", env.pid());
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
    assert_eq!(c["action"], "project.delete");
    assert_eq!(
        c["target"],
        serde_json::json!({"name": "Atlas Demo", "id": pid})
    );
    assert_eq!(c["external"], false, "a project exists only in Core");
    let token = c["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);
    let impact: Vec<String> = c["impact"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        impact,
        vec![
            "deletes project Atlas Demo and all of its Core records; this cannot be undone"
                .to_string(),
            "1 conversation, 2 messages and 2 tasks are deleted, with their events, artifacts \
             and verification records"
                .to_string(),
            "1 registered repository is unregistered; its files are not touched".to_string(),
            "1 audit record of removed sandboxes is deleted with the project".to_string(),
            "1 Core-allocated worktree directory and 1 task branch in host repositories are \
             left in place; Core never touches host files, branches or sandboxes"
                .to_string(),
        ]
    );
    assert_eq!(env.snapshot(), snapshot, "step 1 changed nothing");

    // Step 2: a rename between the steps does not invalidate the token.
    env.ok(
        "project.update",
        serde_json::json!({"projectId": pid, "name": "Atlas Demo renamed"}),
    );
    let step2 = env.ok(
        "project.delete",
        serde_json::json!({"projectId": pid, "confirmToken": token}),
    );
    assert_eq!(step2, serde_json::json!({"deleted": true}));
    for (table, n) in owned_rows(&env, &pid) {
        assert_eq!(n, 0, "{table} still holds rows of the deleted project");
    }
    assert_eq!(
        owned_rows(&env, &other_id),
        bystander_before,
        "bystander untouched"
    );
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
    // And the project is gone for every method.
    let e = env.err("project.delete", serde_json::json!({"projectId": pid}));
    assert_eq!(e["code"], "NOT_FOUND");
}

#[test]
fn project_delete_token_rules_refuse_and_delete_nothing() {
    let mut env = Env::new();
    let pid = env.project_id.clone();
    let before = env.snapshot();
    let step2 = |t: &str| serde_json::json!({"projectId": pid, "confirmToken": t});

    // Unknown / malformed token.
    for t in ["", "not-a-token", &"0".repeat(64)] {
        let e = env.err("project.delete", step2(t));
        assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
        assert_eq!(e["message"], TOKEN_REJECTED_MESSAGE);
    }
    // A token for ANOTHER project is refused and burned.
    let other = env.ok("project.create", serde_json::json!({"name": "Nova Demo"}));
    let other_token = env.ok(
        "project.delete",
        serde_json::json!({"projectId": other["id"]}),
    )["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let e = env.err("project.delete", step2(&other_token));
    assert_eq!(e["code"], "VALIDATION_FAILED");
    let e = env.err(
        "project.delete",
        serde_json::json!({"projectId": other["id"], "confirmToken": other_token}),
    );
    assert_eq!(
        e["code"], "VALIDATION_FAILED",
        "burned by the mismatched attempt"
    );
    // Reused token: the first use deletes; nothing to re-use afterwards is
    // shown on a fresh project below. Here: use once on a refused attempt.
    let t = env.ok("project.delete", env.pid())["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    env.exec(&format!(
        "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at) \
         VALUES ('blocker', '{}', 'running', 't', 't')",
        env.conversation_id
    ));
    let e = env.err("project.delete", step2(&t));
    assert_eq!(e["code"], "CONFLICT");
    env.exec("UPDATE tasks SET status='completed' WHERE id='blocker'");
    let e = env.err("project.delete", step2(&t));
    assert_eq!(
        e["code"], "VALIDATION_FAILED",
        "single use, even after a refusal"
    );
    env.exec("DELETE FROM tasks WHERE id='blocker'");
    let mut after = env.snapshot();
    after.retain(|(t, _)| *t != "projects");
    let mut expect = before.clone();
    expect.retain(|(t, _)| *t != "projects");
    assert_eq!(after, expect, "nothing deleted");
    assert_eq!(env.project()["id"], pid.as_str());

    // Expired token (TTL shortened through CoreConfig).
    let mut short = Env::with_ttl(Some(std::time::Duration::from_millis(50)));
    let t = short.ok("project.delete", short.pid())["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    std::thread::sleep(std::time::Duration::from_millis(120));
    let e = short.err(
        "project.delete",
        serde_json::json!({"projectId": short.project_id, "confirmToken": t}),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED");
    assert_eq!(
        short.project()["id"],
        short.project_id.as_str(),
        "not deleted"
    );
}

#[test]
fn project_delete_preconditions_are_checked_at_both_steps() {
    let mut env = Env::new();
    let pid = env.project_id.clone();
    let conv = env.conversation_id.clone();
    // Step 1 refuses while a task is not terminal (awaiting_review included).
    for status in ["queued", "running", "awaiting_review", "not-a-status"] {
        env.exec(&format!(
            "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at) \
             VALUES ('t-{status}', '{conv}', '{status}', 't', 't')"
        ));
        let e = env.err("project.delete", env.pid());
        assert_eq!(e["code"], "CONFLICT", "{status}: {e}");
        assert_eq!(e["message"], MSG_HAS_TASKS, "{status}");
        env.exec(&format!("DELETE FROM tasks WHERE id='t-{status}'"));
    }
    // Every terminal status lets step 1 through.
    for status in [
        "completed",
        "rejected",
        "failed",
        "cancelled",
        "interrupted",
    ] {
        env.exec(&format!(
            "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at) \
             VALUES ('t-{status}', '{conv}', '{status}', 't', 't')"
        ));
    }
    env.ok("project.delete", env.pid());
    // A live binding refuses (an audit row, removed_at set, does not).
    env.exec(&format!(
        "INSERT INTO sandbox_bindings (id, project_id, sandbox_name, workspace_mode, created_at) \
         VALUES ('live', '{pid}', 'atlas-auth', 'mountless', 't')"
    ));
    let e = env.err("project.delete", env.pid());
    assert_eq!(e["code"], "CONFLICT");
    assert_eq!(e["message"], MSG_HAS_SANDBOXES);
    env.exec("UPDATE sandbox_bindings SET removed_at='t2' WHERE id='live'");

    // Step 2 re-checks: a token issued while clear is refused once a task
    // appears, and nothing is deleted.
    let t = env.ok("project.delete", env.pid())["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": conv, "content": "late"}),
    );
    let before = env.snapshot();
    let e = env.err(
        "project.delete",
        serde_json::json!({"projectId": pid, "confirmToken": t}),
    );
    assert_eq!(e["code"], "CONFLICT");
    assert_eq!(e["message"], MSG_HAS_TASKS);
    assert_eq!(env.snapshot(), before, "nothing deleted");
    // Same for a live binding appearing between the steps.
    env.exec("UPDATE tasks SET status='cancelled'");
    let t = env.ok("project.delete", env.pid())["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    env.exec("UPDATE sandbox_bindings SET removed_at=NULL WHERE id='live'");
    let e = env.err(
        "project.delete",
        serde_json::json!({"projectId": pid, "confirmToken": t}),
    );
    assert_eq!(e["message"], MSG_HAS_SANDBOXES);
    assert_eq!(env.project()["id"], pid.as_str());

    let e = env.err(
        "project.delete",
        serde_json::json!({"projectId": "no-such-project"}),
    );
    assert_eq!(e["code"], "NOT_FOUND");
}

/// An archived project can still be deleted (archive is not a lock).
#[test]
fn an_archived_project_can_be_deleted() {
    let mut env = Env::new();
    env.ok("project.archive", env.pid());
    let t = env.ok("project.delete", env.pid())["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let done = env.ok(
        "project.delete",
        serde_json::json!({"projectId": env.project_id, "confirmToken": t}),
    );
    assert_eq!(done, serde_json::json!({"deleted": true}));
    assert_eq!(env.count("SELECT COUNT(*) FROM projects"), 0);
}

// ---------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------

#[test]
fn add_repository_registers_the_canonical_top_level_once() {
    let mut env = Env::new();
    let nova = env.base.join("Nova Demo repo");
    init_repo(&nova);
    // Added through a non-canonical spelling: stored canonical.
    let spelled = format!("{}/./", nova.display());
    let p = env.ok(
        "project.add_repository",
        serde_json::json!({"projectId": env.project_id, "path": spelled}),
    );
    assert_eq!(
        p["repositories"],
        serde_json::json!([env.repo_str(), nova.display().to_string()])
    );
    // Already registered: unchanged, no second row.
    let again = env.ok(
        "project.add_repository",
        serde_json::json!({"projectId": env.project_id, "path": nova.display().to_string()}),
    );
    assert_eq!(again, p);
    assert_eq!(env.count("SELECT COUNT(*) FROM repositories"), 2);
}

#[test]
fn add_repository_refusals_register_nothing() {
    let mut env = Env::new();
    let plain = env.base.join("not a repo");
    std::fs::create_dir_all(&plain).unwrap();
    let nested = env.repo.join("sub");
    std::fs::create_dir_all(&nested).unwrap();
    let before = env.snapshot();
    let pid = env.project_id.clone();
    for (path, code) in [
        ("relative/path".to_string(), "VALIDATION_FAILED"),
        (plain.display().to_string(), "VALIDATION_FAILED"),
        (nested.display().to_string(), "VALIDATION_FAILED"),
        (
            env.base.join("missing").display().to_string(),
            "VALIDATION_FAILED",
        ),
        ("/".to_string(), "PERMISSION_DENIED"),
        ("/etc".to_string(), "PERMISSION_DENIED"),
    ] {
        let e = env.err(
            "project.add_repository",
            serde_json::json!({"projectId": pid, "path": path}),
        );
        assert_eq!(e["code"], code, "{path}: {e}");
    }
    let e = env.err(
        "project.add_repository",
        serde_json::json!({"projectId": "no-such-project", "path": env.repo_str()}),
    );
    assert_eq!(e["code"], "NOT_FOUND");
    assert_eq!(env.snapshot(), before);
}

#[test]
fn remove_repository_matches_stored_or_canonical_and_refuses_while_used() {
    let mut env = Env::new();
    let pid = env.project_id.clone();
    let nova = env.base.join("Nova Demo repo");
    init_repo(&nova);
    env.ok(
        "project.add_repository",
        serde_json::json!({"projectId": pid, "path": nova.display().to_string()}),
    );
    // Matched by the canonicalized form of a non-canonical input (symlink).
    let link = env.base.join("nova-link");
    std::os::unix::fs::symlink(&nova, &link).unwrap();
    let p = env.ok(
        "project.remove_repository",
        serde_json::json!({"projectId": pid, "path": link.display().to_string()}),
    );
    assert_eq!(p["repositories"], serde_json::json!([env.repo_str()]));
    assert!(nova.join(".git").is_dir(), "host repository untouched");

    // Referenced by a task (even a finished one): CONFLICT, nothing removed.
    let task = env.worktree_task();
    env.ok("task.cancel", serde_json::json!({"taskId": task.id}));
    let e = env.err(
        "project.remove_repository",
        serde_json::json!({"projectId": pid, "path": env.repo_str()}),
    );
    assert_eq!(e["code"], "CONFLICT");
    assert_eq!(e["message"], MSG_REPO_IN_USE);
    assert_eq!(env.count("SELECT COUNT(*) FROM repositories"), 1);

    // Not registered with this project: NOT_FOUND, nothing removed.
    let e = env.err(
        "project.remove_repository",
        serde_json::json!({"projectId": pid, "path": nova.display().to_string()}),
    );
    assert_eq!(e["code"], "NOT_FOUND");
    // A path that no longer exists on disk still matches its stored row.
    let gone = env.base.join("Orbit Demo repo");
    init_repo(&gone);
    env.ok(
        "project.add_repository",
        serde_json::json!({"projectId": pid, "path": gone.display().to_string()}),
    );
    std::fs::remove_dir_all(&gone).unwrap();
    let p = env.ok(
        "project.remove_repository",
        serde_json::json!({"projectId": pid, "path": gone.display().to_string()}),
    );
    assert_eq!(p["repositories"], serde_json::json!([env.repo_str()]));
}

/// Mirror of entry 0028: a repository added LATER that holds the accepted
/// global excludes file revokes it for every repository.
#[test]
fn add_repository_revets_the_global_excludes_file() {
    let env = Env::new();
    let dotfiles = env.base.join("Nova Demo dotfiles");
    init_repo(&dotfiles);
    let global = dotfiles.join("gitignore_global");
    std::fs::write(&global, ".DS_Store\n").unwrap();
    let inner = ServerInner::with_config(
        Database::open(&env.base.join("core.sqlite3")).unwrap(),
        SbxLocator::with_search(None, vec![]),
        CoreConfig {
            worktrees_root: Some(env.root.clone()),
            user_excludes_file: Some(global.clone()),
            ..CoreConfig::default()
        },
    );
    assert_eq!(inner.git.active_excludes_file(), global);
    let mut env = Env { inner, ..env };
    env.ok(
        "project.add_repository",
        serde_json::json!({"projectId": env.project_id, "path": dotfiles.display().to_string()}),
    );
    assert_eq!(
        env.inner.git.active_excludes_file(),
        PathBuf::from("/dev/null"),
        "revoked everywhere"
    );
}

/// An already-registered path re-added does not re-vet (nothing is new),
/// and an unrelated repository keeps the excludes file.
#[test]
fn add_repository_of_an_unrelated_repo_keeps_the_excludes_file() {
    let env = Env::new();
    let global = env.base.join("global-ignore");
    std::fs::write(&global, ".DS_Store\n").unwrap();
    let inner = ServerInner::with_config(
        Database::open(&env.base.join("core.sqlite3")).unwrap(),
        SbxLocator::with_search(None, vec![]),
        CoreConfig {
            worktrees_root: Some(env.root.clone()),
            user_excludes_file: Some(global.clone()),
            ..CoreConfig::default()
        },
    );
    let mut env = Env { inner, ..env };
    let nova = env.base.join("Nova Demo repo");
    init_repo(&nova);
    env.ok(
        "project.add_repository",
        serde_json::json!({"projectId": env.project_id, "path": nova.display().to_string()}),
    );
    assert_eq!(env.inner.git.active_excludes_file(), global);
}

/// Probe advertises the six A3a methods (advertised = dispatched).
#[test]
fn probe_advertises_the_project_lifecycle_methods() {
    let mut env = Env::new();
    let probe = env.ok("system.probe", serde_json::json!({}));
    let methods: Vec<&str> = probe["methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.as_str().unwrap())
        .collect();
    // 22 after A3a; 27 since A3b added the five conversation methods.
    assert_eq!(methods.len(), 27);
    for m in [
        "project.update",
        "project.archive",
        "project.unarchive",
        "project.delete",
        "project.add_repository",
        "project.remove_repository",
    ] {
        assert!(methods.contains(&m), "{m} not advertised");
    }
}

/// Review I1: Core refuses spoofing characters in project names on create
/// AND update (stored names are untouched).
#[test]
fn project_names_refuse_controls_and_bidi_on_create_and_update() {
    let mut env = Env::new();
    for bad in [
        "Atlas\nDemo",
        "Atlas\tDemo",
        "Atlas\u{202E}omeD",
        "Atlas\u{2028}Demo",
    ] {
        let e = env.err("project.create", serde_json::json!({"name": bad}));
        assert_eq!(e["code"], "VALIDATION_FAILED", "{bad:?}: {e}");
        let e = env.err(
            "project.update",
            serde_json::json!({"projectId": env.project_id, "name": bad}),
        );
        assert_eq!(e["code"], "VALIDATION_FAILED", "{bad:?}: {e}");
    }
    let e = env.err(
        "project.update",
        serde_json::json!({"projectId": env.project_id, "description": "a\u{2066}b"}),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
    assert_eq!(env.project()["name"], "Atlas Demo");
    assert_eq!(env.count("SELECT COUNT(*) FROM projects"), 1);
}

/// Review I2: remove_repository requires an absolute path, and prefers the
/// row whose stored path EXACTLY equals the input over one that only
/// matches its canonical form.
#[test]
fn remove_repository_requires_absolute_and_prefers_the_exact_stored_match() {
    let mut env = Env::new();
    let pid = env.project_id.clone();
    let e = env.err(
        "project.remove_repository",
        serde_json::json!({"projectId": pid, "path": "Atlas Demo repo"}),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
    // A legacy (pre-W1) row stored a SYMLINK path; the canonical target is a
    // separate, EARLIER row. Removing by the symlink path removes the
    // symlink row, not the earlier canonical one.
    let nova = env.base.join("Nova Demo repo");
    init_repo(&nova);
    let link = env.base.join("nova-link");
    std::os::unix::fs::symlink(&nova, &link).unwrap();
    env.exec(&format!(
        "INSERT INTO repositories (id, project_id, canonical_path) VALUES ('canon', '{pid}', '{}');
         INSERT INTO repositories (id, project_id, canonical_path) VALUES ('legacy-link', '{pid}', '{}');",
        nova.display(),
        link.display()
    ));
    env.ok(
        "project.remove_repository",
        serde_json::json!({"projectId": pid, "path": link.display().to_string()}),
    );
    assert_eq!(
        env.count("SELECT COUNT(*) FROM repositories WHERE id='legacy-link'"),
        0
    );
    assert_eq!(
        env.count("SELECT COUNT(*) FROM repositories WHERE id='canon'"),
        1
    );
}
