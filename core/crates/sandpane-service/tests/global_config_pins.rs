//! A6 W4 / review I5 — command-scope `-c` pins beat a hostile GLOBAL git
//! config.
//!
//! This binary holds exactly ONE test and points `HOME` and
//! `XDG_CONFIG_HOME` at a temporary directory before anything else runs, so
//! the "global" config every git process reads is a temp file. The user's
//! real global config is never read or written. (Core's runner scrubs every
//! `GIT_*` variable, so `GIT_CONFIG_GLOBAL` cannot be used; `HOME` is what
//! git consults.) No sbx is located or run.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;

use sandpane_core::sbx::SbxLocator;
use sandpane_core::Database;
use sandpane_protocol::{WorkspaceMode, PROTOCOL_VERSION};
use sandpane_service::{
    create_task_with_mode, handle_line, CoreConfig, SendMode, ServerInner, TaskWorkspaceRequest,
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
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn rpc(inner: &ServerInner, id: u32, method: &str, params: serde_json::Value) -> serde_json::Value {
    let frame = serde_json::json!({"v": PROTOCOL_VERSION, "id": id.to_string(),
        "method": method, "params": params});
    let resp: serde_json::Value =
        serde_json::from_str(&handle_line(inner, &frame.to_string())).unwrap();
    assert!(resp.get("ok").is_some(), "{method}: {resp}");
    resp["ok"].clone()
}

#[test]
fn command_scope_pins_beat_a_hostile_global_config() {
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let home = base.join("home");
    std::fs::create_dir_all(home.join(".config")).unwrap();
    // The ONLY test in this binary: no other thread reads the environment.
    std::env::set_var("HOME", &home);
    std::env::set_var("XDG_CONFIG_HOME", home.join(".config"));
    std::env::remove_var("GIT_CONFIG_GLOBAL");

    let repo = base.join("Atlas Demo repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [
        ("user.email", "sandpane@test.invalid"),
        ("user.name", "Sandpane Test"),
        ("maintenance.auto", "false"),
        ("gc.auto", "0"),
    ] {
        git(&repo, &["config", k, v]);
    }
    std::fs::write(repo.join("app.txt"), b"base\n").unwrap();
    std::fs::write(repo.join("tool.sh"), b"#!/bin/sh\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "base"]);

    let db = Database::open(&base.join("core.sqlite3")).unwrap();
    let inner: Arc<ServerInner> = ServerInner::with_config(
        db,
        SbxLocator::with_search(None, vec![]),
        CoreConfig {
            worktrees_root: Some(base.join("data").join("worktrees")),
            ..CoreConfig::default()
        },
    );
    let project = rpc(
        &inner,
        1,
        "project.create",
        serde_json::json!({"name": "Atlas Demo", "repositories": [repo.display().to_string()]}),
    );
    let conv = rpc(
        &inner,
        2,
        "conversation.create",
        serde_json::json!({"projectId": project["id"], "agentId": "codex"}),
    );
    let task = create_task_with_mode(
        &inner,
        conv["id"].as_str().unwrap(),
        "work",
        Some(TaskWorkspaceRequest {
            mode: WorkspaceMode::HostWorktree,
            repo_path: Some(repo.display().to_string()),
        }),
        SendMode::Task,
    )
    .unwrap_or_else(|f| panic!("{:?} {}", f.code, f.message));
    let wt: String = inner
        .lock_db()
        .conn()
        .query_row(
            "SELECT worktree_path FROM tasks WHERE id = ?1",
            [&task.id],
            |r| r.get(0),
        )
        .unwrap();
    let wt = Path::new(&wt);
    let content: &[u8] = b"base\ntrailing space   \n\tindented\n";
    std::fs::write(wt.join("app.txt"), content).unwrap();
    std::fs::set_permissions(wt.join("tool.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let review = rpc(
        &inner,
        3,
        "git.review",
        serde_json::json!({"taskId": task.id}),
    );

    // Now the hostile GLOBAL config (in the temp HOME).
    std::fs::write(
        home.join(".gitconfig"),
        "[core]\n\tautocrlf = true\n\tfileMode = false\n\tsplitIndex = true\n\
         [apply]\n\twhitespace = fix\n",
    )
    .unwrap();
    assert_eq!(
        git(&repo, &["config", "--global", "--get", "core.autocrlf"]),
        "true"
    );
    assert_eq!(git(&repo, &["config", "--get", "apply.whitespace"]), "fix");

    let r = rpc(
        &inner,
        4,
        "git.apply",
        serde_json::json!({"taskId": task.id, "expectedBase": task.base_commit,
            "reviewId": review["reviewId"], "entries": review["changes"]}),
    );
    assert_eq!(r["applied"], true, "{r}");
    assert_eq!(std::fs::read(repo.join("app.txt")).unwrap(), content);
    let mode = std::fs::metadata(repo.join("tool.sh"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o111, 0o111);
    let staged = git(&repo, &["ls-files", "-s", "--", "tool.sh"]);
    assert!(staged.starts_with("100755 "), "{staged}");
    let shared = std::fs::read_dir(repo.join(".git"))
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| e.file_name().to_string_lossy().starts_with("sharedindex."));
    assert!(!shared, "a split index was written");
}
