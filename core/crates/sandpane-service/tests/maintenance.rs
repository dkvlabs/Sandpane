//! A9 — `maintenance.inventory` / `maintenance.cleanup` (design 2026-10-09
//! §3.9, item 8 tests).
//!
//! Every request is a real frame through the production dispatch
//! (`handle_line`). Everything happens inside each test's OWN temporary
//! directory (never `$HOME` or the real Sandpane data directory). No sbx is
//! reachable (the locator searches an empty directory) and no git runs; the
//! spawn counter proof is in `maintenance_spawn.rs` (its own binary, so no
//! parallel test can move the process-wide counter).
//!
//! Cross-process liveness uses a helper child: this test binary re-executed
//! with `--exact helper_hold_core_temp` and an env-var switch; the helper
//! builds its own Core on the SAME data directory and holds a real
//! `CoreTemp`.

#![cfg(unix)]

use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use sandpane_core::sbx::SbxLocator;
use sandpane_core::Database;
use sandpane_protocol::PROTOCOL_VERSION;
use sandpane_service::{
    handle_line, rfc3339_from_unix, CoreConfig, CoreTemp, MaintenanceLimits, PathHook, ServerInner,
    TestHook,
};
use serde_json::{json, Value};

// --- Pinned strings (clients match on these) ---------------------------------

const R_THIS_CORE: &str = "in use by this Sandpane Core";
const R_LIVE: &str = "in use by a running Sandpane Core";
const R_RECENT_LOCK: &str = "being created; Sandpane waits 10 minutes before offering it";
const R_UNLOCKED_RECENT: &str = "it has no lock file and changed less than 10 minutes ago or \
     after this Core started; it may still be in use";
const R_NOT_DIR: &str = "not a real directory owned by you";
const R_BAD_LOCK: &str = "its lock file is not a regular file owned by you";
const R_FOREIGN: &str = "not created by Sandpane";
const R_DB_OUTSIDE: &str =
    "the database is outside Sandpane's data directory; manage these files yourself";
const R_DB_NEWEST: &str = "the only way back to the previous Sandpane Core version";
const R_DB_NOT_FILE: &str = "not a regular file owned by you";
const R_WORKTREE: &str = "removal waits for W-D: Sandpane cannot remove worktrees yet";
const SKIP_GONE: &str = "no longer present";
const SKIP_CHANGED: &str = "changed since you confirmed";
const NOTE_VO: &str = "output removed from Sandpane's records; the database file does not \
     shrink, older migration backups may still contain it, and residual copies may remain on \
     disk (removal is best effort)";
const R_LIVE_OR_PROBED: &str = "being checked by a scan or in use by a Sandpane Core; scan again";
const MSG_CLEANUP_SCAN_BUSY: &str =
    "a maintenance scan is running; wait for it to finish; nothing was changed";
const D_ORPHAN: &str = "not referenced by this Core's database; another Sandpane Core using a \
     different database may own it";
const MSG_SCAN_BUSY: &str =
    "a maintenance scan is already running; wait for it to finish; nothing was scanned";
const MSG_CLEANUP_BUSY: &str =
    "a maintenance cleanup is already running; wait for it to finish; nothing was changed";
const MSG_NO_ITEMS: &str = "items must name at least one inventory item; nothing was changed";
const MSG_TOO_MANY: &str = "at most 500 items per cleanup; nothing was changed";
const MSG_DUPLICATE: &str = "duplicate item ids; nothing was changed";
const MSG_BAD_ID: &str = "an item id is not a maintenance item id; nothing was changed";
const MSG_CUTOFF_TOO_LATE: &str = "the verificationOutput cutoff is later than Core's retention \
     allows; scan again; nothing was changed";
const MSG_TOKEN: &str =
    "confirmation token is invalid, expired, already used, or not for this action and target; \
     request a new confirmation";

fn msg_unknown(id: &str) -> String {
    format!("item {id} is not in Core's inventory; scan again; nothing was changed")
}

fn msg_not_removable(id: &str, reason: &str) -> String {
    format!("item {id} cannot be removed ({reason}); nothing was changed")
}

// --- Harness -------------------------------------------------------------------

type PathFn = Arc<dyn Fn(&Path) + Send + Sync>;
type CoreFn = Arc<dyn Fn(&ServerInner) + Send + Sync>;

/// A one-shot hook slot (the hook is taken before it runs).
#[derive(Clone, Default)]
struct PathSlot(Arc<Mutex<Option<PathFn>>>);

impl PathSlot {
    fn set(&self, f: impl Fn(&Path) + Send + Sync + 'static) {
        *self.0.lock().unwrap() = Some(Arc::new(f));
    }
    fn hook(&self) -> PathHook {
        let slot = self.0.clone();
        PathHook(Arc::new(move |p: &Path| {
            let f = slot.lock().unwrap().take();
            if let Some(f) = f {
                f(p);
            }
        }))
    }
}

#[derive(Clone, Default)]
struct CoreSlot(Arc<Mutex<Option<CoreFn>>>);

impl CoreSlot {
    fn set(&self, f: impl Fn(&ServerInner) + Send + Sync + 'static) {
        *self.0.lock().unwrap() = Some(Arc::new(f));
    }
    fn hook(&self) -> TestHook {
        let slot = self.0.clone();
        TestHook(Arc::new(move |inner: &ServerInner| {
            let f = slot.lock().unwrap().take();
            if let Some(f) = f {
                f(inner);
            }
        }))
    }
}

#[derive(Default)]
struct Opts {
    db_in_data: bool,
    no_data_dir: bool,
    ttl: Option<Duration>,
    limits: Option<MaintenanceLimits>,
}

struct Env {
    base: tempfile::TempDir,
    data: PathBuf,
    db_path: PathBuf,
    inner: Arc<ServerInner>,
    after_lock_create: PathSlot,
    after_unlink: PathSlot,
    after_dir_removed: PathSlot,
    in_flight: CoreSlot,
    seq: u64,
}

fn rpc_on(inner: &ServerInner, id: &str, method: &str, params: Value) -> Value {
    let frame = json!({"v": PROTOCOL_VERSION, "id": id, "method": method, "params": params});
    serde_json::from_str(&handle_line(inner, &frame.to_string())).unwrap()
}

fn private_dir(p: &Path) {
    std::fs::create_dir_all(p).unwrap();
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).unwrap();
}

impl Env {
    fn new() -> Self {
        Self::with(Opts::default())
    }

    fn with(o: Opts) -> Self {
        let base = tempfile::tempdir().unwrap();
        let base_c = std::fs::canonicalize(base.path()).unwrap();
        let data = base_c.join("data");
        private_dir(&data);
        let db_path = if o.db_in_data {
            data.join("core.sqlite3")
        } else {
            base_c.join("core.sqlite3")
        };
        let after_lock_create = PathSlot::default();
        let after_unlink = PathSlot::default();
        let after_dir_removed = PathSlot::default();
        let in_flight = CoreSlot::default();
        let db = Database::open(&db_path).unwrap();
        let inner = ServerInner::with_config(
            db,
            SbxLocator::with_search(None, vec![base_c.join("no-sbx-here")]),
            CoreConfig {
                worktrees_root: (!o.no_data_dir).then(|| data.join("worktrees")),
                confirmation_ttl: o.ttl,
                test_temp_after_lock_create: Some(after_lock_create.hook()),
                test_cleanup_after_unlink: Some(after_unlink.hook()),
                test_cleanup_after_dir_removed: Some(after_dir_removed.hook()),
                test_maintenance_in_flight: Some(in_flight.hook()),
                test_maintenance_limits: o.limits,
                ..CoreConfig::default()
            },
        );
        Self {
            base,
            data,
            db_path,
            inner,
            after_lock_create,
            after_unlink,
            after_dir_removed,
            in_flight,
            seq: 0,
        }
    }

