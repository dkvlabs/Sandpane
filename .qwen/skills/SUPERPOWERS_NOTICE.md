# Vendored: Superpowers skills

The skill directories in this folder that are **not** Sandpane-authored are installed verbatim from the **Superpowers** repository:

- Source: https://github.com/obra/superpowers (cloned directly from GitHub)
- Version: **6.4.2** — commit `8ca22dba9a94f28898bbce59f2537ff4d87c747d` (2026-09-25, "Release v6.4.2: leaner plans from writing-plans (#2384)")
- Author: Jesse Vincent (jesse@fsck.com)
- License: MIT — full text in [`SUPERPOWERS_LICENSE`](SUPERPOWERS_LICENSE)
- Installed: 2026-10-09 into this project only (`.qwen/skills/`, not user-global)

Installed skills (15): `brainstorming`, `diagnosing-superpowers`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `using-superpowers`, `verification-before-completion`, `writing-plans`, `writing-skills`.

Sandpane-authored skills in this folder (5): `sandpane-changelog`, `sandpane-phase-gates`, `sbx-cli-integration`, `git-safe-tasks`, `core-protocol`.

## History

- 2026-10-09 (entry 0002): initial vendoring of 14 skills from a local marketplace cache of v5.1.0.
- 2026-10-09 (entry 0003): replaced with the canonical GitHub v6.4.2 — all 14 skills updated, `diagnosing-superpowers` added; byte-identical to source verified via `diff -rq`.

## Local adaptation notes

- Skill bodies are unmodified. Cross-references like `superpowers:test-driven-development` refer to the sibling skill of that name in this folder.
- References to Claude Code tool names (TodoWrite, Skill, Task) map to Qwen Code equivalents (`todo_write`, `skill` tool, `agent` tool). The upstream repo's `hooks/`, `index.js`, and harness manifests are Claude Code plugin plumbing and are intentionally NOT installed — Qwen Code discovers skills directly from this folder.
- Sandpane-specific rules in `/AGENTS.md` and `docs/specs/06_SECURITY_AND_LICENSING.md` take precedence over any vendored skill guidance (per `using-superpowers`' own instruction-priority rule).
