# Installing the Sandpane VS Code extension locally

How to package the extension as a `.vsix` and run it against a real Sandpane
Core service on your machine. This is the P3 "package + local installation
guide" deliverable (`docs/specs/07_ROADMAP_AND_TASKS.md`).

> **Honest state (scaffold stage):** the extension connects to a real Core,
> renders the sidebar, and exercises the full protocol client (project /
> sandbox / conversation / task surfaces, event replay with per-task cursors).
> Real sandbox operations need the Docker Sandboxes `sbx` CLI and a running
> Docker daemon — without them, sandbox views show Core's structured
> `NOT_INSTALLED` answer, never a fake success. Agent chats are seam-level
> until the P0 Codex-in-SBX feasibility gate closes
> ([`docs/compatibility.md`](../../docs/compatibility.md)). Marketplace
> publication is deliberately NOT done yet (licensing gate,
> [`docs/licensing-decision.md`](../../docs/licensing-decision.md)).

## 1. Build the Core service

The extension attaches to an already-running Core; it never launches,
upgrades, or stops one (ADR 1, `docs/specs/02 §10`).

```bash
cd core
cargo build -p sandpane-service        # debug build is fine for local use
```

## 2. Package the extension

```bash
cd clients/vscode
npm install --no-audit --no-fund       # dev dependencies only; zero runtime deps
npm run package                        # compile + vsce package
```

This produces `clients/vscode/sandpane-<version>.vsix` (verified with
`@vscode/vsce` 4.0.0; the artifact is gitignored — build it, don't commit it).

## 3. Install into VS Code

Either from the UI: Command Palette → **Extensions: Install from VSIX…** →
pick the file, or from a terminal:

```bash
code --install-extension clients/vscode/sandpane-0.0.1.vsix
```

Reload the window when prompted. The Sandpane icon appears in the Activity Bar
(activation: `onStartupFinished`).

## 4. Start the Core service

In a separate terminal:

```bash
core/target/debug/sandpane-service
```

On macOS the service listens on the per-user default socket:

```
~/Library/Application Support/sandpane/sandpane.sock
```

The extension connects there automatically. To use a different socket, either
start the service with `SANDPANE_SOCKET=/path/to/sandpane.sock` or set the
extension setting **Sandpane: Core Socket Path** (`sandpane.coreSocketPath`)
to the same path.

## 5. Verify

- The sidebar's **Projects & Chats** view lists the projects in the Core
  database (initially empty — create one from the view).
- Command Palette → **Sandpane: Start Task (Chat)** opens the chat seam.
- With `sbx` absent, sandbox views show the honest `NOT_INSTALLED` state from
  `system.probe` / `sandbox.list`.
- For a wire-level check against the same binary the extension talks to:
  `cd clients/vscode && npm run check:live` (55 checks; spawns its own
  disposable Core, does not touch your default socket or database).

## Uninstall

Command Palette → **Extensions: Show Installed Extensions** → Sandpane →
Uninstall. Nothing is left in VS Code; your Core database and socket are owned
by the service, not the extension — stop the service separately (Ctrl-C its
terminal).
