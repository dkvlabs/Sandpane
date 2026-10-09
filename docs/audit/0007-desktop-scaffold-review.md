# 0007 — Auto-review record: Tauri desktop app scaffold (apps/desktop)

- **date:** 2026-10-09
- **implementation commit:** `136231b` (feat(desktop): Tauri 2 desktop app scaffold — full IA shell, Core client, thin Rust IPC proxy; 61 files, +14,870; one amend fixed an orchestrator message error — the UI is React with a dependency-free router, not React-less)
- **review ran:** before the commit, **lighter path** (review-agent fan-outs cancelled per user directive "do not retry, switch to the lighter review path"); orchestrator checklist with fresh command evidence. No independent reviewer verdict exists for this entry — disclosed.

## Scope

`apps/desktop/` — 61 files: `src/lib/` (protocol 351 L, core-client 619 L, reducers 1014 L, decode, framing, wizard, hooks, event-store, conversation-store), dependency-free hash router + context, React entry/App, UI store, transport adapters (tauri + unavailable), components (layout/ui/chat/project/review/sandbox ≈2.3k), 10 feature views (dashboard, projects, project, chats, tasks, sandboxes+wizard, agents, templates, integrations, settings ≈2.4k), CSS token system (dark+light), `src-tauri/` (ipc_client.rs 371 L, main.rs, tauri.conf.json, capabilities), 7 vitest suites + fake-core test double, README. Nothing written outside the directory (orchestrator verified via git status inventories).

## Method (orchestrator checks, fresh)

- `make desktop-check` ×2 → typecheck exit 0, **vitest 7 files / 144 tests / 0 failed**; agent's cold re-run post-fence agreed.
- `npm run build` (vite) run by the orchestrator: exit 0, `305.49 kB JS + 20.04 kB CSS`, "✓ built in 569ms".
- Security greps: no `innerHTML`/`eval(` in src/ (0 hits); strict CSP in tauri.conf.json (`default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'`, ipc-only connect-src); only prose mention of `std::process::Command` in ipc_client.rs header comment (absence claim), no actual Command/spawn.
- Wire parity through the landed value-set gate: `python3 scripts/schema_drift.py` 7×OK; desktop's own `tests/protocol.test.ts` asserts the same sets (20 tests green in-suite).
- Agent-reported self-fixes verified as present in-suite: sandbox-name pre-validation now Core-anchored-allowlist equivalent (wizard 25 tests); immutable conversation snapshot (reducers/connectivity suites).

## Findings

### Critical
None from the checklist. (AGENTS rules probed: no shell surface — the proxy has none; validation before args; no client-side task-state invention — states come from replayed events + per-task checkpoints; honest gap UIs; no secrets.)

### Suggestion
1. **`ipc_client.rs` has never been compiled on this host** (agent stated "no Rust/Tauri toolchain"; actually Rust 1.99 exists via Homebrew, but Tauri's crate/system-dep download was not attempted — the honest state is "deliberately not built here, deferred per execution plan entry for desktop"). Its included unit tests are therefore UNRUN.
2. No real-socket round trip from desktop (fake-core test double only, clearly labelled in tests/) — the VS Code scaffold's live harness proves the wire format, not this client.
3. Core has no push frame — 1→10 s replaying `task.subscribe` poll with per-task checkpoints is the honest substitute; recorded in the compatibility gap register (entry 0008 set).
4. Specs/05 §11 performance targets entirely unprofiled; jsdom/browser render unverified (unit tests are pure logic).

### Nice-to-have
5. `installed_daemon_unknown` tri-state display — better than the binary ready/not-ready the spec sketch implies; keep.

## Disposition

| # | Disposition |
|---|---|
| 1 | Accepted-with-correction: reworded from "no toolchain" to "deferred per plan; toolchain partially present" in changelog 0007; P5 packaging will compile. |
| 2 | Accepted: live round-trip is P5 integration (Core-side already proven via VS Code harness + service integration suite). |
| 3 | Deferred to Core (gap register docs/compatibility.md "Protocol v1 gaps"; P1/P2 protocol work). |
| 4 | Accepted at scaffold boundary; DT5 in the scaffold README lists it. |
| 5 | Recorded. |

**Verdict: PASS via lighter path (orchestrator checklist + fresh gates). Independent deep review cancelled by user directive — disclosed.**
