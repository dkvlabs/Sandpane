/**
 * Pure display logic. Nothing here decides a task lifecycle transition —
 * transitions are enforced in Core (`sandpane_core::task`) and this module only
 * renders the status Core reported (AGENTS.md §Code Review rule 3). Where the
 * spec calls a state that this build cannot observe, the function returns an
 * explicit `unknown`/`unprobed` shape instead of a guess.
 */

import { MAX_HISTORY_BYTES, MAX_LIST_LIMIT, TASK_STATUSES } from "./protocol";
import type {
  AgentCapability,
  ApplyResult,
  ChangeSet,
  ConversationHistoryResult,
  CoreCapabilities,
  ErrorCode,
  FileChangeStatus,
  MessageRecord,
  Project,
  SandboxSummary,
  TaskEvent,
  TaskStatus,
  TaskSummary,
  WorkspaceMode,
} from "./protocol";
import { UNRECOGNIZED_CORE_CODE } from "./core-client";
import type { ProbeOutcome, CoreRequestError } from "./core-client";

// ---------------------------------------------------------------------------
// Task status
// ---------------------------------------------------------------------------

export type StatusTone =
  | "neutral"
  | "active"
  | "attention"
  | "success"
  | "danger"
  | "info";

export interface StatusView {
  status: TaskStatus | "unknown";
  label: string;
  tone: StatusTone;
  /** Work is (or was) being performed by an agent. */
  alive: boolean;
  terminal: boolean;
  /** Review work the developer still owes. */
  needsReview: boolean;
  /** Copy that must accompany the badge so the state is not misread. */
  note: string;
}

const STATUS_VIEWS: Record<TaskStatus, Omit<StatusView, "status">> = {
  created: {
    label: "Created",
    tone: "neutral",
    alive: false,
    terminal: false,
    needsReview: false,
    note: "Recorded by Core; not scheduled yet.",
  },
  queued: {
    label: "Queued",
    tone: "info",
    alive: false,
    terminal: false,
    needsReview: false,
    note: "Waiting for scheduler admission.",
  },
  preparing: {
    label: "Preparing sandbox",
    tone: "active",
    alive: true,
    terminal: false,
    needsReview: false,
    note: "Setting up the workspace before the agent starts.",
  },
  running: {
    label: "Running",
    tone: "active",
    alive: true,
    terminal: false,
    needsReview: false,
    note: "Agent activity is streaming into the durable event log.",
  },
  verifying: {
    label: "Running verification",
    tone: "active",
    alive: true,
    terminal: false,
    needsReview: false,
    note: "Commands and exit codes come from Core, never from the UI.",
  },
  awaiting_input: {
    label: "Waiting for your input",
    tone: "attention",
    alive: true,
    terminal: false,
    needsReview: false,
    note: "The agent asked a question; answer it in the chat.",
  },
  awaiting_review: {
    label: "Ready for review",
    tone: "attention",
    alive: false,
    terminal: false,
    needsReview: true,
    note: "Changes exist against the task base commit and are not applied yet.",
  },
  completed: {
    label: "Completed",
    tone: "success",
    alive: false,
    terminal: true,
    needsReview: false,
    note: "Terminal state reported by Core.",
  },
  rejected: {
    label: "Rejected",
    tone: "danger",
    alive: false,
    terminal: true,
    needsReview: false,
    note: "Review was rejected; nothing was applied to your working tree.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    alive: false,
    terminal: true,
    needsReview: false,
    note: "Inspect the error event for the verified reason.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "neutral",
    alive: false,
    terminal: true,
    needsReview: false,
    note: "Cancellation was requested explicitly and recorded.",
  },
  interrupted: {
    label: "Interrupted",
    tone: "danger",
    alive: false,
    terminal: true,
    needsReview: false,
    note:
      "Core restarted while this task was mid-flight. It was reconciled to " +
      "interrupted and is NOT resumed automatically — starting again creates a new task.",
  },
};

const UNKNOWN_STATUS_VIEW: Omit<StatusView, "status"> = {
  label: "Unknown",
  tone: "neutral",
  alive: false,
  terminal: false,
  needsReview: false,
  note: "Core reported a status this desktop build does not recognise.",
};

/**
 * Membership in the known set — NOT `value in STATUS_VIEWS`, which would accept
 * prototype keys such as `"constructor"` as a task status.
 */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * Display text for a raw wire value this build does not recognise: one
 * printable line (control characters stripped, length capped), so a hostile or
 * garbled value cannot restyle or spoof the surrounding copy.
 */
export function displayRaw(raw: string): string {
  return sanitizeHint(raw) ?? "(unprintable)";
}

/**
 * The view for a status. `unrecognized` is Core's raw status string when the
 * decoder could not map it (`TaskSummary.unrecognizedStatus`): the badge then
 * says exactly what Core sent and why this build cannot interpret it. It is
 * never terminal, never running and never reviewable.
 */
export function taskStatusView(status: unknown, unrecognized?: string | null): StatusView {
  if (isTaskStatus(status)) return { status, ...STATUS_VIEWS[status] };
  if (typeof unrecognized === "string") {
    return {
      status: "unknown",
      ...UNKNOWN_STATUS_VIEW,
      label: `Unknown status (${displayRaw(unrecognized)}) — this Sandpane build is older than Core`,
      tone: "attention",
      note:
        `Core reported "${displayRaw(unrecognized)}", a task status this desktop build does not ` +
        "know. It is not treated as running, finished or reviewable; update Sandpane Desktop to " +
        "act on this task here.",
    };
  }
  return { status: "unknown", ...UNKNOWN_STATUS_VIEW };
}

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "completed",
  "rejected",
  "failed",
  "cancelled",
  "interrupted",
];

export function isAliveStatus(status: TaskStatus | undefined): boolean {
  return status !== undefined && STATUS_VIEWS[status].alive;
}

/**
 * Deliberately no `paused`: Sandpane never implies a pause it cannot verify
 * (specs/02 §4). "Stop" means cancel, "close tab" means hide.
 */
export function describeTaskAction(
  status: TaskStatus | "unknown" | null | undefined,
): { canCancel: boolean; canReview: boolean; canRetry: boolean } {
  const view = taskStatusView(status);
  return {
    canCancel: view.alive || status === "queued" || status === "created",
    canReview: status === "awaiting_review",
    // Retry only ever creates a NEW task; it never resumes an old one.
    canRetry:
      status === "failed" || status === "cancelled" || status === "interrupted",
  };
}

/**
 * Why review/apply must stay disabled for a task, or null when nothing blocks.
 *
 * A status this build does not recognise — from Core's task row
 * (`unrecognizedStatus`) or from a `status.changed` event the fold could not
 * read (`projection.status === "unknown"`) — means the desktop cannot tell
 * whether reviewing or applying is meaningful, so it does neither. A projection
 * with NO status yet (`null`) is not a block: that is "not reported", not
 * "unrecognised".
 */
