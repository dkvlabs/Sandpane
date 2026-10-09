//! Task scheduler constraints (docs/specs/02 §4):
//! - configurable global and per-project parallel-task maxima
//! - ONE active writer per writable workspace; read-only conversations may share
//! - independent writers require separate worktrees/clones/sandboxes
//! - conflicts are queued, never raced
//!
//! This module is the in-memory policy engine; durable task rows and events
//! live in SQLite via [`crate::db`] / [`crate::events`].

use std::collections::{HashMap, HashSet};

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

#[derive(Debug, Clone)]
pub struct Scheduler {
    limits: Limits,
    running: HashSet<String>,
    running_per_project: HashMap<String, usize>,
    /// workspace key -> task id holding the single writer lock.
    writer_locks: HashMap<String, String>,
}

impl Scheduler {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            running: HashSet::new(),
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

    /// Record that `task_id` started. Returns Err(()) when admission would be
    /// violated (callers must `admit` first; this is the commit point).
    pub fn mark_running(
        &mut self,
        task_id: &str,
        project_id: &str,
        workspace_key: Option<&str>,
        mode: WorkspaceMode,
    ) -> Result<(), Admission> {
        match self.admit(task_id, project_id, workspace_key, mode) {
            Admission::Admitted => {}
            other => return Err(other),
        }
        self.running.insert(task_id.to_string());
        *self
            .running_per_project
            .entry(project_id.to_string())
            .or_insert(0) += 1;
        if Self::is_writable(mode) {
            if let Some(ws) = workspace_key {
                self.writer_locks
                    .insert(ws.to_string(), task_id.to_string());
            }
        }
        Ok(())
    }

    /// Release all resources held by a finished/cancelled/interrupted task.
    pub fn mark_finished(&mut self, task_id: &str, project_id: &str, workspace_key: Option<&str>) {
        if self.running.remove(task_id) {
            if let Some(n) = self.running_per_project.get_mut(project_id) {
                *n = n.saturating_sub(1);
            }
        }
        if let Some(ws) = workspace_key {
            if self.writer_locks.get(ws).map(String::as_str) == Some(task_id) {
                self.writer_locks.remove(ws);
            }
        }
    }

    /// After a Core restart, reconciliation starts from EMPTY scheduler state:
    /// previously-"running" tasks are `interrupted` in the database and must be
    /// re-admitted like any new task. This method documents/enforces that.
    pub fn reconciliation_baseline() -> Self {
        Self::new(Limits::default())
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
        s.mark_finished("t1", "pA", None);
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
        s.mark_finished("t2", "pA", Some("/repo/atlas")); // not the holder: no-op
        assert_eq!(s.writer_lock_holder("/repo/atlas"), Some("t1"));
        s.mark_finished("t1", "pA", Some("/repo/atlas"));
        assert_eq!(s.writer_lock_holder("/repo/atlas"), None);
        assert_eq!(
            s.admit("t2", "pA", Some("/repo/atlas"), WorkspaceMode::SbxClone),
            Admission::Admitted
        );
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
