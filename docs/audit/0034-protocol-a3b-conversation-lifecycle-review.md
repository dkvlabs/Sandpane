# 0034 — Auto-review record: protocol A3b, conversation lifecycle

- **date:** 2026-10-11
- **implementation commit:** `f44ab4c` — feat(protocol): conversation lifecycle (A3b) (77 files, +14719/−372)
- **review ran:** before the commit, on the same working-tree diff, per `audit/README.md`

## Scope

The whole A3b addition. The design decisions in [§3.3 of the design of record](../plans/2026-10-09-protocol-v1-additions.md) were written and committed (`c9d40de`) before any code.

- **Core:**
  - `sandpane-protocol`: five methods placed after `conversation.history`, so `Method::ALL` grows to 27. Also:
    - `Conversation.archivedAt?` / `sandboxId?`;
    - `conversation.list {includeArchived?}`;
    - the rename, delete and export types;
    - feature `conversation-sandbox-id`.
  - `sandpane-core`:
    - new `redact.rs`;
    - migration v6 (`conversations.archived_at`, `conversations.sandbox_id`; `.pre-v6.bak`);
    - `Validator::conversation_title`.
  - `sandpane-service`:
    - new `conversation_lifecycle.rs`;
    - `require_writable_conversation` on both send paths;
    - shared `read_message_page`;
    - test seams `test_before_task_write` / `test_before_export_redaction` (`#[doc(hidden)]`, never set in production).
  - **Dependency:** `regex =1.13.1` (default features off; std, unicode, perf-*). It pulls in `regex-automata` 0.4.18 and `regex-syntax` 0.8.11. All three are MIT OR Apache-2.0.
- **Schemas:** `rpc-request.schema.json` (27), `core-capabilities.schema.json`, `schemas/README.md`.
- **Clients:** VS Code, desktop (React + Tauri shell), JetBrains.
- **Docs:**
  - design §3.3 review amendments (merged overlaps, first-page title count, regex wording, known unmatched shapes) and the §3.4 v7 one-line fix;
  - `docs/specs/02` contract;
  - `docs/compatibility.md`;
  - plan C2;
  - root and client READMEs.

## Method

Same order as entry 0033.

1. Core and schema came first, followed by one `security-reviewer` pass on the Core diff. That pass returned **BLOCK**. Its fixes landed test-first, each with a mutation check, and the Core gate was re-run by the orchestrator before any client work.
2. Core was then frozen, and the three clients were briefed from one shared document (`a3b-client-brief.md`). It covered:
   - the exact `Method::ALL` order;
   - the exact Core messages;
   - the export assembly rules;
   - the checklist of defect classes from earlier reviews.
3. A cross-client finding from the VS Code agent was relayed to the other two (see the client findings).
4. One combined `security-reviewer` pass covered all three clients, including the phase-review checks: README claims, drift pins, test doubles and test quality.
5. Its Warnings and actionable Info items were fixed test-first in each client, then re-gated.
6. All gates were re-run fresh by the orchestrator.

## Findings

**Core review: BLOCK.**

- **C1 (Critical):** a detected PEM private-key block was discarded and its body exported in clear.
  - **Cause:** spans were taken greedily by start and any overlapping span was skipped. A single-line `env-secret` or `auth-header` match that began earlier on the BEGIN line won, and the multi-line `private-key` span was dropped.
  - **Reproduced on:**
    - quoted dotenv (`PRIVATE_KEY="-----BEGIN …`);
    - YAML (`SSH_PRIVATE_KEY: "…`);
    - `password: '…`;
    - `Authorization: x -----BEGIN …`.
  - **Rule:** Code Review rule 6 (no secrets in exports).
- **W1:** `url-credentials` missed an empty user name (`redis://:password@host`).
- **W2:** secret-named query parameters (`client_secret`, `db_password`, `refresh_token`, `id_token`) leaked. `url-secret-param` matched only exact names, and `env-secret` deliberately does not start after `?`/`&`.
- **Info:**
  - **I1:** further unmatched shapes (PGP and lowercase PEM, `ASIA…`, `xapp-`, `x-api-key`, `--password value`, JWE tails, glued prefixes, token-only URL users, folded headers, a raw `@`/`/`/`#` inside URL passwords).
  - **I2:** "linear time" was overstated (regex documents `find_iter` as O(m·n²) worst case; measured ≤ 37 ms on 25 hostile 2 MiB shapes).
  - **I3:** a narrow race: a full two-step delete landing between `conversation.send`'s commit and its event append made send answer INTERNAL.
  - **I4:** Core forgets a deleted task's worktree path (the directory stays; future `maintenance.cleanup` cannot find it).
  - **I5:** `aho-corasick` is in `Cargo.lock` but never compiled.
  - **I6:** client pins were red until the client step.
