//! A9 (design 2026-10-09 §3.9 item 8): `maintenance.inventory` and both
//! steps of `maintenance.cleanup` spawn NO process — no git, no sbx.
//!
//! Its own test binary with exactly ONE test, so nothing else in this
//! process can move `sandpane_core::process::spawn_attempts()` (the
//! process-wide counter of every spawn attempt through Core's runners, the
//! only production spawn paths). The baseline is taken after the Core and
//! every fixture exist; every item kind is present so each scanner runs.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, SystemTime};

use sandpane_core::process::spawn_attempts;
use sandpane_core::sbx::SbxLocator;
use sandpane_core::Database;
use sandpane_protocol::PROTOCOL_VERSION;
use sandpane_service::{handle_line, rfc3339_from_unix, CoreConfig, ServerInner};
use serde_json::{json, Value};

fn private_dir(p: &std::path::Path) {
    std::fs::create_dir_all(p).unwrap();
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn rpc(inner: &ServerInner, method: &str, params: Value) -> Value {
    let frame = json!({"v": PROTOCOL_VERSION, "id": "1", "method": method, "params": params});
    serde_json::from_str(&handle_line(inner, &frame.to_string())).unwrap()
}

#[test]
fn inventory_and_cleanup_spawn_no_process() {
    let base = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(base.path()).unwrap();
    let data = base.join("data");
    private_dir(&data);
    let db_path = data.join("core.sqlite3");
    let inner = ServerInner::with_config(
        Database::open(&db_path).unwrap(),
        // An sbx that WOULD be found if anything tried to run it.
        SbxLocator::with_search(None, vec![base.join("bin")]),
        CoreConfig {
            worktrees_root: Some(data.join("worktrees")),
            ..CoreConfig::default()
        },
    );
    private_dir(&base.join("bin"));
    std::fs::write(base.join("bin").join("sbx"), "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(
        base.join("bin").join("sbx"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    // temp: a crashed entry (removable) and a foreign name.
    let tmp = data.join("tmp");
    private_dir(&tmp);
    let u = uuid::Uuid::new_v4().to_string();
    private_dir(&tmp.join(&u));
    std::fs::write(tmp.join(format!("{u}.live")), b"").unwrap();
    private_dir(&tmp.join("notes"));
    // dbBackup: one removable, one newest.
    std::fs::write(data.join("core.sqlite3.pre-v8.bak"), b"old").unwrap();
    std::fs::write(data.join("core.sqlite3.pre-v9.bak"), b"new").unwrap();
    // worktree: a tracked finished task and an old orphan, in a registered
    // repository (so a careless implementation would reach for git).
    let root = data.join("worktrees");
    private_dir(&root);
    private_dir(&root.join("t1"));
    private_dir(&root.join("orphan"));
    std::fs::File::open(root.join("orphan"))
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
    let finished = rfc3339_from_unix(
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 40 * 86_400,
    );
    {
        let db = inner.lock_db();
        db.conn()
            .execute_batch(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Atlas Demo','t');
                 INSERT INTO conversations (id,project_id,title,agent_id,created_at)
                     VALUES ('c1','p1','Chat','codex','t');
                 INSERT INTO verification_commands (id,project_id,label,argv_json,approved_at)
                     VALUES ('vc1','p1','tests','[\"make\"]','t');",
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO repositories (id,project_id,canonical_path) VALUES ('r1','p1',?1)",
                [base.display().to_string()],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO tasks (id,conversation_id,status,created_at,updated_at,repo_id,
                     worktree_path) VALUES ('t1','c1','completed','t','t','r1',?1)",
                [root.join("t1").display().to_string()],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO verification_runs (id,task_id,command_id,sandbox_name,
                     workspace_mode,argv_json,label,status,outcome,stdout,stderr,
                     started_sequence,started_at,finished_at)
                 VALUES ('r1','t1','vc1','atlas-auth','mountless','[]','tests','finished',
                     'exited','o','e',1,'t',?1)",
                [finished],
            )
            .unwrap();
    }

    let before = spawn_attempts();
    let inv = rpc(&inner, "maintenance.inventory", json!({}));
    let items: Vec<String> = inv["ok"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["removable"] == true)
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect();
    let kinds: Vec<&str> = inv["ok"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["kind"].as_str().unwrap())
        .collect();
    for k in ["temp", "dbBackup", "verificationOutput", "worktree"] {
        assert!(kinds.contains(&k), "{k} missing: {inv}");
    }
    assert_eq!(items.len(), 3, "{inv}");
    let step1 = rpc(&inner, "maintenance.cleanup", json!({ "items": items }));
    let token = step1["ok"]["confirmation"]["token"]
        .as_str()
        .unwrap_or_else(|| panic!("{step1}"))
        .to_string();
    let step2 = rpc(
        &inner,
        "maintenance.cleanup",
        json!({ "items": items, "confirmToken": token }),
    );
    assert_eq!(step2["ok"]["skipped"], json!([]), "{step2}");
    assert_eq!(
        spawn_attempts(),
        before,
        "inventory and cleanup must spawn no process"
    );
}
