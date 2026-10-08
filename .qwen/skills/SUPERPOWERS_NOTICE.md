# Vendored: Superpowers skills

The skill directories in this folder that are **not** prefixed `sandpane-` and not otherwise project-authored are vendored verbatim from the **Superpowers** plugin:

- Source: https://github.com/obra/superpowers (vendored from local marketplace cache, version 5.1.0)
- Author: Jesse Vincent (jesse@fsck.com)
- License: MIT — full text in [`SUPERPOWERS_LICENSE`](SUPERPOWERS_LICENSE)

Vendored skills (14): `brainstorming`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `using-superpowers`, `verification-before-completion`, `writing-plans`, `writing-skills`.

## Local adaptation notes

- Skill bodies are unmodified. Cross-references like `superpowers:test-driven-development` refer to the sibling vendored skill of that name in this folder.
- References to Claude Code tool names (TodoWrite, Skill, Task) map to Qwen Code equivalents (`todo_write`, `skill` tool, `agent` tool).
- Sandpane-specific rules in `/AGENTS.md` and `docs/specs/06_SECURITY_AND_LICENSING.md` take precedence over any vendored skill guidance (per `using-superpowers`' own instruction-priority rule).

Vendored on 2026-10-09 during implementation entry 0002 (see `docs/CHANGELOG.md`).
