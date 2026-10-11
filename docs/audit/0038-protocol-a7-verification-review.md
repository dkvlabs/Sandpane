# 0038 — Auto-review record: protocol A7, verification commands and `project.context`

- **date:** 2026-10-12
- **implementation commit:** `bd48a10` — feat(protocol): verification commands and project.context (A7) (116 files, +22264/−208)
- **design commit:** `5d29980` — docs(plan): A7 verification and project.context design decisions (§3.7)
- **review ran:** every review below ran, and every fix landed, before `bd48a10`.

## Scope

This covers the whole A7 addition, built to [§3.7 of the design of record](../plans/2026-10-09-protocol-v1-additions.md). Item 14 of §3.7 (implementation decisions and review outcomes) was updated in `bd48a10`.

- **Core:**
  - `sandpane-protocol`:
    - six methods appended after `git.apply`: `verification.list`, `verification.approve`, `verification.revoke`, `verification.run`, `verification.result`, `project.context`, making **34 methods**;
    - feature `verification`, making **6 features**;
    - event kinds `verification.started` and `verification.finished`.
  - `sandpane-core`:
    - new `verification.rs` (approval rules, secret checks, run records) and `context.rs` (`openat`/`O_NOFOLLOW` manifest reads, no tools, redacted notes);
    - `validation.rs` (label and argv rules);
    - `process.rs`: `run_partial` and `run_bounded` rewritten as a single-threaded unreaped-leader runner (`waitid … WNOWAIT`) with no reader threads and no stale group signal;
    - `sbx.rs`: the `exec` builder, `VERIFIED_EXEC_VERSIONS = &[]`, and `command_in` with a Core-owned empty 0700 working directory, also used for `version` and `ls --json`;
    - `db.rs`: migration v8 (`verification_commands`, `verification_runs`);
    - `diff.rs`: `F_DUPFD_CLOEXEC`.
  - `sandpane-service`:
    - new `verification.rs`: handlers, the version and identity gates, async runs (`runId`, `startedSequence`), caps (1 per task, 1 per sandbox, 4 global), the writer lock for `direct_mount` runs, keyed replay, and the response backstop `MAX_RESPONSE_BYTES = MAX_FRAME_BYTES − 64 KiB`;
    - delete refusals while a run is in flight in `project_lifecycle.rs` and `conversation_lifecycle.rs`;
    - new tests in `tests/verification.rs` (37).
- **Schemas:**
  - new `verification.schema.json` and `project-context.schema.json`;
  - updated `rpc-request`, `core-capabilities`, `task-event` and `schemas/README.md`.
- **Clients** (VS Code, desktop, JetBrains):
  - typed wrappers and the 34-method and 6-feature pins;
  - the 45 s deadline for `project.context` and `verification.run` (the desktop proxy uses 43 s);
  - an approve editor with one field per argv element, and a confirmation reachable only from a user gesture;
  - revoke behind a confirmation;
  - `project.context` suggestions that only pre-fill the editor;
  - a run control bound to the task's `sandboxName`;
  - keyed runs with "Retry safely";
  - results shown as escaped plain text;
  - verification events rendered for display only;
  - "a verification is running" refusal copy for stop and delete.
- **Docs:** design §3.7 and the root and client READMEs.

## Method

1. **Design.** Two `security-reviewer` passes, both folded into §3.7 before `5d29980`:
   - the first returned **BLOCK** on C1 (argv and labels stored and replayed unredacted), with W1–W9 and I1–I7;
   - the re-review returned PASS-WITH-WARNINGS (R1–R4, I-a–I-h).
   A cobra/pflag probe showed that `sbx exec -- NAME argv…` never turns an argv element into an `sbx` flag.
2. **Core implementation.** The `core-engineer` worked test-first, with mutation runs.
3. **Core security review.** One `security-reviewer` pass returned **PASS-WITH-WARNINGS** (W1–W3, S1, S2, I2).
4. **Fixes and re-verification.**
   - The fixes were made test-first, and a re-verification also returned PASS-WITH-WARNINGS.
   - Its follow-ups were fixed too: N1 (flaky timing tests), I-a, and I-b (pre-existing, `run_bounded`).
   - The orchestrator re-ran the Core gate (596 tests) and then **froze** 14 wire files with SHA-256 hashes before briefing the clients. This is the lesson from A6, where Core changed under the clients.
