# Sandpane Desktop

Tauri 2 + React + TypeScript shell for Sandpane: the multi-project control centre for
AI development workspaces and Docker sandboxes.

It attaches to **the same single persistent per-user Sandpane Core** that VS Code and
JetBrains use, over the same NDJSON socket protocol. It does **not** start its own Core,
does not reimplement task/project business logic in Tauri handlers, and does not ship a
second sandbox backend.

Status: **P5 / DT0–DT1 scaffold**, re-synced to the additive protocol-v1 revision
(`task.list`, `conversation.list`, `conversation.history`, `CoreCapabilities.methods`,
`Project.repositories`, `SandboxSummary.workspaceMode`, `TaskSubscribeParams.afterSequences`).
The shell, the wire client and the full information architecture are real and tested. The Tauri
Rust shell compiles, lints and unit-tests clean on this host **as of the review-fix pass below**;
an earlier revision of this README claimed that while the crate did not compile (see
[Verification](#verification)).

---

## Verification

### Verified on this host (macOS, Node 24.5.0, Rust 1.99.0 / Homebrew) — A5 git.diff pass, 2026-10-11

Run fresh after the A5 `git.diff` + ChangeSet fields client work (protocol design 2026-10-09 §3.5),
against the A5 Core + schema in the working tree, on top of the A4 send-mode work (§3.4), the A3b
conversation-lifecycle work (§3.3) and
the A3a project-lifecycle work (§3.2), the A2 idempotency work and its review fixes
(W1–W4, I4, I5) and the A1 sandbox-lifecycle work and its review fixes. Every row below is a command that was actually run, with its actual
result, except where a row says it was not re-run:

| Command | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | OK — 0 errors |
| `npm test` (`vitest run`) | OK — **20 files, 614 tests passed**; 1 file (8 live tests) skipped without `SANDPANE_SOCKET` |
| `npm run build` (`tsc --noEmit && vite build`) | NOT re-run in the A1 pass. Last run in the 2026-10-09 review-fix pass: OK, `dist/` emitted (338.83 kB JS, 20.65 kB CSS then) |
| `cd src-tauri && cargo fmt --check` | OK — no diff |
| `cd src-tauri && cargo check --offline` | NOT re-run separately in the A3b / A4 / A5 passes (`clippy --all-targets` below compiles the crate) |
| `cd src-tauri && cargo clippy --offline --all-targets -- -D warnings` | OK — no warnings |
| `cd src-tauri && cargo test --offline` | OK — **33 passed; 0 failed** (frame validation and wire-length cap, CR/LF smuggling, response-id match, Core's connection-level refusal, per-method budgets, socket path policy, socket trust check, and fake-Core round trips on a real socket: retry-once for reads on early EOF / connect refused, no retry after a timeout or for a mutation, a part-way write of a mutation flagged as maybe-applied, `sandbox.stop` / `sandbox.remove` never re-sent after an early EOF; `Method::ALL` is 28; the six A3a project methods, the five A3b conversation methods and A5's `git.diff` are allowlisted and never replay-safe; the A3a and A3b methods are on the default 12 s budget except `project.create` / `project.add_repository` at 43 s, and `git.review` / `git.diff` are at 43 s; a lost answer to an `is_read_only` method — `git.diff` and `conversation.export` included — is never marked maybe-applied) |
| `make desktop-check` (repo root) | NOT re-run in the A3b / A4 / A5 passes (the orchestrator runs `make check`); it runs all of the above except `npm run build` |
| `npm run lint --if-present` | No `lint` script in this package — nothing ran |

**Correction of an earlier claim.** A previous revision of this table reported `cargo check` OK
and "7 passed" for `src-tauri`. That was false at the time: since commit `fbc45e2` the crate failed
to compile (`E0308`, `replay_safe(request.method)` passed a `String` where a `Method` was required),
and `make check` never compiled `src-tauri` because it is not in the `core/` workspace. The crate
now compiles, and `make desktop-check` builds and tests it, so the same regression fails the gate.

### A1 sandbox lifecycle (stop / remove / sbx agent) — status

| Item | Status |
| --- | --- |
| Stop (confirmed; shows re-queried state, UNKNOWN when `requeried` is absent) | Functional headless: unit-tested against an in-memory FakeCore. **UNVERIFIED live** — never run against a real Core + sbx |
| Remove (Core two-step token; dialog shows impact, sbx id, expiry, "NOT CONFIRMED AS CREATED BY SANDPANE"; cancel sends nothing) | Functional headless, same tests. **UNVERIFIED live** — never run against real sbx |
| Stop dialog active-task count | Reads `task.list`; today's Core never records `sandboxName` on tasks, so the dialog says the count cannot be checked instead of showing 0 |
| sbx agent in the create wizard (default `shell`) | Functional headless; non-shell agents only when the Core advertises the `sandbox-create-agent` feature (A2; replaced the earlier "`sandbox.remove` is advertised" inference). **UNVERIFIED live** |
| FakeCore `sandbox.stop` / `sandbox.remove` handlers | **Modeled** on `sandpane-service` source (`sandbox_stop`, `sandbox_remove`, `confirm.rs`), **not captured** from a live run |
| The hook that sends `sandbox.stop` / step 2 after the dialog confirms (`useSandboxLifecycle`) | No DOM test (no jsdom in this suite); the pure controllers are tested, and the dialogs are checked as SSR markup only. Focus trap / Escape / focus return in a real webview are unverified |

### A2 idempotency keys — what the desktop does, and status

- **Features.** `system.probe` `features` is decoded absent-tolerantly (absent = nothing
  advertised; unknown strings are kept but never acted on). The known set is drift-tested
  against Rust `FEATURES` and the schema's `features.items.examples`.
- **Keys.** Only when Core advertises `idempotency-keys`, each user action — one wizard
  **Create**, one chat **Send** — carries one fresh `idempotencyKey`: 32 lowercase hex characters
  from `crypto.getRandomValues`, never derived from content. Without the feature no key is sent.
  A key is checked against Core's exact rule (1..=128 of `[A-Za-z0-9._-]`) before the frame is
  written.
- **Retry safely.** When a keyed Create/Send ends with an UNKNOWN outcome (a timeout or transport
  drop after the write, or a Core `INTERNAL`), the error panel offers **Retry safely**, which
  resends the identical params with the same key. Nothing retries automatically. On click it
  first re-probes the connected Core (`system.probe`): if `idempotency-keys` is no longer
  advertised nothing is sent ("Not retried: the connected Core does not advertise idempotency
  keys, so a retry could run it twice. Nothing was sent — check state first."); if the re-probe
  cannot reach Core nothing is sent and Retry safely stays offered. A retry that provably never
  reached Core (`CORE_UNREACHABLE`, not maybe-applied) keeps the original unknown outcome and
  key, offers Retry safely again, and shows the unreachable reason as secondary text. A double
  click sends once. An answer to Create/Send that this build cannot decode is reported as an
  unknown outcome (maybe applied), never echoing the payload. Without a key, an unknown outcome —
  including a Core `INTERNAL` on Create/Send — says "Check state before trying again (this Core
  does not advertise idempotency keys, so a retry could run it twice)." `REPLAY_SAFE_METHODS`
  and the Rust `replay_safe` are unchanged.
- **Replays.** A response with `replayed: true` shows "Core returned the result of your earlier
  identical request (replayed). It may be out of date; refreshing from Core." and the view
  re-reads `sandbox.list` / `task.list` + history; a replayed task's status is not shown as
  current. A present but non-boolean `replayed` is read as "may be a replay": the same
  re-read happens and the status is not shown as current.
- **CONFLICTs.** The three A2 messages are matched on Core's exact text (drift-tested against
  `sandpane-service`): "key used with different parameters" and "still in progress" say nothing
  was run; "outcome unknown" says to re-read state and that a retry needs a new request — never
  "nothing was run". A1's per-sandbox name-lock CONFLICT is titled "Nothing was run — another
  operation on this sandbox is in progress". Core's own message is always shown, revealed and
  capped.

| Item | Status |
| --- | --- |
| Features, keys, Retry safely, replay notice, CONFLICT copy | Functional headless: unit-tested against an in-memory FakeCore (`tests/idempotency.test.ts`). **UNVERIFIED live** — never run against a real Core + sbx, never in the running desktop app |
| FakeCore `features`, `sandbox.create` / `conversation.send` idempotency, `replayed`, CONFLICTs, lost-answer drop | **Modeled** on the `sandpane-service` source (§3.1), **not captured** from a live run |
| The Retry safely button and replay notices in the wizard and chat | No DOM test (no jsdom); the pure decision functions are tested |

### A3a project lifecycle — what the desktop does, and status

- **Methods.** `METHODS` was the 22 names of `Method::ALL` at A3a (27 since A3b, below), in order (drift-tested against the
  Rust crate and `schemas/rpc-request.schema.json`). The six new ones — `project.update`,
  `project.archive`, `project.unarchive`, `project.delete`, `project.add_repository`,
  `project.remove_repository` — are NOT replay-safe (TS `REPLAY_SAFE_METHODS` and the Rust
  `replay_safe` are unchanged). They use the default deadlines (webview 15 s, proxy 12 s) except
  `project.add_repository`, which — like `project.create` (a pre-existing gap fixed here) — runs
  Core's git canonicalization of a path (up to 30 s): webview 45 s, proxy 43 s (drift-tested,
  proxy ≥ 2 s below the webview).
