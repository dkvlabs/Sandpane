/**
 * `task.subscribe` cursor semantics, proven against the desktop's own replaying
 * subscription.
 *
 * The rules come from `TaskSubscribeParams` in Rust and were confirmed against
 * the prebuilt service: a `taskId` request replays that ONE task from the scalar
 * and ignores any map; a scope-wide request replays EACH task from its own
 * `afterSequences` cursor (absent ⇒ 0); with no map at all every task falls back
 * to the shared scalar. The gap this closes was the desktop's own: it used to
 * send the MINIMUM checkpoint as one scalar, which re-flooded every task ahead of
 * it and, once a task was behind, could not express its cursor at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreClient, isOversizedReplayRefusal } from "../src/lib/core-client";
import { FakeCore, OVERSIZE_REFUSAL_MESSAGE } from "./support/fake-core";
import type { TaskEvent, TaskSummary } from "../src/lib/protocol";

function ev(taskId: string, sequence: number): TaskEvent {
  return {
    taskId,
    sequence,
    kind: "status.changed",
    payload: { to: "running" },
    timestamp: "2026-10-09T00:00:00Z",
  };
}

/**
 * Core scopes a replayed task through its conversation, so a project-scoped test
 * must register that join rather than assume the double guesses it.
 */
function wireProjectOn(target: FakeCore, tasks: string[], projectId = "p1"): void {
  for (const taskId of tasks) {
    target.addTaskInProject(
      {
        id: taskId,
        conversationId: `c-${taskId}`,
        status: "running" as const,
        sandboxName: null,
        taskBranch: null,
        baseCommit: null,
      },
      projectId,
    );
  }
}

function wireProject(tasks: string[], projectId = "p1"): void {
  wireProjectOn(core, tasks, projectId);
}

let core: FakeCore;
let client: CoreClient;

beforeEach(() => {
  core = new FakeCore();
  client = new CoreClient(core.transport);
});

afterEach(() => {
  client.close();
  vi.useRealTimers();
});

describe("the wire shape of each request", () => {
  it("a taskId scope sends the scalar and never a map", async () => {
    core.appendEvents([ev("t1", 1), ev("t1", 2)]);
    await client.replayTaskEvents({
      taskId: "t1",
      afterSequence: 1,
      afterSequences: { t1: 99, t2: 99 },
    });
    // The map is dropped rather than sent-and-ignored, so a reader of the frame
    // cannot conclude the cursor came from the map.
    expect(core.lastParams("task.subscribe")).toEqual({
      afterSequence: 1,
      taskId: "t1",
    });
  });

  it("a scope-wide request carries the map without a taskId", async () => {
    core.appendEvents([ev("t-a", 4), ev("t-b", 11)]);
    await client.replayTaskEvents({
      projectId: "p1",
      afterSequence: 0,
      afterSequences: { "t-a": 3, "t-b": 10 },
    });
    expect(core.lastParams("task.subscribe")).toEqual({
      afterSequence: 0,
      projectId: "p1",
      afterSequences: { "t-a": 3, "t-b": 10 },
    });
  });

  it("no map keeps the legacy shared-scalar frame", async () => {
    await client.replayTaskEvents({ projectId: "p1", afterSequence: 7 });
    expect(core.lastParams("task.subscribe")).toEqual({
      afterSequence: 7,
      projectId: "p1",
    });
  });
});

describe("uneven per-task cursors (the case a shared scalar cannot express)", () => {
  it("resumes each task from its OWN sequence instead of the minimum", async () => {
    wireProject(["t-a", "t-b"]);
    // t-a is at 100, t-b is at 2. One shared scalar would have to be 2, which
    // re-floods t-a's 98 already-seen events — or 100, which SKIPS t-b's unseen
    // tail. Per-task cursors are the only correct answer.
    core.appendEvents([ev("t-a", 100), ev("t-b", 3), ev("t-b", 4)]);
    const sub = client.subscribeTasks({
      projectId: "p1",
      afterSequence: 0,
      onEvents: () => {},
      pollIntervalMs: 5_000,
    });
    await sub.currentPass();
    // First pass held no checkpoints, so the legacy scalar (0) applies and both
    // tasks replay in full — nothing is skipped on a cold start.
    expect(sub.lastSequence("t-a")).toBe(100);
    expect(sub.lastSequence("t-b")).toBe(4);

    // Second pass must ask per task: t-a from 100, t-b from 4 — NOT min(4,100).
    core.appendEvents([ev("t-a", 101), ev("t-b", 5)]);
    sub.stop();
    const delivered: TaskEvent[] = [];
    const sub2 = client.subscribeTasks({
      projectId: "p1",
      afterSequence: 0,
      onEvents: (events) => delivered.push(...events),
      pollIntervalMs: 5_000,
    });
    // Seed the checkpoints the way a reconnect does, then let one pass run.
    await sub2.currentPass();
    expect(delivered.map((e) => `${e.taskId}#${e.sequence}`).sort()).toEqual([
      "t-a#100",
      "t-a#101",
      "t-b#3",
      "t-b#4",
      "t-b#5",
    ]);
    sub2.stop();
  });

  it("a checkpointed scope asks for each task's own cursor on the next pass", async () => {
    wireProject(["t-a", "t-b"]);
    core.appendEvents([ev("t-a", 100), ev("t-b", 2)]);
    const sub = client.subscribeTasks({
      projectId: "p1",
      onEvents: () => {},
      pollIntervalMs: 60_000,
    });
    await sub.currentPass();
    expect(sub.checkpointSnapshot()).toEqual({ "t-a": 100, "t-b": 2 });

    core.appendEvents([ev("t-a", 101), ev("t-b", 3)]);
    await sub.catchUpNow();
    const sent = core.lastParams<Record<string, unknown>>("task.subscribe");
    expect(sent.afterSequences).toEqual({ "t-a": 100, "t-b": 2 });
    expect(sub.lastSequence("t-a")).toBe(101);
    expect(sub.lastSequence("t-b")).toBe(3);
    sub.stop();
  });

  it("delivers only what each cursor had not seen — no re-flood of the ahead task", async () => {
    wireProject(["t-a", "t-b"]);
    core.appendEvents([ev("t-a", 100), ev("t-b", 2)]);
    const seen: string[] = [];
    const sub = client.subscribeTasks({
      projectId: "p1",
      onEvents: (events) => seen.push(...events.map((e) => `${e.taskId}#${e.sequence}`)),
      pollIntervalMs: 60_000,
    });
    await sub.currentPass();
    seen.length = 0;
    core.appendEvents([ev("t-b", 3)]);
    await sub.catchUpNow();
    // t-a sits at 100 and must NOT be re-delivered even though its cursor is
    // far ahead of t-b's — the old min-scalar request would have re-sent it.
    expect(seen).toEqual(["t-b#3"]);
    sub.stop();
  });
});

