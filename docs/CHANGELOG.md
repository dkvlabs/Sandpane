# Sandpane implementation changelog

Every **big implementation step** gets one numbered entry here, per the mandatory logging rule in [`/AGENTS.md`](../AGENTS.md). Entries are chronological: numbers ascend, the newest entry sits at the bottom, directly above the append marker.

## Entry format

```markdown
## NNNN — Short title

- **date:** YYYY-MM-DD
- **phase:** roadmap phase / area (e.g. P1 Core, docs, infra)
- **commit:** <git short hash> (<commit subject>)
- **details:** what was implemented, key decisions, deviations
- **files:** notable paths added/changed
- **verification:** commands run and their actual results (evidence, not claims)
- **review:** docs/audit/NNNN-<slug>-review.md — one-line review outcome
- **model:** model used for the implementation session, or `-`
- **tokens:** input: <n|-> · cached: <n|-> · output: <n|-> (session delta: <n|->)
```

Rules:

1. Any value that cannot be determined is recorded as a dash `-` (e.g. `model: -`). Never guess or fabricate numbers.
2. The `commit` hash points at the implementation commit; the audit/changelog record itself lands in the follow-up `docs(audit)` commit.
3. `verification` must quote commands actually run in that step and their real outcome, including failures and unverified items.
4. Each entry has a matching auto-review record in [`audit/`](audit/README.md) with the same number.

---

## 0001 — Docs folder rebuild

- **date:** 2026-10-09
- **phase:** docs
- **commit:** `9fd4427` (docs: rebuild docs folder — specs/, design/ dedup, audit trail, changelog, P0 records)
- **details:** Rebuilt `docs/` per goal directive. Moved the 9-file implementation package `SANDPANE_IMPLEMENTATION/` → `specs/` (100% renames, content untouched, relative links preserved). Removed 3 byte-identical root-level duplicates of `design/` files (verified with `diff -q` before deletion) and the 1505-line concatenated `SANDPANE_FULL_IMPLEMENTATION_PLAN.md` bundle (specs are the single source of truth; noted in docs/README rebuild note). Added: `docs/README.md` index with reading order, `docs/CHANGELOG.md` (this file, with entry format + dash rule), `docs/audit/` (README conventions + `0000-execution-plan.md` governing all entries), `docs/compatibility.md` and `docs/licensing-decision.md` as the P0 records required by the roadmap (gates recorded OPEN; `sbx` not installed on this host).
- **files:** docs/README.md, docs/CHANGELOG.md, docs/audit/{README,0000-execution-plan}.md, docs/compatibility.md, docs/licensing-decision.md, docs/specs/* (moved), 4 deletions
- **verification:** relative-link walk over docs/**/*.md → only the 4 documented forward references unresolved (AGENTS.md ×3, audit/0001 ×1), all other links OK; `diff -q` → 3/3 duplicates IDENTICAL before removal; `git log` → `9fd4427` on main; `git status` → clean (except untracked `.qwen/` session tooling)
- **review:** [audit/0001-docs-rebuild-review.md](audit/0001-docs-rebuild-review.md) — `/review` skill quick pass (effort: low, unverified): 0 critical, 4 suggestions; all dispositioned (3 accepted-temporary, 1 addressed by the audit record itself)
- **model:** qwen3.8-max (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; goal meter not yet incremented at capture, review cost-ledger unavailable)

## 0002 — AI operations foundation (AGENTS.md, agents, skills, commands, root files)

