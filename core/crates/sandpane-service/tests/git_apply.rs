//! A6 — `git.apply` for reviewed files (design 2026-10-09 §3.6).
//!
//! `host_worktree` tasks are seeded through the internal API
//! (`create_task_with_mode`) on REAL temporary repositories with a REAL
//! linked worktree; every request is a real frame through the production
//! dispatch (`handle_line`). Hostile configuration is set in the test
//! repositories' own config only. No sbx is located or run.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sandpane_core::apply::ApplyLimits;
use sandpane_core::sbx::SbxLocator;
use sandpane_core::Database;
use sandpane_protocol::{WorkspaceMode, PROTOCOL_VERSION};
use sandpane_service::{
    create_task_with_mode, discard_task_worktree, handle_line, CoreConfig, CreateClaimHook,
    SendMode, ServerInner, TaskWorkspaceRequest, TestHook,
};

// --- Stable messages (pinned: clients match on these) -----------------------

const NOTHING: &str = "; nothing was written";
const MSG_NEEDS_REVIEW: &str = "git.apply needs reviewId and a non-empty entries list copied \
     from a git.review answer; nothing was written";
const MSG_SELECTED_FILES: &str = "selectedFiles is not accepted: send reviewId and entries copied \
     from a git.review answer instead; nothing was written";
const MSG_TOO_MANY: &str = "at most 1000 entries can be applied at once; nothing was written";
const MSG_NOT_REVIEWED: &str =
    "entries do not match a review Core produced; review again; nothing was written";
const MSG_DIRECT_MOUNT: &str = "this task worked directly in your repository; its changes are \
     already in your working tree, so there is nothing to apply; nothing was written";

fn q(p: &str) -> String {
    format!("{p:?}")
}
fn msg_changed(p: &str) -> String {
    format!(
        "{} changed since it was reviewed; review it again{NOTHING}",
        q(p)
    )
}
fn msg_listed_twice(p: &str) -> String {
    format!("{} is listed more than once in entries{NOTHING}", q(p))
}
fn msg_symlink(p: &str) -> String {
    format!("{}: symlinks are never applied{NOTHING}", q(p))
}
fn msg_base_symlink(p: &str) -> String {
    format!(
        "{} is a symlink in the base commit; deleting or replacing a tracked symlink is not \
         supported{NOTHING}",
        q(p)
    )
}
fn msg_no_content(p: &str) -> String {
    format!(
        "{} has no reviewed content id (it was over the 32 MiB apply cap, or not a file Core \
         could read, when it was reviewed), so it is too large or unsupported to apply{NOTHING}",
        q(p)
    )
}
fn msg_leading_path(p: &str) -> String {
    format!(
        "{} lies under a symlink or a file in your working tree{NOTHING}",
        q(p)
    )
}
fn msg_dirty(paths: &[&str]) -> String {
    let l: Vec<String> = paths.iter().map(|p| q(p)).collect();
    format!(
        "{} in your working tree have uncommitted changes or are untracked or ignored files\
         {NOTHING}",
        l.join(", ")
    )
}
fn msg_hidden(paths: &[&str]) -> String {
    let l: Vec<String> = paths.iter().map(|p| q(p)).collect();
    format!(
        "{} are flagged assume-unchanged or skip-worktree in your index, which hides changes\
         {NOTHING}",
        l.join(", ")
    )
}
fn msg_filtered(p: &str, f: &str) -> String {
    format!(
        "{} has the filter attribute {f:?} (for example Git LFS) in your repository; Core never \
         runs filters, so it would receive raw content{NOTHING}",
        q(p)
    )
}
fn msg_write_failed(repo: &str) -> String {
    format!(
        "the write failed after git's checks passed; some files may have been written or staged \
         — check `git status` in {repo}"
    )
}
fn msg_write_killed(repo: &str) -> String {
    format!(
        "{}; `.git/index.lock` may remain — remove it only after checking that no git process \
         is running",
        msg_write_failed(repo)
    )
}
const MSG_CONTENT_TOO_LARGE: &str = "the selected files hold more than 64 MiB of new content, \
     too much to apply in one step; apply fewer files at once; nothing was written";
const MSG_PREPARE_TOO_SLOW: &str = "preparing the apply took longer than its 20 s budget; apply \
     fewer files at once; nothing was written";
const MSG_CHECK_UNAVAILABLE: &str =
    "git could not check the patch (timed out or failed); nothing was written";
fn msg_verify_unavailable(repo: &str) -> String {
    format!("could not verify the staged content — check `git status` in {repo}")
}
const MSG_WRITE_NOT_RUN: &str = "git apply was not started (reading the repository's \
     configuration timed out or failed); nothing was written";
const MSG_CHECK_FAILED: &str = "the patch does not apply cleanly; nothing was written";
const MSG_PATCH_TOO_LARGE: &str = "the selected changes are too large to apply in one step (the \
     patch exceeds 64 MiB); nothing was written";
const MSG_WRITE_TOO_LATE: &str = "git apply was not started (too little of its time budget was \
     left to finish it safely); nothing was written";
fn msg_create_repo_busy(repo: &str, holder: &str) -> String {
    format!(
        "{repo} is busy: {holder} holds its writer lock (a running writer task, an apply or a \
         worktree discard), and a direct_mount sandbox could change it while that runs; try \
         again when it finishes; nothing was created"
    )
}
fn msg_create_mount_in_progress(repo: &str, name: &str) -> String {
    format!(
        "{repo} is busy: sandbox \"{name}\" is being created with a direct mount of it; try \
         again when that create finishes; nothing was created"
    )
}
fn msg_mount_being_created(repo: &str, name: &str) -> String {
    format!(
        "{repo} is busy: sandbox \"{name}\" is being created with a direct mount of it and \
         could change it while Core writes; nothing was written"
    )
}
fn msg_mounted(what: &str) -> String {
    format!(
        "{what}: a sandbox mounts this repository directly and can change it while Core writes; \
         stop or remove it first; nothing was written"
    )
}

fn msg_verify_failed(repo: &str) -> String {
    format!(
        "files were changed, but the staged content differs from the reviewed content — check \
         `git status` in {repo}"
    )
}

// --- Harness ----------------------------------------------------------------

const TAB: &str = "tab\there.txt";
const NEWLINE: &str = "new\nline.txt";
const QUOTE: &str = "quo\"te \\ $(x) `y` a&&b.txt";

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

fn write(path: &Path, content: &[u8]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

fn chmod(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn mode_of(path: &Path) -> u32 {
    std::fs::symlink_metadata(path)
        .unwrap()
        .permissions()
        .mode()
        & 0o777
}

/// Base content committed in the host repository.
fn init_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "sandpane@test.invalid"]);
    git(dir, &["config", "user.name", "Sandpane Test"]);
    // The TEST's own `git commit` must not start background maintenance in
    // the object store the W-A tests measure (repo config only).
    git(dir, &["config", "maintenance.auto", "false"]);
    git(dir, &["config", "gc.auto", "0"]);
    write(&dir.join("app.txt"), b"base\n");
    write(&dir.join("gone.txt"), b"bye\n");
    write(&dir.join("old.txt"), "keep\n".repeat(20).as_bytes());
    write(&dir.join("tool.sh"), b"#!/bin/sh\necho hi\n");
    write(&dir.join("bin.dat"), b"a\0b");
    write(&dir.join("d/x"), b"x\n");
    write(&dir.join("d/y"), b"y\n");
    for n in [TAB, NEWLINE, QUOTE] {
        write(&dir.join(n), b"one\n");
    }
    std::os::unix::fs::symlink("app.txt", dir.join("link")).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-qm", "base"]);
}

struct Env {
    _dir: tempfile::TempDir,
    base: PathBuf,
    inner: Arc<ServerInner>,
    repo: PathBuf,
    project_id: String,
    conversation_id: String,
    seq: u32,
}

/// What a test may install on the Core it builds (test seams only).
#[derive(Default)]
struct Seams {
    create_claim: Option<CreateClaimHook>,
    before_check: Option<TestHook>,
    before_start: Option<TestHook>,
    before_write: Option<TestHook>,
    after_write: Option<TestHook>,
    limits: Option<ApplyLimits>,
}

fn hook(f: impl Fn(&ServerInner) + Send + Sync + 'static) -> Option<TestHook> {
    Some(TestHook(Arc::new(f)))
}

impl Env {
    fn new() -> Self {
        Self::with(|_| Seams::default())
    }

    /// `seams` receives the repository path (created before Core starts).
    fn with(seams: impl FnOnce(&Path) -> Seams) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let repo = base.join("Atlas Demo repo");
        init_repo(&repo);
        let s = seams(&repo);
        let inner = Self::core(&base, s);
        let mut env = Self {
            _dir: dir,
            base,
            inner,
            repo,
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
            serde_json::json!({"projectId": project["id"], "agentId": "codex"}),
        );
        env.conversation_id = conv["id"].as_str().unwrap().to_string();
        env
    }

    fn core(base: &Path, s: Seams) -> Arc<ServerInner> {
        let db = Database::open(&base.join("core.sqlite3")).unwrap();
        ServerInner::with_config(
            db,
            SbxLocator::with_search(None, vec![]),
            CoreConfig {
                worktrees_root: Some(base.join("data").join("worktrees")),
                test_after_create_claim: s.create_claim,
                test_apply_before_check: s.before_check,
                test_apply_before_start: s.before_start,
                test_apply_before_write: s.before_write,
                test_apply_after_write: s.after_write,
                test_apply_limits: s.limits,
                ..CoreConfig::default()
            },
        )
    }

    /// A NEW Core on the same database (a restart).
    fn restart(&mut self) {
        self.inner = Self::core(&self.base, Seams::default());
    }

    fn repo_str(&self) -> String {
        self.repo.display().to_string()
    }

    fn rpc(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        self.seq += 1;
        rpc_on(&self.inner, &self.seq.to_string(), method, params)
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

    /// A task with real Git context; returns (task id, work tree, base).
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
        (s.id.clone(), dir, s.base_commit.unwrap_or_default())
    }

    fn review(&mut self, task: &str) -> serde_json::Value {
        self.ok("git.review", serde_json::json!({"taskId": task}))
    }

    /// The `git.apply` response frame for `paths` copied verbatim from
    /// `review` (all entries when `paths` is empty).
    fn apply(
        &mut self,
        task: &str,
        base: &str,
        review: &serde_json::Value,
        paths: &[&str],
    ) -> serde_json::Value {
        let params = apply_params(task, base, review, paths);
        self.rpc("git.apply", params)
    }

    fn apply_ok(
        &mut self,
        task: &str,
        base: &str,
        review: &serde_json::Value,
        paths: &[&str],
    ) -> serde_json::Value {
        let resp = self.apply(task, base, review, paths);
        assert!(resp.get("ok").is_some(), "git.apply failed: {resp}");
        resp["ok"].clone()
    }

    /// An apply that must be refused with `applied: false` and `reason`.
    fn refused(
        &mut self,
        task: &str,
        base: &str,
        review: &serde_json::Value,
        paths: &[&str],
        reason: &str,
    ) -> serde_json::Value {
        let r = self.apply_ok(task, base, review, paths);
        assert_eq!(r["applied"], false, "{r}");
        assert_eq!(r["abortReason"], reason, "{r}");
        assert!(r.get("partial").is_none(), "{r}");
        r
    }

    fn events(&self, task: &str) -> Vec<(String, serde_json::Value)> {
        events_of(&self.inner, task)
    }

    fn host_status(&self) -> String {
        String::from_utf8(git_out(
            &self.repo,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        ))
        .unwrap()
    }
}

