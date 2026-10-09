---
name: sandpane-phase-gates
description: Use when starting, finishing, or auditing a Sandpane roadmap phase (P0-P11) or client deliverable (VS0-VS4, JB0-JB4, DT0-DT5), when deciding whether a phase is complete, or when asked what remains before a release gate.
---

# Sandpane phase gates

Phase discipline from `docs/specs/07_ROADMAP_AND_TASKS.md`: implement in dependency order; a phase is complete **only after its objective acceptance checks pass with evidence** — never on vibes or partial work.

## Gate procedure

1. Identify the phase and its **Exit** statement in `docs/specs/07_ROADMAP_AND_TASKS.md` (plus the client checklist in `docs/specs/03`, `04`, or `05` when applicable).
2. Verify prerequisites: earlier phases' exits hold; `docs/compatibility.md` rows for anything version-sensitive are filled or explicitly UNVERIFIED.
3. Run the phase's verification commands fresh (see `/AGENTS.md` Commands table). Capture real output.
4. Walk the phase checklist item by item; each is either done-with-evidence, honestly unverified (say why), or not done.
5. Check the cross-cutting gates below — they apply to EVERY phase.
6. Log via the `sandpane-changelog` skill.

## Cross-cutting gates (all phases)

- **Security** (`docs/specs/06_SECURITY_AND_LICENSING.md` §10): no shell injection from names/paths/text/refs; same-user IPC boundary; destructive ops server-validated and confirmed; secrets never mirrored or logged; prompt-injection corpus cannot escalate privileges.
- **Honesty** (`docs/specs/08_TESTING_AND_RELEASE.md`): no fabricated pass status, no fake success UI, unsupported features visibly unsupported; fixtures labeled illustrative until captured from real tools.
- **Licensing** (`docs/licensing-decision.md`): nothing bundled from Docker; public-release artifacts blocked while gates are OPEN.
- **Recovery**: task reconciliation after crash/restart marks `interrupted` rather than fabricating `running`; client reconnect is idempotent.

## Release-gate quick map

| Gate | Requires |
|---|---|
| Internal alpha | One real structured Codex task in an SBX sandbox with streamed messages, real Git diff, authentic test outcomes (P0-P4 evidence) |
| Public beta | Legal gate PASSED + dependable multi-project/multi-chat + two isolated writers + shared Core replay + threat-model/redaction pass |
| Stable | Migration/crash/recovery/uninstall demonstrated; no known critical injection/credential/Git-integrity issues; published test matrix; independent versioned client releases |

## Common mistakes

| Mistake | Fix |
|---|---|
| Marking a phase done because code compiles | Exit statements are behavioral; run the acceptance scenarios |
| Skipping P0 because "it's legal paperwork" | P0 is a BLOCKER; its technical fixtures/feasibility proofs gate P3+ chat claims |
| Assuming an untested SBX/agent version works | Capability-gate; record exact versions in docs/compatibility.md |
| Silently descoping a checklist item | Record it as not-done with reason in the changelog entry |
