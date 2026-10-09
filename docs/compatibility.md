# Sandpane compatibility matrix (P0 record)

Required by `specs/07_ROADMAP_AND_TASKS.md` (P0) and `specs/08_TESTING_AND_RELEASE.md` §3. Record **exact tested combinations** here. Unverified rows must stay marked `UNVERIFIED` — never advertise an untested combination as working.

## Development host (recorded 09.10.2026)

| Item | Value | Status |
|---|---|---|
| OS | macOS 27.0.1 (darwin, arm64 / Apple Silicon) | verified (host) |
| Rust | rustc 1.99.0 (Homebrew) | verified |
| Node / npm | v24.5.0 / 11.21.0 | verified |
| pnpm | 10.33.2 | verified |
| Java | OpenJDK 23 | verified |
| Gradle / Kotlin | Gradle **8.10.2** + JDK 23 present via sdkman (re-measured 09.10.2026); `kotlinc` absent | JetBrains scaffold exists file-level only — **build UNVERIFIED**: `./gradlew` has never been executed, no Kotlin file compiled, IntelliJ Platform artifacts never resolved |
| Git | driven by core integration tests on real temp repos | verified (host) |
| Core protocol | version **1** (integer `PROTOCOL_VERSION`); crate semver 0.1.0 — separate axes, do not conflate | verified (core suite) |
| Docker CLI | `/usr/local/bin/docker`, `Docker version 29.8.2, build 7fc2dff` (re-probed 09.10.2026) | verified (CLI version) |
| Docker daemon | `docker info` fails: `failed to connect to the docker API at unix:///Users/gabrielgeorgescu/.docker/run/docker.sock … daemon is not running` | **daemon DOWN on this host — no container can run here today** |
| Docker SBX CLI (`sbx`) | `sbx` not on PATH (Python `shutil.which` probe + Core `system.probe` → `sbx.installed:false`) | **P0 BLOCKER — all SBX integration UNVERIFIED** |
| Codex CLI | `/Users/gabrielgeorgescu/.local/bin/codex`, `codex-cli 0.155.1`; `~/.codex/auth.json` + `config.toml` exist (presence metadata only — contents never read, never logged) | **P0 BLOCKER — never validated inside SBX, so the adapter stays `verified:false`** |
| Claude Agent SDK | not validated | UNVERIFIED |

> **P0 blocker attribution, corrected 09.10.2026 by live host probes.** The gate is *not* missing
> Docker or a missing Codex install — both are present (Docker CLI 29.8.2, `codex-cli 0.155.1`).
> It is precisely: (1) the `sbx` CLI is not installed, (2) the Docker daemon is not running, and
> (3) adapter verification requires executing Codex **inside a real SBX**, which neither (1) nor (2)
> permits. Until all three hold, `system.probe` must keep reporting `sbx.installed:false` and
> `codex {verified:false, supportsStreaming:false, supportsCancel:false, supportsResume:false}` —
> which is what the live harness (`clients/vscode/scripts/live-core-check.mjs`, 30/30) asserts.

## Transport / platform prerequisites recorded against the code (entry 0004 review)

- **Windows:** the named-pipe transport is NOT implemented in the scaffold (`sandpane-service` refuses to start on non-Unix with a stated reason). Before any Windows support claim, additionally resolve `git` to an absolute path at startup — a bare program name + untrusted cwd can execute a repository-local `git.exe` on Windows (review 0004 #13).
- **SBX binary verification:** `SbxLocator` currently accepts any regular file named `sbx` (override or PATH). Before P0 real-CLI work lands, add execute-bit/ownership verification per specs/06 §4 "pin or verify binaries" (review 0004 #12).
- **Subprocess timeouts:** external `sbx`/`git` invocations are bounded in output size but NOT in wall-clock time; a hung `sbx` wedges one connection thread, never the daemon. Bounded timeouts remain an open P1 item (review 0004 #5).
- **`git.apply` ref names:** `preconditions_for_apply` compares HEAD against an expected full/abbreviated object id; symbolic refs must be `rev-parse`-resolved by the caller (recorded limitation, review 0004 #20).

## Protocol v1 gaps surfaced by client-scaffold verification (entries 0006–0008)

Each item was verified against the committed sources (line numbers as of 09.10.2026) — they are Core-side limitations gating client features, not client defects. Resolving any of them is a coordinated `sandpane-protocol` + `schemas/` change with a protocol-version decision (AGENTS.md rule 8; specs/02 §2) — P1/P2 territory.

- **No `task.list` / `conversation.list` methods** (closed 11-method enum) — discovery must go through `task.subscribe` project-wide replay; chat enumeration is impossible. Blocks VS2/DT1/JB1-style UI.
- **`task_subscribe` applies ONE `afterSequence` to every task** in a project-wide replay (`sandpane-service` lib.rs ~:828) while sequences are per-task starting at 1 — a shared cursor can skip events of low-sequence tasks. Client workaround in use: per-task checkpoints (desktop, JetBrains); Core fix: per-task cursors or a monotonic project-wide sequence.
- **`conversation.send` returns a full `TaskSummary`** (service ~:761) where specs/02 §2 specifies `{taskId}` — clients dual-accept; protocol cleanup pending.
- **`project.list` carries no repository paths** (service ~:375) — an IDE folder cannot be resolved to a Core project remotely; blocks JB1 binding / JB3 task creation and VS workspace association.
- **`SandboxSummary` lacks `workspaceMode`** (protocol ~:249) — the UI cannot label `direct_mount` live-writable from this payload as specs/04 §3 requires; the data exists in `sandbox_bindings` but is not joined out.
- **`ContextRef` kind `selection` has no identifier contract** (protocol ~:310) — clients must quote selection content as data and attach only the file path (the JetBrains scaffold does exactly this).

Client-side handling of every item above is recorded in the respective scaffold README (entries 0006–0008).

## Target combination matrix (to fill during P0/P3/P5/P6)

| Platform | CPU | OS version | Docker SBX version | Codex version | Claude version | VS Code version | IntelliJ baseline | Core protocol (v) | Tests | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| macOS | arm64 | 27.0.1 | - | - | - | - | - | 1 (core 0.1.0) | core unit/integration + daemon smoke | scaffold stage; SBX absent |
| macOS | x86_64 | - | - | - | - | - | - | - | - | UNVERIFIED |
| Windows 11 | x86_64 | - | - | - | - | - | - | - | - | UNVERIFIED |
| Linux (TBD distro) | x86_64 | - | - | - | - | - | - | - | - | UNVERIFIED |

## SBX CLI fixtures

Fixtures under `core/crates/sandpane-core/tests/fixtures/sbx/` are **illustrative hand-written samples**, clearly marked as such, used to test parsing/argument-construction logic offline. Before any release gate passes, replace them with sanitized, version-labelled captures from a real `sbx` CLI (P0 task) and record the SBX version above.

## Version gate policy

Capability discovery comes from known tested commands, documented minimum versions, and actual runtime verification — not optimistic parsing of arbitrary output (specs/08 §3).