    fn tmp(&self) -> PathBuf {
        self.data.join("tmp")
    }

    fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.seq += 1;
        rpc_on(&self.inner, &self.seq.to_string(), method, params)
    }

    fn inventory(&mut self) -> Value {
        let r = self.rpc("maintenance.inventory", json!({}));
        assert!(r.get("ok").is_some(), "inventory failed: {r}");
        r["ok"].clone()
    }

    fn step1(&mut self, items: &[&str]) -> Value {
        self.rpc("maintenance.cleanup", json!({ "items": items }))
    }

    fn token(&mut self, items: &[&str]) -> String {
        let r = self.step1(items);
        let c = &r["ok"]["confirmation"];
        assert!(c.is_object(), "step 1 failed: {r}");
        c["token"].as_str().unwrap().to_string()
    }

    fn step2(&mut self, items: &[&str], token: &str) -> Value {
        self.rpc(
            "maintenance.cleanup",
            json!({ "items": items, "confirmToken": token }),
        )
    }

    fn clean(&mut self, items: &[&str]) -> Value {
        let t = self.token(items);
        let r = self.step2(items, &t);
        assert!(r.get("ok").is_some(), "step 2 failed: {r}");
        r["ok"].clone()
    }

    fn sql(&self, sql: &str) {
        self.inner.lock_db().conn().execute_batch(sql).unwrap();
    }
}

fn item<'a>(inv: &'a Value, id: &str) -> Option<&'a Value> {
    inv["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == id)
}

