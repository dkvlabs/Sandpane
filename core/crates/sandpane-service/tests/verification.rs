//! A7 — verification commands and `project.context` (design 2026-10-09
//! §3.7, item 13).
//!
//! Every request is a real frame through the production dispatch
//! (`handle_line`). sbx is an explicitly-labeled STAND-IN executable written
//! into a test temp dir (a test double, NOT the real Docker SBX CLI; the real
//! `sbx` is never run): it answers `version`, `ls --json` and `exec` with the
//! captured v0.47.0 shapes (`sandpane-core/tests/fixtures/sbx/captured/
//! v0.47.0/state/version.txt`, `crud/02_ls_json_after_create.txt`,
//! `crud/04_exec.txt`) and records, per invocation, every argument, its
//! environment, its working directory and that directory's listing. Its
//! program text is a FIXED literal; every variable input is a data file read
//! via `$0`, never interpolated.
//!
//! Tasks are bound to sandboxes through internal seeding (no wire path binds
//! a task before A4b — recorded UNVERIFIED in the report). The fake's version
//! reaches `VERIFIED_EXEC_VERSIONS` only through the `CoreConfig` test seam.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::params;
use sandpane_core::process::RunLimits;
use sandpane_core::sbx::{SbxLocator, SbxVersion};
use sandpane_core::{Database, EventLog};
use sandpane_protocol::PROTOCOL_VERSION;
use sandpane_service::{handle_line, CoreConfig, ServerInner, TestHook};

// --- Stable messages (pinned: clients match on these) ----------------------

const MSG_NOT_BOUND: &str = "this task is not bound to a sandbox; nothing was run";
const MSG_CHANGED: &str = "the task's sandbox changed since you confirmed; nothing was run";
const MSG_IDENTITY: &str = "Core cannot confirm the sandbox's identity; nothing was run";
const MSG_TASK_BUSY: &str =
    "a verification is already running for this task; wait for it to finish; nothing was run";
const MSG_SANDBOX_BUSY: &str =
    "a verification is already running in this sandbox; wait for it to finish; nothing was run";
const MSG_CORE_BUSY: &str = "a verification is already running in each of Core's 4 \
     verification slots; wait for one to finish; nothing was run";
const MSG_REVOKED: &str = "this verification command was revoked; nothing was run";
const MSG_OTHER_PROJECT: &str =
    "this verification command belongs to another project; nothing was run";
const MSG_PROJECT_ARCHIVED: &str = "project is archived; unarchive it first; nothing was changed";
const MSG_CONVERSATION_ARCHIVED: &str =
    "conversation is archived; unarchive it first; nothing was changed";
const MSG_TOO_MANY: &str = "this project already has 50 approved verification commands, the \
     most it can hold; revoke one first; nothing was approved";
const MSG_PROJECT_RUNNING: &str = "a verification is running for a task of this project; wait \
     for it to finish; nothing was deleted";
const MSG_CONVERSATION_RUNNING: &str = "a verification is running for a task of this \
     conversation; wait for it to finish; nothing was deleted";
const MSG_SANDBOX_RUNNING: &str =
    "a verification is running in this sandbox; wait for it to finish; nothing was deleted";
const MSG_SHUTTING_DOWN: &str = "Core is shutting down; nothing was run";
const IDEM_MSG_MISMATCH: &str =
    "idempotency key was already used with different parameters; nothing was run";

fn msg_not_running(name: &str) -> String {
    format!(
        "sandbox \"{name}\" is not running; sbx exec would start it; start it with `sbx run` in \
         a terminal; nothing was run"
    )
}

// --- The stand-in sbx --------------------------------------------------------

const SBX_ID: &str = "b5ebec73-e2ae-471a-811a-e011cfb1948e";

const FAKE_SBX_SCRIPT: &str = r#"#!/bin/sh
d=$(dirname "$0")
i=0
until mkdir -p "$d/calls" && mkdir "$d/calls/$i" 2>/dev/null; do i=$((i+1)); done
c="$d/calls/$i"
j=0
for a in "$@"; do j=$((j+1)); printf '%s' "$a" > "$c/arg.$j"; done
printf '%s' "$j" > "$c/argc"
env > "$c/env"
pwd -P > "$c/cwd"
ls -A > "$c/listing"
case "$1" in
  version)
    echo 'sbx version: v0.47.0 0411f50ee4700fe7bd37e6e7e3aced563e850ca9'
    if [ -f "$d/version.big" ]; then head -c 70000 /dev/zero | tr '\0' x; fi ;;
  ls)
    if [ -f "$d/ls.err" ]; then cat "$d/ls.err" >&2; exit 1; fi
    cat "$d/ls.json"
    if [ -f "$d/ls.selfdelete" ]; then rm -f "$0"; fi ;;
  exec)
    if [ -f "$d/exec.stdout" ]; then cat "$d/exec.stdout"; fi
    if [ -f "$d/exec.stderr" ]; then cat "$d/exec.stderr" >&2; fi
    touch "$d/exec.started"
    if [ -f "$d/exec.gate" ]; then
      n=0
      while [ ! -f "$d/exec.release" ] && [ "$n" -lt 600 ]; do sleep 0.05; n=$((n+1)); done
    fi
    if [ -f "$d/exec.sleep" ]; then sleep 30; fi
    if [ -f "$d/exec.selfkill" ]; then kill -KILL $$; fi
    if [ -f "$d/exec.escape" ]; then perl -e 'use POSIX; POSIX::setsid(); sleep 3' & fi
    if [ -f "$d/exec.exit" ]; then exit "$(cat "$d/exec.exit")"; fi
    exit 0 ;;
  *) echo 'unsupported by stand-in' >&2; exit 64 ;;
esac
"#;

/// One recorded stand-in invocation.
#[derive(Debug)]
struct Call {
    args: Vec<String>,
    env_keys: Vec<String>,
    env_text: String,
    cwd: String,
    listing: String,
}

/// Variables the test seam offers Core (Core's own environment is never
/// changed: `set_var` would race other test threads).
fn seam_env(home: &Path) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    [
        ("PATH", "/usr/bin:/bin".to_string()),
        ("HOME", home.display().to_string()),
        ("USER", "atlas".to_string()),
        ("LANG", "C".to_string()),
        ("LC_ALL", "C".to_string()),
        ("SANDPANE_CANARY_TOKEN", "canary-7d1e".to_string()),
        ("CARGO_PKG_NAME", "sandpane-service".to_string()),
        ("DOCKER_HOST", "tcp://canary.invalid:2375".to_string()),
        ("GITHUB_TOKEN", "canary-github".to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
}

// --- The harness -------------------------------------------------------------

type DynHook = Arc<dyn Fn(&ServerInner) + Send + Sync>;

/// One `ls --json` row: (name, id, status, workspaces).
type LsRow<'a> = (&'a str, &'a str, &'a str, Option<Vec<String>>);

#[derive(Clone)]
struct Seams {
    versions: Option<Vec<SbxVersion>>,
    limits: Option<(RunLimits, Duration)>,
}

impl Default for Seams {
    fn default() -> Self {
        Self {
            versions: Some(vec![SbxVersion {
                major: 0,
                minor: 47,
                patch: 0,
                pre: None,
            }]),
            limits: Some((
                RunLimits {
                    timeout: Duration::from_secs(20),
                    max_stdout: 64 * 1024,
                    max_stderr: 64 * 1024,
                },
                Duration::from_millis(300),
            )),
        }
    }
}

struct Env {
    base: tempfile::TempDir,
    fake: tempfile::TempDir,
    _repo_dir: tempfile::TempDir,
    repo: String,
    inner: Arc<ServerInner>,
    /// One-shot hook fired by `test_verification_before_start`.
    hook: Arc<Mutex<Option<DynHook>>>,
    seq: u64,
    project_id: String,
    conversation_id: String,
    repo_id: String,
}

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
    run(&["config", "commit.gpgsign", "false"]);
    std::fs::write(dir.path().join("README.md"), "demo\n").unwrap();
    run(&["add", "."]);
    run(&["commit", "-qm", "base"]);
    let canonical = std::fs::canonicalize(dir.path())
        .unwrap()
        .display()
        .to_string();
    (dir, canonical)
}

fn rpc_on(
    inner: &ServerInner,
    id: &str,
    method: &str,
    params: serde_json::Value,
) -> serde_json::Value {
    let frame = serde_json::json!({"v": PROTOCOL_VERSION, "id": id, "method": method,
        "params": params});
    serde_json::from_str(&handle_line(inner, &frame.to_string())).unwrap()
}

impl Env {
    fn new() -> Self {
        Self::with(Seams::default())
    }

