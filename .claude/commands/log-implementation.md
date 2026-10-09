---
description: Log a completed implementation — writes docs/audit/NNNN review record + docs/CHANGELOG.md entry per the AGENTS.md rule
---

Invoke the `sandpane-changelog` skill and execute its full procedure for the most recent big implementation step (or for this specific step: $ARGUMENTS).

Determine the next entry number NNNN from docs/CHANGELOG.md and docs/audit/. The implementation commit must already exist — if the working tree still holds uncommitted implementation changes, run the auto-review first (method per the `sandpane-changelog` skill: read-only `phase-reviewer`, plus `security-reviewer` for attack-surface diffs; the `/code-review` multi-agent tier only on explicit user request), disposition findings, commit the implementation, then log it.

Write docs/audit/NNNN-<slug>-review.md from the skill's audit-template.md with real findings/dispositions/evidence, add the matching docs/CHANGELOG.md entry immediately ABOVE the bottom append marker (chronological — numbers ascend, newest last) with details, verification, review link, model, and tokens — using `-` for every value you cannot actually observe (never fabricate numbers) — and finish with the `docs(audit): log implementation NNNN — <title>` commit.
