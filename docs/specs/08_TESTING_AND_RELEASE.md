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