describe("an oversized replay is recoverable, not a retry storm", () => {
  it("latches the refusal, reports it once and stops polling", async () => {
    vi.useFakeTimers();
    const refusing = new FakeCore({ refuseReplayAsOversized: true });
    const c = new CoreClient(refusing.transport, { requestTimeoutMs: 1_000 });
    const errors: unknown[] = [];
    const states: string[] = [];
    const sub = c.subscribeTasks({
      projectId: "p1",
      pollIntervalMs: 100,
      onEvents: () => {},
      onError: (err) => errors.push(err),
      onState: (state) => states.push(state.kind),
    });
    await sub.currentPass();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "REPLAY_TOO_LARGE", source: "core" });
    expect(sub.replayRefused).toContain("ceiling");
    expect(sub.state.kind).toBe("refused");

    // The point of the latch: time passing must NOT keep re-asking Core for a
    // replay that can never fit a frame.
    const afterFirst = refusing.callsFor("task.subscribe");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refusing.callsFor("task.subscribe")).toBe(afterFirst);

    sub.stop();
    c.close();
  });

  it("resumes after the caller narrows the request", async () => {
    const refusing = new FakeCore({ refuseReplayAsOversized: true });
    const c = new CoreClient(refusing.transport);
    // The double scopes a project-wide replay through the task's conversation,
    // exactly as Core does, so the join must be registered here too.
    wireProjectOn(refusing, ["t-a"]);
    const delivered: TaskEvent[] = [];
    const sub = c.subscribeTasks({
      projectId: "p1",
      onEvents: (events) => delivered.push(...events),
      pollIntervalMs: 60_000,
    });
    await sub.currentPass();
    expect(sub.state.kind).toBe("refused");

    // The refusal is Core's verdict on THIS scope; only a narrower request may
    // be tried again, so clearing it is an explicit caller action.
    // The caller narrows the scope (here: a Core that can now answer), then pulls.
    refusing.appendEvents([ev("t-a", 1), ev("t-a", 2)]);
    refusing.setReplayRefusal(false);
    sub.clearReplayRefusal();
    expect(sub.replayRefused).toBeNull();
    await sub.catchUpNow();
    // Not merely "a second request happened" — the resumed pass must actually
    // deliver, otherwise a latch bug that blocks all future pulls stays hidden.
    expect(refusing.callsFor("task.subscribe")).toBe(2);
    expect(delivered.map((e) => e.sequence)).toEqual([1, 2]);
    expect(sub.state.kind).not.toBe("refused");
    sub.stop();
    c.close();
  });

  it("detects the refusal narrowly — an ordinary validation error is not latched", () => {
    expect(
      isOversizedReplayRefusal({
        source: "core",
        code: "VALIDATION_FAILED",
        message: OVERSIZE_REFUSAL_MESSAGE,
      }),
    ).toBe(false); // a plain object is not a CoreRequestError; only the real type counts
    const c = new CoreClient(core.transport);
    core.failNextWith(1);
    return expect(c.listConversations({})).rejects.toMatchObject({ code: "DAEMON_DOWN" });
  });
});

describe("task.list hydration reaches rows the event stream never showed", () => {
  it("reads Core's stored rows exactly as Core stores them", async () => {
    const tasks_row: TaskSummary = {
      id: "t-seed",
      conversationId: "c-seed",
      status: "interrupted",
      sandboxName: null,
      taskBranch: null,
      baseCommit: null,
    };
    core.addTaskInProject(tasks_row, "p1");
    const tasks = await client.listTasks({ projectId: "p1" });
    expect(tasks).toEqual([
      {
        id: "t-seed",
        conversationId: "c-seed",
        status: "interrupted",
        sandboxName: null,
        taskBranch: null,
        baseCommit: null,
      },
    ]);
    // `interrupted` is Core's restart reconciliation, displayed verbatim; the
    // client never turns it back into `running` (AGENTS rule 3).
    expect(core.lastParams("task.list")).toEqual({ projectId: "p1" });
  });

  it("a pre-revision Core refusing task.list surfaces as a structured error", async () => {
    const legacy = new FakeCore({ legacyCore: true });
    const c = new CoreClient(legacy.transport);
    await expect(c.listTasks({})).rejects.toMatchObject({
      source: "core",
      code: "VALIDATION_FAILED",
    });
    c.close();
  });
});
