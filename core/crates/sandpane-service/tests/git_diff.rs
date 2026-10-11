//! A5 — `git.diff` and the exact change list (design 2026-10-09 §3.5).
//! Tasks with REAL Git context are seeded through the internal API
//! (`create_task_with_mode`) against disposable repositories; every RPC is a
//! real frame through the production dispatch (`handle_line`). Tracked
//! patches are checked against plain git's own output for the same
//! pathspecs (an oracle). No sbx is located or run here.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sandpane_core::sbx::SbxLocator;
use sandpane_core::Database;
use sandpane_protocol::{WorkspaceMode, PROTOCOL_VERSION};
use sandpane_service::{
    create_task_with_mode, discard_task_worktree, handle_line, CoreConfig, SendMode, ServerInner,
    TaskWorkspaceRequest,
};

const MSG_NOT_IN_LIST: &str = "path is not in this task's change list; nothing was read";
const MSG_NO_GIT_CONTEXT: &str = "task has no Git context (repo binding + base_commit)";
const MSG_WORKTREE_REMOVED: &str =
    "the task's worktree was removed (discarded); there is nothing left to review";

const TAB: &str = "tab\there.txt";
const NEWLINE: &str = "new\nline.txt";
const QUOTE: &str = "quo\"te \\ $(x) `y` a&&b.txt";
const DASH: &str = "-dash.txt";
const UNICODE: &str = "日本 é.txt";
/// As a glob this matches `ga.txt` too; `:(literal)` must keep it to itself.
const GLOB: &str = "g[a].txt";

fn git_out(dir: &Path, args: &[&str]) -> Vec<u8> {
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
    out.stdout
}

fn git(dir: &Path, args: &[&str]) -> String {
    String::from_utf8(git_out(dir, args))
        .unwrap()
        .trim()
        .to_string()
}

/// Base content committed in the host repository.
fn init_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "sandpane@test.invalid"]);
    git(dir, &["config", "user.name", "Sandpane Test"]);
    // A user/repo config that would hide renames without --find-renames.
    git(dir, &["config", "diff.renames", "false"]);
    let w = |name: &str, content: &[u8]| std::fs::write(dir.join(name), content).unwrap();
    w("app.txt", b"base\n");
    w("gone.txt", b"bye\n");
    w("old name.txt", "keep\n".repeat(20).as_bytes());
    w("bin.dat", b"a\0b");
    w("latin1.txt", b"caf\xe9\n");
    w("big.txt", b"small\n");
    w("unchanged.txt", b"same\n");
    for n in [TAB, NEWLINE, QUOTE, DASH, UNICODE, GLOB, "ga.txt"] {
        w(n, b"one\n");
    }
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-qm", "base"]);
}

