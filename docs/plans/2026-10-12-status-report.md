# Status report and A8–A9 implementation plan (2026-10-12)

This report records where the spec-completion goal stands after A7, what is still open, and how the last two protocol steps, **A8** and **A9**, are to be implemented. It complements the plan of record ([2026-10-09-spec-completion-plan.md](2026-10-09-spec-completion-plan.md)) and the protocol design of record ([2026-10-09-protocol-v1-additions.md](2026-10-09-protocol-v1-additions.md)). Every number below comes from a command run in this session or from a commit. Anything not proven on this host is labeled **UNVERIFIED**.

## 1. Summary

- The protocol has grown from 14 methods (before A1, per `schemas/rpc-request.schema.json` at `b1067c7^`) to **34 methods**, with **6 features**, in seven additive steps (A1–A7). All three clients (VS Code, desktop, JetBrains) implement every step. Each step was designed and security-reviewed, implemented and reviewed in Core, then in the clients. It then went through the gates, was committed, and was logged in `docs/audit/`. Since A7, Core's wire files are also frozen with SHA-256 hashes before the clients are briefed, a lesson from A6, where Core changed under the clients.
- What remains:
  - A8 (sbx status, ports and read-only listings);
  - A9 (maintenance cleanup);
  - A4b (workspace selection on the wire), which unlocks real Git-context tasks;
  - the scheduler, adapter-registry and client-feature backlogs;
  - the final README re-verification.
- **Nothing in Sandpane has run an agent or a verification command inside a real sandbox through Core.** The real sbx v0.47.0 was proven at CLI level (entry 0014–0015). Core spawns `sbx exec` only for versions in `VERIFIED_EXEC_VERSIONS`, which is empty until the user captures C-1, C-2, C-5 and C-7 (§5).

## 2. What is done

| Step | Content | Implementation | Log |
|---|---|---|---|
| F0–F4 | Review fixes: CI pinning; Core hardening; desktop, VS Code and JetBrains bug and security fixes | `edf9a74`, `bb5cc8f`, `321f4fd`, `0344167`, `af8949b` | 0016–0020 |
| U1–U4 | Latest dependencies: Rust, VS Code (TS 7, Vitest 5), desktop (React 19.3, Vite 8.3, Tauri 2.12), JetBrains (Gradle 9.8.1, Kotlin 2.4.21, IntelliJ 2026.2.3, Java 25) | `013ecfd`, `7a0a5b8`, `8b45a9c`, `da20777` | 0021–0023, 0025 |
| C3 (Core part) | Task Git context and host worktrees; fail-closed discard; global-excludes re-vet | `2232d88`, `ab68c5b` | 0027–0028 |
| R | README install and run guide (every step executed in isolated dirs) | `4c1f8c3` | 0030 |
| A1 | `sandbox.stop`, confirmed `sandbox.remove`, create `agent` | `b1067c7` | 0031 |
| A2 | Durable idempotency keys, `features` advertisement | `af8858d` | 0032 |
| A3a / A3b | Project lifecycle; conversation lifecycle (rename, archive, two-step delete, redacted export) | `9069f6a`, `f44ab4c` | 0033, 0034 |
| A4 | `conversation.send` mode (Task / Discuss) | `d6b17dd` | 0035 |
| A5 | `git.diff`, exact change lists | `10c5f18`, `394709e` | 0036 |
| A6 | `git.apply` for reviewed files (content-bound, quarantined objects, writer lock) | `dbdf9c1` | 0037 |
| A7 | Approved verification commands (`verification.list/approve/revoke/run/result`) and `project.context` | `5d29980` (design), `bd48a10` | 0038 |

### A7 in one paragraph

- **Approval.** A user approves an exact argv plus a label. Approval refuses secret-like values (per element, joined, and as JSON) and control characters other than TAB and LF.
- **Running.** `verification.run` runs the argv only inside the task's bound sandbox, through `sbx exec -- <name> <argv…>`. There is no shell, the environment is cleared down to an allowlist, and Core uses an empty 0700 working directory of its own.
- **Async model.** Runs are asynchronous (`runId`, `startedSequence`).
  - Output is stored only in `verification_runs` and read through `verification.result`. It is never put in events.
  - Each run gets exactly one terminal record.
  - Caps: 1 run per task, 1 per sandbox, 4 globally. A `direct_mount` run takes the repository writer lock.
