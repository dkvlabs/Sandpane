# 0024 — Auto-review record: fail closed on repositories with submodules

- **date:** 2026-10-09
- **implementation commit:** `fb16670` — fix(core): fail closed on repositories with submodules (review integrity)
- **trigger:** finding from the automated commit security review of `bb5cc8f` (security-guidance plugin)

## Finding (input)

**[MEDIUM, logic/review-integrity] `core/crates/sandpane-core/src/git.rs`.**

`status_porcelain()` and `diff_name_status` pass `--ignore-submodules=dirty`. This flag was added in 0019 so that a submodule's own filter drivers never run, and it is still needed for that. But it also hides uncommitted or untracked work inside a submodule's work tree:

- the dirty gate can report clean, which risks overwriting uncommitted host work (AGENTS.md Code Review rule 7);
- a review can under-report an agent's changes.

## Method

1. The `core-engineer` agent implemented a fail-closed refusal.
2. A mutation check confirmed the tests catch the bug: with `refuse_submodules` forced to return `Ok`, 4 tests failed, including the service test. With the bug present, that test returned `{"changes":[],"hostDirty":false}` even though the submodule held uncommitted work.
3. The orchestrator re-ran the gates fresh, rebuilt the service, and ran the live VS Code check.

The scope was Core only. The protocol and schemas are unchanged.

## Disposition

**Fixed: fail closed.**

- **Submodule detection.** Gitlinks (mode 160000) are read from the index only, through the existing hardened runner, using `ls-files --stage -z --full-name -- :(top)`. Submodule work trees are never entered.
- **What refuses.** `is_dirty()` and `change_list()` refuse with `SubmodulesPresent`, so the apply preconditions refuse as well. `git.review` then returns `VALIDATION_FAILED` naming the paths, and `git.apply` aborts with an `abortReason`.
- **Why `.gitmodules` is not the trigger.** It is an agent-writable work-tree file, so it is deliberately ignored here.

## Behaviour change visible to clients

`git.review` and `git.apply` now refuse every repository whose index has a gitlink, including clean submodules and task worktrees created from such repositories.

## Residual risk and follow-ups (recorded)

- **Large indexes.** An index above about 700k entries exceeds the 64 MiB scan cap and is refused.
- **Untracked nested repositories** (no gitlink) still trip the dirty gate as `?? dir/`.
- **Git versions.** Verified on git 2.56.0 only.
- **Protocol follow-up (C-series).** A `ChangeSet` field for uninspected paths would allow a flagged partial review instead of a refusal.
- **Earlier refusal (C3).** Refusing at task or worktree creation would surface the problem sooner than at review.

## Verification evidence (orchestrator, fresh)

- `cargo fmt --check` passes, and `cargo clippy --all-targets -- -D warnings` is clean.
- `cargo test`:
  - sandpane-core 90;
  - lifecycle 3;
  - protocol 13;
  - service lib 19;
  - service_integration 35;
  - 0 failed.
- `make schema-drift` reports "All schema/protocol value sets in sync."
- With the service rebuilt, the live VS Code check reports `56/56 checks passed against the live Core service`, so repositories without submodules are unaffected.
- The secret/path gate is clean (3 files).

**PASS.**
