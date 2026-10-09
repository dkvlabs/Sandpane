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
    use sandpane_service::{serve_listener, ServerInner};

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
    let inner = ServerInner::new(db, locator);
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