- **`project.context`.** Reads manifests with `openat`/`O_NOFOLLOW`, runs no tools, and redacts notes. Its suggestions only pre-fill the approval editor.
- **Clients.** Every client opens the approve and run confirmations only from a user gesture. Exit 0 is shown as "exit status 0 (as reported by sbx exec)", never as "passed", and output is shown as escaped plain text.

## 3. Verification state at A7

| Gate | Result |
|---|---|
| Core (`cargo fmt --check`, `clippy --all-targets -D warnings`, `cargo test`) | 596 passed, 0 failed |
| VS Code (`npm run typecheck && npm test`) | 810 passed |
| Desktop (`npm test`, src-tauri `cargo test`) | 736 passed + 9 live skipped; 36 Rust passed |
| Live checks against an isolated Core (no real sbx) | VS Code 66/66; desktop 9/9 |
| JetBrains (`./gradlew test --rerun buildPlugin verifyPluginStructure`, `verifyPlugin`) | 483 tests, 0 failures; Compatible with IU-262.10968.63 |
| `make check`, schema lint and drift | exit 0; 34 methods and 6 features in sync |

**UNVERIFIED** (carried, unchanged by A7):

- no client was launched in a real editor, app or IDE;
- the desktop Tauri native build and signing were not done;
- no codex or claude sandbox exists, because both need provider sign-in;
- no wire-created task has Git context or a sandbox binding until A4b.

## 4. What is still open

1. **A8 and A9** (§6 and §7 below).
2. **A4b: workspace selection on `conversation.send`, plus a token-confirmed `worktree.discard`.** Recorded, not scheduled. It has three hard preconditions:
   - **W-D:** `git.review` and `git.diff` on `host_worktree` must stop running git inside the task worktree. Git must be pinned to the host common dir, the task side read only by Core, with a hostile-`.git` test.
   - **I-h:** C-1, C-2, C-5 and C-7 must be captured before `verification.run` is reachable over the wire.
   - **I-c:** `worktree.discard` must refuse while a `host_worktree` run is in flight.
3. **Core backlog:**
   - scheduler wiring (bounded queue, limits from settings);
   - the adapter registry with capability snapshots (`verified:false` until P0 proof);
   - graceful shutdown (`main.rs` has no shutdown path, disclosed in §3.7);
   - a live push subscription;
   - the P10 workflow schema skeleton;
   - task `integration_status`;
   - verification cancel (needs C-4).
4. **Client backlog (CL):**
   - **desktop:** persistent shell, S03 chat, Dashboard/Cockpit polish, ⌘K palette, S00 onboarding, native notifications, DiffViewer, redacted diagnostics export, unsigned `tauri build`;
   - **VS Code:** conversation tabs and paging, activity/changed-files views, context actions, `@vscode/test-electron`, ESLint;
   - **JetBrains:** create UI, lifecycle and diff parity, and the JB0 items (`runIde`, an installed zip).
5. **Final README pass:** re-run every install/run step for Core, desktop, VS Code and JetBrains, then update the test counts and the A-series feature list.
6. **Licensing gate:** a public release of any SBX-integrated artifact stays blocked until `docs/licensing-decision.md` is checked. Nothing is published to a marketplace.

## 5. Captures the user can run (Sandpane never runs them while building)

All of these run against a disposable, provider-free `shell` sandbox. The A7 ones are defined in §3.7 item 12.

