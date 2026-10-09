/**
 * Typed wrappers for **exactly** the 14 Core methods (`sandpane_protocol::Method`
 * / `Method::ALL`).
 *
 * Every payload key is written in the wire spelling (camelCase), every enum in
 * its wire spelling (snake_case / SCREAMING_SNAKE). Unknown methods are
 * impossible to call: the parameter type is the `CoreMethodName` union and
 * `CoreConnection.request` re-checks it at runtime. There is no
 * "run this command" method and there never will be (specs/02 §2).
 *
 * The client-side validators below mirror `sandpane_core::validation` and the
 * `sandpane_service` bounds so an illegal value is explained before it is sent —
 * Core validates again, and its verdict is the one that counts (specs/06 §4).
 *
 * `task.list`, `conversation.list` and `conversation.history` are ADDITIVE v1
 * methods: a pre-revision Core does not dispatch them. Callers that must work
 * against any Core feature-detect with `coreAdvertisesMethod(probe, 'task.list')`
 * instead of assuming the method exists.
 */

import { CoreConnection } from './connection';
import type {
  AgentCapability,
  ApplyResult,
  ChangeSet,
  Conversation,
  ConversationCreateParams,
  ConversationHistoryParams,
  ConversationHistoryResult,
  ConversationListParams,
  ConversationSendParams,
  CoreCapabilities,
  GitApplyParams,
  Project,
  ProjectCreateParams,
  SandboxCreateSpec,
  SandboxSummary,
  TaskListParams,
  TaskSubscribeParams,
  TaskSummary,
} from './protocol';
import {
  MAX_CURSOR_KEY_LEN,
  MAX_LIST_LIMIT,
  MAX_SCOPING_ID_LEN,
  MAX_SUBSCRIBE_CURSORS,
} from './protocol';
import type { ErrorCode, TaskEvent, TaskStatus } from './events';
import { isTaskStatus } from './events';

/** Thrown before a request leaves the client. Never a Core verdict. */
export class CoreValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'CoreValidationError';
    this.field = field;
  }
}

/** `Validator::sandbox_name` — 1..=63, lowercase alnum + single hyphens, alnum ends. */
export function validateSandboxName(name: string): string {
  if (name.length === 0) throw new CoreValidationError('name', 'value is empty');
  if (name.length > 63) throw new CoreValidationError('name', `value exceeds max length 63`);
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new CoreValidationError(
      'name',
      'only lowercase ASCII letters, digits and single hyphens are allowed',
    );
  }
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) {
    throw new CoreValidationError('name', 'must start and end with an ASCII letter or digit');
  }
  if (name.includes('--')) {
    throw new CoreValidationError('name', 'contains the disallowed sequence "--"');
  }
  return name;
}

/** `Validator::git_ref` — hex object id (>=7) or a conservative branch name. */
export function validateGitRef(value: string, field = 'expectedBase'): string {
  if (value.length === 0) throw new CoreValidationError(field, 'value is empty');
  if (value.length > 200) throw new CoreValidationError(field, 'value exceeds max length 200');
  if (value.length >= 7 && /^[0-9a-fA-F]+$/.test(value)) return value;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new CoreValidationError(field, 'only [A-Za-z0-9._/-] are allowed in a ref');
  }
  for (const seq of ['..', '//', '.lock', './', '/.']) {
    if (value.includes(seq)) {
      throw new CoreValidationError(field, `contains the disallowed sequence "${seq}"`);
    }
  }
  if (
    value.startsWith('-') ||
    value.startsWith('.') ||
    value.endsWith('/') ||
    value.endsWith('.')
  ) {
    throw new CoreValidationError(
      field,
      'ref may not start with "-" or "." or end with "/" or "."',
    );
  }
  return value;
}

/** `Validator::display_text` — bounded, control characters other than \n and \t rejected. */
export function validateDisplayText(value: string, max: number, field: string): string {
  if (value.length === 0) throw new CoreValidationError(field, 'value is empty');
  // Rust compares `chars().count()` (Unicode scalar values); `.length` is UTF-16
  // code units and would refuse an astral-plane value Core accepts.
  if (Array.from(value).length > max) throw new CoreValidationError(field, `value exceeds max length ${max}`);
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && ch !== '\n' && ch !== '\t') {
      throw new CoreValidationError(field, `contains a disallowed control character U+${code.toString(16)}`);
    }
    if (code === 0x7f) {
      throw new CoreValidationError(field, 'contains a disallowed character U+7f');
    }
  }
  return value;
}

export function validateAbsoluteRepoPath(value: string, field = 'repoPath'): string {
  if (!value.startsWith('/')) {
    throw new CoreValidationError(field, `path is not absolute: ${value}`);
  }
  if (value.includes('\0')) {
    throw new CoreValidationError(field, 'path contains a NUL byte');
  }
  return value;
}