struct Env {
    _dir: tempfile::TempDir,
    inner: Arc<ServerInner>,
    repo: PathBuf,
    conversation_id: String,
    seq: u32,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let repo = base.join("Atlas Demo repo");
        init_repo(&repo);
        let db = Database::open(&base.join("core.sqlite3")).unwrap();
        let inner = ServerInner::with_config(
            db,
            SbxLocator::with_search(None, vec![]),
            CoreConfig {
                worktrees_root: Some(base.join("data").join("worktrees")),
                ..CoreConfig::default()
            },
        );
        let mut env = Self {
            _dir: dir,
            inner,
            repo,
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

    /// A task with real Git context; returns (task id, its work tree, base).
    fn task(&self, mode: WorkspaceMode) -> (String, PathBuf, String) {
        let s = create_task_with_mode(
            &self.inner,
            &self.conversation_id,
            "work",
            Some(TaskWorkspaceRequest {
                mode,
                repo_path: Some(self.repo_str()),
            }),
            SendMode::Task,
        )
        .unwrap_or_else(|f| panic!("create failed: {:?} {}", f.code, f.message));
        let wt: Option<String> = self
            .inner
            .lock_db()
            .conn()
            .query_row(
                "SELECT worktree_path FROM tasks WHERE id = ?1",
                [&s.id],
                |r| r.get(0),
            )
            .unwrap();
        let dir = wt.map(PathBuf::from).unwrap_or_else(|| self.repo.clone());
        (s.id.clone(), dir, s.base_commit.unwrap())
    }

    fn diff(&mut self, task: &str, path: &str) -> serde_json::Value {
        self.ok(
            "git.diff",
            serde_json::json!({"taskId": task, "path": path}),
        )
    }

    fn diff_err(&mut self, params: serde_json::Value) -> serde_json::Value {
        self.err("git.diff", params)
    }
}

/// The agent's work inside the task worktree `wt` (every status).
fn do_work(wt: &Path) {
    let w = |name: &str, content: &[u8]| std::fs::write(wt.join(name), content).unwrap();
    w("app.txt", b"base\ntask edit\n");
    std::fs::remove_file(wt.join("gone.txt")).unwrap();
    git(wt, &["mv", "old name.txt", "new \"name\".txt"]);
    w("bin.dat", b"a\0c");
    w("latin1.txt", b"caf\xe9 au lait\n");
    w("big.txt", "line of text\n".repeat(400).as_bytes());
    w("added.txt", b"staged new\n");
    git(wt, &["add", "added.txt"]);
    for n in [TAB, NEWLINE, QUOTE, DASH, UNICODE, GLOB, "ga.txt"] {
        w(n, b"one\ntwo\n");
    }
    w("notes.md", b"u1\nu2");
    std::os::unix::fs::symlink("/etc/passwd", wt.join("link")).unwrap();
    w("blob.bin", b"x\0y");
    w("u-latin1.txt", b"na\xefve\n");
    w("u-big.txt", "untracked line\n".repeat(400).as_bytes());
}

/// Plain git's patch for the same pathspecs (the oracle).
fn oracle(wt: &Path, base: &str, paths: &[&str]) -> String {
    let mut args = vec![
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-U3",
        "--find-renames",
        base,
        "--",
    ];
    let specs: Vec<String> = paths.iter().map(|p| format!(":(literal){p}")).collect();
    args.extend(specs.iter().map(String::as_str));
    String::from_utf8_lossy(&git_out(wt, &args)).into_owned()
}

fn blob(wt: &Path, base: &str, path: &str) -> String {
    git(wt, &["rev-parse", &format!("{base}:{path}")])
}

// ---------------------------------------------------------------------------

#[test]
fn git_review_lists_exact_paths_old_paths_and_the_repo_path() {
    let mut env = Env::new();
    let (task, wt, _base) = env.task(WorkspaceMode::HostWorktree);
    do_work(&wt);
    let review = env.ok("git.review", serde_json::json!({"taskId": task}));
    assert_eq!(review["repoPath"], env.repo_str().as_str());
    assert!(review.get("uninspected").is_none(), "{review}");
    let mut got: Vec<(String, String, Option<String>)> = review["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["path"].as_str().unwrap().to_string(),
                c["status"].as_str().unwrap().to_string(),
                c.get("oldPath").map(|o| o.as_str().unwrap().to_string()),
            )
        })
        .collect();
    got.sort();
    let s = |p: &str, st: &str| (p.to_string(), st.to_string(), None);
    let mut want = vec![
        s("app.txt", "modified"),
        s("gone.txt", "deleted"),
        (
            "new \"name\".txt".to_string(),
            "renamed".to_string(),
            Some("old name.txt".to_string()),
        ),
        s("bin.dat", "modified"),
        s("latin1.txt", "modified"),
        s("big.txt", "modified"),
        s("added.txt", "added"),
        s(TAB, "modified"),
        s(NEWLINE, "modified"),
        s(QUOTE, "modified"),
        s(DASH, "modified"),
        s(UNICODE, "modified"),
        s(GLOB, "modified"),
        s("ga.txt", "modified"),
        s("notes.md", "untracked"),
        s("link", "untracked"),
        s("blob.bin", "untracked"),
        s("u-latin1.txt", "untracked"),
        s("u-big.txt", "untracked"),
    ];
    want.sort();
    assert_eq!(got, want);
    // The real response only uses keys `change-set.schema.json` allows
    // (`additionalProperties: false` at both levels).
    let schema: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../schemas/change-set.schema.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let allowed = |props: &serde_json::Value| -> Vec<String> {
        props.as_object().unwrap().keys().cloned().collect()
    };
    let top = allowed(&schema["properties"]);
    for k in review.as_object().unwrap().keys() {
        assert!(top.contains(k), "top-level key {k:?} not in the schema");
    }
    let item = allowed(&schema["properties"]["changes"]["items"]["properties"]);
    for c in review["changes"].as_array().unwrap() {
        for k in c.as_object().unwrap().keys() {
            assert!(item.contains(k), "change key {k:?} not in the schema");
        }
    }
    assert!(top.contains(&"repoPath".to_string()) && item.contains(&"oldPath".to_string()));
}

