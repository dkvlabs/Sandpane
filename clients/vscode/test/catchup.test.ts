import { describe, expect, it } from 'vitest';
import { EventCheckpoint, TaskSubscription } from '../src/core-client/catchup';
import type { CoreCommands } from '../src/core-client/commands';
import type { TaskEvent } from '../src/core-client/events';

function event(taskId: string, sequence: number, kind = 'status.changed'): TaskEvent {
  return {
    taskId,
    sequence,
    kind,
    payload: kind === 'status.changed' ? { to: 'queued' } : { text: 'x' },
    timestamp: '2026-10-09T00:00:00Z',
  };
}

/** A subscription doubles as a fake Core: it records the requested checkpoint. */
class StubCommands {
  readonly calls: { afterSequence: number; taskId?: string; projectId?: string }[] = [];
  pages: TaskEvent[][] = [];
  delayMs = 0;

  constructor(private readonly onCall?: (n: number) => void) {}

  taskSubscribe(params: {
    afterSequence: number;
    taskId?: string | null;
    projectId?: string | null;
  }): Promise<TaskEvent[]> {
    this.calls.push({
      afterSequence: params.afterSequence,
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.projectId ? { projectId: params.projectId } : {}),
    });
    this.onCall?.(this.calls.length);
    const page = this.pages.shift() ?? [];
    if (this.delayMs > 0) {
      return new Promise((resolve) => setTimeout(() => resolve(page), this.delayMs));
    }
    return Promise.resolve(page);
  }

  asCommands(): CoreCommands {
    // Only taskSubscribe is exercised; the cast keeps the type honest elsewhere.
    return this as unknown as CoreCommands;
  }
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

  it('project-wide pulls replay from the floor and dedupe protects them', async () => {
    const commands = new StubCommands();
    const appliedBatches: number[] = [];
    const sub = new TaskSubscription(commands.asCommands(), {
      projectId: 'p1',
      onApplied: (batch) => appliedBatches.push(batch.length),
    });
    commands.pages = [
      [event('t1', 1), event('t2', 1)],
      [event('t1', 1), event('t1', 2), event('t2', 1)], // overlap on the next pull
    ];
    await sub.catchUp();
    await sub.catchUp();
    expect(commands.calls[0]).toEqual({ afterSequence: 0, projectId: 'p1' });
    // A single wire-level afterSequence cannot express per-task checkpoints, so
    // the project pull replays from the floor and the checkpoint drops repeats.
    expect(commands.calls[1]).toEqual({ afterSequence: 0, projectId: 'p1' });
    expect(appliedBatches).toEqual([2, 1]);
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
