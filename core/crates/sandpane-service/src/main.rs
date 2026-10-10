//! Sandpane Core service daemon (Unix socket transport).
//!
//! Startup policy lives in `sandpane_service::runtime` (testable):
//! - Sandpane's OWN data directory (`…/sandpane`, matching every client) is
//!   created 0700; a shared parent is never chmodded. An overridden socket's
//!   directory must already be 0700 and owned by this user.
//! - Single instance per socket via a `flock`ed lockfile; a leftover socket
//!   path is unlinked only if it is a socket nobody answers on.
//! - Socket 0600, peer uid checked per connection, connection cap + idle
//!   timeout — never TCP (specs/02 §2, specs/06 §4).

#[cfg(unix)]
fn main() {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    use sandpane_core::sbx::SbxLocator;
    use sandpane_core::Database;
    use sandpane_service::runtime::{self, ConnectionLimits, PathEnv, StartupError};
    use sandpane_service::{serve_listener, CoreConfig, ServerInner};

    let env = PathEnv::from_process();
    let data_dir = runtime::data_dir_for(&env);
    let (socket_path, socket_is_override) = runtime::socket_path_for(&env);
    let db_path = runtime::db_path_for(&env);

    // Held for the whole process lifetime (single-instance lock).
    let _guard =
        match runtime::prepare_runtime(&data_dir, &socket_path, socket_is_override, &db_path) {
            Ok(g) => g,
            Err(e @ StartupError::AlreadyRunning(_)) => {
                eprintln!("sandpane-service: {e}");
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("sandpane-service: refusing to start: {e}");
                std::process::exit(1);
            }
        };

    let listener = UnixListener::bind(&socket_path).unwrap_or_else(|e| {
        eprintln!("sandpane-service: bind {}: {e}", socket_path.display());
        std::process::exit(1);
    });
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).unwrap_or_else(
        |e| {
            eprintln!("sandpane-service: cannot chmod socket: {e}");
            std::process::exit(1);
        },
    );
    let sock_mode = std::fs::metadata(&socket_path)
        .map(|m| m.permissions().mode() & 0o777)
        .unwrap_or(0o777);
    if sock_mode & 0o077 != 0 {
        let _ = std::fs::remove_file(&socket_path);
        eprintln!(
            "sandpane-service: refusing to serve: socket {} is group/other-accessible ({sock_mode:04o})",
            socket_path.display()
        );
        std::process::exit(1);
    }

    let db = Database::open(&db_path).unwrap_or_else(|e| {
        eprintln!("sandpane-service: open {}: {e}", db_path.display());
        std::process::exit(1);
    });
    let locator = SbxLocator::from_env();
    // Security S8: say which sbx binary will be executed and why.
    match locator.locate_with_source() {
        Ok((path, source)) => eprintln!(
            "sandpane-service: sbx resolved to {} (via {})",
            path.display(),
            source.as_str()
        ),
        Err(e) => eprintln!("sandpane-service: {e}"),
    }
    // Task worktrees live in Core's OWN private data directory (created 0700
    // on first allocation), never inside a user's repository.
    // The USER's own global excludes file, resolved from global git config
    // only (never a repository's config). A missing file ignores nothing, so
    // it is simply not passed; a git failure is reported and falls back.
    let user_excludes_file = match sandpane_core::git::user_excludes_candidate(
        &sandpane_core::git::GitRunner::default(),
        &sandpane_core::git::ExcludesEnv {
            home: std::env::var_os("HOME").map(std::path::PathBuf::from),
            xdg_config_home: std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from),
        },
    ) {
        Ok(Some(p)) if std::fs::symlink_metadata(&p).is_ok() => Some(p),
        Ok(_) => None,
        Err(e) => {
            eprintln!("sandpane-service: cannot resolve global excludes file ({e}); using none");
            None
        }
    };
    // FAIL CLOSED (A2 review W3): restart reconciliation (tasks ->
    // interrupted, pending idempotency keys -> unknown) must be durable
    // before anything is served. If it is not, remove the socket we bound
    // (no client may connect to unreconciled state) and exit non-zero.
    let inner = match ServerInner::try_with_config(
        db,
        locator,
        CoreConfig {
            worktrees_root: Some(data_dir.join("worktrees")),
            user_excludes_file,
            ..CoreConfig::default()
        },
    ) {
        Ok(inner) => inner,
        Err(e) => {
            drop(listener);
            let _ = std::fs::remove_file(&socket_path);
            eprintln!(
                "sandpane-service: refusing to start: {e}; nothing was served (database {})",
                db_path.display()
            );
            std::process::exit(1);
        }
    };
    eprintln!(
        "sandpane-service: listening on {} (protocol v{}, core v{}, db {})",
        socket_path.display(),
        sandpane_protocol::PROTOCOL_VERSION,
        sandpane_protocol::CORE_VERSION,
        db_path.display()
    );
    serve_listener(inner, listener, ConnectionLimits::default());
}

#[cfg(not(unix))]
fn main() {
    // Windows named pipes are a P1 transport deliverable (specs/02 §2).
    // Honest failure beats a fake cross-platform claim.
    eprintln!(
        "sandpane-service: this build supports Unix domain sockets only; \
         the Windows named-pipe transport is a P1 deliverable"
    );
    std::process::exit(2);
}
