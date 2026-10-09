# Sandpane audit records

This folder holds the **auto-review record** for every big implementation step, plus the overall execution plan. It is the evidence trail referenced by [`../CHANGELOG.md`](../CHANGELOG.md) and required by [`/AGENTS.md`](../../AGENTS.md).

## Naming

- `NNNN-<slug>-review.md` — auto-review record for changelog entry `NNNN`.
- `0000-execution-plan.md` — the implementation plan governing the numbered entries.

## What a review record contains

1. **Scope** — what was reviewed (commit range / working tree diff, files).
2. **Method** — how the auto-review was produced (e.g. `/code-review` skill, review agent, checklist pass).
3. **Findings** — categorized (critical / warning / suggestion), each with file references.
4. **Disposition** — what was fixed before commit, what was accepted, what was deferred (with issue/changelog pointer).
5. **Verification evidence** — commands run and actual output summaries.

Reviews happen **before** the implementation commit lands; the record itself is committed in the follow-up `docs(audit)` commit together with the changelog entry.
