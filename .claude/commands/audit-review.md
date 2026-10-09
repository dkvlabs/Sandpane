---
description: Run the pre-commit auto-review gate on the current changes (or a given commit range) using the phase-reviewer agent
---

Run the auto-review gate for the current uncommitted changes (if a commit range like `HEAD~2..HEAD` is given in the arguments, review that range instead). Arguments: $ARGUMENTS.

Dispatch the `phase-reviewer` agent (read-only) with: the scope (working tree or the given range), the phase/module being implemented, and the acceptance-criteria pointers (docs/specs/07 exit statement + relevant client checklist). Also dispatch `security-reviewer` when the diff touches command execution, IPC, credentials, Git apply paths, or webview surfaces.

Collect their findings, fix or disposition every Critical before the implementation commit, and keep the full output (scope, method, findings, dispositions, verification evidence, gate verdict) ready for transcription into docs/audit/NNNN-<slug>-review.md by the `sandpane-changelog` flow (/log-implementation).