5. **Clients.** The three client engineers worked in parallel from one shared brief.
   - The hashes were re-checked after every Core change and before the commit, and never mismatched.
6. **Client security reviews.** Two read-only `security-reviewer` passes, one on desktop and JetBrains and one on VS Code, both returned **PASS-WITH-WARNINGS**.
7. **Client fixes.** Each client was fixed test-first, with RED evidence (failing tests or reverted mutations) for every fix.
8. **Spot checks and gates.** The orchestrator checked each Warning fix in the source, then re-ran every gate fresh on the final tree.

## Findings

**Core review: PASS-WITH-WARNINGS.**

- **W1:** a response could exceed 4 MiB through control-character escapes. Argv also accepted control characters.
- **W2:** `run_partial` could signal a stale process group after the leader was reaped, and could rewrite an `Exited` result as `TimedOut`.
- **W3:** a secret split across argv elements passed the per-element check.
- **S1:** a duplicated fd was not close-on-exec.
- **S2:** `project.context` notes were not redacted.
- **I2:** a note text error.

**Core re-verification: PASS-WITH-WARNINGS.**

- **N1:** the `process::` timing tests were flaky under load (36/40 failures with 4 concurrent copies × 10 rounds). The cause was the first-run cost of a freshly written script on macOS.
- **I-a:** a failed `waitid` must never count as "exited".
- **I-b (pre-existing):** `run_bounded` (git and sbx) could kill the group after the reap.
- **I-c:** an oversized request `id` echoes into its own response.
- **I-d:** `output_incomplete` was added to migration v8 in place before any commit.
- **I-e:** the redactor has pattern gaps (`--api-key=…`, `--password …`).

**Client review 1 (desktop + JetBrains): PASS-WITH-WARNINGS.**

- **J-W1 (JetBrains):** on run success, `tasks.track(…, task)` passed a possibly stale `TaskSummary`. This overwrote the displayed task status (a completed task could show `running` again) and ran off the EDT, racing `onBatch`. This breaks AGENTS.md rule 3 and §3.7 item 5.
- **J-W2 (JetBrains):** the approve, run and revoke confirmations rendered argv, labels, notes and sandbox names through `JEditorPane` text/html. The escaping was complete, but §3.7 item 6 says "plain text, never HTML".
- **JetBrains Info:**
  - J-I1: a held lost-answer claim did not say where to resolve it;
  - J-I2: `project.context` was read on every reconnect;
  - J-I3: default `toString`s carried untrusted text;
  - J-I4: verified that `details` stays out of logs;
  - J-I5: Zs spaces and the ⟨ ⟩ delimiters were unescaped in list rows;
  - J-I6: the UI gate is feature-only, but every call also requires the method to be advertised.
- **Desktop Info:**
  - D-I1: some Core strings (timestamps, the run-id prefix) were rendered unrevealed;
  - D-I2: no warning about an earlier unknown run;
  - D-I3: Revoke… had no `isTrusted` check;
  - D-I4 (both clients): stale suggestion notes stayed after an argv edit;
  - D-I5 (both clients): "Retry safely" was offered indefinitely, although Core keeps keys for 24 h.

**Client review 2 (VS Code): PASS-WITH-WARNINGS.**

- **W1:** an approve refused because the project is archived was worded as a label or argument refusal.
- **W2:** `revoked: false` was shown ok-toned as "already revoked".
- **W3:** the output view's "no links" claim depended on a configuration default that a workspace can override, and the document first opened as plaintext.
- **I1 (cross-client):** `verification.run` answers only after the version gate (3 s) and the identity gate (30 s). The brief's "default deadline" was wrong, so desktop and JetBrains could show "may have started" while Core was still gating. VS Code already used 45 s.
- **Other Info:**
  - I2: INTERNAL "…; nothing was run" was treated as a lost answer;
  - I3: one picker title was unrevealed;
  - I4: the timer refresh re-read `project.context`;
  - I5: matches the A2 retry pattern;
  - I6: no static pin on the wire-wrapper call sites;
  - I7: a re-approval gave no "already approved" note.

