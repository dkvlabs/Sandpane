//! A9 — `maintenance.inventory` and the token-confirmed
//! `maintenance.cleanup` (design 2026-10-09 §3.9).
//!
//! A9 cleans up only state Core itself created: `temp` directories under
//! `<data>/tmp` (A6 apply quarantines, A7 exec working directories), the
//! migration backups beside the database (`dbBackup`) and the stored output
//! of old verification runs (`verificationOutput`). Worktrees are listed
//! report-only. Nothing here spawns a process (no git, no sbx), touches a
//! repository, a sandbox, an sbx setting or global Git config.
//!
//! Ids are Core-assigned and only ever looked up in Core's OWN fresh
//! inventory: no path is built from a client-supplied id (W2). Every
//! client id first passes the grammar in [`sandpane_core::maintenance`].
//!
//! Not task-scoped: no task events. The answer carries the outcome, and one
//! log line per item records id, kind and outcome only (§3.9 item 5).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sandpane_protocol::{ErrorCode, MaintenanceCleanupParams, MaintenanceInventoryParams};

use crate::{ServerInner, SvcFailure};

// ---------------------------------------------------------------------------
// Pinned strings (clients and tests match on these)
// ---------------------------------------------------------------------------

pub const REASON_THIS_CORE: &str = "in use by this Sandpane Core";
pub const REASON_LIVE: &str = "in use by a running Sandpane Core";
pub const REASON_RECENT_LOCK: &str = "being created; Sandpane waits 10 minutes before offering it";
pub const REASON_UNLOCKED_RECENT: &str = "it has no lock file and changed less than 10 minutes \
     ago or after this Core started; it may still be in use";
pub const REASON_NOT_DIR: &str = "not a real directory owned by you";
pub const REASON_BAD_LOCK: &str = "its lock file is not a regular file owned by you";
pub const REASON_CHANGED_DURING_SCAN: &str = "it changed while Core was checking it; scan again";
pub const REASON_FOREIGN: &str = "not created by Sandpane";
pub const REASON_DB_OUTSIDE: &str =
    "the database is outside Sandpane's data directory; manage these files yourself";
pub const REASON_DB_NEWEST: &str = "the only way back to the previous Sandpane Core version";
pub const REASON_DB_NOT_FILE: &str = "not a regular file owned by you";
pub const REASON_WORKTREE: &str = "removal waits for W-D: Sandpane cannot remove worktrees yet";
pub const SKIP_GONE: &str = "no longer present";
pub const SKIP_CHANGED: &str = "changed since you confirmed";
pub const DETAIL_ORPHAN: &str = "not referenced by this Core's database; another Sandpane Core \
     using a different database may own it";
pub const DETAIL_TRACKED: &str = "worktree of a finished task; stop the task's sandbox first, \
     then run `git worktree remove` from that repository";
pub const NOTE_VERIFICATION_OUTPUT: &str = "output removed from Sandpane's records; the database \
     file does not shrink, older migration backups may still contain it, and residual copies may \
     remain on disk (removal is best effort)";
/// Step 2's reason when a temp lock is held at removal time: another Core's
/// (or this Core's) scan probe holds it for a moment, or a Core uses it
/// (review I3) — Core cannot tell which.
pub const REASON_LIVE_OR_PROBED: &str =
    "being checked by a scan or in use by a Sandpane Core; scan again";
pub const MSG_CLEANUP_SCAN_BUSY: &str =
    "a maintenance scan is running; wait for it to finish; nothing was changed";
pub const NOTE_TEMP_SIZES: &str =
    "temporary directory sizes are not measured, so the space freed is not reported";
pub const UNAVAILABLE_NO_DATA_DIR: &str = "this Core was started without its data directory";
pub const MSG_SCAN_BUSY: &str =
    "a maintenance scan is already running; wait for it to finish; nothing was scanned";
pub const MSG_CLEANUP_BUSY: &str =
    "a maintenance cleanup is already running; wait for it to finish; nothing was changed";
pub const MSG_NO_ITEMS: &str = "items must name at least one inventory item; nothing was changed";
pub const MSG_TOO_MANY: &str = "at most 500 items per cleanup; nothing was changed";
pub const MSG_DUPLICATE: &str = "duplicate item ids; nothing was changed";
pub const MSG_BAD_ID: &str = "an item id is not a maintenance item id; nothing was changed";
pub const MSG_CUTOFF_TOO_LATE: &str = "the verificationOutput cutoff is later than Core's \
     retention allows; scan again; nothing was changed";

pub fn msg_unknown(id: &str) -> String {
    format!("item {id} is not in Core's inventory; scan again; nothing was changed")
}

pub fn msg_not_removable(id: &str, reason: &str) -> String {
    format!("item {id} cannot be removed ({reason}); nothing was changed")
}

fn unsafe_root(what: &str, why: &str) -> String {
    format!("Core's {what} failed its safety check ({why}); nothing under it is listed or removed")
}

/// Default verification-output retention (§3.9 item 2: 30 days).
pub const DEFAULT_VERIFICATION_OUTPUT_RETENTION: Duration = Duration::from_secs(30 * 86_400);
pub const MIN_VERIFICATION_OUTPUT_RETENTION: Duration = Duration::from_secs(86_400);
pub const MAX_VERIFICATION_OUTPUT_RETENTION: Duration = Duration::from_secs(3650 * 86_400);

/// `CoreConfig::verification_output_retention` → the clamped value.
pub fn retention_from_config(v: Option<Duration>) -> Duration {
    v.unwrap_or(DEFAULT_VERIFICATION_OUTPUT_RETENTION).clamp(
        MIN_VERIFICATION_OUTPUT_RETENTION,
        MAX_VERIFICATION_OUTPUT_RETENTION,
    )
}

/// The 10-minute rules of §3.9 item 2 (temp lock-only and lock-absent
/// entries, young orphan worktrees).
const MIN_AGE: Duration = Duration::from_secs(600);

/// Inventory and cleanup bounds (§3.9 items 1, 3, 4). Tests shrink them via
/// `CoreConfig::test_maintenance_limits`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaintenanceLimits {
    /// Items one inventory answers (then `truncated`).
    pub max_items: usize,
    /// Entries read from one directory (then `truncated`).
    pub max_dir_entries: usize,
    /// Rows pruned per transaction.
    pub prune_batch: usize,
    /// Whole-inventory budget; past it, items are listed without sizes.
    pub budget: Duration,
    /// Serialised size the inventory answer may reach (the frame backstop
    /// minus envelope headroom); items are cut from the tail past it.
    pub max_response_bytes: usize,
}

impl Default for MaintenanceLimits {
    fn default() -> Self {
        Self {
            max_items: 2000,
            max_dir_entries: 10_000,
            prune_batch: 500,
            budget: Duration::from_secs(10),
            max_response_bytes: crate::MAX_FRAME_BYTES - 64 * 1024,
        }
    }
}

/// Single-flight flags (§3.9 item 4, I8): one inventory and one cleanup at
/// a time. Memory only.
#[derive(Debug, Default)]
pub struct MaintenanceState {
    scan: AtomicBool,
    cleanup: AtomicBool,
}

struct Flight<'a>(&'a AtomicBool);

impl<'a> Flight<'a> {
    fn take(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Self(flag))
    }
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Unsupported off Unix: answered honestly instead of pretending.
#[cfg(not(unix))]
pub(crate) fn maintenance_inventory(
    _inner: &ServerInner,
    _p: MaintenanceInventoryParams,
) -> Result<serde_json::Value, SvcFailure> {
    Err(SvcFailure::from((
        ErrorCode::Internal,
        "maintenance is not supported on this platform; nothing was scanned".to_string(),
    )))
}

#[cfg(not(unix))]
pub(crate) fn maintenance_cleanup(
    _inner: &ServerInner,
    _p: MaintenanceCleanupParams,
) -> Result<serde_json::Value, SvcFailure> {
    Err(SvcFailure::from((
        ErrorCode::Internal,
        "maintenance is not supported on this platform; nothing was changed".to_string(),
    )))
}