fn rpc_on(
    inner: &ServerInner,
    id: &str,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    let frame = serde_json::json!({
        "v": PROTOCOL_VERSION, "id": id, "method": method, "params": params
    });
    serde_json::from_str(&handle_line(inner, &frame.to_string())).unwrap()
}

fn events_of(inner: &ServerInner, task: &str) -> Vec<(String, serde_json::Value)> {
    let db = inner.lock_db();
    let mut stmt = db
        .conn()
        .prepare("SELECT kind, payload FROM task_events WHERE task_id = ?1 ORDER BY sequence")
        .unwrap();
    let rows = stmt
        .query_map([task], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .unwrap();
    rows.map(|r| {
        let (k, p) = r.unwrap();
        (k, serde_json::from_str(&p).unwrap())
    })
    .collect()
}

fn apply_kinds(events: &[(String, serde_json::Value)]) -> Vec<String> {
    events
        .iter()
        .filter(|(k, _)| k.starts_with("git.appl"))
        .map(|(k, _)| k.clone())
        .collect()
}

fn entries(review: &serde_json::Value, paths: &[&str]) -> Vec<serde_json::Value> {
    let all = review["changes"].as_array().unwrap();
    if paths.is_empty() {
        return all.clone();
    }
    paths
        .iter()
        .map(|p| {
            all.iter()
                .find(|c| c["path"] == *p)
                .unwrap_or_else(|| panic!("{p:?} not in review {review}"))
                .clone()
        })
        .collect()
}

fn apply_params(
    task: &str,
    base: &str,
    review: &serde_json::Value,
    paths: &[&str],
) -> serde_json::Value {
    serde_json::json!({
        "taskId": task,
        "expectedBase": base,
        "reviewId": review["reviewId"],
        "entries": entries(review, paths),
    })
}

fn entry<'a>(review: &'a serde_json::Value, path: &str) -> &'a serde_json::Value {
    review["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["path"] == path)
        .unwrap_or_else(|| panic!("{path:?} not in {review}"))
}

fn hash(dir: &Path, rel: &str) -> String {
    git(dir, &["hash-object", "--no-filters", "--", rel])
}

/// `(mode, oid)` staged for `path` in the host index, if any.
fn staged(repo: &Path, path: &str) -> Option<(String, String)> {
    let out = git_out(
        repo,
        &["ls-files", "-s", "-z", "--", &format!(":(literal){path}")],
    );
    out.split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .map(|r| String::from_utf8(r.to_vec()).unwrap())
        .find_map(|r| {
            let (meta, p) = r.split_once('\t')?;
            (p == path).then(|| {
                let f: Vec<&str> = meta.split(' ').collect();
                (f[0].to_string(), f[1].to_string())
            })
        })
}

// --- Successful applies (item 11: statuses, special paths) ------------------

#[test]
fn applies_modified_added_deleted_renamed_exec_bit_and_binary_entries() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"base\ntask edit\n");
    write(&wt.join("added.txt"), b"staged new\n");
    git(&wt, &["add", "added.txt"]);
    write(&wt.join("notes.md"), b"untracked\n");
    std::fs::remove_file(wt.join("gone.txt")).unwrap();
    git(&wt, &["mv", "old.txt", "renamed.txt"]);
    chmod(&wt.join("tool.sh"), 0o755);
    write(&wt.join("bin.dat"), b"x\0y\0z");

    let review = env.review(&task);
    assert!(review["reviewId"].as_str().is_some_and(|s| !s.is_empty()));
    let statuses: Vec<(String, String)> = review["changes"]
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
    for (p, s) in [
        ("app.txt", "modified"),
        ("added.txt", "added"),
        ("notes.md", "untracked"),
        ("gone.txt", "deleted"),
        ("renamed.txt", "renamed"),
        ("tool.sh", "modified"),
        ("bin.dat", "modified"),
    ] {
        assert!(
            statuses.contains(&(p.to_string(), s.to_string())),
            "{p} {s}: {review}"
        );
    }
    // Content binding (item 3): Core's ids equal git's for the same bytes;
    // deleted entries carry none.
    assert_eq!(entry(&review, "app.txt")["taskBlob"], hash(&wt, "app.txt"));
    assert_eq!(entry(&review, "app.txt")["taskMode"], "100644");
    assert_eq!(entry(&review, "tool.sh")["taskMode"], "100755");
    assert!(entry(&review, "gone.txt").get("taskBlob").is_none());
    assert!(entry(&review, "gone.txt").get("taskMode").is_none());
    assert_eq!(entry(&review, "renamed.txt")["oldPath"], "old.txt");

    let head_before = git(&env.repo, &["rev-parse", "HEAD"]);
    let r = env.apply_ok(&task, &base, &review, &[]);
    assert_eq!(r["applied"], true, "{r}");
    assert!(
        r.get("abortReason").is_none() && r.get("partial").is_none(),
        "{r}"
    );
    let applied: Vec<&str> = r["appliedFiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let mut want: Vec<&str> = statuses.iter().map(|(p, _)| p.as_str()).collect();
    let mut got = applied.clone();
    want.sort();
    got.sort();
    assert_eq!(got, want);
    assert_eq!(
        r["modeChanges"],
        serde_json::json!([{"path": "tool.sh", "from": "100644", "to": "100755"}])
    );
    let snapshot = r["snapshotTree"].as_str().unwrap();
    assert_eq!(snapshot.len(), 40);
    // The host index tree IS the snapshot (the host was clean at base), and
    // nothing was committed.
    assert_eq!(git(&env.repo, &["write-tree"]), snapshot);
    assert_eq!(git(&env.repo, &["rev-parse", "HEAD"]), head_before);
    for f in [
        "app.txt",
        "added.txt",
        "notes.md",
        "renamed.txt",
        "tool.sh",
        "bin.dat",
    ] {
        assert_eq!(
            std::fs::read(env.repo.join(f)).unwrap(),
            std::fs::read(wt.join(f)).unwrap(),
            "{f}"
        );
    }
    assert!(!env.repo.join("gone.txt").exists() && !env.repo.join("old.txt").exists());
    assert_eq!(mode_of(&env.repo.join("tool.sh")) & 0o100, 0o100);
    assert_eq!(staged(&env.repo, "tool.sh").unwrap().0, "100755");
    // The work tree matches the index (staged, nothing left unstaged).
    assert!(git(&env.repo, &["diff", "--name-only"]).is_empty());
    // W7: started, then applied — with the files and the snapshot.
    let ev = env.events(&task);
    assert_eq!(apply_kinds(&ev), ["git.apply.started", "git.applied"]);
    let started = &ev.iter().find(|(k, _)| k == "git.apply.started").unwrap().1;
    assert_eq!(started["baseCommit"], base);
    assert_eq!(started["snapshotTree"], snapshot);
    assert_eq!(started["files"], r["appliedFiles"]);
    let done = &ev.iter().find(|(k, _)| k == "git.applied").unwrap().1;
    assert_eq!(done["snapshotTree"], snapshot);
    assert_eq!(done["modeChanges"], r["modeChanges"]);
}

#[test]
fn special_character_paths_are_applied_exactly() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    for n in [TAB, NEWLINE, QUOTE] {
        write(&wt.join(n), b"one\ntwo\n");
    }
    let added = "new\ttab \"q\".txt";
    write(&wt.join(added), b"fresh\n");
    let review = env.review(&task);
    let r = env.apply_ok(&task, &base, &review, &[TAB, NEWLINE, QUOTE, added]);
    assert_eq!(r["applied"], true, "{r}");
    for n in [TAB, NEWLINE, QUOTE] {
        assert_eq!(
            std::fs::read(env.repo.join(n)).unwrap(),
            b"one\ntwo\n",
            "{n:?}"
        );
        assert_eq!(staged(&env.repo, n).unwrap().1, hash(&wt, n), "{n:?}");
    }
    assert_eq!(std::fs::read(env.repo.join(added)).unwrap(), b"fresh\n");
}

/// A selection applies ONLY the selected entries; the rest stay out.
#[test]
fn only_the_selected_entries_are_applied() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"base\nchanged\n");
    write(&wt.join("notes.md"), b"not selected\n");
    std::fs::remove_file(wt.join("gone.txt")).unwrap();
    let review = env.review(&task);
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], true, "{r}");
    assert_eq!(r["appliedFiles"], serde_json::json!(["app.txt"]));
    assert_eq!(r["modeChanges"], serde_json::json!([]));
    assert!(!env.repo.join("notes.md").exists());
    assert!(env.repo.join("gone.txt").exists());
    assert_eq!(env.host_status(), "M  app.txt\n");
}

// --- Request shape (VALIDATION_FAILED) and review binding (R4) --------------

#[test]
fn malformed_requests_are_validation_failed_and_unknown_tasks_not_found() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"changed\n");
    let review = env.review(&task);
    let good = apply_params(&task, &base, &review, &["app.txt"]);
    let with = |k: &str, v: serde_json::Value| {
        let mut p = good.clone();
        p[k] = v;
        p
    };
    let without = |k: &str| {
        let mut p = good.clone();
        p.as_object_mut().unwrap().remove(k);
        p
    };
    let too_many: Vec<serde_json::Value> = (0..1001)
        .map(|i| serde_json::json!({"path": format!("f{i}"), "status": "added"}))
        .collect();
    for (params, msg) in [
        (
            with("selectedFiles", serde_json::json!(["app.txt"])),
            MSG_SELECTED_FILES,
        ),
        (
            {
                let mut p = without("entries");
                p["selectedFiles"] = serde_json::json!(["app.txt"]);
                p
            },
            MSG_SELECTED_FILES,
        ),
        (without("reviewId"), MSG_NEEDS_REVIEW),
        (without("entries"), MSG_NEEDS_REVIEW),
        (with("entries", serde_json::json!([])), MSG_NEEDS_REVIEW),
        (with("reviewId", serde_json::json!("")), MSG_NEEDS_REVIEW),
        (with("entries", serde_json::json!(too_many)), MSG_TOO_MANY),
    ] {
        let e = env.err("git.apply", params.clone());
        assert_eq!(e["code"], "VALIDATION_FAILED", "{params}: {e}");
        assert_eq!(e["message"], msg, "{params}");
    }
    // A short (prefix) base is still refused as before (security W3).
    let e = env.err("git.apply", with("expectedBase", serde_json::json!("abc")));
    assert_eq!(e["code"], "VALIDATION_FAILED", "{e}");
    let e = env.err(
        "git.apply",
        with("taskId", serde_json::json!("no-such-task")),
    );
    assert_eq!(e["code"], "NOT_FOUND", "{e}");
    assert_eq!(env.host_status(), "", "nothing was written");
    assert!(apply_kinds(&env.events(&task)).is_empty());
}

