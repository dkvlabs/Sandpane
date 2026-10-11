# Sandpane — Architecture, core protocol, and persistence

**Baseline:** 08.10.2026 · **Status:** proposed design; interfaces shown below belong to Sandpane, not Docker SBX.

## 1. One persistent per-user core

```text
VS Code Extension (TypeScript) ─┐
JetBrains Plugin (Kotlin/JVM) ──┼── secured local IPC ── Sandpane Core (Rust service)
Desktop App (Tauri/React) ─────┘                            │
                     ┌─────────────────────────────────────┼──────────────────┐
                     ▼                                     ▼                  ▼
                SQLite + logs                       SBX CLI adapter    Agent adapters
                     │                                     │                  │
             projects/chats/tasks                     Docker SBX       Codex / Claude / ...
                                                                   (running inside SBX)
```

**Do not let each client maintain its own authoritative project/task database.** A detached IDE UI must not be able to accidentally terminate a task. The Core service owns all long-running agent processes and child supervision. Use exactly one core instance per OS user and a lock/handshake to prevent duplicates.

### Process lifecycle

- A client connects, checks version/capabilities, subscribes to events, and fetches a project snapshot.
- If Core is absent, launch a signed/verified Sandpane-owned executable for the matching platform, then connect.
- Keep Core alive independent of clients while tasks run. When idle, allow user-configured shutdown after durable state flush.
- On Core restart, reconcile SQLite records with OS processes, SBX daemon state, branches and agent-native sessions. Mark unverified tasks `interrupted`; never infer that an old PID still belongs to your agent.
- Do **not** automatically execute previously running tasks merely because they were marked `running` in SQLite.
- Protect core upgrades with schema migrations, compatibility handshake, and single-writer database access.

### Packaging strategy

- `sandpane-core`: shared Rust crate with typed SBX adapters, Git, context and session logic.
- `sandpane-service`: persistent Rust process and local IPC protocol server.
- `sandpane-client-ts`: typed client used by VS Code, React and Tauri.
- `sandpane-client-kotlin`: client used by IntelliJ Platform plugin.
- `sandpane-protocol`: versioned JSON schemas with generated bindings.

Desktop installers can bundle a **Sandpane-owned** service binary; IDE plugins may bundle matching Sandpane binaries for tested OS/CPU targets or discover a preinstalled one. **Never bundle SBX itself** absent explicit written permission. Establish a secure updater/version ownership model so a plugin cannot silently downgrade a running core used by another client.

## 2. Service protocol and IPC security

Transport: Unix domain socket on Linux/macOS with per-user filesystem permissions; Windows named pipe with explicit user-only DACL. Do not bind to a TCP interface by default.

Requirements:

- Protocol version negotiation, instance identity and supported feature discovery.
- Request IDs; cancellation; deadlines; correlation IDs.
- JSON schema validation for all requests/responses/events.
- Same-user access controls, authorization of mutating operations, and CSRF-like defenses where browser-facing bridges exist.
- Sequence-numbered event stream and client acknowledgments/checkpoints.
- Bounded responses and log retention with truncation disclosure.
- Operation idempotency keys for sandbox/task creation and client retries.
- Structured errors: `NOT_INSTALLED`, `DAEMON_DOWN`, `UNSUPPORTED_SBX_VERSION`, `PROVIDER_AUTH_REQUIRED`, `CONFLICT`, `TASK_INTERRUPTED`, `PERMISSION_DENIED`, `VALIDATION_FAILED`.

Implemented contract (protocol v1, additively revised — see the revision note under the block):

