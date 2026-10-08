# Sandpane documentation

**Publisher:** DKV Labs · **Rebuilt:** 09.10.2026

One workspace. Every coding agent. Isolated by design.

This folder is the documentation home for Sandpane — an independent, local-first AI development workspace and Docker Sandboxes (`sbx`) manager for VS Code, JetBrains IDEs, and a standalone desktop app, all sharing one persistent Rust Core.

## Layout

| Path | Purpose |
|---|---|
| [specs/](specs/README.md) | The authoritative implementation specification (8 documents). Start with `01_MASTER_PLAN.md`. |
| [design/](design/README.md) | Desktop visual design reference, design spec, final design agent prompt, HTML mockup and preview screenshots (mockup data only). |
| [CHANGELOG.md](CHANGELOG.md) | Implementation changelog. Every big implementation step is logged here with details, review link, model, and token usage. |
| [audit/](audit/README.md) | Auto-review records and the execution plan. One review file per logged implementation. |
| [compatibility.md](compatibility.md) | Verified platform / SBX / agent / IDE compatibility matrix (P0 record). |
| [licensing-decision.md](licensing-decision.md) | Docker licensing gate decision record (P0 blocker). |

## Reading order for implementers

1. [specs/README.md](specs/README.md) — package overview and product boundaries
2. [specs/01_MASTER_PLAN.md](specs/01_MASTER_PLAN.md) — vision, modules, workflows, release gates
3. [specs/02_ARCHITECTURE_AND_DATA.md](specs/02_ARCHITECTURE_AND_DATA.md) — Core, IPC, persistence, task model
4. [specs/06_SECURITY_AND_LICENSING.md](specs/06_SECURITY_AND_LICENSING.md) — safety rules and legal gate
5. [specs/07_ROADMAP_AND_TASKS.md](specs/07_ROADMAP_AND_TASKS.md) — phased delivery order and exit criteria
6. The client spec you are implementing: [03_VSCODE_EXTENSION.md](specs/03_VSCODE_EXTENSION.md), [04_JETBRAINS_PLUGIN.md](specs/04_JETBRAINS_PLUGIN.md), [05_DESKTOP_APP.md](specs/05_DESKTOP_APP.md)
7. [specs/08_TESTING_AND_RELEASE.md](specs/08_TESTING_AND_RELEASE.md) — verification matrix and publishing

## Working agreements

- AI agents working in this repository must read and follow [`/AGENTS.md`](../AGENTS.md), including the mandatory implementation-logging rule (commit → auto-review → `docs/audit/` record → `docs/CHANGELOG.md` entry).
- Implementation progress is tracked in [CHANGELOG.md](CHANGELOG.md); review evidence lives in [audit/](audit/README.md).
- Public docs use the fictional demo project names **Atlas Demo**, **Nova Demo**, and **Orbit Demo** only.
- Screenshots and HTML mockups in `design/` contain illustrative sample data, never real execution results.

## Rebuild note (09.10.2026)

The docs folder was rebuilt: the implementation package moved from `docs/SANDPANE_IMPLEMENTATION/` to `docs/specs/`; byte-identical root-level duplicates of design files were removed in favor of `docs/design/`; the concatenated `SANDPANE_FULL_IMPLEMENTATION_PLAN.md` bundle was removed (the 8 spec files are the single source of truth); and `audit/`, `CHANGELOG.md`, `compatibility.md`, and `licensing-decision.md` were added. See [CHANGELOG.md](CHANGELOG.md) entry 0001 and [audit/0001-docs-rebuild-review.md](audit/0001-docs-rebuild-review.md).
