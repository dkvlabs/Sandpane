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
| Durable-event catch-up from a checkpoint (`task.subscribe`, per-task `afterSequences`) | **functional** | `test/catchup.test.ts` (17) + live: a shared scalar is shown to skip the behind task's unseen events, and `afterSequences` recovers them |
| Typed wrappers for exactly the 14 Core methods | **functional** | `test/commands.test.ts` (22) + live: all 14 exercised against the real service |
| Read-only enumeration + bounded transcript (`task.list`, `conversation.list`, `conversation.history`) | **functional** | live: project scoping, status filter, `truncated`/`nextSequence` paging against real rows |
| Feature discovery from `system.probe` → `methods` (additive methods are detected, never assumed) | **functional** | `test/protocolWire.test.ts` (13) + live: Core advertises 14 and it equals `schemas/rpc-request.schema.json` |
| TS protocol types mirrored from Rust (`camelCase` payloads, `snake_case` statuses/modes, `SCREAMING_SNAKE` codes) | **functional + drift-guarded** | `test/protocolWire.test.ts` reads `core/crates/sandpane-protocol/src/lib.rs`, `sandpane-service/src/lib.rs` and `schemas/*.json` and fails on a rename |
| Display-only task reducer (no invented transitions), incl. `task.list` hydration | **functional** | `test/reducer.test.ts` (20) + live: `cancelled` appears only because Core appended it; double cancel → `CONFLICT` |
| Context attachments: selection/active file/diagnostics, explicit list before send, secret exclusion | **functional (planner)** | `test/context.test.ts` (20) |
| Diff argument builder (`vscode.diff`) from a real ChangeSet | **functional (builder)** | `test/diff.test.ts` (10) — URI resolution inside VS Code is **not yet verified**, see Pending |
| Workspace-mode labels incl. prominent `direct_mount` LIVE-WRITABLE, and UNVERIFIED when Core reports no binding row | **functional** | `test/vscodeGuards.test.ts` (14) — `SandboxSummary.workspaceMode` absent ⇒ never rendered as safe |
| Error-code → install/help guidance (`NOT_INSTALLED`, `DAEMON_DOWN`, …) incl. the oversized-replay refusal as recoverable | **functional** | `test/diagnostics.test.ts` (23) + live: `task.subscribe` over the frame ceiling ⇒ structured `VALIDATION_FAILED` |
| Remote-host gate (`env.remoteName`) → explicit unsupported state | **functional** | `test/vscodeGuards.test.ts` |
| Webview CSP (nonce, `default-src 'none'`, no inline script/style, escaping) | **functional** | `test/webview.test.ts` (8) |
| Sidebar webview (plain TypeScript), task tree, status bar, 9 commands | **wired, needs a human-in-the-loop run** | compiles; never launched inside a real VS Code window yet |

### Live integration against a real Core

