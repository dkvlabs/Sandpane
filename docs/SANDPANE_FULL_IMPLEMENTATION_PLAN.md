# Sandpane — Complete implementation specification

**DKV Labs · 08.10.2026**

This combines the individual implementation documents into one Markdown file. See the ZIP for separately editable files.

---

# Sandpane — DKV Labs implementation package

**Version:** planning baseline 1.0 · **Date:** 08.10.2026 · **Status:** specification, not implemented

> **Sandpane:** One workspace. Every coding agent. Isolated by design.

An independent, local-first developer workspace for Docker Sandboxes (`sbx`), multi-project AI coding, persistent conversations, parallel isolated tasks, Git-safe review, and a native-feeling interface in VS Code, JetBrains IDEs, and a cross-platform desktop app.

## Read in this order

| File | Purpose |
|---|---|
| [01_MASTER_PLAN.md](01_MASTER_PLAN.md) | Product vision, capabilities, complete modules, product boundaries, acceptance criteria |
| [02_ARCHITECTURE_AND_DATA.md](02_ARCHITECTURE_AND_DATA.md) | Shared persistent core, IPC, persistence, task model, agent protocols, concurrency |
| [03_VSCODE_EXTENSION.md](03_VSCODE_EXTENSION.md) | Copilot-style VS Code integration specification |
| [04_JETBRAINS_PLUGIN.md](04_JETBRAINS_PLUGIN.md) | Native IntelliJ Platform plugin implementation |
| [05_DESKTOP_APP.md](05_DESKTOP_APP.md) | Tauri 2 cross-platform standalone application |
| [06_SECURITY_AND_LICENSING.md](06_SECURITY_AND_LICENSING.md) | License review gate, safe execution, credentials, Git and network safety |
| [07_ROADMAP_AND_TASKS.md](07_ROADMAP_AND_TASKS.md) | Ordered phases, implementation checklists, dependencies and release gates |
| [08_TESTING_AND_RELEASE.md](08_TESTING_AND_RELEASE.md) | Verification matrix, platform testing, packaging and publication |

## Explicit product boundaries

- **Not** an alternative to Docker's runtime. Docker SBX is installed and licensed separately by the user.
- **Not** a terminal embedded in an IDE. Chat and management are first-class graphical workflows; an advanced terminal is optional.
- **Not** an imitation or interception of proprietary ChatGPT, Claude Desktop, GitHub Copilot, or JetBrains AI Assistant internals.
- **Not** a universal agent API: every coding-agent adapter must independently prove streaming, cancellation, session persistence, and sandbox execution.
- **Not** a statement of Docker authorization. Public distribution requires an explicit licensing/legal review gate.

## Implementation priorities

1. Licensing + SBX/agent feasibility spikes.
2. Shared Rust core service and SQLite-backed multi-project/session models.
3. VS Code extension with Codex, task isolation, and change review.
4. Standalone desktop app and native-app SSH connection wizard.
5. JetBrains plugin.
6. More agent adapters, full supported SBX management, and automation.

Each client can ship and version independently, while sharing a versioned core protocol.

## Primary references to validate against when implementing

- Docker SBX CLI: https://docs.docker.com/reference/cli/sbx/
- Docker Sandboxes workflows: https://docs.docker.com/ai/sandboxes/
- Docker editor/native-app connections: https://docs.docker.com/ai/sandboxes/integrations/
- Docker license terms: https://www.docker.com/legal/docker-subscription-service-agreement/
- VS Code extension guides: https://code.visualstudio.com/api
- JetBrains IntelliJ Platform SDK: https://plugins.jetbrains.com/docs/intellij/welcome.html
- Tauri v2: https://v2.tauri.app/
- Codex app-server documentation: https://developers.openai.com/codex/app-server/
- Claude Agent SDK: https://platform.claude.com/docs/en/agent-sdk/overview

**Keep a verified compatibility matrix with exact CLI/IDE/agent versions.** This is a design plan; examples are not proof that every discussed command or adapter works with every future release.


---

# Sandpane — Master implementation plan

**Publisher:** DKV Labs  
**Date:** 08.10.2026  
**Scope:** VS Code extension + JetBrains plugin + standalone desktop application + shared core  
**Proposed license:** MIT for original Sandpane code, subject to dependency/redistribution review  
**Status:** implementation specification; no implementation or licensing approval implied

## 1. Vision and target outcome

Sandpane is an open-source, local-first **AI development workspace and Docker Sandboxes manager**. Developers can create isolated environments, open several projects, run multiple coding-agent chats at once, inspect agent activity, verify results, and merge approved changes into Git — from VS Code, JetBrains, or a standalone app.

**The primary flow:** Open project → Detect stack → Pick agent → Create isolated SBX environment → Start chat/task → Watch real execution → Run tests → Review diff → Apply approved changes.

**Success is measured in reduced context-switching and safer code changes**, not the number of buttons covering the SBX CLI.

### Nonnegotiable principles

1. **Single source of truth:** Docker SBX owns sandboxes; Sandpane stores project/task metadata and maps names to environments.
2. **Local-first:** no required Sandpane cloud service, proxy, or account. Existing Docker and agent authentication stays with those products.
3. **Native-feeling UX:** graphical chat, IDE selections, diagnostics, diff review, previews. No terminal as the main interaction surface.
4. **Agent-neutral, not agent-magical:** capability-gated adapters, no scraping terminal UI or guessing proprietary APIs.
5. **Concurrent with isolation:** multiple chats can share a sandbox for analysis; independent writable tasks need dedicated clones/worktrees/sandboxes.
6. **Reviewable:** show actual Git changes and verification status; never claim safety for edits already applied to a direct-mounted host directory.
7. **Recoverable:** keep conversations and task events; recover provider-native sessions only when supported; reconcile real processes after restarts.
8. **Respect licensing:** independently written code, official public interfaces, no bundled proprietary SBX binaries, written clearance before public release where required.

## 2. Three client products, one engine

| Client | User experience | Primary differentiation |
|---|---|---|
| **Sandpane for VS Code** | Sidebar with Copilot-style chat, multiple conversations, sandbox picker, code context, native diff/review | No terminal interaction required; integrated with editor |
| **Sandpane for JetBrains** | Native Tool Window with chat, active inspections, file/selection actions, IDE diffs | Uses public IntelliJ Platform APIs and Kotlin client |
| **Sandpane Desktop** | Project cockpit, global activity dashboard, sandbox/integration administration, optional multiple windows | Project and agent orchestration independent of any IDE |

All connect to a **single persistent per-user Sandpane Core** over authenticated local IPC. Clients attach/detach from running tasks without becoming those tasks' process parents.

## 3. Project hierarchy and multi-chat behavior

The following project names are fictional examples only: **Atlas Demo**, **Nova Demo**, and **Orbit Demo**. Do not expose real customer or internal projects in public documentation.

```text
Sandpane
├── Atlas Demo [project]
│   ├── frontend/ [repository]
│   ├── backend/ [repository]
│   ├── auth-sandbox [isolated environment]
│   │   └── Conversation: Implement authentication → Task 001
│   ├── qa-sandbox [isolated environment]
│   │   └── Conversation: Check API correctness → Task 002
│   └── Conversation: Architecture questions [read-only/shared env]
├── Nova Demo
│   ├── ingest-sandbox → Conversation: Import pipeline
│   └── search-sandbox → Conversation: Optimize search
└── Orbit Demo website
    └── web-sandbox → Conversation: Animate hero
```

**Required behaviors:** unlimited *stored* projects/chats (subject to disk storage), concurrent active agents bounded by machine/provider limits, separate UI tabs, fast project switching, no task cancellation on tab close, task and event replay across clients, archived histories, accurate running/failed/interrupted states, and explicit per-task branch/environment linkage.

### Conversation vs task vs process

- **Conversation:** durable user/agent message history owned by Sandpane.
- **Provider session:** agent-specific native thread ID; may have constraints and may not survive all kinds of exits.
- **Task:** a tracked unit of work linked to a conversation, Git worktree/branch, sandbox, and verification results.
- **Process:** an OS child process supervised by Core; can disappear even if its task record remains.

Never equate stored messages with live process continuation. Closing VS Code may leave a task running **only if** the persistent core service and provider process remain alive.

## 4. Product modules and priorities

