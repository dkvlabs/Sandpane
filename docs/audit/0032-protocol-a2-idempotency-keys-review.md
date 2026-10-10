# 0032 — Auto-review record: protocol A2, durable idempotency keys and feature advertisement

- **date:** 2026-10-10
- **implementation commit:** `af8858d` — feat(protocol): durable idempotency keys and feature advertisement (A2) (56 files, +5830/−284)
- **review ran:** before the commit, on the same working-tree diff, per `audit/README.md`

## Scope

The whole A2 addition. The design decisions in [§3.1 of the design of record](../plans/2026-10-09-protocol-v1-additions.md) were written before any code.

- **Core:** `sandpane-protocol` (`FEATURES`, `idempotencyKey?`, `replayed?`), `sandpane-core` (new `idempotency.rs`, migration v5, key validator), `sandpane-service` (keyed create/send, startup reconcile, fail-closed start), and the integration tests.
- **Schemas and drift:** `core-capabilities`, `sandbox-create-spec`, `scripts/schema_drift.py`.
- **Clients:** VS Code, JetBrains, desktop.
- **Docs:** design §3.1, `docs/specs/02`, the plan, `docs/compatibility.md`, root and client READMEs.
- **Also included:** the hidden-character cleanup of an older desktop test file (`tests/unknown-status-followup.test.ts`: 18 raw invisible code points, all inside string literals, rewritten as `\uXXXX` escapes; its 45 tests pass).

## Method

The work followed the order adopted after entry 0031. Core and the schema came first; one `security-reviewer` pass covered the Core diff, and its fixes landed before any client work. The orchestrator then re-ran the gate and froze Core's behaviour. All three clients were briefed from one shared document: the frozen semantics, the exact user-facing strings, Core's error-code invariants, and a checklist of the defect classes earlier reviews kept finding. Finally, one combined `security-reviewer` pass, which also did the phase-review checks (README claims, fixture labels, drift pins, test quality), covered all three clients. Its fixes were re-gated. All gates were re-run fresh by the orchestrator.

## Findings

No Critical findings in either review.

**Core review:**

- **C-W1** (honesty): a replay returned the stored first response verbatim, for example `status: "queued"` after restart had reconciled the task to `interrupted`. Clients could not tell it was a replay.
- **C-W2**: two post-start create outcomes were stored as `done`, contrary to the §3.1 item 7 text: exit 0 with a failed re-query, and a timeout after which the re-query found the sandbox.
- **C-W3**: a failed startup reconcile of `pending` to `unknown` was only logged, so keys could stay "in progress" until the next restart. The task reconcile had the same log-only pattern.
- **C-W4**: the schemas README claimed client wire-parity pins that did not exist yet.
- **Info:**
  - C-I1: "never run twice" holds only within retention.
  - C-I2: fingerprint stability across future fields.
  - C-I3: a replay after the project is deleted returns that error.
  - C-I4: a race marker was matched by string.
  - C-I5: a concurrent same-key create can get A1's name-lock CONFLICT.
  - C-I6: a large clock jump prunes rows.
  - C-I7: git cannot prove the design was written first.
  - C-I8: no `cargo-audit`.

**Combined client review:**

- **W1:** "Retry safely" in VS Code and desktop resent the stored key without checking that the *current* Core still advertises `idempotency-keys`. A Core swapped for a pre-A2 build could drop the key and run the request twice. This is an edge case, because pre-A2 Cores refuse the v5 database. VS Code's reconnect also briefly exposed the previous Core's cached features.
- **W2:** in VS Code and desktop, a Retry-safely attempt that failed provably unsent lost the unknown-outcome context. The generic copy invited a fresh-key Send, which could run twice.
- **W3** (desktop): a decode failure after Core had answered a create/send showed "client error … retry". A malformed `replayed` threw for the whole reply.
- **W4** (desktop): for an unkeyed create/send, the INTERNAL copy said "Retry".
- **Info:**
  - I1: retry copy overclaimed "otherwise returns the earlier result".
  - I2: task-oriented CONFLICT headline.
  - I3: a malformed success reply in VS Code.
  - I4: double click on desktop Retry safely.
  - I5: generic name-lock copy.
  - I6: the desktop transport-drop flag is partial (pre-existing).
  - I7: JetBrains' gate-to-send gap.
  - I8: JetBrains' over-cautious not-ready copy.
  - I9: the reviewer did not run `verifyPlugin`.
