//! C3 — task Git context through the service: base commit, task branch,
//! Core-owned worktree allocation, `git.review` reading the worktree, and
//! cleanup that never destroys work. Real disposable Git repositories; RPCs go
//! through the production dispatch (`handle_line`). Task creation WITH a
//! workspace uses the internal `create_task` API because protocol v1's
//! `conversation.send` cannot select one yet.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sandpane_core::sbx::SbxLocator;
use sandpane_core::Database;
use sandpane_protocol::{ErrorCode, WorkspaceMode, PROTOCOL_VERSION};
use sandpane_service::{
    create_task, discard_task_worktree, handle_line, report_orphaned_task_workspaces, CoreConfig,
    ServerInner, TaskWorkspaceRequest,
};

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

struct Env {
    _dir: tempfile::TempDir,
    inner: Arc<ServerInner>,
    repo: PathBuf,
    root: PathBuf,
    conversation_id: String,
    seq: u32,
}

impl Env {
    /// A project with one registered repository and one conversation; Core
    /// configured with a worktree root (not yet created) under a temp data dir.
    fn new() -> Self {
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
                ..CoreConfig::default()
            },
        );
        let mut env = Self {
            _dir: dir,
            inner,
            repo,
            root,
            conversation_id: String::new(),
            seq: 0,
        };
        let project = env.ok(
            "project.create",
            serde_json::json!({"name": "Atlas Demo", "repositories": [env.repo_str()]}),
        );
        let conv = env.ok(
            "conversation.create",
            serde_json::json!({"projectId": project["id"], "agentId": "codex"}),
        );
        env.conversation_id = conv["id"].as_str().unwrap().to_string();
        env
    }

    fn db_path(&self) -> PathBuf {
        self.root
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("core.sqlite3")
    }

    fn repo_str(&self) -> String {
        self.repo.display().to_string()
    }

    fn rpc(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        self.seq += 1;
        let frame = serde_json::json!({
            "v": PROTOCOL_VERSION, "id": self.seq.to_string(), "method": method, "params": params
        });
        serde_json::from_str(&handle_line(&self.inner, &frame.to_string())).unwrap()
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

    fn create(&self, mode: WorkspaceMode, repo: Option<String>) -> sandpane_protocol::TaskSummary {
        create_task(
            &self.inner,
            &self.conversation_id,
            "implement the feature",
            Some(TaskWorkspaceRequest {
                mode,
                repo_path: repo,
            }),
        )
        .unwrap_or_else(|f| panic!("create_task failed: {:?} {}", f.code, f.message))
    }

    /// (workspace_mode, worktree_path, worktree_removed_at) as stored.
    fn row(&self, task_id: &str) -> (Option<String>, Option<String>, Option<String>) {
        let db = self.inner.lock_db();
        db.conn()
            .query_row(
                "SELECT workspace_mode, worktree_path, worktree_removed_at FROM tasks WHERE id=?1",
                [task_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
    }

    fn task_count(&self) -> i64 {
        let db = self.inner.lock_db();
        db.conn()
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap()
    }

    fn events(&mut self, task_id: &str) -> Vec<serde_json::Value> {
        self.ok("task.subscribe", serde_json::json!({"taskId": task_id}))
            .as_array()
            .unwrap()
            .clone()
    }
}

fn sandpane_branches(repo: &Path) -> String {
    git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/sandpane/",
        ],
    )
}