```ts
interface SandpaneRpc {
  'system.probe': { request: {}; response: CoreCapabilities /* + methods: string[] (feature discovery); + features: string[] (A2: "idempotency-keys", "sandbox-create-agent"; A3b: "conversation-sandbox-id"; unknown strings are ignored) */ };
  'project.create': { request: { name: string; repositories: string[] }; response: Project /* + repositories: string[] */ };
  'project.list': { request: { includeArchived?: boolean /* A3a; default false */ }; response: Project[] /* + archivedAt? (A3a) */ };
  'project.update': { request: { projectId: string; name?: string; description?: string }; response: Project };
  'project.archive': { request: { projectId: string }; response: Project };
  'project.unarchive': { request: { projectId: string }; response: Project };
  'project.delete': { request: { projectId: string; confirmToken?: string }; response: { confirmation?: ConfirmationRequest; deleted?: true } /* §2 token flow; never touches host files, branches or sandboxes */ };
  'project.add_repository': { request: { projectId: string; path: string }; response: Project };
  'project.remove_repository': { request: { projectId: string; path: string }; response: Project };
  'sandbox.list': { request: {}; response: SandboxSummary[] /* each may carry workspaceMode; ABSENT when unbound */ };
  'sandbox.create': { request: SandboxCreateSpec /* + agent?: built-in sbx agent, default "shell"; + idempotencyKey?: 1..=128 [A-Za-z0-9._-] (A2) */; response: SandboxSummary /* + agent?: as sbx reports it; + replayed?: true on a keyed replay */ };
  'sandbox.stop': { request: { name: string }; response: { stopped: true; requeried?: SandboxSummary /* ABSENT = not listed or re-query failed: state unknown */ } };
  'sandbox.remove': { request: { name: string; confirmToken?: string }; response: { confirmation?: ConfirmationRequest /* step 1: nothing changed */; removed?: true /* step 2 */ } /* two-step token flow: docs/plans/2026-10-09-protocol-v1-additions.md §2 */ };
  'conversation.create': { request: { projectId: string; agentId: string; sandboxId?: string /* A3b: persisted as the chosen sandbox NAME, not a binding */; title?: string }; response: Conversation /* + sandboxId?, archivedAt? (A3b) */ };
  'conversation.send': { request: { conversationId: string; content: string; attachments?: ContextRef[]; idempotencyKey?: string /* A2 */; mode?: 'task' | 'discuss' /* A4, feature conversation-send-mode */ }; response: TaskSummary /* + replayed?: true on a keyed replay; A4: mode?, chosenSandboxName? (a name the chat chose, never a binding) */ };
  'conversation.list': { request: { projectId?: string; limit?: number; includeArchived?: boolean /* A3b; default false */ }; response: Conversation[] };
  'conversation.history': { request: { conversationId: string; afterSequence?: number; limit?: number }; response: { messages: MessageRecord[]; truncated: boolean; nextSequence: number } /* A3b: also serves archived conversations */ };
  'conversation.rename': { request: { conversationId: string; title: string }; response: Conversation };
  'conversation.archive': { request: { conversationId: string }; response: Conversation };
  'conversation.unarchive': { request: { conversationId: string }; response: Conversation };
  'conversation.delete': { request: { conversationId: string; confirmToken?: string }; response: { confirmation?: ConfirmationRequest; deleted?: true } /* §2 token flow; never touches host files, worktrees, branches or sandboxes */ };
  'conversation.export': { request: { conversationId: string; afterSequence?: number; limit?: number }; response: { format: 'sandpane.conversation-export.v1'; exportedAt: string; conversation: Conversation; messages: MessageRecord[]; truncated: boolean; nextSequence: number; redaction: { bestEffort: true; replacements: number; byKind: Record<string, number> } } /* always redacted, best-effort; messages only */ };
  'task.cancel': { request: { taskId: string }; response: { requested: boolean } };
  'task.list': { request: { projectId?: string; statuses?: TaskStatus[]; limit?: number }; response: TaskSummary[] };
  'task.subscribe': { request: { projectId?: string; taskId?: string; afterSequence?: number; afterSequences?: Record<string, number> }; response: TaskEvent[] };
  'git.review': { request: { taskId: string }; response: ChangeSet /* A5: exact NUL-parsed paths, oldPath? on renames, repoPath?, uninspected? */ };
  'git.diff': { request: { taskId: string; path: string /* byte-exact entry of the recomputed change list */; status?: FileChangeStatus; maxBytes?: number /* 1..=524288, default 262144 */ }; response: { path: string; oldPath?: string; status: FileChangeStatus; patch: string; binary: boolean; truncated: boolean; lossy: boolean; baseBlob?: string } /* A5, read-only, display-only */ };
  'git.apply': { request: { taskId: string; selectedFiles?: string[]; expectedBase: string }; response: ApplyResult };
}
```