#[test]
fn entries_must_be_verbatim_members_of_a_review_core_produced() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    let (other, other_wt, _) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"changed\n");
    write(&other_wt.join("app.txt"), b"other\n");
    let review = env.review(&task);
    let other_review = env.review(&other);
    let app = entry(&review, "app.txt").clone();
    let tamper = |k: &str, v: serde_json::Value| {
        let mut e = app.clone();
        e[k] = v;
        e
    };
    let cases: Vec<(serde_json::Value, Vec<serde_json::Value>)> = vec![
        // unknown review id
        (serde_json::json!("not-a-review"), vec![app.clone()]),
        // another task's review id
        (other_review["reviewId"].clone(), vec![app.clone()]),
        // tampered fields
        (
            review["reviewId"].clone(),
            vec![tamper("taskBlob", "0".repeat(40).into())],
        ),
        (
            review["reviewId"].clone(),
            vec![tamper("taskMode", "100755".into())],
        ),
        (
            review["reviewId"].clone(),
            vec![tamper("status", "added".into())],
        ),
        (
            review["reviewId"].clone(),
            vec![tamper("oldPath", "gone.txt".into())],
        ),
        (
            review["reviewId"].clone(),
            vec![tamper("path", "gone.txt".into())],
        ),
        // a field dropped
        (review["reviewId"].clone(), {
            let mut e = app.clone();
            e.as_object_mut().unwrap().remove("taskBlob");
            vec![e]
        }),
        // a path Core never listed
        (
            review["reviewId"].clone(),
            vec![serde_json::json!({"path": "evil.sh", "status": "untracked",
                "taskBlob": "0".repeat(40), "taskMode": "100755"})],
        ),
    ];
    for (rid, ents) in cases {
        let r = env.ok(
            "git.apply",
            serde_json::json!({"taskId": task, "expectedBase": base, "reviewId": rid,
                "entries": ents}),
        );
        assert_eq!(r["applied"], false, "{r}");
        assert_eq!(r["abortReason"], MSG_NOT_REVIEWED, "{ents:?}");
    }
    // Listed twice.
    let r = env.ok(
        "git.apply",
        serde_json::json!({"taskId": task, "expectedBase": base,
            "reviewId": review["reviewId"], "entries": [app.clone(), app.clone()]}),
    );
    assert_eq!(r["abortReason"], msg_listed_twice("app.txt"), "{r}");
    // Only the last 8 reviews per task are kept (memory only).
    let first = env.review(&task);
    for _ in 0..8 {
        env.review(&task);
    }
    env.refused(&task, &base, &first, &["app.txt"], MSG_NOT_REVIEWED);
    assert_eq!(env.host_status(), "", "nothing was written");
}

#[test]
fn a_review_id_does_not_survive_a_core_restart() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"changed\n");
    let review = env.review(&task);
    env.restart();
    env.refused(&task, &base, &review, &["app.txt"], MSG_NOT_REVIEWED);
}

// --- Mode and context refusals (item 1) -------------------------------------

#[test]
fn only_host_worktree_tasks_apply() {
    let mut env = Env::new();
    let fake = serde_json::json!({"reviewId": "r",
        "changes": [{"path": "app.txt", "status": "modified"}]});
    // direct_mount: the work is already in the host tree.
    let (dm, _repo, base) = env.task(WorkspaceMode::DirectMount);
    env.refused(&dm, &base, &fake, &[], MSG_DIRECT_MOUNT);
    // A direct_mount review is unchanged by A6: no reviewId, no taskBlob.
    write(&env.repo.join("app.txt"), b"live edit\n");
    let review = env.review(&dm);
    assert!(review.get("reviewId").is_none(), "{review}");
    assert!(entry(&review, "app.txt").get("taskBlob").is_none());
    git(&env.repo, &["checkout", "-q", "--", "app.txt"]);
    // sbx_clone: the existing review message + "; nothing was written".
    let (clone, _, _) = env.task(WorkspaceMode::SbxClone);
    let r = env.apply_ok(&clone, &base, &fake, &[]);
    let reason = r["abortReason"].as_str().unwrap();
    assert!(
        reason.starts_with("review of sbx_clone tasks is not implemented")
            && reason.ends_with(NOTHING),
        "{reason}"
    );
    // No Git context.
    let plain = create_task_with_mode(&env.inner, &env.conversation_id, "hi", None, SendMode::Task)
        .unwrap();
    env.refused(
        &plain.id,
        &base,
        &fake,
        &[],
        "task has no Git context (repo binding + base_commit); nothing was written",
    );
    // A removed (discarded) worktree.
    let (task, _wt, _) = env.task(WorkspaceMode::HostWorktree);
    env.ok("task.cancel", serde_json::json!({"taskId": task}));
    discard_task_worktree(&env.inner, &task).unwrap();
    env.refused(
        &task,
        &base,
        &fake,
        &[],
        "the task's worktree was removed (discarded); there is nothing left to review; nothing \
         was written",
    );
    // The client's expectedBase must equal the recorded base exactly.
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"changed\n");
    let review = env.review(&task);
    let wrong = "1".repeat(40);
    env.refused(
        &task,
        &wrong,
        &review,
        &[],
        &format!(
            "base diverged: the task's recorded base is {base}, the client expected {wrong}\
             {NOTHING}"
        ),
    );
    assert_eq!(env.host_status(), "", "nothing was written");
}

// --- Entry policy (item 3) --------------------------------------------------

#[test]
fn symlinks_and_base_symlinks_are_never_applied() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    std::os::unix::fs::symlink("app.txt", wt.join("newlink")).unwrap();
    let review = env.review(&task);
    assert_eq!(entry(&review, "newlink")["taskMode"], "120000");
    env.refused(&task, &base, &review, &["newlink"], &msg_symlink("newlink"));
    // R7: deleting a tracked symlink.
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    std::fs::remove_file(wt.join("link")).unwrap();
    let review = env.review(&task);
    env.refused(&task, &base, &review, &["link"], &msg_base_symlink("link"));
    // R7: a symlink → file typechange.
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    std::fs::remove_file(wt.join("link")).unwrap();
    write(&wt.join("link"), b"now a file\n");
    let review = env.review(&task);
    assert_eq!(entry(&review, "link")["status"], "modified");
    env.refused(&task, &base, &review, &["link"], &msg_base_symlink("link"));
    assert!(std::fs::symlink_metadata(env.repo.join("link"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(env.host_status(), "");
}

#[test]
fn files_over_the_apply_cap_carry_no_task_blob_and_are_refused() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    let big = vec![b'x'; 32 * 1024 * 1024 + 1];
    write(&wt.join("huge.bin"), &big);
    let review = env.review(&task);
    let e = entry(&review, "huge.bin");
    assert!(
        e.get("taskBlob").is_none() && e.get("taskMode").is_none(),
        "{e}"
    );
    env.refused(
        &task,
        &base,
        &review,
        &["huge.bin"],
        &msg_no_content("huge.bin"),
    );
    assert!(!env.repo.join("huge.bin").exists());
}

#[test]
fn a_file_changed_since_review_is_refused() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"reviewed\n");
    write(&wt.join("new.txt"), b"reviewed\n");
    write(&wt.join("tool.sh"), b"#!/bin/sh\necho reviewed\n");
    std::fs::remove_file(wt.join("gone.txt")).unwrap();
    let review = env.review(&task);
    // content
    write(&wt.join("app.txt"), b"swapped after review\n");
    env.refused(&task, &base, &review, &["app.txt"], &msg_changed("app.txt"));
    // exec bit only
    chmod(&wt.join("tool.sh"), 0o755);
    env.refused(&task, &base, &review, &["tool.sh"], &msg_changed("tool.sh"));
    // gone / back
    std::fs::remove_file(wt.join("new.txt")).unwrap();
    env.refused(&task, &base, &review, &["new.txt"], &msg_changed("new.txt"));
    write(&wt.join("gone.txt"), b"back\n");
    env.refused(
        &task,
        &base,
        &review,
        &["gone.txt"],
        &msg_changed("gone.txt"),
    );
    // replaced by a symlink to the reviewed bytes' twin
    write(&wt.join("twin.txt"), b"reviewed\n");
    std::fs::remove_file(wt.join("app.txt")).unwrap();
    std::os::unix::fs::symlink("twin.txt", wt.join("app.txt")).unwrap();
    env.refused(&task, &base, &review, &["app.txt"], &msg_symlink("app.txt"));
    assert_eq!(env.host_status(), "", "nothing was written");
}

/// A case-only rename fails closed on a case-insensitive filesystem
/// (disclosed as unsupported); on a case-sensitive one it applies.
#[test]
fn a_case_only_rename_fails_closed_on_a_case_insensitive_filesystem() {
    let mut env = Env::new();
    let insensitive = env.repo.join("APP.TXT").exists();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    git(&wt, &["mv", "app.txt", "App.txt"]);
    let review = env.review(&task);
    let r = env.apply_ok(&task, &base, &review, &["App.txt"]);
    if insensitive {
        assert_eq!(r["applied"], false, "{r}");
        assert_eq!(r["abortReason"], msg_changed("app.txt"), "{r}");
        assert_eq!(env.host_status(), "");
    } else {
        assert_eq!(r["applied"], true, "{r}");
    }
}

// --- C1: directory/file swaps fail closed -----------------------------------

