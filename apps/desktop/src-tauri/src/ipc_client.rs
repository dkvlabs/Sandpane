// The narrow Core IPC proxy.
//
// One command forwards exactly one already-validated NDJSON request frame to the
// per-user Core socket and returns the single response line. Framing, request id
// correlation and `afterSequence` replay live in the TypeScript client
// (`src/lib/core-client.ts`), which is what lets the same wire logic be unit
// tested without a native build.
//
// Deliberately absent here: process spawning, shell execution, arbitrary paths,
// arbitrary URLs, arbitrary methods. Adding any of those to this file is a
// security regression, not a feature (AGENTS.md §Code Review rules 1, 2, 6).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use sandpane_protocol::{Method, RpcRequest, PROTOCOL_VERSION};
use serde::Serialize;
use tauri::State;

/// Mirrors `sandpane_service::MAX_FRAME_BYTES`. A frame over the cap is refused
/// rather than buffered (AGENTS.md §Code Review rule 9).
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Mirrors `rpc-request.schema.json` (`id` maxLength 128).
const MAX_ID_CHARS: usize = 128;

/// How long to wait for Core's answer before giving the webview a typed error.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(20);

/// Methods with no server-side effect, so re-sending one after a failed READ is
/// safe. Everything else must never be re-issued blindly: `write_and_read`
/// finishes `write_all` before the read can fail or time out, so Core may already
/// have executed the request — retrying `conversation.send` would append a second
/// message row and queue a second task, and retrying `git.apply` would re-run an
/// apply the user only confirmed once (docs/specs/06 §10: "Multiple clients cannot
/// accidentally issue duplicate create/start tasks after reconnect"). Core has no
/// idempotency keys yet (a P1 item in docs/specs/02 §2), so the proxy is the only
/// place this can be prevented for the desktop shell.
///
/// `task.cancel` is deliberately excluded even though it is idempotent in effect:
/// Core answers the second cancel with `CONFLICT`, which would surface to the user
/// as a spurious failure of an operation that already succeeded.
fn replay_safe(method: Method) -> bool {
    matches!(
        method,
        Method::SystemProbe
            | Method::ProjectList
            | Method::SandboxList
            | Method::TaskList
            | Method::ConversationList
            | Method::ConversationHistory
            | Method::TaskSubscribe
            | Method::GitReview
    )
}

#[derive(Debug, Clone, Serialize)]
pub struct ProxyError {
    /// Stable machine-readable code; the UI maps it to copy.
    pub code: &'static str,
    pub message: String,
}

impl ProxyError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Socket path policy, kept identical to `sandpane-service::default_socket_path`:
/// explicit `SANDPANE_SOCKET`, else a per-user private data directory. NEVER TCP.
pub fn socket_path() -> PathBuf {
    if let Some(path) = std::env::var_os("SANDPANE_SOCKET") {
        return PathBuf::from(path);
    }
    data_dir().join("sandpane.sock")
}

fn data_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir().join("Library/Application Support/sandpane")
    } else {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".local/state/sandpane"))
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

#[derive(Debug, Clone, Serialize)]
pub struct SocketStatus {
    pub path: String,
    pub exists: bool,
    /// False on platforms where this scaffold has no transport at all.
    pub transport_supported: bool,
}

/// Read-only metadata for the Settings/diagnostics view. Does not connect, so it
/// cannot disturb the single-instance handshake that Core owns.
#[tauri::command]
pub fn core_socket_status() -> Result<SocketStatus, ProxyError> {
    let path = socket_path();
    Ok(SocketStatus {
        path: path.display().to_string(),
        exists: path.exists(),
        transport_supported: cfg!(unix),
    })
}

// ---------------------------------------------------------------------------
// Frame validation (shared by every platform)
// ---------------------------------------------------------------------------

