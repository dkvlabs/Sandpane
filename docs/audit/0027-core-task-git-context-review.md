# 0027 — Auto-review record: task Git context and host worktrees (C3)

- **date:** 2026-10-09
- **implementation commit:** `2232d88` — feat(core): task Git context and host worktrees, with fail-closed discard (C3)
- **review ran:** before the commit, in three rounds:
  1. phase review and security review in parallel;
  2. a security re-review after the fixes;
  3. orchestrator verification.

## Scope

`core/`:

- `sandpane-core`: `db.rs` (migration v3), `git.rs` (builders, hardening, runner helpers) and the new `workspace.rs`.
- `sandpane-service`: `lib.rs` (`create_task`, discard, review routing, excludes vetting, orphan report) and `main.rs`.
- The new test file `tests/task_git_context.rs`.

`sandpane-protocol` and `schemas/` were **not** changed.

## Reachability (important for reading this entry)

This is a **Core-internal capability**:

- `conversation.send` still creates tasks with no Git context.
- `create_task` with a workspace is reachable only from Rust.
- Discarding a worktree is reachable only from Rust.
- `sandbox.create` still refuses `host_worktree`.

Therefore:

- The P2 item "unique branch/worktree/sandbox per isolated writable task" and the P4 item "branch/worktree/clone assignment; record base" are **not** ticked.
- Two spec §7 fields remain open: `sandbox_name` per task and `integration_status`.
- The cleanup and retention **policy** (A9) remains open.

The protocol additions this needs are listed in [plans/2026-10-09-protocol-v1-additions.md](../plans/2026-10-09-protocol-v1-additions.md) and in the engineer's report (workspace on send, `TaskSummary.workspaceMode/worktreePath`, `ChangeSet.repoPath`, tokened discard, sandbox↔worktree binding).

## Method