#[test]
fn c1_a_directory_file_swap_fails_closed_and_never_applies_unselected_deletions() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    std::fs::remove_dir_all(wt.join("d")).unwrap();
    write(&wt.join("d"), b"now a file\n");
    let review = env.review(&task);
    for (p, s) in [("d/x", "deleted"), ("d/y", "deleted"), ("d", "untracked")] {
        assert_eq!(entry(&review, p)["status"], s, "{review}");
    }
    // Only the new file: the host still has the DIRECTORY `d`, so the C2
    // walk (now run before any object is written, W-A) refuses it; behind
    // it, `update-index` without --replace and the exact-set check fail
    // closed too (unit tests `git_dir_session_builds_a_snapshot_from_
    // objects_only`, `the_exact_set_check_refuses_anything_but_the_selection`).
    env.refused(&task, &base, &review, &["d"], &msg_leading_path("d"));
    // A deletion under what is now a file is not "absent with real-directory
    // ancestors" (item 3).
    env.refused(&task, &base, &review, &["d", "d/x"], &msg_changed("d/x"));
    env.refused(&task, &base, &review, &[], &msg_changed("d/x"));
    assert_eq!(std::fs::read(env.repo.join("d/x")).unwrap(), b"x\n");
    assert_eq!(std::fs::read(env.repo.join("d/y")).unwrap(), b"y\n");
    assert_eq!(env.host_status(), "");
    assert!(apply_kinds(&env.events(&task)).is_empty());
}

// --- C2: host leading-path walk ---------------------------------------------

#[test]
fn c2_untracked_or_ignored_symlinked_ancestors_never_send_a_write_outside() {
    for ignored in [false, true] {
        let mut env = Env::new();
        let outside = env.base.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, env.repo.join("data")).unwrap();
        if ignored {
            // A host-only ignore file (`info/exclude` lives in the COMMON
            // dir and would hide the task's file from the review too).
            write(&env.repo.join(".gitignore"), b"data\n.gitignore\n");
            assert_eq!(git(&env.repo, &["check-ignore", "data"]), "data");
        }
        let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
        write(&wt.join("data/new.txt"), b"payload\n");
        let review = env.review(&task);
        env.refused(
            &task,
            &base,
            &review,
            &["data/new.txt"],
            &msg_leading_path("data/new.txt"),
        );
        assert_eq!(
            std::fs::read_dir(&outside).unwrap().count(),
            0,
            "nothing may appear outside the repository (ignored={ignored})"
        );
    }
    // A FILE ancestor in the host.
    let mut env = Env::new();
    write(&env.repo.join("data"), b"a file\n");
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("data/new.txt"), b"payload\n");
    let review = env.review(&task);
    env.refused(
        &task,
        &base,
        &review,
        &["data/new.txt"],
        &msg_leading_path("data/new.txt"),
    );
    assert_eq!(std::fs::read(env.repo.join("data")).unwrap(), b"a file\n");
}

// --- C3: no git process on the apply path reads the task worktree ----------

#[test]
fn c3_a_planted_git_file_never_runs_its_filter() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"base\nreviewed\n");
    let review = env.review(&task);

    // The agent repoints the worktree's `.git` at a gitdir it owns, whose
    // config defines a clean/smudge filter that leaves a marker.
    let marker = env.base.join("MARKER");
    let script = env.base.join("evil-filter.sh");
    write(
        &script,
        format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()).as_bytes(),
    );
    chmod(&script, 0o755);
    let evil = env.base.join("evil-gitdir");
    git(&env.base, &["init", "-q", "--bare", evil.to_str().unwrap()]);
    let host_objects = env.repo.join(".git/objects");
    write(
        &evil.join("objects/info/alternates"),
        format!("{}\n", host_objects.display()).as_bytes(),
    );
    git(&evil, &["config", "core.bare", "false"]);
    git(
        &evil,
        &["config", "filter.evil.clean", script.to_str().unwrap()],
    );
    git(
        &evil,
        &["config", "filter.evil.smudge", script.to_str().unwrap()],
    );
    git(&evil, &["config", "filter.evil.required", "true"]);
    write(&evil.join("info/attributes"), b"* filter=evil\n");
    write(&evil.join("HEAD"), format!("{base}\n").as_bytes());
    write(
        &wt.join(".git"),
        format!("gitdir: {}\n", evil.display()).as_bytes(),
    );
    // The trap is armed: an ordinary git process in the worktree runs it.
    git(&wt, &["hash-object", "app.txt"]);
    assert!(marker.exists(), "the test filter must be reachable");
    std::fs::remove_file(&marker).unwrap();

    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert!(
        !marker.exists(),
        "Core ran a git process in the task worktree: {r}"
    );
    assert_eq!(r["applied"], true, "{r}");
    assert_eq!(
        std::fs::read(env.repo.join("app.txt")).unwrap(),
        b"base\nreviewed\n"
    );
}

/// C3, stronger: the planted gitdir makes ANY git process that discovers
/// it from the worktree die. The apply still succeeds, so no git process on
/// the apply path (including the runner's own config enumeration) ran there.
#[test]
fn c3_no_git_process_on_the_apply_path_discovers_the_worktree() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"base\nreviewed\n");
    write(&wt.join("new.txt"), b"added\n");
    let review = env.review(&task);
    let evil = env.base.join("evil-gitdir");
    git(&env.base, &["init", "-q", "--bare", evil.to_str().unwrap()]);
    git(&evil, &["config", "core.repositoryformatversion", "99"]);
    write(
        &wt.join(".git"),
        format!("gitdir: {}\n", evil.display()).as_bytes(),
    );
    let out = std::process::Command::new("git")
        .args(["status"])
        .current_dir(&wt)
        .output()
        .unwrap();
    assert!(
        !out.status.success(),
        "the trap must make discovering git fail"
    );
    let r = env.apply_ok(&task, &base, &review, &["app.txt", "new.txt"]);
    assert_eq!(r["applied"], true, "{r}");
    assert_eq!(std::fs::read(env.repo.join("new.txt")).unwrap(), b"added\n");
}

// --- C4: review and diff bind the same single read ---------------------------

#[test]
fn c4_diff_task_blob_is_the_hash_of_the_bytes_it_displays() {
    let mut env = Env::new();
    let (task, wt, _base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"base\nshown\n");
    let big: String = (0..20_000).map(|i| format!("line {i}\n")).collect();
    write(&wt.join("big-untracked.txt"), big.as_bytes());
    let review = env.review(&task);
    for p in ["app.txt", "big-untracked.txt"] {
        let d = env.ok(
            "git.diff",
            serde_json::json!({"taskId": task, "path": p, "maxBytes": 1024}),
        );
        assert_eq!(d["taskBlob"], entry(&review, p)["taskBlob"], "{p}");
        assert_eq!(d["taskMode"], "100644", "{p}");
        // The FULL content's id, even when the display is cut.
        assert_eq!(d["taskBlob"], hash(&wt, p), "{p}");
    }
    let d = env.ok(
        "git.diff",
        serde_json::json!({"taskId": task, "path": "big-untracked.txt", "maxBytes": 1024}),
    );
    assert_eq!(d["truncated"], true);
    let d = env.ok(
        "git.diff",
        serde_json::json!({"taskId": task, "path": "app.txt"}),
    );
    assert!(d["patch"].as_str().unwrap().contains("+shown\n"), "{d}");
    assert!(
        d["patch"]
            .as_str()
            .unwrap()
            .starts_with("diff --git a/base b/task\n"),
        "{d}"
    );
    // A deleted entry has no task side.
    std::fs::remove_file(wt.join("gone.txt")).unwrap();
    let d = env.ok(
        "git.diff",
        serde_json::json!({"taskId": task, "path": "gone.txt"}),
    );
    assert!(d.get("taskBlob").is_none(), "{d}");
    assert!(
        d["patch"]
            .as_str()
            .unwrap()
            .contains("deleted file mode 100644"),
        "{d}"
    );
}

// --- Item 5 host gates --------------------------------------------------------

#[test]
fn host_gates_refuse_dirty_untracked_ignored_paths_and_a_moved_head() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    write(&wt.join("new.txt"), b"task\n");
    let review = env.review(&task);
    // Uncommitted user work on a touched path.
    write(&env.repo.join("app.txt"), b"user work\n");
    env.refused(
        &task,
        &base,
        &review,
        &["app.txt"],
        &msg_dirty(&["app.txt"]),
    );
    assert_eq!(
        std::fs::read(env.repo.join("app.txt")).unwrap(),
        b"user work\n"
    );
    git(&env.repo, &["checkout", "-q", "--", "app.txt"]);
    // An untracked user file where the task creates one.
    write(&env.repo.join("new.txt"), b"user file\n");
    env.refused(
        &task,
        &base,
        &review,
        &["new.txt"],
        &msg_dirty(&["new.txt"]),
    );
    // ... and an IGNORED one.
    write(&env.repo.join(".git/info/exclude"), b"new.txt\n");
    env.refused(
        &task,
        &base,
        &review,
        &["new.txt"],
        &msg_dirty(&["new.txt"]),
    );
    assert_eq!(
        std::fs::read(env.repo.join("new.txt")).unwrap(),
        b"user file\n"
    );
    std::fs::remove_file(env.repo.join("new.txt")).unwrap();
    // HEAD moved past the base.
    write(&env.repo.join("other.txt"), b"x\n");
    git(&env.repo, &["add", "other.txt"]);
    git(&env.repo, &["commit", "-qm", "user commit"]);
    let head = git(&env.repo, &["rev-parse", "HEAD"]);
    env.refused(
        &task,
        &base,
        &review,
        &["app.txt"],
        &format!("your repository's HEAD is {head}, not the task's base {base}{NOTHING}"),
    );
    assert_eq!(std::fs::read(env.repo.join("app.txt")).unwrap(), b"base\n");
}

#[test]
fn w3_hidden_index_entries_are_refused() {
    for flag in ["--assume-unchanged", "--skip-worktree"] {
        let mut env = Env::new();
        let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
        write(&wt.join("app.txt"), b"task\n");
        let review = env.review(&task);
        git(&env.repo, &["update-index", flag, "app.txt"]);
        // The flag hides this user edit from `git status`.
        write(&env.repo.join("app.txt"), b"hidden user work\n");
        env.refused(
            &task,
            &base,
            &review,
            &["app.txt"],
            &msg_hidden(&["app.txt"]),
        );
        assert_eq!(
            std::fs::read(env.repo.join("app.txt")).unwrap(),
            b"hidden user work\n",
            "{flag}"
        );
    }
}

#[test]
fn r5_paths_the_host_filters_are_refused() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    // The host's own attributes (not the task's) name a filter.
    write(
        &env.repo.join(".git/info/attributes"),
        b"app.txt filter=lfs\n",
    );
    env.refused(
        &task,
        &base,
        &review,
        &["app.txt"],
        &msg_filtered("app.txt", "lfs"),
    );
    assert_eq!(std::fs::read(env.repo.join("app.txt")).unwrap(), b"base\n");
}

