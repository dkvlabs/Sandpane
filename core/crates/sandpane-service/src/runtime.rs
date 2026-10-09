//! Daemon runtime policy: data/socket/DB paths, private-directory checks,
//! single-instance lock, stale-socket handling, peer credentials and
//! connection limits (docs/specs/02 §1-§2, docs/specs/06 §4).
//!
//! Kept pure or temp-dir-testable; `main.rs` only wires these together.

use std::ffi::OsString;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Environment inputs for path resolution (pure, so every OS branch is
/// testable on any host).
#[derive(Debug, Clone, Default)]
pub struct PathEnv {
    pub macos: bool,
    pub home: Option<OsString>,
    pub xdg_state_home: Option<OsString>,
    pub socket_override: Option<OsString>,
    pub db_override: Option<OsString>,
}

impl PathEnv {
    pub fn from_process() -> Self {
        Self {
            macos: cfg!(target_os = "macos"),
            home: std::env::var_os("HOME"),
            xdg_state_home: std::env::var_os("XDG_STATE_HOME"),
            socket_override: std::env::var_os("SANDPANE_SOCKET"),
            db_override: std::env::var_os("SANDPANE_DB"),
        }
    }
}

/// Trimmed, non-blank value (mirrors `paths.ts`: blank means unset). Non-UTF-8
/// values are kept verbatim (they cannot be "blank").
fn non_blank(v: &Option<OsString>) -> Option<PathBuf> {
    let v = v.as_ref()?;
    match v.to_str() {
        Some(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| PathBuf::from(t))
        }
        None => Some(PathBuf::from(v)),
    }
}

/// `$HOME`, else `/tmp` (same fallback as `paths.ts`).
pub fn home_for(env: &PathEnv) -> PathBuf {
    match &env.home {
        Some(h) if !h.is_empty() => PathBuf::from(h),
        _ => PathBuf::from("/tmp"),
    }
}

/// Security W5: MUST match `clients/vscode/src/core-client/paths.ts`
/// `coreDataDir` and JetBrains `ConnectionManager`:
/// macOS → `~/Library/Application Support/sandpane`;
/// otherwise `$XDG_STATE_HOME` (trimmed, blank = unset; else `~/.local/state`)
/// + `/sandpane`. The `sandpane` leaf is Sandpane's own directory — the only
///   one Core ever creates as private or chmods.
pub fn data_dir_for(env: &PathEnv) -> PathBuf {
    let home = home_for(env);
    if env.macos {
        return home.join("Library/Application Support/sandpane");
    }
    let base = non_blank(&env.xdg_state_home).unwrap_or_else(|| home.join(".local/state"));
    base.join("sandpane")
}

/// Socket path and whether it came from `SANDPANE_SOCKET`.
pub fn socket_path_for(env: &PathEnv) -> (PathBuf, bool) {
    match non_blank(&env.socket_override) {
        Some(p) => (p, true),
        None => (data_dir_for(env).join("sandpane.sock"), false),
    }
}

pub fn db_path_for(env: &PathEnv) -> PathBuf {
    non_blank(&env.db_override).unwrap_or_else(|| data_dir_for(env).join("sandpane.sqlite3"))
}

pub fn home_dir() -> PathBuf {
    home_for(&PathEnv::from_process())
}

/// Effective user id of this process.
#[cfg(unix)]
pub fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

#[derive(Debug)]
pub enum StartupError {
    /// Another live Core instance owns this socket/lock.
    AlreadyRunning(PathBuf),
    /// Refusing to serve (unsafe permissions, wrong owner, non-socket file…).
    Refused(String),
}

impl std::fmt::Display for StartupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning(p) => write!(
                f,
                "another Core instance owns {} — attach to it instead",
                p.display()
            ),
            Self::Refused(m) => f.write_str(m),
        }
    }
}

/// Holds the single-instance lock for the daemon's lifetime.
#[derive(Debug)]
pub struct RuntimeGuard {
    _lock: File,
    pub lock_path: PathBuf,
}

#[cfg(unix)]
fn check_private_dir(dir: &Path, what: &str) -> Result<(), StartupError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let meta = std::fs::metadata(dir).map_err(|e| {
        StartupError::Refused(format!("{what} {} is not usable: {e}", dir.display()))
    })?;
    if !meta.is_dir() {
        return Err(StartupError::Refused(format!(
            "{what} {} is not a directory",
            dir.display()
        )));
    }
    if meta.uid() != euid() {
        return Err(StartupError::Refused(format!(
            "{what} {} is owned by uid {}, not by you (uid {}); refusing to serve",
            dir.display(),
            meta.uid(),
            euid()
        )));
    }
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(StartupError::Refused(format!(
            "{what} {} is group/other-accessible ({mode:04o}); it must be 0700 and owned by \
             you. Sandpane does not chmod directories it does not own",
            dir.display()
        )));
    }
    Ok(())
}

