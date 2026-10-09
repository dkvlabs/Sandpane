# 0012 — Auto-review record: Claude Code migration + Superpowers as project plugin

- **date:** 2026-10-09
- **implementation commit:** `edd6eac` — chore(tooling): migrate agent config from Qwen Code to Claude Code; superpowers as project plugin (101 files, +47/−11182)
- **review ran:** before the commit, on the same staged diff, per `audit/README.md`

## Scope

Tooling/docs only — no product code. The staged diff covered:

- `.qwen/` → `.claude/` renames for 9 agents, 3 commands and the 5 Sandpane skills.
- Deletion of the rest of `.qwen/`: the 15 vendored Superpowers skills, `SUPERPOWERS_LICENSE` and `SUPERPOWERS_NOTICE.md`.
- New `.claude/settings.json`.
- Edits to `AGENTS.md`, `README.md`, `LICENSE`, `clients/vscode/LICENSE`, `.gitignore` and `docs/audit/README.md`.
- Removal from the index of 9 staged-but-never-committed `.claude/tmp/` Qwen review artifacts. They never reached a commit.

Historical records (`docs/CHANGELOG.md` entries 0001–0011 and `docs/audit/0000–0011`) were deliberately left untouched. They are append-only history and still mention `.qwen/`.

## Method

The orchestrator ran an inline docs/tooling checklist pass, the lighter tier allowed by `sandpane-changelog`. No `/code-review` fan-out was launched. The pass covered:

1. Upstream parity: a fresh `git clone --depth 1` of obra/superpowers was diffed against the previously vendored copies.
2. Claude Code config syntax was checked against the official docs by a `claude-code-guide` subagent. Sources: code.claude.com sub-agents, skills, plugins and settings pages. Checks covered agent `tools`/`permissionMode`, `$ARGUMENTS`, `enabledPlugins`, and the recommended `.gitignore` entries.
3. A repo-wide `qwen` reference sweep.
4. A relative-link walk over the changed Markdown.
5. A frontmatter check of all agents, skills and commands.
6. Confirmation that no junk files were staged.

## Findings

1. **Critical (fixed): the review gate was unusable under Claude Code.** In `.claude/agents/phase-reviewer.md` and `security-reviewer.md`, the `tools:` field listed Qwen tool names (`read_file`, `grep_search`, `run_shell_command`). Claude Code cannot resolve those names, so both reviewers had no working tools. That would break the review gate AGENTS.md makes mandatory.
2. **Suggestion (fixed): `approvalMode` did nothing in Claude Code.** All 9 agents set it, but Claude Code silently ignores the field.
3. **Suggestion (fixed): command arguments were dropped.** All 3 commands used the Qwen `{{args}}` placeholder, which Claude Code does not substitute, so `/audit-review HEAD~2..HEAD` lost its range.
4. **Suggestion (fixed): duplicate skills.** The user has `superpowers@claude-plugins-official` enabled globally, so the vendored copies loaded every skill twice (`brainstorming` and `superpowers:brainstorming`).
5. **Suggestion (fixed): stale Qwen sources in `sandpane-changelog`.** Its model/token table pointed at Qwen-only sources (`~/.qwen/settings.json`, `.qwen/reviews/*-cost-ledger.json`, `get_goal`).
6. **Nice-to-have (documented): the plugin is not auto-installed.** A committed `enabledPlugins` entry enables the plugin but does not download it, so each clone needs a one-time `claude plugin install superpowers@claude-plugins-official --scope project`.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| 1 | fixed pre-commit | Tools are now `Read, Grep, Glob, Bash`. `permissionMode: plan` was deliberately not used: it can block the reviewers' test/build runs, and it is ignored when the parent session runs in acceptEdits or auto mode. Read-only is enforced by the tool allowlist (no Edit/Write). |
| 2 | fixed pre-commit | `auto-edit` → `permissionMode: acceptEdits` |
| 3 | fixed pre-commit | `$ARGUMENTS` |
| 4 | fixed pre-commit | Vendored copies removed. The plugin is enabled at project scope in `.claude/settings.json`; this was the user's choice in session. |
| 5 | fixed pre-commit | The table now names Claude Code `/status` / `/cost` and keeps the dash rule. `/review` references changed to `/code-review`. |
| 6 | accepted, documented | The setup command is in `AGENTS.md` and `README.md`. |

## Verification evidence

- Upstream parity: `git clone --depth 1 https://github.com/obra/superpowers` returned HEAD `8ca22dba9a94f28898bbce59f2537ff4d87c747d` (v6.4.2, 2026-09-25). `diff -rq` reported all 15 vendored skills identical and `cmp` reported LICENSE identical. The plugin path therefore gives the same version the project had pinned.
- Plugin ID: `~/.claude/settings.json` already enables `superpowers@claude-plugins-official`, and this session lists the `superpowers:*` skills. The ID resolves on this host. Whether it resolves on other hosts was not verified.
- `git grep -n -i qwen` (excluding historical audit and changelog records) returned no matches.
- The relative-link walk over AGENTS.md, README.md, docs/audit/README.md and `.claude/**/*.md` found 0 broken links.
- All agent, skill and command files have well-formed frontmatter, and none contains `approvalMode`, `read_file` or `{{args}}`.
- `python3 -m json.tool .claude/settings.json` succeeded.
- `git diff --cached --name-only | grep -E 'tmp/|DS_Store'` returned nothing.
- Not verified: a fresh Claude Code session loading the reconfigured agents, which needs a session restart. No `make check` was run, because the commit touches no code paths.

**Docs/tooling checklist tier, orchestrator inline: 1 Critical and 4 Suggestions fixed pre-commit, 1 Nice-to-have documented. PASS.**