/// R5 must read the host's own WORK-TREE `.gitattributes` (check-attr runs
/// without the `GIT_ATTR_SOURCE` override that hides it elsewhere).
#[test]
fn r5_a_filter_in_the_hosts_committed_gitattributes_is_refused() {
    let mut env = Env::new();
    write(&env.repo.join(".gitattributes"), b"app.txt filter=lfs\n");
    git(&env.repo, &["add", ".gitattributes"]);
    git(&env.repo, &["commit", "-qm", "attributes"]);
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    env.refused(
        &task,
        &base,
        &review,
        &["app.txt"],
        &msg_filtered("app.txt", "lfs"),
    );
    assert_eq!(std::fs::read(env.repo.join("app.txt")).unwrap(), b"base\n");
}

#[test]
fn a_redirected_or_unborn_host_is_refused() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    // A repository-local core.worktree sends git somewhere else.
    let elsewhere = env.base.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    git(
        &env.repo,
        &["config", "core.worktree", elsewhere.to_str().unwrap()],
    );
    env.refused(
        &task,
        &base,
        &review,
        &["app.txt"],
        "git does not place your repository's work tree at its root (is a repository-local \
         core.worktree set?); nothing was written",
    );
    assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
    git(&env.repo, &["config", "--unset", "core.worktree"]);
    // An unborn branch: the host is not at the task's base.
    git(&env.repo, &["checkout", "-q", "--orphan", "fresh"]);
    env.refused(
        &task,
        &base,
        &review,
        &["app.txt"],
        "your repository has no commit, so it is not at the task's base; nothing was written",
    );
    assert_eq!(std::fs::read(env.repo.join("app.txt")).unwrap(), b"base\n");
}

#[test]
fn a_submodule_in_the_host_is_refused() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let origin = env.base.join("lib-origin");
    init_repo(&origin);
    git(
        &env.repo,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            origin.to_str().unwrap(),
            "vendor/lib",
        ],
    );
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], false, "{r}");
    let reason = r["abortReason"].as_str().unwrap();
    assert!(
        reason.contains("vendor/lib") && reason.contains("submodule"),
        "{reason}"
    );
    assert!(reason.ends_with(NOTHING), "{reason}");
    assert_eq!(std::fs::read(env.repo.join("app.txt")).unwrap(), b"base\n");
}

// --- W4: hostile repository config cannot change what is written -----------

#[test]
fn w4_hostile_repo_config_cannot_change_the_written_bytes_or_modes() {
    let hostile: [(&str, &str); 15] = [
        ("core.autocrlf", "true"),
        ("core.safecrlf", "true"),
        ("core.symlinks", "false"),
        ("core.fileMode", "false"),
        ("core.protectHFS", "false"),
        ("core.protectNTFS", "false"),
        ("core.checkStat", "minimal"),
        ("core.trustctime", "false"),
        ("core.splitIndex", "true"),
        ("core.sparseCheckout", "true"),
        ("index.sparse", "true"),
        ("apply.whitespace", "fix"),
        ("apply.whitespace", "error"),
        ("apply.ignoreWhitespace", "change"),
        ("core.eol", "crlf"),
    ];
    for (key, value) in hostile {
        let mut env = Env::new();
        let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
        let content: &[u8] = b"base\ntrailing space   \n\tindented\n";
        write(&wt.join("app.txt"), content);
        chmod(&wt.join("tool.sh"), 0o755);
        let review = env.review(&task);
        git(&env.repo, &["config", key, value]);
        let r = env.apply_ok(&task, &base, &review, &["app.txt", "tool.sh"]);
        assert_eq!(r["applied"], true, "{key}={value}: {r}");
        assert_eq!(
            std::fs::read(env.repo.join("app.txt")).unwrap(),
            content,
            "{key}={value}"
        );
        assert_eq!(
            staged(&env.repo, "app.txt").unwrap(),
            ("100644".to_string(), hash(&wt, "app.txt")),
            "{key}={value}"
        );
        assert_eq!(
            staged(&env.repo, "tool.sh").unwrap().0,
            "100755",
            "{key}={value}"
        );
        assert_eq!(
            mode_of(&env.repo.join("tool.sh")) & 0o111,
            0o111,
            "{key}={value}"
        );
        let shared = std::fs::read_dir(env.repo.join(".git"))
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with("sharedindex."));
        assert!(!shared, "{key}={value}: a split index was written");
    }
}

// --- W1 / R6 / W2: outcomes after git's checks passed ----------------------

#[test]
fn w1_a_write_failure_after_the_check_is_partial_never_nothing_written() {
    let mut env = Env::with(|repo| {
        let lock = repo.join(".git/index.lock");
        Seams {
            before_write: hook(move |_| std::fs::write(&lock, b"").unwrap()),
            ..Seams::default()
        }
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], false, "{r}");
    assert_eq!(r["partial"], true, "{r}");
    assert_eq!(r["abortReason"], msg_write_failed(&env.repo_str()));
    assert_eq!(r["appliedFiles"], serde_json::json!(["app.txt"]));
    let ev = env.events(&task);
    assert_eq!(apply_kinds(&ev), ["git.apply.started", "git.apply.failed"]);
    let failed = &ev.last().unwrap().1;
    assert_eq!(failed["partial"], true);
    assert_eq!(failed["reason"], r["abortReason"]);
}

#[test]
fn r6_a_killed_write_is_partial_and_names_the_index_lock() {
    let mut env = Env::with(|_| Seams {
        limits: Some(ApplyLimits {
            write_timeout: Duration::from_nanos(1),
            ..ApplyLimits::default()
        }),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], false, "{r}");
    assert_eq!(r["partial"], true, "{r}");
    assert_eq!(r["abortReason"], msg_write_killed(&env.repo_str()));
}

#[test]
fn w2_post_write_verification_reports_a_mismatch_as_partial() {
    let mut env = Env::with(|repo| {
        let file = repo.join("app.txt");
        Seams {
            after_write: hook(move |_| std::fs::write(&file, b"raced\n").unwrap()),
            ..Seams::default()
        }
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], false, "{r}");
    assert_eq!(r["partial"], true, "{r}");
    assert_eq!(r["abortReason"], msg_verify_failed(&env.repo_str()));
    assert_eq!(
        apply_kinds(&env.events(&task)),
        ["git.apply.started", "git.apply.failed"]
    );
}

// --- W7 durability, retries, W6 locking --------------------------------------

#[test]
fn w7_the_start_is_durable_before_the_first_host_write() {
    type Seen = Option<(Vec<String>, Vec<u8>)>;
    let seen: Arc<Mutex<Seen>> = Arc::default();
    let task_slot: Arc<Mutex<String>> = Arc::default();
    let (seen2, slot2) = (Arc::clone(&seen), Arc::clone(&task_slot));
    let mut env = Env::with(move |repo| {
        let file = repo.join("app.txt");
        Seams {
            before_write: hook(move |inner| {
                let task = slot2.lock().unwrap().clone();
                let kinds = apply_kinds(&events_of(inner, &task));
                *seen2.lock().unwrap() = Some((kinds, std::fs::read(&file).unwrap()));
            }),
            ..Seams::default()
        }
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    *task_slot.lock().unwrap() = task.clone();
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], true, "{r}");
    let (kinds, host_bytes) = seen.lock().unwrap().clone().unwrap();
    assert_eq!(
        kinds,
        ["git.apply.started"],
        "durable start, no outcome yet"
    );
    assert_eq!(host_bytes, b"base\n", "the host was not written yet");
    assert_eq!(
        apply_kinds(&env.events(&task)),
        ["git.apply.started", "git.applied"]
    );
}

#[test]
fn a_lost_answer_retry_fails_closed() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    std::fs::remove_file(wt.join("gone.txt")).unwrap();
    let review = env.review(&task);
    let first = env.apply_ok(&task, &base, &review, &["app.txt", "gone.txt"]);
    assert_eq!(first["applied"], true, "{first}");
    // The client never saw that answer and retries the same request.
    env.refused(
        &task,
        &base,
        &review,
        &["app.txt", "gone.txt"],
        &msg_dirty(&["app.txt", "gone.txt"]),
    );
    assert_eq!(std::fs::read(env.repo.join("app.txt")).unwrap(), b"task\n");
}

#[test]
fn w6_concurrent_apply_discard_and_writer_tasks_get_conflict() {
    let second: Arc<Mutex<Option<serde_json::Value>>> = Arc::default();
    let answers: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let (second2, answers2) = (Arc::clone(&second), Arc::clone(&answers));
    let mut env = Env::with(move |_| Seams {
        before_write: hook(move |inner| {
            let Some(params) = second2.lock().unwrap().clone() else {
                return;
            };
            let apply = rpc_on(inner, "c1", "git.apply", params.clone());
            let discard = discard_task_worktree(inner, params["discardTask"].as_str().unwrap())
                .err()
                .map(
                    |f| serde_json::json!({"code": format!("{:?}", f.code), "message": f.message}),
                );
            answers2.lock().unwrap().push(apply);
            answers2.lock().unwrap().push(discard.unwrap_or_default());
        }),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    let (task2, wt2, _) = env.task(WorkspaceMode::HostWorktree);
    let (finished, _, _) = env.task(WorkspaceMode::HostWorktree);
    env.ok("task.cancel", serde_json::json!({"taskId": finished}));
    write(&wt.join("app.txt"), b"one\n");
    write(&wt2.join("new.txt"), b"two\n");
    let review = env.review(&task);
    let review2 = env.review(&task2);
    let mut p2 = apply_params(&task2, &base, &review2, &["new.txt"]);
    p2["discardTask"] = serde_json::json!(finished);
    *second.lock().unwrap() = Some(p2.clone());

    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], true, "{r}");
    let got = answers.lock().unwrap().clone();
    let holder = format!("git.apply:{task}");
    assert_eq!(got[0]["err"]["code"], "CONFLICT", "{got:?}");
    assert_eq!(
        got[0]["err"]["message"],
        format!(
            "{} is busy: {holder} holds its writer lock (a running writer task, another apply \
             or a worktree discard); nothing was written",
            env.repo_str()
        )
    );
    assert_eq!(got[1]["code"], "Conflict", "{got:?}");
    assert!(
        got[1]["message"].as_str().unwrap().starts_with(&holder),
        "{got:?}"
    );
    assert!(!env.repo.join("new.txt").exists());
    // The lock is released with the answer: the second apply now runs.
    *second.lock().unwrap() = None;
    p2.as_object_mut().unwrap().remove("discardTask");
    let r = env.ok("git.apply", p2);
    assert_eq!(r["applied"], true, "{r}");

    // A writer task bound to the repository path holds the same lock.
    let (task3, wt3, base3) = env.task(WorkspaceMode::HostWorktree);
    git(&env.repo, &["reset", "-q", "--hard"]);
    std::fs::remove_file(env.repo.join("new.txt")).ok();
    write(&wt3.join("app.txt"), b"three\n");
    let review3 = env.review(&task3);
    // A direct_mount writer is admitted under `canonicalize(<registered
    // path>)` (create_task_keyed → registered_repository); the scaffold
    // never marks one running (no verified adapter), so the test does,
    // with that same derivation.
    let (dm, _, _) = env.task(WorkspaceMode::DirectMount);
    let key = std::fs::canonicalize(&env.repo)
        .unwrap()
        .display()
        .to_string();
    env.inner
        .lock_scheduler()
        .mark_running(&dm, &env.project_id, Some(&key), WorkspaceMode::DirectMount)
        .unwrap();
    let e = env.err(
        "git.apply",
        apply_params(&task3, &base3, &review3, &["app.txt"]),
    );
    assert_eq!(e["code"], "CONFLICT", "{e}");
    assert!(
        e["message"]
            .as_str()
            .unwrap()
            .contains(&format!("{dm} holds its writer lock")),
        "{e}"
    );
    env.inner.lock_scheduler().mark_finished(&dm);
    // W-C: the unfinished direct_mount task still mounts the repository.
    let e = env.err(
        "git.apply",
        apply_params(&task3, &base3, &review3, &["app.txt"]),
    );
    assert_eq!(e["code"], "CONFLICT", "{e}");
    assert_eq!(
        e["message"],
        msg_mounted(&format!("direct_mount task {dm}"))
    );
    env.ok("task.cancel", serde_json::json!({"taskId": dm}));
    let r = env.apply_ok(&task3, &base3, &review3, &["app.txt"]);
    assert_eq!(r["applied"], true, "{r}");
}

