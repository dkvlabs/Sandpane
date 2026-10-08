# Sandpane Desktop — standalone cross-platform implementation

**Stack:** Tauri 2 + React + TypeScript + Tailwind + shadcn/ui + Rust Core client/service.  
**Target:** macOS, Windows, Linux where Docker SBX is itself supported.  
**Role:** Sandpane's multi-project control center, not a competing Docker runtime and not a full IDE.

## 1. Primary experience

```text
┌────────────────────────────────────────────────────────────────────┐
│ Sandpane                                     ● Core / SBX Ready   │
├───────────────────┬────────────────────────────────────────────────┤
│ Projects          │ [Auth] [Payments] [Search] [+ New Chat]       │
│ ▾ Atlas Demo        │ Agent: Codex · Sandbox: auth · git: auth-task │
│   ● Auth          │                                                │
│   ● Payments      │ Agent activity and conversational chat        │
│ ▾ Nova Demo     │ ✓ inspected repo · ✓ implemented · ● tests   │
│   ● Search        │                                                │
│                   │ Changed files [Review]    Preview [Open]     │
│ Activity          │                                                │
│ Sandboxes         │ Compose message…                        Send │
│ Agents            │                                                │
│ MCP & Policies    │                                                │
│ Connections       │                                                │
│ Settings          │                                                │
├───────────────────┴────────────────────────────────────────────────┤
│ Running 3 · Queued 1 · Review needed 2 · Failed 0                 │
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
