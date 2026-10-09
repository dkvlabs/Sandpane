/**
 * Pure display logic. Nothing here decides a task lifecycle transition —
 * transitions are enforced in Core (`sandpane_core::task`) and this module only
 * renders the status Core reported (AGENTS.md §Code Review rule 3). Where the
 * spec calls a state that this build cannot observe, the function returns an
 * explicit `unknown`/`unprobed` shape instead of a guess.
 */

import type {
  AgentCapability,
  ApplyResult,
  ChangeSet,
  CoreCapabilities,
  ErrorCode,
  FileChangeStatus,
  TaskEvent,
  TaskStatus,
  WorkspaceMode,
} from "./protocol";
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

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && value in STATUS_VIEWS;
}

export function taskStatusView(status: unknown): StatusView {
  if (isTaskStatus(status)) return { status, ...STATUS_VIEWS[status] };
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

// ---------------------------------------------------------------------------
// Dashboard / status-bar aggregation
// ---------------------------------------------------------------------------

export interface TaskCounts {
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
        break;
      default:
        // "unknown" and any future wire status: counted in total only.
        break;
    }
  }
  return counts;
}

/**
 * Core exposes no `task.list` method, so the task index is derived from durable
 * events only (`task.created` + `status.changed`) — the projections this client
 * has actually folded. A task with no events folded in is simply absent; the UI
 * never shows a row it has no evidence for.
 */
export interface TaskIndexEntry {
  taskId: string;
  conversationId: string | null;
  status: TaskStatus | "unknown";
  lastSequence: number;
}

export function foldTaskIndex(
  projections: ReadonlyMap<string, TaskProjection>,
): TaskIndexEntry[] {
  const rows: TaskIndexEntry[] = [];
  for (const projection of projections.values()) {
    rows.push({
      taskId: projection.taskId,
      conversationId: projection.conversationId,
      status: projection.status ?? "unknown",
      lastSequence: projection.lastSequence,
    });
  }
  return rows.sort((a, b) => b.lastSequence - a.lastSequence);
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
  /** Current status as reported by Core (never computed by the UI). */
  status: TaskStatus | "unknown" | null;
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
    status: null,
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
      return withSequence(
        p,
        event,
        { status },
        { kind: "status", sequence, timestamp, status },
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

export function fileChangeLabel(status: FileChangeStatus): string {
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
    return {
      headline: "Applied",
      detail: `Core applied ${changeSet.changes.length} file(s) from ${shortHash(
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
  return {
    headline: `${changeSet.changes.length} file(s) changed`,
    detail: `Base ${shortHash(changeSet.baseCommit)}. Not applied to your working tree.${dirtyWarning}${
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
  if (err.isCoreError) {
    return { ...CORE_ERROR_COPY[err.code as ErrorCode], reason: err.message };
  }
  switch (err.code) {
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
