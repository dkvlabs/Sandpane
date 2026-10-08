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
| Gradle / Kotlin | not installed locally | JetBrains plugin build UNVERIFIED on this host |
| Docker CLI | /usr/local/bin/docker present | verified (presence only) |
| Docker SBX CLI (`sbx`) | **not installed** | **P0 BLOCKER — all SBX integration UNVERIFIED** |
| Codex app-server | not validated inside SBX | **P0 BLOCKER — chat adapter UNVERIFIED** |
| Claude Agent SDK | not validated | UNVERIFIED |

## Target combination matrix (to fill during P0/P3/P5/P6)

| Platform | CPU | OS version | Docker SBX version | Codex version | Claude version | VS Code version | IntelliJ baseline | Core protocol | Tests | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| macOS | arm64 | 27.0.1 | - | - | - | - | - | 0.1.0 | core unit/integration | scaffold stage; SBX absent |
| macOS | x86_64 | - | - | - | - | - | - | - | - | UNVERIFIED |
| Windows 11 | x86_64 | - | - | - | - | - | - | - | - | UNVERIFIED |
| Linux (TBD distro) | x86_64 | - | - | - | - | - | - | - | - | UNVERIFIED |

## SBX CLI fixtures

Fixtures under `core/crates/sandpane-core/tests/fixtures/sbx/` are **illustrative hand-written samples**, clearly marked as such, used to test parsing/argument-construction logic offline. Before any release gate passes, replace them with sanitized, version-labelled captures from a real `sbx` CLI (P0 task) and record the SBX version above.

## Version gate policy

Capability discovery comes from known tested commands, documented minimum versions, and actual runtime verification — not optimistic parsing of arbitrary output (specs/08 §3).