/// An untracked entry that is not a file (a nested repository, listed by
/// git as `nested/`) is refused over the wire — never read, never INTERNAL.
#[test]
fn an_untracked_nested_repository_is_refused_not_read() {
    let mut env = Env::new();
    let (task, wt, _base) = env.task(WorkspaceMode::HostWorktree);
    let nested = wt.join("nested");
    std::fs::create_dir(&nested).unwrap();
    git(&nested, &["init", "-q", "-b", "main"]);
    std::fs::write(nested.join("inner.txt"), b"inner\n").unwrap();
    let review = env.ok("git.review", serde_json::json!({"taskId": task}));
    assert!(
        review["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["path"] == "nested/"),
        "{review}"
    );
    let e = env.diff_err(serde_json::json!({"taskId": task, "path": "nested/"}));
    assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
    let m = e["message"].as_str().unwrap();
    assert!(
        m.ends_with("; nothing was read") && m.contains("directory"),
        "{m}"
    );
}

#[test]
fn tracked_entries_match_git_with_base_blobs() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    do_work(&wt);
    // modified
    let d = env.diff(&task, "app.txt");
    assert_eq!(d["status"], "modified");
    assert_eq!(d["patch"], oracle(&wt, &base, &["app.txt"]).as_str());
    assert!(d["patch"].as_str().unwrap().contains("+task edit\n"));
    assert_eq!(d["binary"], false);
    assert_eq!(d["truncated"], false);
    assert_eq!(d["lossy"], false);
    assert_eq!(d["baseBlob"], blob(&wt, &base, "app.txt").as_str());
    assert!(d.get("oldPath").is_none(), "{d}");
    // added (staged): no base blob
    let d = env.diff(&task, "added.txt");
    assert_eq!(d["status"], "added");
    assert_eq!(d["patch"], oracle(&wt, &base, &["added.txt"]).as_str());
    assert!(d.get("baseBlob").is_none(), "{d}");
    // deleted
    let d = env.diff(&task, "gone.txt");
    assert_eq!(d["status"], "deleted");
    assert!(
        d["patch"].as_str().unwrap().contains("deleted file mode"),
        "{d}"
    );
    assert_eq!(d["patch"], oracle(&wt, &base, &["gone.txt"]).as_str());
    assert_eq!(d["baseBlob"], blob(&wt, &base, "gone.txt").as_str());
    // renamed: BOTH pathspecs, so git sees the rename (repo sets
    // diff.renames=false); the base blob is the OLD path's.
    let d = env.diff(&task, "new \"name\".txt");
    assert_eq!(d["status"], "renamed");
    assert_eq!(d["oldPath"], "old name.txt");
    let p = d["patch"].as_str().unwrap();
    assert!(p.contains("rename from old name.txt\n"), "{p}");
    assert_eq!(p, oracle(&wt, &base, &["new \"name\".txt", "old name.txt"]));
    assert_eq!(d["baseBlob"], blob(&wt, &base, "old name.txt").as_str());
    // binary: decided by numstat, empty patch, never --binary
    let d = env.diff(&task, "bin.dat");
    assert_eq!(d["binary"], true);
    assert_eq!(d["patch"], "");
    assert_eq!(d["baseBlob"], blob(&wt, &base, "bin.dat").as_str());
}

#[test]
fn special_character_paths_are_diffed_exactly() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    do_work(&wt);
    for name in [TAB, NEWLINE, QUOTE, DASH, UNICODE, GLOB] {
        let d = env.diff(&task, name);
        assert_eq!(d["path"], name);
        let p = d["patch"].as_str().unwrap();
        assert!(p.ends_with(" one\n+two\n"), "{name:?}: {p}");
        assert_eq!(p, oracle(&wt, &base, &[name]), "{name:?}");
        assert_eq!(d["baseBlob"], blob(&wt, &base, name).as_str(), "{name:?}");
    }
}

