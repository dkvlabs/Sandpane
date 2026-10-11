# Plan of record — spec completion, review fixes, latest dependencies (2026-10-09)

**Goal (user, 2026-10-09):** read `docs/` (design → specs) and implement everything it describes; check the preview implementation for security issues and bugs; commit after each implementation; use the latest library versions for each implementation; finally update the README with every step to run/install the desktop app, VS Code extension and JetBrains plugin.

**Rules that bound this plan:** `AGENTS.md` (logging per implementation, honesty, no shell interpolation, Git safety, licensing gate) and `docs/specs/07` ("do not build fake mock-powered success UI as a substitute for integration"). Anything that cannot be proven on this host ships **visibly unsupported/unverified**, never faked.

## Inputs

Five read-only reviews were run at `81f4841`: security (whole repo), Core, VS Code, Desktop + design, and JetBrains. Their condensed findings drive the backlog below. Real `sbx v0.47.0` captures landed in entry 0014.

## Order (fixes → upgrades → features)

Each line is one implementation commit plus its `docs(audit)` log entry. Small same-area fixes are grouped into one entry.

### F — Review fixes (security + bugs)

| # | Area | Content | Status |
|---|---|---|---|
| F0 | CI | Actions pinned to SHAs, gradle wrapper validation, cargo-audit pinned, Node 24 (security W7) | done `edf9a74` |
| F1 | Core | Reconcile `awaiting_input`/`verifying`; git hardening (fsmonitor/hooks/env); real sbx v0.47 argv + validator + `--clone`; version parse + probe via `daemon status --json`; bounded subprocess runner; stderr classification; socket/data-dir permissions + `sandpane/` subdir; flock single-instance; peer-cred check; idle timeout + connection cap; scheduler idempotency; event high-water mark (migration v2); honest `conversation.send` code; `project.create` canonical git-root + denylist; exact base-OID checks (security W1–W3, W5, S2–S4, S7, S8) | done `bb5cc8f` (entry 0019) |
| F2 | Desktop | Tauri crate compiles; async proxy; CR/LF + response-id checks; timeouts; task-derived live-writable disclosure; state-leak keys; history race; project-scoped task index; ConfirmDialog; reactive store status; inert settings; router/theme/contrast; socket path + owner check; narrowed capability (A1–A12, W4–W6, S9) | done `321f4fd` (entry 0017) |
| F3 | VS Code | `vscode.diff` Uri args; reconnect socket leak; replay scope; live-writable from the selected sandbox; composer persistence; attachment authorization; honest copy; conversation scope reset; refresh after reconnect; live polling; settings `scope: machine` + socket owner check; crypto nonce (bugs 1–12, W4, S5, S6) | done `0344167` (entry 0018) |
| F4 | JetBrains | Inverted dispose guard; intentional-close reconnect loop and client leak; conversation selection drift; ref-counted streams; per-stream replay refusal and real gap resync; apply sends the reviewed paths; honest send/chip; UTF-8 byte budget; settings wiring; Swing `html.disable` (S1); socket owner check (W4) | done `af8949b` (entry 0020) |

### U — Latest dependencies (one area per commit, full suite each)

Status (09.10.2026): U1 `013ecfd` (0022), U2 `7a0a5b8` (0023), U3 `8b45a9c` (0021), U4 `da20777` (0025) — all done. U4 targets Java 25, not 21: the IDE requires it.

| # | Area | Target |
|---|---|---|
| U1 | Rust (core + Tauri) | rusqlite 0.32 → 0.40.2; serde 1.0.229; serde_json 1.0.151; thiserror 2.0.21; uuid 1.27; tauri 2.12.2; tauri-build 2.7.1 |
| U2 | VS Code | TypeScript 7.0.2, Vitest 5.0.3, `@vscode/vsce` 4.0.0. `@types/vscode` and `@types/node` track `engines.vscode` and the Node bundled with VS Code's Electron (latest *compatible*, reason recorded) |
| U3 | Desktop | React 19.3, Vite 8.3, `@vitejs/plugin-react` 6.1, Vitest 5.0, TypeScript 7.0, `@tauri-apps/api` + `@tauri-apps/cli` matched to the `tauri` crate minor, React Query 5 latest |
| U4 | JetBrains | Gradle 9.8.1, Kotlin 2.4.21, IntelliJ Platform Gradle Plugin 2.19.0, target IntelliJ IDEA 2026.2.3 (build 262, unified IU — IC ended at 2025.3), Java 21 bytecode compiled with an installed JDK 26/27. The first build downloads the IDE (multi-GB). |

All verified versions are recorded in `docs/compatibility.md`.

### C — Core features (protocol changes serialized: Core + schemas + drift gate first, then clients)

Protocol additions follow the design of record: [2026-10-09-protocol-v1-additions.md](2026-10-09-protocol-v1-additions.md). It covers additive-only rules, the two-step confirmation token, and landing order A1–A9.