/// Validate one request frame before it may touch the socket. Returns the parsed
/// request so the caller can report the method in errors.
fn validate_frame(line: &str) -> Result<RpcRequest, ProxyError> {
    if line.len() > MAX_FRAME_BYTES {
        return Err(ProxyError::new(
            "FRAME_TOO_LARGE",
            format!(
                "frame of {} bytes exceeds the {} byte cap",
                line.len(),
                MAX_FRAME_BYTES
            ),
        ));
    }
    let request: RpcRequest = serde_json::from_str(line.trim_end_matches('\n')).map_err(|err| {
        ProxyError::new("VALIDATION_FAILED", format!("frame is not an RpcRequest: {err}"))
    })?;
    if request.v != PROTOCOL_VERSION {
        return Err(ProxyError::new(
            "PROTOCOL_VERSION",
            format!(
                "client frame speaks v{}; this shell speaks v{PROTOCOL_VERSION}",
                request.v
            ),
        ));
    }
    if request.id.is_empty() || request.id.chars().count() > MAX_ID_CHARS {
        return Err(ProxyError::new(
            "VALIDATION_FAILED",
            "request id must be 1..=128 characters",
        ));
    }
    if Method::parse(&request.method).is_none() {
        return Err(ProxyError::new(
            "METHOD_NOT_ALLOWED",
            format!(
                "\"{}\" is not an allowlisted Sandpane Core method",
                request.method
            ),
        ));
    }
    Ok(request)
}

// ---------------------------------------------------------------------------
// Unix transport
// ---------------------------------------------------------------------------

/// One reused connection to the Core socket. The write half is a clone of the
/// read half, exactly like `serve_connection` on the service side.
#[cfg(unix)]
struct Connection {
    reader: std::io::BufReader<std::os::unix::net::UnixStream>,
    writer: std::os::unix::net::UnixStream,
}

#[derive(Default)]
pub struct CoreProxy {
    #[cfg(unix)]
    conn: Mutex<Option<Connection>>,
}

#[cfg(unix)]
fn connect(path: &Path) -> Result<Connection, ProxyError> {
    use std::os::unix::net::UnixStream;

    let stream = UnixStream::connect(path).map_err(|err| {
        ProxyError::new(
            "CORE_UNREACHABLE",
            format!(
                "could not connect to the Core socket at {}: {err}. Start sandpane-service; this \
                 shell never launches a Core of its own.",
                path.display()
            ),
        )
    })?;
    stream
        .set_read_timeout(Some(RESPONSE_TIMEOUT))
        .map_err(|err| ProxyError::new("INTERNAL", format!("set_read_timeout: {err}")))?;
    let reader = std::io::BufReader::new(stream.try_clone().map_err(|err| {
        ProxyError::new("INTERNAL", format!("socket clone: {err}"))
    })?);
    Ok(Connection {
        reader,
        writer: stream,
    })
}

/// Forward one validated request frame; return the response line verbatim.
#[tauri::command]
#[cfg(unix)]
pub fn core_request_frame(
    state: State<'_, CoreProxy>,
    line: String,
) -> Result<String, ProxyError> {
    // No `std::io` imports here: every socket read/write goes through
    // `write_and_read`, which owns the traits it needs.
    let request = validate_frame(&line)?;
    let path = socket_path();

    let mut guard = state.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        *guard = Some(connect(&path)?);
    }

    let mut buffer = String::new();
    for attempt in 0..2 {
        let conn = guard
            .as_mut()
            .ok_or_else(|| ProxyError::new("INTERNAL", "connection slot is empty"))?;
        match write_and_read(conn, &line, &mut buffer) {
            Ok(()) => {
                let response = buffer.trim_end_matches('\n').to_string();
                if validate_response_shape(&response).is_err() {
                    // Drop the connection: the stream is no longer aligned.
                    *guard = None;
                    return Err(ProxyError::new(
                        "MALFORMED_FRAME",
                        format!("Core answered {} with a non-conforming frame", request.method),
                    ));
                }
                return Ok(response);
            }
            Err(err) => {
                *guard = None;
                // A mutating frame must not be re-sent: `write_all` already
                // succeeded, so Core may have applied it. Report the loss with
                // the instruction the user can actually act on.
                if !replay_safe(request.method) {
                    return Err(ProxyError::new(
                        err.code,
                        format!(
                            "{} — the frame was already written to Core, so it may have been applied; inspect Core's state instead of retrying",
                            err.message
                        ),
                    ));
                }
                if attempt == 1 {
                    return Err(err);
                }
                buffer.clear();
                // One reconnect attempt covers a socket closed by a Core restart.
                *guard = Some(connect(&path)?);
            }
        }
    }
    Err(ProxyError::new("INTERNAL", "unreachable"))
}