| ID | Module | P0 / minimum | Follow-on |
|---|---|---|---|
| A | **Project cockpit** | Project CRUD, repos, context, selected agent/sandbox, recent activity | Multi-repo groups, global search, presets |
| B | **Sandbox manager** | Detect SBX/daemon, list/create/start/stop/delete, inspect | Advanced creation, mounts, policies, templates, MCP, secrets, diagnostics |
| C | **Copilot-style chat** | Codex structured chat adapter, streaming, stop, tabs, saved messages | Claude/OpenCode/Gemini adapters, session fork if truly supported |
| D | **Parallel tasks** | Queue, max-concurrency, events, recovery, separate write environments | Task dependencies, priorities, agent handoffs |
| E | **Git-safe coding** | Clone/worktree selection, actual status/diff, apply/discard with confirmation | Selective hunks, conflicts, commits, PR/MR |
| F | **Project context** | Approved project rules, active file and selection, explicit attachments | Stack detection, diagnostics context, context budgets |
| G | **Verification and repair** | Configured tests/build/lint, captured results, manual retry | Bounded auto-fix loop, test summaries |
| H | **App preview** | Ports and local URLs via supported mechanisms | Browser automation, Playwright artifacts |
| I | **MCP/skills/agent setup** | Inventory and supported configured add/auth/remove | Guided MCP discovery, experimental kits/skills gated |
| J | **Policies/secrets/resources** | Network rules/logs, credentials *presence*, basic resource settings | Denied-request helper, telemetry only where verified |
| K | **Native app connections** | Guided ChatGPT/Claude Desktop and editor SSH setup | One-click open only with documented launcher support |
| L | **Templates and environments** | List/save/load verified SBX templates | Env presets, declarative config, import/export |
| M | **Workflow automation** | Not in initial MVP | Implement → lint → test → diff → review, parallel subtasks |
| N | **Global activity** | Running/queued/completed/error tasks, notifications | Cross-project analytics and saved filters |

## 5. High-value end-user workflows

### W1 — First run and one-click environment

1. Detect `sbx` executable/version, daemon, installation state, Git and agent availability.
2. Show missing dependencies with links to official installation instructions; **do not silently install or download SBX**.
3. Select a workspace folder/repository; inspect read-only manifests for a proposed stack.
4. Offer Quick Create (agent, project, isolation mode) and Advanced Create (only supported flags/settings).
5. Explain filesystem/credential access, network defaults, and any billable/experimental operation before proceeding.
6. Create sandbox; report actual CLI status and errors; open project cockpit/chat.

### W2 — Multiple chats in one project

1. User selects Atlas Demo, opens `Auth` and `Billing` conversations in different tabs.
2. An analysis-only conversation may share a sandbox when it does not modify code.
3. For parallel writable tasks Sandpane creates separate Git branches/worktrees/clones and dedicated sandbox bindings.
4. The global dashboard lists independent task status; switching tabs never kills tasks.
5. Each chat shows its sandbox, agent, branch and changed-file state.

### W3 — Safe code generation and review

1. Create isolated task branch/worktree (or SBX clone mode after validating data flow).
2. Start agent with authorized context; stream messages/events and record edits.
3. Run declared tests/lint/build; show logs, errors, and artifacts.
4. Compare output against task base revision; provide native IDE or desktop diff.
5. Show possible merge conflicts and unexpected untracked files.
6. Apply approved changes using an explicit Git operation (not a silent file overwrite); offer commit/PR only on request.

### W4 — One-click error fixing

1. User selects failed test/build record or editor diagnostic.
2. Sandpane assembles a bounded context payload excluding secrets.
3. Agent proposes and applies a change inside isolated task environment.
4. Rerun selected verification; cap retries, preserve all outcomes.
5. User reviews Git diff before integrating.

### W5 — Open native ChatGPT/Claude application

1. Choose project sandbox and preferred application.
2. Verify compatible SBX version and supported SSH integration.
3. Use official `sbx setup ssh` workflow where applicable, verify sandbox-specific hostname.
4. Present application-specific steps and clearly describe any credential-forwarding concerns.
5. Launch application **only** using documented OS/application mechanisms. No unsupported manipulation of app settings.
6. Explicitly state Sandpane cannot retrieve private native-app chat history.

### W6 — Agent handoff

1. Export a user-approved task summary, relevant changed files and constraints.
2. Start a **new** provider session in another isolated sandbox, if needed.
3. Send approved context and reference relevant Git revisions.
4. Never claim cross-provider transfer of private native session identifiers/history.

## 6. UX information architecture

```text
Sandpane
├── Dashboard / Global Activity
├── Projects
│   ├── Repositories
│   ├── Chats [tabs; per conversation agent/sandbox/branch]
│   ├── Tasks & Review
│   ├── Preview & Tests
│   └── Context & Settings
├── Sandboxes [list/create/details/start/stop/delete]
├── Agents & Sessions
├── Templates & Presets
├── MCP, Skills & Secrets
├── Policies, Ports & Diagnostics
├── Application Connections
└── Settings
```

Desktop uses this full IA. IDE plugins compress it into a primary chat Tool Window/sidebar with a project dropdown, chat tabs, task details and links to native diff/IDE surfaces.

## 7. Suggested initial MVP

**Target:** first useful, testable release for local desktop VS Code; not all providers or all platforms.

- Project list and local repository associations.
- SBX install/daemon/version checks; sandbox CRUD and clear confirmations.
- One proven agent (Codex), structured streamed chat, multi-chat history.
- Multiple projects and isolated simultaneous tasks with configured queue limit.
- Durable task events, reconnect, precise failed/interrupted reporting.
- Actual Git status/diff, integration into VS Code diff and safe apply.
- User-controlled source-file/selection context.
- Tests/build output and a clear completed/review state.
- Security controls, no credential scraping, no unvalidated remote command arguments.

**Explicitly not MVP:** cloud SBX API, free-form automation, all agent providers, native ChatGPT history sync, unverified agent pause/fork, JCEF-only features, a general Docker Desktop replacement, or an app-hosted full IDE/editor.

## 8. Success and release gates

Functional: two projects; three conversations; two isolated writable tasks; switch clients; resume event stream; run verification; review and integrate a real diff; stop/delete sandboxes with confirmation.

Safety: no cross-project modification; no unauthorized local-IPC access; no unintended secret exposure; no shell injection; no destructive host Git operation without consent.

Reliability: correct task reconciliation after process/service crash; idempotent client reconnection; accurate version capability gating; clean migration path and uninstall behavior.

Go to [02_ARCHITECTURE_AND_DATA.md](02_ARCHITECTURE_AND_DATA.md) for implementation contracts and [07_ROADMAP_AND_TASKS.md](07_ROADMAP_AND_TASKS.md) for the delivery sequence.


---

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

Example proposed contract:

```ts
interface SandpaneRpc {
  'system.probe': { request: {}; response: CoreCapabilities };
  'project.create': { request: { name: string; repositories: string[] }; response: Project };
  'sandbox.list': { request: {}; response: SandboxSummary[] };
  'sandbox.create': { request: SandboxCreateSpec; response: SandboxSummary };
  'conversation.create': { request: { projectId: string; agentId: string; sandboxId?: string }; response: Conversation };
  'conversation.send': { request: { conversationId: string; content: string; attachments?: ContextRef[] }; response: { taskId: string } };
  'task.cancel': { request: { taskId: string }; response: { requested: boolean } };
  'task.subscribe': { request: { projectId?: string; afterSequence?: number }; response: TaskEvent[] };
  'git.review': { request: { taskId: string }; response: ChangeSet };
  'git.apply': { request: { taskId: string; selectedFiles?: string[]; expectedBase: string }; response: ApplyResult };
}
```

Neither prompts nor file paths are executable commands. CLI operations are implemented as specific backend methods with strictly constructed argument arrays.

## 3. Data model

SQLite: WAL mode, foreign keys, indexed events and migrations. Store Sandpane's project/task/conversation state, not a duplicate authoritative SBX sandbox inventory. Suggested entities:

| Table | Keys and fields | Important constraint |
|---|---|---|
| `projects` | id, name, description, created_at, archived_at | user-owned; stable ID |
| `repositories` | id, project_id, canonical_path, remote_url | canonicalize before use |
| `sandbox_bindings` | id, project_id, sandbox_name, workspace_mode, repo_id | SBX state always probed before actions |
| `conversations` | id, project_id, title, agent_id, created_at, archived_at | more than one per project |
| `messages` | id, conversation_id, role, content, sequence | redact or encrypt optional sensitive history |
| `agent_sessions` | id, conversation_id, provider, native_session_id, capability_snapshot | native session may be unavailable |
| `tasks` | id, conversation_id, sandbox_binding_id, repo_id, base_commit, task_branch, status | each task owns exact Git context |
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


---

# Sandpane for VS Code — implementation specification

**Stack:** TypeScript, VS Code Extension API, React + Tailwind + shadcn/ui (webview), Sandpane Core TS client.  
**Primary surface:** custom Copilot-style sidebar, **not a terminal**.  
**Dependency:** [02_ARCHITECTURE_AND_DATA.md](02_ARCHITECTURE_AND_DATA.md).

## 1. User experience contract

