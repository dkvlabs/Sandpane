# Sandpane

**One workspace. Every coding agent. Isolated by design.**

Sandpane is an open-source, local-first **AI development workspace and Docker Sandboxes (`sbx`) manager** by DKV Labs. Create isolated environments, open several projects, run multiple coding-agent chats at once, watch real execution, run tests, review actual Git diffs, and merge approved changes — from VS Code, JetBrains IDEs, or a standalone desktop app, all connected to one persistent per-user Core service.

> **Status:** scaffold phase, with the Core protocol at its 34-method v1 surface (sandbox stop and two-step confirmed remove; durable idempotency keys with an explicit "Retry safely"; project rename, archive, repository add/remove and two-step confirmed delete that never touches host files; conversation rename, archive, two-step confirmed delete and a best-effort redacted export; a Task / Discuss send mode that Core records (neither runs an agent yet); a read-only per-file `git.diff` view; applying reviewed files to your working tree (staged, never committed) only after an explicit per-file confirmation, reachable only for tasks with Git context, which no wire-created task has until A4b; approved verification commands, each an exact argument list a user confirms, plus read-only suggestions from `project.context`. A command runs only inside the task's own sandbox through `sbx exec` with no shell, and Core keeps running disabled for every real `sbx` version until the user captures the C-1/C-2/C-5/C-7 proofs; `sbx` v0.47 has no start, so Start is shown as unsupported; the sbx status shows the daemon as running, stopped or unknown "at last check", read from the captured `sbx daemon status` text, plus whether verification runs are enabled for that sbx version and whether it matches the captured fixtures' version number). Rust Core (606 tests), VS Code extension (850 tests), desktop app (747 unit + 9 opt-in live tests; 36 shell tests) and JetBrains plugin (493 tests; Plugin Verifier `Compatible` with IntelliJ IDEA 2026.2.3) all build, test and package on the dev host — evidence in [`docs/CHANGELOG.md`](docs/CHANGELOG.md) and [`docs/audit/`](docs/audit/README.md). Real sandbox and agent execution remain gated: the Codex-in-SBX feasibility check is an open P0 blocker ([`docs/compatibility.md`](docs/compatibility.md)), and public release of SBX-integrated artifacts is gated on [`docs/licensing-decision.md`](docs/licensing-decision.md). No artifact is published to any marketplace. Unsupported = visibly unsupported.

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
| [`.claude/`](.claude/) | Claude Code project config — subagents, Sandpane skills, slash commands; `settings.json` enables the Superpowers plugin |

## Install and run

