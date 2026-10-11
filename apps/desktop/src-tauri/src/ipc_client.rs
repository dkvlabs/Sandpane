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
//
// Concurrency model: every request opens its OWN connection on a blocking worker
// thread (`tauri::async_runtime::spawn_blocking`), so the main thread never
// blocks on a socket and no request waits behind another one on a shared lock.
// `sandpane-service` serves each connection on its own thread, so per-request
// connections are the shape it expects. The whole exchange — connect, write,
// read, and the single retry a read-only method may get — runs under one
// deadline (`PROXY_DEADLINE_MS`) that is deliberately SHORTER than the webview's
// own request timeout (`DEFAULT_REQUEST_TIMEOUT_MS` in core-client.ts). That
// ordering is what guarantees the webview hears the proxy's verdict before it
// gives up, instead of timing out while the frame is still about to be written.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sandpane_protocol::{Method, RpcRequest, PROTOCOL_VERSION};
use serde::Serialize;

/// Mirrors `sandpane_service::MAX_FRAME_BYTES`. A frame over the cap is refused
/// rather than buffered (AGENTS.md §Code Review rule 9).
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Mirrors `rpc-request.schema.json` (`id` maxLength 128).
const MAX_ID_CHARS: usize = 128;

/// Default total budget for one proxied request, retry included. Every
/// per-method budget in [`proxy_deadline_ms`] MUST stay below the webview's
/// timeout for the same method (`requestTimeoutFor` in core-client.ts) —
/// `tests/proxy-contract.test.ts` parses both and checks every method.
pub const PROXY_DEADLINE_MS: u64 = 12_000;

/// Pause before the single retry a read-only method may get (a Core restart
/// needs a moment to re-bind its socket).
const RETRY_DELAY: Duration = Duration::from_millis(150);

/// Per-method proxy budget. Core's `sandbox.create` may legitimately run up to
/// 300 s (image pull) and `sandbox.list` up to 30 s; `sandbox.stop` (stop plus
/// the `ls --json` re-query) up to about 330 s, and `sandbox.remove` step 2
/// (identity re-check plus `rm --force`) a little longer. `project.create` and
/// `project.add_repository` canonicalize a repository path with git, which may
/// take up to 30 s. Everything else answers well inside the default.
pub fn proxy_deadline_ms(method: Method) -> u64 {
    match method {
        Method::SandboxCreate => 320_000,
        Method::SandboxList => 40_000,
        Method::SandboxStop => 350_000,
        Method::SandboxRemove => 390_000,
        // A repository path goes through Core's git canonicalization, which may
        // take up to 30 s (`project.create`, A3a `project.add_repository`).
        Method::ProjectCreate => 43_000,
        Method::ProjectAddRepository => 43_000,
        _ => PROXY_DEADLINE_MS,
    }
}

/// Methods with no server-side effect, so re-sending one after a failed exchange
/// is safe. Everything else must never be re-issued blindly: once the frame is
/// written, Core may already have executed it — retrying `conversation.send`
/// would append a second message row and queue a second task, and retrying
/// `git.apply` would re-run an apply the user only confirmed once
/// (docs/specs/06 §10).
///
/// A2 added optional idempotency keys to `sandbox.create` and
/// `conversation.send` (advertised as the `idempotency-keys` feature): within
/// 24 h a keyed request Core already finished is answered from its stored
/// result, never run twice. Auto-replay still stays OFF here (design
/// 2026-10-09 §3.1 item 10): this proxy cannot tell whether a frame carries a
/// key, a pre-A2 Core silently drops the field, and a pruned key would run
/// again. The webview offers an explicit "Retry safely" with the same key
/// instead; making keyed writes auto-replayable is a later, separately
/// reviewed step.
///
/// `task.cancel` is deliberately excluded even though it is idempotent in effect:
/// Core answers the second cancel with `CONFLICT`, which would surface to the user
/// as a spurious failure of an operation that already succeeded.
///
/// `sandbox.stop` and `sandbox.remove` (A1) are excluded too. Stop changes the
/// sandbox; remove's step 1 mints a single-use confirmation token in Core and
/// step 2 removes the sandbox, so neither step may ever be re-sent blindly.
///
/// The six A3a project-lifecycle methods (`project.update`, `project.archive`,
/// `project.unarchive`, `project.delete`, `project.add_repository`,
/// `project.remove_repository`) are excluded too: each writes Core's database,
/// and `project.delete`'s step 1 mints a single-use token while step 2 deletes.
/// Archive/unarchive are idempotent in effect, but a blind re-send would still
/// hide a lost answer from the user, so they follow the same rule.
///
/// The five A3b conversation-lifecycle methods (`conversation.rename`,
/// `conversation.archive`, `conversation.unarchive`, `conversation.delete`,
/// `conversation.export`) are excluded as well (design 2026-10-09 §3.3 item 9):
/// the first four write Core's database, `conversation.delete`'s step 1 mints a
/// single-use token and step 2 deletes, and `conversation.export` — a read —
/// stays out for uniformity, so a lost export answer is surfaced, not re-sent.
///
/// `src/lib/core-client.ts` mirrors this list as `REPLAY_SAFE_METHODS`; the
/// drift test parses this `matches!` and fails if the two ever differ.
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
#[serde(rename_all = "camelCase")]
pub struct ProxyError {
    /// Stable machine-readable code; the UI maps it to copy.
    pub code: &'static str,
    pub message: String,
    /// True when a state-changing frame reached Core but its answer was lost
    /// (timeout, dropped connection, misaligned or malformed reply). The UI must
    /// then tell the user to RE-READ state rather than retry, because Core may
    /// already have applied it. Always false for read-only methods and for
    /// failures that happened before the frame was fully written.
    pub may_have_been_applied: bool,
}

impl ProxyError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            may_have_been_applied: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Socket path policy
// ---------------------------------------------------------------------------