#[cfg(unix)]
pub(crate) use imp::{flock, maintenance_cleanup, maintenance_inventory};

#[cfg(unix)]
mod imp {
    use std::collections::{BTreeMap, BTreeSet, HashSet};
    use std::ffi::{CStr, CString, OsStr, OsString};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};
    use std::time::{Instant, SystemTime};

    use rusqlite::params;
    use sandpane_core::maintenance::{
        escape_display, escape_display_with_limit, format_utc, items_digest, parse_backup_name,
        parse_item_id, temp_uuid, ItemId, MAX_CLEANUP_ITEMS,
    };
    use sandpane_protocol::{
        MaintenanceCleanupResult, MaintenanceConfirmation, MaintenanceInventoryResult,
        MaintenanceItem, MaintenanceSkipped, MaintenanceTarget, MaintenanceUnavailable,
        MAINTENANCE_CLEANUP_ACTION, MAINTENANCE_KIND_DB_BACKUP, MAINTENANCE_KIND_TEMP,
        MAINTENANCE_KIND_VERIFICATION_OUTPUT, MAINTENANCE_KIND_WORKTREE,
    };

    use super::*;
    use crate::confirm::{self, ItemIdentity};
    use crate::rfc3339_from_unix;

    fn invalid(m: impl Into<String>) -> SvcFailure {
        SvcFailure::from((ErrorCode::ValidationFailed, m.into()))
    }

    fn conflict(m: &str) -> SvcFailure {
        SvcFailure::from((ErrorCode::Conflict, m.to_string()))
    }

    fn internal(m: impl std::fmt::Display) -> SvcFailure {
        SvcFailure::from((ErrorCode::Internal, m.to_string()))
    }

    fn limits(inner: &ServerInner) -> MaintenanceLimits {
        inner.test_maintenance_limits.unwrap_or_default()
    }

    fn unix_secs(t: SystemTime) -> u64 {
        t.duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    fn euid() -> u32 {
        crate::runtime::euid()
    }

    // ---------------------------------------------------------------------------
    // Descriptor-level file-system helpers (no path is ever taken from a client)
    // ---------------------------------------------------------------------------

    /// What Core compares: `(dev, ino)` for "the same file", plus size and
    /// mtime for the step-1 identity (W2).
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) struct Stat {
        dev: u64,
        ino: u64,
        mode: u32,
        uid: u32,
        size: u64,
        mtime_ns: i128,
    }

    impl Stat {
        #[allow(clippy::unnecessary_cast)] // field widths differ between macOS and Linux
        fn from_libc(s: &libc::stat) -> Self {
            Self {
                dev: s.st_dev as u64,
                ino: s.st_ino as u64,
                mode: s.st_mode as u32,
                uid: s.st_uid as u32,
                size: s.st_size as u64,
                mtime_ns: (s.st_mtime as i128) * 1_000_000_000 + (s.st_mtime_nsec as i128),
            }
        }

        fn from_meta(m: &std::fs::Metadata) -> Self {
            Self {
                dev: m.dev(),
                ino: m.ino(),
                mode: m.mode(),
                uid: m.uid(),
                size: m.size(),
                mtime_ns: i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec()),
            }
        }

        #[allow(clippy::unnecessary_cast)]
        fn kind(&self) -> u32 {
            self.mode & (libc::S_IFMT as u32)
        }

        #[allow(clippy::unnecessary_cast)]
        fn is_dir(&self) -> bool {
            self.kind() == libc::S_IFDIR as u32
        }

        #[allow(clippy::unnecessary_cast)]
        fn is_reg(&self) -> bool {
            self.kind() == libc::S_IFREG as u32
        }

        fn same_file(&self, o: &Stat) -> bool {
            self.dev == o.dev && self.ino == o.ino
        }

        fn mtime(&self) -> SystemTime {
            let secs = self.mtime_ns.div_euclid(1_000_000_000);
            let nanos = self.mtime_ns.rem_euclid(1_000_000_000) as u32;
            if secs >= 0 {
                SystemTime::UNIX_EPOCH + Duration::new(secs as u64, nanos)
            } else {
                SystemTime::UNIX_EPOCH
            }
        }

        fn identity(&self, id: &str) -> ItemIdentity {
            ItemIdentity {
                id: id.to_string(),
                dev: self.dev,
                ino: self.ino,
                size: self.size,
                mtime_ns: self.mtime_ns,
            }
        }

        fn matches(&self, i: &ItemIdentity) -> bool {
            self.dev == i.dev
                && self.ino == i.ino
                && self.size == i.size
                && self.mtime_ns == i.mtime_ns
        }
    }

    fn cstring(name: &OsStr) -> std::io::Result<CString> {
        CString::new(name.as_bytes()).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))
    }

    fn retry_eintr<F: FnMut() -> libc::c_int>(mut f: F) -> std::io::Result<libc::c_int> {
        loop {
            let r = f();
            if r >= 0 {
                return Ok(r);
            }
            let e = std::io::Error::last_os_error();
            if e.raw_os_error() != Some(libc::EINTR) {
                return Err(e);
            }
        }
    }

    /// `flock(op)` on `file`, retried on EINTR. `flock` only, never `fcntl` /
    /// `lockf` (§3.9 item 2: POSIX record locks would not conflict within one
    /// process and a leaked descriptor would behave differently).
    pub(crate) fn flock(file: &std::fs::File, op: libc::c_int) -> std::io::Result<()> {
        let fd = file.as_raw_fd();
        // SAFETY: flock on a descriptor `file` owns for the duration of the call.
        retry_eintr(|| unsafe { libc::flock(fd, op) }).map(|_| ())
    }

    /// `flock(LOCK_EX|LOCK_NB)`: `Ok(true)` acquired, `Ok(false)` held elsewhere.
    fn try_flock(file: &std::fs::File) -> std::io::Result<bool> {
        match flock(file, libc::LOCK_EX | libc::LOCK_NB) {
            Ok(()) => Ok(true),
            Err(e) if e.raw_os_error() == Some(libc::EWOULDBLOCK) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Open a directory without following a final symlink.
    fn open_dir(path: &Path) -> std::io::Result<OwnedFd> {
        let c = cstring(path.as_os_str())?;
        // SAFETY: valid NUL-terminated path; the returned fd is owned below.
        let fd = retry_eintr(|| unsafe {
            libc::open(
                c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        })?;
        // SAFETY: `fd` is a fresh descriptor this function owns.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn fstat(fd: RawFd) -> std::io::Result<Stat> {
        let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: `fd` is open; `st` is written by fstat on success.
        retry_eintr(|| unsafe { libc::fstat(fd, st.as_mut_ptr()) })?;
        // SAFETY: fstat succeeded, so `st` is initialised.
        Ok(Stat::from_libc(unsafe { &st.assume_init() }))
    }

    /// `fstatat(dirfd, name, AT_SYMLINK_NOFOLLOW)`.
    fn fstatat(dirfd: RawFd, name: &OsStr) -> std::io::Result<Stat> {
        let c = cstring(name)?;
        let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: `dirfd` is open, `c` is NUL-terminated, `st` is written on
        // success.
        retry_eintr(|| unsafe {
            libc::fstatat(
                dirfd,
                c.as_ptr(),
                st.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        })?;
        // SAFETY: fstatat succeeded.
        Ok(Stat::from_libc(unsafe { &st.assume_init() }))
    }

    /// The cleaner's open of a lock file (§3.9 item 2): `O_RDONLY|O_NOFOLLOW|
    /// O_NONBLOCK|O_CLOEXEC`, never `O_CREAT` — a FIFO cannot block the scan
    /// and a symlink is refused (`ELOOP`).
    fn open_lock_probe(dirfd: RawFd, name: &OsStr) -> std::io::Result<std::fs::File> {
        let c = cstring(name)?;
        // SAFETY: `dirfd` is open, `c` NUL-terminated; the fd is owned below.
        let fd = retry_eintr(|| unsafe {
            libc::openat(
                dirfd,
                c.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        })?;
        // SAFETY: fresh descriptor owned by the returned File.
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    fn unlinkat(dirfd: RawFd, name: &OsStr) -> std::io::Result<()> {
        let c = cstring(name)?;
        // SAFETY: `dirfd` is open, `c` NUL-terminated.
        retry_eintr(|| unsafe { libc::unlinkat(dirfd, c.as_ptr(), 0) }).map(|_| ())
    }

    /// Read up to `cap` names from the directory `dirfd` (`.`/`..` skipped).
    /// `true` = more entries were left unread.
    fn list_dir(dirfd: RawFd, cap: usize) -> std::io::Result<(Vec<OsString>, bool)> {
        // SAFETY: dup of an open descriptor; fdopendir takes ownership of the
        // duplicate and closedir releases it.
        let dup = retry_eintr(|| unsafe { libc::fcntl(dirfd, libc::F_DUPFD_CLOEXEC, 0) })?;
        // SAFETY: `dup` is a fresh, open directory descriptor.
        let dir = unsafe { libc::fdopendir(dup) };
        if dir.is_null() {
            let e = std::io::Error::last_os_error();
            // SAFETY: fdopendir failed, so `dup` is still ours to close.
            unsafe { libc::close(dup) };
            return Err(e);
        }
        // SAFETY: `dir` is a valid DIR*.
        unsafe { libc::rewinddir(dir) };
        let mut names = Vec::new();
        let mut more = false;
        loop {
            // SAFETY: `dir` is valid until closedir below.
            let ent = unsafe { libc::readdir(dir) };
            if ent.is_null() {
                break;
            }
            // SAFETY: readdir returned a valid dirent whose d_name is
            // NUL-terminated.
            let name = unsafe { CStr::from_ptr((*ent).d_name.as_ptr()) }.to_bytes();
            if name == b"." || name == b".." {
                continue;
            }
            if names.len() >= cap {
                more = true;
                break;
            }
            names.push(OsStr::from_bytes(name).to_os_string());
        }
        // SAFETY: `dir` came from fdopendir and is closed exactly once.
        unsafe { libc::closedir(dir) };
        names.sort();
        Ok((names, more))
    }

    /// A Core-private directory: real directory, owned by the effective uid,
    /// no group/other bits. Returns its identity.
    fn check_private_dir(path: &Path) -> Result<Stat, String> {
        let m = std::fs::symlink_metadata(path).map_err(|e| format!("cannot stat it: {e}"))?;
        if m.file_type().is_symlink() {
            return Err("it is a symlink".into());
        }
        let st = Stat::from_meta(&m);
        if !st.is_dir() {
            return Err("it is not a directory".into());
        }
        if st.uid != euid() {
            return Err("it is not owned by you".into());
        }
        if st.mode & 0o077 != 0 {
            return Err(format!(
                "it is group/other-accessible ({:04o})",
                st.mode & 0o7777
            ));
        }
        Ok(st)
    }

    fn created_at(path: &Path) -> Option<String> {
        std::fs::symlink_metadata(path)
            .ok()?
            .created()
            .ok()
            .map(|t| rfc3339_from_unix(unix_secs(t)))
    }

    fn older_than(t: SystemTime, now: SystemTime, age: Duration) -> bool {
        now.duration_since(t).map(|d| d >= age).unwrap_or(false)
    }

    // ---------------------------------------------------------------------------
    // The data directory and `<data>/tmp`, opened once per call (W7)
    // ---------------------------------------------------------------------------

    struct Roots {
        data: Option<PathBuf>,
        /// The data directory passed its owner / 0700 / not-a-symlink check
        /// (review I1: otherwise no dbBackup is removable).
        data_ok: bool,
        /// `Err(reason)` = the temp kind is unavailable for this call.
        tmp: Result<Option<TmpRoot>, String>,
        /// `Err(reason)` = the worktree kind is unavailable for this call.
        worktrees: Result<Option<PathBuf>, String>,
    }

    struct TmpRoot {
        path: PathBuf,
        fd: OwnedFd,
        stat: Stat,
    }

    impl Roots {
        fn open(inner: &ServerInner) -> Self {
            let Some(wt) = inner.worktrees_root.as_deref() else {
                return Self {
                    data: None,
                    data_ok: false,
                    tmp: Err(UNAVAILABLE_NO_DATA_DIR.into()),
                    worktrees: Err(UNAVAILABLE_NO_DATA_DIR.into()),
                };
            };
            let Some(data) = wt.parent().map(Path::to_path_buf) else {
                return Self {
                    data: None,
                    data_ok: false,
                    tmp: Err(UNAVAILABLE_NO_DATA_DIR.into()),
                    worktrees: Err(UNAVAILABLE_NO_DATA_DIR.into()),
                };
            };
            if let Err(why) = check_private_dir(&data) {
                let r = unsafe_root("data directory", &why);
                return Self {
                    data: Some(data),
                    data_ok: false,
                    tmp: Err(r.clone()),
                    worktrees: Err(r),
                };
            }
            let tmp_path = data.join("tmp");
            let tmp = match std::fs::symlink_metadata(&tmp_path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                _ => match check_private_dir(&tmp_path) {
                    Err(why) => Err(unsafe_root("temporary directory", &why)),
                    Ok(st) => match open_dir(&tmp_path).and_then(|fd| {
                        let s = fstat(fd.as_raw_fd())?;
                        Ok((fd, s))
                    }) {
                        Ok((fd, s)) if s.same_file(&st) => Ok(Some(TmpRoot {
                            path: tmp_path,
                            fd,
                            stat: s,
                        })),
                        Ok(_) => Err(unsafe_root(
                            "temporary directory",
                            "it changed while Core opened it",
                        )),
                        Err(e) => Err(unsafe_root("temporary directory", &e.to_string())),
                    },
                },
            };
            let worktrees = match std::fs::symlink_metadata(wt) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Ok(m) if m.is_dir() && !m.file_type().is_symlink() => Ok(Some(wt.to_path_buf())),
                _ => Err(unsafe_root(
                    "worktree directory",
                    "it is not a real directory",
                )),
            };
            Self {
                data: Some(data),
                data_ok: true,
                tmp,
                worktrees,
            }
        }

        /// W7: immediately before a removal under `tmp/`, the data directory and
        /// `tmp/` pass the owner / 0700 / not-a-symlink checks again and `tmp/`
        /// is still the directory opened at the start of the call.
        fn recheck_tmp(&self, tmp: &TmpRoot) -> Result<(), String> {
            let data = self.data.as_deref().ok_or(UNAVAILABLE_NO_DATA_DIR)?;
            check_private_dir(data).map_err(|why| unsafe_root("data directory", &why))?;
            let now = check_private_dir(&tmp.path)
                .map_err(|why| unsafe_root("temporary directory", &why))?;
            if !now.same_file(&tmp.stat) {
                return Err(unsafe_root(
                    "temporary directory",
                    "it was replaced during the cleanup",
                ));
            }
            Ok(())
        }
    }

    // ---------------------------------------------------------------------------
    // Inventory
    // ---------------------------------------------------------------------------

    /// What step 2 needs to act on an entry.
    #[derive(Debug, Clone)]
    enum Target {
        /// The UUID as read from `<data>/tmp` by this inventory.
        Temp(uuid::Uuid),
        DbBackup {
            dir: PathBuf,
            name: OsString,
            n: u64,
            size: u64,
        },
        VerificationOutput,
        None,
    }

    #[derive(Debug, Clone)]
    struct Entry {
        item: MaintenanceItem,
        target: Target,
        identity: Option<Stat>,
    }

    struct Scan {
        entries: Vec<Entry>,
        truncated: bool,
        unavailable: Vec<MaintenanceUnavailable>,
    }

    impl Scan {
        fn find(&self, id: &str) -> Option<&Entry> {
            self.entries.iter().find(|e| e.item.id == id)
        }

        fn unavailable(&self, kind: &str) -> Option<&str> {
            self.unavailable
                .iter()
                .find(|u| u.kind == kind)
                .map(|u| u.reason.as_str())
        }
    }

    fn item(
        id: String,
        kind: &str,
        removable: Result<(), String>,
        detail: String,
    ) -> MaintenanceItem {
        MaintenanceItem {
            id,
            kind: kind.to_string(),
            removable: removable.is_ok(),
            bytes: None,
            size_incomplete: None,
            created_at: None,
            detail: escape_display(detail.as_bytes()),
            reason: removable.err().map(|r| escape_display(r.as_bytes())),
            path: None,
            repository_path: None,
        }
    }

    /// What the scanners accumulate.
    #[derive(Default)]
    struct Acc {
        entries: Vec<Entry>,
        foreign: Vec<Foreign>,
        truncated: bool,
        unavailable: Vec<MaintenanceUnavailable>,
    }

    /// A foreign entry awaiting its `foreign:<n>` id.
    struct Foreign {
        kind: &'static str,
        key: Vec<u8>,
        item: MaintenanceItem,
    }

    /// The temp probe shared by the inventory and step 2 (§3.9 item 2 `temp`).
    struct TempProbe {
        verdict: Result<(), &'static str>,
        dir: Option<Stat>,
        lock: Option<Stat>,
        /// The `LOCK_NB` probe lock, held until dropped (step 2 keeps it across
        /// the removal and the unlink).
        held: Option<std::fs::File>,
    }

    impl TempProbe {
        fn identity(&self) -> Option<Stat> {
            self.dir.or(self.lock)
        }
    }

    /// Probe `<uuid>` / `<uuid>.live` under the open `tmp/` descriptor.
    /// `None` = neither exists any more.
    fn probe_temp(
        inner: &ServerInner,
        dirfd: RawFd,
        uuid: uuid::Uuid,
        now: SystemTime,
    ) -> Option<TempProbe> {
        let name = OsString::from(uuid.to_string());
        let lock_name = OsString::from(format!("{uuid}.live"));
        let dir = fstatat(dirfd, &name).ok();
        let lock_stat = fstatat(dirfd, &lock_name).ok();
        if dir.is_none() && lock_stat.is_none() {
            return None;
        }
        let reject = |why: &'static str| TempProbe {
            verdict: Err(why),
            dir,
            lock: lock_stat,
            held: None,
        };
        if inner
            .temp_registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&uuid)
        {
            return Some(reject(REASON_THIS_CORE));
        }
        if let Some(d) = dir {
            if !(d.is_dir() && d.uid == euid()) {
                return Some(reject(REASON_NOT_DIR));
            }
        }
        let file = match open_lock_probe(dirfd, &lock_name) {
            Ok(f) => Some(f),
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) => None,
            // ELOOP (a symlink), EACCES, …: not a lock file Core made.
            Err(_) => return Some(reject(REASON_BAD_LOCK)),
        };
        let Some(file) = file else {
            // Lock-absent (a pre-A9 Core's directory, or the lock file vanished).
            let d = dir?;
            let old = older_than(d.mtime(), now, MIN_AGE) && d.mtime() < inner.started_at;
            return Some(TempProbe {
                verdict: if old {
                    Ok(())
                } else {
                    Err(REASON_UNLOCKED_RECENT)
                },
                dir,
                lock: None,
                held: None,
            });
        };
        let Ok(fd_stat) = fstat(file.as_raw_fd()) else {
            return Some(reject(REASON_BAD_LOCK));
        };
        if !(fd_stat.is_reg() && fd_stat.uid == euid()) {
            return Some(reject(REASON_BAD_LOCK));
        }
        match try_flock(&file) {
            Ok(true) => {}
            Ok(false) => return Some(reject(REASON_LIVE)),
            Err(_) => return Some(reject(REASON_BAD_LOCK)),
        }
        // Re-stat the path: proceed only if it still names the locked file.
        match fstatat(dirfd, &lock_name) {
            Ok(p) if p.same_file(&fd_stat) => {}
            _ => return Some(reject(REASON_CHANGED_DURING_SCAN)),
        }
        let verdict = if dir.is_none() && !older_than(fd_stat.mtime(), now, MIN_AGE) {
            // Between an owner's flock and its mkdir: never removed.
            Err(REASON_RECENT_LOCK)
        } else {
            Ok(())
        };
        Some(TempProbe {
            verdict,
            dir,
            lock: Some(fd_stat),
            held: Some(file),
        })
    }

    fn scan_temp(
        inner: &ServerInner,
        roots: &Roots,
        lim: &MaintenanceLimits,
        now: SystemTime,
        acc: &mut Acc,
    ) {
        let tmp = match &roots.tmp {
            Err(reason) => {
                acc.unavailable.push(MaintenanceUnavailable {
                    kind: MAINTENANCE_KIND_TEMP.into(),
                    reason: escape_display(reason.as_bytes()),
                });
                return;
            }
            Ok(None) => return,
            Ok(Some(t)) => t,
        };
        let (names, more) = match list_dir(tmp.fd.as_raw_fd(), lim.max_dir_entries) {
            Ok(v) => v,
            Err(e) => {
                acc.unavailable.push(MaintenanceUnavailable {
                    kind: MAINTENANCE_KIND_TEMP.into(),
                    reason: escape_display(
                        unsafe_root("temporary directory", &e.to_string()).as_bytes(),
                    ),
                });
                return;
            }
        };
        acc.truncated |= more;
        let mut uuids = BTreeSet::new();
        for name in &names {
            let s = name.to_str();
            if let Some(u) = s.and_then(temp_uuid) {
                uuids.insert(u);
            } else if let Some(u) = s.and_then(|s| s.strip_suffix(".live")).and_then(temp_uuid) {
                uuids.insert(u);
            } else {
                let mut detail = b"tmp/".to_vec();
                detail.extend_from_slice(name.as_bytes());
                let mut it = item(
                    String::new(),
                    MAINTENANCE_KIND_TEMP,
                    Err(REASON_FOREIGN.into()),
                    String::new(),
                );
                it.detail = escape_display(&detail);
                acc.foreign.push(Foreign {
                    kind: MAINTENANCE_KIND_TEMP,
                    key: name.as_bytes().to_vec(),
                    item: it,
                });
            }
        }
        for u in uuids {
            // Inventory releases its probe lock before answering (drop here).
            let Some(p) = probe_temp(inner, tmp.fd.as_raw_fd(), u, now) else {
                continue;
            };
            let detail = if p.dir.is_some() {
                format!("Core temporary directory {u}")
            } else {
                format!("Core temporary lock file {u}.live with no directory")
            };
            let mut it = item(
                format!("temp:{u}"),
                MAINTENANCE_KIND_TEMP,
                p.verdict.map_err(str::to_string),
                detail,
            );
            it.created_at = created_at(&tmp.path.join(u.to_string()));
            acc.entries.push(Entry {
                item: it,
                target: Target::Temp(u),
                identity: p.identity(),
            });
        }
    }

    fn scan_db_backups(
        inner: &ServerInner,
        roots: &Roots,
        lim: &MaintenanceLimits,
        within_budget: &dyn Fn() -> bool,
        acc: &mut Acc,
    ) {
        let db_path = {
            let db = inner.lock_db();
            db.path().map(Path::to_path_buf)
        };
        let Some(db_path) = db_path else {
            return;
        };
        let (Some(dir), Some(file_name)) = (
            db_path.parent().map(Path::to_path_buf),
            db_path
                .file_name()
                .and_then(OsStr::to_str)
                .map(str::to_string),
        ) else {
            return;
        };
        // W3: removable only when the database sits in Sandpane's own data
        // directory (both sides canonicalised: /var vs /private/var).
        let inside = match (&roots.data, std::fs::canonicalize(&dir)) {
            (Some(data), Ok(dir_c)) if roots.data_ok => std::fs::canonicalize(data)
                .map(|d| d == dir_c)
                .unwrap_or(false),
            _ => false,
        };
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return;
        };
        let mut found: Vec<(String, u64, u64, Option<Stat>, SystemTime)> = Vec::new();
        let mut seen = 0usize;
        for ent in rd.flatten() {
            seen += 1;
            if seen > lim.max_dir_entries {
                acc.truncated = true;
                break;
            }
            let Some(name) = ent.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Some((n, k)) = parse_backup_name(&file_name, &name) else {
                continue;
            };
            let meta = std::fs::symlink_metadata(dir.join(&name))
                .ok()
                .filter(|m| !m.file_type().is_symlink());
            // Recency: birth time where the platform has one, else mtime.
            // NOT `k`: db.rs reuses the first free `.bak[.k]` slot, so a
            // re-created `.bak` can be newer than `.bak.1` (review W1).
            let recency = meta
                .as_ref()
                .and_then(|m| m.created().or_else(|_| m.modified()).ok())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            let st = meta
                .map(|m| Stat::from_meta(&m))
                .filter(|s| s.is_reg() && s.uid == euid());
            found.push((name, n, k, st, recency));
        }
        // Protected (review W1): the UNION of the newest real backup with
        // N == LATEST_SCHEMA_VERSION and the newest real backup overall
        // (highest N, then most recent); ties broken by k, then name.
        let newest_where = |want: Option<u64>| -> Option<String> {
            found
                .iter()
                .filter(|(_, n, _, st, _)| st.is_some() && want.is_none_or(|w| *n == w))
                .max_by(|a, b| (a.1, a.4, a.2, &a.0).cmp(&(b.1, b.4, b.2, &b.0)))
                .map(|(name, ..)| name.clone())
        };
        let latest = u64::try_from(sandpane_core::db::LATEST_SCHEMA_VERSION).ok();
        let protected: Vec<String> = [newest_where(latest), newest_where(None)]
            .into_iter()
            .flatten()
            .collect();
        for (name, n, _k, st, _) in found {
            let verdict = if !inside {
                Err(REASON_DB_OUTSIDE)
            } else if st.is_none() {
                Err(REASON_DB_NOT_FILE)
            } else if protected.contains(&name) {
                Err(REASON_DB_NEWEST)
            } else {
                Ok(())
            };
            let mut detail = format!(
                "migration backup taken before schema v{n} (a copy of the database at schema v{})",
                n.saturating_sub(1)
            );
            if let Some(s) = st {
                let mode = s.mode & 0o7777;
                if mode & !0o600 != 0 {
                    detail.push_str(&format!(
                        "; its mode {mode:04o} is wider than 0600, so other users may be able to \
                         read it"
                    ));
                }
            }
            let mut it = item(
                format!("dbBackup:{name}"),
                MAINTENANCE_KIND_DB_BACKUP,
                verdict.map_err(str::to_string),
                detail,
            );
            if let Some(s) = st {
                if within_budget() {
                    it.bytes = Some(s.size);
                }
            }
            it.created_at = created_at(&dir.join(&name));
            acc.entries.push(Entry {
                item: it,
                target: Target::DbBackup {
                    dir: dir.clone(),
                    name: OsString::from(&name),
                    n,
                    size: st.map(|s| s.size).unwrap_or(0),
                },
                identity: st,
            });
        }
    }

    /// The predicate of §3.9 item 2 `verificationOutput` (`?1` = the cutoff).
    const VO_PREDICATE: &str = "status IN ('finished', 'interrupted') AND finished_at IS NOT NULL \
         AND finished_at < ?1 AND output_pruned = 0";

    fn vo_count(inner: &ServerInner, cutoff: &str) -> Result<i64, rusqlite::Error> {
        let db = inner.lock_db();
        db.conn().query_row(
            &format!("SELECT COUNT(*) FROM verification_runs WHERE {VO_PREDICATE}"),
            params![cutoff],
            |r| r.get(0),
        )
    }

    /// Stored bytes, not characters (`length()` on TEXT counts characters).
    fn vo_bytes(inner: &ServerInner, cutoff: &str) -> Result<i64, rusqlite::Error> {
        let db = inner.lock_db();
        db.conn().query_row(
            &format!(
                "SELECT COALESCE(SUM(length(CAST(stdout AS BLOB)) + length(CAST(stderr AS BLOB))), 0)
                 FROM verification_runs WHERE {VO_PREDICATE}"
            ),
            params![cutoff],
            |r| r.get(0),
        )
    }

    fn plural(n: i64, one: &str, many: &str) -> String {
        format!("{n} {}", if n == 1 { one } else { many })
    }

    fn scan_verification_output(
        inner: &ServerInner,
        now: SystemTime,
        within_budget: &dyn Fn() -> bool,
        acc: &mut Acc,
    ) -> Result<(), SvcFailure> {
        let retention = inner.verification_output_retention;
        let cutoff = format_utc(unix_secs(now).saturating_sub(retention.as_secs()));
        let count = vo_count(inner, &cutoff).map_err(internal)?;
        if count > 0 {
            let mut it = item(
                format!("verificationOutput:{cutoff}"),
                MAINTENANCE_KIND_VERIFICATION_OUTPUT,
                Ok(()),
                format!(
                    "stored output of {} that finished before {cutoff} (older than {} days)",
                    plural(count, "verification run", "verification runs"),
                    retention.as_secs() / 86_400
                ),
            );
            if within_budget() {
                it.bytes =
                    Some(u64::try_from(vo_bytes(inner, &cutoff).map_err(internal)?).unwrap_or(0));
            }
            acc.entries.push(Entry {
                item: it,
                target: Target::VerificationOutput,
                identity: None,
            });
        }
        Ok(())
    }

    fn scan_worktrees(
        inner: &ServerInner,
        roots: &Roots,
        lim: &MaintenanceLimits,
        now: SystemTime,
        acc: &mut Acc,
    ) -> Result<(), SvcFailure> {
        let root = match &roots.worktrees {
            Err(reason) => {
                acc.unavailable.push(MaintenanceUnavailable {
                    kind: MAINTENANCE_KIND_WORKTREE.into(),
                    reason: escape_display(reason.as_bytes()),
                });
                return Ok(());
            }
            Ok(r) => r.clone(),
        };
        // Database reads first, the DB mutex released before any stat.
        let (tracked, referenced) = {
            let db = inner.lock_db();
            let mut stmt = db
                .conn()
                .prepare(
                    "SELECT t.id, t.worktree_path, r.canonical_path FROM tasks t
                     LEFT JOIN repositories r ON r.id = t.repo_id
                     WHERE t.worktree_path IS NOT NULL AND t.worktree_removed_at IS NULL
                       AND t.status IN ('completed', 'rejected', 'failed', 'cancelled')
                     ORDER BY t.id",
                )
                .map_err(internal)?;
            let tracked = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                })
                .map_err(internal)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(internal)?;
            let mut stmt = db
                .conn()
                .prepare(
                    "SELECT worktree_path FROM tasks
                     WHERE worktree_path IS NOT NULL AND worktree_removed_at IS NULL",
                )
                .map_err(internal)?;
            let referenced = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(internal)?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(internal)?;
            (tracked, referenced)
        };
        for (task, path, repo) in tracked {
            let detail = DETAIL_TRACKED.to_string();
            let mut it = item(
                format!("worktree:{task}"),
                MAINTENANCE_KIND_WORKTREE,
                Err(REASON_WORKTREE.into()),
                detail,
            );
            it.path = Some(escape_display_with_limit(path.as_bytes(), 4096));
            it.repository_path = repo.map(|r| escape_display_with_limit(r.as_bytes(), 4096));
            if parse_item_id(&it.id).is_ok() {
                acc.entries.push(Entry {
                    item: it,
                    target: Target::None,
                    identity: None,
                });
            } else {
                acc.foreign.push(Foreign {
                    kind: MAINTENANCE_KIND_WORKTREE,
                    key: path.into_bytes(),
                    item: it,
                });
            }
        }
        let Some(root) = root else {
            return Ok(());
        };
        let root_c = std::fs::canonicalize(&root).unwrap_or(root.clone());
        let Ok(fd) = open_dir(&root) else {
            return Ok(());
        };
        let Ok((names, more)) = list_dir(fd.as_raw_fd(), lim.max_dir_entries) else {
            return Ok(());
        };
        acc.truncated |= more;
        for name in names {
            let full = root_c.join(&name);
            let plain = root.join(&name);
            let referenced_here = [&full, &plain]
                .iter()
                .any(|p| p.to_str().map(|s| referenced.contains(s)).unwrap_or(false));
            if referenced_here {
                continue;
            }
            // A stat of the entry itself, never a read inside it (W6).
            let Ok(st) = fstatat(fd.as_raw_fd(), &name) else {
                continue;
            };
            if !st.is_dir() {
                continue;
            }
            // I7: a worktree being allocated exists before its task row commits.
            if !older_than(st.mtime(), now, MIN_AGE) {
                continue;
            }
            let mut it = item(
                String::new(),
                MAINTENANCE_KIND_WORKTREE,
                Err(REASON_WORKTREE.into()),
                DETAIL_ORPHAN.into(),
            );
            it.path = Some(escape_display_with_limit(full.as_os_str().as_bytes(), 4096));
            acc.foreign.push(Foreign {
                kind: MAINTENANCE_KIND_WORKTREE,
                key: name.as_bytes().to_vec(),
                item: it,
            });
        }
        Ok(())
    }

    /// One fresh inventory. NOT single-flight itself: the `maintenance.inventory`
    /// handler and both cleanup steps call it under their own flag.
    fn scan(inner: &ServerInner, roots: &Roots, now: SystemTime) -> Result<Scan, SvcFailure> {
        let lim = limits(inner);
        let deadline = Instant::now() + lim.budget;
        let within_budget = || Instant::now() < deadline;
        let mut acc = Acc::default();
        scan_temp(inner, roots, &lim, now, &mut acc);
        scan_db_backups(inner, roots, &lim, &within_budget, &mut acc);
        scan_verification_output(inner, now, &within_budget, &mut acc)?;
        scan_worktrees(inner, roots, &lim, now, &mut acc)?;
        let Acc {
            mut entries,
            mut foreign,
            truncated,
            unavailable,
        } = acc;
        // Deterministic foreign ids: by kind, then the entry's raw name.
        foreign.sort_by(|a, b| (a.kind, &a.key).cmp(&(b.kind, &b.key)));
        for (n, f) in foreign.into_iter().enumerate() {
            let mut it = f.item;
            it.id = format!("foreign:{n}");
            entries.push(Entry {
                item: it,
                target: Target::None,
                identity: None,
            });
        }
        entries.sort_by(|a, b| (&a.item.kind, &a.item.id).cmp(&(&b.item.kind, &b.item.id)));
        // NOT capped here: the cleanup steps look ids up in the whole fresh
        // inventory; only the inventory ANSWER is capped (item 1).
        Ok(Scan {
            entries,
            truncated,
            unavailable,
        })
    }

    pub(crate) fn maintenance_inventory(
        inner: &ServerInner,
        _p: MaintenanceInventoryParams,
    ) -> Result<serde_json::Value, SvcFailure> {
        let Some(_flight) = Flight::take(&inner.maintenance.scan) else {
            return Err(conflict(MSG_SCAN_BUSY));
        };
        if let Some(h) = &inner.test_maintenance_in_flight {
            (h.0)(inner);
        }
        let roots = Roots::open(inner);
        let s = scan(inner, &roots, SystemTime::now())?;
        let lim = limits(inner);
        // Measured with the longer `false` so the final answer never grows.
        let mut result = MaintenanceInventoryResult {
            items: Vec::new(),
            truncated: false,
            unavailable: s.unavailable,
        };
        // Measured, not assumed (§3.9 item 1 "below the frame backstop"):
        // display paths make an item's size vary, so the (kind, id)-ordered
        // list is cut from the tail where the answer would pass the limit.
        let envelope = serde_json::to_vec(&result).map_err(internal)?.len();
        let mut used = envelope;
        let total = s.entries.len();
        for e in s.entries.into_iter().take(lim.max_items) {
            let len = serde_json::to_vec(&e.item).map_err(internal)?.len() + 1;
            if used + len > lim.max_response_bytes {
                break;
            }
            used += len;
            result.items.push(e.item);
        }
        result.truncated = s.truncated || result.items.len() < total;
        serde_json::to_value(result).map_err(internal)
    }

    // ---------------------------------------------------------------------------
    // Cleanup
    // ---------------------------------------------------------------------------

    /// The W2 grammar gate on a client item list: count, duplicates, grammar.
    fn validate_items(items: &[String]) -> Result<Vec<(String, ItemId)>, SvcFailure> {
        if items.is_empty() {
            return Err(invalid(MSG_NO_ITEMS));
        }
        if items.len() > MAX_CLEANUP_ITEMS {
            return Err(invalid(MSG_TOO_MANY));
        }
        let mut seen = HashSet::new();
        if !items.iter().all(|i| seen.insert(i.as_str())) {
            return Err(invalid(MSG_DUPLICATE));
        }
        items
            .iter()
            .map(|i| {
                parse_item_id(i)
                    .map(|p| (i.clone(), p))
                    .map_err(|_| invalid(MSG_BAD_ID))
            })
            .collect()
    }

    /// §3.9 item 2: a cutoff is accepted only if `cutoff <= now − retention`.
    fn cutoff_allowed(inner: &ServerInner, unix: u64, now: SystemTime) -> bool {
        unix <= unix_secs(now).saturating_sub(inner.verification_output_retention.as_secs())
    }

    fn kind_of(p: &ItemId) -> &'static str {
        match p {
            ItemId::Temp(_) => MAINTENANCE_KIND_TEMP,
            ItemId::DbBackup(_) => MAINTENANCE_KIND_DB_BACKUP,
            ItemId::VerificationOutput { .. } => MAINTENANCE_KIND_VERIFICATION_OUTPUT,
            ItemId::Worktree(_) => MAINTENANCE_KIND_WORKTREE,
            ItemId::Foreign(_) => "foreign",
        }
    }

    pub(crate) fn maintenance_cleanup(
        inner: &ServerInner,
        p: MaintenanceCleanupParams,
    ) -> Result<serde_json::Value, SvcFailure> {
        let Some(_flight) = Flight::take(&inner.maintenance.cleanup) else {
            return Err(conflict(MSG_CLEANUP_BUSY));
        };
        // Review I3: cleanup and this Core's inventory exclude each other, so
        // no in-process scan probe holds a lock step 2 needs.
        let Some(_scan) = Flight::take(&inner.maintenance.scan) else {
            return Err(conflict(MSG_CLEANUP_SCAN_BUSY));
        };
        if let Some(h) = &inner.test_maintenance_in_flight {
            (h.0)(inner);
        }
        let result = match p.confirm_token {
            None => step1(inner, &p.items)?,
            Some(token) => step2(inner, &p.items, &token)?,
        };
        serde_json::to_value(result).map_err(internal)
    }

    /// Step 1: re-inventory, refuse unknown or not-removable ids, describe the
    /// impact and issue a token bound to the exact set (digest) plus the
    /// step-1 identities. Changes nothing.
    fn step1(
        inner: &ServerInner,
        items: &[String],
    ) -> Result<MaintenanceCleanupResult, SvcFailure> {
        let parsed = validate_items(items)?;
        let now = SystemTime::now();
        let roots = Roots::open(inner);
        let s = scan(inner, &roots, now)?;
        let mut identities = Vec::new();
        let mut temps = 0usize;
        let mut backups: Vec<String> = Vec::new();
        let mut vo_line = None;
        for (id, p) in &parsed {
            if let ItemId::VerificationOutput { cutoff, unix } = p {
                if !cutoff_allowed(inner, *unix, now) {
                    return Err(invalid(MSG_CUTOFF_TOO_LATE));
                }
                let n = vo_count(inner, cutoff).map_err(internal)?;
                if n == 0 {
                    return Err(invalid(msg_unknown(id)));
                }
                let bytes = vo_bytes(inner, cutoff).map_err(internal)?;
                vo_line = Some(format!(
                    "the stored output of {} that finished before {cutoff} ({bytes} bytes) is \
                     removed from Sandpane's records; the runs themselves are kept; the database \
                     file does not shrink, and older migration backups may still contain it",
                    plural(n, "verification run", "verification runs"),
                ));
                continue;
            }
            let Some(e) = s.find(id) else {
                return Err(invalid(msg_unknown(id)));
            };
            if !e.item.removable {
                let reason = e.item.reason.clone().unwrap_or_default();
                return Err(invalid(msg_not_removable(id, &reason)));
            }
            if let Some(st) = e.identity {
                identities.push(st.identity(id));
            }
            match &e.target {
                Target::Temp(_) => temps += 1,
                Target::DbBackup { n, size, .. } => backups.push(format!(
                    "{id}: a full copy of your projects, conversations and messages as they were at \
                     schema v{}, before Core migrated to v{n}; it is deleted for good ({size} bytes)",
                    n.saturating_sub(1)
                )),
                Target::VerificationOutput | Target::None => {}
            }
        }
        let mut impact = Vec::new();
        if temps > 0 {
            impact.push(format!(
                "{temps} Core temporary {} and {} lock {} deleted from Sandpane's data directory \
                 (sizes are not measured)",
                if temps == 1 {
                    "directory"
                } else {
                    "directories"
                },
                if temps == 1 { "its" } else { "their" },
                if temps == 1 { "file is" } else { "files are" },
            ));
        }
        impact.extend(backups);
        impact.extend(vo_line);
        impact.push(
            "nothing else is touched: no repository, worktree, sandbox or sbx setting".to_string(),
        );
        let ttl = inner.confirmation_ttl;
        let token = inner
            .lock_confirmations()
            .issue_with_identities(
                confirm::ConfirmationBinding {
                    action: MAINTENANCE_CLEANUP_ACTION.to_string(),
                    name: String::new(),
                    id: items_digest(items),
                },
                identities,
                Instant::now(),
                ttl,
            )
            .map_err(|e| {
                internal(format!(
                    "OS random source unavailable for a confirmation token: {e}"
                ))
            })?;
        Ok(MaintenanceCleanupResult {
            confirmation: Some(MaintenanceConfirmation {
                token,
                expires_at: rfc3339_from_unix(unix_secs(SystemTime::now() + ttl)),
                action: MAINTENANCE_CLEANUP_ACTION.to_string(),
                target: MaintenanceTarget {
                    items: items.to_vec(),
                },
                impact,
                external: false,
            }),
            removed: None,
            skipped: None,
            freed_bytes: None,
            notes: Vec::new(),
        })
    }

    /// A removed item: its measured size (absent = not measured) and an
    /// optional note that the removal was not complete in every respect.
    #[derive(Debug, Default)]
    struct Removed {
        bytes: Option<u64>,
        note: Option<String>,
    }

    /// One item's step-2 outcome: `Ok` removed, `Err(reason)` skipped
    /// (nothing destructive happened, or the reason says what did).
    type Outcome = Result<Removed, String>;

    /// Step 2: consume the token FIRST (every attempt burns it), then re-check
    /// and remove what still qualifies, in (kind, id) order. File-system work
    /// never runs under the DB mutex.
    fn step2(
        inner: &ServerInner,
        items: &[String],
        token: &str,
    ) -> Result<MaintenanceCleanupResult, SvcFailure> {
        let (_, identities) = inner
            .lock_confirmations()
            .consume_with_identities(
                token,
                MAINTENANCE_CLEANUP_ACTION,
                &items_digest(items),
                Instant::now(),
            )
            .map_err(|confirm::TokenRejected| invalid(confirm::TOKEN_REJECTED_MESSAGE))?;
        let mut parsed = validate_items(items)?;
        let now = SystemTime::now();
        for (_, p) in &parsed {
            if let ItemId::VerificationOutput { unix, .. } = p {
                if !cutoff_allowed(inner, *unix, now) {
                    return Err(invalid(MSG_CUTOFF_TOO_LATE));
                }
            }
        }
        let identities: BTreeMap<String, ItemIdentity> =
            identities.into_iter().map(|i| (i.id.clone(), i)).collect();
        parsed.sort_by(|a, b| (kind_of(&a.1), &a.0).cmp(&(kind_of(&b.1), &b.0)));
        let roots = Roots::open(inner);
        let s = scan(inner, &roots, now)?;
        let mut removed = Vec::new();
        let mut skipped = Vec::new();
        let mut freed: Option<u64> = Some(0);
        let mut notes = Vec::new();
        for (id, p) in &parsed {
            let outcome: Outcome = match p {
                ItemId::Temp(_) => remove_temp(inner, &roots, &s, id, identities.get(id), now),
                ItemId::DbBackup(_) => remove_backup(&roots, &s, id, identities.get(id)),
                ItemId::VerificationOutput { cutoff, .. } => prune_output(inner, cutoff),
                ItemId::Worktree(_) | ItemId::Foreign(_) => Err(s
                    .find(id)
                    .and_then(|e| e.item.reason.clone())
                    .unwrap_or_else(|| SKIP_GONE.to_string())),
            };
            let kind = kind_of(p);
            match outcome {
                Ok(Removed { bytes, note }) => {
                    eprintln!("sandpane-service: maintenance.cleanup {id} ({kind}): removed");
                    notes.extend(note);
                    match p {
                        ItemId::VerificationOutput { .. } => {
                            if !notes.iter().any(|n| n == NOTE_VERIFICATION_OUTPUT) {
                                notes.push(NOTE_VERIFICATION_OUTPUT.to_string());
                            }
                        }
                        _ => match bytes {
                            Some(b) => freed = freed.map(|f| f.saturating_add(b)),
                            None => {
                                freed = None;
                                if !notes.iter().any(|n| n == NOTE_TEMP_SIZES) {
                                    notes.push(NOTE_TEMP_SIZES.to_string());
                                }
                            }
                        },
                    }
                    removed.push(id.clone());
                }
                Err(reason) => {
                    eprintln!("sandpane-service: maintenance.cleanup {id} ({kind}): skipped");
                    skipped.push(MaintenanceSkipped {
                        id: id.clone(),
                        reason: escape_display(reason.as_bytes()),
                    });
                }
            }
        }
        Ok(MaintenanceCleanupResult {
            confirmation: None,
            removed: Some(removed),
            skipped: Some(skipped),
            freed_bytes: freed,
            notes,
        })
    }

    /// Remove one `temp` entry under the held probe lock (§3.9 items 2-3):
    /// remove the directory, unlink the lock file, and only then release the
    /// lock.
    fn remove_temp(
        inner: &ServerInner,
        roots: &Roots,
        s: &Scan,
        id: &str,
        expected: Option<&ItemIdentity>,
        now: SystemTime,
    ) -> Outcome {
        if let Some(reason) = s.unavailable(MAINTENANCE_KIND_TEMP) {
            return Err(reason.to_string());
        }
        let tmp = match &roots.tmp {
            Ok(Some(t)) => t,
            Ok(None) => return Err(SKIP_GONE.into()),
            Err(reason) => return Err(reason.clone()),
        };
        // W2: the name comes from Core's own fresh inventory, never from
        // the client's id.
        let Some(Target::Temp(uuid)) = s.find(id).map(|e| e.target.clone()) else {
            return Err(SKIP_GONE.into());
        };
        let dirfd = tmp.fd.as_raw_fd();
        let Some(probe) = probe_temp(inner, dirfd, uuid, now) else {
            return Err(SKIP_GONE.into());
        };
        probe.verdict.map_err(|r| {
            if r == REASON_LIVE {
                REASON_LIVE_OR_PROBED.to_string()
            } else {
                r.to_string()
            }
        })?;
        let current = probe.identity().ok_or_else(|| SKIP_GONE.to_string())?;
        if !expected.is_some_and(|e| current.matches(e)) {
            return Err(SKIP_CHANGED.into());
        }
        roots.recheck_tmp(tmp)?;
        let name = OsString::from(uuid.to_string());
        let lock_name = OsString::from(format!("{uuid}.live"));
        let mut dir_removed = false;
        if let Some(d) = probe.dir {
            match fstatat(dirfd, &name) {
                Ok(now_d) if now_d.same_file(&d) && now_d.is_dir() && now_d.uid == euid() => {}
                _ => return Err(SKIP_CHANGED.into()),
            }
            // remove_dir_all does not follow a symlink in the final component
            // or below it (Rust >= 1.58.1). Residual (accepted, W7): it takes a
            // path, so an intermediate-component swap after the re-check above
            // is not excluded.
            if let Err(e) = std::fs::remove_dir_all(tmp.path.join(&name)) {
                // Review W2: remove_dir_all may have deleted part of it.
                return Err(format!("partially removed ({}) — scan again", e.kind()));
            }
            dir_removed = true;
            if let Some(h) = &inner.test_cleanup_after_dir_removed {
                (h.0)(&tmp.path.join(&lock_name));
            }
        }
        // Review W2: once the directory is gone, the item is reported as
        // REMOVED even if its lock file cannot be — never as untouched.
        let lock_left = || Removed {
            bytes: None,
            note: Some(format!(
                "{id}: directory removed; its lock file changed or could not be removed — scan \
                 again"
            )),
        };
        if let (Some(l), Some(held)) = (probe.lock, probe.held) {
            match fstatat(dirfd, &lock_name) {
                Ok(p) if p.same_file(&l) => {
                    if let Err(e) = unlinkat(dirfd, &lock_name) {
                        if dir_removed {
                            return Ok(lock_left());
                        }
                        return Err(format!(
                            "its lock file could not be removed ({e}); scan again"
                        ));
                    }
                }
                _ if dir_removed => return Ok(lock_left()),
                _ => return Err(SKIP_CHANGED.into()),
            }
            if let Some(h) = &inner.test_cleanup_after_unlink {
                (h.0)(&tmp.path.join(&lock_name));
            }
            // Released only after the unlink.
            drop(held);
        }
        // Sizes of temp directories are not measured (no W5 walk in A9).
        Ok(Removed::default())
    }

    /// Remove one migration backup after the regular-file, owner and identity
    /// re-check (W3).
    fn remove_backup(
        roots: &Roots,
        s: &Scan,
        id: &str,
        expected: Option<&ItemIdentity>,
    ) -> Outcome {
        let Some(e) = s.find(id) else {
            return Err(SKIP_GONE.into());
        };
        if !e.item.removable {
            return Err(e.item.reason.clone().unwrap_or_default());
        }
        let Target::DbBackup { dir, name, .. } = &e.target else {
            return Err(SKIP_GONE.into());
        };
        let path = dir.join(name);
        let now = match std::fs::symlink_metadata(&path) {
            Ok(m) if !m.file_type().is_symlink() => Stat::from_meta(&m),
            Ok(_) => return Err(REASON_DB_NOT_FILE.into()),
            Err(_) => return Err(SKIP_GONE.into()),
        };
        if !(now.is_reg() && now.uid == euid()) {
            return Err(REASON_DB_NOT_FILE.into());
        }
        if !expected.is_some_and(|i| now.matches(i)) {
            return Err(SKIP_CHANGED.into());
        }
        // Review I1: the data directory passes its checks again right
        // before the removal.
        let data = roots.data.as_deref().ok_or(UNAVAILABLE_NO_DATA_DIR)?;
        check_private_dir(data).map_err(|why| unsafe_root("data directory", &why))?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(Removed {
                bytes: Some(now.size),
                note: None,
            }),
            Err(e) => Err(format!("could not be removed ({e}); scan again")),
        }
    }

    /// Prune the stored output of old runs in batches (§3.9 item 2): exactly
    /// the §3.9 `UPDATE` restricted to one batch of row ids per transaction,
    /// the DB mutex released between batches, `secure_delete` ON for those
    /// transactions only (best effort) and restored after each.
    fn prune_output(inner: &ServerInner, cutoff: &str) -> Outcome {
        let batch = i64::try_from(limits(inner).prune_batch.max(1)).unwrap_or(500);
        let total = vo_count(inner, cutoff).map_err(|e| format!("could not be read ({e})"))?;
        if total == 0 {
            return Err(SKIP_GONE.into());
        }
        let mut done: i64 = 0;
        loop {
            let n = {
                let db = inner.lock_db();
                let conn = db.conn();
                let previous: i64 = conn
                    .query_row("PRAGMA secure_delete", [], |r| r.get(0))
                    .unwrap_or(0);
                let _ = conn.execute_batch("PRAGMA secure_delete = 1;");
                let run = || -> Result<usize, rusqlite::Error> {
                    let tx = conn.unchecked_transaction()?;
                    let n = tx.execute(
                        &format!(
                            "UPDATE verification_runs SET stdout = '', stderr = '', output_pruned = 1
                             WHERE id IN (SELECT id FROM verification_runs WHERE {VO_PREDICATE}
                                          LIMIT ?2)
                               AND {VO_PREDICATE}"
                        ),
                        params![cutoff, batch],
                    )?;
                    tx.commit()?;
                    Ok(n)
                };
                let n = run();
                let _ = conn.execute_batch(&format!("PRAGMA secure_delete = {previous};"));
                n
            };
            match n {
                Ok(n) => {
                    done += n as i64;
                    if (n as i64) < batch {
                        break;
                    }
                }
                Err(e) => {
                    return Err(if done > 0 {
                        format!("partially pruned: {done} of {total} runs before an error ({e}); scan again")
                    } else {
                        format!("could not be pruned ({e}); scan again")
                    });
                }
            }
        }
        // Review I2: fold the pruned pages out of the WAL file (best effort;
        // a busy checkpoint is ignored — the note says copies may remain).
        {
            let db = inner.lock_db();
            let _ = db
                .conn()
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        }
        Ok(Removed::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_defaults_to_30_days_and_is_clamped() {
        const DAY: u64 = 86_400;
        assert_eq!(retention_from_config(None), Duration::from_secs(30 * DAY));
        assert_eq!(
            retention_from_config(Some(Duration::ZERO)),
            Duration::from_secs(DAY)
        );
        assert_eq!(
            retention_from_config(Some(Duration::from_secs(10 * DAY))),
            Duration::from_secs(10 * DAY)
        );
        assert_eq!(
            retention_from_config(Some(Duration::from_secs(100_000 * DAY))),
            Duration::from_secs(3650 * DAY)
        );
    }

    #[test]
    fn single_flight_flags_are_exclusive_and_released_on_drop() {
        let state = MaintenanceState::default();
        let a = Flight::take(&state.scan).expect("free");
        assert!(Flight::take(&state.scan).is_none(), "second taker refused");
        assert!(Flight::take(&state.cleanup).is_some(), "independent flags");
        drop(a);
        assert!(Flight::take(&state.scan).is_some(), "released on drop");
    }
}