Neither prompts nor file paths are executable commands. CLI operations are implemented as specific backend methods with strictly constructed argument arrays.

**Revision note (entry 0010, as-built).** This block was previously an "example proposed contract" of 10 methods; it now documents the **implemented** 28-method v1 surface (`docs/CHANGELOG.md` 0010; `sandbox.stop` and `sandbox.remove` added by A1 the six project lifecycle methods by A3a the five conversation lifecycle methods by A3b, the send `mode` by A4 and `git.diff` by A5 of `docs/plans/2026-10-09-protocol-v1-additions.md`; there is no `sandbox.start` because sbx v0.47 has none). Rules that keep it honest:

- **Idempotency keys (A2).** A keyed `sandbox.create` / `conversation.send` is stored durably for 24 h; a replay with identical params returns the first response plus `replayed: true` (not current state), different params or an unfinished/unknown earlier attempt give `CONFLICT` and run nothing new. Decisions: `docs/plans/2026-10-09-protocol-v1-additions.md` §3.1.
- **`PROTOCOL_VERSION` stays `1`** — the revision is additive only: new methods, new optional request fields, new response fields that are absent-tolerant (`#[serde(default)]`). Nothing was renamed or removed, so an older client's frames still parse.
- **`task.subscribe` cursor semantics** are now explicit, because one scalar `afterSequence` applied across a project-wide replay silently skips the unseen events of tasks whose per-task sequences are lower (sequences restart at 1 per task): when `taskId` is present the scalar governs and `afterSequences` is ignored; without `taskId`, each task replays from `afterSequences[taskId]` (a task absent from the map replays from 0); with no map at all the legacy shared-scalar behavior is preserved. Clients that need correct catch-up across tasks must send the map.
- **Bounded reads.** `task.list`, `conversation.list` and `conversation.history` clamp `limit` (default 200, max 500) and `conversation.history` additionally caps serialized bytes, disclosing `truncated: true` when either ceiling stopped the scan; a `task.subscribe` replay that cannot fit one IPC frame is refused with `VALIDATION_FAILED` rather than emitted oversized. Bounded responses with truncation disclosure is a §2 requirement, not a nicety.
- **Feature discovery is the client's obligation**: `system.probe` advertises the method list it actually dispatches (`CoreCapabilities.methods`), and a client must gate a call on that advertisement instead of assuming. `scripts/schema_drift.py` now compares that advertised set against the schema enum, so "handled but undiscoverable" fails the gate.
- **Known spec-vs-code deviations, still open:** `conversation.send` currently responds with a full `TaskSummary` rather than `{ taskId }`, and `ContextRef` kind `selection` has no Core-defined target grammar. Both are recorded in `docs/compatibility.md` ("Protocol v1 gaps") and are deliberately NOT silently rewritten here.

## 3. Data model

SQLite: WAL mode, foreign keys, indexed events and migrations. Store Sandpane's project/task/conversation state, not a duplicate authoritative SBX sandbox inventory. Suggested entities:

| Table | Keys and fields | Important constraint |
|---|---|---|
| `projects` | id, name, description, created_at, archived_at | user-owned; stable ID |
| `repositories` | id, project_id, canonical_path, remote_url | canonicalize before use |
| `sandbox_bindings` | id, project_id, sandbox_name, workspace_mode, repo_id, sbx_id, removed_at | SBX state always probed before actions; `sbx_id` + `removed_at` added in schema v4 — rows are marked removed, never deleted |
| `conversations` | id, project_id, title, agent_id, created_at, archived_at, sandbox_id (v6, A3b: chosen sandbox name, not a binding) | more than one per project |
| `messages` | id, conversation_id, role, content, sequence | redact or encrypt optional sensitive history |
| `agent_sessions` | id, conversation_id, provider, native_session_id, capability_snapshot | native session may be unavailable |
| `tasks` | id, conversation_id, sandbox_binding_id, repo_id, base_commit, task_branch, status, mode (v7, A4: requested send mode), chosen_sandbox_name (v7, A4: the chat's chosen sandbox name, never a binding) | each task owns exact Git context |
| `task_events` | sequence PK, task_id, kind, payload, timestamp | append-only, replayable |
| `task_artifacts` | id, task_id, kind, file_path, checksum | bounded retention |
| `verifications` | id, task_id, command_label, exit_code, output_artifact | user-approved commands |
| `presets` | id, name, configuration_json, version | no plaintext provider secrets |
| `project_context` | project_id, rules_json, approved_at | include only approved content |
| `workflows` | id, project_id, definition_json | future/opt-in |
| `client_state` | client_id, project_id, selected_conversation | UI preference only |
| `settings` | key, value, scope | carefully typed and migratable |

Indexes: `tasks(status, updated_at)`, `conversations(project_id, updated_at)`, `task_events(task_id, sequence)`, `messages(conversation_id, sequence)`.

A sandbox can serve several conversations, a conversation can contain sequential tasks, and a task points to one specific execution binding. Store task branch names separately from sandbox names.

## 4. Task lifecycle and concurrency

```text
created → queued → preparing → running → verifying → awaiting_review → completed
             │          │          │                └── rejected
             └──────────┴──────────┴── failed / cancelled / interrupted
                              ↳ awaiting_input → running (when adapter supports it)
```

Enforce state transitions in Core, not in UI. Emit every transition as a durable event **before** notifying subscribers. Store task inputs, environment binding and base Git revision before starting execution.

### Scheduler constraints

- Configurable maximum global and per-project parallel tasks.
- Default **one active writer per writable workspace**; multiple read-only conversations may share.
- Independent writers require validated separate Git worktrees, clones and/or sandboxes.
- Queue conflicts instead of allowing two agents to race on the same files.
- Cancel via provider-native API when supported; otherwise controlled process termination with timeout and process-tree cleanup.
- Clearly separate `cancel`, `stop sandbox`, `close tab`, `archive chat`, and `delete project`.
- No fictitious `pause` feature; expose only provider-supported suspension/resumption.

### Event normalization

```ts
type AgentEvent =
  | { type: 'message.delta'; text: string }
  | { type: 'tool.started'; name: string; id: string }
  | { type: 'tool.finished'; id: string; ok: boolean; summary?: string }
  | { type: 'file.changed'; path: string }
  | { type: 'approval.required'; requestId: string; description: string }
  | { type: 'task.completed'; ok: boolean }
  | { type: 'error'; code: string; message: string };
```

This is a **Sandpane** event format; never mistake it for official Docker/Codex/Claude wire schemas. Normalize only what the underlying adapter can verify; mark unsupported events explicitly.

## 5. SBX CLI adapter

- Discover a trusted `sbx` binary location; handle PATH and user override with confirmation.
- Validate installed version and supported command flags; store a tested version/capability matrix.
- Use `std::process::Command` argument vectors, no shell interpolation.
- Parse official machine-readable output when supported and confirmed for the installed version.
- Re-query SBX after mutations; avoid assuming command success means desired state reached.
- Respect sandbox lifecycle ownership: never delete a sandbox created outside Sandpane without an explicit user confirmation.
- Protect advanced actions with capability flags; present errors rather than guessing default flags.
- Add bounded subprocess timeouts; streaming log support when available; control process tree cleanup.
- Offer read-only diagnostics and redacted export; dangerous `reset` operations excluded from routine troubleshooting UI.

Commands/flags in planning docs are **illustrative**; pin real command contracts from the official CLI reference and test fixtures during Phase 0.

## 6. Agent adapter architecture

```rust
// Conceptual Rust trait; final signatures chosen during feasibility spike.
trait AgentAdapter {
    fn id(&self) -> &str;
    fn capabilities(&self) -> AgentCapabilities;
    // detect, create_session, send, cancel, resume, and stream_events
}
```

Implement per-provider compatibility:

| Adapter | First step | Do not assume |
|---|---|---|
| Codex | Validate documented Codex app-server structured protocol running **inside SBX** | Every app-server feature survives SBX transport, every session is resumable |
| Claude Code | Validate supported Agent SDK or structured headless CLI through sandbox execution | Direct SDK invocation can automatically target sandbox without a transport bridge |
| OpenCode | Validate official programmatic/headless interface | Its session/tool event semantics equal Codex's |
| Gemini CLI / Copilot CLI | Experimental adapters after documented-interface review | Universal approval/event/session formats |

For each adapter prove: auth path, setup dependencies, programmatic execution **inside** SBX, message stream, cancellation, process lifetime, session resume if advertised, tool event semantics, output bounds, path mapping, error cases and permission handling.

**Important:** `sbx run` is not itself a universal interactive chat protocol; do not scrape ANSI terminal text and call that a safe integration. An experimental proof may need a documented agent-native server or structured CLI process transported through `sbx exec`/SSH using supported SBX operations. Block GA until those exact paths are validated.

## 7. Git tasks and filesystem mappings

Supported modes:

- **Direct mount:** edits may affect host immediately. Clearly label as live writable; review cannot retroactively block edits.
- **SBX clone:** separate sandbox worktree; verify Git access, base branch, fetch/merge behavior and untracked/secret exposure.
- **Host Git worktree:** independent host directory/branch; only valid if filesystem mount and sandbox selection explicitly match that worktree.
- **Mountless:** for scratch experiments; no automatic access to host project.

Each task stores `repository_id`, `base_commit`, `task_branch`, `workspace_mode`, `sandbox_name`, and `integration_status`. Confirm clean/dirty host state before integration, and never overwrite uncommitted changes. Apply with normal Git operations, detect conflicts and show clear remediation. Temporary repos/worktrees have explicit cleanup/retention settings.

## 8. Project context, verification and files

- Repository inspection uses bounded, read-only manifest parsing and explicit user consent for running install/setup/test scripts.
- Context sources: approved project rules, current file/selection, diagnostics, specific attachments, diff ranges. Never blanket-send all file contents or credentials.
- Each `VerificationCommand` is user-approved or deliberately selected from visible project configuration; execute in selected sandbox context only.
- Capture exit code, stdout/stderr (bounded/redacted), elapsed time and report artifacts.
- `Fix error` passes exact failure and targeted files, then requires review; automated retries must have a configured ceiling.
- File browser and copy UI use verified SBX copy/exec operations and strict path validation; not essential for MVP.

## 9. Runtime/OS concerns

- Support macOS (Intel/Apple Silicon), Windows and Linux **only where Docker SBX itself supports the target setup**; do not promise universal SBX availability.
- VS Code local extension hosts vs Remote SSH/WSL containers and JetBrains remote backends require explicit host-context resolution.
- Local sockets, filesystem path canonicalization, Unicode, ownership and permissions differ across platforms.
- Avoid any untrusted code execution inside the host management process.
- Version the Core protocol independently from client applications; test one new client with an older compatible core and show upgrade instructions when incompatible.

## 10. ADRs (required decisions before coding)

1. Define service ownership, startup mechanism, auto-update/upgrade policy and idle shutdown.
2. Set concrete IPC framing, authentication, reconnect and event retention.
3. Choose first supported SBX release and record its command/JSON fixtures.
4. Prove Codex structured execution in a sandbox before committing to chat UI scope.
5. Choose Git clone/worktree policy and precise application path mapping.
6. Define privacy defaults for chat transcripts and context history.
7. Pick stable release boundaries: VS Code first, desktop and JetBrains independently.

See [06_SECURITY_AND_LICENSING.md](06_SECURITY_AND_LICENSING.md) and [08_TESTING_AND_RELEASE.md](08_TESTING_AND_RELEASE.md).