/// Socket path policy — the same precedence and directory layout as
/// `clients/vscode/src/core-client/paths.ts` (`coreSocketPath`/`coreDataDir`):
/// a non-blank `SANDPANE_SOCKET` (trimmed) wins; otherwise
/// `~/Library/Application Support/sandpane/sandpane.sock` on macOS and
/// `$XDG_STATE_HOME/sandpane/sandpane.sock` (blank `XDG_STATE_HOME` → `~/.local/state`)
/// elsewhere; an empty `HOME` falls back to `/tmp`. NEVER TCP.
///
/// Values that are not valid UTF-8 are treated as unset, exactly as the
/// string-typed VS Code resolver would see them.
pub fn socket_path() -> PathBuf {
    let var = |name: &str| std::env::var_os(name).and_then(|v| v.into_string().ok());
    resolve_socket_path(
        var("SANDPANE_SOCKET").as_deref(),
        var("XDG_STATE_HOME").as_deref(),
        var("HOME").as_deref(),
        cfg!(target_os = "macos"),
    )
}

/// Pure resolver behind [`socket_path`], so the policy is testable without
/// mutating process environment (Rust tests run on parallel threads).
pub fn resolve_socket_path(
    sandpane_socket: Option<&str>,
    xdg_state_home: Option<&str>,
    home: Option<&str>,
    macos: bool,
) -> PathBuf {
    if let Some(explicit) = non_blank(sandpane_socket) {
        return PathBuf::from(explicit);
    }
    let home = non_empty(home).unwrap_or("/tmp");
    let data_dir = if macos {
        Path::new(home).join("Library/Application Support/sandpane")
    } else {
        let base = non_blank(xdg_state_home)
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(home).join(".local/state"));
        base.join("sandpane")
    };
    data_dir.join("sandpane.sock")
}

fn non_blank(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketStatus {
    pub path: String,
    pub exists: bool,
    /// False on platforms where this scaffold has no transport at all.
    pub transport_supported: bool,
}

/// Read-only metadata for the Settings/diagnostics view. Does not connect, so it
/// cannot disturb the single-instance handshake that Core owns. Registered but,
/// per `capabilities/default.json`, NOT granted to the main window until a view
/// actually calls it.
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
// Socket trust check (before every connect)
// ---------------------------------------------------------------------------

/// The trust verdict over an `lstat` of the socket path: it must be a socket
/// (not a symlink to one, not a regular file), owned by the current user, and
/// carry no group/other permission bits — the 0600 `sandpane-service` sets.
/// Anything else may be another user's listener, so the proxy refuses to send
/// frames (which can carry prompt text and repository paths) to it.
fn socket_trust_verdict(
    is_socket: bool,
    owner_uid: u32,
    mode: u32,
    expected_uid: u32,
) -> Result<(), ProxyError> {
    if !is_socket {
        return Err(ProxyError::new(
            "SOCKET_UNTRUSTED",
            "the Core socket path is not a Unix socket (a symlink, file or directory is never followed)",
        ));
    }
    if owner_uid != expected_uid {
        return Err(ProxyError::new(
            "SOCKET_UNTRUSTED",
            format!(
                "the Core socket is owned by uid {owner_uid}, not by this user (uid {expected_uid}); \
                 refusing to send frames to another user's listener"
            ),
        ));
    }
    if mode & 0o077 != 0 {
        return Err(ProxyError::new(
            "SOCKET_UNTRUSTED",
            format!(
                "the Core socket has mode {:o}; it must not be accessible to group or others (expected 600)",
                mode & 0o777
            ),
        ));
    }
    Ok(())
}

/// `lstat` the path and apply [`socket_trust_verdict`]. There is a residual
/// window between this check and `connect` (a same-user attacker could swap the
/// path); peer-credential checks on the connected socket are the full fix and
/// are tracked separately.
#[cfg(unix)]
fn check_socket(path: &Path) -> Result<(), ProxyError> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};

    let meta = std::fs::symlink_metadata(path).map_err(|err| {
        ProxyError::new(
            "CORE_UNREACHABLE",
            format!(
                "no Core socket at {}: {err}. Start sandpane-service; this shell never launches a \
                 Core of its own.",
                path.display()
            ),
        )
    })?;
    // SAFETY: `getuid` has no preconditions, never fails and touches no memory.
    let uid = unsafe { libc::getuid() };
    socket_trust_verdict(meta.file_type().is_socket(), meta.uid(), meta.mode(), uid)
}

// ---------------------------------------------------------------------------
// Frame validation (shared by every platform)
// ---------------------------------------------------------------------------

/// A request that passed validation. `payload` is the exact line (without its
/// single trailing newline) that will be written — the bytes that were parsed,
/// never a re-serialization (re-encoding would sort keys and could change what
/// Core sees versus what was validated).
#[derive(Debug)]
struct ValidatedFrame<'a> {
    payload: &'a str,
    request: RpcRequest,
    method: Method,
}

