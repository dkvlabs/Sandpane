# Sandpane protocol schemas

Versioned JSON Schemas for the Sandpane Core IPC protocol and durable events
(docs/specs/02_ARCHITECTURE_AND_DATA.md §2-§4). These are **Sandpane-owned**
formats — never Docker SBX / Codex / Claude wire formats.

| Schema | Describes | Rust source of truth |
|---|---|---|
| [rpc-request.schema.json](rpc-request.schema.json) | client → core frame | `sandpane_protocol::RpcRequest` |
| [rpc-response.schema.json](rpc-response.schema.json) | core → client frame (ok/err, error codes) | `sandpane_protocol::RpcResponse` |
| [core-capabilities.schema.json](core-capabilities.schema.json) | `system.probe` result | `sandpane_protocol::CoreCapabilities` |
| [agent-event.schema.json](agent-event.schema.json) | normalized agent event union | `sandpane_protocol::AgentEvent` |
| [task-event.schema.json](task-event.schema.json) | durable replayable log entry | `sandpane_protocol::TaskEvent` |
| [sandbox-create-spec.schema.json](sandbox-create-spec.schema.json) | `sandbox.create` params | `sandpane_protocol::SandboxCreateSpec` |
| [change-set.schema.json](change-set.schema.json) | `git.review` result | `sandpane_protocol::ChangeSet` |
| [verification.schema.json](verification.schema.json) | A7 `verification.*` params and results (`$defs`) | `sandpane_protocol::Verification*`, `OutputRedaction` |
| [project-context.schema.json](project-context.schema.json) | A7 `project.context` params and result | `sandpane_protocol::ProjectContext*`, `RepositoryContext`, `DetectedManifest` |

## Sync status

