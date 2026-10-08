# 0001 — Auto-review record: docs folder rebuild

- **date:** 2026-10-09
- **implementation commit:** `9fd4427` — docs: rebuild docs folder — specs/, design/ dedup, audit trail, changelog, P0 records (19 files, +191/−1718)
- **review ran:** before the commit, on the same working-tree diff (`qwen review capture-local`), per `audit/README.md`

## Scope

Working-tree diff vs `e81666a`: 2003 diff lines (117 source-classified, 1886 docs), 5 review chunks:

1. Deletion `docs/SANDPANE_DESKTOP_PREVIEW.png` (binary duplicate)
2. Deletion `docs/SANDPANE_DESKTOP_VISUAL_REFERENCE.html` (107-line duplicate)
3. Deletion `docs/SANDPANE_FINAL_DESIGN_AGENT_PROMPT.md` (106-line duplicate)
4. Deletion `docs/SANDPANE_FULL_IMPLEMENTATION_PLAN.md` (1505-line concatenated bundle)
5. Nine 100%-similarity renames `docs/SANDPANE_IMPLEMENTATION/*` → `docs/specs/*` + six new files (`docs/README.md`, `docs/CHANGELOG.md`, `docs/audit/README.md`, `docs/audit/0000-execution-plan.md`, `docs/compatibility.md`, `docs/licensing-decision.md`)

Untracked files were included by the capture (6 new docs). Nothing skipped (`skippedFiles: []`).

## Method

Bundled `/review` skill, **effort: low** (quick pass — inline angle rotation, no subagents, findings unverified, no verdict claimed). Args parsed via `qwen review parse-args` (fallback args file written by the orchestrator, disclosed). Angles walked:

- **A — line-by-line** over all six new markdown files (~172 added lines): paths, dates, numbering, tables → findings 1, 2, 4
- **B — removed behaviour** over all four deletion chunks: duplicate-preservation invariant and bundle-content invariant → finding 3
- **C — language pitfalls**: markdown only, no code/YAML frontmatter introduced; link syntax machine-checked → no new candidates
- **D — wrapper/proxy routing**: N/A (no code in diff)
- **E — reuse/dead code**: docs/README.md vs specs/README.md overlap judged intentional (different audiences) → nothing
- **F — sibling consistency**: NNNN numbering, date style, branding, review-flow description consistent across CHANGELOG.md / audit/README.md / execution plan → nothing
- **Sweep**: deletion headers + rename blocks re-read for gaps; `.DS_Store` present on disk but git-ignored → nothing new

Recall floor: 4 candidates required (min(changed files, 4) tier), 4 found → no re-pass owed.

## Findings (all Suggestion; unverified — low tier)

1. **Forward-reference links unresolved at this commit** — `docs/README.md` (→ `../AGENTS.md`, → `audit/0001-docs-rebuild-review.md`), `docs/CHANGELOG.md` (→ `../AGENTS.md`), `docs/audit/README.md` (→ `../../AGENTS.md`). Confidence: low (deliberate).
2. **`docs/compatibility.md` claims fixtures exist** under `core/crates/sandpane-core/tests/fixtures/sbx/` (present tense) — directory does not exist yet.
3. **Deleted bundle's unique glue header lost** (incl. its "See the ZIP" pointer); all spec content itself preserved via the nine 100% renames. Confidence: low.
4. **Execution-plan entry 0001 says "link check"** while forward references are legitimately unresolved until entry 0002 — the gate needs the accepted-forward-reference list (this file provides it).

## Disposition

| # | Disposition | Reason |
|---|---|---|
| 1 | **Accepted (temporary)** | Targets land this session: `audit/0001` in this logging commit; `AGENTS.md` in entry 0002. Final full link check is a Definition-of-Done item of the execution plan and runs again in entry 0007. |
| 2 | **Accepted (resolves in 0003)** | Entry 0003 creates the fixtures directory at exactly this path; verification of 0003 must confirm the claim. |
| 3 | **Accepted** | `docs/README.md` "Rebuild note" documents the removal and rationale; no spec content lost (verified below). |
| 4 | **Addressed by this record** | Accepted forward references at commit `9fd4427`: `../AGENTS.md` (×3 files), `audit/0001-docs-rebuild-review.md` (×1), `/LICENSE` (text mention in licensing-decision.md). Everything else resolved — see evidence. |

No Critical findings. Nothing fixed pre-commit (no defect class requiring it).

## Verification evidence

- Duplicate preservation: `diff -q docs/<f> docs/design/<f>` → IDENTICAL for all three duplicates **before** deletion (tool output this session).
- Bundle = concatenation: bundle header itself states "This combines the individual implementation documents into one Markdown file"; its sections match `specs/README.md`, `01`, `02`, … read this session; renames landed at `similarity index 100%`.
- Link check (python relative-link walk over `docs/**/*.md`): exactly the 4 forward references above; **all other links resolve** ("BROKEN:" list contained only those).
- Commit landed: `git log --oneline` → `9fd4427` on `main`; `git status` clean except untracked `.qwen/` (session tooling, gitignored in entry 0002).
- Review temp files swept; stray `qwen-review-local-cache-candidate.json` removed manually (low tier must not write a cache).

**Quick pass (effort: low) — findings are unverified. No verdict emitted (low tier).**
