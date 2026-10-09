/**
 * Holds folded task-event projections and notifies React in batches.
 *
 * Why this exists separately from React Query: task events are a durable,
 * replayable stream keyed by per-task sequence, not a request/response cache.
 * One `task.subscribe` pass at a time owns the stream (specs/05 §11), replay is
 * idempotent, and DOM-affecting notifications are coalesced every ~80 ms so a
 * fast `message.delta` stream cannot re-render the chat per token.
 */

import { CoreClient, TaskSubscription } from "./core-client";
import {
  compareProjectionsByActivity,
  emptyProjection,
  foldTaskEvents,
  markReplayGap,
  taskStatusView,
  type TaskProjection,
} from "./reducers";
import { EVENT_BATCH_MS_MAX, EVENT_BATCH_MS_MIN } from "../stores/ui";
import type { TaskEvent } from "./protocol";

export interface TaskEventStoreOptions {
  /** Coalescing window for listener notification. */
  batchMs?: number;
  pollIntervalMs?: number;
}

export type StoreStatus =
  | { kind: "idle" }
  | { kind: "streaming" }
  | { kind: "degraded"; reason: string; attempt: number }
  /**
   * Core refused the scope-wide replay as too large for one frame. Polling is
   * PAUSED, not failed: the same request can never succeed, so the store waits
   * for a narrower request instead of retrying (no retry storm).
   */
  | { kind: "refused"; reason: string };

export class TaskEventStore {
  private readonly projections = new Map<string, TaskProjection>();
  private readonly listeners = new Set<() => void>();
  private snapshot: TaskProjection[] = [];
  private subscription: TaskSubscription | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private status: StoreStatus = { kind: "idle" };
  private batchMs: number;
  private readonly pollIntervalMs: number | undefined;

  constructor(
    private readonly client: CoreClient,
    options: TaskEventStoreOptions = {},
  ) {
    this.batchMs = clampBatchMs(options.batchMs ?? 80);
    this.pollIntervalMs = options.pollIntervalMs;
  }

  /** Attach the single global replay stream. Idempotent. */
  start(): void {
    if (this.subscription) return;
    this.subscription = this.client.subscribeTasks({
      ...(this.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: this.pollIntervalMs }),
      afterSequence: 0,
      onEvents: (events) => this.applyEvents(events),
      onGap: (info) => this.applyGap(info.taskId, info.from, info.to),
      onReplayRefused: (reason) => {
        this.setStatus({ kind: "refused", reason });
        this.notifySoon();
      },
      onError: (err) => {
        this.setStatus({
          kind: "degraded",
          reason: err.message,
          attempt: this.subscription?.state.kind === "backoff"
            ? this.subscription.state.attempt
            : 1,
        });
        this.notifySoon();
      },
      onState: (state) => {
        if (state.kind === "polling") this.setStatus({ kind: "streaming" });
        else if (state.kind === "stopped") this.setStatus({ kind: "idle" });
        else if (state.kind === "refused") this.setStatus({ kind: "refused", reason: state.reason });
      },
    });
  }

  stop(): void {
    this.subscription?.stop();
    this.subscription = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.setStatus({ kind: "idle" });
  }

  /** Reattach after a transport drop: resumes from held checkpoints. */
  resume(): void {
    this.subscription?.resume();
  }

  /**
   * Stable reference until the status structurally changes, so it can be a
   * `useSyncExternalStore` snapshot (arrow: passed unbound to React).
   */
  getStatus = (): StoreStatus => this.status;

  /** The coalescing window, driven live by the UI preference (clamped 16–500 ms). */
  get batchWindowMs(): number {
    return this.batchMs;
  }

  setBatchMs(ms: number): void {
    this.batchMs = clampBatchMs(ms);
  }

  /** Sequence checkpoint per task, for status copy and reconnect assertions. */
  checkpoint(taskId: string): number {
    return this.projections.get(taskId)?.lastSequence ?? 0;
  }

  // -- external store contract ---------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): TaskProjection[] => this.snapshot;

  /** Latest replayed event count, exposed for tests and diagnostics copy. */
  get foldedEventCount(): number {
    let total = 0;
    for (const p of this.projections.values()) total += p.entries.length;
    return total;
  }

  // -- folding --------------------------------------------------------------

  /**
   * Apply a replay batch. Safe to call with overlapping batches: any sequence
   * already folded for that task is ignored, so a reconnect that re-delivers a
   * boundary event cannot duplicate a transcript line.
   */
  applyEvents(events: readonly TaskEvent[]): void {
    if (events.length === 0) return;
    let changed = false;
    let needsAttention = false;
    for (const event of events) {
      const current =
        this.projections.get(event.taskId) ?? emptyProjection(event.taskId);
      if (event.sequence <= current.lastSequence) continue;
      const next = foldTaskEvents(current, [event]);
      this.projections.set(event.taskId, next);
      changed = true;
      if (isAttentionEvent(current, next)) needsAttention = true;
    }
    if (changed) {
      this.rebuildSnapshot();
      if (needsAttention) this.flushNow();
      else this.notifySoon();
    }
  }

  private applyGap(taskId: string, from: number, to: number): void {
    const current = this.projections.get(taskId) ?? emptyProjection(taskId);
    this.projections.set(taskId, markReplayGap(current, { from, to }));
    this.rebuildSnapshot();
    this.notifySoon();
  }

  private rebuildSnapshot(): void {
    // Per-task sequences are not comparable across tasks; order by activity.
    this.snapshot = [...this.projections.values()].sort(compareProjectionsByActivity);
  }

  /**
   * Coalesced notify. `applyEvents` bypasses it with `flushNow` when a batch
   * carried a terminal or attention state (the user must not wait for the
   * window to learn a task failed or needs review/input/approval).
   */
  private notifySoon(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.batchMs);
  }

  flush(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /** Replace the status only on a structural change, and notify when it does. */
  private setStatus(next: StoreStatus): void {
    if (sameStatus(this.status, next)) return;
    this.status = next;
    this.notifySoon();
  }

  /** Test/diagnostic view of a single task projection. */
  peek(taskId: string): TaskProjection | undefined {
    return this.projections.get(taskId);
  }
}

function clampBatchMs(ms: number): number {
  if (!Number.isFinite(ms)) return 80;
  return Math.min(EVENT_BATCH_MS_MAX, Math.max(EVENT_BATCH_MS_MIN, Math.round(ms)));
}

function sameStatus(a: StoreStatus, b: StoreStatus): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "degraded":
      return b.kind === "degraded" && a.reason === b.reason && a.attempt === b.attempt;
    case "refused":
      return b.kind === "refused" && a.reason === b.reason;
    default:
      return true;
  }
}

/**
 * A fold that the user must see at once: the task reached a terminal status or
 * one that waits on them, or Core asked for an approval.
 */
function isAttentionEvent(before: TaskProjection, after: TaskProjection): boolean {
  if (after.pendingApprovals.length > before.pendingApprovals.length) return true;
  if (after.status === before.status || after.status === null || after.status === "unknown") {
    return false;
  }
  const view = taskStatusView(after.status);
  return view.terminal || view.needsReview || after.status === "awaiting_input";
}