```text
┌── VS Code editor ─────────────┐┌── Sandpane sidebar ────────────────────┐
│ AuthService.ts                ││ Atlas Demo                ● Core online  │
│                               ││ Sandbox: auth-codex        [Change]   │
│ editor, diagnostics, Git diff ││ Agent: Codex                            │
│                               ││ [Auth] [API Review] [+ Chat]           │
│                               ││                                      │
│                               ││ You: implement refresh tokens        │
│                               ││ Agent: checking existing auth code…  │
│                               ││ ✓ 3 files edited · tests: running    │
│                               ││ [View Changes] [Open Preview]        │
│                               ││                                      │
│                               ││ [selection.ts ×] [diagnostics ×]    │
│                               ││ Ask the agent…               [Send]  │
└───────────────────────────────┘└──────────────────────────────────────┘
```

Every task and chat always shows its **project, agent, sandbox, workspace mode and Git branch**. Multiple tabs/conversations must not imply multiple agent processes share the same writable files.

### Screens / views

- Dedicated Activity Bar icon and Sandpane sidebar.
- Projects / chats navigation (responsive compact list, search, recent tabs).
- Chat composer with context attachments, streaming output, tool activity and stop action.
- Sandbox dropdown, quick-create wizard, detail panel and start/stop/delete actions.
- Task status and changed-files summary with commands to open native diffs.
- Global activity view accessible through the command palette; optional editor panel for broader dashboard.
- Settings / troubleshooting with SBX + Core + agent capability probes.
- Native Chat participant / LM tool integration is a **separate optional P2 adapter**, not required for independent chat.

## 2. Extension implementation

### Supported APIs

- `viewsContainers.activitybar` and `views` to register Sandpane navigation.
- `WebviewViewProvider` for React chat with strict Content Security Policy and structured message bridge.
- `TreeDataProvider` if needed for lightweight project list; avoid duplicate navigation UIs.
- `window.activeTextEditor`, selection/document APIs for context attachments.
- `languages.getDiagnostics` / diagnostics listeners for error context with explicit consent.
- `workspace.workspaceFolders`, `workspace.fs`, `window.showOpenDialog` for repository associations.
- `commands.executeCommand('vscode.diff', ...)` and `window.showTextDocument` for change inspection (with real Git revisions/URIs).
- `globalState` / `workspaceState` for client UI state; messages/tasks persist in Core, not extension-only storage.
- `SecretStorage` only for keys created explicitly for Sandpane integrations (if ever). Do not scrape Docker/Codex/Claude credentials.

### Extension ⇄ Core integration

1. At activation probe the local Sandpane Core process and version.
2. Start/upgrade the **Sandpane-owned** service only under an agreed installation/ownership policy.
3. Negotiate capabilities and load projects; show clear offline/configuration states.
4. Subscribe to durable events with last acknowledged sequence ID.
5. Use typed Core API for all SBX/agent actions. No direct arbitrary command execution from webview.
6. Handle window dispose by unsubscribing UI, **not cancelling tasks**.

Remote VS Code hosts: detect `env.remoteName`/workspace scheme/extension host location. v0.1 supports only the verified local-host setup. Show an explicit unsupported-state explanation instead of executing a local SBX command against a remote path.

### Suggested VS Code manifest (outline only)

```json
{
  "name": "sandpane",
  "displayName": "Sandpane",
  "publisher": "dkv-labs",
  "main": "./dist/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "sandpane", "title": "Sandpane", "icon": "media/sandpane.svg" }]
    },
    "views": {
      "sandpane": [{ "id": "sandpane.chat", "name": "Projects & Chats", "type": "webview" }]
    },
    "commands": [
      { "command": "sandpane.newChat", "title": "Sandpane: New Chat" },
      { "command": "sandpane.createSandbox", "title": "Sandpane: Create Sandbox" },
      { "command": "sandpane.sendSelection", "title": "Sandpane: Add Selection to Chat" },
      { "command": "sandpane.reviewTask", "title": "Sandpane: Review Task Changes" }
    ]
  }
}
```

Set the exact `engines.vscode` / SDK versions after consulting the targeted VS Code release. Do not copy manifest fragments as a complete publishable manifest.

## 3. UI state and component breakdown

```text
src/
├── extension.ts
├── core-client/{connection,events,commands}.ts
├── vscode/{context,diagnostics,diff,workspaces}.ts
└── webview/
    ├── App.tsx
    ├── views/{ProjectList,Conversation,Activity,Settings}.tsx
    ├── components/{ChatTabs,MessageStream,Composer,ToolTimeline,TaskBadge,ChangeList}.tsx
    ├── dialogs/{SandboxWizard,DeleteConfirm,GitApplyConfirm}.tsx
    └── state/{query,ui}.ts
```

Chat UI rules:
- Mobile-width/narrow-sidebar usable (vertical tab list or dropdown at very narrow widths).
- Keyboard navigation, screen-reader announcements for new messages, theme tokens instead of hardcoded colors.
- Markdown/code output sanitized; no uncontrolled HTML rendering, remote scripts or untrusted links with custom schemes.
- Streaming with throttled repaint/batching so large event streams do not freeze the extension.
- Persistent task progress belongs to Core. React Query stores cached server state; Zustand or component state stores only ephemeral UI preferences.

## 4. Feature details and acceptance

| Feature | Implementation | Acceptance |
|---|---|---|
| Create/select project | Core projects + workspace folder association | Reopening VS Code selects correct project without duplication |
| Multi-chat tabs | Core conversations + client tab preferences | Switching a tab doesn't stop agent |
| Prompt streaming | Codex adapter through Core | Distinguishable user/agent/tool events; cancellation works |
| Context attachment | Explicit selection, active file, diagnostics | Shows every attachment before sending; secret exclusions respected |
| Sandbox lifecycle | Typed Core methods → supported SBX commands | Existing sandboxes visible, operations confirmed/reconciled |
| Parallel tasks | Core scheduler; isolated workspace | Two writable tasks can run without editing same working tree |
| Diff review | Core Git change set + `vscode.diff` | Actual base/target files and untracked changes visible |
| Apply changes | Core validated Git merge/patch action | Conflicting host edits never overwritten silently |
| Tests | Core verification events | Exit code and log shown, no fabricated pass status |
| Reconnection | Sequence catch-up | VS Code reload doesn't duplicate the running task |
| Status | Version/daemon/agent errors | Missing SBX results in actionable install instructions |

### Context actions

- **Sandpane: Explain Selection** → attach selected code, ask question; default read-only task.
- **Sandpane: Refactor Selection** → prepare isolated writable task.
- **Sandpane: Fix Current Problems** → summarize selected diagnostics and ask for a scoped fix.
- **Sandpane: Add File to Chat** → attach file path/content within approved size and security policy.
- **Sandpane: Review Active Task** → open native diff/review UI.

Do not run arbitrary code based solely on a text selection. User confirmation must distinguish discussion from writable task execution.

## 5. Versioned deliverables

### VS0 — Wiring and probe
- [ ] Scaffold extension, lint/tests, VS Code test runner.
- [ ] Detect Core/CLI; display status and errors.
- [ ] Show project/sandbox list using real Core data.

### VS1 — Sandbox management
- [ ] Quick-create wizard, sandbox name validation.
- [ ] Start/stop/delete with explicit confirmation.
- [ ] Bind local project workspace correctly.

### VS2 — Chat and multi-project
- [ ] Codex feasibility gate passed inside SBX.
- [ ] Chat tabs, streaming messages, activity, cancellation.
- [ ] Event replay and open-in-another-window behavior.

### VS3 — Coding integration
- [ ] Selection/file/diagnostic context.
- [ ] Task Git diff, verification and approved apply.
- [ ] App preview and network access links.

### VS4 — Polish + publishing
- [ ] Narrow layout and accessibility audit.
- [ ] CSP, output sanitization and adversarial input tests.
- [ ] Local/remote extension-host constraints documented.
- [ ] `.vsix`, Marketplace/Open VSX metadata subject to their publication terms.

## 6. Integration tests

1. Create two projects, open three chats and keep two tasks running while switching tabs.
2. Close/reopen VS Code; new UI catches up from Core event checkpoint.
3. Open a second VS Code window; both show same task state without duplicate process.
4. Send a selection with spaces/Unicode/newlines; Core receives exact content without shell execution.
5. Attempt to apply changes with dirty host files; require safe conflict/abort.
6. Stop a sandbox with active tasks; warn and define cancellation implications.
7. Disable/omit Codex adapter; chat shows unsupported explanation rather than falling back to terminal scrape.
8. Open in unsupported remote host; do not bind wrong filesystem.

## 7. References

- https://code.visualstudio.com/api/extension-guides/webview
- https://code.visualstudio.com/api/extension-guides/tree-view
- https://code.visualstudio.com/api/extension-guides/ai/chat
- https://docs.docker.com/ai/sandboxes/integrations/


---

# Sandpane for JetBrains — implementation specification

**Stack:** Kotlin, IntelliJ Platform SDK, Gradle IntelliJ Platform Plugin 2.x, native Tool Window UI, typed local Core RPC client.  
**Principle:** a **native-feeling Copilot-style assistant**, not a terminal; use supported public IntelliJ APIs only.

## 1. Product scope

