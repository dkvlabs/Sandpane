# Sandpane Desktop

Tauri 2 + React + TypeScript shell for Sandpane: the multi-project control centre for
AI development workspaces and Docker sandboxes.

It attaches to **the same single persistent per-user Sandpane Core** that VS Code and
JetBrains use, over the same NDJSON socket protocol. It does **not** start its own Core,
does not reimplement task/project business logic in Tauri handlers, and does not ship a
second sandbox backend.

Status: **P5 / DT0–DT1 scaffold.** The shell, the wire client and the full information
architecture are real and tested. The native build is not verified on this host (see
[Verification](#verification)).

---

## Verification

Commands actually run on this host (macOS, Node 24.5.0, npm 11.21.0):

| Command | Result |
| --- | --- |
| `npm install --no-audit --no-fund` | OK — 102 packages |
| `npm run typecheck` (`tsc --noEmit`) | OK — 0 errors |
| `npm test` (`vitest run`) | OK — 7 files, **144 tests passed** |
| `npm run build` (`tsc --noEmit && vite build`) | OK — `dist/` emitted (≈305 kB JS, 20 kB CSS) |
| `tsc --noEmit --noUnusedLocals --noUnusedParameters` | OK — no unused symbols |
| `python3 scripts/schema_drift.py` (repo root) | OK — `schemas/` ↔ `sandpane-protocol` in sync; `tests/protocol.test.ts` asserts the same value sets on the TS side |

**Not verified here, and therefore not claimed:**

- `npm run tauri dev` / `npm run tauri build` — needs a Rust toolchain plus the Tauri 2
  system prerequisites (WebKitGTK on Linux, MSVC/WebView2 on Windows). The Rust side in
  `src-tauri/` has never been compiled on this machine.
- A real attach to `sandpane.sock`, and any round trip against a live `sandpane-service`.
- Native notifications, the native folder picker, code signing/notarization, installers.
- Windows named-pipe transport — Core itself serves Unix sockets only, so the desktop
  proxy returns `TRANSPORT_UNSUPPORTED` there instead of pretending.
- Performance targets (idle CPU/memory, 30-chat retention): never measured.

---

## What runs today

```bash
cd apps/desktop
npm install
npm run typecheck && npm test   # the two gates
npm run dev                     # UI shell in a browser: shows the OFFLINE state by design
npm run tauri dev               # native window (requires the Rust toolchain — unverified here)
```

`npm run dev` in a plain browser is not a demo mode. There is no fake Core there: the
transport resolves to an explicit *unavailable* state, every view says Core cannot be
reached, and no data is invented. Run `sandpane-service` and `npm run tauri dev` for real
data.

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
                     │                                     afterSequence replay
              CoreTransport (injected)
                     │
   TauriTransport ── invoke("core_request_frame") ── Rust proxy (src-tauri/src/ipc_client.rs)
                                                          │  validates v/id/method + 4 MiB cap
                                                          ▼
                                                per-user Core Unix socket (NDJSON)
```

- **Wire contract is shared, not re-invented.** `src/lib/protocol.ts` matches
  `clients/vscode/src/core-client/protocol.ts` on the constants both declare
  (`PROTOCOL_VERSION = 1`, `MAX_FRAME_BYTES = 4 MiB`, the same workspace modes), so the two
  clients really do speak one protocol. `src/lib/protocol.ts` mirrors
  `core/crates/sandpane-protocol` exactly: camelCase fields, `snake_case` statuses and
  workspace modes, `SCREAMING_SNAKE_CASE` error codes, `{v,id,...}` frames, and the
  `AgentEvent` tagged union keyed by `type`. `schemas/*.json` is the third copy; they move
  together.
- **The Rust shell is a narrow typed client.** Two commands total:
  `core_request_frame` (one validated request → one response line) and `core_socket_status`
  (read-only metadata). It re-validates every method against `sandpane_protocol::Method`,
  enforces `MAX_FRAME_BYTES`, has no `std::process::Command`, no shell, no arbitrary path or
  URL handler, and never spawns Core.
- **State ownership stays in Core.** The UI derives its task table from durable
  `task_events` replay (`task.subscribe(afterSequence)`) because protocol v1 has no
  `task.list`; it computes no lifecycle transitions and never renders `running`/`resumed`
  it did not receive. React Query owns reads/writes; the event stream lives in
  `TaskEventStore` with ~80 ms coalescing; `src/stores/ui.ts` holds presentation-only
  preferences (no Zustand dependency was added for it).
- **Core has no push frame yet**, so liveness is a replaying `task.subscribe` poll with a
  per-task checkpoint, exponential backoff on failure, gap reporting, and a `resume()` path
  that re-uses the checkpoint — which is also how a UI restart catches up without
  duplicating events.

### Information architecture (docs/specs/01 §6, docs/specs/05 §1–2)

| Route | View | Data source today |
| --- | --- | --- |
| `#/` | Dashboard | `system.probe`, `project.list`, event replay |
| `#/projects` | Projects | `project.list`, `project.create` |
| `#/projects/:id`, `#/projects/:id/conversations/:cid` | ProjectWorkspace | sandbox picker + chat + activity timeline + review |
| `#/chats` | Chats | conversations created in this window (no `conversation.list` in v1 — stated in UI) |
| `#/tasks`, `#/tasks/:id` | Tasks & Review | event replay, `task.cancel`, `git.review`, `git.apply` |
| `#/sandboxes`, `#/sandboxes/new` | Sandboxes + wizard | `sandbox.list`, `sandbox.create` (start/stop/delete: no method yet) |
| `#/agents` | Agents | `system.probe` `agents[]` |
| `#/templates` | Templates | read-only unsupported state (no template RPC) |
| `#/integrations` | Integrations | guidance for editors/native apps/SSH/MCP/policies |
| `#/settings` | Settings | Core-reported runtime + local UI preferences |

A hash router (no routing dependency) drives this; an unmatched hash renders an explicit
"no such view" screen rather than silently falling back to the dashboard.

### Honest states

Every view renders from the injected `CoreClient`, and the offline/missing path is a first
class state (`docs/specs/05 §5`): `attaching`, `attached`, `version_mismatch`, `unreachable`
(carried data is only ever labelled **stale**), plus `transport_unavailable` outside the
Tauri shell. SBX readiness distinguishes `not_installed`, `daemon_down`,
`installed_daemon_unknown` and `ready` — the scaffold Core locates the binary but does not
probe version/daemon, so it maps to `installed_daemon_unknown`, never a green "ready".
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
│   │   ├── framing.ts            NDJSON codec, bounded at MAX_FRAME_BYTES
│   │   ├── decode.ts             runtime decoders for `ok` payloads (no casts)
│   │   ├── core-client.ts        RPC + correlation + task.subscribe replay engine
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
│   └── src/{main.rs,ipc_client.rs}
└── tests/                        framing, reducers, connection, wizard, core-client
```

`src-tauri/Cargo.toml` depends on `sandpane-protocol` by path so the allowlist the proxy
enforces cannot drift from Core's `Method::parse`, while keeping its own lockfile.

---

## Deferred

- **DT1 polish:** virtualized chat lists (bounded rendering + explicit "show earlier" is in
  place), native folder picker, OS notifications, `conversation.list`/history UI once Core
  gains the method, command palette.
- **DT2:** sandbox detail, start/stop/remove with confirmations, capability-gated advanced
  wizard options, project↔sandbox binding beyond `sandbox.create`.
- **DT3:** real diff text viewer (no `git.diff` in v1), selective apply UX, verification
  history, "open in IDE".
- **DT4:** network policy, port publishing (loopback by default), templates, MCP, secret
  presence, redacted diagnostics export, native-app/SSH wizard.
- **DT5:** multi-window consistency, signing/notarization, installer paths per OS,
  accessibility/performance benchmarking with recorded hardware.
- **Tailwind + shadcn/ui** (design spec §17) is deliberately deferred: functionality first,
  then the visual pass. This scaffold implements the same semantic tokens as CSS variables.
