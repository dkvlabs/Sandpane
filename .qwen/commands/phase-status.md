---
description: Report Sandpane implementation status against the roadmap phases and logged entries
---

Produce a status report for Sandpane implementation progress{{args}} (optionally focused on one phase, e.g. `P1` or `vscode`):

1. Read docs/CHANGELOG.md (all entries) and docs/audit/0000-execution-plan.md.
2. Read docs/specs/07_ROADMAP_AND_TASKS.md phase list and the client deliverable checklists (specs/03 §5, specs/04 §4, specs/05 §4) as relevant.
3. For each phase P0-P11 and each scaffolded deliverable: state DONE-WITH-EVIDENCE (link the changelog entry + verification output), PARTIAL (what exists, what remains), or NOT-STARTED. Cite the docs/compatibility.md and docs/licensing-decision.md gate states verbatim where they block a phase.
4. End with: next recommended phase per the dependency graph, its entry criteria, and any standing blockers.

Do not mark anything done without evidence in this repository; unverified means UNVERIFIED.
