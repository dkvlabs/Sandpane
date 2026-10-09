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
The shell, the wire client and the full information architecture are real and tested, and the
Tauri Rust shell now **compiles and lints clean on this host** (see
[Verification](#verification)).

---

## Verification

### Verified on this host (macOS, Node 24.5.0, npm 11.21.0, Rust 1.99.0 / Homebrew)

| Command | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | OK — 0 errors |
| `npm test` (`vitest run`) | OK — **10 files, 227 tests passed**, 1 file (8 live tests) auto-skipped without a socket |
| `SANDPANE_SOCKET=… npm test` | OK — **11 files, 235 tests passed** (227 unit + 8 against the real Core binary) |
| `npm run build` (`tsc --noEmit && vite build`) | OK — `dist/` emitted (327.01 kB JS, 20.04 kB CSS) |
| `cargo check --manifest-path src-tauri/Cargo.toml` | OK — `Finished dev profile` |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | OK — no warnings |
| `cargo test --manifest-path src-tauri/Cargo.toml` | OK — **7 passed; 0 failed** (frame proxy unit tests) |

**Baseline movement:** the desktop suite went from **144 → 227** tests. The added coverage is
`tests/guards.test.ts` (27), `tests/replay-cursors.test.ts` (11),
`tests/protocol-drift.test.ts` (23) and the new additive-field cases inside
`tests/protocol.test.ts` (20 → 29) and `tests/reducers.test.ts` (28 → 41).

### Live Core run (the client, not a hand-rolled script)

The prebuilt `core/target/debug/sandpane-service` (built 15:09, never rebuilt or edited here)
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

- `system.probe` → `methods` is the 14-name list, `Method::ALL` order.
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

- `npm run tauri dev` / `npm run tauri build` — the crate now **compiles, lints and unit-tests
  clean**, but the native window has never been launched on this host: no WebKit runtime check,
  no round trip through `core_request_frame` over Tauri IPC, no build/sign/notarize run. The Rust
  socket proxy is therefore *compiled and unit-tested*, not *end-to-end exercised*.
- The `refused` replay path (Core's oversized-replay latch) is covered by unit tests against a
  test double modelled on Core's measured refusal text; it has not been triggered against a Core
  holding ~4 MiB of events.
- The Windows named-pipe transport — Core itself serves Unix sockets only, so the desktop proxy
  returns `TRANSPORT_UNSUPPORTED` there instead of pretending.
- `workspaceMode` end-to-end: decoding, clamping and the UNVERIFIED rendering are unit-tested;
  no sandbox with a recorded binding row was read on this host because `sbx` is absent.
- Native notifications, the native folder picker, installers.
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
  tagged union, and the same 14-name `Method` surface as `clients/vscode`. `schemas/*.json` is
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
  and never spawns Core.
- **State ownership stays in Core.** Task rows come from `task.list` and durable
  `task.subscribe` replay; both are Core's own values, displayed verbatim and labelled with
  which read produced them. When Core's two reads disagree the row shows both — the client
  computes no lifecycle transitions and never renders `running`/`resumed` it did not receive
  (AGENTS rule 3). React Query owns reads/writes; the event stream lives in `TaskEventStore`
  with ~80 ms coalescing; `src/stores/ui.ts` holds presentation-only preferences.
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
| `#/tasks`, `#/tasks/:id` | Tasks & Review | `task.list` + event replay, `task.cancel`, `git.review`, `git.apply` |
| `#/sandboxes`, `#/sandboxes/new` | Sandboxes + wizard | `sandbox.list` (incl. `workspaceMode`), `sandbox.create` (start/stop/delete: no method yet) |
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
                                  replay cursors, protocol drift, live Core (opt-in)
```

`src-tauri/Cargo.toml` depends on `sandpane-protocol` by path (`../../../core/crates/…`) so the
allowlist the proxy enforces cannot drift from Core's `Method::parse`, while keeping its own
lockfile. That path was previously `../../core/…`, which resolved to the non-existent
`apps/core/crates/sandpane-protocol`; dependency resolution failed and the crate had never been
compiled. Fixing it surfaced three real defects that a non-compiling crate had been hiding — a
missing `std::io::Read` import (so the bounded read could not compile), unused imports, and a
missing icon asset — all now fixed and covered by `cargo clippy -D warnings` and 7 Rust tests.

---

## Deferred

- **DT1 polish:** virtualized chat lists (bounded rendering + explicit "show earlier" is in
  place), native folder picker, OS notifications, command palette. Chat history is no longer
  blocked on Core — `conversation.list`/`conversation.history` exist and are wired; what remains
  is archive/export/search, for which no method exists.
- **DT2:** sandbox detail, start/stop/remove with confirmations, capability-gated advanced
  wizard options, project↔sandbox binding beyond `sandbox.create`.
- **DT3:** real diff text viewer (no `git.diff` in v1), selective apply UX, verification
  history, "open in IDE", approval responses (no approval RPC exists).
- **DT4:** network policy, port publishing (loopback by default), templates, MCP, secret
  presence, redacted diagnostics export, native-app/SSH wizard.
- **DT5:** multi-window consistency, signing/notarization, installer paths per OS,
  accessibility/performance benchmarking with recorded hardware, real brand iconography.
- **Tailwind + shadcn/ui** (design spec §17) is deliberately deferred: functionality first,
  then the visual pass. This scaffold implements the same semantic tokens as CSS variables.
