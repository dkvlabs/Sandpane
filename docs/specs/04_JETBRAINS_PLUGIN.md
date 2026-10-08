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
