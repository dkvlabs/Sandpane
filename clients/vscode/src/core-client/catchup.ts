/**
 * Reconnect / catch-up logic over Core's durable, sequence-numbered task log.
 *
 * Reality of this build (core/crates/sandpane-service/src/lib.rs): the service
 * is strictly request/response — it writes exactly one frame per request and
 * never pushes. "Live" therefore means **pull `task.subscribe` again from the
 * checkpoint**, not a claimed push channel. The checkpoint makes every replay
 * idempotent: re-acknowledging an event we already applied is a no-op, so a
 * window reload cannot duplicate a running task (specs/03 §4 "Reconnection").
 */

import type { CoreCommands } from './commands';
import type { TaskEvent } from './events';

export interface CheckpointSnapshot {
  [taskId: string]: number;
}

/** Per-task highest acknowledged sequence. */
export class EventCheckpoint {
  private readonly lastByTask = new Map<string, number>();

  afterSequence(taskId: string): number {
    return this.lastByTask.get(taskId) ?? 0;
  }

  /** Smallest checkpoint across known tasks — a safe global `afterSequence`. */
  get globalAfterSequence(): number {
    if (this.lastByTask.size === 0) return 0;
    let min = Number.POSITIVE_INFINITY;
    for (const value of this.lastByTask.values()) min = Math.min(min, value);
    return min === Number.POSITIVE_INFINITY ? 0 : min;
  }

  /**
   * True when the event is newer than the checkpoint (and is therefore applied).
   * Duplicate or out-of-order replays return false — never re-applied.
   */
  accept(event: TaskEvent): boolean {
    if (!Number.isFinite(event.sequence) || event.sequence < 1) return false;
    const seen = this.lastByTask.get(event.taskId) ?? 0;
    if (event.sequence <= seen) return false;
    this.lastByTask.set(event.taskId, event.sequence);
    return true;
  }

  acceptAll(events: readonly TaskEvent[]): TaskEvent[] {
    const applied: TaskEvent[] = [];
    // Sort defensively: a replayed page must never move a checkpoint backwards.
    for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
      if (this.accept(event)) applied.push(event);
    }
    return applied;
  }

  forget(taskId: string): void {
    this.lastByTask.delete(taskId);
  }

  clear(): void {
    this.lastByTask.clear();
  }

  snapshot(): CheckpointSnapshot {
    return Object.fromEntries(this.lastByTask.entries());
  }
}

export type Schedule = (fn: () => void, ms: number) => unknown;
export type CancelSchedule = (handle: unknown) => void;

export interface TaskSubscriptionOptions {
  /** Narrow the replay to one project or one task (both are optional). */
  projectId?: string;
  taskId?: string;
  /** Where to start when nothing is acknowledged yet. Core replays strictly after it. */
  initialAfterSequence?: number;
  /** 0 disables the polling loop (manual `catchUp()` only). */
  pollIntervalMs?: number;
  schedule?: Schedule;
  cancel?: CancelSchedule;
  /** Observes every successfully applied batch (for the UI + logs). */
  onApplied?: (events: TaskEvent[]) => void;
  onError?: (error: Error) => void;
}

/**
 * Pull-based subscription. `TaskSubscription` never invents state: it hands the
 * events to the caller's reducer and only tracks sequences.
 */
export class TaskSubscription {
  readonly checkpoint = new EventCheckpoint();
  private timer: unknown = undefined;
  private inFlight: Promise<number> | null = null;
  private stopped = false;
  private started = false;

  constructor(
    private readonly commands: CoreCommands,
    private readonly options: TaskSubscriptionOptions = {},
  ) {}

  get isStarted(): boolean {
    return this.started && !this.stopped;
  }

  /** First replay from the checkpoint, then arm the poll if configured. */
  async start(): Promise<number> {
    if (this.stopped) return 0;
    this.started = true;
    const applied = await this.catchUp();
    this.arm();
    return applied;
  }

  private arm(): void {
    const interval = this.options.pollIntervalMs ?? 0;
    if (interval <= 0 || this.stopped || this.timer !== undefined) return;
    const schedule =
      this.options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
    this.timer = schedule(() => {
      this.timer = undefined;
      void this.catchUp().finally(() => this.arm());
    }, interval);
  }

  /**
   * Replay everything after the checkpoint. Serialized: overlapping calls share
   * one in-flight fetch, so a reconnect storm cannot double-apply a page.
   */
  catchUp(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    // A single `afterSequence` on the wire cannot express per-task checkpoints:
    // Core applies one number to every task it replays. So the precise value is
    // used only for a task-scoped subscription; a project-wide pull replays from
    // the configured floor and relies on the checkpoint to drop duplicates.
    // Cheaper-than-correct alternatives (global MIN) silently skip events of
    // newly created tasks, so they are not used.
    const afterSequence = this.options.taskId
      ? this.checkpoint.afterSequence(this.options.taskId)
      : (this.options.initialAfterSequence ?? 0);
    const run = (async (): Promise<number> => {
      const events = await this.commands.taskSubscribe({
        projectId: this.options.projectId ?? null,
        taskId: this.options.taskId ?? null,
        afterSequence,
      });
      const applied = this.checkpoint.acceptAll(Array.isArray(events) ? events : []);
      if (applied.length > 0) this.options.onApplied?.(applied);
      return applied.length;
    })();
    this.inFlight = run;
    return run.finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
  }

  /** Stop pulling. Detaching the UI — Core keeps its tasks running. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      const cancel = this.options.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
      cancel(this.timer);
      this.timer = undefined;
    }
  }
}
