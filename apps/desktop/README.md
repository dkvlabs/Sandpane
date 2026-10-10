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

### Verified on this host (macOS, Node 24.5.0, Rust 1.99.0 / Homebrew) — A3a project-lifecycle pass, 2026-10-10

Run fresh after the A3a project-lifecycle client work (protocol design 2026-10-09 §3.2), against
the A3a Core + schema in the working tree, on top of the A2 idempotency work and its review fixes
(W1–W4, I4, I5) and the A1 sandbox-lifecycle work and its review fixes. Every row below is a command that was actually run, with its actual
result, except where a row says it was not re-run:

| Command | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | OK — 0 errors |
| `npm test` (`vitest run`) | OK — **17 files, 484 tests passed**; 1 file (8 live tests) skipped without `SANDPANE_SOCKET` |
| `npm run build` (`tsc --noEmit && vite build`) | NOT re-run in the A1 pass. Last run in the 2026-10-09 review-fix pass: OK, `dist/` emitted (338.83 kB JS, 20.65 kB CSS then) |
| `cd src-tauri && cargo check --offline` | OK — `Finished dev profile` |
| `cd src-tauri && cargo clippy --offline --all-targets -- -D warnings` | OK — no warnings |
| `cd src-tauri && cargo test --offline` | OK — **32 passed; 0 failed** (frame validation and wire-length cap, CR/LF smuggling, response-id match, Core's connection-level refusal, per-method budgets, socket path policy, socket trust check, and fake-Core round trips on a real socket: retry-once for reads on early EOF / connect refused, no retry after a timeout or for a mutation, a part-way write of a mutation flagged as maybe-applied, `sandbox.stop` / `sandbox.remove` never re-sent after an early EOF; `Method::ALL` is 22 and the six A3a project methods are allowlisted, never replay-safe, and on the default 12 s budget except `project.create` / `project.add_repository` at 43 s) |
| `make desktop-check` (repo root) | OK — runs all of the above except `npm run build`; now includes `cargo fmt --check`, `check`, `clippy`, `test` for `src-tauri` |

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

- **Methods.** `METHODS` is the 22 names of `Method::ALL`, in order (drift-tested against the
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
  tagged union, and the 22-name `Method` surface of Rust `Method::ALL` (A3a added six project
  methods). `schemas/*.json` is
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
- **DT3:** real diff text viewer (no `git.diff` in v1), selective apply UX, verification
  history, "open in IDE", approval responses (no approval RPC exists).
- **DT4:** network policy, port publishing (loopback by default), templates, MCP, secret
  presence, redacted diagnostics export, native-app/SSH wizard.
- **DT5:** multi-window consistency, signing/notarization, installer paths per OS,
  accessibility/performance benchmarking with recorded hardware, real brand iconography.
- **Tailwind + shadcn/ui** (design spec §17) is deliberately deferred: functionality first,
  then the visual pass. This scaffold implements the same semantic tokens as CSS variables.