| # | Command | Unlocks |
|---|---|---|
| C-1 | `sbx exec -- <name> printf '[%s]\n' -u --privileged -e X=y 'a b' '$(id)' '*' --` | literal argv passing (A7 gate) |
| C-2 | `sbx exec -- <name> sh -c 'exit 7'` | exit-status pass-through (A7 gate; exit 0 may then read "passed") |
| C-3 | `sbx exec` on a stopped sandbox | auto-start assumption |
| C-4 | SIGTERM / SIGKILL to `sbx exec` during `sleep 60` | verification cancel |
| C-5 | `sbx exec -- <name> pwd` | working directory (A7 gate) |
| C-6 | `sbx exec -- <name> env` with a canary variable | environment isolation |
| C-7 | `sbx exec -- <name> id` | no elevation (A7 gate) |
| C-8 | `sbx ports <name> --json` with no published port, then with one | `sandbox.ports.list` (A8b) |
| C-9 | `sbx ports <name> --publish 8080/tcp4`, `sbx ports <name> --publish 127.0.0.1:18080:8080/tcp4`, each followed by `sbx ports <name> --json`; then `--unpublish 127.0.0.1:<hostPort>:8080/tcp4`; plus one publish on a stopped sandbox. Optionally `--publish 8080/tcp6`, to learn how sbx writes `::1` | `sandbox.ports.publish/unpublish` (A8b) |
| C-10 | `sbx policy ls --json` and `sbx policy ls <name> --json` | policy listing (A8c) |
| C-11 | `sbx template ls --json` | template listing (A8c) |
| C-12 | `sbx mcp ls --json` (no servers, and with one if the user has any) | MCP listing (A8c) |
| C-13 | `sbx secret ls --json` with no secrets; then, only if the user chooses, with one dummy secret the user sets | secret presence listing (A8c) |
| C-14 | `sbx diagnose --json` (never `--upload`), and `sbx daemon status --json` with the daemon stopped (only the running JSON and both text forms are captured today) | `sbx.status` details (A8a) |
| C-15 | `sbx prune --dry-run --json` (never without `--dry-run`) | A9 reporting of stopped sandboxes |

Each capture is stored under `core/crates/sandpane-core/tests/fixtures/sbx/captured/<version>/` with `$HOME` and workspace paths sanitized. Its `_meta.json` must say `fixture_status: captured`.

## 6. A8 — sbx status, ports and read-only listings

### 6.1 Principles (bind every A8 sub-step)

1. **Capture-gated advertisement.** A method or feature is advertised only for an sbx version whose real output for that exact command is captured. Today only `version` and `daemon status --json` are captured, so only `sbx.status` can ship advertised. The rest ship in Core and the clients, but stay unadvertised (clients show "not supported by this Core / sbx version") until the capture lands. This uses the same mechanism as `VERIFIED_EXEC_VERSIONS`: a per-surface `VERIFIED_<SURFACE>_VERSIONS` list.
2. **Never auto-start the daemon from a read.**
   - `sbx ls` auto-starts `sandboxd`, as captured.
   - `sbx.status` must use only `version` and `daemon status --json`. A captured stopped-daemon status does not auto-start.
   - Every listing that might start the daemon is refused with `UNAVAILABLE` ("the sbx daemon is stopped") when `daemon status` says it is stopped.
3. **No machine-wide mutation.**
   - Policy, secrets, MCP and templates are **read-only** in A8.
   - `policy allow/deny/rm/reset/init`, `secret set/rm/import`, `mcp add/rm/auth/load` and `template load/rm/save` are not exposed. The UI lists them as "not supported in Sandpane; use the sbx CLI".
   - `diagnose --upload` is never passed.
   - `--cloud` is never passed.
4. **Allowlist parsing.** Core decodes each listing into a typed struct with an explicit field allowlist and drops every other field. Values are size-capped and redacted, and the whole answer stays under the frame backstop (`MAX_RESPONSE_BYTES`), with `truncated` disclosed.
   - **Secrets** yield only `{ name, scope, sandbox?, service? }`, never a value, even if sbx emitted one. A test feeds a fixture that contains a `value` field and asserts that it is absent from the answer and from logs.
   - **MCP** drops headers and placeholders, and the signed-in identity is reduced to presence (`signedIn: boolean`).
5. **Typed argv only.** Every sbx call is an argument vector built from validated values: the sandbox name through `validation::sandbox_name`, ports as integers. No string from a client is passed through as a port spec or flag.

### 6.2 A8a — `sbx.status` (read-only, ships advertised)

