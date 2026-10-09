import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  reduceTaskView,
  selectTask,
  selectTasks,
} from '../src/state/reducer';
import type { TaskEvent } from '../src/core-client/events';
import { isTerminalStatus, normalizeAgentEvent, TASK_STATUSES } from '../src/core-client/events';

function ev(taskId: string, sequence: number, kind: string, payload: unknown): TaskEvent {
  return { taskId, sequence, kind, payload, timestamp: '2026-10-09T00:00:00Z' };
}

describe('task-status reducer is display-only', () => {
  it('starts with no status: nothing is invented before Core speaks', () => {
    const state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskEvent',
      event: ev('t1', 1, 'task.created', { conversationId: 'c1' }),
    });
    const task = selectTask(state, 't1');
    expect(task?.status).toBeNull();
    expect(task?.conversationId).toBe('c1');
  });

  it('applies exactly the statuses Core emitted, in order', () => {
    let state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskEvents',
      events: [
        ev('t1', 1, 'task.created', { conversationId: 'c1' }),
        ev('t1', 2, 'status.changed', { to: 'queued' }),
        ev('t1', 3, 'status.changed', { to: 'preparing' }),
        ev('t1', 4, 'status.changed', { to: 'running' }),
      ],
    });
    expect(selectTask(state, 't1')?.status).toBe('running');
    expect(selectTask(state, 't1')?.statusSequence).toBe(4);

    // Core is the only place transitions are decided: an illegal-looking jump is
    // still just displayed, never repaired or refused client-side.
    state = reduceTaskView(state, {
      kind: 'taskEvent',
      event: ev('t1', 5, 'status.changed', { to: 'awaiting_review' }),
    });
    expect(selectTask(state, 't1')?.status).toBe('awaiting_review');
  });

  it('never maps a provider completion flag into a Core status', () => {
    const state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskEvents',
      events: [
        ev('t1', 1, 'status.changed', { to: 'running' }),
        ev('t1', 2, 'task.completed', { type: 'task.completed', ok: true }),
      ],
    });
    const task = selectTask(state, 't1');
    expect(task?.status).toBe('running'); // NOT "completed"
    expect(task?.completedOk).toBe(true);
    expect(task?.lines.some((l) => l.text.includes('awaiting Core status'))).toBe(true);
  });

  it('an unknown status value is surfaced, and the previous status is kept', () => {
    const state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskEvents',
      events: [
        ev('t1', 1, 'status.changed', { to: 'running' }),
        ev('t1', 2, 'status.changed', { to: 'half_finished' }),
      ],
    });
    const task = selectTask(state, 't1');
    expect(task?.status).toBe('running');
    expect(task?.unknownKinds).toContain('status:half_finished');
    expect(task?.lines.at(-1)?.unsupported).toBe(true);
  });

  it('an unknown event kind is recorded, not swallowed', () => {
    const state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskEvent',
      event: ev('t1', 7, 'quantum.progress', { anything: 1 }),
    });
    const task = selectTask(state, 't1');
    expect(task?.unknownKinds).toEqual(['quantum.progress']);
    expect(task?.lines[0]?.text).toContain('unrecognized Core event kind "quantum.progress"');
    expect(task?.status).toBeNull();
  });

  it('ignores a stale redelivery of an older sequence', () => {
    let state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskEvents',
      events: [
        ev('t1', 1, 'status.changed', { to: 'running' }),
        ev('t1', 2, 'status.changed', { to: 'verifying' }),
      ],
    });
    const before = state;
    state = reduceTaskView(state, {
      kind: 'taskEvent',
      event: ev('t1', 1, 'status.changed', { to: 'created' }),
    });
    expect(state).toBe(before);
    expect(selectTask(state, 't1')?.status).toBe('verifying');
  });

  it('renders tool activity and file changes from agent events', () => {
    const state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskEvents',
      events: [
        ev('t1', 1, 'tool.started', { type: 'tool.started', name: 'read_file', id: 'tool-1' }),
        ev('t1', 2, 'tool.finished', { type: 'tool.finished', id: 'tool-1', ok: false, summary: 'denied' }),
        ev('t1', 3, 'file.changed', { type: 'file.changed', path: 'src/auth.ts' }),
        ev('t1', 4, 'file.changed', { type: 'file.changed', path: 'src/auth.ts' }),
      ],
    });
    const task = selectTask(state, 't1');
    expect(task?.tools).toEqual([
      { id: 'tool-1', name: 'read_file', state: 'finished_failed', summary: 'denied' },
    ]);
    expect(task?.files).toEqual(['src/auth.ts']);
  });

  it('an approval request states the protocol gap instead of pretending to answer', () => {
    const state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskEvent',
      event: ev('t1', 1, 'approval.required', {
        type: 'approval.required',
        requestId: 'a-1',
        description: 'run cargo test',
      }),
    });
    const line = selectTask(state, 't1')?.lines[0];
    expect(line?.needsAnswer).toBe(true);
    expect(line?.text).toContain('no method to answer it');
  });

  it('a scheduler deferral keeps the task queued and says why', () => {
    const state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskEvents',
      events: [
        ev('t1', 1, 'status.changed', { to: 'queued' }),
        ev('t1', 2, 'scheduler.deferred', { reason: 'workspace busy' }),
      ],
    });
    const task = selectTask(state, 't1');
    expect(task?.status).toBe('queued');
    expect(task?.lines.at(-1)?.text).toContain('workspace busy');
  });

  it('a Core-supplied TaskSummary is displayed verbatim', () => {
    const state = reduceTaskView(EMPTY_STATE, {
      kind: 'taskSummary',
      summary: {
        id: 't9',
        conversationId: 'c9',
        status: 'queued',
        sandboxName: 'auth-codex',
        taskBranch: 'sandpane/t9',
        baseCommit: 'deadbeefcafe',
      },
    });
    expect(selectTask(state, 't9')).toMatchObject({
      status: 'queued',
      sandboxName: 'auth-codex',
      taskBranch: 'sandpane/t9',
      baseCommit: 'deadbeefcafe',
    });
    // A later event with a lower sequence still cannot overwrite by luck: the
    // summary path does not touch lastSequence, replay guard applies to events.
  });

  it('keeps tasks in insertion order and supports reset', () => {
    let state = reduceTaskView(EMPTY_STATE, { kind: 'taskEvent', event: ev('b', 1, 'status.changed', { to: 'created' }) });
    state = reduceTaskView(state, { kind: 'taskEvent', event: ev('a', 1, 'status.changed', { to: 'queued' }) });
    expect(selectTasks(state).map((t) => t.taskId)).toEqual(['b', 'a']);
    expect(reduceTaskView(state, { kind: 'reset' })).toBe(EMPTY_STATE);
  });

  it('caps the visible transcript while Core keeps the full log', () => {
    let state = EMPTY_STATE;
    const events: TaskEvent[] = [];
    for (let i = 1; i <= 520; i += 1) {
      events.push(ev('t1', i, 'message.delta', { type: 'message.delta', text: `line ${i}` }));
    }
    state = reduceTaskView(state, { kind: 'taskEvents', events });
    const task = selectTask(state, 't1');
    expect(task?.lines).toHaveLength(500);
    expect(task?.lines.at(-1)?.text).toBe('line 520');
    expect(task?.lines[0]?.text).toBe('line 21');
  });

  it('terminal classification is data, not a transition rule', () => {
    expect(TASK_STATUSES.filter(isTerminalStatus)).toEqual([
      'completed',
      'rejected',
      'failed',
      'cancelled',
      'interrupted',
    ]);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('awaiting_review')).toBe(false);
  });
});

describe('AgentEvent normalization', () => {
  it('passes through every documented variant', () => {
    expect(normalizeAgentEvent({ type: 'message.delta', text: 'hi' })).toEqual({
      type: 'message.delta',
      text: 'hi',
    });
    expect(normalizeAgentEvent({ type: 'error', code: 'DAEMON_DOWN', message: 'm' })).toEqual({
      type: 'error',
      code: 'DAEMON_DOWN',
      message: 'm',
    });
  });

  it('marks anything unverifiable as unsupported.event rather than guessing', () => {
    expect(normalizeAgentEvent({ type: 'message.delta' })).toEqual({
      type: 'unsupported.event',
      providerType: 'message.delta',
    });
    expect(normalizeAgentEvent({ type: 'agent.thinking', x: 1 })).toEqual({
      type: 'unsupported.event',
      providerType: 'agent.thinking',
    });
    expect(normalizeAgentEvent({ type: 'error', code: 'MADE_UP', message: 'm' })).toEqual({
      type: 'unsupported.event',
      providerType: 'error',
    });
    expect(normalizeAgentEvent('nope')).toEqual({
      type: 'unsupported.event',
      providerType: 'unknown',
    });
  });
});
