# 0033 — Auto-review record: protocol A3a, project lifecycle

- **date:** 2026-10-11
- **implementation commit:** `9069f6a` — feat(protocol): project lifecycle (A3a) (77 files, +11004/−311)
- **review ran:** before the commit, on the same working-tree diff, per `audit/README.md`

## Scope

The whole A3a addition. The design decisions in [§3.2 of the design of record](../plans/2026-10-09-protocol-v1-additions.md) were written before any code.

- **Core:**
  - `sandpane-protocol`: six methods, so `Method::ALL` grows to 22; `includeArchived`; `Project.archivedAt`.
  - `sandpane-core`: `Validator::project_name` and a stricter `project_description`.
  - `sandpane-service`: new `project_lifecycle.rs`; `ProjectCreates` in-flight counter; `ConfirmationStore::consume_by_id`; bindings record `repo_id`; the post-claim re-check `recheck_create_target`; the test seam `CoreConfig.test_after_create_claim`.
  - Tests: new `tests/project_lifecycle.rs` and additions to `service_integration.rs`.
- **Schemas:** `rpc-request.schema.json` and `schemas/README.md`.
- **Clients:** VS Code, JetBrains and desktop.
- **Docs:** design §3.2, `docs/specs/02`, the plan, `docs/compatibility.md`, and the root and client READMEs.

## Method

Same order as entry 0032.

1. Core and the schema came first, then one `security-reviewer` pass on the Core diff. That pass returned **BLOCK**; its fixes landed and the Core gate was re-run before any client work.
2. Core behaviour was frozen. All three clients were briefed from one shared document: the frozen semantics, the exact Core messages, the error-code invariants, and the checklist of defect classes from earlier reviews.
3. One combined `security-reviewer` pass covered all three clients. It also did the phase-review checks: README claims, fixture labels, drift pins and test quality.
4. Its Warnings and the actionable Info items were fixed test-first, then re-gated.
5. All gates were re-run fresh by the orchestrator.

## Findings

**Core review: BLOCK.**

- **C1 (Critical):** `sandbox.create` could deadlock Core.
  - **Cause:** the DB guard from `inner.lock_db()` sat in an `if let` scrutinee (edition 2021), so it lived through the then-block. Inside it, `PendingClaim::release()` re-locked the same non-reentrant mutex.
  - **Trigger:** a race in which `project.archive` or `project.delete` lands between the archived check and the post-claim re-check of a keyed create.
  - **Effect:** the single per-user Core would hang for every client.
  - **Evidence:** reproduced as a scratch program, not end-to-end.
- **W1:** `project.remove_repository` could leave `sandbox.create`'s mount check stale, and could unregister a repository that a live `direct_mount` sandbox mounts, because bindings never recorded `repo_id`. Once unregistered, that repository leaves the excludes-file forbidden roots: the entry-0028 threat.
- **W2:** the pinned client method lists were red repo-wide until the client step (Code Review rule 8).
- **Info:**
  - **I1:** names and descriptions accepted `\n`, C1, U+2028/2029 and bidi controls, and the name is interpolated into impact line 0.
  - **I2:** `remove_repository` could match the wrong repository in a symlink case, and accepted relative paths.
  - **I3:** the replay asymmetry after delete.
  - **I4:** non-object `project.list` params.
  - **I5:** the archived bypasses (`git.apply` needs a P4 decision).
  - **I6:** filesystem stats under the DB mutex.
  - **I7:** worktrees and branches left orphaned after delete.
  - **I8:** the same repository registered in two projects.
  - **I9:** the desktop proxy forwards all parseable methods.
  - **I10:** no new dependencies.

**Combined client review: PASS-WITH-WARNINGS, no Critical.**

