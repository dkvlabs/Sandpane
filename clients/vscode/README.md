# Sandpane — VS Code extension (`clients/vscode`)

The VS Code attachment for a **Sandpane Core** service: Activity Bar sidebar,
sandbox picker, chat shell, task tree, Git-safe review — all driven through the
typed Core client over its Unix socket. The product surface is the graphical
sidebar; a terminal is never the interaction surface.

**Stage: P3 scaffold (VS0 wiring + probe, with honest seams for VS1/VS2/P4).**
Everything below states plainly what runs, what is wired-but-gated, and what is
not implemented. Nothing here pretends to be a capability it does not have.

---

## What is functional today (with evidence)

| Area | Status | Evidence |
|---|---|---|
| NDJSON framing (encode/parse, `MAX_FRAME_BYTES` guard, chunk reassembly, resync) | **functional** | `test/framing.test.ts` (10 tests) + live: oversized line answered by Core with `VALIDATION_FAILED "frame too large"` |
| Request/response correlation by `id`, timeout, structured `err` envelope | **functional** | `test/connection.test.ts` (12) + live: 25 concurrent requests each returned to their own promise |
| Reconnect with exponential backoff + jitter, resubscribe hook | **functional** | `test/connection.test.ts` (delays 188/375/750 while failing; reset after a healthy drop) |
| Durable-event catch-up from a checkpoint (`task.subscribe`, per-task `afterSequences`) | **functional** | `test/catchup.test.ts` + live: a shared scalar is shown to skip the behind task's unseen events, and `afterSequences` recovers them |
| Live updates: `task.subscribe` re-pulled every 2 s while the connection is online and some task of the selected project is non-terminal (Core never pushes); scoped to the selected project and rebuilt when it changes, and a late answer for a previous project is discarded; a refused project-wide replay falls back to task-scoped pulls (at most 64 tasks — unfinished first, then most recently active — omission reported) | **functional (headless)** | `test/eventFeed.test.ts`, `test/session.test.ts` |
| Core socket trust check: before every connect the socket path is `lstat`ed and must be a Unix socket (not a symlink) owned by the current uid with no group/other bits; otherwise the client refuses with guidance | **functional** | `test/transport.test.ts` (real sockets: 0666, foreign uid, symlink, regular file, stale socket). Live: the 2026-10-09 `scripts/live-core-check.mjs` run (56/56) attached through this check to the 0600 socket `sandpane-service` created — that shows real Core's socket is ACCEPTED; refusals are proven only by the unit tests |
| Typed wrappers for exactly the 28 Core methods (`sandbox.remove`, `project.delete` and `conversation.delete` each have two wrappers, one per confirmation step) | **functional** | `test/commands.test.ts`, `test/sandboxLifecycle.test.ts`, `test/projectLifecycle.test.ts` + live (2026-10-09, pre-A1): the 14 earlier methods exercised against the real service. `sandbox.stop` / `sandbox.remove` are **not** called by the live check (they would drive the real `sbx`) — UNVERIFIED live; the six A3a methods have **not** been exercised against a real Core by this client (UNVERIFIED live) |
| A1 sandbox lifecycle: Stop / Remove / Start commands. Stop and Remove are gated on the `system.probe` advertisement (not advertised ⇒ visible refusal, no frame). Remove is the two-step server-side confirmation: step 1 shows a native modal with the target name + sbx id, every `impact` line (max 20 × 200 chars, rest counted), the expiry and — when `external` — `NOT CONFIRMED AS CREATED BY SANDPANE` first ("Core cannot confirm Sandpane created this sandbox (no Sandpane binding is recorded for this sbx id)."; `external` also covers pre-A1 bindings without an id and bindings for an earlier same-named sandbox, so the copy never claims who created it); a confirmation whose expiry has passed at click time, or cannot be read, is never sent; only the "Remove sandbox" button sends step 2 with the step-1 token; cancel sends nothing. Stop with no `requeried` is shown as UNKNOWN, never "stopped". Stop/Remove address sandboxes by Core's `Validator::sandbox_name` rule (uppercase and `.` allowed, so sbx-named sandboxes such as `Atlas.Demo` are reachable; pinned against the Rust source), while New Sandbox keeps the stricter create rule. Start is visibly unsupported (sbx v0.47 has no start). Create offers an agent choice (default provider-free `shell`, sent as an absent field; others labeled "agent not verified") only when Core advertises the `sandbox-create-agent` feature (A2; previously inferred from `sandbox.remove`) | **functional (headless)** | `test/sandboxLifecycle.test.ts`, `test/session.test.ts` — never run inside a real VS Code window or against a real `sbx` from this extension |
| A2 idempotency keys: `system.probe` `features` are read absent-tolerantly (unknown strings ignored). Only when Core advertises `idempotency-keys`, each New Sandbox and each conversation send (command palette and sidebar composer alike) carries one fresh key — 32 lowercase hex from `crypto.randomBytes(16)`, never derived from content; an older Core gets no key. When a keyed create/send ends with an UNKNOWN outcome (client timeout, connection lost or write failed after the request was handed over, or Core `INTERNAL`), the error notification offers **"Retry safely"**, which resends the identical params with the SAME key — only on that click, never automatically; without the feature no retry is offered and the copy says to check before trying again. A response with `replayed: true` shows "Core returned the result of your earlier identical request (replayed). It may be out of date; refreshing from Core." and re-reads `sandbox.list` / `task.list` instead of painting the replayed state. Core's keyed CONFLICTs are matched by exact prefix (drift-tested against `sandpane-service`): key reused with different params / still in progress / A1 name lock ⇒ "Nothing was run"; earlier outcome unknown ⇒ "Outcome unknown … Re-read state first; a retry needs a new request" (never "nothing was run"), followed by a re-read; Core's own message is always shown sanitized and capped. Keys are kept 24 h by Core; the retry copy says so | **functional (headless)** | `test/idempotency.test.ts` (9), `test/session.test.ts` (A2 block, 11), `test/protocolWire.test.ts` (features vs Rust `FEATURES` + schema examples, CONFLICT strings vs Rust, key rule vs `Validator::idempotency_key`) — never run against a real `sbx`, never inside a real VS Code window; the live check only asserts the advertisement |
| A3a project lifecycle: 8 commands — Rename Project, Edit Project Description, Archive Project, Unarchive Project, Show / Hide Archived Projects, Add Repository to Project, Remove Repository from Project, Delete Project — each gated on a fresh `system.probe` advertisement BEFORE any picker (not advertised ⇒ visible refusal, no frame) and re-checked when it runs. The project picker re-reads `project.list {includeArchived:true}` and labels archived projects `ARCHIVED`; on an archived project every edit (rename, description, add/remove repository) is refused right after the pick — before any name, folder or repository is asked for — with Core's own reason (`project is archived; unarchive it first; nothing was changed`) and nothing is sent; only Unarchive and Delete apply. Archiving the selected project while archived projects are hidden deselects it (never left as an unlabeled, seemingly usable header). Names are validated with Core's exact `Validator::project_name` rule (1–120 chars, no control char incl. newline/tab, no line/paragraph separator or bidi control, not trimmed) — also for New Project; descriptions with `Validator::project_description` (≤ 2000 chars, `\n` the only control, empty clears). The description is edited in an untitled plain-text editor (the input box is single-line); nothing is sent until "Save as description", CRLF is sent as LF. Add Repository uses the native folder picker (local `file:` folders only); Remove Repository picks from Core's registered list and only unregisters (the folder is not touched). Show archived is a per-workspace UI preference and sends `includeArchived:true` only when on; the header shows `name · ARCHIVED`. Delete uses the A1 two-step pattern: step 1 `{projectId}` → native modal with name + id, impact (max 20 × 200, rest counted), expiry and what is not touched; the step-1 answer must be for that project id and action; expiry is re-checked at click (expired/unreadable ⇒ nothing sent); only "Delete project" sends step 2 with the token (never shown or logged); Cancel sends nothing; never retried. After a delete the project, its conversation and the selection are dropped from client UI state. Core's exact refusals (unfinished tasks, sandboxes, create in flight, repository in use, token rejected, not found …) get plain copy that keeps Core's "nothing was …" (drift-tested against `project_lifecycle.rs` / `confirm.rs`); no answer / `INTERNAL` ⇒ "Outcome UNKNOWN" (never "nothing was …"), then `project.list {includeArchived:true}` is re-read and, for delete, the client says what Core lists as of that re-read — "it was not deleted" only when Core answered the request (e.g. `INTERNAL`); after a timeout or closed connection it says the request may still finish, and if the re-read fails the outcome stays UNKNOWN. A step-2 `NOT_FOUND` ("project not found", e.g. deleted from another window) drops the project from UI state like a confirmed delete. `project.add_repository` and `project.create` use a 45 s client deadline (Core's git top-level check may take up to 30 s, `RunLimits::QUERY`; a create with several slow repositories can still exceed it and is then UNKNOWN); the others keep 15 s. Every mutation re-reads `project.list` | **functional (headless)** | `test/projectLifecycle.test.ts` (frames, validator corpus + drift vs `validation.rs`, message drift + copy, delete view), `test/session.test.ts` (A3a block), `test/protocolWire.test.ts` (now 27 methods, A3a wire fields), `test/manifest.test.ts` (20 commands registered = contributed) — **UNVERIFIED**: never run against a real A3a Core by this client and never inside a real VS Code window (pickers, untitled-editor description flow, folder dialog and modal are wired but not human-tested). VS Code's modal API cannot make Cancel the default button; Escape and the built-in Cancel both send nothing |
| A3b conversation lifecycle (sidebar chat surface): the sidebar lists Core's conversations for the selected project (`conversation.list`); a **Show archived** toggle sends `includeArchived:true` only when on AND Core advertises `conversation.archive` (per-workspace UI preference); archived rows are labeled `ARCHIVED`. Per row: open (select; **New conversation** clears the selection), Rename, Archive / Unarchive, Export, Delete — every action gated on a fresh `system.probe` advertisement (not advertised ⇒ the button is disabled with the reason and the action is refused visibly, no frame); ids posted by the webview must be ones Core listed. **Archived conversation:** Send and Rename are disabled with Core's own reason (`conversation is archived; unarchive it first; nothing was changed`), the history stays shown, and the extension refuses a send locally too; **archived project** (checked first, Core's order): Send, Rename and Unarchive are disabled with A3a's project message; Archive, Export and Delete stay available. Rename uses the native input box whose validator mirrors `Validator::conversation_title` exactly (1–200 chars, no control char incl. newline/tab, no separator/bidi control, not trimmed) plus the whitespace-only refusal with **Rust's** White_Space set (a lone U+FEFF is accepted, as Core does); a stored title Core would now refuse is never prefilled. New conversations get a Core-valid title derived from the first message (one line, cut by code point, blank → Core's "Untitled conversation"), and `sandboxId` is validated with Core's addressable sandbox-name rule. Delete uses the A1 two-step pattern: step 1 `{conversationId}` → native modal with title + id, impact (max 20 × 200, rest counted), expiry and what is not touched; the step-1 answer must be for that id and action (a rename in between is fine — Core binds by id); expiry re-checked at click time (expired/unreadable ⇒ nothing sent); only "Delete conversation" sends step 2 (token never shown, logged or persisted); never retried. After a delete (or step-2 `NOT_FOUND`, or an unknown outcome after which Core's archived-inclusive re-read no longer lists it) the row, the selection, its stored preference and the deleted tasks' display are dropped. No answer / `INTERNAL` ⇒ "Outcome UNKNOWN", then `conversation.list {projectId, limit:500, includeArchived:true}` is re-read: "not deleted" only when Core answered the request; absence from a FULL page keeps it UNKNOWN; when Core does not advertise `conversation.archive` the re-read is live-only, so absence keeps it UNKNOWN and nothing is forgotten locally; otherwise absence is reported as "Core no longer lists this conversation; the outcome of this request was not confirmed." and the conversation is dropped from UI state. Delete and Export are single-flight: a second one while one runs is refused visibly and sends nothing. **Export:** pages from `afterSequence: 0` until `truncated` is false; a `nextSequence` that does not strictly increase, or the 200-page cap, stops it as PARTIAL (`complete:false`, disclosed); every page is shape-checked and ANY page failure writes no file (and no dialog is shown). One JSON document `{format, exportedAt, conversation, messages, redaction (summed replacements + byKind), complete, note}` is saved through `window.showSaveDialog` (default `<redacted-title>-export.json` built from Core's REDACTED title, JSON filter) and `workspace.fs.writeFile` to exactly the chosen URI; cancel writes nothing; the content is never logged. "Redaction is best-effort; review the export before sharing it." is shown before (status line, dialog title) and after (with the replacement count). "Sandbox chosen at creation: NAME" (plus "not in the current sandbox list" when absent from `sandbox.list`, or "the sandbox list could not be read" when `sandbox.list` failed; "no sandbox recorded at creation" when none is stored) is shown only when Core advertises `conversation-sandbox-id`, and is never used as a binding. Core's exact A3b messages get plain copy that keeps Core's "nothing was …" (drift-tested against `conversation_lifecycle.rs` / `confirm.rs`). A send to an archived conversation is now Core's `VALIDATION_FAILED` (was `NOT_FOUND` before A3b); the client maps it and re-reads the list | **functional (headless)** | `test/conversationLifecycle.test.ts` (59 cases: frames, deadlines, validator corpus + drift vs `validation.rs` / `conversation_lifecycle.rs`, message drift + copy, delete view, export collector, file name, labels, derived title), `test/session.test.ts` (A3b block, 30), `test/sidebarApp.test.ts` (A3b block, 5), `test/webview.test.ts` (message parsing), `test/protocolWire.test.ts` (27 methods incl. the A3b slice, A3b wire fields, features) — **UNVERIFIED**: never run against a real A3b Core by this client (the live script pins the 27 methods and the A3b advertisement but was not re-run and does not exercise the A3b calls) and never inside a real VS Code window (the conversation list, input box, modal and `showSaveDialog`/`workspace.fs.writeFile` flow are wired and unit-tested against a recording stub, not human-tested). VS Code's modal API cannot make Cancel the default button; Escape and the built-in Cancel both send nothing |
| A4 `conversation.send` mode: the sidebar composer has a **Task / Discuss** choice (`<select>`, built once, Task by default, **not remembered** — it is DOM state of the open webview only, nothing is stored). It is enabled only while Core advertises `conversation-send-mode`; otherwise it is disabled at Task with "not supported by this Core". Task (and every command-palette send) sends **no** `mode` key, so frames stay identical to A2/A3b; Discuss sends `"mode":"discuss"`. A Discuss send re-probes Core first (attaching if needed) and is refused visibly — before any conversation is created — when the connected Core does not advertise the feature (a pre-A4 Core would drop `mode` and record a task); it is never downgraded to Task. Discuss clears and locks the writable intent (the extension also refuses Discuss + writable): a discussion never asks for a writable workspace. "Retry safely" resends the identical params including `mode`, and is refused (nothing sent, `mode` never stripped) when the click-time re-probe no longer advertises the feature. The composer note says what Core records and nothing more: neither mode runs an agent in this build (both stay queued, `PERMISSION_DENIED` / `adapter.unavailable`), and Discuss is not a sandbox, not a dry run and not safe execution. Task rows (sidebar chips, Tasks tree description + tooltip) show `Send mode: <value>` — an open string, so an unknown value such as `plan` is shown as-is — and `sandbox chosen by its chat — not where it runs: <name>`, both revealed and capped (64 / 128); a non-string value is shown as "(unreadable value from Core — not shown)", never echoed. A `null` mode is treated as absent, as Core does. `chosenSandboxName` never feeds the stop-dialog task count, isolation/workspace labels or scope logic; the stop copy stays "cannot be checked" because `sandboxName` (the binding) is still never filled. Core's `VALIDATION_FAILED` `mode must be "task" or "discuss"` gets plain copy (drift-tested against the raw string in `sandpane-service`); `sandbox.remove`'s new impact line ("N unfinished task(s) were sent from chats that chose this sandbox name; removing it does not cancel them") is shown in the existing modal | **functional (headless)** | `test/sendMode.test.ts` (wire frames, local refusal of any other value, drift: feature, `SendMode::as_str` values, raw-string message, Rust/TS struct fields; open-string display, reveal + caps, labels, honest copy, webview message parse, app.ts copy mirrors), `test/session.test.ts` (A4 block, 13: frames advertised / not advertised, send-time re-probe, a re-check right before the send (a reconnect between re-probe and send refuses, never downgrades), Discuss + writable, keyed retry identical incl. `mode`, retry gate, refusal copy, snapshot rows incl. a non-string mode, stop count ignores `chosenSandboxName`, both remove impact-line variants), `test/sidebarApp.test.ts` (A4 block, 6), `test/protocolWire.test.ts` + `test/idempotency.test.ts` (4 known features = Rust `FEATURES` = schema examples) — **UNVERIFIED**: never run against a real A4 Core by this client (the live script checks that the 4 features are advertised but was not re-run) and never inside a real VS Code window (the `<select>`, its note and the chips are tested in the fake-DOM harness only) |
| A5 `git.diff` + ChangeSet fields: **Sandpane: Show Task Patch (read-only, git.diff)** and a per-task **Diff** button in the sidebar (disabled with "not supported by this Core" unless `git.diff` is advertised; the action re-probes and refuses visibly, sending no frame, when it is not). Flow: `git.review` → a quick pick of every entry Core returned (paths revealed on one line, renames as `oldPath → path`, status shown) → `git.diff {taskId, path, status}` with the entry's `path` passed **byte-exact** (no trimming, normalizing or validation — Core gates it) and its `status` always sent (a path listed twice stays unambiguous); `maxBytes` is omitted (Core default 262 144; the wrapper clamps any value to Core's 1..=524 288). `git.review` and `git.diff` use the 45 s git deadline (`RunLimits::QUERY` is 30 s per git run). The answer is shape-checked (a malformed one is reported without echoing it) and shown in a **read-only virtual document** (`sandpane-diff:` scheme, `diff` language, in-memory store of the last 20; no temp file, nothing written to the workspace, never applied or run, patch content never logged). The document header discloses: path from JSON (never parsed from the patch header), status, short base blob, `symlink → target` for a mode-120000 untracked patch (the link text, not the target's content), "treated as binary (possibly by repository attributes) — no text diff shown" (never "no changes"), "diff truncated at N bytes — the last hunk header may promise more lines than are shown", "contains bytes that are not valid UTF-8; shown with replacement characters", and how many lines had hidden/bidi/control characters (escaped as `\uXXXX`; tabs kept; CRLF endings shown as `\r` and counted separately). Core's exact refusals (no Git context, worktree removed, work tree redirected, path not in list, path listed twice, non-UTF-8 path, untracked file changed / not a regular file, submodules, task not found) get honest copy that says nothing was read; a timeout says "Core did not answer in time — no file was changed (git.diff is read-only)". Review and Apply surfaces now reveal exact paths (a real newline cannot pose as a new row), show `repository (from Core): <repoPath>`, and say "N paths were not inspected — this change list is NOT complete" if `uninspected` is ever non-empty; the native review diffs renames via `oldPath` and prefers the folder matching Core's `repoPath` | **functional (headless)** | `test/gitDiff.test.ts` (wire frames incl. a path with tab, quote, newline and non-ASCII; status always sent; maxBytes clamp; 45 s deadlines; drift: maxBytes bounds, `RunLimits::QUERY`, every exact message, Rust/TS struct fields; decode; document disclosures, reveal, symlink, names from JSON; labels/notes; error copy; store), `test/session.test.ts` (A5 blocks, 11), `test/diff.test.ts` (rename via `oldPath`, exact tab/newline path join), `test/sidebarApp.test.ts` (Diff button, 2), `test/webview.test.ts`, `test/protocolWire.test.ts` + `test/commands.test.ts` (28 methods, `git.diff` after `git.review`), `test/manifest.test.ts` (21 commands, content-provider wiring) — **UNVERIFIED**: no wire-created task has Git context until A4b, so over the wire `git.diff` can only answer "task has no Git context" (the live script checks that, but was not re-run); the patch view, quick pick and Diff button have never been run inside a real VS Code window |
| Anti-spoofing for Core text in native surfaces: hidden/bidi/control characters shown as `\uXXXX`, notification link syntax `](` broken, lengths capped (mirrors JetBrains `VisibleText`) | **functional** | `test/sandboxLifecycle.test.ts`, `test/session.test.ts` (error box, modal detail) |
| Read-only enumeration + bounded transcript (`task.list`, `conversation.list`, `conversation.history`) | **functional** | live: project scoping, status filter, `truncated`/`nextSequence` paging against real rows |
| Feature discovery from `system.probe` → `methods` (additive methods are detected, never assumed) | **functional** | `test/protocolWire.test.ts` (pinned at 28 methods in `Method::ALL` order and the A2 features incl. the sbx agent allowlist vs the schema) + live (2026-10-09, pre-A1): Core advertised 14 and it equalled `schemas/rpc-request.schema.json`; the live check now pins 28 and has not been re-run by this client change |
| TS protocol types mirrored from Rust (`camelCase` payloads, `snake_case` statuses/modes, `SCREAMING_SNAKE` codes) | **functional + drift-guarded** | `test/protocolWire.test.ts` reads `core/crates/sandpane-protocol/src/lib.rs`, `sandpane-service/src/lib.rs` and `schemas/*.json` and fails on a rename |
| Display-only task reducer (no invented transitions), incl. `task.list` hydration | **functional** | `test/reducer.test.ts` (20) + live: `cancelled` appears only because Core appended it; double cancel → `CONFLICT` |
| Context attachments: selection/active file/diagnostics, explicit list before send, secret exclusion | **functional (planner)** — Core v1 accepts the references but does **not** store or forward them (verified in `sandpane-service` `conversation_send`); the UI says so next to every list | `test/context.test.ts` |
| Send check: a send must quote the id of the CURRENT attachment list, built for the same intent (read-only vs writable); checked in the extension host, so stale or wrong-intent lists are rejected. One send at a time (Send disabled while one is in flight) | **functional** | `test/sessionPolicy.test.ts`, `test/session.test.ts`, `test/sidebarApp.test.ts` |
| Diff review: `vscode.diff` with real `Uri` objects (`Uri.file`, and `.with({scheme:'git', query:{path,ref}})` for the base revision) from a real ChangeSet; the base must be a plain 7–64 hex commit id or the diff is refused; at most 10 editors per Review, the rest reported | **functional (builder + wiring)** | `test/diff.test.ts`, `test/session.test.ts` (paths with `#`/`?`) — resolution by the installed `vscode.git` inside a real window is **not yet verified**, see Pending |
| Workspace-mode labels incl. prominent `direct_mount` LIVE-WRITABLE, and UNVERIFIED when Core reports no binding row | **functional** | `test/vscodeGuards.test.ts` (14) — `SandboxSummary.workspaceMode` absent ⇒ never rendered as safe |
| Error-code → install/help guidance (`NOT_INSTALLED`, `DAEMON_DOWN`, …) incl. the oversized-replay refusal as recoverable, plus Core's `details.hint` remediation shown verbatim (never executed) | **functional** | `test/diagnostics.test.ts`, `test/coreRemediation.test.ts`, `test/session.test.ts` + live: `task.subscribe` over the frame ceiling ⇒ structured `VALIDATION_FAILED` |
| Remote-host gate (`env.remoteName`) → explicit unsupported state | **functional** | `test/vscodeGuards.test.ts` |
| Webview CSP (nonce, `default-src 'none'`, no inline script/style, escaping) | **functional** | `test/webview.test.ts` (8) |
| Sidebar webview (plain TypeScript): composer built once and never replaced (draft, writable checkbox and focus survive every state push), regions patched in place, pushes coalesced per animation frame, stable ids on task buttons | **functional (headless)** | `test/sidebarApp.test.ts` runs the real `app.ts` (compiled once by the real `tsc` with the shipped `tsconfig.webview.json`, run in `node:vm`) against a minimal fake DOM — no jsdom dependency |
| Task tree, status bar, 21 commands, the sidebar inside VS Code | **wired, needs a human-in-the-loop run** | compiles; never launched inside a real VS Code window yet |

### Live integration against a real Core

`scripts/live-core-check.mjs` runs the compiled client against the actual
`sandpane-service` binary over its Unix socket (temp socket + temp DB, nothing
mocked). Latest run on this host (2026-10-09, after the review-fix revision and
the Core error-code update, BEFORE A1 — the script now pins 28 methods and
adds A1/A2/A3a/A3b/A5 advertisement checks, the A4 feature and an A5 `git.diff` "no Git context" check; it has not been re-run since) — **56/56 checks
passed**, including:

```
PASS  system.probe advertises exactly the 14 methods the client allowlists
PASS  Core's advertised list equals schemas/rpc-request.schema.json (no drift)
PASS  the client feature-detects the additive methods from the probe, not a version
PASS  project.list returns the repository paths it was created with
PASS  conversation.history returns an object disclosing truncated + nextSequence
PASS  history returns the stored message verbatim (hostile content stays inert data)
PASS  paging past the last message returns none and keeps the cursor (never rewinds)
PASS  a new message advances nextSequence and pages forward without losing rows
PASS  conversation.list enumerates both live conversations of the project
PASS  conversation.list scoping an unknown project is an empty list, not an error
PASS  a blank projectId is refused client-side before the frame is written
PASS  task.list scopes to the project and filters by Core status
PASS  a status outside Core's closed enum is refused before the request is written
PASS  the two tasks have UNEVEN per-task sequences (5 vs 4) — the shape a shared cursor breaks on
PASS  LEGACY SHAPE: one shared scalar skips every unseen event of the behind task
PASS  afterSequences replays EACH task from its own cursor — unseen events arrive
PASS  a task absent from the map replays IN FULL (cursor 0), exactly as documented
PASS  an over-ceiling replay is refused with structured VALIDATION_FAILED
PASS  the client classifies it as a refusal and maps it to recoverable guidance
PASS  narrowing to one taskId still succeeds — the refusal is recoverable, not fatal
PASS  a bounded read discloses truncation instead of overflowing the frame
PASS  system.probe reports sbx presence coherently (this host: installed)
PASS  project.list returns the CANONICAL repository path (clients must realpath before comparing)
PASS  project.create refuses a monorepo subfolder (git toplevel only)
PASS  sandbox.list returns Core's listing or a structured error (sbx installed)
PASS  hostile multi-line content is stored verbatim as inert data
PASS  adapter.unavailable carries PERMISSION_DENIED (policy: no verified adapter — not a sign-in problem)
PASS  cancellation is durable: status.changed(cancelled) is appended
PASS  git.apply does not write host files (honest abort: P4 deliverable)
PASS  Core rejects an off-allowlist method with VALIDATION_FAILED (no free-form exec)
```

The two cursor rows above are the point of the discovery revision: the harness
reproduces the recorded v1 defect live (a shared `afterSequence` returns nothing
for the behind task) and then shows `afterSequences` recovering exactly that
task's unseen events. The ceiling rows prove the behaviour change on an existing
method: Core refuses an undeliverable replay instead of emitting it, the client
maps it to recoverable guidance, and a narrowed request still works.

Reproduce:

```bash
cd core && cargo build -p sandpane-service          # once, outside this dir
cd ../clients/vscode && npm install && npm run compile
node scripts/live-core-check.mjs                    # or: npm run check:live
```

The harness spawns the **already-built** binary. The extension itself never
launches, upgrades or stops Core — see *Deferred* (ADR 1).

## Build / test

```bash
cd clients/vscode
npm install --no-audit --no-fund   # dev dependencies only — the shipped extension has zero runtime deps
npm run typecheck                  # tsc --noEmit (extension + tests, then the webview script)
npm test                           # vitest run — pure modules, real-socket transport suites, the sidebar
                                   # script in node:vm, and session.ts against a recording vscode stub
npm run compile                    # tsc → out/ (extension) + out/webview/app.js (sidebar script)
npm run check                      # typecheck + test
npm run check:live                 # optional: real Core service integration (see above)
npm run package                    # compile + vsce package → sandpane-<version>.vsix
```

Local installation guide (packaging the `.vsix`, installing it, starting the
Core service it attaches to): [`INSTALL.md`](INSTALL.md). Marketplace
publication is deliberately not done yet (licensing gate,
[`docs/licensing-decision.md`](../../docs/licensing-decision.md)).

No runtime dependencies: Node stdlib + the VS Code API only. `devDependencies`
are typescript, @types/vscode, @types/node, vitest and @vscode/vsce (vite is
pulled in as vitest's required peer).

### Toolchain and compatibility notes

| Package | Pinned | Why this version |
|---|---|---|
| `typescript` | `7.0.2` | Latest. TS 7 removed `moduleResolution: node`/`node10`, `module: none`, `esModuleInterop: false` (always on now) and the classic JS compiler API (the package root now exports only `version`; no `transpileModule`). `tsconfig.json` therefore uses `module: node20` (CommonJS emit, since `package.json` has no `"type"`); `tsconfig.webview.json` uses `module: esnext` + `moduleDetection: legacy`, which emits `app.js` byte-identical to the old `module: none` output (no import/export → classic script). Because `esModuleInterop` is forced on, `out/*.js` now wraps namespace imports (`import * as vscode`) in `__importStar`; no other emit change. |
| `vitest` | `5.0.3` | Latest. Requires Node `^22.12 \|\| ^24 \|\| >=26` for running tests (not for the extension). Its migration guide had no change applicable here; the config moved from `vitest.config.ts` to `vitest.config.mts` only because Vite 8 (vitest's peer) warns that its planned native config loader rejects ESM syntax in a file loaded as CommonJS. The alias uses `fileURLToPath(new URL(…, import.meta.url))` (Vite's pattern, with `fileURLToPath` instead of `.pathname` so a checkout path with spaces works). |
| `@vscode/vsce` | `^4.0.0` | Latest stable (`4.0.0`; `4.0.1-*` are prereleases). Requires Node `>= 22` to package. |
| `@types/vscode` | `1.90.0` (exact) | Must not exceed `engines.vscode` (`^1.90.0`), or typecheck would accept APIs older hosts lack. `1.90.0` is the only published 1.90.x. Pinned exactly so it cannot float to a newer API surface. |
| `@types/node` | `^22.20.5` | VS Code 1.90's Electron bundles Node 20 (per the project's compatibility target; not independently re-verified here), so `20.x` types would match the runtime best — but vitest 5 declares the peer `@types/node ^22.0.0 \|\| >=24.0.0` and npm hard-fails (`ERESOLVE`) with any 20.x. 22.x is the closest version vitest 5 accepts. Consequence: typecheck no longer flags a Node-22-only API. `src/` imports only `node:net`, `node:fs`, `node:fs/promises` and `node:crypto`; keep new Node API use within Node 20 by review, since this is not machine-checked. |

**Unit tests need no extension host.** Everything under `src/core-client/`,
`src/state/*` and the pure halves of `src/vscode/*` and `src/webview/html.ts`/
`bridge.ts` import no `vscode`, so they run under plain Node with an injected
fake duplex. `src/session.ts` is exercised through `test/helpers/vscodeStub.ts`
(aliased as `vscode` in `vitest.config.mts`) against a scripted fake Core, and
`src/webview/app.ts` through `test/helpers/fakeDom.ts`.

## Module layout

```
src/
├── extension.ts              activate/deactivate: 21 commands (progress-wrapped),
│                             status bar, webview + tree registration
├── session.ts                the one controller: Core client + state fan-out to
│                             sidebar / tree / status bar
├── core-client/
│   ├── protocol.ts           frames + payloads mirrored from Rust (camelCase)
│   ├── events.ts             AgentEvent / TaskEvent / TaskStatus / ErrorCode
│   ├── connection.ts         NDJSON codec, id correlation, timeouts, backoff
│   ├── transport.ts          the real node:net socket transport (injected seam)
│   ├── commands.ts           typed wrappers for exactly 28 methods + guards
│   ├── conversationExport.ts A3b export paging loop + the one export document (pure)
│   ├── catchup.ts            EventCheckpoint + pull-based resume (per-task cursors),
│   │                         ProjectEventFeed (polling + task-scoped fallback)
│   ├── socketTrust.ts        socket owner/type/mode verdict before connecting
│   └── paths.ts              socket/data-dir resolution (mirrors sandpane_service)
├── state/reducer.ts          display-only task state over Core statuses
├── state/sessionPolicy.ts    pure session decisions: selected workspace mode,
│                             send gate, send authorization, scope, polling
├── vscode/
│   ├── context.ts            attachment planner (explicit list, secret deny)
│   ├── editor.ts             the thin vscode glue that feeds context.ts
│   ├── diagnostics.ts        ErrorCode / client failure → human guidance
│   ├── diff.ts               pure `vscode.diff` argument builder
│   ├── workspaces.ts         mode labels (direct_mount = LIVE-WRITABLE)
│   ├── host.ts               remote-extension-host gate
│   ├── sandboxActions.ts     A1 stop/remove views, picker rows (pure)
│   ├── projectActions.ts     A3a messages + copy, delete view, picker rows (pure)
│   ├── conversationActions.ts A3b messages + copy, delete view, labels, file name (pure)
│   ├── sendMode.ts           A4 send-mode copy, refusal copy, task-row labels (pure)
│   ├── gitDiff.ts            A5 git.diff messages + copy, patch document, sandpane-diff store (pure)
│   └── taskTree.ts           sandpane.tasks TreeDataProvider
└── webview/
    ├── bridge.ts             message whitelist + state payload types (pure)
    ├── html.ts               CSP document builder (pure, nonce, escaping)
    ├── sidebar.ts            WebviewViewProvider (extension side)
    └── app.ts                sidebar app, plain TypeScript, no bundler
test/                         vitest — pure modules, fake duplex, no vscode runtime
media/                        sandpane.svg (Activity Bar), sidebar.css (theme tokens)
```

## Security properties actually enforced

- **The webview cannot execute anything.** It posts only the whitelisted message
  kinds (`parseWebviewMessage`); unknown kinds are dropped and counted. Every
  accepted kind maps to one typed Core method. No command passthrough, no shell.
- **Strict CSP**: `default-src 'none'`, `script-src 'nonce-…' <cspSource>`,
  styles from a file (no `unsafe-inline`), `connect-src 'none'` (the webview
  cannot reach the socket or the network), per-render nonce, all interpolation
  escaped.
- **No free-form RPC.** `CoreConnection.request` re-checks the method against the
  16-name allowlist at runtime; the wire has no exec method, and Core answers
  `VALIDATION_FAILED` if a client ignores that (verified live). The wrapper
  surface is exactly the allowlist — `test/commands.test.ts` asserts one wrapper
  per advertised method and no extra callable method.
- **Additive methods are detected, not assumed.** `task.list`, `conversation.list`
  and `conversation.history` are feature-detected from `system.probe`'s
  `methods` array; a Core that does not advertise them gets no call, and the gap
  is logged instead of being filled with a client-side fake list.
- **Bounded frames** in both directions: oversized client frames are refused
  before writing; oversized inbound lines are dropped and the stream resyncs.
  A replay that cannot fit one frame comes back from Core as a structured
  `VALIDATION_FAILED`; the project-wide request is never re-sent, and the feed
  switches to task-scoped pulls (one task per request, from each task's own
  cursor) instead of disabling catch-up. A single task that is itself too large
  is reported and skipped.
- **The Core socket is verified before connecting.** Symlinks, non-sockets, a
  foreign owner or any group/other permission bit are refused with guidance.
  `sandpane.coreSocketPath` and `sandpane.attachDiagnostics` are
  `"scope": "machine"`, so a repository's `.vscode/settings.json` cannot point
  the client at another socket or opt you into diagnostics.
- **Sends match the list that was shown.** The extension host only sends when
  the request quotes the id of the CURRENT attachment plan, built for the same
  intent; a stale list or a read-only list sent as writable is refused. This
  prevents UI mistakes, not forgery: the plan id is visible to the webview, so
  script running inside it could post a matching id. The webview's protection
  is the strict CSP and the message whitelist.
- **CSP nonce from a CSPRNG** (`crypto.randomBytes`, rejection-sampled).
- **Context is explicit and deny-by-default**: selection → active file →
  diagnostics (opt-in, writable intent only), every attachment listed before
  send, sensitive paths (`.env`, `id_rsa`, `credentials.json`, `*.key`,
  `.npmrc`, `secrets*`, …) excluded outright rather than redacted,
  per-attachment size cap. Honest limit: Core v1 ignores `attachments`, and
  `conversation.send` has no read-only mode — both intents create a task.
- **Logs are not a secret sink.** The client log channel records transport and
  RPC outcomes; prompt bodies and credentials are never written.
- **Deactivate closes UI hooks only.** `deactivate()` is empty;
  `SandpaneSession.dispose()` stops polling and drops the socket. There is no
  cancellation call anywhere on the detach path — Core keeps running tasks.
- **Remote hosts are refused, not guessed.** With `env.remoteName` set, commands
  explain the unsupported state instead of running local Core logic against
  remote paths.
- **Windows is refused.** Core binds a Unix socket; the named-pipe transport is
  a P1 deliverable, so `unsupportedPlatformReason()` says so rather than trying.

## Deferred / not implemented (stated, not hidden)

### Context actions (specs/03 §4 + §2 manifest)
- **DEFERRED: Explain Selection / Refactor Selection / Fix Current Problems / Add File to Chat / Review Active Task, and `sandpane.sendSelection`** (specs/03:131–135, :82). None are contributed or registered; there is no `editor/context` menu. A selection *reference* is listed and sent via `startTask`'s preview (Core v1 does not store or resolve it), but the dedicated menu entries and their consent UX are P3 work. Named here after review 0006 #6 — previously this gap was invisible in this file.

### VS1 — sandbox management
- **DEFERRED: quick-create wizard.** The manifest, `sandboxCreate` wrapper, name
  validation and the direct-mount confirmation exist; the multi-step wizard UI
  does not. Reason: P3 UI work sequenced after the sidebar's Core round-trip was
  proven.
- **Stop / remove sandbox (A1): implemented, UNVERIFIED live.** `sandbox.stop`
  (client deadline 360 s) and the two-step `sandbox.remove` (400 s per step,
  never retried) are wired to "Sandpane: Stop Sandbox" / "Sandpane: Remove
  Sandbox" and covered headlessly; neither has been run from this extension
  against a real `sbx`. **Start is NOT supported**: sbx v0.47 has no `start`
  command, so "Sandpane: Start Sandbox" only explains that (use
  `sbx run --name <name>` in a terminal) and sends nothing.
  `sandbox.create` (real `sbx create`, up to 300 s in Core — the client waits
  330 s) has not been exercised from this extension either.
- **Long lifecycle calls share the one Core connection.** Core serves this
  window's connection serially, so while a stop or remove runs (up to ~6
  minutes: `sbx stop`/`sbx rm` plus re-query) other calls and event polls on
  the same connection may hit their 15 s client deadline. Those timeouts are
  reported as such and are not retried; refresh once the action finishes.