function requireId(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CoreValidationError(field, 'identifier is required');
  }
  return value.trim();
}

/**
 * `sandpane_service::validate_scoping_id` — an id that scopes a read must be
 * non-empty, control-character-free and ≤ `MAX_SCOPING_ID_LEN` **chars** (Rust
 * `Validator::display_text` counts chars). A typo'd empty `projectId` is a
 * structured refusal here, not a silently empty list that reads as "no tasks".
 */
export function validateScopingId(value: string, field: string): string {
  return validateDisplayText(value, MAX_SCOPING_ID_LEN, field);
}

/**
 * `sandpane_service::optional_scoping_id` — absent means unscoped; an empty
 * string is a client bug and is refused. Returns `undefined` so the caller
 * OMITS the key instead of sending `null`.
 */
export function optionalScopingId(value: string | null | undefined, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CoreValidationError(field, 'value must be a string or absent');
  return validateScopingId(value, field);
}

/**
 * `sandpane_service::clamp_limit` — absent → Core's own default (so we omit the
 * key rather than inventing 200 on the wire); anything else is clamped into
 * `1..=MAX_LIST_LIMIT`. A non-integer or non-finite value is refused locally:
 * Rust's `limit` is a `u32`, so `-5` and `1.5` are `VALIDATION_FAILED` at parse
 * time and must not leave this client looking like a valid request.
 */
export function clampLimit(limit: number | null | undefined, field = 'limit'): number | undefined {
  if (limit === undefined || limit === null) return undefined;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isInteger(limit)) {
    throw new CoreValidationError(field, 'limit must be an integer');
  }
  if (limit < 0) throw new CoreValidationError(field, 'limit must not be negative');
  return Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
}

/**
 * `sandpane_service::validate_cursor_map` — bounded entries and non-empty,
 * id-sized keys. Rust measures a key in BYTES (`str::len()`), so the bound here
 * is the UTF-8 byte length, not `string.length`.
 *
 * Values: Core normalizes a cursor with `.max(0)` and ignores the entry shape
 * otherwise, so a negative cursor is normalized to 0 here rather than refused —
 * the same thing the scalar `afterSequence` already does. A non-number or a
 * non-finite number is refused locally because it is not representable in Rust's
 * `i64` and would be a parse-time `VALIDATION_FAILED` at Core.
 */
export function validateCursorMap(
  map: Record<string, number> | null | undefined,
  field = 'afterSequences',
): Record<string, number> | undefined {
  if (map === undefined || map === null) return undefined;
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw new CoreValidationError(field, 'value must be a task id → sequence map');
  }
  const entries = Object.entries(map);
  if (entries.length > MAX_SUBSCRIBE_CURSORS) {
    throw new CoreValidationError(
      field,
      `has ${entries.length} entries, the bound is ${MAX_SUBSCRIBE_CURSORS}`,
    );
  }
  const bytes = new TextEncoder();
  const out: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || bytes.encode(key).length > MAX_CURSOR_KEY_LEN) {
      throw new CoreValidationError(field, `key must be 1..=${MAX_CURSOR_KEY_LEN} bytes`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CoreValidationError(field, `cursor for ${key} must be a finite number`);
    }
    out[key] = Math.max(0, Math.trunc(value));
  }
  return out;
}

/**
 * `task.list.statuses` are Core's OWN stored status names, deserialized into a
 * closed enum — an unknown string is `VALIDATION_FAILED`, never normalized.
 * Duplicates are collapsed here because they carry no meaning in an SQL IN-list
 * and collapsing keeps the bound-parameter count finite (Rust does the same).
 */
export function validateStatusFilter(
  statuses: readonly string[] | undefined,
): TaskStatus[] | undefined {
  if (statuses === undefined || statuses === null) return undefined;
  if (!Array.isArray(statuses)) {
    throw new CoreValidationError('statuses', 'value must be an array of Core task statuses');
  }
  const out: TaskStatus[] = [];
  for (const status of statuses) {
    if (!isTaskStatus(status)) {
      throw new CoreValidationError(
        'statuses',
        `"${String(status)}" is not a Core task status — statuses are Core's own values and are never guessed`,
      );
    }
    if (!out.includes(status)) out.push(status);
  }
  return out.length > 0 ? out : undefined;
}

export interface CancelResult {
  requested: boolean;
}

/**
 * A wrapper is an async surface: a failed guard must REJECT the returned
 * promise, never throw synchronously out of a `Promise`-typed call. Kept out of
 * the class so the prototype exposes exactly the 14 protocol methods.
 */
