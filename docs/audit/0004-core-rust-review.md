# 0004 — Auto-review record: Rust Core workspace, protocol schemas, tooling

- **date:** 2026-10-09
- **implementation commit:** `9624967` — feat(core): Rust Core workspace — protocol, domain, IPC daemon; schemas; Makefile; code-review rules (31 files, +5812/−2)
- **review ran:** before the commit, on the same working-tree diff, via the read-only `phase-reviewer` project agent (the bundled `/review` 23-agent workflow was cancelled by the user earlier in this session; the lighter project-agent path was used and is disclosed here)

## Scope

Working tree vs `c9da1fa`: new `core/` Cargo workspace (`sandpane-protocol` 585 L, `sandpane-core` 7 modules + fixtures + lifecycle integration test, `sandpane-service` lib 1100+ L + main.rs + 11-socket-integration tests), `schemas/` 7 JSON schemas + README, `Makefile`, `AGENTS.md` new `## Code Review` rules 1–10, `docs/compatibility.md` transport/platform prerequisites. Net ≈4,900 lines Rust + 292 schema lines. No binaries bundled.

## Method

`phase-reviewer` agent (plan-mode, read-only): loaded docs/specs 02/06/07/08 acceptance criteria + AGENTS.md Code Review rules; re-ran verification fresh (`make core-check` — permission was NOT blocked); walked all in-scope files; checked the author's late-phase focus areas (NDJSON flush fix, validation allowlist switch, durable-before-notify, git change semantics, rusqlite usage, schema↔Rust wire drift, honesty of capability/verification claims). Its full report (2 Critical, 20 Suggestion, 6 Nice-to-have) was transcribed and dispositioned by the orchestrator.

Orchestrator additionally ran, after fixes: `make core-check` (72 tests green), `make schema-lint`, and an over-the-real-binary daemon smoke suite: probe → protocolVersion 1, verified:false; socket `0600` / dir `0700` read back; **kill/restart reconciliation proven end-to-end** (daemon killed with a `running` task; new instance → durable `status.changed → interrupted {reconciledAfterRestart:true}` event via `task.subscribe`, row `interrupted`, daemon logged `reconciled 1 stale task(s)`).

## Findings (from the review; condensed)

### Critical
1. **Restart reconciliation asserted only in a comment; no production code** — test helper implemented the behavior it claimed to verify (T09 fiction).
2. **`sandbox.create` mounted arbitrary absolute host paths** — `path_within_root` never called; schema/protocol comments claimed containment that did not exist.

### Suggestion (abridged; full bodies in the review transcript)
3 schema↔Rust drift `unsupported.event` (`providerType` vs `provider_type`); 4 `workspace_mode` stored JSON-quoted (queries silently miss live-writable rows); 5 no subprocess wall-clock timeouts; 6 idempotency keys/deadlines absent from envelope; 7 schemas `additionalProperties:false` stricter than Rust (no `deny_unknown_fields`); 8 apply dirty-gate contradicts direct_mount-by-design dirtiness; 9 `git.apply` failed OPEN when task lacks Git context + `selectedFiles` ignored silently; 10 non-ASCII paths C-quoted into ChangeSets; 11 `Renamed` status unreachable (`--no-renames`); 12 SBX locator accepts any regular file named `sbx`; 13 bare `git` + untrusted cwd on Windows; 14 non-UTF-8 frame closed connection without response; 15 one poisoned mutex bricks daemon; 16 multi-statement mutations not transactional (log/status can diverge); 17 `task_cancel` never releases scheduler state; 18 full prompt mirrored into event log, no redaction seam; 19 sequence query error masked as `1`; 20 allowlist regressions (`+` refs) + `./` edge over-permissive; 21 test gaps list; 22 permission `set` failures ignored (same-user boundary fictional).

### Nice-to-have
23 WAL pragma not asserted; TooNew refusal ran after pragma mutation; 24 index deviates from spec table (undocumented); 25 dead-in-scaffold surface (start/stop/remove/inspect/version, port, prune, capability gating) must not read as covered; 26 Makefile client targets cryptic until phases land; 27 compatibility.md conflates protocol version with crate semver; 28 presets.configuration_json invites provider secrets.

## Disposition

