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
| Typed wrappers for exactly the 14 Core methods | **functional** | `test/commands.test.ts` (22) + live: all 14 exercised against the real service |
| Read-only enumeration + bounded transcript (`task.list`, `conversation.list`, `conversation.history`) | **functional** | live: project scoping, status filter, `truncated`/`nextSequence` paging against real rows |
| Feature discovery from `system.probe` → `methods` (additive methods are detected, never assumed) | **functional** | `test/protocolWire.test.ts` (13) + live: Core advertises 14 and it equals `schemas/rpc-request.schema.json` |
| TS protocol types mirrored from Rust (`camelCase` payloads, `snake_case` statuses/modes, `SCREAMING_SNAKE` codes) | **functional + drift-guarded** | `test/protocolWire.test.ts` reads `core/crates/sandpane-protocol/src/lib.rs`, `sandpane-service/src/lib.rs` and `schemas/*.json` and fails on a rename |
| Display-only task reducer (no invented transitions), incl. `task.list` hydration | **functional** | `test/reducer.test.ts` (20) + live: `cancelled` appears only because Core appended it; double cancel → `CONFLICT` |
| Context attachments: selection/active file/diagnostics, explicit list before send, secret exclusion | **functional (planner)** — Core v1 accepts the references but does **not** store or forward them (verified in `sandpane-service` `conversation_send`); the UI says so next to every list | `test/context.test.ts` |
| Send check: a send must quote the id of the CURRENT attachment list, built for the same intent (read-only vs writable); checked in the extension host, so stale or wrong-intent lists are rejected. One send at a time (Send disabled while one is in flight) | **functional** | `test/sessionPolicy.test.ts`, `test/session.test.ts`, `test/sidebarApp.test.ts` |
| Diff review: `vscode.diff` with real `Uri` objects (`Uri.file`, and `.with({scheme:'git', query:{path,ref}})` for the base revision) from a real ChangeSet; the base must be a plain 7–64 hex commit id or the diff is refused; at most 10 editors per Review, the rest reported | **functional (builder + wiring)** | `test/diff.test.ts`, `test/session.test.ts` (paths with `#`/`?`) — resolution by the installed `vscode.git` inside a real window is **not yet verified**, see Pending |
| Workspace-mode labels incl. prominent `direct_mount` LIVE-WRITABLE, and UNVERIFIED when Core reports no binding row | **functional** | `test/vscodeGuards.test.ts` (14) — `SandboxSummary.workspaceMode` absent ⇒ never rendered as safe |
| Error-code → install/help guidance (`NOT_INSTALLED`, `DAEMON_DOWN`, …) incl. the oversized-replay refusal as recoverable, plus Core's `details.hint` remediation shown verbatim (never executed) | **functional** | `test/diagnostics.test.ts`, `test/coreRemediation.test.ts`, `test/session.test.ts` + live: `task.subscribe` over the frame ceiling ⇒ structured `VALIDATION_FAILED` |
| Remote-host gate (`env.remoteName`) → explicit unsupported state | **functional** | `test/vscodeGuards.test.ts` |
| Webview CSP (nonce, `default-src 'none'`, no inline script/style, escaping) | **functional** | `test/webview.test.ts` (8) |
| Sidebar webview (plain TypeScript): composer built once and never replaced (draft, writable checkbox and focus survive every state push), regions patched in place, pushes coalesced per animation frame, stable ids on task buttons | **functional (headless)** | `test/sidebarApp.test.ts` runs the real `app.ts` (transpiled, `node:vm`) against a minimal fake DOM — no jsdom dependency |
| Task tree, status bar, 9 commands, the sidebar inside VS Code | **wired, needs a human-in-the-loop run** | compiles; never launched inside a real VS Code window yet |

### Live integration against a real Core

`scripts/live-core-check.mjs` runs the compiled client against the actual
`sandpane-service` binary over its Unix socket (temp socket + temp DB, nothing
mocked). Latest run on this host (2026-10-09, after the review-fix revision and
the Core error-code update) — **56/56 checks passed**, including:

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
are typescript, @types/vscode, @types/node, vitest and @vscode/vsce.

**Unit tests need no extension host.** Everything under `src/core-client/`,
`src/state/*` and the pure halves of `src/vscode/*` and `src/webview/html.ts`/
`bridge.ts` import no `vscode`, so they run under plain Node with an injected
fake duplex. `src/session.ts` is exercised through `test/helpers/vscodeStub.ts`
(aliased as `vscode` in `vitest.config.ts`) against a scripted fake Core, and
`src/webview/app.ts` through `test/helpers/fakeDom.ts`.

## Module layout

```
src/
├── extension.ts              activate/deactivate: 9 commands (progress-wrapped),
│                             status bar, webview + tree registration
├── session.ts                the one controller: Core client + state fan-out to
│                             sidebar / tree / status bar
├── core-client/
│   ├── protocol.ts           frames + payloads mirrored from Rust (camelCase)
│   ├── events.ts             AgentEvent / TaskEvent / TaskStatus / ErrorCode
│   ├── connection.ts         NDJSON codec, id correlation, timeouts, backoff
│   ├── transport.ts          the real node:net socket transport (injected seam)
│   ├── commands.ts           typed wrappers for exactly 14 methods + guards
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
  14-name allowlist at runtime; the wire has no exec method, and Core answers
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
- **DEFERRED: start/stop/delete sandbox.** There is no `sandbox.start` /
  `sandbox.stop` / `sandbox.delete` method in protocol v1 (14 methods total, and
  none of them is sandbox lifecycle beyond create/list), and
  inventing one client-side is forbidden. Requires a Core protocol change plus a
  verified SBX adapter path (`docs/specs/07` P1/P8). Sandboxes can currently only
  be listed and created. `sbx` 0.47.0 is now installed on this host and
  `sandbox.list` answers live (see the run above); `sandbox.create` (real
  `sbx create`, up to 300 s in Core — the client waits 330 s for that one
  method) has not been exercised from this extension.

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
  TypeScript sidebar (`src/webview/app.ts`, compiled with `module: none` so no
  bundler is needed) because the component tree is only worth building once the
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
- **DEFERRED: repository root for diffs.** `git.review` returns
  `baseCommit` + per-file paths but **no repository path**, so the client asks the
  user to confirm the workspace folder as the root. Needs a protocol field
  (P4).
- **DEFERRED: renamed files.** `FileChange` carries a single `path`; without the
  rename source a diff would compare the wrong file, so renamed entries are
  refused with a reason.
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
| 6 | stop sandbox with active tasks warns | **PENDING** — no `sandbox.stop` method in v1 |
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
