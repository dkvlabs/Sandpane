# 0006 — Auto-review record: VS Code extension scaffold

- **date:** 2026-10-09
- **implementation commit:** `39bfaa2` (feat(clients/vscode): VS Code extension scaffold — core-client, webview sidebar, 141 unit tests, live-Core harness); follow-up fix commit `d7e19a5` (independent-review dispositions, +109/−14, tests now 143)
- **review ran:** pass 1 — before `39bfaa2`, as the **lighter path**: per the user's directive ("do not retry" the review fan-outs, "switch to the lighter review path") the dispatched review agents were cancelled/stopped and the orchestrator ran a checklist pass with fresh command evidence, disclosed as such. Pass 2 — one independently dispatched reviewer had ALREADY completed when the cancellation took effect; its full file-level + measured review (**PASS-WITH-FIXES**) is transcribed and dispositioned below. The desktop/JetBrains reviewer agents returned no report (cancelled) — those entries remain pass-1-only, as their records state.

## Scope

`clients/vscode/` — 44 files: manifest/config (package.json, 3 tsconfigs, vitest), `src/core-client/` (protocol/events/connection/transport/commands/catchup/paths), `src/state/reducer.ts`, `src/vscode/` (context/editor/diagnostics/diff/workspaces/host/taskTree), `src/webview/` (bridge/html/sidebar/app), `src/extension.ts` + `session.ts`, 11 test suites + fakeCore helper, `scripts/live-core-check.mjs` (dev harness), README, media assets. No changes to any file outside the directory.

## Method (orchestrator checks, all run fresh this session)

