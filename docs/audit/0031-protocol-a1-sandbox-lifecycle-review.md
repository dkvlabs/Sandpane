# 0031 — Auto-review record: protocol A1, sandbox stop / confirmed remove / create agent

- **date:** 2026-10-10
- **implementation commit:** `b1067c7` — feat(protocol): sandbox.stop, confirmed sandbox.remove, create agent (A1) (71 files, +9250/−320)
- **review ran:** before the commit, on the same working-tree diff, per `audit/README.md`

## Scope

The whole A1 addition from [the protocol design of record](../plans/2026-10-09-protocol-v1-additions.md) §2–§4:

- **Core:** `sandpane-protocol`, `sandpane-core` (`db`, `sbx`, `validation`), `sandpane-service` (`lib.rs`, the new `confirm.rs` and `inflight.rs`, the integration tests).
- **Schemas:** `rpc-request`, `sandbox-create-spec`, schemas README.
- **Clients:** VS Code (`clients/vscode`), JetBrains (`clients/jetbrains`), desktop (`apps/desktop`, webview and Tauri shell).
- **Docs:** design doc §2/§3, `docs/specs/02`, `docs/compatibility.md`, the spec-completion plan, root and client READMEs.

All untracked new files were included. Nothing was skipped.

## Method

Four read-only review agents, plus re-runs of every gate by the orchestrator:

1. `security-reviewer` on the Core and schema diff (before the clients existed).
2. `security-reviewer` on the VS Code and desktop diffs.
3. `security-reviewer` on the JetBrains diff, including a jshell probe of kotlinx-serialization decode errors against the plugin's compiled classes.
4. `phase-reviewer` on the whole working tree: design §1 rule-4 pinned lists, §4 client obligations, rule 5 honesty, docs consistency, test quality.

Every finding below was fixed by the implementing engineer and then re-gated. The orchestrator re-ran all gates fresh after the last edit (see Verification evidence).

## Findings

No Critical findings in any of the four reviews.

**Core security review (1):**

- **C-W1** (Warning) `lib.rs` `external`/impact were keyed by sandbox name. A foreign same-named sandbox that replaced a Sandpane one removed outside Core would lose the "not created by Sandpane" warning.
- **C-W2** (Warning) The `removed_at` UPDATE was name-keyed and unserialized. A concurrent same-name `sandbox.create` during the post-`rm` re-query could have its new binding marked removed.
- **C-W3** (Warning, honesty) The `RemovalConfirmation` docs said the token proved user consent. Any same-user process can run both steps.
- **C-I4** The accepted sbx id allowed `\n`, which is interpolated into impact line 1 (a forged dialog line).
- **C-I5** `SandboxSummary.agent` was relayed unvalidated from `sbx ls`.
- **C-I6** The design doc disagreed with the code: step 2 `requeried`, and stop `requeried` optional.
- **C-I7** Stop/remove don't consider active tasks bound to the sandbox (moot today).
- **C-I1, C-I2, C-I3, C-I8**, accepted:
  - eviction "DoS" needs the same access as removal itself;
  - HashMap token lookup over a same-user socket;
  - the residual out-of-band race between id re-check and `rm` (sbx v0.47 has no remove-by-id);
  - `user_confirmed` is `pub` by convention.

**VS Code and desktop security review (2):**

- **VD-W1** VS Code sent step 2 for an expired or unparseable `expiresAt`. Core refuses it, but the client promise was "expiry never sends".
- **VD-W2** Desktop Stop was a single click with no confirmation (specs/05 requires confirmations).
- **VD-W3** (honesty) Desktop CONFLICT copy named only one of Core's two causes and dropped Core's message.
- **VD-W4** Desktop Core/sbx error text on the new surfaces was not revealed (bidi, U+2028, newlines).
- **VD-I1** VS Code's `not JSON` log echoed V8's input snippet, so part of a token could leak into the output channel. The code predates A1.
- **VD-I2 to VD-I8**, accepted or noted:
  - the `reportError` truncation loses diagnostics over 2000 code points;
  - the two clients' escape sets differ slightly;
  - desktop step-1 timeouts read "may have been applied";
  - clock skew fails closed;
  - a stale comment (fixed);
  - the agent gate reads the cached probe;
  - desktop agent validation lives only in the wizard (Core re-validates).

**JetBrains security review (3):**