function guarded<R>(work: () => Promise<R>): Promise<R> {
  try {
    return work();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export class CoreCommands {
  constructor(private readonly connection: CoreConnection) {}

  /** `{}` → `CoreCapabilities`. Probe identity, SBX presence and adapter gates. */
  systemProbe(): Promise<CoreCapabilities> {
    return guarded(() => this.connection.request<CoreCapabilities>('system.probe', {}));
  }

  projectList(): Promise<Project[]> {
    return guarded(() => this.connection.request<Project[]>('project.list', {}));
  }

  /** Repositories must be absolute: Core rejects anything else with VALIDATION_FAILED. */
  projectCreate(params: ProjectCreateParams): Promise<Project> {
    return guarded(() => {
      const name = validateDisplayText(params.name, 120, 'name');
      const repositories = params.repositories.map((repo) => validateAbsoluteRepoPath(repo, 'repositories'));
      return this.connection.request<Project>('project.create', { name, repositories });
    });
  }

  /**
   * `{}` → `SandboxSummary[]`. Real behaviour: without an `sbx` binary Core
   * answers NOT_INSTALLED, with a stopped daemon DAEMON_DOWN. Surfaced verbatim
   * by `explainCoreError`; never turned into an empty list.
   */
  sandboxList(): Promise<SandboxSummary[]> {
    return guarded(() => this.connection.request<SandboxSummary[]>('sandbox.list', {}));
  }

  sandboxCreate(spec: SandboxCreateSpec): Promise<SandboxSummary> {
    return guarded(() => {
      const name = validateSandboxName(spec.name);
      const projectId = requireId(spec.projectId, 'projectId');
      const payload: Record<string, unknown> = { name, projectId, workspaceMode: spec.workspaceMode };
      if (typeof spec.repoPath === 'string' && spec.repoPath.length > 0) {
        payload['repoPath'] = validateAbsoluteRepoPath(spec.repoPath);
      }
      return this.connection.request<SandboxSummary>('sandbox.create', payload);
    });
  }

  conversationCreate(params: ConversationCreateParams): Promise<Conversation> {
    return guarded(() => {
      const projectId = requireId(params.projectId, 'projectId');
      const agentId = validateDisplayText(params.agentId, 64, 'agentId');
      const payload: Record<string, unknown> = { projectId, agentId };
      if (typeof params.sandboxId === 'string' && params.sandboxId.length > 0) {
        payload['sandboxId'] = validateSandboxName(params.sandboxId);
      }
      payload['title'] =
        typeof params.title === 'string' && params.title.trim().length > 0
          ? validateDisplayText(params.title.trim(), 200, 'title')
          : '';
      return this.connection.request<Conversation>('conversation.create', payload);
    });
  }

  /**
   * `{conversationId, content, attachments}` → `TaskSummary`.
   * `content` is data. It is never interpolated into a command anywhere in this
   * client (AGENTS.md rule 1); Core stores it and hands it to an adapter.
   */
  conversationSend(params: ConversationSendParams): Promise<TaskSummary> {
    return guarded(() => {
      const conversationId = requireId(params.conversationId, 'conversationId');
      const content = validateDisplayText(params.content, 64 * 1024, 'content');
      const attachments = params.attachments.map((ref) => ({
        kind: ref.kind,
        target: validateDisplayText(ref.target, 4096, 'attachments.target'),
      }));
      return this.connection.request<TaskSummary>('conversation.send', {
        conversationId,
        content,
        attachments,
      });
    });
  }

  /** `{taskId}` → `{requested}`. Cancelling is a Core decision, not ours. */
  taskCancel(taskId: string): Promise<CancelResult> {
    return guarded(() =>
      this.connection.request<CancelResult>('task.cancel', {
        taskId: requireId(taskId, 'taskId'),
      }),
    );
  }

  /**
   * Replay of durable events strictly after `afterSequence` → `TaskEvent[]`.
   *
   * Cursor rules mirrored from `TaskSubscribeParams` in Rust:
   * * `taskId` present → the scalar is the cursor and `afterSequences` is
   *   ignored by Core, so this client does not even put it on the wire.
   * * `taskId` absent → `afterSequences` (when supplied) replays each task from
   *   its OWN cursor; omitting it keeps the legacy shared-scalar behavior.
   */
  taskSubscribe(params: TaskSubscribeParams): Promise<TaskEvent[]> {
    return guarded(() => {
      const taskId = typeof params.taskId === 'string' && params.taskId.length > 0 ? params.taskId : undefined;
      const payload: Record<string, unknown> = {
        afterSequence: Math.max(0, Math.trunc(params.afterSequence)),
      };
      if (typeof params.projectId === 'string' && params.projectId.length > 0) {
        payload['projectId'] = params.projectId;
      }
      if (taskId !== undefined) {
        payload['taskId'] = taskId;
        // Core ignores a map alongside taskId; sending it would suggest otherwise.
        return this.connection.request<TaskEvent[]>('task.subscribe', payload);
      }
      const cursors = validateCursorMap(params.afterSequences);
      if (cursors !== undefined && Object.keys(cursors).length > 0) {
        payload['afterSequences'] = cursors;
      }
      return this.connection.request<TaskEvent[]>('task.subscribe', payload);
    });
  }

  /**
   * `{projectId?, statuses?, limit?}` → `TaskSummary[]`. Read-only discovery of
   * Core task state; statuses are displayed exactly as Core stores them — this
   * client computes no transitions (AGENTS.md rule 3).
   *
   * ADDITIVE v1 method: feature-detect via `coreAdvertisesMethod` before calling
   * against an unknown Core build.
   */
  taskList(params: TaskListParams = {}): Promise<TaskSummary[]> {
    return guarded(() => {
      const payload: Record<string, unknown> = {};
      const projectId = optionalScopingId(params.projectId, 'projectId');
      if (projectId !== undefined) payload['projectId'] = projectId;
      const statuses = validateStatusFilter(params.statuses);
      if (statuses !== undefined) payload['statuses'] = statuses;
      const limit = clampLimit(params.limit);
      if (limit !== undefined) payload['limit'] = limit;
      return this.connection.request<TaskSummary[]>('task.list', payload);
    });
  }

  /**
   * `{projectId?, limit?}` → `Conversation[]`. Archived conversations are
   * excluded by Core (`archived_at IS NULL`), so this is what the sidebar may
   * actually reopen. ADDITIVE v1 method — feature-detect before calling.
   */
  conversationList(params: ConversationListParams = {}): Promise<Conversation[]> {
    return guarded(() => {
      const payload: Record<string, unknown> = {};
      const projectId = optionalScopingId(params.projectId, 'projectId');
      if (projectId !== undefined) payload['projectId'] = projectId;
      const limit = clampLimit(params.limit);
      if (limit !== undefined) payload['limit'] = limit;
      return this.connection.request<Conversation[]>('conversation.list', payload);
    });
  }

  /**
   * `{conversationId, afterSequence?, limit?}` → `ConversationHistoryResult` —
   * an OBJECT, not an array: `truncated` discloses whether the row limit OR the
   * byte ceiling cut the scan short, and `nextSequence` is the cursor for the
   * following page. An unknown/archived conversation is Core's `NOT_FOUND`,
   * never an empty-but-successful answer that reads as "no messages".
   */
  conversationHistory(params: ConversationHistoryParams): Promise<ConversationHistoryResult> {
    return guarded(() => {
      const conversationId = validateScopingId(
        requireId(params.conversationId, 'conversationId'),
        'conversationId',
      );
      const payload: Record<string, unknown> = { conversationId };
      // Core normalises a negative cursor to 0; we normalize identically.
      payload['afterSequence'] = Math.max(0, Math.trunc(params.afterSequence ?? 0));
      const limit = clampLimit(params.limit);
      if (limit !== undefined) payload['limit'] = limit;
      return this.connection.request<ConversationHistoryResult>('conversation.history', payload);
    });
  }

  /** `{taskId}` → `ChangeSet` (base commit, dirty host flag, per-file status). */
  gitReview(taskId: string): Promise<ChangeSet> {
    return guarded(() =>
      this.connection.request<ChangeSet>('git.review', { taskId: requireId(taskId, 'taskId') }),
    );
  }

  /** Explicit, base-checked Git integration. Never a file overwrite (specs/06 §6). */
  gitApply(params: GitApplyParams): Promise<ApplyResult> {
    return guarded(() => {
      const payload: Record<string, unknown> = {
        taskId: requireId(params.taskId, 'taskId'),
        expectedBase: validateGitRef(params.expectedBase),
      };
      if (Array.isArray(params.selectedFiles) && params.selectedFiles.length > 0) {
        payload['selectedFiles'] = params.selectedFiles.map((file) =>
          validateDisplayText(file, 4096, 'selectedFiles'),
        );
      }
      return this.connection.request<ApplyResult>('git.apply', payload);
    });
  }
}

/** Convenience: the adapters Core reports as actually verified (P0 gate passed). */
export function verifiedAgents(agents: AgentCapability[]): AgentCapability[] {
  return agents.filter((a) => a.verified === true);
}

/** Structured error code carried by a rejection, if any. */
export function errorCodeOf(error: unknown): ErrorCode | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z_0-9]*$/.test(code)) return code as ErrorCode;
  }
  return undefined;
}
