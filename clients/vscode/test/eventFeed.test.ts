/**
 * Live updates + refusal recovery for the sidebar's event feed:
 *  - review bug 10 / backlog 6: `task.subscribe` is re-pulled on a timer, but
 *    only while the caller says polling is worthwhile (online + a non-terminal
 *    task); otherwise no timer is armed;
 *  - review bug 3: once Core refuses a project-wide replay as too large, the
 *    feed falls back to task-scoped pulls (one task per request) from each
 *    task's own cursor, instead of disabling catch-up for good.
 *
 * The stub below is a test double for Core's `task.subscribe` (the unit under
 * test is the subscription/feed logic), replaying with the service's rule.
 */

import { describe, expect, it } from 'vitest';
import { ProjectEventFeed, TaskSubscription, chooseFallbackTasks } from '../src/core-client/catchup';
import type { CoreCommands } from '../src/core-client/commands';
import type { TaskEvent } from '../src/core-client/events';
import { FakeTimers, flush } from './helpers/fakeCore';

function ev(taskId: string, sequence: number): TaskEvent {
  return { taskId, sequence, kind: 'status.changed', payload: { to: 'queued' }, timestamp: '2026-10-09T00:00:00Z' };
}

interface Call {
  taskId?: string;
  projectId?: string;
  afterSequence: number;
  afterSequences?: Record<string, number>;
}

class CoreStub {
  readonly calls: Call[] = [];
  readonly log = new Map<string, TaskEvent[]>();
  /** Project-wide (no taskId) replays are refused as over the frame ceiling. */
  refuseProjectWide = false;
  /** Task ids whose single-task replay is ALSO over the ceiling. */
  readonly refuseTasks = new Set<string>();

  seed(...events: TaskEvent[]): void {
    for (const e of events) this.log.set(e.taskId, [...(this.log.get(e.taskId) ?? []), e]);
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
    if ((!params.taskId && this.refuseProjectWide) || (params.taskId && this.refuseTasks.has(params.taskId))) {
      return Promise.reject(
        Object.assign(
          new Error('VALIDATION_FAILED: task.subscribe replay passed the 4161536-byte ceiling; narrow the request'),
          { code: 'VALIDATION_FAILED', name: 'CoreRpcError' },
        ),
      );
    }
    const targets = params.taskId
      ? [{ taskId: params.taskId, cursor: params.afterSequence }]
      : [...this.log.keys()].map((taskId) => ({
          taskId,
          cursor: params.afterSequences ? (params.afterSequences[taskId] ?? 0) : params.afterSequence,
        }));
    return Promise.resolve(
      targets.flatMap((t) => (this.log.get(t.taskId) ?? []).filter((e) => e.sequence > t.cursor)),
    );
  }

  asCommands(): CoreCommands {
    return this as unknown as CoreCommands;
  }
}

describe('TaskSubscription polling predicate (bug 10 / backlog 6)', () => {
  it('re-pulls on the interval while the predicate holds, and stops when it does not', async () => {
    const core = new CoreStub();
    core.seed(ev('t1', 1));
    const timers = new FakeTimers();
    let active = true;
    const applied: number[] = [];
    const sub = new TaskSubscription(core.asCommands(), {
      projectId: 'p1',
      pollIntervalMs: 2_000,
      schedule: timers.set,
      cancel: timers.clear,
      shouldPoll: () => active,
      onApplied: (events) => applied.push(...events.map((e) => e.sequence)),
    });
    await sub.start();
    expect(timers.pending.map((t) => t.ms)).toEqual([2_000]);

    core.seed(ev('t1', 2));
    timers.runNext();
    await flush();
    expect(applied).toEqual([1, 2]); // the poll delivered the new event
    expect(timers.pending).toHaveLength(1); // and re-armed

    active = false; // e.g. every task reached a terminal status
    timers.runNext();
    await flush();
    expect(timers.pending).toHaveLength(0); // no timer while there is nothing to watch

    active = true;
    sub.poke();
    expect(timers.pending).toHaveLength(1); // poke re-arms once activity resumes
    sub.poke();
    expect(timers.pending).toHaveLength(1); // and never double-arms
  });

  it('does not arm before start() and never after stop()', async () => {
    const core = new CoreStub();
    const timers = new FakeTimers();
    const sub = new TaskSubscription(core.asCommands(), {
      projectId: 'p1',
      pollIntervalMs: 1_000,
      schedule: timers.set,
      cancel: timers.clear,
      shouldPoll: () => true,
    });
    sub.poke();
    expect(timers.pending).toHaveLength(0);
    await sub.start();
    sub.stop();
    expect(timers.pending).toHaveLength(0);
    sub.poke();
    expect(timers.pending).toHaveLength(0);
  });
});

