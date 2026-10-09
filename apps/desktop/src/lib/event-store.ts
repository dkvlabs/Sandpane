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
  emptyProjection,
  foldTaskEvents,
  markReplayGap,
  type TaskProjection,
} from "./reducers";
import type { TaskEvent } from "./protocol";

export interface TaskEventStoreOptions {
  /** Coalescing window for listener notification. */
  batchMs?: number;
  pollIntervalMs?: number;
}

export type StoreStatus =
  | { kind: "idle" }
  | { kind: "streaming" }
  | { kind: "degraded"; reason: string; attempt: number };

export class TaskEventStore {
  private readonly projections = new Map<string, TaskProjection>();
  private readonly listeners = new Set<() => void>();
  private snapshot: TaskProjection[] = [];
  private subscription: TaskSubscription | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private status: StoreStatus = { kind: "idle" };
  private readonly batchMs: number;
  private readonly pollIntervalMs: number | undefined;

  constructor(
    private readonly client: CoreClient,
    options: TaskEventStoreOptions = {},
  ) {
    this.batchMs = options.batchMs ?? 80;
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

  getStatus(): StoreStatus {
    return this.status;
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
    for (const event of events) {
      const current =
        this.projections.get(event.taskId) ?? emptyProjection(event.taskId);
      if (event.sequence <= current.lastSequence) continue;
      this.projections.set(event.taskId, foldTaskEvents(current, [event]));
      changed = true;
    }
    if (changed) {
      this.rebuildSnapshot();
      this.notifySoon();
    }
  }

  private applyGap(taskId: string, from: number, to: number): void {
    const current = this.projections.get(taskId) ?? emptyProjection(taskId);
    this.projections.set(taskId, markReplayGap(current, { from, to }));
    this.rebuildSnapshot();
    this.notifySoon();
  }

  private rebuildSnapshot(): void {
    this.snapshot = [...this.projections.values()].sort((a, b) =>
      b.lastSequence - a.lastSequence,
    );
  }

  /**
   * Coalesced notify, with an immediate flush when a batch carried a terminal
   * or attention state (the user must not wait 80 ms to learn a task failed).
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

  private setStatus(next: StoreStatus): void {
    this.status = next;
  }

  /** Test/diagnostic view of a single task projection. */
  peek(taskId: string): TaskProjection | undefined {
    return this.projections.get(taskId);
  }
}
