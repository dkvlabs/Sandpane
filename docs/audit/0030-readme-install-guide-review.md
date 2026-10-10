# 0030 — Auto-review record: README install and run guide

- **date:** 2026-10-10
- **implementation commit:** `4c1f8c3` — docs(readme): install and run guide for Core, desktop, VS Code and JetBrains
- **review method:** checklist pass (docs change), with every command executed rather than read.

## Scope

`README.md` (status paragraph; new "Install and run" section replacing the stale "Getting started"), `docs/plans/2026-10-09-spec-completion-plan.md` (status of C3 follow-up, JetBrains and R).

## Method

1. Fresh clone of `27dbb9b` in the session scratchpad, and a second in a temp directory (see the finding below).
2. Core started with a throwaway `HOME`, socket and database, and a `PATH` without `sbx`, so neither the real `~/Library/Application Support/sandpane` nor the sandbox daemon was touched (the real data directory's timestamps were checked afterwards: last modified 2026-10-09).
3. VS Code extension installed only into an isolated profile (`--user-data-dir`/`--extensions-dir`).
4. Each claim in the guide was checked against the source: socket/DB defaults and overrides (`runtime.rs`), `sandpane.coreSocketPath` (user-only setting), `bundle.active: false`, the JetBrains configurable (`Settings → Tools → Sandpane`), rust-version minimums (1.89 Core, 1.90 desktop shell). Two drafted claims without evidence were removed (a download size; a licensing reason for disabled bundling).

## Results

| Step | Result |
|---|---|
| `cargo build --release -p sandpane-service`, start | built in 19 s; `listening on … (protocol v1, core v0.1.0, …)` |
| VS Code `npm ci && npm run check && npm run package` | 280 passed; `Packaged: …/sandpane-0.0.1.vsix (30 files, 98.63 KB)` |
| VS Code isolated install | `successfully installed`; `dkvlabs.sandpane@0.0.1` listed |
| VS Code live check | 56/56 PASS |
| Desktop `npm ci`, typecheck, test, `npm run tauri build` | 351 passed / 8 skipped; `Built application at: …/release/sandpane-desktop` |
| Desktop live suite against the running Core | 8/8 |
| JetBrains `./gradlew buildPlugin verifyPlugin` | zip 1 163 019 bytes; `Compatible` |

## Findings

| # | Finding | Disposition |
|---|---|---|
| 1 | `vsce package` listed no files in the scratchpad clone. Cause: npm redacts the UUID-like session segment of the path to `***` in `npm list` output, which `vsce` then globs. Not a repository bug. | Re-ran from a temp directory without a UUID segment (passed); documented as a host-specific trap in the guide |
| 2 | The live check's socket path exceeded the Unix socket limit when `TMPDIR` pointed at a long directory | Re-ran with the default temp dir; the guide warns to keep `SANDPANE_SOCKET` under ~100 characters |
| 3 | GUI launches (desktop window, VS Code sidebar, plugin in a real IDE, `runIde`) and Linux were not executed | Labelled UNVERIFIED in the guide |

All temporary Core processes were stopped (`pgrep` found none) and the temporary socket directory was removed.
