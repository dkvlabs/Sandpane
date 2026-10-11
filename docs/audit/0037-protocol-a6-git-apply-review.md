# 0037 — Auto-review record: protocol A6, `git.apply` for reviewed files

- **date:** 2026-10-11
- **implementation commit:** `dbdf9c1` — feat(protocol): git.apply for reviewed files (A6) (107 files, +19295/−2683)
- **design commit:** `bde5870` — docs(plan): A6 git.apply design decisions (§3.6)
- **review ran:** every review below ran, and every fix landed, before `dbdf9c1`.

## Scope

This covers the whole A6 addition, built to [§3.6 of the design of record](../plans/2026-10-09-protocol-v1-additions.md). The §3.6 review-outcome items (11) were updated in `dbdf9c1`.

- **Core:**
  - `sandpane-protocol`:
    - new `GitApplyParams {taskId, expectedBase, reviewId, entries}` and `ApplyResult {applied, abortReason?, conflictedFiles, appliedFiles?, modeChanges?, snapshotTree?, partial?}`;
    - `ChangeSet.reviewId?` / `hostHooksPath?`, and `taskBlob?` / `taskMode?` on `FileChange` and `GitDiffResult`;
    - feature `git-apply`, making **5 features**; methods stay at **28**.
  - `sandpane-core`:
    - new `apply.rs`: entry validation against the review, host gates, the quarantined snapshot, the write, verification and the message constants;
    - new `objects.rs`: blob ids with sha1dc collision detection or SHA-256;
    - `git.rs`: `GitDirSession`, `APPLY_PINS`, deadline runners, the quarantine and `classify_apply_check`;
    - `workspace.rs`, `scheduler.rs` and `diff.rs` adjusted;
    - a new dependency, `sha1collisiondetection = "=0.3.4"` (MIT, default features off), plus a test vector with a provenance and MIT notice.
  - `sandpane-service`:
    - new `git_apply.rs`: the handler, the writer lock, direct-mount refusals, durable `git.apply.*` events and restart reconciliation;
    - `sandbox_create` takes the repository writer lock for direct_mount;
    - new tests in `tests/git_apply.rs` and `tests/global_config_pins.rs`.
- **Schemas:** `change-set.schema.json`, `core-capabilities.schema.json`, `task-event.schema.json` and `schemas/README.md`.
- **Clients** (VS Code, desktop, JetBrains):
  - typed wrappers and the 5-feature pins;
  - the 45 s `git.apply` deadline (the desktop proxy uses 43 s);
  - per-file selection over one review;
  - the gesture-only confirmation with flags (a) unseen content, (b) executable files and (c) paths that run automatically;
  - the diff/entry mismatch refusal;
  - honest results for every outcome;
  - single flight;
  - the four `git.apply.*` events rendered for display only.
- **Docs:** design §3.6 and the root and client READMEs.

## Method

1. **Design.** The A6 design went through two `security-reviewer` passes:
   - the first returned BLOCK on C1–C4 and W1–W7;
   - the re-review raised R1–R8;
   - all were folded into §3.6 before `bde5870`.
2. **Core implementation.** The `core-engineer` worked test-first, with mutation runs.
3. **First Core security review.** One `security-reviewer` pass on the Core diff reproduced findings with scratch probes and returned **PASS-WITH-WARNINGS**.
4. **First fix round.** Fixes were made test-first with mutation runs. The orchestrator re-ran the Core gate independently (494 tests).
5. **Security re-verification.** A `security-reviewer` re-verification of W-A, W-B and W-C used fake-git probes. It returned **PASS-WITH-WARNINGS** with two new Warnings.
6. **Second fix round.** Those were fixed test-first. The orchestrator re-ran the Core gate (509 tests) and recorded SHA-256 hashes of the frozen Core files.
7. **Client implementation.** The three client engineers worked in parallel from one shared brief.
   - Core changed under them during the second fix round. The JetBrains engineer detected this from file hashes and adapted.
   - The combined client review covered the final messages.
8. **Combined client review.** One combined `security-reviewer` / phase pass on all three clients returned **BLOCK** on one desktop Critical.
9. **Client fixes.** Each client was fixed test-first, with RED evidence and revert checks.
10. **Final gates.** The orchestrator re-ran every gate fresh on the final tree.

