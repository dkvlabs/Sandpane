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
