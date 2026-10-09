# Sandpane compatibility matrix (P0 record)

Required by `specs/07_ROADMAP_AND_TASKS.md` (P0) and `specs/08_TESTING_AND_RELEASE.md` §3. Record **exact tested combinations** here. Unverified rows must stay marked `UNVERIFIED` — never advertise an untested combination as working.

## Development host (recorded 09.10.2026)

| Item | Value | Status |
|---|---|---|
| OS | macOS 27.0.1 (darwin, arm64 / Apple Silicon) | verified (host) |
| Rust | rustc 1.99.0 (Homebrew) | verified |
| Node / npm | v24.5.0 / 11.21.0 | verified |
| `@vscode/vsce` | 4.0.0 (`npm run package` in `clients/vscode`) | verified — packages `sandpane-0.0.1.vsix` (28 files, ~77 KB; `.vscodeignore` keeps sources/tests/session-artifact dirs out) |
| pnpm | 10.33.2 | verified |
| Java | OpenJDK 23 | verified |
| Gradle / Kotlin | Gradle wrapper **8.10.2** + JDK 23 (sdkman) + JDK 17/26/27 (`/usr/libexec/java_home -V`); no standalone `kotlinc` — Kotlin compiles through `kotlin-compiler-embeddable` resolved by Gradle into `~/.gradle` | **JB0 build gate PASSED on this host (entry 0010).** `./gradlew clean buildPlugin test --offline` → BUILD SUCCESSFUL; a forced-fresh run (`--rerun-tasks`, 17:27:46) executed all 15 tasks and packaged `build/distributions/sandpane-jetbrains-0.1.0-scaffold.zip` (2,707,234 B); re-verified fresh at commit time (17:40): **98 Kotlin tests, 0 failures, 0 errors** (CoreClientFraming 29, CoreCommands 29, ErrorAttribution 13, ProtocolDriftGuard 8, ReplayCursorSemantics 7, FolderMatching 12). `make check` now aggregates `jetbrains-check` (`./gradlew build --console=plain --offline`). **Still UNVERIFIED:** `runIde` (never launched in an IDE), Plugin Verifier (never run), the zip never installed/loaded, version pins unconfirmed against current Plugin SDK docs, and the Kotlin client has never completed a live Core round trip. `verifyPluginProjectConfiguration` reports **`sourceCompatibility='17'` but IntelliJ Platform `2024.2.4` requires `'21'`** — unresolvable here (no JDK 21 installed; the build runs `--offline`, so auto-provisioning is not an option), recorded as an open JB0 item rather than papered over. The build also added several GB to the host's `~/.gradle` (9.9 GB total at this writing, attribution not established); `clients/jetbrains/build/` and `.intellijPlatform/` are gitignored (`.gitignore:31-32`). |
| Git | driven by core integration tests on real temp repos | verified (host) |
| Core protocol | version **1** (integer `PROTOCOL_VERSION`); crate semver 0.1.0 — separate axes, do not conflate | verified (core suite) |
| Docker CLI | `/usr/local/bin/docker`, `Docker version 29.8.2, build 7fc2dff` (re-probed 09.10.2026) | verified (CLI version) |
| Docker daemon | `docker info` fails: `failed to connect to the docker API at unix:///Users/gabrielgeorgescu/.docker/run/docker.sock … daemon is not running` | **daemon DOWN on this host — no container can run here today** |
| Docker SBX CLI (`sbx`) | `/opt/homebrew/bin/sbx`, `sbx version: v0.47.0 0411f50ee4700fe7bd37e6e7e3aced563e850ca9` (probed 09.10.2026). Daemon `sandboxd` was stopped; `sbx ls --json` auto-started it (observed side effect), after which `sbx ls --json` → `{"sandboxes": []}` exit 0. `sbx create shell …` → `error: global network policy has not been initialized / try: sbx policy init <allow-all\|balanced\|deny-all>` exit 1 | **CLI + daemon + sandbox CRUD verified (CLI level).** The user ran `sbx policy init balanced` (09.10.2026). A disposable `shell` sandbox then went through create → `ls --json` → exec → stop → rm --force → not-found, every step exit 0 except the expected final error, all captured in `captured/v0.47.0/crud/`. Real `ls --json` rows: `name, id, agent, status, last_used_at, workspaces[], created_at`. Sandpane's Core adapter against these outputs is verified separately in its own entry. Agents needing provider sign-in (codex, claude) are UNVERIFIED |
| Codex CLI | `/Users/gabrielgeorgescu/.local/bin/codex`, `codex-cli 0.155.1`; `~/.codex/auth.json` + `config.toml` exist (presence metadata only — contents never read, never logged) | **P0 BLOCKER — never validated inside SBX, so the adapter stays `verified:false`** |
| Claude Agent SDK | not validated | UNVERIFIED |
| Claude Code (agent harness, dev tooling only) | `claude --version` → `2.1.288 (Claude Code)` (09.10.2026) | verified (host) — project config in `.claude/` (agents `skills:` preload, commands `argument-hint`) checked against code.claude.com docs, entry 0013 |
| Superpowers plugin (dev tooling only) | `superpowers@claude-plugins-official` **6.4.1** (`5bf4e78`), project + user scope (`~/.claude/plugins/installed_plugins.json`, 09.10.2026). Upstream latest is **6.4.2** (`8ca22db`, only change: leaner `writing-plans`), but the official marketplace pins `sha 5bf4e78`, so `claude plugin update` reports "already at the latest version (6.4.1)" | verified (installed version); 6.4.2 not available via the official marketplace — re-run `claude plugin marketplace update claude-plugins-official && claude plugin update superpowers@claude-plugins-official --scope project` once the pin moves |