## Findings

**Core review: PASS-WITH-WARNINGS.**

- **W-A:**
  - new-content volume was unbounded before the caps;
  - a refusal could still leave objects in the host `.git/objects`.
- **W-B:** the chain of per-call timeouts could reach about 125 s, against a 45 s client deadline.
- **W-C:** the writer lock did not cover a live `direct_mount` sandbox or task on the same repository.
- **W-D:** A5 `git.review` / `git.diff` on `host_worktree` run git inside the task worktree.
- **Info:**
  - **I1:** the config enumeration soft-failed on stderr.
  - **I2:** reconciliation should key on `startedSequence`.
  - **I3:** a `--check` that could not run was worded as "does not apply".
  - **I4:** splitIndex together with manyFiles gets a misleading label (it still fails closed).
  - **I5:** the W4 pins were tested at repository scope only.
  - **I6:** the test vector had no provenance notice.
  - **I7:** a rename gives an empty patch.

**Core re-verification: PASS-WITH-WARNINGS.** W-B, I1, I2 and I3 were confirmed FIXED; W-A and W-C were PARTIAL.

- **W-N1:** a `direct_mount` `sandbox.create` ignored the writer lock. Its binding row appears only after `sbx create` returns, so a create in flight was invisible to the apply.
- **W-N2:** refusals after `hash-object -w` / `write-tree` left unreferenced loose objects (up to about 64 MiB) while saying "nothing was written".
- **Info:**
  - **I-N1:** the write-phase config probe could leave `git apply` milliseconds before the deadline.
  - **I-N2:** there is no deadline between phases, and the task scan is unfiltered.
  - **I-N3:** a direct-mount binding with a NULL repository was skipped.
  - **I-N4:** old outcome events have no `startedSequence`.
  - **I-N5:** INTERNAL messages embed capped git stderr.
  - **N14:** the stderr condition was a surviving mutation.

**Combined client review: BLOCK.**

- **Desktop D-C1 (Critical):**
  - What happened: `useApplyChanges` used TanStack's default `networkMode: 'online'`. If the webview believed it was offline when the user confirmed, the mutation paused before sending, the UI showed "Applying…", and TanStack sent it later by itself on an `online` event, even after a task switch.
  - Evidence: reproduced against `@tanstack/query-core` 5.104.1 (offline at click: `sent = 0`, `isPaused = true`; after the online event: `sent = 1`).
  - Same issue in older code: the 7 other `useMutation` sites had it too.
- **Desktop:**
  - **W1:** `msg_mount_being_created` was not its own CONFLICT kind.
  - **W2:** single flight and the outcome were lost across a task switch.
  - **I1:** `MSG_WRITE_TOO_LATE` was not keyed.
  - **I2:** a diff record ignored `status`.
  - **I3:** entries are rebuilt from five string fields.
  - **I4:** the mismatch rule did not compare `taskMode`.
  - **I5:** the `sandbox.create` busy texts were not keyed.
- **VS Code:**
  - **V-W1:** Enter could confirm, because the modal cannot make Cancel the default.
  - **V-W2:** the new outcomes were not keyed.
  - **V-W3:** a `sandbox.create` CONFLICT was labelled a task-state conflict.
  - **I1–I4:** unrevealed logging, the status tone, the deadline read from Rust, and `$(` in notifications.
- **JetBrains:**
  - no Warning;
  - **J-I1:** `MSG_WRITE_TOO_LATE` was not keyed;
  - **J-I2:** the mismatch check scans every entry and fails closed;
  - **J-I3:** the first task awaiting review is taken;
  - **J-I4:** the `sandbox.create` busy texts were not keyed.
- **Cross-client:** `core.hooksPath=.` yields no `hostHooksPath`.

