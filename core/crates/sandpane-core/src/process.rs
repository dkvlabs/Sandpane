//! Bounded subprocess runner shared by the SBX and Git adapters
//! (docs/specs/06 §4, sbx-cli-integration rule 5: timeouts, output caps,
//! process-tree cleanup, no orphaned children).
//!
//! Callers build a [`std::process::Command`] from a fixed program + validated
//! argument vector (never a shell) and hand it to [`run_bounded`], which:
//! - closes stdin (`Stdio::null`) so nothing can ever block on a prompt;
//! - captures stdout/stderr up to a byte cap each, draining (and discarding)
//!   the rest so a chatty child cannot wedge on a full pipe, and reports the
//!   truncation instead of hiding it;
//! - enforces a wall-clock deadline; on expiry the child's whole PROCESS GROUP
//!   is killed (Unix), so a backgrounded grandchild holding the pipe cannot
//!   keep the caller blocked past the deadline.

use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use thiserror::Error;

/// Wall-clock and output limits for one invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunLimits {
    pub timeout: Duration,
    pub max_stdout: usize,
    pub max_stderr: usize,
}

impl RunLimits {
    /// Short read-only probes (`sbx version`, `sbx daemon status --json`).
    /// `system.probe` runs two of these, so 2 × 3 s stays well inside the
    /// clients' 15 s request timeout (vscode `connection.ts`, desktop
    /// `DEFAULT_REQUEST_TIMEOUT_MS`); real `sbx version` answers in ms.
    pub const PROBE: RunLimits = RunLimits {
        timeout: Duration::from_secs(3),
        max_stdout: 64 * 1024,
        max_stderr: 64 * 1024,
    };
    /// Listing / status-class commands.
    pub const QUERY: RunLimits = RunLimits {
        timeout: Duration::from_secs(30),
        max_stdout: 4 * 1024 * 1024,
        max_stderr: 256 * 1024,
    };
    /// Mutations that may pull images or start containers (`sbx create`).
    pub const MUTATION: RunLimits = RunLimits {
        timeout: Duration::from_secs(300),
        max_stdout: 1024 * 1024,
        max_stderr: 1024 * 1024,
    };
}

#[derive(Debug)]
pub struct BoundedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// More stdout was produced than `max_stdout`; the excess was discarded.
    /// Callers that parse stdout MUST refuse truncated output (fail loudly).
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

impl BoundedOutput {
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn stderr_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("could not start process: {0}")]
    Spawn(std::io::Error),
    #[error("process exceeded its {0:?} deadline and was killed")]
    TimedOut(Duration),
    #[error("waiting for process failed: {0}")]
    Wait(std::io::Error),
    /// Reading the child's stdout/stderr failed: the captured output is
    /// incomplete, so it is refused rather than treated as EOF (review S-d).
    #[error("reading process output failed: {0}")]
    Read(std::io::Error),
}

/// Poll interval while waiting for the child; small enough that short probes
/// return promptly, large enough not to spin.
const POLL: Duration = Duration::from_millis(5);

/// Run `cmd` under `limits`. stdin/stdout/stderr are overridden here.
pub fn run_bounded(mut cmd: Command, limits: &RunLimits) -> Result<BoundedOutput, ProcessError> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New process group whose id == the child's pid, so a timeout can
        // kill the whole tree the child spawned (not just the direct child).
        cmd.process_group(0);
    }
    let deadline = Instant::now() + limits.timeout;
    let mut child = cmd.spawn().map_err(ProcessError::Spawn)?;
    let pid = child.id();

    let (out_tx, out_rx) = mpsc::channel();
    let (err_tx, err_rx) = mpsc::channel();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let max_out = limits.max_stdout;
    let max_err = limits.max_stderr;
    std::thread::spawn(move || {
        let _ = out_tx.send(stdout.map(|s| read_capped(s, max_out)));
    });
    std::thread::spawn(move || {
        let _ = err_tx.send(stderr.map(|s| read_capped(s, max_err)));
    });

    // Wait for exit or deadline.
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    kill_tree(&mut child, pid);
                    return Err(ProcessError::TimedOut(limits.timeout));
                }
                std::thread::sleep(POLL);
            }
            Err(e) => {
                kill_tree(&mut child, pid);
                return Err(ProcessError::Wait(e));
            }
        }
    };

    // The child exited, but a descendant may still hold a pipe open. Wait for
    // the readers only until the SAME deadline; past it, kill the group and
    // report a timeout rather than return possibly-incomplete output.
    let remaining = deadline.saturating_duration_since(Instant::now());
    let out = recv_until(&out_rx, remaining);
    let remaining = deadline.saturating_duration_since(Instant::now());
    let err = recv_until(&err_rx, remaining);
    let (Some(out), Some(err)) = (out, err) else {
        kill_group(pid);
        return Err(ProcessError::TimedOut(limits.timeout));
    };
    let (stdout, stdout_truncated) = out
        .transpose()
        .map_err(ProcessError::Read)?
        .unwrap_or_default();
    let (stderr, stderr_truncated) = err
        .transpose()
        .map_err(ProcessError::Read)?
        .unwrap_or_default();
    Ok(BoundedOutput {
        status,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    })
}

type Captured = Option<std::io::Result<(Vec<u8>, bool)>>;

fn recv_until(rx: &mpsc::Receiver<Captured>, wait: Duration) -> Option<Captured> {
    rx.recv_timeout(wait.max(Duration::from_millis(1))).ok()
}