**Verified clean by the reviews:**
- no shell anywhere, and only validated arguments;
- every approve, revoke and run confirmation opens only from a user gesture, and VS Code command handlers drop their arguments;
- the run target comes from `TaskSummary.sandboxName`, never `chosenSandboxName`;
- a fresh key per gesture, and single flight;
- a lost answer reads "may have started", never "nothing was run";
- no `dangerouslySetInnerHTML`, `innerHTML`, ConsoleView, terminal or link detector on output;
- exit 0 is never "passed";
- `UNSUPPORTED_SBX_VERSION` is worded as a version gate;
- every disclosure flag is shown;
- the desktop proxy marks only list, result and context as read-only, and none of the six methods is replay-safe;
- client validators are never stricter than Core.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| Design C1 | fixed in design | Approval refuses any secret-like match (per element, joined, JSON); nothing unredacted is stored. |
| Core W1 | fixed pre-commit | Argv refuses control characters other than TAB and LF. `verification.list`, `project.context` and `verification.result` measure their answer against `MAX_FRAME_BYTES − 64 KiB` and return a bounded `VALIDATION_FAILED` with details. |
| Core W2, I-a, I-b | fixed pre-commit | Single-threaded unreaped-leader runner (`waitid … WNOWAIT`) for `run_partial` and `run_bounded`. Group signals are sent only while the leader is unreaped, there is no post-reap kill, and `Exited` is kept together with `outputIncomplete`. A failed `waitid` kills the child first. |
| Core W3 | fixed pre-commit | Joined-argv and JSON-argv secret checks, plus a re-check at run start. |
| Core S1, S2, I2 | fixed pre-commit | Close-on-exec duplicate; notes are redacted, or withheld when the redactor is unavailable; text fix. |
| Core N1 | fixed pre-commit | Warm-up plus readiness markers: 0/40 failures (was 36/40), and 0 in 16 runs under a CPU hog on every core. |
| Core I-c, I-e | accepted | I-c is pre-existing and self-inflicted. I-e: the redactor is best-effort, documented, and outside A7 scope. |
| Core I-d | accepted | Development databases from an uncommitted A7 build must be recreated. No released database has v8. |
| Three surviving mutants | accepted | They need a pipe read error or a `waitid` error on Core's own child, which no test can cause. `drain` error recording is unit-tested. |
| J-W1 | fixed pre-commit | `VerificationRuns.followAfterStart` calls `track(id, conversationId, null)` inside `onEdt`. Test: a stale "running" summary never changes a monitor view that is completed at sequence 12. RED before the fix and under the io-pool mutation. |
| J-W2 | fixed pre-commit | `VerificationText` returns plain lines, shown in a non-editable `JTextArea` with `html.disable` and re-revealed. `noA7DialogRendersHtml` pins that no A7 file uses text/html, `JEditorPane` or `DialogHtml`. Orchestrator grep: none. |
| Run deadline (cross-client) | fixed pre-commit | Desktop proxy 43 s and webview 45 s, JetBrains 45 s floor, VS Code 45 s. All are drift-pinned against `RunLimits::PROBE` + `QUERY` read from `process.rs`, and against the gate order in `verification.rs`. |
| VS Code W1 | fixed pre-commit | Archived-project and archived-conversation copy for approve, run and revoke, drift-tested against `MSG_PROJECT_ARCHIVED` / `MSG_CONVERSATION_ARCHIVED`. |
| VS Code W2 | fixed pre-commit | Only `revoked === true` counts as revoked. Anything else is error-toned "may not have been revoked", and the list is re-read. |
| VS Code W3 | fixed pre-commit | The language has its own `.sandpane-verification` extension, so the document opens directly in it. The header claims "not linked" only while the language-scoped `editor.links` is exactly `false`; otherwise it says links are enabled by a setting and untrusted. The README discloses the workspace override. |
| D-I5 (all clients) | fixed pre-commit | "Retry safely" is offered only within 23 h of a key's first send, drift-pinned to Core `RETENTION_SECS`, and re-checked at click time. After that, "Too late to retry safely — the earlier run may have started …". VS Code applies the same window to the A2 `sandbox.create` / `conversation.send` retries. |
| D-I1–D-I4, J-I1–J-I3, J-I5, VS Code I2–I4, I6, I7 | fixed pre-commit | As listed in §3.7 item 14 ("Client review outcome"). |
| J-I4, J-I6, VS Code I5 | no change | J-I4 and J-I6 are verified safe. I5 matches the A2 pattern: Core's one-run-per-task cap prevents concurrent double runs, and a second run needs a full confirmation. |
| Live linking by other extensions (VS Code) | accepted residual | Another extension's link provider could still detect links in the output document. Disclosed in the README. |
| Real runs | open, by design | `VERIFIED_EXEC_VERSIONS` is empty, so every real `sbx` gets `UNSUPPORTED_SBX_VERSION` until the user captures C-1, C-2, C-5 and C-7 (§3.7 items 11–12). No wire-created task has a sandbox binding until A4b. |
| W-D | still open | The A6 A4b precondition is unchanged by A7 (§3.7 I7). |

