//! Task scheduler constraints (docs/specs/02 §4):
//! - configurable global and per-project parallel-task maxima
//! - ONE active writer per writable workspace; read-only conversations may share
//! - independent writers require separate worktrees/clones/sandboxes
//! - conflicts are queued, never raced
//!
//! This module is the in-memory policy engine; durable task rows and events
//! live in SQLite via [`crate::db`] / [`crate::events`].

use std::collections::HashMap;

use sandpane_protocol::WorkspaceMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// May start now.
    Admitted,
    /// Must wait: global or per-project concurrency exhausted.
    QueuedConcurrency,
    /// Must wait: another writer holds the workspace lock.
    QueuedWriterLock,
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_global_running: usize,
    pub max_per_project_running: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_global_running: 4,
            max_per_project_running: 2,
        }
    }
}

/// What Core recorded when a task was admitted, so release never depends on
/// a caller re-supplying the same project/workspace (review 0015 bug 7).
#[derive(Debug, Clone, PartialEq, Eq)]
struct RunningEntry {
    project_id: String,
    workspace_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Scheduler {
    limits: Limits,
    running: HashMap<String, RunningEntry>,
    running_per_project: HashMap<String, usize>,
    /// workspace key -> task id holding the single writer lock.
    writer_locks: HashMap<String, String>,
}

impl Scheduler {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            running: HashMap::new(),
            running_per_project: HashMap::new(),
            writer_locks: HashMap::new(),
        }
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// Decide whether `task_id` may start. Read-only tasks ignore writer locks
    /// (analysis conversations may share a sandbox) but still count against
    /// concurrency limits.
    pub fn admit(
        &self,
        task_id: &str,
        project_id: &str,
        workspace_key: Option<&str>,
        mode: WorkspaceMode,
    ) -> Admission {
        if self.running.len() >= self.limits.max_global_running {
            return Admission::QueuedConcurrency;
        }
        let per_project = self
            .running_per_project
            .get(project_id)
            .copied()
            .unwrap_or(0);
        if per_project >= self.limits.max_per_project_running {
            return Admission::QueuedConcurrency;
        }
        if Self::is_writable(mode) {
            if let Some(ws) = workspace_key {
                if let Some(holder) = self.writer_locks.get(ws) {
                    if holder != task_id {
                        return Admission::QueuedWriterLock;
                    }
                }
            }
        }
        Admission::Admitted
    }

    /// Record that `task_id` started. Returns Err(admission) when admission
    /// would be violated (callers must `admit` first; this is the commit
    /// point). IDEMPOTENT: marking an already-running task again changes
    /// nothing and succeeds — it used to double-count the per-project slot,
    /// starving that project after a retry.
    pub fn mark_running(
        &mut self,
        task_id: &str,
        project_id: &str,
        workspace_key: Option<&str>,
        mode: WorkspaceMode,
    ) -> Result<(), Admission> {
        if self.running.contains_key(task_id) {
            return Ok(());
        }
        match self.admit(task_id, project_id, workspace_key, mode) {
            Admission::Admitted => {}
            other => return Err(other),
        }
        let locked_key = if Self::is_writable(mode) {
            workspace_key.map(str::to_string)
        } else {
            None
        };
        self.running.insert(
            task_id.to_string(),
            RunningEntry {
                project_id: project_id.to_string(),
                workspace_key: locked_key.clone(),
            },
        );
        *self
            .running_per_project
            .entry(project_id.to_string())
            .or_insert(0) += 1;
        if let Some(ws) = locked_key {
            self.writer_locks.insert(ws, task_id.to_string());
        }
        Ok(())
    }