/// Read to EOF, keeping at most `cap` bytes and discarding the rest so the
/// writer never blocks on a full pipe. A read error is returned, never
/// mistaken for EOF.
fn read_capped<R: Read>(mut r: R, cap: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut kept = Vec::new();
    let mut truncated = false;
    let mut buf = [0u8; 8192];
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let room = cap.saturating_sub(kept.len());
                if n > room {
                    truncated = true;
                }
                kept.extend_from_slice(&buf[..n.min(room)]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok((kept, truncated))
}

fn kill_tree(child: &mut std::process::Child, pid: u32) {
    kill_group(pid);
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    let Ok(pgid) = libc::pid_t::try_from(pid) else {
        return;
    };
    if pgid <= 1 {
        return; // never signal init or "every process" (-1)
    }
    // SAFETY: plain syscall; a negative pid targets exactly the process group
    // `run_bounded` created for this child via `process_group(0)`.
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// Test-only: write a FIXED-content script (no interpolated values; data
    /// reaches it only as argv) and return its path. Production code never
    /// runs a shell.
    fn script(dir: &Path, name: &str, body: &'static str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn limits(ms: u64, cap: usize) -> RunLimits {
        RunLimits {
            timeout: Duration::from_millis(ms),
            max_stdout: cap,
            max_stderr: cap,
        }
    }

    #[test]
    fn captures_stdout_stderr_and_status() {
        let d = tempfile::tempdir().unwrap();
        let s = script(d.path(), "s", "#!/bin/sh\necho out; echo err >&2; exit 3\n");
        let out = run_bounded(Command::new(s), &limits(5000, 1024)).unwrap();
        assert_eq!(out.stdout_lossy(), "out\n");
        assert_eq!(out.stderr_lossy(), "err\n");
        assert_eq!(out.status.code(), Some(3));
        assert!(!out.stdout_truncated && !out.stderr_truncated);
    }

    #[test]
    fn caps_output_and_reports_truncation_without_blocking() {
        // ~1 MiB of output against a 100-byte cap: must finish (excess
        // drained, not left to fill the pipe) and say it truncated.
        let d = tempfile::tempdir().unwrap();
        let s = script(
            d.path(),
            "s",
            "#!/bin/sh\ni=0\nwhile [ $i -lt 16384 ]; do echo 0123456789012345678901234567890123456789012345678901234567890123; i=$((i+1)); done\n",
        );
        let out = run_bounded(Command::new(s), &limits(20_000, 100)).unwrap();
        assert_eq!(out.stdout.len(), 100);
        assert!(out.stdout_truncated);
        assert!(out.status.success());
    }

    #[test]
    fn timeout_kills_the_child() {
        let d = tempfile::tempdir().unwrap();
        let s = script(d.path(), "s", "#!/bin/sh\nsleep 30\n");
        let start = Instant::now();
        let err = run_bounded(Command::new(s), &limits(300, 1024)).unwrap_err();
        assert!(matches!(err, ProcessError::TimedOut(_)), "{err:?}");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{:?}",
            start.elapsed()
        );
    }

    #[test]
    fn timeout_kills_a_grandchild_holding_the_pipe() {
        // The direct child exits at once but leaves a background sleeper that
        // inherited stdout. Without process-group cleanup the reader would
        // block for the sleeper's full 30 s. The pidfile path arrives as $1.
        let d = tempfile::tempdir().unwrap();
        let pidfile = d.path().join("grandchild.pid");
        let s = script(
            d.path(),
            "s",
            "#!/bin/sh\nsleep 30 &\necho $! > \"$1\"\necho started\n",
        );
        let mut cmd = Command::new(s);
        cmd.arg(&pidfile);
        let start = Instant::now();
        let err = run_bounded(cmd, &limits(500, 1024)).unwrap_err();
        assert!(matches!(err, ProcessError::TimedOut(_)), "{err:?}");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{:?}",
            start.elapsed()
        );
        // The grandchild is gone (kill(pid, 0) fails with ESRCH).
        let pid: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut alive = true;
        for _ in 0..200 {
            // SAFETY: signal 0 only probes existence.
            if unsafe { libc::kill(pid, 0) } != 0 {
                alive = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!alive, "grandchild {pid} survived the timeout");
    }

    struct FailingReader {
        served: bool,
    }

    impl Read for FailingReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if !self.served {
                self.served = true;
                buf[..3].copy_from_slice(b"abc");
                return Ok(3);
            }
            Err(std::io::Error::other("pipe broke"))
        }
    }

    #[test]
    fn read_errors_are_reported_not_treated_as_eof() {
        let err = read_capped(FailingReader { served: false }, 1024).unwrap_err();
        assert_eq!(err.to_string(), "pipe broke");
        assert_eq!(
            read_capped(&b"hello"[..], 3).unwrap(),
            (b"hel".to_vec(), true)
        );
    }

    #[test]
    fn stdin_is_closed() {
        // `cat` with no input must see EOF immediately rather than hang.
        let out = run_bounded(Command::new("cat"), &limits(5000, 1024)).unwrap();
        assert!(out.status.success());
        assert!(out.stdout.is_empty());
    }

    #[test]
    fn spawn_failure_is_structured() {
        let err = run_bounded(
            Command::new("/nonexistent/definitely-not-a-binary"),
            &limits(1000, 16),
        )
        .unwrap_err();
        assert!(matches!(err, ProcessError::Spawn(_)));
    }
}