#[test]
fn untracked_entries_are_synthesized_without_running_git_on_them() {
    let mut env = Env::new();
    let (task, wt, _base) = env.task(WorkspaceMode::HostWorktree);
    do_work(&wt);
    let d = env.diff(&task, "notes.md");
    assert_eq!(d["status"], "untracked");
    assert_eq!(
        d["patch"],
        "diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n\
         @@ -0,0 +1,2 @@\n+u1\n+u2\n\\ No newline at end of file\n"
    );
    assert!(d.get("baseBlob").is_none(), "{d}");
    // A symlink is its target TEXT (never followed into /etc/passwd), with
    // git's symlink mode (A5 security I7) so the patch recreates a LINK.
    let d = env.diff(&task, "link");
    assert_eq!(
        d["patch"],
        "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n\
         @@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n"
    );
    // An executable file keeps its mode too.
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(wt.join("run.sh"), b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(wt.join("run.sh"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
    }
    let d = env.diff(&task, "run.sh");
    assert!(
        d["patch"]
            .as_str()
            .unwrap()
            .starts_with("diff --git a/run.sh b/run.sh\nnew file mode 100755\n--- /dev/null\n"),
        "{d}"
    );
    let d = env.diff(&task, "blob.bin");
    assert_eq!(d["binary"], true);
    assert_eq!(d["patch"], "");
}

#[test]
fn non_utf8_content_is_decoded_lossily_and_disclosed() {
    let mut env = Env::new();
    let (task, wt, _base) = env.task(WorkspaceMode::HostWorktree);
    do_work(&wt);
    for path in ["latin1.txt", "u-latin1.txt"] {
        let d = env.diff(&task, path);
        assert_eq!(d["lossy"], true, "{path}: {d}");
        assert_eq!(d["binary"], false, "{path}");
        assert!(
            d["patch"].as_str().unwrap().contains('\u{fffd}'),
            "{path}: {d}"
        );
    }
    assert_eq!(env.diff(&task, "app.txt")["lossy"], false);
}

#[test]
fn truncation_cuts_at_a_line_and_max_bytes_is_clamped() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    do_work(&wt);
    for path in ["big.txt", "u-big.txt"] {
        let d = env.ok(
            "git.diff",
            serde_json::json!({"taskId": task, "path": path, "maxBytes": 300}),
        );
        let p = d["patch"].as_str().unwrap();
        assert_eq!(d["truncated"], true, "{path}");
        assert!(p.len() <= 300 && p.ends_with('\n'), "{path}: {p:?}");
        let full = env.diff(&task, path);
        assert_eq!(full["truncated"], false, "{path}");
        let full = full["patch"].as_str().unwrap();
        if path == "big.txt" {
            assert!(full.starts_with(p), "{path}");
        } else {
            // Untracked: the truncated hunk header counts only the lines
            // included (documented); the body is a prefix of the full one.
            let body = |s: &str| s.splitn(6, '\n').nth(5).unwrap_or("").to_string();
            assert!(
                p.starts_with(
                    "diff --git a/u-big.txt b/u-big.txt\nnew file mode 100644\n\
                     --- /dev/null\n+++ b/u-big.txt\n@@ -0,0 +1,"
                ),
                "{p}"
            );
            assert!(full.contains("@@ -0,0 +1,400 @@\n"), "{full}");
            assert!(body(full).starts_with(&body(p)), "{path}");
            let lines = body(p).lines().count();
            assert!(
                p.contains(&format!("@@ -0,0 +1,{lines} @@\n")) && lines > 0,
                "{p}"
            );
        }
    }
    assert_eq!(
        env.diff(&task, "big.txt")["patch"],
        oracle(&wt, &base, &["big.txt"]).as_str()
    );
    // 0 is clamped to 1 byte (never refused); a huge value to the maximum.
    let d = env.ok(
        "git.diff",
        serde_json::json!({"taskId": task, "path": "app.txt", "maxBytes": 0}),
    );
    assert_eq!(d["truncated"], true);
    assert!(d["patch"].as_str().unwrap().len() <= 1, "{d}");
    let d = env.ok(
        "git.diff",
        serde_json::json!({"taskId": task, "path": "app.txt", "maxBytes": u64::MAX}),
    );
    assert_eq!(d["truncated"], false);
}

#[test]
fn the_path_gate_is_byte_exact_against_the_recomputed_list() {
    let mut env = Env::new();
    let (task, wt, _base) = env.task(WorkspaceMode::HostWorktree);
    do_work(&wt);
    for bad in [
        "",
        "./app.txt",
        "app.txt/",
        "APP.txt",
        "app",
        "*.txt",
        ":(literal)app.txt",
        "../app.txt",
        "app.txt\n",
        "unchanged.txt",
        "old name.txt",
        "\"tab\\there.txt\"",
        "nested/../app.txt",
    ] {
        let e = env.diff_err(serde_json::json!({"taskId": task, "path": bad}));
        assert_eq!(e["code"], "VALIDATION_FAILED", "{bad:?}: {e}");
        assert_eq!(e["message"], MSG_NOT_IN_LIST, "{bad:?}");
    }
    // Recomputed at CALL time: an entry that disappears is refused, a new
    // one is accepted.
    std::fs::remove_file(wt.join("notes.md")).unwrap();
    let e = env.diff_err(serde_json::json!({"taskId": task, "path": "notes.md"}));
    assert_eq!(e["message"], MSG_NOT_IN_LIST);
    std::fs::write(wt.join("fresh.txt"), b"f\n").unwrap();
    assert_eq!(env.diff(&task, "fresh.txt")["status"], "untracked");
    // Missing params are a decode refusal.
    let e = env.diff_err(serde_json::json!({"taskId": task}));
    assert_eq!(e["code"], "VALIDATION_FAILED");
}

#[test]
fn errors_unknown_task_no_git_context_and_removed_worktree() {
    let mut env = Env::new();
    let e = env.diff_err(serde_json::json!({"taskId": "no-such-task", "path": "app.txt"}));
    assert_eq!(e["code"], "NOT_FOUND", "{e}");
    // A wire-created task (conversation.send) has no Git context.
    let cid = env.conversation_id.clone();
    let sent = env.ok(
        "conversation.send",
        serde_json::json!({"conversationId": cid, "content": "hi"}),
    );
    let e = env.diff_err(serde_json::json!({"taskId": sent["id"], "path": "app.txt"}));
    assert_eq!(e["code"], "VALIDATION_FAILED");
    assert_eq!(e["message"], MSG_NO_GIT_CONTEXT);
    // A discarded worktree: the existing message, nothing read.
    let (task, _wt, _base) = env.task(WorkspaceMode::HostWorktree);
    env.ok("task.cancel", serde_json::json!({"taskId": task}));
    discard_task_worktree(&env.inner, &task).unwrap();
    let e = env.diff_err(serde_json::json!({"taskId": task, "path": "app.txt"}));
    assert_eq!(e["code"], "VALIDATION_FAILED");
    assert_eq!(e["message"], MSG_WORKTREE_REMOVED);
    // git.diff is advertised.
    let probe = env.ok("system.probe", serde_json::json!({}));
    let methods: Vec<&str> = probe["methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.as_str().unwrap())
        .collect();
    let at = methods.iter().position(|m| *m == "git.diff").unwrap();
    assert_eq!(methods[at - 1], "git.review");
    assert_eq!(methods[at + 1], "git.apply");
}

fn add_submodule(repo: &Path, origin_parent: &Path) {
    let origin = origin_parent.join("sub-origin");
    init_repo(&origin);
    let out = std::process::Command::new("git")
        .args([
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            &origin.display().to_string(),
            "sub",
        ])
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    git(repo, &["commit", "-qm", "add submodule"]);
}

/// Same submodule refusal as `git.review`, including the HOST check: a
/// host_worktree task whose host repository gained a submodule after the
/// worktree was allocated is refused by both methods.
#[test]
fn submodules_are_refused_exactly_like_git_review() {
    let mut env = Env::new();
    let (wt_task, wt, _base) = env.task(WorkspaceMode::HostWorktree);
    std::fs::write(wt.join("app.txt"), b"edit\n").unwrap();
    let (dm_task, _repo, _base) = env.task(WorkspaceMode::DirectMount);
    let parent = env.repo.parent().unwrap().to_path_buf();
    add_submodule(&env.repo, &parent);
    for task in [&wt_task, &dm_task] {
        let r = env.err("git.review", serde_json::json!({"taskId": task}));
        assert_eq!(r["code"], "VALIDATION_FAILED", "{r}");
        let e = env.diff_err(serde_json::json!({"taskId": task, "path": "app.txt"}));
        assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
        assert_eq!(e["message"], r["message"], "same refusal as git.review");
    }
}

const MSG_WORK_TREE_REDIRECTED: &str =
    "git does not place this task's work tree at its recorded directory (is a repository-local \
     core.worktree set?); nothing was read";

/// A5 security C1 (a): an agent with a direct_mount writes the host
/// repository's `.git/config` (`core.worktree` → a directory outside the
/// repository) and an index entry. `git.diff` and `git.review` must refuse
/// — never return outside content.
#[test]
fn a_repo_local_core_worktree_cannot_point_git_diff_outside_the_target() {
    let mut env = Env::new();
    let (task, _repo, _base) = env.task(WorkspaceMode::DirectMount);
    let outside = env.repo.parent().unwrap().join("victim-home-ssh");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("notes.txt"), b"FAKE-SECRET key material\n").unwrap();
    std::fs::write(env.repo.join("notes.txt"), b"placeholder\n").unwrap();
    git(&env.repo, &["add", "notes.txt"]);
    git(
        &env.repo,
        &["config", "core.worktree", outside.to_str().unwrap()],
    );
    let resp = env.rpc(
        "git.diff",
        serde_json::json!({"taskId": task, "path": "notes.txt"}),
    );
    assert!(!resp.to_string().contains("FAKE-SECRET"), "{resp}");
    let e = &resp["err"];
    assert_eq!(e["code"], "VALIDATION_FAILED", "{resp}");
    assert_eq!(e["message"], MSG_WORK_TREE_REDIRECTED, "{resp}");
    let r = env.err("git.review", serde_json::json!({"taskId": task}));
    assert_eq!(r["code"], "VALIDATION_FAILED", "{r}");
    assert_eq!(r["message"], MSG_WORK_TREE_REDIRECTED, "{r}");
    // A redirect to a directory that does not exist is the same refusal.
    git(
        &env.repo,
        &["config", "core.worktree", "/nonexistent-sandpane-dir"],
    );
    let e = env.diff_err(serde_json::json!({"taskId": task, "path": "notes.txt"}));
    assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
    assert_eq!(e["message"], MSG_WORK_TREE_REDIRECTED, "{e}");
}

/// A5 security C1 (b): `hostDirty` describes the HOST repository; a
/// `core.worktree` there pointing at a clean checkout must not make the
/// user's uncommitted work disappear from it (a host_worktree task's own
/// work tree is unaffected and still reviewable). A direct_mount task on
/// the same repository is refused.
#[test]
fn host_dirty_survives_a_core_worktree_redirect_to_a_clean_checkout() {
    let mut env = Env::new();
    let (task, wt, _base) = env.task(WorkspaceMode::HostWorktree);
    let (dm_task, _repo, _base) = env.task(WorkspaceMode::DirectMount);
    std::fs::write(wt.join("app.txt"), b"base\ntask edit\n").unwrap();
    let clean = env.repo.parent().unwrap().join("clean-copy");
    git(
        &env.repo,
        &["worktree", "add", "-q", "--detach", clean.to_str().unwrap()],
    );
    std::fs::write(env.repo.join("app.txt"), b"base\nUSER WORK\n").unwrap();
    git(
        &env.repo,
        &["config", "core.worktree", clean.to_str().unwrap()],
    );
    let review = env.ok("git.review", serde_json::json!({"taskId": task}));
    assert_eq!(review["hostDirty"], true, "{review}");
    assert_eq!(review["changes"][0]["path"], "app.txt", "{review}");
    let r = env.err("git.review", serde_json::json!({"taskId": dm_task}));
    assert_eq!(r["message"], MSG_WORK_TREE_REDIRECTED, "{r}");
}

/// A5 security W1: repository config must not change the patch's shape —
/// `diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix`/`dstPrefix`
/// and `diff.context` are overridden (`a/`, `b/`, 3 lines of context).
#[test]
fn repository_diff_config_cannot_change_prefixes_or_context() {
    let mut env = Env::new();
    let body: String = (1..=9).map(|i| format!("{i}\n")).collect();
    std::fs::write(env.repo.join("nine.txt"), &body).unwrap();
    git(&env.repo, &["add", "nine.txt"]);
    git(&env.repo, &["commit", "-qm", "nine lines"]);
    let (task, wt, _base) = env.task(WorkspaceMode::HostWorktree);
    std::fs::write(wt.join("nine.txt"), body.replace("5\n", "FIVE\n")).unwrap();
    for (k, v) in [
        ("diff.noprefix", "true"),
        ("diff.mnemonicPrefix", "true"),
        ("diff.srcPrefix", "SRC/"),
        ("diff.dstPrefix", "DST/"),
        ("diff.context", "0"),
    ] {
        git(&env.repo, &["config", k, v]);
    }
    let d = env.diff(&task, "nine.txt");
    let p = d["patch"].as_str().unwrap();
    assert!(p.starts_with("diff --git a/nine.txt b/nine.txt\n"), "{p}");
    assert!(
        p.ends_with(
            "\n--- a/nine.txt\n+++ b/nine.txt\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+FIVE\n 6\n 7\n 8\n"
        ),
        "{p}"
    );
}

const MSG_PATH_LISTED_TWICE: &str =
    "path is listed more than once in this task's change list; pass its status; nothing was read";

/// A5 security I2: `git rm --cached` lists one path twice (deleted from the
/// index, still on disk as untracked). Without `status` the call is refused
/// — never an arbitrary pick; with it, the matching entry is diffed.
#[test]
fn a_path_listed_twice_needs_its_status() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    std::fs::write(wt.join("app.txt"), b"base\nnow untracked\n").unwrap();
    git(&wt, &["rm", "-q", "--cached", "app.txt"]);
    let review = env.ok("git.review", serde_json::json!({"taskId": task}));
    let mut listed: Vec<&str> = review["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["path"] == "app.txt")
        .map(|c| c["status"].as_str().unwrap())
        .collect();
    listed.sort();
    assert_eq!(listed, ["deleted", "untracked"], "{review}");
    let e = env.diff_err(serde_json::json!({"taskId": task, "path": "app.txt"}));
    assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
    assert_eq!(e["message"], MSG_PATH_LISTED_TWICE, "{e}");
    let d = env.ok(
        "git.diff",
        serde_json::json!({"taskId": task, "path": "app.txt", "status": "deleted"}),
    );
    assert_eq!(d["status"], "deleted");
    assert_eq!(d["baseBlob"], blob(&wt, &base, "app.txt").as_str());
    assert!(
        d["patch"].as_str().unwrap().contains("deleted file mode"),
        "{d}"
    );
    let d = env.ok(
        "git.diff",
        serde_json::json!({"taskId": task, "path": "app.txt", "status": "untracked"}),
    );
    assert_eq!(d["status"], "untracked");
    assert!(
        d["patch"]
            .as_str()
            .unwrap()
            .ends_with("+base\n+now untracked\n"),
        "{d}"
    );
    // A status that does not match any entry for the path is NOT_IN_LIST.
    let e =
        env.diff_err(serde_json::json!({"taskId": task, "path": "app.txt", "status": "modified"}));
    assert_eq!(e["message"], MSG_NOT_IN_LIST, "{e}");
    // An unambiguous path still needs no status; a matching one is accepted.
    std::fs::write(wt.join("gone.txt"), b"bye\nmore\n").unwrap();
    assert_eq!(env.diff(&task, "gone.txt")["status"], "modified");
    let d = env.ok(
        "git.diff",
        serde_json::json!({"taskId": task, "path": "gone.txt", "status": "modified"}),
    );
    assert_eq!(d["status"], "modified");
}
