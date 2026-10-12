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
//!   keep the caller blocked past the deadline;
//! - on Unix, reads both pipes from the calling thread (non-blocking), so no
//!   reader thread outlives the call, and signals the group only while its
//!   leader is unreaped (security review W2 / I-b).

use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
#[cfg(not(unix))]
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
    /// Short read-only probes (`sbx version`, `sbx daemon status`).
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
    /// An approved verification command run through `sbx exec` (A7, design
    /// 2026-10-09 §3.7 item 5, W2). Used ONLY with [`run_partial`], which
    /// keeps the output captured so far on timeout, read failure and kill.
    pub const VERIFICATION: RunLimits = RunLimits {
        timeout: Duration::from_secs(600),
        max_stdout: 64 * 1024,
        max_stderr: 64 * 1024,
    };
}

/// Between SIGTERM and SIGKILL when a verification is stopped (deadline,
/// read failure, graceful shutdown): §3.7 item 5, "SIGTERM, 5 s grace, then
/// SIGKILL".
pub const VERIFICATION_KILL_GRACE: Duration = Duration::from_secs(5);

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
///
/// Unix (security review I-b, the W2 pattern of [`run_partial`]): the
/// leader's exit is detected WITHOUT reaping it; the pipes are read by this
/// thread alone (non-blocking), so no reader thread can outlive the call;
/// after the leader exits, the pipes are read until the SAME deadline, and a
/// group still holding one is killed while the leader is still unreaped
/// (never after the reap); then the leader is reaped and the read ends are
/// closed. Results and errors are unchanged: a pipe still open at the
/// deadline is [`ProcessError::TimedOut`], never possibly-incomplete output.
#[cfg(unix)]
pub fn run_bounded(cmd: Command, limits: &RunLimits) -> Result<BoundedOutput, ProcessError> {
    run_bounded_in(cmd, limits, &ChildSlot::default())
}

#[cfg(unix)]
fn run_bounded_in(
    mut cmd: Command,
    limits: &RunLimits,
    slot: &ChildSlot,
) -> Result<BoundedOutput, ProcessError> {
    use std::os::unix::process::CommandExt;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // New process group whose id == the child's pid, so a timeout can kill
    // the whole tree the child spawned (not just the direct child).
    cmd.process_group(0);
    let deadline = Instant::now() + limits.timeout;
    let mut child = {
        let mut st = slot.lock();
        let child = cmd.spawn().map_err(ProcessError::Spawn)?;
        st.pgid = Some(child.id());
        child
    };
    let pid = child.id();
    let mut out = Stream::new(child.stdout.take(), limits.max_stdout);
    let mut err = Stream::new(child.stderr.take(), limits.max_stderr);
    // Phase 1: the leader runs (a read error is recorded and reported once
    // the leader has ended, as before).
    loop {
        pump2(&mut out, &mut err);
        match leader_exited(pid) {
            Ok(true) => break,
            Ok(false) => {}
            Err(e) => {
                let _ = reap(&mut child, pid, slot);
                return Err(ProcessError::Wait(e));
            }
        }
        if Instant::now() >= deadline {
            slot.signal(SIGKILL);
            let _ = reap(&mut child, pid, slot);
            return Err(ProcessError::TimedOut(limits.timeout));
        }
        std::thread::sleep(POLL);
    }
    // Phase 2: the leader has ended, NOT reaped. A descendant may still hold
    // a pipe: read until the same deadline.
    let all_done = |out: &Stream<_>, err: &Stream<_>| out.c.done && err.c.done;
    loop {
        pump2(&mut out, &mut err);
        if all_done(&out, &err) || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(POLL);
    }
    if !all_done(&out, &err) {
        // Past the deadline with a pipe still open: kill what is left of the
        // group while the leader is unreaped, then reap; the read ends close
        // when the streams drop here.
        if group_has_members(pid) {
            slot.signal(SIGKILL);
        }
        let _ = reap(&mut child, pid, slot);
        return Err(ProcessError::TimedOut(limits.timeout));
    }
    let status = reap(&mut child, pid, slot).map_err(ProcessError::Wait)?;
    let read_error = out.c.error.take().or_else(|| err.c.error.take());
    if let Some(e) = read_error {
        return Err(ProcessError::Read(std::io::Error::other(e)));
    }
    Ok(BoundedOutput {
        status,
        stdout: out.c.bytes,
        stderr: err.c.bytes,
        stdout_truncated: out.c.truncated,
        stderr_truncated: err.c.truncated,
    })
}

/// Reap the leader under the slot lock, clearing the recorded group id in
/// the same critical section (no signal through the slot can follow the
/// reap). A leader not known to have exited (`leader_exited` is anything
/// but `Ok(true)`) is still our unreaped child, so `kill` is safe and makes
/// the wait bounded.
fn reap(
    child: &mut std::process::Child,
    pid: u32,
    slot: &ChildSlot,
) -> std::io::Result<ExitStatus> {
    let mut st = slot.lock();
    if !matches!(leader_exited(pid), Ok(true)) {
        let _ = child.kill();
    }
    let status = child.wait();
    st.pgid = None;
    status
}

/// Run `cmd` under `limits` (non-Unix: the original thread-based reader;
/// not exercised on the hosts this crate is verified on).
#[cfg(not(unix))]
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

#[cfg(not(unix))]
type Captured = Option<std::io::Result<(Vec<u8>, bool)>>;