- **Not in the sidebar yet:** stop/remove/start are command-palette commands
  with a fresh `sandbox.list` picker; the webview's sandbox list has no buttons
  for them and does not show the sbx-reported `agent`.

### VS2 — chat and multi-project
- **DEFERRED (P0 gate): real streaming chat.** Core advertises
  `codex {verified:false, supportsStreaming:false, supportsCancel:false,
  supportsResume:false}` — confirmed live. Sending a prompt therefore creates a
  real queued task and Core appends `adapter.unavailable` with
  `PERMISSION_DENIED` (Core's policy refuses to run an unverified adapter —
  signing in would not help); the sidebar shows exactly that, and the composer
  asks for explicit confirmation before sending. `PROVIDER_AUTH_REQUIRED` now
  means "sign in" (e.g. sbx not signed in to Docker); when Core attaches a
  `details.hint` (`sbx login`, `sbx policy init <allow-all|balanced|deny-all>`)
  the error box and status line show it as text for the user to run — the
  extension never runs it. Chat tabs, streaming repaint
  batching and event replay UI land after the Codex-in-SBX feasibility gate.
- **DEFERRED: React + Tailwind + shadcn/ui webview.** `specs/03 §3` describes
  `App.tsx` + `views/`/`components/`/`dialogs/`. This scaffold ships a plain
  TypeScript sidebar (`src/webview/app.ts`, compiled as a classic script — `module: esnext` +
  `moduleDetection: legacy`, no import/export — so no bundler is needed) because the component tree is only worth building once the
  chat gate defines its real message model. Migration is the VS2 deliverable.