| # | Disposition | Evidence |
|---|---|---|
| 1 | **Fixed pre-commit** | `reconcile_after_restart()` in `ServerInner::new` (production path main.rs takes); `RECONCILABLE_STATUSES` incl. created/queued/preparing/running/awaiting_input; durable tx per task; new integration test `restart_reconciliation_interrupts_stale_tasks_in_production_path` + daemon kill/restart smoke (Method above). Terminal rows untouched. |
| 2 | **Fixed pre-commit** | `sandbox_create` now requires writable modes to carry `repoPath` that `fs::canonicalize`s **inside a project-registered repository** (symlink-resolved), `PERMISSION_DENIED` otherwise; mountless refuses a path. Tests: arbitrary `/tmp`, symlink escape, missing path, contained subpath accepted. Schema/protocol claims now TRUE. |
| 3 | Fixed | `#[serde(rename = "providerType")]` + exact wire pins in protocol tests (approval.required pin added too). |
| 4 | Fixed | `workspace_mode_wire()` bare snake_case storage; test asserts stored value == `sbx_clone`. |
| 5 | Deferred, documented | compatibility.md §"Transport / platform prerequisites" (open P1 item). Damage bounded: no DB mutex held across subprocess (reviewer confirmed). |
| 6 | Deferred | P1 protocol work (specs/02 §2); recorded in this file + changelog; `sandbox_bindings` name-collision surfaces as structured error meanwhile. |
| 7 | Accepted | Hand-synced drift-check lands with CI entry; schemas/README states Rust as source of truth. |
| 8 | Documented in code | `preconditions_for_apply` KNOWN SCOPE LIMIT doc: P4 must scope dirty-gate to touched paths; changelog records it. |
| 9 | **Fixed pre-commit** | fail-closed `match` on `git_context` — no-context apply refuses explicitly; test assertion added (`apply refused… no Git context`). `selectedFiles` no-op remains P4 scope (schema lacks apply params — recorded). |
| 10 | Fixed | `-c core.quotePath=false` on diff/ls-files builders; test `change_list_keeps_non_ascii_paths_verbatim`. |
| 11 | Fixed | `--no-renames` dropped; R/C lines parsed (new path kept); test `change_list_reports_renames_at_new_path`. |
| 12 | Deferred, documented | compatibility.md prerequisites (P0 gate; unreachable today — sbx absent). |
| 13 | Deferred, documented | compatibility.md Windows prerequisites (P9). |
| 14 | Fixed | InvalidData → structured `VALIDATION_FAILED` frame before disconnect; test `non_utf8_frame_gets_structured_refusal`. |
| 15 | Fixed | `lock_db()`/`lock_scheduler()` with `unwrap_or_else(into_inner)` at every site. |
| 16 | Fixed | `EventLog::from_conn`; project_create / conversation_send / task_cancel / reconciliation all single-transaction (event + row writes atomic). |
| 17 | Deferred with in-code note | needs workspace-key column arriving with P2 provisioning; scaffold scheduler takes no locks yet (reviewer: latent, not live). |
| 18 | Deferred | P1/P9 redaction seam; recorded here + changelog (local-only store, no leak path today). |
| 19 | Fixed | sequence query error propagates (`?`), no silent fallback. |
| 20 | Fixed/Documented | `./`, `/.`, leading `.` rejected (+3 test cases); `+` trade-off documented at the validator (Core-owned naming; future user-ref surface needs rev-parse, not a wider allowlist). |
| 21 | Partially fixed | Added: reconciliation-over-service, containment×5 cases, non-UTF8, mode roundtrip, renames, non-ASCII. Remaining gaps (DAEMON_DOWN heuristic, writable-mode RPC admission, main.rs automated perms tests) recorded — smoke-verified, not test-covered. |
| 22 | Fixed + smoke-verified | chmod failures fatal; metadata read-back refuses serving at group/other-accessible modes (failure = refuse); smoke confirmed `0600`/`0700` held on real daemon. |
| 23 | Fixed | version check BEFORE pragmas; WAL assertion added (`journal_mode == wal`). |
| 24 | Documented | index deviation comment in MIGRATION_V1. |
| 25 | Recorded | changelog states P1 items as PARTIAL (list+create only; locator without version/capability probing). |
| 26 | Fixed | `@test -d … || fail loudly` guards on the three client targets. |
| 27 | Fixed | compatibility.md separates protocol v1 from crate 0.1.0. |
| 28 | Documented | presets column warning comment in schema SQL. |

No finding left standing as Critical at commit time. Gate verdict as delivered by the reviewer: **PASS-WITH-FIXES → all Criticals fixed pre-commit**.

## Verification evidence (fresh, pre-commit)

- `make core-check` → `cargo fmt --check` OK; `cargo clippy --all-targets -- -D warnings` clean; test results: **46 + 3 + 7 + 5 + 11 = 72 passed, 0 failed** across all targets.
- `make schema-lint` → `schemas: JSON syntax OK`.
- Daemon smoke (real binary): `probe OK; sbx.installed = False`, `perms OK: socket 0600 dir 0700`, `RECONCILIATION OVER REAL DAEMON OK` with daemon log line `sandpane-service: reconciled 1 stale task(s) to interrupted: t1`.
- Injection corpora green in-suite: `sandbox_name_injection_never_reaches_exec` asserts `/tmp/sandpane-pwned` never created; hostile content survives as inert data end-to-end.
- `git commit` scoped via pathspec (`core schemas Makefile AGENTS.md docs/compatibility.md`); concurrent client-scaffold agents (separate dirs) untouched; `git log` → `9624967`.

**Independent review by the read-only `phase-reviewer` project agent; this record is its dispositioned output. Not the full `/review` fan-out (user-cancelled) — disclosed.**
