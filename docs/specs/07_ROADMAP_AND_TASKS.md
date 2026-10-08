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