- **NO LONGER DEFERRED: `conversation.list` / `conversation.history` /
  `task.list` — landed and verified live.** The protocol-v1 discovery revision
  added all three, and this client wraps them (`commands.conversationList` /
  `conversationHistory` / `taskList`) behind `system.probe` feature detection.
  The sidebar can now recover real state it previously could only guess at:
  `conversation.list` re-points the restored conversation preference at a record
  Core still has (and drops it if Core does not), `conversation.history` pages a
  bounded transcript disclosing `truncated` + `nextSequence`, and `task.list`
  hydrates the task display with Core's stored statuses.
  What is *still* genuinely pending, stated plainly:
  * **no real execution behind any of it** — the P0 Codex-in-SBX gate has not
    passed, so every task Core reports is `queued` → `adapter.unavailable`; the
    new reads enumerate that state honestly rather than showing work in progress;
  * **in-host VS Code verification** — the multi-project / multi-chat recovery is
    proven headless against the real service, not yet by reopening an actual
    Extension Development Host window;
  * **`conversation.send` answer shape** — it returns a full `TaskSummary` while
    sibling mutating methods return `{requested:true}` or an id envelope. That
    cleanup is a Core protocol decision; this client keeps reading the summary as
    Core's verdict instead of papering over the mismatch;
  * **`ContextRef` selection identifier contract** — `kind:"selection"` still
    carries a client-formatted `target` string with no Core-defined grammar, so
    an attachment's exact range is still not an agreed wire contract (an open
    Core gap, **not** fixed by this revision);
  * **no repository path in `git.review`** (see VS3 below), which is what
    actually blocks reopening a chat against the right folder.