**Verified clean by the reviews:**
- no shell anywhere, and only validated arguments;
- durable `git.apply.started` before the write, and the outcome event before the response;
- test seams are `None` in production;
- entries are sent verbatim from one review, and `selectedFiles` is never sent;
- the confirmation opens only from a user gesture;
- a partial is never shown as success, and a timeout reads "may have been applied";
- the desktop proxy keeps `git.apply` out of `is_read_only` and `replay_safe` and forwards the payload byte for byte;
- the JetBrains EDT never waits;
- the drift tests read the Rust sources.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| W-A, W-N2 | fixed pre-commit | 64 MiB cap and a per-entry deadline in `validate_entries`; host gates before any object write; every snapshot-phase git call runs in an object quarantine (`GIT_OBJECT_DIRECTORY` under Core temp, host objects as a C-quoted alternate). The patch alone applies on the host for text, binary literal and delta, mode-only, add and delete. Integration tests assert `.git/objects` is unchanged after every post-snapshot refusal, including a real ~68 MiB too-large patch. Mutations Q1–Q3 went RED. |
| W-B, I-N1 | fixed pre-commit | Per-phase deadline runners: prepare + check 20 s, write 15 s, verify 6 s, 41 s in total. `bounded()` cuts every git spawn. The write probe is capped at 3 s, and `git apply` never starts with less than 5 s left (`MSG_WRITE_TOO_LATE`). A cut-off before `git apply` starts is a non-partial `MSG_WRITE_NOT_RUN`. |
| W-C, W-N1, I-N3 | fixed pre-commit | `refuse_direct_mounts` runs after the lock and right before `git.apply.started` → CONFLICT `msg_mounted`. An unknown mode, an unreadable status or a NULL repository counts as a match. A `direct_mount` `sandbox.create` holds the repository writer lock for the whole create: CONFLICT "…; nothing was created" while an apply holds it, and `msg_mount_being_created` on an apply during a create. |
| W-D | open, recorded A4b precondition | §3.6 item 11. A5 review and diff must stop running git in a `host_worktree` worktree before A4b gives wire tasks Git context. |
| I1, N14 | fixed pre-commit | An exit 1 with stderr is a failure. A unit test with a fake `git` kills the former surviving mutation. |
| I2 | fixed pre-commit | Outcome events carry `startedSequence`; reconciliation closes only matching starts. |
| I3 | fixed pre-commit | `ApplyCheck {Applies, DoesNotApply, CouldNotCheck}`; `MSG_CHECK_UNAVAILABLE` is worded separately. |
| I5, I6 | fixed pre-commit | `global_config_pins.rs` runs under a temporary hostile `HOME` gitconfig. The test vector has a NOTICE with SHA-1 provenance and the upstream MIT license. |
| I-N2 | fixed (cheap part) | A SQL prefilter that only excludes safe values; Rust remains the authority. The gaps between phases (DB mutex, appends) stay without a deadline: a disclosed residual. |
| I4, I7, I-N4, I-N5 | accepted | I4 fails closed. I7 is covered by the "renamed, content unchanged" display. I-N4 affects development databases only. I-N5 predates A6. |
| Root `hooksPath` | accepted | Flag (b) (`100755`) still marks executable hooks. Recorded in §3.6. |
| Crash during prepare | accepted residual | A crash can leave one call's quarantine (≤ ~64 MiB) under Core's `<data>/tmp`, outside the user's repository; there is no startup sweep yet. |
| D-C1 | fixed pre-commit | `createQueryClient()` sets `networkMode: "always"` for every query and mutation, and the apply mutation sets it explicitly. Tests drive `onlineManager.setOnline(false)` and assert the frame is sent at click time and never later; reverting the setting turns all three D-C1 tests RED. |
| Desktop W1, W2, I1, I2, I4, I5 | fixed pre-commit | Own CONFLICT copy for a mount being created. A keyed mutation (`['core','git','apply',taskId]`, `gcTime: Infinity`) with `useIsMutating` / `useMutationState`, so single flight and the last outcome survive a task switch. `MSG_WRITE_TOO_LATE` is keyed. The diff record matches path and status. The mismatch rule compares `taskMode`. The create-busy copy is keyed. |
| Desktop I3 | accepted | The five wire fields are the same JavaScript strings, so the entries are byte-identical. |
| V-W1 | fixed pre-commit | After the modal, a typed `showInputBox` step: only the exact count sends, never pre-filled. More than 50 files opens the full list in a read-only `sandpane-apply:` virtual document, and the modal caps its list at 50; flags are always shown in full. |
| V-W2, V-W3, VS Code I1–I4 | fixed pre-commit | The new outcomes are keyed and drift-tested. Create-busy gets its own copy, with no "Re-read task state" and no "Retry safely". The log goes through `plainText`. Partial and lost answers get the `'error'` tone. `GIT_APPLY_TIMEOUT_MS === CLIENT_APPLY_DEADLINE`. `$(` is broken in notifications. |
| J-I1, J-I4 | fixed pre-commit | Keyed and drift-tested against the final Core. |
| J-I2, J-I3 | accepted | J-I2 fails in the safe direction. For J-I3, the dialogs name the task, the review and the repository. |