Deliver one plugin targeting a verified compatible baseline of IntelliJ IDEA, then test and expand to PyCharm, WebStorm and PhpStorm. Other JetBrains IDEs (Android Studio, Rider, GoLand, CLion, etc.) require their own compatibility checks. Cross-IDE support is never assumed automatically.

### Main window

```text
IDE editor / project tree            | SANDPANE Tool Window
-------------------------------------+----------------------------------
AuthService.kt                       | Project: Atlas Demo               
IDE code editor + diagnostics        | Sandbox: atlas-auth ●        
                                     | [Auth] [Architecture] [+]      
                                     | You: fix token refresh         
                                     | Codex: inspecting service…     
                                     | ✓ test completed               
                                     | Files: AuthService.kt          
                                     | [Open IDE Diff]                
                                     | [Selection ×] [Send]           
```

Allow users to create/select project, sandbox, agent and chat, send editor context, inspect the actual agent activity, run verification, and review/merge changes without opening a terminal.

## 2. Plugin architecture

- Plugin descriptor `META-INF/plugin.xml`: Tool Window registered through public IntelliJ extension points; actions for editor selection/file context; settings configurable.
- `ToolWindowFactory`: native Swing/IntelliJ components by default; a tabbed chat UI and conversation list.
- JCEF optional for rich Markdown/code rendering **only** if supported by the current IDE runtime, with a native Swing fallback.
- Application-scoped service for Core process connectivity; project-scoped service for repository bindings and selected conversation.
- Kotlin coroutines or sanctioned background task APIs; never block Event Dispatch Thread (EDT) with IPC, SBX or Git operations.
- IntelliJ `PersistentStateComponent` for client UI settings only; shared projects/tasks/messages live in Sandpane Core.
- Plugin should not bundle Docker SBX or vendor credentials. Optionally bundle an **independently written Sandpane Core launcher** under an agreed multi-client service/version model.

### Module layout

```text
jetbrains/
├── build.gradle.kts
├── src/main/resources/META-INF/plugin.xml
└── src/main/kotlin/.../sandpane/
    ├── SandpaneToolWindowFactory.kt
    ├── core/{CoreClient,ConnectionManager,EventStream}.kt
    ├── models/{Projects,Chats,Tasks,Sandboxes}.kt
    ├── ui/{ToolWindowPanel,ChatPanel,ProjectPanel,TaskPanel,SettingsPanel}.kt
    ├── actions/{ExplainSelection,RefactorSelection,FixDiagnostics,ReviewChanges}.kt
    ├── ide/{ProjectContext,DiagnosticsProvider,GitDiffProvider}.kt
    └── services/{ProjectSessionService,CoreApplicationService}.kt
```

### Lifecycle

1. Connect to local per-user Core at IDE startup/on Tool Window activation.
2. Negotiate protocol version and load project/sandbox snapshot.
3. Subscribe to events with last seen sequence; render as chat/timeline.
4. Dispose UI subscriptions on project close **without terminating shared tasks**.
5. If Core unavailable show a self-contained recover/installation path.
6. If project is remote, check where the IDE backend executes and where the selected folder exists. Disallow unsupported cross-host path mapping.

## 3. IDE integration with explicit authorization

| Use case | IntelliJ responsibility | Core responsibility |
|---|---|---|
| Explain selection | Capture selected text with safe read actions | Attach to read-only conversation |
| Refactor method | Capture file/revision/selection and scope | Create isolated writable task |
| Fix inspection | Read bounded diagnostics and file context | Run verified agent adapter and configured tests |
| Review changes | Native Diff API and file navigation | Provide real Git base/target content and change sets |
| Manage project | Resolve correct project root/modules | Map project to sandbox/worktree |
| Show activity | Tool Window event rendering | Real state transitions and replay |

Use documented project/editor/VFS APIs, obey read/write action rules, and never use internal or private JetBrains AI Assistant interfaces. Respect dumb/indexing mode: avoid slow indexing-dependent operations on EDT and disable actions when context is unavailable.

Git review: call Core to produce a verified change set; use the IDE's public diff APIs for display. Direct-mount changes are already on disk, so UI must not imply they are still safely pending.

## 4. Supported feature releases

### JB0 — Platform viability
- [ ] Select exact IDE baseline, JDK, Kotlin and Gradle versions from current plugin SDK docs.
- [ ] Scaffold plugin; run in sandbox IDE; configure Plugin Verifier.
- [ ] Implement Tool Window, navigation and Core connection.
- [ ] Display live project and sandbox list.

### JB1 — Basic management
- [ ] Create/list/start/stop/delete sandboxes.
- [ ] Associate project root with sandbox and show warnings on writable mounts.
- [ ] Display capability limitations if installed SBX version differs.

### JB2 — Chat / multiple conversations
- [ ] Chat tabs, structured Codex streaming, agent activity, cancellation.
- [ ] Conversation persistence and task event replay.
- [ ] Show selected sandbox/branch/agent in every chat.
- [ ] Project switching and multiple IDE-window state sync.

### JB3 — Coding workflows
- [ ] Selection and active file context actions.
- [ ] Inspection/error-to-agent actions.
- [ ] Native diffs for changed code and safe apply through Core.
- [ ] Verification runs and review status.
- [ ] Open preview URLs in supported browser action.

### JB4 — Stabilization and publication
- [ ] Validate Swing/JCEF accessibility, theme changes and Markdown safety.
- [ ] Test IDEA, PyCharm, WebStorm, PhpStorm against declared compatibility range.
- [ ] Test remote development/WSL path handling or mark as unsupported.
- [ ] Run Plugin Verifier and end-to-end scenario tests.
- [ ] Build signed plugin ZIP and prepare JetBrains Marketplace listing.

## 5. Key technical risks

1. **Remote IntelliJ environments:** the plugin may execute on a different host than the visible UI. Resolve actual backend paths and Core location.
2. **UI rendering:** large streamed chats can overwhelm EDT; batch event updates and cap retained in-memory view models.
3. **JCEF availability:** do not make JCEF a hard requirement unless tested and explicitly supported.
4. **Plugin classloader/API differences:** target public SDK and verify each IDE build.
5. **Service ownership:** IDE project close must not stop an agent launched by another Sandpane client.
6. **Kotlin protocol drift:** generate client types from versioned schemas; test against older/newer Core.

## 6. Acceptance tests

- Install and activate tool window on the declared baseline IDE without deprecated/private APIs.
- Link two projects; create multiple chats; stream real agent events.
- Run two isolated tasks without cross-repository writes.
- Review a real changed file with the IDE's native diff UI.
- Resume chat display after closing/reopening project; accurate interrupted statuses.
- Ctrl/⌘ keybindings do not conflict with common IDE actions.
- Graceful unsupported state when Core/SBX/path mapping is unavailable.

## 7. References

- https://plugins.jetbrains.com/docs/intellij/welcome.html
- https://plugins.jetbrains.com/docs/intellij/tool-windows.html
- https://plugins.jetbrains.com/docs/intellij/plugin-configuration-file.html
- https://plugins.jetbrains.com/docs/intellij/verifying-plugin-compatibility.html


---

# Sandpane Desktop — standalone cross-platform implementation

**Stack:** Tauri 2 + React + TypeScript + Tailwind + shadcn/ui + Rust Core client/service.  
**Target:** macOS, Windows, Linux where Docker SBX is itself supported.  
**Role:** Sandpane's multi-project control center, not a competing Docker runtime and not a full IDE.

## 1. Primary experience

```text
┌────────────────────────────────────────────────────────────────────┐
│ Sandpane                                     ● Core / SBX Ready    │
├───────────────────┬────────────────────────────────────────────────┤
│ Projects          │ [Auth] [Payments] [Search] [+ New Chat]        │
│ ▾ Atlas Demo      │ Agent: Codex · Sandbox: auth · git: auth-task  │
│   ● Auth          │                                                │
│   ● Payments      │ Agent activity and conversational chat         │
│ ▾ Nova Demo       │ ✓ inspected repo · ✓ implemented · ● tests     │
│   ● Search        │                                                │
│                   │ Changed files [Review]    Preview [Open]       │
│ Activity          │                                                │
│ Sandboxes         │ Compose message…                        Send   │
│ Agents            │                                                │
│ MCP & Policies    │                                                │
│ Connections       │                                                │
│ Settings          │                                                │
├───────────────────┴────────────────────────────────────────────────┤
│ Running 3 · Queued 1 · Review needed 2 · Failed 0                  │
└────────────────────────────────────────────────────────────────────┘
```

### Navigation

- **Dashboard:** global running tasks, approvals, errors, upcoming review work.
- **Projects:** project cockpit, grouped repositories, chats, context profile, task history.
- **Chats:** Copilot-style streaming with tabs, agent/sandbox/branch info, file/task event timeline.
- **Tasks & Review:** test results, actual Git diff, apply/discard, branch conflicts.
- **Sandboxes:** list, create, start/stop/delete, settings, resource and network views.
- **Agents:** capability, auth status, presets, supported session operations.
- **Integrations:** MCP, skills, templates, policies, secrets, native app connections.
- **Settings:** local Core, SBX detection, theme, notifications, privacy, diagnostics.

