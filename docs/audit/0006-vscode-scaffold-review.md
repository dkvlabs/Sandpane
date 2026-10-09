# 0006 — Auto-review record: VS Code extension scaffold

- **date:** 2026-10-09
- **implementation commit:** `39bfaa2` (feat(clients/vscode): VS Code extension scaffold — core-client, webview sidebar, 141 unit tests, live-Core harness)
- **review ran:** before the commit, as the **lighter path** — per the user's directive ("do not retry" the review fan-outs, "switch to the lighter review path") the three dispatched review agents were cancelled/stopped; the orchestrator performed a checklist pass with fresh command evidence, disclosed here as such. No independent reviewer verdict exists for this entry.

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

**Verdict: PASS via lighter path (orchestrator checklist + fresh live-harness evidence). Independent deep review not run — cancelled by user directive; disclosure stands as the review-method caveat for this entry.**