> **P0 blocker attribution (updated 09.10.2026, superseding the earlier note).** Since the earlier note,
> the `sbx` CLI v0.47.0 has been installed, its daemon runs, and the user initialized the global network
> policy. A provider-free `shell` sandbox completed a real create → exec → stop → rm round trip
> (entry 0015). Docker CLI 29.8.2 and `codex-cli 0.155.1` are also present. The one remaining P0 blocker
> is **running Codex (or any provider agent) inside a real SBX**, which needs a provider sign-in that only
> the user can do. Until then, `system.probe` reports
> `codex {verified:false, supportsStreaming:false, supportsCancel:false, supportsResume:false}`. The live
> VS Code harness (`clients/vscode/scripts/live-core-check.mjs`, 56/56 on 09.10.2026) checks that.

## Dependency versions (upgrade pass U1–U4, 09.10.2026)

Every version below was confirmed against its registry (`npm view`, crates.io / `cargo search`, Gradle Plugin Portal, JetBrains releases), and the area's full gate ran fresh on it.

| Area | Versions | Status |
|---|---|---|
| Desktop (`apps/desktop`), entry 0021 | react / react-dom 19.3.0, @types/react(-dom) 19.3.0, vite 8.3.4, @vitejs/plugin-react 6.1.2, vitest 5.0.3, typescript 7.0.2, @tanstack/react-query 5.104.1, @tauri-apps/api 2.12.2, @tauri-apps/cli 2.12.1, @types/node 24.19.1 (matches the host's Node 24, not 26); crates tauri 2.12.2, tauri-build 2.7.1, serde 1.0.229, serde_json 1.0.151, libc 0.2.190; `rust-version` 1.90 (tauri 2.12's own MSRV) | verified: `make desktop-check` 273 TS passed / 8 skipped + 31 Rust; `vite build` OK; `npm audit` 0. Native `tauri dev`/`tauri build`: UNVERIFIED. Transitive holds from the Linux GTK stack: thiserror 1.0.69, toml 0.8.2 |
| Core (`core/`), entry 0022 | rusqlite 0.32.1 → **0.40.2** (`bundled` SQLite 3.53.2, `default-features=false` + `cache`, so the wasm-only `ffi-sqlite-wasm-rs` path is not in the lockfile), serde 1.0.229, serde_json 1.0.151, thiserror 2.0.21, uuid 1.27.0, libc 0.2.190, tempfile 3.27.0; workspace `rust-version` 1.89 (uuid 1.27's MSRV) | verified: fmt/clippy `-D warnings` clean, `cargo test` 154 passed, schema drift in sync, `cargo tree -d --target all` no duplicates, no dynamic system SQLite (`otool -L`). MSRV 1.89 declared but not build-tested (only rustc 1.99 locally); `cargo audit` not installed here (runs in CI, pinned 0.22.2) |
| VS Code (`clients/vscode`), entry 0023 | typescript 7.0.2 (`module: node20`; webview `module: esnext` + `moduleDetection: legacy`, output byte-identical), vitest 5.0.3 (+ vite 8.3.4 peer), @vscode/vsce 4.0.0, @types/vscode **1.90.0 exact** (was floating to 1.140.0, above `engines.vscode ^1.90.0`), @types/node 22.20.5 (vitest 5 peer floor is `^22 \|\| >=24`, so 20.x is refused; `src/` uses only node:net/fs/crypto). Build host needs Node 22.12+ or 24 | verified: typecheck clean, 280/280 tests, `.vsix` packages (30 files), live check 56/56 against the U1 Core, `npm audit` 0. Not run in an Extension Development Host: UNVERIFIED |

## Transport / platform prerequisites recorded against the code (entry 0004 review)

- **Windows:** the named-pipe transport is NOT implemented in the scaffold (`sandpane-service` refuses to start on non-Unix with a stated reason). Before any Windows support claim, additionally resolve `git` to an absolute path at startup — a bare program name + untrusted cwd can execute a repository-local `git.exe` on Windows (review 0004 #13).
- **SBX binary verification:** `SbxLocator` currently accepts any regular file named `sbx` (override or PATH). Before P0 real-CLI work lands, add execute-bit/ownership verification per specs/06 §4 "pin or verify binaries" (review 0004 #12).
- **Subprocess timeouts:** external `sbx`/`git` invocations are bounded in output size but NOT in wall-clock time; a hung `sbx` wedges one connection thread, never the daemon. Bounded timeouts remain an open P1 item (review 0004 #5).
- **`git.apply` ref names:** `preconditions_for_apply` compares HEAD against an expected full/abbreviated object id; symbolic refs must be `rev-parse`-resolved by the caller (recorded limitation, review 0004 #20).

## Protocol v1 gaps surfaced by client-scaffold verification (entries 0006–0008)

Originally six items, each verified against the committed sources (line numbers as of 09.10.2026) — Core-side limitations gating client features, not client defects. Resolving them required a coordinated `sandpane-protocol` + `schemas/` + client-types change with a protocol-version decision (AGENTS.md rule 8; specs/02 §2). **Status after entry 0010: four closed, two open.** `PROTOCOL_VERSION` remained **1** because every addition was additive (new methods; new optional request fields; new response fields that are absent-tolerant), so pre-revision client frames still parse.

### CLOSED by entry 0010

- ~~**No `task.list` / `conversation.list` methods**~~ → both exist, plus **`conversation.history`** (`{messages, truncated, nextSequence}`), so the enum is 14 methods and clients no longer fake discovery locally. **Verified live**: VS Code harness 55/55 against the real `sandpane-service` binary (project scoping, status filter, limit clamp, paging cursor, empty-vs-error semantics), 13 new service integration tests on real SQLite + real socket.
- ~~**`task_subscribe` applies ONE `afterSequence` to every task**~~ → `afterSequences: {taskId: cursor}` per-task cursors added, with the rules written down in specs/02 §2 (with `taskId` the scalar wins and the map is ignored; without it each task replays from its own cursor, absent ⇒ 0; no map ⇒ legacy behavior). **Verified live**: the harness builds two tasks with UNEVEN per-task sequences (5 vs 4) and asserts the legacy shared scalar returns **0** of the behind task's unseen events (the recorded defect reproducing) while the map returns them. Desktop additionally covers it in unit + opt-in live tests; the JetBrains side is file-level only (see the Gradle/Kotlin row above — never compiled on this host).
- ~~**`project.list` carries no repository paths**~~ → `Project.repositories: string[]` from `repositories.canonical_path`, ordered. **Verified live**: harness asserts `project.list` returns the paths the project was created with. The folder→project *resolver* is still client work (no Core change needed; VS Code explicitly declined a string-compare resolver as unsound until Core canonicalizes).
- ~~**`SandboxSummary` lacks `workspaceMode`**~~ → joined from `sandbox_bindings`, absent when unbound, reusing the existing snake_case modes; a legacy JSON-quoted mode row decodes instead of silently disappearing. **Partially verified**: proven only in the Rust suite against its explicitly-labelled stand-in executable (`sandbox_list_joins_workspace_mode_and_omits_it_when_unbound`, `legacy_quoted_workspace_mode_row_is_still_reported_and_junk_stays_absent`) — **no live path exists on this host**, because `sandbox.list` answers `NOT_INSTALLED` without `sbx`, so the clients' "absent ⇒ UNVERIFIED / treat as live-writable" rendering is unit-tested only. This remains P0-gated for a real-sandbox confirmation.

### STILL OPEN

- **`conversation.send` returns a full `TaskSummary`** (service ~:761) where specs/02 §2 specifies `{taskId}` — clients dual-accept; a breaking-shape cleanup, so it was deliberately NOT folded into an additive revision.
- **`ContextRef` kind `selection` has no identifier contract** (protocol ~:310) — clients must quote selection content as data and attach only the file path (the JetBrains scaffold does exactly this).

Also recorded during 0010, as a Core-side asymmetry rather than a gap: `task_subscribe` passes a scalar `afterSequence` through **unclamped** (only the cursor map and `conversation.history` clamp negatives). It is behaviorally identical (`sequence > -7` ≡ `sequence > 0`) but clients must not claim Core clamps it.

Client-side handling of every item is recorded in the respective scaffold README (entries 0006–0008, 0010).

## Target combination matrix (to fill during P0/P3/P5/P6)

| Platform | CPU | OS version | Docker SBX version | Codex version | Claude version | VS Code version | IntelliJ baseline | Core protocol (v) | Tests | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| macOS | arm64 | 27.0.1 | v0.47.0 (CLI, daemon, shell-sandbox CRUD) | - | - | - | - | 1 (core 0.1.0) | core unit/integration + daemon smoke | policy `balanced` (user); Codex-in-SBX not yet proven |
| macOS | x86_64 | - | - | - | - | - | - | - | - | UNVERIFIED |
| Windows 11 | x86_64 | - | - | - | - | - | - | - | - | UNVERIFIED |
| Linux (TBD distro) | x86_64 | - | - | - | - | - | - | - | - | UNVERIFIED |

## SBX CLI fixtures

Fixtures under `core/crates/sandpane-core/tests/fixtures/sbx/` (top level) are **illustrative hand-written samples**, clearly marked as such. **Real captures** from `sbx v0.47.0` live in `captured/v0.47.0/` (`fixture_status: captured`, see its `_meta.json`): every command's `--help`, version/daemon/empty-list state, and the real error format (`error: <msg>` + `  try: <hint>`, exit 1). `captured/v0.47.0/crud/` holds a real create/list/exec/stop/rm round trip, including non-empty `ls --json` rows (field `status`, not the illustrative `state`).

## Version gate policy

Capability discovery comes from known tested commands, documented minimum versions, and actual runtime verification — not optimistic parsing of arbitrary output (specs/08 §3).