## 2. Technical architecture

- Tauri 2 runs an independently written client UI; Rust/Tauri communicates with **the same persistent per-user Sandpane Core** used by VS Code and JetBrains.
- Desktop cannot spawn a second competing Core instance. Use single-instance coordination and Core handshake/version negotiation.
- Do not reimplement project/task business logic in Tauri handlers. Tauri commands should be a narrow typed client or be replaced by the shared core library only if service state ownership is preserved.
- React Query for server/cache state, optional Zustand for UI-only state, React Router or equivalent for navigation.
- Use shadcn/ui with theme tokens, keyboard navigation, virtualized message lists, and responsive panels.
- Use Tauri file picker for local repositories, native OS notifications for completion/review, and open-external for approved safe URLs.
- Never expose generic shell command execution to the webview. Use small, explicit Tauri capabilities and CSP.
- Chat/Git task metadata belongs in shared SQLite; UI preferences belong in Tauri's appropriate user app config store.
- Support multiple windows only after confirming synced navigation/cached state and no duplicate process launches.

### Directory sketch

```text
apps/desktop/
├── src/
│   ├── app/{routes,providers}
│   ├── components/{layout,chat,project,sandbox,review}
│   ├── features/{dashboard,projects,tasks,agents,templates,connections,settings}
│   ├── lib/core-client.ts
│   └── stores/ui.ts
└── src-tauri/
    ├── src/{main,ipc_client,dialogs,notifications}.rs
    ├── capabilities/
    └── tauri.conf.json
```

## 3. Functional modules

### A. Dashboard + multi-project conversations (P0)
- Multiple project cards, pinned favorites, recent work.
- Multi-repository project groups and per-project tabs.
- New conversation with agent selection and workspace mode.
- Active tasks continue when opening another chat or minimizing app.
- Search and archive Sandpane-owned chat history; export on request.
- Show exact provider-native session recovery capability and current process status.
- Global activity: running, queued, completed, needs review, errors.

### B. Sandbox wizard and lifecycle (P0)
- Detect SBX, verify CLI version and daemon.
- Quick Create: name, project/workspace and agent; recommended safe isolation mode.
- Advanced Create: supported mount/clone/template/resource/policy settings, only after feature detection.
- List/detail/start/stop/remove with state reconciliation, confirmations and meaningful errors.
- Surface manual install and authenticate steps, not hidden bundled Docker binaries.

### C. Task review and developer workflows (P0/P1)
- Show real changed files with before/after and Git status.
- Native-feeling side-by-side diff; optional open in preferred IDE.
- Selective apply where implementation supports conflict-safe Git operations.
- Verification history, exit codes, output and review checklist.
- Configure approved build/test/lint commands; one-click retry or explicit Fix with Agent.
- Never silently write into unrelated host project directories.

### D. Network/ports/templates/MCP/secrets (P1)
- Sandbox-specific network policies and denied-request explanations.
- Publish/unpublish ports via verified SBX commands, default localhost.
- Saved SBX templates, load/export/remove with correct lifecycle limitations.
- MCP add/list/inspect/authorize/load/remove where supported.
- Secret names/status only; registration/removal through official mechanisms without displaying stored values.
- Skills/kits when supported and gated by installed SBX version.

### E. Native application connection wizard (P1)
- User selects sandbox and ChatGPT Desktop, Claude Desktop, VS Code or supported editor.
- Sandpane checks documented SSH integration availability and tests endpoint.
- Present correct hostname/manual configuration instructions.
- Detect native app installation where allowed; open app using documented launch mechanism only.
- Warn about credential exposure and **do not access external apps' private chat histories**.

### F. Optional terminal and file transfer (P2)
- Optional terminal as an advanced drawer, never required to navigate Sandpane.
- Use PTY with proper child-process ownership/cleanup and bounded log streams.
- Copy files via supported sandbox file transfer commands.
- Warn before transferring credentials or writing outside approved sandbox paths.

## 4. Delivery plan

### DT0 — App shell
- [ ] Create Tauri app, React layout, theme and accessible navigation.
- [ ] Core connection client, health probe and version negotiation.
- [ ] Handle missing SBX gracefully, no placeholder success screens.

### DT1 — Real project/task UI
- [ ] Project list, repositories, chat tabs, streaming task events.
- [ ] Persist only UI selection locally; load real state from shared Core.
- [ ] Global active task dashboard and notification preferences.
- [ ] Reconnect after Core/UI restart with sequence replay.

### DT2 — Sandbox operations
- [ ] Quick-create and advanced wizard with capability filtering.
- [ ] List/details/lifecycle and confirmation.
- [ ] Link project to exact sandbox and Git context.

### DT3 — Safe changes
- [ ] Real Git status/diff/changes viewer.
- [ ] Conflict-safe apply and sandbox cleanup decisions.
- [ ] Test/build logs and verification status.

### DT4 — Integration modules
- [ ] Network, ports, templates, MCP, secret status, diagnostics.
- [ ] Native-app connection wizard and SSH setup checks.
- [ ] Export redacted diagnostics and import/export safe presets.

### DT5 — Release hardening
- [ ] Multi-window consistency and process ownership tests.
- [ ] macOS/Windows/Linux path, socket and installer tests.
- [ ] Native notifications, keyboard accessibility, dark/light mode.
- [ ] Code signing/notarization where required or available.
- [ ] Document Core/SBX prerequisites and troubleshooting.

## 5. Important decisions

- One persistent Core for all clients; **not** a per-Tauri-window sandbox backend.
- No automatic provider credential import, no cloud account, no telemetry by default.
- Protect deletion, merging, port exposure and secrets with deliberate user actions.
- Label unverified agent and SBX features unavailable, not guessed.
- Multi-window support can ship later; multi-project and multiple tabs should exist at first useful desktop release.

## 6. Acceptance scenarios

1. Create Project A and B; start separate coding tasks and switch without interruption.
2. Close desktop but leave Core running; reopen and catch up on task events.
3. Open VS Code against the same Core; both clients show consistent statuses.
4. Create a sandbox from wizard; error clearly when daemon unavailable.
5. Finish task, run tests, review diff, apply only after confirmation.
6. Configure native SSH app connection without accessing private app settings.
7. Remove a sandbox with an active task: show exact consequences and require confirmation.
8. Export sanitized logs; verify no tokens or workspace secrets are included.

## 7. References

- https://v2.tauri.app/
- https://docs.docker.com/reference/cli/sbx/
- https://docs.docker.com/ai/sandboxes/integrations/


---

# Sandpane — Security, licensing, and compliance gates

**Date:** 08.10.2026 · **Important:** engineering guidance; not legal advice, and not a statement that Docker has authorized this product.

## 1. The legal question to resolve first

Sandpane intends to be a third-party, independent open-source GUI and orchestration client for Docker Sandboxes (`sbx`). It uses **documented external interfaces**, and users install/authenticate Docker SBX separately. The Docker Subscription Service Agreement and any SBX-specific license terms may still restrict particular third-party integrations, derivative works, redistribution and competitive products.

**A documented CLI command does not automatically constitute permission to publish every GUI/service that calls it.** Technical feasibility and distribution rights are different checks.

### Mandatory release gate

- [ ] Obtain current applicable Docker/SBX license terms and record effective version/date.
- [ ] Ask Docker for written clarification covering: (a) local CLI wrapper GUI, (b) persistent background orchestration service, (c) open-source VS Code/JetBrains plugins, (d) standalone cross-platform binary distribution, (e) templates/exports, (f) Docker name/trademark references and attribution.
- [ ] Confirm permitted branding, screenshots and logos without implication of affiliation.
- [ ] Confirm license compatibility of all dependencies, SDKs, SDK binary packaging and marketplace requirements.
- [ ] Publish independent-software notice and dependency prerequisites.
- [ ] Review whether users' access to cloud SBX is governed by separate terms/billing; default cloud OFF.
- [ ] Preserve the written decision and escalate unresolved terms before public launch.

**Fallback if permission is unclear:** continue only with approved independently written features and internal technical prototypes; postpone public SBX integration release until reviewed. Do not attempt to bypass terms by hiding the integration or manipulating private APIs.

Recommended product disclaimer:

> Sandpane is an independent open-source developer tool published by DKV Labs. It is not affiliated with or endorsed by Docker, Inc. Docker Sandboxes is installed, licensed and authenticated separately.

Open-sourcing original Sandpane code under MIT **does not relicense Docker SBX or any third-party agent software**.

## 2. Integration authorization matrix