- **W1 (VS Code):** after an unknown step-2 outcome, a re-read that still listed the project produced "it was not deleted". This holds only because Core serves each connection in order; a future reconnect-and-wait would make it false.
- **W2 (VS Code, desktop):** the `project.add_repository` deadline was shorter than Core's 30 s git bound: 15 s in VS Code, a 12 s proxy in desktop. `project.create` had the same gap, which predates A3a.
- **W3 (desktop):** "Add repository" takes a typed absolute path, not a native folder picker as design §3.2 item 9 asks.
- **Info:**
  - **Desktop:** an unknown step 2 that did delete leaves a stale `lastProjectId`; lone surrogates were not refused locally.
  - **JetBrains:**
    - an unparseable expiry failed open (as in A1);
    - the step-2 frame was written on the EDT;
    - impact lines and chooser rows had no length cap;
    - no deleted-listener fired after an unknown outcome that did delete;
    - the token rejection is matched by prefix (A1 precedent, drift-tested);
    - the " [archived]" suffix can be imitated by a live name.
  - **VS Code:**
    - Cancel cannot be made the default in the modal (disclosed, same as A1);
    - the rename box is prefilled with the raw name;
    - selection was not cleared on step-2 NOT_FOUND.
  - **Desktop and JetBrains:** deleting an archived project requires "Show archived" first.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| C1 | fixed pre-commit | The re-check result is bound to a local first, so the guard drops before `release()`. The test seam `test_after_create_claim` (`#[doc(hidden)]`, never set in production) drives real archive, delete and remove-repository calls into the window. With the old `if let` restored, all three re-check tests hang ("Core did not answer within 10s: deadlocked"). A mechanical audit of every lock-in-scrutinee and named-guard re-lock found one more benign site (`discard_task_worktree`), which was also rebound. |
| W1 (Core) | fixed pre-commit | (a) `create_and_bind` writes `sandbox_bindings.repo_id`. (b) `recheck_create_target` re-confirms under the DB mutex that the project is live and the mounted repository is still registered; otherwise new CONFLICT "the repository was unregistered from this project while the sandbox was being prepared; nothing was run". (c) `remove_repository` refuses while a task or live binding uses the repository, or a pre-A3a mounting binding has a NULL `repo_id`, or a create is in flight. **Deviation:** audit rows of *removed* sandboxes get `repo_id = NULL` in the same transaction, so a stale FK cannot block removal forever. Covered by seven mutation checks. |
| W2 (Core) | fixed pre-commit | Every pinned list in all three clients moved to 22 in the same commit; the whole-repo gate is green. |
| I1, I2, I3, I6 | fixed pre-commit | `Validator::project_name` (≤120; refuses all Cc incl. `\n` `\t`, C1, U+2028/2029, U+200E/200F, U+061C, U+202A–202E, U+2066–2069) and the same refusals in `project_description` (`\n` allowed). `remove_repository` requires an absolute path and prefers the exact stored match. The asymmetry is documented in code and design. Filesystem stats now run after the mutex is released. |
| I4, I5, I7, I8, I9, I10 | accepted | Disclosed / correct by design / impact line says so / scheduler locks protect tasks / same as `sandbox.remove` / nothing to do. The `git.apply` archived gate is a recorded P4 decision. |
| W1 (VS Code) | fixed pre-commit | `settleDeleteFromCore(project, coreFinished)`. "…it was not deleted (Core answered the delete request…)" only for a Core-answered error. Otherwise: "Core still lists the project as of this re-read. Core never answered the delete request, so it may still finish — re-read before acting; not retried." A failed re-read now says the outcome is UNKNOWN. |
| W2 (VS Code, desktop) | fixed pre-commit | VS Code `PROJECT_GIT_TIMEOUT_MS = 45_000` for `project.add_repository` and `project.create`; a drift test reads the 30 s `RunLimits::QUERY` from Core. Desktop proxy 43 000 ms / webview 45 000 ms for both, pinned on both sides. **Residual:** a `project.create` with several slow repositories can still exceed 45 s; that is reported as UNKNOWN, never as a failure. |
| W3 (desktop) | accepted deviation | Only the user's own typing reaches the call, it must be absolute, and Core validates the git root and denylist; no path can come from Core or an agent. Recorded in the desktop README as "Not implemented — accepted deviation"; `@tauri-apps/plugin-dialog` is a follow-up. |
| Desktop Info (stale id, surrogates) | fixed pre-commit | `ProjectDeletionFlow` re-reads `{includeArchived:true}` after an unknown step 2 and forgets the project locally only if Core no longer lists it (copy: "Core no longer lists this project", never "deleted by this request"). A step-2 NOT_FOUND also forgets it. Validators refuse unpaired surrogates. |
| JetBrains Info (expiry, EDT, caps, listener) | fixed pre-commit | Applied to both A1 and A3a. An unreadable expiry fails closed. Step 2 is built and sent on the io pool; if it cannot be scheduled, nothing is sent. `DisplayCap` caps every Core string at 200 code points without splitting a surrogate pair. Pure `ProjectDeleteFollowUp`: forget on `deleted:true` or a Core-raised NOT_FOUND; forget after an unknown outcome only when an archived-inclusive re-read no longer lists the project. |
| VS Code Info (NOT_FOUND selection) | fixed pre-commit | A step-2 `NOT_FOUND: project not found` forgets the project like `deleted:true`. |
| Remaining Info | accepted | Disclosed (Cancel default, A1 precedent), drift-tested prefix, label spoof only works toward "looks archived", raw prefill is the user's own edit box. |