/// Validate one request frame before it may touch the socket.
fn validate_frame(line: &str) -> Result<ValidatedFrame<'_>, ProxyError> {
    // Exactly one optional trailing newline; any other CR/LF would make Core's
    // line reader see more than one frame (frame smuggling: a replay-safe
    // `system.probe` hiding a `git.apply` on its second line).
    let payload = line.strip_suffix('\n').unwrap_or(line);
    // The cap applies to what goes on the wire — payload PLUS its newline —
    // because that is what Core's bounded `read_line` counts.
    let wire_len = payload.len() + 1;
    if wire_len > MAX_FRAME_BYTES {
        return Err(ProxyError::new(
            "FRAME_TOO_LARGE",
            format!(
                "frame of {wire_len} bytes (with its newline) exceeds the {MAX_FRAME_BYTES} byte cap"
            ),
        ));
    }
    if payload.contains(['\r', '\n']) {
        return Err(ProxyError::new(
            "VALIDATION_FAILED",
            "a frame must be exactly one line: CR/LF is only allowed as the single trailing newline",
        ));
    }
    let request: RpcRequest = serde_json::from_str(payload).map_err(|err| {
        ProxyError::new(
            "VALIDATION_FAILED",
            format!("frame is not an RpcRequest: {err}"),
        )
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
    let method = Method::parse(&request.method).ok_or_else(|| {
        ProxyError::new(
            "METHOD_NOT_ALLOWED",
            format!(
                "\"{}\" is not an allowlisted Sandpane Core method",
                request.method
            ),
        )
    })?;
    Ok(ValidatedFrame {
        payload,
        request,
        method,
    })
}

/// Structural check of the answer: an object with `v`, the SAME `id` the request
/// carried, and exactly one of `ok`/`err`. A different id means the stream is not
/// aligned with this request, so the answer is never handed to the webview as if
/// it were this request's result.
fn validate_response(line: &str, expected_id: &str) -> Result<(), ProxyError> {
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|err| ProxyError::new("MALFORMED_FRAME", format!("not JSON: {err}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| ProxyError::new("MALFORMED_FRAME", "response is not an object"))?;
    if object
        .get("v")
        .and_then(serde_json::Value::as_u64)
        .is_none()
    {
        return Err(ProxyError::new("MALFORMED_FRAME", "response is missing v"));
    }
    let id = object
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ProxyError::new("MALFORMED_FRAME", "response is missing id"))?;
    // Core answers a connection-level refusal (peer is another OS user, frame
    // over the cap) with an `err` frame carrying an EMPTY id, before handling
    // any request. Report it as itself — it was not applied.
    if id.is_empty() {
        if let Some(err) = object.get("err") {
            let code = err
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?");
            let message = err
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            return Err(ProxyError::new(
                "CORE_REFUSED_CONNECTION",
                format!(
                    "Core refused the connection before handling the request ({code}: {message})"
                ),
            ));
        }
    }
    if id != expected_id {
        let message = format!(
            "Core answered id \"{id}\" to request \"{expected_id}\"; the answer was dropped"
        );
        return Err(ProxyError::new("RESPONSE_ID_MISMATCH", message));
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

/// Mark an error that happened after a state-changing frame was written.
fn after_write(method: Method, mut err: ProxyError) -> ProxyError {
    if !replay_safe(method) {
        err.may_have_been_applied = true;
        err.message = format!(
            "{} — the request had already been delivered to Core, so it may have been applied. \
             Re-read state before retrying.",
            err.message
        );
    }
    err
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Forward one validated request frame; return the response line verbatim.
///
/// `async` + `spawn_blocking`: the socket exchange runs on a blocking worker, so
/// the main (UI/event-loop) thread is never parked on a Core read.
#[tauri::command]
pub async fn core_request_frame(line: String) -> Result<String, ProxyError> {
    // `None`: the budget comes from the validated method (`proxy_deadline_ms`).
    tauri::async_runtime::spawn_blocking(move || proxy_frame(&line, &socket_path(), None))
        .await
        .map_err(|err| ProxyError::new("INTERNAL", format!("proxy worker failed: {err}")))?
}

/// Windows named pipes are a P1 transport deliverable in the Core service, which
/// serves Unix sockets only. This shell says so instead of pretending: no
/// fallback TCP, no local reimplementation of the protocol.
#[cfg(not(unix))]
fn proxy_frame(line: &str, _path: &Path, _budget: Option<Duration>) -> Result<String, ProxyError> {
    // Still validate before refusing, so a bad frame is reported as itself
    // rather than masked by the platform message.
    validate_frame(line)?;
    Err(ProxyError::new(
        "TRANSPORT_UNSUPPORTED",
        "this build attaches to Core over a Unix domain socket; the named-pipe transport is a P1 \
         Core deliverable and is not implemented here",
    ))
}

/// Validate, then exchange one frame with Core under a single deadline.
#[cfg(unix)]
fn proxy_frame(line: &str, path: &Path, budget: Option<Duration>) -> Result<String, ProxyError> {
    let frame = validate_frame(line)?;
    let budget = budget.unwrap_or_else(|| Duration::from_millis(proxy_deadline_ms(frame.method)));
    let deadline = std::time::Instant::now() + budget;
    let attempts = if replay_safe(frame.method) { 2 } else { 1 };
    let mut last: Option<ProxyError> = None;
    for attempt in 0..attempts {
        if attempt > 0 {
            // Brief pause before the single retry, never past the deadline.
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left <= RETRY_DELAY {
                break;
            }
            std::thread::sleep(RETRY_DELAY);
        }
        match exchange(path, &frame, deadline, budget) {
            Ok(response) => return Ok(response),
            // Only a FAST failure of a read-only method is retried (socket
            // missing or refusing, the write broke, or Core closed before
            // answering — e.g. a Core restart). A timeout is never retried.
            Err(Failure::Retryable(err)) => last = Some(err),
            Err(Failure::Final(err)) => return Err(err),
        }
    }
    Err(last.unwrap_or_else(|| ProxyError::new("INTERNAL", "no attempt was made")))
}

#[cfg(unix)]
enum Failure {
    Retryable(ProxyError),
    Final(ProxyError),
}

#[cfg(unix)]
fn exchange(
    path: &Path,
    frame: &ValidatedFrame<'_>,
    deadline: std::time::Instant,
    budget: Duration,
) -> Result<String, Failure> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    let method = frame.method;
    let remaining = |what: &str| -> Result<Duration, ProxyError> {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            Err(ProxyError::new(
                "TIMEOUT",
                format!(
                    "Core did not answer {} within the {} ms proxy budget ({what})",
                    frame.request.method,
                    budget.as_millis()
                ),
            ))
        } else {
            Ok(left)
        }
    };

    // A failure that is safe to retry for a read-only method, and final (with
    // the "may have been applied" flag when anything was written) otherwise.
    let retry_if_read = |err: ProxyError| {
        if replay_safe(method) {
            Failure::Retryable(err)
        } else {
            Failure::Final(after_write(method, err))
        }
    };

    // --- before anything is written: failures are safe to report as "not sent"
    check_socket(path).map_err(|err| {
        // A missing socket is what a Core restart looks like for a moment; an
        // UNTRUSTED socket is never retried.
        if err.code == "CORE_UNREACHABLE" && replay_safe(method) {
            Failure::Retryable(err)
        } else {
            Failure::Final(err)
        }
    })?;
    let mut stream = UnixStream::connect(path).map_err(|err| {
        Failure::Retryable(ProxyError::new(
            "CORE_UNREACHABLE",
            format!(
                "could not connect to the Core socket at {}: {err}. Start sandpane-service; this \
                 shell never launches a Core of its own.",
                path.display()
            ),
        ))
    })?;
    let left = remaining("before write").map_err(Failure::Final)?;
    stream.set_write_timeout(Some(left)).map_err(|err| {
        Failure::Final(ProxyError::new(
            "INTERNAL",
            format!("set_write_timeout: {err}"),
        ))
    })?;
    let mut bytes = Vec::with_capacity(frame.payload.len() + 1);
    bytes.extend_from_slice(frame.payload.as_bytes());
    bytes.push(b'\n');
    // A failed `write_all` is NOT proof that nothing was delivered: Core's
    // reader handles a final UNTERMINATED line at EOF, so if every payload byte
    // arrived before the break, Core may have executed it without the newline.
    stream.write_all(&bytes).map_err(|err| {
        retry_if_read(ProxyError::new(
            "WRITE_FAILED",
            format!("socket write failed part-way: {err}"),
        ))
    })?;

    // --- after the write: Core may have acted on a state-changing frame
    let mut line: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let left = remaining("waiting for the answer")
            .map_err(|err| Failure::Final(after_write(method, err)))?;
        stream.set_read_timeout(Some(left)).map_err(|err| {
            Failure::Final(after_write(
                method,
                ProxyError::new("INTERNAL", format!("set_read_timeout: {err}")),
            ))
        })?;
        let read = match stream.read(&mut chunk) {
            Ok(n) => n,
            Err(err)
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut =>
            {
                return Err(Failure::Final(after_write(
                    method,
                    ProxyError::new(
                        "TIMEOUT",
                        format!(
                            "Core did not answer {} within the {} ms proxy budget",
                            frame.request.method,
                            budget.as_millis()
                        ),
                    ),
                )));
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => {
                return Err(Failure::Final(after_write(
                    method,
                    ProxyError::new("READ_FAILED", format!("socket read: {err}")),
                )))
            }
        };
        if read == 0 {
            // Not "unreachable": the frame was written, so this is a lost
            // answer. With nothing back, a read-only method may retry once (the
            // shape a Core restart produces); a mutation is flagged.
            let err = ProxyError::new(
                "CONNECTION_CLOSED",
                "Core closed the connection before answering",
            );
            return Err(if line.is_empty() {
                retry_if_read(err)
            } else {
                Failure::Final(after_write(method, err))
            });
        }
        let received = &chunk[..read];
        if let Some(newline) = received.iter().position(|b| *b == b'\n') {
            line.extend_from_slice(&received[..newline]);
            if line.len() > MAX_FRAME_BYTES {
                return Err(Failure::Final(after_write(
                    method,
                    ProxyError::new("FRAME_TOO_LARGE", "Core answered with a frame over the cap"),
                )));
            }
            break;
        }
        line.extend_from_slice(received);
        // Bounded read: never buffer past the cap waiting for a newline.
        if line.len() > MAX_FRAME_BYTES {
            return Err(Failure::Final(after_write(
                method,
                ProxyError::new("FRAME_TOO_LARGE", "Core answered with a frame over the cap"),
            )));
        }
    }

    let response = String::from_utf8(line).map_err(|_| {
        Failure::Final(after_write(
            method,
            ProxyError::new(
                "MALFORMED_FRAME",
                "Core answered with a frame that is not UTF-8",
            ),
        ))
    })?;
    validate_response(&response, &frame.request.id).map_err(|err| {
        // Core's empty-id refusal is sent before any request is handled
        // (peer-uid check, over-cap frame), so it is known NOT to be applied.
        if err.code == "CORE_REFUSED_CONNECTION" {
            Failure::Final(err)
        } else {
            Failure::Final(after_write(method, err))
        }
    })?;
    Ok(response)
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
        // One trailing newline is the frame terminator, not an error.
        assert!(validate_frame(&format!("{}\n", frame("system.probe"))).is_ok());
    }

    /// The proxy holds no method list of its own: `validate_frame` asks
    /// `sandpane_protocol::Method::parse`, so the ADDITIVE-v1 reads are forwarded
    /// the moment Core's crate gains them — and this shell can never advertise a
    /// method Core does not dispatch.
    #[test]
    fn additive_v1_reads_are_forwarded() {
        for method in [
            "task.list",
            "conversation.list",
            "conversation.history",
            "sandbox.stop",
            "sandbox.remove",
            "project.update",
            "project.archive",
            "project.unarchive",
            "project.delete",
            "project.add_repository",
            "project.remove_repository",
            "conversation.rename",
            "conversation.archive",
            "conversation.unarchive",
            "conversation.delete",
            "conversation.export",
        ] {
            assert!(
                validate_frame(&frame(method)).is_ok(),
                "{method} must be allowlisted because Core's crate parses it"
            );
        }
        assert_eq!(Method::ALL.len(), 27);
        // Wire names are lowercase snake_case segments; camelCase is not a method.
        assert_eq!(
            validate_frame(&frame("project.addRepository"))
                .unwrap_err()
                .code,
            "METHOD_NOT_ALLOWED"
        );
        // sbx v0.47 has no `start`; the crate does not parse one, so neither does the proxy.
        assert_eq!(
            validate_frame(&frame("sandbox.start")).unwrap_err().code,
            "METHOD_NOT_ALLOWED"
        );
    }

    #[test]
    fn validated_frame_carries_the_parsed_method() {
        let line = frame("git.apply");
        let validated = validate_frame(&line).unwrap();
        assert_eq!(validated.method, Method::GitApply);
        assert!(!replay_safe(validated.method));
    }

    /// Frame smuggling: a CR or LF anywhere before the single trailing newline
    /// would let Core's line reader see a second frame.
    #[test]
    fn embedded_cr_or_lf_is_refused() {
        let smuggled = format!(
            "{}\n{}",
            frame("system.probe"),
            r#"{"v":1,"id":"x","method":"git.apply","params":{"taskId":"t"}}"#
        );
        // JSON whitespace may legally contain a newline; the frame still is two lines to Core.
        let whitespace_newline = r#"{"v":1,"id":"desk-1",
"method":"system.probe","params":{}}"#;
        let cr =
            r#"{"v":1,"id":"desk-1",\r"method":"system.probe","params":{}}"#.replace("\\r", "\r");
        let crlf_terminated = format!("{}\r\n", frame("system.probe"));
        let double_newline = format!("{}\n\n", frame("system.probe"));
        for line in [
            smuggled.as_str(),
            whitespace_newline,
            cr.as_str(),
            crlf_terminated.as_str(),
            double_newline.as_str(),
        ] {
            let err = validate_frame(line).expect_err("must refuse an embedded CR/LF");
            assert_eq!(err.code, "VALIDATION_FAILED", "{line:?}");
        }
    }

    #[test]
    fn duplicate_method_keys_are_refused() {
        let line = r#"{"v":1,"id":"a","method":"system.probe","method":"git.apply","params":{}}"#;
        assert_eq!(validate_frame(line).unwrap_err().code, "VALIDATION_FAILED");
    }

    /// The bytes written are the bytes validated, never a re-serialization.
    #[test]
    fn payload_is_the_exact_validated_line() {
        let line = format!(
            r#"{{"v":{PROTOCOL_VERSION},"id":"desk-2","method":"task.subscribe","params":{{"projectId":"p1","afterSequence":0,"afterSequences":{{"t-b":11,"t-a":4}}}}}}"#
        );
        let with_newline = format!("{line}\n");
        let validated = validate_frame(&with_newline).expect("cursor map must validate");
        assert_eq!(validated.payload, line);
        assert_eq!(validated.request.params["afterSequences"]["t-a"], 4);
        assert_eq!(validated.request.params["afterSequences"]["t-b"], 11);
    }

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
        for m in [
            Method::ProjectCreate,
            Method::SandboxCreate,
            Method::ConversationCreate,
            Method::ConversationSend,
            Method::GitApply,
            Method::TaskCancel,
            Method::SandboxStop,
            Method::SandboxRemove,
            Method::ProjectUpdate,
            Method::ProjectArchive,
            Method::ProjectUnarchive,
            Method::ProjectDelete,
            Method::ProjectAddRepository,
            Method::ProjectRemoveRepository,
            Method::ConversationRename,
            Method::ConversationArchive,
            Method::ConversationUnarchive,
            Method::ConversationDelete,
            Method::ConversationExport,
        ] {
            assert!(!replay_safe(m), "{m:?} must never be re-sent");
        }
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

    /// The cap counts the wire bytes, newline included, as Core's reader does.
    #[test]
    fn frame_cap_counts_the_trailing_newline() {
        let shell = format!(
            r#"{{"v":{PROTOCOL_VERSION},"id":"a","method":"system.probe","params":{{"x":""}}}}"#
        );
        let fill = |total_payload: usize| {
            let pad = "x".repeat(total_payload - shell.len());
            format!(
                r#"{{"v":{PROTOCOL_VERSION},"id":"a","method":"system.probe","params":{{"x":"{pad}"}}}}"#
            )
        };
        let at_cap = fill(MAX_FRAME_BYTES); // payload == cap → wire == cap + 1
        assert_eq!(at_cap.len(), MAX_FRAME_BYTES);
        assert_eq!(validate_frame(&at_cap).unwrap_err().code, "FRAME_TOO_LARGE");
        assert_eq!(
            validate_frame(&format!("{at_cap}\n")).unwrap_err().code,
            "FRAME_TOO_LARGE"
        );
        let fits = fill(MAX_FRAME_BYTES - 1); // wire == cap exactly
        assert!(validate_frame(&fits).is_ok());
        assert!(validate_frame(&format!("{fits}\n")).is_ok());
    }

    #[test]
    fn long_running_methods_get_their_own_budget() {
        assert_eq!(proxy_deadline_ms(Method::SandboxCreate), 320_000);
        assert_eq!(proxy_deadline_ms(Method::SandboxList), 40_000);
        assert_eq!(proxy_deadline_ms(Method::SandboxStop), 350_000);
        assert_eq!(proxy_deadline_ms(Method::SandboxRemove), 390_000);
        assert_eq!(proxy_deadline_ms(Method::GitApply), PROXY_DEADLINE_MS);
        assert_eq!(proxy_deadline_ms(Method::SystemProbe), PROXY_DEADLINE_MS);
        // A3a: the project-lifecycle DB writes keep the default budget …
        for m in [
            Method::ProjectUpdate,
            Method::ProjectArchive,
            Method::ProjectUnarchive,
            Method::ProjectDelete,
            Method::ProjectRemoveRepository,
            // A3b: the five conversation-lifecycle methods are Core DB work
            // (export redacts after the DB lock is released) — default budget.
            Method::ConversationRename,
            Method::ConversationArchive,
            Method::ConversationUnarchive,
            Method::ConversationDelete,
            Method::ConversationExport,
        ] {
            assert_eq!(proxy_deadline_ms(m), PROXY_DEADLINE_MS, "{m:?}");
        }
        // … but a repository path goes through Core's git canonicalization (up
        // to 30 s), for project.create and project.add_repository alike.
        assert_eq!(proxy_deadline_ms(Method::ProjectCreate), 43_000);
        assert_eq!(proxy_deadline_ms(Method::ProjectAddRepository), 43_000);
    }

    #[test]
    fn response_shape_requires_exactly_one_outcome() {
        assert!(validate_response(r#"{"v":1,"id":"a","ok":{}}"#, "a").is_ok());
        assert!(validate_response(
            r#"{"v":1,"id":"a","err":{"code":"INTERNAL","message":"m"}}"#,
            "a"
        )
        .is_ok());
        assert!(validate_response(r#"{"v":1,"id":"a"}"#, "a").is_err());
        assert!(validate_response(r#"{"v":1,"id":"a","ok":{},"err":{}}"#, "a").is_err());
        assert!(validate_response(r#"not json"#, "a").is_err());
    }

    #[test]
    fn response_for_another_request_is_refused() {
        let err = validate_response(r#"{"v":1,"id":"other","ok":{}}"#, "mine").unwrap_err();
        assert_eq!(err.code, "RESPONSE_ID_MISMATCH");
        assert_eq!(
            validate_response(r#"{"v":1,"ok":{}}"#, "mine")
                .unwrap_err()
                .code,
            "MALFORMED_FRAME"
        );
    }

    #[test]
    fn lost_answer_to_a_mutation_says_it_may_have_been_applied() {
        let mutated = after_write(Method::GitApply, ProxyError::new("TIMEOUT", "t"));
        assert!(mutated.may_have_been_applied);
        assert!(mutated.message.contains("may have been applied"));
        assert!(mutated.message.contains("Re-read state"));
        // A1: a lost stop, or either step of the two-step remove, is never a
        // plain timeout that invites a blind retry.
        for m in [Method::SandboxStop, Method::SandboxRemove] {
            let lost = after_write(m, ProxyError::new("TIMEOUT", "t"));
            assert!(lost.may_have_been_applied, "{m:?}");
        }
        let read = after_write(Method::TaskList, ProxyError::new("TIMEOUT", "t"));
        assert!(!read.may_have_been_applied);
        assert_eq!(read.message, "t");
    }

    #[test]
    fn proxy_error_serializes_camel_case_for_the_webview() {
        let json = serde_json::to_value(ProxyError::new("TIMEOUT", "m")).unwrap();
        assert_eq!(json["code"], "TIMEOUT");
        assert_eq!(json["mayHaveBeenApplied"], false);
    }

    // --- socket path policy (mirrors clients/vscode/src/core-client/paths.ts) ---

    #[test]
    fn socket_path_matches_the_vscode_client_on_every_branch() {
        type Case<'a> = (
            Option<&'a str>,
            Option<&'a str>,
            Option<&'a str>,
            bool,
            &'a str,
        );
        let cases: [Case; 9] = [
            // explicit override wins, trimmed
            (
                Some("/x/s.sock"),
                Some("/st"),
                Some("/h"),
                false,
                "/x/s.sock",
            ),
            (Some("  /x/s.sock "), None, Some("/h"), true, "/x/s.sock"),
            // blank override is ignored
            (
                Some("   "),
                Some("/st"),
                Some("/h"),
                false,
                "/st/sandpane/sandpane.sock",
            ),
            // Linux/BSD: XDG_STATE_HOME + /sandpane
            (
                None,
                Some("/st"),
                Some("/h"),
                false,
                "/st/sandpane/sandpane.sock",
            ),
            (
                None,
                Some(" /st "),
                Some("/h"),
                false,
                "/st/sandpane/sandpane.sock",
            ),
            // blank XDG falls back to ~/.local/state
            (
                None,
                Some(""),
                Some("/h"),
                false,
                "/h/.local/state/sandpane/sandpane.sock",
            ),
            (
                None,
                None,
                Some("/h"),
                false,
                "/h/.local/state/sandpane/sandpane.sock",
            ),
            // macOS ignores XDG
            (
                None,
                Some("/st"),
                Some("/h"),
                true,
                "/h/Library/Application Support/sandpane/sandpane.sock",
            ),
            // empty HOME → /tmp
            (
                None,
                None,
                Some(""),
                false,
                "/tmp/.local/state/sandpane/sandpane.sock",
            ),
        ];
        for (sock, xdg, home, macos, want) in cases {
            assert_eq!(
                resolve_socket_path(sock, xdg, home, macos),
                PathBuf::from(want),
                "{sock:?} {xdg:?} {home:?} macos={macos}"
            );
        }
        assert_eq!(
            resolve_socket_path(None, None, None, true),
            PathBuf::from("/tmp/Library/Application Support/sandpane/sandpane.sock")
        );
    }

    // --- socket trust verdict ---

    #[test]
    fn trust_verdict_requires_own_private_socket() {
        assert!(socket_trust_verdict(true, 501, 0o140600, 501).is_ok());
        assert!(socket_trust_verdict(true, 501, 0o140700, 501).is_ok());
        for (is_socket, uid, mode) in [
            (false, 501, 0o100600), // regular file
            (true, 0, 0o140600),    // another user's socket
            (true, 501, 0o140660),  // group-writable
            (true, 501, 0o140604),  // world-readable
            (true, 501, 0o140755),
        ] {
            let err = socket_trust_verdict(is_socket, uid, mode, 501).unwrap_err();
            assert_eq!(err.code, "SOCKET_UNTRUSTED", "{is_socket} {uid} {mode:o}");
        }
    }

    // --- end-to-end against a fake Core listener on a real Unix socket ---

    #[cfg(unix)]
    mod socket {
        use super::super::*;
        use super::frame;
        use std::io::{BufRead, BufReader, Read, Write};
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixListener;
        use std::sync::atomic::{AtomicUsize, Ordering};

        static COUNTER: AtomicUsize = AtomicUsize::new(0);

        /// Short path under /tmp: macOS caps `sun_path` at 104 bytes and the
        /// default temp dir under /var/folders is already long.
        struct TempSock {
            dir: PathBuf,
            path: PathBuf,
        }

        impl TempSock {
            fn new() -> Self {
                let n = COUNTER.fetch_add(1, Ordering::SeqCst);
                let dir = PathBuf::from(format!("/tmp/spd-{}-{n}", std::process::id()));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
                let path = dir.join("s.sock");
                Self { dir, path }
            }
        }

        impl Drop for TempSock {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }

        /// What the fake Core does with the Nth connection's request line.
        enum Reply {
            Answer(String),
            /// Keep the connection open and never answer.
            Hold,
            /// Close without answering (a Core restart / early EOF).
            Close,
        }

        fn bind(path: &Path) -> UnixListener {
            let listener = UnixListener::bind(path).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
            listener.set_nonblocking(true).unwrap();
            listener
        }

        /// Accept connections on `listener` for `window`, answering connection
        /// N with `reply(N, request_line)`. Returns every request line received,
        /// so a test proves how many times a frame was written by JOINING it.
        fn serve_on(
            listener: UnixListener,
            window: Duration,
            reply: fn(usize, &str) -> Reply,
        ) -> std::thread::JoinHandle<Vec<String>> {
            std::thread::spawn(move || {
                let until = std::time::Instant::now() + window;
                let mut seen = Vec::new();
                let mut held = Vec::new();
                while std::time::Instant::now() < until {
                    let stream = match listener.accept() {
                        Ok((stream, _)) => stream,
                        Err(_) => {
                            std::thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                    };
                    stream.set_nonblocking(false).unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    let n = seen.len();
                    seen.push(line.clone());
                    match reply(n, line.trim_end_matches('\n')) {
                        Reply::Answer(answer) => {
                            let mut w = stream;
                            w.write_all(answer.as_bytes()).unwrap();
                            w.write_all(b"\n").unwrap();
                        }
                        Reply::Hold => held.push(stream),
                        Reply::Close => drop(stream),
                    }
                }
                drop(held);
                seen
            })
        }

        fn serve(
            sock: &TempSock,
            window: Duration,
            reply: fn(usize, &str) -> Reply,
        ) -> std::thread::JoinHandle<Vec<String>> {
            serve_on(bind(&sock.path), window, reply)
        }

        fn ok_for(request: &str) -> String {
            let value: serde_json::Value = serde_json::from_str(request).unwrap();
            format!(r#"{{"v":1,"id":{},"ok":{{}}}}"#, value["id"])
        }

        fn echo_ok(_n: usize, request: &str) -> Reply {
            Reply::Answer(ok_for(request))
        }

        fn wrong_id(_n: usize, _request: &str) -> Reply {
            Reply::Answer(r#"{"v":1,"id":"someone-else","ok":{}}"#.to_string())
        }

        fn silent(_n: usize, _request: &str) -> Reply {
            Reply::Hold
        }

        fn close_first_then_answer(n: usize, request: &str) -> Reply {
            if n == 0 {
                Reply::Close
            } else {
                Reply::Answer(ok_for(request))
            }
        }

        fn refuse_connection(_n: usize, _request: &str) -> Reply {
            Reply::Answer(
                r#"{"v":1,"id":"","err":{"code":"PERMISSION_DENIED","message":"peer is not the Core's OS user"}}"#
                    .to_string(),
            )
        }

        fn git_apply() -> String {
            r#"{"v":1,"id":"desk-9","method":"git.apply","params":{"taskId":"t"}}"#.to_string()
        }

        #[test]
        fn forwards_the_exact_line_and_returns_the_matching_answer() {
            let sock = TempSock::new();
            let server = serve(&sock, Duration::from_millis(300), echo_ok);
            let line = frame("system.probe");
            let answer = proxy_frame(&line, &sock.path, Some(Duration::from_secs(5))).unwrap();
            assert_eq!(answer, r#"{"v":1,"id":"desk-1","ok":{}}"#);
            assert_eq!(server.join().unwrap(), vec![format!("{line}\n")]);
        }

        #[test]
        fn an_answer_for_another_id_is_dropped_and_flagged_for_a_mutation() {
            let sock = TempSock::new();
            let server = serve(&sock, Duration::from_millis(400), wrong_id);
            let err =
                proxy_frame(&git_apply(), &sock.path, Some(Duration::from_secs(5))).unwrap_err();
            assert_eq!(err.code, "RESPONSE_ID_MISMATCH");
            assert!(err.may_have_been_applied);
            assert_eq!(
                server.join().unwrap().len(),
                1,
                "a mutation is never re-sent"
            );
        }

        #[test]
        fn a_connection_level_refusal_is_reported_as_itself_and_not_applied() {
            let sock = TempSock::new();
            let _server = serve(&sock, Duration::from_millis(300), refuse_connection);
            let err =
                proxy_frame(&git_apply(), &sock.path, Some(Duration::from_secs(5))).unwrap_err();
            assert_eq!(err.code, "CORE_REFUSED_CONNECTION");
            assert!(err.message.contains("PERMISSION_DENIED"));
            assert!(!err.may_have_been_applied);
        }

        #[test]
        fn a_silent_core_times_a_mutation_out_inside_the_budget_written_once() {
            let sock = TempSock::new();
            let server = serve(&sock, Duration::from_millis(700), silent);
            let started = std::time::Instant::now();
            let err = proxy_frame(&git_apply(), &sock.path, Some(Duration::from_millis(200)))
                .unwrap_err();
            assert!(
                started.elapsed() < Duration::from_millis(550),
                "{:?}",
                started.elapsed()
            );
            assert_eq!(err.code, "TIMEOUT");
            assert!(err.may_have_been_applied);
            assert!(err.message.contains("may have been applied"));
            assert_eq!(
                server.join().unwrap().len(),
                1,
                "a mutation is written exactly once"
            );
        }

        #[test]
        fn a_read_only_timeout_is_not_flagged_and_not_retried() {
            let sock = TempSock::new();
            let server = serve(&sock, Duration::from_millis(700), silent);
            let err = proxy_frame(
                &frame("task.list"),
                &sock.path,
                Some(Duration::from_millis(150)),
            )
            .unwrap_err();
            assert_eq!(err.code, "TIMEOUT");
            assert!(!err.may_have_been_applied);
            assert_eq!(
                server.join().unwrap().len(),
                1,
                "a timeout spends the budget: the read is written once, never retried"
            );
        }

        #[test]
        fn a_read_only_method_is_retried_exactly_once_after_an_early_eof() {
            let sock = TempSock::new();
            let server = serve(&sock, Duration::from_millis(700), close_first_then_answer);
            let line = frame("task.list");
            let answer = proxy_frame(&line, &sock.path, Some(Duration::from_secs(5))).unwrap();
            assert_eq!(answer, r#"{"v":1,"id":"desk-1","ok":{}}"#);
            assert_eq!(server.join().unwrap().len(), 2, "one retry, no more");
        }

        #[test]
        fn a_mutation_is_not_retried_after_an_early_eof_and_is_flagged() {
            let sock = TempSock::new();
            let server = serve(&sock, Duration::from_millis(700), close_first_then_answer);
            let err =
                proxy_frame(&git_apply(), &sock.path, Some(Duration::from_secs(5))).unwrap_err();
            assert_eq!(err.code, "CONNECTION_CLOSED");
            assert!(err.may_have_been_applied);
            assert_eq!(server.join().unwrap().len(), 1);
        }

        /// A1: neither `sandbox.stop` nor either step of `sandbox.remove` is
        /// re-sent after an early EOF — step 1 mints a single-use token in Core.
        #[test]
        fn sandbox_stop_and_remove_are_never_retried_after_an_early_eof() {
            for line in [
                r#"{"v":1,"id":"desk-1","method":"sandbox.stop","params":{"name":"atlas-demo"}}"#,
                r#"{"v":1,"id":"desk-1","method":"sandbox.remove","params":{"name":"atlas-demo"}}"#,
            ] {
                let sock = TempSock::new();
                let server = serve(&sock, Duration::from_millis(700), close_first_then_answer);
                let err = proxy_frame(line, &sock.path, Some(Duration::from_secs(5))).unwrap_err();
                assert_eq!(err.code, "CONNECTION_CLOSED", "{line}");
                assert!(err.may_have_been_applied, "{line}");
                assert_eq!(server.join().unwrap().len(), 1, "{line}: written once");
            }
        }

        #[test]
        fn a_read_only_method_is_retried_once_after_connect_refused() {
            let sock = TempSock::new();
            // A socket file nobody listens on: connect() is refused.
            drop(bind(&sock.path));
            let path = sock.path.clone();
            let replacement = std::thread::spawn(move || {
                // Core "restarts" while the proxy waits RETRY_DELAY.
                std::thread::sleep(Duration::from_millis(40));
                std::fs::remove_file(&path).unwrap();
                serve_on(bind(&path), Duration::from_millis(600), echo_ok)
                    .join()
                    .unwrap()
            });
            let answer = proxy_frame(
                &frame("system.probe"),
                &sock.path,
                Some(Duration::from_secs(5)),
            )
            .unwrap();
            assert_eq!(answer, r#"{"v":1,"id":"desk-1","ok":{}}"#);
            assert_eq!(replacement.join().unwrap().len(), 1);
        }

        #[test]
        fn a_mutation_is_not_retried_after_connect_refused() {
            let sock = TempSock::new();
            drop(bind(&sock.path));
            let err =
                proxy_frame(&git_apply(), &sock.path, Some(Duration::from_secs(2))).unwrap_err();
            assert_eq!(err.code, "CORE_UNREACHABLE");
            // Refused before anything was written: nothing to flag.
            assert!(!err.may_have_been_applied);
        }

        /// W1: Core handles a final UNTERMINATED line at EOF, so a write that
        /// breaks part-way is not proof the mutation was not applied.
        #[test]
        fn a_write_that_breaks_part_way_is_flagged_for_a_mutation() {
            let sock = TempSock::new();
            let listener = bind(&sock.path);
            let server = std::thread::spawn(move || loop {
                if let Ok((stream, _)) = listener.accept() {
                    stream.set_nonblocking(false).unwrap();
                    let mut first = [0u8; 16];
                    let _ = (&stream).read(&mut first);
                    drop(stream); // close while the client is still writing
                    return;
                }
                std::thread::sleep(Duration::from_millis(2));
            });
            // ~2 MiB frame (under the cap) so the write cannot fit the socket buffer.
            let line = format!(
                r#"{{"v":1,"id":"desk-9","method":"git.apply","params":{{"taskId":"t","pad":"{}"}}}}"#,
                "x".repeat(2 * 1024 * 1024)
            );
            let err = proxy_frame(&line, &sock.path, Some(Duration::from_secs(5))).unwrap_err();
            server.join().unwrap();
            assert!(
                err.code == "WRITE_FAILED" || err.code == "CONNECTION_CLOSED",
                "{}: {}",
                err.code,
                err.message
            );
            assert!(err.may_have_been_applied, "{}", err.message);
        }

        #[test]
        fn a_socket_open_to_group_or_others_is_refused_before_connecting() {
            let sock = TempSock::new();
            let _listener = UnixListener::bind(&sock.path).unwrap();
            std::fs::set_permissions(&sock.path, std::fs::Permissions::from_mode(0o666)).unwrap();
            let err = proxy_frame(
                &frame("system.probe"),
                &sock.path,
                Some(Duration::from_secs(1)),
            )
            .unwrap_err();
            assert_eq!(err.code, "SOCKET_UNTRUSTED");
            assert!(!err.may_have_been_applied);
        }

        #[test]
        fn a_regular_file_or_symlink_at_the_path_is_refused() {
            let sock = TempSock::new();
            std::fs::write(&sock.path, b"not a socket").unwrap();
            std::fs::set_permissions(&sock.path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(
                proxy_frame(
                    &frame("system.probe"),
                    &sock.path,
                    Some(Duration::from_secs(1))
                )
                .unwrap_err()
                .code,
                "SOCKET_UNTRUSTED"
            );

            let real = TempSock::new();
            let _listener = bind(&real.path);
            let link = sock.dir.join("link.sock");
            std::os::unix::fs::symlink(&real.path, &link).unwrap();
            assert_eq!(
                proxy_frame(&frame("system.probe"), &link, Some(Duration::from_secs(1)))
                    .unwrap_err()
                    .code,
                "SOCKET_UNTRUSTED",
                "a symlink is never followed"
            );
        }

        #[test]
        fn a_missing_socket_is_unreachable_not_untrusted() {
            let sock = TempSock::new();
            let err = proxy_frame(
                &frame("system.probe"),
                &sock.path,
                Some(Duration::from_secs(1)),
            )
            .unwrap_err();
            assert_eq!(err.code, "CORE_UNREACHABLE");
        }
    }
}