// --- Security review follow-ups (W-A, W-B, W-C, I1, I2, I3) ----------------

/// Files and bytes under the host's `.git/objects`.
fn objects_state(repo: &Path) -> (usize, u64) {
    fn walk(d: &Path, acc: &mut (usize, u64)) {
        let entries = std::fs::read_dir(d).unwrap_or_else(|e| panic!("{}: {e}", d.display()));
        for e in entries.filter_map(Result::ok) {
            let m = e
                .metadata()
                .unwrap_or_else(|err| panic!("{}: {err}", e.path().display()));
            if m.is_dir() {
                walk(&e.path(), acc);
            } else {
                acc.0 += 1;
                acc.1 += m.len();
            }
        }
    }
    let mut acc = (0, 0);
    walk(&repo.join(".git/objects"), &mut acc);
    acc
}

/// W-A: the cumulative new content is capped BEFORE any temp copy or
/// `hash-object -w`, so a refused apply leaves the host object store as it
/// was (probe B wrote 96 MiB of loose objects before refusing).
#[test]
fn wa_oversized_content_is_refused_before_any_object_is_written() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    let names: Vec<String> = (0..5).map(|i| format!("big{i}.bin")).collect();
    for (i, n) in names.iter().enumerate() {
        write(&wt.join(n), &vec![b'a' + i as u8; 16 * 1024 * 1024]);
    }
    let review = env.review(&task);
    let before = objects_state(&env.repo);
    let paths: Vec<&str> = names.iter().map(String::as_str).collect();
    env.refused(&task, &base, &review, &paths, MSG_CONTENT_TOO_LARGE);
    assert_eq!(objects_state(&env.repo), before, "no object was written");
    assert!(apply_kinds(&env.events(&task)).is_empty());
}

/// W-A: the cheap host gates (HEAD, touched-path status, the C2 walk) run
/// before any object is written.
#[test]
fn wa_a_host_gate_refusal_writes_no_objects() {
    let mut env = Env::new();
    let outside = env.base.join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, env.repo.join("data")).unwrap();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"never stored\n");
    write(&wt.join("data/new.txt"), b"never stored either\n");
    let review = env.review(&task);
    let before = objects_state(&env.repo);
    // dirty touched path
    write(&env.repo.join("app.txt"), b"user work\n");
    env.refused(
        &task,
        &base,
        &review,
        &["app.txt"],
        &msg_dirty(&["app.txt"]),
    );
    assert_eq!(objects_state(&env.repo), before);
    git(&env.repo, &["checkout", "-q", "--", "app.txt"]);
    // C2
    env.refused(
        &task,
        &base,
        &review,
        &["data/new.txt"],
        &msg_leading_path("data/new.txt"),
    );
    assert_eq!(objects_state(&env.repo), before);
    // HEAD moved (the commit's own objects are counted after it)
    write(&env.repo.join("other.txt"), b"x\n");
    git(&env.repo, &["add", "other.txt"]);
    git(&env.repo, &["commit", "-qm", "user commit"]);
    let moved = objects_state(&env.repo);
    let head = git(&env.repo, &["rev-parse", "HEAD"]);
    env.refused(
        &task,
        &base,
        &review,
        &["app.txt"],
        &format!("your repository's HEAD is {head}, not the task's base {base}{NOTHING}"),
    );
    assert_eq!(objects_state(&env.repo), moved);
}

