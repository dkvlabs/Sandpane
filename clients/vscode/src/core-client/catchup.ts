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

  /**
   * Adopt a cursor learned elsewhere (e.g. the project-wide checkpoint when a
   * task-scoped pull takes over). Forward-only: never moves a cursor back.
   */
  seed(taskId: string, sequence: number): void {
    if (!Number.isFinite(sequence) || sequence < 1) return;
    if (sequence > (this.lastByTask.get(taskId) ?? 0)) this.lastByTask.set(taskId, sequence);
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
  /**
   * Checked every time the loop would arm. `false` leaves no timer armed (e.g.
   * offline, or every task is terminal); call `poke()` once it may be true
   * again. Absent = always poll while started.
   */
  shouldPoll?: () => boolean;
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
    if (
      interval <= 0 ||
      !this.started ||
      this.stopped ||
      this.timer !== undefined ||
      this.replayRefusalMessage !== null
    ) {
      return;
    }
    if (this.options.shouldPoll && !this.options.shouldPoll()) return;
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

  /**
   * Re-arm the poll if it is idle and the predicate now allows it — call after
   * anything that may make polling worthwhile again (reconnect, new task).
   */
  poke(): void {
    this.arm();
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
      // Stopped while the request was in flight (e.g. the user switched
      // project): the page belongs to a scope nobody displays any more. Never
      // apply it and never move the checkpoint (review W1).
      if (this.stopped) return 0;
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

/** How the fallback ranks a task: non-terminal first, then most recently active. */
export interface FallbackTaskRank {
  /** True while the task has no terminal status from Core (or none at all). */
  active: boolean;
  /** Epoch ms of the task's latest event; -Infinity when none was seen. */
  lastActivity: number;
}

/**
 * Pick the tasks the fallback follows (review W2): non-terminal tasks first,
 * then the most recently active; ties go to the task Core listed later.
 * Insertion order alone would follow the OLDEST tasks and drop live ones.
 */
export function chooseFallbackTasks(
  known: readonly string[],
  rank: (taskId: string) => FallbackTaskRank,
  max: number,
): { chosen: string[]; omitted: number } {
  const unique = [...new Set(known)];
  const ranked = unique.map((taskId, index) => ({ taskId, index, ...rank(taskId) }));
  ranked.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
    return b.index - a.index;
  });
  const limit = Math.max(1, Math.floor(max));
  return { chosen: ranked.slice(0, limit).map((r) => r.taskId), omitted: Math.max(0, unique.length - limit) };
}

export interface ProjectEventFeedOptions {
  projectId: string;
  /** Task ids Core reported for this project (task.list + replay), for the fallback. */
  knownTaskIds: () => readonly string[];
  /** Ranking for the fallback's bounded task choice; absent = all active, equal recency. */
  rankTask?: (taskId: string) => FallbackTaskRank;
  /** Per-task poll gate in fallback mode; absent = every known task. */
  isTaskActive?: (taskId: string) => boolean;
  pollIntervalMs?: number;
  schedule?: Schedule;
  cancel?: CancelSchedule;
  shouldPoll?: () => boolean;
  onApplied?: (events: TaskEvent[]) => void;
  onError?: (error: Error) => void;
  /**
   * Core refused the project-wide replay; the feed now pulls task by task.
   * `omitted` = known tasks not followed (beyond `maxFallbackTasks`, lowest
   * ranked: terminal first, then least recently active).
   */
  onFallback?: (message: string, omitted: number) => void;
  /** Even ONE task's replay is too large for a frame: that task is not pulled. */
  onTaskReplayRefused?: (taskId: string, message: string) => void;
  /** Upper bound on task-scoped subscriptions in fallback mode (default 64). */
  maxFallbackTasks?: number;
}

const DEFAULT_MAX_FALLBACK_TASKS = 64;

/**
 * The sidebar's project-scoped event feed (review bug 3).
 *
 * Normally one project-wide `task.subscribe` with per-task `afterSequences`.
 * When Core refuses that replay as too large for one frame, re-sending it can
 * never succeed — previously that latched catch-up OFF for the session. The
 * feed instead switches to task-scoped pulls (one `taskId` per request), each
 * resuming from the cursor the project checkpoint already reached, bounded to
 * `maxFallbackTasks` with the omission reported. A task whose own replay is
 * still too large is reported and skipped; the others keep flowing.
 */
export class ProjectEventFeed {
  private readonly project: TaskSubscription;
  private readonly perTask = new Map<string, TaskSubscription>();
  /** Cursors of task subscriptions that were dropped from the followed set. */
  private readonly droppedCursors = new Map<string, number>();
  private fallbackMessage: string | null = null;
  private lastOmitted = -1;
  private stopped = false;

