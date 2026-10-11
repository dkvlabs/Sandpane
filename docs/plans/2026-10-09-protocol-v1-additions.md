# Protocol v1 additions — design of record (2026-10-09)

This design covers the C-series protocol work in [the spec-completion plan](2026-10-09-spec-completion-plan.md). The Core protocol (`core/crates/sandpane-protocol`, `schemas/`) is designed once here. Each feature then lands as its own commit against this document, with the schema, Core and all three clients updated **together**. That follows AGENTS.md Code Review rule 8 and the `core-protocol` skill.

## 1. Compatibility rules (why the surface looks like this)

A read-only investigation of the shipped clients found the following (scratch notes; summarized here):

| Change | JetBrains | VS Code | Desktop |
|---|---|---|---|
| New optional field on a params/result object | tolerated (`ignoreUnknownKeys`) | tolerated (cast) | tolerated (known-key decoders) |
| New RPC method | tolerated; call refused client-side until allowlisted | same | same |
| New value in `TaskStatus` / `ErrorCode` / `FileChangeStatus` / `WorkspaceMode` | **hard-fails whole calls** (`task.list`, `git.review`, `sandbox.list`; `conversation.send` fails *after* Core applied it) | degrades visibly | **hard-fails whole calls** (desktop tolerance fix in progress) |
| `PROTOCOL_VERSION` bump | Core rejects `v≠1` **before** dispatch, including `system.probe`, so JetBrains loops in `Unavailable` forever and desktop shows "unreachable" | ignored | "unreachable" |

**Therefore:**

1. **`PROTOCOL_VERSION` stays `1`. Every change below is additive:** new methods, new optional request fields, and new response fields that are absent-tolerant (`#[serde(default, skip_serializing_if = …)]`).
2. **No new values in the four strict enums.** Every spec-required error code (`NOT_INSTALLED`, `DAEMON_DOWN`, `UNSUPPORTED_SBX_VERSION`, `PROVIDER_AUTH_REQUIRED`, `CONFLICT`, `TASK_INTERRUPTED`, `PERMISSION_DENIED`, `VALIDATION_FAILED`, plus `NOT_FOUND` and `INTERNAL`) already exists. New outcomes are expressed as new **fields** or new **string-valued fields on new objects**, never as new enum members. If a new enum value ever becomes unavoidable, a separate client-tolerance commit must land first in every client.
3. **Clients gate every new call on `system.probe`'s `methods` advertisement.** If the method is not advertised, the action is shown as visibly unsupported, never hidden behind a fake success.
4. **Each method addition updates every pinned list in the same commit.** The rows for "Adding an RPC method" in the investigation list them:
   - Rust `Method` (`ALL`, `parse`, `as_str`, the `EXPECTED` test) and the service dispatch;
   - `schemas/rpc-request.schema.json`;
   - JetBrains `CoreMethods` / `ProtocolDriftGuardTest` / `CoreClientFramingTest`;
   - VS Code `CORE_METHODS` / `protocolWire.test.ts` / `commands.test.ts` / `live-core-check.mjs`;
   - desktop `METHODS` / `protocol-drift.test.ts` / `protocol.test.ts` / `ipc_client.rs` (`replay_safe`, `proxy_deadline_ms`, the count test) / `REPLAY_SAFE_METHODS` / `METHOD_TIMEOUT_MS`.
5. **Whole-repo gate on every protocol commit:**
   - Core gates and `make schema-drift`;
   - `make desktop-check` (desktop compiles `sandpane-protocol` by path);
   - VS Code `typecheck`, `test` and the live check;
   - JetBrains `test --rerun buildPlugin`.

## 2. Destructive-action confirmation (shared pattern)

The specs require server-side confirmation for destructive actions:

- 02 §5: "never delete a sandbox created outside Sandpane without an explicit user confirmation";
- 02 §4: separate cancel, stop sandbox, archive chat and delete project.

Client-side dialogs alone are not enough, because any same-user process can speak the socket. **Two-step confirmation token** — a server-enforced two-step confirmation bound to the target identity. It is **not** proof of human presence: a malicious same-user process (the specs/06 §3 attacker) can call step 1 and replay the token into step 2, and the socket's same-user authentication cannot tell it apart from a client UI. It stops single accidental or stale requests and binds the action to the identity the user was shown. Connection binding is deliberately not added.

```ts
// Step 1 — no token: Core describes the impact and issues a token. Nothing is changed.
{ method: 'sandbox.remove', params: { name: 'atlas-demo-1' } }
→ ok: { confirmation: { token: string, expiresAt: string, action: 'sandbox.remove',
                        target: { name, id }, impact: string[], external: boolean } }

// Step 2 — same params + token: Core re-checks the target identity, then acts.
{ method: 'sandbox.remove', params: { name: 'atlas-demo-1', confirmToken: '…' } }
→ ok: { removed: true }   // no requeried: Core re-queries itself and answers removed only when the confirmed id is gone
```

Token rules:

- 256-bit random, single-use, and expiring after 120 s. Core's `confirmation_ttl` setting can only shorten this (clamped to 120 s).
- Bound to `(action, target identity)`: for a sandbox, its sbx `id` as well as its name, so a same-named replacement is refused with `CONFLICT`.
- Kept in memory only, so tokens die with Core.
- A wrong or expired token gives `VALIDATION_FAILED`, and nothing runs.
- `external: true` (no live Sandpane binding recorded for **this sbx id**; a binding for the same name but another id, or a pre-A1 binding with no recorded id, does not count) is shown prominently by every client.

The same pattern applies to `project.delete`, `conversation.delete` and `worktree` discard.

## 3. Additions, in landing order

Each row is one commit, plus its `docs(audit)` log entry. Status is tracked in the plan file.

| # | Addition | Shape (additive) | Notes |
|---|---|---|---|
| A1 | `sandbox.stop` | `{ name }` → `{ stopped: true, requeried?: SandboxSummary }` | `sbx stop N`, then re-query via `ls --json` (02 §5). `requeried` is optional: absent = no longer listed or the re-query failed, so clients show the state as **unknown**. Not destructive, so no token. |
| A1 | `sandbox.remove` | §2 token flow → `{ removed: true }` | `sbx rm --force N` runs only after the token check and the sbx-id re-check. Bindings now record `sbx_id` (schema v4); only the live rows for the confirmed id (plus pre-A1 rows with no id) are captured before `rm` and marked removed, never deleted. A per-sandbox-name Core lock covers `sandbox.create` and the confirmed remove (re-check → binding update); a second operation on the same name gets `CONFLICT` and runs nothing. Residual race (disclosed): `rm` acts on a name, so a same-named sandbox created **out of band** between the re-check and `rm` would be the one removed — sbx v0.47 has no remove-by-id. |
| A1 | `sandbox.start` | **not added** | sbx v0.47.0 has no `start`; restart is the interactive `sbx run --name`. Clients show "Start: not supported by sbx v0.47 (use `sbx run` in a terminal)". |
| A1 | `SandboxCreateSpec.agent?: string` | default `"shell"` (provider-free) | Exact match against the built-in agents in captured `sbx create --help`: `claude, codex, copilot, cursor, devin, docker-agent, droid, gemini, kiro, opencode, shell`. Sandbox **kit references are refused**: local dirs, ZIPs, git repos and OCI refs all run third-party code. `--cloud` is never passed, because it is billable and outside local scope. Provider agents are accepted, but the sandbox is labeled "agent not verified". |
| A2 | `SandboxCreateSpec.idempotencyKey?`, `ConversationSendParams.idempotencyKey?` | string ≤ 128, `[A-Za-z0-9._-]` | Core stores key → result for 24 h. A replay returns the stored result. The same key with different params gives `CONFLICT`. Decisions in §3.1 (durable storage, claim before execution, restart → `unknown`, `features` advertisement). |
| A3 | `project.update` (name, description), `project.archive` / `project.unarchive`, `project.delete` (token), `project.add_repository` / `project.remove_repository` | `Project` gains `description?`, `archivedAt?` | Repositories still pass the canonical git-root + denylist check. Removing a repository is refused while tasks reference it. |
| A3 | `conversation.rename`, `conversation.archive` / `unarchive`, `conversation.delete` (token), `conversation.export` | `Conversation` gains `sandboxId?`, `archivedAt?` | `sandboxId` from create is persisted (it was previously discarded). Export returns redacted JSON within the frame cap, and `truncated` is disclosed. |
| A4 | `ConversationSendParams.mode?: "task" \| "discuss"` | default `"task"` | `discuss` never gets a writable workspace. With no verified adapter, both still answer `PERMISSION_DENIED` (honest). Follow-up from A1: once tasks carry sandbox names, `sandbox.stop` / `sandbox.remove` must refuse, or describe in `impact`, active tasks bound to the sandbox. |
| A5 | `ChangeSet.repoPath?`, `ChangeSet.uninspected?: string[]`, `FileChange.oldPath?` | response fields | `oldPath` comes from `--name-status -M`. `uninspected` lets a future review return a flagged partial list for submodules instead of refusing; today it is always refused. |
| A5 | `git.diff` | `{ taskId, path, maxBytes? }` → `{ path, oldPath?, patch, binary, truncated, baseBlob?, taskBlob? }` | Read-only. Hardened runner; the path must be in the task's change list. Patch capped (default 256 KiB). |
| A6 | `git.apply` (existing) implemented for reviewed entries | additive: `entries`, `FileChange.taskBlob`/`taskMode`, `ApplyResult.appliedFiles` | **Superseded by §3.6** (originally `--3way` / `cherry-pick`): `host_worktree` only; content bound to the reviewed blob ids; no git process reads the task worktree; exact-set snapshot from objects; host leading-path and dirty gates; `git apply --index` with post-write verification; durable start/finish events. |
| A7 | `verification.list`, `verification.approve` (user-entered argv + label), `verification.revoke`, `verification.run` | `VerificationCommand { id, label, argv: string[], approvedAt }`, `VerificationResult { exitCode, stdout, stderr, truncated, elapsedMs }` | **Superseded by §3.7**: runs **only** inside the task's sandbox via `sbx exec -- <name> <argv>` (no shell), asynchronously, with output read through the added `verification.result`; approvals refuse secrets; spawning is version-gated on captured proof. Never runs on the host. |
| A7 | `project.context` | `{ detected: [{ manifest, suggestedCommands: string[][] }], approved: VerificationCommand[] }` | Bounded, read-only manifest parsing. Suggestions are never auto-approved. |
| A8 | `sbx.status` (read-only diagnostics) | `{ path, version, daemon: { running }, policyInitialized?, captured: boolean }` | From `version` and `daemon status --json`. |
| A8 | `sandbox.ports.list`, `sandbox.ports.publish` (loopback only) / `unpublish` | — | Each is advertised only if captured `--help` proves the flags. Otherwise it is not advertised. |
| A8 | policy / templates / MCP / secrets | **read-only listings only** (secrets: names and presence, never values) | Mutating policy, secrets or MCP changes machine-wide settings. They are not exposed in this pass and are recorded as UNVERIFIED and unsupported in the UI. |
| A9 | `maintenance.cleanup` | `{ dryRun: boolean }` → `{ removable: […], removed: […] }` | Retention for worktrees, artifacts and pruned events. Dry-run is the default. |

**Not in v1 additions** (recorded as follow-ups):

- server-push subscription (frames stay request/response; clients poll `task.subscribe`);
- attachment storage and the selection grammar;
- workflow execution (P10 schema skeleton only).

### 3.1 A2 decisions (idempotency keys), fixed before implementation

1. **Durable, not in memory.**
   - Keys live in SQLite, in a new `idempotency_keys` table added by migration v5 (pre-upgrade backup, downgrade refusal, as v4).
   - Each row stores `method`, `key`, `params_hash`, `state` (`pending` | `done` | `unknown`), `result_json` (`done` only), `created_at` and `completed_at`.
   - Keys are namespaced by method: the same key under `sandbox.create` and `conversation.send` are two separate rows.
