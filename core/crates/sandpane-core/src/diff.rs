//! Display-only helpers for `git.diff` (design 2026-10-09 §3.5 item 3).
//!
//! Nothing here decides anything: the output is shown to a person. The
//! bounds keep a maximal response inside one IPC frame — `maxBytes` is at
//! most [`MAX_DIFF_BYTES`] and JSON escaping grows a byte at most six-fold
//! (`\u0001`), so a patch serializes to ≤ 3 MiB of the 4 MiB frame.
//!
//! UNTRACKED files are read by Core itself (git has no diff for them), so the
//! read is hardened against an agent that controls the work tree:
//! [`read_untracked`] walks the path ONE COMPONENT AT A TIME with `openat`,
//! opening every intermediate directory with `O_DIRECTORY | O_NOFOLLOW` (a
//! symlinked parent is refused, never followed — the path cannot escape the
//! review target). The last component is first classified UNOPENED with
//! `fstatat(AT_SYMLINK_NOFOLLOW)`: a symlink yields its TARGET TEXT via
//! `readlinkat` (as git stores it); a directory, FIFO, socket or device is
//! refused without being opened; a regular file is then opened with
//! `O_NOFOLLOW | O_NONBLOCK` and its `fstat` must name the SAME inode
//! (`st_dev`/`st_ino`) — an entry swapped in between is refused with
//! nothing read (A5 security I4). `.`/`..`/empty/absolute components are
//! refused before any syscall. Only regular files and symlinks are read.
//! Platform note: the errnos (`ELOOP` for `O_NOFOLLOW` on a symlink,
//! `EINVAL` for `readlinkat` on a non-link) are verified on macOS by this
//! module's tests; Linux documents the same.

use std::ffi::CString;
use std::fs::File;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::Path;

/// Upper clamp for `git.diff` `maxBytes` (§3.5 item 3).
pub const MAX_DIFF_BYTES: usize = 524_288;
/// `maxBytes` when the request omits it.
pub const DEFAULT_DIFF_BYTES: usize = 262_144;
/// A NUL within this many leading bytes makes content binary (git's rule).
pub const BINARY_SNIFF_BYTES: usize = 8000;

/// `maxBytes` clamped to `1..=MAX_DIFF_BYTES` (never refused).
pub fn clamp_max_bytes(requested: Option<u64>) -> usize {
    match requested {
        None => DEFAULT_DIFF_BYTES,
        Some(n) => usize::try_from(n)
            .unwrap_or(MAX_DIFF_BYTES)
            .clamp(1, MAX_DIFF_BYTES),
    }
}

/// Bound `bytes` to `cap` for display. `more_exists` says the producer had
/// already stopped at the cap with more output pending. When over the cap,
/// the cut falls just after the LAST newline within the cap, else at the
/// last UTF-8 character boundary (a split character never becomes a fake
/// U+FFFD). Returns the kept bytes and whether anything was cut.
pub fn cut_display(bytes: &[u8], cap: usize, more_exists: bool) -> (Vec<u8>, bool) {
    if !more_exists && bytes.len() <= cap {
        return (bytes.to_vec(), false);
    }
    let window = &bytes[..bytes.len().min(cap)];
    if let Some(nl) = window.iter().rposition(|b| *b == b'\n') {
        return (window[..=nl].to_vec(), true);
    }
    (window[..char_floor(window)].to_vec(), true)
}

/// Length of `w` without a trailing INCOMPLETE UTF-8 sequence. Invalid bytes
/// are kept as they are (they decode to U+FFFD and are disclosed as lossy).
fn char_floor(w: &[u8]) -> usize {
    let n = w.len();
    for back in 1..=n.min(3) {
        let b = w[n - back];
        if b & 0xC0 == 0x80 {
            continue; // continuation byte: keep looking for its leader
        }
        let need = match b {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => 1, // ASCII or an invalid byte: nothing incomplete here
        };
        return if need > back { n - back } else { n };
    }
    n
}

/// Display text plus `lossy`: non-UTF-8 bytes become U+FFFD and say so.
pub fn decode_display(bytes: &[u8]) -> (String, bool) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), false),
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), true),
    }
}