export function reviewBlockReason(
  row: { unrecognizedStatus: string | null } | null | undefined,
  projection:
    | { status: TaskStatus | "unknown" | null; unrecognizedStatus?: string | null }
    | null
    | undefined,
): string | null {
  if (row?.unrecognizedStatus != null) {
    return (
      `Core reports status "${displayRaw(row.unrecognizedStatus)}" for this task, which this ` +
      "Sandpane build does not recognise (it is older than Core). Review and apply are disabled " +
      "here until the desktop is updated; nothing has been applied."
    );
  }
  if (projection?.status === "unknown") {
    const raw = projection.unrecognizedStatus;
    return (
      (typeof raw === "string"
        ? `Core's event log reports status "${displayRaw(raw)}" for this task, which this Sandpane build does not recognise (it is older than Core). `
        : "Core's event log reported a status this Sandpane build does not recognise for this task. ") +
      "Review and apply are disabled here until the desktop is updated; nothing has been applied."
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dashboard / status-bar aggregation
// ---------------------------------------------------------------------------

/**
 * One bucket per status, shared by the Tasks filter tabs AND `countTasks`, so a
 * tab label can never disagree with the rows it filters. `cancelled` is its own
 * bucket: a user-requested stop is not a failure.
 */
export type TaskBucket =
  | "running"
  | "waiting"
  | "queued"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export function taskBucket(status: TaskStatus | "unknown"): TaskBucket {
  switch (status) {
    case "preparing":
    case "running":
    case "verifying":
      return "running";
    case "awaiting_review":
    case "awaiting_input":
      return "waiting";
    case "queued":
    case "created":
      return "queued";
    case "completed":
      return "completed";
    case "failed":
    case "rejected":
    case "interrupted":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
}

export interface TaskCounts {
  cancelled: number;
  running: number;
  queued: number;
  needsReview: number;
  failed: number;
  awaitingInput: number;
  completed: number;
  interrupted: number;
  total: number;
}

export function countTasks(
  tasks: readonly { status: TaskStatus | "unknown" }[],
): TaskCounts {
  const counts: TaskCounts = {
    cancelled: 0,
    running: 0,
    queued: 0,
    needsReview: 0,
    failed: 0,
    awaitingInput: 0,
    completed: 0,
    interrupted: 0,
    total: tasks.length,
  };
  for (const task of tasks) {
    switch (task.status) {
      case "preparing":
      case "running":
      case "verifying":
        counts.running += 1;
        break;
      case "queued":
      case "created":
        counts.queued += 1;
        break;
      case "awaiting_review":
        counts.needsReview += 1;
        break;
      case "awaiting_input":
        counts.awaitingInput += 1;
        break;
      case "failed":
      case "rejected":
        counts.failed += 1;
        break;
      case "interrupted":
        counts.interrupted += 1;
        counts.failed += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      default:
        // "unknown" and any future wire status: counted in total only.
        break;
    }
  }
  return counts;
}

/**
 * The task index the UI renders. Rows come from Core only, from one of two Core
 * reads, and the source is always disclosed:
 *
 * * `"task.list"` — Core's stored task row (ADDITIVE v1 method; available only
 *   when the probe advertises it). This is how a task Core knows about but this
 *   window has never folded an event for becomes visible at all — the reconnect
 *   hydration path.
 * * `"events"` — the status the durable event replay last reported.
 *
 * A row is never invented: with neither source there is no row. When both reads
 * exist and disagree, that is surfaced as `disagreement` rather than resolved by
 * a client-side guess — transitions are Core's to decide (AGENTS rule 3).
 */
export type TaskIndexSource = "task.list" | "events";

export interface TaskIndexEntry {
  taskId: string;
  conversationId: string | null;
  status: TaskStatus | "unknown";
  lastSequence: number;
  /** Core timestamp of the newest event folded for this task; null when none. */
  lastEventAt: string | null;
  source: TaskIndexSource;
  sandboxName: string | null;
  taskBranch: string | null;
  baseCommit: string | null;
  /**
   * Core's raw status when this build does not recognise it (`status` is then
   * `"unknown"`): from the `task.list` row, or from the event log for an
   * event-only row. Null otherwise.
   */
  unrecognizedStatus: string | null;
  /** Set when Core's two reads report different statuses for the same task. */
  disagreement: {
    fromEvents: TaskStatus | "unknown";
    fromTaskList: TaskStatus | "unknown";
  } | null;
}

export function foldTaskIndex(
  projections: ReadonlyMap<string, TaskProjection>,
  coreTasks: readonly TaskSummary[] = [],
): TaskIndexEntry[] {
  const rows = new Map<string, TaskIndexEntry>();

  for (const task of coreTasks) {
    rows.set(task.id, {
      taskId: task.id,
      conversationId: task.conversationId,
      status: task.status,
      lastSequence: projections.get(task.id)?.lastSequence ?? 0,
      lastEventAt: projections.get(task.id)?.lastEventAt ?? null,
      source: "task.list",
      sandboxName: task.sandboxName ?? null,
      taskBranch: task.taskBranch ?? null,
      baseCommit: task.baseCommit ?? null,
      unrecognizedStatus: task.status === "unknown" ? task.unrecognizedStatus ?? null : null,
      disagreement: null,
    });
  }

  for (const projection of projections.values()) {
    const status = projection.status ?? "unknown";
    const existing = rows.get(projection.taskId);
    if (existing === undefined) {
      rows.set(projection.taskId, {
        taskId: projection.taskId,
        conversationId: projection.conversationId,
        status,
        lastSequence: projection.lastSequence,
        lastEventAt: projection.lastEventAt,
        source: "events",
        sandboxName: null,
        taskBranch: null,
        baseCommit: null,
        unrecognizedStatus: projection.unrecognizedStatus,
        disagreement: null,
      });
      continue;
    }
    rows.set(projection.taskId, {
      ...existing,
      conversationId: existing.conversationId ?? projection.conversationId,
      lastSequence: Math.max(existing.lastSequence, projection.lastSequence),
      lastEventAt: projection.lastEventAt ?? existing.lastEventAt,
      // Core's stored row stays on screen; the event fold never overwrites it.
      // A difference between the two Core reads is reported below, not resolved
      // by a client-side guess (AGENTS rule 3).
      disagreement:
        status !== existing.status
          ? {
              fromEvents: status,
              fromTaskList: existing.status,
            }
          : existing.disagreement,
    });
  }

  // Sequences are PER TASK, so comparing them across tasks means nothing.
  // Order by the newest Core event timestamp; rows with no event yet follow in
  // reverse `task.list` order (Core lists `created_at ASC`, so newest first);
  // the task id breaks any remaining tie so the order is stable.
  const coreRank = new Map(coreTasks.map((task, index) => [task.id, index + 1]));
  return [...rows.values()].sort((a, b) => {
    const byActivity = eventTime(b.lastEventAt) - eventTime(a.lastEventAt);
    if (byActivity !== 0 && !Number.isNaN(byActivity)) return byActivity;
    const byCore = (coreRank.get(b.taskId) ?? 0) - (coreRank.get(a.taskId) ?? 0);
    if (byCore !== 0) return byCore;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
}

/** Parse a Core timestamp for ordering; unknown or unparsable sorts last. */
export function eventTime(timestamp: string | null): number {
  if (timestamp === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** Most recently active first (Core event time), then task id — never by sequence. */
export function compareProjectionsByActivity(a: TaskProjection, b: TaskProjection): number {
  const byActivity = eventTime(b.lastEventAt) - eventTime(a.lastEventAt);
  if (byActivity !== 0 && !Number.isNaN(byActivity)) return byActivity;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/**
 * Restrict the window-wide event projections to ONE project.
 *
 * Task events carry no project id, so membership is proven only by Core's own
 * project-scoped reads: the task appears in this project's `task.list`, or its
 * `task.created` conversation is one of this project's conversations. A
 * projection with no conversation and no `task.list` row cannot be attributed;
 * it is excluded and COUNTED so the view can say so rather than guess.
 */
export function scopeProjectionsToProject(
  projections: readonly TaskProjection[],
  scope: {
    taskIds: ReadonlySet<string>;
    conversationIds: ReadonlySet<string>;
    /**
     * True only when `conversationIds` is Core's complete answer for the project
     * (`conversation.list` advertised and loaded). Otherwise a conversation
     * outside the set may still be this project's (created in another client),
     * so such a task is counted as unattributed instead of silently dropped.
     */
    conversationsAuthoritative: boolean;
  },
): { inScope: TaskProjection[]; unattributed: number } {
  const inScope: TaskProjection[] = [];
  let unattributed = 0;
  for (const projection of projections) {
    if (scope.taskIds.has(projection.taskId)) {
      inScope.push(projection);
    } else if (projection.conversationId === null) {
      unattributed += 1;
    } else if (scope.conversationIds.has(projection.conversationId)) {
      inScope.push(projection);
    } else if (!scope.conversationsAuthoritative) {
      unattributed += 1;
    }
  }
  return { inScope, unattributed };
}

/** Per-conversation composer drafts (UI-only state): set one, drop it when empty. */
export function withDraft(
  drafts: Readonly<Record<string, string>>,
  conversationId: string,
  text: string,
): Readonly<Record<string, string>> {
  const next = { ...drafts };
  if (text.length === 0) delete next[conversationId];
  else next[conversationId] = text;
  return next;
}

/** After a send succeeded: clear that chat's draft only if it is still the sent text. */
export function clearSentDraft(
  drafts: Readonly<Record<string, string>>,
  conversationId: string,
  sent: string,
): Readonly<Record<string, string>> {
  return drafts[conversationId] === sent ? withDraft(drafts, conversationId, "") : drafts;
}

/**
 * A remembered selection is only valid while it is still in the list it was
 * picked from (a different project, a filtered conversation, a deleted
 * sandbox); otherwise fall back.
 */
export function resolveSelection(
  remembered: string | null,
  candidates: readonly string[],
  fallback: "first" | "none",
): string | null {
  if (remembered !== null && candidates.includes(remembered)) return remembered;
  return fallback === "first" ? (candidates[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Event folding (timeline projection)
// ---------------------------------------------------------------------------
export type TimelineEntry =
  | { kind: "user-message"; sequence: number; timestamp: string; text: string }
  | { kind: "agent-message"; sequence: number; timestamp: string; text: string }
  | {
      kind: "tool";
      sequence: number;
      timestamp: string;
      toolId: string;
      name?: string;
      ok?: boolean;
      summary?: string;
    }
  | { kind: "file"; sequence: number; timestamp: string; path: string }
  | {
      kind: "approval";
      sequence: number;
      timestamp: string;
      requestId: string;
      description: string;
    }
  | {
      kind: "status";
      sequence: number;
      timestamp: string;
      status: TaskStatus | "unknown";
      /** Core's raw `to` when this build does not recognise it. */
      raw?: string;
    }
  | {
      kind: "error";
      sequence: number;
      timestamp: string;
      code?: string;
      message: string;
    }
  | {
      kind: "unmodelled";
      sequence: number;
      timestamp: string;
      eventKind: string;
      detail: string;
    };

export interface TaskProjection {
  taskId: string;
  /** Highest sequence folded in; the reconnect checkpoint. */
  lastSequence: number;
  /** Core timestamp of that newest event (for cross-task ordering only). */
  lastEventAt: string | null;
  /** Current status as reported by Core (never computed by the UI). */
  status: TaskStatus | "unknown" | null;
  /**
   * Core's raw `status.changed.to` when this build does not recognise it
   * (`status` is then `"unknown"`); cleared by the next recognised status.
   */
  unrecognizedStatus: string | null;
  /** Bound by the `task.created` event payload; null until Core says so. */
  conversationId: string | null;
  entries: TimelineEntry[];
  changedFiles: string[];
  pendingApprovals: { requestId: string; description: string }[];
  agentText: string;
  /** Kinds seen but not modelled — surfaced, not dropped. */
  unknownKinds: string[];
  /** True when a sequence number was skipped: replay is incomplete. */
  replayGap: { from: number; to: number } | null;
}

export function emptyProjection(taskId: string): TaskProjection {
  return {
    taskId,
    lastSequence: 0,
    lastEventAt: null,
    status: null,
    unrecognizedStatus: null,
    conversationId: null,
    entries: [],
    changedFiles: [],
    pendingApprovals: [],
    agentText: "",
    unknownKinds: [],
    replayGap: null,
  };
}

function fieldOf(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

/**
 * Fold durable task events into a renderable projection.
 *
 * Idempotent on replay: an event whose sequence is already folded in is
 * dropped, so a reconnect that re-delivers a boundary event cannot double the
 * transcript.
 */
export function foldTaskEvents(
  base: TaskProjection,
  events: readonly TaskEvent[],
): TaskProjection {
  let next = base;
  for (const event of events) {
    if (event.taskId !== base.taskId) continue;
    if (event.sequence <= next.lastSequence) continue;
    next = applyEvent(next, event);
  }
  return next;
}

function withSequence(
  projection: TaskProjection,
  event: TaskEvent,
  patch: Partial<TaskProjection>,
  entry?: TimelineEntry,
): TaskProjection {
  return {
    ...projection,
    ...patch,
    lastSequence: event.sequence,
    lastEventAt: event.timestamp,
    entries: entry ? [...projection.entries, entry] : projection.entries,
  };
}

function applyEvent(p: TaskProjection, event: TaskEvent): TaskProjection {
  const { kind, payload, sequence, timestamp } = event;
  switch (kind) {
    case "task.created":
      return withSequence(
        p,
        event,
        {
          status: p.status ?? "created",
          conversationId: p.conversationId ?? fieldOf(payload, "conversationId"),
        },
        { kind: "status", sequence, timestamp, status: "created" },
      );
    case "status.changed": {
      const raw =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>).to
          : payload;
      const status = isTaskStatus(raw) ? raw : "unknown";
      // A non-empty string this build does not know is a status a newer Core
      // added: kept raw, never mapped. A malformed `to` stays plain "unknown".
      const unrecognized =
        status === "unknown" && typeof raw === "string" && raw.length > 0 ? raw : null;
      return withSequence(
        p,
        event,
        { status, unrecognizedStatus: unrecognized },
        {
          kind: "status",
          sequence,
          timestamp,
          status,
          ...(unrecognized === null ? {} : { raw: unrecognized }),
        },
      );
    }
    case "message.user": {
      const text = fieldOf(payload, "text") ?? "";
      return withSequence(
        p,
        event,
        {},
        { kind: "user-message", sequence, timestamp, text },
      );
    }
    case "adapter.unavailable":
    case "scheduler.deferred": {
      const detail =
        fieldOf(payload, "message") ??
        fieldOf(payload, "reason") ??
        `${kind} reported without a message`;
      return withSequence(p, event, {}, {
        kind: "error",
        sequence,
        timestamp,
        code: kind === "adapter.unavailable" ? "ADAPTER_UNAVAILABLE" : "SCHEDULER_DEFERRED",
        message: detail,
      });
    }
    default:
      return applyPayloadEvent(p, event);
  }
}

function applyPayloadEvent(p: TaskProjection, event: TaskEvent): TaskProjection {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};
  const type = typeof payload.type === "string" ? payload.type : null;
  const { sequence, timestamp } = event;
  switch (type) {
    case "message.delta": {
      const text = typeof payload.text === "string" ? payload.text : "";
      return withSequence(
        p,
        event,
        { agentText: p.agentText + text },
        { kind: "agent-message", sequence, timestamp, text },
      );
    }
    case "tool.started": {
      const toolId = typeof payload.id === "string" ? payload.id : "";
      return withSequence(p, event, {}, {
        kind: "tool",
        sequence,
        timestamp,
        toolId,
        name: typeof payload.name === "string" ? payload.name : undefined,
      });
    }
    case "tool.finished": {
      const toolId = typeof payload.id === "string" ? payload.id : "";
      const ok = typeof payload.ok === "boolean" ? payload.ok : false;
      const summary = typeof payload.summary === "string" ? payload.summary : undefined;
      const existing = p.entries.find(
        (e) => e.kind === "tool" && e.toolId === toolId && e.ok === undefined,
      );
      if (existing) {
        return {
          ...p,
          lastSequence: sequence,
          lastEventAt: timestamp,
          entries: p.entries.map((e) =>
            e === existing ? { ...e, ok, summary } : e,
          ),
        };
      }
      return withSequence(p, event, {}, {
        kind: "tool",
        sequence,
        timestamp,
        toolId,
        ok,
        summary,
      });
    }
    case "file.changed": {
      const path = typeof payload.path === "string" ? payload.path : "";
      const changedFiles = p.changedFiles.includes(path)
        ? p.changedFiles
        : [...p.changedFiles, path];
      return withSequence(p, event, { changedFiles }, {
        kind: "file",
        sequence,
        timestamp,
        path,
      });
    }
    case "approval.required": {
      const requestId =
        typeof payload.requestId === "string" ? payload.requestId : "";
      const description =
        typeof payload.description === "string" ? payload.description : "";
      return withSequence(
        p,
        event,
        { pendingApprovals: [...p.pendingApprovals, { requestId, description }] },
        { kind: "approval", sequence, timestamp, requestId, description },
      );
    }
    case "task.completed": {
      const ok = payload.ok === true;
      return withSequence(p, event, {}, {
        kind: "status",
        sequence,
        timestamp,
        status: ok ? "completed" : "failed",
      });
    }
    case "error": {
      const code = typeof payload.code === "string" ? payload.code : undefined;
      const message =
        typeof payload.message === "string" ? payload.message : "agent error";
      return withSequence(p, event, {}, {
        kind: "error",
        sequence,
        timestamp,
        code,
        message,
      });
    }
    case "unsupported.event": {
      const providerType =
        typeof payload.providerType === "string" ? payload.providerType : "unknown";
      return withSequence(
        p,
        event,
        {
          unknownKinds: addUnique(
            p.unknownKinds,
            `unsupported.event:${providerType}`,
          ),
        },
        {
          kind: "unmodelled",
          sequence,
          timestamp,
          eventKind: "unsupported.event",
          detail: `Provider emitted ${providerType}; this agent adapter could not verify it.`,
        },
      );
    }
    default: {
      const eventKind = type ?? event.kind;
      return withSequence(
        p,
        event,
        { unknownKinds: addUnique(p.unknownKinds, eventKind) },
        {
          kind: "unmodelled",
          sequence,
          timestamp,
          eventKind,
          detail: "Event kind is not modelled by this desktop build.",
        },
      );
    }
  }
}

function addUnique(list: readonly string[], value: string): string[] {
  return list.includes(value) ? [...list] : [...list, value];
}

/** Record a detected replay hole without inventing the missing events. */
export function markReplayGap(
  p: TaskProjection,
  gap: { from: number; to: number },
): TaskProjection {
  return { ...p, replayGap: gap };
}

/**
 * Bound the DOM: the newest `limit` entries are rendered, the remainder stays in
 * Core and is revealed by explicit request. Full virtualization is a DT1 item;
 * this is the honest interim rule (bounded, labelled, no unbounded DOM growth).
 */
export function windowEntries<T extends { sequence: number }>(
  entries: readonly T[],
  limit: number,
): { visible: T[]; hiddenBefore: number } {
  if (entries.length <= limit) return { visible: [...entries], hiddenBefore: 0 };
  return {
    visible: entries.slice(entries.length - limit),
    hiddenBefore: entries.length - limit,
  };
}

// ---------------------------------------------------------------------------
// Conversation transcript (ADDITIVE v1 `conversation.history`)
// ---------------------------------------------------------------------------

/**
 * Fold paged `conversation.history` results into one rendered transcript.
 *
 * `truncated` is Core's disclosure that a row limit OR the byte ceiling stopped
 * the scan; a truncated page is never rendered as a complete conversation. The
 * notice is kept on the folded result so the chat view has to show it, and
 * `nextSequence` stays available as the cursor for the following page.
 */
export interface TranscriptEntry extends MessageRecord {
  /** Messages are listed oldest-first, matching Core's `sequence ASC` order. */
  order: number;
}

export interface TranscriptView {
  entries: TranscriptEntry[];
  /** True while the newest page Core returned was truncated. */
  truncated: boolean;
  /** Highest sequence rendered; the `afterSequence` for the next page. */
  cursor: number;
  /** More than one page folded in, so the UI can say "loaded N pages". */
  pages: number;
  /** Copy explaining a stop; empty string when nothing is withheld. */
  notice: string;
}

export function foldTranscript(
  pages: readonly ConversationHistoryResult[],
): TranscriptView {
  const bySequence = new Map<number, MessageRecord>();
  let truncated = false;
  let cursor = 0;
  for (const page of pages) {
    for (const message of page.messages) {
      bySequence.set(message.sequence, message);
    }
    if (page.nextSequence > cursor) cursor = page.nextSequence;
  }
  // Only the NEWEST page decides: once "Load more" fetched the rest, an earlier
  // page's `truncated` must not keep the "not complete" banner up forever.
  truncated = pages[pages.length - 1]?.truncated ?? false;
  const entries = [...bySequence.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .map((message, index) => ({ ...message, order: index + 1 }));
  return {
    entries,
    truncated,
    cursor,
    pages: pages.length,
    notice: truncated
      ? `Core stopped this read at ${MAX_HISTORY_BYTES} bytes / ${MAX_LIST_LIMIT} rows per page — this is ${entries.length} message(s) loaded so far, not the whole conversation. Load more to continue from sequence ${cursor}.`
      : "",
  };
}

// ---------------------------------------------------------------------------
// Project ⇄ folder association (ADDITIVE v1 `Project.repositories`)
// ---------------------------------------------------------------------------

/**
 * Match a host folder against the repository paths a project registered.
 *
 * Deliberately conservative: Core canonicalizes (resolves symlinks) at
 * `sandbox.create` mount time, NOT at registration, so the stored string is what
 * the caller typed. This helper compares lexically (trailing slash ignored) and
 * reports a match as a PATH MATCH, never as proof of identity — only a canonical
 * comparison on both sides can claim that, and the webview cannot resolve
 * symlinks.
 */
export function normalizeRepoPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const withoutTrailing = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  return withoutTrailing.length === 0 ? "/" : withoutTrailing;
}

export type ProjectAssociation =
  | { kind: "unregistered" }
  | { kind: "no-match"; registered: string[] }
  | { kind: "path-match"; project: Project; registeredPath: string };

export function associateFolder(
  folder: string,
  projects: readonly Project[],
): ProjectAssociation {
  const wanted = normalizeRepoPath(folder);
  if (wanted.length === 0) return { kind: "unregistered" };
  const registered = projects.flatMap((p) => (p.repositories ?? []).map((path) => ({ p, path })));
  if (registered.length === 0) return { kind: "unregistered" };
  const hit = registered.find(
    (entry) => normalizeRepoPath(entry.path) === wanted,
  );
  if (hit === undefined) {
    return {
      kind: "no-match",
      registered: registered.map((entry) => entry.path),
    };
  }
  return { kind: "path-match", project: hit.p, registeredPath: hit.path };
}

// ---------------------------------------------------------------------------
// Connection / capability folding
// ---------------------------------------------------------------------------

export type CoreLinkState =
  | { kind: "unloaded" }
  | { kind: "attaching" }
  | { kind: "attached"; capabilities: CoreCapabilities; asOf: number; stale: false }
  | { kind: "version_mismatch"; coreProtocolVersion: number; asOf: number }
  | {
      kind: "unreachable";
      /** Last capabilities seen before the link dropped, if any. */
      cached: CoreCapabilities | null;
      cachedAsOf: number | null;
      reason: string;
      code: string;
      /** Cached data may be shown, but only ever labelled stale. */
      stale: true;
    };

/**
 * Fold a probe outcome into link state. `cached` is only ever surfaced with
 * `stale: true`, so a disconnected Core can never look live (specs/05 §5,
 * design spec S05).
 */
export function foldCoreLink(
  outcome: ProbeOutcome | null,
  options: {
    now: number;
    previous?: CoreLinkState;
    transportAvailable: boolean;
    transportReason?: string | null;
  },
): CoreLinkState {
  const { now, previous, transportAvailable } = options;
  const cached =
    previous && previous.kind === "attached" ? previous.capabilities : null;
  const cachedAsOf =
    previous && previous.kind === "attached" ? previous.asOf : null;

  if (!transportAvailable) {
    return {
      kind: "unreachable",
      cached,
      cachedAsOf,
      reason:
        options.transportReason ??
        "this build is not running inside the Tauri shell, so it cannot reach the Core socket",
      code: "TRANSPORT_UNAVAILABLE",
      stale: true,
    };
  }
  if (outcome === null) {
    // Probe in flight: keep the shape minimal, never pretend to be attached.
    return { kind: "attaching" };
  }
  if (outcome.kind === "attached") {
    return {
      kind: "attached",
      capabilities: outcome.capabilities,
      asOf: now,
      stale: false,
    };
  }
  if (outcome.kind === "version_mismatch") {
    return {
      kind: "version_mismatch",
      coreProtocolVersion: outcome.coreProtocolVersion,
      asOf: now,
    };
  }
  return {
    kind: "unreachable",
    cached,
    cachedAsOf,
    reason: outcome.error.message,
    code: outcome.error.code,
    stale: true,
  };
}

export type SbxViewState =
  | { kind: "unprobed"; label: string; tone: StatusTone }
  | { kind: "not_installed"; label: string; tone: StatusTone }
  | {
      kind: "installed_daemon_unknown";
      label: string;
      tone: StatusTone;
      version: string | null;
    }
  | { kind: "daemon_down"; label: string; tone: StatusTone; version: string | null }
  | { kind: "ready"; label: string; tone: StatusTone; version: string | null };

/**
 * Docker SBX readiness, derived only from what Core reported. The scaffold Core
 * locates the binary but does not probe `version`/`daemonRunning`, which maps to
 * `installed_daemon_unknown` — never `ready`.
 */
export function foldSbxView(capabilities: CoreCapabilities | null): SbxViewState {
  if (capabilities === null || capabilities.sbx === null) {
    return { kind: "unprobed", label: "SBX status unknown", tone: "neutral" };
  }
  const { sbx } = capabilities;
  if (!sbx.installed) {
    return { kind: "not_installed", label: "Docker SBX not installed", tone: "danger" };
  }
  if (sbx.daemonRunning === false) {
    return {
      kind: "daemon_down",
      label: "SBX daemon is not running",
      tone: "danger",
      version: sbx.version,
    };
  }
  if (sbx.daemonRunning === true) {
    return { kind: "ready", label: "SBX ready", tone: "success", version: sbx.version };
  }
  return {
    kind: "installed_daemon_unknown",
    label: "SBX located, daemon not probed",
    tone: "attention",
    version: sbx.version,
  };
}

export interface AgentView {
  id: string;
  verified: boolean;
  streamingLabel: string;
  cancelLabel: string;
  resumeLabel: string;
  /** Only a verified adapter may run a task in this build. */
  usable: boolean;
}

/** Capability copy is derived from the advertised booleans only. */
export function foldAgentView(cap: AgentCapability): AgentView {
  return {
    id: cap.id,
    verified: cap.verified,
    streamingLabel: cap.supportsStreaming ? "Streams events" : "No streaming",
    cancelLabel: cap.supportsCancel ? "Cancel supported" : "Cancel unsupported",
    resumeLabel: cap.supportsResume
      ? "Native session resume verified"
      : "Resume not verified",
    usable: cap.verified,
  };
}

export interface WorkspaceModeView {
  mode: WorkspaceMode;
  label: string;
  /** `direct_mount` edits the host tree immediately and must be labelled. */
  liveWritable: boolean;
  blurb: string;
}

const WORKSPACE_MODE_VIEWS: Record<
  WorkspaceMode,
  Omit<WorkspaceModeView, "mode">
> = {
  direct_mount: {
    label: "Direct mount",
    liveWritable: true,
    blurb:
      "Host tree is writable immediately: files may already be modified on your machine.",
  },
  sbx_clone: {
    label: "Isolated clone",
    liveWritable: false,
    blurb:
      "Clone mode keeps task edits separate from your working tree until you apply them.",
  },
  host_worktree: {
    label: "Host worktree",
    liveWritable: false,
    blurb: "A separate Git worktree on the host; your checked-out tree is untouched.",
  },
  mountless: {
    label: "Mountless",
    liveWritable: false,
    blurb: "No host workspace is bound, so nothing can be written to your repository.",
  },
};

export function workspaceModeView(mode: WorkspaceMode): WorkspaceModeView {
  return { mode, ...WORKSPACE_MODE_VIEWS[mode] };
}

/**
 * How the UI must present the workspace mode of a sandbox row.
 *
 * `sandbox.list` now returns the mode Core recorded for the binding, but the
 * field is ADDITIVE and optional: absent means Core has no readable binding row,
 * and `direct_mount` means the mount is LIVE-WRITABLE (specs/02 §7). So an
 * absent mode must render as UNVERIFIED and be treated as live-writable —
 * blank-as-safe would silently promise protection the app cannot verify.
 */
export interface SandboxModeView {
  label: string;
  tone: StatusTone;
  /** True when the mount may write the host tree now — including when unverified. */
  liveWritable: boolean;
  /** False only when Core actually reported a mode. */
  verified: boolean;
  mode: WorkspaceMode | null;
  blurb: string;
}

export const UNVERIFIED_SANDBOX_MODE_VIEW: SandboxModeView = {
  label: "Workspace mode UNVERIFIED",
  tone: "attention",
  liveWritable: true,
  verified: false,
  mode: null,
  blurb:
    "Core returned no recorded binding mode for this sandbox, so this build cannot prove the " +
    "mount is isolated. It is shown as live-writable — the unsafe reading — because a " +
    "direct-mounted host tree is writable immediately and silence would promise otherwise.",
};

/**
 * `unrecognized` is Core's raw mode string when this build could not read it
 * (`SandboxSummary.unrecognizedWorkspaceMode`). It gets the SAME unverified,
 * live-writable view as an absent mode — never an isolation claim — with copy
 * that names what Core actually recorded instead of saying it recorded nothing.
 */
export function sandboxModeView(
  mode: WorkspaceMode | null | undefined,
  unrecognized?: string | null,
): SandboxModeView {
  if (mode === undefined || mode === null) {
    if (typeof unrecognized !== "string") return UNVERIFIED_SANDBOX_MODE_VIEW;
    return {
      ...UNVERIFIED_SANDBOX_MODE_VIEW,
      blurb:
        `Core recorded workspace mode "${displayRaw(unrecognized)}", which this Sandpane build ` +
        "does not recognise (it is older than Core), so it cannot prove the mount is isolated. " +
        "It is shown as live-writable — the unsafe reading — until the desktop is updated.",
    };
  }
  const view = workspaceModeView(mode);
  return {
    label: view.label,
    tone: view.liveWritable ? "danger" : "success",
    liveWritable: view.liveWritable,
    verified: true,
    mode,
    blurb: view.blurb,
  };
}

/**
 * The live-writable disclosure for ONE task, derived from that task's own
 * sandbox binding — never from whichever sandbox a view happens to focus.
 *
 * Every missing link resolves to UNVERIFIED (treated as live-writable, the
 * unsafe reading): no task row, a row with no `sandboxName` (event-only rows,
 * or Core did not report one), a name `sandbox.list` does not return, or a row
 * whose recorded mode is absent. Only a mode Core actually recorded for the
 * task's sandbox may claim isolation.
 */
export function taskIsolationView(
  task: Pick<TaskIndexEntry, "sandboxName"> | null | undefined,
  sandboxes: readonly Pick<
    SandboxSummary,
    "name" | "workspaceMode" | "unrecognizedWorkspaceMode"
  >[],
  /** False while `sandbox.list` is loading or failed: absence then proves nothing. */
  sandboxListAvailable = true,
): SandboxModeView & { reason: string } {
  const unverified = (reason: string) => ({ ...UNVERIFIED_SANDBOX_MODE_VIEW, reason });
  if (task === null || task === undefined) {
    return unverified("This task is not in Core's task list here, so its sandbox is unknown.");
  }
  if (task.sandboxName === null) {
    return unverified("Core did not report which sandbox this task runs in.");
  }
  const row = sandboxes.find((s) => s.name === task.sandboxName);
  if (row === undefined && !sandboxListAvailable) {
    return unverified(
      `Core's sandbox list is unavailable right now (loading or failed), so the workspace mode of ${task.sandboxName} cannot be read.`,
    );
  }
  if (row === undefined) {
    return unverified(
      `Sandbox ${task.sandboxName} is not in Core's sandbox list, so its workspace mode cannot be read.`,
    );
  }
  const view = sandboxModeView(row.workspaceMode, row.unrecognizedWorkspaceMode);
  return {
    ...view,
    reason: view.verified
      ? `Core recorded ${view.label} for this task's sandbox ${row.name}.`
      : typeof row.unrecognizedWorkspaceMode === "string"
        ? `Core recorded workspace mode "${displayRaw(row.unrecognizedWorkspaceMode)}" for this task's sandbox ${row.name}, which this Sandpane build does not recognise.`
        : `Core returned no recorded workspace mode for this task's sandbox ${row.name}.`,
  };
}

/**
 * Whether the running Core offers a method. `null` link means "not probed yet",
 * which is NOT "unsupported": the UI must show a pending state rather than
 * claiming a gap it has not observed (AGENTS rule 5).
 */
export interface FeatureGate {
  state: "unprobed" | "supported" | "unsupported";
  /** Copy explaining the state, safe to render directly. */
  note: string;
}

export function featureGate(
  advertised: boolean | null,
  method: string,
  unsupportedNote: string,
): FeatureGate {
  if (advertised === null) {
    return {
      state: "unprobed",
      note: `Core has not been probed yet, so support for ${method} is unknown.`,
    };
  }
  if (advertised) return { state: "supported", note: `${method} is advertised by this Core.` };
  return { state: "unsupported", note: unsupportedNote };
}

export function fileChangeLabel(
  status: FileChangeStatus | "unknown",
  unrecognized?: string | null,
): string {
  switch (status) {
    case "added":
      return "Added";
    case "modified":
      return "Modified";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "untracked":
      return "Untracked";
    default:
      return typeof unrecognized === "string"
        ? `Unknown status (${displayRaw(unrecognized)})`
        : "Unknown status";
  }
}

/**
 * What an apply would actually send, given the user's selection.
 *
 * A file whose status this build does not recognise is never sent: it is
 * dropped from an explicit selection, and while one is in the change set a
 * whole-set apply (no `selectedFiles`, which Core reads as "everything") is
 * blocked, because it would carry that file along implicitly.
 */
export interface ApplyPlan {
  canApply: boolean;
  /** `undefined` = whole change set (only when every file is recognised). */
  selectedFiles: string[] | undefined;
  /** Paths whose status this build cannot read. */
  unrecognized: string[];
  blockedReason: string | null;
}

export function planApply(changeSet: ChangeSet, selected: ReadonlySet<string>): ApplyPlan {
  const unknownChanges = changeSet.changes.filter((c) => c.status === "unknown");
  const unrecognized = unknownChanges.map((c) => c.path);
  const known = new Set(
    changeSet.changes.filter((c) => c.status !== "unknown").map((c) => c.path),
  );
  const selectedFiles = changeSet.changes
    .map((c) => c.path)
    .filter((path) => known.has(path) && selected.has(path));
  if (changeSet.changes.length === 0) {
    return { canApply: false, selectedFiles: undefined, unrecognized, blockedReason: null };
  }
  if (selectedFiles.length > 0) {
    return { canApply: true, selectedFiles, unrecognized, blockedReason: null };
  }
  if (unrecognized.length > 0) {
    const raws = unknownChanges
      .map((c) => `${displayRaw(c.path)} (${displayRaw(c.unrecognizedStatus ?? "unknown")})`)
      .join(", ");
    return {
      canApply: false,
      selectedFiles: undefined,
      unrecognized,
      blockedReason:
        `${unrecognized.length} file(s) have a status this Sandpane build does not recognise: ` +
        `${raws}. Applying the whole change set would include them, so select the recognised ` +
        "files to apply explicitly.",
    };
  }
  return { canApply: true, selectedFiles: undefined, unrecognized, blockedReason: null };
}

/**
 * Review panel copy for a `git.review` / `git.apply` pair. Every claim is
 * conditioned on data Core actually returned — "not yet applied" is only said
 * when the change set exists and apply has not succeeded.
 */
export function reviewSummary(
  changeSet: ChangeSet | null,
  apply: ApplyResult | null,
  /**
   * How many files the apply actually SENT (`selectedFiles.length`); omitted
   * for a whole-set apply. Never the full change-set length when a selection
   * or an unrecognised file narrowed what went to Core.
   */
  sentFileCount?: number,
): { headline: string; detail: string; tone: StatusTone } {
  if (changeSet === null) {
    return {
      headline: "No change set loaded",
      detail:
        "Run Review changes to fetch the diff against the task base commit.",
      tone: "neutral",
    };
  }
  if (apply?.applied) {
    // A whole-set apply is only ever sent when every file is recognised
    // (`planApply`), so the recognised count is what Core was asked to apply.
    const applied =
      sentFileCount ?? changeSet.changes.filter((c) => c.status !== "unknown").length;
    return {
      headline: "Applied",
      detail: `Core applied ${applied} file(s) from ${shortHash(
        changeSet.baseCommit,
      )}.`,
      tone: "success",
    };
  }
  const dirtyWarning = changeSet.hostDirty
    ? " Your host tree is dirty, so apply is blocked until you resolve it."
    : "";
  if (changeSet.changes.length === 0) {
    return {
      headline: "No changes against the task base",
      detail: `git diff vs ${shortHash(changeSet.baseCommit)} returned empty.${dirtyWarning}`,
      tone: "neutral",
    };
  }
  const unrecognized = changeSet.changes.filter((c) => c.status === "unknown").length;
  const unrecognizedNote =
    unrecognized > 0
      ? ` ${unrecognized} file(s) have a status this build does not recognise and cannot be applied from here.`
      : "";
  return {
    headline: `${changeSet.changes.length} file(s) changed`,
    detail: `Base ${shortHash(changeSet.baseCommit)}. Not applied to your working tree.${dirtyWarning}${unrecognizedNote}${
      apply?.abortReason ? ` Last apply aborted: ${apply.abortReason}.` : ""
    }`,
    tone: changeSet.hostDirty ? "attention" : "info",
  };
}

function shortHash(hash: string): string {
  return hash.length > 10 ? hash.slice(0, 10) : hash;
}

// ---------------------------------------------------------------------------
// Error copy (design spec §8: what failed, verified reason, what to do)
// ---------------------------------------------------------------------------

export interface ErrorCopy {
  title: string;
  reason: string;
  action: string;
  tone: StatusTone;
  /**
   * A command Core suggested (`details.hint`, e.g. `sbx login`), sanitized to
   * one short line. Shown as text for the user to run THEMSELVES — the desktop
   * never executes it.
   */
  hint?: string;
  /** `details.provider` when Core named one (e.g. `docker`), sanitized. */
  provider?: string;
}

/** Longest hint shown; Core's hints are short commands. */
const MAX_HINT_CHARS = 120;

/**
 * Reduce an untrusted `details` string to a single printable line: control
 * characters (incl. CR/LF, ANSI escapes) removed, whitespace collapsed,
 * length capped. Returns undefined when nothing usable remains.
 */
export function sanitizeHint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    // C0/C1 control characters (CR/LF, the ESC of ANSI sequences) and
    // zero-width / bidi-override marks that could make a shown command differ
    // from the text a user would copy.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_HINT_CHARS ? `${cleaned.slice(0, MAX_HINT_CHARS - 1)}…` : cleaned;
}

function coreHints(err: CoreRequestError): Pick<ErrorCopy, "hint" | "provider"> {
  const details = err.details;
  if (typeof details !== "object" || details === null) return {};
  const rec = details as Record<string, unknown>;
  const hint = sanitizeHint(rec.hint);
  const provider = sanitizeHint(rec.provider);
  return {
    ...(hint === undefined ? {} : { hint }),
    ...(provider === undefined ? {} : { provider }),
  };
}

const CORE_ERROR_COPY: Record<ErrorCode, Omit<ErrorCopy, "reason">> = {
  NOT_INSTALLED: {
    title: "Docker SBX is not installed",
    action:
      "Install the official sbx CLI, then retry. Sandpane never bundles or silently installs it.",
    tone: "danger",
  },
  DAEMON_DOWN: {
    title: "The SBX daemon is not running",
    action: "Start Docker/the SBX daemon, then retry this operation.",
    tone: "danger",
  },
  UNSUPPORTED_SBX_VERSION: {
    title: "Unsupported SBX version",
    action: "Update sbx to a version Sandpane documents, then retry.",
    tone: "attention",
  },
  PROVIDER_AUTH_REQUIRED: {
    title: "Provider authentication required",
    action:
      "Authenticate the agent through its official flow. Sandpane does not import credentials.",
    tone: "attention",
  },
  CONFLICT: {
    title: "Conflict",
    action: "Resolve the conflicting branch or workspace, then retry.",
    tone: "attention",
  },
  TASK_INTERRUPTED: {
    title: "Task interrupted",
    action:
      "Start a new task. Sandpane does not auto-resume execution after a Core restart.",
    tone: "danger",
  },
  PERMISSION_DENIED: {
    title: "Permission denied",
    action: "Check the workspace path and sandbox policy permissions, then retry.",
    tone: "danger",
  },
  VALIDATION_FAILED: {
    title: "Core rejected the request",
    action:
      "Fix the highlighted field. Core validates every value before it reaches a CLI argument.",
    tone: "attention",
  },
  NOT_FOUND: {
    title: "Not found",
    action:
      "Reload the list — the project, conversation or task no longer exists in Core.",
    tone: "neutral",
  },
  INTERNAL: {
    title: "Core reported an internal error",
    action: "Retry, and export redacted diagnostics from Settings if it repeats.",
    tone: "danger",
  },
};

export function describeCoreError(err: CoreRequestError): ErrorCopy {
  if (err.isCoreError && err.code === UNRECOGNIZED_CORE_CODE) {
    // Core answered with a code this build does not know: show Core's verdict
    // as itself — the raw code and Core's own message — without guessing what
    // it means or offering reassurance.
    const details = err.details;
    const raw =
      typeof details === "object" && details !== null
        ? (details as Record<string, unknown>).unrecognizedCode
        : undefined;
    return {
      title: `Core reported ${typeof raw === "string" ? displayRaw(raw) : "an error code"}, which this Sandpane build does not recognise`,
      reason: err.message,
      action:
        "This desktop build is older than Core. Read Core's message above; update Sandpane Desktop for specific guidance, and re-read state before retrying.",
      tone: "danger",
      ...coreHints(err),
    };
  }
  if (err.isCoreError) {
    const mapped = Object.prototype.hasOwnProperty.call(CORE_ERROR_COPY, err.code)
      ? CORE_ERROR_COPY[err.code as ErrorCode]
      : undefined;
    // A code this build does not have copy for is reported as itself; the UI
    // never invents reassurance for a verdict it cannot explain.
    if (mapped === undefined) {
      return {
        title: `Core reported ${String(err.code)}`,
        reason: err.message,
        action: "Re-check Core and retry; report this code if it repeats.",
        tone: "danger",
        ...coreHints(err),
      };
    }
    return { ...mapped, reason: err.message, ...coreHints(err) };
  }
  // A state-changing request whose answer was lost: the outcome is unknown, so
  // the copy is about re-reading state — never "retry", which could apply twice.
  if (err.mayHaveBeenApplied) {
    return {
      title: "Outcome unknown — this may have been applied",
      reason: err.message,
      action:
        "Re-read state first (refresh this view or re-open the task). Only retry if Core shows the change did not happen; a blind retry can apply it twice.",
      tone: "attention",
    };
  }
  switch (err.code) {
    case "CORE_UNREACHABLE":
      return {
        title: "Core is not running",
        reason: err.message,
        action:
          "Start sandpane-service (the desktop never launches its own Core), then retry.",
        tone: "danger",
      };
    case "CORE_REFUSED_CONNECTION":
      return {
        title: "Core refused this connection",
        reason: err.message,
        action:
          "Core turned the connection away before handling the request, so nothing was applied. Check that sandpane-service runs as your own user, then retry.",
        tone: "danger",
      };
    case "SOCKET_UNTRUSTED":
      return {
        title: "Refused an untrusted Core socket",
        reason: err.message,
        action:
          "The socket path is not a private socket owned by you, so no request was sent. Check the path in Settings and who created it; restart sandpane-service as yourself.",
        tone: "danger",
      };
    case "INVALID_PARAMS":
      return {
        title: "Blocked by the desktop before it reached Core",
        reason: err.message,
        action:
          "This request was never written to the socket: the value fails the same check Core applies (a scoping id must be non-empty and bounded, a limit must be a whole number). Fix the value and retry.",
        tone: "attention",
      };
    case "REPLAY_TOO_LARGE":
      return {
        title: "Core refused a replay too large for one frame",
        reason: err.message,
        action:
          "Event polling is paused for this scope, not failed: re-asking the same question cannot ever fit. Narrow it — open a single task, or a smaller project — then resume from the task view.",
        tone: "attention",
      };
    case "TRANSPORT_UNAVAILABLE":
      return {
        title: "No Core transport",
        reason: err.message,
        action:
          "Run the app inside the Tauri shell (`npm run tauri dev`) so the desktop can attach to the per-user Core socket.",
        tone: "danger",
      };
    case "TRANSPORT_CLOSED":
      return {
        title: "Core connection closed",
        reason: err.message,
        action:
          "Reconnect from the status bar. Active tasks in Core are not cancelled by a UI detach.",
        tone: "attention",
      };
    case "TIMEOUT":
      return {
        title: "Core did not answer in time",
        reason: err.message,
        action: "Check that sandpane-service is running, then retry.",
        tone: "attention",
      };
    case "FRAME_TOO_LARGE":
      return {
        title: "Frame exceeded the IPC cap",
        reason: err.message,
        action:
          "Send less context in one message. The 4 MiB cap protects the UI from unbounded buffers.",
        tone: "attention",
      };
    case "MALFORMED_FRAME":
      return {
        title: "Malformed Core frame",
        reason: err.message,
        action:
          "Reconnect. If it repeats, the Core build does not match this desktop build.",
        tone: "danger",
      };
    case "VERSION_MISMATCH":
      return {
        title: "Protocol version mismatch",
        reason: err.message,
        action: "Update Sandpane Core and the desktop app to the same release.",
        tone: "danger",
      };
    case "METHOD_NOT_ALLOWED":
      return {
        title: "Method not allowed",
        reason: err.message,
        action:
          "This is a bug in the desktop client: only allowlisted Core methods may be called.",
        tone: "danger",
      };
    default:
      // Unmapped client code: never invent reassuring copy for it.
      return {
        title: `Desktop client error (${err.code})`,
        reason: err.message,
        action: "Re-check Core and retry; report this code if it repeats.",
        tone: "danger",
      };
  }
}