- **DEFERRED: approvals.** `approval.required` is rendered with an explicit
  "this protocol version has no method to answer it" note; there is no approve
  RPC.

### VS3 / P4 — Git-safe coding integration
- **DEFERRED: verified `vscode.diff` resolution.** `buildDiffPlan` produces
  `Uri.file` + git-revision `Uri` specs from Core's real `baseCommit` (the same
  `{path, ref}` query shape `vscode.git`'s own `toGitUri` builds), and the
  session passes real `Uri` objects — unit-tested, including paths with `#`/`?`;
  that the installed `vscode.git` resolves the URI on this host is
  unverified. Claiming it would be an evidence-free verification (`AGENTS.md`
  rule 5).
- **Repository root for diffs (A5).** `git.review` now returns `repoPath`; the
  client prefers the open folder that is that repository and still asks the
  user to confirm it (a pre-A5 Core without `repoPath` gets the old project-match
  fallback and says so). For a `host_worktree` task the native `vscode.diff`
  right side is the HOST working tree, not the task worktree — the A5
  "Show Task Patch" view (Core's own `git.diff`) is the accurate per-file view.
- **Renamed files (A5).** `FileChange.oldPath` is used: base(oldPath) ↔
  working(path); without it (pre-A5 Core) the entry is refused with a reason.
- **DEFERRED: apply.** Verified live: Core runs its real precondition gates and
  answers `applied:false` — for the scaffold task (no repo binding) the
  `abortReason` was
  `apply refused: no Git context for task (ValidationFailed): task has no Git context (repo binding + base_commit)`;
  with a real Git context the service's own message is that merge/patch
  application "is a P4 deliverable". The `applyTask` command surfaces whichever
  reason Core returns, verbatim. No host file is ever written by this client.
- **DEFERRED: verification/test output UI, preview links, port forwarding.** No
  Core method exists yet (`verifications` table is server-side only).

### VS0 leftovers
- **Local `.vsix` packaging works; publication does not exist.** `@vscode/vsce`
  is a devDependency and `npm run package` builds `sandpane-<version>.vsix`
  locally (gitignored, never committed). **DEFERRED: marketplace metadata and
  publication, VS Code integration-test runner, accessibility audit** (VS4
  items); `package.json` stays `private: true` (licensing gate).
- **DEFERRED: service start/stop.** `sandpane.startService` / `stopService`
  explain the ownership-policy gap (ADR 1, `specs/02 §10`) and print the command
  for the user to run. `sandpane.serviceMode` deliberately offers only
  `ask`/`manual` — no `auto`.
- **DEFERRED: settings actually reach Core.** `sandboxDirectory`, `defaultCPUs`,
  `defaultMemory`, `defaultDiskSize`, `maxParallelTasks` are declared as
  documented UI defaults; protocol v1 `SandboxCreateSpec` has no resource fields
  and there is no settings RPC, so they are not transmitted. The descriptions in
  `package.json` say so.
- **DEFERRED: Windows named pipe** (P1) and **push notifications**. This Core
  build is strictly request/response, so live updates come from re-pulling
  `task.subscribe` from the checkpoint every 2 s while a task of the selected
  project is non-terminal (tasks stuck in `queued` because no adapter is
  verified keep that poll alive). Normally that is one project-wide request
  per interval; after Core refuses the project-wide replay as too large, it is
  one request per FOLLOWED task per interval — up to 64 tasks, chosen
  unfinished-first then most recently active, so up to ~32 requests/s in the
  worst case. Tasks outside that set are not followed, and the status line
  says how many. The codec already understands
  method-bearing frames and routes them to a notification seam, but no such frame
  exists yet — it is forward-compat, not a claimed capability.

## Verified vs. pending — `specs/03 §6` integration scenarios

| # | Scenario | Status |
|---|---|---|
| 1 | two projects, three chats, two tasks running while switching tabs | **PENDING** — needs chat (VS2) and a real writable task |
| 2 | reopen VS Code, UI catches up from the Core checkpoint | **PARTIAL** — per-task checkpoint replay verified headless (17 unit cases + live: `afterSequences` recovers the behind task's unseen events, which a shared scalar skips); inside a real window: PENDING |
| 3 | second window shows the same state, no duplicate process | **PARTIAL** — two socket clients on one `instanceId` verified live; two VS Code windows: PENDING |
| 4 | selection with spaces/Unicode/newlines arrives exactly, no shell execution | **PARTIAL** — verified live: a hostile multi-line *message body* is stored verbatim and Core has no exec method (rejects one). NOT verified: the selection itself — the client sends only a `kind:"selection"` reference (no content, no Core-defined range grammar), and Core v1's `conversation_send` ignores `attachments`, so selection content never reaches Core today. Needs Core attachment storage + selection grammar |
| 5 | apply with dirty host files aborts safely | **PARTIAL** — Core's precondition gates abort (verified live for the no-Git-context case); the dirty-host path with a real repo: PENDING |
| 6 | stop sandbox with active tasks warns | **PENDING** — Core does not yet record which sandbox a task uses (`tasks.sandbox_binding_id` is never written; `task.sandboxName` is always absent), so the Stop modal says "Active tasks in this sandbox cannot be checked: Core does not yet record which sandbox a task uses." The counting path exists and is tested against a simulated future Core shape only |
| 7 | omitted Codex adapter shows an unsupported explanation | **VERIFIED** live (Core-level) — `adapter.unavailable` + `PERMISSION_DENIED`, no terminal scraping fallback exists in this client; the sidebar rendering of it inside a real window: PENDING |
| 8 | unsupported remote host does not bind the wrong filesystem | **PARTIAL** — `host.ts` gate is unit-tested and every command checks it; inside a real remote window: PENDING (review 0006 #5: re-labelled from "VERIFIED (logic)" for consistency with rows 2/3/5) |

## Conventions

- `out/` is build output (gitignored). `npm run compile` must pass before
  launching the Extension Development Host (F5 in VS Code with this folder
  opened).
- Protocol changes: update `sandpane-protocol` + `schemas/` + `src/core-client/`
  types together — `test/protocolWire.test.ts` fails on drift. It parses the Rust
  source rather than quoting it: the allowlist is checked against `Method::parse`
  **and** `Method::ALL` (which is what `CoreCapabilities.methods` is derived
  from) **and** `schemas/rpc-request.schema.json`, in order, so a rename or a
  reorder breaks the client build instead of desyncing a shipped extension.
  Bounds are pinned the same way (`DEFAULT_LIST_LIMIT`, `MAX_LIST_LIMIT`,
  `MAX_HISTORY_BYTES`, `MAX_SUBSCRIBE_CURSORS`, `MAX_CURSOR_KEY_LEN`,
  `MAX_SCOPING_ID_LEN` are read out of `sandpane-service`).
- An additive method is called only after `system.probe` advertises it
  (`coreAdvertisesMethod`). Never infer a capability from `protocolVersion`.
- UI preferences live in `workspaceState` (selected project/sandbox/conversation).
  No task/chat persistence in extension storage: Core owns it.