#[cfg(unix)]
fn write_and_read(
    conn: &mut Connection,
    line: &str,
    out: &mut String,
) -> Result<(), ProxyError> {
    // `Read` must be in scope for `.take()` (the bounded-read guard); `Take<R>`
    // then implements `BufRead`, which is what supplies `read_line`.
    use std::io::{BufRead, Read, Write};

    let payload = line.trim_end_matches('\n');
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProxyError::new("FRAME_TOO_LARGE", "frame exceeds the cap"));
    }
    conn.writer
        .write_all(payload.as_bytes())
        .and_then(|_| conn.writer.write_all(b"\n"))
        .map_err(|err| ProxyError::new("WRITE_FAILED", format!("socket write: {err}")))?;
    conn.writer
        .flush()
        .map_err(|err| ProxyError::new("WRITE_FAILED", format!("socket flush: {err}")))?;

    // Bounded read: at most cap + 1 byte, so an oversized answer cannot grow us.
    // `mut` is required: `read_line` advances the limiter's internal allowance.
    let mut limited = (&mut conn.reader).take(MAX_FRAME_BYTES as u64 + 1);
    let read = limited
        .read_line(out)
        .map_err(|err| ProxyError::new("READ_FAILED", format!("socket read: {err}")))?;
    if read == 0 {
        return Err(ProxyError::new(
            "CORE_UNREACHABLE",
            "Core closed the connection before answering",
        ));
    }
    if out.len() > MAX_FRAME_BYTES {
        return Err(ProxyError::new(
            "FRAME_TOO_LARGE",
            "Core answered with a frame over the cap",
        ));
    }
    Ok(())
}