**Hand-synced** with the Rust types at scaffold stage — the Rust crate is the
source of truth. The **value-set drift gate landed** with the CI entry
(docs/CHANGELOG.md 0005): `make schema-drift` → `scripts/schema_drift.py`
compares the exact method/error-code/event-type/status/mode/version sets
between this directory and `core/crates/sandpane-protocol` and fails on any
mismatch. The **generated bindings** half (schemas → TypeScript/Kotlin codegen)
remains a P1/P7 deliverable (docs/specs/07 P1 "Stable schema + generated
bindings + drift check", docs/specs/08 §6 "schema/codegen drift"). Until
codegen lands, any protocol change must update the Rust types AND these files
in the same commit — the drift gate now enforces it — and say so in the
changelog entry.

Since entry 0010 the gate also compares a **second** surface: the method set
`Method::ALL` resolves to `as_str` (i.e. what `system.probe` advertises in
`core-capabilities.methods`) against `rpc-request.schema.json`'s method enum —
so a method that Core dispatches but clients cannot discover now fails the
gate instead of drifting silently.

**Why there is no per-method schema for every method.** Only cross-cutting
frames (`rpc-request`, `rpc-response`, `agent-event`, `task-event`,
`core-capabilities`) plus the two payloads a client must construct or consume
blind (`sandbox-create-spec`, `change-set`) have their own files. Params for
`task.list` / `conversation.list` / `conversation.history`, and the A1
`sandbox.stop` / `sandbox.remove` params and results (`SandboxStopParams`,
`SandboxStopResult`, `SandboxRemoveParams`, `SandboxRemoveResult`,
`ConfirmationRequest`) are defined by the Rust types, pinned by the
value-set gate and by each client's wire-parity test. The A2 additions
defined only by the Rust types — the `conversation.send` `idempotencyKey`
(`ConversationSendParams`; `rpc-request`'s `params` stays a bare object) and
the `replayed: true` marker on a replayed `SandboxSummary` / `TaskSummary`
(absent on a first response; a replay is the FIRST response, not current
state) — are pinned by the Rust protocol tests only: client adoption pending
(A2 client step). The A3a project-lifecycle shapes — `ProjectListParams`
(`includeArchived`), `ProjectUpdateParams`, `ProjectIdParams`,
`ProjectDeleteParams` / `ProjectDeleteResult` (the §2 token flow, reusing
`ConfirmationRequest` with `external: false`), `ProjectRepositoryParams` and
`Project.archivedAt` — are likewise defined by the Rust types; only their
six method names are in `rpc-request`'s enum (gated by `schema-drift`).
They are pinned by the Rust protocol and service tests only: client adoption
pending (A3a client step). The A3b conversation-lifecycle shapes —
`ConversationRenameParams`, `ConversationIdParams`,
`ConversationDeleteParams` / `ConversationDeleteResult` (the §2 token flow,
`external: false`), `ConversationExportParams` / `ConversationExportResult`
/ `ExportRedaction`, `ConversationListParams.includeArchived` and
`Conversation.archivedAt` / `sandboxId` — are likewise defined by the Rust
types; their five method names are in `rpc-request`'s enum and the
`conversation-sandbox-id` feature is in `core-capabilities` (both gated by
`schema-drift`). Client adoption pending (A3b client step). The A4 send-mode
shapes — `ConversationSendParams.mode` (`"task"` | `"discuss"`, a plain string
on the wire so Core can answer any other value with the exact
VALIDATION_FAILED message; explicit `"task"` is normalized to absent before
the idempotency fingerprint), `TaskSummary.mode` (the send mode: an OPEN
string, set on every task created from A4 on, absent on older tasks) and
`TaskSummary.chosenSandboxName` (present only when the task's chat chose a
sandbox: a stored NAME, not a binding, and it never means the task runs in
that sandbox; `TaskSummary.sandboxName` keeps its pre-A4 binding-only
meaning) — are likewise defined by the Rust types; no method is added and no
enum is added to any schema. The `conversation-send-mode`
feature is in `core-capabilities` (gated by `schema-drift`). Client adoption
pending (A4 client step). A5 adds the read-only method `git.diff` (28
methods; in `rpc-request`'s enum right after `git.review`, gated by
`schema-drift`) with `GitDiffParams {taskId, path, maxBytes?, status?}` and
`GitDiffResult {path, oldPath?, status, patch, binary, truncated, lossy,
baseBlob?}` defined by the Rust types; `change-set.schema.json` gains the
optional `repoPath`, `uninspected` (defined, never produced in A5) and
`changes[].oldPath` together with the Rust `ChangeSet` / `FileChange`. Since
A5 a change-list `path` is exactly git's (NUL-separated, never C-quoted), and
`git.diff` accepts only that exact string. A path can be listed twice (for
example `deleted` and `untracked` after `git rm --cached`): `git.diff` then
refuses (`VALIDATION_FAILED`) unless the optional `status` — one of the
`changes[].status` values — names the entry; when given, path and status
must both match. Client adoption pending (A5 client
step). A6 implements `git.apply` for reviewed `host_worktree` entries (no new
method; the `git-apply` feature is in `core-capabilities`, gated by
`schema-drift`). `change-set.schema.json` gains the optional `reviewId` (an
opaque id per `host_worktree` review; Core keeps the last 8 per task in
memory), `hostHooksPath` (the host's effective `core.hooksPath`, only when it
is inside the repository, repo-relative) and `changes[].taskBlob` /
`changes[].taskMode` (Core's own blob id and git mode of the task-side bytes;
absent for `deleted` entries and files over 32 MiB), together with the Rust
`ChangeSet` / `FileChange`. `GitDiffResult` gains the same optional
`taskBlob` / `taskMode` (from the one read that also renders the patch; on
`host_worktree` the patch header names are Core temp names, `a/base` /
`b/task`). `GitApplyParams` gains `reviewId?` and `entries?` (each a
`FileChange` copied verbatim from that review); `selectedFiles` is refused.
`ApplyResult` gains `appliedFiles?`, `modeChanges? [{path, from, to}]`,
`snapshotTree?` and `partial?` (true only when git may have written after its
checks passed). The task events `git.apply.started`, `git.applied`,
`git.apply.failed` and `git.apply.reconciled` are open `kind` strings, not
enum values; `git.applied` / `git.apply.failed` payloads carry
`startedSequence` (the `git.apply.started` event they close), which restart
reconciliation matches on. Client adoption pending (A6 client step). A7
(design 2026-10-09 §3.7) adds six methods — `verification.list`,
`verification.approve`, `verification.revoke`, `verification.run`,
`verification.result` and `project.context`, in that order right after
`git.apply` in `rpc-request`'s enum (34 methods) — and the `verification`
feature in `core-capabilities` (6 features); both sets are gated by
`schema-drift`. Their params and results are the first A-series shapes with
their own files: `verification.schema.json` (`$defs` for every
`verification.*` param and result, `VerificationCommand` and
`OutputRedaction`) and `project-context.schema.json`. These two files are
syntax-linted by `schema-lint` but **not** compared by `schema-drift` (it
compares value sets, and they define no enum); the Rust types are the source
of truth and the protocol test `a7_verification_wire_shapes` pins the wire
shapes. `outcome` is an OPEN string (`running` while in flight, then
`exited`, `signaled`, `timed_out`, `spawn_failed`, `read_failed`,
`possibly_sbx_error` or `interrupted`), never an enum; `exitCode` is the exit
status of `sbx exec` (UNVERIFIED pass-through, C-2). The task events
`verification.started {runId, commandId, label, argv, sandbox,
workspaceMode}` and `verification.finished {runId, startedSequence, outcome,
exitCode?, stdoutBytes, stderrBytes, stdoutTruncated, stderrTruncated,
redactions, elapsedMs, outputIncomplete?}` are open `kind` strings (documented in
`task-event.schema.json`); exactly one `verification.finished` closes each
start, interruption (graceful shutdown or restart reconciliation, the latter
with `reconciledAfterRestart: true`) carries only `{runId, startedSequence,
outcome: "interrupted"}`, and command OUTPUT is never in an event — it is read
with `verification.result`. `outputIncomplete: true` (on the result and on
`verification.finished`, absent otherwise) means `sbx exec` exited while an
escaped descendant still held its output open past the kill grace: the exit
status is kept, the output may lack a tail. `verification.list`,
`project.context` and `verification.result` measure their response and,
above `MAX_FRAME_BYTES` − 64 KiB, answer `VALIDATION_FAILED` "the response
would exceed the frame limit (…); …; nothing was returned" (details:
`commandIds` for the list, `repositories` / `repositoryCount` /
`approvedBytes` for the context, `runId` for the result) instead of an
oversized frame. Client adoption pending (A7 client step). A8a (design
2026-10-09 §3.8 item 1) adds no method and no feature string: the strict
`sbx` object in `core-capabilities.schema.json` gains two optional booleans,
`execVerified` (the `verification.run` version gate's own predicate) and
`versionCaptured` (the probed version number equals a captured fixture
version), both absent when the version is unknown, and `daemonRunning` now
comes from the captured text form of `sbx daemon status`. `schema-drift`
compares value sets, so these field names are pinned by the protocol test
`a8a_sbx_status_wire_shape` instead. Client adoption pending (A8a client
step). The
`docs/specs/02 §2` contract blocks are the
human-readable form. Adding a
schema file per method is a codegen concern and belongs with the P1/P7
generated-bindings deliverable, not here.