- **Gating.** Every control is gated on `system.probe` `methods`, per method: not probed yet →
  "Core not probed yet"; not advertised → disabled "not supported by this Core" with the reason.
  "Show archived" is offered only when `project.archive` is advertised; otherwise
  `project.list` is sent exactly as before (`{}`).
- **Projects view → Settings** (per row): rename and a multi-line description (only CHANGED
  fields are sent; validators mirror `Validator::project_name` / `project_description` exactly
  — characters counted as Rust counts them, drift-tested against `validation.rs` — and also
  refuse a lone UTF-16 surrogate, which has no UTF-8 form and which Core refuses at the frame); archive /
  unarchive; repositories list with a two-click "Remove… → Unregister from Core"; "Add a
  repository" as a **typed absolute path** — the Tauri dialog plugin is not a dependency of this
  app, so there is no native folder picker; Core validates the path (Git top level, denylist).
- **Archived.** Rows carry an "archived <instant>" badge. On an archived project the name,
  description and repository controls are disabled with Core's own reason ("project is archived;
  unarchive it first; nothing was changed"); Unarchive and Delete stay available. The project
  workspace reads the project with `includeArchived` (when supported), shows an archived banner,
  and disables New chat and Send with the same reason. The sandbox wizard lists live projects
  only (Core's default), so an archived project cannot be picked there; a project archived after
  the list was read is refused by Core with the honest "Nothing was changed — the project is
  archived" copy.
- **Delete** uses the A1 two-step pattern: step 1 sends `{projectId}`; the dialog shows Core's
  target name + id, impact lines (revealed, capped at 20 with the rest disclosed), and the
  expiry; Cancel is the default and sends nothing; expiry is re-checked at click time; step 2 is
  sent once and never retried. A confirmation for another project id, or with
  `external: true`, is refused. "Deleted" is shown only on `deleted: true`; after it the
  remembered selection, this window's chats of that project, its cached conversation / task /
  history reads and its tasks' replay projections in the event store are dropped, and the global
  task list is re-read. (Replay cursors for the deleted tasks stay in the subscription; Core
  replays only tasks it still has, so they are ignored.) If step 2's outcome is UNKNOWN, the
  desktop re-reads `project.list {includeArchived: true}`: when Core no longer lists the project
  it says exactly that ("Core no longer lists this project", not "deleted by this request") and
  forgets it locally the same way; if it is still listed, or the read fails, the outcome stays
  unknown. A step-2 `NOT_FOUND` also forgets it locally.
- **Honest copy.** Each exact Core refusal (archived, unfinished tasks, sandboxes, create in
  flight, repository in use, not registered, not found, token rejected) maps to "Nothing was
  changed / deleted / removed — …" with Core's text shown, matched on code AND text
  (drift-tested against `project_lifecycle.rs` and `confirm.rs`). A Core `INTERNAL`, a lost
  answer, or an answer this build cannot read on any of these writes is an UNKNOWN outcome
  ("re-read the project list") — never "nothing was …". Payloads are never echoed; the token is
  never logged, displayed or persisted. After every write `project.list` is re-read.

| Item | Status |
| --- | --- |
| Wire frames, gating, delete flow, copy, validators, archived UI state | Functional headless: unit-tested against an in-memory FakeCore (`tests/project-lifecycle.test.ts`, 55 tests, incl. SSR markup of the settings panel and the delete dialog). **UNVERIFIED live** — never run against a real A3a Core, never in the running desktop app |
| FakeCore `project.update` / `archive` / `unarchive` / `delete` / `add_repository` / `remove_repository`, `includeArchived`, faults | **Modeled** on `sandpane-service/src/project_lifecycle.rs` (working tree, §3.2), **not captured** from a live run |
| Native folder picker for "Add a repository" | **Not implemented — accepted deviation**: `@tauri-apps/plugin-dialog` is not a dependency; a typed path is used and Core validates it |
| Click handlers, focus, the dialog's countdown in a real webview | No DOM test (no jsdom); the pure controllers and SSR markup are tested |
| New chat / Send disabled on an archived project (`ChatPanel` `archivedReason`) | The reason string is tested; `ChatPanel` itself cannot be SSR-rendered in this suite (its external-store hooks have no server snapshot), so the disabled buttons are **UNVERIFIED** |

### A3b conversation lifecycle — what the desktop does, and status

- **Methods.** `METHODS` was the 27 names of `Method::ALL` at A3b (28 since A5, below), in order. The five new ones follow
  `conversation.history`: `conversation.rename`, `conversation.archive`, `conversation.unarchive`,
  `conversation.delete`, `conversation.export`. None is replay-safe (TS `REPLAY_SAFE_METHODS` and
  the Rust `replay_safe` are unchanged); all five use the default deadlines (webview 15 s, proxy
  12 s). Drift-tested against the Rust crate, the proxy and `schemas/`.
- **Gating.** Each control is gated per method on `system.probe` `methods` (not probed yet / not
  supported, with the reason). "Show archived" is offered only when `conversation.archive` is
  advertised; `includeArchived: true` is then the only addition to `conversation.list` (it is never
  sent as `false`). The "sandbox chosen at creation" line needs the `conversation-sandbox-id`
  feature; without it the desktop says "not reported by this Core".
- **Where.** Chat panel → "Conversation settings" (per selected chat): the sandbox chosen at
  creation (revealed name, with the caveat that it is a record of the choice, not a live
  binding; "not in the current sandbox list" or "sandbox list unavailable" when that is what is
  known), Rename (Core's `conversation_title` rule mirrored exactly — 200 characters counted as
  Rust counts them, controls / C1 / U+2028–2029 / bidi controls refused, blank refused on rename
  only; blank on create becomes Core's "Untitled conversation"). A stored title Core would refuse,
  or one with invisible characters, is never prefilled raw into the rename field: the field
  starts empty and the title is shown revealed beside it. Archive / Unarchive, Delete…,
  and Export…. Tabs and the Chats view show revealed titles and an "archived" badge.
- **Archived.** On an archived conversation Rename and Send are disabled with Core's reason
  ("conversation is archived; unarchive it first; nothing was changed"); history stays readable,
  Unarchive and Delete stay available. On an archived project the project reason comes first.
  Since A3b Core answers a send to an archived conversation with `VALIDATION_FAILED` and that
  message (it used to be `NOT_FOUND`); the desktop maps it to "Nothing was changed — the
  conversation is archived".
- **Create title.** The title of a new chat is the user's own one-line field, checked with Core's
  rule before "New chat" is enabled. It is never derived from a message (no slicing of a prompt,
  so no multi-line or split-surrogate title can reach Core). A title that is blank as Rust judges
  it (Unicode White_Space, not JS `trim()`) is sent as `""`, so Core stores its own "Untitled
  conversation" — the same as the VS Code client. (Before A3b this build sent "Untitled chat".)
- **Delete** uses the A1/A3a two-step pattern bound to the conversation id: step 1 shows Core's
  impact lines (revealed, capped) and the expiry; Cancel is the default and sends nothing; step 2
  is sent once, never retried. A confirmation for another id, a step-1 answer that already says
  `deleted`, or `external: true` is refused. "Deleted" only on `deleted: true`; then the chat,
  its cached history, its tasks' list rows and replay projections are dropped locally and the
  list is re-read. If step 2's outcome is UNKNOWN (INTERNAL, lost answer, unreadable answer) the
  desktop re-reads `conversation.list {projectId, includeArchived: true, limit: 500}` — only when
  `conversation.archive` is advertised (a live-only list cannot tell archived from deleted, so
  without it the outcome simply stays unknown and nothing is read): absent from a non-full page →
  "Core no longer lists this conversation" and it is forgotten locally; still listed, a full page
  (500 rows) or a failed read → the outcome stays unknown. Exact Core
  refusals (unfinished tasks, not found, token rejected) say "Nothing was deleted / changed — …".
- **Export.** Pages `conversation.export` from `afterSequence: 0` until `truncated: false`;
  `nextSequence` must strictly increase (else the export is marked PARTIAL, "cursor"), at most
  200 pages (else PARTIAL, "page-cap"). Any page failure → "Export failed — no export was
  produced; nothing was copied" (no document, no partial text). A page whose conversation or
  any message names another conversation id is refused by the decoder. Redaction counts are summed
  across pages (Core counts the title on the first page only); `redaction.bestEffort: true` is
  required on every page. The assembled JSON escapes hidden characters as `\uXXXX`. **There is
  no file save**: the desktop shows a read-only, revealed preview capped at 400 lines × 300
  characters (the rest disclosed as "…N more lines") and a Copy button
  (`navigator.clipboard.writeText`), with a notice to review the text before sharing it —
  Core's redaction is best-effort. Export text is never logged and is dropped when the chat
  changes.
- **Honest copy.** Exact Core messages are matched on code AND text (drift-tested against
  `conversation_lifecycle.rs`); anything else gets the generic copy, never "nothing was …".
  The delete token is never logged, displayed or persisted; decode errors never echo payloads.

| Item | Status |
| --- | --- |
| Wire frames, gating, validators, delete flow, re-check, export paging/assembly/preview, copy | Functional headless: unit-tested against an in-memory FakeCore (`tests/conversation-lifecycle.test.ts`, 73 tests, incl. SSR markup of the actions, delete dialog and export panel). **UNVERIFIED live** — never run against a real A3b Core, never in the running desktop app |
| FakeCore `conversation.rename` / `archive` / `unarchive` / `delete` / `export`, `includeArchived`, archived send refusal | **Modeled** on `sandpane-service/src/conversation_lifecycle.rs` (working tree, §3.3), **not captured** from a live run |
| Save export to a file | **Not implemented — accepted deviation**: `@tauri-apps/plugin-dialog` / `plugin-fs` are not dependencies; a preview + Copy is offered instead |
| Clipboard write inside the Tauri webview | **UNVERIFIED** — the Copy path is tested with an injected clipboard; WebKit permission behaviour in the native window was never exercised |
| `ChatPanel` wiring (settings section, disabled Send on an archived chat) | Not SSR-renderable in this suite (external-store hooks); the pieces it composes are tested, the panel itself is **UNVERIFIED** |
| `tests/live-core.test.ts` A3b pins (27 methods, `conversation-sandbox-id` advertised) | Updated, **not run** (skips without `SANDPANE_SOCKET`) |

### A5 git.diff — what the desktop does, and status

- **Methods: 28.** `git.diff` sits between `git.review` and `git.apply` (drift-tested against Rust
  `Method::ALL`, the schema, and the proxy's `Method::ALL.len()` test). It is NOT replay-safe (TS
  `REPLAY_SAFE_METHODS` and Rust `replay_safe`). `git.review` and `git.diff` get the git deadline:
  webview 45 s, proxy 43 s, pinned on both sides.
- **Change set.** `ChangeSet.repoPath` is shown (revealed); `FileChange.oldPath` is shown as
  `oldPath → path` for renames; `uninspected` (never produced by an A5 Core) would show "N paths
  were not inspected — this change set is not complete", and an empty list is then never called
  an empty change set. Paths are exact since A5 (no C-quoting); they are revealed on display, so a
  tab or newline in a file name is visible.
- **Diff action.** Every change-set entry gets a Diff button, gated on `git.diff` being advertised
  (otherwise disabled with "not supported by this Core"). It sends `{taskId, path, status}` with
  the entry's `path` byte for byte (never trimmed or normalized) and ALWAYS its `status` (a path
  can be listed twice). `maxBytes` is omitted (Core's default 262 144); the client never sends
  more than 524 288. An entry whose status this build does not recognise cannot be diffed.
- **Rendering.** The patch is untrusted text: a read-only monospace `<pre>` of React text
  children (never `dangerouslySetInnerHTML`), split on LF, each line revealed (hidden, control,
  bidi characters, CR and U+2028 become `\u` escapes; the line is marked "!"; tabs stay), capped at
  2 000 lines × 1 000 characters per whole line (tabs included, counted before escaping) with the
  rest counted. File names come from the JSON
  `path` / `oldPath` only. A Copy button copies the patch exactly as Core returned it and reports
  failure honestly; after a copy the note says how many lines of the whole patch hold hidden
  characters (when any) and "Never apply this patch — it may create symlinks." The view says it is
  display only; the patch is never applied, written to the repository or run.
- **Disclosures.** `binary`: "treated as binary (possibly by repository attributes) — no text diff
  shown"; `truncated`: "diff truncated at N bytes"; `lossy`: "contains bytes that are not valid
  UTF-8; shown with replacement characters"; renames `oldPath → path`; "symlink → target" only
  for Core's exact untracked symlink shape (status `untracked`, not binary or truncated, line 2
  exactly `new file mode 120000`, hunk header exactly `@@ -0,0 +1 @@`, exactly one `+` line —
  the JetBrains rule), otherwise no symlink line (a target containing a newline, a typechange); `baseBlob` as a short id; an
  empty non-binary patch as "Core returned an empty patch …". Never "no changes".
- **Honest copy.** Core's exact refusals (path not in the change list, listed twice, not valid
  UTF-8, work tree redirected, no Git context, worktree removed, submodules, and the untracked
  read refusals ending "; nothing was read") map to "Nothing was read — …" (drift-tested against
  `sandpane-service`, `git.rs`, `diff.rs`). The two pattern matches (the submodule prefix and the
  "; nothing was read" suffix) apply only to an error that answered `git.review` / `git.diff`
  (`CoreRequestError.method`); the same text from any other method gets the generic copy. A timeout is "Core did not answer in time — no file was
  changed (git.diff is read-only)"; INTERNAL is "Core could not produce the diff — no file was
  changed …". `git.diff` failures never use the "may have been applied" wording of writes: the
  proxy's `after_write` adds its suffix only for methods outside `is_read_only` (an exhaustive
  `match`, separate from `replay_safe`: `git.diff` and `conversation.export` are reads that are
  still not re-sent), and `diffFailureCopy` strips both the webview's and the proxy's suffix
  (drift-tested against `MAY_HAVE_BEEN_APPLIED_SUFFIX`).

