/**
 * Display-only task-state reducer.
 *
 * AGENTS.md rule 3 / specs/02 §4: transitions are enforced in **Core**. This
 * reducer therefore never derives a status from another status, never infers
 * `running` from activity, and never repairs a gap. It applies exactly what the
 * durable event stream said (`status.changed {to}`) and shows everything else
 * as data or as an explicit "unknown kind" marker.
 */

import type { AgentEvent, TaskEvent, TaskStatus } from '../core-client/events';
import { isTaskStatus, normalizeAgentEvent, statusFromEvent } from '../core-client/events';
import type { TaskSummary } from '../core-client/protocol';

export type TranscriptRole = 'user' | 'agent' | 'tool' | 'system';

export interface TranscriptLine {
  role: TranscriptRole;
  text: string;
  sequence: number;
  /** Set when Core's payload could not be verified as a known event shape. */
  unsupported?: boolean;
  /** approval.required: protocol v1 has no method to answer it from a client. */
  needsAnswer?: boolean;
  errorCode?: string;
}

export interface ToolView {
  id: string;
  name: string;
  state: 'started' | 'finished_ok' | 'finished_failed';
  summary?: string;
}

export interface TaskView {
  taskId: string;
  /** null until Core emits a status; never filled in locally. */
  status: TaskStatus | null;
  statusSequence: number;
  conversationId?: string;
  sandboxName?: string | null;
  taskBranch?: string | null;
  baseCommit?: string | null;
  lines: TranscriptLine[];
  files: string[];
  tools: ToolView[];
  /** Event kinds this client cannot interpret — surfaced, not swallowed. */
  unknownKinds: string[];
  lastSequence: number;
  lastTimestamp?: string;
  /** Set from Core's `task.completed`/terminal statuses for badge rendering. */
  completedOk?: boolean;
}

export interface TaskViewState {
  tasks: Record<string, TaskView>;
  /** Insertion order for stable rendering. */
  order: string[];
}

export type TaskViewAction =
  | { kind: 'taskEvent'; event: TaskEvent }
  | { kind: 'taskEvents'; events: TaskEvent[] }
  | /** `conversation.send` / Core-supplied summary — a Core verdict, displayable. */
    { kind: 'taskSummary'; summary: TaskSummary }
  | /**
   * `task.list` hydration: Core's stored statuses, verbatim, so a reopened
   * window can show tasks it has not replayed events for. A summary is a Core
   * verdict — this is NOT a client-side transition, and a status this client
   * cannot name is never mapped onto one it can.
   */
    { kind: 'taskList'; tasks: TaskSummary[] }
  | { kind: 'reset' };

export const EMPTY_STATE: TaskViewState = { tasks: {}, order: [] };

const MAX_LINES = 500;

function blankTask(taskId: string): TaskView {
  return {
    taskId,
    status: null,
    statusSequence: 0,
    lines: [],
    files: [],
    tools: [],
    unknownKinds: [],
    lastSequence: 0,
  };
}

function withTask(state: TaskViewState, task: TaskView): TaskViewState {
  const existed = Object.prototype.hasOwnProperty.call(state.tasks, task.taskId);
  return {
    tasks: { ...state.tasks, [task.taskId]: task },
    order: existed ? state.order : [...state.order, task.taskId],
  };
}

function pushLine(task: TaskView, line: TranscriptLine): TaskView {
  const lines = [...task.lines, line];
  // Bounded display buffer; Core keeps the full durable log.
  return { ...task, lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines };
}