| Operation | Interface | Release policy |
|---|---|---|
| Sandbox create/list/start/stop/remove | Public SBX CLI | Confirm published commands and wrapper licensing |
| Network/ports/templates/MCP/secrets | Public documented SBX CLI | Capability-gate per installed version; test exact flags |
| Local application SSH connectivity | Official SBX integration docs | Guide user; don't edit proprietary app's private config |
| Codex chat and sessions | Documented Codex app-server, tested inside SBX | Agent-specific feasibility gate |
| Claude Code chat | Documented structured CLI / Agent SDK, tested inside SBX | Adapter-specific gate |
| VS Code/JetBrains editor UI | Public IDE extension SDKs | Follow marketplace policy |
| ChatGPT/Claude Desktop native-app chat history | Not documented as accessible | Do not attempt to read, scrape or sync |
| Docker internal daemon/private API | Undocumented/private | Excluded |
| Redistribution of SBX binaries | Proprietary | Excluded absent explicit authorization |
| Cloud Sandbox API | Experimental documented API | Future separate review; user billing/consent required |

## 3. Threat model

**Assets:** user's source code, uncommitted changes, environment secrets, agent credentials, Git remotes, local machine, sandbox configs, Core SQLite database, chat history, and logs.

**Trust boundaries:** React webview ⇄ IDE extension host ⇄ local IPC ⇄ Core ⇄ SBX CLI/agent process ⇄ sandbox network/filesystem; remote integrations and MCP tools add boundaries.

**Attackers or failure sources:** malicious/untrusted repository, prompt injection through files/tool output, compromised MCP server, malicious agent-produced instructions, unauthorized local process, path confusion or symlink traversal, accidental operator action, overly broad mounts, vulnerable dependencies, command injection and task-concurrency races.

## 4. Secure CLI and IPC execution

- Only Rust Core can invoke approved SBX/Git subprocesses; webview cannot run shell commands.
- Use fixed executable + argument vector. Never `sh -c` / `cmd /c` with interpolated untrusted input.
- Strict type validation for sandbox names, project paths, Git refs, port mappings and network destinations.
- Canonicalize and validate workspace roots before reading/applying file operations; account for symlinks and time-of-check/time-of-use issues.
- Ensure project context from remote IDE hosts isn't misinterpreted as a local path.
- Pin or verify binaries launched from user overrides; never silently trust repository-local `sbx` executables or executable files named by an agent.
- Use per-user socket permission or Windows pipe ACL; handshake version and authorized client identity as appropriate.
- Limit IPC method access by capability where useful; destructive actions require confirmations and server-side validation even if UI already confirmed.
- Bound stdin/stdout/events and enforce timeouts. Capture process trees and cleanup without killing unrelated processes.
- No unauthenticated localhost TCP admin endpoint; no cloud listener in local-first baseline.

## 5. Credentials, privacy and context

- Keep Docker authentication in Docker-supported stores/flows, agent authentication in provider-supported flows, and Sandpane-only secrets in OS credential storage if unavoidable.
- Store only *presence* and nonsecret metadata about SBX secrets; avoid displaying existing values.
- Never import credentials from private ChatGPT/Claude Desktop installation files.
- Default chat transcripts and project metadata to local storage. Document retention, export and delete options.
- Redact tokens, `Authorization` headers, `.env` values, SSH keys and private URLs from telemetry, diagnostics and streamed logs when possible; note that redaction is best-effort and users must review exports.
- Require explicit approval for adding entire directories or files to agent context; size cap and deny sensitive paths by default.
- Scan/project-instruction summaries are **untrusted context**, not system authorization. Treat prompts from README or tools as potentially hostile instructions.
- Do not send source code to a Sandpane-owned server; no default product telemetry.

## 6. Filesystem and Git safety

### Default workspace decision

Use task-isolated Git clone/worktree execution wherever practical. In direct mount mode, the host is writable immediately and must carry a prominent warning.

### Before executing an agent task

- Check repository identity, base commit, current branch, dirty status and intended workspace mode.
- Snapshot metadata, *not automatically sensitive contents*.
- Allocate a unique branch/worktree/sandbox binding for independent writable tasks.
- Reject attempts to bind two simultaneous writer tasks to one directory unless user explicitly resolves conflict.
- Keep untracked files and secrets out of patches by default; ask before including them.

### Before integrating changes

- Re-check host branch and dirty state against recorded base.
- Generate actual diff including new/deleted/renamed files.
- Support no-overwrite conflict handling. Abort cleanly on changed base or unresolved conflict.
- Require explicit user approval of merge/cherry-pick/patch/commit.
- Preserve task artifacts and branch references until user decides to clean up.
- Deletion of isolated task environment is independent from deletion of a project/repository.

### Sandbox security nuance

Clone-mode isolation prevents direct writes to the host working tree but must not be described as total secret isolation. Host mounts and copied repos may expose sensitive/untracked data. Explain what can be read and written in the selected mode.

## 7. Agent execution and MCP

- Each adapter must document its own auth flow, execution scope, tool permissions and approval semantics.
- Never assume all agents support interactive approvals; some sandbox workflows may operate with elevated or bypassed agent approvals.
- Show true privileges and ask for consent before starting high-impact tasks.
- MCP registration must explain command/server address and execution origin (host vs sandbox), credential scope and network targets.
- Treat MCP responses and tool outputs as untrusted data; do not authorize management commands by parsing chat text.
- Limit automatically launched subprocess count and agent retry loops.
- Allow user cancellation; log actual outcome and warn if files may already have changed.

## 8. Network, ports, remote access

- Default locally published services to loopback (localhost) when supported.
- Require deliberate confirmation before exposing network ports publicly.
- Show effective network policy rather than assume a requested rule took effect.
- Display actual blocked destinations from supported SBX policy logs where available.
- Use documented SSH configuration flow; test connection without storing host private keys in Sandpane database.
- Warn about app-specific credential forwarding (notably native Claude Desktop SSH workflow as documented by Docker).
- Do not use SSH to bypass SBX isolation restrictions.

## 9. Logging, updates, distribution

- Logs have bounded size and retention, timestamps, correlation IDs, and user-controlled export.
- Avoid exposing full prompt content or sensitive file contents in routine logs.
- Security policy with vulnerability disclosure instructions and dependency audits.
- Signed reproducible release artifacts where feasible, plus checksums and provenance.
- Updates must not interrupt active agent processes; handle service upgrades with handshake and maintenance mode.
- Client binaries and Core updates need tested rollback/migration strategy.
- Disable cloud operations by default; require subscription/billing acknowledgment if later introduced.

## 10. Security acceptance gate

- [ ] No shell injection from sandbox name, chat text, branch name, filenames or URL.
- [ ] Same-user IPC boundary enforced on all supported OSes.
- [ ] Unauthorized process cannot invoke delete/merge via exposed webview.
- [ ] Multiple clients cannot accidentally issue duplicate create/start tasks after reconnect.
- [ ] Dirty host changes remain intact after task integration attempt.
- [ ] Network ports never become publicly exposed unintentionally.
- [ ] Diagnostic export reviewed for secret redaction.
- [ ] Prompt injection in repository instructions cannot turn chat content into Core admin permission.
- [ ] Secrets are not mirrored into plaintext configuration/history by default.
- [ ] Destructive operations remain server-validated and explicitly confirmed.
- [ ] Docker/legal/third-party redistribution release approvals documented.

## 11. Primary references

- https://www.docker.com/legal/docker-subscription-service-agreement/
- https://docs.docker.com/reference/cli/sbx/
- https://docs.docker.com/ai/sandboxes/security/
- https://docs.docker.com/ai/sandboxes/integrations/
- https://code.visualstudio.com/api/extension-guides/webview
- https://plugins.jetbrains.com/docs/intellij/welcome.html


---

# Sandpane — Phased implementation roadmap and agent-ready task checklist

**Scheduling approach:** release-based gates, not unverified delivery-day estimates. Implement in dependency order and mark each phase complete only after objective acceptance tests.  
**First target:** VS Code + one working SBX-hosted agent + multi-project/multi-chat and Git-safe review.

## Dependency graph

```text
P0 legality + feasibility
      ├── SBX CLI/version matrix ────┐
      ├── agent transport spike ─────┤
      └── Git safety spike ──────────┤
                                    ▼
P1 persistent Core + IPC + SQLite + task supervisor
                                    │
                                    ▼
P2 multi-project + session model + scheduler + event replay
                                    │
                                    ▼
P3 VS Code MVP (real structured chat + sandbox CRUD)
                                    │
                                    ▼
P4 Git-safe changes + tests + preview
                ┌───────────────────┴──────────────────┐
                ▼                                      ▼
P5 Tauri desktop client                       P6 JetBrains plugin
                └───────────────────┬──────────────────┘
                                    ▼
P7 agent expansion → P8 SBX advanced → P9 native apps → P10 automation
                                    │
                                    ▼
                          P11 stable releases
```

## P0 — Legal + supported-interface feasibility (**BLOCKER**)