    fn with(seams: Seams) -> Self {
        let base = tempfile::tempdir().unwrap();
        let fake = tempfile::tempdir().unwrap();
        let sbx = fake.path().join("sbx");
        std::fs::write(&sbx, FAKE_SBX_SCRIPT).unwrap();
        std::fs::set_permissions(&sbx, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (repo_dir, repo) = git_repo();
        let hook: Arc<Mutex<Option<DynHook>>> = Arc::new(Mutex::new(None));
        let inner = Self::core(base.path(), fake.path(), &hook, seams);
        let mut env = Self {
            base,
            fake,
            _repo_dir: repo_dir,
            repo,
            inner,
            hook,
            seq: 0,
            project_id: String::new(),
            conversation_id: String::new(),
            repo_id: String::new(),
        };
        let project = env.ok(
            "project.create",
            serde_json::json!({"name": "Atlas Demo", "repositories": [env.repo]}),
        );
        env.project_id = project["id"].as_str().unwrap().to_string();
        let conv = env.ok(
            "conversation.create",
            serde_json::json!({"projectId": env.project_id, "agentId": "codex"}),
        );
        env.conversation_id = conv["id"].as_str().unwrap().to_string();
        env.repo_id = env
            .inner
            .lock_db()
            .conn()
            .query_row(
                "SELECT id FROM repositories WHERE project_id = ?1",
                params![env.project_id],
                |r| r.get(0),
            )
            .unwrap();
        env.set_ls(&[]);
        env
    }

    fn core(
        base: &Path,
        fake: &Path,
        hook: &Arc<Mutex<Option<DynHook>>>,
        seams: Seams,
    ) -> Arc<ServerInner> {
        let db = Database::open(&base.join("core.sqlite3")).unwrap();
        let slot = Arc::clone(hook);
        let fire = TestHook(Arc::new(move |inner: &ServerInner| {
            let f = slot.lock().unwrap().take();
            if let Some(f) = f {
                f(inner);
            }
        }));
        ServerInner::with_config(
            db,
            SbxLocator::with_search(None, vec![fake.to_path_buf()]),
            CoreConfig {
                worktrees_root: Some(base.join("data").join("worktrees")),
                test_verified_exec_versions: seams.versions,
                test_verification_limits: seams.limits,
                test_verification_env: Some(seam_env(&base.join("home"))),
                test_verification_before_start: Some(fire),
                ..CoreConfig::default()
            },
        )
    }

    /// A NEW Core on the same database (a restart); the old one is dropped
    /// by the caller (its workers may still be running).
    fn restart(&mut self) -> Arc<ServerInner> {
        let new = Self::core(
            self.base.path(),
            self.fake.path(),
            &self.hook,
            Seams::default(),
        );
        std::mem::replace(&mut self.inner, new)
    }

    fn set_hook(&self, f: impl Fn(&ServerInner) + Send + Sync + 'static) {
        *self.hook.lock().unwrap() = Some(Arc::new(f));
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

    fn file(&self, name: &str, text: &str) {
        std::fs::write(self.fake.path().join(name), text).unwrap();
    }

    fn rm(&self, name: &str) {
        let _ = std::fs::remove_file(self.fake.path().join(name));
    }

    /// Rows of `ls --json`: (name, id, status, workspaces).
    fn set_ls(&self, rows: &[(&str, &str, &str, Option<Vec<String>>)]) {
        let rows: Vec<serde_json::Value> = rows
            .iter()
            .map(|(name, id, status, ws)| {
                let mut row = serde_json::json!({
                    "name": name, "id": id, "agent": "shell", "status": status,
                    "last_used_at": "2026-10-09T17:31:30.035041Z",
                    "created_at": "2026-10-09T17:31:28Z",
                });
                if let Some(ws) = ws {
                    row["workspaces"] = serde_json::json!(ws);
                }
                row
            })
            .collect();
        self.file(
            "ls.json",
            &serde_json::to_string_pretty(&serde_json::json!({ "sandboxes": rows })).unwrap(),
        );
    }

    fn reset_calls(&self) {
        let _ = std::fs::remove_dir_all(self.fake.path().join("calls"));
    }

    fn calls(&self) -> Vec<Call> {
        let dir = self.fake.path().join("calls");
        let mut idx: Vec<u64> = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
                    .collect()
            })
            .unwrap_or_default();
        idx.sort_unstable();
        idx.into_iter()
            .map(|i| {
                let c = dir.join(i.to_string());
                let read = |n: &str| std::fs::read_to_string(c.join(n)).unwrap_or_default();
                let argc: usize = read("argc").parse().unwrap_or(0);
                let args = (1..=argc).map(|j| read(&format!("arg.{j}"))).collect();
                let env_text = read("env");
                let env_keys = env_text
                    .lines()
                    .filter_map(|l| l.split_once('=').map(|(k, _)| k.to_string()))
                    .collect();
                Call {
                    args,
                    env_keys,
                    env_text,
                    cwd: read("cwd").trim().to_string(),
                    listing: read("listing"),
                }
            })
            .collect()
    }

    fn verbs(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .map(|c| c.args.first().cloned().unwrap_or_default())
            .collect()
    }