#[test]
fn isolated_task_records_exact_git_context_and_review_reads_its_worktree() {
    let mut env = Env::new();
    let base = git(&env.repo, &["rev-parse", "HEAD"]);
    let task = env.create(WorkspaceMode::HostWorktree, Some(env.repo_str()));

    // Exact full base, Core-named branch, Core-owned worktree.
    assert_eq!(task.base_commit.as_deref(), Some(base.as_str()));
    let branch = format!("sandpane/{}", task.id);
    assert_eq!(task.task_branch.as_deref(), Some(branch.as_str()));
    let wt = env.root.join(&task.id);
    let (mode, path, removed) = env.row(&task.id);
    assert_eq!(mode.as_deref(), Some("host_worktree"));
    assert_eq!(path.as_deref(), Some(wt.to_str().unwrap()));
    assert_eq!(removed, None);
    assert_eq!(git(&wt, &["rev-parse", "HEAD"]), base);
    assert_eq!(git(&env.repo, &["rev-parse", &branch]), base);
    assert!(!wt.starts_with(&env.repo));
    // Core's root is private.
    use std::os::unix::fs::PermissionsExt;
    let mode_bits = std::fs::metadata(&env.root).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode_bits, 0o700);
    // The user's checkout is untouched.
    assert_eq!(git(&env.repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");

    // Visible through the existing wire fields and the durable event log.
    let listed = env.ok("task.list", serde_json::json!({}));
    let row = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == task.id.as_str())
        .unwrap()
        .clone();
    assert_eq!(row["baseCommit"], base.as_str());
    assert_eq!(row["taskBranch"], branch.as_str());
    let events = env.events(&task.id);
    let created = events.iter().find(|e| e["kind"] == "task.created").unwrap();
    assert_eq!(created["payload"]["baseCommit"], base.as_str());
    assert_eq!(created["payload"]["workspaceMode"], "host_worktree");
    assert_eq!(created["payload"]["worktreePath"], wt.to_str().unwrap());
    assert_eq!(created["payload"]["liveWritable"], false);
    assert!(events
        .iter()
        .any(|e| e["kind"] == "status.changed" && e["payload"]["to"] == "queued"));

    // Unrelated USER edits in the host repo + the TASK's edits in its worktree.
    std::fs::write(env.repo.join("app.txt"), "user edit\n").unwrap();
    std::fs::write(env.repo.join("host-notes.txt"), "user untracked\n").unwrap();
    std::fs::write(wt.join("app.txt"), "task edit\n").unwrap();
    std::fs::write(wt.join("task-file.txt"), "task untracked\n").unwrap();

    let review = env.ok("git.review", serde_json::json!({"taskId": task.id}));
    assert_eq!(review["baseCommit"], base.as_str());
    // hostDirty describes the HOST (the integration target), not the worktree.
    assert_eq!(review["hostDirty"], true);
    let mut changes: Vec<(String, String)> = review["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["path"].as_str().unwrap().to_string(),
                c["status"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    changes.sort();
    assert_eq!(
        changes,
        vec![
            ("app.txt".to_string(), "modified".to_string()),
            ("task-file.txt".to_string(), "untracked".to_string()),
        ],
        "review must list the task worktree's changes only"
    );
    // Host work untouched by allocation and review.
    assert_eq!(
        std::fs::read_to_string(env.repo.join("app.txt")).unwrap(),
        "user edit\n"
    );
    assert!(env.repo.join("host-notes.txt").exists());

    // The wire default stays honest: conversation.send creates NO Git context.
    let plain = env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": env.conversation_id, "content": "hi"}),
    );
    assert!(plain.get("taskBranch").is_none() && plain.get("baseCommit").is_none());
    assert_eq!(env.row(plain["id"].as_str().unwrap()), (None, None, None));
}

#[test]
fn discard_refuses_live_or_dirty_worktrees_and_never_destroys_work() {
    let mut env = Env::new();
    let task = env.create(WorkspaceMode::HostWorktree, Some(env.repo_str()));
    let wt = env.root.join(&task.id);
    let branch = task.task_branch.clone().unwrap();

    // A queued (non-terminal) task's worktree is not discardable.
    let f = discard_task_worktree(&env.inner, &task.id).unwrap_err();
    assert_eq!(f.code, ErrorCode::Conflict, "{}", f.message);
    assert!(wt.exists());

    // Cancel is NOT discard: the worktree and branch survive it.
    env.ok("task.cancel", serde_json::json!({"taskId": task.id}));
    assert!(wt.exists());
    assert_eq!(sandpane_branches(&env.repo), branch);

    // Uncommitted (untracked) task work → refused, work intact.
    std::fs::write(wt.join("result.txt"), "agent output\n").unwrap();
    let f = discard_task_worktree(&env.inner, &task.id).unwrap_err();
    assert_eq!(f.code, ErrorCode::Conflict);
    assert!(f.message.contains("uncommitted"), "{}", f.message);
    assert_eq!(
        std::fs::read_to_string(wt.join("result.txt")).unwrap(),
        "agent output\n"
    );
    assert_eq!(sandpane_branches(&env.repo), branch);
    assert_eq!(env.row(&task.id).2, None);

    // Clean → removed: directory and Core's branch go, the host stays.
    std::fs::remove_file(wt.join("result.txt")).unwrap();
    std::fs::write(env.repo.join("host-notes.txt"), "user untracked\n").unwrap();
    let out = discard_task_worktree(&env.inner, &task.id).unwrap();
    assert!(out.directory_was_present && out.branch_deleted && !out.already_removed);
    assert_eq!(out.worktree_path, wt.to_str().unwrap());
    assert!(!wt.exists());
    assert_eq!(sandpane_branches(&env.repo), "");
    assert!(env.repo.join("host-notes.txt").exists());
    assert_eq!(git(&env.repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
    let (_, path, removed) = env.row(&task.id);
    assert_eq!(
        path.as_deref(),
        Some(wt.to_str().unwrap()),
        "path kept for audit"
    );
    assert!(removed.is_some());
    let events = env.events(&task.id);
    let ev = events
        .iter()
        .find(|e| e["kind"] == "workspace.removed")
        .expect("durable removal event");
    assert_eq!(ev["payload"]["branchDeleted"], true);

    // Review never falls back to the host tree for a removed worktree.
    let err = env.err("git.review", serde_json::json!({"taskId": task.id}));
    assert_eq!(err["code"], "VALIDATION_FAILED");
    assert!(
        err["message"].as_str().unwrap().contains("removed"),
        "{err}"
    );

    // Idempotent.
    let again = discard_task_worktree(&env.inner, &task.id).unwrap();
    assert!(again.already_removed && !again.branch_deleted);
}

#[test]
fn submodule_repository_is_refused_at_allocation_with_nothing_created() {
    let mut env = Env::new();
    let origin = env
        .root
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("lib-origin");
    init_repo(&origin);
    git(
        &env.repo,
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
    git(&env.repo, &["commit", "-qm", "add submodule"]);
    let f = create_task(
        &env.inner,
        &env.conversation_id,
        "work",
        Some(TaskWorkspaceRequest {
            mode: WorkspaceMode::HostWorktree,
            repo_path: Some(env.repo_str()),
        }),
    )
    .unwrap_err();
    assert_eq!(f.code, ErrorCode::ValidationFailed, "{}", f.message);
    assert!(f.message.contains("vendor/lib"), "{}", f.message);
    assert_eq!(env.task_count(), 0, "no task row for a refused allocation");
    assert_eq!(sandpane_branches(&env.repo), "");
    let leftover = std::fs::read_dir(&env.root).map(|d| d.count()).unwrap_or(0);
    assert_eq!(leftover, 0);
    let _ = env.ok("project.list", serde_json::json!({}));
}

#[test]
fn direct_mount_task_records_base_but_never_gets_a_worktree() {
    let mut env = Env::new();
    let base = git(&env.repo, &["rev-parse", "HEAD"]);
    let task = env.create(WorkspaceMode::DirectMount, Some(env.repo_str()));
    assert_eq!(task.base_commit.as_deref(), Some(base.as_str()));
    assert_eq!(task.task_branch, None, "Core never branches the live tree");
    assert_eq!(
        env.row(&task.id),
        (Some("direct_mount".to_string()), None, None)
    );
    assert_eq!(sandpane_branches(&env.repo), "");
    assert!(!env.root.exists(), "no worktree root was even created");
    let events = env.events(&task.id);
    let created = events.iter().find(|e| e["kind"] == "task.created").unwrap();
    assert_eq!(created["payload"]["liveWritable"], true);
    assert_eq!(created["payload"]["workspaceMode"], "direct_mount");

    // Review of a live-writable task reads the host tree (that IS its workspace).
    std::fs::write(env.repo.join("app.txt"), "live edit\n").unwrap();
    let review = env.ok("git.review", serde_json::json!({"taskId": task.id}));
    assert!(review["changes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["path"] == "app.txt"));

    // Nothing to discard, and Core says why.
    env.ok("task.cancel", serde_json::json!({"taskId": task.id}));
    let f = discard_task_worktree(&env.inner, &task.id).unwrap_err();
    assert_eq!(f.code, ErrorCode::ValidationFailed);
    assert!(f.message.contains("direct_mount"), "{}", f.message);
    assert_eq!(
        std::fs::read_to_string(env.repo.join("app.txt")).unwrap(),
        "live edit\n"
    );
}

/// sbx_clone work lives in the sandbox's private clone (captured `create
/// --help`: commits come back through the `sandbox-<name>` remote), so the
/// host tree would show NONE of it — review must refuse, not report "clean".
#[test]
fn sbx_clone_task_records_base_and_review_refuses_honestly() {
    let mut env = Env::new();
    let task = env.create(WorkspaceMode::SbxClone, Some(env.repo_str()));
    // Review W4: the host HEAD is not verified against the sandbox clone, so
    // Core records NO base rather than one that looks verified.
    assert_eq!(task.base_commit, None);
    assert_eq!(task.task_branch, None);
    let events = env.events(&task.id);
    let created = events.iter().find(|e| e["kind"] == "task.created").unwrap();
    assert!(created["payload"].get("baseCommit").is_none(), "{created}");
    assert_eq!(created["payload"]["workspaceMode"], "sbx_clone");
    assert_eq!(
        env.row(&task.id),
        (Some("sbx_clone".to_string()), None, None)
    );
    assert!(!env.root.exists());
    let err = env.err("git.review", serde_json::json!({"taskId": task.id}));
    assert_eq!(err["code"], "VALIDATION_FAILED");
    assert!(
        err["message"].as_str().unwrap().contains("sbx_clone"),
        "{err}"
    );
}

#[test]
fn workspace_requests_are_validated_before_anything_is_written() {
    let env = Env::new();
    let req = |mode, repo: Option<String>| {
        create_task(
            &env.inner,
            &env.conversation_id,
            "work",
            Some(TaskWorkspaceRequest {
                mode,
                repo_path: repo,
            }),
        )
        .unwrap_err()
    };
    // A real repository that is NOT registered with the project.
    let other = env
        .root
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("Nova Demo");
    init_repo(&other);
    let f = req(
        WorkspaceMode::HostWorktree,
        Some(other.display().to_string()),
    );
    assert_eq!(f.code, ErrorCode::PermissionDenied, "{}", f.message);
    assert_eq!(sandpane_branches(&other), "");
    // A subdirectory of a registered root is not the root.
    std::fs::create_dir(env.repo.join("src")).unwrap();
    let f = req(
        WorkspaceMode::HostWorktree,
        Some(env.repo.join("src").display().to_string()),
    );
    assert_eq!(f.code, ErrorCode::PermissionDenied, "{}", f.message);
    // Repository-backed modes need a repository; mountless takes none.
    assert_eq!(
        req(WorkspaceMode::HostWorktree, None).code,
        ErrorCode::ValidationFailed
    );
    assert_eq!(
        req(WorkspaceMode::Mountless, Some(env.repo_str())).code,
        ErrorCode::ValidationFailed
    );
    assert_eq!(env.task_count(), 0);
    assert_eq!(sandpane_branches(&env.repo), "");

    // Without a configured worktree root, host_worktree is refused, not faked.
    let unconfigured = ServerInner::new(
        Database::open_in_memory().unwrap(),
        SbxLocator::with_search(None, vec![]),
    );
    let project = serde_json::from_str::<serde_json::Value>(&handle_line(
        &unconfigured,
        &serde_json::json!({"v": 1, "id": "1", "method": "project.create",
            "params": {"name": "Orbit Demo", "repositories": [env.repo_str()]}})
        .to_string(),
    ))
    .unwrap();
    let conv = serde_json::from_str::<serde_json::Value>(&handle_line(
        &unconfigured,
        &serde_json::json!({"v": 1, "id": "2", "method": "conversation.create",
            "params": {"projectId": project["ok"]["id"], "agentId": "codex"}})
        .to_string(),
    ))
    .unwrap();
    let f = create_task(
        &unconfigured,
        conv["ok"]["id"].as_str().unwrap(),
        "work",
        Some(TaskWorkspaceRequest {
            mode: WorkspaceMode::HostWorktree,
            repo_path: Some(env.repo_str()),
        }),
    )
    .unwrap_err();
    assert_eq!(f.code, ErrorCode::ValidationFailed, "{}", f.message);
    assert_eq!(sandpane_branches(&env.repo), "");
}

/// `hostDirty` comes from the HOST repository (the integration target) and
/// the change list from the task's worktree — each proven on its own.
#[test]
fn review_takes_host_dirty_from_the_host_and_changes_from_the_worktree() {
    let mut env = Env::new();
    let task = env.create(WorkspaceMode::HostWorktree, Some(env.repo_str()));
    let wt = env.root.join(&task.id);

    // Only the worktree is edited: task changes listed, host clean.
    std::fs::write(wt.join("app.txt"), "task edit\n").unwrap();
    let review = env.ok("git.review", serde_json::json!({"taskId": task.id}));
    assert_eq!(review["hostDirty"], false, "{review}");
    assert_eq!(review["changes"].as_array().unwrap().len(), 1, "{review}");

    // Only the host is edited: host dirty, no task changes.
    git(&wt, &["checkout", "-q", "--", "app.txt"]);
    std::fs::write(env.repo.join("host-notes.txt"), "user untracked\n").unwrap();
    let review = env.ok("git.review", serde_json::json!({"taskId": task.id}));
    assert_eq!(review["hostDirty"], true, "{review}");
    assert!(review["changes"].as_array().unwrap().is_empty(), "{review}");
}

/// Review C1 through the service: a tampered (symbolic) task ref is refused
/// and the user's branch survives.
#[test]
fn discard_refuses_a_symbolic_task_ref_and_keeps_the_users_branch() {
    let mut env = Env::new();
    let task = env.create(WorkspaceMode::HostWorktree, Some(env.repo_str()));
    env.ok("task.cancel", serde_json::json!({"taskId": task.id}));
    let branch = task.task_branch.clone().unwrap();
    git(
        &env.repo,
        &[
            "symbolic-ref",
            &format!("refs/heads/{branch}"),
            "refs/heads/main",
        ],
    );
    let f = discard_task_worktree(&env.inner, &task.id).unwrap_err();
    assert_eq!(f.code, ErrorCode::Conflict, "{}", f.message);
    assert!(f.message.contains("symbolic"), "{}", f.message);
    git(&env.repo, &["rev-parse", "--verify", "refs/heads/main"]);
    git(&env.repo, &["rev-parse", "--verify", "HEAD"]);
    assert!(env.root.join(&task.id).exists());
    assert_eq!(env.row(&task.id).2, None, "nothing recorded as removed");
}

/// Review S1: durable INTENT is recorded before the git side effect, then
/// the outcome — so the audit is accurate after a crash or retry.
#[test]
fn discard_records_intent_before_the_removal_outcome() {
    let mut env = Env::new();
    let task = env.create(WorkspaceMode::HostWorktree, Some(env.repo_str()));
    env.ok("task.cancel", serde_json::json!({"taskId": task.id}));
    discard_task_worktree(&env.inner, &task.id).unwrap();
    let events = env.events(&task.id);
    let seq = |kind: &str| {
        events
            .iter()
            .find(|e| e["kind"] == kind)
            .unwrap_or_else(|| panic!("no {kind} event in {events:?}"))["sequence"]
            .as_i64()
            .unwrap()
    };
    assert!(seq("workspace.removing") < seq("workspace.removed"));
}

/// A refused discard (preflight) records no intent at all.
#[test]
fn refused_discard_records_no_removal_events() {
    let mut env = Env::new();
    let task = env.create(WorkspaceMode::HostWorktree, Some(env.repo_str()));
    env.ok("task.cancel", serde_json::json!({"taskId": task.id}));
    std::fs::write(env.root.join(&task.id).join("work.txt"), "w\n").unwrap();
    discard_task_worktree(&env.inner, &task.id).unwrap_err();
    let events = env.events(&task.id);
    assert!(
        !events
            .iter()
            .any(|e| e["kind"].as_str().unwrap().starts_with("workspace.")),
        "{events:?}"
    );
}

/// Discard respects the scheduler's writer lock on the worktree.
#[test]
fn discard_refuses_while_another_task_holds_the_worktree_writer_lock() {
    let env = Env::new();
    let task = env.create(WorkspaceMode::HostWorktree, Some(env.repo_str()));
    let mut env = env;
    env.ok("task.cancel", serde_json::json!({"taskId": task.id}));
    let key = env.root.join(&task.id).display().to_string();
    env.inner
        .lock_scheduler()
        .mark_running("some-writer", "p", Some(&key), WorkspaceMode::HostWorktree)
        .unwrap();
    let f = discard_task_worktree(&env.inner, &task.id).unwrap_err();
    assert_eq!(f.code, ErrorCode::Conflict, "{}", f.message);
    assert!(f.message.contains("writer"), "{}", f.message);
    assert!(env.root.join(&task.id).exists());
}

/// Review S4: "no commit" is VALIDATION_FAILED; a broken repository (a git
/// execution failure) is INTERNAL — not blamed on the request.
#[test]
fn record_base_failures_map_to_distinct_codes() {
    let mut env = Env::new();
    let empty = env
        .root
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("Orbit Demo empty");
    std::fs::create_dir_all(&empty).unwrap();
    git(&empty, &["init", "-q", "-b", "main"]);
    let project = env.ok(
        "project.create",
        serde_json::json!({"name": "Orbit Demo", "repositories": [empty.display().to_string()]}),
    );
    let conv = env.ok(
        "conversation.create",
        serde_json::json!({"projectId": project["id"], "agentId": "codex"}),
    );
    let mk = |repo: &Path| {
        create_task(
            &env.inner,
            conv["id"].as_str().unwrap(),
            "work",
            Some(TaskWorkspaceRequest {
                mode: WorkspaceMode::DirectMount,
                repo_path: Some(repo.display().to_string()),
            }),
        )
        .unwrap_err()
    };
    let f = mk(&empty);
    assert_eq!(f.code, ErrorCode::ValidationFailed, "{}", f.message);
    assert!(f.message.contains("no commit"), "{}", f.message);
    // Corrupt the registered repository: git can no longer read it.
    std::fs::write(empty.join(".git").join("HEAD"), "garbage\n").unwrap();
    let f = mk(&empty);
    assert_eq!(f.code, ErrorCode::Internal, "{}", f.message);
}

/// Review W3: read-only reconciliation REPORTS worktree directories and
/// `sandpane/*` branches with no task row behind them — and deletes nothing.
#[test]
fn orphaned_task_workspaces_are_reported_never_deleted() {
    let env = Env::new();
    let live = env.create(WorkspaceMode::HostWorktree, Some(env.repo_str()));
    let orphan_dir = env.root.join("0b0e5e1e-0000-4000-8000-000000000000");
    std::fs::create_dir(&orphan_dir).unwrap();
    let orphan_branch = "sandpane/0b0e5e1e-0000-4000-8000-00000000beef";
    git(&env.repo, &["branch", orphan_branch]);
    let report = report_orphaned_task_workspaces(&env.inner);
    assert_eq!(report.worktree_dirs, vec![orphan_dir.clone()]);
    assert_eq!(
        report.branches,
        vec![(env.repo_str(), orphan_branch.to_string())]
    );
    assert!(!report.branches.iter().any(|(_, b)| b.ends_with(&live.id)));
    assert!(orphan_dir.exists());
    git(&env.repo, &["rev-parse", "--verify", orphan_branch]);
}

/// Review W3 / phase W3: when the durable write fails AFTER allocation, the
/// fresh worktree and branch are rolled back (DB failure injected with a
/// SQLite trigger — a real failure, not a mock).
#[test]
fn failed_task_write_rolls_back_the_fresh_worktree() {
    let env = Env::new();
    env.inner
        .lock_db()
        .conn()
        .execute_batch(
            "CREATE TRIGGER inject_failure BEFORE INSERT ON tasks
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
        )
        .unwrap();
    let f = create_task(
        &env.inner,
        &env.conversation_id,
        "work",
        Some(TaskWorkspaceRequest {
            mode: WorkspaceMode::HostWorktree,
            repo_path: Some(env.repo_str()),
        }),
    )
    .unwrap_err();
    assert_eq!(f.code, ErrorCode::Internal, "{}", f.message);
    assert_eq!(sandpane_branches(&env.repo), "");
    assert_eq!(std::fs::read_dir(&env.root).unwrap().count(), 0);
    assert_eq!(env.task_count(), 0);
}

// --- User global excludes (orchestrator follow-up) --------------------------

/// Open (or reopen) Core on `db_path` with a user-excludes candidate.
fn reopen_with_excludes(env: &Env, candidate: PathBuf) -> Arc<ServerInner> {
    ServerInner::with_config(
        Database::open(&env.db_path()).unwrap(),
        SbxLocator::with_search(None, vec![]),
        CoreConfig {
            worktrees_root: Some(env.root.clone()),
            user_excludes_file: Some(candidate),
            ..CoreConfig::default()
        },
    )
}

fn review_of(inner: &ServerInner, task_id: &str) -> serde_json::Value {
    let frame = serde_json::json!({
        "v": PROTOCOL_VERSION, "id": "r", "method": "git.review", "params": {"taskId": task_id}
    });
    let resp: serde_json::Value =
        serde_json::from_str(&handle_line(inner, &frame.to_string())).unwrap();
    resp["ok"].clone()
}

/// The user's OWN global ignore (`.DS_Store`) is honoured: not dirty, not
/// listed — while real untracked work still is.
#[test]
fn user_global_excludes_hide_ds_store_from_host_dirty_and_review() {
    let env = Env::new();
    let task = env.create(WorkspaceMode::DirectMount, Some(env.repo_str()));
    let global = env
        .root
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("global-ignore");
    std::fs::write(&global, ".DS_Store\n").unwrap();
    let inner = reopen_with_excludes(&env, global.clone());
    assert_eq!(inner.git.active_excludes_file(), global);
    std::fs::write(env.repo.join(".DS_Store"), "finder\n").unwrap();
    let review = review_of(&inner, &task.id);
    assert_eq!(review["hostDirty"], false, "{review}");
    assert!(review["changes"].as_array().unwrap().is_empty(), "{review}");
    std::fs::write(env.repo.join("work.txt"), "work\n").unwrap();
    let review = review_of(&inner, &task.id);
    assert_eq!(review["hostDirty"], true, "{review}");
    assert_eq!(review["changes"][0]["path"], "work.txt", "{review}");
}

/// A candidate inside a registered repository (or the worktree root) is
/// rejected at startup: Core falls back to `/dev/null`.
#[test]
fn excludes_candidates_inside_repositories_or_the_root_are_rejected() {
    let env = Env::new();
    let task = env.create(WorkspaceMode::DirectMount, Some(env.repo_str()));
    let in_repo = env.repo.join("agent-ignore");
    std::fs::write(&in_repo, "*\n").unwrap();
    let inner = reopen_with_excludes(&env, in_repo);
    assert_eq!(inner.git.active_excludes_file(), PathBuf::from("/dev/null"));
    std::fs::write(env.repo.join("work.txt"), "work\n").unwrap();
    let review = review_of(&inner, &task.id);
    assert_eq!(review["hostDirty"], true, "{review}");
    std::fs::create_dir_all(&env.root).unwrap();
    let in_root = env.root.join("ignore");
    std::fs::write(&in_root, "*\n").unwrap();
    let inner = reopen_with_excludes(&env, in_root);
    assert_eq!(inner.git.active_excludes_file(), PathBuf::from("/dev/null"));
}

/// Follow-up to 0027's commit review (validator scope mismatch): a global
/// excludes file accepted at startup lies inside a repository that is
/// registered LATER (a dotfiles repo). From then on an agent with write access
/// there could hide files from the reviews and dirty gates of OTHER
/// repositories, so registering it must revoke the file for every repository.
#[test]
fn registering_the_repository_that_holds_the_excludes_file_revokes_it_everywhere() {
    let mut env = Env::new();
    let task = env.create(WorkspaceMode::DirectMount, Some(env.repo_str()));
    let base = env.root.parent().unwrap().parent().unwrap().to_path_buf();
    let dotfiles = base.join("Nova Demo dotfiles");
    init_repo(&dotfiles);
    let global = dotfiles.join("gitignore_global");
    std::fs::write(&global, ".DS_Store\n").unwrap();
    env.inner = reopen_with_excludes(&env, global.clone());
    assert_eq!(env.inner.git.active_excludes_file(), global);
    std::fs::write(env.repo.join(".DS_Store"), "finder\n").unwrap();
    assert_eq!(review_of(&env.inner, &task.id)["hostDirty"], false);

    env.ok(
        "project.create",
        serde_json::json!({"name": "Nova Demo", "repositories": [dotfiles.display().to_string()]}),
    );
    assert_eq!(
        env.inner.git.active_excludes_file(),
        PathBuf::from("/dev/null")
    );
    // A DIFFERENT repository's review no longer honours the revoked file.
    let review = review_of(&env.inner, &task.id);
    assert_eq!(review["hostDirty"], true, "{review}");
    assert_eq!(review["changes"][0]["path"], ".DS_Store", "{review}");
}

/// The realistic dotfiles layout: `~/.config/git/ignore` is a SYMLINK into a
/// dotfiles repository that is registered after startup. The accepted path is
/// the canonical target, so registering the dotfiles repo still revokes it.
#[cfg(unix)]
#[test]
fn a_symlinked_excludes_file_is_revoked_when_its_target_repository_is_registered() {
    let mut env = Env::new();
    let task = env.create(WorkspaceMode::DirectMount, Some(env.repo_str()));
    let base = env.root.parent().unwrap().parent().unwrap().to_path_buf();
    let dotfiles = base.join("Orbit Demo dotfiles");
    init_repo(&dotfiles);
    let target = dotfiles.join("git").join("ignore");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, ".DS_Store\n").unwrap();
    let config_git = base.join("home").join(".config").join("git");
    std::fs::create_dir_all(&config_git).unwrap();
    let link = config_git.join("ignore");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    env.inner = reopen_with_excludes(&env, link);
    assert_eq!(
        env.inner.git.active_excludes_file(),
        target,
        "accepted as the canonical target"
    );
    std::fs::write(env.repo.join(".DS_Store"), "finder\n").unwrap();
    assert_eq!(review_of(&env.inner, &task.id)["hostDirty"], false);

    env.ok(
        "project.create",
        serde_json::json!({"name": "Orbit Demo", "repositories": [dotfiles.display().to_string()]}),
    );
    assert_eq!(
        env.inner.git.active_excludes_file(),
        PathBuf::from("/dev/null")
    );
    assert_eq!(review_of(&env.inner, &task.id)["hostDirty"], true);
}

/// Registering an unrelated repository keeps an accepted excludes file.
#[test]
fn registering_an_unrelated_repository_keeps_the_excludes_file() {
    let mut env = Env::new();
    let base = env.root.parent().unwrap().parent().unwrap().to_path_buf();
    let global = base.join("global-ignore");
    std::fs::write(&global, ".DS_Store\n").unwrap();
    env.inner = reopen_with_excludes(&env, global.clone());
    let orbit = base.join("Orbit Demo repo");
    init_repo(&orbit);
    env.ok(
        "project.create",
        serde_json::json!({"name": "Orbit Demo", "repositories": [orbit.display().to_string()]}),
    );
    assert_eq!(env.inner.git.active_excludes_file(), global);
}
