# 0018 — Auto-review record: VS Code review fixes (F3)

- **date:** 2026-10-09
- **implementation commit:** `0344167` — fix(vscode): security and correctness fixes from the review (F3)
- **review ran:** before the commit, in two rounds

## Scope

`clients/vscode/**`: the extension host, Core client, webview, manifest and tests.

## Method

1. **Discovery reviews (read-only, at `81f4841`).**
   - The VS Code review found bugs 1–12.
   - The security review found W4, S5 and S6 on this surface.
2. **The fix batch,** by the `vscode-engineer` agent.
3. **An independent read-only review of the fix diff.** Verdict: PASS-WITH-WARNINGS.
   - Warnings:
     - W1: a stale response after a project switch;
     - W2: the fallback chose tasks in insertion order;
     - W3: double sends;
     - W4: wording that overstated consent;
     - W5: `baseCommit` was not validated.
   - Suggestions: S1–S6.
4. **A follow-up batch** fixed W1–W5 and re-review S2, S3, S4 and S6. Re-review S1 and S5 were deferred as low-severity. These labels are separate from the security review's S5, which is fixed above. The engineer ran a mutation check: each new test fails with its fix removed.

## Findings and disposition (discovery round)

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| 1 / S5 | High | `vscode.diff` was given strings, and `encodeURI` broke paths containing `#` or `?` | **Fixed:** `Uri` objects with a JSON query |
| 2 | High | Reconnect leaked sockets, and a stale transport nulled the live one | **Fixed** and tested |
| 3 | High | Catch-up stayed scoped to the first project; one oversize replay disabled catch-up for good | **Fixed:** rescoped on change, with a per-task fallback |
| 4, 8 | High (rule 4) | Live-writable mode was not copied from the selected sandbox; the conversation was never reset on a scope change | **Fixed** |
| 5 | High | The composer draft was wiped on every state push | **Fixed:** built once and patched in place |
| 6, 7 | High (rule 5) | Writable context was sent unseen; dishonest copy about diagnostics and the read-only mode | **Fixed:** preview is always required, and the copy was corrected |
| 9–12 | Medium / Low | No refresh after a background reconnect; polling unused; unknown error codes; misc | **Fixed** |
| W4 | Warning (security) | A workspace's settings could redirect the socket path | **Fixed:** `scope: machine` plus a socket owner/mode check |
| S6 | Suggestion (security) | The webview nonce used `Math.random` | **Fixed:** `crypto.randomBytes` |

### Follow-up review

- Re-review S1 and S5 are deferred; they are not the security review's S5. Their contents were not carried into this record; they live in the review transcript and remain open.
- Every other follow-up item is fixed.

## Residual risk

- The extension has not been run in an Extension Development Host.
- With several projects and none stored, a project cannot be picked automatically (backlog 9).
- Polling continues while tasks sit in `queued` with no verified adapter.
- Several Core additions are still needed: a send mode, attachment storage, `Conversation.sandboxId`, and `ChangeSet.repoPath`.

## Verification evidence (orchestrator, fresh, before the commit)

- `npm run typecheck`: clean.
- `npm test`: `Test Files 19 passed (19)`, `Tests 280 passed (280)`.
- `npm run package`: `DONE Packaged: sandpane-0.0.1.vsix (30 files, 95.32 KB)`. The `.vsix` is git-ignored.
- Live check (engineer, against a local Core debug build): `56/56 checks passed`.
- Secret/path gate: clean (37 files).

**Two-round review: PASS-WITH-WARNINGS → warnings fixed, 2 suggestions deferred. PASS.**
