# 0026 — Auto-review record: desktop protocol tolerance

- **date:** 2026-10-09
- **implementation commits:**
  - `6fbbb4b` — fix(desktop): tolerate unknown protocol enum values without hiding them
  - `78fb74a` — fix(desktop): one action gate for unknown statuses; inert display of paths (review follow-up)
- **review ran:** **after** `6fbbb4b` was committed. That is a process deviation: AGENTS.md asks for the review before the commit. The orchestrator re-ran the gate fresh before committing but did not run the `phase-reviewer` agent first. The review then ran on the committed diff, and its warnings were fixed in `78fb74a`, which was checked against those findings before commit.

## Scope

`apps/desktop/**` only: decoders, Core client, reducers, views, tests. No Rust, schema or protocol change.

## Why

This prepares for the additive protocol work in [plans/2026-10-09-protocol-v1-additions.md](../plans/2026-10-09-protocol-v1-additions.md).

A read-only audit found that desktop failed whole calls on unknown values of `TaskStatus`, `ErrorCode`, `FileChangeStatus` or `WorkspaceMode`:

- `task.list` and `git.review` failed outright;
- `sandbox.list` failed outright;
- `conversation.send` failed **after** Core had already applied it, which invites a duplicate retry;
- an unknown error code replaced Core's real error with `MALFORMED_FRAME`.

## Method

1. `desktop-engineer` implemented `6fbbb4b`. 23 of its 33 new tests failed before the fix.
2. The `phase-reviewer` agent reviewed `6fbbb4b` read-only, including on a clean `git archive` extract. It confirmed the 23/33 red claim on `6fbbb4b^`. Verdict: **PASS-WITH-WARNINGS, no Critical.**
3. `desktop-engineer` fixed W1 and S1, S3, S4, S5 in `78fb74a`. 36 of the 42 initial new tests failed before the fix.
4. The orchestrator re-ran `make desktop-check` and the build fresh before `78fb74a`.

## Findings and disposition

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| W1 | Warning (rule 3 spirit) | Cancel was gated on the event-log status only (`TasksView.tsx:248-250,:270`; `ProjectWorkspaceView.tsx:105-107,:280`). An unrecognised status on Core's task row left Cancel enabled, contradicting the `6fbbb4b` commit message ("cancel disabled"). Core still validates `task.cancel` server-side, and no state was fabricated. | **Fixed in `78fb74a`:** a single pure `taskActionGate(row, projection)` drives cancel, review, retry and the review block in all views |
| W2 | Warning (rule 5, specs/08) | The new UI gates (disabled checkbox, `!plan.canApply`, `onConfirm` re-check, cancel) are untested at render level; there is no component harness | **Accepted, recorded.** Pure functions are tested; wiring is checked by source pins only. A component harness (jsdom/testing-library) is backlog |
| S1 | Suggestion (rule 7) | `planApply` selected by path, so a duplicate path (one known entry, one unknown) could carry the unknown change; React keys collided | **Fixed in `78fb74a`** |
| S2 | Suggestion (rule 7) | The "never apply an unknown file" rule exists only in this client | **Deferred to C/A6:** Core's `git.apply` must honour `selectedFiles` and refuse what it cannot classify |
| S3 | Suggestion | `sanitizeHint` missed several invisible, bidi and tag characters; the length cap could split a surrogate pair; review-list paths were shown unsanitised | **Fixed in `78fb74a`:** `displayPath` shows unusual characters as visible escapes |
| S4 | Suggestion (rule 5) | Unknown-status tasks appeared only in "All N" | **Fixed:** "Unrecognised N" tab and status-bar count |
| S5 | Suggestion | The disagreement record missed differing unknown raw values; the tooltip showed a bare "Unknown" | **Fixed** |
| S6 | Suggestion | `ERROR_CODES` is not compared directly to Rust (schema-drift covers it indirectly) | **Backlog** |

## Residual risk

- Views were never rendered: no React test harness, no native Tauri run.
- The "Unrecognised" bucket also holds rare event-only rows that have no reported status yet. A code comment notes this.

## Verification evidence

- **Reviewer, on `6fbbb4b`:**
  - live repo: typecheck and tests → 306 passed / 8 skipped;
  - clean extract: `tsc` exit 0, vitest 306 / 8, vite build OK;
  - src-tauri `cargo test` → 31 passed;
  - new tests on `6fbbb4b^` → `23 failed | 10 passed (33)`.
- **Orchestrator, before `78fb74a`:**
  - `make desktop-check` exit 0: `Tests 351 passed | 8 skipped (359)`, `test result: ok. 31 passed`;
  - `npm run build` → `✓ built in 156ms`;
  - secret/path gate clean (9 files).

**Review: PASS-WITH-WARNINGS on `6fbbb4b` → W1 and S1, S3–S5 fixed in `78fb74a`; W2 accepted; S2 and S6 deferred. PASS.**