1. Sandbox lifecycle: `sandbox.stop` and `sandbox.remove` (confirmed, `rm --force` behind server confirmation). `start` maps to the documented path or is reported unsupported. **Done `b1067c7` (entry 0031, A1), all three clients.** Start is reported unsupported (sbx v0.47 has none). Still open: JetBrains has no create UI (the `agent` field is typed only); the VS Code webview has no lifecycle buttons and does not show `agent`; the active-task check before stop/remove waits for per-task sandbox bindings (C3) — A4 (`d6b17dd`, entry 0035) only records the name a task's chat chose (`chosenSandboxName`) and describes it in the remove impact, never as a binding; the out-of-band same-name race remains (no remove-by-id in sbx v0.47); stop/remove block other calls on a shared client connection (Core serves a connection serially). Never run against a real `sbx`.
2. Project/conversation lifecycle: update/archive/delete, repo add/remove, conversation rename/archive/delete/export (redacted), persisted `sandboxId`. **Project half done `9069f6a` (entry 0033, A3a), all three clients**: update, archive/unarchive (+ `includeArchived`), two-step delete that never touches host files/branches/sandboxes, `add_repository`/`remove_repository` (bindings now record `repo_id`). **Conversation half done `f44ab4c` (entry 0034, A3b), all three clients**: rename, archive/unarchive (+ `includeArchived`), two-step delete that never touches host files/worktrees/branches/sandboxes, paged best-effort redacted export, persisted `sandboxId` (a name chosen at creation, not a binding). C2 complete.
3. Task Git context: `repo_id`, `base_commit`, `task_branch`, worktree allocation and cleanup. **Core-internal part done `2232d88` (entry 0027); the global excludes file is re-vetted on repository registration `ab68c5b` (entry 0028).** Not wire-reachable until the A-series protocol additions. `integration_status`, per-task `sandbox_name` and the retention policy are still open.
4. `git.diff` (per file) and `git.apply` of selected files: merge/cherry-pick `--no-commit` or `apply --3way`, conflict rollback, dirty gate on touched paths.
5. Approved verification commands (`verification.approve/list/run`, injectable executor) and stack detection into `project_context`. **Done `bd48a10` (entry 0038, A7), all three clients**: runs only inside the task's bound sandbox through `sbx exec` (no shell), version-gated until the user captures C-1/C-2/C-5/C-7; `project.context` suggestions only pre-fill. Remaining steps (A8, A9, A4b) and their plans: [2026-10-12-status-report.md](2026-10-12-status-report.md).
6. Scheduler wiring (bounded queue, limits from settings) and idempotency keys. **Idempotency keys done `af8858d` (entry 0032, A2), all three clients**: durable 24 h keys for `sandbox.create` / `conversation.send`, `replayed: true` on replays, `features` advertisement, explicit "Retry safely" only (no automatic replay). Scheduler wiring is still open.
7. Adapter registry skeleton with capability snapshots (every adapter `verified:false` until P0 proof).
8. P8 sbx surfaces built from captured help: ports (loopback default), policy, templates, MCP, secrets (presence only, `set` via stdin), daemon status, diagnose — capability-gated.
9. Graceful shutdown and a live push subscription; retention/cleanup RPC; workflow schema skeleton (P10, no execution).

### CL — Client features (after each Core protocol step)

- **Desktop:** persistent shell (TopBar, icon rail, nested project/chat tree, StatusBar, Inspector); S03 chat screen; Dashboard and Cockpit; ⌘K palette; S00 onboarding; native notifications, single-instance and store plugins; sandbox lifecycle UI (stop/remove done in 0031); DiffViewer; redacted diagnostics export; macOS unsigned `tauri build`.
- **VS Code:** conversation tabs and history paging; activity and changed-files views; project auto-select from workspace folders; specs/03 §4 context actions; diagnostics consent; per-file apply; jsdom adversarial tests, ESLint, `@vscode/test-electron`; sandbox lifecycle (stop/remove commands done in 0031; webview buttons open); verification.
- **JetBrains:** per its review backlog (F4); lifecycle and diff parity; `buildPlugin` and `verifyPlugin`. Unknown-enum tolerance and the anti-spoofing hardening (table-row Apply dialog) landed in entry 0029; follow-ups from its reviews are listed in that audit record.

### R — README

Every step to build, run and install the Core service, desktop app, VS Code extension and JetBrains plugin, each one actually executed in this session. Anything not executed is labeled unverified. **Done** in the root README "Install and run" (entry 0030): every build/package/install step executed from a fresh clone in isolated directories; GUI launches remain UNVERIFIED.

## Blocked — owner and unblock action

| Item | Blocked on | Owner / action |
|---|---|---|
| ~~Real sandbox create/stop/rm proof, non-empty `ls --json` rows~~ | **Unblocked 2026-10-09:** the user ran `sbx policy init balanced`; CLI round trip captured (entry 0015) | — |
| Ports/policy/secrets effects against a real sandbox | Not yet exercised | Orchestrator, provider-free `shell` sandbox only |
| Real Codex conversation in SBX (streaming, cancel, session id, resume); verified adapters (Codex, Claude Code, OpenCode…) | Provider credentials inside a sandbox | **User:** provider sign-in; agents never enter credentials |
| Docker SBX license and written position; trademark/marketplace suitability | Humans / Docker | **Maintainers** (`docs/licensing-decision.md`) |
| Marketplace publication (VS Code, Open VSX, JetBrains), desktop signing and notarization | Licensing gate + certificates | **User permission + licensing gate** |
| Windows/Linux runtime verification | Hosts not available here | **Maintainers** (CI covers Linux core only) |

## Definition of done

1. Every F, U, C and CL item that is implementable on this host has landed in its own commit, with a `docs/CHANGELOG.md` entry and a `docs/audit/` record.
2. Every blocked item appears as visibly unsupported or unverified in the UI where it surfaces, and is listed in `docs/compatibility.md` and the README with its unblock action.
3. `make check` passes fresh, including desktop `cargo check`/`cargo test` and the JetBrains build.
4. The README run/install steps were executed in this session, with results recorded.
5. The working tree is clean, and the sbx daemon is returned to its pre-session state (stopped) unless the user says otherwise.
