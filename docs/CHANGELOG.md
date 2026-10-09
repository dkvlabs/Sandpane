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

<!-- New entries are appended immediately above this line (chronological, numbers ascending). -->
