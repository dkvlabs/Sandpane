# 0015 — Auto-review record: real sbx sandbox lifecycle capture (P0)

- **date:** 2026-10-09
- **implementation commit:** `5153311` — test(sbx): capture a real sbx v0.47.0 sandbox lifecycle round trip (P0)
- **review ran:** before the commit, on the staged fixtures

## Scope

Ten new capture files in `captured/v0.47.0/crud/`, `_meta.json` (contents and policy note), and `docs/compatibility.md` (sbx row, matrix row, fixtures section).

## Method

The orchestrator ran an inline fixtures checklist:

- **Precondition:** the user ran `sbx policy init balanced` themselves. The agent did not choose the machine-wide policy.
- **Isolation:** the sandbox used the provider-free `shell` agent, an empty scratch workspace, and a unique name. It was removed at the end, and `ls --json` was confirmed empty afterwards.
- **Sanitization:** `$HOME`/`$SCRATCH` substitution, then a grep for the username and `/private/tmp` (0 hits).
- **Comparison:** the captured outputs were compared against the illustrative fixture's assumptions.

## Findings

1. **Warning (routed): the illustrative fixture's row shape was wrong.** `list.json` assumed a field named `state`; real rows use `status` and also carry `id`, `agent`, `workspaces[]`, `created_at` and `last_used_at`. The Core adapter rewrite (in progress) was given the real shape and must parse from the captures.
2. **Suggestion (recorded): `start` does not exist in this CLI version.** Restart is `sbx run --name N`, which interactively attaches the agent. Core should report start as unsupported, or map it only after `run` is proven non-interactive.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| 1 | routed to the Core fix batch | Parsing tests pinned to `crud/02_ls_json_after_create.txt` |
| 2 | routed to Core feature C1 (sandbox lifecycle) | Recorded in the plan |

## Verification evidence

- `sbx create shell --name sandpane-p0-probe --quiet <empty-ws>` → exit 0.
- `sbx ls --json` → 1 row, `status: "running"`.
- `sbx exec … echo sandpane-p0-ok` → `sandpane-p0-ok`.
- `sbx stop` → "stopped; state preserved", and `ls --json` then shows `status: "stopped"`.
- `sbx rm --force` → "removed", and `ls --json` then shows `{"sandboxes": []}`.
- A second `rm --force` → `error: sandbox 'sandpane-p0-probe' not found`, exit 1.
- The leak grep returned 0 hits.

**Fixtures checklist, orchestrator inline: 2 findings routed. PASS.**