describe('ProjectEventFeed refusal fallback (bug 3)', () => {
  it('falls back to task-scoped pulls from each task cursor after a refused project replay', async () => {
    const core = new CoreStub();
    core.seed(ev('a', 1), ev('a', 2), ev('b', 1));
    const applied: string[] = [];
    const notices: string[] = [];
    const feed = new ProjectEventFeed(core.asCommands(), {
      projectId: 'p1',
      knownTaskIds: () => ['a', 'b'],
      onApplied: (events) => applied.push(...events.map((e) => `${e.taskId}:${e.sequence}`)),
      onFallback: (message) => notices.push(message),
    });
    await feed.catchUp();
    expect(applied).toEqual(['a:1', 'b:1', 'a:2']); // checkpoint applies a page in sequence order
    expect(feed.mode).toBe('project');

    // The project grows past one frame: Core refuses the project-wide replay.
    core.seed(ev('a', 3), ev('b', 2));
    core.refuseProjectWide = true;
    await feed.catchUp();
    expect(feed.mode).toBe('per_task');
    expect(notices).toHaveLength(1);
    // Each task resumed from ITS OWN cursor — nothing replayed twice, nothing skipped.
    expect([...applied].sort()).toEqual(['a:1', 'a:2', 'a:3', 'b:1', 'b:2']);
    const scoped = core.calls
      .filter((c) => c.taskId !== undefined)
      .sort((x, y) => (x.taskId ?? '').localeCompare(y.taskId ?? ''));
    expect(scoped).toEqual([
      { taskId: 'a', projectId: 'p1', afterSequence: 2 },
      { taskId: 'b', projectId: 'p1', afterSequence: 1 },
    ]);

    // Later pulls stay task-scoped (catch-up is NOT disabled).
    core.seed(ev('b', 3));
    await feed.catchUp();
    expect(applied[applied.length - 1]).toBe('b:3');
    expect(core.calls.filter((c) => c.taskId === undefined)).toHaveLength(2); // no more project-wide retries
  });

  it('picks up tasks that appear after the fallback started', async () => {
    const core = new CoreStub();
    core.refuseProjectWide = true;
    core.seed(ev('a', 1));
    let known = ['a'];
    const applied: string[] = [];
    const feed = new ProjectEventFeed(core.asCommands(), {
      projectId: 'p1',
      knownTaskIds: () => known,
      onApplied: (events) => applied.push(...events.map((e) => `${e.taskId}:${e.sequence}`)),
    });
    await feed.catchUp();
    expect(applied).toEqual(['a:1']);
    core.seed(ev('n', 1));
    known = ['a', 'n'];
    await feed.catchUp();
    expect(applied).toEqual(['a:1', 'n:1']);
  });

  it('reports a single task that is itself too large and keeps the others flowing', async () => {
    const core = new CoreStub();
    core.refuseProjectWide = true;
    core.refuseTasks.add('huge');
    core.seed(ev('huge', 1), ev('small', 1));
    const refused: string[] = [];
    const applied: string[] = [];
    const feed = new ProjectEventFeed(core.asCommands(), {
      projectId: 'p1',
      knownTaskIds: () => ['huge', 'small'],
      onApplied: (events) => applied.push(...events.map((e) => `${e.taskId}:${e.sequence}`)),
      onTaskReplayRefused: (taskId) => refused.push(taskId),
    });
    await feed.catchUp();
    expect(refused).toEqual(['huge']);
    expect(applied).toEqual(['small:1']);
  });

  it('bounds the number of task-scoped pulls and says how many were left out', async () => {
    const core = new CoreStub();
    core.refuseProjectWide = true;
    const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
    for (const id of ids) core.seed(ev(id, 1));
    const fallbacks: number[] = [];
    const feed = new ProjectEventFeed(core.asCommands(), {
      projectId: 'p1',
      knownTaskIds: () => ids,
      maxFallbackTasks: 4,
      onFallback: (_message, omitted) => fallbacks.push(omitted),
    });
    await feed.catchUp();
    expect(core.calls.filter((c) => c.taskId !== undefined)).toHaveLength(4);
    expect(fallbacks).toEqual([6]);
  });

  it('stop() ends every pull and timer', async () => {
    const core = new CoreStub();
    core.refuseProjectWide = true;
    core.seed(ev('a', 1));
    const timers = new FakeTimers();
    const feed = new ProjectEventFeed(core.asCommands(), {
      projectId: 'p1',
      knownTaskIds: () => ['a'],
      pollIntervalMs: 1_000,
      schedule: timers.set,
      cancel: timers.clear,
      shouldPoll: () => true,
    });
    await feed.start();
    expect(timers.pending.length).toBeGreaterThan(0);
    feed.stop();
    expect(timers.pending).toHaveLength(0);
    const before = core.calls.length;
    await feed.catchUp();
    expect(core.calls.length).toBe(before);
  });
});