- `make vscode-check` ×2 → `tsc --noEmit` both configs clean; **vitest 11 files / 141 tests passed, 0 failed**; exit 0 both times.
- `node clients/vscode/scripts/live-core-check.mjs` re-run by the orchestrator against the compiled `core/target/debug/sandpane-service` (4,993,120 B binary, built this session): **30/30 PASS** with verbatim transcript — includes probe honesty (`verified:false` all codex flags, `sbx.installed:false`), `NOT_INSTALLED` never empty-list, hostile multi-line content inert, durable cancel + `CONFLICT` on double-cancel, `git.review`/`git.apply` honest aborts, `shell.exec` rejected client-side (`UnknownMethodError`) AND by Core (`VALIDATION_FAILED`), 4 MiB bound enforced both directions, 25-way correlation, state survives disconnect, shared `instanceId` across two sockets.
- Binary freshness: rebuilt immediately before the harness run (`cargo build -p sandpane-service` → Finished, tests green at every `make check`).
- Security greps: CSP meta present in `webview/html.ts` (`Content-Security-Policy` with escaped injection); zero `child_process`/`exec(` in `src/core-client/`; wire parity via `python3 scripts/schema_drift.py` → 7×OK (the scaffold's own `protocolWire.test.ts` pins Rust-side strings).
- Manifest facts read from package.json: `publisher: dkvlabs`, `dependencies: {}`, `engines.vscode: ^1.90.0`.
- NOT run by anyone: launching the extension inside a real VS Code host (no integration runner) — sidebar/tree/status-bar wiring is compile+logic+protocol-verified, not host-verified.

## Findings

### Critical
None surfaced by the checklist (the surfaces AGENTS.md rules 1–10 cover were all probed: no shell use, allowlist-only RPC, no client-side state authority, honest capability flags, bounded frames).

### Suggestion
1. `publisher: dkvlabs` contradicts the specs/03 §2 outline (`dkv-labs`) — a publishing-metadata decision for the P6 marketplace gate, not a code defect.
2. `src/webview/app.ts` hand-mirrors bridge types (import-free by CSP design) — drift risk until the React migration replaces it.
3. The extension has never run in a real VS Code window; P3 exit criteria (specs/03 §5 VS0/VS4, §6 in-host scenarios 1,6) remain outstanding by design at scaffold stage.
4. `scripts/live-core-check.mjs` needs a pre-built Core binary — dev-only, documented; the extension itself never spawns Core.

### Nice-to-have
5. Pull-based catch-up (no Core push frame) documented as a forward-compat seam rather than claimed as a capability.

## Disposition

| # | Disposition |
|---|---|
| 1 | Deferred, recorded — publisher decision belongs to the marketplace/P6 gate; changelog 0006 details note both spellings. |
| 2 | Accepted until React migration (P3 polish); flagged in changelog. |
| 3 | Accepted with disclosure — scaffold claims are scoped to what was verified (see README scenario table 4&7 live / 2,3,5,8 headless / 1,6 pending). |
| 4 | Accepted — harness excluded from shipped product surface. |
| 5 | Recorded. |

**Pass 1 verdict: PASS via lighter path (orchestrator checklist + fresh live-harness evidence) — superseded below by the independently delivered review.**

## Pass 2 — independent reviewer report (transcribed; verdict PASS-WITH-FIXES)

Scope: all 22 src + 12 test files read; typecheck/141 tests re-run green; `live-core-check.mjs` re-run 30/30 against a pre-built binary (spawn shape verified: argument vector, zero args, never a shell); wire parity re-checked against lib.rs (11/10/8/12/4/4/5 exact); `paths.ts` mirrors Core `default_socket_path` exactly; no `any`, no fabricated `verified:true`, fakeCore doubles the injected transport only.

**Measured defect (reviewer's Finding 1, self-re-graded from Critical to top Suggestion because no quoted AGENTS rule covers it):** `transport.ts` armed `net.Socket.setTimeout` (an INACTIVITY timer) with `connectTimeoutMs` and destroyed on `'timeout'` — a healthy idle connection churned **4 reconnects / 15 s**, and any Core reply slower than 3 s died on the idle timer, not the 15 s request timeout. `connection.test.ts` never drove a healthy idle socket, so no test caught it.
**Additional findings:** #2 unescaped dot in the primary `.env` sensitive pattern over-excluded benign files (`/repo/xenv.ts` measured); #3 `validateGitRef` client mirror looser than Rust `Validator::branch_name` (missing `./`, `/.`, leading-dot) — fails safe, wrong message; #4 `engines.vscode ^1.90.0` vs `@types/vscode` resolving 1.140.0 — typecheck does not prove the floor; #5 README scenario-8 label inconsistent with rows 2/3/5; #6 five specs/03 §4 context actions + `sandpane.sendSelection` absent AND unmentioned in Deferred (orchestrator re-verified against specs/03:82,131–135 ✓); #7 publisher string (already pass-1 #1); #8 stale test-file pointer in html.ts comment; #9 unreproducible "47 packages" comment; #10 webview hand-mirrored types (already pass-1 #2).

### Pass-2 dispositions (fix commit `d7e19a5`)

| # | Disposition | Evidence |
|---|---|---|
| 1 | **Fixed** | connect deadline now a wall-clock timer cleared at settle; inactivity timer removed; timeout path rejects without double-firing onClose; new `test/transport.test.ts` reproduces the churn conditions against a real socket (8× window idle) and passes; live harness re-passed 30/30 post-change |
| 2 | **Fixed** | pattern escaped; false-positive case `/repo/xenv.ts` added to the not-over-blocked list |
| 3 | **Fixed** | mirror now rejects `./`, `/.`, leading `.` (Rust parity); 3 regression cases added |
| 4 | **Deferred, recorded** | engines↔SDK pin pair is a P6 packaging decision (needs a real 1.90 install to verify the floor; changing types blind trades one unproven claim for another). Open item; README/compatibility to gain the row at packaging |
| 5 | **Fixed** | row 8 now PARTIAL with the same epistemic wording as 2/3/5 |
| 6 | **Fixed** | README now names all five actions + `sandpane.sendSelection` as deferred, with spec line cites (confirmed against the spec by the orchestrator before adding) |
| 7 | Carried from pass 1 | P6 marketplace decision, unchanged |
| 8 | **Fixed** | comment points at the real `test/webview.test.ts` |
| 9 | **Fixed** | count claim replaced by the verifiable invariant ("zero runtime deps") |
| 10 | Carried from pass 1 | drift-guard gap noted; removed by React migration |

Final verification after fixes: typecheck clean, **vitest 12 files / 143 tests / 0 failed**, `live-core-check.mjs` 30/30 against the compiled Core binary.

**Entry 0006 final verdict: PASS-WITH-FIXES → all fixable findings fixed and re-verified in `d7e19a5`; 2 findings deferred with recorded reasons (#4 P6 pin pair, #7 publisher decision). Pass 1 + Pass 2 together = independent review obtained for this entry.**