function objectPayload(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function applyAgentEvent(task: TaskView, event: TaskEvent, agent: AgentEvent): TaskView {
  switch (agent.type) {
    case 'message.delta':
      return pushLine(task, { role: 'agent', text: agent.text, sequence: event.sequence });
    case 'tool.started':
      return {
        ...pushLine(task, {
          role: 'tool',
          text: `tool started: ${agent.name}`,
          sequence: event.sequence,
        }),
        tools: [...task.tools, { id: agent.id, name: agent.name, state: 'started' }],
      };
    case 'tool.finished': {
      const tools = task.tools.map((tool) =>
        tool.id === agent.id
          ? {
              ...tool,
              state: agent.ok ? ('finished_ok' as const) : ('finished_failed' as const),
              ...(agent.summary === undefined ? {} : { summary: agent.summary }),
            }
          : tool,
      );
      const sawUnknownTool = !task.tools.some((tool) => tool.id === agent.id);
      return pushLine(
        { ...task, tools },
        {
          role: 'tool',
          text: sawUnknownTool
            ? `tool finished (id ${agent.id} was never started in this view): ${agent.ok ? 'ok' : 'failed'}`
            : `tool finished: ${agent.ok ? 'ok' : 'failed'}`,
          sequence: event.sequence,
        },
      );
    }
    case 'file.changed':
      return {
        ...pushLine(task, { role: 'tool', text: `file changed: ${agent.path}`, sequence: event.sequence }),
        files: task.files.includes(agent.path) ? task.files : [...task.files, agent.path],
      };
    case 'approval.required':
      // Honest seam: protocol v1 has no method to answer an approval request.
      return pushLine(task, {
        role: 'system',
        text:
          `agent requests approval (${agent.requestId}): ${agent.description} — ` +
          'this protocol version has no method to answer it; the task stays blocked',
        sequence: event.sequence,
        needsAnswer: true,
      });
    case 'task.completed':
      // Note: NOT a status. `completed` arrives only via Core's status.changed.
      return {
        ...pushLine(task, {
          role: 'system',
          text: `agent reported completion (ok=${agent.ok}) — awaiting Core status`,
          sequence: event.sequence,
        }),
        completedOk: agent.ok,
      };
    case 'error':
      return pushLine(task, {
        role: 'system',
        text: `${agent.code}: ${agent.message}`,
        sequence: event.sequence,
        errorCode: agent.code,
      });
    case 'unsupported.event':
      return pushLine(
        {
          ...task,
          unknownKinds: task.unknownKinds.includes(agent.providerType)
            ? task.unknownKinds
            : [...task.unknownKinds, agent.providerType],
        },
        {
          role: 'system',
          text: `unsupported provider event: ${agent.providerType}`,
          sequence: event.sequence,
          unsupported: true,
        },
      );
    default: {
      const _exhaustive: never = agent;
      return _exhaustive;
    }
  }
}

function applyTaskEvent(state: TaskViewState, event: TaskEvent): TaskViewState {
  const existing = state.tasks[event.taskId];
  const previous = existing ?? blankTask(event.taskId);

  // Stale/out-of-order replay: display nothing. Core's checkpoint is the
  // authority; this guard only keeps a re-delivered frame from double-painting.
  if (event.sequence <= previous.lastSequence && existing !== undefined) {
    return state;
  }
  const task: TaskView = {
    ...previous,
    lastSequence: Math.max(previous.lastSequence, event.sequence),
    lastTimestamp: event.timestamp,
  };
  const payload = objectPayload(event.payload);

  switch (event.kind) {
    case 'status.changed': {
      const to = statusFromEvent(event.kind, event.payload);
      if (to === undefined) {
        // Core emitted a status we cannot name: show the raw value, do not map it.
        const raw = payload?.['to'];
        return withTask(
          state,
          pushLine(
            { ...task, unknownKinds: uniq(task.unknownKinds, `status:${String(raw)}`) },
            {
              role: 'system',
              text: `Core emitted an unknown task status: ${String(raw)} — status left unchanged`,
              sequence: event.sequence,
              unsupported: true,
            },
          ),
        );
      }
      return withTask(state, { ...task, status: to, statusSequence: event.sequence });
    }
    case 'task.created': {
      const conversationId = typeof payload?.['conversationId'] === 'string'
        ? payload['conversationId']
        : undefined;
      // No status here on purpose: Core emits created → queued as its own event.
      return withTask(state, { ...task, ...(conversationId ? { conversationId } : {}) });
    }
    case 'message.user': {
      const agent = normalizeAgentEvent(event.payload);
      if (agent.type === 'message.delta') {
        return withTask(state, pushLine(task, { role: 'user', text: agent.text, sequence: event.sequence }));
      }
      return withTask(
        state,
        pushLine(task, {
          role: 'user',
          text: String(event.payload ?? ''),
          sequence: event.sequence,
          unsupported: true,
        }),
      );
    }
    case 'scheduler.deferred': {
      const reason = typeof payload?.['reason'] === 'string' ? payload['reason'] : 'no reason given';
      return withTask(
        state,
        pushLine(task, {
          role: 'system',
          text: `scheduler deferred this task (${reason}); it stays queued in Core`,
          sequence: event.sequence,
        }),
      );
    }
    case 'adapter.unavailable':
    case 'message.agent': {
      // `adapter.unavailable` carries a normalized AgentEvent; so may a future
      // agent-message channel. Anything unrecognizable stays explicit.
      const agent = normalizeAgentEvent(event.payload);
      return withTask(state, applyAgentEvent(task, event, agent));
    }
    default: {
      // Known agent-event kinds delivered under their own names.
      const agentLike = ['message.delta', 'tool.started', 'tool.finished', 'file.changed',
        'approval.required', 'task.completed', 'error', 'unsupported.event'];
      if (agentLike.includes(event.kind)) {
        return withTask(state, applyAgentEvent(task, event, normalizeAgentEvent(event.payload)));
      }
      return withTask(
        state,
        pushLine(
          { ...task, unknownKinds: uniq(task.unknownKinds, event.kind) },
          {
            role: 'system',
            text: `unrecognized Core event kind "${event.kind}" (seq ${event.sequence}) — not interpreted`,
            sequence: event.sequence,
            unsupported: true,
          },
        ),
      );
    }
  }
}

function uniq(list: string[], value: string): string[] {
  return list.includes(value) ? list : [...list, value];
}

/**
 * Display one Core `TaskSummary`. `status` is copied exactly as Core stored it:
 * a value this client cannot name is recorded in `unknownKinds` and the previous
 * status is KEPT, because guessing a lifecycle state here would be inventing a
 * transition (AGENTS.md rule 3).
 */
function applySummary(state: TaskViewState, summary: TaskSummary): TaskViewState {
  const previous = state.tasks[summary.id] ?? blankTask(summary.id);
  const named = isTaskStatus(summary.status);
  const task: TaskView = {
    ...previous,
    // Core's verdict verbatim — no local transition arithmetic.
    status: named ? summary.status : previous.status,
    conversationId: summary.conversationId,
    ...(summary.sandboxName !== undefined ? { sandboxName: summary.sandboxName } : {}),
    ...(summary.taskBranch !== undefined ? { taskBranch: summary.taskBranch } : {}),
    ...(summary.baseCommit !== undefined ? { baseCommit: summary.baseCommit } : {}),
    ...(named
      ? {}
      : {
          unknownKinds: uniq(previous.unknownKinds, `status:${String(summary.status)}`),
          lines: [
            ...previous.lines,
            {
              role: 'system' as const,
              text: `Core reported an unknown task status "${String(summary.status)}" — status left unchanged`,
              sequence: previous.lastSequence,
              unsupported: true,
            },
          ],
        }),
  };
  return withTask(state, task);
}

export function reduceTaskView(state: TaskViewState, action: TaskViewAction): TaskViewState {
  switch (action.kind) {
    case 'reset':
      return EMPTY_STATE;
    case 'taskEvent':
      return applyTaskEvent(state, action.event);
    case 'taskEvents': {
      let next = state;
      for (const event of [...action.events].sort((a, b) =>
        a.taskId === b.taskId ? a.sequence - b.sequence : a.taskId.localeCompare(b.taskId)
      )) {
        next = applyTaskEvent(next, event);
      }
      return next;
    }
    case 'taskSummary':
      return applySummary(state, action.summary);
    case 'taskList': {
      // Hydration only: every row is displayed as Core returned it, in Core's
      // order. No row is dropped, reordered into a "newer" state, or completed
      // locally.
      let next = state;
      for (const summary of action.tasks) next = applySummary(next, summary);
      return next;
    }
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export function selectTasks(state: TaskViewState): TaskView[] {
  return state.order.map((id) => state.tasks[id]).filter((t): t is TaskView => t !== undefined);
}

export function selectTask(state: TaskViewState, taskId: string): TaskView | undefined {
  return state.tasks[taskId];
}
