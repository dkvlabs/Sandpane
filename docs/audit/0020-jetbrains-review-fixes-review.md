# 0020 — Auto-review record: JetBrains review fixes (F4)

- **date:** 2026-10-09
- **implementation commit:** `af8949b` — fix(jetbrains): security and correctness fixes from the review (F4)
- **review ran:** before the commit, in two rounds

## Scope

`clients/jetbrains/**`: the connection manager, Core client, event streams, services, actions, UI, settings, `plugin.xml` and tests. Gradle, Kotlin, IDE and toolchain versions are unchanged; they move in U4.

## Method

1. **Discovery reviews (read-only, at `81f4841`):**
   - the JetBrains review found bugs 1–12;
   - the security review found S1 and W4 on this surface.
2. **Fix batch** by the `jetbrains-engineer` agent.
3. **Independent read-only review of the fix diff.** Verdict: PASS-WITH-WARNINGS.
   - Warnings:
     - **W1:** hole-filling events could roll status back.
     - **W2:** a late `conversation.list` overrode the user's newer pick.
   - Suggestions 1–9.
4. **Follow-up batch:** fixed W1, W2 and suggestions 1–8; 9 deferred.
   - **Negative controls:** removing each of four fixes made its test fail.
5. **Orchestrator re-ran the gate.** A cache-restored `:test` (`FROM-CACHE`) was not accepted as evidence; `test --rerun` executed the suite for real.

## Findings and disposition (discovery round)

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | High | Inverted dispose guard ran Swing off the EDT after dispose | **Fixed** |
| 2 | High | Intentional close reconnected forever; overlapping connects leaked clients | **Fixed.** Fake UDS server lifecycle tests |
| 3 | High | Conversation selection drift: the transcript showed B while Send posted to A | **Fixed.** Reconciled by id |
| 4 | Medium | One window's release killed another window's stream; listener leak | **Fixed.** Ref-counted `StreamRegistry` |
| 5–6 | Medium | Oversize replay retried forever; gap resync was a no-op | **Fixed.** Per-stream refusal; `forgetCheckpoint` before merge |
| 7 | Medium (Git safety) | Apply sent `selectedFiles=null` after the user confirmed N files | **Fixed.** Sends exactly the reviewed paths |
| 8–12 | Low | Delta lost wakeup; char vs UTF-8 budget; no-op chip; empty task id; unwired settings; missing vcs module dependency | **Fixed** |
| S1 | Suggestion (security) | Core-supplied titles rendered as Swing HTML | **Fixed.** `html.disable` plus inert text |
| W4 | Warning (security) | No socket owner/mode check | **Fixed.** `SocketTrust` |

The follow-up round fixed W1, W2 and suggestions 1–8. Suggestion 9 (timing-based tests) is deferred; the waits now poll with 8 s timeouts.

## Residual risk

- Not yet run:
  - `runIde` / JB0;
  - Plugin Verifier against multiple IDEs;
  - a live Core round trip.
- Unverified: whether `Messages.showDialog` renders HTML.
- Rename sources are absent from the protocol's `FileChange` (protocol gap, disclosed in the UI).
- Filled-in non-delta transcript rows still append at the end.
- Toolchain: the bytecode target is still 17. The 2024.2.4 baseline IDE ships JBR 21. U4 moves this.

## Verification evidence (orchestrator, fresh, before the commit)

- `./gradlew test buildPlugin verifyPluginStructure --offline` exited 0. The junit XML totals `tests=161 failures=0 errors=0 skipped=0`.
- `./gradlew test --rerun --offline` printed `> Task :test` (executed, not cached) and `BUILD SUCCESSFUL in 15s`.
- Build output: `build/distributions/sandpane-jetbrains-0.1.0-scaffold.zip` (2,754,962 bytes), which is git-ignored.
- Secret/path gate: clean (32 files). No local JDK or cache paths are in tracked files.

**Two-round review: PASS-WITH-WARNINGS → warnings fixed, 1 suggestion deferred. PASS.**