/// Create (if missing) Sandpane's OWN data directory 0700 and make sure it is
/// private: a symlink, foreign owner or permissive mode is corrected only
/// where it is safely ours (mode on our own directory), otherwise refused.
#[cfg(unix)]
pub fn ensure_private_data_dir(dir: &Path) -> Result<(), StartupError> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| StartupError::Refused(format!("cannot create {}: {e}", dir.display())))?;
    let meta = std::fs::symlink_metadata(dir)
        .map_err(|e| StartupError::Refused(format!("cannot stat {}: {e}", dir.display())))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(StartupError::Refused(format!(
            "data directory {} must be a real directory, not a symlink",
            dir.display()
        )));
    }
    if meta.uid() != euid() {
        return Err(StartupError::Refused(format!(
            "data directory {} is owned by uid {}, not by you",
            dir.display(),
            meta.uid()
        )));
    }
    if meta.permissions().mode() & 0o077 != 0 {
        // Our own leaf directory: tighten it, then verify by read-back.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| StartupError::Refused(format!("cannot chmod {}: {e}", dir.display())))?;
    }
    check_private_dir(dir, "data directory")
}

/// Bug 6 / W5 / S2: prepare everything before binding.
/// - Sandpane's own data dir is created/tightened (never a shared parent).
/// - An OVERRIDE socket's parent must already be a 0700 directory owned by
///   this user; it is never created or chmodded.
/// - The DB's parent is created (0700) if missing, never chmodded if present.
/// - A `flock`ed lockfile beside the socket enforces one instance.
/// - A leftover socket path is unlinked only if it IS a socket and nothing
///   answers on it.
#[cfg(unix)]
pub fn prepare_runtime(
    data_dir: &Path,
    socket_path: &Path,
    socket_is_override: bool,
    db_path: &Path,
) -> Result<RuntimeGuard, StartupError> {
    use std::os::unix::fs::{DirBuilderExt, FileTypeExt, OpenOptionsExt};
    use std::os::unix::io::AsRawFd;

    let socket_dir = socket_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| {
            StartupError::Refused(format!(
                "socket path {} has no parent directory",
                socket_path.display()
            ))
        })?;
    if !socket_is_override || db_path.starts_with(data_dir) {
        ensure_private_data_dir(data_dir)?;
    }
    if socket_is_override {
        check_private_dir(socket_dir, "SANDPANE_SOCKET directory")?;
    } else {
        check_private_dir(socket_dir, "socket directory")?;
    }
    if let Some(db_dir) = db_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        if !db_dir.exists() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(db_dir)
                .map_err(|e| {
                    StartupError::Refused(format!(
                        "cannot create database directory {}: {e}",
                        db_dir.display()
                    ))
                })?;
        }
    }

    let mut lock_name = socket_path.as_os_str().to_owned();
    lock_name.push(".lock");
    let lock_path = PathBuf::from(lock_name);
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&lock_path)
        .map_err(|e| {
            StartupError::Refused(format!("cannot open lock {}: {e}", lock_path.display()))
        })?;
    // SAFETY: valid open fd for the lifetime of `lock`.
    let rc = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
            return Err(StartupError::AlreadyRunning(socket_path.to_path_buf()));
        }
        return Err(StartupError::Refused(format!(
            "cannot lock {}: {err}",
            lock_path.display()
        )));
    }

    match std::fs::symlink_metadata(socket_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(StartupError::Refused(format!(
                "cannot stat {}: {e}",
                socket_path.display()
            )))
        }
        Ok(meta) => {
            if !meta.file_type().is_socket() {
                return Err(StartupError::Refused(format!(
                    "{} exists and is not a socket; refusing to delete it",
                    socket_path.display()
                )));
            }
            // A pre-lock (older) Core may still be serving it.
            if std::os::unix::net::UnixStream::connect(socket_path).is_ok() {
                return Err(StartupError::AlreadyRunning(socket_path.to_path_buf()));
            }
            std::fs::remove_file(socket_path).map_err(|e| {
                StartupError::Refused(format!(
                    "cannot remove stale socket {}: {e}",
                    socket_path.display()
                ))
            })?;
        }
    }
    Ok(RuntimeGuard {
        _lock: lock,
        lock_path,
    })
}

