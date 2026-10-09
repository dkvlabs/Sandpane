# 0017 — Auto-review record: desktop review fixes (F2)

- **date:** 2026-10-09
- **implementation commit:** `321f4fd` — fix(desktop): security and correctness fixes from the review (F2)
- **review ran:** before the commit, in two rounds

## Scope

- `apps/desktop/**`: the Tauri `src-tauri` proxy, capabilities, build script, the React app and tests.
- `Makefile`: `desktop-check` now runs the cargo gates.

## Method

1. **Discovery reviews (read-only, at `81f4841`).**
   - A desktop and design review found bugs A1–A12.
   - The whole-repository security review found W5, W6 and S9 on this surface.
2. **The fix batch,** by the `desktop-engineer` agent.
3. **An independent read-only review of the fix diff** (a `general-purpose` agent using the `phase-reviewer` and `security-reviewer` definitions). Verdict: PASS-WITH-WARNINGS.
   - Warnings:
     - W1: a write that breaks part-way through is not proof that Core ignored the frame;
     - W2: the README build size was stale;
     - W3: the retry paths were untested.
   - Suggestions:
     - frame cap +1 for the newline;
     - per-method deadlines;
     - Core hints in the UI;
     - copy;
     - ErrorBoundary reset;
     - icon-only rail.
4. **A follow-up batch** fixed every warning and suggestion. The orchestrator then re-ran the gates fresh.

## Findings and disposition (discovery round)

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| A1 | Critical | The `src-tauri` crate did not compile (`replay_safe` type mismatch), and the README claimed `cargo check` passed | **Fixed.** `make desktop-check` now runs cargo fmt/check/clippy/test |
| A2 | High | A synchronous Tauri command blocked the main thread | **Fixed:** async command |
| A3 / W6 | Medium | Raw CR/LF inside a frame allowed request smuggling; the response id was not checked | **Fixed** and tested |
| A4 | Medium | The JS timeout was shorter than Rust's, so a request could be sent twice | **Fixed:** per-method budgets on both sides, with a drift test |
| A5 | Critical (rules 4/5) | Live-writable was hard-coded or taken from the wrong sandbox | **Fixed:** derived from the task, and an unknown mode is treated as live-writable |
| A6–A8 | High / Medium | State leaked across project and task switches; history race; task index mixed projects | **Fixed** |
| A9–A12 | Medium / Low | ConfirmDialog; store status reactivity; inert settings; router crash; theme; contrast | **Fixed.** Inert settings removed; ErrorBoundary added |
| W5 | Warning (security) | Socket path differed from the other clients | **Fixed:** `<state>/sandpane/sandpane.sock` plus an owner/mode trust check |
| S9 | Suggestion (security) | `core:default` capability was too broad | **Fixed:** narrowed to `allow-core-request-frame` |

Design-fidelity gaps (TopBar, palette, Inspector, S00–S10 screens) are **not fixes**. They are tracked as CL features in `docs/plans/2026-10-09-spec-completion-plan.md`.

## Residual risk (unverified, recorded honestly)

- No native Tauri window was run, so the narrowed capability and the IPC round trip are proven by unit tests only.
- The tests have no DOM, so the ErrorBoundary reset, rail tooltips and dialog focus trap are tested only through pure helpers.
- A TOCTOU race remains between `lstat` and `connect`.
- The non-Unix build was not compiled.
- Surface-3 contrast is 4.11:1, which is AA for large text only.

## Verification evidence (orchestrator, fresh, before the commit)

`make desktop-check` exit 0:

- `Tests 273 passed | 8 skipped (281)`;
- `test result: ok. 31 passed; 0 failed` (src-tauri);
- cargo fmt and clippy `-D warnings` clean.

The secret/path gate on the staged diff was clean (33 files).

**Two-round review: PASS-WITH-WARNINGS → all warnings fixed. PASS.**
