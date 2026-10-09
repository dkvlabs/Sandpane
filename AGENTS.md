# AGENTS.md — Sandpane (DKV Labs)

Instructions for every AI agent working in this repository. Read fully before changing anything. User instructions in a session take precedence over this file; this file takes precedence over default agent behavior.

## What Sandpane is

Sandpane is an open-source, local-first **AI development workspace and Docker Sandboxes (`sbx`) manager**: isolated environments, multiple projects, parallel coding-agent chats, real execution visibility, verification, and Git-safe review — from VS Code, JetBrains IDEs, and a standalone Tauri desktop app, all attached to **one persistent per-user Rust Core** over authenticated local IPC.

The authoritative specification lives in [`docs/specs/`](docs/specs/README.md). Start with `01_MASTER_PLAN.md`; obey `06_SECURITY_AND_LICENSING.md` absolutely; implement in the order of `07_ROADMAP_AND_TASKS.md`.

## MANDATORY: implementation logging rule

> **After each big implementation: commit, auto-review, log in `docs/audit/`, and create a changelog entry in `docs/CHANGELOG.md` with the implementation details, model used, and tokens used (input, cached, output). If you don't have specific information for the changelog, use a dash (e.g., `model: -`). Never guess or fabricate numbers.**

A "big implementation" is any coherent deliverable that would be its own commit series: a phase, module, client skeleton, docs rebuild, or infrastructure addition. The operational procedure (numbering, formats, review method, where model/token figures come from) is defined by the **`sandpane-changelog` skill** (`.qwen/skills/sandpane-changelog/SKILL.md`) — invoke it; do not improvise the format.

Flow per implementation (details in the skill):

1. Implement the change.
2. Run the auto-review **before committing** — method scaled to risk per the `sandpane-changelog` skill: read-only `phase-reviewer` agent (plus `security-reviewer` for execution/IPC/credential/git/webview surfaces) for code; a checklist pass for docs/tooling. Use the bundled `/review` fan-out only when the user explicitly asks for it.
3. Fix or disposition every Critical finding; commit the implementation.
4. Write `docs/audit/NNNN-<slug>-review.md` (scope, method, findings, disposition, verification evidence).
5. Add entry `NNNN` to `docs/CHANGELOG.md` immediately above the bottom append marker (chronological — numbers ascend, newest last), with `-` for every unknown value.
6. Commit the log as `docs(audit): log implementation NNNN — <title>`.

## Repository layout

```text
AGENTS.md            ← this file (agent contract)
README.md            ← project overview and quickstart
LICENSE              ← MIT (original Sandpane code; see docs/licensing-decision.md)
docs/                ← specs/, design/, audit/, CHANGELOG.md, P0 records
schemas/             ← versioned JSON schemas for the Core protocol and events
core/                ← Rust workspace: sandpane-protocol, sandpane-core, sandpane-service
clients/vscode/      ← VS Code extension (TypeScript)
clients/jetbrains/   ← IntelliJ Platform plugin (Kotlin, Gradle)
apps/desktop/        ← Tauri 2 desktop app (React + Rust shell)
.qwen/agents/        ← project subagent definitions (role-specialized)
.qwen/skills/        ← project skills + vendored superpowers (MIT, see SUPERPOWERS_NOTICE.md)
.qwen/commands/      ← project slash commands (/log-implementation, /audit-review, /phase-status)
```

## Commands

| Task | Command |
|---|---|
| Core format/lint/test | `make core-check` (or `cd core && cargo fmt --check && cargo clippy -- -D warnings && cargo test`) |
| VS Code typecheck/test | `cd clients/vscode && npm run typecheck && npm test` |
| Desktop typecheck/test | `cd apps/desktop && npm run typecheck && npm test` |
| JetBrains | `cd clients/jetbrains && ./gradlew build` (requires local Gradle/JDK; not verifiable on every host — record honestly) |
| Schema syntax + protocol drift gate | `make schema-lint && make schema-drift` (both in `make check`) |
| Everything | `make check` |

## Non-negotiable engineering rules (from docs/specs)