/// Security S3: uid of the process on the other end of a Unix socket.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
pub fn peer_uid(stream: &std::os::unix::net::UnixStream) -> std::io::Result<u32> {
    use std::os::unix::io::AsRawFd;
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: valid fd; out-pointers live for the call.
    let rc = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(uid)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn peer_uid(stream: &std::os::unix::net::UnixStream) -> std::io::Result<u32> {
    use std::os::unix::io::AsRawFd;
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: valid fd; `cred`/`len` are correctly sized out-parameters.
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(cred.uid)
}

#[cfg(all(
    unix,
    not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "linux",
        target_os = "android"
    ))
))]
pub fn peer_uid(_stream: &std::os::unix::net::UnixStream) -> std::io::Result<u32> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "peer credentials are not implemented on this platform",
    ))
}

/// A connection is served only when its peer is this same user. An
/// undeterminable peer is refused (fail closed).
pub fn peer_allowed(peer: std::io::Result<u32>, own_uid: u32) -> bool {
    matches!(peer, Ok(uid) if uid == own_uid)
}

/// Security S7: bounds on client connections.
#[derive(Debug, Clone, Copy)]
pub struct ConnectionLimits {
    /// Concurrent connections served; extra connects get a structured refusal.
    pub max_connections: usize,
    /// A connection that sends nothing for this long is closed. Clients
    /// already reconnect with backoff (vscode `connection.ts`), so an idle
    /// close is recoverable; 30 min keeps idle IDE windows attached.
    pub idle_timeout: Duration,
    /// Bound on one blocked response write (a client that stops reading).
    pub write_timeout: Duration,
}