/// W-B: one deadline for prepare + check; past it, nothing is written and
/// no start is recorded.
#[test]
fn wb_an_exhausted_prepare_budget_refuses_before_the_start() {
    let mut env = Env::with(|_| Seams {
        limits: Some(ApplyLimits {
            prepare_budget: Duration::from_nanos(1),
            ..ApplyLimits::default()
        }),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let before = objects_state(&env.repo);
    env.refused(&task, &base, &review, &["app.txt"], MSG_PREPARE_TOO_SLOW);
    assert!(apply_kinds(&env.events(&task)).is_empty());
    assert_eq!(objects_state(&env.repo), before);
    assert_eq!(env.host_status(), "");
}

/// W-B / W-C: the budget and the direct-mount check are BOTH re-checked
/// after prepare, right before the durable start; either refusal leaves no
/// start and no write.
#[test]
fn wb_wc_budget_and_mounts_are_rechecked_right_before_the_start() {
    // Budget: prepare succeeds, then the seam outlasts the budget.
    let mut env = Env::with(|_| Seams {
        limits: Some(ApplyLimits {
            prepare_budget: Duration::from_secs(3),
            ..ApplyLimits::default()
        }),
        before_start: hook(|_| std::thread::sleep(Duration::from_millis(3100))),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let before = objects_state(&env.repo);
    env.refused(&task, &base, &review, &["app.txt"], MSG_PREPARE_TOO_SLOW);
    assert!(apply_kinds(&env.events(&task)).is_empty());
    assert_eq!(env.host_status(), "");
    assert_eq!(objects_state(&env.repo), before, "W-N2");

    // Mount: a direct_mount binding appears while Core prepares.
    let mut env = Env::with(|_| Seams {
        before_start: hook(|inner| {
            let db = inner.lock_db();
            let (project, repo): (String, String) = db
                .conn()
                .query_row("SELECT project_id, id FROM repositories", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            db.conn()
                .execute(
                    "INSERT INTO sandbox_bindings (id, project_id, sandbox_name, \
                     workspace_mode, repo_id, created_at) VALUES ('late', ?1, 'atlas-late', \
                     'direct_mount', ?2, 't')",
                    rusqlite::params![project, repo],
                )
                .unwrap();
        }),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let before = objects_state(&env.repo);
    let e = env.err(
        "git.apply",
        apply_params(&task, &base, &review, &["app.txt"]),
    );
    assert_eq!(e["code"], "CONFLICT", "{e}");
    assert_eq!(e["message"], msg_mounted("sandbox \"atlas-late\""));
    assert!(apply_kinds(&env.events(&task)).is_empty());
    assert_eq!(env.host_status(), "");
    assert_eq!(objects_state(&env.repo), before, "W-N2");
}

/// W-N2: a patch over the cap is refused AFTER the snapshot was built (the
/// new content itself is under the content cap: incompressible binary
/// content grows by about a quarter in a binary patch); no snapshot object
/// is left in the host.
#[test]
fn wn2_a_too_large_patch_leaves_no_objects() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    // Two files under the 32 MiB per-file cap, 54 MiB in all (under the
    // 64 MiB content cap); their binary patch is about 68 MiB.
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    for name in ["noise-a.bin", "noise-b.bin"] {
        let mut bytes = vec![0u8; 27 * 1024 * 1024];
        for b in bytes.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *b = x as u8;
        }
        write(&wt.join(name), &bytes);
    }
    let review = env.review(&task);
    let before = objects_state(&env.repo);
    env.refused(
        &task,
        &base,
        &review,
        &["noise-a.bin", "noise-b.bin"],
        MSG_PATCH_TOO_LARGE,
    );
    assert_eq!(objects_state(&env.repo), before);
    assert!(apply_kinds(&env.events(&task)).is_empty());
}

/// W-N2: `git apply --check` refusing the patch (the host file changed
/// after the gates, through the test seam) leaves no snapshot object.
#[test]
fn wn2_a_patch_that_does_not_apply_leaves_no_objects() {
    let mut env = Env::with(|repo| {
        let target = repo.join("app.txt");
        Seams {
            before_check: hook(move |_| std::fs::write(&target, b"user edit\n").unwrap()),
            ..Seams::default()
        }
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let before = objects_state(&env.repo);
    let r = env.refused(&task, &base, &review, &["app.txt"], MSG_CHECK_FAILED);
    assert_eq!(r["conflictedFiles"], serde_json::json!(["app.txt"]), "{r}");
    assert_eq!(objects_state(&env.repo), before);
    assert!(apply_kinds(&env.events(&task)).is_empty());
}

/// W-N2: the snapshot's own objects never reach the host, and Core's temp
/// directory (patch, temp index, quarantine) is gone after a refusal and
/// after a success.
#[test]
fn wn2_the_snapshot_tree_stays_out_of_the_host_and_core_temp_is_removed() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    write(&wt.join("fresh.txt"), b"fresh\n");
    let review = env.review(&task);
    let tmp_root = env.base.join("data").join("tmp");
    let leftovers = |root: &Path| -> Vec<String> {
        match std::fs::read_dir(root) {
            Ok(rd) => rd
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
            Err(_) => vec![],
        }
    };
    // A refusal (dirty touched path) ...
    write(&env.repo.join("app.txt"), b"user work\n");
    env.refused(
        &task,
        &base,
        &review,
        &["app.txt"],
        &msg_dirty(&["app.txt"]),
    );
    assert_eq!(leftovers(&tmp_root), Vec::<String>::new());
    git(&env.repo, &["checkout", "-q", "--", "app.txt"]);
    // ... and a success.
    let r = env.apply_ok(&task, &base, &review, &["app.txt", "fresh.txt"]);
    assert_eq!(r["applied"], true, "{r}");
    assert_eq!(leftovers(&tmp_root), Vec::<String>::new());
    let tree = r["snapshotTree"].as_str().unwrap();
    let present = std::process::Command::new("git")
        .args(["cat-file", "-e", tree])
        .current_dir(&env.repo)
        .status()
        .unwrap()
        .success();
    assert!(!present, "the snapshot tree is not in the host store");
    assert_eq!(
        std::fs::read(env.repo.join("fresh.txt")).unwrap(),
        b"fresh\n"
    );
}

/// I3 + W-B: a check that times out (or fails to run) is not "does not
/// apply cleanly".
#[test]
fn i3_a_check_that_could_not_run_is_reported_honestly() {
    let mut env = Env::with(|_| Seams {
        limits: Some(ApplyLimits {
            check_timeout: Duration::from_nanos(1),
            ..ApplyLimits::default()
        }),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let before = objects_state(&env.repo);
    let r = env.refused(&task, &base, &review, &["app.txt"], MSG_CHECK_UNAVAILABLE);
    assert_eq!(r["conflictedFiles"], serde_json::json!([]));
    assert!(apply_kinds(&env.events(&task)).is_empty());
    assert_eq!(env.host_status(), "");
    // W-N2: the snapshot was built before the check; none of it is left.
    assert_eq!(objects_state(&env.repo), before);
}

/// W-B: each verification call is capped; a verify that cannot finish is
/// a partial outcome with its own wording.
#[test]
fn wb_a_verification_that_cannot_finish_is_partial() {
    let mut env = Env::with(|_| Seams {
        limits: Some(ApplyLimits {
            verify_timeout: Duration::from_nanos(1),
            ..ApplyLimits::default()
        }),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], false, "{r}");
    assert_eq!(r["partial"], true, "{r}");
    assert_eq!(r["abortReason"], msg_verify_unavailable(&env.repo_str()));
    assert_eq!(
        apply_kinds(&env.events(&task)),
        ["git.apply.started", "git.apply.failed"]
    );
}

/// W-B: the write phase has ONE budget that also covers the configuration
/// read before `git apply`. Cut off there, git apply never ran: an honest
/// "nothing was written" failure (not a partial), host untouched.
#[test]
fn wb_a_write_cut_off_before_git_apply_writes_nothing() {
    let mut env = Env::with(|_| Seams {
        limits: Some(ApplyLimits {
            write_budget: Duration::from_nanos(1),
            ..ApplyLimits::default()
        }),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let host_before = std::fs::read(env.repo.join("app.txt")).unwrap();
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], false, "{r}");
    assert_ne!(r["partial"], true, "{r}");
    assert_eq!(r["abortReason"], MSG_WRITE_NOT_RUN);
    assert_eq!(
        std::fs::read(env.repo.join("app.txt")).unwrap(),
        host_before
    );
    assert_eq!(
        apply_kinds(&env.events(&task)),
        ["git.apply.started", "git.apply.failed"]
    );
}

/// I-N1: with less than the floor left of the write phase after its
/// configuration read, `git apply` is not started: an honest "nothing was
/// written", not a partial.
#[test]
fn in1_git_apply_never_starts_with_less_than_the_floor_left() {
    let mut env = Env::with(|_| Seams {
        limits: Some(ApplyLimits {
            write_budget: Duration::from_secs(4),
            ..ApplyLimits::default()
        }),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let host_before = std::fs::read(env.repo.join("app.txt")).unwrap();
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], false, "{r}");
    assert_ne!(r["partial"], true, "{r}");
    assert_eq!(r["abortReason"], MSG_WRITE_TOO_LATE);
    assert_eq!(
        std::fs::read(env.repo.join("app.txt")).unwrap(),
        host_before
    );
    assert_eq!(env.host_status(), "");
    assert_eq!(
        apply_kinds(&env.events(&task)),
        ["git.apply.started", "git.apply.failed"]
    );
}

/// W-B: the verification phase has ONE budget (each call is also capped):
/// running out of it after a write is a partial with the verify wording.
#[test]
fn wb_the_verification_phase_has_one_budget() {
    let mut env = Env::with(|_| Seams {
        limits: Some(ApplyLimits {
            verify_budget: Duration::from_nanos(1),
            ..ApplyLimits::default()
        }),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], false, "{r}");
    assert_eq!(r["partial"], true, "{r}");
    assert_eq!(r["abortReason"], msg_verify_unavailable(&env.repo_str()));
    assert_eq!(std::fs::read(env.repo.join("app.txt")).unwrap(), b"task\n");
}

/// W-C: a live direct_mount sandbox binding (or unfinished direct_mount
/// task) on the same registered repository can write while Core writes.
#[test]
fn wc_a_direct_mount_sandbox_on_the_repository_blocks_apply() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let repo_id: String = env
        .inner
        .lock_db()
        .conn()
        .query_row(
            "SELECT id FROM repositories WHERE project_id = ?1",
            [&env.project_id],
            |r| r.get(0),
        )
        .unwrap();
    // Both stored shapes of the mode (bare and the pre-0004 JSON-quoted).
    for (id, mode) in [("b1", "direct_mount"), ("b2", "\"direct_mount\"")] {
        env.inner
            .lock_db()
            .conn()
            .execute(
                "INSERT INTO sandbox_bindings (id, project_id, sandbox_name, workspace_mode, \
                 repo_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 't')",
                rusqlite::params![id, env.project_id, format!("atlas-{id}"), mode, repo_id],
            )
            .unwrap();
        let e = env.err(
            "git.apply",
            apply_params(&task, &base, &review, &["app.txt"]),
        );
        assert_eq!(e["code"], "CONFLICT", "{e}");
        assert_eq!(
            e["message"],
            msg_mounted(&format!("sandbox \"atlas-{id}\""))
        );
        env.inner
            .lock_db()
            .conn()
            .execute(
                "UPDATE sandbox_bindings SET removed_at = 't' WHERE id = ?1",
                [id],
            )
            .unwrap();
    }
    // A binding that does not mount the repository does not block.
    env.inner
        .lock_db()
        .conn()
        .execute(
            "INSERT INTO sandbox_bindings (id, project_id, sandbox_name, workspace_mode, \
             repo_id, created_at) VALUES ('b3', ?1, 'atlas-clone', 'sbx_clone', ?2, 't')",
            rusqlite::params![env.project_id, repo_id],
        )
        .unwrap();
    assert_eq!(env.host_status(), "");
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], true, "{r}");
}

/// W-N1: a direct_mount `sandbox.create` takes the repository writer lock,
/// so one that starts while an apply holds it is refused (CONFLICT, nothing
/// created, the idempotency key not consumed); a mountless create is not.
#[test]
fn wn1_an_apply_in_progress_refuses_a_direct_mount_create() {
    let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let slot = Arc::clone(&seen);
    let mut env = Env::with(move |repo| {
        let repo = repo.display().to_string();
        Seams {
            before_start: hook(move |inner| {
                let project: String = inner
                    .lock_db()
                    .conn()
                    .query_row("SELECT id FROM projects", [], |r| r.get(0))
                    .unwrap();
                let direct = rpc_on(
                    inner,
                    "c1",
                    "sandbox.create",
                    serde_json::json!({"name": "atlas-live", "projectId": project,
                        "workspaceMode": "direct_mount", "repoPath": repo,
                        "idempotencyKey": "wn1-key"}),
                );
                let mountless = rpc_on(
                    inner,
                    "c2",
                    "sandbox.create",
                    serde_json::json!({"name": "atlas-plain", "projectId": project,
                        "workspaceMode": "mountless"}),
                );
                slot.lock().unwrap().extend([direct, mountless]);
            }),
            ..Seams::default()
        }
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], true, "{r}");
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen[0]["err"]["code"], "CONFLICT", "{}", seen[0]);
    assert_eq!(
        seen[0]["err"]["message"],
        msg_create_repo_busy(&env.repo_str(), &format!("git.apply:{task}"))
    );
    assert_eq!(seen[1]["err"]["code"], "NOT_INSTALLED", "{}", seen[1]);
    let bindings: i64 = env
        .inner
        .lock_db()
        .conn()
        .query_row("SELECT COUNT(*) FROM sandbox_bindings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(bindings, 0, "nothing was created");
    // The key was never claimed: a retry runs (no sbx here: NOT_INSTALLED).
    let retry = env.rpc(
        "sandbox.create",
        serde_json::json!({"name": "atlas-live", "projectId": env.project_id,
            "workspaceMode": "direct_mount", "repoPath": env.repo_str(),
            "idempotencyKey": "wn1-key"}),
    );
    assert_eq!(retry["err"]["code"], "NOT_INSTALLED", "{retry}");
}

/// W-N1: an apply that starts while a direct_mount create of the same
/// repository is in flight is refused; once the create is over, it runs.
#[test]
fn wn1_a_direct_mount_create_in_flight_refuses_an_apply() {
    let params: Arc<Mutex<Option<serde_json::Value>>> = Arc::default();
    let seen: Arc<Mutex<Option<serde_json::Value>>> = Arc::default();
    let (p, out) = (Arc::clone(&params), Arc::clone(&seen));
    let mut env = Env::with(move |_| Seams {
        create_claim: Some(CreateClaimHook(Arc::new(move |inner: &ServerInner| {
            if let Some(params) = p.lock().unwrap().clone() {
                *out.lock().unwrap() = Some(rpc_on(inner, "a1", "git.apply", params));
            }
        }))),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    *params.lock().unwrap() = Some(apply_params(&task, &base, &review, &["app.txt"]));
    let create = env.rpc(
        "sandbox.create",
        serde_json::json!({"name": "atlas-live", "projectId": env.project_id,
            "workspaceMode": "direct_mount", "repoPath": env.repo_str(),
            "idempotencyKey": "wn1-inflight"}),
    );
    // No sbx in this harness: the create itself ends NOT_INSTALLED.
    assert_eq!(create["err"]["code"], "NOT_INSTALLED", "{create}");
    let during = seen
        .lock()
        .unwrap()
        .clone()
        .expect("the hook ran the apply");
    assert_eq!(during["err"]["code"], "CONFLICT", "{during}");
    assert_eq!(
        during["err"]["message"],
        msg_mount_being_created(&env.repo_str(), "atlas-live")
    );
    assert_eq!(env.host_status(), "");
    assert!(apply_kinds(&env.events(&task)).is_empty());
    *params.lock().unwrap() = None;
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], true, "after the create, the apply runs: {r}");
}

/// W-N1: two direct_mount creates of the same repository: the second is
/// refused while the first is in flight, with its own wording.
#[test]
fn wn1_a_second_direct_mount_create_waits_for_the_first() {
    let seen: Arc<Mutex<Option<serde_json::Value>>> = Arc::default();
    let out = Arc::clone(&seen);
    let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut env = Env::with(move |repo| {
        let repo = repo.display().to_string();
        Seams {
            create_claim: Some(CreateClaimHook(Arc::new(move |inner: &ServerInner| {
                if fired.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                let project: String = inner
                    .lock_db()
                    .conn()
                    .query_row("SELECT id FROM projects", [], |r| r.get(0))
                    .unwrap();
                *out.lock().unwrap() = Some(rpc_on(
                    inner,
                    "c2",
                    "sandbox.create",
                    serde_json::json!({"name": "atlas-two", "projectId": project,
                        "workspaceMode": "direct_mount", "repoPath": repo}),
                ));
            }))),
            ..Seams::default()
        }
    });
    let first = env.rpc(
        "sandbox.create",
        serde_json::json!({"name": "atlas-one", "projectId": env.project_id,
            "workspaceMode": "direct_mount", "repoPath": env.repo_str()}),
    );
    assert_eq!(first["err"]["code"], "NOT_INSTALLED", "{first}");
    let second = seen.lock().unwrap().clone().expect("the hook ran");
    assert_eq!(second["err"]["code"], "CONFLICT", "{second}");
    assert_eq!(
        second["err"]["message"],
        msg_create_mount_in_progress(&env.repo_str(), "atlas-one")
    );
}

/// I-N3: a direct_mount binding whose repository is unknown (NULL
/// `repo_id`) blocks every apply (fail-safe); a mountless binding — whose
/// repository is NULL by design — does not.
#[test]
fn in3_a_direct_mount_binding_without_a_repository_blocks_apply() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let insert = |env: &Env, id: &str, mode: &str| {
        env.inner
            .lock_db()
            .conn()
            .execute(
                "INSERT INTO sandbox_bindings (id, project_id, sandbox_name, workspace_mode, \
                 repo_id, created_at) VALUES (?1, ?2, ?3, ?4, NULL, 't')",
                rusqlite::params![id, env.project_id, format!("atlas-{id}"), mode],
            )
            .unwrap();
    };
    insert(&env, "m1", "mountless");
    insert(&env, "d1", "direct_mount");
    let e = env.err(
        "git.apply",
        apply_params(&task, &base, &review, &["app.txt"]),
    );
    assert_eq!(e["code"], "CONFLICT", "{e}");
    assert_eq!(e["message"], msg_mounted("sandbox \"atlas-d1\""));
    env.inner
        .lock_db()
        .conn()
        .execute(
            "UPDATE sandbox_bindings SET removed_at = 't' WHERE id = 'd1'",
            [],
        )
        .unwrap();
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], true, "mountless never blocks: {r}");
}

/// I-N2: the SQL prefilter on tasks drops only rows Core can READ as safe
/// (a terminal status, a non-direct mode); an unreadable status or an
/// unknown mode still blocks (fail-safe).
#[test]
fn in2_the_task_prefilter_keeps_every_fail_safe_case() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let (other, _, _) = env.task(WorkspaceMode::HostWorktree);
    let set = |env: &Env, status: &str, mode: Option<&str>| {
        env.inner
            .lock_db()
            .conn()
            .execute(
                "UPDATE tasks SET status = ?1, workspace_mode = ?2 WHERE id = ?3",
                rusqlite::params![status, mode, other],
            )
            .unwrap();
    };
    let blocked = msg_mounted(&format!("direct_mount task {other}"));
    for (status, mode, blocks) in [
        ("completed", Some("direct_mount"), false),
        ("interrupted", Some("\"direct_mount\""), false),
        ("running", Some("\"sbx_clone\""), false),
        ("running", Some("mountless"), false),
        ("running", Some("direct_mount"), true),
        ("\"completed\"", Some("direct_mount"), true),
        ("bogus", Some("direct_mount"), true),
        ("running", Some("bogus_mode"), true),
        ("queued", None, true),
    ] {
        set(&env, status, mode);
        let resp = env.rpc(
            "git.apply",
            apply_params(&task, &base, &review, &["app.txt"]),
        );
        if blocks {
            assert_eq!(resp["err"]["code"], "CONFLICT", "{status} {mode:?}: {resp}");
            assert_eq!(resp["err"]["message"], blocked, "{status} {mode:?}");
        } else {
            assert!(
                resp["err"]["message"] != blocked,
                "{status} {mode:?} must not block: {resp}"
            );
        }
    }
}

/// I1 / C3: a `.git` file naming a gitdir that does not exist (any git that
/// discovers it dies with 128) does not stop the apply path.
#[test]
fn i1_a_git_file_naming_a_missing_gitdir_does_not_stop_the_apply() {
    let mut env = Env::new();
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"base\nreviewed\n");
    let review = env.review(&task);
    write(
        &wt.join(".git"),
        format!("gitdir: {}\n", env.base.join("no-such-gitdir").display()).as_bytes(),
    );
    let out = std::process::Command::new("git")
        .args(["config", "--get-regexp", "filter"])
        .current_dir(&wt)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(128), "the trap must make git die");
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], true, "{r}");
}