## Verification evidence

The orchestrator ran all of the following fresh before committing `bd48a10`. After the gates, only two docs-only edits were made: the root README status counts and §3.7 item 14. Neither is read by any test or gate.

- **Frozen wire:** `shasum -a 256 -c a7-wire-freeze.sha` gave OK for all 14 frozen files after every Core follow-up and again before the commit.
- **Core gate:**
  - `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` were clean.
  - `cargo test`: **596 passed, 0 failed**. That is core lib 263, lifecycle 3, protocol 31, service lib 35, conversation 21, git_apply 54, git_diff 14, global_config_pins 1, project 17, send_mode 7, service_integration 93, task_git_context 19, verification 37, doctests 1.
- **`make check`** (`make-check-a7-final.log`): exit 0.
  - Schemas: `methods (rpc-request.method): 34 values match`, `advertised methods … 34 values match`, `features … 6 values match`, `All schema/protocol value sets in sync.`
  - VS Code: `Tests 810 passed (810)`.
  - Desktop: `Tests 736 passed | 9 skipped (745)`.
  - Tauri shell: 36 passed.
  - `make check: OK (core + schemas + vscode + desktop + jetbrains)`.
- **JetBrains, run alone:**
  - `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` → `BUILD SUCCESSFUL`; JUnit XML: **483 tests, 0 failures, 0 errors, 0 skipped**.
  - `verifyPlugin --offline --rerun-tasks` → `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`.
- **Live checks** against an isolated Core (`env -i`, a temporary `HOME`, `SANDPANE_SBX_PATH=/nonexistent/sbx`, a short `/tmp` socket and DB, removed afterwards):
  - VS Code: `66/66 checks passed against the live Core service`. That includes:
    - `A7: Core advertises the six verification methods after git.apply, and the feature "verification"`;
    - `verification.list of a fresh project answers {commands: []}`;
    - an approve with a runtime-built secret-like argument answers `VALIDATION_FAILED … argument 2 looks like a secret (token) …; nothing was approved` with Core's hint;
    - the list stays empty afterwards.
  - Desktop: `Tests 9 passed (9)`, including the A7 live test.
  - `pgrep` showed no leftover Core process. One leftover from an earlier run, caused by a kill pattern that did not match, was identified by its socket environment and stopped. The final runs used the exact PID.
- **Hidden characters and secrets:**
  - `invisible-scan`: 0 raw invisible characters in the 116 staged files.
  - The secret gate matched only the fictional `/Users/demo` fixture user (8 lines in JetBrains tests), and no token-shaped value. A follow-up grep of the staged diff found 0 occurrences of the real username.
- **Spot checks by the orchestrator:**
  - no `text/html`, `DialogHtml`, `JEditorPane` or `HTMLEditorKit` in the JetBrains A7 UI;
  - `track(task.id, task.conversationId, null)`;
  - VS Code `revoked === true` and its "Core did not confirm" branch;
  - `.sandpane-verification` and the conditional link header.
- **Toolchain:** rustc 1.99.0, git 2.56.0, node v24.5.0.
- **Not run:**
  - anything against a real `sbx`;
  - captures C-1–C-7;
  - any client in a real editor, app or IDE: the panels, editors, confirmations (focus and default buttons), pickers, the output views, and `isTrusted` in WKWebView;
  - a real `verification.run` over the wire: it is version-gated, and no task is bound until A4b;
  - `cargo-audit` / `cargo-deny` (not installed). A7 adds no dependency.

**Reviews:**
- Design: BLOCK → fixed → PASS-WITH-WARNINGS.
- Core: PASS-WITH-WARNINGS → fixed → PASS-WITH-WARNINGS → fixed.
- Clients: two PASS-WITH-WARNINGS passes → every Warning and dispatched Info fixed.

No Critical remains. W-D and the A7 capture gate (I-h) remain open as recorded A4b preconditions.
