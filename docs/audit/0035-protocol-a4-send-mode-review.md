# 0035 — Auto-review record: protocol A4, `conversation.send` mode

- **date:** 2026-10-11
- **implementation commit:** `d6b17dd` — feat(protocol): conversation.send mode — Task / Discuss (A4) (53 files, +4016/−120)
- **review ran:** before the commit, on the same working-tree diff, per `audit/README.md`

## Scope

This covers the whole A4 addition. The design decisions in [§3.4 of the design of record](../plans/2026-10-09-protocol-v1-additions.md) were committed before any code (`a8b0305`). A review amendment then landed in this commit: the `chosenSandboxName` split and the v7 column rename.

- **Core:**
  - `sandpane-protocol`:
    - `ConversationSendParams.mode?` and `TaskSummary.mode?` (open strings);
    - `TaskSummary.chosenSandboxName?`;
    - feature `conversation-send-mode` (4 features);
    - no new method, so 27.
  - `sandpane-core`: migration v7 adds `tasks.mode`, `tasks.chosen_sandbox_name` and an index on the latter, with a `.pre-v7.bak` backup; a v8 database is refused.
  - `sandpane-service`:
    - `normalize_send_params` runs before `keyed_call`;
    - `SendMode` and `create_task_with_mode` (`create_task` is unchanged and wraps it);
    - the discuss workspace guard;
    - the mode in `task.created`, `scheduler.deferred` and `adapter.unavailable`;
    - the `sandbox.remove` step-1 impact line;
    - new `tests/send_mode.rs`.
- **Schemas:** `core-capabilities.schema.json` and `schemas/README.md` (prose and feature examples; no enum).
- **Clients:** VS Code, desktop and JetBrains.
- **Docs:** design §3.4 amendments (items 1, 3 and 5), the root README and the client READMEs.

## Method

1. Core and schema were reviewed by one `security-reviewer` pass on the Core diff, which returned **BLOCK**. The fix was a design amendment made first in §3.4, then implemented test-first with RED evidence and nine mutations. The orchestrator re-ran the Core gate.
2. Core was frozen and the three clients were briefed from one shared document (`a4-client-brief.md`). One cross-client safeguard, found by the desktop agent, was relayed to VS Code: never retry a Discuss send against a Core that no longer advertises the feature.
3. One combined `security-reviewer` pass covered all three clients, with phase-review checks (README claims, drift pins, test doubles).
4. Its Warnings and actionable Info items were fixed test-first in each client and re-gated.
5. The orchestrator re-ran every gate fresh.

## Findings

**Core review: BLOCK.**

- **C1 (Critical, rule 8 with rule 5):** A4 filled `TaskSummary.sandboxName` with the chat's chosen sandbox name. The desktop `taskIsolationView` (`apps/desktop/src/lib/reducers.ts`) reads that field as the sandbox a task runs in. For a task with no sandbox at all, it would have shown a `verified: true` isolation label naming that sandbox.
- **C2 (Critical, same rules):** the VS Code (`session.ts`) and desktop (`sandbox-lifecycle.ts`) stop dialogs count tasks by `sandboxName`. They would have warned "N active task(s) … run in this sandbox; stopping it ends them". That is false, and Core's own remove impact line says the opposite.
- **Info:**
  - **I1:** if the task-count query failed, step 1 of `sandbox.remove` returned INTERNAL.
  - **I2:** `tasks.sandbox_name` had no index.
  - **I3:** `COALESCE(chosen, binding)` in `task.list` would hide a future binding.
  - **I4:** the doc for a non-string `mode` was inaccurate.
  - **I5:** a doc comment was misplaced.
  - **I6:** the schema prose overstated where `sandboxName` appears.
  - **I7:** no test covered the fail-closed count or the cross-project count.
  - **I8:** the orchestrator's design edit happened during the review.
- **Verified OK:** both pre-A4 fingerprints were recomputed independently with `shasum`. The discuss guard runs before any Git side effect. Migration v7 runs in one transaction. Locks and SQL parameterization are correct, and the event payloads are honest.

**Combined client review: PASS-WITH-WARNINGS, no Critical.**

- **W1 (desktop):** a new Discuss send trusted a cached probe up to 30 s old. A Core restarted into a pre-A4 build would drop `mode` and record a task, with nothing said.
- **W2 (desktop):** the copy for `MSG_SEND_MODE_INVALID` said "Nothing was sent", but the frame was sent.
- **W3 (JetBrains):** in a reconnect race, `effectiveChoice` could send a Task while the combo still showed Discuss.
- **Info:**
  - **I1 (VS Code):** a reconnect could land between the Discuss re-probe and the send.
  - **I2 (VS Code):** inferred "disagree about the protocol" copy.
  - **I3 (JetBrains):** generic decode errors could echo a capped snippet of a row.
  - **I4:** test gaps: the non-string `mode`, the "could not be read" impact variant, a try/catch that never asserted, and a fake Core that refused modes it would ignore.
  - **I5 (VS Code):** `validateSendMode(null)` threw, but Core treats `null` as absent.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| C1, C2 | fixed pre-commit (design amended first) | The field is split. The new additive `TaskSummary.chosenSandboxName?` is stored in `tasks.chosen_sandbox_name` (v7 renamed before any commit). `sandboxName` is back to its pre-A4 value: send leaves it absent, and `task.list` reads only the binding. Test `a_chat_chosen_sandbox_never_fills_sandbox_name` failed RED with `"sandboxName":"atlas-auth"` in the send response. Every client also has a test proving `chosenSandboxName` never feeds isolation labels, stop or remove counts, or binding logic: the desktop's two exclusion tests were proved by mutation; VS Code's stop-count test was mutation-proven; JetBrains has a source-scan allowlist. |
