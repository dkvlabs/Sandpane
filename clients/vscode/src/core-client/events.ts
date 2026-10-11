/**
 * Event, status and error-code types mirrored from `sandpane-protocol`
 * (core/crates/sandpane-protocol/src/lib.rs — the source of truth) and
 * `schemas/{agent-event,task-event,rpc-response}.schema.json`.
 *
 * Wire naming rules reproduced here verbatim, do not "prettify" them:
 *  - `TaskStatus`   → snake_case   (`awaiting_review`, not `awaitingReview`)
 *  - `ErrorCode`    → SCREAMING_SNAKE_CASE (`UNSUPPORTED_SBX_VERSION`)
 *  - `AgentEvent`   → internally tagged `type`, dotted lowercase names
 *                     (`message.delta`, `tool.started`, `unsupported.event`)
 *  - `TaskEvent`    → camelCase fields (`taskId`, `afterSequence` in params)
 *
 * Nothing in this file invents state: clients display Core-emitted statuses
 * only (AGENTS.md rule 3).
 */

/** `sandpane_protocol::ErrorCode` — the complete structured error surface. */
export type ErrorCode =
  | 'NOT_INSTALLED'
  | 'DAEMON_DOWN'
  | 'UNSUPPORTED_SBX_VERSION'
  | 'PROVIDER_AUTH_REQUIRED'
  | 'CONFLICT'
  | 'TASK_INTERRUPTED'
  | 'PERMISSION_DENIED'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INTERNAL';

export const ERROR_CODES: readonly ErrorCode[] = [
  'NOT_INSTALLED',
  'DAEMON_DOWN',
  'UNSUPPORTED_SBX_VERSION',
  'PROVIDER_AUTH_REQUIRED',
  'CONFLICT',
  'TASK_INTERRUPTED',
  'PERMISSION_DENIED',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'INTERNAL',
];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** `sandpane_protocol::TaskStatus` (specs/02 §4). Transitions live in Core. */
export type TaskStatus =
  | 'created'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'verifying'
  | 'awaiting_input'
  | 'awaiting_review'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'created',
  'queued',
  'preparing',
  'running',
  'verifying',
  'awaiting_input',
  'awaiting_review',
  'completed',
  'rejected',
  'failed',
  'cancelled',
  'interrupted',
];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * Terminal statuses — a *classification* of Core's own state set for display
 * (badge stops spinning), NOT a transition rule. Deciding whether a task may
 * move anywhere is `sandpane_core::task`'s job alone.
 */
const TERMINAL: readonly TaskStatus[] = ['completed', 'rejected', 'failed', 'cancelled', 'interrupted'];

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL.includes(status);
}

/** `sandpane_protocol::AgentEvent` — normalized union (specs/02 §4). */
export type AgentEvent =
  | { type: 'message.delta'; text: string }
  | { type: 'tool.started'; name: string; id: string }
  | { type: 'tool.finished'; id: string; ok: boolean; summary?: string }
  | { type: 'file.changed'; path: string }
  | { type: 'approval.required'; requestId: string; description: string }
  | { type: 'task.completed'; ok: boolean }
  | { type: 'error'; code: ErrorCode; message: string }
  | { type: 'unsupported.event'; providerType: string };

export const AGENT_EVENT_TYPES: readonly AgentEvent['type'][] = [
  'message.delta',
  'tool.started',
  'tool.finished',
  'file.changed',
  'approval.required',
  'task.completed',
  'error',
  'unsupported.event',
];

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Validate a payload against the `AgentEvent` union. Anything that does not
 * match exactly — an unknown tag, a missing required field, a wrong primitive —
 * is surfaced as `unsupported.event`, never coerced into a guess (specs/02 §4:
 * adapters normalize only what they can verify; clients do the same).
 */
export function normalizeAgentEvent(payload: unknown): AgentEvent {
  const obj = record(payload);
  const providerType = obj ? str(obj['type']) : undefined;
  if (!obj || !providerType) {
    return { type: 'unsupported.event', providerType: providerType ?? 'unknown' };
  }
  switch (providerType) {
    case 'message.delta': {
      const text = str(obj['text']);
      return text === undefined ? unsupported(providerType) : { type: 'message.delta', text };
    }
    case 'tool.started': {
      const name = str(obj['name']);
      const id = str(obj['id']);
      return name === undefined || id === undefined
        ? unsupported(providerType)
        : { type: 'tool.started', name, id };
    }
    case 'tool.finished': {
      const id = str(obj['id']);
      const ok = bool(obj['ok']);
      if (id === undefined || ok === undefined) return unsupported(providerType);
      const summary = str(obj['summary']);
      return summary === undefined
        ? { type: 'tool.finished', id, ok }
        : { type: 'tool.finished', id, ok, summary };
    }
    case 'file.changed': {
      const path = str(obj['path']);
      return path === undefined ? unsupported(providerType) : { type: 'file.changed', path };
    }
    case 'approval.required': {
      const requestId = str(obj['requestId']);
      const description = str(obj['description']);
      return requestId === undefined || description === undefined
        ? unsupported(providerType)
        : { type: 'approval.required', requestId, description };
    }
    case 'task.completed': {
      const ok = bool(obj['ok']);
      return ok === undefined ? unsupported(providerType) : { type: 'task.completed', ok };
    }
    case 'error': {
      const code = obj['code'];
      const message = str(obj['message']);
      return isErrorCode(code) && message !== undefined
        ? { type: 'error', code, message }
        : unsupported(providerType);
    }
    case 'unsupported.event': {
      const inner = str(obj['providerType']);
      return { type: 'unsupported.event', providerType: inner ?? providerType };
    }
    default:
      return unsupported(providerType);
  }
}

function unsupported(providerType: string): AgentEvent {
  return { type: 'unsupported.event', providerType };
}

/**
 * `sandpane_protocol::TaskEvent` — a durable, replayable log entry.
 * Kinds Core emits in this build (verified against sandpane-service):
 * `task.created`, `message.user`, `status.changed` (`{to}`),
 * `adapter.unavailable` (AgentEvent), `scheduler.deferred` (`{reason}`).
 * `kind` stays `string`: unknown kinds must not break replay.
 */
export interface TaskEvent {
  taskId: string;
  sequence: number;
  kind: string;
  payload: unknown;
  timestamp: string;
}

/**
 * A6 (§3.6 item 8) apply events (sandpane-service git_apply.rs; drift-tested).
 * Payloads are decoded as optional / open fields; `git.apply.started` carries
 * the entries and index states, which are never shown or logged.
 */
export const APPLY_EVENT_KINDS = {
  started: 'git.apply.started',
  applied: 'git.applied',
  failed: 'git.apply.failed',
  reconciled: 'git.apply.reconciled',
} as const;

/** Read the `to` status out of a `status.changed` payload; undefined if absent/invalid. */
export function statusFromEvent(kind: string, payload: unknown): TaskStatus | undefined {
  if (kind !== 'status.changed') return undefined;
  const obj = record(payload);
  const to = obj ? obj['to'] : undefined;
  return isTaskStatus(to) ? to : undefined;
}