    /// Release all resources held by a finished/cancelled/interrupted task,
    /// using the project and workspace recorded at admission. Releasing a
    /// task that is not running is a no-op (idempotent).
    pub fn mark_finished(&mut self, task_id: &str) {
        let Some(entry) = self.running.remove(task_id) else {
            return;
        };
        if let Some(n) = self.running_per_project.get_mut(&entry.project_id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                self.running_per_project.remove(&entry.project_id);
            }
        }
        if let Some(ws) = entry.workspace_key {
            if self.writer_locks.get(&ws).map(String::as_str) == Some(task_id) {
                self.writer_locks.remove(&ws);
            }
        }
    }

    pub fn running_in_project(&self, project_id: &str) -> usize {
        self.running_per_project
            .get(project_id)
            .copied()
            .unwrap_or(0)
    }

    /// After a Core restart, reconciliation starts from EMPTY scheduler state:
    /// previously-"running" tasks are `interrupted` in the database and must be
    /// re-admitted like any new task. This method documents/enforces that.
    pub fn reconciliation_baseline() -> Self {
        Self::new(Limits::default())
    }

    /// Take the single writer lock on `workspace_key` for an OPERATION that
    /// is not a running task (A6 W6: `git.apply`; worktree discard). `Err`
    /// names the current holder — a writing task or another operation; the
    /// caller refuses (CONFLICT), it never waits or races. Not re-entrant.
    pub fn try_lock_writer(&mut self, workspace_key: &str, holder: &str) -> Result<(), String> {
        if let Some(current) = self.writer_locks.get(workspace_key) {
            return Err(current.clone());
        }
        self.writer_locks
            .insert(workspace_key.to_string(), holder.to_string());
        Ok(())
    }

    /// Release a lock taken by [`Self::try_lock_writer`]; only its holder
    /// can (anything else is a no-op).
    pub fn unlock_writer(&mut self, workspace_key: &str, holder: &str) {
        if self.writer_locks.get(workspace_key).map(String::as_str) == Some(holder) {
            self.writer_locks.remove(workspace_key);
        }
    }

    pub fn writer_lock_holder(&self, workspace_key: &str) -> Option<&str> {
        self.writer_locks.get(workspace_key).map(String::as_str)
    }

    pub fn running_count(&self) -> usize {
        self.running.len()
    }

    /// direct_mount and host_worktree/sbx_clone writes are writable modes;
    /// mountless scratch has no host workspace to lock (None key by callers),
    /// and read-only conversations pass no workspace_key.
    pub fn is_writable(mode: WorkspaceMode) -> bool {
        matches!(
            mode,
            WorkspaceMode::DirectMount | WorkspaceMode::SbxClone | WorkspaceMode::HostWorktree
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_limit_queues() {
        let mut s = Scheduler::new(Limits {
            max_global_running: 2,
            max_per_project_running: 2,
        });
        s.mark_running("t1", "pA", None, WorkspaceMode::Mountless)
            .unwrap();
        s.mark_running("t2", "pB", None, WorkspaceMode::Mountless)
            .unwrap();
        assert_eq!(
            s.admit("t3", "pA", None, WorkspaceMode::Mountless),
            Admission::QueuedConcurrency
        );
        s.mark_finished("t1");
        assert_eq!(
            s.admit("t3", "pA", None, WorkspaceMode::Mountless),
            Admission::Admitted
        );
    }

    #[test]
    fn per_project_limit_queues() {
        let mut s = Scheduler::new(Limits {
            max_global_running: 8,
            max_per_project_running: 1,
        });
        s.mark_running("t1", "pA", None, WorkspaceMode::Mountless)
            .unwrap();
        assert_eq!(
            s.admit("t2", "pA", None, WorkspaceMode::Mountless),
            Admission::QueuedConcurrency
        );
        // Other project unaffected.
        assert_eq!(
            s.admit("t3", "pB", None, WorkspaceMode::Mountless),
            Admission::Admitted
        );
    }

    #[test]
    fn one_writer_per_writable_workspace() {
        let mut s = Scheduler::new(Limits::default());
        s.mark_running("t1", "pA", Some("/repo/atlas"), WorkspaceMode::HostWorktree)
            .unwrap();
        // Second writer on the same workspace is queued, never raced.
        assert_eq!(
            s.admit("t2", "pA", Some("/repo/atlas"), WorkspaceMode::DirectMount),
            Admission::QueuedWriterLock
        );
        // A writer on a DIFFERENT workspace (separate worktree) is fine.
        assert_eq!(
            s.admit(
                "t3",
                "pA",
                Some("/repo/atlas-wt2"),
                WorkspaceMode::HostWorktree
            ),
            Admission::Admitted
        );
        // Read-only sharing of the same environment is allowed (no ws key).
        assert_eq!(
            s.admit("t4", "pA", None, WorkspaceMode::Mountless),
            Admission::Admitted
        );
        // Lock releases only when the holder finishes.
        s.mark_finished("t2"); // not running, not the holder: no-op
        assert_eq!(s.writer_lock_holder("/repo/atlas"), Some("t1"));
        s.mark_finished("t1");
        assert_eq!(s.writer_lock_holder("/repo/atlas"), None);
        assert_eq!(
            s.admit("t2", "pA", Some("/repo/atlas"), WorkspaceMode::SbxClone),
            Admission::Admitted
        );
    }

    /// Bug 7: a repeated mark_running (retry / duplicate start) must not
    /// double-count; one finish fully releases the slot and the lock.
    #[test]
    fn mark_running_is_idempotent_and_finish_releases_fully() {
        let mut s = Scheduler::new(Limits {
            max_global_running: 2,
            max_per_project_running: 2,
        });
        s.mark_running("t1", "pA", Some("/repo/a"), WorkspaceMode::DirectMount)
            .unwrap();
        s.mark_running("t1", "pA", Some("/repo/a"), WorkspaceMode::DirectMount)
            .unwrap();
        assert_eq!(s.running_count(), 1);
        assert_eq!(s.running_in_project("pA"), 1);
        // Still room for a second task in pA.
        assert_eq!(
            s.admit("t2", "pA", None, WorkspaceMode::Mountless),
            Admission::Admitted
        );
        // Idempotent even when the global limit is otherwise exhausted.
        s.mark_running("t2", "pA", None, WorkspaceMode::Mountless)
            .unwrap();
        s.mark_running("t1", "pA", Some("/repo/a"), WorkspaceMode::DirectMount)
            .unwrap();
        s.mark_finished("t1");
        s.mark_finished("t1");
        assert_eq!(s.running_in_project("pA"), 1);
        assert_eq!(s.writer_lock_holder("/repo/a"), None);
        s.mark_finished("t2");
        assert_eq!(s.running_in_project("pA"), 0);
        assert_eq!(s.running_count(), 0);
    }

    /// A6 W6: an apply takes the writer lock on the host repository path;
    /// any other holder (a writing task, another apply, a discard) means
    /// refusal, never a wait or a race. Only the holder releases it.
    #[test]
    fn operation_writer_lock_is_exclusive_with_tasks_and_operations() {
        let mut s = Scheduler::new(Limits::default());
        assert_eq!(s.try_lock_writer("/repo", "git.apply:t1"), Ok(()));
        assert_eq!(
            s.try_lock_writer("/repo", "git.apply:t2"),
            Err("git.apply:t1".to_string())
        );
        // A writable task on the same workspace is queued behind it.
        assert_eq!(
            s.admit("t3", "p", Some("/repo"), WorkspaceMode::DirectMount),
            Admission::QueuedWriterLock
        );
        // Another workspace is independent.
        assert_eq!(s.try_lock_writer("/other", "git.apply:t2"), Ok(()));
        // A non-holder cannot release it.
        s.unlock_writer("/repo", "git.apply:t2");
        assert_eq!(s.writer_lock_holder("/repo"), Some("git.apply:t1"));
        s.unlock_writer("/repo", "git.apply:t1");
        assert_eq!(s.writer_lock_holder("/repo"), None);
        // A running writer task blocks an operation.
        s.mark_running("t4", "p", Some("/repo"), WorkspaceMode::DirectMount)
            .unwrap();
        assert_eq!(
            s.try_lock_writer("/repo", "git.apply:t1"),
            Err("t4".to_string())
        );
        // The same holder re-locking is refused too (no re-entrancy).
        s.mark_finished("t4");
        s.try_lock_writer("/repo", "x").unwrap();
        assert!(s.try_lock_writer("/repo", "x").is_err());
    }

    #[test]
    fn mountless_is_not_writable() {
        assert!(!Scheduler::is_writable(WorkspaceMode::Mountless));
        assert!(Scheduler::is_writable(WorkspaceMode::DirectMount));
    }

    #[test]
    fn restart_reconciliation_starts_empty() {
        let s = Scheduler::reconciliation_baseline();
        assert_eq!(s.running_count(), 0);
        // A task previously "running" must be re-admitted, never assumed running.
        assert_eq!(
            s.admit("old-task", "pA", Some("/repo"), WorkspaceMode::HostWorktree),
            Admission::Admitted
        );
    }
}