- **J-W1** After `sbx rm` ran, a failed re-query passed `f.code` through, possibly VALIDATION_FAILED. The plugin then said "Core ran nothing / not removed", and a test pinned that false claim.
- **J-W2** A short malformed step-1 answer made kotlinx decode errors echo `JSON input: {"token":…}` into a notification. This was reproduced with jshell.
- **J-W3** Head-of-line blocking: Core serves a connection serially. A stop/remove of up to about 6 min delays other calls on the plugin's shared socket, including `task.cancel`. No fake success: late answers are uncorrelated.
- **J-I1** `SandboxRemoveParams.toString` printed `confirmToken`.
- **J-I2** The deadline KDoc misstated Core's bound.
- **J-I3** CONFLICT copy named one cause.
- **J-I5** "List not read yet" was shown even after a failed refresh.
- **J-I4, J-I6, J-I7, J-I8**, accepted:
  - chooser rows can look like fake rows, but the name is validated before send and the dialog shows Core's target;
  - "nothing was sent" wording on a step-1 socket drop is harmless;
  - `DialogUi` has no IDE test;
  - a reconnect to another Core makes the token fail closed.

**Phase review (4):**

- **P-W1** (honesty) All three clients said an `external` sandbox "was created outside Sandpane". After C-W1, `external` also covers bindings with no recorded sbx id and bindings for an earlier sandbox.
- **P-W2** (honesty) Core never fills `task.sandboxName` (`tasks.sandbox_binding_id` is never written). So the new Stop active-task count (VS Code, then desktop) always read 0 ("no active task"), and the VS Code README raised specs/03 §6 scenario 6 to PARTIAL on it.
- **P-W3** VS Code and desktop validated stop/remove names with the strict create rule. External sandboxes such as `Atlas.Demo`, which Core and sbx accept, could not be stopped or removed, and this was not disclosed.
- **P-W4** "Whole-repo gate not met: VS Code live check not run, and it would start the real sbx." **Incorrect as stated.** The orchestrator ran it, and the desktop live tests, with `SANDPANE_SBX_PATH=/nonexistent/sbx` and a PATH without `sbx`. Core logged "sbx executable not found".
- **P-W5** The desktop README was stale (14 methods, no stop/remove, no budgets, no UNVERIFIED disclosure).
- **P-I1** The legacy impact line said "predates sbx id tracking" even for post-A1 rows whose re-query failed.
- **P-I2 to P-I7** (noted):
  - desktop uses an in-app focus-trapped dialog;
  - the agent picker is gated on `sandbox.remove` being advertised (inference);
  - deadline comment;
  - VS Code queuing (same as J-W3);
  - every token attempt burns the token, including on CONFLICT;
  - one weak protocolWire assertion, backed by exact-frame tests elsewhere.
