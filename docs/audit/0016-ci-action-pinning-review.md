# 0016 — Auto-review record: CI supply-chain hardening (F0)

- **date:** 2026-10-09
- **implementation commit:** `edf9a74` — ci: pin all actions to commit SHAs, validate gradle wrapper, pin cargo-audit (security W7)
- **review ran:** inline checklist by the orchestrator; logged after the commit (this record was deferred, and is folded in here)

## Scope

`.github/workflows/ci.yml` only.

## Method

The orchestrator ran a checklist against security finding W7, from the 2026-10-09 whole-repository security review:

- every `uses:` names a full 40-hex commit SHA, with the release tag in a comment;
- `gradle/actions/wrapper-validation` runs before any `./gradlew`;
- `cargo install cargo-audit` is version-pinned and `--locked`;
- the Node version satisfies the engines of the planned upgrades (Vitest 5 / Vite 8: `^22.12 || ^24`).

## Findings

1. **Suggestion (recorded): `dtolnay/rust-toolchain` has no release tags.** It is pinned to the SHA at the head of its `stable` branch on 2026-10-09. Bumps must be manual.
2. **Note: the workflow has not run on GitHub from this session.** Nothing was pushed. The SHAs were resolved from the upstream release tags, but the first CI run is still the real proof.

## Disposition

| # | Disposition |
|---|---|
| 1 | Accepted; the comment records the date |
| 2 | Recorded as UNVERIFIED until the first pushed run |

## Verification evidence

`grep -n "uses:" .github/workflows/ci.yml` shows that all 13 `uses:` lines carry a 40-hex SHA. `wrapper-validation` is at line 164, before the gradle step. `cargo install cargo-audit --version 0.22.2 --locked` is at line 94.

**Checklist: PASS (CI execution UNVERIFIED).**
