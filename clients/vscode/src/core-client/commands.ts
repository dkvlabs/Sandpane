/**
 * Typed wrappers for **exactly** the 11 Core methods (`sandpane_protocol::Method`).
 *
 * Every payload key is written in the wire spelling (camelCase), every enum in
 * its wire spelling (snake_case / SCREAMING_SNAKE). Unknown methods are
 * impossible to call: the parameter type is the `CoreMethodName` union and
 * `CoreConnection.request` re-checks it at runtime. There is no
 * "run this command" method and there never will be (specs/02 §2).
 *
 * The client-side validators below mirror `sandpane_core::validation` so an
 * illegal value is explained before it is sent — Core validates again, and its
 * verdict is the one that counts (specs/06 §4).
 */

import { CoreConnection } from './connection';
import type {
  AgentCapability,
  ApplyResult,
  ChangeSet,
  Conversation,
  ConversationCreateParams,
  ConversationSendParams,
  CoreCapabilities,
  GitApplyParams,
  Project,
  ProjectCreateParams,
  SandboxCreateSpec,
  SandboxSummary,
  TaskSubscribeParams,
  TaskSummary,
} from './protocol';
import type { ErrorCode, TaskEvent } from './events';

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
  for (const seq of ['..', '//', '.lock']) {
    if (value.includes(seq)) {
      throw new CoreValidationError(field, `contains the disallowed sequence "${seq}"`);
    }
  }
  if (value.startsWith('-') || value.endsWith('/') || value.endsWith('.')) {
    throw new CoreValidationError(field, 'ref may not start with "-" or end with "/" or "."');
  }
  return value;
}

/** `Validator::display_text` — bounded, control characters other than \n and \t rejected. */
export function validateDisplayText(value: string, max: number, field: string): string {
  if (value.length === 0) throw new CoreValidationError(field, 'value is empty');
  if (value.length > max) throw new CoreValidationError(field, `value exceeds max length ${max}`);
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

export interface CancelResult {
  requested: boolean;
}

/**
 * A wrapper is an async surface: a failed guard must REJECT the returned
 * promise, never throw synchronously out of a `Promise`-typed call. Kept out of
 * the class so the prototype exposes exactly the 11 protocol methods.
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

  /** Replay of durable events strictly after `afterSequence` → `TaskEvent[]`. */
  taskSubscribe(params: TaskSubscribeParams): Promise<TaskEvent[]> {
    return guarded(() => {
      const payload: Record<string, unknown> = {
        afterSequence: Math.max(0, Math.trunc(params.afterSequence)),
      };
      if (typeof params.projectId === 'string' && params.projectId.length > 0) {
        payload['projectId'] = params.projectId;
      }
      if (typeof params.taskId === 'string' && params.taskId.length > 0) {
        payload['taskId'] = params.taskId;
      }
      return this.connection.request<TaskEvent[]>('task.subscribe', payload);
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
