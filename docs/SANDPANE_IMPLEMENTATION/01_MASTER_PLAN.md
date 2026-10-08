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