- **Source:** `sbx version` and `sbx daemon status` in its **text** form. `Status: running` / `Status: stopped` is captured for both states, while the JSON form is captured only for a running daemon. `--json` is used only after C-14 captures the stopped JSON.
- **Shape:** `{} → { path, version, daemon: { running: boolean }, captured: boolean, surfaces: { exec, ports, policy, templates, mcp, secrets: "verified" | "unverified" } }`.
- `captured` is true only when `version` is in the fixture set Core was built with. `surfaces` tells clients which A8 methods to expect, and is derived from the same `VERIFIED_*` lists that drive advertisement.
- **`policyInitialized` is omitted.** The only non-mutating probe would be `policy ls --json`, which is not captured (C-10). The design of record listed it as optional, so leaving it out is honest.
- Read-only and replay-safe. Deadline 15 s.
- **Clients:** a status card in every client.
  - **Desktop:** Dashboard and the S00 onboarding.
  - **VS Code:** the sidebar header.
  - **JetBrains:** the tool-window header.
  - The card shows version, daemon running or stopped, and per-surface "verified / not verified for this version". It carries no buttons that start or stop the daemon (that is a machine-wide setting).

### 6.3 A8b — `sandbox.ports.list`, `sandbox.ports.publish`, `sandbox.ports.unpublish`

- **list:** `{ name } → { ports: [{ hostIp, hostPort, sandboxPort, protocol }] }`, built from `sbx ports <name> --json`. Read-only. Advertised after C-8.
- **publish:** `{ name, sandboxPort, hostPort?, protocol?, idempotencyKey? }`.
  - Core builds the spec itself, and the client never supplies a host IP. The forms follow the captured grammar `[[HOST_IP:]HOST_PORT:]SANDBOX_PORT[/PROTOCOL]`, where a host IP requires a host port:
    - Without `hostPort`, Core sends `<sandboxPort>/tcp4` (or `udp4`). With no `HOST_IP`, sbx binds loopback, and `tcp4` binds only 127.0.0.1, per the captured help.
    - With `hostPort`, Core sends `127.0.0.1:<hostPort>:<sandboxPort>/<proto4>`.
  - The answer comes from a fresh re-list. If the resulting mapping's host IP is not loopback, Core unpublishes it at once and reports a failure (defence in depth).
  - The IPv6 forms (`tcp6`/`udp6`, how `::1` is written) are deferred until C-9 shows them. The exact strings stay UNVERIFIED until C-9.
  - Ports are integers in 1–65535, and `hostPort` must be ≥ 1024 (no privileged host ports).
  - In the first pass, `protocol` must be one of `tcp4 | udp4` (default `tcp4`). Dual-stack `tcp` and `udp` are refused, to keep exactly one loopback family per mapping.
  - The answer re-lists the ports and returns the resulting mapping.
  - Keyed write (A2), not replay-safe.
  - **Disclosure (from captured help):** "publishing starts a stopped sandbox". The confirmation states it, and the impact names the sandbox state.
  - Advertised after C-9.
- **unpublish:** `{ name, hostPort, sandboxPort, protocol }`. Core builds `127.0.0.1:<hostPort>:<sandboxPort>/<proto4>`, the documented `[HOST_IP:]HOST_PORT:SANDBOX_PORT[/PROTOCOL]` form. Not destructive to data, so no token. The answer re-lists ports, so anything left behind is shown, as sbx reports it.
- **Locking:** both take the per-sandbox-name lock that A1 uses for create and remove, so a publish cannot race a remove.
- **Event:** a durable `sandbox.port.published` / `sandbox.port.unpublished` event, appended before notify. Its payload is the mapping only.
- **Clients:**
  - a Ports section per sandbox, with a list, Publish (sandbox port, optional host port, protocol picker; gesture-only confirmation; "loopback only" stated) and an Unpublish confirmation;
  - **desktop:** the sandbox lifecycle panel;
  - **VS Code:** a webview section plus a command;
  - **JetBrains:** an action plus a dialog.
  - Never open a browser to the port automatically. The URL is shown as text and copied on request.

### 6.4 A8c — read-only listings: `sbx.policy.list`, `sbx.templates.list`, `sbx.mcp.list`, `sbx.secrets.list`