/// Git's binary rule: a NUL within the first [`BINARY_SNIFF_BYTES`].
pub fn is_binary(content: &[u8]) -> bool {
    content[..content.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// `prefix + path` as git prints it in a patch header with
/// `core.quotePath=false`: C-quoted when it holds a control character, `"`
/// or `\` (named escapes for `\a\b\t\n\v\f\r`, octal otherwise); non-ASCII
/// stays verbatim.
pub fn quote_header_path(prefix: &str, path: &str) -> String {
    let full = format!("{prefix}{path}");
    let needs = full
        .bytes()
        .any(|b| b < 0x20 || b == 0x7f || b == b'"' || b == b'\\');
    if !needs {
        return full;
    }
    let mut out = String::from("\"");
    for c in full.chars() {
        match c {
            '\u{7}' => out.push_str("\\a"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{b}' => out.push_str("\\v"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\{:03o}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The git mode of a new entry (A5 security I7): what `git apply` will
/// create — a regular file, an executable, or a SYMLINK whose target is the
/// patch content (without the mode line it would create a regular file).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewFileMode {
    Regular,
    Executable,
    Symlink,
}

impl NewFileMode {
    pub fn git_mode(self) -> &'static str {
        match self {
            NewFileMode::Regular => "100644",
            NewFileMode::Executable => "100755",
            NewFileMode::Symlink => "120000",
        }
    }
}

/// A standard new-file git diff for an untracked entry, as git prints it for
/// an intent-to-add path minus the `index` line (Core does not hash):
/// `diff --git a/<path> b/<path>`, `new file mode <mode>`, `--- /dev/null`,
/// `+++ b/<path>` (TAB-terminated when the name holds a space, as git
/// does), one `@@ -0,0 +1,N @@` hunk (git's `+1` form when N is 1;
/// no hunk for an empty file), and `\ No newline at end of file` when the
/// COMPLETE content lacks a final newline. With `partial` (the read stopped
/// at the cap) the hunk counts only the lines included and never claims a
/// missing final newline. The caller still cuts the result to `maxBytes`.
pub fn synthesize_new_file_patch(
    path: &str,
    mode: NewFileMode,
    content: &[u8],
    partial: bool,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + content.len() / 8 + 128);
    out.extend_from_slice(b"diff --git ");
    out.extend_from_slice(quote_header_path("a/", path).as_bytes());
    out.push(b' ');
    out.extend_from_slice(quote_header_path("b/", path).as_bytes());
    out.extend_from_slice(format!("\nnew file mode {}\n", mode.git_mode()).as_bytes());
    out.extend_from_slice(b"--- /dev/null\n+++ ");
    out.extend_from_slice(quote_header_path("b/", path).as_bytes());
    // Git terminates a header name holding a space with a TAB (so trailing
    // whitespace in the name stays unambiguous); match it exactly.
    if path.contains(' ') {
        out.push(b'\t');
    }
    out.push(b'\n');
    if content.is_empty() {
        return out;
    }
    let lines: Vec<&[u8]> = content.split_inclusive(|b| *b == b'\n').collect();
    match lines.len() {
        1 => out.extend_from_slice(b"@@ -0,0 +1 @@\n"),
        n => out.extend_from_slice(format!("@@ -0,0 +1,{n} @@\n").as_bytes()),
    }
    for line in &lines {
        out.push(b'+');
        out.extend_from_slice(line);
        if !line.ends_with(b"\n") {
            out.push(b'\n');
            if !partial {
                out.extend_from_slice(b"\\ No newline at end of file\n");
            }
        }
    }
    out
}

/// [`synthesize_new_file_patch`] bounded to `cap` bytes, returning the
/// patch and `truncated` (`partial`, or anything was dropped). When the full
/// patch does not fit, it is rebuilt from the LARGEST prefix of whole
/// content lines whose patch fits, so the hunk header always counts exactly
/// the `+` lines shown (a plain byte cut would leave a header promising
/// lines that are not there). A line too long for the cap leaves only the
/// file headers; a cap smaller than the headers falls back to
/// [`cut_display`].
pub fn new_file_patch_within(
    path: &str,
    mode: NewFileMode,
    content: &[u8],
    partial: bool,
    cap: usize,
) -> (Vec<u8>, bool) {
    let full = synthesize_new_file_patch(path, mode, content, partial);
    if full.len() <= cap {
        return (full, partial);
    }
    // Byte offsets just past each COMPLETE line; patch size grows with k.
    let ends: Vec<usize> = content
        .iter()
        .enumerate()
        .filter(|(_, b)| **b == b'\n')
        .map(|(i, _)| i + 1)
        .collect();
    let patch_for = |k: usize| {
        let end = if k == 0 { 0 } else { ends[k - 1] };
        synthesize_new_file_patch(path, mode, &content[..end], true)
    };
    // Largest k in 0..=ends.len() whose patch fits (binary search).
    let (mut lo, mut hi) = (0usize, ends.len());
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if patch_for(mid).len() <= cap {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let best = patch_for(lo);
    if best.len() <= cap {
        (best, true)
    } else {
        (cut_display(&best, cap, false).0, true)
    }
}

/// What [`read_untracked`] found.
#[derive(Debug, PartialEq, Eq)]
pub enum UntrackedContent {
    /// A regular file: at most `cap` bytes; `over_cap` when more existed;
    /// `executable` when the owner execute bit is set (git's 100755).
    File {
        bytes: Vec<u8>,
        over_cap: bool,
        executable: bool,
    },
    /// A symlink: its target text (never followed).
    Symlink { target: Vec<u8> },
}

impl UntrackedContent {
    /// The mode git would record for this entry.
    pub fn mode(&self) -> NewFileMode {
        match self {
            UntrackedContent::File {
                executable: true, ..
            } => NewFileMode::Executable,
            UntrackedContent::File { .. } => NewFileMode::Regular,
            UntrackedContent::Symlink { .. } => NewFileMode::Symlink,
        }
    }
}

#[derive(Debug)]
pub enum UntrackedError {
    /// The path is not a plain relative path inside the root (absolute,
    /// `.`/`..`/empty component, or a symlinked/non-directory parent).
    Escapes(String),
    /// A directory (a nested repository is listed as `dir/`), FIFO, socket
    /// or device: nothing a patch can show.
    NotAFile(String),
    /// The entry changed between its classification (`fstatat`) and its
    /// open/read — replaced by another file, a symlink, a FIFO… (A5
    /// security I4). Nothing was read.
    Changed(String),
    Io(std::io::Error),
}

#[cfg(test)]
thread_local! {
    static BEFORE_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

/// Test-only: run `f` once, between the leaf's `fstatat` and its open.
#[cfg(test)]
fn set_before_open_hook(f: Box<dyn FnOnce()>) {
    BEFORE_OPEN.with(|h| *h.borrow_mut() = Some(f));
}

#[cfg(test)]
fn run_before_open_hook() {
    if let Some(f) = BEFORE_OPEN.with(|h| h.borrow_mut().take()) {
        f()
    }
}

/// Whether two `stat` results name the same inode.
fn same_file(a: &libc::stat, b: &libc::stat) -> bool {
    a.st_dev == b.st_dev && a.st_ino == b.st_ino
}

fn last_os_error() -> std::io::Error {
    std::io::Error::last_os_error()
}

/// `openat(dirfd, name, flags)` as an owned descriptor.
fn openat(dir: &OwnedFd, name: &CString, flags: libc::c_int) -> std::io::Result<OwnedFd> {
    // SAFETY: `dir` is a live descriptor and `name` is NUL-terminated; on
    // success the returned descriptor is owned by nobody else.
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags | libc::O_CLOEXEC) };
    if fd < 0 {
        Err(last_os_error())
    } else {
        // SAFETY: `fd` was just returned by a successful `openat`.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

/// The result of walking every component of a relative path but the last.
enum Walk {
    /// Every ancestor opened as a real directory; `dir` holds the last one.
    Parent {
        dir: OwnedFd,
        leaf: CString,
        dir_marker: bool,
    },
    /// An ancestor does not exist (ENOENT); every ancestor before it opened
    /// as a real directory.
    MissingAncestor,
}

/// Why a walk refused a path.
enum WalkError {
    /// Not a plain relative path, or an existing ancestor is a symlink or
    /// not a directory (`ELOOP` / `ENOTDIR` under `O_NOFOLLOW`).
    Escapes,
    Io(std::io::Error),
}

/// Walk `rel` below `root` one component at a time (`O_DIRECTORY |
/// O_NOFOLLOW` per ancestor). `.`/`..`/empty/absolute components are refused
/// before any syscall; a trailing `/` (git's untracked-directory marker) is
/// reported as `dir_marker`.
fn walk_parent(root: &Path, rel: &str) -> Result<Walk, WalkError> {
    if rel.is_empty() || rel.starts_with('/') {
        return Err(WalkError::Escapes);
    }
    let (body, dir_marker) = match rel.strip_suffix('/') {
        Some(b) => (b, true),
        None => (rel, false),
    };
    let mut parts: Vec<CString> = Vec::new();
    for part in body.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(WalkError::Escapes);
        }
        parts.push(CString::new(part).map_err(|_| WalkError::Escapes)?);
    }
    let Some(leaf) = parts.pop() else {
        return Err(WalkError::Escapes);
    };
    let root_c =
        CString::new(root.as_os_str().as_encoded_bytes()).map_err(|_| WalkError::Escapes)?;
    // SAFETY: NUL-terminated path; the result is checked and then owned.
    let root_fd = unsafe {
        libc::open(
            root_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(WalkError::Io(last_os_error()));
    }
    // SAFETY: `root_fd` was just returned by a successful `open`.
    let mut dir = unsafe { OwnedFd::from_raw_fd(root_fd) };
    let dir_flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW;
    for part in &parts {
        dir = match openat(&dir, part, dir_flags) {
            Ok(fd) => fd,
            Err(e) => {
                return match e.raw_os_error() {
                    Some(libc::ELOOP) | Some(libc::ENOTDIR) => Err(WalkError::Escapes),
                    Some(libc::ENOENT) => Ok(Walk::MissingAncestor),
                    _ => Err(WalkError::Io(e)),
                }
            }
        };
    }
    Ok(Walk::Parent {
        dir,
        leaf,
        dir_marker,
    })
}

/// Read the untracked entry `rel` (a path git reported, relative to `root`)
/// WITHOUT following any symlink and without leaving `root` (see the module
/// doc for the walk). Reads at most `cap + 1` bytes.
pub fn read_untracked(
    root: &Path,
    rel: &str,
    cap: usize,
) -> Result<UntrackedContent, UntrackedError> {
    let escapes = || {
        UntrackedError::Escapes(format!(
            "{rel:?} is not a plain path inside the review target"
        ))
    };
    let (dir, last, dir_marker) = match walk_parent(root, rel) {
        Ok(Walk::Parent {
            dir,
            leaf,
            dir_marker,
        }) => (dir, leaf, dir_marker),
        Ok(Walk::MissingAncestor) => {
            return Err(UntrackedError::Io(std::io::Error::from_raw_os_error(
                libc::ENOENT,
            )))
        }
        Err(WalkError::Escapes) => return Err(escapes()),
        Err(WalkError::Io(e)) => return Err(UntrackedError::Io(e)),
    };
    let first = stat_at_nofollow(&dir, &last).map_err(UntrackedError::Io)?;
    read_classified_leaf(&dir, &last, &first, rel, cap, dir_marker)
}

/// What [`read_task_entry`] found for a change-list path (A6 §3.6 item 3).
#[derive(Debug, PartialEq, Eq)]
pub enum TaskEntry {
    /// The leaf (or an ancestor) does not exist; every EXISTING ancestor is
    /// a real directory.
    Absent,
    /// A regular file: at most `cap` bytes; `over_cap` when more existed.
    File {
        bytes: Vec<u8>,
        over_cap: bool,
        executable: bool,
    },
    /// A symlink: its target text (never followed).
    Symlink { target: Vec<u8> },
}

impl TaskEntry {
    /// The git mode of a present entry (`None` when absent).
    pub fn git_mode(&self) -> Option<NewFileMode> {
        match self {
            TaskEntry::Absent => None,
            TaskEntry::File {
                executable: true, ..
            } => Some(NewFileMode::Executable),
            TaskEntry::File { .. } => Some(NewFileMode::Regular),
            TaskEntry::Symlink { .. } => Some(NewFileMode::Symlink),
        }
    }
}

/// Read the task-side state of `rel` below `root` for an apply or a review
/// hash (A6 §3.6 items 2-3): the same hardened walk as [`read_untracked`]
/// (no symlink followed, no FIFO/device opened, inode re-checked), except
/// that absence is an answer ([`TaskEntry::Absent`]) — an ancestor that is a
/// symlink or a file is still refused ([`UntrackedError::Escapes`]). A
/// trailing `/` (a nested repository) is refused as [`UntrackedError::NotAFile`]. Reads at most `cap + 1` bytes.
pub fn read_task_entry(root: &Path, rel: &str, cap: usize) -> Result<TaskEntry, UntrackedError> {
    let escapes =
        || UntrackedError::Escapes(format!("{rel:?} is not a plain path inside the work tree"));
    if rel.ends_with('/') {
        // git lists a nested repository as `dir/`: never read, like A5.
        return Err(UntrackedError::NotAFile(format!(
            "{rel:?} is a directory (for example a nested repository)"
        )));
    }
    let (dir, leaf) = match walk_parent(root, rel) {
        Ok(Walk::Parent { dir, leaf, .. }) => (dir, leaf),
        Ok(Walk::MissingAncestor) => return Ok(TaskEntry::Absent),
        Err(WalkError::Escapes) => return Err(escapes()),
        Err(WalkError::Io(e)) => return Err(UntrackedError::Io(e)),
    };
    let first = match stat_at_nofollow(&dir, &leaf) {
        Ok(st) => st,
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => return Ok(TaskEntry::Absent),
        Err(e) => return Err(UntrackedError::Io(e)),
    };
    Ok(
        match read_classified_leaf(&dir, &leaf, &first, rel, cap, false)? {
            UntrackedContent::File {
                bytes,
                over_cap,
                executable,
            } => TaskEntry::File {
                bytes,
                over_cap,
                executable,
            },
            UntrackedContent::Symlink { target } => TaskEntry::Symlink { target },
        },
    )
}

/// What a host leaf must be for [`check_host_path`] (A6 §3.6 item 5, C2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostLeaf {
    /// A create target: nothing may exist at the path.
    MustBeAbsent,
    /// A modify or delete target: a regular file (never a symlink).
    MustBeRegularFile,
}

/// The host leading-path check (A6 §3.6 item 5, C2). `git apply --index`
/// consults only the INDEX for "beyond a symlink", so an untracked or
/// ignored symlinked directory would send a write outside the repository.
/// Core walks the host work tree itself: every EXISTING ancestor must be a
/// real directory (`O_DIRECTORY | O_NOFOLLOW`); then the leaf must match
/// `want` (`fstatat(AT_SYMLINK_NOFOLLOW)`). A missing ancestor is fine only
/// for a create target. `Err` carries a short reason (never the message the
/// client sees — the caller words that).
pub fn check_host_path(root: &Path, rel: &str, want: HostLeaf) -> Result<(), String> {
    if rel.ends_with('/') {
        return Err("not a plain path".into());
    }
    let (dir, leaf) = match walk_parent(root, rel) {
        Ok(Walk::Parent { dir, leaf, .. }) => (dir, leaf),
        Ok(Walk::MissingAncestor) if want == HostLeaf::MustBeAbsent => return Ok(()),
        Ok(Walk::MissingAncestor) => return Err("the file does not exist".into()),
        Err(WalkError::Escapes) => return Err("an ancestor is a symlink or a file".into()),
        Err(WalkError::Io(e)) => return Err(e.to_string()),
    };
    match (stat_at_nofollow(&dir, &leaf), want) {
        (Err(e), HostLeaf::MustBeAbsent) if e.raw_os_error() == Some(libc::ENOENT) => Ok(()),
        (Ok(_), HostLeaf::MustBeAbsent) => Err("something already exists there".into()),
        (Ok(st), HostLeaf::MustBeRegularFile) if st.st_mode & libc::S_IFMT == libc::S_IFREG => {
            Ok(())
        }
        (Ok(_), HostLeaf::MustBeRegularFile) => Err("it is not a regular file".into()),
        (Err(e), _) => Err(e.to_string()),
    }
}

/// Read an already-classified leaf (`first` = its `fstatat` result).
fn read_classified_leaf(
    dir: &OwnedFd,
    last: &CString,
    first: &libc::stat,
    rel: &str,
    cap: usize,
    dir_marker: bool,
) -> Result<UntrackedContent, UntrackedError> {
    let escapes = || {
        UntrackedError::Escapes(format!(
            "{rel:?} is not a plain path inside the review target"
        ))
    };
    // A5 security I4: the leaf was classified WITHOUT opening it (no open of
    // a FIFO/device, no symlink followed); now open it and prove the
    // descriptor is that same inode.
    #[cfg(test)]
    run_before_open_hook();
    let changed = || UntrackedError::Changed(format!("{rel:?} changed while it was being read"));
    match first.st_mode & libc::S_IFMT {
        libc::S_IFLNK if !dir_marker => {
            return match read_link_at(dir, last) {
                // Not a symlink any more (EINVAL) or gone: it changed.
                Err(UntrackedError::Io(e))
                    if matches!(e.raw_os_error(), Some(libc::EINVAL) | Some(libc::ENOENT)) =>
                {
                    Err(changed())
                }
                other => other.map(|target| UntrackedContent::Symlink { target }),
            };
        }
        libc::S_IFLNK => return Err(escapes()),
        libc::S_IFDIR => {
            return Err(UntrackedError::NotAFile(format!(
                "{rel:?} is a directory (for example a nested repository)"
            )))
        }
        libc::S_IFREG if !dir_marker => {}
        _ => {
            return Err(UntrackedError::NotAFile(format!(
                "{rel:?} is not a regular file"
            )))
        }
    }
    let file_flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK;
    let fd = openat(dir, last, file_flags).map_err(|e| match e.raw_os_error() {
        // A symlink (ELOOP), FIFO/socket/device quirks, or a vanished
        // entry: it was a regular file a moment ago.
        Some(libc::ELOOP) | Some(libc::ENXIO) | Some(libc::EOPNOTSUPP) | Some(libc::ENOENT) => {
            changed()
        }
        _ => UntrackedError::Io(e),
    })?;
    let opened = fstat(&fd).map_err(UntrackedError::Io)?;
    if !same_file(first, &opened) || opened.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(changed());
    }
    let executable = opened.st_mode & libc::S_IXUSR != 0;
    let file = File::from(fd);
    let mut bytes = Vec::new();
    file.take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(UntrackedError::Io)?;
    let over_cap = bytes.len() > cap;
    bytes.truncate(cap);
    Ok(UntrackedContent::File {
        bytes,
        over_cap,
        executable,
    })
}

/// `fstatat(dir, name, AT_SYMLINK_NOFOLLOW)`: the entry itself, unopened.
fn stat_at_nofollow(dir: &OwnedFd, name: &CString) -> std::io::Result<libc::stat> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `dir` is live, `name` NUL-terminated, `st` valid for writes.
    let rc = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            st.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc != 0 {
        return Err(last_os_error());
    }
    // SAFETY: a successful `fstatat` initialized `st`.
    Ok(unsafe { st.assume_init() })
}

/// `fstat` of an open descriptor.
fn fstat(fd: &OwnedFd) -> std::io::Result<libc::stat> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `fd` is live and `st` valid for writes.
    let rc = unsafe { libc::fstat(fd.as_raw_fd(), st.as_mut_ptr()) };
    if rc != 0 {
        return Err(last_os_error());
    }
    // SAFETY: a successful `fstat` initialized `st`.
    Ok(unsafe { st.assume_init() })
}