- **Doc list:** root README, `docs/specs/02` implemented-contract block and `sandbox_bindings` row, plan C1 status, `docs/compatibility.md` UNVERIFIED note.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| C-W1 | fixed pre-commit | v4 adds `sandbox_bindings.sbx_id`, captured at create. `external` = no live binding with that sbx id. Rows without an id are external, with a disclosure line. `sandbox.list` joins by id, falling back to name only for rows without an id. |
| C-W2 | fixed pre-commit | Binding row ids are captured before `rm`; the UPDATE touches only those. A per-name in-flight lock (`inflight.rs`) spans create and confirmed remove, so a concurrent operation gets CONFLICT and nothing runs. |
| C-W3 | fixed pre-commit | `sbx.rs` doc and design §2 now say "not proof of human presence against a malicious same-user process". No connection binding. |
| C-I4, C-I5 | fixed pre-commit | sbx id `[A-Za-z0-9-]{1,64}`, otherwise dropped, and step 1 fails closed. Agent `[A-Za-z0-9._-]{1,64}`, otherwise dropped. |
| C-I6, C-I7 | fixed pre-commit (docs) | Design §2/§3 reconciled. I7 recorded in the A4 row and the plan's C1 open items. |
| C-I1/I2/I3/I8 | accepted | Rationale in Findings. The I3 race is disclosed in code, design §3 and plan C1. |
| VD-W1, VD-I1 | fixed pre-commit | Click-time expiry check, failing closed. The decode error logs only the error kind and line length. |
| VD-W2 | fixed pre-commit | Stop goes through `ConfirmDialog` with Cancel focused. The task count is shown honestly (see P-W2). |
| VD-W3, VD-W4 | fixed pre-commit | Both CONFLICT causes plus Core's own message (revealed, capped). `describeCoreError` reveals and caps every error surface. |
| VD-I2…I8 | accepted / fixed (I6 comment) | Low impact; recorded. |
| J-W1 | fixed pre-commit (Core + client) | Core: every failure after `rm` runs is INTERNAL, including a NOT_FOUND from `rm` itself (`after_rm`). Invariant: at step 2, VALIDATION_FAILED, CONFLICT and NOT_FOUND only come before `rm`. JetBrains says "ran nothing" only for Core's token-rejected or name-refusal prefixes, drift-pinned against the Rust source. |
| J-W2, J-I1 | fixed pre-commit | Decode failures become fixed-text INTERNAL with no payload. `toString` redacts the token. Both tested. |
| J-W3 / P-I5 | deferred (follow-up) | Disclosed in the JetBrains and VS Code READMEs, including the `task.cancel` delay, and in plan C1. Fix options: a dedicated connection for long calls, or concurrent dispatch per connection in Core. |
| J-I2, J-I3, J-I5 | fixed pre-commit | Deadline floors drift-pinned against `RunLimits`. Both CONFLICT causes shown. The refresh failure reason is shown. |
| J-I4/I6/I7/I8 | accepted | Rationale in Findings. |
| P-W1, P-I1 | fixed pre-commit | Shared wording in all three clients: "NOT CONFIRMED AS CREATED BY SANDPANE — Core cannot confirm Sandpane created this sandbox (no Sandpane binding is recorded for this sbx id)." Doc comments in Rust, TS and Kotlin updated. Core impact line now reads "has no recorded sbx id". |
| P-W2 | fixed pre-commit | VS Code and desktop say "Active tasks in this sandbox cannot be checked: Core does not yet record which sandbox a task uses". The counting path is kept for a future Core and tested as such. VS Code README scenario 6 is back to PENDING. Desktop shows 0 only when Core has no non-terminal task at all, which is established, not assumed. VS Code shows "cannot be checked" in that case too, which is more conservative. |
| P-W3 | fixed pre-commit | `validateAddressableSandboxName` in VS Code and desktop mirrors `Validator::sandbox_name`, drift-pinned against the Rust source (desktop also runs Core's own accept/reject corpus). Create keeps the strict rule. |
| P-W4 | rejected (finding incorrect) | Both live checks were run isolated; evidence below. |
| P-W5 + doc list | fixed pre-commit | Desktop README refreshed with an A1 status table. Root README, specs/02, plan C1 and CL lines, and `docs/compatibility.md` (UNVERIFIED-against-real-sbx row) updated. |

## Verification evidence

All run fresh by the orchestrator after the last edit, before `b1067c7`:

- `make check` → exit 0:
  - Core: `cargo fmt --check` OK; clippy `--all-targets -D warnings` clean; tests 130 + 3 + 17 + 28 + 58 + 19 = **255 passed, 0 failed**.
  - Schemas: `schemas: JSON syntax OK`; `OK methods (rpc-request.method): 16 values match`; `OK advertised methods (Method::ALL -> core-capabilities.methods): 16 values match`; `All schema/protocol value sets in sync.`
  - VS Code: `Tests 338 passed (338)`.
  - Desktop: `Tests 401 passed | 8 skipped (409)`; Tauri shell `32 passed; 0 failed`.
- JetBrains, forced fresh: `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` → exit 0, JUnit XML **243 tests, 0 failures, 0 errors, 0 skipped**. `./gradlew verifyPlugin --offline --rerun-tasks` → `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`.
- VS Code live check: `env -i … SANDPANE_SBX_PATH=/nonexistent/sbx node scripts/live-core-check.mjs` → **57/57 checks passed**, including `A1: Core advertises sandbox.stop + sandbox.remove and no sandbox.start` and `sandbox.list fails with NOT_INSTALLED (no sbx on this host)`. Core stderr: "sbx executable not found".
- Desktop live tests against an isolated Core (temp socket and DB, `SANDPANE_SBX_PATH=/nonexistent/sbx`, PATH without sbx) → `Tests 8 passed (8)`. Temp dir removed afterwards.
- Flaky test outside this diff: `process::tests::timeout_kills_a_grandchild_holding_the_pipe` failed once in an early full run (pidfile read under parallel load). It passed 3/3 alone and in every later full run. `process.rs` is unchanged. Recorded as a pre-existing follow-up.
- Hidden-character scan over the 71 changed files → 0 raw invisible characters, after 4 raw U+202E/U+200B in `apps/desktop/tests/sandbox-lifecycle.test.ts` were rewritten as `\u` escapes (50/50 tests in that file pass). Secret/path gate on the staged diff → clean.
- `pgrep -fl 'sbx|sandpane-service'` after the live runs → none.
- **Not run:**
  - anything against a real `sbx` or a real sandbox (by rule);
  - the VS Code commands, desktop dialogs and JetBrains actions inside a real editor, app or IDE;
  - `cargo-audit` / `cargo-deny` (not installed; the only new dependency edge is `getrandom =0.4.3`, MIT OR Apache-2.0, already in `Cargo.lock`);
  - the desktop `npm run build` / `tauri build` (not re-run in this pass).
- Desktop FakeCore stop/remove handlers are labelled MODELED, not captured.

**Reviews: 3 × `security-reviewer` + 1 × `phase-reviewer` — PASS-WITH-WARNINGS, no Critical; every Warning fixed pre-commit except J-W3/P-I5 (deferred, disclosed) and P-W4 (incorrect, rejected with evidence).**