- **Also decided by the orchestrator:** the export title is redacted on every page, so summing page counts overcounted.

**Combined client review: PASS-WITH-WARNINGS, no Critical.**

- **W1 (JetBrains):** after archiving the selected conversation with "Show archived" off, the picker fell back to Core's first conversation. The composer stayed enabled, so the next message could go to a conversation the user never picked.
- **W2 (desktop):** the unknown-outcome re-read sent `includeArchived:true` without checking that `conversation.archive` is advertised.
- **W3 (VS Code):** the README still said the live check pins 22. The root README was also stale (22 methods, old counts).
- **Info:**
  1. **VS Code settle copy:** it said "the delete took effect" after an unknown outcome. The live-only re-read could also forget a conversation.
  2. **No single-flight guard** for delete and export in VS Code and JetBrains.
  3. **Uneven export page shape checks:** desktop and JetBrains did not check each message's `conversationId`; JetBrains did not require `bestEffort == true`.
  4. **JetBrains opt-in verbose log:** it logs unsolicited frames, capped at 240 characters and token-redacted, off by default. This predates A3b.
  5. **Desktop rename field:** it prefilled a raw stored title that could contain bidi or invisible characters.
  6. **VS Code modal:** it cannot default to Cancel.
  7. **JetBrains `createConversation`:** it has no callers.
  8. **Desktop export:** it is a preview + Copy, not a file save.
- **Cross-client finding (VS Code agent, during implementation):** `conversation.create` now applies `Validator::conversation_title`. A title sliced from a multi-line first message, or one that splits a surrogate pair, would make create fail.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| C1 | fixed pre-commit | Overlapping spans are merged: the region extends to `max(end)`, keeps the highest-priority kind, and is replaced and counted once. A merged region is at least as long as each part, so the never-lengthen invariant holds. Test `a_private_key_inside_an_earlier_span_is_merged_never_dropped`: eight shapes, no body text, `private-key == 1`. RED shown on the old code; mutation (skip overlap) fails it. |
| W1, W2 | fixed pre-commit | The user part becomes `[^/\s:@?#]*`. `url-secret-param` also accepts names containing `env-secret`'s keywords, under the same `(?i)`. Tests cover the leaking cases and the near-misses (`ssh://git@…`, `?monkey=`). Each has its own mutation. |
| Title count | fixed pre-commit | Title replacements are counted only when the normalized `afterSequence` is 0, so clients sum pages. Test `export_counts_title_replacements_on_the_first_page_only`. Documented on `ExportRedaction`. |
| I2 | fixed pre-commit | Module docs and design §3.3 reworded to state the documented worst case and the measured behaviour. |
| I3 | fixed pre-commit | Under the same DB guard as the append, send checks that the task still exists. If not, it skips the scaffold event and returns the summary already built. Test `send_answers_its_summary_when_the_task_is_deleted_before_the_post_commit_event` holds the public scheduler lock to open the window. No new seam. |
| I1 | accepted, disclosed | Best-effort by design (specs/06). Listed in design §3.3. Clients say "Redaction is best-effort; review the export before sharing it." |
| I4 | accepted | Required by §3.3 (Core never touches host files). The impact line discloses the count. Recorded for A9 `maintenance.cleanup`. |
| I5 | accepted | `cargo tree -i aho-corasick` prints nothing. Its license (Unlicense OR MIT) is compatible anyway. |
| I6 | fixed pre-commit | Every pinned list in all three clients moved to 27 in this commit. |
| Cross-client create title | fixed pre-commit | VS Code `titleFromMessage` and JetBrains `titleForCreate`: refused characters become spaces, whitespace collapses, the cut is by code point to 80, and a blank result sends `""` (Core stores "Untitled conversation"). The desktop takes a user-typed title validated with Core's rule. A blank one sends `""` (it used to send "Untitled chat"). Each has a RED or mutation test. |
| W1 (JetBrains) | fixed pre-commit | A vanished selection becomes NONE and stays NONE until the user picks. With nothing selected, the composer and Send are disabled ("select a conversation to continue"). Archive success adds "Archived conversations are hidden; turn on Show archived to see or unarchive it." Two tests that had asserted the old fallback were rewritten. |
| W2 (desktop) | fixed pre-commit | `recheckConversationListed` takes the archive-advertised flag. When it is false, the outcome is unknown, no list frame is sent, and nothing is forgotten. |
| W3 | fixed pre-commit | Client README fixed; root README updated (27 methods, fresh counts). |
| Info 1 (VS Code) | fixed pre-commit | New copy: "Core no longer lists this conversation; the outcome of this request was not confirmed." Without `conversation.archive`, the outcome stays UNKNOWN and nothing is forgotten. |
| Info 2 | fixed pre-commit | Single-flight delete and export: VS Code `conversationOpInFlight`, JetBrains `SingleFlight` (the button is disabled, and a racing click is refused visibly). The desktop was already single-flight. |
| Info 3 | fixed pre-commit | The desktop decoder and JetBrains `shapeProblem` refuse a page that carries another conversation's message. JetBrains also requires `bestEffort == true`. |
| Info 5 (desktop) | fixed pre-commit | `renamePrefill`: a stored title that Core's rule refuses, or that `displayRevealed` flags as unusual, is not copied into the field. It is shown revealed beside it. |
| Info 4, 6, 7, 8 | accepted | Info 4: pre-existing, off by default, redacted. Info 6: platform limit; Escape and Cancel send nothing (A1 precedent). Info 7: JetBrains has no create UI (recorded follow-up). Info 8: disclosed in the desktop README and UI; `@tauri-apps/plugin-dialog` is a follow-up. |