#[cfg(not(unix))]
fn recv_until(rx: &mpsc::Receiver<Captured>, wait: Duration) -> Option<Captured> {
    rx.recv_timeout(wait.max(Duration::from_millis(1))).ok()
}

/// Read to EOF, keeping at most `cap` bytes and discarding the rest so the
/// writer never blocks on a full pipe. A read error is returned, never
/// mistaken for EOF.
#[cfg(not(unix))]
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

#[cfg(not(unix))]
fn kill_tree(child: &mut std::process::Child, pid: u32) {
    kill_group(pid);
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

// ---------------------------------------------------------------------------
// A7: the partial-output runner and the TERM/grace/KILL helper (design
// 2026-10-09 §3.7 item 5, W2/W3)
// ---------------------------------------------------------------------------

/// The live child of one [`run_partial`] call, shared with whoever may have
/// to stop it (Core's graceful shutdown).
///
/// The process-group id is recorded right after spawn and CLEARED in the
/// same critical section in which the child is reaped (`try_wait` runs under
/// this lock), so a signal sent through the slot can never reach a reused
/// pid. `cancelled` makes a not-yet-spawned run never spawn. Memory only:
/// after a restart no pid is ever signalled (specs/02 §1).
#[derive(Debug, Default)]
pub struct ChildSlot {
    state: std::sync::Mutex<SlotState>,
}

#[derive(Debug, Default)]
struct SlotState {
    pgid: Option<u32>,
    cancelled: bool,
    /// Group signals actually issued through this slot (test evidence).
    signals_sent: u32,
}

impl ChildSlot {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self::default())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SlotState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether a spawned, not-yet-reaped child is recorded.
    pub fn is_live(&self) -> bool {
        self.lock().pgid.is_some()
    }

    /// Signal the live child's process group. `false` = nothing live, or
    /// the leader is already reaped (see [`signal_recorded_group`]).
    pub fn signal(&self, sig: i32) -> bool {
        let mut st = self.lock();
        signal_recorded_group(&mut st, sig)
    }

    /// Mark the run cancelled (a child not spawned yet never will be) and
    /// signal the live child's group, if any. `false` = nothing live.
    pub fn cancel_and_signal(&self, sig: i32) -> bool {
        let mut st = self.lock();
        st.cancelled = true;
        signal_recorded_group(&mut st, sig)
    }
}

/// Security review W2, enforced at the signal site: the group led by `pgid`
/// is signalled only while its leader is provably unreaped — `waitid`
/// (`WNOWAIT`, so nothing is reaped) still finds it as our child, running or
/// a zombie. An unreaped leader holds its pid, so the group id cannot have
/// been reused by a stranger. A reaped leader (ECHILD) is never signalled,
/// even if a stale id is still recorded. Called under the slot lock.
fn signal_recorded_group(st: &mut SlotState, sig: i32) -> bool {
    match st.pgid {
        Some(pgid) if leader_exited(pgid).is_ok() => {
            signal_group(pgid, sig);
            st.signals_sent = st.signals_sent.saturating_add(1);
            true
        }
        _ => false,
    }
}

/// How a [`run_partial`] call ended. The captured output is kept in every
/// case.
#[derive(Debug)]
pub enum RunEnding {
    /// The child exited on its own or was killed by a signal Core did not
    /// send for a deadline (`ExitStatusExt::signal` tells which).
    Exited(ExitStatus),
    /// The deadline passed: the group got SIGTERM, then SIGKILL after the
    /// grace.
    TimedOut,
    /// Reading stdout/stderr failed; the child's group was stopped (TERM,
    /// grace, KILL) and the output read before the failure is kept.
    ReadFailed(String),
    /// Waiting for the child failed; its group was killed.
    WaitFailed(String),
    /// The slot was cancelled before the child was spawned: nothing ran.
    Cancelled,
}

/// What [`run_partial`] captured.
#[derive(Debug)]
pub struct PartialOutput {
    pub ending: RunEnding,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    /// From just before the spawn to the end of the run.
    pub elapsed: Duration,
    /// The leader ended but a stream was still open when Core stopped
    /// reading (a descendant held it): the output may be incomplete.
    pub output_incomplete: bool,
    /// Core sent at least one signal to the run's process group.
    pub group_signalled: bool,
}

/// One stream's capture. Read only by the runner thread itself — there are
/// no reader threads, so nothing can outlive the run (security review W2).
#[derive(Debug, Default)]
struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
    error: Option<String>,
    done: bool,
}

/// At most this many chunks are read per [`drain`] call, so a fast producer
/// can never keep the runner from checking its deadline.
const MAX_READS_PER_DRAIN: usize = 64;

