# 0000 — Execution plan: AI workspace foundation + product scaffold

**Date:** 09.10.2026 · **Host:** macOS 27.0.1 (arm64) · **Toolchains:** Rust 1.99, Node 24.5, Java 23 · **Missing locally:** `sbx` CLI, Gradle/Kotlin toolchain

## Objective (from goal)

Read `docs/specs/01_MASTER_PLAN.md` (formerly `docs/SANDPANE_IMPLEMENTATION/01_MASTER_PLAN.md`) and implement everything from it: create agents, skills, and every file for the AI to use; rebuild the docs folder; after each big implementation commit, auto-review, log in `docs/audit/`, and add a changelog entry with details, model used, and tokens used (input, cached, output), using `-` for unknown values. Add the logging rule to `AGENTS.md`, create a skill for the logging system, and use the superpowers skill methodology.

## Method

Superpowers methodology (MIT, Jesse Vincent — vendored under `.qwen/skills/`): plan first, execute in phases, verification-before-completion (evidence before claims), auto-review each phase, no completion claims without fresh verification output.

## Phases (each = one changelog entry + one audit review)

| Entry | Phase | Deliverable | Verification |
|---|---|---|---|
| 0001 | Docs rebuild | `docs/specs/`, `docs/design/` dedup, `docs/audit/`, `CHANGELOG.md`, `compatibility.md`, `licensing-decision.md`, index | link check, `git status` clean |
| 0002 | AI operations foundation | `AGENTS.md` (with logging rule), `.qwen/agents/` (9 subagents), `.qwen/skills/` (5 project skills + vendored superpowers), `.qwen/commands/` (3), root `README.md`, `LICENSE`, `.gitignore`, `rust-toolchain.toml` | frontmatter parse check, link check |
| 0003 | Protocol + Rust Core | `schemas/` JSON schemas; `core/` Cargo workspace: `sandpane-protocol`, `sandpane-core` (task state machine, SQLite schema/migrations, event log, scheduler, SBX adapter, Git workspace modes, validation), `sandpane-service` (Unix-socket JSON-lines daemon) | `cargo fmt --check`, `cargo clippy`, `cargo test` all green |
| 0004 | VS Code client | `clients/vscode/` extension skeleton per `specs/03`: manifest, activation, core-client (socket, framing, events), context/diff/diagnostics modules, webview app, unit tests | `npm run typecheck`, `npm test` green |
| 0005 | Desktop app | `apps/desktop/` Tauri 2 skeleton per `specs/05`: React shell with full IA routes, core-client lib, `src-tauri` Rust side (not built here) | `npm run typecheck`, `npm test` green; Tauri build deferred (documented) |
| 0006 | JetBrains plugin | `clients/jetbrains/` Gradle IntelliJ Platform 2.x skeleton per `specs/04`: plugin.xml, tool window, core client, actions, services | file-level checks only; Gradle build NOT verifiable locally (no toolchain) — recorded honestly |
| 0007 | CI + integration | `.github/workflows/ci.yml` per `specs/08` §6, `Makefile`, final README/docs sync | fresh full verification run of all suites |

## Actual entry mapping (updated 09.10.2026 as phases land)

Changelog numbers are assigned by **commit chronology**, not by this plan's table (which stays as the original plan of record):

| Plan entry | Actually became | Why |
|---|---|---|
| 0003 Protocol + Rust Core | CHANGELOG **0004** | User-requested superpowers v6.4.2 install took 0003 mid-session |
| 0007 CI + integration | CHANGELOG **0005** | CI/drift-gate work is non-overlapping with the client scaffolds, so it landed first while three client agents ran in the background |
| 0004 VS Code client | CHANGELOG **0006** (`39bfaa2`) | parallel scaffold; reviewed via lighter path (user directive) |
| 0005 Desktop app | CHANGELOG **0007** (`136231b`) | parallel scaffold; lighter path, disclosed |
| 0006 JetBrains plugin | CHANGELOG **0008** (`137524a`) | parallel scaffold; file-level-only review, JB0 build gate open |
| 0007 (final sync half) | CHANGELOG **0009** | `make check` aggregation + README/docs sync + plan close-out |

Two follow-up tooling commits (`a2634bd`, `5052102` — logging-rule alignment) are folded into entry 0009 per the skill's "trivial fixes fold into the next entry" rule.

## Scope boundaries (honest limits)

- P0 legal clearance and real `sbx` fixtures cannot be produced on this machine (`sbx` not installed; Docker written position requires humans). `docs/licensing-decision.md` and `docs/compatibility.md` record the gates as OPEN; SBX adapter fixtures are explicitly marked illustrative until captured from a real CLI.
- JetBrains and Tauri builds are scaffolded but not compiled here (toolchain weight/absence); recorded as unverified in their entries.
- No fake success UI, no mocked integration presented as real (specs/07 §Instructions rule 4).

## Definition of done

1. All 7 entries logged in `docs/CHANGELOG.md` with matching `docs/audit/NNNN-*-review.md`.
2. `AGENTS.md` contains the mandatory logging rule; `sandpane-changelog` skill exists.
3. Agents + skills + commands present and parseable; superpowers vendored with attribution.
4. Docs folder rebuilt with no broken relative links and no duplicate files.
5. `cargo test` (core), `npm test`/`typecheck` (vscode, desktop) pass with fresh output.
6. Every implementation committed; working tree clean at the end.