    /// Bind `task` (status `completed`, a finished task) to `sandbox` through
    /// internal seeding. `sbx_id` `None` = a binding without a recorded id.
    fn bind(&self, task: &str, sandbox: &str, mode: &str, sbx_id: Option<&str>) {
        let db = self.inner.lock_db();
        let c = db.conn();
        let binding = format!("b-{task}");
        c.execute(
            "INSERT INTO sandbox_bindings (id, project_id, sandbox_name, workspace_mode, repo_id,
                 created_at, sbx_id) VALUES (?1, ?2, ?3, ?4, ?5, 't', ?6)",
            params![
                binding,
                self.project_id,
                sandbox,
                mode,
                self.repo_id,
                sbx_id
            ],
        )
        .unwrap();
        c.execute(
            "INSERT INTO tasks (id, conversation_id, sandbox_binding_id, repo_id, workspace_mode,
                 status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'completed', 't', 't')",
            params![task, self.conversation_id, binding, self.repo_id, mode],
        )
        .unwrap();
    }

    fn approve(&mut self, label: &str, argv: &[&str]) -> String {
        let r = self.ok(
            "verification.approve",
            serde_json::json!({"projectId": self.project_id, "label": label, "argv": argv}),
        );
        r["command"]["id"].as_str().unwrap().to_string()
    }

    fn run_params(&self, task: &str, cmd: &str, sandbox: &str, mode: &str) -> serde_json::Value {
        serde_json::json!({"taskId": task, "commandId": cmd, "expectedSandboxName": sandbox,
            "expectedWorkspaceMode": mode})
    }

    fn run(&mut self, task: &str, cmd: &str, sandbox: &str, mode: &str) -> serde_json::Value {
        let p = self.run_params(task, cmd, sandbox, mode);
        self.rpc("verification.run", p)
    }

    fn wait_finished(&mut self, run_id: &str) -> serde_json::Value {
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let r = self.ok(
                "verification.result",
                serde_json::json!({ "runId": run_id }),
            );
            if r["outcome"] != "running" {
                return r;
            }
            assert!(Instant::now() < until, "run {run_id} never finished");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_exec_started(&self) {
        let until = Instant::now() + Duration::from_secs(20);
        while !self.fake.path().join("exec.started").exists() {
            assert!(Instant::now() < until, "exec never started");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_idle(&self) {
        let until = Instant::now() + Duration::from_secs(30);
        while !self.inner.verifications.is_empty() {
            assert!(
                Instant::now() < until,
                "runs never cleared from the registry"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn events(&self, task: &str) -> Vec<(i64, String, serde_json::Value)> {
        let db = self.inner.lock_db();
        let mut stmt = db
            .conn()
            .prepare("SELECT sequence, kind, payload FROM task_events WHERE task_id = ?1 ORDER BY sequence")
            .unwrap();
        let rows = stmt
            .query_map(params![task], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .map(|r| {
                let (s, k, p) = r.unwrap();
                (s, k, serde_json::from_str(&p).unwrap())
            })
            .collect();
        rows
    }

    fn finished_events(&self, task: &str) -> Vec<serde_json::Value> {
        self.events(task)
            .into_iter()
            .filter(|(_, k, _)| k == "verification.finished")
            .map(|(_, _, p)| p)
            .collect()
    }

    fn lock_key(&self) -> String {
        self.repo.clone()
    }
}

fn running_row(
    name: &str,
    ws: Option<Vec<String>>,
) -> (&str, &'static str, &'static str, Option<Vec<String>>) {
    (name, SBX_ID, "running", ws)
}

/// A direct_mount task `t1` on sandbox `atlas-demo`, listed running with the
/// repository as its workspace; plus one approved command.
fn direct_env(argv: &[&str]) -> (Env, String) {
    let mut env = Env::new();
    env.bind("t1", "atlas-demo", "direct_mount", Some(SBX_ID));
    let repo = env.repo.clone();
    env.set_ls(&[running_row("atlas-demo", Some(vec![repo]))]);
    let cmd = env.approve("unit tests", argv);
    (env, cmd)
}

/// `n` mountless tasks `t0..`, each on its own sandbox `nova-demo-<i>`
/// (listed running, no workspace).
fn mountless_env(n: usize) -> (Env, String) {
    let mut env = Env::new();
    let ids: Vec<String> = (0..n)
        .map(|i| format!("00000000-0000-4000-8000-{i:012}"))
        .collect();
    let names: Vec<String> = (0..n).map(|i| format!("nova-demo-{i}")).collect();
    for i in 0..n {
        env.bind(&format!("t{i}"), &names[i], "mountless", Some(&ids[i]));
    }
    let rows: Vec<(&str, &str, &str, Option<Vec<String>>)> = (0..n)
        .map(|i| (names[i].as_str(), ids[i].as_str(), "running", Some(vec![])))
        .collect();
    env.set_ls(&rows);
    let cmd = env.approve("unit tests", &["make", "test"]);
    (env, cmd)
}

fn start(env: &mut Env, task: &str, cmd: &str, sandbox: &str, mode: &str) -> (String, i64) {
    let r = env.run(task, cmd, sandbox, mode);
    assert!(r.get("ok").is_some(), "run refused: {r}");
    (
        r["ok"]["runId"].as_str().unwrap().to_string(),
        r["ok"]["startedSequence"].as_i64().unwrap(),
    )
}

const SHELL_SET_KEYS: [&str; 4] = ["PWD", "OLDPWD", "SHLVL", "_"];

// --- §3.7 item 3: the one fixed spawn (argv, env, cwd; R2) ------------------

#[test]
fn run_spawns_exactly_exec_dashdash_name_argv_in_one_cleared_context() {
    let argv = [
        "printf",
        "[%s]\\n",
        "-u",
        "--privileged",
        "-e",
        "X=y",
        "a b",
        "$(id)",
        "*",
        "--",
    ];
    let (mut env, cmd) = direct_env(&argv);
    env.file("exec.stdout", "sandpane-p0-ok\n");
    env.reset_calls();
    let (run_id, seq) = start(&mut env, "t1", &cmd, "atlas-demo", "direct_mount");
    let r = env.wait_finished(&run_id);
    assert_eq!(r["outcome"], "exited", "{r}");
    assert_eq!(r["exitCode"], 0);
    assert_eq!(r["stdout"], "sandpane-p0-ok\n");
    assert_eq!(r["sandbox"], "atlas-demo");
    assert_eq!(r["workspaceMode"], "direct_mount");
    assert_eq!(r["argv"], serde_json::json!(argv));
    assert_eq!(r["label"], "unit tests");
    assert!(seq > 0);

    let calls = env.calls();
    let args: Vec<Vec<String>> = calls.iter().map(|c| c.args.clone()).collect();
    let mut want_exec = vec![
        "exec".to_string(),
        "--".to_string(),
        "atlas-demo".to_string(),
    ];
    want_exec.extend(argv.iter().map(|s| s.to_string()));
    assert_eq!(
        args,
        vec![
            vec!["version".to_string()],
            vec!["ls".to_string(), "--json".to_string()],
            want_exec,
        ],
        "exactly version, ls --json, then exec -- NAME ARGV…"
    );
    // R2: identical environment and working directory for all three.
    let cwd0 = &calls[0].cwd;
    let data_tmp = std::fs::canonicalize(env.base.path().join("data").join("tmp")).unwrap();
    assert!(
        Path::new(cwd0).starts_with(&data_tmp),
        "cwd {cwd0} must be a Core-owned dir under {}",
        data_tmp.display()
    );
    for c in &calls {
        assert_eq!(&c.cwd, cwd0, "same cwd for every invocation");
        assert_eq!(c.listing, "", "the cwd is empty");
        assert_eq!(
            c.env_text, calls[0].env_text,
            "same environment for every invocation"
        );
        for k in &c.env_keys {
            let allowed = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"]
                .contains(&k.as_str())
                || k.starts_with("LC_")
                || SHELL_SET_KEYS.contains(&k.as_str());
            assert!(allowed, "{k} reached sbx: {:?}", c.env_keys);
        }
        assert!(c.env_keys.iter().any(|k| k == "LC_ALL"), "LC_* kept");
        assert!(!c.env_text.contains("canary"), "a host token reached sbx");
        assert!(
            !c.env_keys.iter().any(|k| k.starts_with("CARGO")),
            "Core's env leaked"
        );
    }
    // The Core temp dir is gone after the run.
    assert!(!Path::new(cwd0).exists(), "the per-run cwd is removed");
    // Task status is never changed by a verification (rule 3).
    let status: String = env
        .inner
        .lock_db()
        .conn()
        .query_row("SELECT status FROM tasks WHERE id='t1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(status, "completed");
}

// --- §3.7 item 4: every gate refuses and spawns nothing ---------------------

#[test]
fn db_gates_refuse_before_any_sbx_call() {
    let (mut env, cmd) = direct_env(&["make", "test"]);
    env.reset_calls();
    let e = env.err(
        "verification.run",
        env.run_params("nope", &cmd, "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["code"], "NOT_FOUND", "{e}");
    let e = env.err(
        "verification.run",
        env.run_params("t1", "nope", "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["code"], "NOT_FOUND", "{e}");
    // What the user saw differs from the binding.
    for (name, mode) in [
        ("atlas-demo", "host_worktree"),
        ("nova-demo", "direct_mount"),
    ] {
        let e = env.err("verification.run", env.run_params("t1", &cmd, name, mode));
        assert_eq!(
            (e["code"].as_str(), e["message"].as_str()),
            (Some("VALIDATION_FAILED"), Some(MSG_CHANGED))
        );
    }
    // Unbound task.
    {
        let db = env.inner.lock_db();
        db.conn()
            .execute(
                "INSERT INTO tasks (id, conversation_id, status, created_at, updated_at)
                 VALUES ('t-unbound', ?1, 'completed', 't', 't')",
                params![env.conversation_id],
            )
            .unwrap();
    }
    let e = env.err(
        "verification.run",
        env.run_params("t-unbound", &cmd, "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["message"], MSG_NOT_BOUND);
    // A command of another project.
    let (_d2, repo2) = git_repo();
    let p2 = env.ok(
        "project.create",
        serde_json::json!({"name": "Nova Demo", "repositories": [repo2]}),
    );
    let other = env.ok(
        "verification.approve",
        serde_json::json!({"projectId": p2["id"], "label": "other", "argv": ["make", "test"]}),
    )["command"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let e = env.err(
        "verification.run",
        env.run_params("t1", &other, "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["message"], MSG_OTHER_PROJECT);
    // A revoked command.
    env.ok(
        "verification.revoke",
        serde_json::json!({ "commandId": cmd }),
    );
    let e = env.err(
        "verification.run",
        env.run_params("t1", &cmd, "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["message"], MSG_REVOKED);
    // A removed binding.
    let cmd2 = env.approve("lint", &["make", "lint"]);
    env.inner
        .lock_db()
        .conn()
        .execute(
            "UPDATE sandbox_bindings SET removed_at='t' WHERE id='b-t1'",
            [],
        )
        .unwrap();
    let e = env.err(
        "verification.run",
        env.run_params("t1", &cmd2, "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["message"], MSG_NOT_BOUND);
    assert!(
        env.calls().is_empty(),
        "a DB gate ran sbx: {:?}",
        env.verbs()
    );
}

#[test]
fn identity_gate_refuses_and_never_execs() {
    let (mut env, cmd) = direct_env(&["make", "test"]);
    let repo = env.repo.clone();
    let other_dir = tempfile::tempdir().unwrap();
    let other = std::fs::canonicalize(other_dir.path())
        .unwrap()
        .display()
        .to_string();
    let cases: Vec<(Vec<LsRow>, String)> = vec![
        // a different sbx id under the bound name
        (
            vec![(
                "atlas-demo",
                "00000000-0000-4000-8000-000000000009",
                "running",
                Some(vec![repo.clone()]),
            )],
            MSG_IDENTITY.into(),
        ),
        // the name is not listed
        (
            vec![("nova-demo", SBX_ID, "running", Some(vec![repo.clone()]))],
            MSG_IDENTITY.into(),
        ),
        // a different workspace
        (
            vec![("atlas-demo", SBX_ID, "running", Some(vec![other.clone()]))],
            MSG_IDENTITY.into(),
        ),
        // two workspaces
        (
            vec![(
                "atlas-demo",
                SBX_ID,
                "running",
                Some(vec![repo.clone(), other.clone()]),
            )],
            MSG_IDENTITY.into(),
        ),
        // no workspaces field (fail closed)
        (
            vec![("atlas-demo", SBX_ID, "running", None)],
            MSG_IDENTITY.into(),
        ),
        // no workspace at all
        (
            vec![("atlas-demo", SBX_ID, "running", Some(vec![]))],
            MSG_IDENTITY.into(),
        ),
        // a status Core does not know
        (
            vec![("atlas-demo", SBX_ID, "paused", Some(vec![repo.clone()]))],
            MSG_IDENTITY.into(),
        ),
        // stopped: sbx exec would start it
        (
            vec![("atlas-demo", SBX_ID, "stopped", Some(vec![repo.clone()]))],
            msg_not_running("atlas-demo"),
        ),
    ];
    for (rows, want) in cases {
        env.set_ls(&rows);
        env.reset_calls();
        let e = env.err(
            "verification.run",
            env.run_params("t1", &cmd, "atlas-demo", "direct_mount"),
        );
        assert_eq!(e["code"], "VALIDATION_FAILED", "{rows:?}: {e}");
        assert_eq!(e["message"], want.as_str(), "{rows:?}");
        assert_eq!(
            env.verbs(),
            vec!["version", "ls"],
            "{rows:?}: nothing but the gates ran"
        );
    }
    // I-d: a workspace reported through a symlinked path is the same
    // directory once canonicalized.
    let link_dir = tempfile::tempdir().unwrap();
    let link = link_dir.path().join("repo-link");
    std::os::unix::fs::symlink(&repo, &link).unwrap();
    env.set_ls(&[(
        "atlas-demo",
        SBX_ID,
        "running",
        Some(vec![link.display().to_string()]),
    )]);
    let (run_id, _) = start(&mut env, "t1", &cmd, "atlas-demo", "direct_mount");
    assert_eq!(env.wait_finished(&run_id)["outcome"], "exited");
    // A binding without a recorded sbx id is never confirmed.
    env.bind("t2", "orbit-demo", "mountless", None);
    env.set_ls(&[("orbit-demo", SBX_ID, "running", Some(vec![]))]);
    env.reset_calls();
    let e = env.err(
        "verification.run",
        env.run_params("t2", &cmd, "orbit-demo", "mountless"),
    );
    assert_eq!(e["message"], MSG_IDENTITY);
    assert!(!env.verbs().contains(&"exec".to_string()));
    assert!(env.events("t2").is_empty(), "a refusal wrote an event");
    // A mountless binding whose row has NO workspaces field: fail closed
    // (absent is never read as "no workspace").
    env.bind("t3", "nova-demo", "mountless", Some(SBX_ID));
    env.set_ls(&[("nova-demo", SBX_ID, "running", None)]);
    env.reset_calls();
    let e = env.err(
        "verification.run",
        env.run_params("t3", &cmd, "nova-demo", "mountless"),
    );
    assert_eq!(e["message"], MSG_IDENTITY);
    assert!(!env.verbs().contains(&"exec".to_string()));
}

/// A8a review W3: the gate never parses truncated `sbx version` stdout,
/// even when its first token is a verified version.
#[test]
fn version_gate_refuses_truncated_version_output() {
    let mut env = Env::with(Seams::default());
    env.bind("t1", "atlas-demo", "direct_mount", Some(SBX_ID));
    let repo = env.repo.clone();
    env.set_ls(&[running_row("atlas-demo", Some(vec![repo]))]);
    let cmd = env.approve("unit tests", &["make", "test"]);
    env.file("version.big", "");
    env.reset_calls();
    let e = env.err(
        "verification.run",
        env.run_params("t1", &cmd, "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["code"], "UNSUPPORTED_SBX_VERSION", "{e}");
    assert_eq!(
        e["message"],
        "sbx exec argument passing has not been verified for this sbx (Core could not read its \
         version); nothing was run"
    );
    assert_eq!(env.verbs(), vec!["version"], "only the version probe ran");
    assert!(env.events("t1").is_empty());
}

#[test]
fn version_gate_refuses_without_the_test_seam() {
    let mut env = Env::with(Seams {
        versions: None,
        ..Seams::default()
    });
    env.bind("t1", "atlas-demo", "direct_mount", Some(SBX_ID));
    let repo = env.repo.clone();
    env.set_ls(&[running_row("atlas-demo", Some(vec![repo]))]);
    let cmd = env.approve("unit tests", &["make", "test"]);
    env.reset_calls();
    let e = env.err(
        "verification.run",
        env.run_params("t1", &cmd, "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["code"], "UNSUPPORTED_SBX_VERSION", "{e}");
    assert_eq!(
        e["message"],
        "sbx exec argument passing has not been verified for sbx 0.47.0; nothing was run"
    );
    assert_eq!(env.verbs(), vec!["version"], "only the version probe ran");
    assert!(env.events("t1").is_empty());
}

#[test]
fn no_sbx_is_not_installed() {
    let (mut env, cmd) = direct_env(&["make", "test"]);
    env.rm("sbx");
    let e = env.err(
        "verification.run",
        env.run_params("t1", &cmd, "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["code"], "NOT_INSTALLED", "{e}");
}

// --- §3.7 item 2: approve ------------------------------------------------------

#[test]
fn approve_refuses_secrets_and_stores_nothing() {
    let mut env = Env::new();
    let token = format!("ghp_{}", "A1b2C3d4E5".repeat(4));
    let mut counts = sandpane_core::redact::RedactionCounts::default();
    sandpane_core::redact::redact(&token, &mut counts).unwrap();
    let kinds: Vec<&str> = sandpane_core::redact::KINDS
        .iter()
        .copied()
        .filter(|k| counts.get(k) > 0)
        .collect();
    assert!(!kinds.is_empty(), "the fixture must look like a secret");
    let e = env.err(
        "verification.approve",
        serde_json::json!({"projectId": env.project_id, "label": "push",
            "argv": ["gh", token, "x"]}),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED");
    assert_eq!(
        e["message"],
        format!(
            "argument 2 looks like a secret ({}); approved commands cannot hold secrets; nothing \
             was approved",
            kinds.join(", ")
        )
    );
    assert!(e["details"]["hint"]
        .as_str()
        .unwrap()
        .contains("no override"));
    let e = env.err(
        "verification.approve",
        serde_json::json!({"projectId": env.project_id, "label": format!("deploy {token}"),
            "argv": ["make", "deploy"]}),
    );
    assert_eq!(
        e["message"],
        format!(
            "the label looks like a secret ({}); approved commands cannot hold secrets; nothing \
             was approved",
            kinds.join(", ")
        )
    );
    let n: i64 = env
        .inner
        .lock_db()
        .conn()
        .query_row("SELECT COUNT(*) FROM verification_commands", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0, "nothing was stored");
}

#[test]
fn approve_validates_dedupes_and_caps() {
    let mut env = Env::new();
    let first = env.ok(
        "verification.approve",
        serde_json::json!({"projectId": env.project_id, "label": "  unit tests  ",
            "argv": ["cargo", "test"]}),
    );
    assert_eq!(first["command"]["label"], "unit tests", "trimmed");
    assert_eq!(
        first["command"]["argv"],
        serde_json::json!(["cargo", "test"])
    );
    assert_eq!(first["command"]["projectId"], env.project_id.as_str());
    let again = env.ok(
        "verification.approve",
        serde_json::json!({"projectId": env.project_id, "label": "renamed",
            "argv": ["cargo", "test"]}),
    );
    assert_eq!(
        again["command"], first["command"],
        "same argv → the existing command, label unchanged"
    );
    for bad in [
        serde_json::json!({"projectId": env.project_id, "label": "", "argv": ["x"]}),
        serde_json::json!({"projectId": env.project_id, "label": "a\u{202e}b", "argv": ["x"]}),
        serde_json::json!({"projectId": env.project_id, "label": "ok", "argv": []}),
        serde_json::json!({"projectId": env.project_id, "label": "ok", "argv": ["-x"]}),
        serde_json::json!({"projectId": env.project_id, "label": "ok", "argv": ["a\u{0}b"]}),
    ] {
        let e = env.err("verification.approve", bad.clone());
        assert_eq!(e["code"], "VALIDATION_FAILED", "{bad}");
    }
    let e = env.err(
        "verification.approve",
        serde_json::json!({"projectId": "nope", "label": "ok", "argv": ["x"]}),
    );
    assert_eq!(e["code"], "NOT_FOUND");
    for i in 1..50 {
        env.approve(&format!("c{i}"), &["echo", &i.to_string()]);
    }
    let e = env.err(
        "verification.approve",
        serde_json::json!({"projectId": env.project_id, "label": "51st", "argv": ["echo", "x"]}),
    );
    assert_eq!(e["message"], MSG_TOO_MANY);
    // At the cap, re-approving an existing argv still answers it.
    let again = env.ok(
        "verification.approve",
        serde_json::json!({"projectId": env.project_id, "label": "x", "argv": ["cargo", "test"]}),
    );
    assert_eq!(again["command"]["id"], first["command"]["id"]);
    // Revoked commands do not count.
    env.ok(
        "verification.revoke",
        serde_json::json!({"commandId": first["command"]["id"]}),
    );
    env.approve("51st", &["echo", "x"]);
    let list = env.ok(
        "verification.list",
        serde_json::json!({"projectId": env.project_id}),
    );
    let list = list["commands"].as_array().unwrap();
    assert_eq!(list.len(), 50);
    assert_eq!(list[0]["label"], "c1", "ordered by approval");
    assert_eq!(list[49]["label"], "51st");
}

#[test]
fn revoke_is_an_idempotent_tombstone() {
    let mut env = Env::new();
    let cmd = env.approve("unit tests", &["make", "test"]);
    for _ in 0..2 {
        let r = env.ok("verification.revoke", serde_json::json!({"commandId": cmd}));
        assert_eq!(r, serde_json::json!({"revoked": true}));
    }
    let list = env.ok(
        "verification.list",
        serde_json::json!({"projectId": env.project_id}),
    );
    assert_eq!(list["commands"], serde_json::json!([]));
    let kept: i64 = env
        .inner
        .lock_db()
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM verification_commands WHERE id = ?1 AND revoked_at IS NOT NULL",
            params![cmd],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kept, 1, "tombstoned, never deleted");
    let e = env.err(
        "verification.revoke",
        serde_json::json!({"commandId": "nope"}),
    );
    assert_eq!(e["code"], "NOT_FOUND");
    let e = env.err("verification.result", serde_json::json!({"runId": "nope"}));
    assert_eq!(e["code"], "NOT_FOUND");
}

#[test]
fn archived_project_and_conversation_refuse_but_revoke_and_reads_work() {
    let (mut env, cmd) = direct_env(&["make", "test"]);
    env.ok(
        "project.archive",
        serde_json::json!({"projectId": env.project_id}),
    );
    env.reset_calls();
    let e = env.err(
        "verification.approve",
        serde_json::json!({"projectId": env.project_id, "label": "x", "argv": ["make", "lint"]}),
    );
    assert_eq!(e["message"], MSG_PROJECT_ARCHIVED);
    let e = env.err(
        "verification.run",
        env.run_params("t1", &cmd, "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["message"], MSG_PROJECT_ARCHIVED);
    env.ok(
        "verification.list",
        serde_json::json!({"projectId": env.project_id}),
    );
    env.ok(
        "project.context",
        serde_json::json!({"projectId": env.project_id}),
    );
    env.ok(
        "project.unarchive",
        serde_json::json!({"projectId": env.project_id}),
    );
    env.ok(
        "conversation.archive",
        serde_json::json!({"conversationId": env.conversation_id}),
    );
    let e = env.err(
        "verification.run",
        env.run_params("t1", &cmd, "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["message"], MSG_CONVERSATION_ARCHIVED);
    env.ok(
        "project.archive",
        serde_json::json!({"projectId": env.project_id}),
    );
    env.ok("verification.revoke", serde_json::json!({"commandId": cmd}));
    assert!(env.calls().is_empty(), "archived refusals ran sbx");
}

// --- W7: concurrency ------------------------------------------------------------

#[test]
fn one_run_per_task_and_per_sandbox_and_four_across_core() {
    let (mut env, cmd) = mountless_env(6);
    // t5 shares t0's sandbox.
    {
        let db = env.inner.lock_db();
        db.conn()
            .execute(
                "UPDATE tasks SET sandbox_binding_id='b-t0' WHERE id='t5'",
                [],
            )
            .unwrap();
    }
    env.file("exec.gate", "");
    let (r0, _) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    env.wait_exec_started();
    let e = env.err(
        "verification.run",
        env.run_params("t0", &cmd, "nova-demo-0", "mountless"),
    );
    assert_eq!(
        (e["code"].as_str(), e["message"].as_str()),
        (Some("CONFLICT"), Some(MSG_TASK_BUSY))
    );
    let e = env.err(
        "verification.run",
        env.run_params("t5", &cmd, "nova-demo-0", "mountless"),
    );
    assert_eq!(e["message"], MSG_SANDBOX_BUSY);
    let mut runs = vec![r0];
    for i in 1..4 {
        runs.push(
            start(
                &mut env,
                &format!("t{i}"),
                &cmd,
                &format!("nova-demo-{i}"),
                "mountless",
            )
            .0,
        );
    }
    env.reset_calls();
    let e = env.err(
        "verification.run",
        env.run_params("t4", &cmd, "nova-demo-4", "mountless"),
    );
    assert_eq!(e["message"], MSG_CORE_BUSY);
    // Only the gates of a NEW run call `version` / `ls`; an `exec` here is a
    // worker of a run started above that spawned after the reset.
    let gates: Vec<String> = env.verbs().into_iter().filter(|v| v != "exec").collect();
    assert!(gates.is_empty(), "a capped run ran sbx: {gates:?}");
    env.file("exec.release", "");
    for r in &runs {
        assert_eq!(env.wait_finished(r)["outcome"], "exited");
    }
    env.wait_idle();
    start(&mut env, "t4", &cmd, "nova-demo-4", "mountless");
}

/// The in-transaction admission check (not only the pre-check) refuses a run
/// that raced another start for the same task.
#[test]
fn the_start_transaction_rechecks_admission() {
    let (mut env, cmd) = mountless_env(1);
    env.file("exec.gate", "");
    let raced = Arc::new(Mutex::new(None::<serde_json::Value>));
    let slot = Arc::clone(&raced);
    let cmd2 = cmd.clone();
    env.set_hook(move |inner| {
        let r = rpc_on(
            inner,
            "race",
            "verification.run",
            serde_json::json!({"taskId": "t0", "commandId": cmd2,
                "expectedSandboxName": "nova-demo-0", "expectedWorkspaceMode": "mountless"}),
        );
        *slot.lock().unwrap() = Some(r);
    });
    let e = env.err(
        "verification.run",
        env.run_params("t0", &cmd, "nova-demo-0", "mountless"),
    );
    assert_eq!(e["message"], MSG_TASK_BUSY, "{e}");
    let winner = raced.lock().unwrap().take().unwrap();
    let run = winner["ok"]["runId"]
        .as_str()
        .expect("the racing run started")
        .to_string();
    env.file("exec.release", "");
    env.wait_finished(&run);
    let execs = env.verbs().iter().filter(|v| *v == "exec").count();
    assert_eq!(execs, 1, "exactly one exec");
    let started = env
        .events("t0")
        .iter()
        .filter(|(_, k, _)| k == "verification.started")
        .count();
    assert_eq!(started, 1);
}

#[test]
fn a_revoke_racing_a_run_wins_in_the_start_transaction() {
    let (mut env, cmd) = mountless_env(1);
    let c = cmd.clone();
    env.set_hook(move |inner| {
        let r = rpc_on(
            inner,
            "revoke",
            "verification.revoke",
            serde_json::json!({"commandId": c}),
        );
        assert!(r.get("ok").is_some(), "{r}");
    });
    let e = env.err(
        "verification.run",
        env.run_params("t0", &cmd, "nova-demo-0", "mountless"),
    );
    assert_eq!(e["message"], MSG_REVOKED);
    assert!(!env.verbs().contains(&"exec".to_string()));
    assert!(env.events("t0").is_empty(), "nothing started");
    assert!(env.inner.verifications.is_empty());
}

#[test]
fn a_binding_removed_or_a_remove_in_flight_during_the_gates_refuses() {
    let (mut env, cmd) = mountless_env(1);
    env.set_hook(|inner| {
        inner
            .lock_db()
            .conn()
            .execute(
                "UPDATE sandbox_bindings SET removed_at='t' WHERE id='b-t0'",
                [],
            )
            .unwrap();
    });
    let e = env.err(
        "verification.run",
        env.run_params("t0", &cmd, "nova-demo-0", "mountless"),
    );
    assert_eq!(e["message"], MSG_NOT_BOUND);
    env.inner
        .lock_db()
        .conn()
        .execute(
            "UPDATE sandbox_bindings SET removed_at=NULL WHERE id='b-t0'",
            [],
        )
        .unwrap();
    // A confirmed `sandbox.remove` claimed the name meanwhile.
    let held = Arc::new(AtomicBool::new(false));
    let h = Arc::clone(&held);
    env.set_hook(move |inner| {
        std::mem::forget(inner.sandbox_ops.try_acquire("nova-demo-0").unwrap());
        h.store(true, Ordering::SeqCst);
    });
    let e = env.err(
        "verification.run",
        env.run_params("t0", &cmd, "nova-demo-0", "mountless"),
    );
    assert!(held.load(Ordering::SeqCst));
    assert_eq!(e["code"], "CONFLICT");
    assert_eq!(
        e["message"],
        "another operation on sandbox \"nova-demo-0\" is in progress; nothing was run"
    );
    assert!(!env.verbs().contains(&"exec".to_string()));
    assert!(env.events("t0").is_empty());
}

#[test]
fn direct_mount_runs_hold_the_repository_writer_lock() {
    let (mut env, cmd) = direct_env(&["make", "test"]);
    let key = env.lock_key();
    // Held by someone else: refused, nothing runs.
    env.inner
        .lock_scheduler()
        .try_lock_writer(&key, "git.apply:t9")
        .unwrap();
    env.reset_calls();
    let e = env.err(
        "verification.run",
        env.run_params("t1", &cmd, "atlas-demo", "direct_mount"),
    );
    assert_eq!(e["code"], "CONFLICT");
    assert_eq!(
        e["message"],
        format!(
            "{key} is busy: git.apply:t9 holds its writer lock (a running writer task, an apply, \
             a worktree discard or another verification); a verification is already running or \
             the repository is being written; nothing was run"
        )
    );
    assert!(!env.verbs().contains(&"exec".to_string()));
    env.inner
        .lock_scheduler()
        .unlock_writer(&key, "git.apply:t9");
    // Held for the whole run, released after.
    env.file("exec.gate", "");
    let (run, _) = start(&mut env, "t1", &cmd, "atlas-demo", "direct_mount");
    env.wait_exec_started();
    assert_eq!(
        env.inner.lock_scheduler().writer_lock_holder(&key),
        Some(format!("verification.run:{run}").as_str())
    );
    assert!(env
        .inner
        .lock_scheduler()
        .try_lock_writer(&key, "git.apply:t9")
        .is_err());
    env.file("exec.release", "");
    env.wait_finished(&run);
    env.wait_idle();
    let until = Instant::now() + Duration::from_secs(10);
    while env
        .inner
        .lock_scheduler()
        .writer_lock_holder(&key)
        .is_some()
    {
        assert!(Instant::now() < until, "the writer lock was never released");
        std::thread::sleep(Duration::from_millis(10));
    }
}

// --- R1: keyed replay first -------------------------------------------------------

#[test]
fn keyed_replay_comes_first_in_flight_and_after_a_revoke() {
    let (mut env, cmd) = direct_env(&["make", "test"]);
    env.file("exec.gate", "");
    let mut p = env.run_params("t1", &cmd, "atlas-demo", "direct_mount");
    p["idempotencyKey"] = serde_json::json!("k-1");
    let first = env.ok("verification.run", p.clone());
    assert!(first.get("replayed").is_none());
    env.wait_exec_started();
    env.reset_calls();
    // In flight (and the run itself holds the direct_mount writer lock).
    let again = env.ok("verification.run", p.clone());
    assert_eq!(again["runId"], first["runId"]);
    assert_eq!(again["startedSequence"], first["startedSequence"]);
    assert_eq!(again["replayed"], true);
    // After a revoke, and on an archived project.
    env.ok("verification.revoke", serde_json::json!({"commandId": cmd}));
    env.ok(
        "project.archive",
        serde_json::json!({"projectId": env.project_id}),
    );
    let again = env.ok("verification.run", p.clone());
    assert_eq!(again["runId"], first["runId"]);
    assert!(
        env.calls().is_empty(),
        "a replay ran sbx: {:?}",
        env.verbs()
    );
    // Same key, different params.
    let mut q = env.run_params("t1", &cmd, "atlas-demo", "mountless");
    q["idempotencyKey"] = serde_json::json!("k-1");
    let e = env.err("verification.run", q);
    assert_eq!(
        (e["code"].as_str(), e["message"].as_str()),
        (Some("CONFLICT"), Some(IDEM_MSG_MISMATCH))
    );
    env.file("exec.release", "");
    env.wait_finished(first["runId"].as_str().unwrap());
    let started = env
        .events("t1")
        .iter()
        .filter(|(_, k, _)| k == "verification.started")
        .count();
    assert_eq!(started, 1, "a replay never runs a second time");
}

// --- R3 / W3: one terminal record, shutdown, restart -------------------------------

#[test]
fn shutdown_interrupts_once_and_the_worker_never_overwrites_it() {
    let (mut env, cmd) = mountless_env(1);
    env.file("exec.stdout", "partial-before-shutdown\n");
    env.file("exec.gate", "");
    let (run, seq) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    env.wait_exec_started();
    let n = env.inner.shutdown_verifications(Duration::from_millis(500));
    assert_eq!(n, 1);
    env.wait_idle();
    let finished = env.finished_events("t0");
    assert_eq!(
        finished.len(),
        1,
        "exactly one terminal event: {finished:?}"
    );
    assert_eq!(finished[0]["outcome"], "interrupted");
    assert_eq!(finished[0]["startedSequence"], seq);
    assert_eq!(finished[0]["runId"], run.as_str());
    let r = env.ok("verification.result", serde_json::json!({"runId": run}));
    assert_eq!(r["outcome"], "interrupted");
    assert_eq!(r["stdout"], "", "the worker's later record never lands");
    let status: String = env
        .inner
        .lock_db()
        .conn()
        .query_row(
            "SELECT status FROM verification_runs WHERE id=?1",
            params![run],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "interrupted");
    // No new start after shutdown began.
    let e = env.err(
        "verification.run",
        env.run_params("t0", &cmd, "nova-demo-0", "mountless"),
    );
    assert_eq!(e["message"], MSG_SHUTTING_DOWN);
}

#[test]
fn restart_reconciles_open_starts_and_the_old_worker_never_overwrites() {
    let (mut env, cmd) = mountless_env(1);
    env.file("exec.gate", "");
    let (run, seq) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    env.wait_exec_started();
    // A6 I2: a finished event naming ANOTHER start never closes this one.
    {
        let db = env.inner.lock_db();
        EventLog::from_conn(db.conn())
            .append(
                "t0",
                "verification.finished",
                &serde_json::json!({"runId": "other", "startedSequence": seq + 1000,
                    "outcome": "exited"}),
                "t",
            )
            .unwrap();
    }
    let old = env.restart();
    let finished = env.finished_events("t0");
    let mine: Vec<_> = finished
        .iter()
        .filter(|p| p["startedSequence"] == seq)
        .collect();
    assert_eq!(mine.len(), 1, "{finished:?}");
    assert_eq!(mine[0]["outcome"], "interrupted");
    assert_eq!(mine[0]["reconciledAfterRestart"], true);
    assert_eq!(mine[0]["runId"], run.as_str());
    assert_eq!(
        env.ok("verification.result", serde_json::json!({"runId": run}))["outcome"],
        "interrupted"
    );
    // The dead Core's worker ends later: R3, its record never lands.
    env.file("exec.release", "");
    let until = Instant::now() + Duration::from_secs(20);
    while !old.verifications.is_empty() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    let mine = env
        .finished_events("t0")
        .into_iter()
        .filter(|p| p["startedSequence"] == seq)
        .count();
    assert_eq!(mine, 1);
    // A second restart finds nothing open.
    drop(old);
    let before = env.events("t0").len();
    let _old = env.restart();
    assert_eq!(
        env.events("t0").len(),
        before,
        "reconciliation is idempotent"
    );
}

/// W3 / A2 item 7: a reconciliation that cannot be made durable (the row
/// update, or the `verification.finished` event) means Core does not serve.
#[test]
fn startup_fails_closed_when_verification_reconciliation_fails() {
    for trigger in [
        "CREATE TRIGGER block_runs BEFORE UPDATE ON verification_runs
         BEGIN SELECT RAISE(ABORT, 'test: reconciliation blocked'); END;",
        "CREATE TRIGGER block_events BEFORE INSERT ON task_events
         BEGIN SELECT RAISE(ABORT, 'test: reconciliation blocked'); END;",
    ] {
        startup_fails_closed_with(trigger);
    }
}

fn startup_fails_closed_with(trigger: &str) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite3");
    {
        let db = Database::open(&path).unwrap();
        let c = db.conn();
        c.execute_batch(
            "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
             INSERT INTO conversations (id,project_id,agent_id,created_at) VALUES ('c1','p1','codex','t');
             INSERT INTO tasks (id,conversation_id,status,created_at,updated_at) VALUES ('t1','c1','completed','t','t');
             INSERT INTO verification_commands (id,project_id,label,argv_json,approved_at) VALUES ('v1','p1','x','[\"x\"]','t');",
        )
        .unwrap();
        let ev = EventLog::from_conn(c)
            .append(
                "t1",
                "verification.started",
                &serde_json::json!({"runId": "r1"}),
                "t",
            )
            .unwrap();
        c.execute(
            "INSERT INTO verification_runs (id,task_id,command_id,sandbox_name,workspace_mode,
                 argv_json,label,status,started_sequence,started_at)
             VALUES ('r1','t1','v1','atlas-demo','mountless','[\"x\"]','x','running',?1,'t')",
            params![ev.sequence],
        )
        .unwrap();
        c.execute_batch(trigger).unwrap();
    }
    let db = Database::open(&path).unwrap();
    let r = ServerInner::try_with_config(
        db,
        SbxLocator::with_search(None, vec![]),
        CoreConfig::default(),
    );
    let err = match r {
        Ok(_) => panic!("{trigger}: Core started with an unreconciled verification"),
        Err(e) => e.to_string(),
    };
    assert!(
        err.contains("verification restart reconciliation failed"),
        "{err}"
    );
}

// --- W2 / I3: outcomes ---------------------------------------------------------

#[test]
fn exit_status_is_passed_through_as_reported() {
    let (mut env, cmd) = mountless_env(1);
    env.file("exec.exit", "7");
    let (run, seq) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    let r = env.wait_finished(&run);
    assert_eq!(
        (r["outcome"].as_str(), r["exitCode"].as_i64()),
        (Some("exited"), Some(7))
    );
    assert!(r["elapsedMs"].is_u64());
    assert!(r["finishedAt"].is_string());
    let f = env.finished_events("t0");
    assert_eq!(f.len(), 1);
    assert_eq!(f[0]["exitCode"], 7);
    assert_eq!(f[0]["startedSequence"], seq);
}

#[test]
fn an_sbx_shaped_error_is_possibly_sbx_error_and_keeps_its_code() {
    let (mut env, cmd) = mountless_env(1);
    env.file(
        "exec.stderr",
        "error: not signed in to Docker\n  try: sbx login\n",
    );
    env.file("exec.exit", "1");
    let (run, _) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    let r = env.wait_finished(&run);
    assert_eq!(r["outcome"], "possibly_sbx_error");
    assert_eq!(r["exitCode"], 1);
}

#[test]
fn a_signal_death_is_signaled_with_no_code() {
    let (mut env, cmd) = mountless_env(1);
    env.file("exec.selfkill", "");
    let (run, _) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    let r = env.wait_finished(&run);
    assert_eq!(r["outcome"], "signaled");
    assert!(r.get("exitCode").is_none(), "{r}");
}

#[test]
fn a_timeout_kills_the_group_and_keeps_partial_output() {
    let (mut env, cmd) = {
        let mut env = Env::with(Seams {
            limits: Some((
                RunLimits {
                    timeout: Duration::from_millis(700),
                    max_stdout: 64 * 1024,
                    max_stderr: 64 * 1024,
                },
                Duration::from_millis(200),
            )),
            ..Seams::default()
        });
        env.bind("t0", "nova-demo-0", "mountless", Some(SBX_ID));
        env.set_ls(&[running_row("nova-demo-0", Some(vec![]))]);
        let cmd = env.approve("slow", &["sleep", "60"]);
        (env, cmd)
    };
    env.file("exec.stdout", "partial-marker-91c2\n");
    env.file("exec.sleep", "");
    let t = Instant::now();
    let (run, _) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    let r = env.wait_finished(&run);
    assert_eq!(r["outcome"], "timed_out");
    assert!(r.get("exitCode").is_none());
    assert_eq!(r["stdout"], "partial-marker-91c2\n", "partial output kept");
    assert!(
        t.elapsed() < Duration::from_secs(15),
        "killed, not waited out"
    );
}

#[test]
fn a_vanished_program_is_spawn_failed() {
    let (mut env, cmd) = mountless_env(1);
    env.file("ls.selfdelete", "");
    let (run, _) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    let r = env.wait_finished(&run);
    assert_eq!(r["outcome"], "spawn_failed", "{r}");
    assert_eq!(env.finished_events("t0").len(), 1);
    env.wait_idle();
}

// --- W1 / item 6: redaction before storage; output never in events -----------------

#[test]
fn output_is_redacted_before_storage_and_never_in_events() {
    let (mut env, cmd) = mountless_env(1);
    let token = format!("ghp_{}", "Z9y8X7w6V5".repeat(4));
    env.file(
        "exec.stdout",
        &format!("STDOUT-MARKER-7f3a token={token}\n"),
    );
    env.file("exec.stderr", "STDERR-MARKER-2b9d\n");
    let (run, _) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    let r = env.wait_finished(&run);
    let stdout = r["stdout"].as_str().unwrap();
    assert!(stdout.contains("STDOUT-MARKER-7f3a"));
    assert!(!stdout.contains(&token), "a token was stored: {stdout}");
    assert!(r["redactions"]["replacements"].as_u64().unwrap() >= 1);
    assert_eq!(r["redactions"]["bestEffort"], true);
    assert!(r["redactions"]["byKind"]
        .as_object()
        .unwrap()
        .values()
        .any(|v| v.as_u64() >= Some(1)));
    let raw: String = env
        .inner
        .lock_db()
        .conn()
        .query_row(
            "SELECT stdout FROM verification_runs WHERE id=?1",
            params![run],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!raw.contains(&token), "the raw row holds the token");
    for (_, kind, payload) in env.events("t0") {
        let text = payload.to_string();
        assert!(!text.contains("MARKER"), "{kind} carries output: {text}");
        assert!(!text.contains(&token), "{kind} carries a token");
    }
    let f = &env.finished_events("t0")[0];
    assert_eq!(
        f["stdoutBytes"],
        format!("STDOUT-MARKER-7f3a token={token}\n").len()
    );
    assert_eq!(f["stderrBytes"], "STDERR-MARKER-2b9d\n".len());
    let started = env
        .events("t0")
        .into_iter()
        .find(|(_, k, _)| k == "verification.started")
        .unwrap()
        .2;
    assert_eq!(started["runId"], run.as_str());
    assert_eq!(started["commandId"], cmd.as_str());
    assert_eq!(started["argv"], serde_json::json!(["make", "test"]));
    assert_eq!(started["sandbox"], "nova-demo-0");
    assert_eq!(started["workspaceMode"], "mountless");
    assert_eq!(started["label"], "unit tests");
}

// --- W7: deletes refuse while a run is in flight; explicit delete order --------

#[test]
fn deletes_refuse_while_a_run_is_in_flight() {
    let (mut env, cmd) = mountless_env(1);
    // Step-2 tokens obtained while nothing runs (a project delete needs no
    // live binding at step 1, so the binding is hidden for that one call).
    let conv_token = env.ok(
        "conversation.delete",
        serde_json::json!({"conversationId": env.conversation_id}),
    )["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let rm_token = env.ok("sandbox.remove", serde_json::json!({"name": "nova-demo-0"}))
        ["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    env.inner
        .lock_db()
        .conn()
        .execute(
            "UPDATE sandbox_bindings SET removed_at='t' WHERE id='b-t0'",
            [],
        )
        .unwrap();
    let project_token = env.ok(
        "project.delete",
        serde_json::json!({"projectId": env.project_id}),
    )["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    env.inner
        .lock_db()
        .conn()
        .execute(
            "UPDATE sandbox_bindings SET removed_at=NULL WHERE id='b-t0'",
            [],
        )
        .unwrap();

    env.file("exec.gate", "");
    let (run, _) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    env.wait_exec_started();
    env.reset_calls();
    // Step 1.
    let e = env.err(
        "project.delete",
        serde_json::json!({"projectId": env.project_id}),
    );
    assert_eq!(
        (e["code"].as_str(), e["message"].as_str()),
        (Some("CONFLICT"), Some(MSG_PROJECT_RUNNING))
    );
    let e = env.err(
        "conversation.delete",
        serde_json::json!({"conversationId": env.conversation_id}),
    );
    assert_eq!(e["message"], MSG_CONVERSATION_RUNNING);
    let e = env.err("sandbox.remove", serde_json::json!({"name": "nova-demo-0"}));
    assert_eq!(e["message"], MSG_SANDBOX_RUNNING);
    // Step 2.
    let e = env.err(
        "project.delete",
        serde_json::json!({"projectId": env.project_id, "confirmToken": project_token}),
    );
    assert_eq!(e["message"], MSG_PROJECT_RUNNING);
    let e = env.err(
        "conversation.delete",
        serde_json::json!({"conversationId": env.conversation_id, "confirmToken": conv_token}),
    );
    assert_eq!(e["message"], MSG_CONVERSATION_RUNNING);
    let e = env.err(
        "sandbox.remove",
        serde_json::json!({"name": "nova-demo-0", "confirmToken": rm_token}),
    );
    assert_eq!(e["message"], MSG_SANDBOX_RUNNING);
    assert!(!env.verbs().contains(&"rm".to_string()), "sbx rm ran");
    env.file("exec.release", "");
    env.wait_finished(&run);
    env.wait_idle();

    // Explicit delete order once nothing runs: runs before tasks…
    let t = env.ok(
        "conversation.delete",
        serde_json::json!({"conversationId": env.conversation_id}),
    )["confirmation"]["token"]
        .clone();
    env.ok(
        "conversation.delete",
        serde_json::json!({"conversationId": env.conversation_id, "confirmToken": t}),
    );
    let count = |env: &Env, sql: &str| -> i64 {
        env.inner
            .lock_db()
            .conn()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(count(&env, "SELECT COUNT(*) FROM verification_runs"), 0);
    // …and commands before projects.
    env.inner
        .lock_db()
        .conn()
        .execute("UPDATE sandbox_bindings SET removed_at='t'", [])
        .unwrap();
    let t = env.ok(
        "project.delete",
        serde_json::json!({"projectId": env.project_id}),
    )["confirmation"]["token"]
        .clone();
    env.ok(
        "project.delete",
        serde_json::json!({"projectId": env.project_id, "confirmToken": t}),
    );
    assert_eq!(count(&env, "SELECT COUNT(*) FROM verification_commands"), 0);
}

// --- §3.7 item 9: project.context on real repositories --------------------------

fn write(dir: &Path, name: &str, bytes: &[u8]) {
    std::fs::write(dir.join(name), bytes).unwrap();
}

#[test]
fn project_context_reads_registered_repositories_only_and_safely() {
    let mut env = Env::new();
    let repo = PathBuf::from(&env.repo);
    write(
        &repo,
        "package.json",
        br#"{"scripts":{"test":"jest","test":"vitest \u001b]8;;http://x\u0007run","pretest":"node pre.js","posttest":"node post.js","lint":"eslint ."}}"#,
    );
    write(&repo, ".npmrc", b"script-shell=/bin/zsh\n");
    write(&repo, "GNUmakefile", b"test:\n\techo gnu\n");
    write(&repo, "Makefile", b"check:\n\techo other\n");
    write(&repo, "Cargo.toml", b"[package]\nname='atlas'\n");
    write(&repo, "go.mod", b"module atlas\n");
    write(&repo, "pyproject.toml", &[0xEF, 0xBB, 0xBF, b'[']);
    let cmd = env.approve("unit tests", &["cargo", "test"]);
    let r = env.ok(
        "project.context",
        serde_json::json!({"projectId": env.project_id}),
    );
    assert_eq!(r["approved"][0]["id"], cmd.as_str());
    let repo_ctx = &r["repositories"][0];
    assert_eq!(repo_ctx["repoPath"], env.repo.as_str());
    let by: std::collections::HashMap<String, serde_json::Value> = repo_ctx["detected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (d["manifest"].as_str().unwrap().to_string(), d.clone()))
        .collect();
    let pkg = &by["package.json"];
    assert_eq!(
        pkg["suggestedCommands"],
        serde_json::json!([["npm", "run", "test"], ["npm", "run", "lint"]])
    );
    let notes: Vec<&str> = pkg["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect();
    assert!(
        notes
            .iter()
            .any(|n| n.starts_with("npm run test runs: vitest")),
        "duplicate key: last wins: {notes:?}"
    );
    assert!(notes.contains(&"npm run test first runs pretest: node pre.js"));
    assert!(notes.contains(&"npm run test then runs posttest: node post.js"));
    assert!(notes.iter().any(|n| n.contains(".npmrc")));
    assert!(notes
        .iter()
        .any(|n| n.starts_with("this is the file in your registered repository now")));
    assert_eq!(
        by["GNUmakefile"]["suggestedCommands"],
        serde_json::json!([["make", "test"]])
    );
    assert!(
        !by.contains_key("Makefile"),
        "GNU make reads GNUmakefile first"
    );
    assert_eq!(
        by["Cargo.toml"]["suggestedCommands"],
        serde_json::json!([["cargo", "test"]])
    );
    assert_eq!(
        by["go.mod"]["suggestedCommands"],
        serde_json::json!([["go", "test", "./..."]])
    );
    let unreadable = repo_ctx["unreadable"].as_array().unwrap();
    assert!(
        unreadable.contains(&serde_json::json!("pyproject.toml")),
        "BOM: {unreadable:?}"
    );

    // A symlinked manifest, an oversized one, and deeply nested JSON.
    std::fs::remove_file(repo.join("package.json")).unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(
        outside.path(),
        "package.json",
        br#"{"scripts":{"test":"stolen"}}"#,
    );
    std::os::unix::fs::symlink(
        outside.path().join("package.json"),
        repo.join("package.json"),
    )
    .unwrap();
    write(&repo, "go.mod", &vec![b'a'; 256 * 1024 + 1]);
    let r = env.ok(
        "project.context",
        serde_json::json!({"projectId": env.project_id}),
    );
    let unreadable = r["repositories"][0]["unreadable"]
        .as_array()
        .unwrap()
        .clone();
    assert!(
        unreadable.contains(&serde_json::json!("package.json")),
        "{unreadable:?}"
    );
    assert!(
        unreadable.contains(&serde_json::json!("go.mod")),
        "{unreadable:?}"
    );
    assert!(!r.to_string().contains("stolen"));
    std::fs::remove_file(repo.join("package.json")).unwrap();
    let deep = format!("{}{}", "[".repeat(5000), "]".repeat(5000));
    write(&repo, "package.json", deep.as_bytes());
    let r = env.ok(
        "project.context",
        serde_json::json!({"projectId": env.project_id}),
    );
    assert!(r["repositories"][0]["unreadable"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("package.json")));

    // A symlinked ROOT (the registered path replaced by a link): nothing read.
    let moved = PathBuf::from(format!("{}-moved", env.repo));
    std::fs::rename(&repo, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &repo).unwrap();
    let r = env.ok(
        "project.context",
        serde_json::json!({"projectId": env.project_id}),
    );
    assert_eq!(r["repositories"][0]["unreadable"], serde_json::json!(["."]));
    assert_eq!(r["repositories"][0]["detected"], serde_json::json!([]));
    std::fs::remove_file(&repo).unwrap();
    std::fs::rename(&moved, &repo).unwrap();

    let e = env.err("project.context", serde_json::json!({"projectId": "nope"}));
    assert_eq!(e["code"], "NOT_FOUND");
}

// --- Security review follow-ups (W1, W2, W3) ---------------------------------------

const FRAME_REFUSAL_PREFIX: &str = "the response would exceed the frame limit (";

/// Every frame Core answers must fit the transport cap.
fn frame_len(env: &mut Env, method: &str, params: serde_json::Value) -> (usize, serde_json::Value) {
    env.seq += 1;
    let frame = serde_json::json!({"v": PROTOCOL_VERSION, "id": env.seq.to_string(),
        "method": method, "params": params});
    let line = handle_line(&env.inner, &frame.to_string());
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    (line.len(), v)
}

/// W1 fix 1: control characters are refused at approve.
#[test]
fn approve_refuses_control_characters_in_argv() {
    let mut env = Env::new();
    let e = env.err(
        "verification.approve",
        serde_json::json!({"projectId": env.project_id, "label": "x",
            "argv": ["echo", "a\u{1}b"]}),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED");
    assert_eq!(
        e["message"],
        "argv: value has an invalid shape: argument 2 contains a control character"
    );
}

/// Rows stored before W1 fix 1 (here seeded directly): 50 commands of
/// 16 KiB of `\x01` each. Each response is refused structurally — never an
/// oversized frame — and says what to do.
fn seed_oversized_commands(env: &Env) -> Vec<String> {
    let db = env.inner.lock_db();
    let mut ids = Vec::new();
    for i in 0..50 {
        let argv: Vec<String> = std::iter::once(format!("p{i}"))
            .chain(std::iter::repeat_n("\u{1}".repeat(4000), 4))
            .collect();
        let id = format!("cmd-{i:02}");
        db.conn()
            .execute(
                "INSERT INTO verification_commands (id, project_id, label, argv_json, approved_at)
                 VALUES (?1, ?2, ?3, ?4, '2026-10-12T00:00:00Z')",
                params![
                    id,
                    env.project_id,
                    format!("c{i}"),
                    serde_json::to_string(&argv).unwrap()
                ],
            )
            .unwrap();
        ids.push(id);
    }
    ids
}

#[test]
fn oversized_list_and_context_are_refused_not_sent() {
    let mut env = Env::new();
    let ids = seed_oversized_commands(&env);
    for method in ["verification.list", "project.context"] {
        let (len, v) = {
            let pid = env.project_id.clone();
            frame_len(&mut env, method, serde_json::json!({"projectId": pid}))
        };
        assert!(
            len < sandpane_service::MAX_FRAME_BYTES,
            "{method}: {len}-byte frame sent"
        );
        let e = &v["err"];
        assert_eq!(e["code"], "VALIDATION_FAILED", "{method}: {v}");
        let m = e["message"].as_str().unwrap();
        assert!(m.starts_with(FRAME_REFUSAL_PREFIX), "{m}");
        assert!(m.ends_with("nothing was returned"), "{m}");
        assert!(m.contains("revoke"), "{m}");
    }
    let (_, v) = {
        let pid = env.project_id.clone();
        frame_len(
            &mut env,
            "verification.list",
            serde_json::json!({"projectId": pid}),
        )
    };
    let listed: Vec<&str> = v["err"]["details"]["commandIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap())
        .collect();
    assert_eq!(listed.len(), ids.len(), "every id is offered for revoking");
    // Revoking enough of them makes the list fit again.
    for id in &ids[..25] {
        env.ok(
            "verification.revoke",
            serde_json::json!({ "commandId": id }),
        );
    }
    let list = env.ok(
        "verification.list",
        serde_json::json!({"projectId": env.project_id}),
    );
    assert_eq!(list["commands"].as_array().unwrap().len(), 25);
}

/// W1: the repository-count trigger. 700 registered entries of one real
/// repository whose package.json yields ~6 KiB of notes each.
#[test]
fn project_context_with_too_many_repositories_is_refused_naming_them() {
    let mut env = Env::new();
    let long = "x".repeat(600);
    let mut scripts = serde_json::Map::new();
    for name in ["test", "check", "lint", "build"] {
        for prefix in ["", "pre", "post"] {
            scripts.insert(format!("{prefix}{name}"), serde_json::json!(long));
        }
    }
    std::fs::write(
        Path::new(&env.repo).join("package.json"),
        serde_json::json!({ "scripts": scripts }).to_string(),
    )
    .unwrap();
    {
        let db = env.inner.lock_db();
        for i in 0..700 {
            db.conn()
                .execute(
                    "INSERT INTO repositories (id, project_id, canonical_path) VALUES (?1, ?2, ?3)",
                    params![format!("r-{i}"), env.project_id, env.repo],
                )
                .unwrap();
        }
    }
    let (len, v) = {
        let pid = env.project_id.clone();
        frame_len(
            &mut env,
            "project.context",
            serde_json::json!({"projectId": pid}),
        )
    };
    assert!(
        len < sandpane_service::MAX_FRAME_BYTES,
        "{len}-byte frame sent"
    );
    let m = v["err"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("{v}"));
    assert!(m.starts_with(FRAME_REFUSAL_PREFIX), "{m}");
    assert!(m.contains(&env.repo), "names the largest repository: {m}");
    assert!(m.contains("remove repositories"), "{m}");
    assert!(!v["err"]["details"]["repositories"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn an_oversized_result_is_refused_not_sent() {
    let (mut env, cmd) = mountless_env(1);
    {
        let db = env.inner.lock_db();
        let ev = EventLog::from_conn(db.conn())
            .append(
                "t0",
                "verification.started",
                &serde_json::json!({"runId": "big"}),
                "t",
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO verification_runs (id, task_id, command_id, sandbox_name,
                     workspace_mode, argv_json, label, status, outcome, exit_code, stdout,
                     started_sequence, started_at, finished_at)
                 VALUES ('big', 't0', ?1, 'nova-demo-0', 'mountless', '[\"make\"]', 'x',
                     'finished', 'exited', 0, ?2, ?3, 't', 't')",
                params![cmd, "\u{1}".repeat(1_000_000), ev.sequence],
            )
            .unwrap();
    }
    let (len, v) = frame_len(
        &mut env,
        "verification.result",
        serde_json::json!({"runId": "big"}),
    );
    assert!(
        len < sandpane_service::MAX_FRAME_BYTES,
        "{len}-byte frame sent"
    );
    let m = v["err"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("{v}"));
    assert!(m.starts_with(FRAME_REFUSAL_PREFIX), "{m}");
}

/// The backstop keeps 64 KiB of headroom for the envelope: a response that
/// would itself still fit under MAX_FRAME_BYTES, but inside that headroom,
/// is refused too.
#[test]
fn a_result_inside_the_envelope_headroom_is_refused() {
    let (mut env, cmd) = mountless_env(1);
    let stdout = "a".repeat(sandpane_service::MAX_FRAME_BYTES - 32 * 1024);
    {
        let db = env.inner.lock_db();
        let ev = EventLog::from_conn(db.conn())
            .append(
                "t0",
                "verification.started",
                &serde_json::json!({"runId": "near"}),
                "t",
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO verification_runs (id, task_id, command_id, sandbox_name,
                     workspace_mode, argv_json, label, status, outcome, exit_code, stdout,
                     started_sequence, started_at, finished_at)
                 VALUES ('near', 't0', ?1, 'nova-demo-0', 'mountless', '[\"make\"]', 'x',
                     'finished', 'exited', 0, ?2, ?3, 't', 't')",
                params![cmd, stdout, ev.sequence],
            )
            .unwrap();
    }
    let (len, v) = frame_len(
        &mut env,
        "verification.result",
        serde_json::json!({"runId": "near"}),
    );
    assert!(len < sandpane_service::MAX_FRAME_BYTES);
    let m = v["err"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("a {len}-byte answer was sent"));
    assert!(m.starts_with(FRAME_REFUSAL_PREFIX), "{m}");
}

/// W3: a secret split across elements is refused at approve…
#[test]
fn approve_refuses_a_secret_split_across_elements() {
    let mut env = Env::new();
    let e = env.err(
        "verification.approve",
        serde_json::json!({"projectId": env.project_id, "label": "headers",
            "argv": ["curl", "-H", "Authorization:", "Bearer",
                     "q7Zr2LkP9xVb3NcT8mWd4HfJ6sYa1GeU5oRi0tQk"]}),
    );
    assert_eq!(
        e["message"],
        "the arguments together look like a secret (auth-header); approved commands cannot hold \
         secrets; nothing was approved"
    );
    assert!(e["details"]["hint"]
        .as_str()
        .unwrap()
        .contains("no override"));
}

/// …and a command stored under an older, weaker check is refused at run
/// start, before any sbx call.
#[test]
fn a_command_that_no_longer_passes_the_secret_check_is_refused_at_run() {
    let (mut env, _) = mountless_env(1);
    let argv = serde_json::json!([
        "curl",
        "-H",
        "Authorization:",
        "Bearer",
        "q7Zr2LkP9xVb3NcT8mWd4HfJ6sYa1GeU5oRi0tQk"
    ]);
    env.inner
        .lock_db()
        .conn()
        .execute(
            "INSERT INTO verification_commands (id, project_id, label, argv_json, approved_at)
             VALUES ('old', ?1, 'old', ?2, 't')",
            params![env.project_id, argv.to_string()],
        )
        .unwrap();
    env.reset_calls();
    let e = env.err(
        "verification.run",
        env.run_params("t0", "old", "nova-demo-0", "mountless"),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED");
    assert_eq!(
        e["message"],
        "this command no longer passes the secret check; revoke it; nothing was run"
    );
    assert!(env.calls().is_empty(), "sbx ran: {:?}", env.verbs());
    assert!(env.events("t0").is_empty());
}

/// W3 with W1: a stored command holding a control character (approved
/// before the shape check refused them) is refused at run start too.
#[test]
fn a_command_that_no_longer_passes_the_shape_check_is_refused_at_run() {
    let (mut env, _) = mountless_env(1);
    env.inner
        .lock_db()
        .conn()
        .execute(
            "INSERT INTO verification_commands (id, project_id, label, argv_json, approved_at)
             VALUES ('ctl', ?1, 'ctl', ?2, 't')",
            params![
                env.project_id,
                serde_json::json!(["echo", "a\u{1}b"]).to_string()
            ],
        )
        .unwrap();
    env.reset_calls();
    let e = env.err(
        "verification.run",
        env.run_params("t0", "ctl", "nova-demo-0", "mountless"),
    );
    assert_eq!(e["code"], "VALIDATION_FAILED");
    assert_eq!(
        e["message"],
        "this command no longer passes the argument checks (argv: value has an invalid shape: \
         argument 2 contains a control character); revoke it; nothing was run"
    );
    assert!(env.calls().is_empty(), "sbx ran: {:?}", env.verbs());
    assert!(env.events("t0").is_empty());
}

/// W2 end to end: `sbx exec` exits 0 while a descendant in its own session
/// holds stdout. The exit status is kept, never rewritten to timed_out, and
/// the result and the finished event say the output may be incomplete.
#[test]
fn an_escaped_descendant_keeps_the_exit_status_and_flags_incomplete_output() {
    let (mut env, cmd) = mountless_env(1);
    env.file("exec.stdout", "before-exit\n");
    env.file("exec.escape", "");
    let t = Instant::now();
    let (run, _) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    let r = env.wait_finished(&run);
    assert_eq!(r["outcome"], "exited", "{r}");
    assert_eq!(r["exitCode"], 0);
    assert_eq!(r["outputIncomplete"], true);
    assert_eq!(r["stdout"], "before-exit\n");
    assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
    let f = &env.finished_events("t0")[0];
    assert_eq!(f["outputIncomplete"], true);
    // A complete run carries no flag.
    env.rm("exec.escape");
    let (run, _) = start(&mut env, "t0", &cmd, "nova-demo-0", "mountless");
    let r = env.wait_finished(&run);
    assert!(r.get("outputIncomplete").is_none(), "{r}");
}

// --- Wire surface ------------------------------------------------------------------

#[test]
fn the_probe_advertises_verification_and_the_six_methods_in_order() {
    let mut env = Env::new();
    let caps = env.ok("system.probe", serde_json::json!({}));
    assert!(caps["features"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("verification")));
    let methods: Vec<&str> = caps["methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.as_str().unwrap())
        .collect();
    // 36 since A9 added maintenance.inventory and maintenance.cleanup.
    assert_eq!(methods.len(), 36);
    let at = methods.iter().position(|m| *m == "git.apply").unwrap();
    assert_eq!(
        &methods[at + 1..at + 7],
        [
            "verification.list",
            "verification.approve",
            "verification.revoke",
            "verification.run",
            "verification.result",
            "project.context"
        ]
    );
}

// --- Production seams --------------------------------------------------------------

#[test]
fn production_config_has_no_verification_seams() {
    let c = CoreConfig::default();
    assert!(c.test_verified_exec_versions.is_none());
    assert!(c.test_verification_limits.is_none());
    assert!(c.test_verification_env.is_none());
    assert!(c.test_verification_before_start.is_none());
    assert!(sandpane_core::sbx::VERIFIED_EXEC_VERSIONS.is_empty());
    let main =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs")).unwrap();
    assert!(
        !main.contains("test_verif"),
        "main.rs must not set a verification seam"
    );
}
