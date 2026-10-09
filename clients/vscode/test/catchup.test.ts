import { describe, expect, it } from 'vitest';
import {
  EventCheckpoint,
  TaskSubscription,
  isOversizedReplayRefusal,
} from '../src/core-client/catchup';
import type { CoreCommands } from '../src/core-client/commands';
import type { TaskEvent } from '../src/core-client/events';
import { flush } from './helpers/fakeCore';

function event(taskId: string, sequence: number, kind = 'status.changed'): TaskEvent {
  return {
    taskId,
    sequence,
    kind,
    payload: kind === 'status.changed' ? { to: 'queued' } : { text: 'x' },
    timestamp: '2026-10-09T00:00:00Z',
  };
}

/**
 * A subscription doubles as a fake Core: it records the requested cursors and
 * replays with the SAME rule `sandpane-service` implements —
 *  * `taskId` set           → that task from the scalar (map ignored),
 *  * `taskId` absent + map  → each task from `afterSequences[taskId] ?? 0`,
 *  * `taskId` absent, no map→ every task from the shared scalar.
 * It is a test double for Core, not the unit under test (the subscription).
 */
class StubCommands {
  readonly calls: {
    afterSequence: number;
    taskId?: string;
    projectId?: string;
    afterSequences?: Record<string, number>;
  }[] = [];
  pages: TaskEvent[][] = [];
  delayMs = 0;
  /** When set, every call rejects with this error (a structured Core answer). */
  failWith: unknown = null;
  /** Core-side logs keyed by task, so replay is a real query, not a scripted page. */
  readonly log = new Map<string, TaskEvent[]>();

  constructor(private readonly onCall?: (n: number) => void) {}

  seed(events: TaskEvent[]): void {
    for (const e of events) {
      const list = this.log.get(e.taskId) ?? [];
      list.push(e);
      this.log.set(e.taskId, [...list].sort((a, b) => a.sequence - b.sequence));
    }
  }

  taskSubscribe(params: {
    afterSequence: number;
    taskId?: string | null;
    projectId?: string | null;
    afterSequences?: Record<string, number> | null;
  }): Promise<TaskEvent[]> {
    this.calls.push({
      afterSequence: params.afterSequence,
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.projectId ? { projectId: params.projectId } : {}),
      ...(params.afterSequences ? { afterSequences: params.afterSequences } : {}),
    });
    this.onCall?.(this.calls.length);
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.pages.length > 0) {
      const page = this.pages.shift() ?? [];
      if (this.delayMs > 0) {
        return new Promise((resolve) => setTimeout(() => resolve(page), this.delayMs));
      }
      return Promise.resolve(page);
    }
    const targets = params.taskId
      ? [{ taskId: params.taskId, cursor: params.afterSequence }]
      : [...this.log.keys()].map((taskId) => ({
          taskId,
          cursor: params.afterSequences
            ? Math.max(0, params.afterSequences[taskId] ?? 0)
            : params.afterSequence,
        }));
    const events = targets.flatMap((t) =>
      (this.log.get(t.taskId) ?? []).filter((e) => e.sequence > t.cursor),
    );
    return Promise.resolve(events.sort((a, b) =>
      a.taskId === b.taskId ? a.sequence - b.sequence : a.taskId.localeCompare(b.taskId),
    ));
  }

  asCommands(): CoreCommands {
    // Only taskSubscribe is exercised; the cast keeps the type honest elsewhere.
    return this as unknown as CoreCommands;
  }
}

/** The structured refusal Core answers for a replay that cannot fit one frame. */
function ceilingRefusal(): Error {
  return Object.assign(
    new Error(
      'VALIDATION_FAILED: replay of 2 task(s) passed the 4161536-byte ceiling this frame shape ' +
        'can carry (4161900 bytes so far); narrow the request (single taskId, a higher ' +
        'afterSequence, or per-task afterSequences) — task.subscribe has no truncation ' +
        'envelope yet (docs/specs/02 §2)',
    ),
    { code: 'VALIDATION_FAILED', name: 'CoreRpcError' },
  );
}

