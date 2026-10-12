//! Server-side destructive-action confirmation tokens (design of record
//! `docs/plans/2026-10-09-protocol-v1-additions.md` §2).
//!
//! Step 1 of a destructive method issues a token bound to `(action, target
//! name, target id)`; step 2 presents it. `sandbox.remove` matches action +
//! name ([`ConfirmationStore::consume`]) and then re-checks the sbx id;
//! `project.delete` matches action + project id
//! ([`ConfirmationStore::consume_by_id`]) — its name is display only. Rules enforced here:
//!
//! * 256 bits from the OS RNG (`getrandom`), hex-encoded (64 lowercase chars);
//! * single-use: a presented token is removed from the store on ANY attempt —
//!   success, expiry, or a mismatched action/name — before anything is judged;
//! * expires [`CONFIRMATION_TTL`] after issue (monotonic clock, injected so it
//!   is testable);
//! * every rejection is the same [`TokenRejected`] value, so a caller cannot
//!   learn which part of the binding mismatched;
//! * memory only, bounded to [`MAX_PENDING_CONFIRMATIONS`] entries (expired
//!   ones are evicted first, then the oldest), so tokens die with Core.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Lifetime of an issued token (design §2: 120 s).
pub const CONFIRMATION_TTL: Duration = Duration::from_secs(120);

/// Pending tokens Core keeps at once. A same-user process flooding step 1 can
/// only evict older pending tokens (the user re-confirms); memory stays bounded.
pub const MAX_PENDING_CONFIRMATIONS: usize = 64;

/// Encoded token length: 32 random bytes as lowercase hex.
pub const TOKEN_HEX_LEN: usize = 64;

/// What a token authorizes: one action on one target identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmationBinding {
    pub action: String,
    pub name: String,
    pub id: String,
}

/// The single, uniform rejection for any unusable token (unknown, malformed,
/// expired, reused, or bound to another action/target).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenRejected;

pub const TOKEN_REJECTED_MESSAGE: &str =
    "confirmation token is invalid, expired, already used, or not for this action and target; \
     request a new confirmation";

/// A9 (§3.9 item 1, W2): the step-1 file-system identity of one confirmed
/// maintenance item, kept in the token's in-memory binding so step 2 can
/// skip an item that changed in between ("changed since you confirmed").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemIdentity {
    pub id: String,
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub mtime_ns: i128,
}

#[derive(Debug)]
struct Pending {
    binding: ConfirmationBinding,
    identities: Vec<ItemIdentity>,
    issued: Instant,
    expires: Instant,
}

#[derive(Debug)]
pub struct ConfirmationStore {
    pending: HashMap<String, Pending>,
    cap: usize,
}

impl Default for ConfirmationStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfirmationStore {
    pub fn new() -> Self {
        Self::with_capacity(MAX_PENDING_CONFIRMATIONS)
    }

