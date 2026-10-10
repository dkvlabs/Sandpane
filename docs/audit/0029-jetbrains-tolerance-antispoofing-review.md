# 0029 — Auto-review record: JetBrains protocol tolerance and anti-spoofing

- **date:** 2026-10-10
- **implementation commit:** `9bc6230` — fix(jetbrains): tolerate unknown protocol enums and harden dialogs against spoofing
- **review ran:** before the commit, in rounds:
  1. security review of the first version (2026-10-09): **BLOCK**, Critical C1;
  2. fix, then phase review and security re-review in parallel;
  3. fixes for the re-review's three Warnings, then the full gate again.

## Scope

`clients/jetbrains/` only (28 files): `model/Reported.kt`, `text/VisibleText.kt`, `ui/ApplyConfirmation.kt`, `ui/SendContextMessages.kt` (new); `ui/PlainText.kt` (`DialogHtml`), `services/ApplyPlan.kt`, the four actions, `TaskMonitorService`, `EditorDiffProvider`, `ChatPanel`, `Models.kt`, `WorkspaceModeView.kt`, `ErrorAttribution.kt`, README; tests `DialogLayoutTest`, `DialogTextTest`, `ApplyPlanSpoofingTest`, `UnknownEnumToleranceTest`, `VisibleTextTest` (new) and five updated test classes. No protocol or schema change; `ProtocolDriftGuardTest` was extended to `FileChangeStatus` and `change-set.schema.json`.

## What changed

- **Protocol tolerance.** `Reported<E>` (Known/Unknown; unknown wire names must be strict snake_case ≤ 64) for `TaskStatus`, `FileChangeStatus` and `WorkspaceMode`. A newer Core's new value no longer fails `task.list`, `git.review`, `sandbox.list` or `conversation.send`. Unknown-status files are listed, never selected; an unknown workspace mode is treated as live-writable; a task with an unknown status is never `awaitingReview`.
- **Anti-spoofing.** `VisibleText` escapes Cc/Cf/Zl/Zp, unpaired surrogates and invisible letters by code point on every surface. The Apply and send-context dialogs are built by `DialogHtml`: each entry or labelled value is a table row, marker or label in a `nowrap` column, value in the next.
- **Follow-ups** from the security reviews: W2 (bounded conflict list), S1 (NFC + case-fold exclusion of unknown-status twins; collisions among selected paths are listed, not refused), S2 (single-line Core text in notifications; `ErrorAttribution.describe` reveals at the source), S4 (code-point truncation), S5 (UNVERIFIED notice when the workspace mode is null), S6 (flag literal escape sequences).

## Findings and disposition

### Security review, round 1 — BLOCK

| # | Finding | Disposition |
|---|---|---|
| C1 (Critical) | A crafted path rendered a pixel-identical fake `[2]` entry (WrapProbe) and a fake "NOT sent" header (ConcealProbe): the AlertDialog's word-wrap view factory force-breaks an over-long run, and with `<br>`-per-entry lines the tail started at the left margin | **Fixed**: table-row layout (`DialogHtml`); `DialogLayoutTest` searches widths 300/360/480 × padding 0..90 for both shapes with the platform kit, asserts no line in a text cell starts left of its column, asserts cells really wrapped, and keeps the old layout as a control that does produce a fake `[2]` |
| W2 | Unbounded conflicted-file list in the apply-result notification | **Fixed** (`conflictsLine`, 20 + "… and N more") |
| S1, S2, S4, S5, S6 | see "What changed" | **Fixed** |
| W1 | Core must apply exactly `selectedFiles` | Core/P4 item; no client change |

### Phase review — PASS-WITH-NOTES

| # | Finding | Disposition |
|---|---|---|
| W1 | README carried two contradictory gate records (196 vs 202 tests) | **Fixed**: one current record, the 196 run labelled intermediate |
| W2 | README said the test lays out "the real dialog"; it lays out the real dialog HTML in a stand-in pane | **Fixed** wording; AlertDialog's own pane (width, CSS, font) labelled UNVERIFIED |
| W3 | "Verified … by disassembling the platform classes" (`PlainText.kt` KDoc, README) has no recorded `javap` evidence in `docs/compatibility.md` | **Accepted as a known gap**: the disassembly was done in an earlier round (entry 0020 era) and its command output was not kept. Re-record it in `docs/compatibility.md` before relying on it again. |
| S1 | `Reported<TaskStatus>.isTerminal` is only used by tests | Deferred |
| S2 | NFC + `lowercase(ROOT)` approximates APFS/NTFS folding | KDoc and README now say "approximation" |
| S3 | `listNotSent` overflow does not count flagged paths; duplicate unknown entries listed twice | Deferred (cosmetic; none are sent) |
| S4 | Send confirmation still used `<br>` lines | **Fixed** with security re-review W3 below |
| Note | Unknown ErrorCode tolerance is NOT part of this diff (RPC `code` was already a `String`); an agent `error` event with an unknown code is still `Malformed` (pre-existing) | Recorded; no claim made |

### Security re-review — PASS-WITH-NOTES

The reviewer's own probe (`TableAttack`, IDE 2026.2.3 JBR and `HTMLEditorKitBuilder().withWordWrapViewFactory()`) ran 10 attack shapes plus fold-collision text over widths 220..700: `cases=2131 layouts=129991 wrappedCells=101814`, 0 escapes. Shapes included leading space/NBSP runs, RTL (Hebrew/Arabic) runs, `</td></tr><tr><td>` inside a path, the elision boundary and math-bold text. C1 confirmed fixed.

| # | Finding | Disposition |
|---|---|---|
| W1 | Case-collision groups unbounded (`fold 4000` → a 29 942 px dialog) | **Fixed**: ≤ 20 groups, ≤ 5 paths per group, overflow lines; `foldCollisionGroupsAreBoundedInTheDialog` |
| W2 | Unicode mathematical-bold letters look like the bold headers and were not flagged | **Fixed**: paths whose NFKC differs from NFC are flagged (`lookAlikeCompatibilityCharactersAreFlagged`, NFD not flagged); KDoc corrected — the column layout, not the weight, is the protection |
| W3 | Send-context confirmation spoofable by wrapping (`/repo/src/qqq… selection: none` → fake left-margin line); README overclaimed | **Fixed**: `SendContextMessages` builds both send dialogs with `DialogHtml.fields` (label column + value cell); `theSendConfirmationValuesCannotWrapIntoTheLabelColumn` |
| Suggestion | A path literally containing `  ⟷  ` reads like the collision separator | Accepted (informational list only) |
| Suggestion | `baseCommit` printed without a hex check | Accepted (Core-trusted; defence in depth only) |

## Verification evidence (fresh, after the last edit)

- `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache --console=plain` → `BUILD SUCCESSFUL`; JUnit XML: **205 tests, 0 failures, 0 errors, 0 skipped**, 26 result files.
- `./gradlew verifyPlugin --offline` → `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`.
- Raw invisible-character scan of every changed `.kt`/`.md`/`.kts` file: 0 (an earlier tool conversion had turned `\u00A0` escapes into raw characters; all are escapes now).
- `make check` on the tree before the W-fixes: `make check: OK (core + schemas + vscode + desktop + jetbrains)`.
- Secret/path gate on the staged diff: clean (28 files).
