// Sandpane Desktop — Tauri shell.
//
// The Rust side is deliberately tiny. It is a narrow typed client for the shared
// per-user Core socket and nothing else:
//
//   * it exposes exactly two commands, both about Core frames;
//   * it never spawns, restarts or supervises a Core process (the single
//     persistent Core per user is owned by `sandpane-service`; docs/specs/05 §2);
//   * it has no shell, no `std::process::Command`, no filesystem handler and no
//     generic "execute this" surface, so the webview cannot ask for either;
//   * it re-validates every outbound frame against `sandpane_protocol::Method`
//     and `MAX_FRAME_BYTES`, so a buggy or compromised UI still cannot send a
//     method Core does not allowlist.
//
// Business logic (projects, tasks, sandboxes, Git) stays in Core. That is why
// this crate can stay a proxy instead of becoming a second implementation.

mod ipc_client;

use ipc_client::{core_request_frame, core_socket_status};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            core_request_frame,
            core_socket_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sandpane Desktop");
}