/// Read what is available NOW into `c`, keeping at most `cap` bytes and
/// discarding the rest. Returns when the reader would block, at EOF, on an
/// error or after [`MAX_READS_PER_DRAIN`] chunks. EOF and an error mark the
/// stream done; an error is RECORDED with the bytes read so far (never
/// treated as EOF, never discarding what was read).
fn drain<R: Read>(r: &mut R, cap: usize, c: &mut Capture) {
    let mut buf = [0u8; 8192];
    let mut reads = 0;
    while reads < MAX_READS_PER_DRAIN {
        match r.read(&mut buf) {
            Ok(0) => {
                c.done = true;
                return;
            }
            Ok(n) => {
                reads += 1;
                let room = cap.saturating_sub(c.bytes.len());
                if n > room {
                    c.truncated = true;
                }
                c.bytes.extend_from_slice(&buf[..n.min(room)]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                c.error = Some(e.to_string());
                c.done = true;
                return;
            }
        }
    }
}

/// One non-blocking output stream of the child. The read end is CLOSED as
/// soon as the stream ends and, at the latest, when [`run_partial`] returns.
struct Stream<R> {
    reader: Option<R>,
    cap: usize,
    c: Capture,
}

impl<R: Read + AsRawFdCompat> Stream<R> {
    fn new(reader: Option<R>, cap: usize) -> Self {
        let mut c = Capture {
            done: reader.is_none(),
            ..Capture::default()
        };
        if let Some(r) = &reader {
            if let Err(e) = set_nonblocking(r) {
                c.error = Some(format!("cannot make the pipe non-blocking: {e}"));
                c.done = true;
            }
        }
        let reader = if c.done { None } else { reader };
        Self { reader, cap, c }
    }

    fn pump(&mut self) {
        if let Some(r) = self.reader.as_mut() {
            drain(r, self.cap, &mut self.c);
            if self.c.done {
                self.reader = None;
            }
        }
    }
}

/// The raw descriptor of a child pipe (unix) — a seam so `Stream` stays
/// generic for the platform split.
trait AsRawFdCompat {
    #[cfg(unix)]
    fn raw(&self) -> std::os::fd::RawFd;
}

#[cfg(unix)]
impl<T: std::os::fd::AsRawFd> AsRawFdCompat for T {
    fn raw(&self) -> std::os::fd::RawFd {
        self.as_raw_fd()
    }
}

#[cfg(not(unix))]
impl<T> AsRawFdCompat for T {}

#[cfg(unix)]
fn set_nonblocking<R: AsRawFdCompat>(r: &R) -> std::io::Result<()> {
    let fd = r.raw();
    // SAFETY: plain fcntl on a descriptor this process owns.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: as above.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_nonblocking<R>(_r: &R) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "non-blocking pipes are only implemented on unix",
    ))
}

fn pump2<A: Read + AsRawFdCompat, B: Read + AsRawFdCompat>(a: &mut Stream<A>, b: &mut Stream<B>) {
    a.pump();
    b.pump();
}

/// Whether the leader `pid` has exited, WITHOUT reaping it (`WNOWAIT`): an
/// unreaped leader keeps its pid — and so the group id it leads — from being
/// reused, so a group signal sent before the reap can never reach a stranger
/// (security review W2).
#[cfg(unix)]
fn leader_exited(pid: u32) -> std::io::Result<bool> {
    let id =
        libc::id_t::try_from(pid).map_err(|_| std::io::Error::other("child pid out of range"))?;
    loop {
        // SAFETY: zeroed siginfo is a valid out-parameter for waitid.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: waits (without blocking or reaping) on our own child.
        let r = unsafe {
            libc::waitid(
                libc::P_PID,
                id,
                &mut info,
                libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
            )
        };
        if r < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        // SAFETY: si_pid is valid for a WEXITED state change (0 = none).
        let exited = unsafe { info.si_pid() } != 0;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let exited = info.si_pid != 0;
        return Ok(exited);
    }
}

#[cfg(not(unix))]
fn leader_exited(_pid: u32) -> std::io::Result<bool> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "process groups are only implemented on unix",
    ))
}

/// The leader is known to be still running (`Ok(false)`). An error is NOT
/// read as "exited": callers that must act on an unreaped leader check
/// `leader_exited` themselves; here an error only ends a wait, and no signal
/// can follow it (the slot refuses a leader `waitid` cannot find).
fn leader_running(pid: u32) -> bool {
    matches!(leader_exited(pid), Ok(false))
}

/// Whether the group led by `pgid` has a member that can be signalled. On
/// macOS a group whose only member is the unreaped (zombie) leader answers
/// EPERM, so no signal is sent to it; elsewhere a zombie-only group may
/// still count — a signal to it is harmless, because the unreaped leader
/// keeps the id from being reused.
#[cfg(unix)]
fn group_has_members(pgid: u32) -> bool {
    let Ok(pgid) = libc::pid_t::try_from(pgid) else {
        return false;
    };
    if pgid <= 1 {
        return false;
    }
    // SAFETY: signal 0 only probes; a negative pid names exactly the group.
    unsafe { libc::kill(-pgid, 0) == 0 }
}

#[cfg(not(unix))]
fn group_has_members(_pgid: u32) -> bool {
    false
}

/// Stop a run that must not continue (deadline, read failure, wait
/// failure): SIGTERM the group, wait up to `grace` for the leader (still
/// unreaped, reading the streams meanwhile), then SIGKILL the group if the
/// leader is still running or members remain, and wait (bounded) for the
/// leader to exit. Never reaps — the caller reaps under the slot lock.
/// Returns whether a signal was sent.
fn stop_group<A: Read + AsRawFdCompat, B: Read + AsRawFdCompat>(
    pid: u32,
    slot: &ChildSlot,
    grace: Duration,
    out: &mut Stream<A>,
    err: &mut Stream<B>,
) -> bool {
    let mut sent = slot.signal(SIGTERM);
    let until = Instant::now() + grace;
    while leader_running(pid) && Instant::now() < until {
        pump2(out, err);
        std::thread::sleep(POLL);
    }
    if leader_running(pid) || group_has_members(pid) {
        sent |= slot.signal(SIGKILL);
    }
    let until = Instant::now() + Duration::from_secs(10);
    while leader_running(pid) && Instant::now() < until {
        pump2(out, err);
        std::thread::sleep(POLL);
    }
    sent
}