/// `readlinkat` into a bounded buffer (a target longer than it is refused).
fn read_link_at(dir: &OwnedFd, name: &CString) -> Result<Vec<u8>, UntrackedError> {
    let mut buf = vec![0u8; 8192];
    // SAFETY: `buf` is valid for `buf.len()` bytes; `name` is NUL-terminated.
    let n = unsafe {
        libc::readlinkat(
            dir.as_raw_fd(),
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            buf.len(),
        )
    };
    if n < 0 {
        return Err(UntrackedError::Io(last_os_error()));
    }
    let n = n as usize;
    if n >= buf.len() {
        return Err(UntrackedError::Io(std::io::Error::other(
            "symlink target too long",
        )));
    }
    buf.truncate(n);
    Ok(buf)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn max_bytes_is_clamped_not_refused() {
        assert_eq!(clamp_max_bytes(None), DEFAULT_DIFF_BYTES);
        assert_eq!(DEFAULT_DIFF_BYTES, 262_144);
        assert_eq!(MAX_DIFF_BYTES, 524_288);
        assert_eq!(clamp_max_bytes(Some(0)), 1);
        assert_eq!(clamp_max_bytes(Some(1)), 1);
        assert_eq!(clamp_max_bytes(Some(100)), 100);
        assert_eq!(clamp_max_bytes(Some(524_288)), 524_288);
        assert_eq!(clamp_max_bytes(Some(524_289)), 524_288);
        assert_eq!(clamp_max_bytes(Some(u64::MAX)), 524_288);
    }

    #[test]
    fn cut_keeps_whole_lines_or_a_char_boundary() {
        // Fits: unchanged, not truncated.
        assert_eq!(cut_display(b"a\nb", 3, false), (b"a\nb".to_vec(), false));
        // Over the cap: cut just after the last newline at or before it.
        assert_eq!(
            cut_display(b"aaa\nbbb\nccc", 9, false),
            (b"aaa\nbbb\n".to_vec(), true)
        );
        // The runner already capped (bytes == cap) but more existed.
        assert_eq!(
            cut_display(b"aaa\nbbb\nc", 9, true),
            (b"aaa\nbbb\n".to_vec(), true)
        );
        // Exactly a line end at the cap with more after it: keep it all.
        assert_eq!(cut_display(b"aa\nb", 3, false), (b"aa\n".to_vec(), true));
        // One long line: never split a UTF-8 character.
        let s = "αβγ".as_bytes();
        assert_eq!(cut_display(s, 3, false), ("α".as_bytes().to_vec(), true));
        assert_eq!(cut_display(s, 4, false), ("αβ".as_bytes().to_vec(), true));
        // Invalid bytes are never "repaired" into a shorter cut.
        assert_eq!(
            cut_display(b"\xff\xff\xff", 2, false),
            (b"\xff\xff".to_vec(), true)
        );
        // A 4-byte character with cap 3 cuts to nothing.
        assert_eq!(cut_display("😀".as_bytes(), 3, false), (Vec::new(), true));
    }

    #[test]
    fn decoding_discloses_lossy_and_a_cut_never_fakes_it() {
        assert_eq!(decode_display(b"ok\n"), ("ok\n".to_string(), false));
        assert_eq!(decode_display(b"a\xffb"), ("a\u{fffd}b".to_string(), true));
        let (cut, _) = cut_display("aé".as_bytes(), 2, false);
        assert_eq!(decode_display(&cut), ("a".to_string(), false));
    }

    #[test]
    fn binary_is_a_nul_in_the_first_8000_bytes() {
        assert!(!is_binary(b"text\n"));
        assert!(is_binary(b"a\0b"));
        let mut late = vec![b'a'; BINARY_SNIFF_BYTES];
        late.push(0);
        assert!(!is_binary(&late));
        late[BINARY_SNIFF_BYTES - 1] = 0;
        assert!(is_binary(&late));
    }

    #[test]
    fn header_paths_are_quoted_like_git() {
        assert_eq!(
            quote_header_path("b/", "plain name.txt"),
            "b/plain name.txt"
        );
        assert_eq!(quote_header_path("b/", "日本.txt"), "b/日本.txt");
        assert_eq!(
            quote_header_path("b/", "t\tn\nq\"s\\.txt"),
            "\"b/t\\tn\\nq\\\"s\\\\.txt\""
        );
        assert_eq!(
            quote_header_path("b/", "bell\u{7}del\u{7f}"),
            "\"b/bell\\adel\\177\""
        );
        assert_eq!(quote_header_path("b/", "esc\u{1b}"), "\"b/esc\\033\"");
    }

    const H: &str = "diff --git a/p b/p\nnew file mode 100644\n--- /dev/null\n+++ b/p\n";

    #[test]
    fn synthesized_patch_shapes() {
        use NewFileMode::*;
        let s = |m, c: &[u8], partial| {
            String::from_utf8(synthesize_new_file_patch("p", m, c, partial)).unwrap()
        };
        assert_eq!(
            s(Regular, b"a\nb", false),
            format!("{H}@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n")
        );
        assert_eq!(s(Regular, b"a\n", false), format!("{H}@@ -0,0 +1 @@\n+a\n"));
        assert_eq!(s(Regular, b"", false), H);
        // A partial read never claims "no newline at end of file", and the
        // hunk counts only the lines included.
        assert_eq!(
            s(Regular, b"a\nb", true),
            format!("{H}@@ -0,0 +1,2 @@\n+a\n+b\n")
        );
        // A5 security I7: the mode line says what the entry IS.
        assert!(s(Executable, b"x\n", false)
            .starts_with("diff --git a/p b/p\nnew file mode 100755\n--- /dev/null\n"));
        assert_eq!(
            s(Symlink, b"/etc/passwd", false),
            "diff --git a/p b/p\nnew file mode 120000\n--- /dev/null\n+++ b/p\n\
             @@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n"
        );
        // A space: TAB after the ---/+++ name only; quoting per side.
        assert_eq!(
            String::from_utf8(synthesize_new_file_patch("a b", Regular, b"z\n", false)).unwrap(),
            "diff --git a/a b b/a b\nnew file mode 100644\n--- /dev/null\n+++ b/a b\t\n\
             @@ -0,0 +1 @@\n+z\n"
        );
        assert_eq!(
            String::from_utf8(synthesize_new_file_patch("t\tx", Regular, b"z\n", false)).unwrap(),
            "diff --git \"a/t\\tx\" \"b/t\\tx\"\nnew file mode 100644\n--- /dev/null\n\
             +++ \"b/t\\tx\"\n@@ -0,0 +1 @@\n+z\n"
        );
    }

    /// The cap applies to the FINISHED patch, and a cut patch keeps whole
    /// lines with an honest hunk header (its count equals the `+` lines
    /// shown); one line too long for the cap leaves only the file headers.
    #[test]
    fn capped_new_file_patch_keeps_an_honest_hunk_header() {
        let m = NewFileMode::Regular;
        let content = "line\n".repeat(100);
        let (full, t) = new_file_patch_within("p", m, content.as_bytes(), false, 1 << 20);
        assert!(!t);
        assert_eq!(
            full,
            synthesize_new_file_patch("p", m, content.as_bytes(), false)
        );
        for cap in [90, 100, 128, 333] {
            let (patch, truncated) = new_file_patch_within("p", m, content.as_bytes(), false, cap);
            assert!(truncated, "{cap}");
            assert!(patch.len() <= cap, "{cap}: {}", patch.len());
            let text = String::from_utf8(patch).unwrap();
            let shown = text.lines().filter(|l| l.starts_with("+line")).count();
            if shown > 0 {
                let header = if shown == 1 {
                    "@@ -0,0 +1 @@\n".to_string()
                } else {
                    format!("@@ -0,0 +1,{shown} @@\n")
                };
                assert!(text.contains(&header), "{cap}: {text}");
            }
            assert!(!text.contains("No newline"), "{cap}");
        }
        // A partial READ is truncated even when the patch fits.
        let (_, t) = new_file_patch_within("p", m, b"a\n", true, 1 << 20);
        assert!(t);
        // One long line: only the headers remain.
        let (patch, t) = new_file_patch_within("p", m, &[b'x'; 500], false, 100);
        assert!(t);
        assert_eq!(patch, H.as_bytes().to_vec());
        // A cap smaller than the headers: cut like any other text.
        let (patch, t) = new_file_patch_within("p", m, b"a\n", false, 5);
        assert!(t && patch.len() <= 5);
    }

    fn git(dir: &Path, args: &[&str]) -> Vec<u8> {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out.stdout
    }

    /// Oracle: for several contents and modes, Core's synthesized patch
    /// equals git's own new-file diff (`git add -N` then `git diff`) except
    /// the `index` line (Core does not hash) — and `git apply` of Core's
    /// patch recreates the same kind of entry (a LINK for a symlink, an
    /// executable for 100755).
    #[test]
    fn synthesized_patch_matches_git_for_intent_to_add_files() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("oracle");
        let applied = dir.path().join("applied");
        for r in [&d, &applied] {
            std::fs::create_dir(r).unwrap();
            git(r, &["init", "-q", "-b", "main"]);
        }
        let cases: [(&str, &[u8], NewFileMode); 8] = [
            ("one.txt", b"one line\n", NewFileMode::Regular),
            ("two.txt", b"a\nb", NewFileMode::Regular),
            ("many \"q\".txt", b"1\n2\n3\n4\n", NewFileMode::Regular),
            ("t\tab.txt", b"x\n\ny\n", NewFileMode::Regular),
            ("sp ace.txt", b"s\n", NewFileMode::Regular),
            ("crlf.txt", b"a\r\nb\r\n", NewFileMode::Regular),
            ("run.sh", b"#!/bin/sh\n", NewFileMode::Executable),
            ("link", b"/etc/passwd", NewFileMode::Symlink),
        ];
        for (name, content, mode) in cases {
            let path = d.join(name);
            match mode {
                NewFileMode::Symlink => {
                    symlink(std::str::from_utf8(content).unwrap(), &path);
                }
                _ => {
                    std::fs::write(&path, content).unwrap();
                    let bits = if mode == NewFileMode::Executable {
                        0o755
                    } else {
                        0o644
                    };
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(bits)).unwrap();
                }
            }
            git(&d, &["add", "-N", "--", name]);
            let theirs = git(
                &d,
                &[
                    "-c",
                    "core.quotePath=false",
                    "diff",
                    "--no-color",
                    "--",
                    name,
                ],
            );
            let theirs: String = String::from_utf8_lossy(&theirs)
                .split_inclusive('\n')
                .filter(|l| !l.starts_with("index "))
                .collect();
            let ours = synthesize_new_file_patch(name, mode, content, false);
            assert_eq!(String::from_utf8_lossy(&ours), theirs, "{name:?}");
            let patch_file = dir.path().join("p.patch");
            std::fs::write(&patch_file, &ours).unwrap();
            git(&applied, &["apply", patch_file.to_str().unwrap()]);
            let meta = std::fs::symlink_metadata(applied.join(name)).unwrap();
            match mode {
                NewFileMode::Symlink => {
                    assert!(meta.file_type().is_symlink(), "{name:?}");
                    assert_eq!(
                        std::fs::read_link(applied.join(name)).unwrap(),
                        Path::new("/etc/passwd")
                    );
                }
                NewFileMode::Executable => {
                    assert!(meta.is_file() && meta.permissions().mode() & 0o100 != 0)
                }
                NewFileMode::Regular => {
                    assert!(meta.is_file() && meta.permissions().mode() & 0o100 == 0);
                    assert_eq!(std::fs::read(applied.join(name)).unwrap(), content);
                }
            }
        }
    }

    fn symlink(target: &str, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[test]
    fn untracked_reads_files_capped_and_symlinks_as_target_text() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/f.txt"), b"hello\n").unwrap();
        assert_eq!(
            read_untracked(&root, "sub/f.txt", 100).unwrap(),
            UntrackedContent::File {
                bytes: b"hello\n".to_vec(),
                over_cap: false,
                executable: false
            }
        );
        assert_eq!(
            read_untracked(&root, "sub/f.txt", 6).unwrap(),
            UntrackedContent::File {
                bytes: b"hello\n".to_vec(),
                over_cap: false,
                executable: false
            }
        );
        assert_eq!(
            read_untracked(&root, "sub/f.txt", 3).unwrap(),
            UntrackedContent::File {
                bytes: b"hel".to_vec(),
                over_cap: true,
                executable: false
            }
        );
        // The owner execute bit is reported (git's 100755).
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                root.join("sub/f.txt"),
                std::fs::Permissions::from_mode(0o744),
            )
            .unwrap();
        }
        let got = read_untracked(&root, "sub/f.txt", 100).unwrap();
        assert_eq!(got.mode(), NewFileMode::Executable);
        // A symlink is its target TEXT, never followed — even to a secret
        // outside the root.
        symlink("/etc/passwd", &root.join("link"));
        assert_eq!(
            read_untracked(&root, "link", 100).unwrap(),
            UntrackedContent::Symlink {
                target: b"/etc/passwd".to_vec()
            }
        );
        assert_eq!(
            read_untracked(&root, "link", 100).unwrap().mode(),
            NewFileMode::Symlink
        );
    }

    #[test]
    fn untracked_refuses_escapes_and_non_files_without_hanging() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap().join("root");
        std::fs::create_dir(&root).unwrap();
        let outside = root.parent().unwrap().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret\n").unwrap();
        // A symlinked PARENT directory is an escape (never followed).
        symlink(outside.to_str().unwrap(), &root.join("linkdir"));
        let e = read_untracked(&root, "linkdir/secret.txt", 100).unwrap_err();
        assert!(matches!(e, UntrackedError::Escapes(_)), "{e:?}");
        for bad in [
            "../outside/secret.txt",
            "/etc/passwd",
            "a/./b",
            "a//b",
            "",
            ".",
        ] {
            let e = read_untracked(&root, bad, 100).unwrap_err();
            assert!(matches!(e, UntrackedError::Escapes(_)), "{bad:?}: {e:?}");
        }
        // A nested repository is listed as `dir/`; a directory, a FIFO and a
        // socket are not files. The FIFO must not block (O_NONBLOCK).
        std::fs::create_dir(root.join("nested")).unwrap();
        for bad in ["nested/", "nested"] {
            let e = read_untracked(&root, bad, 100).unwrap_err();
            assert!(matches!(e, UntrackedError::NotAFile(_)), "{bad:?}: {e:?}");
        }
        let fifo = root.join("fifo");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: plain syscall on a NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        let e = read_untracked(&root, "fifo", 100).unwrap_err();
        assert!(matches!(e, UntrackedError::NotAFile(_)), "{e:?}");
        let e = read_untracked(&root, "missing.txt", 100).unwrap_err();
        assert!(
            matches!(e, UntrackedError::Io(ref io) if io.kind() == std::io::ErrorKind::NotFound),
            "{e:?}"
        );
    }

    /// A5 security I4: the leaf is classified by `fstatat(AT_SYMLINK_NOFOLLOW)`
    /// BEFORE any open, and the opened descriptor must be that same inode.
    /// The hook swaps the entry in that window; every swap is refused and
    /// nothing is read.
    #[test]
    fn untracked_refuses_an_entry_swapped_between_stat_and_open() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let swap = |name: &'static str, with: fn(&Path)| {
            let root2 = root.clone();
            std::fs::write(root.join(name), b"original\n").unwrap();
            set_before_open_hook(Box::new(move || {
                let p = root2.join(name);
                std::fs::remove_file(&p).unwrap();
                with(&p);
            }));
            let r = read_untracked(&root, name, 100);
            assert!(
                matches!(r, Err(UntrackedError::Changed(_))),
                "{name}: {r:?}"
            );
        };
        // A different regular file (new inode, same name).
        swap("f1", |p| std::fs::write(p, b"SECRET\n").unwrap());
        // A symlink to an outside secret.
        swap("f2", |p| symlink("/etc/passwd", p));
        // A FIFO (opens non-blocking, but is not the stat'ed inode).
        swap("f3", |p| {
            let c = std::ffi::CString::new(p.to_str().unwrap()).unwrap();
            // SAFETY: plain syscall on a NUL-terminated path.
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        });
        // A symlink to a hard link of the SAME inode (outside the walk): the
        // inode check alone would pass, `O_NOFOLLOW` refuses it.
        std::fs::write(root.join("f4"), b"original\n").unwrap();
        let root2 = root.clone();
        set_before_open_hook(Box::new(move || {
            let p = root2.join("f4");
            let hard = root2.join("f4-hardlink");
            std::fs::hard_link(&p, &hard).unwrap();
            std::fs::remove_file(&p).unwrap();
            symlink(hard.to_str().unwrap(), &p);
        }));
        let r = read_untracked(&root, "f4", 100);
        assert!(matches!(r, Err(UntrackedError::Changed(_))), "f4: {r:?}");
        // A symlink swapped for a regular file before readlinkat.
        symlink("/etc/hosts", &root.join("l1"));
        let root2 = root.clone();
        set_before_open_hook(Box::new(move || {
            let p = root2.join("l1");
            std::fs::remove_file(&p).unwrap();
            std::fs::write(&p, b"SECRET\n").unwrap();
        }));
        let r = read_untracked(&root, "l1", 100);
        assert!(matches!(r, Err(UntrackedError::Changed(_))), "{r:?}");
        // Without a swap the same names read normally.
        std::fs::write(root.join("ok"), b"fine\n").unwrap();
        assert!(read_untracked(&root, "ok", 100).is_ok());
    }

    /// A6 §3.6 item 3: the task-side read tells "absent" (ENOENT, with every
    /// existing ancestor a real directory) apart from everything else, and
    /// reads the FULL content up to the cap.
    #[test]
    fn task_entry_reads_files_symlinks_and_absence_without_following() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/f.txt"), b"hello\n").unwrap();
        assert_eq!(
            read_task_entry(&root, "sub/f.txt", 100).unwrap(),
            TaskEntry::File {
                bytes: b"hello\n".to_vec(),
                over_cap: false,
                executable: false
            }
        );
        assert_eq!(
            read_task_entry(&root, "sub/f.txt", 2).unwrap(),
            TaskEntry::File {
                bytes: b"he".to_vec(),
                over_cap: true,
                executable: false
            }
        );
        symlink("/etc/passwd", &root.join("link"));
        assert_eq!(
            read_task_entry(&root, "link", 100).unwrap(),
            TaskEntry::Symlink {
                target: b"/etc/passwd".to_vec()
            }
        );
        // Absent leaf, and absent ANCESTOR (a whole directory deleted).
        assert_eq!(
            read_task_entry(&root, "sub/gone.txt", 100).unwrap(),
            TaskEntry::Absent
        );
        assert_eq!(
            read_task_entry(&root, "nodir/x/y.txt", 100).unwrap(),
            TaskEntry::Absent
        );
        // A FILE where an ancestor directory should be (dir->file swap) is
        // not "absent": it is refused.
        std::fs::write(root.join("plain"), b"x").unwrap();
        assert!(matches!(
            read_task_entry(&root, "plain/x.txt", 100),
            Err(UntrackedError::Escapes(_))
        ));
        // A symlinked ancestor is refused, never followed.
        symlink(root.join("sub").to_str().unwrap(), &root.join("lsub"));
        assert!(matches!(
            read_task_entry(&root, "lsub/f.txt", 100),
            Err(UntrackedError::Escapes(_))
        ));
        // Directories are not files.
        assert!(matches!(
            read_task_entry(&root, "sub", 100),
            Err(UntrackedError::NotAFile(_))
        ));
        for bad in ["", "/abs", "a/../b", "./a", "a//b"] {
            assert!(
                matches!(
                    read_task_entry(&root, bad, 100),
                    Err(UntrackedError::Escapes(_))
                ),
                "{bad:?}"
            );
        }
        // git's `dir/` marker (a nested repository) is a directory, refused
        // before any syscall, with "directory" in the message (A5 wording).
        assert!(
            matches!(read_task_entry(&root, "a/", 100), Err(UntrackedError::NotAFile(m)) if m.contains("directory"))
        );
    }

    /// A6 §3.6 item 5 (C2): every existing ancestor of a host path must be a
    /// real directory; a create target must be absent, a modify/delete
    /// target a regular file.
    #[test]
    fn host_leading_path_check_refuses_symlinked_or_file_ancestors() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap().join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), b"x").unwrap();
        let outside = root.parent().unwrap().join("outside");
        std::fs::create_dir(&outside).unwrap();
        // Untracked/ignored symlinked directories (node_modules-style).
        symlink(outside.to_str().unwrap(), &root.join("node_modules"));
        symlink("/etc/passwd", &root.join("leaf-link"));
        std::fs::write(root.join("afile"), b"x").unwrap();

        use HostLeaf::*;
        assert!(check_host_path(&root, "src/a.rs", MustBeRegularFile).is_ok());
        assert!(check_host_path(&root, "src/new.rs", MustBeAbsent).is_ok());
        assert!(check_host_path(&root, "brand/new/dir/f.rs", MustBeAbsent).is_ok());
        for (rel, want) in [
            ("node_modules/pkg/index.js", MustBeAbsent),
            ("node_modules/x", MustBeRegularFile),
            ("afile/child", MustBeAbsent),
            ("leaf-link", MustBeRegularFile),
            ("leaf-link", MustBeAbsent),
            ("src/a.rs", MustBeAbsent),
            ("src", MustBeRegularFile),
            ("src/missing.rs", MustBeRegularFile),
            ("missing-dir/x.rs", MustBeRegularFile),
            ("../outside/x", MustBeAbsent),
            ("", MustBeAbsent),
        ] {
            assert!(
                check_host_path(&root, rel, want).is_err(),
                "{rel:?} {want:?} must be refused"
            );
        }
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[test]
    fn same_file_compares_device_and_inode() {
        // SAFETY: zeroed `stat` is a valid value for these plain fields.
        let mut a: libc::stat = unsafe { std::mem::zeroed() };
        a.st_dev = 1;
        a.st_ino = 2;
        let mut b = a;
        assert!(same_file(&a, &b));
        b.st_ino = 3;
        assert!(!same_file(&a, &b));
        b.st_ino = 2;
        b.st_dev = 9;
        assert!(!same_file(&a, &b));
    }
}
