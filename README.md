# Sandpane

**One workspace. Every coding agent. Isolated by design.**

Sandpane is an open-source, local-first **AI development workspace and Docker Sandboxes (`sbx`) manager** by DKV Labs. Create isolated environments, open several projects, run multiple coding-agent chats at once, watch real execution, run tests, review actual Git diffs, and merge approved changes — from VS Code, JetBrains IDEs, or a standalone desktop app, all connected to one persistent per-user Core service.

> **Status:** implementation scaffold phase. The specifications in [`docs/specs/`](docs/specs/README.md) are authoritative; progress and evidence are logged in [`docs/CHANGELOG.md`](docs/CHANGELOG.md) with auto-review records in [`docs/audit/`](docs/audit/README.md). Public release of SBX-integrated artifacts is gated on [`docs/licensing-decision.md`](docs/licensing-decision.md).

> **Independence notice:** Sandpane is an independent open-source developer tool published by DKV Labs. It is not affiliated with or endorsed by Docker, Inc. Docker Sandboxes is installed, licensed, and authenticated separately by the user. Sandpane never bundles `sbx` binaries.

## Primary flow

Open project → Detect stack → Pick agent → Create isolated SBX environment → Start chat/task → Watch real execution → Run tests → Review diff → Apply approved changes.

## Repository layout

| Path | What it is |
|---|---|
| [`docs/specs/`](docs/specs/README.md) | Authoritative 8-document implementation specification (master plan, architecture/data, VS Code, JetBrains, desktop, security/licensing, roadmap, testing/release) |
| [`docs/design/`](docs/design/README.md) | Desktop visual design reference and final design agent prompt (mockup data only) |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) · [`docs/audit/`](docs/audit/README.md) | Implementation log and auto-review evidence trail |
| [`schemas/`](schemas/) | Versioned JSON schemas for the Core RPC protocol and agent events |
| [`core/`](core/) | Rust workspace — `sandpane-protocol`, `sandpane-core`, `sandpane-service` (persistent daemon, SQLite, SBX adapter, task supervisor) |
| [`clients/vscode/`](clients/vscode/) | VS Code extension (TypeScript) — Copilot-style sidebar, sandbox picker, diff review |
| [`clients/jetbrains/`](clients/jetbrains/) | IntelliJ Platform plugin (Kotlin) — native Tool Window |
| [`apps/desktop/`](apps/desktop/) | Tauri 2 desktop app (React) — project cockpit and global activity |
| [`AGENTS.md`](AGENTS.md) | Contract for AI agents working in this repo (includes the mandatory logging rule) |
| [`.qwen/`](.qwen/skills/SUPERPOWERS_NOTICE.md) | Project subagents, skills (incl. vendored MIT Superpowers), and slash commands |

## Getting started (development)

Prerequisites: Rust stable (rustfmt + clippy), Node 20+, and — for real sandbox functionality — Docker Sandboxes (`sbx`) installed and licensed separately (see [docs/compatibility.md](docs/compatibility.md) for the verified matrix).

```bash
make core-check          # cargo fmt --check + clippy -D warnings + cargo test in core/
make vscode-check        # typecheck + unit tests for clients/vscode
make desktop-check       # typecheck + unit tests for apps/desktop
make check               # everything verifiable on this host
```

JetBrains plugin: `cd clients/jetbrains && ./gradlew build` (requires Gradle + a supported JDK; run the Plugin Verifier before any release).

## Working on Sandpane with an AI agent

1. Read [`AGENTS.md`](AGENTS.md) — engineering rules, safety gates, logging obligation.
2. Follow [`docs/specs/07_ROADMAP_AND_TASKS.md`](docs/specs/07_ROADMAP_AND_TASKS.md) in phase order; do not assume later-phase modules exist.
3. Use the project skills: `sandpane-changelog` (logging), `sandpane-phase-gates` (acceptance), `sbx-cli-integration`, `git-safe-tasks`, `core-protocol`; and the vendored Superpowers workflow skills (`using-superpowers` first).
4. Every big implementation ends with: commit → auto-review → `docs/audit/NNNN-*-review.md` → `docs/CHANGELOG.md` entry `NNNN` (unknown values recorded as `-`).

## License

MIT for original Sandpane code — see [LICENSE](LICENSE) and the redistribution gates in [docs/licensing-decision.md](docs/licensing-decision.md). Vendored Superpowers skills are MIT © 2025 Jesse Vincent.