#[cfg(unix)]
const SIGTERM: i32 = libc::SIGTERM;
#[cfg(unix)]
const SIGKILL: i32 = libc::SIGKILL;
#[cfg(not(unix))]
const SIGTERM: i32 = 15;
#[cfg(not(unix))]
const SIGKILL: i32 = 9;

#[cfg(unix)]
fn signal_group(pgid: u32, sig: i32) {
    let Ok(pgid) = libc::pid_t::try_from(pgid) else {
        return;
    };
    if pgid <= 1 {
        return; // never signal init or "every process" (-1)
    }
    // SAFETY: plain syscall; a negative pid targets exactly the process group
    // `run_partial` created for this child via `process_group(0)`.
    unsafe {
        libc::kill(-pgid, sig);
    }
}

#[cfg(not(unix))]
fn signal_group(_pgid: u32, _sig: i32) {}

/// Run `cmd` under `limits`, KEEPING the output captured so far whatever
/// happens (A7 W2): the deadline (SIGTERM to the group, `grace`, SIGKILL),
/// a read failure (same stop) and a kill all return [`PartialOutput`] with
/// the bytes read. stdin is `/dev/null`; the child gets its own process
/// group, recorded in `slot` for Core's graceful shutdown. `Err` means the
/// process never started (spawn failure).
///
/// Security review W2: the leader's exit is detected WITHOUT reaping it, and
/// every group signal is sent while it is still unreaped (its id cannot be
/// reused). After a natural exit the streams are read for at most `grace`
/// more; if a descendant still holds one, the result keeps `Exited(status)`
/// and says `output_incomplete` — it is never rewritten to a timeout —
/// stragglers in the run's own group are stopped, and the read ends are
/// closed. The streams are read by this thread alone (non-blocking), so no
/// reader thread outlives the call.
pub fn run_partial(
    mut cmd: Command,
    limits: &RunLimits,
    grace: Duration,
    slot: &ChildSlot,
) -> std::io::Result<PartialOutput> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let start = Instant::now();
    let deadline = start + limits.timeout;
    // Spawn under the slot lock: a cancelled run never spawns, and the pgid
    // is recorded before anyone can look.
    let mut child = {
        let mut st = slot.lock();
        if st.cancelled {
            return Ok(PartialOutput {
                ending: RunEnding::Cancelled,
                stdout: Vec::new(),
                stderr: Vec::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                elapsed: start.elapsed(),
                output_incomplete: false,
                group_signalled: false,
            });
        }
        let child = cmd.spawn()?;
        st.pgid = Some(child.id());
        child
    };
    let pid = child.id();
    let mut out = Stream::new(child.stdout.take(), limits.max_stdout);
    let mut err = Stream::new(child.stderr.take(), limits.max_stderr);
    let mut signalled = false;
    let read_error =
        |out: &Stream<_>, err: &Stream<_>| out.c.error.clone().or_else(|| err.c.error.clone());
    // Phase 1: the leader runs. Stop early on a read or wait failure.
    let mut stopped: Option<RunEnding> = None;
    loop {
        pump2(&mut out, &mut err);
        if let Some(e) = read_error(&out, &err) {
            signalled |= stop_group(pid, slot, grace, &mut out, &mut err);
            stopped = Some(RunEnding::ReadFailed(e));
            break;
        }
        match leader_exited(pid) {
            Ok(true) => break,
            Ok(false) => {}
            Err(e) => {
                signalled |= stop_group(pid, slot, grace, &mut out, &mut err);
                stopped = Some(RunEnding::WaitFailed(e.to_string()));
                break;
            }
        }
        if Instant::now() >= deadline {
            signalled |= stop_group(pid, slot, grace, &mut out, &mut err);
            stopped = Some(RunEnding::TimedOut);
            break;
        }
        std::thread::sleep(POLL);
    }
    // Phase 2: the leader has ended and is NOT reaped yet. Read the streams
    // for at most `grace` more — never until the deadline.
    let all_done = |out: &Stream<_>, err: &Stream<_>| out.c.done && err.c.done;
    let until = Instant::now() + grace;
    loop {
        pump2(&mut out, &mut err);
        if all_done(&out, &err) || Instant::now() >= until {
            break;
        }
        std::thread::sleep(POLL);
    }
    // A stream still open now was cut: the output may be incomplete even if
    // the stragglers holding it are stopped below.
    let cut = !all_done(&out, &err);
    if cut && group_has_members(pid) {
        // A straggler in the run's OWN group holds a stream: stop it while
        // the leader is still unreaped.
        signalled |= slot.signal(SIGTERM);
        let until = Instant::now() + grace.min(Duration::from_millis(500));
        while !all_done(&out, &err) && Instant::now() < until {
            pump2(&mut out, &mut err);
            std::thread::sleep(POLL);
        }
        if group_has_members(pid) {
            signalled |= slot.signal(SIGKILL);
        }
        let settle = Instant::now() + Duration::from_millis(200);
        while !all_done(&out, &err) && Instant::now() < settle {
            pump2(&mut out, &mut err);
            std::thread::sleep(POLL);
        }
    }
    // Reap under the slot lock: the pgid is cleared in the same critical
    // section, so no signal through the slot can follow the reap.
    let status = reap(&mut child, pid, slot);
    pump2(&mut out, &mut err);
    let output_incomplete = cut || !all_done(&out, &err);
    // Close the read ends now: nothing in Core holds the pipes after this.
    out.reader = None;
    err.reader = None;
    let mut ending = match stopped {
        Some(e) => e,
        None => match status {
            Ok(st) => RunEnding::Exited(st),
            Err(e) => RunEnding::WaitFailed(e.to_string()),
        },
    };
    if !matches!(ending, RunEnding::ReadFailed(_)) {
        if let Some(e) = read_error(&out, &err) {
            ending = RunEnding::ReadFailed(e);
        }
    }
    Ok(PartialOutput {
        ending,
        stdout: out.c.bytes,
        stderr: err.c.bytes,
        stdout_truncated: out.c.truncated,
        stderr_truncated: err.c.truncated,
        elapsed: start.elapsed(),
        output_incomplete,
        group_signalled: signalled,
    })
}