1. **No shell interpolation, ever.** SBX/Git/subprocess calls are typed argument vectors (`std::process::Command` style). Never `sh -c` with interpolated input. Validate sandbox names, paths, refs, ports against strict allowlists (`sandpane_core::validation`).
2. **Single source of truth.** Docker SBX owns sandbox state; the Core owns project/task/conversation state in SQLite. Clients never keep authoritative databases and never parent agent processes.
3. **Task state transitions are enforced in Core**, emitted as durable append-only events **before** subscribers are notified. Never fabricate `running`/`resumed` state after a restart — reconcile and mark `interrupted`.
4. **Git safety.** Never overwrite uncommitted host changes; record `base_commit`; apply only via explicit Git operations with conflict detection and user confirmation. Direct-mount mode must always be labeled live-writable.
5. **Honesty.** No fake success UI, no mocked integration presented as real, no capability claimed without a verified adapter path. Unsupported = visibly unsupported. Verification claims require fresh command output (superpowers `verification-before-completion`).
6. **Licensing gate.** Public release of SBX-integrated artifacts is blocked until `docs/licensing-decision.md` gates are checked. Never bundle `sbx` binaries. Never access proprietary ChatGPT/Claude Desktop/Copilot/JetBrains AI internals. MIT covers original Sandpane code only.
7. **Secrets.** Never scrape, mirror, or log credentials. SBX secrets: presence metadata only. Redact tokens/keys from logs, events, and exports (best-effort, documented).
8. **Demo data** uses fictional project names Atlas Demo / Nova Demo / Orbit Demo only.

## Agents and skills map

Specialized subagents (`.qwen/agents/`): `core-engineer`, `sbx-integration-engineer`, `vscode-engineer`, `jetbrains-engineer`, `desktop-engineer`, `test-engineer`, `security-reviewer`, `docs-maintainer`, `phase-reviewer`. Delegate phase work to the matching agent; keep the logging discipline in the orchestrator.

Project skills (`.qwen/skills/`): `sandpane-changelog` (logging system — mandatory), `sandpane-phase-gates` (acceptance checks per phase), `sbx-cli-integration`, `git-safe-tasks`, `core-protocol`.

**Superpowers** (vendored, MIT — see `.qwen/skills/SUPERPOWERS_NOTICE.md`): use `using-superpowers` to start, `writing-plans`/`executing-plans` for planned work, `test-driven-development` for code, `requesting-code-review` around reviews, `verification-before-completion` before ANY completion claim. When a superpowers skill and this file conflict, this file and `docs/specs/06_SECURITY_AND_LICENSING.md` win.

## Conventions

- Rust: `cargo fmt` + `clippy -D warnings` clean before commit; unit tests beside code, integration tests in `tests/`.
- TypeScript: strict mode; no `any` without a recorded reason; vitest for unit tests.
- Kotlin: public IntelliJ Platform APIs only; never block EDT; `PersistentStateComponent` for UI-only state.
- Commits: Conventional Commits (`feat(core):`, `docs(audit):`, …). Every implementation commit is followed by its `docs(audit)` logging commit.
- Protocol changes touch `schemas/` + generated/hand-synced client types together; note drift-check status in the changelog entry.
- Record verified versions in `docs/compatibility.md` whenever you prove something against a real tool.

## Code Review

Project-specific rules reviewers MUST enforce. Report a violation only when you can quote the exact rule below and cite the exact changed line that breaks it (name this section as the source). No style preferences.

1. **No shell interpolation.** Any subprocess (`std::process::Command`, Node `child_process`, Kotlin `ProcessBuilder`) must use an argument vector/list. A changed line that builds a command string for a shell, or interpolates an external value into one, is Critical. `sh -c`, `bash -lc`, string-concatenated `git`/`sbx` invocations → Critical.
2. **Validate before argument.** Any external value (sandbox name, path, ref, port, agent id) that reaches a CLI argument vector must pass `sandpane_core::validation` (or the client equivalent) first. An unvalidated external value flowing into an arg → Critical.
3. **Task state transitions in Core only.** A client/UI file that computes or asserts a task lifecycle transition instead of reading Core state → Warning (Critical if it fabricates a `running`/`resumed` state after restart).
4. **Durable-before-notify.** A change that notifies subscribers of a task event before it is appended durably (`task_events`) → Critical.
5. **Honest capability/verification claims.** `verified: true`, `supportsResume: true`, a green status, or a passing check with no evidence path → Critical. Tests that mock the unit under test, or fixtures labeled as captured when they are illustrative → Critical.
6. **No secrets in logs/events/exports.** A changed line that writes a token/key/secret value (not presence metadata) to a log, event payload, or export → Critical.
7. **Git apply safety.** A change that writes host-repo files outside an explicit, base-checked, confirmed Git operation (merge/cherry-pick/patch) → Critical. Overwriting uncommitted host work → Critical.
8. **Protocol/schema together.** A change to `sandpane-protocol` types or `schemas/*.json` that updates one without the other, or breaks frame compatibility without a version bump → Warning (Critical if it silently desyncs a shipped client).
9. **Bounded IPC frames.** A read path that buffers unbounded input without the `MAX_FRAME_BYTES` cap → Warning.
10. **Licensing gate.** Bundling a third-party binary (e.g. `sbx`), or claiming Docker affiliation/endorsement → Critical.
