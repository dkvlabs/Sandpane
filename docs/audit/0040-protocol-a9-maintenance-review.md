# 0040 — Auto-review record: protocol A9 — maintenance inventory and cleanup

- **date:** 2026-10-12
- **implementation commit:** `7c784f0` — feat(protocol): maintenance inventory and cleanup (A9) (81 files, +9 125/−141; squash of `wip/a9-maintenance-core` — Core and schemas `47afc5d`, clients `232c92a` — with the docs)
- **review ran:** before the commit, on the same working-tree diff, per `audit/README.md`

## Scope

The whole A9 surface: `sandpane-core/src/maintenance.rs` (id grammar, digests, backup-name parsing), `sandpane-service/src/maintenance.rs` (~1 750 lines: descriptor-level scan and removal, single-flight, token flow, batched prune), `sandpane-service/src/git_apply.rs` (`CoreTemp` sibling lock files), `process.rs` (spawn counter), `db.rs` (migration v9), `sandpane-protocol/src/lib.rs` (2 methods, 7th feature, payload types), `schemas/maintenance.schema.json` + `rpc-request`/`verification`/`core-capabilities` updates, and the three clients (desktop proxy + webview panel, VS Code command + sidebar section, JetBrains action + dialogs), the drift/live suites, and the docs (design §3.9 item 9, `docs/compatibility.md`, READMEs, this plan report).

## Method

- **Design:** `security-reviewer` reviewed §3.9 before implementation (recorded in `391babc`).
- **Core:** `security-reviewer` returned PASS-WITH-WARNINGS. The fix pass (W1, W2, I1–I4) had been stopped mid-way on the branch; this session verified each fix in the code (all present), ran the full Core gate, and **re-reviewed W1 and W2 inline** (subagent dispatch is unavailable on this host — every subagent spawn fails with a reasoning-level error, a known harness defect recorded in the project notes), walking the union-protection comparator and the step-2 removal ladder against the findings and their mutation tests.
- **Clients:** reviewed inline against the AGENTS.md §Code Review rules (argument vectors only; validated ids; Core-only state; honest copy; no secrets; token never logged/persisted; exhaustive read/write matches with 36-method pins in the desktop proxy and JetBrains drift gates). The A8a precedent (per-surface display, no "ready" wording) was followed for the new UI copy.
- **Mutation evidence:** two deliberate mutations — desktop `resultDisclosures` losing the `outputPruned` precedence, and the JetBrains `disclosures` equivalent — each turned the named test red (`tests/maintenance.test.ts` 1 failed; `MaintenanceTest.outputPrunedTakesPrecedenceOverTheTruncationDisclosures` failed) and were reverted, with the suites green again afterwards.

## Findings

1. **Suggestion (fixed pre-commit), `apps/desktop/src/lib/maintenance.ts` `dismiss()`:** it cleared `settled` and called `emit()` without changing the `useSyncExternalStore` snapshot, so the outcome panel would not disappear until the next state change. Fixed by setting a new state object (`this.set({ ...this.state })`).
2. **Suggestion (fixed), VS Code name collision:** the maintenance helper `outcomeCopy` clashed with the A7 helper of the same name in `session.ts` (TS2300). Renamed to `maintenanceOutcomeCopy`.
3. **Suggestion (fixed), JetBrains `MaintenanceItemsDialog`:** property-assignment syntax (`preferredScrollableViewportSize = …`) does not compile against the platform's JBList; replaced with `preferredSize` on the panel.
4. **Info (accepted):** the live script's older "advertises exactly the 34 methods" check failed against the A9 Core on the first live run — expected drift, caught by design; updated to 36 and the run went 69/69.
5. **Info (accepted):** Mimosa reported `scanner_enobufs` (incomplete pre-commit scan) on both commits; per its own message the commits proceeded and no security claim is based on that scanner. The findings above are from the inline review, not from Mimosa.
6. No Critical finding was raised against A9 code.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| 1 | fixed pre-commit | snapshot identity is what drives the React re-render |
| 2 | fixed pre-commit | duplicate export broke `tsc` |
| 3 | fixed pre-commit | Kotlin property/setter asymmetry |
| 4 | fixed (test updated) | the pin exists to catch exactly this drift |
| 5 | accepted | scanner outage; not evidence either way; inline review stands |

## Verification evidence

All results below are from runs in this session, before `7c784f0`.

- **Core:** `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` clean. `cargo test`: **655 passed, 0 failed** (596 at A7 + A9's own suites; `tests/maintenance.rs` 33, `maintenance_spawn.rs` 1, unit tests in both crates). The W1/W2 mutation tests (`w1_a_newer_schema_backup_does_not_unprotect_the_current_one`, `w1_within_one_schema_the_most_recent_backup_is_protected_not_the_highest_k`, `w2_directory_removed_but_lock_file_changed_is_reported_removed_with_a_note`, `w2_directory_removed_but_unlink_failed_is_reported_removed_with_a_note`, `w2_a_failed_directory_removal_is_reported_as_partially_removed`) pass against the re-reviewed code.
- **Desktop:** `npm run typecheck` clean; `npm test`: **775 passed, 10 opt-in live skipped** (28 new A9 tests in `tests/maintenance.test.ts`; drift suites updated to 36 methods / 7 features). `cd src-tauri && cargo test`: 37 passed (36-method pins, read/write decisions, 30 s budgets, the A9 suffix test).
- **VS Code:** `npm run typecheck` clean; `npm test`: **863 passed** (13 new tests in `test/maintenance.test.ts`; 27 contributed/registered commands; live script extended).
- **JetBrains, run alone** (`./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache`, then `verifyPlugin --offline`): `BUILD SUCCESSFUL`; JUnit XML: **505 tests, 0 failures, 0 errors** (12 new in `MaintenanceTest`); verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`.
- **`make check`:** exit 0 (core + schema-lint + schema-drift at 36 methods / 7 features + vscode + desktop + jetbrains).
- **Live checks** against isolated Cores (`env -i`, throwaway `HOME`/socket/DB, `SANDPANE_SBX_PATH=/nonexistent/sbx`):
  - VS Code `scripts/live-core-check.mjs`: **69/69**, including the new A9 checks (advertisement of both methods at the end + the `maintenance` feature; `maintenance.inventory` answers `{items, truncated}`; step 1 with an unknown id answers `VALIDATION_FAILED … nothing was issued`);
  - desktop `tests/live-core.test.ts`: **10/10**, including the new A9 inventory/refusal test;
  - the throwaway Core was killed by exact PID; no `sandpane-service` process was left.
- **Scans:** 0 raw invisible characters across the 57 changed files; secret gate clean (no token-shaped value, no real username/home path introduced; the one `grep` hit is pre-existing context in `docs/compatibility.md`).
- **UNVERIFIED:**
  - the maintenance UIs have never been shown in a real editor, app or IDE;
  - no real cleanup was driven against a live Core (the live checks only scan and prove refusals);
  - `sbx` was never run — every check used a nonexistent sbx path, and A9 spawns no sbx process by design (spawn-counter test).

**Inline review (orchestrator; phase-reviewer/security-reviewer subagents unavailable on this host) — findings dispositioned above; no Critical remains.**