- [ ] Establish exact Docker SBX license and Docker written position for an independent open-source manager.
- [ ] Verify name/trademark/domain/marketplace suitability for Sandpane.
- [ ] Verify supported SBX OSes, CLI versions, daemon startup and prerequisites.
- [ ] Enumerate documented `sbx` subcommands and machine-readable output; save fixtures from actual version(s).
- [ ] Execute sandbox create/list/start/stop/delete with a disposable test sandbox.
- [ ] Validate Git clone vs direct mount vs worktree mechanics and cleanup.
- [ ] Prove a **real structured Codex conversation inside SBX**, including streaming, cancellation, session ID, and file changes.
- [ ] Prove reconnection/resumption, or explicitly label it unsupported.
- [ ] Validate SSH/native ChatGPT and Claude setup instructions against documented SBX version.
- [ ] Record technical and licensing constraints in `docs/compatibility.md` and `docs/licensing-decision.md`.

**Exit:** SDK/CLI capabilities evidenced by fixtures and automated smoke tests; legal clearance path identified; no magic/unproven chat assumptions.

## P1 — Shared Rust Core service

- [ ] Create Rust workspace crates: `core`, `service`, `protocol`, `client-ts`, `client-kotlin`.
- [ ] CLI binary locator and version/capability probing.
- [ ] Typed, allowlisted sandbox CRUD and state reconciliation.
- [ ] SQLite schema/migrations for projects, repos, chats, tasks, events, native provider sessions.
- [ ] Single per-user persistent daemon; process supervision and graceful shutdown.
- [ ] Unix socket/Windows named pipe with same-user access controls.
- [ ] RPC schema versioning, request IDs, timeouts, cancellation, idempotency.
- [ ] Event sequence/replay and client reconnection.
- [ ] Structured diagnostic errors, bounded/redacted logs.
- [ ] Unit and integration tests, cross-OS smoke where SBX supported.

**Exit:** CLI-accessible/automated test client can create projects/sandboxes and reconnect safely after service restart.

## P2 — Multi-project conversations and task scheduler

- [ ] Project CRUD, multi-repo associations, client-selected project state.
- [ ] Conversation CRUD, message history, archive/export/delete.
- [ ] Adapter registry + capability snapshots per session.
- [ ] Sandpane-owned task state machine and event persistence.
- [ ] Spawn/track child agent execution under Core ownership.
- [ ] Bounded queues, global/per-project concurrency and writer locks.
- [ ] Assign unique branch/worktree/sandbox per isolated writable task.
- [ ] Client detach does not cancel work; service restart reconciliation.
- [ ] Support cancellation with real process tree cleanup.
- [ ] Two-client event subscription and idempotent task starts.

**Exit:** two projects and at least two concurrent isolated tasks, with accurate statuses and no cross-project writes.

## P3 — VS Code v0.1

- [ ] Activity Bar container + sidebar WebviewViewProvider.
- [ ] Sandpane Core connection and installation/setup diagnostics.
- [ ] Project/sandbox picker and Quick Create wizard.
- [ ] Start/stop/delete sandbox actions with confirmations.
- [ ] Custom streaming Codex chat UI and conversation tabs.
- [ ] Tool-event activity, task status, cancellation, history and event catch-up.
- [ ] Active file/selection context; opt-in diagnostics.
- [ ] Git changed-files list and native VS Code diff action.
- [ ] Webview CSP, output sanitization, keyboard navigation.
- [ ] Package/test `.vsix` and write local installation guide.

**Exit:** sandbox CRUD, real Codex conversation, multi-chat/multi-project switching, diff review from VS Code without terminal UI.

## P4 — Git-safe development and verification v0.2

- [ ] Task branch/worktree/clone assignment; direct-mount warnings.
- [ ] Record base Git revision; detect dirty host state.
- [ ] Track added/deleted/renamed/untracked files.
- [ ] Review diff and apply selected approved work via controlled Git operations.
- [ ] Abort safely on conflicts and changed host state.
- [ ] Approved project test/lint/build commands with exit code and captured outputs.
- [ ] `Fix test error` task path with bounded retries.
- [ ] Stack detection from manifests and human-approved project context.
- [ ] Expose supported localhost port preview and browser open actions.
- [ ] Test non-ASCII paths, symlinks and concurrent task outputs.

**Exit:** agent generates changes in isolation; tests run; host remains untouched until explicit review/integration.

## P5 — Tauri desktop v0.1

- [ ] Tauri 2 app with responsive React navigation and Core client.
- [ ] Projects, conversations, global activity, queue/review status.
- [ ] Real streaming chat and task event viewer.
- [ ] Sandbox CRUD + quick/advanced wizard with capability gating.
- [ ] Git diff review and selected apply flows.
- [ ] Notifications, settings, dark/light, accessibility.
- [ ] Installer and Core service installation/upgrade UX.
- [ ] Verify cross-client state with running VS Code extension.

**Exit:** same task starts in VS Code, progresses while IDE closed and is reviewable from Desktop.

## P6 — JetBrains plugin v0.1

- [ ] Select and test target IntelliJ Platform baseline.
- [ ] Kotlin plugin with Tool Window and typed Core client.
- [ ] Project/sandbox selector and conversation tabs.
- [ ] Streaming Codex events, cancellation, history and reconnection.
- [ ] Editor selection, file context, diagnostics.
- [ ] Native IDE diff and safe apply through Core.
- [ ] Background tasks with EDT-safe UI updates.
- [ ] Plugin Verifier and tested IDEA/PyCharm/WebStorm/PhpStorm builds.
- [ ] Explicit unsupported remote-host behavior.

**Exit:** native-looking agent coding workflow inside verified JetBrains IDEs, concurrent with VS Code/Desktop clients.

## P7 — Expand validated agents

- [ ] Claude Code structured adapter and auth/session compatibility tests.
- [ ] OpenCode adapter after official API verification.
- [ ] Optional Gemini/Copilot CLI adapters, independently gated.
- [ ] Per-provider settings, model listing only where available.
- [ ] Approved text/context handoffs between agents.
- [ ] Unified activity taxonomy while preserving provider-specific details.
- [ ] Session resume advertised only after restart tests.

**Exit:** at least two supported agents independently execute isolated tasks with correct event/cancel semantics.

## P8 — Complete **documented** SBX management

- [ ] Network policy read/write and denied-request logs.
- [ ] Published ports read/write and secure localhost defaults.
- [ ] Templates list/save/load/export/import/remove.
- [ ] MCP add/list/inspect/auth/load/remove for validated formats.
- [ ] Secrets presence, add/remove using documented commands; never show stored values.
- [ ] Skills/kits/declarative env support if current SBX version truly supports them.
- [ ] Diagnostics, daemon status, redacted export.
- [ ] Capability-driven UI disables unsupported experimental features.

**Exit:** all UI operations proven with official interfaces; no undocumented internal Docker API usage.

## P9 — External/native application connections

- [ ] `sbx setup ssh` guided flow; check minimum compatible SBX version.
- [ ] ChatGPT Desktop SSH connection instructions, tested on supported OS.
- [ ] Claude Desktop SSH connection instructions and credential warning.
- [ ] VS Code/Cursor SSH and appropriate remote project path display.
- [ ] Validate JetBrains remote workflow per product.
- [ ] Safe native application launching only through supported OS APIs.
- [ ] Do not claim importing/synchronizing native-app chat history.

**Exit:** user can intentionally configure at least one officially documented native app SSH connection.

## P10 — Advanced automation (post-MVP)

- [ ] Workflow schema/state machine with timeouts, audit and cancellation.
- [ ] Implement → test → review pipeline.
- [ ] Bounded iterative error fixing with explicit approvals.
- [ ] Task dependency DAG and queued parallel agent tasks.
- [ ] GitHub/GitLab branches, commits, PR/MR via documented APIs with user consent.
- [ ] Global notifications and configurable task cleanup/retention.
- [ ] Optional cloud-runtime feasibility/legal review, separate billable operations.

**Exit:** automation is predictable, reviewable, testable and stoppable, with no silent destructive actions.

## P11 — Stable release and publication

- [ ] Legal/public distribution clearance for intended usage.
- [ ] Security threat-model review + dependency audit.
- [ ] SBX and provider version compatibility matrix published.
- [ ] Service crash/restart, migrations, power-loss and client reconnect tests.
- [ ] Git dirty/conflict safety matrix.
- [ ] Windows/macOS/Linux supported configurations tested.
- [ ] Installer/uninstaller and clean upgrade/downgrade paths.
- [ ] VS Code Marketplace/Open VSX listing as permitted.
- [ ] JetBrains Marketplace listing as permitted.
- [ ] Desktop package signing/notarization/checksums as feasible.
- [ ] README, docs, changelog, contributing, security disclosure policy.

**Exit:** independent, appropriately named client releases, not one monolithic 'all clients must be ready' blocker.

## Release labels (illustrative, independently versioned)

| Milestone | Capability |
|---|---|
| `core/0.1` | Documented SBX CRUD and persistent service |
| `vscode/0.1` | Codex chat, multi-project, multi-chat, sandbox management |
| `vscode/0.2` | Git isolation, tests, change review |
| `desktop/0.1` | Full project cockpit on Tauri |
| `jetbrains/0.1` | Native tool window with common core capabilities |
| `core/0.5` | Second verified agent, full lifecycle/recovery |
| `clients/1.x` | Stable, security-reviewed separately |