2. **Fingerprint, not params.** The hash input is prefixed with a version tag (`sandpane-idem-v1`). New optional request fields must use `skip_serializing_if`, so absent fields don't change existing hashes.
   - `params_hash` is SHA-256 of the canonical serialization of the *typed* params with `idempotencyKey` removed (serde struct field order; `serde_json` has no `preserve_order`). It is never computed from raw frame bytes.
   - The params themselves are never stored, so prompt text is not retained a second time.
3. **`conversation.send`: atomic with the write.** The key row (`done`, with the result) is inserted in the same transaction as the message, task and event rows. A replay therefore returns exactly the task that was created, and a crash leaves either both or neither.
4. **`sandbox.create`: claim before the subprocess.**
   - Order of checks:
     1. validate the params;
     2. look the key up;
     3. take A1's per-name lock;
     4. commit a `pending` claim;
     5. run `sbx create`;
     6. complete the claim as `done` with the result.
   - Because the lookup comes before the lock, a replay of a finished create returns the stored result rather than CONFLICT.
5. **Replay outcomes.**

   | Situation | Outcome |
   |---|---|
   | `done`, same hash | The stored **first** response, unchanged, plus an additive `replayed: true`. It is not current state (a task may since have been reconciled to `interrupted`, a sandbox stopped); clients re-read with `task.list` / `sandbox.list` after a replay. |
   | Same key, different hash | `CONFLICT` ("idempotency key was already used with different parameters; nothing was run"). |
   | `pending` | `CONFLICT` ("an operation with this idempotency key is still in progress; nothing was run"). |
   | `unknown` | `CONFLICT` ("the outcome of the earlier request with this idempotency key is unknown (Core restarted or sbx failed while it ran); re-read state before retrying with a new key"). |

   No new error enum value is introduced. A concurrent same-key create for the same sandbox name may instead receive A1's name-lock `CONFLICT` ("another operation on sandbox … is in progress; nothing was run"). In every case nothing ran.
6. **Restart: never fabricate.** At Core startup every leftover `pending` row becomes `unknown`. This follows the AGENTS.md rule that Core never fabricates running or resumed state after a restart.
7. **Failures.**
   - Only successes are stored. A failure that Core knows happened before anything ran (validation, NOT_INSTALLED, the name lock) deletes the claim, so the key stays retryable.
   - A failure after `sbx create` started marks the row `unknown`, because sbx may have created the sandbox: a non-zero exit, a wait/read error, a timeout after which the re-query does not find the sandbox, or a failed binding write. A retry with that key is refused within the retention window, never run twice.
   - Two post-start outcomes are stored as `done`, because they match the response the client actually received: exit 0 with a failed re-query (`probedState: null`), and a timeout after which the re-query finds the sandbox.
   - A spawn failure (the process never executed) releases the claim.
   - If the startup reconcile of `pending` rows (or of tasks) fails, Core refuses to serve rather than serve unreconciled state.
8. **Retention.** Rows older than 24 h are pruned at startup and before each insert. The table is also capped at 10 000 rows by pruning the oldest `done`/`unknown` rows first. `pending` rows are never pruned while Core runs. After a row is pruned the key is unknown to Core, so "never run twice" holds only within retention: a later `sandbox.create` with the same name is refused by sbx itself, while a later `conversation.send` would create a new task.
9. **Advertisement.**
   - `CoreCapabilities` gains an additive `features: string[]` (`#[serde(default)]`; schema and drift gate updated). A2 advertises `"idempotency-keys"`.
   - It also advertises `"sandbox-create-agent"` for the A1 field. That replaces the client inference "agent is honoured if `sandbox.remove` is advertised".
   - Clients send `idempotencyKey` **only** when the feature is advertised. A pre-A2 Core silently drops an unknown field, so a key sent to it would promise a safety it does not have.
10. **Client retry policy for A2.**
    - Each user action (one Create click, one Send) gets one fresh random key of 128 bits, base64url or hex, within the allowed charset.
    - Only an explicit user "Retry" of that same action reuses it.
    - Automatic-replay sets (desktop `REPLAY_SAFE_METHODS`, the Rust `replay_safe`) are **unchanged** in A2. Making keyed writes auto-replayable is a later, separately reviewed step.

### 3.2 A3a decisions (project lifecycle), fixed before implementation

A3 is landed in two commits: **A3a** (projects, below) and **A3b** (conversations, §3.3).

1. **Methods (6 new, 22 total).**
   - `project.update {projectId, name?, description?}` → `Project`. The name is at most 120 characters, using the `Validator::project_name` rule that `project.create` now applies too. It refuses every control character (including newline and tab), line and paragraph separators, and bidi controls. The description is at most 2000 characters; newlines are allowed; every other control character, line and paragraph separators, and bidi controls are refused; and an empty description clears it. At least one of the two fields must be present. Method segments stay lowercase snake_case: the method-name pattern in `core-capabilities.schema.json` and every drift test require it.
   - `project.archive {projectId}` / `project.unarchive {projectId}` → `Project`. Both are idempotent: archiving an archived project returns it unchanged.
   - `project.delete {projectId, confirmToken?}` uses the §2 token flow:
     - action `project.delete`;
     - target `{name: <project name>, id: <project id>}`, where a rename between the two steps does not invalidate the token, but a different id does;
     - step 2 returns `{deleted: true}`.
   - `project.add_repository {projectId, path}` → `Project`.
   - `project.remove_repository {projectId, path}` → `Project`.
2. **Wire additions.**
   - `Project` gains `archivedAt?` (absent when not archived). `description` is already present.
   - `project.list` gains an optional `includeArchived?: boolean`, default false. That keeps today's behaviour for older clients, which never see archived projects.
3. **What archived means.** Archiving is reversible and changes nothing outside Core.
   - While a project is archived, Core refuses `conversation.create`, `conversation.send`, `sandbox.create`, `project.update` and the repository methods with `VALIDATION_FAILED` ("project is archived; unarchive it first; nothing was changed").
   - Tasks that are already running keep running. Reads keep working.
4. **Delete preconditions, checked at step 1 and again at step 2.** Step 2 re-checks under the DB lock in the same transaction as the delete. Each failure is `CONFLICT`, and nothing is deleted:
   - the project has a non-terminal task ("cancel or finish its tasks first");
   - the project has a live sandbox binding, meaning `removed_at IS NULL` ("remove its sandboxes first"). Core never removes an sbx sandbox as a side effect.
   - a `sandbox.create` for this project is in flight. Core keeps a per-project in-flight count, held from the create's claim until its binding is written or it fails, and delete refuses while that count is above zero. This prevents an sbx sandbox being created for a project that is deleted underneath it. Archive is not blocked, because it is reversible.
5. **What delete does.**
   - It removes the project's rows: project, repositories, conversations, messages, agent sessions, tasks, task events, artifacts and verification rows, the `removed_at` binding rows, `project_context`, `client_state` and workflows. Deletes run in an explicit order (tasks, then conversations, bindings, repositories, project), and existing `ON DELETE CASCADE` acts only as a backstop.
   - It runs in one transaction.
   - It **never touches host files, branches or sandboxes.** The impact lines say:
     - how many conversations, messages and tasks are deleted;
     - that audit rows of removed sandboxes are deleted with the project;
     - that Core-allocated worktree directories (if any) and task branches in the host repositories are **left in place**, with their count when Core knows it.
   - Rows in `idempotency_keys` are not touched: they hold results only and expire within 24 h.
   - A keyed replay after a delete differs by method. A `conversation.send` replay returns the stored first response (`replayed: true`) for a task that no longer exists, consistent with "a replay is not current state". A `sandbox.create` replay answers NOT_FOUND, because create checks that the project exists before the key lookup.
6. **Repository add.**
   - Same canonical git-root and denylist rules as `project.create`: `canonical_repository`, dedupe, then `revet_excludes_for_new_repositories` before the insert, as in entry 0028.
   - A path already registered in this project returns the project unchanged.
7. **Repository remove.**
   - The repository is matched by its stored canonical path, or by the canonicalized form of the input.
   - Core refuses with `CONFLICT` while any task (`tasks.repo_id`) or live binding (`sandbox_bindings.repo_id`) references it.
   - From A3a on, `sandbox.create` records `sandbox_bindings.repo_id`: the registered repository whose root contains the mount path (NULL for mountless). The create's post-claim re-check also confirms that repository is still registered.
   - Removal is also refused in two more cases. One is while any live `direct_mount`/`sbx_clone` binding of the project has a NULL `repo_id`; these are pre-A3a rows, and the refusal is deliberately conservative. The other is while a `sandbox.create` for the project is in flight, with the message `a sandbox is being created for this project; try again when it finishes; nothing was removed`. Otherwise a repository a live sandbox writes to could drop out of the excludes-file forbidden roots (entry 0028).
   - The path must be absolute. An exact stored match is preferred over a canonicalized one.
   - It never touches the host repository. No token is needed, because nothing outside Core changes.
8. **Exact user-facing messages** (clients match on them):
   - `project is archived; unarchive it first; nothing was changed`
   - `project has tasks that are not finished; cancel or finish them first; nothing was deleted`
   - `project has sandboxes; remove them first; nothing was deleted`
   - `repository is used by a task or sandbox of this project; nothing was removed`
   - `a sandbox is being created for this project; try again when it finishes; nothing was deleted`