/// I2: outcomes name the start they end (`startedSequence`), so an orphaned
/// start followed by a later, completed apply is still reconciled.
#[test]
fn i2_an_orphaned_start_is_reconciled_even_after_a_later_apply() {
    let armed = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let armed2 = Arc::clone(&armed);
    let mut env = Env::with(move |_| Seams {
        before_write: hook(move |_| {
            if armed2.swap(false, std::sync::atomic::Ordering::SeqCst) {
                panic!("simulated Core crash");
            }
        }),
        ..Seams::default()
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    let review = env.review(&task);
    let params = apply_params(&task, &base, &review, &["app.txt"]);
    let inner = Arc::clone(&env.inner);
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        rpc_on(&inner, "x", "git.apply", params)
    }));
    assert!(crashed.is_err());
    let r = env.apply_ok(&task, &base, &review, &["app.txt"]);
    assert_eq!(r["applied"], true, "{r}");
    let ev = env.events(&task);
    assert_eq!(
        apply_kinds(&ev),
        ["git.apply.started", "git.apply.started", "git.applied"]
    );
    let seqs: Vec<i64> = {
        let db = env.inner.lock_db();
        let mut st = db
            .conn()
            .prepare(
                "SELECT sequence FROM task_events WHERE task_id = ?1 AND kind = \
                 'git.apply.started' ORDER BY sequence",
            )
            .unwrap();
        let rows = st.query_map([&task], |r| r.get(0)).unwrap();
        rows.map(Result::unwrap).collect()
    };
    let done = &ev.last().unwrap().1;
    assert_eq!(done["startedSequence"], seqs[1], "{done}");
    env.restart();
    let ev = env.events(&task);
    let rec: Vec<&serde_json::Value> = ev
        .iter()
        .filter(|(k, _)| k == "git.apply.reconciled")
        .map(|(_, p)| p)
        .collect();
    assert_eq!(rec.len(), 1, "{ev:?}");
    assert_eq!(rec[0]["startedSequence"], seqs[0]);
}

// --- W7: restart reconciliation ----------------------------------------------

/// Run one apply whose Core "dies" in `phase` (a panic in a test seam, so
/// the outcome event is never written), then restart Core on the same
/// database and return the reconciled outcome.
fn crash_and_reconcile(phase: &str, partial: bool) -> (Env, String, serde_json::Value) {
    let phase = phase.to_string();
    let mut env = Env::with(move |repo| {
        let repo = repo.to_path_buf();
        let crash = hook(move |_| {
            if partial {
                // Undo one of the two paths in the index, then die.
                git(&repo, &["reset", "-q", "--", "new.txt"]);
            }
            panic!("simulated Core crash");
        });
        if phase == "before" {
            Seams {
                before_write: crash,
                ..Seams::default()
            }
        } else {
            Seams {
                after_write: crash,
                ..Seams::default()
            }
        }
    });
    let (task, wt, base) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"task\n");
    write(&wt.join("new.txt"), b"new\n");
    let review = env.review(&task);
    let params = apply_params(&task, &base, &review, &["app.txt", "new.txt"]);
    let inner = Arc::clone(&env.inner);
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        rpc_on(&inner, "x", "git.apply", params)
    }));
    assert!(crashed.is_err(), "the seam must have crashed the apply");
    assert_eq!(apply_kinds(&env.events(&task)), ["git.apply.started"]);
    env.restart();
    let ev = env.events(&task);
    assert_eq!(
        apply_kinds(&ev),
        ["git.apply.started", "git.apply.reconciled"]
    );
    let rec = ev.last().unwrap().1.clone();
    assert_eq!(rec["reconciledAfterRestart"], true);
    assert_eq!(rec["files"], serde_json::json!(["app.txt", "new.txt"]));
    // Idempotent: a second restart adds nothing.
    env.restart();
    assert_eq!(apply_kinds(&env.events(&task)).len(), 2);
    (env, task, rec)
}

#[test]
fn restart_reconciles_an_apply_that_never_wrote_as_not_applied() {
    let (env, _task, rec) = crash_and_reconcile("before", false);
    assert_eq!(rec["outcome"], "not_applied", "{rec}");
    assert_eq!(env.host_status(), "");
}

#[test]
fn restart_reconciles_a_completed_write_as_applied() {
    let (env, _task, rec) = crash_and_reconcile("after", false);
    assert_eq!(rec["outcome"], "applied", "{rec}");
    assert_eq!(env.host_status(), "M  app.txt\nA  new.txt\n");
}

#[test]
fn restart_reconciles_a_half_staged_write_as_partial() {
    let (_env, _task, rec) = crash_and_reconcile("after", true);
    assert_eq!(rec["outcome"], "partial", "{rec}");
}

// --- Review additions (items 3, 9) and the advertisement (item 10) ---------

#[test]
fn review_reports_the_hooks_path_only_when_repo_relative() {
    let mut env = Env::new();
    let (task, wt, _) = env.task(WorkspaceMode::HostWorktree);
    write(&wt.join("app.txt"), b"x\n");
    assert!(env.review(&task).get("hostHooksPath").is_none());
    for (value, want) in [
        (".husky".to_string(), Some(".husky")),
        ("./tools/../.githooks".to_string(), Some(".githooks")),
        (format!("{}/hooks-dir", env.repo_str()), Some("hooks-dir")),
        ("/somewhere/else".to_string(), None),
        ("../outside".to_string(), None),
    ] {
        git(&env.repo, &["config", "core.hooksPath", &value]);
        let r = env.review(&task);
        match want {
            Some(w) => assert_eq!(r["hostHooksPath"], w, "{value}"),
            None => assert!(r.get("hostHooksPath").is_none(), "{value}: {r}"),
        }
    }
}

#[test]
fn the_probe_advertises_git_apply_with_28_methods() {
    let mut env = Env::new();
    let caps = env.ok("system.probe", serde_json::json!({}));
    assert!(caps["features"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("git-apply")));
    assert_eq!(caps["features"].as_array().unwrap().len(), 5);
    assert_eq!(caps["methods"].as_array().unwrap().len(), 28);
}
