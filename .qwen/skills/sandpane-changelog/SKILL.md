---
name: sandpane-changelog
description: Use when a big implementation step has just been completed (a phase, module, client skeleton, docs rebuild, or infrastructure addition is committed or about to be committed), when asked to log an implementation, write an audit record, or update docs/CHANGELOG.md, or when unsure whether a change counts as "big" enough to log.
priority: 10
---

# Sandpane implementation changelog & audit logging

The logging system mandated by `/AGENTS.md`:

> After each big implementation: commit, auto-review, log in `docs/audit/`, and create a changelog entry in `docs/CHANGELOG.md` with the implementation details, model used, and tokens used (input, cached, output). If you don't have specific information for the changelog, use a dash (e.g., `model: -`). Never guess or fabricate numbers.

## When this applies

Log every **big implementation step**: a roadmap phase or slice of one, a new module/crate/client skeleton, a docs rebuild, CI/tooling additions, security-relevant changes. Do NOT log trivial fixes (typos, formatting) individually — fold them into the next entry's details if relevant.

## Procedure (in order)

1. **Implement** the change completely.
2. **Auto-review BEFORE committing.** Choose the method scaled to risk:
   - Docs/tooling-only: a read-only checklist pass (the `phase-reviewer` agent, or the `/review` skill at `--effort low`) against the working-tree diff.
   - Code changes: dispatch the read-only `phase-reviewer` project agent on the diff; add `security-reviewer` when the change touches command execution, IPC, credentials, Git apply, or webview surfaces.
   - The bundled `/review` multi-agent fan-out is available but must NOT be launched unless the user explicitly requests it in the current session (a large fan-out was user-cancelled in this project's history — "do not retry" without a fresh request).
   Fix every Critical finding or record a disposition. Keep the findings list; it feeds step 4. Whichever method ran, name it in the audit record's Method section and the changelog's review line.
3. **Commit** the implementation (Conventional Commits). Note the short hash: `git log --oneline -1`.
4. **Write the audit record** `docs/audit/NNNN-<slug>-review.md` using [audit-template.md](audit-template.md). `NNNN` = next zero-padded number after the highest existing entry in `docs/CHANGELOG.md` (check with `ls docs/audit/` and the last changelog entry — they share numbering; `0000` is the execution plan, entries start at `0001`).
5. **Add the changelog entry** to `docs/CHANGELOG.md` immediately above the append marker at the bottom (chronological order — numbers ascend, newest entry last), using the entry format documented at the top of that file.
6. **Commit the log**: `docs(audit): log implementation NNNN — <title>`.

## Filling model and tokens (dash rule)

Record only what you can actually observe; every unknown value becomes `-`. Never estimate, extrapolate, or fabricate.

| Field | Where it comes from | If unavailable |
|---|---|---|
| `model` | The session's configured model (e.g. from `/status`, or `~/.qwen/settings.json` `model.name` — qualify it as "(session configuration)") | `-` |
| `tokens input/cached/output` | A per-breakdown source: the `/review` cost-ledger JSON (`.qwen/reviews/*-cost-ledger.json`, has input/cached/output for the review window) or harness usage records | `-` for each missing component |
| `session delta` | Goal/usage meter totals before vs after the step (`get_goal` `tokensUsed` in goal sessions) | `-` |

## Quality bars

- **verification** field: quote commands actually run in this step and their real outcomes — including failures and things that could NOT be verified (e.g. "Gradle build not run: no local toolchain"). Evidence before claims (superpowers `verification-before-completion`).
- **details** field: what was built, key decisions, and any deviation from `docs/specs/`. Spec deviations must also be flagged in the entry's details, not silently absorbed.
- Every entry number has a matching audit file; every audit file lists findings AND dispositions (accepted/deferred counts as dispositioned when justified).
- Cross-check after writing: entry `NNNN` exists in both files, commit hashes resolve (`git cat-file -e <hash>^{commit}`), relative links in both files resolve.

## Common mistakes

| Mistake | Fix |
|---|---|
| Logging after several implementations at once | One entry per big step, written immediately after it |
| Inventing token numbers | Dash rule — `-` is always acceptable, a guess never is |
| Committing the audit record and implementation together | Separate commits: implementation hash must be referencable from the log |
| "All checks pass" without output | Paste the real command results (trimmed) into verification |
| Numbering drift between audit/ and CHANGELOG.md | Both derive from the same next-number rule in step 4 |