| Method | sbx argv | Answer (allowlist) | Notes |
|---|---|---|---|
| `sbx.policy.list` | `policy ls [<name>] --json` | `{ policies: [{ name, source, appliesTo, decisions: {byType} }], truncated }` | No `--include-inactive`, no `--wide` in the first pass. Org policies are shown as read-only facts |
| `sbx.templates.list` | `template ls --json` | `{ templates: [{ name, size?, createdAt? }] }` | No load/save/rm |
| `sbx.mcp.list` | `mcp ls --json` | `{ servers: [{ name, gateway, transport, usable, needsAuth, headersUnsupported }] }` | Headers, placeholders and identity are dropped. "Needs auth" says "run `sbx mcp auth` yourself" |
| `sbx.secrets.list` | `secret ls --json` (optionally `--sandbox <name>`) | `{ secrets: [{ name, scope, sandbox?, service? }] }` | **Presence only.** No set/rm/import. Names are redacted by the A7 secret detector if a name itself looks like a token |

- All four are read-only and replay-safe. Each is advertised per version after its own capture (C-10 to C-13). The JSON field names in the table are provisional until those captures fix them; the design review must re-check every name against the captured output.
- **Feature:** `sbx-listings` (one feature string). Methods are advertised individually.
- **Clients:** a read-only "Sandbox environment" view per client, with four tabs or sections. Every row is rendered as escaped text. For each mutation the CLI offers, the view says "managed with the sbx CLI, not by Sandpane".

### 6.5 A8 process, tests and acceptance

1. **Design** (§3.8 in the design of record), then a security review of the design (`security-reviewer`), then commit.
2. **Core:**
   - `sbx.rs` builders;
   - typed decoders with allowlists;
   - the `VERIFIED_*` lists;
   - `sandpane-protocol` types;
   - schemas;
   - drift gate;
   - an event schema for the port events.
   - **Tests:**
     - decoders against the captured fixtures, and against hostile fixtures (extra fields, values in secrets, oversize rows, control and bidi characters);
     - argv-building tests (no host IP from the wire, port ranges, protocol allowlist);
     - "stopped daemon refuses without starting it";
     - advertisement follows the `VERIFIED_*` lists;
     - lock interaction with `sandbox.remove`.
3. Core security review, fixes, and a freeze with hashes.
4. A client brief, then the three clients in parallel.
5. A combined client review.
6. **Gates:** `make check`, the JetBrains gate alone, live checks against an isolated Core (no real sbx: every A8 listing must answer "not supported for this sbx version" or `UNAVAILABLE`), the invisible-character scan and the secret gate.
7. Commit `feat(protocol): sbx status, ports and read-only listings (A8)`, then audit 0039.
8. Splitting A8 into A8a/A8b/A8c commits is allowed if the diff grows past a reviewable size; each one is then logged separately.

## 7. A9 — `maintenance.cleanup`

### 7.1 Scope

These are retention targets Core owns, all on this machine:

1. **Host worktrees** Core created, in two groups:
   - **Tracked:** worktrees of tasks in a final state (`completed`, `rejected`, `failed`, `cancelled`, from the `TaskStatus` enum). `interrupted` tasks are included only after the retention period, because a restart may leave a task `interrupted` that the user still wants to review. Each goes through the existing fail-closed discard path from C3.
   - **Orphans:** directories under Core's own worktree root (`<data>/worktrees`) that no task row references. They are left behind on purpose by the A3a/A3b two-step deletes, which hard-delete the rows (`DELETE FROM tasks …`) but never touch host files, worktrees or branches. Orphans are matched to a registered repository through their `.git` file, read by Core, never by running git in them (W-D). An orphan whose repository is still registered gets the same discard path. Any other orphan is **listed only**, with the `git worktree remove` command the user can run themselves.
   For both groups:
   - never with uncommitted or unreviewed changes;
   - never a worktree Core did not create;
   - never while a verification run or an apply holds that task (A7 I-c, A6 writer lock).