describe('stop() during an in-flight pull (review W1)', () => {
  it('a response that lands after stop() is never applied', async () => {
    const core = new CoreStub();
    core.seed(ev('a', 1));
    const control = { release: (): void => undefined };
    const gate = new Promise<void>((resolve) => { control.release = resolve; });
    const original = core.taskSubscribe.bind(core);
    core.taskSubscribe = (params) => gate.then(() => original(params));
    const applied: string[] = [];
    const sub = new TaskSubscription(core.asCommands(), {
      projectId: 'p1',
      onApplied: (events) => applied.push(...events.map((e) => `${e.taskId}:${e.sequence}`)),
    });
    const pending = sub.catchUp();
    sub.stop(); // e.g. the user switched project while the pull was in flight
    control.release();
    expect(await pending).toBe(0);
    expect(applied).toEqual([]);
    expect(sub.checkpoint.afterSequence('a')).toBe(0);
  });
});

describe('fallback task choice (review W2)', () => {
  it('prefers non-terminal tasks, then the most recently active, over insertion order', () => {
    const info: Record<string, { active: boolean; lastActivity: number }> = {
      old_done: { active: false, lastActivity: 100 },
      old_active: { active: true, lastActivity: 1 },
      new_done: { active: false, lastActivity: 900 },
      newer_active: { active: true, lastActivity: 50 },
      never_seen: { active: true, lastActivity: Number.NEGATIVE_INFINITY },
    };
    const chosen = chooseFallbackTasks(
      ['old_done', 'old_active', 'new_done', 'newer_active', 'never_seen'],
      (id) => info[id] ?? { active: true, lastActivity: Number.NEGATIVE_INFINITY },
      3,
    );
    expect(chosen.chosen).toEqual(['newer_active', 'old_active', 'never_seen']);
    expect(chosen.omitted).toBe(2);
  });

  it('stops task subscriptions that drop out of the chosen set, and resumes them from their cursor', async () => {
    const core = new CoreStub();
    core.refuseProjectWide = true;
    core.seed(ev('a', 1), ev('b', 1));
    const active = new Set(['a']);
    const applied: string[] = [];
    const feed = new ProjectEventFeed(core.asCommands(), {
      projectId: 'p1',
      knownTaskIds: () => ['a', 'b'],
      rankTask: (id) => ({ active: active.has(id), lastActivity: 0 }),
      maxFallbackTasks: 1,
      onApplied: (events) => applied.push(...events.map((e) => `${e.taskId}:${e.sequence}`)),
    });
    await feed.catchUp();
    expect(applied).toEqual(['a:1']);
    expect(feed.followedTaskIds()).toEqual(['a']);

    // 'a' finishes, 'b' becomes active: 'a' is dropped, 'b' is followed.
    active.delete('a');
    active.add('b');
    await feed.catchUp();
    expect(feed.followedTaskIds()).toEqual(['b']);
    expect(applied).toEqual(['a:1', 'b:1']);

    // 'a' comes back: it resumes from ITS cursor (1), nothing is re-applied.
    core.seed(ev('a', 2));
    active.add('a');
    active.delete('b');
    await feed.catchUp();
    expect(applied).toEqual(['a:1', 'b:1', 'a:2']);
    const aCalls = core.calls.filter((c) => c.taskId === 'a').map((c) => c.afterSequence);
    expect(aCalls).toEqual([0, 1]);
  });
});
