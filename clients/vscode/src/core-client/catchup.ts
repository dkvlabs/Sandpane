/**
 * Reconnect / catch-up logic over Core's durable, sequence-numbered task log.
 *
 * Reality of this build (core/crates/sandpane-service/src/lib.rs): the service
 * is strictly request/response — it writes exactly one frame per request and
 * never pushes. "Live" therefore means **pull `task.subscribe` again from the
 * checkpoint**, not a claimed push channel. The checkpoint makes every replay
 * idempotent: re-acknowledging an event we already applied is a no-op, so a
 * window reload cannot duplicate a running task (specs/03 §4 "Reconnection").
 *
 * Per-task cursors: since the protocol-v1 revision, `task.subscribe` accepts an
 * `afterSequences` map so a project-wide replay resumes EACH task from its own
 * checkpoint. Before that, one shared scalar could only ever express one task's
 * cursor and silently skipped the unseen events of every task behind it (the
 * recorded v1 gap in docs/compatibility.md). A subscription with no checkpoint
 * yet still sends the legacy scalar.
 */

import { errorCodeOf } from './commands';
import type { CoreCommands } from './commands';
import type { TaskEvent } from './events';
import { MAX_SUBSCRIBE_CURSORS } from './protocol';

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

  /**
   * The `afterSequences` map for a project-wide replay, bounded to Core's
   * `MAX_SUBSCRIBE_CURSORS` entries.
   *
   * When the checkpoint is larger than the bound, the OLDEST entries are the
   * ones left out — and a task missing from the map replays **in full** (cursor
   * 0), which is the safe direction: nothing is skipped, the checkpoint simply
   * re-drops the redelivery. `omitted` reports that count so the caller can say
   * so instead of hiding it.
   */
  snapshotCursors(
    max: number = MAX_SUBSCRIBE_CURSORS,
  ): { cursors: CheckpointSnapshot; omitted: number } {
    const entries = [...this.lastByTask.entries()];
    if (entries.length <= max) {
      return { cursors: Object.fromEntries(entries), omitted: 0 };
    }
    const kept = entries.slice(entries.length - max);
    return { cursors: Object.fromEntries(kept), omitted: entries.length - kept.length };
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
  /**
   * Fires when Core refuses a replay as too large to fit one IPC frame. The
   * message is Core's verbatim guidance; the subscription then STOPS pulling so
   * a poll loop cannot retry a request that can never succeed. Call
   * `clearReplayRefusal()` after narrowing the request (single `taskId`, higher
   * cursor, or a smaller project) to resume.
   */
  onReplayRefused?: (message: string) => void;
}

/**
 * Core's refusal of an undeliverable replay (protocol-v1 revision):
 * `task.subscribe` answers `VALIDATION_FAILED` naming a byte ceiling instead of
 * emitting a frame both ends of the transport would reject. Detection is
 * deliberately conservative — an unrecognised `VALIDATION_FAILED` is reported as
 * an ordinary error, it does not latch the loop off.
 */
export function isOversizedReplayRefusal(error: unknown): boolean {
  if (errorCodeOf(error) !== 'VALIDATION_FAILED') return false;
  const message = error instanceof Error ? error.message : String(error);
  return /task\.subscribe/i.test(message) && /ceiling/i.test(message);
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
  private replayRefusalMessage: string | null = null;

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
    // A refused replay is not a transient failure: re-sending the same request
    // can never fit a frame, so the loop stops rather than hammering Core.
    if (interval <= 0 || this.stopped || this.timer !== undefined || this.replayRefusalMessage !== null) {
      return;
    }
    const schedule =
      this.options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
    this.timer = schedule(() => {
      this.timer = undefined;
      const page = this.catchUp();
      // A poll failure must never surface as an unhandled rejection, and it must
      // never vanish either: give it to the caller's handler, or log it. The
      // loop keeps polling because this kind of error can be transient.
      const settled = page.catch((error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        if (this.options.onError) this.options.onError(wrapped);
        else console.warn(`[sandpane] task.subscribe pull failed: ${wrapped.message}`);
      });
      void settled.finally(() => this.arm());
    }, interval);
  }

  /** Core's verbatim refusal text when the last replay was too large; else null. */
  get replayRefused(): string | null {
    return this.replayRefusalMessage;
  }

  /**
   * Re-arm after the caller has narrowed the request (smaller project, single
   * taskId, or a higher cursor). Nothing is fetched until the next `catchUp()`.
   */
  clearReplayRefusal(): void {
    this.replayRefusalMessage = null;
    this.arm();
  }

  /**
   * Replay everything after the checkpoint. Serialized: overlapping calls share
   * one in-flight fetch, so a reconnect storm cannot double-apply a page.
   */
  catchUp(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    if (this.replayRefusalMessage !== null) return Promise.resolve(0);
    // A task-scoped pull resumes from that task's own scalar cursor. A
    // project-wide pull resumes every task from its OWN cursor via
    // `afterSequences` — the semantics Core defines for it. With nothing
    // acknowledged yet there is no map to send, so the legacy shared scalar
    // (the configured floor) applies unchanged.
    const cursors = this.options.taskId
      ? undefined
      : this.checkpoint.snapshotCursors().cursors;
    const hasCursors = cursors !== undefined && Object.keys(cursors).length > 0;
    const afterSequence = this.options.taskId
      ? this.checkpoint.afterSequence(this.options.taskId)
      : (this.options.initialAfterSequence ?? 0);
    const run = (async (): Promise<number> => {
      let events: TaskEvent[];
      try {
        events = await this.commands.taskSubscribe({
          projectId: this.options.projectId ?? null,
          taskId: this.options.taskId ?? null,
          afterSequence,
          ...(hasCursors ? { afterSequences: cursors } : {}),
        });
      } catch (error) {
        if (isOversizedReplayRefusal(error)) {
          const message = error instanceof Error ? error.message : String(error);
          this.replayRefusalMessage = message;
          this.options.onReplayRefused?.(message);
          // Counted as a handled failure, not re-thrown into an onError storm.
          return 0;
        }
        throw error;
      }
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