2. **Task branches** (`sandpane/task-…`) of discarded worktrees, removed only when the branch tip is reachable from the base or the user explicitly confirms an unmerged branch. These are listed separately as `unmerged`, and the default is to keep them.
3. **`verification_runs` output.** After a retention period (default 30 days), the stored stdout and stderr are deleted, and the row keeps its status, exit code, timestamps and `outputPruned: true`. (§3.7 requires A9 to cover these rows.)
4. **Expired idempotency keys** (older than 24 h, `done` or `unknown`).
5. **Events:** nothing to prune for deleted entities, because the conversation delete already hard-deletes their `task_events` (and messages, sessions, artifacts, runs). For live tasks the event log is append-only and **never pruned** by A9. A size-based event retention, if one is ever wanted, is a separate design.
6. **Export and diagnostic artifacts** Core wrote to its data dir.

**Out of scope (machine-wide or user-owned):**

- `sbx prune` and `sbx rm`. Removing sandboxes stays with the confirmed `sandbox.remove`. A9 may only *report* `sbx prune --dry-run --json` candidates after C-15, with the copy "run `sbx prune` yourself". Pruning also deletes those sandboxes' secrets, a machine-wide side effect.
- Anything in the user's repositories other than Core-created worktrees and branches.
- Global Git config, and the sbx policy, secrets or templates.

### 7.2 Shape and confirmation

- **Dry run:** `maintenance.cleanup { dryRun: true }` (the default when `dryRun` is absent).
  - The answer is `{ removable: [{ kind, id, path?, bytes?, reason }], kept: [{ kind, id, reason }], confirmationToken, expiresAt }`.
  - Read-only, but not replay-safe, because it mints a token.
- **Execution:** `maintenance.cleanup { dryRun: false, confirmationToken, items: [ids] }`, following the §2 two-step pattern.
  - The token binds the exact removable set and expires (60 s).
  - Core re-checks every item at execution and skips any that changed, reporting why.
  - It answers `{ removed: [...], skipped: [{ id, reason }] }`.
  - A durable `maintenance.cleanup` event is appended before notify, with counts only.
- **Single flight:** one cleanup at a time (a global lock). It takes each repository's writer lock for worktree and branch removal.
- No automatic or scheduled cleanup in this pass. Every execution needs a user gesture plus the confirmation.

### 7.3 Clients

- A "Clean up" view (desktop Settings/Maintenance; a VS Code command plus webview section; a JetBrains action plus dialog).
- The flow:
  1. The dry run runs on a gesture.
  2. The view lists items grouped by kind, with sizes and reasons.
  3. Unmerged branches are unchecked by default and warned about.
  4. The confirmation states exactly what is removed and that it cannot be undone.
- The results show removed and skipped items with reasons. Copy never says "everything was cleaned" when anything was skipped.

### 7.4 A9 process and tests

- The same process as A8: design §3.9, design review, Core, Core review, freeze, clients, client review, gates, commit `feat(protocol): maintenance cleanup (A9)`, then audit 0040.
- **Tests:**
  - **Fail-closed worktree removal:** dirty, unknown origin, locked by a run, locked by an apply.
  - **Branches:** unmerged branches are kept unless they are explicitly included.
  - **Tokens:** a token is bound to the set; an expired or replayed token is refused; a changed item is skipped.
  - **Output and keys:** output pruning keeps the run record; idempotency-key expiry does not touch `pending` keys.
  - **Events:** no live-task event is ever pruned.
  - **Safety:** no sbx call is made in either mode before C-15 (and no non-dry-run sbx call ever).
  - **Migration v9:** `outputPruned` and the retention metadata, with backup and downgrade refusal like the earlier migrations.

## 8. Order after A9

1. **A4b** (with W-D first, as its own Core commit), once the user has run the A7 captures.
2. **The Core backlog:** scheduler wiring, the adapter registry, graceful shutdown.
3. **The CL client backlog**, one client per entry.
4. **The final README:** every run/install step for desktop, VS Code and JetBrains re-executed from a fresh clone in isolated directories, counts updated, GUI launches labeled UNVERIFIED unless the user launches them.
5. **A final `make check`**, a clean tree, and the sbx daemon confirmed stopped.