## Verification evidence

The orchestrator ran all of the following fresh on `dbdf9c1`'s tree before committing it:

- **Core gate:**
  - `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` were clean.
  - `cargo test`: **509 passed, 0 failed**. That is core lib 214, lifecycle 3, protocol 30, service lib 35, conversation 21, git_apply 54, git_diff 14, global_config_pins 1, project 17, send_mode 7, service_integration 93, task_git_context 19, doctests 1.
  - The schema checks were clean.
- **`make check`** (`make-check-a6.log`): exit 0.
  - Schemas: both method checks report `28 values match`; features report `5 values match`; `All schema/protocol value sets in sync.`
  - VS Code: `Tests 709 passed (709)`.
  - Desktop: `Tests 672 passed | 8 skipped (680)`.
  - Tauri shell: 34 passed.
  - JetBrains: `BUILD SUCCESSFUL`.
- **JetBrains, run alone:**
  - `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` → 39 result files, **445 tests, 0 failures, 0 errors, 0 skipped**.
  - `verifyPlugin --offline --rerun-tasks` → `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`.
- **Live checks** against an isolated Core (`env -i`, a temporary `HOME`, `SANDPANE_SBX_PATH=/nonexistent/sbx`, a short `/tmp` socket and DB, removed afterwards):
  - VS Code: `62/62 checks passed against the live Core service`. That includes `A6: git.apply on a wire-created task aborts with "task has no Git context …; nothing was written"`, answered as `{"abortReason":"task has no Git context (repo binding + base_commit); nothing was written","applied":false,"conflictedFiles":[]}`.
  - Desktop: `Tests 8 passed (8)`.
  - Core stderr: "sbx executable not found". `pgrep` showed no leftover Core process.
- **Hidden characters and secrets:**
  - `invisible-scan`: 0 raw invisible characters in the 106 staged text files (the 640-byte binary test vector is excluded).
  - The secret gate matched only fictional home-directory fixture paths: users named `dev` and `demo` for the Atlas Demo and Nova Demo projects, and a one-letter Linux home stub in a Rust unit test. A follow-up grep of the staged diff found 0 real home paths, usernames or scratch paths.
- **Host git:** 2.56.0.
- **Not run:**
  - anything against a real `sbx`;
  - any client in a real editor, app or IDE: the pickers and checkboxes, the confirmation dialogs (including focus and default buttons), the VS Code typed step and `sandpane-apply:` view, the JetBrains VCS refresh;
  - a real `git.apply` over the wire: no wire-created task has Git context until A4b, and real applies are exercised only by Core integration tests with internally seeded tasks on real temporary repositories;
  - a real-seconds test of the phase budgets;
  - `cargo-audit` / `cargo-deny` (not installed). Instead, the new dependency's licenses were checked by hand from each crate's `Cargo.toml` in the local registry: `sha1collisiondetection` 0.3.4 is `MIT` (and ships a `LICENSE.txt`), and its normal-dependency tree is `generic-array` 1.4.5 `MIT`, `typenum` 1.20.1 `MIT OR Apache-2.0`, and `rustversion` 1.0.23 `MIT OR Apache-2.0`.

**Reviews:**
- Core: PASS-WITH-WARNINGS → fixed → re-verification PASS-WITH-WARNINGS → fixed.
- Clients: BLOCK on D-C1 → fixed, along with every dispatched Warning and Info item.

No Critical remains. W-D is open as the recorded A4b precondition.
