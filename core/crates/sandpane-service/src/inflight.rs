//! Per-sandbox-name operation lock (review W2).
//!
//! `sandbox.create` and the confirmed step of `sandbox.remove` both act on a
//! sandbox NAME through sbx and then write `sandbox_bindings` rows for it. Run
//! concurrently, a remove could mark the binding a racing create just wrote.
//! A name in flight is therefore exclusive: a second operation on it is
//! refused immediately with `CONFLICT` (never queued, never raced), and runs
//! nothing.
//!
//! This is a set of names, not a mutex held across work: the set's own mutex
//! is held only for the insert/remove, so no Core mutex is ever held while a
//! subprocess runs. The guard releases the name on drop, including on early
//! return and unwind.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

#[derive(Debug, Default)]
pub struct SandboxOpLocks {
    names: Mutex<HashSet<String>>,
}

/// Exclusive claim on one sandbox name; released when dropped.
#[derive(Debug)]
pub struct SandboxOpGuard<'a> {
    locks: &'a SandboxOpLocks,
    name: String,
}

impl SandboxOpLocks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim `name`, or `None` when another operation holds it.
    pub fn try_acquire(&self, name: &str) -> Option<SandboxOpGuard<'_>> {
        if self.set().insert(name.to_string()) {
            Some(SandboxOpGuard {
                locks: self,
                name: name.to_string(),
            })
        } else {
            None
        }
    }

    pub fn is_held(&self, name: &str) -> bool {
        self.set().contains(name)
    }

    /// Poison-tolerant: a panicking holder still releases through `Drop`.
    fn set(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.names.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for SandboxOpGuard<'_> {
    fn drop(&mut self) {
        self.locks.set().remove(&self.name);
    }
}

/// Per-project count of `sandbox.create` calls in flight (A3a §3.2 item 4).
///
/// `project.delete` refuses while a project's count is above zero, so a
/// sandbox can never be created for a project deleted underneath it (the
/// binding row would then have no project). Counted, not exclusive: creates
/// of different sandboxes for one project run in parallel.
///
/// LOCK ORDER: this map's mutex is a LEAF. It is held only for the
/// increment / decrement / read, never while acquiring the DB mutex, a
/// sandbox-name claim, or anything else, and never while a subprocess runs.
/// `project.delete` reads it while HOLDING the DB mutex (DB → leaf), and
/// `sandbox.create` increments it with no other Core lock held — so no cycle
/// exists. Correctness argument: create increments FIRST and only then
/// re-checks, under the DB mutex, that the project still exists; delete
/// checks the count under the DB mutex in the same critical section as its
/// delete transaction. Either delete sees the count (and refuses), or create
/// sees the project gone (and runs nothing).
#[derive(Debug, Default)]
pub struct ProjectCreates {
    counts: Mutex<HashMap<String, usize>>,
}

/// One in-flight create for one project; decremented when dropped
/// (binding written, failure, early return or unwind).
#[derive(Debug)]
pub struct ProjectCreateGuard<'a> {
    creates: &'a ProjectCreates,
    project_id: String,
}

impl ProjectCreates {
    pub fn new() -> Self {
        Self::default()
    }

    /// Count one more create for `project_id` until the guard drops.
    pub fn enter(&self, project_id: &str) -> ProjectCreateGuard<'_> {
        *self.map().entry(project_id.to_string()).or_insert(0) += 1;
        ProjectCreateGuard {
            creates: self,
            project_id: project_id.to_string(),
        }
    }

    pub fn count(&self, project_id: &str) -> usize {
        self.map().get(project_id).copied().unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.map().is_empty()
    }

    /// Poison-tolerant, like [`SandboxOpLocks`].
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, usize>> {
        self.counts.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for ProjectCreateGuard<'_> {
    fn drop(&mut self) {
        let mut map = self.creates.map();
        if let Some(n) = map.get_mut(&self.project_id) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                map.remove(&self.project_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_exclusive_until_its_guard_drops() {
        let locks = SandboxOpLocks::new();
        let g = locks.try_acquire("atlas-auth").expect("free name");
        assert!(locks.is_held("atlas-auth"));
        assert!(
            locks.try_acquire("atlas-auth").is_none(),
            "second claim refused"
        );
        // Other names are independent.
        let other = locks.try_acquire("nova-search").expect("independent name");
        drop(g);
        assert!(!locks.is_held("atlas-auth"));
        assert!(
            locks.try_acquire("atlas-auth").is_some(),
            "released on drop"
        );
        drop(other);
        assert!(!locks.is_held("nova-search"));
    }

    #[test]
    fn released_on_unwind() {
        let locks = SandboxOpLocks::new();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = locks.try_acquire("atlas-auth").unwrap();
            panic!("handler failed mid-operation");
        }));
        assert!(r.is_err());
        assert!(!locks.is_held("atlas-auth"));
    }

    /// A3a: per-project create counter — counted (not exclusive), released
    /// on drop and on unwind, independent per project.
    #[test]
    fn project_create_count_is_held_until_every_guard_drops() {
        let c = ProjectCreates::new();
        assert_eq!(c.count("p-1"), 0);
        let a = c.enter("p-1");
        let b = c.enter("p-1");
        let other = c.enter("p-2");
        assert_eq!(c.count("p-1"), 2);
        assert_eq!(c.count("p-2"), 1);
        drop(a);
        assert_eq!(c.count("p-1"), 1);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _b = b;
            panic!("create failed mid-operation");
        }));
        assert!(r.is_err());
        assert_eq!(c.count("p-1"), 0, "released on unwind");
        drop(other);
        assert_eq!(c.count("p-2"), 0);
        assert!(c.is_empty(), "no zero-count entries linger");
    }
}