impl Default for ConnectionLimits {
    fn default() -> Self {
        Self {
            max_connections: 64,
            idle_timeout: Duration::from_secs(30 * 60),
            write_timeout: Duration::from_secs(30),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn env(macos: bool, home: &str, xdg: Option<&str>) -> PathEnv {
        PathEnv {
            macos,
            home: Some(home.into()),
            xdg_state_home: xdg.map(Into::into),
            socket_override: None,
            db_override: None,
        }
    }

    /// W5: pinned per OS branch, identical to `paths.ts` `coreDataDir`.
    #[test]
    fn data_dir_matches_clients_on_every_branch() {
        assert_eq!(
            data_dir_for(&env(true, "/Users/dev", None)),
            PathBuf::from("/Users/dev/Library/Application Support/sandpane")
        );
        // macOS ignores XDG_STATE_HOME (as paths.ts does).
        assert_eq!(
            data_dir_for(&env(true, "/Users/dev", Some("/x"))),
            PathBuf::from("/Users/dev/Library/Application Support/sandpane")
        );
        assert_eq!(
            data_dir_for(&env(false, "/home/dev", None)),
            PathBuf::from("/home/dev/.local/state/sandpane")
        );
        // The bug: XDG_STATE_HOME used to be the data dir itself.
        assert_eq!(
            data_dir_for(&env(false, "/home/dev", Some("/home/dev/.state"))),
            PathBuf::from("/home/dev/.state/sandpane")
        );
        // Blank / whitespace XDG means unset; values are trimmed.
        assert_eq!(
            data_dir_for(&env(false, "/home/dev", Some("   "))),
            PathBuf::from("/home/dev/.local/state/sandpane")
        );
        assert_eq!(
            data_dir_for(&env(false, "/home/dev", Some(" /s "))),
            PathBuf::from("/s/sandpane")
        );
        // No HOME → /tmp fallback, like paths.ts.
        let mut e = env(false, "", None);
        e.home = None;
        assert_eq!(
            data_dir_for(&e),
            PathBuf::from("/tmp/.local/state/sandpane")
        );
    }

    #[test]
    fn socket_and_db_paths_and_overrides() {
        let mut e = env(false, "/home/dev", Some("/st"));
        assert_eq!(
            socket_path_for(&e),
            (PathBuf::from("/st/sandpane/sandpane.sock"), false)
        );
        assert_eq!(
            db_path_for(&e),
            PathBuf::from("/st/sandpane/sandpane.sqlite3")
        );
        e.socket_override = Some(" /run/x.sock ".into());
        e.db_override = Some("/data/db.sqlite3".into());
        assert_eq!(socket_path_for(&e), (PathBuf::from("/run/x.sock"), true));
        assert_eq!(db_path_for(&e), PathBuf::from("/data/db.sqlite3"));
        e.socket_override = Some("  ".into());
        assert!(!socket_path_for(&e).1, "blank override is unset");
    }

    fn mode_of(p: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    fn chmod(p: &Path, m: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
    }

    /// Bug 6: the default layout creates ONLY Sandpane's own dir 0700 and
    /// never touches the (shared) parent's mode.
    #[test]
    fn default_layout_creates_private_data_dir_without_chmodding_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        std::fs::create_dir(&state).unwrap();
        chmod(&state, 0o755);
        let data = state.join("sandpane");
        let sock = data.join("sandpane.sock");
        let db = data.join("sandpane.sqlite3");
        let guard = prepare_runtime(&data, &sock, false, &db).unwrap();
        assert_eq!(mode_of(&data), 0o700);
        assert_eq!(mode_of(&state), 0o755, "shared parent must not be chmodded");
        assert!(guard.lock_path.exists());
        // An existing, too-open OWN data dir is tightened.
        drop(guard);
        chmod(&data, 0o755);
        let _g = prepare_runtime(&data, &sock, false, &db).unwrap();
        assert_eq!(mode_of(&data), 0o700);
    }

    #[test]
    fn override_socket_dir_must_already_be_private_and_is_never_chmodded() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data/sandpane");
        let shared = tmp.path().join("shared");
        std::fs::create_dir(&shared).unwrap();
        chmod(&shared, 0o755);
        let sock = shared.join("core.sock");
        let db = tmp.path().join("dbdir/nested/core.sqlite3");
        let err = prepare_runtime(&data, &sock, true, &db).unwrap_err();
        assert!(
            matches!(&err, StartupError::Refused(m) if m.contains("0700")),
            "{err}"
        );
        assert_eq!(
            mode_of(&shared),
            0o755,
            "override parent must not be chmodded"
        );
        // Missing override dir: refused, not created.
        let missing = tmp.path().join("nope/core.sock");
        assert!(prepare_runtime(&data, &missing, true, &db).is_err());
        assert!(!tmp.path().join("nope").exists());
        // Private override dir: accepted; DB dir created; data dir untouched
        // (DB is not inside it and the socket is overridden).
        let private = tmp.path().join("private");
        std::fs::create_dir(&private).unwrap();
        chmod(&private, 0o700);
        let _g = prepare_runtime(&data, &private.join("core.sock"), true, &db).unwrap();
        assert!(db.parent().unwrap().is_dir());
        assert!(!data.exists());
    }

    /// S2: one instance per lock; a leftover NON-socket is never unlinked; a
    /// dead socket file is replaced.
    #[test]
    fn single_instance_lock_and_stale_socket_handling() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("sandpane");
        let sock = data.join("sandpane.sock");
        let db = data.join("db.sqlite3");
        let g1 = prepare_runtime(&data, &sock, false, &db).unwrap();
        let second = prepare_runtime(&data, &sock, false, &db).unwrap_err();
        assert!(
            matches!(second, StartupError::AlreadyRunning(_)),
            "{second}"
        );
        drop(g1);

        // Regular file where the socket should be → refused, file kept.
        std::fs::write(&sock, b"precious").unwrap();
        let err = prepare_runtime(&data, &sock, false, &db).unwrap_err();
        assert!(matches!(&err, StartupError::Refused(m) if m.contains("not a socket")));
        assert_eq!(std::fs::read(&sock).unwrap(), b"precious");
        std::fs::remove_file(&sock).unwrap();

        // Dead socket (listener dropped) → replaced.
        drop(std::os::unix::net::UnixListener::bind(&sock).unwrap());
        assert!(sock.exists());
        let _g = prepare_runtime(&data, &sock, false, &db).unwrap();
        assert!(!sock.exists());
    }

    #[test]
    fn live_unlocked_socket_is_treated_as_running_instance() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("sandpane");
        std::fs::create_dir(&data).unwrap();
        chmod(&data, 0o700);
        let sock = data.join("sandpane.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let err = prepare_runtime(&data, &sock, false, &data.join("db")).unwrap_err();
        assert!(matches!(err, StartupError::AlreadyRunning(_)));
        assert!(sock.exists(), "a live socket is never unlinked");
    }

    #[test]
    fn peer_credentials_same_user_and_fail_closed() {
        let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
        let uid = peer_uid(&a).unwrap();
        assert_eq!(uid, euid());
        assert!(peer_allowed(Ok(uid), euid()));
        assert!(!peer_allowed(Ok(uid.wrapping_add(1)), euid()));
        assert!(!peer_allowed(Err(std::io::Error::other("unknown")), euid()));
    }
}