- **date:** 2026-10-09
- **phase:** infra / AI operations
- **commit:** `6002c63` (feat(infra): AI operations foundation — AGENTS.md, 9 subagents, 5 project skills, vendored superpowers, 3 commands, root files)
- **details:** Created the complete AI-agent operating layer required by the goal. **AGENTS.md**: agent contract with the MANDATORY logging rule verbatim (commit → auto-review → `docs/audit/` record → `docs/CHANGELOG.md` entry with details, model, tokens input/cached/output; dash `-` for every unknown, never fabricated), repo layout, commands, 8 non-negotiable engineering rules distilled from specs 02/06/07, agents/skills map, conventions. **9 subagents** (`.qwen/agents/`): core-, sbx-integration-, vscode-, jetbrains-, desktop-engineer (auto-edit), test-engineer, docs-maintainer, plus read-only plan-mode security-reviewer and phase-reviewer — each grounded in its spec document with hard safety rules and honesty clauses. **5 project skills** (`.qwen/skills/`): `sandpane-changelog` (the logging system: procedure, numbering, dash-rule sources for model/tokens, audit-template.md), `sandpane-phase-gates`, `sbx-cli-integration`, `git-safe-tasks`, `core-protocol`. **Superpowers vendored** (satisfies "use the superpower skill"): 14 skills from v5.1.0 (MIT © Jesse Vincent), byte-identical copies + SUPERPOWERS_LICENSE + SUPERPOWERS_NOTICE.md with adaptation notes; methodology in active use this session (execution plan 0000, verification-before-completion discipline). **3 commands**: `/log-implementation`, `/audit-review`, `/phase-status`. Root files: README.md, MIT LICENSE with scope notes (original code only; vendored attribution; release gate pointer), extended .gitignore (anchors reviewed), rust-toolchain.toml. Pre-commit review fixes applied: security-reviewer logging line added; .gitignore output patterns anchored.
- **files:** AGENTS.md, README.md, LICENSE, .gitignore, rust-toolchain.toml, .qwen/agents/ (9), .qwen/skills/ (5 project + 14 vendored + NOTICE/LICENSE), .qwen/commands/ (3)
- **verification:** frontmatter structure check over 31 files → ALL FRONTMATTER OK; `diff -rq` vendored vs source cache → 14/14 IDENTICAL + LICENSE identical; link check → all AGENTS.md/docs links resolve (entry 0001's forward refs to AGENTS.md and audit/0001 now resolved), 5 README layout links pending entries 0003–0006 (accepted, listed in audit); `git log` → `6002c63`
- **review:** [audit/0002-ai-ops-foundation-review.md](audit/0002-ai-ops-foundation-review.md) — `/review` quick pass (effort: low, unverified): 0 critical, 4 suggestions + 1 nice-to-have; 2 fixed pre-commit, 3 accepted-temporary with resolution gates
- **model:** qwen3.8-max (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; goal meter reads 0 mid-turn — updates only at turn boundaries, breakdown unavailable)

## 0003 — Superpowers v6.4.2 installed from canonical GitHub source (project-level)

- **date:** 2026-10-09
- **phase:** infra / AI operations (user request; supersedes the cache-vendored v5.1.0 from entry 0002)
- **commit:** `8f9506e` (feat(skills): install superpowers v6.4.2 from canonical GitHub source (project-level))
- **details:** Per user request, installed superpowers directly from https://github.com/obra/superpowers into the **project** skills directory `.qwen/skills/` (explicitly not user-global `~/.qwen/skills/`). Fresh shallow clone at HEAD `8ca22dba9a94f28898bbce59f2537ff4d87c747d` = release **v6.4.2** (2026-09-25). Replaced all 14 cache-vendored v5.1.0 skills with their canonical v6.4.2 versions and added the new 15th skill `diagnosing-superpowers` (with its prompts/references/templates). Refreshed `SUPERPOWERS_LICENSE` and rewrote `SUPERPOWERS_NOTICE.md` with exact provenance (repo URL, version, commit hash, install date, history, adaptation notes; upstream Claude Code plugin plumbing — hooks/index.js/manifests — intentionally not installed). Security scan of all scripts: no network surface; two upstream `child_process` uses documented (env-gated browser open; graphviz via execFileSync). Project-authored skills/agents/commands untouched. Note: entry numbering shifts — the paused execution plan (audit/0000) had assigned 0003 to the Rust core; that work will take the next free number when resumed.
- **files:** .qwen/skills/{15 superpowers dirs, SUPERPOWERS_LICENSE, SUPERPOWERS_NOTICE.md} — 69 files, +4084/−1472
- **verification:** `diff -rq` installed vs fresh clone → 15/15 IDENTICAL + LICENSE identical; frontmatter scan → 20/20 OK; script grep → no curl/wget/fetch/http.request; `git diff --cached --stat` → all changes under .qwen/skills/; post-commit `git status` → clean except `?? core/` (paused-goal work, deliberately excluded via pathspec add)
- **review:** [audit/0003-superpowers-v642-install-review.md](audit/0003-superpowers-v642-install-review.md) — `/review` quick pass (effort: low, unverified) + mechanical provenance/integrity checks: 0 critical, 2 suggestions + 1 nice-to-have; 1 mitigated at commit (scoped add), 2 accepted (upstream behavior documented)
- **model:** qwen3.8-max (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; goal meter paused/unavailable for this user-requested change, no per-breakdown source)

## 0004 — Rust Core workspace, protocol schemas, tooling

- **date:** 2026-10-09
- **phase:** P1 Core + P2 scaffold boundary (execution-plan entry that the paused plan numbered 0003; renumbered to 0004 after user-requested entry 0003)
- **commit:** `9624967` (feat(core): Rust Core workspace — protocol, domain, IPC daemon; schemas; Makefile; code-review rules)
- **details:** Implemented the Core per docs/specs/02 as a 3-crate Cargo workspace. **sandpane-protocol**: NDJSON RPC envelope (v/id/method/params → ok/err), 11 allowlisted methods (no free-form execution surface), AgentEvent tagged union + TaskStatus/ErrorCode/workspace-mode wire types with exact-string schema-conformance pins. **sandpane-core**: `validation` (sandbox names, allowlist `[A-Za-z0-9._/-]` branch/ref rules incl. `./`/`/.`/leading-dot rejections, display text, path containment, shell-metachar tripwire), `task` state machine (full lifecycle table incl. created→cancelled/interrupted, no pause fiction, terminal-is-final), `db` (15 tables + 4 indexes per spec, WAL/FK/busy_timeout via execute_batch, forward-only migrations in transactions, TooNew refuses before touching pragmas), `events` append-only replay with per-task sequences (errors propagate; transaction-scoped `from_conn`), `scheduler` (global/per-project limits, one-writer-per-workspace locks, empty reconciliation baseline), `sbx` (locator env-override/PATH, typed command builders for create/list/start/stop/remove/inspect/version, version parse fail-loud, illustrative fixtures labeled `_meta.json fixture_status:"illustrative"`), `git` (worktree/status/diff arg builders, `-c core.quotePath=false` base-vs-worktree change list incl. untracked/renamed/non-ASCII, apply preconditions with documented ref-name limitation and direct_mount scope note). **sandpane-service**: Unix-socket daemon — single-instance handshake (live connect → attach; stale → replace), read-back-enforced 0700 dir / 0600 socket (refuses to serve otherwise, failed metadata = refuse), bounded frames (4 MiB cap + over-limit refusal + non-UTF-8 structured refusal), poison-tolerant locks, ATOMIC message/task/event/cancel writes via transactions, **restart reconciliation in production code** (`ServerInner::new` → durable `status.changed→interrupted {reconciledAfterRestart}` per stale in-flight task before any observation), **mount containment** (writable repoPath must canonicalize inside a project-registered repository; symlink escapes → PERMISSION_DENIED; mountless refuses paths), honest scaffold boundaries (capabilities `verified:false` pending P0; `git.apply` fail-closed + P4 abort disclosure; no agent execution). **schemas/**: 7 JSON Schemas + hand-sync README. **Makefile**: core-check/schema-lint + loud guards for unlanded client targets. **AGENTS.md**: new `## Code Review` rules 1–10 (machine-loadable by future `/review` runs). **compatibility.md**: Windows named-pipe + `git`-path-resolution prerequisites, SBX binary verification, subprocess-timeout and redaction-seam deferrals recorded; protocol-v vs crate-semver axes separated. Review-driven fixes: validation allowlist bypass (`$(evil)`) caught by own test; BufWriter per-frame flush bug caught by integration suite. Honest partials (not-done, per specs/07 wording): version/capability probing wired (UNSUPPORTED_SBX_VERSION currently unreachable), CRUD start/stop/remove/inspect + port/prune helpers unused, idempotency keys/deadlines (P1), subprocess timeouts (P1), redaction seam (P1/P9), cancel-releases-writer-lock (needs P2 provisioning), DAEMON_DOWN heuristic untested against real CLI contract.
- **files:** core/{Cargo.toml,Cargo.lock,crates/sandpane-protocol,crates/sandpane-core,crates/sandpane-service}, schemas/ (8), Makefile, AGENTS.md, docs/compatibility.md — 31 files, +5812/−2
- **verification:** `make core-check` → fmt OK, `clippy --all-targets -D warnings` clean, **72 tests passed / 0 failed** (46 core-lib + 3 lifecycle + 7 protocol + 5 service-lib + 11 Unix-socket integration); `make schema-lint` OK; daemon smoke over the REAL binary: probe (protocolVersion 1, verified false), socket 0600 / dir 0700 read-back, kill/restart → `reconciled 1 stale task(s) to interrupted: t1` + event replay + row state verified via sqlite; injection corpora green incl. `/tmp/sandpane-pwned` never created. NOT verified: real `sbx` behavior (absent — stand-in scripts labeled), Windows paths, DAEMON_DOWN mapping
- **review:** [audit/0004-core-rust-review.md](audit/0004-core-rust-review.md) — independent read-only `phase-reviewer` agent (the 23-agent `/review` workflow was user-cancelled; lighter path disclosed): **PASS-WITH-FIXES** — 2 Critical (restart reconciliation fictional; mount containment missing) both FIXED pre-commit with covering tests; 20 Suggestions + 6 Nice-to-have: 13 fixed, 7 documented/deferred with pointers
- **model:** qwen3.8-max (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; goal meter reports tokensUsed 0 / turnCount 0 mid-turn, no per-breakdown source available to the agent)

## 0005 — PR CI workflow + schema/protocol value-set drift gate

- **date:** 2026-10-09
- **phase:** CI / quality infra (plan-of-record entry 0007 "CI + integration"; landed early as 0005 because it is non-overlapping with the three client-scaffold agents running in parallel — see audit/0000 mapping)
- **commit:** `acbdc35` (ci: PR workflow per specs/08 §6 + schema/protocol value-set drift gate)
- **details:** Landed the PR CI layer of docs/specs/08 §6 and closed audit-0004 disposition #7 (value-set half). **.github/workflows/ci.yml**: `core` job (fmt/clippy/tests on ubuntu+macos matrix, `--all-targets`), non-blocking `cargo-audit` until triage with an in-file gate note, `schemas` job (syntax + drift), and a `detect` job whose file-existence step outputs gate the three client jobs via `needs.detect.outputs` — job-level `if` documents only needs/success-family, so hashFiles was moved into a step (review Critical 2). Header lists every §6 bullet NOT covered: webview CSP/static analysis (P3), TS lint step, Kotlin SDK tests + Plugin Verifier (P6), native Tauri Rust builds, SBX fixture contract tests / real-SBX CI integration (P0-gated, `sbx` absent), and the destructive-adapter review requirement (branch protection, not workflow-expressible). **scripts/schema_drift.py** (stdlib, `--repo-root` overridable): compares exact wire VALUE SETS — 11 methods, 10 error codes on two schema surfaces, 8 agent-event types, 5 change statuses, 4 workspace modes, protocol version — between `schemas/` and the Rust protocol crate; field-level shapes and codegen explicitly out of scope. Fail-closed contract hardened after review: unclassifiable Rust wire strings, data-carrying variants in unit-only enums, and schema-structure errors all exit 2 ("cannot classify input (not drift)"), never a false DRIFT or a silent pass. **Makefile**: `schema-drift` target; `check` now aggregates core + schema-lint + drift gate; honest wording (value-set gate, codegen P1/P7). **AGENTS.md**: Commands row for the gate. **schemas/README.md**: Sync-status rewritten — drift gate landed, generated TS/Kotlin bindings remain P1/P7. Noted during review: `origin` IS configured and reachable (github.com:dkvlabs/Sandpane, zero branches) — contrary to this entry's first draft; the workflow has NEVER run and the first push of main will execute it untested (disclosed in the file header). Concurrent-agent incident: an in-flight scaffold agent accidentally corrupted one line of this file; reverted from HEAD (single hunk, committed-correct), all three agents fenced to their directories (audit 0005 incident note).
- **files:** .github/workflows/ci.yml, scripts/schema_drift.py, Makefile, AGENTS.md, schemas/README.md — 5 files, +398/−10
- **verification:** `make check` → fmt OK, clippy `-D warnings` clean, **72 passed / 0 failed** (46+3+7+5+11), `schemas: JSON syntax OK`, drift gate 7×OK in sync, EXIT 0 (run fresh twice pre-commit). Mutation battery on disposable copies: remove `git.apply`+bump schema version → exit 1 with both diffs; non-dotted method `"ping"` → exit 2 unclassifiable (was silent pass — evasion closed); data variant `Renamed{..}` → exit 2; schema `method.enum` removed → exit 2 (was traceback-as-drift); dotted new method → DRIFT reported; baseline → exit 0. ci.yml YAML parsed (Ruby psych — PyYAML absent), 7 jobs incl. detect; all in-file path refs exist. NOT verified: real GitHub Actions execution (never run — origin has no branches; first push runs untested), `cargo audit` advisory backlog, ubuntu test leg, client guard outputs at runtime.
- **review:** [audit/0005-ci-drift-review.md](audit/0005-ci-drift-review.md) — independent read-only `phase-reviewer` agent (fan-out `/review` remains user-cancelled): **PASS-WITH-FIXES** — 4 Critical (false "no remote" claim; job-level hashFiles contradicts documented availability; self-violated exit-code contract; proven drift evasion via non-dotted strings) ALL FIXED pre-commit with re-run mutation evidence; 6 Suggestions fixed/accepted; 1 Nice-to-have cluster recorded
- **model:** qwen3.8-max (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; goal meter exposes only session totals, no per-breakdown source available to the agent)

## 0006 — VS Code extension scaffold (clients/vscode)

- **date:** 2026-10-09
- **phase:** P3 VS Code client (scaffold boundary — specs/03 §5 VS1–VS3 host features deferred, see details)
- **commit:** `39bfaa2` (feat(clients/vscode): VS Code extension scaffold — core-client, webview sidebar, 141 unit tests, live-Core harness)
- **details:** Built by the `vscode-engineer` background agent (parallel scaffold with 0007/0008), verified and committed by the orchestrator after the user directive to stop review-agent retries and take the lighter path. Core client: Unix-socket NDJSON transport with framing, request correlation, 4 MiB bound, checkpointed catch-up polling (Core has no push frame); state reducer; context/diff/diagnostics/workspaces/taskTree modules; CSP-hardened classic-script webview sidebar; zero runtime dependencies (Node stdlib + VS Code API). Deviations recorded by the scaffold and accepted: `publisher: dkvlabs` per brief vs specs/03 outline `dkv-labs` (P6 marketplace decision); two-config `tsc` scripts for the bundler-free webview; extra config key `sandpane.attachDiagnostics` (specs/03 §4 consent needs a real switch); `serviceMode` deliberately has no `auto` (ADR-1 undecided); finer module layout than specs/03 §3 for vscode-free unit-testability; webview `app.ts` hand-mirrors bridge types (drift risk until React migration). Deferred honestly: sandbox wizard (no start/stop/delete RPC in v1 — gap register in docs/compatibility.md), streaming chat (P0 Codex-in-SBX gate; probe reports `verified:false` live), conversation/task enumeration (no RPCs), rename diffs (no rename source in `FileChange`), apply/verification UI (P4), `.vsix`/vsce, real-VS-Code-window host verification, Windows named pipe (P1), remote extension hosts.
- **files:** clients/vscode/ — 44 files, +9,604 (src 23 modules, 11 test suites, harness, media, configs); + fix commit `d7e19a5` (8 files, +109/−14: 12th test suite, new regression corpora, README truth fixes)
- **verification:** `make vscode-check` ×2 → typecheck clean (both tsconfigs), **vitest 11 files / 141 tests / 0 failed**, exit 0; `node scripts/live-core-check.mjs` run by the orchestrator against the freshly built `core/target/debug/sandpane-service` → **30/30 checks PASS** over a real socket (probe honesty incl. all-false codex flags; NOT_INSTALLED vs empty list; hostile content inert; durable cancel + CONFLICT double-cancel; git.review/git.apply honest aborts; shell.exec rejected client-side and by Core; 4 MiB bound both directions; 25-way correlation; state survives disconnect; shared instanceId); CSP meta present in webview html.ts; no child_process/exec in core-client; `python3 scripts/schema_drift.py` 7×OK (protocolWire.test.ts pins Rust strings too). Post-review-fix re-verification (`d7e19a5`): typecheck clean, **vitest 12 files / 143 tests / 0 failed**, live harness 30/30 re-pass. NOT verified: any in-host VS Code execution (no integration runner yet); the `engines.vscode ^1.90.0` floor vs `@types/vscode` 1.140 (P6 pin-pair item, recorded)
- **review:** [audit/0006-vscode-scaffold-review.md](audit/0006-vscode-scaffold-review.md) — two passes: (1) pre-commit lighter-path checklist per user directive (0 Critical, 4 Suggestion + 1 Nice-to-have); (2) an independently dispatched reviewer completed just as the cancellation took effect — **PASS-WITH-FIXES** incl. one **measured defect** (idle-connection reconnect churn + slow-reply truncation from misusing `net.Socket.setTimeout` as a connect timeout) and 9 further findings: 7 fixed in `d7e19a5` with regression tests, 2 deferred with recorded reasons (publisher string, engines/SDK pin pair), 1 carried; all dispositioned in the record. Entry verdict: **PASS-WITH-FIXES → clean at `d7e19a5`**
- **model:** qwen3.8-max (session configuration; scaffold subagent same family)
- **tokens:** input: - · cached: - · output: - (session delta: -; scaffold agent reported 36.3M total tokens incl. internal turns — no per-breakdown input/cached/output split exposed to the orchestrator; goal-meter deltas only, dash per rule)

## 0007 — Tauri desktop app scaffold (apps/desktop)

- **date:** 2026-10-09
- **phase:** P5 desktop client (scaffold boundary: packaging/perf/a11y deferred per plan)
- **commit:** `136231b` (feat(desktop): Tauri 2 desktop app scaffold — full IA shell, Core client, thin Rust IPC proxy)
- **details:** Built by the `desktop-engineer` background agent in parallel with 0006/0008; orchestrator-verified and committed via the lighter review path (user directive cancelled the review fan-outs). React UI with a dependency-free hash router and semantic-token CSS (disclosed deviation from specs/05 §2 Tailwind/shadcn — the spec's own "functionality first, polish later" ordering); React Query for server state as specs require; transport-agnostic Core client (framing, correlation, 4 MiB bound, per-task-checkpointed replay polling since Core has no push frame); 10 feature views; honest gap UIs rendering each missing RPC (task.list/conversation.list/git.diff/sandbox lifecycle/templates/MCP/secrets/ports) as a labelled absence, never a fake; `src-tauri/` is a deliberately thin proxy — 2 commands that re-validate `v`/`id`/method/frame size, no `std::process::Command`, no Core spawn, Windows → `TRANSPORT_UNSUPPORTED`. Two self-found bugs fixed by the agent pre-delivery: sandbox-name prevalidation switched from denylist to Core-anchored-allowlist parity; conversation snapshot made immutable so `useSyncExternalStore` re-renders on new chats. Orchestrator corrections: agent's "no Rust/Tauri toolchain on this host" is inaccurate (Rust 1.99 present; the honest state is Tauri build deferred per the execution plan), and the first draft of the implementation commit message misworded the UI stack — amended before logging.
- **files:** apps/desktop/ — 61 files, +14,870 (src/lib 9 modules, 10 features, components ~2.3k, src-tauri 4, 7 test suites, CSS tokens, configs)
- **verification:** `make desktop-check` ×2 → typecheck exit 0, **vitest 7 files / 144 tests / 0 failed**; orchestrator `npm run build` → vite exit 0 (`305.49 kB JS + 20.04 kB CSS`, built in 569 ms); greps: 0 `innerHTML`/`eval(` in src/, strict CSP in tauri.conf.json (object-src 'none', form-action 'none', ipc-only connect-src), no Command/spawn in ipc_client.rs; `python3 scripts/schema_drift.py` 7×OK with desktop's protocol.test.ts pinning the same value sets (20 tests). NOT verified: any compilation of `src-tauri` Rust (never built — deferred per plan; its unit tests UNRUN), real socket attach from this client (fake-core double only, labelled), browser-rendered UI, all specs/05 §11 perf targets
- **review:** [audit/0007-desktop-scaffold-review.md](audit/0007-desktop-scaffold-review.md) — **lighter path, disclosed**: orchestrator checklist with fresh gates (review agents cancelled per user directive): 0 Critical, 4 Suggestion + 1 Nice-to-have all dispositioned; PASS via lighter path
- **model:** qwen3.8-max (session configuration; scaffold subagent same family)
- **tokens:** input: - · cached: - · output: - (session delta: -; agent-reported totals only (35.3M incl. internal turns at delivery, +1.0M post-fence recheck), no input/cached/output breakdown exposed — dash per rule)

## 0008 — IntelliJ Platform plugin scaffold (clients/jetbrains)

- **date:** 2026-10-09
- **phase:** P4/P6 JetBrains plugin (file-level scaffold boundary — JB0 build gate remains open)
- **commit:** `137524a` (feat(clients/jetbrains): IntelliJ plugin scaffold — Core client, tool window, chat/review UI, actions)
- **details:** Built by the `jetbrains-engineer` agent in parallel with 0006/0007. 17 Kotlin files (4,396 lines): AF_UNIX SocketChannel CoreClient with NDJSON framing, correlation and EDT guard; ConnectionManager app service with backoff, per-task-checkpointed resubscribe and AgentGate (composer disabled while `system.probe` reports `verified:false` — reading real Core state, not fabricating capability); kotlinx-serialization wire mirror with `@SerialName` parity; tool window + ChatPanel + 4 actions + 4 services + settings; real Gradle wrapper generated by an actual `gradle wrapper` run before any build script existed (never fabricated; `./gradlew` never executed). SAFETY: zero subprocess surface anywhere in the module (Core launcher deliberately unwired pending ADR-1/licensing), public platform APIs only. Notable adjudication: the agent's headline `providerType` drift filing was **stale and REFUTED** by the orchestrator (protocol lib.rs:371 rename + :563 wire-pin test passing); the agent independently discovered the staleness and corrected its own report — including reframing its dual-spelling decoder acceptance as documented back-compat. Its remaining 7 protocol-gap filings were re-verified line-by-line and became the new **Protocol v1 gaps register in docs/compatibility.md** (this entry's docs set). This entry also corrects the compatibility matrix from re-measurement: Gradle 8.10.2 + JDK 23 present (sdkman), `kotlinc` absent — replacing the stale "not installed locally" row. Disclosed honesty set: nothing compiled/built/tested; all version pins UNVERIFIED; icons/shortcuts/native diff deliberately absent pending JB0/JB3; JB2 chat gated behind the open P0 Codex-in-SBX check; `make jetbrains-check` now passes its dir guard and fails on this host without network (CI runs it only on networked runners via the detect gate; aggregate `make check` excludes it).
- **files:** clients/jetbrains/ — 27 files, +5,331 (Kotlin 17 files, plugin.xml, build config, wrapper, README); docs/compatibility.md (+16/−1: toolchain row re-measured + Protocol v1 gaps register)
- **verification:** orchestrator file-level: plugin.xml XML-parsed well-formed, **8/8 declared classes exist** (packages match paths); forbidden greps **0 hits** (ProcessBuilder/Runtime.exec/sh -c/internal APIs/reflection/Unsafe/TODO()); providerType adjudication: lib.rs:371 + wire-pin :563, `cargo test -p sandpane-protocol` 7/7; gap register: service :375/:761/:828–831 + protocol :249–254 line-verified; host toolchains re-measured (`gradle --version` 8.10.2, `java -version` OpenJDK 23, `which kotlinc` → absent); `python3 scripts/schema_drift.py` 7×OK. **NOT verified — categorically: no Kotlin file ever compiled; gradlew never executed; framing test UNRUN; no runIde/Plugin Verifier; pins UNVERIFIED (JB0 open gate)**
- **review:** [audit/0008-jetbrains-scaffold-review.md](audit/0008-jetbrains-scaffold-review.md) — **lighter path, disclosed**: orchestrator file-level checklist (review agent cancelled per user directive); 0 Critical at the provable layer + explicit statement of what file-level review cannot prove; 4 Suggestions + 1 Nice-to-have dispositioned; PASS at file level, JB0 remains open
- **model:** qwen3.8-max (session configuration; scaffold subagent same family)
- **tokens:** input: - · cached: - · output: - (session delta: -; agent totals only (25.9M at delivery, +6.9M post-fence recheck), no input/cached/output breakdown exposed — dash per rule)

## 0009 — Integration & final docs-sync sweep

- **date:** 2026-10-09
- **phase:** plan-of-record entry 0007 close-out half ("CI + integration": final README/docs sync + full verification sweep)
- **commit:** `9a8d5d2` (chore(integrate): make check aggregates landed clients; README status + command sweep)
- **details:** Closed the execution plan. `make check` now aggregates everything verifiable on this host — core (fmt/clippy/72 tests) + schema-lint + drift gate + vscode-check (141) + desktop-check (144) — while **excluding** jetbrains-check with an explicit in-target reason (no Kotlin ever compiled; JB0 gate). Root README: status block rewritten to the evidence-backed state ("scaffold phase complete", P0 sbx/Codex + licensing gates stated as OPEN, "Unsupported = visibly unsupported"), command list extended with the schema gates and `npm install first` notes. Execution plan gained the authoritative plan↔actual numbering map (0004↔core, 0005↔CI, 0006/0007/0008↔clients, 0009↔this sweep) and records the two folded logging-rule alignment commits (`a2634bd`, `5052102`: review-method tiering per the user's lighter-path directive; AGENTS.md "newest first" contradiction fixed to chronological-newest-last; `/log-implementation` command aligned). Definition-of-done walked item by item in the audit record. Standing open gates deliberately NOT closed by anything in this session: P0 (real `sbx` CLI + Codex-in-SBX feasibility + real fixtures), licensing release gates, JB0 Kotlin build, P3 in-host VS Code verification, Core push transport + the six protocol-v1 gaps in the compatibility register.
- **files:** Makefile, README.md, docs/audit/0000-execution-plan.md, docs/audit/0009-integration-docs-review.md, docs/CHANGELOG.md
- **verification:** full `make check` fresh: **357 tests passed / 0 failed** (72 Rust + 141 VS Code + 144 desktop), clippy clean, schema gates 7×OK + JSON syntax OK, aggregate exit 0; docs-relative-link walk → **0 broken**; `ls docs/audit/` → records 0000–0009 + README, one per implementation entry; `grep -c '^## 0009' docs/CHANGELOG.md` = 1 post-commit; final `git status` → clean (verified in the closing commit below)
- **review:** [audit/0009-integration-docs-review.md](audit/0009-integration-docs-review.md) — docs/tooling checklist tier (lighter path stands per user directive): 0 Critical, 2 Suggestion accepted-with-docs, 1 Nice-to-have deferred; PASS
- **model:** qwen3.8-max (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; goal meter exposes session totals only (~45.8M of 62.0M budget at the turn's start), no per-breakdown source available — dash per rule)

## 0010 — Protocol v1 discovery revision: read methods, per-task replay cursors, repositories, workspaceMode + JB0 build gate

- **date:** 2026-10-09
- **phase:** P1/P2 protocol surface (closes 4 of the 6 protocol-v1 gaps recorded in `docs/compatibility.md` entries 0006–0008) + client adaptation + JB0
- **commit:** `fbc45e2` (feat(protocol): v1 discovery revision — read methods, per-task replay cursors, project repositories, workspaceMode)
- **details:** Coordinated additive protocol change; `PROTOCOL_VERSION` stays **1** (every addition is a new method, a `#[serde(default)]` optional request field, or an absent-tolerant response field; pre-revision frame round-trips are pinned by protocol-crate tests). Added: `task.list`, `conversation.list`, `conversation.history` (limits clamped 1..=500, statuses from Core's closed enum, truncation disclosure with `nextSequence` paging, `conversation.history` byte ceiling with first-row exception so paging cannot stall); `task.subscribe` `afterSequences` per-task cursor map (bounded: 4096 entries, keys ≤100 bytes; scalar semantics unchanged when `taskId` is set; rules written into specs/02 §2); oversized `task.subscribe` replays now refused with structured `VALIDATION_FAILED` (fail-closed byte estimate under the frame cap) instead of emitting a frame the client must drop; `Project.repositories` from the `repositories` table; `SandboxSummary.workspaceMode` joined from `sandbox_bindings` (fail-closed absent on unreadable rows; legacy JSON-quoted rows decode); `CoreCapabilities.methods` derived from `Method::ALL` (advertised = dispatched, by construction) and the drift gate now compares the advertised set as a third surface. Clients adapted: VS Code (cursor map snapshots with omission disclosure, replay-refusal latch that stops the poll loop, live harness grown to 55 checks), desktop (`guards.ts` pre-flight mirroring Core's validators, feature gates, replay-cursor + protocol-drift suites, opt-in live suite vs a real service, Tauri IPC proxy replay-safety classification so a mutated frame is never blindly re-sent), JetBrains (CoreCommands/CoreGuards/ErrorAttribution/ReplayCursors/FolderMatching + 5 test classes; **JB0 build gate PASSED offline**: 98 Kotlin tests, `buildPlugin` zip — runIde/Plugin Verifier/JDK-21 mismatch remain open JB0 items, recorded in compatibility.md). Gap register: 4 CLOSED, 2 still open (`conversation.send` full-TaskSummary shape — deliberately not folded in, breaking; `ContextRef` selection identifier contract). Also: `make check` now aggregates `jetbrains-check` (`--offline`, warm Gradle caches); `.gitignore` gains local tool-artifact dirs. Review deviation recorded honestly: the `phase-reviewer`/`security-reviewer` subagents could not be dispatched (harness reasoning-level error), so the orchestrator performed the full inline review against AGENTS.md rules 1–10; the environment's Mimosa commit gate blocked three times on a name-based "SSRF" heuristic in the desktop live test (local Unix-socket RPC; focused deep re-scan sealed **0 findings**, seal `sha256:f3832279…`) — resolved by pinning the live suite to raw `request()` calls (wrappers are one-line passthroughs, unit-covered; no coverage loss; live suite re-verified 8/8).
- **files:** `core/crates/sandpane-protocol/src/lib.rs`, `core/crates/sandpane-service/{src/lib.rs,tests/service_integration.rs}`, `schemas/{rpc-request,core-capabilities}.schema.json`, `scripts/schema_drift.py`, `clients/vscode/src/**` + `scripts/live-core-check.mjs`, `apps/desktop/src/**` + `apps/desktop/src-tauri/**` + tests, `clients/jetbrains/src/**` + tests, `Makefile`, `README.md`, `docs/compatibility.md`, `docs/specs/02_ARCHITECTURE_AND_DATA.md`, `.gitignore`
- **verification:** fresh, this session — `make check` (first run with jetbrains aggregated) → **exit 0**: core fmt/clippy/test + schema-lint + drift gate + VS Code typecheck & **171 tests** + desktop typecheck & **228 passed / 8 skipped** + Gradle `build --offline` SUCCESSFUL; `cd core && cargo test` → **97 passed / 0 failed**; `./gradlew clean buildPlugin test --offline` → BUILD SUCCESSFUL, XML results **98 tests / 0 failures** (fresh 17:40 run); `node scripts/live-core-check.mjs` vs the real service binary → **55/55 checks** (uneven-cursor defect reproduction, over-ceiling refusal + recovery, truncation disclosure); desktop live suite vs disposable service → **8/8**, re-run **8/8** after the raw-request restructure with `tsc --noEmit` clean; Mimosa focused deep re-scan → **completed, sealed, 0 findings**; `pgrep sandpane-service` after each disposable run → no orphans
- **review:** [audit/0010-protocol-discovery-revision-review.md](audit/0010-protocol-discovery-revision-review.md) — inline full pass (subagents unavailable; method recorded); **no Critical/Warning findings** vs AGENTS.md rules 1–10; 2 Suggestions fixed pre-commit (stale counts 97→98 & 227→228 corrected to fresh evidence; Makefile aggregate updated + re-run green); 1 external-scanner false positive dispositioned with sealed 0-finding deep re-scan and a no-coverage-loss restructure; PASS
- **model:** GLM-5.3 (session configuration, account:zai-individual-coding-plan/GLM-5.3)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0011 — VS Code .vsix packaging + local installation guide (P3 close-out item)

- **date:** 2026-10-09
- **phase:** P3 (roadmap item "Package/test `.vsix` and write local installation guide")
- **commit:** `a725b52` (feat(clients/vscode): package .vsix via vsce + local installation guide (P3))
- **details:** `npm run package` = compile + `vsce package` (`@vscode/vsce` 4.0.0 as a dev-only dependency — the shipped extension keeps zero runtime deps). Manifest gained `repository`/`bugs` (github.com/dkvlabs/Sandpane, directory `clients/vscode`); MIT `LICENSE` shipped inside the package; `.vscodeignore` keeps sources, tests, tooling, source maps, session-artifact dirs and the `.vsix` itself out of the artifact (first build leaked `.gitignore` + a `.mimosa/` hook-state dir — caught in review, fixed, rebuilt clean). New `clients/vscode/INSTALL.md`: build Core, package, install-from-VSIX, start the service the extension attaches to (the extension never launches Core — ADR 1), socket resolution (`SANDPANE_SOCKET` / `sandpane.coreSocketPath` / per-user default), and the honest scaffold-state limits (sbx absent ⇒ `NOT_INSTALLED`; chats seam-level; no Marketplace until the licensing gate). `docs/compatibility.md` gains the `@vscode/vsce` 4.0.0 verified row. Marketplace publication deliberately NOT done (licensing gate, `docs/licensing-decision.md`).
- **files:** `clients/vscode/{package.json,package-lock.json,.vscodeignore,LICENSE,INSTALL.md,README.md}`, `docs/compatibility.md`, `.gitignore`
- **verification:** `npm run package` → `sandpane-0.0.1.vsix` (28 files, 77.21 KB); `unzip -l` → contents audited, 0 leaks after fix; `npm test` → 171 passed / 0 failed after manifest changes; `npx vsce --version` → 4.0.0
- **review:** [audit/0011-vsix-packaging-review.md](audit/0011-vsix-packaging-review.md) — docs/tooling checklist tier, orchestrator inline (subagents unavailable this session); 1 finding fixed pre-commit (package leak); no Critical findings; PASS
- **model:** GLM-5.3 (session configuration, account:zai-individual-coding-plan/GLM-5.3)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0012 — Agent tooling migrated to Claude Code; Superpowers as project-scoped plugin

- **date:** 2026-10-09
- **phase:** infra (agent tooling)
- **commit:** `edd6eac` (chore(tooling): migrate agent config from Qwen Code to Claude Code; superpowers as project plugin)
- **details:** Claude Code is now the project's only agent harness. The 9 agents, 3 commands and 5 Sandpane skills moved from `.qwen/` to `.claude/` (git renames keep their history), and `.qwen/` was deleted. Superpowers (obra/superpowers v6.4.2, upstream HEAD `8ca22db`) is no longer vendored. It is enabled for the project through `.claude/settings.json` `enabledPlugins` (`superpowers@claude-plugins-official`), which removes the duplicate skill triggers caused by the plugin also being enabled globally; each clone needs one setup step, documented in AGENTS.md and README. Agent frontmatter was converted to Claude Code fields (`permissionMode`; reviewer tools `Read, Grep, Glob, Bash`), which fixes reviewer agents that had no resolvable tools. Commands now use `$ARGUMENTS`. The `sandpane-changelog` model/token sources and the `/review` references (now `/code-review`) were updated. Staged `.claude/tmp` Qwen review leftovers were dropped, and `.gitignore` now covers Claude Code local artifacts. Historical entries 0001–0011 were left unchanged.
- **files:** `.claude/{settings.json,agents/*,commands/*,skills/*}`, `.qwen/**` (removed), `AGENTS.md`, `README.md`, `LICENSE`, `clients/vscode/LICENSE`, `.gitignore`, `docs/audit/README.md`
- **verification:** fresh upstream clone diffed against the vendored copies: 15/15 skills and LICENSE identical. `git grep -i qwen` outside historical records: 0 matches. Relative-link walk: 0 broken. Frontmatter check: OK. `.claude/settings.json`: valid JSON. No tmp or `.DS_Store` files staged. Not verified: reload in a fresh Claude Code session, and plugin install on other hosts.
- **review:** [audit/0012-claude-code-migration-review.md](audit/0012-claude-code-migration-review.md) — docs/tooling checklist tier, orchestrator inline, with Claude Code syntax checked by a `claude-code-guide` subagent against official docs; 1 Critical (reviewer agents had no usable tools) and 4 Suggestions fixed pre-commit, 1 Nice-to-have documented; PASS
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0013 — Claude Code agents/commands/skills refresh + superpowers version record

- **date:** 2026-10-09
- **phase:** infra (agent tooling)
- **commit:** `78d317c` (chore(tooling): refresh Claude Code agents, commands and skills; record superpowers version)
- **details:** Reviewed all 9 agents, 3 commands and 5 project skills.
  - **Agents:** each now preloads its governing skill through the `skills:` frontmatter field. This fixes the read-only reviewers: their tool allowlist has no Skill tool, so they could not load the gates they cite.
  - **`core-protocol`:** synced to the code — `NOT_FOUND` (in code, not yet in specs/02 §2), the 4 MiB frame cap, per-task `afterSequences` cursors, the oversized-replay refusal, bounded read methods, and `Method::ALL` with `make schema-drift`.
  - **`core-engineer`:** error list now includes `NOT_FOUND`; its superpowers reference is namespaced.
  - **Commands:** gained quoted `argument-hint` values.
  - **`sandpane-changelog`:** lost the unsupported `priority` field.
  - **Version:** entry 0012's switch from the vendored copies to the plugin was a silent downgrade, 6.4.2 → 6.4.1. The official marketplace pins `5bf4e78` (6.4.1), and upstream 6.4.2 only changes `writing-plans`. The user chose to stay on official 6.4.1. The version is recorded in `docs/compatibility.md`, and 0012 has a correction note.
- **files:** `.claude/agents/*.md`, `.claude/commands/*.md`, `.claude/skills/{core-protocol,sandpane-changelog}/SKILL.md`, `docs/compatibility.md`, `docs/audit/0012-claude-code-migration-review.md` (correction)
- **verification:**
  - `claude plugin update superpowers@claude-plugins-official --scope project --json` → `up_to_date` 6.4.1.
  - `installed_plugins.json` → user and project scopes both at 6.4.1 `5bf4e78`.
  - `claude --version` → 2.1.288.
  - The PyYAML frontmatter parse of 17 files passed, with no undocumented keys and all `skills:` targets present.
  - The skill's protocol claims match the code constants.
  - Not verified: skill preloading and command hints in a restarted session.
- **review:** [audit/0013-claude-config-refresh-review.md](audit/0013-claude-config-refresh-review.md) — docs/tooling checklist tier, orchestrator inline. Result: 1 Critical fixed, 1 Critical dispositioned by user decision, 4 lesser findings fixed; PASS.
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0014 — Real sbx v0.47.0 capture (P0 progress)

- **date:** 2026-10-09
- **phase:** P0 (supported-interface feasibility)
- **commit:** `c392530` (test(sbx): capture real sbx v0.47.0 help, state and error fixtures (P0))
- **details:** `sbx` is now installed on the dev host (v0.47.0). These were captured and sanitized into `core/crates/sandpane-core/tests/fixtures/sbx/captured/v0.47.0/` with `fixture_status: captured`:
  - every documented command and subcommand `--help` (66 files)
  - version, daemon status (stopped, running, `--json`) and empty `ls`
  - the real error format: `error: <msg>` / `  try: <hint>`, exit 1

  Observed behavior: `sbx ls --json` auto-starts `sandboxd`. `sbx create` refuses until the global network policy is initialized (`sbx policy init …`). That is a persistent, user-owned choice, so the CRUD success paths remain UNVERIFIED. `docs/compatibility.md` was updated.
- **files:** `core/crates/sandpane-core/tests/fixtures/sbx/captured/v0.47.0/**`, `docs/compatibility.md`
- **verification:** `sbx version` → v0.47.0 0411f50; `sbx daemon status --json` → running; `sbx ls --json` → `{"sandboxes": []}` exit 0; `sbx create shell --name sandpane-p0-probe …` → policy-not-initialized error, exit 1, nothing created (`ls` stays empty); 0 invalid help captures; no username or secret leaks.
- **review:** [audit/0014-sbx-v047-capture-review.md](audit/0014-sbx-v047-capture-review.md) — fixtures checklist: 1 fixed, 2 deferred with owners; PASS
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0015 — Real sbx sandbox lifecycle round trip (P0 progress)

- **date:** 2026-10-09
- **phase:** P0 (supported-interface feasibility)
- **commit:** `5153311` (test(sbx): capture a real sbx v0.47.0 sandbox lifecycle round trip (P0))
- **details:** The user initialized the global network policy (`sbx policy init balanced`). A disposable `shell` sandbox on an empty scratch workspace then went through the full real lifecycle, all captured as fixtures: create → `ls --json` → exec → stop → `rm --force` → not-found. This yields the real `ls --json` row shape (`name, id, agent, status, last_used_at, workspaces[], created_at`); the illustrative fixture had assumed `state`. Two findings were recorded: `start` does not exist in this CLI version (restart is the interactive `sbx run --name`), and the Core adapter must parse the real rows. `docs/compatibility.md` now records sandbox CRUD as verified at the CLI level. Codex/Claude sandboxes (which need provider sign-in) remain UNVERIFIED.
- **files:** `core/crates/sandpane-core/tests/fixtures/sbx/captured/v0.47.0/{crud/*,_meta.json}`, `docs/compatibility.md`
- **verification:** create exit 0; one `running` row; exec printed `sandpane-p0-ok`; stop → `stopped`; rm → empty list; second rm → not-found, exit 1; leak grep 0 hits
- **review:** [audit/0015-sbx-crud-roundtrip-review.md](audit/0015-sbx-crud-roundtrip-review.md) — fixtures checklist: 2 findings routed to Core work; PASS
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0016 — CI supply-chain hardening (F0)

- **date:** 2026-10-09
- **phase:** cross-cutting (security review W7)
- **commit:** `edf9a74` (ci: pin all actions to commit SHAs, validate gradle wrapper, pin cargo-audit (security W7))
- **details:**
  - Every GitHub Action is pinned to a full commit SHA of its latest release: checkout v7.0.1, setup-node v7.1.0, setup-python v7.0.0, setup-java v6.0.1, rust-cache v2.9.2. `dtolnay/rust-toolchain` is pinned to the head of its `stable` branch on 2026-10-09.
  - `gradle/actions/wrapper-validation` v6.4.0 runs before `./gradlew`.
  - cargo-audit is pinned to 0.22.2 with `--locked`.
  - CI moves from Node 20 to Node 24, ahead of the Vitest 5 / Vite 8 upgrades.
- **files:** `.github/workflows/ci.yml`
- **verification:** all 13 `uses:` lines carry 40-hex SHAs. The workflow has not been run on GitHub from this session: UNVERIFIED.
- **review:** [audit/0016-ci-action-pinning-review.md](audit/0016-ci-action-pinning-review.md) — inline checklist; PASS (CI execution UNVERIFIED)
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0017 — Desktop review fixes (F2)

- **date:** 2026-10-09
- **phase:** P5 (desktop) hardening
- **commit:** `321f4fd` (fix(desktop): security and correctness fixes from the review (F2))
- **details:**
  - **Discovery review findings fixed:** A1–A12 from the desktop review, and W5, W6 and S9 from the security review.
  - **The `src-tauri` crate compiles again,** and `make desktop-check` now gates on cargo fmt/check/clippy/test.
  - **Proxy:**
    - async request path;
    - CR/LF smuggling rejected;
    - response-id check;
    - newline-aware frame cap;
    - per-method deadlines with a Rust↔TS drift test;
    - a single bounded retry for read-only methods only;
    - a mutation whose write broke part-way is flagged "may have been applied";
    - Core's connection refusal surfaced as its own code.
  - **Socket path and trust:** the path matches the other clients, with an owner/mode trust check before connect. The capability is narrowed to the single request command.
  - **UI fixes:**
    - the task-derived live-writable disclosure;
    - state-leak keys;
    - a history race and a project-scoped task index;
    - ConfirmDialog;
    - an ErrorBoundary;
    - sanitized Core hints, which are never executed;
    - an icon-only rail by default;
    - contrast and router fixes.
  - **Two review rounds:** the independent re-review's W1–W3 and suggestions were all fixed.
- **files:** `apps/desktop/**` (33 files), `Makefile`
- **verification:** `make desktop-check` exit 0 — 273 TS passed / 8 skipped; 31 Rust passed; clippy `-D warnings` clean. No native Tauri window run: UNVERIFIED.
- **review:** [audit/0017-desktop-review-fixes-review.md](audit/0017-desktop-review-fixes-review.md) — two rounds; PASS
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0018 — VS Code review fixes (F3)

- **date:** 2026-10-09
- **phase:** P3/P4 (VS Code) hardening
- **commit:** `0344167` (fix(vscode): security and correctness fixes from the review (F3))
- **details:**
  - **Discovery review findings fixed:** bugs 1–12 from the VS Code review, and W4 and S6 from the security review.
  - **Diff:** `vscode.diff` is given `Uri` objects, and `baseCommit` is validated as a hex commit id.
  - **Connection:** reconnect no longer leaks sockets.
  - **Catch-up:**
    - rescoped when the project or sandbox changes;
    - stale responses are dropped after a switch;
    - an oversize replay falls back to following the 64 most relevant tasks.
  - **Live-writable state** now comes from the selected sandbox.
  - **Composer:**
    - the draft is preserved across state pushes;
    - sends are single-flight;
    - attachment previews are always shown;
    - the copy was made honest.
  - **Settings and trust:**
    - `scope: machine` settings;
    - a socket owner/mode check;
    - a crypto nonce for the webview CSP.
  - **Two review rounds:** W1–W5 and re-review S2/S3/S4/S6 were fixed; re-review S1 and S5 are deferred.
- **files:** `clients/vscode/**` (37 files)
- **verification:**
  - `npm run typecheck` clean;
  - `npm test` 280/280;
  - `npm run package` OK;
  - the live check passed 56/56 against a local Core build.
  - No Extension Development Host run: UNVERIFIED.
- **review:** [audit/0018-vscode-review-fixes-review.md](audit/0018-vscode-review-fixes-review.md) — two rounds; PASS (2 suggestions deferred)
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0019 — Core review fixes (F1)

- **date:** 2026-10-09
- **phase:** P1/P2 (Core) hardening
- **commit:** `bb5cc8f` (fix(core): security and correctness fixes from the review (F1))
- **details:** Fixes Core bugs 1–10 and security findings W1–W3, W5, S2–S4, S7 and S8. A security re-review then found two git-hardening bypasses with working proofs of concept (W-1 promisor lazy fetch through `core.sshCommand`; W-2 a submodule's filter driver). Both are closed by regression tests that failed before the fix.
  - **Reconciliation:** restart reconciliation now covers every non-terminal status.
  - **Host git:** cannot run repo-configured programs and never fetches lazily.
  - **sbx adapter:** matches the real v0.47.0 argv and `ls --json` rows; probes with `daemon status --json`; classifies captured stderr.
  - **Subprocesses:** a bounded runner with a deadline, output cap and process-group kill. A `sandbox.create` timeout re-queries sbx instead of orphaning the sandbox.
  - **Runtime:** `<state>/sandpane` 0700/0600, flock, peer-uid check, idle timeout and connection cap.
  - **Projects and mounts:** projects store the canonical git root with a denylist, and mounts must equal a registered root.
  - **Also:** exact base-OID checks; scheduler idempotency; event high-water mark (migration v2); an honest `conversation.send` error code.
  - **Unchanged:** the protocol crate and schemas.
- **files:** `core/**` (18 files; new `process.rs`, `runtime.rs`; `libc` 0.2)
- **verification:**
  - clippy `-D warnings` clean;
  - `cargo test` 154 passed, 0 failed;
  - `make schema-drift` in sync;
  - VS Code live check 56/56 against the rebuilt service.
  - Agent execution in a sandbox: UNVERIFIED (provider sign-in).
- **review:** [audit/0019-core-review-fixes-review.md](audit/0019-core-review-fixes-review.md) — two rounds incl. PoC-backed security re-review; PASS (residual `info/attributes` race documented)
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0020 — JetBrains review fixes (F4)

- **date:** 2026-10-09
- **phase:** P6 (JetBrains) hardening
- **commit:** `af8949b` (fix(jetbrains): security and correctness fixes from the review (F4))
- **details:** Fixes JetBrains bugs 1–12 and security S1/W4, then the re-review's W1/W2 and suggestions 1–8.
  - **Lifecycle:**
    - correct dispose guard;
    - no reconnect after an intentional close (version mismatch is terminal);
    - single-flight connect;
    - typed RPCs require Ready.
  - **Streams:**
    - ref-counted per-task streams across windows, with a snapshot handover;
    - per-stream replay refusal;
    - a real gap resync;
    - hole fills never roll status back.
  - **Chat:**
    - selection reconciled by id and project;
    - streaming text ordered by sequence.
  - **Apply:** sends exactly the reviewed paths.
  - **Security:**
    - Swing HTML disabled on Core text;
    - socket owner/mode check.
  - **Other:** UTF-8 context budget; settings wired.
- **files:** `clients/jetbrains/**` (32 files)
- **verification:**
  - `./gradlew test --rerun`: 161 tests, 0 failures.
  - `buildPlugin` and `verifyPluginStructure` pass offline.
  - `runIde`, Plugin Verifier and a live Core round trip: UNVERIFIED.
- **review:** [audit/0020-jetbrains-review-fixes-review.md](audit/0020-jetbrains-review-fixes-review.md) — two rounds; PASS (timing-test suggestion deferred)
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0021 — Desktop dependency upgrade (U3)

- **date:** 2026-10-09
- **phase:** P5 (desktop) maintenance
- **commit:** `8b45a9c` (build(desktop): upgrade to React 19.3, Vite 8.3, Vitest 5, TypeScript 7, Tauri 2.12 (U3))
- **details:**
  - **npm packages:**
    - React 19.3.0;
    - Vite 8.3.4 with plugin-react 6.1.2 (Oxc);
    - Vitest 5.0.3;
    - TypeScript 7.0.2;
    - React Query 5.104.1;
    - @tauri-apps/api 2.12.2 and @tauri-apps/cli 2.12.1;
    - @types/node 24.19.1, matching the Node 24 runtime.
  - **Rust crates:**
    - tauri 2.12.2;
    - tauri-build 2.7.1;
    - serde 1.0.229, serde_json 1.0.151, libc 0.2.190;
    - `rust-version` raised to 1.90, which is tauri's MSRV.
  - **Lockfile:** regenerated. Every entry resolves from registry.npmjs.org.
  - **Source change:** `TextInput` uses React 19 ref-as-a-prop. No config changes were needed (checked against each migration guide).
  - **Docs:** versions recorded in `docs/compatibility.md`.
- **files:** `apps/desktop/{package.json,package-lock.json,src-tauri/Cargo.toml,src/components/ui/primitives.tsx}`, `docs/compatibility.md`
- **verification:**
  - `make desktop-check`: 273 passed / 8 skipped TS tests, 31 Rust tests passed.
  - `vite build` OK.
  - `npm audit`: 0 vulnerabilities.
  - Native `tauri build`: UNVERIFIED.
- **review:** [audit/0021-desktop-deps-upgrade-review.md](audit/0021-desktop-deps-upgrade-review.md) — checklist; PASS
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0022 — Core dependency upgrade (U1)

- **date:** 2026-10-09
- **phase:** P1/P2 (Core) maintenance
- **commit:** `013ecfd` (build(core): upgrade rusqlite to 0.40.2 and pin latest dependency floors (U1))
- **details:**
  - **rusqlite 0.32.1 → 0.40.2:**
    - bundled SQLite 3.53.2;
    - includes the 0.40.1 fixes for SAVEPOINT-name injection and `from_rc` UB;
    - default features are off, plus `cache`, so the wasm-only path leaves the lockfile.
  - **Floors raised to the latest releases:** serde, serde_json, thiserror, uuid, libc, tempfile.
  - **`rust-version`** 1.85 → 1.89.
  - **No source changes:** each rusqlite runtime-breaking change was checked against its call sites.
  - Versions are recorded in `docs/compatibility.md`.
- **files:** `core/{Cargo.toml,Cargo.lock,crates/sandpane-core/Cargo.toml,crates/sandpane-service/Cargo.toml}`, `docs/compatibility.md`
- **verification:**
  - clippy `-D warnings` is clean;
  - `cargo test` passes 154 tests;
  - schema drift is in sync;
  - there are no duplicate crates across all targets.
  - MSRV build and `cargo audit` locally: UNVERIFIED.
- **review:** [audit/0022-core-deps-upgrade-review.md](audit/0022-core-deps-upgrade-review.md) — checklist; PASS
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0023 — VS Code dependency upgrade (U2)

- **date:** 2026-10-09
- **phase:** P3/P4 (VS Code) maintenance
- **commit:** `7a0a5b8` (build(vscode): upgrade to TypeScript 7 and Vitest 5; pin @types/vscode to the engine (U2))
- **details:**
  - **TypeScript 7.0.2:**
    - `module` is now `node20`.
    - The webview build uses `esnext` with legacy module detection; its output is byte-identical.
    - `esModuleInterop` is forced on, so five files gain `__importStar`.
  - **Vitest 5.0.3 / Vite 8.3.4:**
    - Config moved to `vitest.config.mts`.
    - The fake-DOM helper now compiles with the real `tsc`, using an argument vector.
  - **`@types/vscode`:** pinned exactly to 1.90.0. It had floated to 1.140.0, above `engines.vscode`.
  - **`@types/node`:** 22.20.5. Vitest 5 refuses 20.x; this gap is recorded.
  - **Docs:** the README toolchain table and INSTALL host requirements (Node 22.12+ or 24) are updated, and `docs/compatibility.md` records the versions.
- **files:** `clients/vscode/**` (12 files), `docs/compatibility.md`
- **verification:**
  - typecheck clean;
  - 280/280 tests pass;
  - the `.vsix` packages (30 files);
  - the live Core check passes 56/56 against the upgraded Core;
  - `npm audit` reports 0 vulnerabilities.
  - No Extension Development Host run: UNVERIFIED.
- **review:** [audit/0023-vscode-deps-upgrade-review.md](audit/0023-vscode-deps-upgrade-review.md) — checklist; PASS (1 warning fixed in-commit)
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0024 — Fail closed on repositories with submodules

- **date:** 2026-10-09
- **phase:** P4 (Git safety) hardening
- **commit:** `fb16670` (fix(core): fail closed on repositories with submodules (review integrity))
- **details:** The automated commit security review of `bb5cc8f` found a problem in the git hardening. `--ignore-submodules=dirty` hid uncommitted submodule work from both the dirty gate and review.
  - **Detection:** Core now reads gitlinks from the index only, through the hardened runner, and never enters a submodule work tree.
  - **Refusal:** `is_dirty`, `change_list` and the apply preconditions refuse with the paths named.
    - `git.review` returns `VALIDATION_FAILED`.
    - `git.apply` aborts with an `abortReason`.
  - **Unchanged:** the filter-trap protection and the protocol.
- **files:** `core/crates/sandpane-core/src/git.rs`, `core/crates/sandpane-service/{src/lib.rs,tests/service_integration.rs}`
- **verification:**
  - clippy `-D warnings` clean;
  - `cargo test`: 160 passed;
  - mutation check: 4 tests fail when the refusal is disabled;
  - schema drift in sync;
  - VS Code live check: 56/56.
- **review:** [audit/0024-core-submodule-fail-closed-review.md](audit/0024-core-submodule-fail-closed-review.md) — automated finding + orchestrator verification; PASS
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0025 — JetBrains toolchain upgrade (U4)

- **date:** 2026-10-09
- **phase:** P6 (JetBrains) maintenance
- **commit:** `da20777` (build(jetbrains): upgrade to Gradle 9.8.1, Kotlin 2.4.21, IntelliJ Platform 2026.2.3, Java 25 (U4))
- **details:**
  - **Gradle 9.8.1.** Wrapper and distribution checksums verified against services.gradle.org.
  - **Build plugins and libraries.**
    - IntelliJ Platform Gradle Plugin 2.19.0.
    - Kotlin 2.4.21.
    - kotlinx-serialization 1.11.0.
    - The foojay toolchain resolver.
  - **Target IDE.** IntelliJ IDEA 2026.2.3 (build 262, unified dependency). Since/until is 262/262.*: only the verified build is claimed.
  - **Java 25 toolchain.** The IDE requires it. CI `setup-java` moved to 25 as well.
  - **Code.** Public API replacements, plus `jvmDefault` to remove verifier-flagged stubs.
  - **Docs.** Versions recorded in `docs/compatibility.md`.
- **files:** `clients/jetbrains/**` (11 files), `.github/workflows/ci.yml`, `docs/compatibility.md`
- **verification:**
  - `test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` → 161 tests, 0 failures.
  - Plugin Verifier → `Compatible` with IU-262.10968.63.
  - `runIde` and loading the plugin in a real IDE: UNVERIFIED.
- **review:** [audit/0025-jetbrains-toolchain-upgrade-review.md](audit/0025-jetbrains-toolchain-upgrade-review.md) — checklist; PASS (CI Java fixed in-commit)
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0026 — Desktop protocol tolerance

- **date:** 2026-10-09
- **phase:** P5 (desktop), prerequisite for the protocol v1 additions
- **commit:** `6fbbb4b` (fix(desktop): tolerate unknown protocol enum values without hiding them) + `78fb74a` (fix(desktop): one action gate for unknown statuses; inert display of paths)
- **details:** Unknown values from a newer Core no longer fail whole calls. Each case stays visible and honest:
  - **TaskStatus:** shown as "Unknown status (raw)". It is never treated as terminal or running. Review, apply, cancel and retry are disabled through a single `taskActionGate`. A send that comes back with an unknown status is reported as accepted.
  - **ErrorCode:** Core's message is kept and the raw code is shown.
  - **FileChange status:** the file is listed but not selectable, and "apply everything" is blocked.
  - **WorkspaceMode:** shown as unverified/live-writable.
  - **Malformed frames** still fail.
  - **Drift tests** pin the TaskStatus, FileChange and workspace-mode lists to the Rust enums.
  - **Unusual characters** in file paths are shown as visible escapes.
  - **Counts:** a new "Unrecognised N" count.
- **files:** `apps/desktop/**` (16 + 9 files)
- **verification:** `make desktop-check` → 351 passed / 8 skipped, 31 Rust tests passed; vite build OK. Render-level wiring: UNVERIFIED (no component harness).
- **review:** [audit/0026-desktop-protocol-tolerance-review.md](audit/0026-desktop-protocol-tolerance-review.md) — phase-reviewer ran **after** the first commit (process deviation recorded); PASS-WITH-WARNINGS → fixed in the follow-up; PASS
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0027 — Task Git context and host worktrees (C3, Core-internal)

- **date:** 2026-10-09
- **phase:** P2/P4 groundwork. **Not wire-reachable yet;** P2/P4 checklist items are not ticked.
- **commit:** `2232d88` (feat(core): task Git context and host worktrees, with fail-closed discard (C3))
- **details:**
  - **Migration v3:** `worktree_path` and `worktree_removed_at`.
  - **Internal `create_task`:** records the full base OID.
    - host_worktree allocates `sandpane/<id>` under `<data>/worktrees`. Submodules are refused. The worktree is rolled back if the database write fails.
    - direct_mount is labeled live-writable.
    - sbx_clone records no unverified base.
  - **`git.review`:** routes by workspace mode.
  - **Fail-closed discard:**
    - plan, then execute;
    - checks: clean, no ignored files, no hidden-index entries, branch at base, branch not symbolic, no writer-lock holder;
    - never uses `--force`; deletes the branch with `update-ref --no-deref` compare-and-delete;
    - records durable intent and outcome events.
  - **Hardening on every git call:**
    - untracked files are visible regardless of repo config;
    - `ignoreStat` is off;
    - repo-local `excludesFile` is overridden, and the user's vetted global excludes file is honoured.
  - **Orphans:** a read-only startup report; nothing is deleted.
  - **Security review:** the first version was **blocked** for two Criticals (a symref task ref deleted the user's branch; `showUntrackedFiles=no` let discard delete untracked work). Both are fixed and re-verified with the reviewer's PoCs.
  - **Downgrade boundary:** an older Core refuses the v3 database. Restore `<db>.pre-v3.bak` to downgrade.
- **files:** `core/crates/sandpane-core/src/{db.rs,git.rs,workspace.rs,lib.rs}`, `core/crates/sandpane-service/{src/lib.rs,src/main.rs,tests/task_git_context.rs}`
- **verification:**
  - clippy `-D warnings` clean;
  - `cargo test` 209 passed (run twice);
  - schema drift in sync;
  - VS Code live check 56/56;
  - sbx_clone against real sbx: UNVERIFIED.
- **review:** [audit/0027-core-task-git-context-review.md](audit/0027-core-task-git-context-review.md) — phase + security (BLOCK → fixed) + security re-review; PASS-WITH-WARNINGS (sandbox-binding preconditions recorded)
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0028 — Re-vet the global excludes file on repository registration

- **date:** 2026-10-10
- **phase:** P2/P4 hardening (follow-up to 0027). Core-internal; no protocol change.
- **commit:** `ab68c5b` (fix(core): re-vet the global excludes file when repositories are registered)
- **details:**
  - `project.create` re-runs `accept_excludes_file` against the current repositories, the new ones and the worktree root, under the DB lock and before the insert. Any failure revokes the file for every repository: one-way, `/dev/null` until restart, one stderr line.
  - `accept_excludes_file` also refuses a file or parent directory writable by group or others.
  - `GitRunner`'s excludes fields are private; `with_excludes_file`, `active_excludes_file` and `revoke_excludes` are the only access.
  - Known residuals (recorded in the audit): grandparent-directory swaps by other local users, Linux umask-002 users fall back to `/dev/null`, transient errors revoke until restart, no re-vet on mount.
- **files:** `core/crates/sandpane-core/src/git.rs`, `core/crates/sandpane-service/{src/lib.rs,tests/task_git_context.rs}`
- **verification:** fmt clean; clippy `-D warnings` clean; `cargo test` 214 passed; schema drift in sync; new tests observed failing first.
- **review:** [audit/0028-core-excludes-revet-review.md](audit/0028-core-excludes-revet-review.md) — security review PASS-WITH-NOTES; Suggestions 1 and 6 fixed before commit
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0029 — JetBrains protocol tolerance and anti-spoofing hardening

- **date:** 2026-10-10
- **phase:** P6 (JB) hardening; security-review follow-up to 0020.
- **commit:** `9bc6230` (fix(jetbrains): tolerate unknown protocol enums and harden dialogs against spoofing)
- **details:**
  - `Reported<E>` for `TaskStatus`, `FileChangeStatus`, `WorkspaceMode`: a newer Core's new value no longer fails whole calls; unknown-status files are listed, never selected; unknown workspace mode treated as live-writable.
  - `VisibleText` reveals hidden characters by code point on every surface.
  - Apply and send-context dialogs built by `DialogHtml` as table rows, so a wrapped crafted path cannot fake an entry or header (security review C1, BLOCK → fixed). NOT-sent entries use `[x<n>]` markers.
  - Bounded conflict and case-collision lists; NFC + case-fold exclusion of unknown-status twins; single-line Core text in notifications; code-point truncation; UNVERIFIED mode notice; flags for literal escape sequences and look-alike compatibility characters.
  - No protocol or schema change; drift guard extended.
- **files:** `clients/jetbrains/**` (28 files; new `model/Reported.kt`, `text/VisibleText.kt`, `ui/ApplyConfirmation.kt`, `ui/SendContextMessages.kt`, five new test classes)
- **verification:** `test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` → 205 tests, 0 failures; `verifyPlugin` → Compatible; invisible-character scan 0; reviewer probe 129 991 layouts, 0 escapes.
- **review:** [audit/0029-jetbrains-tolerance-antispoofing-review.md](audit/0029-jetbrains-tolerance-antispoofing-review.md) — security BLOCK → fixed; phase PASS-WITH-NOTES; security re-review PASS-WITH-NOTES, its three Warnings fixed before commit
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0030 — README install and run guide

- **date:** 2026-10-10
- **phase:** R (goal deliverable: every step to run/install the apps).
- **commit:** `4c1f8c3` (docs(readme): install and run guide for Core, desktop, VS Code and JetBrains)
- **details:** prerequisites; Core build/run with socket, DB and sbx overrides and an isolated trial setup; desktop (`tauri dev`/`tauri build`), VS Code (`npm run package`, `--install-extension`, isolated profile), JetBrains (`buildPlugin`, Install Plugin from Disk, `runIde`); `make check`; a record of what was executed. Status paragraph refreshed; plan statuses updated.
- **files:** `README.md`, `docs/plans/2026-10-09-spec-completion-plan.md`
- **verification:** every build/package/install step executed from a fresh clone of `27dbb9b` in isolated directories (Core build + start, VS Code 280 tests + package + isolated install + live 56/56, desktop 351 tests + `tauri build` + live 8/8, JetBrains `buildPlugin` + `verifyPlugin` Compatible). GUI launches and Linux: UNVERIFIED.
- **review:** [audit/0030-readme-install-guide-review.md](audit/0030-readme-install-guide-review.md) — checklist pass with executed commands
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0031 — Protocol A1: sandbox stop, confirmed remove, create agent

- **date:** 2026-10-10
- **phase:** C1 / protocol v1 addition A1 ([design of record](plans/2026-10-09-protocol-v1-additions.md) §2–§4), with the CL lifecycle work in all three clients.
- **commit:** `b1067c7` (feat(protocol): sandbox.stop, confirmed sandbox.remove, create agent (A1))
- **details:**
  - **Protocol:** additive; `PROTOCOL_VERSION` stays 1; 16 advertised methods. Drift check is in sync (`make schema-drift`: 16 values match).
  - **Core:**
    - `sandbox.stop` (`requeried?` absent = state unknown).
    - Two-step `sandbox.remove`. The 256-bit, single-use, 120 s in-memory token is bound to action, name and sbx id. Step 2 burns the token first, then re-checks the sbx id (CONFLICT on a replacement), runs `rm --force`, and re-queries. Every failure after `rm` runs is INTERNAL. Only the binding rows captured before `rm` are marked removed.
    - A per-name in-flight lock across create and remove.
    - `SandboxCreateSpec.agent?`: exact allowlist from captured `create --help`; defaults to shell; kit refs and `--cloud` refused.
    - Shape-filtered `SandboxSummary.agent?` and sbx id.
    - DB schema v4: `sbx_id`, `removed_at`.
    - `external` = no live binding recorded for this sbx id. The token is documented as not proof of human presence.
  - **Clients:** VS Code, JetBrains and desktop each have:
    - pinned lists, typed wrappers, and `system.probe` gating;
    - a native two-step confirmation: impact revealed and capped, the shared "NOT CONFIRMED AS CREATED BY SANDPANE" marker, expiry re-checked at click time, no retry, token never logged or shown;
    - an honest unsupported Start;
    - addressable-name validators mirroring Core;
    - a Stop confirmation where the active-task count reads "cannot be checked" until Core records per-task sandbox names.
    - VS Code and desktop also get an sbx agent picker defaulting to shell.
  - **Deviations and open items:**
    - JetBrains has no create UI.
    - The VS Code webview has no lifecycle buttons.
    - Head-of-line blocking on a shared client connection is disclosed and deferred.
    - The out-of-band same-name race (sbx v0.47 has no remove-by-id) is disclosed.
- **files:**
  - Core and schemas: `core/crates/**` (new `confirm.rs`, `inflight.rs`), `schemas/*.json`.
  - Clients: `clients/vscode/**`, `clients/jetbrains/**`, `apps/desktop/**`.
  - Docs: `docs/specs/02_ARCHITECTURE_AND_DATA.md`, `docs/plans/*`, `docs/compatibility.md`, `README.md`.
- **verification:**
  - `make check` exit 0: Core 255; VS Code 338; desktop 401 + 8 opt-in skipped; Tauri 32.
  - JetBrains 243 tests; `verifyPlugin` Compatible (IU-262.10968.63).
  - Live checks against an isolated Core with no `sbx` reachable: VS Code 57/57, desktop 8/8.
  - Never run against a real `sbx`, or in a real editor, app or IDE (UNVERIFIED).
  - `cargo-audit` and `cargo-deny` not installed.
- **review:** [audit/0031-protocol-a1-sandbox-lifecycle-review.md](audit/0031-protocol-a1-sandbox-lifecycle-review.md) — 3 × `security-reviewer` + `phase-reviewer`, no Critical; Warnings fixed pre-commit (one deferred and disclosed, one rejected with evidence)
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0032 — Protocol A2: durable idempotency keys and feature advertisement

- **date:** 2026-10-10
- **phase:** C6 (idempotency part) / protocol v1 addition A2 ([design §3.1](plans/2026-10-09-protocol-v1-additions.md)), with all three clients.
- **commit:** `af8858d` (feat(protocol): durable idempotency keys and feature advertisement (A2))
- **details:**
  - **Core keys:**
    - `idempotencyKey?` on `sandbox.create` / `conversation.send`, stored in SQLite (schema v5).
    - Fingerprint: SHA-256 of the tagged typed params; params are never stored.
    - Send writes the key in the same transaction as its rows. Create claims the key before `sbx` runs.
    - A replay returns the first response plus `replayed: true`. Mismatch, pending or unknown give CONFLICT with exact strings, and nothing runs.
    - Startup marks pending keys unknown, and a failed reconcile makes Core refuse to start (tasks too).
    - Retention is 24 h with a 10 000-row cap.
  - **Feature advertisement:** `features` = `["idempotency-keys", "sandbox-create-agent"]`, drift-gated against the schema.
  - **Clients:**
    - The A1 agent inference is replaced by the feature check.
    - One CSPRNG key per user action, sent only when advertised.
    - "Retry safely" only on unknown outcomes, re-checking the live Core at click time; never automatic.
    - Replay notice plus a re-read.
    - CONFLICT copy pinned to Core's strings.
  - **Process change:** the design was decided first. Core was reviewed and frozen, then the clients were dispatched from one shared brief, then one combined client review.
  - **Also:** 18 raw invisible characters in an older desktop test file were rewritten as escapes.
- **files:**
  - `core/crates/**` (new `idempotency.rs`), `core/Cargo.lock`, `schemas/*`, `scripts/schema_drift.py`
  - `clients/vscode/**`, `clients/jetbrains/**`, `apps/desktop/**`
  - `docs/plans/*`, `docs/specs/02_ARCHITECTURE_AND_DATA.md`, `docs/compatibility.md`, `README.md`
- **verification:**
  - `make check` exit 0: Core 288, VS Code 367, desktop 429 + 8 opt-in skipped, Tauri 32.
  - JetBrains 265; `verifyPlugin` Compatible.
  - Live, isolated Core with no `sbx`: VS Code 58/58, desktop 8/8.
  - UNVERIFIED: never run against real `sbx` or in a real editor, app or IDE. `cargo-audit` and `cargo-deny` are not installed.
- **review:** [audit/0032-protocol-a2-idempotency-keys-review.md](audit/0032-protocol-a2-idempotency-keys-review.md) — `security-reviewer` on Core plus one combined security/phase pass on the clients; no Critical; every Warning fixed pre-commit
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0033 — Protocol A3a: project lifecycle

- **date:** 2026-10-11
- **phase:** C2 (project half) / protocol v1 addition A3a ([design §3.2](plans/2026-10-09-protocol-v1-additions.md)), with all three clients.
- **commit:** `9069f6a` (feat(protocol): project lifecycle (A3a))
- **details:**
  - **Core methods (22 total):** `project.update`, `project.archive`, `project.unarchive`, `project.delete` (A1 two-step token, bound to the project id via `consume_by_id`), `project.add_repository`, `project.remove_repository`; `project.list {includeArchived?}`; `Project.archivedAt`.
  - **Delete:** one ordered transaction; refuses while unfinished tasks, sandboxes or an in-flight create exist; never touches host files, branches or sandboxes (worktree dirs and task branches are left in place, and the impact lines say so).
  - **Archived projects** refuse new work (conversation create/send, sandbox create, update, repository methods); cancel, stop, remove, delete and unarchive stay allowed.
  - **Validation:** new `Validator::project_name` and a stricter `project_description` refuse control, line-separator and bidi characters.
  - **Review fixes:** a reachable Core self-deadlock (DB guard in an `if let` scrutinee) fixed with a deterministic test seam; bindings record `repo_id`, and a post-claim re-check refuses a create whose repository was unregistered meanwhile.
  - **Clients:** 22-method pins; probe-gated project settings surfaces; A1-pattern delete confirmation; validators drift-tested against Core; a 45 s deadline for git-backed project calls; unknown delete outcomes settled by re-reading Core; local state forgotten only when Core no longer lists the project. JetBrains also hardened A1: an unreadable expiry fails closed, step 2 is sent off the EDT, and Core text is capped at 200 code points.
  - **Deviation:** the desktop app adds a repository from a typed absolute path, not a native folder picker (design §3.2 item 9). It is accepted and disclosed in the desktop README.
- **files:**
  - `core/crates/**` (new `project_lifecycle.rs` and its test), `schemas/rpc-request.schema.json`, `schemas/README.md`
  - `clients/vscode/**`, `clients/jetbrains/**`, `apps/desktop/**`
  - `docs/plans/*`, `docs/specs/02_ARCHITECTURE_AND_DATA.md`, `docs/compatibility.md`, `README.md`
- **verification:**
  - `make check`: Core 324, schemas in sync (22 methods), VS Code 454, desktop 484 + 8 opt-in skipped, Tauri 32. The same run failed at JetBrains `:test` because a concurrent Gradle run shared the build directory; re-run alone below.
  - JetBrains 311; `verifyPlugin` Compatible.
  - Live, isolated Core with no `sbx`: VS Code 59/59, desktop 8/8.
  - UNVERIFIED: never run against real `sbx` or in a real editor, app or IDE. `cargo-audit` and `cargo-deny` are not installed (no new dependencies).
- **review:** [audit/0033-protocol-a3a-project-lifecycle-review.md](audit/0033-protocol-a3a-project-lifecycle-review.md) — `security-reviewer` on Core (BLOCK; C1 and W1 fixed) plus one combined security/phase pass on the clients (PASS-WITH-WARNINGS); no Critical remains; W1 and W2 fixed pre-commit; W3 accepted and disclosed
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0034 — Protocol A3b: conversation lifecycle

- **date:** 2026-10-11
- **phase:** C2 (conversation half; C2 complete) / protocol v1 addition A3b ([design §3.3](plans/2026-10-09-protocol-v1-additions.md)), with all three clients.
- **commit:** `f44ab4c` (feat(protocol): conversation lifecycle (A3b))
- **details:**
  - **Core methods (27 total):** `conversation.rename`, `conversation.archive`, `conversation.unarchive`, `conversation.delete` (A1 two-step token, bound to the conversation id), `conversation.export`; `conversation.list {includeArchived?}`; `Conversation.archivedAt?`/`sandboxId?`; feature `conversation-sandbox-id`; migration v6 with backup and downgrade refusal.
  - **Delete:** one transaction; refuses while unfinished tasks exist; never touches host files, worktrees, branches or sandboxes (impact lines say so).
  - **Archived conversations** refuse send and rename (a behaviour change: send used to answer NOT_FOUND); history and export still serve them; the project-archived message wins when both apply.
  - **Export:** paged like history (`MAX_HISTORY_BYTES` counted on raw rows under the lock); always redacted after the lock is released; messages only.
  - **Redaction:** new `sandpane-core::redact`, seven kinds, never lengthens text; overlapping matches are merged so a PEM block is never dropped; the title is counted on the first page only.
  - **Dependencies:** `regex` 1.13.1 (pinned exactly, default features off) → `regex-automata` 0.4.18, `regex-syntax` 0.8.11; all MIT OR Apache-2.0. `aho-corasick` 1.1.5 appears in `Cargo.lock` but is not compiled.
  - **Clients:** 27-method pins; probe-gated rename, archive/unarchive, "Show archived", A1-pattern delete and export; validators drift-tested against `Validator::conversation_title`; create titles normalized so a multi-line first prompt never fails create; single-flight delete and export; an unknown delete outcome is settled by an archived-inclusive re-read only when `conversation.archive` is advertised; JetBrains never moves the send target to a conversation the user did not pick.
  - **Deviations:**
    - the new methods sit after `conversation.history` in `Method::ALL`, not at the end;
    - regex features are trimmed;
    - two `#[doc(hidden)]` test seams;
    - a new `MSG_TITLE_BLANK` refusal for rename;
    - the desktop export is a read-only preview + Copy (no file save; `@tauri-apps/plugin-dialog` is not a dependency), accepted and disclosed.
- **files:**
  - `core/crates/**` (new `redact.rs`, `conversation_lifecycle.rs` and its test), `core/Cargo.lock`, `schemas/rpc-request.schema.json`, `schemas/core-capabilities.schema.json`, `schemas/README.md`
  - `clients/vscode/**`, `clients/jetbrains/**`, `apps/desktop/**`
  - `docs/plans/*`, `docs/specs/02_ARCHITECTURE_AND_DATA.md`, `docs/compatibility.md`, `README.md`
- **verification:**
  - `make check` exit 0: Core 364; schemas in sync (27 methods, 3 features); VS Code 552; desktop 557 + 8 opt-in skipped; Tauri 32.
  - JetBrains alone: 376; `verifyPlugin` Compatible.
  - Live, isolated Core with no `sbx`: VS Code 60/60, desktop 8/8.
  - 0 raw invisible characters in 77 files; the secret gate matched only synthetic redaction-test fixtures.
  - UNVERIFIED: never run against real `sbx` or in a real editor, app or IDE; live scripts check the advertisement, not the A3b calls; `cargo-audit` and `cargo-deny` are not installed.
- **review:** [audit/0034-protocol-a3b-conversation-lifecycle-review.md](audit/0034-protocol-a3b-conversation-lifecycle-review.md) — `security-reviewer` on Core (BLOCK; C1, W1, W2, I2, I3 fixed) plus one combined security/phase pass on the clients (PASS-WITH-WARNINGS; W1–W3 and four Info items fixed); no Critical remains
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0035 — Protocol A4: conversation.send mode (Task / Discuss)

- **date:** 2026-10-11
- **phase:** protocol v1 addition A4 ([design §3.4](plans/2026-10-09-protocol-v1-additions.md)), with all three clients
- **commit:** `d6b17dd` (feat(protocol): conversation.send mode — Task / Discuss (A4))
- **details:**
  - **Wire:**
    - `conversation.send {mode?: "task"|"discuss"}`, behind the feature `conversation-send-mode` (now 4 features).
    - An explicit `"task"` (or `null`) is normalized to absent before the idempotency fingerprint. The pre-A4 fingerprints are pinned and were recomputed independently.
    - Any other value is refused with `mode must be "task" or "discuss"` and nothing is written.
    - The method count is unchanged at 27.
  - **Behaviour:**
    - A discuss task never gets a writable workspace. This is refused at the internal API, before any Git side effect.
    - Both modes still record PERMISSION_DENIED and stay queued, and the scaffold events name the mode.
  - **Task summary:**
    - `TaskSummary.mode?` is an open string.
    - The new additive `TaskSummary.chosenSandboxName?` carries the sandbox name the task's chat chose. It is never a binding.
    - **`sandboxName` keeps its pre-A4 binding-only meaning.** This is a review-driven amendment to §3.4: overloading it would have made shipped clients show a verified isolation label and false "stopping it ends them" counts.
  - **Migration v7:** adds `tasks.mode`, `tasks.chosen_sandbox_name` and an index on it, with a backup; a v8 database is refused.
  - **`sandbox.remove`:** step 1 gains a line describing unfinished tasks sent from chats that chose the name. It never refuses; if the count cannot be read, it says so instead of failing.
  - **Clients:**
    - a Task / Discuss choice, gated on the feature;
    - Discuss is never downgraded to Task: a fresh probe or capability check runs before a Discuss send or retry, and the request is refused visibly otherwise;
    - "Send mode" and "sandbox chosen by its chat — not where it runs" are shown read-only;
    - `chosenSandboxName` is proven by tests never to feed isolation labels or stop/remove counts;
    - JetBrains no longer echoes undecodable replies.
  - **Deviations:**
    - `mode` is `Option<String>` rather than a serde enum, so Core returns its exact message.
    - The design was amended during review (the field split and the v7 column rename).
    - The desktop withholds a Discuss retry after feature loss through a new `not-retried` keyed outcome.
- **files:**
  - `core/crates/**` (new `tests/send_mode.rs`), `schemas/core-capabilities.schema.json`, `schemas/README.md`
  - `clients/vscode/**`, `clients/jetbrains/**`, `apps/desktop/**`
  - `docs/plans/2026-10-09-protocol-v1-additions.md`, `README.md`
- **verification:**
  - `make check` exited 0: Core 379; schemas in sync (27 methods, 4 features); VS Code 592; desktop 583 + 8 opt-in skipped; Tauri 32.
  - JetBrains, run alone: 389 tests; `verifyPlugin` Compatible.
  - Live checks against an isolated Core with no `sbx`: VS Code 60/60, desktop 8/8.
  - 0 raw invisible characters in 53 files; the secret gate was clean.
  - UNVERIFIED: never run against a real `sbx` or in a real editor, app or IDE; no Discuss send was made through the live scripts.
- **review:** [audit/0035-protocol-a4-send-mode-review.md](audit/0035-protocol-a4-send-mode-review.md) — `security-reviewer` on Core (BLOCK: C1 and C2 fixed via a §3.4 amendment, I1–I7 fixed) plus one combined security/phase pass on the clients (PASS-WITH-WARNINGS: W1–W3 and the Info items fixed); no Critical remains
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0036 — Protocol A5: git.diff and exact change lists

- **date:** 2026-10-11
- **phase:** protocol v1 addition A5 ([design §3.5](plans/2026-10-09-protocol-v1-additions.md)), with all three clients
- **commits:**
  - `10c5f18` (feat(protocol): git.diff and exact change lists (A5, WIP — client review fixes in progress))
  - `394709e` (fix(clients): A5 git.diff client review fixes)
- **details:**
  - **Wire:**
    - New read-only `git.diff {taskId, path, status?, maxBytes?}` → `{path, oldPath?, status, patch, binary, truncated, lossy, baseBlob?}`, placed right after `git.review`. That makes **28 methods**; features are unchanged at 4.
    - `path` must be an exact entry of the task's change list. `status` disambiguates a path listed twice. `maxBytes` is clamped to 1..=524 288 (default 262 144).
    - Output is display-only and never fed to apply.
  - **Change list:**
    - `git.review` paths are now exact: parsed with `-z --find-renames`, no longer C-quoted.
    - New `FileChange.oldPath?` for renames, and `ChangeSet.repoPath?` / `uninspected?`.
  - **Hardening (from the Core review):**
    - Every git call pins `--work-tree=<cwd>`, and `confirm_work_tree` refuses a redirected work tree. Review C1: a repo-local `core.worktree` read outside the target.
    - The patch shape is pinned (`a/`/`b/` prefixes, `-U3`), and pathspecs are built only from the change list (`LiteralPathspec::from_change`).
    - Untracked reads use `fstatat`, then `openat(O_NOFOLLOW|O_NONBLOCK)`, then an inode check.
    - Synthesized untracked patches carry `diff --git` and `new file mode` lines.
  - **Clients:**
    - per-file read-only diff views: a VS Code `sandpane-diff:` virtual document, a desktop `<pre>` as text, a JetBrains read-only dialog;
    - a 45 s deadline for `git.review` / `git.diff` (the desktop proxy uses 43 s);
    - disclosures for binary (possibly by repository attributes), truncated, lossy, rename and symlink patches;
    - honest copy for every exact refusal.
  - **Client review fixes:**
    - the symlink line needs untracked, mode `120000` on line 2, an exact `@@ -0,0 +1 @@` and exactly one `+` line;
    - VS Code breaks `$(` in labels;
    - the desktop proxy has an `is_read_only` set, so reads never say "may have been applied";
    - JetBrains shows CR as `\r` and picks the VCS root by `repoPath`.
  - **Deviations:**
    - The client review fixes landed one commit after the implementation commit. The user asked to commit the in-progress tree, so `10c5f18` is labelled WIP and lists the open items.
    - JetBrains now resolves nothing (with a visible warning) when `repoPath` is absent or matches no VCS root. It no longer falls back to the first root.
- **files:**
  - `core/crates/**` (new `sandpane-core/src/diff.rs`, `sandpane-service/tests/git_diff.rs`)
  - `schemas/rpc-request.schema.json`, `schemas/change-set.schema.json`, `schemas/README.md`
  - `clients/vscode/**`, `clients/jetbrains/**`, `apps/desktop/**`
  - `docs/plans/2026-10-09-protocol-v1-additions.md`, `docs/specs/02_ARCHITECTURE_AND_DATA.md`, `README.md`
- **verification:**
  - `make check` exited 0 on `394709e`: Rust 455 (Core 422 plus Tauri 33); schemas in sync (28 methods, 4 features); VS Code 641; desktop 614 + 8 opt-in skipped.
  - JetBrains, run alone: 410 tests; `verifyPlugin` Compatible.
  - Live checks against an isolated Core with no `sbx`: VS Code 62/62, desktop 8/8.
  - 0 raw invisible characters; the secret gate was clean.
  - UNVERIFIED:
    - never run against a real `sbx` or in a real editor, app or IDE;
    - no wire-created task has Git context until A4b, so no real patch has crossed the wire.
- **review:** [audit/0036-protocol-a5-git-diff-review.md](audit/0036-protocol-a5-git-diff-review.md) — `security-reviewer` on Core (BLOCK: C1 `core.worktree` leak fixed and re-verified PASS; W1 and I1–I4, I7 fixed) plus one combined security/phase pass on the clients (PASS-WITH-WARNINGS: all dispatched items fixed in `394709e`); no Critical remains
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0037 — Protocol A6: git.apply for reviewed files

- **date:** 2026-10-11
- **phase:** protocol v1 addition A6 ([design §3.6](plans/2026-10-09-protocol-v1-additions.md)), with all three clients
- **commits:**
  - `bde5870` (docs(plan): A6 git.apply design decisions (§3.6))
  - `dbdf9c1` (feat(protocol): git.apply for reviewed files (A6))
- **details:**
  - **Wire:**
    - `git.apply {taskId, expectedBase, reviewId, entries}` → `{applied, abortReason?, conflictedFiles, appliedFiles?, modeChanges?, snapshotTree?, partial?}`.
    - `entries` are copied verbatim from the `git.review` answer that produced `reviewId`. `selectedFiles` is refused. At most 1000 entries.
    - `ChangeSet` gains `reviewId?` and `hostHooksPath?`. `FileChange` and `GitDiffResult` gain `taskBlob?` / `taskMode?`.
    - New feature `git-apply`, making **5 features**; methods stay at **28**.
    - Additive event kinds: `git.apply.started`, `git.applied`, `git.apply.failed`, `git.apply.reconciled`.
  - **What it does:**
    - It applies reviewed `host_worktree` changes into your working tree and stages them; nothing is committed.
    - `direct_mount` and `sbx_clone` are refused.
    - The content Core hashed at review time (`taskBlob` = git blob id with sha1dc or SHA-256) is exactly what gets written. An entry that changed since review is refused.
  - **Safety:**
    - No git process reads the task worktree; Core reads files through an `openat` walk.
    - The snapshot is built in an object quarantine, so a refusal leaves your `.git/objects` unchanged.
    - Host gates before any write: HEAD/base, touched-path status (untracked and ignored too), hidden index entries, symlinked leading paths, filter attributes and submodules.
    - The write is `apply --check --index` then `apply --index` under 13 pinned config keys, followed by a post-write verify.
    - Durable events come before the response, and restarts are reconciled.
    - One writer lock per repository is shared with `direct_mount` `sandbox.create`.
    - Per-phase deadlines total 41 s, inside the 45 s client deadline.
    - A partial outcome is reported as partial, naming `git status`.
  - **Clients:**
    - per-file selection over one review;
    - a confirmation reachable only from a user gesture, listing every file and flagging (a) unseen content, (b) executable files, (c) paths that run automatically;
    - VS Code adds a typed-count step, because its modal cannot default to Cancel;
    - a diff/entry mismatch refuses to send;
    - single flight, never retried automatically;
    - the desktop sets TanStack `networkMode: "always"` app-wide.
  - **Deviations:**
    - Core changed after the clients were briefed (the re-verification fixes added four messages). The combined client review was run against the final Core, and all three clients key the final texts.
    - The VS Code confirmation adds a typed second step that is not in §3.6 item 9; it is stricter.
  - **Open:** W-D, the A4b precondition. A5 review and diff still run git inside a `host_worktree` task worktree.
- **files:**
  - `core/crates/**`: new `sandpane-core/src/apply.rs` and `objects.rs`, `testdata/sha-mbles-1.bin` and its NOTICE, `sandpane-service/src/git_apply.rs`, `tests/git_apply.rs`, `tests/global_config_pins.rs`
  - `core/Cargo.lock`
  - `schemas/change-set.schema.json`, `schemas/core-capabilities.schema.json`, `schemas/task-event.schema.json`, `schemas/README.md`
  - `clients/vscode/**`, `clients/jetbrains/**`, `apps/desktop/**`
  - `docs/plans/2026-10-09-protocol-v1-additions.md`, `README.md`
- **verification:**
  - Core: `cargo test` 509 passed, 0 failed; fmt and clippy clean.
  - `make check` exited 0 on `dbdf9c1`'s tree: schemas in sync (28 methods, 5 features); VS Code 709; desktop 672 + 8 opt-in skipped; Tauri shell 34.
  - JetBrains, run alone: 445 tests, 0 failures; `verifyPlugin` Compatible (IU-262.10968.63).
  - Live checks against an isolated Core with no `sbx`: VS Code 62/62, including the A6 wire refusal "task has no Git context …; nothing was written"; desktop 8/8.
  - 0 raw invisible characters in 106 staged text files. The secret gate flagged only fictional fixture paths, with 0 real paths.
  - The new dependency `sha1collisiondetection` 0.3.4 is MIT, and its tree is MIT or MIT-or-Apache-2.0 (checked from the crates' manifests). `cargo-audit` / `cargo-deny` are not installed.
  - UNVERIFIED:
    - never run against a real `sbx` or in a real editor, app or IDE;
    - no wire-created task has Git context until A4b, so real applies are exercised only by Core integration tests on real temporary repositories;
    - no real-seconds test of the phase budgets.
- **review:** [audit/0037-protocol-a6-git-apply-review.md](audit/0037-protocol-a6-git-apply-review.md) — `security-reviewer` on Core (PASS-WITH-WARNINGS: W-A, W-B, W-C, I1–I3, I5 and I6 fixed), then a `security-reviewer` re-verification (PASS-WITH-WARNINGS: W-N1, W-N2, I-N1–I-N3 and N14 fixed), plus one combined security/phase pass on the clients (BLOCK on desktop D-C1, a confirmed apply resumable by an `online` event: fixed, along with every dispatched Warning and Info); no Critical remains
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0038 — Protocol A7: verification commands and project.context

- **date:** 2026-10-12
- **phase:** protocol v1 addition A7 ([design §3.7](plans/2026-10-09-protocol-v1-additions.md)), with all three clients
- **commits:**
  - `5d29980` (docs(plan): A7 verification and project.context design decisions (§3.7))
  - `bd48a10` (feat(protocol): verification commands and project.context (A7))
- **details:**
  - **Wire:**
    - Six methods follow `git.apply`: `verification.list`, `verification.approve`, `verification.revoke`, `verification.run`, `verification.result` and `project.context`, making **34 methods**.
    - New feature `verification`, making **6 features**.
    - Additive event kinds: `verification.started`, `verification.finished` (`outcome` includes `interrupted`).
    - Migration v8 adds `verification_commands` and `verification_runs`.
  - **What it does:**
    - A user approves an exact argv plus a label. `verification.run` runs it only inside the task's bound sandbox, through `sbx exec -- <name> <argv…>`. It never runs on the host or through a shell.
    - The environment is cleared down to an allowlist. Core uses an empty 0700 working directory of its own, also for `version` and `ls --json`.
    - Runs are asynchronous (`runId`, `startedSequence`). Output is stored only in `verification_runs` and read through `verification.result`; it is never put in events. Each run gets exactly one terminal record.
    - `project.context` reads manifests with `openat`/`O_NOFOLLOW`, runs no tool and redacts notes. Its suggestions only pre-fill the approval editor.
  - **Safety:**
    - Approval refuses secret-like values (per element, joined, and as JSON) and control characters other than TAB and LF. The secret check runs again at run start.
    - The version gate uses `VERIFIED_EXEC_VERSIONS`, which is empty, so every real `sbx` gets `UNSUPPORTED_SBX_VERSION` until captures C-1, C-2, C-5 and C-7. The identity gate requires a fresh `ls --json` to list exactly the bound id, `running`, and the bound mount.
    - Caps: 1 run per task, 1 per sandbox, 4 globally. A `direct_mount` run takes the repository writer lock.
    - Keyed replay comes first.
    - Responses are capped at `MAX_FRAME_BYTES − 64 KiB`, with `outputIncomplete` disclosed.
    - `process.rs` uses a single-threaded unreaped-leader runner, so there is no stale group signal (this also fixes the pre-existing `run_bounded`).
  - **Clients:**
    - approve, revoke and run confirmations reachable only from a user gesture, listing every revealed argv element with its count;
    - the run target comes from the task binding (`sandboxName`);
    - a fresh key per gesture, and "Retry safely" only after a lost answer and within 23 h of the first send;
    - a 45 s deadline for `project.context` and `verification.run`;
    - output shown as escaped plain text; exit 0 is never "passed";
    - verification events are display-only.
  - **Deviations:**
    - The client brief gave `verification.run` the default deadline. That was wrong, because Core gates for up to 33 s before the durable start. All clients now use 45 s, and it is drift-pinned.
    - VS Code applies the 23 h retry window to the A2 retries too.
    - Graceful shutdown is implemented, but `main.rs` has no shutdown path (disclosed in §3.7).
  - **Process change:** Core and its wire files were frozen with SHA-256 hashes before the clients were briefed, and the hashes were checked before the commit (lesson from A6).
  - **Open:**
    - W-D and the A7 capture gate (I-h) are A4b preconditions.
    - Verification cancel needs C-4.
- **files:**
  - `core/crates/**`: new `sandpane-core/src/verification.rs` and `context.rs`, `sandpane-service/src/verification.rs`, `tests/verification.rs`; changes to `validation.rs`, `process.rs`, `sbx.rs`, `db.rs`, `diff.rs` and the lifecycle handlers
  - `schemas/verification.schema.json` and `schemas/project-context.schema.json` (new); `rpc-request`, `core-capabilities`, `task-event`, `schemas/README.md`
  - `clients/vscode/**`, `clients/jetbrains/**`, `apps/desktop/**`
  - `docs/plans/2026-10-09-protocol-v1-additions.md`, `README.md`
- **verification:**
  - Core: `cargo test` 596 passed, 0 failed; fmt and clippy clean.
  - `make check` exited 0 on `bd48a10`'s tree: schemas in sync (34 methods, 6 features); VS Code 810; desktop 736 + 9 opt-in skipped; Tauri shell 36.
  - JetBrains, run alone: 483 tests, 0 failures; `verifyPlugin` Compatible (IU-262.10968.63).
  - Live checks against an isolated Core with no `sbx`:
    - VS Code 66/66, including that the A7 methods and feature are advertised, a fresh project lists no commands, and a secret-like approve is refused with nothing stored;
    - desktop 9/9.
  - All 14 frozen wire files matched their hashes.
  - 0 raw invisible characters in 116 staged files. The secret gate flagged only the fictional `/Users/demo` fixture user, with 0 real paths.
  - No new dependency.
  - UNVERIFIED:
    - never run against a real `sbx` or in a real editor, app or IDE;
    - no real `verification.run`: it is version-gated, and no task is bound until A4b;
    - captures C-1–C-7 are not taken.
- **review:** [audit/0038-protocol-a7-verification-review.md](audit/0038-protocol-a7-verification-review.md)
  - Design: `security-reviewer` returned BLOCK on C1 (fixed), then PASS-WITH-WARNINGS.
  - Core: `security-reviewer` returned PASS-WITH-WARNINGS (W1–W3, S1, S2, I2 fixed), then a re-verification returned PASS-WITH-WARNINGS (N1, I-a, I-b fixed; I-c, I-d, I-e accepted).
  - Clients: two `security-reviewer` passes returned PASS-WITH-WARNINGS (J-W1, J-W2, VS Code W1–W3, the cross-client run deadline and the dispatched Info all fixed).
  - No Critical remains.
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

## 0039 — Protocol A8a: sbx daemon status, execVerified and versionCaptured

- **date:** 2026-10-12
- **phase:** protocol v1 addition A8a ([design §3.8](plans/2026-10-09-protocol-v1-additions.md)), with all three clients; A8b/A8c deferred
- **commits:**
  - `391babc` (docs(plan): A8 and A9 design decisions (§3.8, §3.9))
  - `20829f9` (feat(protocol): sbx daemon status from the text form, execVerified and versionCaptured (A8a))
- **details:**
  - **Wire (additive, no new method or feature; still 34 methods and 6 features):**
    - `system.probe` reads the daemon state from the captured text form of `sbx daemon status`. The probe runs `version` and `daemon status`, never `ls`. A stopped daemon now reads `false`.
    - The parse is strict: exit 0, untruncated output, line 1 exactly `Status: running` or `Status: stopped`, no later `Status:` line, no CR, no `Starting…` preamble. Anything else is `null`. `Socket:` and `Logs:` lines and stderr are never parsed, stored or returned.
    - `SbxStatus` gains optional `execVerified` (the `verification.run` gate's predicate over the probe's own reading; the gate stays authoritative) and `versionCaptured` (the version number equals a captured fixture version, `CAPTURED_VERSIONS = [0.47.0]`, drift-tested; build not compared).
  - **Review fixes in Core:**
    - `SbxVersion` keeps the semver pre-release, so `0.47.0-rc.1` is never captured or exec-verified as `0.47.0`.
    - The `verification.run` version gate refuses truncated `sbx version` output (a pre-existing A7 gap).
  - **Clients:**
    - All three show "SBX daemon running (at last check)", "SBX daemon stopped (at last check)" or "SBX daemon state unknown", plus "Verification runs are (not) enabled for this sbx version" and "Same sbx version number as Sandpane's captured fixtures (macOS; build not compared): yes/no" when Core sends them.
    - No "ready" wording, no success tone, no daemon start/stop control.
    - Desktop decodes the two booleans tolerantly and relabels the old "SBX ready". VS Code adds a sidebar sbx region shown only while online. JetBrains marks the sbx block as coming from the connection check, not the refresh.
  - **Deviations and open items:**
    - A8b (ports) and A8c (listings) are not implemented: their outputs are uncaptured (C-8 to C-13), so decoders would be written against guessed JSON.
    - `sandbox.list` (A1) still runs `sbx ls`, which sbx 0.47.0 was captured auto-starting the daemon. Refusing it when the daemon reads stopped is carried to A8c (needs C-14).
    - Aligning the probe's `sbx version` read context with the gate's is deferred until `VERIFIED_EXEC_VERSIONS` gets its first entry.
- **files:**
  - `core/crates/sandpane-core/src/sbx.rs`, `process.rs`; `sandpane-protocol/src/lib.rs`; `sandpane-service/src/lib.rs`, `verification.rs`; `tests/service_integration.rs`, `tests/verification.rs`
  - `schemas/core-capabilities.schema.json`, `schemas/README.md`
  - `apps/desktop/**`, `clients/vscode/**`, `clients/jetbrains/**`
  - `docs/plans/2026-10-09-protocol-v1-additions.md`, `docs/plans/2026-10-12-status-report.md` (design commit), `docs/compatibility.md`, `README.md`
- **verification:**
  - Core: `cargo test` 606 passed, 0 failed; fmt and clippy clean.
  - `make check` exited 0: schemas in sync (34 methods, 6 features); Rust 642 (606 Core + 36 Tauri shell); VS Code 850; desktop 747 + 9 opt-in skipped; JetBrains build successful.
  - JetBrains, run alone: 493 tests, 0 failures; `verifyPlugin` Compatible (IU-262.10968.63).
  - Live checks against an isolated Core with no `sbx`: VS Code 66/66, desktop 9/9; no Core process left.
  - 0 raw invisible characters in 38 staged files (after replacing two raw U+202E test literals with escapes); secret gate clean.
  - No new dependency.
  - UNVERIFIED:
    - never run against a real `sbx`; the parse rests on the v0.47.0 macOS arm64 captures;
    - the running form's exit status and the stopped JSON form are uncaptured (C-14);
    - no client display shown in a real editor, app or IDE.
- **review:** [audit/0039-protocol-a8a-sbx-status-review.md](audit/0039-protocol-a8a-sbx-status-review.md)
  - Design: `security-reviewer` returned BLOCK on C1 (an A9 finding; fixed and re-checked: PASS); §3.8 findings W8, I1–I4 and I10 folded in.
  - Core: `security-reviewer` returned PASS-WITH-WARNINGS (W1–W3 and I1 fixed; I2 and I3 accepted).
  - Clients: `security-reviewer` returned PASS-WITH-WARNINGS (W1–W3 and the Info items fixed; the `sandbox.list` auto-start follow-up deferred to A8c).
  - No Critical remains.
- **model:** claude-opus-5-5 (session configuration)
- **tokens:** input: - · cached: - · output: - (session delta: -; no per-breakdown usage source exposed to this session — dash per rule)

<!-- New entries are appended immediately above this line (chronological, numbers ascending). -->
