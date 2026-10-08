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

<!-- New entries are appended immediately above this line (chronological, numbers ascending). -->