9. **Clients.**
   - Each new method is gated on `system.probe` `methods`.
   - Project settings get: rename and description; an archive/unarchive toggle; a "show archived" filter (`includeArchived: true`); add repository (each client's native folder picker, with Core validating the path); remove repository; and delete through the shared two-step dialog pattern from A1 (impact lines revealed and capped, Cancel default, expiry re-checked at click time, no retry).

### 3.3 A3b decisions (conversation lifecycle), fixed before implementation

1. **Methods (5 new, 27 total).** Lowercase snake_case segments, as in §3.2.
   - `conversation.rename {conversationId, title}` → `Conversation`.
   - `conversation.archive {conversationId}` / `conversation.unarchive {conversationId}` → `Conversation`. Both are idempotent.
   - `conversation.delete {conversationId, confirmToken?}` uses the §2 token flow:
     - action `conversation.delete`;
     - target `{name: <stored title>, id: <conversation id>}`, bound by id through `consume_by_id`, so a rename between the steps does not invalidate the token;
     - step 2 returns `{deleted: true}`;
     - `external` is always false.
   - `conversation.export {conversationId, afterSequence?, limit?}` → a redacted export page (item 6). It is read-only.
2. **Wire additions.**
   - `Conversation` gains `archivedAt?` (absent when live) and `sandboxId?` (absent when none was stored).
   - `conversation.list` gains `includeArchived?: boolean`, default false. Older clients therefore never see archived conversations.
   - `features` gains `"conversation-sandbox-id"`. Without it, a client cannot tell "no sandbox was chosen" from "an older Core discarded the choice". Clients may rely on `sandboxId` being persisted only when the feature is advertised.
3. **`sandboxId` is a stored name, not an identity.**
   - Migration v6 adds `conversations.sandbox_id TEXT` (same backup and downgrade-refusal rules as v4/v5). `conversation.create` stores the value it already validates with `Validator::sandbox_name`.
   - It is the sandbox **name** chosen when the conversation was created. Core does not check that the sandbox still exists, and a same-named replacement (A1) is indistinguishable.
   - Clients present it as "sandbox chosen at creation", never as a binding. They show "not in the current sandbox list" when it is absent from `sandbox.list`.
   - Rows created before v6 have no value. Nothing back-fills them.
4. **What archived means.** Archiving is reversible and changes nothing outside Core.
   - **Archived conversation:**
     - `conversation.send` and `conversation.rename` are refused with `VALIDATION_FAILED` ("conversation is archived; unarchive it first; nothing was changed"). This replaces today's `NOT_FOUND` from the `archived_at IS NULL` filters on both send paths (the early check and the authoritative in-transaction re-check).
     - Tasks already running keep running.
     - `conversation.history`, `conversation.export` and task reads keep working. `history` stops answering `NOT_FOUND` for archived rows; before A3b no method could archive a conversation, so no client depended on that.
   - **Archived project:** only reads, `conversation.archive` and `conversation.delete` are allowed. `conversation.rename` and `conversation.unarchive` are refused with A3a's project message ("project is archived; unarchive it first; nothing was changed").
   - **Keyed replay:** `conversation.send` looks the idempotency key up before these checks. A keyed replay to a conversation that has since been archived or deleted returns the stored first response with `replayed: true`. This matches the documented asymmetry in §3.2 item 5: a replay is not current state.
5. **Delete.**
   - **Precondition:** checked at step 1 and again at step 2 under the DB lock, in the same transaction as the delete. If the conversation has a non-terminal task: `CONFLICT` ("conversation has tasks that are not finished; cancel or finish them first; nothing was deleted").
     - A concurrent `conversation.send` cannot slip past. Send writes its task in one transaction that re-checks that the conversation exists. It either commits first (delete then sees a non-terminal task) or finds the conversation gone (`NOT_FOUND`).
   - **Explicit order, in one transaction** (from the v1–v5 schema; `ON DELETE CASCADE` is only a backstop):
     1. `verifications`, `task_artifacts` and `task_events` of the conversation's tasks;
     2. `tasks`;
     3. `agent_sessions`;
     4. `messages`;
     5. `client_state.selected_conversation`, set to NULL where it names this id (it has no foreign key);
     6. the `conversations` row.
   - **It never touches host files, worktrees, branches or sandboxes.** The impact lines say:
     - how many messages and tasks are deleted;
     - that task events, artifacts and verification records go with them;
     - that Core-allocated worktree directories and task branches are **left in place**, with their count when Core knows it;
     - that the chosen sandbox, if any, is not touched.
   - **Locks:** filesystem checks for the impact lines run after the DB mutex is released (A3a I6). No lock guard may live in an `if let` / `match` / `while let` scrutinee whose body re-locks; that was A3a's C1 deadlock.
   - **Idempotency keys** are not touched, as in A3a.
6. **Export: always redacted, paged, bounded.**
   - **Shape:** `{format: "sandpane.conversation-export.v1", exportedAt, conversation, messages, truncated, nextSequence, redaction: {bestEffort: true, replacements, byKind}}`.
     - `conversation` is a `Conversation` with its title redacted.
     - `messages` are `MessageRecord`s with their content redacted.
     - `byKind` maps a kind name to its count and omits kinds with zero replacements.
     - The title is redacted on every page but counted only on the first page (`afterSequence` absent or 0), so clients sum page counts directly.
     - There is no unredacted mode.
   - **Scope:** only the conversation metadata and its messages. Task events, artifacts and verification output are **not included**. Clients say so on the export surface and in the saved file.
   - **Paging and bounds:** identical to `conversation.history`.
     - `afterSequence`, and `limit` clamped to 1..=500.
     - The same byte ceiling, `MAX_HISTORY_BYTES`, is counted over the raw serialized rows under the DB lock. The first row always passes.
     - `truncated` and `nextSequence` follow history's rules. Clients loop until `truncated` is false, require `nextSequence` to strictly increase, and stop after a fixed page cap, disclosing a partial export.
   - **Redaction never lengthens text, and runs after the DB lock is released.**
     - Each match is replaced by `[REDACTED:<kind>]` when the matched span is at least that long. Otherwise it becomes one `*` per character.
     - Markers are ASCII and need no JSON escaping, so a redacted row never serializes longer than the raw row. The ceiling counted under the lock therefore still bounds the page, and the 4 MiB frame cap holds.
     - A test pins "output never longer than input" with a page made of short matches.
     - Overlapping matches are merged into one region, attributed to the highest-priority kind among them. A multi-line `private-key` block is therefore never dropped because a single-line match started earlier on its BEGIN line (A3b review C1).
   - **Engine:** the `regex` crate (1.13.1, MIT OR Apache-2.0, pinned exactly like `sha2`). Its patterns are fixed and trusted and it has no catastrophic backtracking, which a hand-written scanner would not guarantee. Worst-case iteration over all matches is documented as O(m·n²); it was measured roughly linear on hostile 2 MiB inputs (at most 37 ms). Patterns are compiled once with a size limit.
   - **Kinds (best-effort, specs/06 §"Redact tokens, Authorization headers, .env values, SSH keys and private URLs"):**
     - `auth-header`: `Authorization` / `Proxy-Authorization` values.
     - `private-key`: PEM `PRIVATE KEY` blocks; an unterminated block is redacted to the end of the message.
     - `token`: well-known prefixes, including GitHub `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` / `github_pat_`, GitLab `glpat-`, Slack `xox?-`, OpenAI and Anthropic `sk-`, AWS `AKIA`, Google `AIza`, npm `npm_`, Hugging Face `hf_` and Docker `dckr_pat_`.
     - `jwt`: three base64url segments beginning `eyJ`.
     - `env-secret`: `NAME=value` / `NAME: value` lines whose name contains SECRET, TOKEN, PASSWORD, PASSWD, API_KEY, ACCESS_KEY, PRIVATE_KEY or CREDENTIAL (case-insensitive). Only the value is replaced.
     - `url-credentials`: the `user:pass@` userinfo in a URL, including an empty user (`redis://:pass@host`).
     - `url-secret-param`: query values of `token`, `access_token`, `api_key`, `apikey`, `key`, `secret`, `password`, `sig`, `signature` and `X-Amz-Signature` / `X-Amz-Credential`, plus any parameter whose name contains an `env-secret` keyword (e.g. `client_secret`, `refresh_token`).
     - Host names and paths are **not** redacted. Clients must say: "Redaction is best-effort; review the export before sharing it."
     - **Known unmatched shapes (A3b review I1, accepted):**
       - PGP `PRIVATE KEY BLOCK` and lowercase PEM;
       - AWS `ASIA…` keys, Slack `xapp-` tokens and `X-Amz-Security-Token`;
       - `x-api-key` / `apiKey` names and space-separated `--password value`;
       - the last two segments of a 5-segment JWE;
       - token prefixes glued after `_` or a digit;
       - a token-only URL user name with no password;
       - a folded `Authorization:` header;
       - a raw `@`, `/` or `#` inside a URL password.
7. **Titles.**
   - New `Validator::conversation_title`: 1..=200 characters, with the same refusals as `Validator::project_name` (every Cc including `\n` and `\t`, C1, U+2028/2029, U+200E/200F, U+061C, U+202A–202E, U+2066–2069).
   - `conversation.create` uses it in place of `display_text`. An empty or whitespace-only title on create still becomes "Untitled conversation".
   - On `conversation.rename`, an empty or whitespace-only title is refused (`VALIDATION_FAILED`).
   - Titles stored before A3b may still contain those characters, and the title goes into impact line 0. Clients keep revealing and capping every Core string.
8. **Exact user-facing messages** (clients match on them):
   - `conversation is archived; unarchive it first; nothing was changed`
   - `conversation has tasks that are not finished; cancel or finish them first; nothing was deleted`
   - `conversation not found` (existing)
   - A3a's `project is archived; unarchive it first; nothing was changed`
   - A1's token rejection message
9. **Clients.**
   - **Pinned lists:** every pinned method list moves to 27 (§1 rule 4). None of the five methods joins `REPLAY_SAFE_METHODS` / `replay_safe`; export is a read, but stays out for uniformity. All five keep the default deadlines.
   - **Gating:** each method is gated on `system.probe` `methods`. `includeArchived` is sent only when `conversation.archive` is advertised.
   - **Chat surfaces get:**
     - rename;
     - archive / unarchive;
     - a "show archived" filter;
     - delete through the A1 two-step dialog pattern;
     - export;
     - "sandbox chosen at creation", when the feature is advertised.
     - Send and rename are disabled on an archived conversation, showing Core's reason.
   - **Export destination:**
     - VS Code and JetBrains: the native save dialog. The file is written only to the path the user picks.
     - Desktop: there is no dialog plugin (A3a W3), so it shows the redacted export read-only, with a **Copy** button. Saving to a file waits for `@tauri-apps/plugin-dialog`; this is disclosed.
   - **After a delete,** any client-side selection of that conversation is cleared. An unknown step-2 outcome is settled by re-reading `conversation.list {includeArchived: true}`, as in A3a.

### 3.4 A4 decisions (`conversation.send` mode), fixed before implementation

1. **Wire.**
   - `ConversationSendParams.mode?: "task" | "discuss"` (`Option`, `skip_serializing_if`). Absent means `"task"`.
   - **Hash stability:** Core normalizes an explicit `"task"` to absent *before* the idempotency fingerprint is computed. Every A2 hash stays stable, and two clients that differ only in sending `"task"` explicitly get a replay, not a `CONFLICT`. Any other value is `VALIDATION_FAILED` (`mode must be "task" or "discuss"`).
   - `TaskSummary.mode?: string` is present on every task created from A4 on (`"task"` or `"discuss"`) and absent on older rows. Clients decode it as an **open string**, never a strict enum (§1 table): an unknown value is displayed as-is, never a decode failure.
   - Migration v7 adds `tasks.mode TEXT` and `tasks.chosen_sandbox_name TEXT` (item 3), plus an index on the latter, with the same backup and downgrade-refusal rules.
   - `features` gains `"conversation-send-mode"`. Clients send `mode` only when it is advertised, because a pre-A4 Core silently drops the field and would treat a discussion as a task.
2. **What `discuss` means.**
   - A `discuss` task never gets a writable workspace. The internal `create_task` API refuses `discuss` with any workspace request other than none or `mountless` (`VALIDATION_FAILED`, "a discuss task never gets a writable workspace; nothing was run").
   - The wire path has no workspace selection at all (item 4), so over the wire this cannot occur today. It is enforced and tested at the internal API.
   - The task's scaffold event says which mode was requested. With no verified adapter, both modes still record `PERMISSION_DENIED` and stay `queued` (honest, unchanged).
3. **Sandbox-name follow-up from A1 (describe, never refuse).**
   - From A4 on, a new task stores `tasks.chosen_sandbox_name` from its conversation's `sandbox_id` (A3b) at send time, and reports it as the new additive `TaskSummary.chosenSandboxName?`.
   - **`TaskSummary.sandboxName` keeps its pre-A4 meaning:** the sandbox a task is bound to, from `sandbox_bindings` only. A4 never fills it from the chat's choice. Shipped clients read `sandboxName` as "the sandbox this task runs in": the desktop derives a verified isolation label from it, and the VS Code and desktop stop dialogs count tasks by it. Overloading it would make them claim isolation and impact that do not exist (A4 Core review C1/C2).
   - It is a stored **name**, not an identity, and no task can run in a sandbox today. So `sandbox.stop` and `sandbox.remove` **never refuse** because of it.
   - `sandbox.remove` step 1 adds one impact line when unfinished tasks were sent from chats that chose this sandbox name: "N unfinished task(s) were sent from chats that chose this sandbox name; removing it does not cancel them".
   - `sandbox.stop` is unchanged.
   - The count reads only `tasks.chosen_sandbox_name` (no back-fill). Tasks created before v7 in a chat that chose the name are not counted. No shipped database has such rows, because v6 and v7 land in consecutive commits; the line is descriptive and never refuses.
4. **Not in A4: workspace selection on the wire** (new row A4b below). A `conversation.send` that creates a `host_worktree` task writes a task branch and a worktree into the user's repository, and every such task stays `queued` with no wire-level discard. That needs its own decisions:
   - which modes are allowed over the wire (never `direct_mount` without the live-writable label);
   - which repositories qualify;
   - how it interacts with the per-path writer lock;
   - a token-confirmed `worktree.discard`, or landing after A9's cleanup.

   Until then, `git.review`, `git.diff` and `git.apply` are reachable over the wire only for tasks that carry Git context, and the wire cannot create one. They are verified by Core integration tests that seed such tasks through the internal API and then send real frames through the dispatcher.
5. **Clients.**
   - Every pinned method list is unchanged (no new method).
   - Known-features lists gain `conversation-send-mode`.
   - The composer gets a Task / Discuss choice, shown only when the feature is advertised, with copy that says neither runs an agent in this build.
   - `TaskSummary.mode` (labelled "Send mode") and `chosenSandboxName` (labelled "sandbox chosen by its chat — not where it runs") are shown read-only, revealed and capped. `chosenSandboxName` never feeds isolation labels, stop or remove impact counts, or scope logic.

| # | Addition | Shape (additive) | Notes |
|---|---|---|---|
| A4b | Workspace selection on `conversation.send` + wire `worktree.discard` (token) | `workspace?: { mode, repoPath? }` | **Recorded, not scheduled.** Prerequisite for any wire-created task with Git context; designed and reviewed on its own because it writes host Git state. **Hard precondition (A6 §3.6 item 2 / C3):** before any path makes `host_worktree` creatable or binds a sandbox to a task worktree, `git.review` and `git.diff` on `host_worktree` must stop running git in the task worktree. Git is pinned to `--git-dir=<host common dir>`, and the task side is read only by Core. A test plants a hostile `.git` file and asserts that a marker filter never runs. |

### 3.5 A5 decisions (`git.diff` + `ChangeSet` fields), fixed before implementation

1. **Exact change list (fixes a latent parsing bug).**
   - `change_list` switches to `git diff --name-status -z --find-renames` and `git ls-files --others --exclude-standard -z`, and parses NUL-separated fields. Git C-quotes paths containing tab, newline, `"` or `\` even with `core.quotePath=false`, so today's line/tab parser returns quoted, wrong paths for such files.
   - `--find-renames` is explicit, because a user's global `diff.renames=false` would otherwise silently turn renames into an add plus a delete.
   - Copies are not detected (`-C` is not passed) and stay `added`.
2. **Wire fields** (`#[serde(default, skip_serializing_if)]`):
   - `FileChange.oldPath?`: set only for `renamed`.
   - `ChangeSet.repoPath?`: the canonical host repository root of the task (the integration target `hostDirty` describes).
   - `ChangeSet.uninspected?: string[]`: defined but **never produced in A5**. Repositories with submodules are still refused with `VALIDATION_FAILED`, as today.
3. **`git.diff {taskId, path, maxBytes?}`** → `{path, oldPath?, status, patch, binary, truncated, lossy, baseBlob?}`. Read-only, not replay-sensitive.
   - **Path gate.**
     - `path` must equal, byte for byte, the `path` of an entry in the task's change list, **recomputed at call time** with the same `review_target` and submodule refusal as `git.review`.
     - Otherwise: `VALIDATION_FAILED` "path is not in this task's change list; nothing was read".
     - No other path form is accepted: no prefixes, globs or `..`.
   - **Tracked entries** (added, modified, deleted, renamed):
     - argv: `git diff --no-ext-diff --no-textconv --no-color --find-renames --end-of-options <base> -- :(literal)<path>`, plus `:(literal)<oldPath>` for a rename (otherwise rename detection sees only one side);
     - same hardened runner and per-repository filter and attribute overrides as `change_list`.
     - Binary is decided by a prior `--numstat -z` run with the same pathspecs (`-\t-`). A binary entry returns `binary: true` and an empty patch. `--binary` patches are never produced.
   - **Untracked entries:** the patch is synthesized by Core; git is not run on the file.
     - The file is opened relative to the review target with `O_NOFOLLOW`. A symlink yields its target text, as git would store it.
     - The read is capped at `maxBytes + 1`.
     - A NUL in the first 8000 bytes means `binary: true`.
     - The patch is a standard new-file unified diff (`--- /dev/null`, `+++ b/<path>`, one `@@ -0,0 +1,N @@` hunk, and `\ No newline at end of file` when it applies).
   - **Bounds and the frame cap:**
     - `maxBytes` is clamped to 1..=524 288 (default 262 144). JSON escaping can grow a byte at most six-fold, so a maximal patch still serializes under the 4 MiB frame.
     - Git output for `git.diff` goes through a **display-only** capped read that returns the first `maxBytes` bytes plus a `truncated` flag, instead of `exec`'s refusal. It is used only by `git.diff` and never for a decision; the change-list and dirty paths keep refusing truncated output.
     - Truncation cuts at the last newline at or before the cap, or at a UTF-8 character boundary when there is none.
   - **Encoding:** non-UTF-8 bytes in a text patch are decoded lossily (U+FFFD) and disclosed with `lossy: true`.
   - **`baseBlob`:** the base-side blob id from `git ls-tree -z <base> -- :(literal)<oldPath or path>`. It is absent for added and untracked entries. There is no `taskBlob` in A5; the design-table field is dropped, because hashing working-tree content would need `hash-object` on agent-written files. A6 decides what it needs.
   - **Implementation decisions (recorded at A5 review):**
     - **`git.diff` output is display-only and must never be fed to `git.apply` or any apply path (A6 constraint).** Synthesized untracked patches carry `new file mode 120000`, so applying one would create a symlink with an agent-chosen target.
     - Clients take file names from the JSON `path`/`oldPath`, never from the patch header. A name containing ` b/` makes git's `diff --git` line ambiguous, exactly as in git itself.
     - Residuals accepted at re-review: in the window between `fstatat` and `openat`, a swap to a device node still runs its driver's `open` once before the inode check refuses it. Closing this needs Linux `O_PATH`, and it requires `mknod` on the host share. Separately, a crafted stat-clean index entry plus `objects/info/alternates` can show a blob whose SHA the attacker already knows.
     - **Work tree pinned (A5 review C1):** every hardened git invocation passes `--work-tree=<cwd>` as a global option. A repo-local `core.worktree`, which an agent can set under `direct_mount`, could otherwise point git outside the review target, so `git.diff` would read host files and `is_dirty` would report "clean". `-c core.worktree=` does not override repo config; `--work-tree` does.
     - The patch shape is pinned (`--src-prefix=a/ --dst-prefix=b/ -U3`), so user or repo `diff.*` config cannot change headers or context.
     - `git.diff` accepts an optional `status`. If a path is listed more than once (e.g. `deleted` and `untracked` after `git rm --cached`) and no `status` is given, Core refuses: "path is listed more than once in this task's change list; pass its status; nothing was read". Clients always send the entry's status.
     - `binary: true` can come from repository attributes (`-diff` in `$GIT_DIR/info/attributes`, a documented residual). Clients word it as "treated as binary (possibly by repository attributes) — no text diff shown".
     - Pathspecs travel as a separate argv channel after `--`, constructed only by `LiteralPathspec::new` (`:(literal)` + the path of the matched change entry; empty or NUL refused). They are exempt from the shell-metacharacter tripwire that guards ordinary args, because filenames may legitimately contain `\n`, `$(`, backticks, `&&` or `||`. No shell is involved anywhere (typed argv).
     - `--ignore-submodules=dirty` is added to the patch and numstat argv, and `--end-of-options` to `ls-tree`.
     - Untracked reads walk the path component by component with `openat` (`O_DIRECTORY|O_NOFOLLOW` per directory, `O_NOFOLLOW|O_NONBLOCK` for the leaf, `readlinkat` for a symlink leaf). Only regular files are read; directories (e.g. a nested repository), FIFOs, sockets and devices are refused with `VALIDATION_FAILED`.
     - A path git reports with non-UTF-8 bytes cannot be named exactly over JSON, so it is refused: "this path is not valid UTF-8, so Core cannot name the file exactly; nothing was read".
     - Truncated untracked patches are rebuilt from whole lines, so the hunk header stays exact. Truncated tracked patches are a plain cut of git's output, so the hunk header may promise more lines than are shown; `truncated: true` discloses it.
4. **Errors:**
   - unknown task: `NOT_FOUND`;
   - no Git context: the existing `VALIDATION_FAILED` "task has no Git context (repo binding + base_commit)";
   - worktree removed: the existing message;
   - submodules: `VALIDATION_FAILED`;
   - path not in the list: the message above;
   - git failure: `INTERNAL`.
5. **Method count:** 28 (A3b's 27 plus `git.diff`). Every pinned list moves together. `git.diff` is a read, but stays out of `REPLAY_SAFE_METHODS` / `replay_safe` like the other A-series methods. It does **not** use the default deadline: git runs under `RunLimits::QUERY` (30 s) for both the change list and the diff, so every client gives `git.diff` the 45 s git deadline from A3a W2 (desktop proxy 43 s / webview 45 s; JetBrains 45 s). `git.review` already has the same exposure, so its deadline moves to 45 s in the same commit.
6. **Verification:**
   - Core integration tests seed tasks with real Git context through the internal API against temporary repositories, including `host_worktree`. They cover modified, added, deleted, renamed (with old and new pathspecs), untracked, symlink, binary, non-UTF-8, truncation, and paths containing tab, newline and quotes. Each sends real `git.review` / `git.diff` frames through `handle_line`.
   - Over the wire the live checks can confirm only that the method is advertised and answers "task has no Git context". This is recorded as UNVERIFIED until A4b.
7. **Clients:**
   - The review surface gets a per-file "Diff" action for entries returned by `git.review`, gated on `git.diff` being advertised.
   - VS Code renders through its native diff editor where the patch allows, otherwise as a read-only text document. JetBrains uses its diff viewer or a read-only viewer. Desktop uses a read-only monospace view.
   - `binary`, `truncated` and `lossy` are disclosed, and `oldPath → path` is shown for renames.
   - Patch text is untrusted data: revealed, never rendered as HTML or Markdown, never executed.

### 3.6 A6 decisions (`git.apply` for reviewed files), fixed before implementation

This is the first path that writes into the user's own repository (AGENTS.md rule 7, specs/06 §6). It binds the apply to the exact content Core hashed at review, never merges into the user's edits, never writes beyond a symlink, and records itself durably. It **supersedes the A6 table row**: there is no `--3way` and no `cherry-pick`. With `HEAD == base` enforced and the touched paths clean, `--3way` could only act when the preimage does not match, and it would then leave conflict markers and unmerged entries in the user's tree. That is not a rollback. A whole-task apply is simply every entry through the same path.

The design-level `security-reviewer` pass on the first draft returned **BLOCK**. C1–C3 and W1–W4 were proven by git 2.56 probes on APFS; C4 was found by analysis. Every finding is folded in below and tagged with its id. A re-review returned PASS-WITH-WARNINGS. Its R1–R8 are folded in as well.

1. **Scope by workspace mode.**
   - `host_worktree` is the only mode that applies.
   - `direct_mount` is refused: "this task worked directly in your repository; its changes are already in your working tree, so there is nothing to apply". This resolves the old `preconditions_for_apply` scope-limit comment without weakening the gate.
   - `sbx_clone`, a removed worktree, and no Git context are refused with the existing review messages. The submodule refusal is unchanged.
   - Today `sandbox.create` refuses `host_worktree`, so A6 is reachable only for tasks seeded internally. It is recorded as UNVERIFIED until A4b.
2. **No git process on the apply path reads the task worktree (C3).**
   - The worktree's `.git` file is agent-writable, and every git process re-reads it. It can name an agent-owned gitdir whose `commondir` points back at the host, so the common-dir, toplevel and worktree-list checks all still pass. That gitdir's filter config then runs on the host.
   - Therefore every task-side git call on the apply path passes `--git-dir=<canonical common dir of the REGISTERED host repository>`. That directory is derived from the registered repository, never read from the worktree. Pinning `<common>/worktrees/<id>` is not enough, because its `commondir` may be agent-writable.
   - **Every** task-side call, including the runner's own filter and object-format enumeration (`repo_overrides`), runs with `--git-dir=<common>` and cwd = Core's temp dir, never the task worktree. The object format used for `taskBlob` is read once from the host common dir's config (R3).
   - The task side is read **only by Core**, through the A5 `openat` walk (`O_DIRECTORY|O_NOFOLLOW` per component, `fstatat(AT_SYMLINK_NOFOLLOW)`, `O_NOFOLLOW|O_NONBLOCK` leaf, inode check).
   - **A4b precondition (recorded, not part of A6):** A5 `git.review` and `git.diff` on `host_worktree` still run git in the worktree, so a raced `.git` file could run a clean filter. Before A4b makes `host_worktree` creatable, the host_worktree change list must move to the same model: git pinned to the host common dir, with the task side read by Core.
3. **Content binding.**
   - **`FileChange.taskBlob?` / `taskMode?` on `git.review`** (additive), produced only for `host_worktree` tasks:
     - `taskBlob` = `H("blob <len>\0" + bytes)`, over bytes Core read itself. `H` is SHA-1 (collision-detecting, matching git's sha1dc; RustCrypto `sha1collisiondetection`, new dependency, `cargo deny`/`cargo audit` when added) or SHA-256 (`sha2`), according to the repository's object format.
     - `taskMode` is `100644`, `100755` or `120000`, from `lstat`.
     - Both are absent for `deleted` entries and for files over the **32 MiB** apply cap (disclosed as "too large to apply").
   - **`git.diff` derives `taskBlob`/`taskMode` and the displayed patch from ONE read (C4).** On `host_worktree`, Core reads the task file once (full content up to the cap), hashes it, and renders the display from those same bytes. The base side comes from objects (`baseBlob`), and the diff is computed between the two Core-owned temp files with `git --git-dir=<common> diff --no-index --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ -U3 -- <tmp/base> <tmp/task>` (cwd = the Core temp dir; `--no-index` fails without a repository under `GIT_ATTR_SOURCE`, R2). `binary` is decided from the bytes read (git's NUL-in-first-8000 rule on both sides), not from a git read of the worktree. Header names are temp names; clients already take names from JSON (A5). Display truncation applies only after hashing. Untracked entries hash the full content, not the `maxBytes + 1` prefix.
   - **`ChangeSet.reviewId?`** (additive, R4): an opaque id for each `git.review` answer on a `host_worktree` task. Core keeps the last 8 per task in memory, so a Core restart means review again. `git.review` never lists ignored files (`--exclude-standard`), and the id is what makes "reviewed" mean "Core listed it". It is not a human-presence token.
   - **`git.apply` params gain `reviewId?` and `entries?: [{path, status, oldPath?, taskBlob?, taskMode?}]`** (additive), copied verbatim from the reviewed `git.review` answer. Every entry must be a member of that review, with identical `path`, `status`, `oldPath`, `taskBlob` and `taskMode`. Otherwise: "entries do not match a review Core produced; review again; nothing was written".
     - A6 apply **requires** `reviewId` and `entries`. `selectedFiles` without `entries`, both together, or an empty list are refused (`VALIDATION_FAILED`, "…; nothing was written"). An empty list never means "all".
     - Paths travel in a typed raw-path argv channel built only from a validated entry (like `LiteralPathspec`; empty and NUL refused), because `--cacheinfo`/`--force-remove` take raw paths, not pathspecs.
   - **Entry validation from Core alone:** the base side comes from `ls-tree -z <base>` under `--git-dir=<common>`; presence, type and hash come from the `openat` walk. Required state per status:
     - `added`/`untracked`: absent in base, a present regular file.
     - `modified`: present in base, a present regular file.
     - `deleted`: present in base, the leaf absent (ENOENT) with real-directory ancestors.
     - `renamed`: `oldPath` present in base and absent in the worktree; `path` absent in base and present.
     - Any mismatch, or a hash or mode different from `taskBlob`/`taskMode`: "<path> changed since it was reviewed; review it again; nothing was written".
   - **Entry policy:** mode `120000` (symlinks) is refused ("symlinks are never applied"); gitlinks are refused; a path listed twice is refused. An executable-bit change is allowed and disclosed. A case-only rename on a case-insensitive filesystem fails closed in git ("already exists") and is disclosed as unsupported. A typechange (`T` in `diff-tree --raw`, symlink↔file) counts as `modified` in the exact-set check. Any target whose base mode is `120000` (deleting a tracked symlink, or a symlink→file change) is refused as unsupported and disclosed (R7).
4. **Snapshot from objects only.**
   - Each selected non-deleted entry's bytes (from the step-3 read) are copied into a Core-owned `0700` temp dir. `hash-object -w --no-filters -- <tempfile>` under `--git-dir=<common>` must print exactly `taskBlob`.
   - In a temp index (`GIT_INDEX_FILE` set by Core inside its temp dir; the env scrub strips inherited `GIT_*`): `read-tree <base>`, then `update-index --add --cacheinfo <mode>,<oid>,<path>` per added or modified path and `update-index --force-remove -- <path>` per deleted path or rename `oldPath`, then `write-tree` → the snapshot tree. `update-index` runs without `--replace`, and any `update-index` failure is reported as "changed since it was reviewed" (R8).
   - **Exact-set check (C1).** Literal pathspecs prefix-match directories (`:(literal)a` matches `a/b`), so no step may be pathspec-scoped. Core runs `diff-tree -r -z --raw --no-renames <base> <snapshot>` **without a pathspec**. The resulting set of (path, status, new mode, new oid) must equal the selected entries exactly: a rename is a delete of `oldPath` plus an add of `path`, nothing more and nothing less. Otherwise: "<path>: the snapshot differs from the reviewed entries; nothing was written". This is also what makes directory/file swaps fail closed.
   - The patch is then generated, again **without a pathspec**: `git -c diff.suppressBlankEmpty=false diff-tree -r --binary --full-index --no-renames --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ <base> <snapshot>`, written to the Core temp dir. The `-c` is a global option before the subcommand, passed through the runner's config channel; after the subcommand it would be diff-tree's combined-diff flag (R1).
   - It is never built with the `git.diff` builders or the display-capped runner (A5 constraint; a test pins this).
   - Snapshot objects in the shared store stay unreferenced and are pruned by git normally.
5. **Host gates** (host repository, hardened runner, work tree pinned, plus `confirm_work_tree` on the host root):
   - the repo-wide submodule scan;
   - `HEAD` == the recorded base == `expectedBase` (exact full oid);
   - every touched path (`path`, and `oldPath`) is absent from `git status --porcelain=v1 -z --untracked-files=all --ignored=matching -- :(literal)…`;
   - **hidden index entries (W3):** any touched path flagged assume-unchanged or skip-worktree (`index_hidden_entries`, scoped to the touched paths) is refused;
   - **host leading-path check (C2):** with `--index`, git's "beyond a symlink" check consults only the index, so an untracked or ignored symlinked directory (e.g. a symlinked `node_modules`, `.venv` or `data`) would send the write outside the repository. For every touched path, Core walks the host work tree with `openat` (`O_DIRECTORY|O_NOFOLLOW`):
     - every existing ancestor must be a real directory;
     - a create target's leaf must be absent;
     - a modify or delete target's leaf must be a regular file (`fstatat AT_SYMLINK_NOFOLLOW`);
     - otherwise: "<path> lies under a symlink or a file in your working tree; nothing was written".
     
     Residual (disclosed): the window between this walk and git's write. The writer lock (item 8) and the refusal while any live `direct_mount` sandbox or task mounts the same repository (code review W-C) leave it usable only by the user's own concurrent actions.
   - **filtered paths (R5):** a touched path whose host attributes name a `filter` (e.g. LFS) is refused, because filters are blanked and it would receive raw content. This is evaluated with `git check-attr -z filter -- <raw paths>` in the host repository WITHOUT the `GIT_ATTR_SOURCE` override: the host's `.gitattributes` are the user's, and `check-attr` executes nothing. A selected entry that adds or modifies `.gitattributes` is flagged in the confirmation.
6. **Write.**
   - `git apply --check --index --whitespace=nowarn <patchfile>`, then `git apply --index --whitespace=nowarn <patchfile>`.
   - **Pins (W4):** `core.autocrlf=false`, `core.safecrlf=false`, `core.symlinks=true`, `core.fileMode=true`, `core.protectHFS=true`, `core.protectNTFS=true`, `core.checkStat=default`, `core.trustctime=true`, `core.splitIndex=false`, `core.sparseCheckout=false`, `index.sparse=false`, and `apply.whitespace`/`apply.ignoreWhitespace` neutralized. A test runs each with hostile user and repo values.
   - **Budget:** the total patch size is capped, so the whole chain (scans, gates, snapshot, check, write, verify) fits well inside the 45 s client deadline. The write runs under its own limit, not the QUERY kill. If that limit fires, Core kills git and reports the W1 outcome with `partial: true`, adding that `.git/index.lock` may remain and must be removed only after checking that no git process is running (R6).
   - **`--check` failure:** `applied: false`, abortReason "the patch does not apply cleanly; nothing was written", and `conflictedFiles` = the paths git names (repo-relative, parsed defensively, capped).
   - **Failure after `--check` passed (W1):** if the write itself fails or is killed, `applied: false`, abortReason "the write failed after git's checks passed; some files may have been written or staged — check `git status` in <repoPath>". It is never "nothing was written".
   - **Post-write verification (W2):** `git apply` does not verify text postimage oids. So host `ls-files -s -z` for the touched paths must equal the snapshot entries (oid and mode; deleted paths absent), and `diff-files --quiet` on them must be clean. A mismatch is a non-success: "files were changed, but the staged content differs from the reviewed content — check `git status` in <repoPath>".
   - The result is staged in the host index and working tree. **Nothing is committed.**
7. **Result (additive):**
   - `ApplyResult.appliedFiles?: string[]`;
   - `ApplyResult.modeChanges?: [{path, from, to}]`;
   - `ApplyResult.snapshotTree?`;
   - `ApplyResult.partial?: boolean`, true only for the W1 and W2 outcomes.
   - Gate failures keep the structured `applied: false` + `abortReason` shape, with stable message constants. Malformed params are `VALIDATION_FAILED`.
8. **Durability, locking, retries.**
   - **Locking (W6):** apply takes the scheduler writer lock for the host repository path. If any writer holds it (e.g. a `direct_mount` task), or another apply or worktree discard is running, the answer is `CONFLICT` and nothing runs.
   - **Durability (W7):** a durable `git.apply.started {files, baseCommit, snapshotTree}` task event is appended before the first host write, and `git.applied` / `git.apply.failed` after it, before the response (rule 4). On restart, an unterminated start is reconciled against the host index and recorded as applied, partial or not applied, never assumed. These are new event types, not enum values.
   - **Retries:** `git.apply` is not replay-safe and never in a client's read-only set. A lost answer is "may have been applied — check `git status` in the repository before retrying". A retry after success fails closed, because the touched paths are now staged and the item 5 gate refuses them.
9. **Confirmation (rule 7; W5).** No Core token: §2's token proves nothing about human presence, and the content binding already ties the apply to the reviewed bytes. Instead:
   - Clients MUST show a native modal **opened only from a user gesture**, never triggered by chat, agent or tool text. It names the repository (`repoPath`, revealed) and lists every file with its status.
   - It separately flags:
     - entries whose content was never fully shown (binary, truncated, or never opened in a diff);
     - executable additions and exec-bit changes;
     - paths that run automatically: under `.husky/`, `.githooks/`, `.github/workflows/`, `.envrc`, `.vscode/`, `.idea/`, `.gitattributes`, `.gitmodules`, or the host's effective `core.hooksPath` when Core reports it as repo-relative (`ChangeSet.hostHooksPath?`, additive).
   - It says the files are written into the working tree and staged, nothing is committed, and the content is "the version Core hashed when you reviewed".
   - If a `git.diff` the user opened returned a `taskBlob` different from the entry's, the client MUST NOT send, and asks for a re-review.
10. **Feature and deadline.**
    - The new feature `git-apply` (5 features) is advertised only by a Core that implements items 1–9. Clients enable Apply only when it is advertised; otherwise they keep the current "not implemented" state.
    - The method count stays 28.
    - `git.apply` uses the 45 s git deadline (desktop proxy 43 s). A timeout is reported as a lost answer, per item 8.
11. **Code review outcome (recorded at A6 Core review, PASS-WITH-WARNINGS).**
    - **Fixed before commit:**
      - W-A: new content is capped at 64 MiB per call (`MSG_CONTENT_TOO_LARGE`), the deadline is checked per entry, and the cheap host gates run before any `hash-object -w`, so a refusal writes no objects;
      - W-B: one deadline per phase, each covering its config probes (prepare + check 20 s, write 15 s, verify 6 s, total 41 s against the 45 s client deadline). A write cut off before `git apply` starts is a non-partial `MSG_WRITE_NOT_RUN`; a verify that cannot finish is a partial;
      - W-C: apply returns CONFLICT (`msg_mounted`) while a non-removed `direct_mount` sandbox binding or a non-terminal `direct_mount` task uses the same canonical repository. It is checked after the lock, after prepare, and right before `git.apply.started`; an unknown mode counts as direct;
      - I1: the enumeration requires empty stderr, plus a nonexistent-gitdir C3 trap (that condition's mutation survives: no git input was found that exits 1 with stderr);
      - I2: outcome events carry `startedSequence`, and reconciliation closes only matching starts;
      - I3: a `--check` timeout or failure (`MSG_CHECK_UNAVAILABLE`) is worded separately from "does not apply";
      - I5: a single-test binary with a temporary hostile `HOME` gitconfig proves the command-scope pins win;
      - I6: the SHA-1 collision test vector carries a provenance and MIT notice.
    - **Accepted:** I4 (splitIndex together with manyFiles gets a misleading label, but the apply still fails closed); I7 (a pure rename has an empty patch, covered by the display note below).
    - **Re-verification (PASS-WITH-WARNINGS), fixed before commit:**
      - W-N1: a `direct_mount` `sandbox.create` holds the repository writer lock for the whole create. It returns CONFLICT ("…; nothing was created") while an apply, writer task or discard holds the lock. An apply during such a create returns CONFLICT `msg_mount_being_created`.
      - W-N2: every snapshot-phase git call runs in an object quarantine (`GIT_OBJECT_DIRECTORY` under Core's temp dir, with the host objects as a C-quoted alternate). Any refusal therefore leaves the host object store unchanged. `snapshotTree` names the tree Core built from the reviewed entries, but it is built in that temporary quarantine and removed after the call: it is not stored in your repository's object store and does not identify any commit. The patch alone applies on the host, as tested for text, binary literal and delta, mode-only, add and delete.
      - I-N1: the write-phase config probe is capped at 3 s, and `git apply` is not started with less than 5 s left (`MSG_WRITE_TOO_LATE`, non-partial).
      - I-N3: a direct-mount binding with no repository counts as a match.
      - I-N2: a SQL prefilter that only excludes safe values.
      - N14: a unit test now covers the stderr condition.
    - **Accepted residuals:**
      - I-N4: outcome events written before `startedSequence` existed are reconciled once (development databases only).
      - I-N5: INTERNAL messages carry capped git stderr (pre-existing).
      - A crash during prepare can leave one call's quarantine (≤ ~64 MiB) under Core's `<data>/tmp`, outside your repository; there is no startup sweep yet.
      - A worktree discard during a direct-mount create gets the existing `msg_locked` text, whose parenthetical does not name that holder.
      - `core.hooksPath=.` (the repository root) yields no `hostHooksPath`, so clients cannot raise flag (c) for root-level hook files. Hooks must be executable to run, so flag (b) (`100755`) still marks them.
    - **Still open, as the recorded A4b precondition (W-D):** A5 `git.review`/`git.diff` on `host_worktree` run git in the task worktree (item 2).
    - **Display note:** on `host_worktree`, `git.diff` headers use Core temp names, and a pure rename returns an empty patch. Clients render it as "renamed, content unchanged".
12. **Verification.**
    - Core integration tests seed `host_worktree` tasks through the internal API, on real temporary repositories with a real linked worktree, and send real `git.apply` frames. They cover:
      - modified, added, deleted, renamed, exec-bit and binary entries;
      - tab, newline and quote paths;
      - every refusal above, including the C1 directory/file swap, C2 untracked and ignored symlinked ancestors, a C3 planted `.git` file (a marker script must never run), and the C4 single read;
      - W1 failure after the check, W2 verification, W3 hidden entries and W4 hostile config;
      - a lost-answer retry, a concurrent apply, writer-lock contention and restart reconciliation.
    - Mutation runs cover the gates.
    - Over the wire, the live checks can confirm only the advertisement and the "no Git context" refusal (UNVERIFIED until A4b).

### 3.7 A7 decisions (verification commands + `project.context`), fixed before implementation

A7 is the first addition that **executes** something. It runs user-approved argv vectors inside a task's sandbox through `sbx exec`. Nothing ever runs on the host (specs/06; AGENTS.md rules 1–2). The real `sbx` is never run while Sandpane is being built. Every `sbx exec` fact below that a capture has not proven is marked **UNVERIFIED**, and item 12 lists the captures that would prove it.

The design-level `security-reviewer` pass on the first draft returned **BLOCK**. The block was one Critical: approved argv and labels were stored and replayed unredacted. The same pass raised Warnings W1–W9 and Info I1–I7. A cobra v1.10.2 / pflag v1.0.10 probe showed that the `sbx exec -- NAME argv…` shape never turns an argv element into an `sbx` flag, under both interspersed and non-interspersed parsing. Every finding is folded in below and tagged with its id. A re-review returned PASS-WITH-WARNINGS. Its R1–R4 and Info I-a–I-h are folded in as well.

1. **Wire (additive; 28 → 34 methods; features 5 → 6).**
   - **`verification.list {projectId}`** → `{commands: VerificationCommand[]}`, ordered by `approvedAt`, with revoked commands excluded.
     - `VerificationCommand {id, projectId, label, argv: string[], approvedAt}`.
   - **`verification.approve {projectId, label, argv}`** → `{command: VerificationCommand}`.
     - Approving the same `argv` again (byte-equal, not revoked) returns the existing command, with its label unchanged.
     - A project holds at most 50 live commands; revoked ones do not count. More is `VALIDATION_FAILED`.
   - **`verification.revoke {commandId}`** → `{revoked: true}`.
     - The row is tombstoned (`revoked_at`), never deleted, so older events' `commandId` still resolves.
     - A run that is already in flight is not stopped. Run start checks revocation inside its transaction (item 5).
   - **`verification.run {taskId, commandId, expectedSandboxName, expectedWorkspaceMode, idempotencyKey?}`** → `{runId, startedSequence}`. It is **asynchronous** (item 5).
     - It never takes argv or a path, so only approved commands can ever run.
     - The two `expected*` values are what the run dialog showed the user (`TaskSummary.sandboxName` / workspace mode). Core compares them with the binding and the live listing (W5), following the A6 `expectedBase` pattern.
   - **`verification.result {runId}`** → `VerificationResult {runId, taskId, commandId, label, argv, sandbox, workspaceMode, outcome, exitCode?, stdout, stderr, stdoutTruncated, stderrTruncated, redactions, elapsedMs, startedAt, finishedAt?}` (W1). An unknown run is `NOT_FOUND`; a run still in flight returns `outcome: "running"`.
   - **`project.context {projectId}`** → `{repositories: [{repoPath, detected: [{manifest, suggestedCommands: string[][], notes: string[]}], unreadable: string[]}], approved: VerificationCommand[]}` (item 9).
   - **Methods** go in `Method::ALL` after `git.apply`, in this order: `verification.list`, `verification.approve`, `verification.revoke`, `verification.run`, `verification.result`, `project.context`. Every pinned list moves together, to **34**.
   - **New feature `"verification"`.** Clients enable the verification UI only when it is advertised.
   - **Archived projects (R4):** `verification.approve` and `verification.run` are refused on an archived project with the A3a message ("project is archived; unarchive it first; nothing was changed"). `verification.run` is also refused when the task's conversation is archived, with the A3b message. `verification.revoke` is always allowed, because it only narrows what can run.
   - **Errors:**
     - `NOT_FOUND`: unknown project, command, task or run.
     - `VALIDATION_FAILED`: malformed input, a secret in an approve (item 2), a command from another project, or a gate refusal (item 4, text ends "nothing was run").
     - `NOT_INSTALLED`: no `sbx`.
     - `UNSUPPORTED_SBX_VERSION`: the version gate (item 3).
     - `CONFLICT`: a run already in flight for the task, the sandbox or the repository, the global cap, or a bad idempotency replay (A2).
2. **Approve validation (Core is the authority; clients are never stricter).**
   - `label`: 1–80 characters, no control characters, no bidi or invisible format characters. Leading and trailing whitespace is trimmed.
   - `argv`:
     - 1–64 elements;
     - each element at most 4096 bytes, all of them together at most 16 KiB;
     - valid UTF-8 with no NUL, and no other control character: C0 except TAB and LF, DEL, and C1 U+0080–U+009F are refused (code review W1: each one serializes as a 6-byte escape and could push a listing past the frame limit);
     - `argv[0]` is non-empty and does not start with `-` (hygiene only, I1: after `--` no element can become an `sbx` flag).
   - **No secrets (C1).** Each argv element, the label, the space-joined argv and its JSON form go through `redact::redact`. The joined and JSON forms catch a secret split across elements (code review W3). The same check runs again at run start, so a command stored under an older, weaker redactor is refused there.
     - Any replacement → `VALIDATION_FAILED` "argument N looks like a secret (<kind>); approved commands cannot hold secrets; nothing was approved", or "the label looks like a secret …".
     - `RedactorUnavailable` → the approve is refused: "the secret check is unavailable, so nothing was approved".
     - Only proven-clean argv is ever stored, put in events or returned. The approve dialog says "Do not put tokens or passwords in arguments".
     - **False positives (I-g):** a harmless argument shaped like a secret (e.g. `--password-file=/path`) is also refused, and there is no override. That is fail-closed. The refusal names the kind and says the argument can be renamed or moved into a script.
   - Nothing else is interpreted. There is no shell, no splitting and no globbing, and no path or allowlist check on `argv[0]`. The user approves an exact vector.
   - Clients collect argv as a list. If a client offers a one-line field, it must show the user the resulting list before approving. Clients never pass a string through a shell-like splitter silently.
3. **What runs (one fixed spawn).**
   - **Argv:** `sbx exec -- <sandbox name> <argv…>`. Core passes no `-i`/`-t`/`-u`/`-e`/`-w`/`--privileged` and no `--cloud`.
   - **Process:**
     - stdin is `/dev/null`;
     - the process runs in its own group;
     - `current_dir` is a Core-owned empty 0700 directory, so sbx cannot derive anything from Core's working directory (W6).
   - **Environment (W4):** cleared, then an allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG` and `LC_*`. Host tokens in Core's environment never reach `sbx`.
   - **Same context for the gates (R2):** the identity gate's `sbx ls --json` and the version probe run with exactly the same environment allowlist and the same Core-owned working directory as the exec, so they cannot consult a different daemon or context. A test asserts the identical environment and working directory across all three invocations.
   - **Flag safety:** the `--` comes **before** the sandbox name. The probe proved that, under stock cobra/pflag, no later element is ever read as an `sbx` flag, in either parsing mode. Other shapes fail: without `--`, interspersed parsing injects `-u root --privileged --cloud`; with `NAME --`, non-interspersed parsing passes the `--` into the command.
   - **UNVERIFIED (C-1, W6):**
     - sbx's own argument handling after parsing (e.g. resolving a default sandbox when `ArgsLenAtDash() == 0`);
     - whether sandboxd joins argv into a shell string;
     - the cobra/pflag version sbx actually links.
   - **Version gate (W6; sbx-cli rule 4).**
     - Core spawns `sbx exec` only for sbx versions in `VERIFIED_EXEC_VERSIONS`, a list that holds a version only after C-1, C-2, C-5 and C-7 are captured for it (item 11).
     - The list is **empty** in A7. Any other version returns `UNSUPPORTED_SBX_VERSION` "sbx exec argument passing has not been verified for sbx <version>; nothing was run".
     - Integration tests add the fake `sbx` version through a test seam.
     - This is honest: the feature, approvals, `project.context` and results are real, and running is gated on proof.
   - **The sandbox name** comes from the task's **binding** (`sandbox_bindings`, the same source as `TaskSummary.sandboxName`). It is never taken from `chosenSandboxName` or from the client, and it is re-validated with `sandpane_core::validation` before it becomes an argument.
   - **No working directory is passed.** The command runs in sbx's default working directory (C-5), and every client says so.
4. **Pre-run gates (nothing runs if any fails).**
   - **Binding:** the task exists and has a live binding. Otherwise: "this task is not bound to a sandbox; nothing was run". Over the wire no task has a binding until A4b, so a real run is reachable only for tasks seeded internally, recorded UNVERIFIED.
   - **Command:** it exists, is not revoked, and belongs to the task's project.
   - **What the user saw:** `expectedSandboxName` and `expectedWorkspaceMode` equal the binding. Otherwise: "the task's sandbox changed since you confirmed; nothing was run".
   - **Identity (W5):**
     - The binding must carry `sbx_id`. A fresh `sbx ls --json` must list the name with exactly that `id`.
     - Its `workspaces` (now parsed) must equal the binding's mount, compared as canonicalized paths (I-d: `/tmp` vs `/private/tmp` on macOS). That is the repository path for `direct_mount`, the task worktree path for `host_worktree`, the clone source for `sbx_clone`, and empty for `mountless`. Only the `direct_mount` shape is captured; the `host_worktree` and `sbx_clone` shapes are UNVERIFIED, and a mismatch fails closed.
     - Its `status` must be exactly `"running"`. `sbx exec` starts a stopped sandbox (captured help), so a stopped one is refused: "sandbox \"<name>\" is not running; sbx exec would start it; start it with `sbx run` in a terminal; nothing was run".
     - A NULL `sbx_id`, a missing or different id, a workspace mismatch, or an unknown status → "Core cannot confirm the sandbox's identity; nothing was run".
     - Disclosed residual (as A1): `exec` acts on a name, so a same-named sandbox swapped in between the listing and the exec would be the one used.
   - **`direct_mount`** bindings run. The run takes the **repository writer lock** for its whole duration, so it is never concurrent with an apply, a writer task, a discard or another `direct_mount` run on that repository (W7). A run on a repository whose lock is held by a running `direct_mount` writer task gets `CONFLICT`, which is intended (I-b). Releasing the lock after a timeout or kill does not stop writes: per C-4 the in-sandbox process may continue, and the timeout copy says so. Every label says "this sandbox mounts your repository directly; the command can change your working tree, including `.git/hooks` that later run on your machine" (I7).
   - **Concurrency (W7):** at most one run per task and one per sandbox, and at most 4 runs across Core. Exceeding any of these → `CONFLICT` "… a verification is already running …; nothing was run".
5. **Asynchronous, durable, reconciled.**
   - **Keyed replay first (R1).** When `idempotencyKey` is present, Core looks it up **before every other check** (A2 §3.1 item 4; A3b keyed replay). A stored result is returned as is, even while that run is still in flight or after its command was revoked. A key with different parameters is `CONFLICT`.
   - **Lock order (I-a).** For `direct_mount`, Core first takes the repository writer lock through the scheduler (non-blocking) and releases the scheduler mutex, and only then opens the DB transaction. The scheduler mutex is never nested inside the DB guard (the A3b C1 deadlock class). The writer lock is released on every failure path and by the drop guard.
   - **Start transaction (W7).** One DB transaction under the DB lock:
     1. re-check that the command is not revoked and belongs to the task's project;
     2. check and set the run concurrency, with an in-memory registry guarded by the same lock;
     3. insert the `verification_runs` row as `running`;
     4. record the idempotency key as **done**, with `{runId, startedSequence}` as its result, atomically with the row and the event (the `conversation.send` pattern, §3.1 item 3). A key is never left pending;
     5. append the durable task event `verification.started {runId, commandId, label, argv, sandbox, workspaceMode}`. The argv was proven clean at approve (C1).

     Commit, answer `{runId, startedSequence}`, then spawn on a worker thread. **No DB, scheduler or writer lock other than the run's own (`direct_mount` only) is held across the exec.**
   - **Worker:**
     - a drop guard writes the terminal state and clears the registry even on panic;
     - it tolerates the task having been deleted (a run in flight also blocks deletes; see below).
   - **One terminal record (R3).** Every terminal write is conditional (`UPDATE … WHERE status = 'running'`), and the terminal event is appended only when that update changed a row. The first terminal record wins: a run marked `interrupted` at shutdown is never overwritten by the `signaled` its own worker sees later. Interruption has **one** representation on both paths, `verification.finished {outcome: "interrupted"}`; there is no separate `verification.interrupted` kind.
   - **Outcome:** the run row is updated, then the durable event `verification.finished {runId, startedSequence, outcome, exitCode?, stdoutBytes, stderrBytes, stdoutTruncated, stderrTruncated, redactions, elapsedMs}` is appended. **Output never goes into events (W1).** It lives only in the run row, read through `verification.result`.
   - **Outcomes** are open strings, not an enum change:
     - `exited`, with `exitCode`;
     - `signaled`, with no code (W2);
     - `timed_out`;
     - `spawn_failed`;
     - `read_failed` (W2);
     - `possibly_sbx_error` (I3; see item 6);
     - `interrupted`.
   - **Idempotency:** `idempotencyKey` reuses A2 (24 h). The fingerprint is `{taskId, commandId, expectedSandboxName, expectedWorkspaceMode}`. A replay returns the same `{runId, startedSequence}` and never runs a second time. Clients always send a key, so a lost answer can be retried safely.
   - **Limits (W2):** `RunLimits::VERIFICATION {timeout: 600 s, max_stdout: 64 KiB, max_stderr: 64 KiB}`, through a runner variant that **keeps the output captured so far** on timeout, read failure and kill. A timed-out run therefore still has its partial output.
     - At the deadline Core kills the process group: SIGTERM, 5 s grace, then SIGKILL.
     - **Disclosed:** killing the `sbx exec` client may not stop the process inside the sandbox (C-4). Copy: "the command may still be running inside the sandbox".
   - **Shutdown and restart (W3):**
     - On graceful shutdown, Core appends a terminal `verification.finished {outcome: "interrupted"}` for each in-flight run, then signals its process group (SIGTERM, grace, SIGKILL).
     - After a crash, a `verification.started` with no matching outcome (matched on `startedSequence`, as A6 I2) gets `verification.finished {outcome: "interrupted"}` at startup, and its row becomes `interrupted`. If that reconcile fails, Core refuses to serve (A2 item 7). Stale PIDs are never signalled after a restart (specs/02 §1).
     - **Disclosed:** after a crash, the orphaned `sbx exec` client and its in-sandbox process may keep running.
     - Copy: "Core restarted while this verification ran; its result is unknown, and the command may still be running inside the sandbox".
   - **Lifecycle (W7):**
     - `project.delete`, `conversation.delete` and `sandbox.remove` refuse while a run is in flight for any of their tasks or sandboxes ("a verification is running …; wait for it to finish; nothing was deleted"). `sandbox.stop` is unchanged and allows a stop during a run (item 14).
     - **Task status is never changed by a verification** (rule 3). A7 deliberately does not use the specs/02 §4 `verifying` state, and clients never show a verification as task status (I6).
6. **Exit status and output (honest, bounded, redacted).**
   - `exitCode` is **the exit status of `sbx exec`**. Whether sbx passes a command's non-zero exit through unchanged is UNVERIFIED (C-2). The only capture is `echo`, which exited 0, and sbx's own failures also exit 1.
   - **I3:** when stdout is empty and stderr has the captured `error: …` shape, the outcome is `possibly_sbx_error`, which keeps its `exitCode` (I-f), labelled "possibly sbx's own error, or the command's own output".
     - `classify_failure`'s code mapping is never applied to exec output.
     - A `try:` hint is never relayed as Core's advice.
   - Clients label the number "exit status (as reported by sbx exec)". They never say "tests passed" or "failed", and never colour exit 0 as a pass until C-2 is captured (I4).
   - **Storage:**
     - stdout and stderr are capped at 64 KiB each and redacted with the best-effort redactor **before** storage. The bytes are decoded lossily first, and that is disclosed (I5).
     - A secret cut at the cap can survive as a partial token, also disclosed (I5).
     - If the redactor is unavailable, the output is not stored; the result says so, and nothing raw is kept.
     - Output is kept only in `verification_runs`. A9 retention must cover these rows.
   - **Rendering (W9).** Output, labels, argv, notes and sandbox names are untrusted text, and clients render them revealed and capped:
     - as plain text: never HTML, never Markdown;
     - never in a terminal, pty or console widget (no VS Code terminal, no JetBrains `ConsoleView` with hyperlink filters);
     - every C0/C1 character except LF and TAB, including ESC, is escaped and shown visibly, so OSC 8 links, OSC 52 clipboard writes and file-link detectors cannot act. A CR is shown as `\r` (I-e);
     - no command links.
7. **Storage (W7).**
   - Migration **v8**, with the v4–v7 backup and downgrade refusal:
     - `verification_commands (id, project_id, label, argv_json, approved_at, revoked_at)`;
     - `verification_runs (id, task_id, command_id, sandbox_name, workspace_mode, argv_json, label, status, exit_code, outcome, stdout, stderr, stdout_truncated, stderr_truncated, redactions_json, started_sequence, started_at, finished_at)`.
   - The unused pre-A7 `verifications` table stays as is.
   - **Explicit delete order (A3a/A3b):** runs before tasks; commands before projects.
8. **Gestures and confirmations (binding for every client; W9).**
   - Approve, revoke and run each happen **only** from a direct user gesture on Sandpane's own control. They never come from chat, agent or tool text, an event, a reconnect or a timer.
   - No entry point accepts argv or a `commandId` from `command:` URIs, `executeCommand` arguments or action parameters. Every entry point opens the dialog and fills it from Core state.
   - **Approve** shows a confirmation that lists argv element by element (revealed, with the element count) and the label, plus "Do not put tokens or passwords in arguments". It also states:
     - "Approval binds this exact argument list, not what it executes. Commands such as `npm run test`, `make test` or `./gradlew test` run code from the repository that the agent can change after you approve.";
     - for a suggestion, the notes Core showed (item 9).
   - **Run** shows:
     - the command, the sandbox and the workspace mode, with the `direct_mount` warning (item 4);
     - "Runs in sbx's default working directory inside the sandbox; the result is the exit status reported by sbx exec; not yet verified against a real sbx";
     - in `host_worktree`, that the command can change files in the task's workspace, so a review taken before may no longer match. A later apply then refuses "changed since reviewed", and the client offers "Review again". A7 does not lift the W-D/A4b precondition (I7).
   - Revoke is a plain confirmation and is not destructive. VS Code reuses the A6 pattern: a modal plus a typed or QuickPick step whose Cancel is the default.
9. **`project.context` (read-only, bounded, no tool runs; W8).**
   - It reads only the project's **registered** repositories. Each root is opened with `O_DIRECTORY|O_NOFOLLOW` and an identity check against the registered canonical path; each manifest goes through the A5 race-safe `openat` read (`O_NOFOLLOW` leaf, regular file only, inode check).
   - A file is capped at 256 KiB. Anything larger, a symlink, a UTF-8 BOM, invalid JSON or an unreadable file goes into `unreadable` by name, with nothing taken from it.
   - Core never runs `npm`, `cargo`, `make`, `gradle` or any other tool. It adds **no new dependency**: JSON goes through `serde_json::Value` with the default recursion limit, never disabled, and a duplicate key takes the last value, like `JSON.parse` (pinned in a test).
   - **Detection** (root files only):

     | Manifest | Suggestion | Notes |
     |---|---|---|
     | `package.json` | `["npm","run","<name>"]` for each of the `scripts` keys `test`, `check`, `lint`, `build` that is present | `"npm run <name> runs: <text>"`, plus `pre<name>` / `post<name>` text when present, which npm also runs. A root `.npmrc` adds "this repository has an .npmrc that can change how npm runs scripts". Each note is capped at 512 bytes. |
     | `Cargo.toml` | `["cargo","test"]` | presence only |
     | `go.mod` | `["go","test","./..."]` | presence only |
     | `GNUmakefile`, else `makefile`, else `Makefile` (GNU make's order) | `["make","<target>"]` for `test` / `check` | the note names the file that was found. Only lines of the form `^<target>:` are matched, with a bounded line scan. |
     | `gradlew` (file) + `build.gradle(.kts)` | `["./gradlew","test"]` | "the Gradle wrapper may download Gradle from the URL in gradle/wrapper/gradle-wrapper.properties" |
     | `pyproject.toml` | `["python","-m","pytest"]` | presence only, "assumes pytest" |
   - Every note set also carries "this is the file in your registered repository now; the copy that runs in the sandbox may differ, and it runs in sbx's default working directory".
   - Suggestions and notes are **untrusted display strings**: shown revealed and capped, never auto-approved, never run. Approving one goes through the same gesture-only approve flow, with argv shown exactly. The secret check applies to it too.
   - `approved` repeats `verification.list` for convenience.
10. **Not in A7.**
    - verification on the host (never);
    - running suggestions without approval;
    - environment variables or a working directory per command;
    - cancelling a running verification (recorded follow-up; needs C-4);
    - retry policies (01 §122);
    - storing output as artifact files.
11. **A4b preconditions (W6, recorded beside W-D).**
    - **Capture gate (I-h):** before A4b makes `verification.run` reachable over the wire, C-1, C-2, C-5 and C-7 must be captured for the installed sbx version, and only then is that version added to `VERIFIED_EXEC_VERSIONS`. C-7 is what makes "no elevation inside the sandbox" a proven claim.
    - **Worktree discard (I-c):** the A4b `worktree.discard` must refuse while a `host_worktree` run is in flight for that task. A7 takes no worktree lock, because a `host_worktree` run writes only the task's own worktree.
12. **UNVERIFIED until captured.** The user can run these against a disposable provider-free `shell` sandbox; Sandpane never runs them while building.
    - **C-1 (argument passing):** `sbx exec -- <name> printf '[%s]\n' -u --privileged -e X=y 'a b' '$(id)' '*' --`. It must print every element literally, bracketed, and must not run as root or privileged.
    - **C-2 (exit status):** `sbx exec -- <name> sh -c 'exit 7'`. It must exit 7 and be distinguishable from an sbx error.
    - **C-3 (stopped sandbox):** `sbx exec` on a stopped sandbox. Confirm it auto-starts, which the gate assumes.
    - **C-4 (kill):** send SIGTERM, then separately SIGKILL, to the `sbx exec` client during `sleep 60`. Check whether the in-sandbox process survives each.
    - **C-5 (working directory):** `sbx exec -- <name> pwd`.
    - **C-6 (environment):** start `sbx exec -- <name> env` with a canary variable in the environment. The canary must not appear.
    - **C-7 (user):** `sbx exec -- <name> id`. It must be the sandbox's normal user, not root.
13. **Verification (Core).**
    - Integration tests use a fake `sbx` script, an executable in a test temp dir found through `SANDPANE_SBX_PATH`. It records its exact argv, environment and working directory, and plays back the captured `ls --json` and `exec` shapes. The fake's version is added to `VERIFIED_EXEC_VERSIONS` through a test seam.
    - They assert:
      - the exact argv (`exec`, `--`, name, argv, nothing else), the cleared environment and the empty working directory;
      - each gate's refusal, and that nothing is spawned on a refusal;
      - the version gate with the seam off;
      - the secret refusal at approve;
      - one run per task, sandbox and Core cap;
      - the `direct_mount` writer lock;
      - an idempotent replay, including a replay while the run is still in flight and a replay after a revoke (R1);
      - a revoke racing a run;
      - archived-project and archived-conversation refusals, with revoke still allowed (R4);
      - exactly one terminal record when shutdown and the worker race (R3);
      - the timeout kill with partial output kept;
      - `signaled` and `read_failed`;
      - shutdown interruption and restart reconciliation;
      - redaction before storage;
      - output never in events;
      - delete refusals while a run is in flight;
      - `project.context` on real temporary repositories (a symlinked root and manifest, oversized, BOM, deeply nested and duplicate-key JSON, pre/post scripts, `.npmrc`, the make file order, hostile script text).

14. **Implementation decisions (recorded at the A7 Core implementation).**
    - **`sandbox.stop` is unchanged.** It has no `impact` field and no token flow, so describing in-flight runs would need a wire change. Stopping a sandbox during a run is allowed; there is no cancel in A7, and stop is the user's way out of a runaway command. The run then ends with whatever outcome `sbx exec` reports (typically `signaled` or `exited`). Clients that know a run is in flight say so in their own stop dialog. The deletes still refuse (item 5).
    - **Wire details:**
      - `VerificationResult.elapsedMs` is optional, absent while the run is in flight.
      - `redactions` is `{bestEffort, replacements, byKind, outputWithheld?}`; `outputWithheld: true` means the redactor was unavailable and no output was stored.
      - `verification.run` answers `{runId, startedSequence, replayed?}`.
      - `stdoutBytes` / `stderrBytes` count the raw captured bytes, before redaction.
      - A restart reconciliation adds `reconciledAfterRestart: true` to the `interrupted` outcome event.
    - **Secret-refusal advice** is in `details.hint`, so the message keeps the item 2 template.
    - **Small choices:**
      - Argument numbers in messages are 1-based.
      - A worker panic records `read_failed`; a worker that never started records `spawn_failed`.
      - The start transaction also re-checks that the binding is live and unchanged, that the project and conversation are not archived, the sandbox-name operation claim, and the shutdown flag.
      - The verification check comes first in the project and conversation delete checks.
    - **Residuals:**
      - `read_failed` is proven by unit tests only, not by an integration test.
      - Graceful shutdown (item 5) is implemented and tested, but `main.rs` has no shutdown path yet, so a real Core relies on restart reconciliation.
      - `project.context` notes are not redacted. They are returned for display only, from the user's own registered repository, and never stored.
      - When a `direct_mount` run holds the writer lock, the pinned `git.apply` / `sandbox.create` "busy" texts name the holder with an older parenthetical.
    - **Code review outcome (A7 Core review, PASS-WITH-WARNINGS; re-verified PASS-WITH-WARNINGS).**
      - **W1, fixed:** argv refuses control characters (item 2). `verification.list`, `project.context` and `verification.result` also measure their response against `MAX_FRAME_BYTES − 64 KiB` and return a bounded `VALIDATION_FAILED` "the response would exceed the frame limit …; nothing was returned". The details are `commandIds`, `repositories` / `repositoryCount` / `approvedBytes`, and `runId`.
      - **W2, fixed:** `run_partial` detects the leader's exit without reaping it (`waitid … WNOWAIT`). It signals the group only while the leader is unreaped, reads for at most the grace period after a natural exit, and keeps `Exited` together with the new `outputIncomplete` flag (result and finished event). It leaves no reader threads behind.
      - **W3, fixed:** the joined-argv and JSON-argv secret checks, plus a re-check at run start (item 2).
      - **S1, S2, I2, fixed:** close-on-exec on the duplicated fd; `project.context` notes are redacted, or withheld when the redactor is unavailable; a note text fix.
      - **Follow-up, fixed before commit:**
        - **N1:** the `process::` timing tests warm each script before the clock starts and wait for readiness markers. 4 concurrent copies × 10 rounds had 0/40 failures, against 36/40 before; 16 runs under a CPU hog on every core had 0 failures.
        - **I-b (pre-existing):** `run_bounded` (git and sbx) now uses the same unreaped-leader pattern. It reads both pipes non-blocking on the calling thread, with no reader threads, sends group signals only through the slot while the leader is unreaped, and has no post-reap group kill. Its external behaviour and types are unchanged, and every git and sbx test passes.
        - **I-a:** a failed `waitid` makes the reap kill the child first; it never counts as "exited".
        - Three mutants survived because a pipe read error or a `waitid` error on Core's own child cannot be triggered from a test; `drain`'s error recording is unit-tested.
        - The `cfg(not(unix))` path is the unchanged old code, not built on this host.
      - **Accepted:**
        - I-c: an oversized request `id` echoes into its own response (pre-existing, self-inflicted).
        - I-e: redactor pattern gaps (`--api-key=…`, `--password …`) are best-effort and out of A7 scope.
        - I-d: `output_incomplete` was added to migration v8 in place before any commit, so a development database created by an earlier uncommitted A7 build must be recreated.
    - **Client review outcome (two read-only security reviews: desktop + JetBrains, then VS Code; both PASS-WITH-WARNINGS, no Critical).**
      - **Deadline correction (cross-client, brief error):** `verification.run` answers only after the version gate (`RunLimits::PROBE`, 3 s) and the identity gate (`RunLimits::QUERY`, 30 s), both before the durable start. So every client now gives it the git deadline: desktop proxy 43 s / webview 45 s, JetBrains 45 s, VS Code 45 s. Each is drift-pinned against `process.rs`, so a client never shows "may have started" while Core is still gating.
      - **JetBrains J-W1, fixed:** a started run follows the task without a (possibly stale) `TaskSummary`, on the EDT, so a verification never changes a displayed task status (rule 3).
      - **JetBrains J-W2, fixed:** the approve, run and revoke confirmations are plain non-editable text (`JTextArea`, `html.disable`). No A7 dialog uses HTML (item 6).
      - **VS Code W1, fixed:** archived-project and archived-conversation refusals get their own copy for approve, run and revoke.
      - **VS Code W2, fixed:** only `revoked: true` counts as revoked. Anything else is shown as "may not have been revoked", and the list is re-read.
      - **VS Code W3, fixed:** the output document opens directly in its own language (dedicated `.sandpane-verification` extension). The header claims "not linked" only while the language-scoped `editor.links` is exactly `false`, and otherwise says that links are enabled by a setting and are untrusted.
      - **Info, fixed (all clients where it applied):**
        - "Retry safely" is offered only within 23 h of the key's first send, inside Core's 24 h retention (drift-pinned to `RETENTION_SECS`), and re-checked at click time.
        - Suggestion notes are dropped once the argv is edited.
        - JetBrains reads `project.context` only on "Detect suggestions"; VS Code never reads it from the timer refresh.
        - Every remaining Core string is revealed (timestamps, run ids, picker titles), and Zs spaces and delimiters are escaped in JetBrains list rows.
        - JetBrains `toString`s show sizes only.
        - Desktop Revoke… requires a trusted event.
        - An INTERNAL "…; nothing was run" refusal reads as definite.
        - Re-approving an existing argv says so.

## 4. Client obligations per addition

Every client gets, for each addition:

- typed wrappers;
- gating on advertisement;
- for destructive actions, the two-step token flow surfaced as a native confirmation that shows `impact` and `external`;
- honest unsupported states, such as `sandbox.start` and mutating policy or secrets;
- updated drift tests.

JetBrains and desktop must have landed their enum-tolerance changes before **any** later change adds an enum value (none is planned here).
