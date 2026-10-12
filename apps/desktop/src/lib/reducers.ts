/**
 * Pure display logic. Nothing here decides a task lifecycle transition —
 * transitions are enforced in Core (`sandpane_core::task`) and this module only
 * renders the status Core reported (AGENTS.md §Code Review rule 3). Where the
 * spec calls a state that this build cannot observe, the function returns an
 * explicit `unknown`/`unprobed` shape instead of a guess.
 */

import { conversationMessageCopy } from "./conversation-messages";
import { createRepoBusyKind, gitMessageCopy } from "./git-messages";
import { projectMessageCopy } from "./project-messages";
import { verificationDeleteRefusalCopy } from "./verification-messages";
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
import { idempotencyConflictCopy, idempotencyConflictKind } from "./idempotency";
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
  row: TaskRowRead | null | undefined,
  projection: TaskEventsRead | null | undefined,
): string | null {
  if (row?.unrecognizedStatus != null) {
    return (
      `Core reports status "${displayRaw(row.unrecognizedStatus)}" for this task, which this ` +
      "Sandpane build does not recognise (it is older than Core). Review and apply are disabled " +
      "here until the desktop is updated; nothing has been applied."
    );
  }
  if (row?.source === "task.list" && row.status === "unknown") {
    return (
      "Core's task row reports a status this Sandpane build does not recognise for this task. " +
      "Review and apply are disabled here until the desktop is updated; nothing has been applied."
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

/** Core's stored task row as the gates read it (a `TaskIndexEntry` fits). */
export interface TaskRowRead {
  unrecognizedStatus: string | null;
  status?: TaskStatus | "unknown";
  /**
   * Where the row came from. Only a `task.list` row's `"unknown"` means "Core
   * said something unrecognised": an event-only row folds a status that was
   * never reported to `"unknown"` too, and that is "not reported".
   */
  source?: TaskIndexSource;
}

/** The status Core's durable event log last reported (a `TaskProjection` fits). */
export interface TaskEventsRead {
  status: TaskStatus | "unknown" | null;
  unrecognizedStatus?: string | null;
}

/**
 * Every task action the desktop offers, from ONE place over BOTH Core reads.
 *
 * Cancel, review, apply and retry depend on knowing the task's state. When
 * EITHER read — Core's task row or its event log — reports a status this build
 * does not recognise, all of them are disabled: the review block
 * (`reviewBlockReason`) and the action flags come from the same check, so a
 * view can never block review while still offering Cancel. When both reads are
 * recognised the event log decides, as before; a known-vs-known difference is
 * surfaced by `foldTaskIndex` (`disagreement`), never resolved here.
 */
export interface TaskActionGate {
  /** True when either Core read reports a status this build cannot interpret. */
  unrecognized: boolean;
  canCancel: boolean;
  canReview: boolean;
  canRetry: boolean;
  /** Non-null when review/apply must stay disabled (`reviewBlockReason`). */
  blockedReason: string | null;
  /** Why Cancel is disabled, safe to render; null when Cancel is offered. */
  cancelUnavailableReason: string | null;
}

export function taskActionGate(
  row: TaskRowRead | null | undefined,
  projection: TaskEventsRead | null | undefined,
): TaskActionGate {
  const blockedReason = reviewBlockReason(row, projection);
  if (blockedReason !== null) {
    return {
      unrecognized: true,
      canCancel: false,
      canReview: false,
      canRetry: false,
      blockedReason,
      cancelUnavailableReason:
        "Core reported a status this Sandpane build does not recognise, so it cannot tell " +
        "whether cancelling applies. Cancel is disabled here until the desktop is updated.",
    };
  }
  const status = projection?.status ?? null;
  const actions = describeTaskAction(status);
  return {
    unrecognized: false,
    ...actions,
    blockedReason: null,
    cancelUnavailableReason: actions.canCancel
      ? null
      : status === null
        ? "No status has been reported for this task in this window yet, so there is nothing to cancel from here."
        : "This task is already in a terminal or review state; cancelling would change nothing.",
  };
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
  /**
   * The `"unknown"` bucket (`taskBucket`): a status this build does not
   * recognise, or none reported yet. Every bucket together equals `total`.
   */
  unrecognized: number;
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
    unrecognized: 0,
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
        // "unknown" and any future wire status: its own visible bucket, never
        // folded into a known one.
        counts.unrecognized += 1;
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
  /** A4: `TaskSummary.mode` (open string), from the task.list row; else null. */
  mode: string | null;
  /**
   * A4: `TaskSummary.chosenSandboxName` — the name the task's chat chose.
   * Display only: NEVER read by `taskIsolationView` or any count or scope.
   */
  chosenSandboxName: string | null;
  /**
   * Core's raw status when this build does not recognise it (`status` is then
   * `"unknown"`): from the `task.list` row, or from the event log for an
   * event-only row. Null otherwise.
   */
  unrecognizedStatus: string | null;
  /**
   * Set when Core's two reads report different statuses for the same task —
   * including two DIFFERENT unrecognised raw values, which are both `"unknown"`
   * here. Each side keeps its raw string (null when recognised) so the UI can
   * name exactly what each read said.
   */
  disagreement: {
    fromEvents: TaskStatus | "unknown";
    fromEventsRaw: string | null;
    fromTaskList: TaskStatus | "unknown";
    fromTaskListRaw: string | null;
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
      mode: task.mode ?? null,
      chosenSandboxName: task.chosenSandboxName ?? null,
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
        mode: null,
        chosenSandboxName: null,
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
      // by a client-side guess (AGENTS rule 3). An event log that has not
      // reported a status yet (`null`) has nothing to disagree with.
      disagreement:
        projection.status !== null &&
        (projection.status !== existing.status ||
          (projection.unrecognizedStatus ?? null) !== existing.unrecognizedStatus)
          ? {
              fromEvents: projection.status,
              fromEventsRaw: projection.unrecognizedStatus ?? null,
              fromTaskList: existing.status,
              fromTaskListRaw: existing.unrecognizedStatus,
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

/**
 * The event-log read carried by a folded index row, for `taskActionGate` where
 * only the row is at hand (the Tasks table). When the two Core reads differ the
 * row keeps the event side in `disagreement`; an event-only row whose status
 * was never reported (folded to `"unknown"` with no raw value) is "not
 * reported", not "unrecognised".
 */
export function indexRowEventsRead(row: TaskIndexEntry): TaskEventsRead {
  if (row.disagreement !== null) {
    return {
      status: row.disagreement.fromEvents,
      unrecognizedStatus: row.disagreement.fromEventsRaw,
    };
  }
  if (row.source === "events" && row.status === "unknown" && row.unrecognizedStatus === null) {
    return { status: null, unrecognizedStatus: null };
  }
  return { status: row.status, unrecognizedStatus: row.unrecognizedStatus };
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
    }
  | {
      /**
       * A6 durable apply record (`git.apply.started` / `git.applied` /
       * `git.apply.failed` / `git.apply.reconciled`). Display only: it never
       * changes the task's status. `text` is revealed and capped.
       */
      kind: "git-apply";
      sequence: number;
      timestamp: string;
      phase: "started" | "applied" | "failed" | "reconciled";
      tone: StatusTone;
      text: string;
    }
  | {
      /**
       * A7 durable verification record (`verification.started` /
       * `verification.finished`). Display only: it NEVER changes the task's
       * status (rule 3, I6), and output is never in it (read it with
       * `verification.result`). `text` is revealed and capped; the raw
       * fields are UNTRUSTED and must be revealed wherever they are shown.
       */
      kind: "verification";
      sequence: number;
      timestamp: string;
      phase: "started" | "finished";
      /** Core's `runId`, or null when the payload did not carry a readable one. */
      runId: string | null;
      tone: StatusTone;
      text: string;
      /** started: the command Core recorded (raw, untrusted). */
      label?: string;
      argv?: string[];
      sandbox?: string;
      workspaceMode?: string;
      /** finished: Core's raw outcome (open string), exit status and disclosures. */
      outcome?: string;
      exitCode?: number;
      disclosures?: string[];
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
    case "git.apply.started":
    case "git.applied":
    case "git.apply.failed":
    case "git.apply.reconciled":
      // A6: shown honestly, never folded into the task status.
      return withSequence(p, event, {}, gitApplyEntry(kind, payload, sequence, timestamp));
    case "verification.started":
    case "verification.finished":
      // A7: shown honestly, never folded into the task status (I6).
      return withSequence(p, event, {}, verificationEntry(kind, payload, sequence, timestamp));
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

/** Display cap for Core's reason inside an apply timeline entry. */
const GIT_APPLY_REASON_CHARS = 300;

function fileCount(payload: Record<string, unknown>): number | null {
  const files = payload.files;
  return Array.isArray(files) ? files.length : null;
}

function filesText(n: number | null): string {
  return n === null ? "files (list not readable)" : `${n} file(s)`;
}

/**
 * A6 apply events, decoded as OPEN payloads (every field optional). The
 * `entries` / `expected` / `before` fields are never rendered; a `partial`
 * that is not exactly `false` is treated as a possible partial.
 */
function gitApplyEntry(
  kind: "git.apply.started" | "git.applied" | "git.apply.failed" | "git.apply.reconciled",
  rawPayload: unknown,
  sequence: number,
  timestamp: string,
): TimelineEntry {
  const payload =
    typeof rawPayload === "object" && rawPayload !== null ? (rawPayload as Record<string, unknown>) : {};
  const files = filesText(fileCount(payload));
  const at = { kind: "git-apply" as const, sequence, timestamp };
  switch (kind) {
    case "git.apply.started":
      return {
        ...at,
        phase: "started",
        tone: "info",
        text: `Apply started for ${files} (Core recorded the start before writing)`,
      };
    case "git.applied":
      return {
        ...at,
        phase: "applied",
        tone: "success",
        text: `Applied ${files} to the repository (staged, not committed)`,
      };
    case "git.apply.failed": {
      const reason =
        typeof payload.reason === "string"
          ? `: ${displayRevealed(payload.reason, GIT_APPLY_REASON_CHARS).text}`
          : "";
      // Core always sends a boolean; anything but `false` (absent, garbled) is
      // a POSSIBLE partial, never "nothing written".
      const partial = payload.partial !== false;
      return partial
        ? {
            ...at,
            phase: "failed",
            tone: "danger",
            text: `Apply did not finish cleanly — some files may have been written or staged; check git status${reason}`,
          }
        : { ...at, phase: "failed", tone: "attention", text: `Apply aborted, no partial write reported${reason}` };
    }
    case "git.apply.reconciled": {
      const outcome = typeof payload.outcome === "string" ? payload.outcome : null;
      const found =
        outcome === "applied"
          ? "it found the files applied"
          : outcome === "partial"
            ? "it found a PARTIAL apply"
            : outcome === "not_applied"
              ? "it found nothing written"
              : `it cannot know what was written (outcome: ${
                  outcome === null ? "not reported" : displayRevealed(outcome, 64).text
                })`;
      return {
        ...at,
        phase: "reconciled",
        tone: outcome === "not_applied" ? "attention" : "danger",
        text: `Core restarted during an apply; ${found} — check git status in the repository`,
      };
    }
  }
}

export interface OutcomeView {
  label: string;
  /** Never "success": exit 0 is not a pass until C-2 is captured (I4). */
  tone: Exclude<StatusTone, "success">;
}

/** "exit status N (as reported by sbx exec)" — never "passed" / "failed". */
export function exitStatusText(exitCode: number | undefined): string {
  return exitCode === undefined
    ? "exit status not reported"
    : `exit status ${exitCode} (as reported by sbx exec)`;
}

/**
 * Honest copy for an OPEN `outcome` string. Unknown values are shown as-is
 * (revealed); nothing is ever coloured or worded as a pass or a fail.
 */
export function outcomeView(outcome: string, exitCode: number | undefined): OutcomeView {
  switch (outcome) {
    case "exited":
      return { label: exitStatusText(exitCode), tone: "neutral" };
    case "signaled":
      return { label: "ended by a signal (no exit status)", tone: "attention" };
    case "timed_out":
      return {
        label: "stopped after 10 minutes; the command may still be running inside the sandbox",
        tone: "attention",
      };
    case "interrupted":
      return {
        label:
          "Core restarted (or stopped) while this ran; the result is unknown; the command may still be running inside the sandbox",
        tone: "attention",
      };
    case "possibly_sbx_error":
      return {
        label: `possibly sbx's own error, or the command's own output — ${exitStatusText(exitCode)}`,
        tone: "attention",
      };
    case "spawn_failed":
      return { label: "Core could not start sbx exec (spawn_failed)", tone: "attention" };
    case "read_failed":
      return {
        label: "Core could not read the command's output (read_failed); the exit status is unknown",
        tone: "attention",
      };
    case "running":
      return { label: "running — Core has not recorded an outcome yet", tone: "info" };
    default:
      return {
        label: `Core reported outcome "${displayRevealed(outcome, 64).text}", which this Sandpane build does not recognise`,
        tone: "attention",
      };
  }
}


export const DISCLOSURE_OUTPUT_INCOMPLETE =
  "output may be incomplete: a process kept the output open after the command exited";
export const DISCLOSURE_OUTPUT_WITHHELD = "output was not stored because the secret check was unavailable";
export const DISCLOSURE_BEST_EFFORT =
  "Output is redacted before Core stores it, on a best-effort basis; it was decoded lossily, and a secret cut at the 64 KiB cap can survive as a partial token.";

export function redactedCountText(n: number): string {
  return `${n} ${n === 1 ? "value was" : "values were"} redacted (best effort)`;
}


/** Display caps for a verification timeline entry. */
const VERIFICATION_LABEL_CHARS = 120;
const VERIFICATION_NAME_CHARS = 120;

/** Disclosures carried by a `verification.finished` payload (flags only; never output). */
function finishedDisclosures(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (payload.stdoutTruncated === true) out.push("stdout was cut at Core's 64 KiB cap");
  if (payload.stderrTruncated === true) out.push("stderr was cut at Core's 64 KiB cap");
  if (payload.outputIncomplete === true) out.push(DISCLOSURE_OUTPUT_INCOMPLETE);
  const redactions =
    typeof payload.redactions === "object" && payload.redactions !== null
      ? (payload.redactions as Record<string, unknown>)
      : {};
  if (redactions.outputWithheld === true) out.push(DISCLOSURE_OUTPUT_WITHHELD);
  if (typeof redactions.replacements === "number" && redactions.replacements > 0) {
    out.push(redactedCountText(redactions.replacements));
  }
  if (payload.reconciledAfterRestart === true) {
    out.push("Core found this run unfinished after a restart; its result is unknown");
  }
  return out;
}

/**
 * A7 verification events, decoded as OPEN payloads (every field optional).
 * Output is never in an event; the outcome copy is the same as the result
 * view's, and nothing is ever coloured as a pass.
 */
function verificationEntry(
  kind: "verification.started" | "verification.finished",
  rawPayload: unknown,
  sequence: number,
  timestamp: string,
): TimelineEntry {
  const payload =
    typeof rawPayload === "object" && rawPayload !== null ? (rawPayload as Record<string, unknown>) : {};
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  const at = { kind: "verification" as const, sequence, timestamp, runId };
  if (kind === "verification.started") {
    const label = typeof payload.label === "string" ? payload.label : undefined;
    const argv =
      Array.isArray(payload.argv) && payload.argv.every((a) => typeof a === "string")
        ? (payload.argv as string[])
        : undefined;
    const sandbox = typeof payload.sandbox === "string" ? payload.sandbox : undefined;
    const workspaceMode = typeof payload.workspaceMode === "string" ? payload.workspaceMode : undefined;
    const shownLabel = label === undefined ? "(label not readable)" : displayRevealed(label, VERIFICATION_LABEL_CHARS).text;
    const shownSandbox =
      sandbox === undefined ? "(sandbox not readable)" : displayRevealed(sandbox, VERIFICATION_NAME_CHARS).text;
    return {
      ...at,
      phase: "started",
      tone: "info",
      text: `Verification started: ${shownLabel} in sandbox ${shownSandbox} (Core recorded the start before running sbx exec)`,
      ...(label === undefined ? {} : { label }),
      ...(argv === undefined ? {} : { argv: [...argv] }),
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(workspaceMode === undefined ? {} : { workspaceMode }),
    };
  }
  const outcome = typeof payload.outcome === "string" && payload.outcome.length > 0 ? payload.outcome : undefined;
  const exitCode =
    typeof payload.exitCode === "number" && Number.isInteger(payload.exitCode) ? payload.exitCode : undefined;
  const view =
    outcome === undefined
      ? { label: "Core did not report a readable outcome", tone: "attention" as const }
      : outcomeView(outcome, exitCode);
  return {
    ...at,
    phase: "finished",
    tone: view.tone,
    text: `Verification finished: ${view.label}`,
    ...(outcome === undefined ? {} : { outcome }),
    ...(exitCode === undefined ? {} : { exitCode }),
    disclosures: finishedDisclosures(payload),
  };
}

/** One verification run as the task's durable events describe it. */
export interface VerificationRunRecord {
  runId: string;
  startedSequence: number;
  startedAt: string;
  /** Raw, untrusted (render revealed). */
  label: string | null;
  argv: string[] | null;
  sandbox: string | null;
  workspaceMode: string | null;
  /** The `verification.finished` entry, or null while none has been seen. */
  finished: { sequence: number; outcome: string | null; exitCode?: number; disclosures: string[] } | null;
}

/** Every run the projection's events started, oldest first, each with its finish if seen. */
export function verificationRunsOf(projection: Pick<TaskProjection, "entries"> | null): VerificationRunRecord[] {
  if (projection === null) return [];
  const runs = new Map<string, VerificationRunRecord>();
  for (const entry of projection.entries) {
    if (entry.kind !== "verification" || entry.runId === null) continue;
    if (entry.phase === "started") {
      if (!runs.has(entry.runId)) {
        runs.set(entry.runId, {
          runId: entry.runId,
          startedSequence: entry.sequence,
          startedAt: entry.timestamp,
          label: entry.label ?? null,
          argv: entry.argv ?? null,
          sandbox: entry.sandbox ?? null,
          workspaceMode: entry.workspaceMode ?? null,
          finished: null,
        });
      }
      continue;
    }
    const run = runs.get(entry.runId);
    if (run === undefined || run.finished !== null) continue;
    run.finished = {
      sequence: entry.sequence,
      outcome: entry.outcome ?? null,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      disclosures: entry.disclosures ?? [],
    };
  }
  return [...runs.values()];
}

/** Runs the events show started in sandbox `name` and not yet finished (any task). */
export function verificationsRunningIn(
  projections: Iterable<Pick<TaskProjection, "entries">>,
  name: string,
): number {
  let count = 0;
  for (const projection of projections) {
    for (const run of verificationRunsOf(projection)) {
      if (run.finished === null && run.sandbox === name) count += 1;
    }
  }
  return count;
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

/**
 * The sbx evidence lines a Core may add to its probe (A8a). `null` = Core did
 * not say (field absent), so no line is rendered.
 */
export interface SbxEvidenceLines {
  execLine: string | null;
  capturedLine: string | null;
}

export type SbxViewState =
  | ({ kind: "unprobed"; label: string; tone: StatusTone } & SbxEvidenceLines)
  | ({ kind: "not_installed"; label: string; tone: StatusTone } & SbxEvidenceLines)
  | ({
      kind: "installed_daemon_unknown";
      label: string;
      tone: StatusTone;
      version: string | null;
    } & SbxEvidenceLines)
  | ({ kind: "daemon_down"; label: string; tone: StatusTone; version: string | null } & SbxEvidenceLines)
  | ({
      kind: "daemon_running";
      label: string;
      tone: StatusTone;
      version: string | null;
    } & SbxEvidenceLines);

/**
 * Exact daemon labels (design 2026-10-09 §3.8 item 1). Never "ready"/"healthy".
 * "(at last check)": the state is one probe's reading, and it can change
 * without Sandpane — `sbx ls` (run by `sandbox.list`) was captured auto-starting
 * the daemon on sbx 0.47.0.
 */
export const SBX_DAEMON_RUNNING_LABEL = "SBX daemon running (at last check)";
export const SBX_DAEMON_STOPPED_LABEL = "SBX daemon stopped (at last check)";
export const SBX_DAEMON_UNKNOWN_LABEL = "SBX daemon state unknown";

export const SBX_EXEC_ENABLED_LINE = "Verification runs are enabled for this sbx version";
export const SBX_EXEC_NOT_ENABLED_LINE = "Verification runs are not enabled for this sbx version";
export const SBX_CAPTURED_LINE_PREFIX =
  "Same sbx version number as Sandpane's captured fixtures (macOS; build not compared)";

/** The exec line, only when Core reported `execVerified` (absent → `null`). */
export function sbxExecLine(execVerified: boolean | undefined): string | null {
  if (execVerified === undefined) return null;
  return execVerified ? SBX_EXEC_ENABLED_LINE : SBX_EXEC_NOT_ENABLED_LINE;
}

/**
 * The captured-fixtures line, only when Core reported `versionCaptured`. It is a
 * statement about Sandpane's evidence, never a support claim, so callers render
 * it as plain text — never a success tone or a check mark.
 */
export function sbxCapturedLine(versionCaptured: boolean | undefined): string | null {
  if (versionCaptured === undefined) return null;
  return `${SBX_CAPTURED_LINE_PREFIX}: ${versionCaptured ? "yes" : "no"}`;
}

const NO_SBX_EVIDENCE: SbxEvidenceLines = { execLine: null, capturedLine: null };

/**
 * Docker SBX daemon state, derived only from what Core reported. Core reads
 * `daemonRunning` from the captured text form of `sbx daemon status`; `null`
 * (or an older Core that does not say) maps to `installed_daemon_unknown`.
 *
 * A running daemon is labelled "SBX daemon running (at last check)" in the `info` tone, never
 * "ready" or `success`: the captured sbx errors show a running daemon can still
 * be unusable (not signed in, policy not initialised), so a green "ready"
 * would claim more than Core verified.
 */
export function foldSbxView(capabilities: CoreCapabilities | null): SbxViewState {
  if (capabilities === null || capabilities.sbx === null) {
    return { kind: "unprobed", label: "SBX status unknown", tone: "neutral", ...NO_SBX_EVIDENCE };
  }
  const { sbx } = capabilities;
  if (!sbx.installed) {
    return {
      kind: "not_installed",
      label: "Docker SBX not installed",
      tone: "danger",
      ...NO_SBX_EVIDENCE,
    };
  }
  const evidence: SbxEvidenceLines = {
    execLine: sbxExecLine(sbx.execVerified),
    capturedLine: sbxCapturedLine(sbx.versionCaptured),
  };
  if (sbx.daemonRunning === false) {
    return {
      kind: "daemon_down",
      label: SBX_DAEMON_STOPPED_LABEL,
      tone: "danger",
      version: sbx.version,
      ...evidence,
    };
  }
  if (sbx.daemonRunning === true) {
    return {
      kind: "daemon_running",
      label: SBX_DAEMON_RUNNING_LABEL,
      tone: "info",
      version: sbx.version,
      ...evidence,
    };
  }
  return {
    kind: "installed_daemon_unknown",
    label: SBX_DAEMON_UNKNOWN_LABEL,
    tone: "attention",
    version: sbx.version,
    ...evidence,
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
 * Review panel copy for a `git.review` / `git.apply` pair. Every claim is
 * conditioned on data Core actually returned — "not yet applied" is only said
 * when the change set exists and apply has not succeeded.
 */
export function reviewSummary(
  changeSet: ChangeSet | null,
  apply: ApplyResult | null,
  /**
   * How many entries the apply actually SENT; used only when Core's success
   * answer omits `appliedFiles`. Never the full change-set length.
   */
  sentFileCount?: number,
  /** The last apply's answer was lost: its outcome is UNKNOWN (may have been applied). */
  applyOutcomeUnknown = false,
): { headline: string; detail: string; tone: StatusTone } {
  if (changeSet === null) {
    return {
      headline: "No change set loaded",
      detail:
        "Run Review changes to fetch the diff against the task base commit.",
      tone: "neutral",
    };
  }
  if (apply?.partial === true) {
    // A6 W1/W2: some files MAY have been written or staged — never "applied",
    // never "not applied".
    return {
      headline: "Apply incomplete",
      detail: "Some files may have been written or staged — check git status in the repository before retrying.",
      tone: "danger",
    };
  }
  if (apply?.applied) {
    const applied = apply.appliedFiles?.length ?? sentFileCount ?? 0;
    return {
      headline: "Applied",
      detail: `Core applied ${applied} file(s) from ${shortHash(
        changeSet.baseCommit,
      )} (staged, not committed).`,
      tone: "success",
    };
  }
  const dirtyWarning = changeSet.hostDirty
    ? " Your host tree is dirty; Core refuses an apply that touches any path that is not clean."
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
  // No claim about the working tree unless Core made one: this view cannot
  // know what was applied before it mounted.
  const applyNote = applyOutcomeUnknown
    ? " The last apply's outcome is unknown (Core's answer was lost) — check git status in the repository."
    : "";
  const aborted = apply?.abortReason
    ? ` Last apply aborted: ${displayRevealed(apply.abortReason, MAX_REASON_CHARS).text}.`
    : "";
  return {
    headline: `${changeSet.changes.length} file(s) changed`,
    detail: `Base ${shortHash(changeSet.baseCommit)} — changes in the task's workspace.${applyNote}${dirtyWarning}${unrecognizedNote}${aborted}`,
    tone: applyOutcomeUnknown ? "danger" : changeSet.hostDirty ? "attention" : "info",
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

/** Longest hint shown, in code points; Core's hints are short commands. */
const MAX_HINT_CHARS = 120;

/**
 * Characters that render as nothing (or reorder their neighbours), so text
 * containing them can look different from what it is: soft hyphen, Arabic
 * letter mark, Mongolian vowel separator, zero-width and directional marks,
 * bidi embeddings / overrides / isolates, word joiner and invisible math
 * operators, BOM, interlinear annotation controls, and the tag block.
 * A RegExp character-class body for use with the `u` flag.
 */
const INVISIBLE_CLASS =
  "\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069" +
  "\\ufeff\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}";

/** C0/C1 controls (CR/LF, the ESC of ANSI sequences) plus `INVISIBLE_CLASS`. */
const HINT_STRIP = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${INVISIBLE_CLASS}]`, "gu");

/**
 * What a file path must never show raw: everything in `HINT_STRIP`, spaces
 * that are not U+0020 (a path could otherwise imitate another), line/paragraph
 * separators, and lone surrogates.
 */
const PATH_ESCAPE = new RegExp(
  `[\\u0000-\\u001f\\u007f-\\u009f${INVISIBLE_CLASS}` +
    "\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ud800-\\udfff]",
  "gu",
);

/** Cut to `max` code points (never inside a surrogate pair), marking the cut. */
function capCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : value;
}

/**
 * Reduce an untrusted `details` string to a single printable line: control
 * characters (incl. CR/LF, ANSI escapes) and invisible / reordering characters
 * removed, whitespace collapsed, length capped by code points. Returns
 * undefined when nothing usable remains.
 */
export function sanitizeHint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(HINT_STRIP, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return capCodePoints(cleaned, MAX_HINT_CHARS);
}

/** Longest path shown, in code points of Core's raw path. */
const MAX_PATH_CHARS = 1024;

/**
 * Display form of a file path Core reported. Unlike `sanitizeHint`, nothing is
 * removed silently: each hidden, control or look-alike character is shown as a
 * visible escape (`\u202E`, `\u{E0041}`) and `unusual` is set, so a path that
 * a bidi override would make read as `gnp.exe` is shown for what it is. Display
 * ONLY — the raw path is what selection and `git.apply` use.
 */
export function displayPath(path: string): { text: string; unusual: boolean } {
  return displayRevealed(path, MAX_PATH_CHARS);
}

/**
 * Display form of ANY untrusted single-line text Core relayed (a path, a
 * confirmation `impact` line, a target name): hidden, control and look-alike
 * characters become visible escapes instead of being stripped, so a U+202E or
 * an embedded newline can neither reorder the text nor fake an extra line, and
 * `unusual` says that something was revealed. Cut at `maxChars` code points
 * with the remainder counted. The result is plain text for React to render —
 * never HTML.
 */
export function displayRevealed(
  value: string,
  maxChars: number,
): { text: string; unusual: boolean } {
  const points = Array.from(value);
  const cut = points.length > maxChars;
  const head = cut ? points.slice(0, maxChars).join("") : value;
  let unusual = false;
  const escaped = head.replace(PATH_ESCAPE, (ch) => {
    unusual = true;
    const code = ch.codePointAt(0) ?? 0;
    const hex = code.toString(16).toUpperCase();
    return code > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
  });
  return {
    text: cut ? `${escaped}… (${points.length - maxChars} more characters)` : escaped,
    unusual,
  };
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

/** A1's per-sandbox name lock (`claim_sandbox_name` in sandpane-service). */
export const NAME_LOCK_PREFIX = "another operation on sandbox ";
export const NAME_LOCK_SUFFIX = " is in progress; nothing was run";

export function isNameLockConflict(message: string): boolean {
  return message.startsWith(NAME_LOCK_PREFIX) && message.endsWith(NAME_LOCK_SUFFIX);
}

/** Copy for an unknown outcome when the request carried NO idempotency key. */
export const UNKEYED_UNKNOWN_ACTION =
  "Check state before trying again (this Core does not advertise idempotency keys, so a retry could run it twice).";
/** Copy for an unknown outcome when the request carried an idempotency key. */
export const KEYED_UNKNOWN_ACTION =
  "Re-read state first. Retry safely resends the identical request with the same idempotency key, so Core will not run it twice.";

/**
 * The single unknown-outcome rendering. `details.idempotencyKeyed` is set by
 * the client for `sandbox.create` / `conversation.send`; when it is absent
 * (any other write) the generic "re-read state first" copy applies.
 */
function unknownOutcomeCopy(err: CoreRequestError): ErrorCopy {
  const details = err.details;
  const keyed =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>).idempotencyKeyed
      : undefined;
  return {
    title: "Outcome unknown — this may have been applied",
    reason: err.message,
    action:
      keyed === true
        ? KEYED_UNKNOWN_ACTION
        : keyed === false
          ? UNKEYED_UNKNOWN_ACTION
          : "Re-read state first (refresh this view or re-open the task). Only retry if Core shows the change did not happen; a blind retry can apply it twice.",
    tone: "attention",
    ...(err.isCoreError ? coreHints(err) : {}),
  };
}

/** Longest Core/transport reason shown, in code points (the cut is disclosed). */
export const MAX_REASON_CHARS = 600;
/** Longest error title shown, in code points. */
const MAX_ERROR_TITLE_CHARS = 300;

/**
 * User-facing copy for any request failure. Core's `message` routinely carries
 * sbx stderr, which can contain bidi overrides, U+2028/U+2029 or newlines, so
 * the reason and title are REVEALED (hidden characters shown as `\uXXXX`, never
 * applied) and capped here, once, for every surface that renders an error.
 */
export function describeCoreError(err: CoreRequestError): ErrorCopy {
  const copy = describeCoreErrorUnrevealed(err);
  return {
    ...copy,
    title: displayRevealed(copy.title, MAX_ERROR_TITLE_CHARS).text,
    reason: displayRevealed(copy.reason, MAX_REASON_CHARS).text,
  };
}

function describeCoreErrorUnrevealed(err: CoreRequestError): ErrorCopy {
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
    // A2: the three idempotency CONFLICTs share Core's CONFLICT code and are
    // told apart by Core's exact message (kept verbatim as `reason`). Only
    // "mismatch"/"pending" may say nothing was run; "unknown" never does.
    // A keyed write (`sandbox.create` / `conversation.send`) that Core answered
    // with INTERNAL: sbx or Core may have acted, so this is an unknown outcome.
    if (err.mayHaveBeenApplied) return unknownOutcomeCopy(err);
    // A1 name lock: another operation holds this sandbox name; nothing ran.
    if (err.code === "CONFLICT" && isNameLockConflict(err.message)) {
      return {
        title: "Nothing was run — another operation on this sandbox is in progress",
        reason: err.message,
        action: "Wait for it to finish, then re-read state before trying again.",
        tone: "attention",
        ...coreHints(err),
      };
    }
    // A6 (W-N1): sandbox.create refused because the repository it would
    // direct-mount is busy. Core says "nothing was created"; its text stays.
    if (err.code === "CONFLICT" && createRepoBusyKind(err.message) !== null) {
      return {
        title: "Repository busy — nothing was created; try again when it finishes",
        reason: err.message,
        action:
          createRepoBusyKind(err.message) === "writer-lock"
            ? "A writer task, an apply or a worktree discard holds the repository. Create the sandbox after it finishes."
            : "Another direct-mount sandbox of this repository is being created. Try again when that create finishes.",
        tone: "attention",
        ...coreHints(err),
      };
    }
    // A3a: Core's exact project-lifecycle refusals (code + text). Each is a
    // refusal before any change, so only these may say "nothing was …".
    // A3b: the same, for Core's exact conversation-lifecycle refusals.
    const lifecycle =
      projectMessageCopy(String(err.code), err.message) ??
      conversationMessageCopy(String(err.code), err.message) ??
      gitMessageCopy(String(err.code), err.message, err.method) ??
      // A7: a delete refused while a verification runs ("nothing was deleted").
      verificationDeleteRefusalCopy(String(err.code), err.message);
    if (lifecycle !== null) {
      return {
        title: lifecycle.title,
        reason: err.message,
        action: lifecycle.action,
        tone: "attention",
        ...coreHints(err),
      };
    }
    const idem = idempotencyConflictKind(err);
    if (idem !== null) {
      const copy = idempotencyConflictCopy(idem);
      return {
        title: copy.title,
        reason: err.message,
        action: copy.action,
        tone: copy.nothingRan ? "attention" : "danger",
        ...coreHints(err),
      };
    }
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
  if (err.mayHaveBeenApplied) return unknownOutcomeCopy(err);
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