1. **Implementation.** The `core-engineer` agent used TDD; every new test was observed failing first, or was proven with a mutation check.
2. **Phase review** (`phase-reviewer`). PASS-WITH-WARNINGS:
   - W1: the docs overstated host_worktree isolation (it shares the user's `.git`).
   - W2: the spec §7 gaps were not recorded.
   - W3: crash orphans; rollback untested.
   - W4: the sbx_clone base was asserted without evidence.
   - W5: `worktree remove` ran under the 30 s QUERY timeout.
   - S1–S10.
3. **Security review** (`security-reviewer`). **BLOCK**, with two Critical findings proven by a PoC crate that drives Core's own `remove_worktree`:
   - **C1:** a task ref made symbolic (`ref: refs/heads/main`) caused `update-ref -d` (without `--no-deref`) to delete the **user's `main` branch** and its reflog; HEAD became unborn.
   - **C2:** repo config `status.showUntrackedFiles=no` made `is_dirty` report clean. Git's own check inside `worktree remove` honours the same config, so discard **deleted untracked work** that `git.review` had listed.
   - Also W1–W4 (shared common `.git`, ignored-file reclassification, orphans) and S1–S3.
4. **Fixes, all with tests:**
   - C1: `--no-deref`, plus a refusal on a symbolic task ref (CONFLICT).
   - C2: `status.showUntrackedFiles=normal` and `--untracked-files=normal`. This also covers the host dirty gate, where the same gap pre-existed.
   - Index flags: `core.ignoreStat=false`, plus a refusal on assume-unchanged or skip-worktree entries.
   - Ignored files: discard refuses when any exist. A repo-local `core.excludesFile` is overridden.
   - Excludes file, at the orchestrator's request: pinning it to `/dev/null` would have marked every repo dirty for users whose global ignore lists `.DS_Store`. Core now resolves the user's global excludes file once, from `--global` config at cwd `/` with `GIT_*` scrubbed. It accepts the file only if the canonical path is a regular file owned by the user and outside every registered repository and the worktree root; otherwise `/dev/null`.
   - `worktree remove` and `update-ref` use MUTATION limits.
   - A durable `workspace.removing` intent event, plus `removal_failed`.
   - sbx_clone records no base.
   - Read-only startup orphan report.
   - Rollback test using a SQLite trigger that injects a failure.
   - Non-ASCII path and branch-advanced tests.
   - Writer-lock holder check.
   - Docs now state the shared-`.git` limitation and the binding preconditions.
5. **Security re-review.** PASS-WITH-WARNINGS. The reviewer's PoCs were re-run against the fixed code:

   | PoC | Result |
   |---|---|
   | A: symref to `main` | refused; `main` intact |
   | A2: symref planted after planning | `--no-deref` deleted only the symref |
   | B: `showUntrackedFiles=no` | refused |
   | B2: untracked file written after planning | git's internal check refused (the `-c` override reaches it) |
   | D: catch-all `info/exclude` | refused |
   | E: assume-unchanged | refused |
   | F: excludes resolution | not influenced by `-c` or repo config; global `include` is not followed (safe default) |

## Findings and disposition

| ID | Source | Severity | Disposition |
|---|---|---|---|
| C1 symref deletes the user's branch | security | **Critical** | **Fixed** and re-verified (PoC A, A2) |
| C2 hidden untracked work deleted | security | **Critical** | **Fixed** and re-verified (PoC B, B2). The host gate is fixed too |
| Shared common `.git` (hooks, refs, config writable by a bound sandbox) | phase W1 / security W4 | Warning | **Documented.** Preconditions before any sandbox↔worktree binding: (1) no sandbox write access to the common `.git`, or label it like direct_mount; (2) discard only with the sandbox stopped/unmounted, **enforced by Core**; (3) never `--force` |
| Ignored files created after planning are deleted by `worktree remove` (PoC D2); lstat→opendir race with a live writer | security re-review W1 | Warning | **Accepted while unreachable.** No writer can exist in a task worktree today (no binding, no wire discard). The preconditions above must be **enforced** before exposure |
| Writer-lock check is effectively a no-op (`mark_running` is never called yet) | security re-review W1 / S2 | Warning | Recorded. It must be wired when adapters run tasks; cancel must then release the lock |
| §7 gaps: `integration_status`, per-task `sandbox_name`, retention | phase W2 | Warning | **Deferred** (C4, A9 and the protocol additions). Not ticked |
| Crash orphans | phase W3 / security W3 | Warning | Read-only startup report (stderr); A9 owns cleanup |
| sbx_clone base unproven | phase W4 | Warning | **Fixed:** no base recorded |
| QUERY timeout on remove | phase W5 | Warning | **Fixed:** MUTATION |
| Excludes vetting: startup-only forbidden roots; file mode and parent writability not checked; global `include` not followed | security re-review S1 | Suggestion | Deferred: re-vet on repository registration and refuse `mode & 0o022`. Cannot cause deletion, only listing differences |
| Apply must also check ignored files at target paths (merge/cherry-pick overwrite ignored files) | security re-review S3 | Suggestion | **C4 / A6 requirement** |
| Phase S2–S10 and security S1–S3 | — | Suggestions | Fixed (S1 intent event, S4 error mapping, S5 logging, S9 tests) or folded into C4/A6/A9 (S2 apply by mode, S8 C2 delete must discard first) |

## Behaviour changes visible to clients

- **Every hardened git call** (`git.review`, `hostDirty`, apply preconditions) now:
  - shows untracked files even when the repo config hides them;
  - ignores repo-local `core.excludesFile` but honours the user's own global ignores.
- **Schema v3:** an old Core binary refuses the upgraded database (TooNew). Restore from `<db>.pre-v3.bak` to downgrade.
- **The `sandbox.create` host_worktree refusal** has a reworded message; it is still VALIDATION_FAILED.

## Residual risk

- **`process::tests::timeout_kills_a_grandchild_holding_the_pipe`** failed once for the reviewer under parallel load. It passed on three reviewer reruns and on two full orchestrator runs. The file was unchanged by this diff. Recorded as possibly flaky, to watch in CI.
- **sbx_clone with real sbx** is unverified.
- **Non-Unix hosts:** allocation is refused.
- **Excludes resolution:** `GIT_CONFIG_GLOBAL` relocation is not honoured, and `main.rs` resolution wiring is untested.

## Verification evidence (orchestrator, fresh, before the commit)

- `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`: clean.
- `cargo test --no-fail-fast`, run twice. Each run: 123 + 3 + 13 + 19 + 35 + 16 passed, 0 failed.
- `make schema-drift`: "All schema/protocol value sets in sync."
- Service rebuilt, then `live-core-check.mjs`: `56/56 checks passed against the live Core service`.
- Secret/path gate: clean (7 files).

**Three-round review: BLOCK → Criticals fixed → PASS-WITH-WARNINGS (binding preconditions recorded). PASS.**
