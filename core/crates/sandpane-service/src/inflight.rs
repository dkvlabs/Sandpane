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

use std::collections::HashSet;
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
}
