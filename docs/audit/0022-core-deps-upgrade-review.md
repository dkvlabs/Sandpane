# 0022 — Auto-review record: Core dependency upgrade (U1)

- **date:** 2026-10-09
- **implementation commit:** `013ecfd` — build(core): upgrade rusqlite to 0.40.2 and pin latest dependency floors (U1)
- **review ran:** before the commit (checklist, orchestrator)

## Scope

- `core/Cargo.toml`
- `core/crates/sandpane-{core,service}/Cargo.toml`
- `core/Cargo.lock`
- `docs/compatibility.md`

No Rust source changed.

## Method

The orchestrator ran a dependency-upgrade checklist against the `core-engineer` report and re-ran the gate fresh after one orchestrator change.

1. **Versions.** Confirmed with `cargo search` / `cargo info`. libc 1.0.0-alpha was not taken.
2. **Migration notes.**
   - ctx7 returned API snippets for rusqlite but no migration notes.
   - The crate tarball has no `Changelog.md`, so the engineer read the GitHub release notes for v0.33.0 through v0.40.2.
   - Each runtime-only breaking change was checked against the call sites:
     - **0.35 tail checks on `execute`/`prepare`:** all multi-statement SQL already uses `execute_batch`. The two dynamically built `prepare` calls each build exactly one statement and are covered by tests.
     - **0.38 u64/usize `ToSql` removal:** nothing binds u64 or usize.
     - **0.38 optional statement cache:** `cache` is kept.
     - **0.40 VTab/wasm changes:** not used.
3. **Bundled SQLite.**
   - `cargo tree -e features -i libsqlite3-sys` shows `bundled`.
   - `otool -L` shows no dynamic sqlite link.
   - The embedded version is 3.53.2.
   - The WAL and foreign-key tests still pass.
4. **Orchestrator change.** `default-features = false, features = ["bundled", "cache"]` drops the wasm-only default `ffi-sqlite-wasm-rs`. `cargo update` removed `sqlite-wasm-rs`, `rsqlite-vfs` and `hashbrown 0.16.1`, and `cargo tree -d --target all` now prints nothing.

## Findings

1. **Note: security gained.** rusqlite 0.40.1 fixes SQL injection through a tainted SAVEPOINT name and UB in `ToSqlOutput::from_rc`.
2. **Note: `rust-version` was understated.** It said 1.85, but the already-locked uuid 1.27 declares 1.89. Corrected. `sandpane-protocol`, which the desktop app consumes, inherits 1.89 as metadata only; the desktop crate already declares 1.90.
3. **Residual (UNVERIFIED):**
   - MSRV 1.89 has not been build-tested; there is no rustup, and only rustc 1.99 is installed.
   - `cargo audit` is not installed locally; CI runs the pinned 0.22.2.
   - Windows and Linux builds were not run.

## Disposition

All notes accepted; no Critical findings.

## Verification evidence (orchestrator, fresh, after its change)

- `cargo fmt --check` passes, and `cargo clippy --all-targets -- -D warnings` is clean.
- `cargo test` passes 85, 3, 13, 19 and 34 tests: 154 in total, 0 failed.
- `make schema-drift` reports "All schema/protocol value sets in sync."
- `cargo tree -d --target all` prints "nothing to print".
- The secret/path gate is clean (5 files).

**Checklist: PASS.**