/// Graceful-shutdown stop of several runs (§3.7 item 5, W3): cancel every
/// slot (an unspawned run never spawns) and SIGTERM each live group, wait up
/// to `grace` for their runners to reap them, then SIGKILL whatever is still
/// live. Only pids recorded by THIS process's runners are ever signalled.
pub fn terminate_slots(slots: &[std::sync::Arc<ChildSlot>], grace: Duration) {
    for s in slots {
        s.cancel_and_signal(SIGTERM);
    }
    let until = Instant::now() + grace;
    while Instant::now() < until && slots.iter().any(|s| s.is_live()) {
        std::thread::sleep(POLL);
    }
    for s in slots {
        s.signal(SIGKILL);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    /// Test-only: write a FIXED-content script (no interpolated values; data
    /// reaches it only as argv) and return its path. Production code never
    /// runs a shell.
    ///
    /// Review N1: the FIRST exec of a freshly written executable is slow on
    /// macOS (measured ~0.45 s median under concurrency, against ~8 ms for
    /// the second exec), which made deadline-based tests race. So the script
    /// is executed once here, in a warm-up mode that exits at once, before
    /// any test clock starts.
    fn script(dir: &Path, name: &str, body: &'static str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let rest = body
            .strip_prefix("#!/bin/sh\n")
            .expect("test scripts start with #!/bin/sh");
        let p = dir.join(name);
        std::fs::write(
            &p,
            format!("#!/bin/sh\n[ -n \"$SANDPANE_TEST_WARMUP\" ] && exit 0\n{rest}"),
        )
        .unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        let warm = Command::new(&p)
            .env("SANDPANE_TEST_WARMUP", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(warm.success(), "warm-up of {name} failed");
        p
    }

    /// Wait (bounded, generously) for a file a test script writes.
    fn wait_for_file(p: &Path, what: &str) {
        let until = Instant::now() + Duration::from_secs(30);
        while !p.exists() {
            assert!(Instant::now() < until, "{what} never appeared");
            std::thread::sleep(Duration::from_millis(10));
        }
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
        // Only the upper bound matters: well under the child's 30 s.
        assert!(
            start.elapsed() < Duration::from_secs(15),
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
        let slot = ChildSlot::default();
        let start = Instant::now();
        // A 2 s deadline leaves the (warmed-up) script ample time to start
        // the sleeper and exit before it; only the upper bound is timed.
        let err = run_bounded_in(cmd, &limits(2000, 1024), &slot).unwrap_err();
        assert!(matches!(err, ProcessError::TimedOut(_)), "{err:?}");
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "{:?}",
            start.elapsed()
        );
        assert!(
            slot.lock().signals_sent >= 1,
            "the group was killed while the leader was unreaped"
        );
        assert!(!slot.is_live(), "the leader was reaped");
        // The grandchild is gone (kill(pid, 0) fails with ESRCH).
        let text = std::fs::read_to_string(&pidfile)
            .expect("the script never reached its sleeper before the 2 s deadline");
        let pid: i32 = text.trim().parse().unwrap();
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

    /// The deadline passes while the leader still runs: the whole group
    /// (the leader and a background sleeper) is killed before the reap.
    #[test]
    fn timeout_kills_the_whole_group_while_the_leader_runs() {
        let d = tempfile::tempdir().unwrap();
        let s = script(
            d.path(),
            "s",
            "#!/bin/sh\nsleep 30 &\necho $! > \"$0.pid\"\nsleep 30\n",
        );
        let slot = ChildSlot::default();
        let err = run_bounded_in(Command::new(s), &limits(1500, 1024), &slot).unwrap_err();
        assert!(matches!(err, ProcessError::TimedOut(_)), "{err:?}");
        assert!(!slot.is_live());
        let text = std::fs::read_to_string(d.path().join("s.pid"))
            .expect("the script never reached its sleeper before the deadline");
        let pid: i32 = text.trim().parse().unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        // SAFETY: probe only (signal 0).
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(Instant::now() < until, "the sleeper {pid} survived");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Review I-b (W2 class, in the runner git and sbx use): the leader
    /// exits while a descendant in its OWN session holds stdout. The call
    /// returns by its own deadline (run_bounded's post-exit wait is bounded
    /// by the same deadline as before), and NOTHING in Core still holds the
    /// pipe afterwards — no reader thread outlives the call — so the
    /// descendant's later write fails with EPIPE.
    #[test]
    fn run_bounded_leaves_no_reader_behind_an_escaped_descendant() {
        let d = tempfile::tempdir().unwrap();
        let s = script(
            d.path(),
            "leader",
            "#!/bin/sh
echo hello
perl -e 'use POSIX; POSIX::setsid(); $SIG{PIPE}=\"IGNORE\"; \
             open(R, \">\", $ARGV[1]); close R; sleep 4; my $ok = syswrite(STDOUT, \"late\\n\"); \
             open(F, \">\", $ARGV[0]); print F (defined $ok ? \"written\" : \"epipe\"); close F' \
             \"$0.result\" \"$0.ready\" &\nwhile [ ! -f \"$0.ready\" ]; do sleep 0.01; done\nexit 0\n",
        );
        let result = d.path().join("leader.result");
        let slot = ChildSlot::default();
        let t = Instant::now();
        let err = run_bounded_in(Command::new(s), &limits(1500, 1024), &slot).unwrap_err();
        let elapsed = t.elapsed();
        assert!(matches!(err, ProcessError::TimedOut(_)), "{err:?}");
        assert!(
            elapsed >= Duration::from_millis(1500) && elapsed < Duration::from_secs(10),
            "returned by its own deadline, not the descendant's: {elapsed:?}"
        );
        assert!(!slot.is_live(), "the leader was reaped");
        #[cfg(target_os = "macos")]
        assert_eq!(
            slot.lock().signals_sent,
            0,
            "no signal to a group whose only member is the unreaped leader"
        );
        let until = Instant::now() + Duration::from_secs(20);
        while !result.exists() {
            assert!(Instant::now() < until, "the descendant never reported");
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            std::fs::read_to_string(&result).unwrap(),
            "epipe",
            "a reader still held the pipe after run_bounded returned"
        );
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

    /// The Unix reader (`drain`, shared by `run_bounded` and `run_partial`
    /// since review I-b) reports a read error instead of treating it as
    /// EOF, and caps what it keeps.
    #[test]
    fn read_errors_are_reported_not_treated_as_eof() {
        let mut c = Capture::default();
        drain(&mut FailingReader { served: false }, 1024, &mut c);
        assert_eq!(c.error.as_deref(), Some("pipe broke"));
        let mut c = Capture::default();
        drain(&mut &b"hello"[..], 3, &mut c);
        assert_eq!(
            (c.bytes.as_slice(), c.truncated, c.done),
            (&b"hel"[..], true, true)
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

    // ---- A7 partial-output runner (design 2026-10-09 §3.7 item 5, W2) ----

    fn vlimits(ms: u64, cap: usize) -> RunLimits {
        limits(ms, cap)
    }

    #[test]
    fn verification_limits_are_the_design_values() {
        assert_eq!(RunLimits::VERIFICATION.timeout, Duration::from_secs(600));
        assert_eq!(RunLimits::VERIFICATION.max_stdout, 64 * 1024);
        assert_eq!(RunLimits::VERIFICATION.max_stderr, 64 * 1024);
        assert_eq!(VERIFICATION_KILL_GRACE, Duration::from_secs(5));
    }

    #[test]
    fn partial_runner_reports_exit_and_output() {
        let d = tempfile::tempdir().unwrap();
        let s = script(d.path(), "s", "#!/bin/sh\necho out; echo err >&2; exit 7\n");
        let slot = ChildSlot::new();
        let out = run_partial(
            Command::new(s),
            &vlimits(5000, 1024),
            Duration::from_millis(200),
            &slot,
        )
        .unwrap();
        match out.ending {
            RunEnding::Exited(st) => assert_eq!(st.code(), Some(7)),
            other => panic!("{other:?}"),
        }
        assert_eq!(out.stdout, b"out\n");
        assert_eq!(out.stderr, b"err\n");
        assert!(
            !slot.is_live(),
            "the slot is cleared once the child is reaped"
        );
    }

    #[test]
    fn partial_runner_keeps_output_captured_before_a_timeout() {
        let d = tempfile::tempdir().unwrap();
        let s = script(
            d.path(),
            "s",
            "#!/bin/sh\necho partial-before-timeout\nsleep 30\n",
        );
        let slot = ChildSlot::new();
        let start = Instant::now();
        // 2 s: the warmed-up script prints long before the deadline.
        let out = run_partial(
            Command::new(s),
            &vlimits(2000, 1024),
            Duration::from_millis(200),
            &slot,
        )
        .unwrap();
        assert!(
            matches!(out.ending, RunEnding::TimedOut),
            "{:?}",
            out.ending
        );
        assert_eq!(
            out.stdout, b"partial-before-timeout\n",
            "partial output kept"
        );
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "{:?}",
            start.elapsed()
        );
    }

    #[test]
    fn partial_runner_timeout_escalates_to_kill_after_the_grace() {
        // The child ignores SIGTERM: only the SIGKILL after the grace ends it.
        let d = tempfile::tempdir().unwrap();
        let s = script(
            d.path(),
            "s",
            "#!/bin/sh\ntrap '' TERM\necho ignoring-term\nwhile :; do sleep 1; done\n",
        );
        let slot = ChildSlot::new();
        let start = Instant::now();
        // 2 s leaves the warmed-up shell ample time to install its trap
        // first; the echo AFTER the trap proves it was installed in time.
        let out = run_partial(
            Command::new(s),
            &vlimits(2000, 1024),
            Duration::from_millis(700),
            &slot,
        )
        .unwrap();
        assert!(
            matches!(out.ending, RunEnding::TimedOut),
            "{:?}",
            out.ending
        );
        assert_eq!(out.stdout, b"ignoring-term\n", "the trap was in place");
        assert!(
            start.elapsed() >= Duration::from_millis(2700),
            "TERM at the deadline, then the grace, then KILL: {:?}",
            start.elapsed()
        );
        assert!(start.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn partial_runner_reports_a_signal_death() {
        let d = tempfile::tempdir().unwrap();
        let s = script(d.path(), "s", "#!/bin/sh\necho before\nkill -9 $$\n");
        let out = run_partial(
            Command::new(s),
            &vlimits(5000, 1024),
            Duration::from_millis(200),
            &ChildSlot::new(),
        )
        .unwrap();
        use std::os::unix::process::ExitStatusExt;
        match out.ending {
            RunEnding::Exited(st) => {
                assert_eq!(st.code(), None);
                assert_eq!(st.signal(), Some(libc::SIGKILL));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(out.stdout, b"before\n");
    }

    #[test]
    fn partial_runner_caps_and_reports_truncation() {
        let d = tempfile::tempdir().unwrap();
        let s = script(
            d.path(),
            "s",
            "#!/bin/sh\ni=0\nwhile [ $i -lt 4096 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done\n",
        );
        let out = run_partial(
            Command::new(s),
            &vlimits(20_000, 100),
            Duration::from_millis(200),
            &ChildSlot::new(),
        )
        .unwrap();
        assert_eq!(out.stdout.len(), 100);
        assert!(out.stdout_truncated);
        assert!(matches!(out.ending, RunEnding::Exited(st) if st.success()));
    }

    #[test]
    fn partial_runner_spawn_failure_is_an_error() {
        let err = run_partial(
            Command::new("/nonexistent/definitely-not-a-binary"),
            &vlimits(1000, 16),
            Duration::from_millis(100),
            &ChildSlot::new(),
        )
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn a_cancelled_slot_never_spawns() {
        let d = tempfile::tempdir().unwrap();
        let marker = d.path().join("ran");
        let s = script(d.path(), "s", "#!/bin/sh\ntouch \"$1\"\n");
        let slot = ChildSlot::new();
        assert!(
            !slot.cancel_and_signal(libc::SIGTERM),
            "nothing live to signal"
        );
        let mut cmd = Command::new(s);
        cmd.arg(&marker);
        let out = run_partial(cmd, &vlimits(2000, 16), Duration::from_millis(100), &slot).unwrap();
        assert!(
            matches!(out.ending, RunEnding::Cancelled),
            "{:?}",
            out.ending
        );
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !marker.exists(),
            "a cancelled run must never start its child"
        );
    }

    /// Security review W2 (probe pgrp.rs): the leader exits ON ITS OWN while
    /// a descendant in its OWN session keeps stdout open. The real exit code
    /// is kept (never rewritten to a timeout), the readers are waited for at
    /// most `grace` (not the deadline), the result says the output may be
    /// incomplete, no signal goes to a group with no live member, and Core's
    /// read ends are closed (the descendant's later write fails with EPIPE —
    /// nothing in Core still holds the pipe).
    #[test]
    fn a_natural_exit_with_an_escaped_descendant_keeps_the_exit_code() {
        let d = tempfile::tempdir().unwrap();
        // The leader waits for a marker perl writes AFTER setsid(), so perl
        // has left the group before the leader exits (review N1).
        let s = script(
            d.path(),
            "leader",
            "#!/bin/sh\necho hello\nperl -e 'use POSIX; POSIX::setsid(); $SIG{PIPE}=\"IGNORE\"; \
             open(R, \">\", $ARGV[1]); close R; sleep 5; my $ok = syswrite(STDOUT, \"late\\n\"); \
             open(F, \">\", $ARGV[0]); print F (defined $ok ? \"written\" : \"epipe\"); close F' \
             \"$0.result\" \"$0.ready\" &\nwhile [ ! -f \"$0.ready\" ]; do sleep 0.01; done\nexit 3\n",
        );
        let result = d.path().join("leader.result");
        let t = Instant::now();
        let out = run_partial(
            Command::new(s),
            &vlimits(60_000, 1024),
            Duration::from_millis(300),
            &ChildSlot::new(),
        )
        .unwrap();
        let elapsed = t.elapsed();
        match out.ending {
            RunEnding::Exited(st) => assert_eq!(st.code(), Some(3), "the real code is kept"),
            other => panic!("rewritten: {other:?}"),
        }
        assert!(out.output_incomplete, "the descendant still held stdout");
        assert_eq!(out.stdout, b"hello\n");
        assert!(
            elapsed >= Duration::from_millis(300) && elapsed < Duration::from_secs(20),
            "waited about the grace, not the 60 s deadline: {elapsed:?}"
        );
        #[cfg(target_os = "macos")]
        assert!(
            !out.group_signalled,
            "no signal to a group whose only member is the unreaped leader"
        );
        wait_for_file(&result, "the descendant's report");
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            std::fs::read_to_string(&result).unwrap(),
            "epipe",
            "Core's read end was closed when run_partial returned"
        );
    }

    /// W2: a straggler in the run's OWN group holding stdout is stopped
    /// after the grace while the leader is still unreaped; the exit code is
    /// kept.
    #[test]
    fn a_natural_exit_stops_stragglers_in_the_group_and_keeps_the_code() {
        let d = tempfile::tempdir().unwrap();
        let s = script(
            d.path(),
            "leader",
            "#!/bin/sh\necho hi\nsleep 30 &\necho $! > \"$0.pid\"\nexit 0\n",
        );
        let t = Instant::now();
        let out = run_partial(
            Command::new(s),
            &vlimits(60_000, 1024),
            Duration::from_millis(300),
            &ChildSlot::new(),
        )
        .unwrap();
        let elapsed = t.elapsed();
        assert!(
            matches!(out.ending, RunEnding::Exited(st) if st.code() == Some(0)),
            "{:?}",
            out.ending
        );
        assert!(out.output_incomplete);
        assert!(out.group_signalled, "the straggler's group was stopped");
        assert!(
            elapsed < Duration::from_secs(20),
            "about the grace, not the 60 s deadline: {elapsed:?}"
        );
        let pid: i32 = std::fs::read_to_string(d.path().join("leader.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        // SAFETY: probe only (signal 0).
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(Instant::now() < until, "the straggler survived");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// W2 at the signal site: once the leader is reaped its group is never
    /// signalled, even while a stale id is still recorded in the slot.
    #[test]
    fn a_reaped_leader_is_never_signalled_through_the_slot() {
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        let slot = ChildSlot::new();
        let mut child = Command::new("true").process_group(0).spawn().unwrap();
        slot.lock().pgid = Some(child.id());
        child.wait().unwrap();
        assert!(
            !slot.signal(libc::SIGTERM),
            "a reaped leader's id was signalled"
        );
        assert!(!slot.cancel_and_signal(libc::SIGKILL));
        // A live, unreaped leader (leading its own group) is signalled.
        let slot = ChildSlot::new();
        let mut child = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        slot.lock().pgid = Some(child.id());
        let t = Instant::now();
        assert!(slot.signal(libc::SIGKILL));
        let st = child.wait().unwrap();
        assert_eq!(st.signal(), Some(libc::SIGKILL));
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    }

    /// A clean run neither signals nor reports incomplete output.
    #[test]
    fn a_clean_exit_reports_complete_output_and_no_signal() {
        let d = tempfile::tempdir().unwrap();
        let s = script(d.path(), "s", "#!/bin/sh\necho done\nexit 0\n");
        let out = run_partial(
            Command::new(s),
            &vlimits(5000, 1024),
            Duration::from_millis(300),
            &ChildSlot::new(),
        )
        .unwrap();
        assert!(!out.output_incomplete);
        assert!(!out.group_signalled);
        assert_eq!(out.stdout, b"done\n");
    }

    #[test]
    fn drain_keeps_bytes_read_before_a_read_error() {
        let mut c = Capture::default();
        drain(&mut FailingReader { served: false }, 1024, &mut c);
        assert_eq!(c.bytes, b"abc", "partial bytes kept");
        assert_eq!(c.error.as_deref(), Some("pipe broke"));
        assert!(c.done);
    }

    /// The TERM/grace/KILL helper used by graceful shutdown (§3.7 item 5
    /// W3): a child that exits on TERM ends promptly; one that ignores TERM
    /// is killed after the grace. Driven directly against live runs.
    #[test]
    fn terminate_slots_terms_then_kills_after_the_grace() {
        let d = tempfile::tempdir().unwrap();
        let polite = script(d.path(), "polite", "#!/bin/sh\nsleep 30\n");
        let stubborn = script(
            d.path(),
            "stubborn",
            "#!/bin/sh\ntrap '' TERM\ntouch \"$0.ready\"\nwhile :; do sleep 1; done\n",
        );
        let ready = d.path().join("stubborn.ready");
        let run = |p: PathBuf| {
            let slot = ChildSlot::new();
            let s2 = slot.clone();
            let h = std::thread::spawn(move || {
                run_partial(
                    Command::new(p),
                    &vlimits(60_000, 64),
                    Duration::from_secs(30),
                    &s2,
                )
                .unwrap()
            });
            (slot, h)
        };
        let (s1, h1) = run(polite);
        let (s2, h2) = run(stubborn);
        let deadline = Instant::now() + Duration::from_secs(30);
        while !(s1.is_live() && s2.is_live()) {
            assert!(Instant::now() < deadline, "children never started");
            std::thread::sleep(Duration::from_millis(10));
        }
        while !ready.exists() {
            assert!(Instant::now() < deadline, "trap never installed");
            std::thread::sleep(Duration::from_millis(10));
        }
        let start = Instant::now();
        terminate_slots(&[s1.clone(), s2.clone()], Duration::from_millis(600));
        let o1 = h1.join().unwrap();
        let o2 = h2.join().unwrap();
        use std::os::unix::process::ExitStatusExt;
        match o1.ending {
            RunEnding::Exited(st) => assert_eq!(st.signal(), Some(libc::SIGTERM)),
            other => panic!("{other:?}"),
        }
        match o2.ending {
            RunEnding::Exited(st) => assert_eq!(st.signal(), Some(libc::SIGKILL)),
            other => panic!("{other:?}"),
        }
        assert!(
            start.elapsed() >= Duration::from_millis(600),
            "KILL only after the grace"
        );
        assert!(start.elapsed() < Duration::from_secs(20));
        assert!(!s1.is_live() && !s2.is_live());
    }
}