## Instructions to an AI coding agent implementing this plan

Implement in phase order. Before changing code:

1. Read `README.md`, `01_MASTER_PLAN.md`, `02_ARCHITECTURE_AND_DATA.md`, `06_SECURITY_AND_LICENSING.md` and relevant client spec.
2. Identify current milestone and exact acceptance checks. Do not assume later-stage modules exist.
3. Confirm versions against official documentation and reproduce an SBX/agent integration test for any used API.
4. Propose a small set of changes and preserve existing architecture. Do not build fake mock-powered success UI as a substitute for integration.
5. Add tests for command arguments, errors, lifecycle, security and recovery.
6. Report exactly what was implemented and verified versus what remains unsupported.
7. Never bundle Docker SBX, scrape proprietary apps, or silently rewrite user Git trees.


---

# Sandpane — Verification, compatibility, and publishing plan

**Objective:** every shipped feature must be supported by real evidence, safe error handling, and explicit OS/agent/SBX version bounds.

## 1. Test layers

| Layer | Tooling (example) | What to verify |
|---|---|---|
| Rust unit tests | `cargo test` | Typed command construction, validators, task transitions, event replay |
| TS unit/component | Vitest, React Testing Library | Webview state, chat, diff navigation, error and loading states |
| Kotlin unit/platform tests | JUnit, IntelliJ SDK fixtures | Tool Window state, action context, Core client |
| Core integration | Disposable SBX/test repo | Real CLI operations, agent execution, Git isolation, cancellation |
| VS Code E2E | VS Code Extension Test runner | Sidebar chat, selections, reconnection, native diffs |
| JetBrains E2E | IDE test framework/Plugin Verifier | Tool Window, editor actions, plugin compatibility |
| Desktop E2E | Tauri E2E tooling suitable for OS | Setup, navigation, chat, lifecycle, multi-window |
| Security | fuzz/property/adversarial tests | Command injection, path traversal, log secrets, IPC auth |

Save sanitized, version-labelled fixtures from real commands. Test against them; never invent output fields or statuses.

## 2. Must-pass functional scenario matrix

| ID | Setup and action | Expected result |
|---|---|---|
| T01 | SBX missing on host | Detect, explain, link to official installer; no false 'connected' |
| T02 | Daemon stopped | Correct diagnostic and retry; no uncontrolled side effects |
| T03 | Create/list/start/stop sandbox | Real SBX state matches UI after reconciliation |
| T04 | Delete sandbox with task | Explicit confirmation, task consequences and safe cleanup |
| T05 | Two projects, three chats | UI restores exact associations and messages |
| T06 | Two isolated writable agents | No same-worktree race or cross-repository modification |
| T07 | Two chats share read-only sandbox | Conversations isolated even when environment shared |
| T08 | Close VS Code during task | Task continues only if Core + agent are actually running |
| T09 | Restart Core during task | Reconcile accurately; do not fabricate running/resumed state |
| T10 | Open Desktop and VS Code | Both see consistent task status; only one process started |
| T11 | Stream thousands of events | UI remains responsive; retention bounded and replay reliable |
| T12 | Cancel agent | Real provider/process cancellation, accurate subsequent status |
| T13 | Provider session not resumable | Resume unavailable with actionable explanation |
| T14 | Dirty host Git tree | Changes not overwritten, conflict or blocked apply |
| T15 | Task adds/deletes/renames files | Accurate Git diff and review, including untracked files |
| T16 | Run approved verification command | True exit status, logs and artifact retention |
| T17 | Reconfigure network rules | Actual policy checked; warning before permissive rule |
| T18 | Publish a service port | Loopback binding by default; no surprise public listener |
| T19 | Add/remove MCP registration | Use validated documented commands; no secret leakage |
| T20 | Create/restore SBX template | Template version and workspace implications explained |
| T21 | Native SSH wizard | Correct hostname, supported steps, no private app file edit |
| T22 | JetBrains remote backend | No incorrect host path mapping or silent local execution |
| T23 | VS Code remote extension host | Unsupported status or verified transport, never wrong machine |
| T24 | Invalid payload/Unicode/shell metacharacters | Typed rejection or safe literal handling; no injection |
| T25 | Old client ↔ new Core | Supported protocol or clear upgrade prompt |
| T26 | App/extension uninstalls | No unapproved user repo/sandbox deletion |

## 3. Platform compatibility policy

Record exact tested combinations in `docs/compatibility.md`:

```text
Platform | CPU | OS version | Docker SBX version | Codex version | Claude version
VS Code version | IntelliJ Platform baseline | Core protocol | Tests | Notes
```

Run macOS Apple Silicon first if that's the active development host, then Windows 11 and a supported Linux desktop. Do not advertise unsupported combinations as working. Check installed JDK/JBR and plugin runtime capabilities for each JetBrains IDE.

**Version gate:** capability discovery comes from known tested commands, documented minimum versions and actual runtime verification, not optimistic parsing of arbitrary output.

## 4. Fault injection

- Kill agent process while Core is running; observe interrupted status and artifact preservation.
- Kill Core during active task; restart; test safe reconciliation and non-duplication.
- Stop SBX daemon while a sandbox is active; show actionable errors.
- Remove sandbox outside Sandpane; client refresh handles orphaned binding.
- Pull network during provider tool request; surface timeout and retry safely.
- Simulate disk full during event persistence and migration; protect database integrity.
- Simulate Git branch diverging during review; abort apply with no partial destructive side effects.
- Open same task from three clients; controls and events remain consistent.
- Replace an executable in PATH; ensure Core executable selection policies catch unexpected binary.

## 5. Security checks

- Same-user OS-level IPC ACL/permissions, request validation and mutating-operation gating.
- Cross-project filesystem/root enforcement, path canonicalization and symlink handling.
- No free-form shell-execution RPC; all management commands parameterized.
- Secret redaction for logs, exported diagnostics and activity events.
- Webview CSP and sanitization of agent/Markdown HTML output.
- Authorization before using external services or submitting sensitive context.
- No public-network binds by default; clear SSH credential-forwarding warnings.
- Prompt-injection test corpus: repository README says 'delete other projects'; Core refuses privileged action.

## 6. Release automation

### Pull request CI

- Rust formatting/clippy/tests and dependency audit.
- TS lint/typecheck/Vitest, webview CSP/static analysis and build.
- Kotlin compilation/SDK tests/Plugin Verifier for targeted IDE range.
- Generated schema/codegen drift check.
- SBX fixture contract tests, then optional ephemeral real-SBX integration tests on compatible CI hosts.
- Review requirement for destructive command adapter modifications.

### Packages

- **Core:** OS-architecture-specific independently authored service binary, version/checksum/provenance.
- **VS Code:** `.vsix` and eligible Marketplace/Open VSX listing; confirm publisher and extension policy.
- **JetBrains:** signed/verified plugin ZIP where appropriate; check Plugin Verifier and Marketplace publication conditions.
- **Desktop:** native Tauri builds for available supported target OSes; code-sign/notarize as needed, publish checksums.
- **Docs:** installation, `sbx` prerequisites, supported versions, how tasks persist, security/privacy, troubleshooting, changelog.

### Upgrade / rollback

- New Core must declare protocol compatibility before accepting clients.
- SQLite migrations backed up atomically; prevent downgrade that would corrupt state.
- Service upgrade waits for active tasks or requires explicit maintenance approval.
- Extension uninstall must not silently destroy existing Docker sandboxes, Git branches or project data.
- Record how to manually stop Core and remove Sandpane-only state.

## 7. Beta and stable exit criteria

### Internal alpha

- One developer can create an SBX sandbox and run a genuine structured Codex task with real streamed messages.
- Git diff is real and test commands return authentic outcomes.
- Failed/unsupported operations are visible, not swallowed.

### Public beta (only after legal gate)

- Multiple projects/chats and two isolated writer tasks are dependable.
- Native clients attach to one shared Core with correct event replay.
- Basic threat model and redaction review pass.
- Source/install docs include actual supported version bounds.

### Stable

- Migration/crash/recovery and uninstall behaviors demonstrated.
- No known critical command-injection, credential disclosure or destructive Git integrity issues.
- Test matrix and support boundaries published.
- Independent versioned releases of each ready client; no need for every proposed P2 feature.

## 8. Useful official references

- Docker: https://docs.docker.com/reference/cli/sbx/
- Docker integrations: https://docs.docker.com/ai/sandboxes/integrations/
- VS Code extension testing: https://code.visualstudio.com/api/working-with-extensions/testing-extension
- IntelliJ plugin compatibility: https://plugins.jetbrains.com/docs/intellij/verifying-plugin-compatibility.html
- Tauri v2: https://v2.tauri.app/