`scripts/live-core-check.mjs` runs the compiled client against the actual
`sandpane-service` binary over its Unix socket (temp socket + temp DB, nothing
mocked). Latest run on this host — **55/55 checks passed**, including:

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
PASS  sandbox.list fails with NOT_INSTALLED (no sbx on this host)
PASS  hostile multi-line content is stored verbatim as inert data
PASS  adapter.unavailable carries PROVIDER_AUTH_REQUIRED (no fake execution)
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
npm test                           # vitest run — 171 tests, pure modules + one real-socket transport suite
npm run compile                    # tsc → out/ (extension) + out/webview/app.js (sidebar script)
npm run check                      # typecheck + test
npm run check:live                 # optional: real Core service integration (see above)
```

No runtime dependencies: Node stdlib + the VS Code API only. `devDependencies`
are typescript, @types/vscode, @types/node, vitest.

**Unit tests need no extension host.** Everything under `src/core-client/`
(except `transport.ts`), `src/state/reducer.ts` and the pure halves of
`src/vscode/*` and `src/webview/html.ts`/`bridge.ts` import no `vscode`, so they
run under plain Node with an injected fake duplex.

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
│   ├── catchup.ts            EventCheckpoint + pull-based resume (per-task cursors)
│   └── paths.ts              socket/data-dir resolution (mirrors sandpane_service)
├── state/reducer.ts          display-only task state over Core statuses
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
  `VALIDATION_FAILED`, is surfaced as recoverable guidance, and the pull loop
  **stops retrying** it instead of hammering the socket.
- **Context is explicit and deny-by-default**: selection → active file →
  diagnostics (opt-in), every attachment listed before send, sensitive paths
  (`.env`, `id_rsa`, `credentials.json`, `*.key`, `.npmrc`, `secrets*`, …)
  excluded outright rather than redacted, per-attachment size cap.
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
- **DEFERRED: Explain Selection / Refactor Selection / Fix Current Problems / Add File to Chat / Review Active Task, and `sandpane.sendSelection`** (specs/03:131–135, :82). None are contributed or registered; there is no `editor/context` menu. The data path exists (selection is quoted into task context via `startTask`'s preview), but the dedicated menu entries and their consent UX are P3 work. Named here after review 0006 #6 — previously this gap was invisible in this file.

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
  be listed and created — and listing needs `sbx`, which is **not installed on
  this host** (`docs/compatibility.md`: P0 BLOCKER).

### VS2 — chat and multi-project
- **DEFERRED (P0 gate): real streaming chat.** Core advertises
  `codex {verified:false, supportsStreaming:false, supportsCancel:false,
  supportsResume:false}` — confirmed live. Sending a prompt therefore creates a
  real queued task and Core answers `adapter.unavailable` /
  `PROVIDER_AUTH_REQUIRED`; the sidebar shows exactly that, and the composer asks
  for explicit confirmation before sending. Chat tabs, streaming repaint
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
- **DEFERRED: verified `vscode.diff` resolution.** `buildDiffPlan` produces the
  `git:` + `file:` argument pair from Core's real `baseCommit`, and its shape is
  unit-tested; that the installed `vscode.git` resolves the URI on this host is
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
- **DEFERRED: `.vsix` packaging + marketplace metadata, VS Code integration-test
  runner, accessibility audit** (VS4 items). `package.json` is `private: true`
  and there is no `@vscode/vsce` dependency yet.
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
  `task.subscribe` from the checkpoint. The codec already understands
  method-bearing frames and routes them to a notification seam, but no such frame
  exists yet — it is forward-compat, not a claimed capability.

## Verified vs. pending — `specs/03 §6` integration scenarios

| # | Scenario | Status |
|---|---|---|
| 1 | two projects, three chats, two tasks running while switching tabs | **PENDING** — needs chat (VS2) and a real writable task |
| 2 | reopen VS Code, UI catches up from the Core checkpoint | **PARTIAL** — per-task checkpoint replay verified headless (17 unit cases + live: `afterSequences` recovers the behind task's unseen events, which a shared scalar skips); inside a real window: PENDING |
| 3 | second window shows the same state, no duplicate process | **PARTIAL** — two socket clients on one `instanceId` verified live; two VS Code windows: PENDING |
| 4 | selection with spaces/Unicode/newlines arrives exactly, no shell execution | **VERIFIED** live — hostile multi-line payload stored verbatim; Core has no exec method and rejects one |
| 5 | apply with dirty host files aborts safely | **PARTIAL** — Core's precondition gates abort (verified live for the no-Git-context case); the dirty-host path with a real repo: PENDING |
| 6 | stop sandbox with active tasks warns | **PENDING** — no `sandbox.stop` method in v1 |
| 7 | omitted Codex adapter shows an unsupported explanation | **VERIFIED** live — `adapter.unavailable` + `PROVIDER_AUTH_REQUIRED`, no terminal scraping fallback exists in this client |
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