- **JetBrains:** no Warnings.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| C-W1 | fixed pre-commit | Additive `replayed: true` on `SandboxSummary`/`TaskSummary`, set only on the replay path and never stored. Docs and schema say a replay is the first response, not current state. Every client shows a replay notice and re-reads state. |
| C-W2 | fixed pre-commit (design text) | §3.1 item 7 now lists exactly which post-start outcomes become `unknown` and which are stored `done`, because they match what the client received. |
| C-W3 | fixed pre-commit | `try_with_config` makes both reconciles fallible. `main.rs` drops the listener, removes the socket and exits 1 ("refusing to start"). Tested through the library and the real binary. |
| C-W4 | fixed pre-commit | README reworded. The client pins landed in this same commit. |
| C-I1, C-I2, C-I4, C-I5 | fixed pre-commit | Retention wording. Fingerprint tag `sandpane-idem-v1` and a rule requiring `skip_serializing_if`. Typed `TaskWriteError::KeyRace`. Name-lock note in design §3.1 item 5. |
| C-I3, C-I6, C-I7, C-I8 | accepted | Fails safe (nothing runs) / rare / recorded / tooling absent. |
| W1 | fixed pre-commit | VS Code and desktop re-attach and re-probe at click time. If the feature is not advertised, they refuse with "Not retried: … Nothing was sent — check state first." JetBrains already gated this way. |
| W2 | fixed pre-commit | A provably-unsent retry keeps the original unknown-outcome state and key and offers Retry safely again. VS Code attaches before retrying. |
| W3 | fixed pre-commit | A post-reply decode failure is marked maybe-applied: unknown-outcome copy, Retry safely only if keyed, payload never echoed. A malformed `replayed` becomes `replayedUncertain`, which triggers a re-read. |
| W4 | fixed pre-commit | Unkeyed create/send get "check state before trying again (this Core does not advertise idempotency keys …)". |
| I1, I4, I5 | fixed pre-commit | Copy "…returns the earlier result or refuses". Synchronous `sending` state plus a latch. Title "Nothing was run — another operation on this sandbox is in progress". |
| I2, I3, I6, I7, I8 | accepted | Honest but generic or over-cautious; nothing can double-run. I6 predates A2. |
| I9 | covered | The orchestrator ran `verifyPlugin` (below). |

## Verification evidence

All run fresh by the orchestrator after the last edit, before `af8858d`:

- **`make check`** → exit 0:
  - Core: `cargo fmt --check` OK; clippy `--all-targets -D warnings` clean; tests 139 + 3 + 20 + 29 + 78 + 19 = **288 passed, 0 failed**.
  - Schemas: `All schema/protocol value sets in sync.`, including `OK features (FEATURES -> core-capabilities.features): 2 values match`.
  - VS Code: `Tests 367 passed (367)`.
  - Desktop: `Tests 429 passed | 8 skipped (437)`; Tauri shell `32 passed; 0 failed`.
- **JetBrains:** `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` → exit 0, **265 tests, 0 failures, 0 errors**. `verifyPlugin --offline --rerun-tasks` → `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`.
- **VS Code live check** against an isolated Core (`env -i`, `SANDPANE_SBX_PATH=/nonexistent/sbx`, PATH without sbx) → **58/58 checks passed**, including `A2: Core advertises every feature this client knows`.
- **Desktop live tests** against an isolated Core (temp socket and DB) → `Tests 8 passed (8)`. Core stderr: "sbx executable not found". The temp dir was removed, and `pgrep` shows no sbx or Core process left.
- **Core-specific evidence**, from the implementing engineer's runs, re-confirmed by the gate above:
  - mutation checks fail the matching tests: no replay marker, log-only reconcile, release replaced by unknown, cap ignored, a lost key race that commits anyway (5 of 5), no Drop backstop;
  - the binary test was seen failing (exit 101) before the `main.rs` change.
- **Hidden characters:** a scan of the 55 changed files found 0 raw invisible characters. The secret/path gate on the staged diff was clean (56 files).
- **Not run:**
  - anything against a real `sbx`;
  - any client inside a real editor, app or IDE;
  - `cargo-audit` / `cargo-deny` (not installed; new chain sha2 0.11.0, digest 0.11.3, block-buffer 0.12.1, crypto-common 0.2.2, hybrid-array 0.4.15, cpufeatures 0.3.1, typenum 1.20.1, all MIT OR Apache-2.0);
  - desktop `npm run build`.
- Desktop FakeCore A2 behaviour is labelled MODELED, not captured.

**Reviews: `security-reviewer` (Core) + combined `security-reviewer`/phase pass (three clients) — PASS-WITH-WARNINGS, no Critical; every Warning fixed pre-commit.**