## Verification evidence

All run fresh by the orchestrator after the last edit, before `9069f6a`:

- **`make check`** (log `make-check-a3a-final.log`):
  - Core: fmt, clippy and tests 142 + 3 + 23 + 31 + 17 + 89 + 19 = **324 passed, 0 failed**.
  - Schemas: `22 values match` for both method checks; `All schema/protocol value sets in sync.`
  - VS Code: `Tests 454 passed (454)`.
  - Desktop: `Tests 484 passed | 8 skipped (492)`; Tauri shell `32 passed; 0 failed`.
  - The run then exited 2 at JetBrains `:test` with `NoSuchFileException … in-progress-results-generic.bin`. The JetBrains fix agent was running Gradle on the same build directory at the same time. Re-run alone below.
- **JetBrains**, run alone after the agent finished:
  - `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` → `BUILD SUCCESSFUL`, **311 tests, 0 failures, 0 errors, 0 skipped** (32 files).
  - `verifyPlugin --offline --rerun-tasks` → `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`.
- **Live checks** against an isolated Core (`env -i`, `SANDPANE_SBX_PATH=/nonexistent/sbx`, PATH without sbx):
  - VS Code: **59/59 checks passed**.
  - Desktop: `Tests 8 passed (8)`, using a temp socket and DB that were removed afterwards.
  - Core stderr: "sbx executable not found". `pgrep` showed no sbx or Core process left.
- **Core-specific evidence** from the implementing engineer's runs, re-confirmed by the gate above:
  - the C1 tests hang with the old form;
  - seven W1/I2 mutants each fail a test;
  - validator and service tests were compile-RED first.
- **Client fix evidence:** each fix was written test-first, and the mutants failed:
  - VS Code: 2 mutants;
  - desktop: 3 mutants;
  - JetBrains: new tests in `ProjectLifecycleTest` (39), `SandboxLifecycleTest` (27) and `RemoveConfirmationDialogTest` (6).
- **Hidden characters and secrets:** a scan of all 76 changed and untracked files found 0 raw invisible characters. The secret/path gate on the staged diff was clean (77 files).
- **Not run:**
  - anything against a real `sbx`;
  - any client inside a real editor, app or IDE (dialogs, pickers, the desktop `ChatPanel` disabled state);
  - the real race timing of C1 (covered deterministically through the hook);
  - the 30 s git figure on a slow filesystem;
  - `cargo-audit` / `cargo-deny` (not installed; no new dependencies);
  - desktop `npm run build`.
- Desktop FakeCore A3a behaviour is labelled MODELED, not captured.

**Reviews: `security-reviewer` on Core (BLOCK → C1 and W1 fixed) and a combined `security-reviewer`/phase pass on the three clients (PASS-WITH-WARNINGS). No Critical remains; W1 and W2 fixed pre-commit; W3 is an accepted, disclosed deviation.**