    pub fn with_capacity(cap: usize) -> Self {
        Self {
            pending: HashMap::new(),
            cap: cap.max(1),
        }
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Issue a fresh token for `binding`, valid until `now + ttl`
    /// (`ttl` is clamped to at most [`CONFIRMATION_TTL`]).
    pub fn issue(
        &mut self,
        binding: ConfirmationBinding,
        now: Instant,
        ttl: Duration,
    ) -> Result<String, getrandom::Error> {
        self.issue_with_identities(binding, Vec::new(), now, ttl)
    }

    /// [`Self::issue`] carrying the step-1 identities of the confirmed items
    /// (A9 `maintenance.cleanup`). Same token rules.
    pub fn issue_with_identities(
        &mut self,
        binding: ConfirmationBinding,
        identities: Vec<ItemIdentity>,
        now: Instant,
        ttl: Duration,
    ) -> Result<String, getrandom::Error> {
        let mut raw = [0u8; 32];
        getrandom::fill(&mut raw)?;
        let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        // Expired entries go first; then, if still full, the oldest pending.
        self.pending.retain(|_, p| now < p.expires);
        while self.pending.len() >= self.cap {
            let Some(oldest) = self
                .pending
                .iter()
                .min_by_key(|(_, p)| p.issued)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.pending.remove(&oldest);
        }
        self.pending.insert(
            token.clone(),
            Pending {
                binding,
                identities,
                issued: now,
                expires: now + ttl.min(CONFIRMATION_TTL),
            },
        );
        Ok(token)
    }

    /// Consume `token` for `action` on `name`. Returns the bound identity
    /// (including the sbx `id` the caller must re-check) or [`TokenRejected`].
    /// The entry is REMOVED before it is judged, so every attempt burns it.
    pub fn consume(
        &mut self,
        token: &str,
        action: &str,
        name: &str,
        now: Instant,
    ) -> Result<ConfirmationBinding, TokenRejected> {
        let Some(p) = self.pending.remove(token) else {
            return Err(TokenRejected);
        };
        // Evaluate every condition, then answer once: no early exit tells
        // which part of the binding mismatched.
        let in_time = now < p.expires;
        let same_action = p.binding.action == action;
        let same_name = p.binding.name == name;
        if in_time & same_action & same_name {
            Ok(p.binding)
        } else {
            Err(TokenRejected)
        }
    }

    /// Consume `token` for `action` on the target with identity `id`, the
    /// NAME NOT COMPARED (A3a `project.delete`: the name is carried for
    /// display only, so a rename between the steps does not invalidate the
    /// token, while a different id does). Same rules as [`Self::consume`]:
    /// removed before it is judged, one uniform rejection.
    pub fn consume_by_id(
        &mut self,
        token: &str,
        action: &str,
        id: &str,
        now: Instant,
    ) -> Result<ConfirmationBinding, TokenRejected> {
        self.consume_with_identities(token, action, id, now)
            .map(|(binding, _)| binding)
    }

    /// [`Self::consume_by_id`] that also returns the identities the token was
    /// issued with (A9: `id` is the digest of the exact confirmed item set).
    pub fn consume_with_identities(
        &mut self,
        token: &str,
        action: &str,
        id: &str,
        now: Instant,
    ) -> Result<(ConfirmationBinding, Vec<ItemIdentity>), TokenRejected> {
        let Some(p) = self.pending.remove(token) else {
            return Err(TokenRejected);
        };
        let in_time = now < p.expires;
        let same_action = p.binding.action == action;
        let same_id = p.binding.id == id;
        if in_time & same_action & same_id {
            Ok((p.binding, p.identities))
        } else {
            Err(TokenRejected)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(action: &str, name: &str, id: &str) -> ConfirmationBinding {
        ConfirmationBinding {
            action: action.into(),
            name: name.into(),
            id: id.into(),
        }
    }

    const ID: &str = "b5ebec73-e2ae-471a-811a-e011cfb1948e";

    #[test]
    fn tokens_are_256_bit_lowercase_hex_and_distinct() {
        let mut s = ConfirmationStore::new();
        let now = Instant::now();
        let a = s
            .issue(
                binding("sandbox.remove", "atlas-auth", ID),
                now,
                CONFIRMATION_TTL,
            )
            .unwrap();
        let b = s
            .issue(
                binding("sandbox.remove", "atlas-auth", ID),
                now,
                CONFIRMATION_TTL,
            )
            .unwrap();
        for t in [&a, &b] {
            assert_eq!(t.len(), TOKEN_HEX_LEN);
            assert!(t
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        }
        assert_ne!(a, b);
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn valid_token_returns_bound_identity_once() {
        let mut s = ConfirmationStore::new();
        let now = Instant::now();
        let t = s
            .issue(
                binding("sandbox.remove", "atlas-auth", ID),
                now,
                CONFIRMATION_TTL,
            )
            .unwrap();
        let got = s
            .consume(
                &t,
                "sandbox.remove",
                "atlas-auth",
                now + Duration::from_secs(5),
            )
            .unwrap();
        assert_eq!(got, binding("sandbox.remove", "atlas-auth", ID));
        // Single-use: the same token is now unknown.
        assert_eq!(
            s.consume(&t, "sandbox.remove", "atlas-auth", now),
            Err(TokenRejected)
        );
        assert!(s.is_empty());
    }

    #[test]
    fn expired_token_is_rejected_and_burned() {
        let mut s = ConfirmationStore::new();
        let now = Instant::now();
        let t = s
            .issue(
                binding("sandbox.remove", "atlas-auth", ID),
                now,
                CONFIRMATION_TTL,
            )
            .unwrap();
        assert_eq!(
            s.consume(&t, "sandbox.remove", "atlas-auth", now + CONFIRMATION_TTL),
            Err(TokenRejected),
            "valid strictly before now + ttl"
        );
        // Burned on the failed attempt: even an in-time retry fails.
        assert_eq!(
            s.consume(&t, "sandbox.remove", "atlas-auth", now),
            Err(TokenRejected)
        );
    }

    #[test]
    fn ttl_is_clamped_to_the_design_maximum() {
        let mut s = ConfirmationStore::new();
        let now = Instant::now();
        let t = s
            .issue(
                binding("sandbox.remove", "atlas-auth", ID),
                now,
                Duration::from_secs(3600),
            )
            .unwrap();
        assert_eq!(
            s.consume(
                &t,
                "sandbox.remove",
                "atlas-auth",
                now + CONFIRMATION_TTL + Duration::from_secs(1)
            ),
            Err(TokenRejected)
        );
    }

    #[test]
    fn action_or_name_mismatch_is_rejected_uniformly_and_burns_the_token() {
        let now = Instant::now();
        for (action, name) in [
            ("project.delete", "atlas-auth"),
            ("sandbox.remove", "nova-search"),
        ] {
            let mut s = ConfirmationStore::new();
            let t = s
                .issue(
                    binding("sandbox.remove", "atlas-auth", ID),
                    now,
                    CONFIRMATION_TTL,
                )
                .unwrap();
            assert_eq!(s.consume(&t, action, name, now), Err(TokenRejected));
            assert_eq!(
                s.consume(&t, "sandbox.remove", "atlas-auth", now),
                Err(TokenRejected),
                "a mismatched attempt consumes the token"
            );
        }
    }

    #[test]
    fn unknown_and_malformed_tokens_are_rejected() {
        let mut s = ConfirmationStore::new();
        let now = Instant::now();
        let t = s
            .issue(
                binding("sandbox.remove", "atlas-auth", ID),
                now,
                CONFIRMATION_TTL,
            )
            .unwrap();
        let upper = t.to_ascii_uppercase();
        for bad in ["", "abc", &"0".repeat(TOKEN_HEX_LEN), upper.as_str()] {
            assert_eq!(
                s.consume(bad, "sandbox.remove", "atlas-auth", now),
                Err(TokenRejected),
                "{bad:?}"
            );
        }
        // Rejections of OTHER strings never consumed the real token.
        assert!(s.consume(&t, "sandbox.remove", "atlas-auth", now).is_ok());
    }

    #[test]
    fn store_is_bounded_and_evicts_expired_then_oldest() {
        let mut s = ConfirmationStore::with_capacity(4);
        let t0 = Instant::now();
        let first = s
            .issue(binding("sandbox.remove", "a0", ID), t0, CONFIRMATION_TTL)
            .unwrap();
        for i in 1..10u64 {
            s.issue(
                binding("sandbox.remove", "ax", ID),
                t0 + Duration::from_millis(i),
                CONFIRMATION_TTL,
            )
            .unwrap();
            assert!(s.len() <= 4);
        }
        assert_eq!(s.len(), 4);
        // The oldest was evicted to make room.
        assert_eq!(
            s.consume(&first, "sandbox.remove", "a0", t0),
            Err(TokenRejected)
        );
        // Expired entries go first: after the TTL, one issue leaves only itself.
        s.issue(
            binding("sandbox.remove", "late", ID),
            t0 + CONFIRMATION_TTL + Duration::from_secs(1),
            CONFIRMATION_TTL,
        )
        .unwrap();
        assert_eq!(s.len(), 1);
    }

    /// A9 (§3.9 item 1, W2): a maintenance token carries the step-1
    /// file-system identities; consuming it returns them exactly once, under
    /// the same burn-before-judge rules as every other token.
    #[test]
    fn identities_travel_with_the_token_and_burn_with_it() {
        let mut s = ConfirmationStore::new();
        let now = Instant::now();
        let ids = vec![ItemIdentity {
            id: "temp:x".into(),
            dev: 1,
            ino: 2,
            size: 3,
            mtime_ns: 4,
        }];
        let t = s
            .issue_with_identities(
                binding("maintenance.cleanup", "", "digest"),
                ids.clone(),
                now,
                CONFIRMATION_TTL,
            )
            .unwrap();
        let (b, got) = s
            .consume_with_identities(&t, "maintenance.cleanup", "digest", now)
            .unwrap();
        assert_eq!((b.id.as_str(), got), ("digest", ids.clone()));
        assert_eq!(
            s.consume_with_identities(&t, "maintenance.cleanup", "digest", now),
            Err(TokenRejected),
            "single use"
        );
        // Wrong digest, wrong action, expired: uniform rejection, burned.
        for (action, id, at) in [
            ("maintenance.cleanup", "other", now),
            ("project.delete", "digest", now),
            ("maintenance.cleanup", "digest", now + CONFIRMATION_TTL),
        ] {
            let t = s
                .issue_with_identities(
                    binding("maintenance.cleanup", "", "digest"),
                    ids.clone(),
                    now,
                    CONFIRMATION_TTL,
                )
                .unwrap();
            assert_eq!(
                s.consume_with_identities(&t, action, id, at),
                Err(TokenRejected)
            );
            assert_eq!(
                s.consume_with_identities(&t, "maintenance.cleanup", "digest", now),
                Err(TokenRejected),
                "burned by the failed attempt"
            );
        }
        // A plain token carries no identities.
        let t = s
            .issue(
                binding("maintenance.cleanup", "", "d2"),
                now,
                CONFIRMATION_TTL,
            )
            .unwrap();
        let (_, got) = s
            .consume_with_identities(&t, "maintenance.cleanup", "d2", now)
            .unwrap();
        assert!(got.is_empty());
    }

    /// A3a: `project.delete` binds the project ID; the name is display only,
    /// so a rename between the steps does not invalidate the token.
    #[test]
    fn consume_by_id_ignores_the_name_but_not_the_id_or_action() {
        let mut s = ConfirmationStore::new();
        let now = Instant::now();
        let t = s
            .issue(
                binding("project.delete", "Atlas Demo", "p-1"),
                now,
                CONFIRMATION_TTL,
            )
            .unwrap();
        let got = s.consume_by_id(&t, "project.delete", "p-1", now).unwrap();
        assert_eq!(got.name, "Atlas Demo", "name carried for display");
        assert_eq!(
            s.consume_by_id(&t, "project.delete", "p-1", now),
            Err(TokenRejected),
            "single use"
        );
        // Wrong id, wrong action, expired: uniform rejection, token burned.
        for (action, id, at) in [
            ("project.delete", "p-2", now),
            ("sandbox.remove", "p-1", now),
            ("project.delete", "p-1", now + CONFIRMATION_TTL),
        ] {
            let t = s
                .issue(
                    binding("project.delete", "Atlas Demo", "p-1"),
                    now,
                    CONFIRMATION_TTL,
                )
                .unwrap();
            assert_eq!(s.consume_by_id(&t, action, id, at), Err(TokenRejected));
            assert_eq!(
                s.consume_by_id(&t, "project.delete", "p-1", now),
                Err(TokenRejected),
                "burned by the failed attempt"
            );
        }
        // A sandbox.remove token is not a project.delete token, even by id.
        let t = s
            .issue(
                binding("sandbox.remove", "atlas-auth", "p-1"),
                now,
                CONFIRMATION_TTL,
            )
            .unwrap();
        assert_eq!(
            s.consume_by_id(&t, "project.delete", "p-1", now),
            Err(TokenRejected)
        );
        assert!(s.is_empty());
    }
}
