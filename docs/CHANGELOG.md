# Sandpane implementation changelog

Every **big implementation step** gets one numbered entry here, per the mandatory logging rule in [`/AGENTS.md`](../AGENTS.md). Newest entries first.

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

<!-- Entries are appended above this line, newest first. -->