describe('EventCheckpoint (idempotent replay)', () => {
  it('accepts a strictly increasing sequence per task and drops duplicates', () => {
    const checkpoint = new EventCheckpoint();
    expect(checkpoint.accept(event('t1', 1))).toBe(true);
    expect(checkpoint.accept(event('t1', 2))).toBe(true);
    expect(checkpoint.accept(event('t1', 2))).toBe(false); // replay
    expect(checkpoint.accept(event('t1', 1))).toBe(false); // out of order
    expect(checkpoint.afterSequence('t1')).toBe(2);
    expect(checkpoint.accept(event('t2', 1))).toBe(true);
    expect(checkpoint.afterSequence('t2')).toBe(1);
    expect(checkpoint.snapshot()).toEqual({ t1: 2, t2: 1 });
  });

  it('rejects malformed sequences instead of poisoning the checkpoint', () => {
    const checkpoint = new EventCheckpoint();
    expect(checkpoint.accept(event('t1', 0))).toBe(false);
    expect(checkpoint.accept(event('t1', -3))).toBe(false);
    expect(checkpoint.accept(event('t1', Number.NaN))).toBe(false);
    expect(checkpoint.afterSequence('t1')).toBe(0);
  });

  it('sorts a shuffled page so a checkpoint never moves backwards', () => {
    const checkpoint = new EventCheckpoint();
    const applied = checkpoint.acceptAll([event('t1', 3), event('t1', 1), event('t1', 2)]);
    expect(applied.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(checkpoint.afterSequence('t1')).toBe(3);
    // A late redelivery of the whole page applies nothing.
    expect(checkpoint.acceptAll([event('t1', 2), event('t1', 3)])).toHaveLength(0);
  });

  it('tracks tasks independently', () => {
    const checkpoint = new EventCheckpoint();
    checkpoint.acceptAll([event('a', 5), event('b', 1)]);
    expect(checkpoint.globalAfterSequence).toBe(1);
    checkpoint.forget('a');
    expect(checkpoint.afterSequence('a')).toBe(0);
    checkpoint.clear();
    expect(checkpoint.snapshot()).toEqual({});
  });
});

describe('TaskSubscription resume', () => {
  it('asks Core only for what it has not acknowledged yet (task-scoped)', async () => {
    const commands = new StubCommands();
    commands.pages = [[event('t1', 1), event('t1', 2)]];
    const sub = new TaskSubscription(commands.asCommands(), { taskId: 't1' });
    await sub.catchUp();
    expect(commands.calls[0]).toEqual({ afterSequence: 0, taskId: 't1' });

    // Next pull resumes after the checkpoint, which is exactly the reload path.
    commands.pages = [[event('t1', 3)]];
    await sub.catchUp();
    expect(commands.calls[1]).toEqual({ afterSequence: 2, taskId: 't1' });
    expect(sub.checkpoint.afterSequence('t1')).toBe(3);
  });

  it('re-delivering a page applies nothing twice', async () => {
    const commands = new StubCommands();
    const applied: TaskEvent[][] = [];
    const sub = new TaskSubscription(commands.asCommands(), {
      taskId: 't1',
      onApplied: (batch) => applied.push(batch),
    });
    commands.pages = [[event('t1', 1), event('t1', 2)], [event('t1', 2), event('t1', 3)]];
    await sub.catchUp();
    await sub.catchUp();
    expect(applied.map((batch) => batch.map((e) => e.sequence))).toEqual([
      [1, 2],
      [3],
    ]);
  });

  it('a window reload resumes without duplicating the running task', async () => {
    const commands = new StubCommands();
    commands.pages = [[event('t1', 1), event('t1', 2)]];
    const beforeReload = new TaskSubscription(commands.asCommands(), { taskId: 't1' });
    await beforeReload.catchUp();
    const acknowledged = beforeReload.checkpoint.afterSequence('t1');
    expect(acknowledged).toBe(2);

    // After a reload the client resumes from that checkpoint. The request asks
    // for seq > 2; if Core redelivered 2 anyway, the restored checkpoint drops
    // it — the task is never painted twice (specs/03 §4).
    const restored = new EventCheckpoint();
    restored.acceptAll([event('t1', 1), event('t1', 2)]);
    const afterReload = new TaskSubscription(commands.asCommands(), {
      taskId: 't1',
      initialAfterSequence: restored.afterSequence('t1'),
    });
    afterReload.checkpoint.acceptAll([event('t1', 1), event('t1', 2)]); // restored state

    commands.pages = [[event('t1', 2), event('t1', 3)]];
    const applied: number[] = [];
    afterReload.checkpoint
      .acceptAll(commands.pages[0] ?? [])
      .forEach((e) => applied.push(e.sequence));
    expect(applied).toEqual([3]);
    expect(afterReload.checkpoint.afterSequence('t1')).toBe(3);
    expect(afterReload.checkpoint.snapshot()).toEqual({ t1: 3 });
  });

  it('project-wide pulls resume EACH task from its own cursor (the fixed v1 gap)', async () => {
    // Uneven event counts: t1 is far ahead of t2. With one shared scalar, a
    // resume at t1's cursor would skip EVERY unseen t2 event — the defect this
    // protocol revision exists to fix.
    const commands = new StubCommands();
    commands.seed([
      event('t1', 1),
      event('t1', 2),
      event('t1', 3),
      event('t1', 4),
      event('t1', 5),
      event('t2', 1),
      event('t2', 2),
    ]);
    const appliedBatches: number[] = [];
    const sub = new TaskSubscription(commands.asCommands(), {
      projectId: 'p1',
      onApplied: (batch) => appliedBatches.push(batch.length),
    });

    // First pull: nothing acknowledged, so no map is sent and everything replays.
    expect(await sub.catchUp()).toBe(7);
    expect(commands.calls[0]).toEqual({ afterSequence: 0, projectId: 'p1' });
    expect(sub.checkpoint.snapshot()).toEqual({ t1: 5, t2: 2 });

    // Core appends one more event to the BEHIND task only.
    commands.seed([event('t2', 3)]);
    expect(await sub.catchUp()).toBe(1);
    // The second pull carries per-task cursors, so t2's unseen seq 3 arrives even
    // though t1 is already at 5.
    expect(commands.calls[1]).toEqual({
      afterSequence: 0,
      projectId: 'p1',
      afterSequences: { t1: 5, t2: 2 },
    });
    expect(appliedBatches).toEqual([7, 1]);
    expect(sub.checkpoint.snapshot()).toEqual({ t1: 5, t2: 3 });

    // Nothing new ⇒ an empty replay, and the checkpoint does not move.
    expect(await sub.catchUp()).toBe(0);
  });

  it('a shared scalar would have skipped the behind task — proving the map matters', async () => {
    // Same log, but the legacy request shape (scalar 5, no map): t2's events all
    // have sequence <= 5 and are lost. This is the recorded v1 behaviour, kept
    // here so the fix is measured against it rather than asserted in prose.
    const commands = new StubCommands();
    commands.seed([event('t1', 1), event('t1', 5), event('t2', 1), event('t2', 2)]);
    const legacy = await commands.taskSubscribe({ afterSequence: 5, projectId: 'p1' });
    expect(legacy).toHaveLength(0);
    const mapped = await commands.taskSubscribe({
      afterSequence: 5,
      projectId: 'p1',
      afterSequences: { t1: 5, t2: 0 },
    });
    expect(mapped.map((e) => `${e.taskId}:${e.sequence}`)).toEqual(['t2:1', 't2:2']);
  });

  it('a task absent from the map replays in full, exactly as Core defines it', async () => {
    const commands = new StubCommands();
    commands.seed([event('t1', 1), event('t1', 2), event('new', 1)]);
    const sub = new TaskSubscription(commands.asCommands(), { projectId: 'p1' });
    sub.checkpoint.acceptAll([event('t1', 1), event('t1', 2)]);
    const applied = await sub.catchUp();
    expect(commands.calls[0]?.afterSequences).toEqual({ t1: 2 });
    // `new` is not in the map → cursor 0 → its full history arrives (nothing skipped).
    expect(applied).toBe(1);
    expect(sub.checkpoint.afterSequence('new')).toBe(1);
  });

  it('bounds the cursor map instead of sending an unbounded one', () => {
    const checkpoint = new EventCheckpoint();
    for (let i = 1; i <= 10; i += 1) checkpoint.accept(event(`t${i}`, i));
    const within = checkpoint.snapshotCursors(16);
    expect(within.omitted).toBe(0);
    expect(Object.keys(within.cursors)).toHaveLength(10);

    const trimmed = checkpoint.snapshotCursors(4);
    expect(Object.keys(trimmed.cursors)).toEqual(['t7', 't8', 't9', 't10']);
    expect(trimmed.omitted).toBe(6);
    // Omitted ⇒ Core replays those from 0, which the checkpoint then de-dupes;
    // nothing is silently dropped from the wire.
    expect(checkpoint.snapshotCursors().cursors).toEqual(checkpoint.snapshot());
  });

  it('an oversized-replay refusal stops the poll loop instead of retrying it', async () => {
    const commands = new StubCommands();
    const refused: string[] = [];
    const scheduled: (() => void)[] = [];
    const sub = new TaskSubscription(commands.asCommands(), {
      projectId: 'p1',
      pollIntervalMs: 1_000,
      onReplayRefused: (message) => refused.push(message),
      schedule: (fn) => {
        scheduled.push(fn);
        return fn;
      },
      cancel: (handle) => {
        const idx = scheduled.indexOf(handle as () => void);
        if (idx >= 0) scheduled.splice(idx, 1);
      },
    });
    commands.failWith = ceilingRefusal();

    expect(await sub.start()).toBe(0);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('ceiling');
    expect(sub.replayRefused).toContain('task.subscribe has no truncation envelope yet');
    // No timer was armed: a retry of this request can never fit a frame.
    expect(scheduled).toHaveLength(0);

    // A manual pull while refused issues nothing at all (no tight loop).
    const before = commands.calls.length;
    expect(await sub.catchUp()).toBe(0);
    expect(commands.calls).toHaveLength(before);

    // Narrowing the request re-arms it.
    commands.failWith = null;
    commands.seed([event('t1', 1)]);
    sub.clearReplayRefusal();
    expect(sub.replayRefused).toBeNull();
    expect(scheduled).toHaveLength(1);
    expect(await sub.catchUp()).toBe(1);
    sub.stop();
  });

  it('classifies only the ceiling refusal, not every VALIDATION_FAILED', () => {
    expect(isOversizedReplayRefusal(ceilingRefusal())).toBe(true);
    const other = Object.assign(new Error('VALIDATION_FAILED: projectId: value is empty'), {
      code: 'VALIDATION_FAILED',
    });
    expect(isOversizedReplayRefusal(other)).toBe(false);
    expect(isOversizedReplayRefusal(new Error('boom'))).toBe(false);
    expect(isOversizedReplayRefusal(null)).toBe(false);
  });

  it('an ordinary replay error still propagates to the caller (never swallowed)', async () => {
    const commands = new StubCommands();
    const sub = new TaskSubscription(commands.asCommands(), { projectId: 'p1' });
    commands.failWith = Object.assign(new Error('NOT_FOUND: no such project'), { code: 'NOT_FOUND' });
    await expect(sub.catchUp()).rejects.toThrow(/NOT_FOUND/);
    expect(sub.replayRefused).toBeNull();
  });

  it('a poll-tick failure is reported through onError and the loop continues', async () => {
    const commands = new StubCommands();
    const errors: string[] = [];
    const scheduled: (() => void)[] = [];
    const sub = new TaskSubscription(commands.asCommands(), {
      projectId: 'p1',
      pollIntervalMs: 1_000,
      onError: (error) => errors.push(error.message),
      schedule: (fn) => {
        scheduled.push(fn);
        return fn;
      },
      cancel: (handle) => {
        const idx = scheduled.indexOf(handle as () => void);
        if (idx >= 0) scheduled.splice(idx, 1);
      },
    });
    commands.pages = [[event('t1', 1)]];
    await sub.start();
    expect(scheduled).toHaveLength(1);

    // The next tick fails with an ordinary structured error.
    commands.failWith = Object.assign(new Error('DAEMON_DOWN: sbx daemon not answering'), {
      code: 'DAEMON_DOWN',
    });
    commands.pages = [];
    scheduled[0]?.();
    await flush(); // let the rejected promise settle through the .catch/.finally chain
    expect(errors).toEqual(['DAEMON_DOWN: sbx daemon not answering']);
    // A transient error keeps polling (unlike an undeliverable replay).
    expect(scheduled).toHaveLength(2);
    expect(sub.replayRefused).toBeNull();
    sub.stop();
  });

  it('concurrent pulls share one in-flight request', async () => {
    const commands = new StubCommands();
    commands.delayMs = 5;
    commands.pages = [[event('t1', 1)]];
    const sub = new TaskSubscription(commands.asCommands(), { taskId: 't1' });
    const [a, b] = await Promise.all([sub.catchUp(), sub.catchUp()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(commands.calls).toHaveLength(1);
  });

  it('stop() ends the pull loop and never cancels anything', async () => {
    const commands = new StubCommands();
    const scheduled: (() => void)[] = [];
    const sub = new TaskSubscription(commands.asCommands(), {
      taskId: 't1',
      pollIntervalMs: 1_000,
      schedule: (fn) => {
        scheduled.push(fn);
        return fn;
      },
      cancel: (handle) => {
        const idx = scheduled.indexOf(handle as () => void);
        if (idx >= 0) scheduled.splice(idx, 1);
      },
    });
    commands.pages = [[event('t1', 1)]];
    await sub.start();
    expect(sub.isStarted).toBe(true);
    expect(scheduled).toHaveLength(1);
    sub.stop();
    expect(sub.isStarted).toBe(false);
    expect(scheduled).toHaveLength(0);
    expect(commands.calls).toHaveLength(1); // only the initial replay happened
  });
});