/// Cheap structural check of the answer: object with `v`, `id`, and one of
/// `ok`/`err`. The client parses it properly; this only stops a misaligned stream
/// from being handed to the webview as if it were a response.
fn validate_response_shape(line: &str) -> Result<(), ProxyError> {
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|err| ProxyError::new("MALFORMED_FRAME", format!("not JSON: {err}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| ProxyError::new("MALFORMED_FRAME", "response is not an object"))?;
    if object.get("v").and_then(serde_json::Value::as_u64).is_none()
        || object.get("id").and_then(serde_json::Value::as_str).is_none()
    {
        return Err(ProxyError::new(
            "MALFORMED_FRAME",
            "response is missing v/id",
        ));
    }
    let has_ok = object.contains_key("ok");
    let has_err = object.contains_key("err");
    if has_ok == has_err {
        return Err(ProxyError::new(
            "MALFORMED_FRAME",
            "response must carry exactly one of ok/err",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Other platforms
// ---------------------------------------------------------------------------

/// Windows named pipes are a P1 transport deliverable in the Core service, which
/// serves Unix sockets only. This shell says so instead of pretending: no
/// fallback TCP, no local reimplementation of the protocol.
#[tauri::command]
#[cfg(not(unix))]
pub fn core_request_frame(
    _state: State<'_, CoreProxy>,
    line: String,
) -> Result<String, ProxyError> {
    // Still validate before refusing, so a bad frame is reported as itself
    // rather than masked by the platform message.
    validate_frame(&line)?;
    Err(ProxyError::new(
        "TRANSPORT_UNSUPPORTED",
        "this build attaches to Core over a Unix domain socket; the named-pipe transport is a P1 \
         Core deliverable and is not implemented here",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(method: &str) -> String {
        format!(r#"{{"v":{PROTOCOL_VERSION},"id":"desk-1","method":"{method}","params":{{}}}}"#)
    }

    #[test]
    fn allowlisted_method_passes() {
        assert!(validate_frame(&frame("system.probe")).is_ok());
        assert!(validate_frame(&frame("task.subscribe")).is_ok());
    }

    /// The proxy holds no method list of its own: `validate_frame` asks
    /// `sandpane_protocol::Method::parse`, so the ADDITIVE-v1 reads are forwarded
    /// the moment Core's crate gains them — and this shell can never advertise a
    /// method Core does not dispatch.
    #[test]
    fn additive_v1_reads_are_forwarded() {
        for method in ["task.list", "conversation.list", "conversation.history"] {
            assert!(
                validate_frame(&frame(method)).is_ok(),
                "{method} must be allowlisted because Core's crate parses it"
            );
        }
        // The crate is the whole allowlist; assert the count so a silent removal
        // in Rust shows up here rather than as a mystery METHOD_NOT_ALLOWED.
        assert_eq!(Method::ALL.len(), 14);
    }

    /// The proxy's one reconnect attempt must only ever re-issue a method with no
    /// server-side effect. `write_all` completes before a read can fail, so a blind
    /// retry of `conversation.send` would append a second message and queue a
    /// second task; `git.apply` would re-run a one-time confirmation.
    #[test]
    fn only_read_only_methods_may_be_re_sent_after_a_lost_answer() {
        let safe: Vec<&str> = Method::ALL
            .iter()
            .filter(|m| replay_safe(**m))
            .map(|m| m.as_str())
            .collect();
        assert_eq!(
            safe,
            vec![
                "system.probe",
                "project.list",
                "sandbox.list",
                "conversation.list",
                "conversation.history",
                "task.list",
                "task.subscribe",
                "git.review",
            ],
            "the replay-safe set is exactly the read-only methods"
        );
        // Spelled out so a future "retry everything for robustness" change fails here.
        for m in [
            Method::ProjectCreate,
            Method::SandboxCreate,
            Method::ConversationCreate,
            Method::ConversationSend,
            Method::GitApply,
            Method::TaskCancel,
        ] {
            assert!(
                !replay_safe(m),
                "{:?} ({}) must never be re-sent after the answer is lost",
                m,
                m.as_str()
            );
        }
    }

    /// A `task.subscribe` frame carrying the per-task cursor map must survive the
    /// proxy — `params` is opaque JSON here and stays that way.
    ///
    /// Note on framing: the proxy writes the ORIGINAL line bytes to the socket
    /// (`write_and_read(conn, &line, …)`); the parsed `RpcRequest` is used only
    /// for validation. Re-serializing it would NOT be byte-identical, because the
    /// default `serde_json` map is sorted — which is exactly why the forward path
    /// must not resend a re-encoded frame.
    #[test]
    fn subscribe_cursor_map_passes_through_untouched() {
        let line = format!(
            r#"{{"v":{PROTOCOL_VERSION},"id":"desk-2","method":"task.subscribe","params":{{"projectId":"p1","afterSequence":0,"afterSequences":{{"t-a":4,"t-b":11}}}}}}"#
        );
        let request = validate_frame(&line).expect("cursor map must validate");
        assert_eq!(request.params["afterSequences"]["t-a"], 4);
        assert_eq!(request.params["afterSequences"]["t-b"], 11);
        assert_eq!(request.params["projectId"], "p1");
        // The documented asymmetry: with a `taskId`, Core ignores the map. The
        // proxy does not interpret that — it forwards whatever the client sent.
        let scalar_only = r#"{"v":1,"id":"desk-3","method":"task.subscribe","params":{"taskId":"t-a","afterSequence":7}}"#;
        let parsed = validate_frame(scalar_only).expect("scalar cursor must validate");
        assert_eq!(parsed.params["afterSequence"], 7);
        assert!(parsed.params.get("afterSequences").is_none());
    }

    #[test]
    fn unknown_method_is_refused() {
        for method in ["shell.exec", "system.probe; ls", "core.raw.socket", ""] {
            let err = validate_frame(&frame(method)).expect_err("must refuse");
            assert_eq!(err.code, "METHOD_NOT_ALLOWED", "{method}");
        }
    }

    #[test]
    fn wrong_version_is_refused() {
        let line = r#"{"v":2,"id":"a","method":"system.probe","params":{}}"#;
        assert_eq!(validate_frame(line).unwrap_err().code, "PROTOCOL_VERSION");
    }

    #[test]
    fn oversized_frame_is_refused() {
        let line = format!(
            r#"{{"v":{PROTOCOL_VERSION},"id":"a","method":"system.probe","params":{{"x":"{}"}}}}"#,
            "x".repeat(MAX_FRAME_BYTES)
        );
        assert_eq!(validate_frame(&line).unwrap_err().code, "FRAME_TOO_LARGE");
    }

    #[test]
    fn response_shape_requires_exactly_one_outcome() {
        assert!(validate_response_shape(r#"{"v":1,"id":"a","ok":{}}"#).is_ok());
        assert!(
            validate_response_shape(r#"{"v":1,"id":"a","err":{"code":"INTERNAL","message":"m"}}"#)
                .is_ok()
        );
        assert!(validate_response_shape(r#"{"v":1,"id":"a"}"#).is_err());
        assert!(validate_response_shape(r#"{"v":1,"id":"a","ok":{},"err":{}}"#).is_err());
        assert!(validate_response_shape(r#"not json"#).is_err());
    }
}