fn ids(inv: &Value) -> Vec<String> {
    inv["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect()
}

fn err_of(r: &Value) -> (String, String) {
    assert!(r.get("err").is_some(), "unexpectedly ok: {r}");
    (
        r["err"]["code"].as_str().unwrap().to_string(),
        r["err"]["message"].as_str().unwrap().to_string(),
    )
}

fn uuid4() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn backdate(path: &Path, secs: u64) {
    let t = SystemTime::now() - Duration::from_secs(secs);
    std::fs::File::open(path).unwrap().set_modified(t).unwrap();
}

/// A temp entry as a crashed Core leaves it: `<uuid>/` and (optionally)
/// `<uuid>.live`, nobody holding the lock.
fn crashed_temp(env: &Env, with_lock: bool, with_dir: bool) -> String {
    private_dir(&env.tmp());
    let u = uuid4();
    if with_dir {
        let d = env.tmp().join(&u);
        private_dir(&d);
        std::fs::write(d.join("patch"), b"stale\n").unwrap();
    }
    if with_lock {
        let l = env.tmp().join(format!("{u}.live"));
        std::fs::write(&l, b"").unwrap();
        std::fs::set_permissions(&l, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    u
}

fn try_flock(f: &std::fs::File) -> bool {
    // SAFETY: flock on a descriptor this test owns.
    unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
}

// --- Cross-process helper ------------------------------------------------------

const HOLDER_DATA: &str = "SANDPANE_A9_HOLDER_DATA";
const HOLDER_MODE: &str = "SANDPANE_A9_HOLDER_MODE";
const HOLDER_READY: &str = "SANDPANE_A9_HOLDER_READY";
const HOLDER_RELEASE: &str = "SANDPANE_A9_HOLDER_RELEASE";

/// NOT a test of its own: a no-op unless the env switch is set, in which
/// case this process is the helper child holding a real `CoreTemp` on the
/// parent's data directory.
#[test]
fn helper_hold_core_temp() {
    let Some(data) = std::env::var_os(HOLDER_DATA) else {
        return;
    };
    let data = PathBuf::from(data);
    let ready = PathBuf::from(std::env::var_os(HOLDER_READY).unwrap());
    let release = PathBuf::from(std::env::var_os(HOLDER_RELEASE).unwrap());
    let mode = std::env::var(HOLDER_MODE).unwrap();
    let inner = ServerInner::with_config(
        Database::open_in_memory().unwrap(),
        SbxLocator::with_search(None, vec![data.join("no-sbx-here")]),
        CoreConfig {
            worktrees_root: Some(data.join("worktrees")),
            ..CoreConfig::default()
        },
    );
    let temp = CoreTemp::new(&inner).unwrap();
    let partial = ready.with_extension("partial");
    std::fs::write(&partial, temp.path().display().to_string()).unwrap();
    std::fs::rename(&partial, &ready).unwrap();
    if mode == "exit" {
        // Die WITHOUT running Drop: the directory and lock file stay, and
        // the kernel releases the flock with the process.
        std::process::exit(0);
    }
    for _ in 0..3000 {
        if release.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(temp);
}

struct Holder {
    child: std::process::Child,
    release: PathBuf,
    path: PathBuf,
}

impl Holder {
    fn start(data: &Path, scratch: &Path, mode: &str) -> Self {
        let ready = scratch.join(format!("ready-{mode}"));
        let release = scratch.join(format!("release-{mode}"));
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "helper_hold_core_temp",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(HOLDER_DATA, data)
            .env(HOLDER_MODE, mode)
            .env(HOLDER_READY, &ready)
            .env(HOLDER_RELEASE, &release)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut holder = Self {
            child,
            release,
            path: PathBuf::new(),
        };
        for _ in 0..1500 {
            if let Ok(p) = std::fs::read_to_string(&ready) {
                holder.path = PathBuf::from(p);
                return holder;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("helper never became ready");
    }

    fn uuid(&self) -> String {
        self.path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    fn wait_exit(&mut self) {
        let status = self.child.wait().unwrap();
        assert!(status.success(), "helper failed: {status}");
    }
}

impl Drop for Holder {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.release, b"");
        for _ in 0..500 {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// --- Wire basics ------------------------------------------------------------------

#[test]
fn methods_and_feature_are_advertised() {
    let mut env = Env::new();
    let probe = env.rpc("system.probe", json!({}));
    let methods = probe["ok"]["methods"].as_array().unwrap();
    for m in ["maintenance.inventory", "maintenance.cleanup"] {
        assert!(methods.iter().any(|x| x == m), "{m} not advertised");
    }
    assert!(probe["ok"]["features"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f == "maintenance"));
}

#[test]
fn a_fresh_core_has_nothing_to_clean_and_absent_params_are_accepted() {
    let mut env = Env::new();
    let inv = env.inventory();
    assert_eq!(inv, json!({"items": [], "truncated": false}));
    let r = env.rpc("maintenance.inventory", Value::Null);
    assert_eq!(r["ok"], inv);
}

#[test]
fn without_a_data_directory_temp_and_worktree_are_unavailable() {
    let mut env = Env::with(Opts {
        no_data_dir: true,
        ..Opts::default()
    });
    let inv = env.inventory();
    let kinds: Vec<&str> = inv["unavailable"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["temp", "worktree"]);
    for u in inv["unavailable"].as_array().unwrap() {
        assert_eq!(
            u["reason"],
            "this Core was started without its data directory"
        );
    }
}

// --- temp ------------------------------------------------------------------------------

#[test]
fn core_temp_keeps_its_lock_file_beside_the_directory_and_removes_both() {
    let mut env = Env::new();
    let t = CoreTemp::new(&env.inner).unwrap();
    let u = t.path().file_name().unwrap().to_string_lossy().into_owned();
    let lock = env.tmp().join(format!("{u}.live"));
    let meta = std::fs::symlink_metadata(&lock).unwrap();
    assert!(meta.file_type().is_file());
    assert_eq!(meta.mode() & 0o777, 0o600);
    assert_eq!(
        std::fs::read_dir(t.path()).unwrap().count(),
        0,
        "nothing new appears inside the temp root"
    );
    assert_eq!(std::fs::metadata(t.path()).unwrap().mode() & 0o777, 0o700);
    // Live in THIS Core: listed, never removable.
    let inv = env.inventory();
    let it = item(&inv, &format!("temp:{u}")).unwrap();
    assert_eq!(it["kind"], "temp");
    assert_eq!(it["removable"], false);
    assert_eq!(it["reason"], R_THIS_CORE);
    let (code, msg) = err_of(&env.step1(&[&format!("temp:{u}")]));
    assert_eq!(
        (code.as_str(), msg),
        (
            "VALIDATION_FAILED",
            msg_not_removable(&format!("temp:{u}"), R_THIS_CORE)
        )
    );
    drop(t);
    assert!(!env.tmp().join(&u).exists());
    assert!(!lock.exists(), "Drop unlinks the lock file");
    assert_eq!(std::fs::read_dir(env.tmp()).unwrap().count(), 0);
}

#[test]
fn a_lock_file_unlinked_between_create_and_flock_makes_the_owner_retry() {
    let env = Env::new();
    let first: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let seen = first.clone();
    env.after_lock_create.set(move |p: &Path| {
        // A cleaner unlinking the lock file in the window.
        std::fs::remove_file(p).unwrap();
        *seen.lock().unwrap() = Some(p.to_path_buf());
    });
    let t = CoreTemp::new(&env.inner).unwrap();
    let first = first.lock().unwrap().clone().expect("hook ran");
    let first_uuid = first
        .file_name()
        .unwrap()
        .to_string_lossy()
        .trim_end_matches(".live")
        .to_string();
    let got = t.path().file_name().unwrap().to_string_lossy().into_owned();
    assert_ne!(got, first_uuid, "retried with a fresh UUID");
    assert!(!env.tmp().join(&first_uuid).exists(), "never mkdir'd");
    assert!(!first.exists());
    assert!(env.tmp().join(format!("{got}.live")).exists());
    drop(t);
    assert_eq!(std::fs::read_dir(env.tmp()).unwrap().count(), 0);
}

#[test]
fn a_core_temp_held_by_another_process_is_never_removable_until_its_holder_exits() {
    let mut env = Env::new();
    let scratch = env.base.path().join("scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    // Held: not removable, and a confirmed cleanup cannot remove it either.
    let held = Holder::start(&env.data, &scratch, "hold");
    let id = format!("temp:{}", held.uuid());
    let inv = env.inventory();
    let it = item(&inv, &id).expect("listed");
    assert_eq!(
        (it["removable"].clone(), it["reason"].clone()),
        (json!(false), json!(R_LIVE))
    );
    let (code, msg) = err_of(&env.step1(&[&id]));
    assert_eq!(
        (code.as_str(), msg),
        ("VALIDATION_FAILED", msg_not_removable(&id, R_LIVE))
    );
    assert!(held.path.exists());
    drop(held);
    // Exited without cleaning up (crash): the lock died with it.
    let mut gone = Holder::start(&env.data, &scratch, "exit");
    gone.wait_exit();
    let id = format!("temp:{}", gone.uuid());
    assert!(gone.path.exists(), "a crash leaves the directory behind");
    let inv = env.inventory();
    assert_eq!(item(&inv, &id).unwrap()["removable"], true);
    let r = env.clean(&[&id]);
    assert_eq!(r["removed"], json!([id]));
    assert_eq!(r["skipped"], json!([]));
    assert!(!gone.path.exists());
    assert!(!env.tmp().join(format!("{}.live", gone.uuid())).exists());
}

#[test]
fn temp_entries_follow_the_lock_and_age_rules() {
    let mut env = Env::new();
    // Crashed with a lock file: removable at once.
    let crashed = crashed_temp(&env, true, true);
    // No lock file (a pre-A9 Core), fresh: not removable.
    let fresh_unlocked = crashed_temp(&env, false, true);
    // No lock file, older than 10 minutes and than this Core: removable.
    let old_unlocked = crashed_temp(&env, false, true);
    backdate(&env.tmp().join(&old_unlocked), 11 * 60);
    // Lock file only, fresh (between an owner's flock and mkdir): not.
    let fresh_lock_only = crashed_temp(&env, true, false);
    // Lock file only, older than 10 minutes: removable.
    let old_lock_only = crashed_temp(&env, true, false);
    backdate(&env.tmp().join(format!("{old_lock_only}.live")), 11 * 60);
    let inv = env.inventory();
    let check = |u: &str, removable: bool, reason: Option<&str>| {
        let it = item(&inv, &format!("temp:{u}")).unwrap_or_else(|| panic!("{u} missing"));
        assert_eq!(it["removable"], removable, "{it}");
        assert_eq!(it.get("reason").and_then(Value::as_str), reason, "{it}");
        assert!(
            it.get("bytes").is_none(),
            "temp sizes are not measured: {it}"
        );
    };
    check(&crashed, true, None);
    check(&fresh_unlocked, false, Some(R_UNLOCKED_RECENT));
    check(&old_unlocked, true, None);
    check(&fresh_lock_only, false, Some(R_RECENT_LOCK));
    check(&old_lock_only, true, None);
    let ids: Vec<String> = [&crashed, &old_unlocked, &old_lock_only]
        .iter()
        .map(|u| format!("temp:{u}"))
        .collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let r = env.clean(&refs);
    let mut removed: Vec<String> = serde_json::from_value(r["removed"].clone()).unwrap();
    removed.sort();
    let mut want = ids.clone();
    want.sort();
    assert_eq!(removed, want);
    assert!(r.get("freedBytes").is_none(), "temp sizes unknown: {r}");
    for u in [&crashed, &old_unlocked, &old_lock_only] {
        assert!(!env.tmp().join(u).exists());
        assert!(!env.tmp().join(format!("{u}.live")).exists());
    }
    assert!(env.tmp().join(&fresh_unlocked).exists());
    assert!(env.tmp().join(format!("{fresh_lock_only}.live")).exists());
}

#[test]
fn planted_entries_in_tmp_are_never_removable() {
    let mut env = Env::new();
    private_dir(&env.tmp());
    let outside = env.base.path().join("outside");
    private_dir(&outside);
    std::fs::write(outside.join("keep.txt"), b"precious\n").unwrap();
    // A symlink named like a temp dir.
    let sym = uuid4();
    std::os::unix::fs::symlink(&outside, env.tmp().join(&sym)).unwrap();
    // A plain file named like a temp dir.
    let file = uuid4();
    std::fs::write(env.tmp().join(&file), b"x").unwrap();
    // A non-UUID name, an uppercase UUID and a non-v4 UUID.
    private_dir(&env.tmp().join("notes"));
    private_dir(&env.tmp().join(uuid4().to_ascii_uppercase()));
    private_dir(&env.tmp().join("3f9a1c22-0000-1000-8000-abcdef012345"));
    // A FIFO named like a lock file, beside a real directory.
    let fifo = crashed_temp(&env, false, true);
    let fifo_path = env.tmp().join(format!("{fifo}.live"));
    let c = std::ffi::CString::new(fifo_path.as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: mkfifo with a valid C string inside this test's temp dir.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    // A symlinked lock file.
    let symlock = crashed_temp(&env, false, true);
    std::os::unix::fs::symlink(
        outside.join("keep.txt"),
        env.tmp().join(format!("{symlock}.live")),
    )
    .unwrap();
    let inv = env.inventory();
    assert_eq!(
        item(&inv, &format!("temp:{sym}")).unwrap()["reason"],
        R_NOT_DIR
    );
    assert_eq!(
        item(&inv, &format!("temp:{file}")).unwrap()["reason"],
        R_NOT_DIR
    );
    for u in [&fifo, &symlock] {
        let it = item(&inv, &format!("temp:{u}")).unwrap();
        assert_eq!(it["removable"], false, "{it}");
        assert_eq!(it["reason"], R_BAD_LOCK, "{it}");
    }
    let foreign: Vec<&Value> = inv["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["id"].as_str().unwrap().starts_with("foreign:"))
        .collect();
    assert_eq!(foreign.len(), 3, "{inv}");
    for f in &foreign {
        assert_eq!(f["kind"], "temp");
        assert_eq!(f["removable"], false);
        assert_eq!(f["reason"], R_FOREIGN);
    }
    assert!(foreign
        .iter()
        .any(|f| f["detail"].as_str().unwrap().contains("notes")));
    // None of them can be confirmed.
    for id in [
        format!("temp:{sym}"),
        format!("temp:{fifo}"),
        foreign[0]["id"].as_str().unwrap().to_string(),
    ] {
        let (code, _) = err_of(&env.step1(&[&id]));
        assert_eq!(code, "VALIDATION_FAILED");
    }
    assert!(outside.join("keep.txt").exists());
    assert_eq!(
        std::fs::read_to_string(outside.join("keep.txt")).unwrap(),
        "precious\n"
    );
}

#[test]
fn foreign_names_are_escaped_and_bounded_in_detail() {
    let mut env = Env::new();
    private_dir(&env.tmp());
    // NAME_MAX is 255 bytes and APFS refuses invalid UTF-8 names (EILSEQ);
    // the 512-byte bound and invalid UTF-8 are unit-tested in
    // `sandpane_core::maintenance`.
    let mut name = b"evil\x1b[2J\xe2\x80\xae".to_vec();
    name.extend_from_slice(&[b'x'; 240]);
    std::fs::write(env.tmp().join(std::ffi::OsStr::from_bytes(&name)), b"").unwrap();
    let inv = env.inventory();
    let d = inv["items"][0]["detail"].as_str().unwrap();
    assert!(d.len() <= 512, "{}", d.len());
    assert!(d.starts_with("tmp/evil\u{fffd}[2J\u{fffd}x"), "{d:?}");
    assert!(
        !d.chars().any(|c| c.is_control() || c == '\u{202e}'),
        "{d:?}"
    );
}

#[test]
fn the_cleaner_releases_the_lock_only_after_unlinking_it() {
    let mut env = Env::new();
    let u = crashed_temp(&env, true, true);
    let lock_path = env.tmp().join(format!("{u}.live"));
    let dir = env.tmp().join(&u);
    // A separate open file description on the same lock file.
    let mine = std::fs::File::open(&lock_path).unwrap();
    let id = format!("temp:{u}");
    let t = env.token(&[&id]);
    let checked = Arc::new(AtomicBool::new(false));
    let flag = checked.clone();
    let probe = mine.try_clone().unwrap();
    let (lp, dp) = (lock_path.clone(), dir.clone());
    env.after_unlink.set(move |p: &Path| {
        assert_eq!(p, lp.as_path());
        assert!(!lp.exists(), "unlinked before the hook");
        assert!(!dp.exists(), "directory removed under the lock");
        assert!(!try_flock(&probe), "the cleaner still holds the lock");
        flag.store(true, Ordering::SeqCst);
    });
    let r = env.step2(&[&id], &t);
    assert_eq!(r["ok"]["removed"], json!([id]), "{r}");
    assert!(checked.load(Ordering::SeqCst), "hook ran");
    assert!(try_flock(&mine), "released after the unlink");
}

// --- the token ---------------------------------------------------------------------------

#[test]
fn the_token_is_bound_to_the_exact_item_set() {
    let mut env = Env::new();
    let a = format!("temp:{}", crashed_temp(&env, true, true));
    let b = format!("temp:{}", crashed_temp(&env, true, true));
    let c = format!("temp:{}", crashed_temp(&env, true, true));
    let step1 = env.step1(&[&a, &b]);
    let conf = &step1["ok"]["confirmation"];
    assert_eq!(conf["action"], "maintenance.cleanup");
    assert_eq!(conf["external"], false);
    assert_eq!(conf["target"], json!({"items": [a, b]}));
    assert!(conf["impact"].as_array().unwrap().len() >= 2);
    // Subset, superset, duplicate: refused, and the token is burned.
    for set in [vec![a.as_str()], vec![&a, &b, &c], vec![&a, &b, &a]] {
        let t = env.token(&[&a, &b]);
        let (code, msg) = err_of(&env.step2(&set, &t));
        assert_eq!(code, "VALIDATION_FAILED", "{set:?}");
        assert!(msg == MSG_TOKEN || msg == MSG_DUPLICATE, "{msg}");
        let (_, msg) = err_of(&env.step2(&[&a, &b], &t));
        assert_eq!(msg, MSG_TOKEN, "burned by the failed attempt");
    }
    assert!(env.tmp().join(&a[5..]).exists() && env.tmp().join(&b[5..]).exists());
    // Reordered: same digest, accepted.
    let t = env.token(&[&a, &b]);
    let r = env.step2(&[&b, &a], &t);
    assert_eq!(r["ok"]["skipped"], json!([]), "{r}");
    // Replayed: refused, nothing more happens.
    let (_, msg) = err_of(&env.step2(&[&b, &a], &t));
    assert_eq!(msg, MSG_TOKEN);
    assert!(env.tmp().join(&c[5..]).exists());
}

#[test]
fn an_expired_token_is_refused_and_removes_nothing() {
    let mut env = Env::with(Opts {
        ttl: Some(Duration::ZERO),
        ..Opts::default()
    });
    let a = format!("temp:{}", crashed_temp(&env, true, true));
    let t = env.token(&[&a]);
    let (code, msg) = err_of(&env.step2(&[&a], &t));
    assert_eq!(
        (code.as_str(), msg.as_str()),
        ("VALIDATION_FAILED", MSG_TOKEN)
    );
    assert!(env.tmp().join(&a[5..]).exists());
}

#[test]
fn step_one_refuses_bad_sets_and_issues_nothing() {
    let mut env = Env::new();
    let a = format!("temp:{}", crashed_temp(&env, true, true));
    let cases: Vec<(Vec<String>, String)> = vec![
        (vec![], MSG_NO_ITEMS.into()),
        (vec![a.clone(), a.clone()], MSG_DUPLICATE.into()),
        (vec!["temp:../../etc".into()], MSG_BAD_ID.into()),
        (vec!["dbBackup:../core.sqlite3".into()], MSG_BAD_ID.into()),
        (vec!["nope".into()], MSG_BAD_ID.into()),
        (
            vec![format!("temp:{}", uuid4())],
            String::new(), // unknown, checked below
        ),
        (
            (0..501).map(|i| format!("foreign:{i}")).collect(),
            MSG_TOO_MANY.into(),
        ),
    ];
    for (items, want) in cases {
        let refs: Vec<&str> = items.iter().map(String::as_str).collect();
        let (code, msg) = err_of(&env.step1(&refs));
        assert_eq!(code, "VALIDATION_FAILED");
        if want.is_empty() {
            assert_eq!(msg, msg_unknown(&items[0]));
        } else {
            assert_eq!(msg, want);
        }
    }
    assert!(env.tmp().join(&a[5..]).exists());
}

#[test]
fn step_two_rechecks_every_item() {
    let mut env = Env::new();
    let became_live = crashed_temp(&env, true, true);
    let vanished = crashed_temp(&env, true, true);
    let changed = crashed_temp(&env, true, true);
    let fine = crashed_temp(&env, true, true);
    let ids: Vec<String> = [&became_live, &vanished, &changed, &fine]
        .iter()
        .map(|u| format!("temp:{u}"))
        .collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let t = env.token(&refs);
    // Between the steps: someone takes the lock, one disappears, one
    // changes identity (replaced by a new directory).
    let holder = std::fs::File::open(env.tmp().join(format!("{became_live}.live"))).unwrap();
    assert!(try_flock(&holder));
    std::fs::remove_dir_all(env.tmp().join(&vanished)).unwrap();
    std::fs::remove_file(env.tmp().join(format!("{vanished}.live"))).unwrap();
    std::fs::remove_dir_all(env.tmp().join(&changed)).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    private_dir(&env.tmp().join(&changed));
    let r = env.step2(&refs, &t);
    let ok = &r["ok"];
    assert_eq!(ok["removed"], json!([format!("temp:{fine}")]), "{r}");
    let skipped: Vec<(String, String)> = ok["skipped"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["id"].as_str().unwrap().to_string(),
                s["reason"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let reason = |u: &str| -> String {
        skipped
            .iter()
            .find(|(id, _)| id == &format!("temp:{u}"))
            .map(|(_, r)| r.clone())
            .unwrap_or_else(|| panic!("{u} not skipped: {r}"))
    };
    // Review I3: a held lock at step 2 may be another scan's probe.
    assert_eq!(reason(&became_live), R_LIVE_OR_PROBED);
    assert_eq!(reason(&vanished), SKIP_GONE);
    assert_eq!(reason(&changed), SKIP_CHANGED);
    assert_eq!(skipped.len(), 3);
    assert!(env.tmp().join(&became_live).exists());
    assert!(env.tmp().join(&changed).exists());
}

#[test]
fn a_tmp_root_swapped_for_a_symlink_between_the_steps_removes_nothing() {
    let mut env = Env::new();
    let u = crashed_temp(&env, true, true);
    let id = format!("temp:{u}");
    let t = env.token(&[&id]);
    let moved = env.data.join("tmp-moved");
    std::fs::rename(env.tmp(), &moved).unwrap();
    std::os::unix::fs::symlink(&moved, env.tmp()).unwrap();
    let r = env.step2(&[&id], &t);
    let ok = &r["ok"];
    assert_eq!(ok["removed"], json!([]), "{r}");
    let reason = ok["skipped"][0]["reason"].as_str().unwrap();
    assert!(reason.contains("safety check"), "{reason}");
    assert!(moved.join(&u).exists());
}

// --- dbBackup -------------------------------------------------------------------------------

fn write_mode(p: &Path, bytes: &[u8], mode: u32) {
    std::fs::write(p, bytes).unwrap();
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
fn db_backups_beside_a_database_in_the_data_directory() {
    let mut env = Env::with(Opts {
        db_in_data: true,
        ..Opts::default()
    });
    let dir = env.db_path.parent().unwrap().to_path_buf();
    write_mode(&dir.join("core.sqlite3.pre-v8.bak"), &[1u8; 300], 0o644);
    write_mode(&dir.join("core.sqlite3.pre-v9.bak"), &[2u8; 200], 0o600);
    write_mode(&dir.join("core.sqlite3.pre-v9.bak.1"), &[3u8; 100], 0o600);
    // Look-alikes are not listed at all.
    write_mode(&dir.join("core.sqlite3.pre-v9.bak.x"), b"x", 0o600);
    write_mode(&dir.join("core.sqlite3.pre-v09.bak"), b"x", 0o600);
    write_mode(&dir.join("other.sqlite3.pre-v9.bak"), b"x", 0o600);
    // A symlinked backup name.
    std::os::unix::fs::symlink(
        dir.join("core.sqlite3.pre-v8.bak"),
        dir.join("core.sqlite3.pre-v7.bak"),
    )
    .unwrap();
    let inv = env.inventory();
    let backups: Vec<String> = ids(&inv)
        .into_iter()
        .filter(|i| i.starts_with("dbBackup:"))
        .collect();
    assert_eq!(
        backups,
        [
            "dbBackup:core.sqlite3.pre-v7.bak",
            "dbBackup:core.sqlite3.pre-v8.bak",
            "dbBackup:core.sqlite3.pre-v9.bak",
            "dbBackup:core.sqlite3.pre-v9.bak.1"
        ]
    );
    let v8 = item(&inv, "dbBackup:core.sqlite3.pre-v8.bak").unwrap();
    assert_eq!(
        (v8["kind"].clone(), v8["removable"].clone()),
        (json!("dbBackup"), json!(true))
    );
    assert_eq!(v8["bytes"], 300);
    assert!(
        v8["detail"].as_str().unwrap().contains("0644"),
        "a mode wider than 0600 is reported: {v8}"
    );
    let v9 = item(&inv, "dbBackup:core.sqlite3.pre-v9.bak").unwrap();
    assert_eq!(v9["removable"], true);
    assert!(!v9["detail"].as_str().unwrap().contains("0600"));
    let newest = item(&inv, "dbBackup:core.sqlite3.pre-v9.bak.1").unwrap();
    assert_eq!(
        (newest["removable"].clone(), newest["reason"].clone()),
        (json!(false), json!(R_DB_NEWEST))
    );
    let sym = item(&inv, "dbBackup:core.sqlite3.pre-v7.bak").unwrap();
    assert_eq!(
        (sym["removable"].clone(), sym["reason"].clone()),
        (json!(false), json!(R_DB_NOT_FILE))
    );
    // Step 1 lists each backup's impact on its own line.
    let s1 = env.step1(&[
        "dbBackup:core.sqlite3.pre-v8.bak",
        "dbBackup:core.sqlite3.pre-v9.bak",
    ]);
    let impact = s1["ok"]["confirmation"]["impact"]
        .as_array()
        .unwrap()
        .clone();
    assert!(impact.iter().any(|l| l
        .as_str()
        .unwrap()
        .contains("a full copy of your projects, conversations and messages as they were at schema v7, before Core migrated to v8")));
    assert!(impact.iter().any(|l| l
        .as_str()
        .unwrap()
        .contains("at schema v8, before Core migrated to v9")));
    let r = env.clean(&[
        "dbBackup:core.sqlite3.pre-v8.bak",
        "dbBackup:core.sqlite3.pre-v9.bak",
    ]);
    assert_eq!(r["skipped"], json!([]), "{r}");
    assert_eq!(r["freedBytes"], 500);
    assert!(!dir.join("core.sqlite3.pre-v8.bak").exists());
    assert!(!dir.join("core.sqlite3.pre-v9.bak").exists());
    assert!(dir.join("core.sqlite3.pre-v9.bak.1").exists());
    assert!(dir.join("core.sqlite3.pre-v9.bak.x").exists());
    assert!(dir.join("core.sqlite3").exists());
}

#[test]
fn db_backups_beside_a_database_outside_the_data_directory_are_not_removable() {
    let mut env = Env::new();
    let dir = env.db_path.parent().unwrap().to_path_buf();
    assert_ne!(dir, env.data);
    write_mode(&dir.join("core.sqlite3.pre-v8.bak"), b"old", 0o600);
    let inv = env.inventory();
    let it = item(&inv, "dbBackup:core.sqlite3.pre-v8.bak").unwrap();
    assert_eq!(
        (it["removable"].clone(), it["reason"].clone()),
        (json!(false), json!(R_DB_OUTSIDE))
    );
    let (code, _) = err_of(&env.step1(&["dbBackup:core.sqlite3.pre-v8.bak"]));
    assert_eq!(code, "VALIDATION_FAILED");
    assert!(dir.join("core.sqlite3.pre-v8.bak").exists());
}

#[test]
fn a_backup_that_changed_between_the_steps_is_skipped() {
    let mut env = Env::with(Opts {
        db_in_data: true,
        ..Opts::default()
    });
    let dir = env.db_path.parent().unwrap().to_path_buf();
    let p = dir.join("core.sqlite3.pre-v8.bak");
    write_mode(&p, b"old", 0o600);
    write_mode(&dir.join("core.sqlite3.pre-v9.bak"), b"newest", 0o600);
    let id = "dbBackup:core.sqlite3.pre-v8.bak";
    let t = env.token(&[id]);
    std::fs::remove_file(&p).unwrap();
    write_mode(&p, b"replaced with something else", 0o600);
    let r = env.step2(&[id], &t);
    assert_eq!(
        r["ok"]["skipped"],
        json!([{"id": id, "reason": SKIP_CHANGED}]),
        "{r}"
    );
    assert!(r["ok"].get("freedBytes").is_none() || r["ok"]["freedBytes"] == 0);
    assert!(p.exists());
}

// --- verificationOutput ----------------------------------------------------------------------

const DAY: u64 = 86_400;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn seed_project(env: &Env) {
    env.sql(
        "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
         INSERT INTO conversations (id,project_id,title,agent_id,created_at)
             VALUES ('c1','p1','Chat','codex','t');
         INSERT INTO tasks (id,conversation_id,status,created_at,updated_at,mode)
             VALUES ('t1','c1','completed','t','t','task');
         INSERT INTO verification_commands (id,project_id,label,argv_json,approved_at)
             VALUES ('vc1','p1','tests','[\"make\",\"test\"]','t');",
    );
}

fn seed_run(env: &Env, id: &str, status: &str, finished_secs_ago: Option<u64>, pruned: bool) {
    let finished = finished_secs_ago.map(|a| rfc3339_from_unix(now_secs() - a));
    env.inner
        .lock_db()
        .conn()
        .execute(
            "INSERT INTO verification_runs (id,task_id,command_id,sandbox_name,workspace_mode,
                 argv_json,label,status,outcome,stdout,stderr,started_sequence,started_at,
                 finished_at,output_pruned)
             VALUES (?1,'t1','vc1','atlas-auth','mountless','[\"make\"]','tests',?2,'exited',
                 ?3,?4,1,'2026-01-01T00:00:00Z',?5,?6)",
            rusqlite::params![
                id,
                status,
                if pruned { "" } else { "ééé" },
                if pruned { "" } else { "bb" },
                finished,
                pruned
            ],
        )
        .unwrap();
}

fn run_output(env: &Env, id: &str) -> (String, String, i64) {
    env.inner
        .lock_db()
        .conn()
        .query_row(
            "SELECT stdout, stderr, output_pruned FROM verification_runs WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
}

fn vo_item(inv: &Value) -> Value {
    inv["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["kind"] == "verificationOutput")
        .cloned()
        .unwrap_or_else(|| panic!("no verificationOutput item: {inv}"))
}

#[test]
fn old_verification_output_is_pruned_and_the_record_kept() {
    let mut env = Env::with(Opts {
        limits: Some(MaintenanceLimits {
            prune_batch: 2,
            ..MaintenanceLimits::default()
        }),
        ..Opts::default()
    });
    seed_project(&env);
    for id in ["old1", "old2", "old3"] {
        seed_run(&env, id, "finished", Some(40 * DAY), false);
    }
    seed_run(&env, "old-int", "interrupted", Some(40 * DAY), false);
    seed_run(&env, "recent", "finished", Some(DAY), false);
    seed_run(&env, "running", "running", None, false);
    seed_run(&env, "done-already", "finished", Some(50 * DAY), true);
    let inv = env.inventory();
    let vo = vo_item(&inv);
    assert_eq!(vo["removable"], true);
    // 4 qualifying runs × ("ééé" = 6 bytes + "bb" = 2 bytes).
    assert_eq!(vo["bytes"], 32, "byte length, not characters: {vo}");
    assert!(
        vo["detail"]
            .as_str()
            .unwrap()
            .contains("4 verification runs"),
        "{vo}"
    );
    let id = vo["id"].as_str().unwrap().to_string();
    let cutoff = id.strip_prefix("verificationOutput:").unwrap();
    let cutoff_secs = sandpane_core::maintenance::parse_cutoff(cutoff).unwrap();
    assert!(cutoff_secs <= now_secs() - 30 * DAY);
    // A client cutoff 60 s older than the fresh one is accepted.
    let older = format!("verificationOutput:{}", rfc3339_from_unix(cutoff_secs - 60));
    let t = env.token(&[&older]);
    // A run that finishes after the cutoff between the steps is untouched.
    seed_run(&env, "late", "finished", Some(29 * DAY), false);
    let r = env.step2(&[&older], &t);
    let ok = &r["ok"];
    assert_eq!(ok["removed"], json!([older]), "{r}");
    assert_eq!(ok["skipped"], json!([]));
    assert_eq!(ok["freedBytes"], 0, "never counts verificationOutput");
    assert!(ok["notes"].as_array().unwrap().iter().any(|n| n == NOTE_VO));
    // Review I2: the WAL was checkpointed (TRUNCATE) after the prune.
    let wal = PathBuf::from(format!("{}-wal", env.db_path.display()));
    assert_eq!(
        std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0),
        0,
        "WAL truncated"
    );
    for id in ["old1", "old2", "old3", "old-int"] {
        assert_eq!(
            run_output(&env, id),
            (String::new(), String::new(), 1),
            "{id}"
        );
    }
    for id in ["recent", "running", "late"] {
        assert_eq!(run_output(&env, id).2, 0, "{id}");
        assert_eq!(run_output(&env, id).0, "ééé");
    }
    // verification.result discloses it; the record is kept.
    let res = env.rpc("verification.result", json!({"runId": "old1"}));
    assert_eq!(res["ok"]["outputPruned"], true, "{res}");
    assert_eq!(res["ok"]["stdout"], "");
    assert_eq!(res["ok"]["outcome"], "exited");
    let res = env.rpc("verification.result", json!({"runId": "recent"}));
    assert!(res["ok"].get("outputPruned").is_none(), "{res}");
    // Nothing left to prune: no verificationOutput item any more.
    let inv = env.inventory();
    assert!(!inv["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["kind"] == "verificationOutput"));
}

#[test]
fn the_cutoff_grammar_and_retention_are_enforced_at_both_steps() {
    let mut env = Env::new();
    seed_project(&env);
    seed_run(&env, "old1", "finished", Some(40 * DAY), false);
    let now = now_secs();
    for bad in [
        "verificationOutput:2026-09-12T08:30:00+00:00",
        "verificationOutput:2026-09-12T08:30:00.000Z",
        "verificationOutput:2026-02-30T00:00:00Z",
        "verificationOutput:",
    ] {
        let (code, msg) = err_of(&env.step1(&[bad]));
        assert_eq!(
            (code.as_str(), msg.as_str()),
            ("VALIDATION_FAILED", MSG_BAD_ID),
            "{bad}"
        );
    }
    // Later than now − retention: refused, even by one hour.
    for late in [now, now - 30 * DAY + 3600] {
        let id = format!("verificationOutput:{}", rfc3339_from_unix(late));
        let (code, msg) = err_of(&env.step1(&[&id]));
        assert_eq!(
            (code.as_str(), msg.as_str()),
            ("VALIDATION_FAILED", MSG_CUTOFF_TOO_LATE)
        );
    }
    // Step 2 refuses a non-canonical cutoff too (and the token is burned).
    let good = format!("verificationOutput:{}", rfc3339_from_unix(now - 31 * DAY));
    let t = env.token(&[&good]);
    let (code, _) = err_of(&env.step2(&["verificationOutput:2026-02-30T00:00:00Z"], &t));
    assert_eq!(code, "VALIDATION_FAILED");
    let late = format!("verificationOutput:{}", rfc3339_from_unix(now));
    let t = env.token(&[&good]);
    let (code, _) = err_of(&env.step2(&[&late], &t));
    assert_eq!(code, "VALIDATION_FAILED");
    assert_eq!(run_output(&env, "old1").2, 0, "nothing pruned");
}

// --- worktree ---------------------------------------------------------------------------------

#[test]
fn worktrees_are_report_only_and_orphans_are_labelled() {
    let mut env = Env::new();
    let root = env.data.join("worktrees");
    private_dir(&root);
    env.sql(
        "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
         INSERT INTO repositories (id,project_id,canonical_path) VALUES ('r1','p1','/repo/atlas');
         INSERT INTO conversations (id,project_id,title,agent_id,created_at)
             VALUES ('c1','p1','Chat','codex','t');",
    );
    let done = "4c1e0a52-1111-4000-8000-000000000001";
    let live = "4c1e0a52-1111-4000-8000-000000000002";
    for (task, status) in [(done, "completed"), (live, "running")] {
        let wt = root.join(task);
        private_dir(&wt);
        env.inner
            .lock_db()
            .conn()
            .execute(
                "INSERT INTO tasks (id,conversation_id,status,created_at,updated_at,repo_id,
                     worktree_path)
                 VALUES (?1,'c1',?2,'t','t','r1',?3)",
                rusqlite::params![task, status, wt.display().to_string()],
            )
            .unwrap();
    }
    // An old orphan whose agent-writable `.git` is a FIFO: never read.
    let orphan = root.join("left-behind");
    private_dir(&orphan);
    let c = std::ffi::CString::new(orphan.join(".git").as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: mkfifo with a valid C string inside this test's temp dir.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    backdate(&orphan, 11 * 60);
    // A young orphan (being allocated): skipped.
    private_dir(&root.join("just-allocated"));
    let inv = env.inventory();
    let tracked = item(&inv, &format!("worktree:{done}")).expect("tracked worktree listed");
    assert_eq!(tracked["kind"], "worktree");
    assert_eq!(tracked["removable"], false);
    assert_eq!(tracked["reason"], R_WORKTREE);
    assert_eq!(tracked["repositoryPath"], "/repo/atlas");
    assert_eq!(tracked["path"], root.join(done).display().to_string());
    assert!(tracked.get("bytes").is_none(), "no worktree size walk");
    assert!(
        item(&inv, &format!("worktree:{live}")).is_none(),
        "live task not listed"
    );
    let orphans: Vec<&Value> = inv["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == "worktree" && i["id"].as_str().unwrap().starts_with("foreign:"))
        .collect();
    assert_eq!(orphans.len(), 1, "{inv}");
    assert_eq!(orphans[0]["detail"], D_ORPHAN);
    assert_eq!(orphans[0]["path"], orphan.display().to_string());
    assert_eq!(orphans[0]["removable"], false);
    let (code, _) = err_of(&env.step1(&[&format!("worktree:{done}")]));
    assert_eq!(code, "VALIDATION_FAILED");
    assert!(root.join(done).exists() && orphan.exists());
}

// --- ordering, bounds, single flight -----------------------------------------------------------

#[test]
fn inventory_order_is_deterministic_and_bounded() {
    let mut env = Env::with(Opts {
        limits: Some(MaintenanceLimits {
            max_items: 3,
            ..MaintenanceLimits::default()
        }),
        ..Opts::default()
    });
    for _ in 0..5 {
        crashed_temp(&env, true, true);
    }
    let a = env.inventory();
    let b = env.inventory();
    assert_eq!(a, b, "stable between scans");
    assert_eq!(a["items"].as_array().unwrap().len(), 3);
    assert_eq!(a["truncated"], true);
    let got = ids(&a);
    let mut sorted = got.clone();
    sorted.sort();
    assert_eq!(got, sorted, "(kind, id) order");
}

/// §3.9 item 1: the answer stays below the frame backstop. Items whose
/// display paths are long could exceed it well before 2 000 items, so the
/// answer is MEASURED and cut from the tail (`truncated: true`).
#[test]
fn the_answer_is_cut_to_the_response_size_limit() {
    let mut env = Env::with(Opts {
        limits: Some(MaintenanceLimits {
            max_response_bytes: 700,
            ..MaintenanceLimits::default()
        }),
        ..Opts::default()
    });
    for _ in 0..6 {
        crashed_temp(&env, true, true);
    }
    let inv = env.inventory();
    let n = inv["items"].as_array().unwrap().len();
    assert!((1..6).contains(&n), "{n} items: {inv}");
    assert_eq!(inv["truncated"], true);
    assert!(inv.to_string().len() <= 700, "{}", inv.to_string().len());
    // A cut list is still the deterministic (kind, id) prefix.
    let got = ids(&inv);
    let mut sorted = got.clone();
    sorted.sort();
    assert_eq!(got, sorted);
}

#[test]
fn a_directory_with_too_many_entries_is_truncated() {
    let mut env = Env::with(Opts {
        limits: Some(MaintenanceLimits {
            max_dir_entries: 2,
            ..MaintenanceLimits::default()
        }),
        ..Opts::default()
    });
    for _ in 0..4 {
        crashed_temp(&env, false, true);
    }
    let inv = env.inventory();
    assert_eq!(inv["truncated"], true);
    assert!(inv["items"].as_array().unwrap().len() <= 2, "{inv}");
}

#[test]
fn past_the_time_budget_items_are_listed_without_sizes() {
    let mut env = Env::with(Opts {
        db_in_data: true,
        limits: Some(MaintenanceLimits {
            budget: Duration::ZERO,
            ..MaintenanceLimits::default()
        }),
        ..Opts::default()
    });
    let dir = env.db_path.parent().unwrap().to_path_buf();
    write_mode(&dir.join("core.sqlite3.pre-v8.bak"), b"old", 0o600);
    write_mode(&dir.join("core.sqlite3.pre-v9.bak"), b"new", 0o600);
    seed_project(&env);
    seed_run(&env, "old1", "finished", Some(40 * DAY), false);
    let inv = env.inventory();
    let b = item(&inv, "dbBackup:core.sqlite3.pre-v8.bak").unwrap();
    assert!(b.get("bytes").is_none(), "{b}");
    assert_eq!(b["removable"], true);
    let vo = vo_item(&inv);
    assert!(vo.get("bytes").is_none(), "{vo}");
}

#[test]
fn a_second_inventory_or_cleanup_in_flight_is_a_conflict() {
    let mut env = Env::new();
    let a = format!("temp:{}", crashed_temp(&env, true, true));
    // During an inventory: a second inventory is refused.
    let seen: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let a1 = a.clone();
    env.in_flight.set(move |inner: &ServerInner| {
        let mut v = s.lock().unwrap();
        v.push(rpc_on(inner, "nested", "maintenance.inventory", json!({})));
        // Review I3: a running inventory also excludes a cleanup.
        v.push(rpc_on(
            inner,
            "nested",
            "maintenance.cleanup",
            json!({"items": [a1]}),
        ));
    });
    env.inventory();
    let nested_cleanup = seen.lock().unwrap().pop().expect("hook ran");
    assert_eq!(
        err_of(&nested_cleanup),
        ("CONFLICT".into(), MSG_CLEANUP_SCAN_BUSY.into())
    );
    let nested = seen.lock().unwrap().pop().expect("hook ran");
    assert_eq!(err_of(&nested), ("CONFLICT".into(), MSG_SCAN_BUSY.into()));
    // During a cleanup: a second cleanup (either step) is refused.
    let t = env.token(&[&a]);
    let s = seen.clone();
    let a2 = a.clone();
    env.in_flight.set(move |inner: &ServerInner| {
        let mut v = s.lock().unwrap();
        v.push(rpc_on(
            inner,
            "nested",
            "maintenance.cleanup",
            json!({"items": [a2]}),
        ));
        // Review I3: a running cleanup also excludes an inventory.
        v.push(rpc_on(inner, "nested", "maintenance.inventory", json!({})));
    });
    let r = env.step2(&[&a], &t);
    assert_eq!(r["ok"]["removed"], json!([a]), "{r}");
    let nested_inv = seen.lock().unwrap().pop().expect("hook ran");
    assert_eq!(
        err_of(&nested_inv),
        ("CONFLICT".into(), MSG_SCAN_BUSY.into())
    );
    let nested = seen.lock().unwrap().pop().expect("hook ran");
    assert_eq!(
        err_of(&nested),
        ("CONFLICT".into(), MSG_CLEANUP_BUSY.into())
    );
    // Both flags are released afterwards.
    env.inventory();
    let (code, _) = err_of(&env.step1(&[&a]));
    assert_eq!(code, "VALIDATION_FAILED", "unknown now, not CONFLICT");
}

// --- Review fixes (A9 Core security review) --------------------------------------

/// W1: a backup from a NEWER schema (pre-v10) does not unprotect the newest
/// pre-v9 backup: both are protected.
#[test]
fn w1_a_newer_schema_backup_does_not_unprotect_the_current_one() {
    let mut env = Env::with(Opts {
        db_in_data: true,
        ..Opts::default()
    });
    let dir = env.db_path.parent().unwrap().to_path_buf();
    for n in [8, 9, 10] {
        write_mode(&dir.join(format!("core.sqlite3.pre-v{n}.bak")), b"x", 0o600);
    }
    let inv = env.inventory();
    let verdict = |n: u32| {
        let it = item(&inv, &format!("dbBackup:core.sqlite3.pre-v{n}.bak")).unwrap();
        (it["removable"].clone(), it["reason"].clone())
    };
    let kept = (json!(false), json!(R_DB_NEWEST));
    assert_eq!(verdict(9), kept, "N == LATEST stays protected");
    assert_eq!(verdict(10), kept, "the overall newest too");
    assert_eq!(verdict(8).0, json!(true));
}

/// W1: within one N recency decides, not `k` (db.rs reuses the first free
/// slot): a re-created `.bak` newer than `.bak.1` is the protected one.
#[test]
fn w1_within_one_schema_the_most_recent_backup_is_protected_not_the_highest_k() {
    let mut env = Env::with(Opts {
        db_in_data: true,
        ..Opts::default()
    });
    let dir = env.db_path.parent().unwrap().to_path_buf();
    let older = dir.join("core.sqlite3.pre-v9.bak.1");
    write_mode(&older, b"older", 0o600);
    backdate(&older, 3600);
    std::thread::sleep(Duration::from_millis(20));
    write_mode(&dir.join("core.sqlite3.pre-v9.bak"), b"recreated", 0o600);
    let inv = env.inventory();
    let bak = item(&inv, "dbBackup:core.sqlite3.pre-v9.bak").unwrap();
    assert_eq!(
        (bak["removable"].clone(), bak["reason"].clone()),
        (json!(false), json!(R_DB_NEWEST))
    );
    assert_eq!(
        item(&inv, "dbBackup:core.sqlite3.pre-v9.bak.1").unwrap()["removable"],
        true
    );
}

fn dir_removed_note(ok: &Value) -> String {
    ok["notes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|n| n.as_str())
        .find(|n| n.contains("directory removed"))
        .map(str::to_string)
        .unwrap_or_else(|| panic!("no directory-removed note: {ok}"))
}

/// W2: the directory is gone but the lock file was replaced before its
/// re-check: the item is REMOVED, with a note -- never reported untouched.
#[test]
fn w2_directory_removed_but_lock_file_changed_is_reported_removed_with_a_note() {
    let mut env = Env::new();
    let u = crashed_temp(&env, true, true);
    let id = format!("temp:{u}");
    let t = env.token(&[&id]);
    env.after_dir_removed.set(|lock: &Path| {
        std::fs::remove_file(lock).unwrap();
        std::fs::write(lock, b"someone else's").unwrap();
    });
    let r = env.step2(&[&id], &t);
    let ok = &r["ok"];
    assert_eq!(ok["removed"], json!([id]), "{r}");
    assert_eq!(ok["skipped"], json!([]));
    assert_eq!(
        dir_removed_note(ok),
        format!(
            "{id}: directory removed; its lock file changed or could not be removed — scan again"
        )
    );
    assert!(!env.tmp().join(&u).exists());
    assert_eq!(
        std::fs::read(env.tmp().join(format!("{u}.live"))).unwrap(),
        b"someone else's",
        "a replaced lock file is never unlinked"
    );
}

/// W2: the directory is gone but unlinking the lock file fails: REMOVED,
/// with the same note.
#[test]
fn w2_directory_removed_but_unlink_failed_is_reported_removed_with_a_note() {
    let mut env = Env::new();
    let u = crashed_temp(&env, true, true);
    let id = format!("temp:{u}");
    let t = env.token(&[&id]);
    let tmp = env.tmp();
    env.after_dir_removed.set(move |_: &Path| {
        // tmp/ read-only: unlinkat fails with EACCES.
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o500)).unwrap();
    });
    let r = env.step2(&[&id], &t);
    std::fs::set_permissions(env.tmp(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let ok = &r["ok"];
    assert_eq!(ok["removed"], json!([id]), "{r}");
    assert_eq!(
        dir_removed_note(ok),
        format!(
            "{id}: directory removed; its lock file changed or could not be removed — scan again"
        )
    );
    assert!(!env.tmp().join(&u).exists());
    assert!(env.tmp().join(format!("{u}.live")).exists());
}

/// W2: `remove_dir_all` failing partway is "partially removed", never a
/// plain skip that implies nothing changed.
#[test]
fn w2_a_failed_directory_removal_is_reported_as_partially_removed() {
    let mut env = Env::new();
    let u = crashed_temp(&env, true, true);
    let sub = env.tmp().join(&u).join("locked");
    private_dir(&sub);
    std::fs::write(sub.join("keep"), b"x").unwrap();
    std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o500)).unwrap();
    let id = format!("temp:{u}");
    let t = env.token(&[&id]);
    let r = env.step2(&[&id], &t);
    std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ok = &r["ok"];
    assert_eq!(ok["removed"], json!([]), "{r}");
    assert_eq!(ok["skipped"][0]["id"], json!(id));
    let reason = ok["skipped"][0]["reason"].as_str().unwrap();
    assert!(
        reason.starts_with("partially removed (") && reason.ends_with(") — scan again"),
        "{reason}"
    );
    assert!(env.tmp().join(format!("{u}.live")).exists(), "lock kept");
}

/// I1: a data directory failing its owner / 0700 check makes every backup
/// non-removable, and step 2 re-checks it before removing.
#[test]
fn i1_an_unsafe_data_directory_blocks_backup_removal_at_both_steps() {
    let mut env = Env::with(Opts {
        db_in_data: true,
        ..Opts::default()
    });
    let dir = env.db_path.parent().unwrap().to_path_buf();
    let old = dir.join("core.sqlite3.pre-v8.bak");
    write_mode(&old, b"old", 0o600);
    write_mode(&dir.join("core.sqlite3.pre-v9.bak"), b"new", 0o600);
    let id = "dbBackup:core.sqlite3.pre-v8.bak";
    let t = env.token(&[id]);
    std::fs::set_permissions(&env.data, std::fs::Permissions::from_mode(0o755)).unwrap();
    let inv = env.inventory();
    let r = env.step2(&[id], &t);
    std::fs::set_permissions(&env.data, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(item(&inv, id).unwrap()["removable"], false, "step 1 view");
    assert_eq!(r["ok"]["removed"], json!([]), "{r}");
    assert_eq!(r["ok"]["skipped"][0]["id"], json!(id));
    assert!(old.exists());
}