Everything below builds from source; nothing is published to a marketplace yet. Every step was executed from a fresh clone on 2026-10-10 (macOS, see [what was verified](#what-was-verified)); the few steps that open a GUI were not launched and say so.

### 1. Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| macOS or Linux | — | Core speaks Unix domain sockets only; Windows is not supported yet |
| Git | any recent | Core (review, apply) and cloning |
| Rust | stable ≥ 1.90 (`rustup`), with `rustfmt` + `clippy` for the checks | Core (≥ 1.89) and the desktop shell (≥ 1.90) |
| Node.js | 22.12+ or 24.x | VS Code extension and desktop app build tooling |
| Desktop app system libraries | Xcode Command Line Tools (macOS); WebKitGTK etc. per the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Linux) | Desktop app |
| VS Code | ≥ 1.90 | VS Code extension |
| A JDK (17+) to start Gradle | any; the build provisions JDK 25 itself through the foojay resolver | JetBrains plugin build |
| IntelliJ IDEA | 2026.2.x (build 262) | JetBrains plugin (the declared compatibility range is 262.*) |
| Docker Sandboxes (`sbx`) | installed and licensed separately | Real sandboxes only. Without it Core runs and reports `NOT_INSTALLED`. Sandpane never bundles it. |

```bash
git clone <this repository> Sandpane
cd Sandpane
```

### 2. Core service (required by every app)

The desktop app and both IDE plugins attach to ONE per-user Core; none of them starts it for you.

```bash
cd core
cargo build --release -p sandpane-service
./target/release/sandpane-service          # keep this terminal open; Ctrl-C stops it
```

It prints `listening on <socket> (protocol v1, core v0.1.0, db <path>)`. Defaults:

- socket: `~/Library/Application Support/sandpane/sandpane.sock` (macOS) or `$XDG_STATE_HOME/sandpane/sandpane.sock` (Linux; `~/.local/state` when unset), mode `0600`;
- database: `sandpane.sqlite3` in the same directory.

Environment overrides:

| Variable | Effect |
|---|---|
| `SANDPANE_SOCKET` | socket path (its directory must be private, `0700`; keep the full path under ~100 characters — a Unix socket path limit) |
| `SANDPANE_DB` | database file |
| `SANDPANE_SBX_PATH` | the `sbx` executable, if it is not on `PATH` |

To try Sandpane without touching your real data, point both at a throwaway directory:

```bash
mkdir -m 700 /tmp/sandpane-trial
SANDPANE_SOCKET=/tmp/sandpane-trial/sandpane.sock SANDPANE_DB=/tmp/sandpane-trial/core.sqlite3 \
  ./target/release/sandpane-service
```

Then start every client with the same `SANDPANE_SOCKET` (or set the socket path in the IDE settings below).

### 3. Desktop app (Tauri)

```bash
cd apps/desktop
npm ci
npm run tauri dev                 # development: native window with hot reload
npm run tauri build               # release binary: src-tauri/target/release/sandpane-desktop
```

Run the release binary directly (`./src-tauri/target/release/sandpane-desktop`, with `SANDPANE_SOCKET=…` if you overrode it). Installer bundling is turned off (`"bundle": { "active": false }` in `src-tauri/tauri.conf.json`), so no `.app`/`.dmg`/`.deb` is produced — the binary is the app. `npm run dev` alone serves the UI in a browser without Tauri, where it shows the Core-unreachable state by design.

### 4. VS Code extension

```bash
cd clients/vscode
npm ci
npm run package                   # → clients/vscode/sandpane-0.0.1.vsix
code --install-extension sandpane-0.0.1.vsix
```

Or in VS Code: Command Palette → **Extensions: Install from VSIX…**. Reload the window; the Sandpane icon appears in the Activity Bar. If Core uses a non-default socket, set **Settings → Extensions → Sandpane → Core Socket Path** (`sandpane.coreSocketPath`; user setting only — a workspace cannot set it). To try it without touching your normal VS Code profile:

```bash
code --user-data-dir /tmp/sandpane-vscode/user --extensions-dir /tmp/sandpane-vscode/ext \
  --install-extension sandpane-0.0.1.vsix
code --user-data-dir /tmp/sandpane-vscode/user --extensions-dir /tmp/sandpane-vscode/ext
```

More detail: [`clients/vscode/INSTALL.md`](clients/vscode/INSTALL.md).

### 5. JetBrains plugin (IntelliJ IDEA 2026.2)

```bash
cd clients/jetbrains
./gradlew buildPlugin             # → build/distributions/sandpane-jetbrains-0.1.0-scaffold.zip
./gradlew verifyPlugin            # optional: Plugin Verifier against IntelliJ IDEA 2026.2.3
```

The first build downloads Gradle 9.8.1, the IntelliJ IDEA 2026.2.3 platform artifacts and, if needed, JDK 25, so it needs network access and takes a while. Install the zip in the IDE: **Settings → Plugins → ⚙ → Install Plugin from Disk…**, pick the zip, restart. The **Sandpane** tool window appears; a non-default socket goes in **Settings → Tools → Sandpane**. To try it in a throwaway IDE sandbox instead of your own IDE profile: `./gradlew runIde`.

### 6. Check everything

```bash
make check                        # Core fmt/clippy/tests, schemas, VS Code, desktop, JetBrains
```

Individual targets: `make core-check`, `make schema-lint`, `make schema-drift`, `make vscode-check`, `make desktop-check`, `make jetbrains-check` (client checks need `npm ci` first; the JetBrains check runs `--offline`, so build once online first). Live suites against a running Core: `cd clients/vscode && npm run check:live` (starts its own throwaway Core from `core/target/debug`, so run `cargo build -p sandpane-service` first) and `cd apps/desktop && SANDPANE_SOCKET=<socket> npx vitest run tests/live-core.test.ts` (creates projects in that Core — point it at a throwaway one).

### What was verified

Executed on 2026-10-10 on macOS (Rust 1.99.0, Node 24.5.0, VS Code 1.141.0) from a fresh clone of commit `27dbb9b`, with Core on a throwaway socket, database and `HOME`, and no `sbx` on its `PATH` (so no sandbox daemon was touched). The guide's commands are unchanged by the later commits.

| Step | Result |
|---|---|
| Core `cargo build --release -p sandpane-service`, then start | built in 19 s; `listening on … (protocol v1, core v0.1.0, …)`; reports `sbx executable not found` as expected |
| VS Code `npm ci && npm run check && npm run package` | 280 tests passed; `Packaged: …/sandpane-0.0.1.vsix (30 files, 98.63 KB)` |
| VS Code install into an isolated profile | `Extension 'sandpane-0.0.1.vsix' was successfully installed.`; `--list-extensions` → `dkvlabs.sandpane@0.0.1` |
| VS Code live check (`node scripts/live-core-check.mjs`) | 56/56 PASS against a real Core |
| Desktop `npm ci && npm run typecheck && npm test && npm run tauri build` | 351 passed, 8 skipped (the opt-in live suite); `Built application at: …/target/release/sandpane-desktop` |
| Desktop live suite against the running Core | 8/8 passed |
| JetBrains `./gradlew buildPlugin verifyPlugin` | `sandpane-jetbrains-0.1.0-scaffold.zip` (1 163 019 bytes); `Compatible` against IU-262.10968.63 |

**Not executed here (UNVERIFIED):** launching the desktop window, opening the VS Code sidebar in a running VS Code, installing the plugin zip into a real IntelliJ IDEA or running `./gradlew runIde`, and any step on Linux. One host-specific trap found during the run: `vsce package` lists no files when the checkout path contains a UUID-like segment, because npm redacts it to `***` in `npm list` output; build from an ordinary path.

## Working on Sandpane with an AI agent

1. Read [`AGENTS.md`](AGENTS.md) — engineering rules, safety gates, logging obligation.
2. Follow [`docs/specs/07_ROADMAP_AND_TASKS.md`](docs/specs/07_ROADMAP_AND_TASKS.md) in phase order; do not assume later-phase modules exist.
3. Use the project skills: `sandpane-changelog` (logging), `sandpane-phase-gates` (acceptance), `sbx-cli-integration`, `git-safe-tasks`, `core-protocol`; and the Superpowers plugin workflow skills (`superpowers:using-superpowers` first; enabled for this project in `.claude/settings.json`; install once per clone with `claude plugin install superpowers@claude-plugins-official --scope project`).
4. Every big implementation ends with: commit → auto-review → `docs/audit/NNNN-*-review.md` → `docs/CHANGELOG.md` entry `NNNN` (unknown values recorded as `-`).

## License

MIT for original Sandpane code — see [LICENSE](LICENSE) and the redistribution gates in [docs/licensing-decision.md](docs/licensing-decision.md). The Superpowers plugin (MIT © 2025 Jesse Vincent) is enabled via project settings, not vendored.
