import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreClient } from "../src/lib/core-client";
import { TaskEventStore } from "../src/lib/event-store";
import { FakeCore } from "./support/fake-core";
import { taskStatusView } from "../src/lib/reducers";
import type { TaskEvent } from "../src/lib/protocol";

function ev(taskId: string, sequence: number, kind: string, payload: unknown): TaskEvent {
  return { taskId, sequence, kind, payload, timestamp: "2026-10-09T00:00:00Z" };
}

let core: FakeCore;
let client: CoreClient;
let store: TaskEventStore;

beforeEach(() => {
  core = new FakeCore();
  client = new CoreClient(core.transport);
  store = new TaskEventStore(client, { pollIntervalMs: 5_000, batchMs: 40 });
});

afterEach(() => {
  store.stop();
  client.close();
});

describe("TaskEventStore folding", () => {
  it("folds a replay batch into per-task projections", () => {
    store.applyEvents([
      ev("t1", 1, "task.created", { conversationId: "c1" }),
      ev("t1", 2, "status.changed", { to: "running" }),
      ev("t2", 1, "task.created", { conversationId: "c2" }),
    ]);
    store.flush();
    const snapshot = store.getSnapshot();
    expect(snapshot.map((p) => p.taskId).sort()).toEqual(["t1", "t2"]);
    expect(store.peek("t1")?.status).toBe("running");
    expect(store.peek("t1")?.conversationId).toBe("c1");
    expect(store.checkpoint("t2")).toBe(1);
  });

  it("is idempotent when an overlapping replay re-delivers events", () => {
    const batch = [
      ev("t1", 1, "task.created", {}),
      ev("t1", 2, "message.delta", { type: "message.delta", text: "once" }),
    ];
    store.applyEvents(batch);
    store.applyEvents(batch);
    expect(store.peek("t1")?.agentText).toBe("once");
    expect(store.foldedEventCount).toBe(2);
  });

  it("exposes a stable snapshot reference between changes", () => {
    store.applyEvents([ev("t1", 1, "task.created", {})]);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.applyEvents([ev("t1", 2, "status.changed", { to: "queued" })]);
    expect(store.getSnapshot()).not.toBe(first);
  });

  it("folds a sparse replay without inventing the events it never received", () => {
    store.applyEvents([
      ev("t1", 1, "task.created", {}),
      ev("t1", 4, "status.changed", { to: "running" }),
    ]);
    const projection = store.peek("t1");
    // Sequences 2 and 3 were never sent: no synthetic rows appear.
    expect(projection?.entries).toHaveLength(2);
    expect(projection?.lastSequence).toBe(4);
    expect(projection?.replayGap).toBeNull();
  });
});

describe("TaskEventStore notifications", () => {
  it("coalesces a burst into one notification and flushes immediately on demand", () => {
    vi.useFakeTimers();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.applyEvents([ev("t1", 1, "task.created", {})]);
    store.applyEvents([ev("t1", 2, "message.delta", { type: "message.delta", text: "a" })]);
    store.applyEvents([ev("t1", 3, "message.delta", { type: "message.delta", text: "b" })]);
    expect(notifications).toBe(0);
    vi.advanceTimersByTime(50);
    expect(notifications).toBe(1);
    expect(store.peek("t1")?.agentText).toBe("ab");
  });

  it("stops notifying once the listener unsubscribes", () => {
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.applyEvents([ev("t1", 1, "task.created", {})]);
    store.flush();
    unsubscribe();
    store.applyEvents([ev("t1", 2, "status.changed", { to: "running" })]);
    store.flush();
    expect(notifications).toBe(1);
  });
});

describe("TaskEventStore streaming lifecycle", () => {
  it("streams from Core, reports status, and resumes from its checkpoint", async () => {
    store = new TaskEventStore(client, { pollIntervalMs: 40, batchMs: 5 });
    core.appendEvents([ev("t1", 1, "task.created", { conversationId: "c1" })]);
    store.start();
    await vi.waitFor(() => expect(store.peek("t1")).toBeDefined());
    expect(store.getStatus().kind).toBe("streaming");

    // A second start() must not open a duplicate stream.
    store.start();
    core.appendEvents([ev("t1", 2, "status.changed", { to: "running" })]);
    await vi.waitFor(() => expect(store.checkpoint("t1")).toBe(2));
    expect(store.peek("t1")?.entries.filter((e) => e.kind === "status")).toHaveLength(2);

    store.stop();
    expect(store.getStatus().kind).toBe("idle");
  });

  it("goes degraded when Core refuses a pass and recovers on the next good one", async () => {
    store = new TaskEventStore(client, { pollIntervalMs: 40, batchMs: 5 });
    core.failNextWith(1);
    store.start();
    await vi.waitFor(() => expect(store.getStatus().kind).toBe("degraded"), {
      timeout: 5_000,
      interval: 10,
    });
    // The stream survives the failure: the following pass succeeds and clears it.
    await vi.waitFor(() => expect(store.getStatus().kind).toBe("streaming"), {
      timeout: 10_000,
      interval: 10,
    });
    expect(core.probeCount).toBe(0); // only task.subscribe passes were made
    expect(core.requests.every((r) => r.method === "task.subscribe")).toBe(true);
    store.stop();
  });

  it("keeps terminal status copy honest for an interrupted task", () => {
    store.applyEvents([
      ev("t1", 1, "task.created", {}),
      ev("t1", 2, "status.changed", { to: "interrupted" }),
    ]);
    const view = taskStatusView(store.peek("t1")?.status);
    expect(view.label).toBe("Interrupted");
    expect(view.alive).toBe(false);
    expect(view.note).toContain("NOT resumed automatically");
  });
});

describe("conversation store", () => {
  it("replaces the snapshot on add so identity-based subscriptions notice it", async () => {
    const {
      addConversation,
      clearConversations,
      listConversations,
      subscribeConversations,
    } = await import("../src/lib/conversation-store");
    const conversation = {
      id: "c1",
      projectId: "p1",
      title: "Auth flow",
      agentId: "codex",
      createdAt: "2026-10-09T00:00:00Z",
    };
    const empty = listConversations();
    let notified = 0;
    const unsubscribe = subscribeConversations(() => {
      notified += 1;
    });

    addConversation(conversation);
    expect(notified).toBe(1);
    expect(listConversations()).not.toBe(empty);
    expect(listConversations()).toEqual([conversation]);

    // Re-adding the same id is a no-op: no duplicate tab, no spurious render.
    addConversation(conversation);
    expect(notified).toBe(1);
    expect(listConversations()).toHaveLength(1);

    unsubscribe();
    clearConversations();
    expect(notified).toBe(1);
    expect(listConversations()).toEqual([]);
  });
});