| Item | Status |
| --- | --- |
| Frames, gating, decoding, disclosures, copy, deadlines, SSR of the diff view | Functional headless: `tests/git-diff.test.ts` (31 tests) against an in-memory FakeCore. **UNVERIFIED live** — never run against a real A5 Core, never in the running desktop app |
| FakeCore `git.review` (exact paths, `repoPath`, `oldPath`) / `git.diff` (path + status gate, truncation, binary, refusals) | **Modeled** on `sandpane-service/src/lib.rs` (working tree, §3.5), **not captured** |
| A diff of a real task | **UNVERIFIED and not reachable over the wire today**: no wire-created task has Git context until A4b, so a real Core answers "task has no Git context" |
| The Diff button, the open diff and Copy inside `ReviewPanel` | `ReviewPanel` is not SSR-rendered in this suite; `DiffView` and the pure helpers are tested, the wiring is **UNVERIFIED** |
| Clipboard in the Tauri webview | **UNVERIFIED** (tested with an injected clipboard) |
| `tests/live-core.test.ts` A5 pins (28 methods, `git.diff` advertised) | Updated, **not run** |

### A4 send mode — what the desktop does, and status

- **No new method** (still 27). `KNOWN_FEATURES` gains `conversation-send-mode` (drift-tested
  against Rust `FEATURES`). The proxy (`ipc_client.rs`) pins no features and is unchanged.