| I1–I7 (Core) | fixed pre-commit | I1: an unreadable count pushes "the number of unfinished tasks sent from chats that chose this sandbox name could not be read; removing it does not cancel them" and continues. I2: index added in v7. I3: COALESCE removed. I4, I5, I6: docs and schema prose corrected. I7: fail-closed and cross-project tests added. Mutations F1–F8 were each killed. |
| I8 | accepted | The orchestrator's own design amendment, recorded here. |
| W1 (desktop) | fixed pre-commit | `submitWithDiscussPrecheck` makes a fresh `system.probe` before every new Discuss send. If the feature is not advertised, or Core cannot be checked, nothing is sent (never downgraded). `discussModeNotRecorded` warns if the answer lacks `mode === "discuss"`. |
| W2 (desktop) | fixed pre-commit | The copy is now "Core did not accept the message — it refused the send mode". |
| W3 (JetBrains) | fixed pre-commit | `SendModes.composerSend` takes the selected choice as-is and refuses visibly when the live capabilities lack the feature. The composer text is kept. `effectiveChoice` is now display-only. |
| I1, I2, I4, I5 (VS Code) | fixed pre-commit | `coreHasFeature` is re-checked right before `deliverSend`. The copy is softened to "may mean … different versions". A non-string value shows "(unreadable value from Core — not shown)". `ScriptedCore` ignores `mode` when the feature is not advertised. `null` is treated as absent. |
| I3 (JetBrains) | fixed pre-commit | `ErrorAttribution` maps `SerializationException` and `IllegalArgumentException` to fixed text. `task.list` decodes through `decodeOrFixed`. |
| I4 (desktop) | fixed pre-commit | The test now asserts the throw with `toThrow`. A drift-tested "could not be read" variant test was added. |
| Cross-client: Discuss retry after feature loss | fixed pre-commit | All three clients withhold a Discuss retry when the re-probed Core no longer advertises send modes. A retry that is sent has byte-identical params. |

## Verification evidence

The orchestrator ran all of the following fresh after the last edit, before `d6b17dd`:

- **`make check`** (log `make-check-a4.log`): exit 0.
  - Core: 160 + 3 + 27 + 32 + 21 + 17 + 7 + 93 + 19 = **379 passed**.
  - Schemas: `27 values match` for both method checks; `features … 4 values match`; `All schema/protocol value sets in sync.`
  - VS Code: `Tests 592 passed (592)`.
  - Desktop: `Tests 583 passed | 8 skipped (591)`. Tauri shell: `32 passed`.
  - JetBrains: `BUILD SUCCESSFUL` (up to date).
- **JetBrains, run alone:**
  - `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` → **389 tests, 0 failures, 0 errors, 0 skipped**.
  - `verifyPlugin --offline --rerun-tasks` → `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`.
- **Live checks** against an isolated Core (`env -i`, `SANDPANE_SBX_PATH=/nonexistent/sbx`):
  - VS Code: 60/60 PASS. Desktop: `Tests 8 passed (8)`, using a temporary socket and DB, removed afterwards.
  - Core stderr said "sbx executable not found". `pgrep` showed no sbx or Core process left.
  - These checks cover the advertisement (including `conversation-send-mode`), not a Discuss send.
- **Implementing-agent evidence** (re-confirmed by the gates above):
  - Core RED for every fix.
  - Mutations M1–M11 (original A4) and F1–F8 (review fixes), all killed.
  - A stale-binary mutation-runner bug was found and fixed by touching files after restore. Every mutation was re-run.
  - Lock scan: 0 hits in 172 + 163 scrutinees.
  - Client RED logs: VS Code 16 + 5; desktop 2 + 5 plus one mutation; JetBrains 2 + 9 + 2.
- **Hidden characters and secrets:** a scan of all 53 changed and untracked files found 0 raw invisible characters. The secret gate on the staged diff was clean.
- **Not run:**
  - anything against a real `sbx`;
  - any client in a real editor, app or IDE (the composer choice, the disabled states, the JetBrains reconnect race in Swing, the desktop `ChatPanel` wiring);
  - a Discuss send through the live scripts;
  - `cargo-audit` / `cargo-deny` (not installed; no new dependencies).
- Desktop FakeCore A4 behaviour is labelled MODELED.

**Reviews:**
- `security-reviewer` on Core: BLOCK. C1 and C2 were fixed via the §3.4 amendment, and I1–I7 fixed.
- Combined `security-reviewer`/phase pass on the three clients: PASS-WITH-WARNINGS. W1–W3 and the actionable Info items were fixed.

No Critical remains.
