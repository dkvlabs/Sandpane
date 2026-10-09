# 0013 — Auto-review record: Claude Code config refresh + superpowers version record

- **date:** 2026-10-09
- **implementation commit:** `78d317c` — chore(tooling): refresh Claude Code agents, commands and skills; record superpowers version (15 files, +42/−18)
- **review ran:** before the commit, on the same staged diff, per `audit/README.md`

## Scope

Tooling and docs only, with no product code. The diff covered:

- the 9 agents in `.claude/agents/`
- the 3 commands in `.claude/commands/`
- 2 skills: `core-protocol` and `sandpane-changelog`
- `docs/compatibility.md`

The log commit also carries a correction note in audit 0012, which links to this record.

## Method

The orchestrator ran an inline docs/tooling checklist pass. No `/code-review` fan-out was launched. The pass had six parts:

1. **Full read.** Every agent, command and skill was read end to end.
2. **Claims vs code.** Skill claims were cross-checked against `sandpane-protocol` and `sandpane-service`: `ErrorCode`, `Method`, `MAX_FRAME_BYTES`, `MAX_SUBSCRIBE_CURSORS`, `MAX_LIST_LIMIT`, and `afterSequences` semantics.
3. **Frontmatter parse.** All 17 files went through PyYAML. Keys were checked against the field lists from code.claude.com (sub-agents and skills pages). The `claude-code-guide` subagent fetched those docs this session.
4. **`skills:` syntax.** The value form was confirmed from the sub-agents doc example, which uses a YAML list.
5. **Installed version.** The superpowers version was read from `~/.claude/plugins/installed_plugins.json` and from the official marketplace's `marketplace.json` pin.
6. **Upstream diff.** `git diff v6.4.1 v6.4.2` was run in a fresh clone.

## Findings

1. **Critical (fixed): reviewers could not load the skills they cite.** `phase-reviewer` cites the `sandpane-phase-gates` gates as authority. Its tool allowlist (`Read, Grep, Glob, Bash`) has no Skill tool, so the gates were never in its context unless it happened to open the file. `security-reviewer` had the same gap for the Git and SBX rules.
2. **Critical (dispositioned): the superpowers version was silently downgraded.** Audit 0012 implied the plugin gave the same 6.4.2 as the vendored copies, but the official marketplace pins 6.4.1 (`5bf4e78`). `claude plugin update … --scope project --json` reported `"up_to_date"`, version 6.4.1. Upstream 6.4.2 changes only `skills/writing-plans` (+34/−71).
3. **Suggestion (fixed): `core-protocol` was stale against the code.** It was missing the `NOT_FOUND` error code, the per-task `afterSequences` cursors (bounded at 4096), the 4 MiB `MAX_FRAME_BYTES` cap, the oversized-replay `VALIDATION_FAILED` refusal, the bounded read methods, and `Method::ALL` with the drift gate.
4. **Suggestion (fixed): stale error list in `core-engineer`.** Its error-code list lacked `NOT_FOUND`, and one superpowers reference was not namespaced.
5. **Suggestion (fixed): unsupported field in `sandpane-changelog`.** `priority: 10` is not a documented skill frontmatter field.
6. **Nice-to-have (fixed): commands had no `argument-hint`.** The values are quoted, because an unquoted `[...]` parses as a YAML list.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| 1 | fixed pre-commit | Each agent preloads its governing skill (YAML list): engineers get `core-protocol` or `sbx-cli-integration`; `test-engineer` and `phase-reviewer` get `sandpane-phase-gates`; `security-reviewer` gets `git-safe-tasks` and `sbx-cli-integration`; `docs-maintainer` gets `sandpane-changelog`. Preloading of project skills by name is inferred from the docs, not stated there. It needs confirmation after a session restart. |
| 2 | accepted (user decision) | The user chose to stay on official 6.4.1 over obra's own marketplace, which would add an unpinned, duplicate plugin ID. The version is recorded in `docs/compatibility.md`, and 0012 carries a correction note. |
| 3–6 | fixed pre-commit | `NOT_FOUND` is in code but not yet in specs/02 §2. The skill says so; the spec was not edited. |

## Verification evidence

- **Plugin refresh.** `claude plugin marketplace update claude-plugins-official` succeeded. `claude plugin update superpowers@claude-plugins-official --scope project --json` returned `{"updateOutcome":"up_to_date","oldVersion":"6.4.1","newVersion":"6.4.1"}`.
- **Marketplace pin.** The official marketplace entry is `"source":{"source":"url","url":"https://github.com/obra/superpowers.git","sha":"5bf4e78…"}`. Upstream tags: `v6.4.1^{}` = `5bf4e78`, `v6.4.2^{}` = `8ca22db` = HEAD.
- **Installed version.** `installed_plugins.json` shows `user 6.4.1 5bf4e78` and `project 6.4.1 5bf4e78`.
- **Harness version.** `claude --version` → `2.1.288 (Claude Code)`.
- **Frontmatter.** The PyYAML parse of 17 files passed with no undocumented keys. Every `skills:` entry resolves to an existing `.claude/skills/<name>/SKILL.md`, and all `argument-hint` values parse as strings.
- **Code anchors.** `MAX_FRAME_BYTES = 4 * 1024 * 1024`, `MAX_SUBSCRIBE_CURSORS = 4096`, `MAX_LIST_LIMIT = 500`, and `ErrorCode::NotFound => "NOT_FOUND"` are present. `afterSequences` is ignored when `taskId` is set (`sandpane-protocol` lib.rs:395).
- **Not verified:** that agents actually preload project skills and that commands show their hints. Both need a restarted Claude Code session.

**Docs/tooling checklist tier, orchestrator inline: 1 Critical fixed, 1 Critical dispositioned by user decision, 3 Suggestions and 1 Nice-to-have fixed. PASS.**