- **Composer (Chat panel).** A "Send as: Task / Discuss" choice, default Task. It is enabled only
  when Core advertises `conversation-send-mode`; otherwise it is shown disabled with "not supported
  by this Core" (or "not probed yet"), and `mode` is never sent — a pre-A4 Core would drop it and
  record a discussion as a task. Task omits `mode` (the frame stays byte-identical to an A2/A3b
  send); Discuss sends `"mode":"discuss"`. The choice is UI-only, per conversation, for this window
  only (never persisted; every chat starts at Task). Copy: neither Task nor Discuss runs an agent
  in this build — Core records the requested mode and the task stays queued; Discuss is not a
  sandbox or a restricted run.
- **Retry safely** resends the identical variables (same key, same mode). A Discuss retry is not
  sent when the re-probed Core no longer advertises `conversation-send-mode` ("Not retried: … it
  would drop "discuss" …"; Retry safely is withdrawn). This needed a params-aware pre-retry check
  in `KeyedWrite` (`recheckKeys(params)`, new `not-retried` outcome); `sandbox.create` keeps the
  keys-only check.
- **Task rows and detail** show "Send mode" (`TaskSummary.mode`, an OPEN string: an unknown value
  such as `plan` is shown as-is) and "Sandbox chosen by its chat — not where it runs"
  (`TaskSummary.chosenSandboxName`), read-only, revealed and capped at 120 characters. Older tasks
  carry neither, and nothing is shown.
- **`chosenSandboxName` is never a binding.** It is kept in its own `TaskIndexEntry` field and is
  never read by `taskIsolationView` (a task carrying only it stays UNVERIFIED) or by
  `countActiveTasksOn` (its stop count stays "cannot be checked"). Both are tested.
- **`sandbox.remove` step 1** may carry Core's new impact line ("N unfinished task(s) were sent from
  chats that chose this sandbox name; removing it does not cancel them"); the existing revealed,
  capped impact rendering shows it (tested). `sandbox.stop` is unchanged.
- **Honest copy.** Core's exact `VALIDATION_FAILED` `mode must be "task" or "discuss"` maps to
  "Core did not accept the message — it refused the send mode" (the frame was sent; Core refuses
  before any key row, message or task).
- **A new Discuss send re-probes Core first.** The cached probe can be up to 30 s old, so just
  before a NEW Discuss send `system.probe` is re-read. If `conversation-send-mode` is no longer
  advertised the send is refused visibly ("Not sent: this Core does not advertise send modes, so
  it would record the discussion as a task. Nothing was sent."), no frame is written, and it is
  never downgraded to Task; a failed re-probe also sends nothing. Send is disabled while the
  re-probe runs. A Task send is not re-probed.
- **Answer check.** If a Discuss send's task does not report `mode: "discuss"`, a "Send mode not
  recorded" warning says Core did not record the requested mode (the reported value revealed).

| Item | Status |
| --- | --- |
| Frames, gating, retry, decode, facts, isolation/stop exclusions, impact line, copy | Functional headless: `tests/send-mode.test.ts` (26 tests, incl. SSR of the choice and the facts) against an in-memory FakeCore. **UNVERIFIED live** — never run against a real A4 Core, never in the running desktop app |
| FakeCore `mode` validation / normalization, `TaskSummary.mode` / `chosenSandboxName`, the `features` entry, the remove impact line, a pre-A4 Core dropping `mode` | **Modeled** on `sandpane-service/src/lib.rs` (working tree, §3.4), **not captured** from a live run |
| The choice inside `ChatPanel` (wiring, per-conversation memory) | `ChatPanel` cannot be SSR-rendered in this suite; the component and the pure helpers are tested, the wiring is **UNVERIFIED** |
| `tests/live-core.test.ts` A4 pins (`conversation-send-mode` advertised, features equal `KNOWN_FEATURES`) | Updated, **not run** |

### Live Core run (earlier evidence — NOT re-run in the review-fix pass)

This section records an earlier run and was not repeated after the fixes above. The prebuilt `core/target/debug/sandpane-service` (built 15:09, never rebuilt or edited here)
was started read-only against a disposable socket and database, and `tests/live-core.test.ts`
ran the app's own `CoreClient` against it:

```
SANDPANE_SOCKET=/tmp/sp-desk-final/run/s.sock npx vitest run --reporter=verbose tests/live-core.test.ts
 ✓ advertises the full method list, and the additive reads are in it
 ✓ returns repositories on project.list and an array from conversation.list
 ✓ refuses a blank scoping id with VALIDATION_FAILED — the guard mirrors the verdict
 ✓ clamps a zero limit to ONE row, not zero rows and not the whole table
 ✓ reads a stored transcript as an object that discloses its bounds
 ✓ hydrates task.list and replays each task from its OWN cursor
 ✓ decodes sandbox.list's additive workspaceMode without guessing it
 ✓ a truncated-shaped page still decodes, and paging past the end is empty
 Tests  8 passed (8)
```

What that run measured (not asserted from prose):

- `system.probe` → `methods` was the 14-name list, `Method::ALL` order, for the Core of that run.
  The A1 Core advertises 16 (`sandbox.stop`, `sandbox.remove` added); that has NOT been re-run
  live from the desktop.
- `project.list` → rows carry `repositories`; `project.create` echoes them.
- `task.list` / `conversation.list` / `conversation.history` exist and answer.
- `conversation.history` is an **object** (`messages`, `truncated`, `nextSequence`); with
  `limit: 1` over three stored messages Core returned one row, `truncated: true`,
  `nextSequence: 1`, and the next page started at sequence 2.
- `limit: 0` → exactly 1 row; `limit: 999999` → clamped (never the whole table).
- `projectId: ""` → `VALIDATION_FAILED: projectId: value is empty` from **Core**; the desktop
  refuses the same value before writing a frame.
- Per-task cursors: a task named in `afterSequences` resumed past its own cursor, tasks absent
  from the map replayed from 1, and with a `taskId` the scalar won while Core ignored the map.
- `sandbox.list` → `NOT_INSTALLED: sbx executable not found` on this host (no `sbx` binary),
  surfaced as a structured error rather than an empty list.

### Not verified here, and therefore not claimed

- `npm run tauri dev` / `npm run tauri build` — the crate **compiles, lints and unit-tests clean**,
  and its socket exchange is tested against a fake Core listener on a real Unix socket, but the
  native window has never been launched on this host: no WebKit runtime check, no round trip
  through `core_request_frame` over Tauri IPC, no build/sign/notarize run. In particular the
  narrowed capability (`allow-core-request-frame` only, no `core:*` permissions) is validated by
  `tauri-build` at compile time but has **not** been exercised at runtime.
- The `SOCKET_UNTRUSTED` check (lstat: socket, owned by this uid, no group/other bits) has a
  residual race between the `lstat` and `connect`; a peer-credential check on the connected
  socket is the full fix and is not implemented here.
- Socket path on Linux: the desktop now resolves `$XDG_STATE_HOME/sandpane/sandpane.sock`, the
  same as the VS Code client. The committed Core service used `$XDG_STATE_HOME/sandpane.sock`
  when `XDG_STATE_HOME` is set; aligning Core is a separate change, not verified from this app.
  Until it lands, set `SANDPANE_SOCKET` explicitly on Linux. macOS paths already agree.
- The `refused` replay path (Core's oversized-replay latch) is covered by unit tests against a
  test double modelled on Core's measured refusal text; it has not been triggered against a Core
  holding ~4 MiB of events.
- The Windows named-pipe transport — Core itself serves Unix sockets only, so the desktop proxy
  returns `TRANSPORT_UNSUPPORTED` there instead of pretending.
- `workspaceMode` end-to-end: decoding, clamping and the UNVERIFIED rendering are unit-tested;
  no sandbox with a recorded binding row was read on this host because `sbx` is absent.
- Native notifications, the native folder picker, installers.
- **Deviation (A3a, accepted): no native folder picker for "Add a repository".** The design asks
  for each client's native folder picker; `@tauri-apps/plugin-dialog` is not a dependency of
  this app, so the path is a typed absolute path that Core validates (Git top level, denylist).
  Adding the plugin (and its capability) is a separate, reviewed change.
- **Deviation (A3b, accepted): no file save for `conversation.export`.** The design leaves the
  save mechanism to each client; this app has no dialog/fs plugin, so it shows a capped,
  read-only preview with Copy. Adding a save path is a separate, reviewed change.
- Performance targets (idle CPU/memory, 30-chat retention): never measured.
- **App icon:** `src-tauri/icons/*.png` are minimal generated placeholders created to satisfy
  `tauri::generate_context!`, which refuses to compile without them. Brand artwork is a design
  pass item; nothing about them is claimed as final.

---

## What runs today

```bash
cd apps/desktop
npm install
npm run typecheck && npm test   # the two gates
npm run dev                     # UI shell in a browser: shows the OFFLINE state by design
npm run tauri dev               # native window (compiles here; never launched here)

# Optional: run the live wire suite against a Core you started yourself
cd ../.. && core/target/debug/sandpane-service &      # or `cargo run -p sandpane-service`
cd apps/desktop && SANDPANE_SOCKET=<the socket> npm test
```

`npm run dev` in a plain browser is not a demo mode. There is no fake Core there: the
transport resolves to an explicit *unavailable* state, every view says Core cannot be
reached, and no data is invented. Run `sandpane-service` and `npm run tauri dev` for real
data.

`tests/live-core.test.ts` **skips unless `SANDPANE_SOCKET` is set**, and when it runs it
creates a project, a conversation and tasks in whatever Core it is pointed at. Point it at a
disposable `SANDPANE_DB`, never your working one.

## Prerequisites for real behaviour

1. Build and start the persistent Core: `cd core && cargo run -p sandpane-service`.
   Socket policy: `SANDPANE_SOCKET`, else `~/Library/Application Support/sandpane/sandpane.sock`
   (macOS) / `$XDG_STATE_HOME/sandpane/sandpane.sock` (Linux) — user-scoped, `0600`, never TCP.
2. Docker SBX CLI installed and its daemon running, if sandbox features are wanted. Core
   reports `installed` only after locating the binary; the desktop reports `NOT_INSTALLED`
   or `DAEMON_DOWN` exactly as Core answers.
3. Agent adapters with a passed feasibility gate for tasks that actually run. An unverified
   adapter is selectable and honestly reported as such; its task stays `queued` with an
   `adapter.unavailable` event.

Sandpane never bundles the `sbx` binary and never imports provider credentials.

---

## Architecture

```
React view  →  CoreClient (src/lib/core-client.ts)      ← framing, id correlation,
                     │                                     per-task cursor replay
              guards.ts (pre-flight validation)
                     │
              CoreTransport (injected)
                     │
   TauriTransport ── invoke("core_request_frame") ── Rust proxy (src-tauri/src/ipc_client.rs)
                                                          │  validates v/id/method + 4 MiB cap
                                                          ▼
                                                per-user Core Unix socket (NDJSON)
```

- **Wire contract is shared, not re-invented.** `src/lib/protocol.ts` mirrors
  `core/crates/sandpane-protocol` exactly: camelCase payload fields, `snake_case` statuses and
  workspace modes, `SCREAMING_SNAKE_CASE` error codes, `{v,id,…}` frames, the `AgentEvent`
  tagged union, and the 28-name `Method` surface of Rust `Method::ALL` (A3a added six project
  methods, A3b five conversation methods, A5 `git.diff`). `schemas/*.json` is
  the third copy; they move together, and `tests/protocol-drift.test.ts` reads the Rust crate and
  the schemas to prove it.
- **Feature detection, never assumption.** Every additive read is gated on
  `coreAdvertisesMethod(capabilities, method)` from `system.probe`. A Core that does not
  advertise a method is never sent it — the app asks rather than inferring support from a
  version number (AGENTS rule 5). "Not probed yet" renders as its own state, not as "unsupported".
- **The Rust shell is a narrow typed client.** Two commands total:
  `core_request_frame` (one validated request → one response line) and `core_socket_status`
  (read-only metadata). It re-validates every method against `sandpane_protocol::Method` — it
  holds **no method list of its own**, so the allowlist cannot drift from Core — enforces
  `MAX_FRAME_BYTES`, has no `std::process::Command`, no shell, no arbitrary path or URL handler,
  and never spawns Core. Specifically:
  - `core_request_frame` is `async` and runs the socket exchange on a blocking worker
    (`spawn_blocking`) over **one connection per request**, so the main thread never waits on
    Core and no request queues behind another on a lock.
  - A frame must be exactly one line (CR/LF only as the single trailing newline), and the bytes
    written are the bytes validated — never a re-serialization. The answer must carry the
    request's own `id`; anything else is dropped (`RESPONSE_ID_MISMATCH`).
  - One per-method deadline covers connect, write, read and the single retry (after a 150 ms
    pause) a read-only method may get after a FAST failure (socket missing/refused, write broke,
    Core closed before answering); a timeout is never retried. Budgets: `sandbox.create` 320 s,
    `sandbox.list` 40 s, `sandbox.stop` 350 s, `sandbox.remove` 390 s, everything else 12 s —
    each below the webview's own deadline for the same method (330 s / 45 s / 360 s / 400 s /
    15 s), drift-tested per method, so the webview always hears the proxy's verdict. Neither
    `sandbox.stop` nor either step of `sandbox.remove` is replay-safe, so neither is ever re-sent.
  - A lost answer to a state-changing method — including a write that broke part-way, since
    Core handles a final unterminated line at EOF — comes back with `mayHaveBeenApplied: true`,
    and the UI says "may have been applied — re-read state" instead of offering a blind retry.
    Core's own connection-level refusal (empty-id `err` frame, e.g. peer-uid mismatch) is
    reported as `CORE_REFUSED_CONNECTION`, not applied.
  - When Core attaches `details.hint` / `details.provider` to an error, the error panel shows
    one sanitized line ("Core suggests: `sbx login`; run it yourself") — Sandpane never runs it.
  - Before connecting it `lstat`s the socket and refuses (`SOCKET_UNTRUSTED`) anything that is not
    a socket owned by the current user with no group/other permission bits.
  - `capabilities/default.json` grants the main window only `allow-core-request-frame` (app
    commands are ACL-gated through `tauri_build::AppManifest`); no `core:*` plugin permission is
    granted. `core_socket_status` is registered but not granted, since no view calls it yet.
- **State ownership stays in Core.** Task rows come from `task.list` and durable
  `task.subscribe` replay; both are Core's own values, displayed verbatim and labelled with
  which read produced them. When Core's two reads disagree the row shows both — the client
  computes no lifecycle transitions and never renders `running`/`resumed` it did not receive
  (AGENTS rule 3). React Query owns reads/writes (including paged `conversation.history`, as
  an infinite query keyed per conversation); the event stream lives in `TaskEventStore` with a
  coalescing window driven live by the Settings preference (16–500 ms, default 80 ms) and an
  immediate flush for terminal/attention events; `src/stores/ui.ts` holds presentation-only
  preferences. Destructive-action confirmation is mandatory and is not a preference.
- **Core has no push frame yet**, so liveness is a replaying `task.subscribe` poll with
  **per-task cursors** (`afterSequences`), exponential backoff on failure, gap reporting, and a
  `resume()` path that re-uses the held cursors — which is how a UI restart or a reconnect
  catches up without duplicating or skipping events.

### Cursor rules the client implements (from `TaskSubscribeParams`)

| Request | Wire cursor actually sent | Replay behaviour |
| --- | --- | --- |
| `taskId` present | scalar `afterSequence` only | that one task; a map would be ignored by Core, so none is put on the wire |
| scope-wide, checkpoints held | `afterSequences` map | each named task from **its own** cursor; a task absent from the map replays in full (0) |
| scope-wide, nothing held yet | shared scalar | the legacy behaviour, unchanged |

Cursor maps are bounded to `MAX_SUBSCRIBE_CURSORS` (4096); when more are held, the **oldest**
are dropped, so the safe direction (a full replay that re-drops an idempotent checkpoint) is the
one that happens, and the drop count is exposed rather than hidden.

### Information architecture (docs/specs/01 §6, docs/specs/05 §1–2)

| Route | View | Data source today |
| --- | --- | --- |
| `#/` | Dashboard | `system.probe`, `project.list`, event replay, `task.list` when advertised |
| `#/projects` | Projects | `project.list` (incl. `repositories`), `project.create` |
| `#/projects/:id`, `#/projects/:id/conversations/:cid` | ProjectWorkspace | `conversation.list` (Core's chats, not just this window's), `conversation.history`, sandbox picker + chat + activity timeline + review |
| `#/chats` | Chats | `conversation.list` when advertised (cross-client chats reopen here); falls back to this window's list and says so |
| `#/tasks`, `#/tasks/:id` | Tasks & Review | `task.list` + event replay, `task.cancel`, `git.review`, `git.apply`; the review's live-writable disclosure comes from the task's own sandbox (`sandboxName` → `sandbox.list` mode), unknown = UNVERIFIED |
| `#/sandboxes`, `#/sandboxes/new` | Sandboxes + wizard | `sandbox.list` (incl. `workspaceMode`, `agent`), `sandbox.create` (incl. the optional sbx `agent`, default `shell`), `sandbox.stop` and two-step `sandbox.remove` when advertised (both behind confirmations); Start is shown as unsupported (sbx v0.47 has no `start`) |
| `#/agents` | Agents | `system.probe` `agents[]` |
| `#/templates` | Templates | read-only unsupported state (no template RPC) |
| `#/integrations` | Integrations | guidance for editors/native apps/SSH/MCP/policies |
| `#/settings` | Settings | Core-reported runtime incl. the advertised method list + local UI preferences |

A hash router (no routing dependency) drives this; an unmatched hash renders an explicit
"no such view" screen rather than silently falling back to the dashboard.

### Honest states

Every view renders from the injected `CoreClient`, and the offline/missing path is a first
class state (`docs/specs/05 §5`): `attaching`, `attached`, `version_mismatch`, `unreachable`
(carried data is only ever labelled **stale**), plus `transport_unavailable` outside the
Tauri shell. SBX readiness distinguishes `not_installed`, `daemon_down`,
`installed_daemon_unknown` and `ready` — the scaffold Core locates the binary but does not
probe version/daemon, so it maps to `installed_daemon_unknown`, never a green "ready".

Two disclosures are deliberate safety choices rather than cosmetics:

- **Workspace mode.** `sandbox.list` now returns the mode Core recorded. An **absent** mode
  renders as `Workspace mode UNVERIFIED` and is treated as **live-writable** — the unsafe
  reading — because `direct_mount` writes the host tree immediately and a blank would silently
  promise isolation the app cannot verify.
- **Transcript bounds.** `conversation.history` answers an object, and when Core stopped a page
  at its row or byte bound (`truncated`), the transcript panel says the read is not complete and
  offers the next page from `nextSequence`. A partial transcript is never shown as the whole chat.

Design mockups under `docs/design/` are **sample data**: Atlas Demo / Nova Demo / Orbit Demo
names never appear as seeded content in this app.

---

## Layout

```
apps/desktop/
├── index.html                  CSP + single static entry
├── package.json  tsconfig.json  vite.config.ts  vitest.config.ts
├── src/
│   ├── main.tsx  App.tsx         transport decided before first paint
│   ├── app/                      context.tsx (deps), router.ts (hash router)
│   ├── lib/
│   │   ├── protocol.ts           mirror of sandpane-protocol (wire names verbatim)
│   │   ├── guards.ts             pre-flight param validation (mirrors sandpane-service)
│   │   ├── framing.ts            NDJSON codec, bounded at MAX_FRAME_BYTES
│   │   ├── decode.ts             runtime decoders for `ok` payloads (no casts)
│   │   ├── core-client.ts        RPC + correlation + per-task-cursor replay engine
│   │   ├── conversation-store.ts in-memory view of chats this window created
│   │   ├── reducers.ts           pure display/state logic (statuses, link, SBX, review)
│   │   ├── event-store.ts        streamed projections, batched notifications
│   │   ├── wizard.ts             sandbox wizard state machine + validation
│   │   ├── focus.ts              pure dialog focus-trap / confirm rules
│   │   └── hooks.ts              React Query wrappers + useSyncExternalStore hooks
│   ├── transport/                tauri.ts (invoke proxy), unavailable.ts (explicit no-Core)
│   ├── stores/ui.ts              UI-only preferences, persisted locally
│   ├── components/{layout,ui,chat,project,review,sandbox}/
│   ├── features/{dashboard,projects,project,chats,tasks,sandboxes,agents,
│   │              templates,integrations,settings}/
│   └── styles/{tokens,base,motion}.css   Obsidian Atmosphere tokens
├── src-tauri/                    Tauri 2 shell (NOT part of the core/ workspace)
│   ├── Cargo.toml  build.rs  tauri.conf.json  capabilities/default.json
│   ├── icons/                    generated placeholder icons (required by generate_context!)
│   └── src/{main.rs,ipc_client.rs}
└── tests/                        framing, reducers, connection, wizard, core-client, guards,
                                  replay cursors, protocol drift, proxy contract,
                                  review-fix regressions (A5–A12), live Core (opt-in)
```

`src-tauri/Cargo.toml` depends on `sandpane-protocol` by path (`../../../core/crates/…`) so the
allowlist the proxy enforces cannot drift from Core's `Method::parse`, while keeping its own
lockfile. That path was previously `../../core/…`, which resolved to the non-existent
`apps/core/crates/sandpane-protocol`; dependency resolution failed and the crate had never been
compiled. The crate is now compiled, linted and tested by `make desktop-check` (32 Rust tests), so
a non-compiling shell can no longer hide behind a green `make check`.

---

## Deferred

- **DT1 polish:** virtualized chat lists (bounded rendering + explicit "show earlier" is in
  place), native folder picker, OS notifications, command palette. Chat history is no longer
  blocked on Core — `conversation.list`/`conversation.history` exist and are wired; what remains
  is archive/export/search, for which no method exists.
- **DT2:** stop and remove with confirmations are implemented (A1; see "A1 sandbox lifecycle"
  under Verification). Start stays unsupported because sbx v0.47 has no `start` command. Still
  deferred: capability-gated advanced wizard options, and project↔sandbox binding beyond
  `sandbox.create`.
- **DT3:** read-only per-file diff text is implemented (A5 `git.diff`; see "A5 git.diff" under
  Verification). Still deferred: a side-by-side viewer, selective apply UX, verification
  history, "open in IDE", approval responses (no approval RPC exists).
- **DT4:** network policy, port publishing (loopback by default), templates, MCP, secret
  presence, redacted diagnostics export, native-app/SSH wizard.
- **DT5:** multi-window consistency, signing/notarization, installer paths per OS,
  accessibility/performance benchmarking with recorded hardware, real brand iconography.
- **Tailwind + shadcn/ui** (design spec §17) is deliberately deferred: functionality first,
  then the visual pass. This scaffold implements the same semantic tokens as CSS variables.
