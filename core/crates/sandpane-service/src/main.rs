//! Sandpane Core service daemon (Unix socket transport).
//!
//! Single instance per OS user: an existing socket that accepts a connect
//! means another live Core owns this session (handshake, not a lock guess).
//! Stale socket files are replaced only after a failed connect probe.
//! Permissions: data directory 0700, socket 0600 — never TCP (specs/02 §2,
//! specs/06 §4).

#[cfg(unix)]
fn main() {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::sync::Arc;

    use sandpane_core::sbx::SbxLocator;
    use sandpane_core::Database;
    use sandpane_service::{default_db_path, default_socket_path, serve_connection, ServerInner};

    let socket_path = default_socket_path();
    let db_path = default_db_path();

    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|e| {
            eprintln!("sandpane-service: cannot create {}: {e}", parent.display());
            std::process::exit(1);
        });
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).unwrap_or_else(
            |e| {
                eprintln!("sandpane-service: cannot chmod {}: {e}", parent.display());
                std::process::exit(1);
            },
        );
        // Read-back enforcement: the same-user IPC boundary (specs/06 §4) is
        // only real if the mode actually holds; a silently permissive socket
        // dir is "any-local-user IPC", so refuse to serve instead. A failed
        // metadata read is treated as maximally permissive → refuse.
        let mode = std::fs::metadata(parent)
            .map(|m| m.permissions().mode() & 0o777)
            .unwrap_or(0o777);
        if mode & 0o077 != 0 {
            eprintln!(
                "sandpane-service: refusing to serve: data directory {} is \
                 group/other-accessible ({mode:04o})",
                parent.display()
            );
            std::process::exit(1);
        }
    }

    // Single-instance handshake.
    if socket_path.exists() {
        match UnixStream::connect(&socket_path) {
            Ok(_) => {
                eprintln!(
                    "sandpane-service: another Core instance owns {} — attach to it instead",
                    socket_path.display()
                );
                std::process::exit(0);
            }
            Err(_) => {
                // Stale socket from a dead process; safe to replace.
                let _ = std::fs::remove_file(&socket_path);
            }
        }
    }

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
    let inner = ServerInner::new(db, SbxLocator::from_env());
    eprintln!(
        "sandpane-service: listening on {} (protocol v{}, core v{}, db {})",
        socket_path.display(),
        sandpane_protocol::PROTOCOL_VERSION,
        sandpane_protocol::CORE_VERSION,
        db_path.display()
    );

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let inner = Arc::clone(&inner);
                std::thread::spawn(move || serve_connection(inner, s));
            }
            Err(e) => eprintln!("sandpane-service: accept failed: {e}"),
        }
    }
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
