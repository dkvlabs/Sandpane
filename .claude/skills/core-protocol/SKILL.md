---
name: core-protocol
description: Use when adding or changing Core RPC methods, event types, error codes, SQLite schema/migrations, task state transitions, scheduler behavior, or any client's Core connection/reconnect logic.
---

# Core protocol & persistence conventions

From `docs/specs/02_ARCHITECTURE_AND_DATA.md`. One persistent per-user Core; clients are thin, stateless-ish attachments.

## Protocol invariants

- Transport: Unix domain socket (per-user perms) / Windows named pipe (user-only DACL). **Never TCP by default.** Newline-delimited JSON frames over the socket, each capped at `MAX_FRAME_BYTES` (4 MiB, `sandpane-service`); readers must bound reads to the cap (AGENTS.md Code Review rule 9).
- Every frame: protocol `v`, request `id`, method or correlated response; JSON-schema validated against `schemas/`.
- Method set starts from the contract in specs/02 §2; the implemented set is `sandpane_protocol::Method::ALL` (advertised in `CoreCapabilities.methods`, so advertised = dispatched). Adding a method = update `sandpane-protocol` types + `schemas/*.json` + each client's typed wrapper together, run `make schema-drift`, and note drift status in the changelog entry.
- Read methods (`task.list`, `conversation.list`, `conversation.history`) clamp `limit` (default 200, max 500) and disclose `truncated: true`; never return an unbounded list.
- Structured error codes only: `NOT_INSTALLED`, `DAEMON_DOWN`, `UNSUPPORTED_SBX_VERSION`, `PROVIDER_AUTH_REQUIRED`, `CONFLICT`, `TASK_INTERRUPTED`, `PERMISSION_DENIED`, `VALIDATION_FAILED`, `NOT_FOUND` (+ transport-level `INTERNAL`). Canonical set: `sandpane_protocol::ErrorCode` — `NOT_FOUND` exists in code but is not yet listed in specs/02 §2. No free-form shell-exec RPC ever.
- Idempotency keys on sandbox/task creation; cancellation + deadlines on every long call.

## Events

- Append-only `task_events` (sequence PK per task) written **durably before** subscriber notification; `task.subscribe` replays from checkpoint — with `taskId`, from the scalar `afterSequence`; without `taskId` (project-wide/global), each task from its own cursor in the `afterSequences` map (bounded: 4096 entries). A replay that cannot fit one frame is refused with `VALIDATION_FAILED`, never emitted oversized. Client reconnect must be idempotent.
- Normalized `AgentEvent` union (specs/02 §4): `message.delta`, `tool.started/finished`, `file.changed`, `approval.required`, `task.completed`, `error`. This is a Sandpane format; normalize only what the adapter can verify; mark unsupported events explicitly.

## Task lifecycle (enforced in Core, never in UI)

`created → queued → preparing → running → verifying → awaiting_review → completed`, with `rejected` from awaiting_review, `awaiting_input → running` when adapter-supported, and `failed / cancelled / interrupted` from queued/preparing/running. The transition table lives in `sandpane_core::task`; extend it there and in tests — a UI that "knows" a transition is a bug. No fictitious `pause`.

## Persistence

- SQLite: WAL, foreign keys on, migrations table, single-writer (the service). Schema = specs/02 §3 (projects, repositories, sandbox_bindings, conversations, messages, agent_sessions, tasks, task_events, task_artifacts, verifications, presets, project_context, workflows, client_state, settings) + the four required indexes.
- Migrations are forward-only, backed up atomically, and refuse downgrade that would corrupt state.
- Store Sandpane state, never a duplicate authoritative SBX inventory; SBX state is probed before actions.
- After Core restart: reconcile SQLite ↔ OS processes ↔ SBX ↔ branches; unverified tasks → `interrupted`; **never** auto-resume execution because a row said `running`; never assume an old PID still belongs to your agent.

## Concurrency & supervision

- Configurable global + per-project maxima; default one writer per writable workspace; queue conflicts instead of racing.
- Cancel: provider-native API when supported, else controlled process-tree termination with timeout; log actual outcome.
- Core outlives clients; window/tab close unsubscribes UI only. Single instance per OS user via lock/handshake; clients launch a verified Sandpane-owned binary only under the agreed ownership policy.

## Common mistakes

| Mistake | Fix |
|---|---|
| Client caching "authoritative" task state | Core is the only source; clients resubscribe with last sequence |
| Notifying subscribers before the event is durable | Write-then-notify, always |
| Adding an RPC that takes a command string | Backend methods with typed args only |
| Trusting `running` rows after a crash | Reconcile → `interrupted` |
