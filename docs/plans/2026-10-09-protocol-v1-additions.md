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
| A6 | `git.apply` (existing) implemented for `selectedFiles` | unchanged shape | Uses `git apply --3way --index`, or `cherry-pick --no-commit` for a whole task. Dirty gate on the touched paths plus the submodule refusal. Conflicts are rolled back and reported as `CONFLICT` with paths. |
| A7 | `verification.list`, `verification.approve` (user-entered argv + label), `verification.revoke`, `verification.run` | `VerificationCommand { id, label, argv: string[], approvedAt }`, `VerificationResult { exitCode, stdout, stderr, truncated, elapsedMs }` | Runs **only** inside the task's sandbox via `sbx exec` with an argv vector (no shell). Output is bounded and redacted. Never runs on the host. |
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
| A4b | Workspace selection on `conversation.send` + wire `worktree.discard` (token) | `workspace?: { mode, repoPath? }` | **Recorded, not scheduled.** Prerequisite for any wire-created task with Git context; designed and reviewed on its own because it writes host Git state. |

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

## 4. Client obligations per addition

Every client gets, for each addition:

- typed wrappers;
- gating on advertisement;
- for destructive actions, the two-step token flow surfaced as a native confirmation that shows `impact` and `external`;
- honest unsupported states, such as `sandbox.start` and mutating policy or secrets;
- updated drift tests.

JetBrains and desktop must have landed their enum-tolerance changes before **any** later change adds an enum value (none is planned here).