## Verification evidence

All run fresh by the orchestrator after the last edit, before `f44ab4c`:

- **Core gate after the review fixes:**
  - `cargo fmt --check` and `clippy --all-targets -D warnings` clean.
  - Tests: 159 + 3 + 25 + 31 + 21 + 17 + 89 + 19 = **364 passed, 0 failed**.
  - `make schema-lint schema-drift`: 27 methods and 3 features match.
- **`make check`** (log `make-check-a3b.log`), exit 0:
  - Core 364.
  - Schemas: `27 values match` (both method checks), `All schema/protocol value sets in sync.`
  - VS Code `Tests 552 passed (552)`.
  - Desktop `Tests 557 passed | 8 skipped (565)`; Tauri shell `32 passed`.
  - JetBrains `BUILD SUCCESSFUL` (up to date).
- **JetBrains, run alone with no other Gradle process:**
  - `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` → `BUILD SUCCESSFUL`, **376 tests, 0 failures, 0 errors, 0 skipped**.
  - `verifyPlugin --offline --rerun-tasks` → `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`.
- **Live checks** against an isolated Core (`env -i`, `SANDPANE_SBX_PATH=/nonexistent/sbx`, a PATH without sbx):
  - VS Code: **60/60 checks passed**.
  - Desktop: `Tests 8 passed (8)`, using a temporary socket and DB, removed afterwards.
  - Core stderr: "sbx executable not found".
  - `pgrep` showed no sbx or Core process left.
  - These checks cover the advertisement, not the A3b calls themselves.
- **Implementing-agent evidence** (re-confirmed by the gates above):
  - Core: RED for every review fix; five mutations, each failing its test; a comment- and string-aware lock-in-scrutinee scan finding 0 hits over 164 scrutinees.
  - Reviewer: a 300 000-input redaction fuzz (multibyte, C0/C1, bidi, overlapping kinds) found 0 panics and 0 outputs longer than their input, in raw bytes or JSON bytes.
  - Clients: RED baselines for the 22→27 drift; RED for the review fixes (VS Code 3, desktop 5, JetBrains 8 + 1); JetBrains mutation controls (9 of 54, and 2 of 43 for the create title).
- **Hidden characters and secrets:**
  - A scan of all 77 changed and untracked files found 0 raw invisible characters.
  - The secret gate on the staged diff matched only synthetic redaction-test fixtures, inside `#[cfg(test)]` in `redact.rs` and in `tests/conversation_lifecycle.rs`: alphabet-sequence tokens, AWS's documented `AKIAIOSFODNN7EXAMPLE`, and PEM blocks with bodies like `MIIEbodyone`.
  - The redaction tests need these fixtures, so they were accepted. No absolute or cache paths matched.
- **Not run:**
  - anything against a real `sbx`;
  - any client inside a real editor, app or IDE (dialogs, save dialogs, the clipboard in the Tauri webview, the JetBrains Swing wiring of `SingleFlight` and the null selection);
  - A3b calls through the live scripts;
  - `cargo-audit` / `cargo-deny` (not installed);
  - desktop `npm run build`.
- Desktop FakeCore A3b behaviour is labelled MODELED, not captured.

**Reviews: `security-reviewer` on Core (BLOCK → C1, W1, W2, I2, I3 fixed) and a combined `security-reviewer`/phase pass on the three clients (PASS-WITH-WARNINGS → W1–W3 and Info 1, 2, 3, 5 fixed). No Critical remains.**