  constructor(
    private readonly commands: CoreCommands,
    private readonly options: ProjectEventFeedOptions,
  ) {
    this.project = new TaskSubscription(commands, {
      projectId: options.projectId,
      ...this.pollOptions(options.shouldPoll),
      ...(options.onApplied ? { onApplied: options.onApplied } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
      onReplayRefused: (message) => {
        this.fallbackMessage = message;
        // Polls run this callback outside catchUp(): start the fallback here too.
        void this.runFallback().catch((error: unknown) => this.reportError(error));
      },
    });
  }

  get projectId(): string {
    return this.options.projectId;
  }

  /** Task ids currently followed in fallback mode (empty in project mode). */
  followedTaskIds(): string[] {
    return [...this.perTask.keys()];
  }

  get mode(): 'project' | 'per_task' {
    return this.fallbackMessage === null ? 'project' : 'per_task';
  }

  /** First replay, then arm polling (subject to `shouldPoll`). */
  async start(): Promise<number> {
    if (this.stopped) return 0;
    const applied = await this.project.start();
    return applied + (await this.runFallback());
  }

  /** One catch-up round in the current mode. */
  async catchUp(): Promise<number> {
    if (this.stopped) return 0;
    if (this.fallbackMessage === null) {
      const applied = await this.project.catchUp();
      if (this.fallbackMessage === null) return applied;
      return applied + (await this.runFallback());
    }
    return this.runFallback();
  }

  /** Re-arm idle polls (after reconnect / new activity). */
  poke(): void {
    if (this.stopped) return;
    if (this.fallbackMessage === null) {
      this.project.poke();
      return;
    }
    for (const sub of this.perTask.values()) sub.poke();
  }

  stop(): void {
    this.stopped = true;
    this.project.stop();
    for (const sub of this.perTask.values()) sub.stop();
    this.perTask.clear();
  }

  private pollOptions(shouldPoll: (() => boolean) | undefined): Partial<TaskSubscriptionOptions> {
    return {
      ...(this.options.pollIntervalMs !== undefined ? { pollIntervalMs: this.options.pollIntervalMs } : {}),
      ...(this.options.schedule ? { schedule: this.options.schedule } : {}),
      ...(this.options.cancel ? { cancel: this.options.cancel } : {}),
      ...(shouldPoll ? { shouldPoll } : {}),
    };
  }

  private fallbackRun: Promise<number> | null = null;

  /** Serialized: the refusal callback and catchUp() share one in-flight round. */
  private runFallback(): Promise<number> {
    if (this.fallbackMessage === null || this.stopped) return Promise.resolve(0);
    if (this.fallbackRun) return this.fallbackRun;
    const run = this.fallbackRound();
    this.fallbackRun = run;
    const clear = (): void => {
      if (this.fallbackRun === run) this.fallbackRun = null;
    };
    run.then(clear, clear);
    return run;
  }

  private async fallbackRound(): Promise<number> {
    if (this.fallbackMessage === null || this.stopped) return 0;
    const message = this.fallbackMessage;
    const { chosen, omitted } = chooseFallbackTasks(
      this.options.knownTaskIds(),
      this.options.rankTask ?? (() => ({ active: true, lastActivity: Number.NEGATIVE_INFINITY })),
      this.options.maxFallbackTasks ?? DEFAULT_MAX_FALLBACK_TASKS,
    );
    // Tasks that fell out of the followed set stop polling; their cursor is
    // kept so a later re-follow resumes instead of replaying from the start.
    const keep = new Set(chosen);
    for (const [taskId, sub] of [...this.perTask.entries()]) {
      if (keep.has(taskId)) continue;
      sub.stop();
      this.perTask.delete(taskId);
      this.droppedCursors.set(taskId, sub.checkpoint.afterSequence(taskId));
    }
    if (omitted !== this.lastOmitted) {
      this.lastOmitted = omitted;
      this.options.onFallback?.(message, omitted);
    }
    let applied = 0;
    for (const taskId of chosen) {
      if (this.stopped) break;
      let sub = this.perTask.get(taskId);
      const isNew = sub === undefined;
      if (!sub) {
        const gate = this.options.shouldPoll;
        const active = this.options.isTaskActive;
        sub = new TaskSubscription(this.commands, {
          projectId: this.options.projectId,
          taskId,
          ...this.pollOptions(() => (gate ? gate() : true) && (active ? active(taskId) : true)),
          ...(this.options.onApplied ? { onApplied: this.options.onApplied } : {}),
          ...(this.options.onError ? { onError: this.options.onError } : {}),
          onReplayRefused: (refusal) => this.options.onTaskReplayRefused?.(taskId, refusal),
        });
        // Resume exactly where the project-wide replay (or this task's own
        // earlier subscription) left it.
        sub.checkpoint.seed(taskId, this.project.checkpoint.afterSequence(taskId));
        sub.checkpoint.seed(taskId, this.droppedCursors.get(taskId) ?? 0);
        this.perTask.set(taskId, sub);
      }
      try {
        applied += isNew ? await sub.start() : await sub.catchUp();
      } catch (error) {
        this.reportError(error);
      }
    }
    return applied;
  }

  private reportError(error: unknown): void {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (this.options.onError) this.options.onError(wrapped);
    else console.warn(`[sandpane] task.subscribe pull failed: ${wrapped.message}`);
  }
}
