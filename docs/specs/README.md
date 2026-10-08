# Sandpane — DKV Labs implementation package

**Version:** planning baseline 1.0 · **Date:** 08.10.2026 · **Status:** specification, not implemented

> **Sandpane:** One workspace. Every coding agent. Isolated by design.

An independent, local-first developer workspace for Docker Sandboxes (`sbx`), multi-project AI coding, persistent conversations, parallel isolated tasks, Git-safe review, and a native-feeling interface in VS Code, JetBrains IDEs, and a cross-platform desktop app.

## Read in this order

| File | Purpose |
|---|---|
| [01_MASTER_PLAN.md](01_MASTER_PLAN.md) | Product vision, capabilities, complete modules, product boundaries, acceptance criteria |
| [02_ARCHITECTURE_AND_DATA.md](02_ARCHITECTURE_AND_DATA.md) | Shared persistent core, IPC, persistence, task model, agent protocols, concurrency |
| [03_VSCODE_EXTENSION.md](03_VSCODE_EXTENSION.md) | Copilot-style VS Code integration specification |
| [04_JETBRAINS_PLUGIN.md](04_JETBRAINS_PLUGIN.md) | Native IntelliJ Platform plugin implementation |
| [05_DESKTOP_APP.md](05_DESKTOP_APP.md) | Tauri 2 cross-platform standalone application |
| [06_SECURITY_AND_LICENSING.md](06_SECURITY_AND_LICENSING.md) | License review gate, safe execution, credentials, Git and network safety |
| [07_ROADMAP_AND_TASKS.md](07_ROADMAP_AND_TASKS.md) | Ordered phases, implementation checklists, dependencies and release gates |
| [08_TESTING_AND_RELEASE.md](08_TESTING_AND_RELEASE.md) | Verification matrix, platform testing, packaging and publication |

## Explicit product boundaries

- **Not** an alternative to Docker's runtime. Docker SBX is installed and licensed separately by the user.
- **Not** a terminal embedded in an IDE. Chat and management are first-class graphical workflows; an advanced terminal is optional.
- **Not** an imitation or interception of proprietary ChatGPT, Claude Desktop, GitHub Copilot, or JetBrains AI Assistant internals.
- **Not** a universal agent API: every coding-agent adapter must independently prove streaming, cancellation, session persistence, and sandbox execution.
- **Not** a statement of Docker authorization. Public distribution requires an explicit licensing/legal review gate.

## Implementation priorities

1. Licensing + SBX/agent feasibility spikes.
2. Shared Rust core service and SQLite-backed multi-project/session models.
3. VS Code extension with Codex, task isolation, and change review.
4. Standalone desktop app and native-app SSH connection wizard.
5. JetBrains plugin.
6. More agent adapters, full supported SBX management, and automation.

Each client can ship and version independently, while sharing a versioned core protocol.

## Primary references to validate against when implementing

- Docker SBX CLI: https://docs.docker.com/reference/cli/sbx/
- Docker Sandboxes workflows: https://docs.docker.com/ai/sandboxes/
- Docker editor/native-app connections: https://docs.docker.com/ai/sandboxes/integrations/
- Docker license terms: https://www.docker.com/legal/docker-subscription-service-agreement/
- VS Code extension guides: https://code.visualstudio.com/api
- JetBrains IntelliJ Platform SDK: https://plugins.jetbrains.com/docs/intellij/welcome.html
- Tauri v2: https://v2.tauri.app/
- Codex app-server documentation: https://developers.openai.com/codex/app-server/
- Claude Agent SDK: https://platform.claude.com/docs/en/agent-sdk/overview

**Keep a verified compatibility matrix with exact CLI/IDE/agent versions.** This is a design plan; examples are not proof that every discussed command or adapter works with every future release.

## Demo project naming

Public-facing demo projects use fictional names **Atlas Demo**, **Nova Demo**, and **Orbit Demo**. The DKV Labs publisher branding is unchanged. This is a sample-data rule only; actual user project names should never be overwritten by the application.
