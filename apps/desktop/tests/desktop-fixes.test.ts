/**
 * Regression tests for the desktop review findings A5–A12. Each block names the
 * finding it pins. Component-only behaviour (React keys, DOM focus) is covered
 * through the pure helpers those components delegate to; the suite runs in
 * node without a DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";
import { CoreClient } from "../src/lib/core-client";
import { TaskEventStore } from "../src/lib/event-store";
import { conversationHistoryQueryOptions } from "../src/lib/hooks";
import { confirmEnabled, nextTrapIndex } from "../src/lib/focus";
import {
  UNVERIFIED_SANDBOX_MODE_VIEW,
  clearSentDraft,
  countTasks,
  emptyProjection,
  foldTaskEvents,
  foldTaskIndex,
  foldTranscript,
  resolveSelection,
  scopeProjectionsToProject,
  taskBucket,
  taskIsolationView,
  withDraft,
  type TaskProjection,
} from "../src/lib/reducers";
import {
  TASK_STATUSES,
  type ConversationHistoryResult,
  type TaskEvent,
  type TaskStatus,
} from "../src/lib/protocol";
import { parseHash, routeViewKey } from "../src/app/router";
import {
  loadUiPreferences,
  sanitize,
  uiPreferences,
  watchSystemTheme,
  type UiState,
} from "../src/stores/ui";
import { FakeCore } from "./support/fake-core";

function ev(taskId: string, sequence: number, kind: string, payload: unknown, at: string): TaskEvent {
  return { taskId, sequence, kind, payload, timestamp: at };
}

// ---------------------------------------------------------------------------
// A5 — live-writable disclosure comes from the task's OWN sandbox
// ---------------------------------------------------------------------------

describe("A5 taskIsolationView", () => {
  const sandboxes = [
    { name: "sb-direct", workspaceMode: "direct_mount" as const },
    { name: "sb-clone", workspaceMode: "sbx_clone" as const },
    { name: "sb-unknown", workspaceMode: null },
  ];

  it("uses the task's own recorded mode, not a focused sandbox", () => {
    const direct = taskIsolationView({ sandboxName: "sb-direct" }, sandboxes);
    expect(direct).toMatchObject({ verified: true, liveWritable: true, mode: "direct_mount" });
    const clone = taskIsolationView({ sandboxName: "sb-clone" }, sandboxes);
    expect(clone).toMatchObject({ verified: true, liveWritable: false, mode: "sbx_clone" });
    expect(clone.reason).toContain("sb-clone");
  });

  it("every unknown link is UNVERIFIED and treated as live-writable", () => {
    const cases = [
      taskIsolationView(null, sandboxes), // no task row
      taskIsolationView({ sandboxName: null }, sandboxes), // events-only row / not reported
      taskIsolationView({ sandboxName: "sb-gone" }, sandboxes), // not in sandbox.list
      taskIsolationView({ sandboxName: "sb-unknown" }, sandboxes), // no recorded mode
      taskIsolationView({ sandboxName: "sb-clone" }, []), // sandbox.list empty
      taskIsolationView({ sandboxName: "sb-clone" }, [], false), // sandbox.list loading/failed
    ];
    for (const view of cases) {
      expect(view.verified).toBe(false);
      expect(view.liveWritable).toBe(true);
      expect(view.label).toBe(UNVERIFIED_SANDBOX_MODE_VIEW.label);
      expect(view.reason.length).toBeGreaterThan(0);
    }
  });

  it("while sandbox.list is loading or failed, the reason says so (not 'not in the list')", () => {
    const view = taskIsolationView({ sandboxName: "sb-clone" }, [], false);
    expect(view.reason).toContain("sandbox list is unavailable");
    expect(view.reason).not.toContain("not in Core's sandbox list");
  });
});

// ---------------------------------------------------------------------------
// A6 — per-entity state must not leak across projects / tasks / conversations
// ---------------------------------------------------------------------------

describe("A6 state scoping", () => {
  it("the workspace view key changes with the project, not with the conversation", () => {
    const a = routeViewKey(parseHash("#/projects/p1"));
    const aChat = routeViewKey(parseHash("#/projects/p1/conversations/c9"));
    const b = routeViewKey(parseHash("#/projects/p2"));
    expect(a).toBe(aChat);
    expect(a).not.toBe(b);
    expect(routeViewKey(parseHash("#/sandboxes/one"))).not.toBe(
      routeViewKey(parseHash("#/sandboxes/two")),
    );
  });

  it("a remembered selection is dropped once it leaves the visible list", () => {
    expect(resolveSelection("t2", ["t1", "t2"], "first")).toBe("t2");
    expect(resolveSelection("t-other-project", ["t1", "t2"], "first")).toBe("t1");
    expect(resolveSelection("t-other-project", [], "first")).toBeNull();
    expect(resolveSelection("sb-deleted", ["sb-a"], "none")).toBeNull();
    expect(resolveSelection(null, ["sb-a"], "none")).toBeNull();
  });

  it("drafts are kept per conversation and cleared only for the chat that was sent", () => {
    let drafts = withDraft({}, "c1", "hello one");
    drafts = withDraft(drafts, "c2", "hello two");
    expect(drafts).toEqual({ c1: "hello one", c2: "hello two" });
    // Sent from c1, while c2 keeps its own text.
    drafts = clearSentDraft(drafts, "c1", "hello one");
    expect(drafts).toEqual({ c2: "hello two" });
    // The user kept typing in c2 after sending: the newer text survives.
    drafts = withDraft(drafts, "c2", "hello two, more");
    expect(clearSentDraft(drafts, "c2", "hello two")).toEqual({ c2: "hello two, more" });
    expect(withDraft({ c1: "x" }, "c1", "")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// A7 — conversation history paging
// ---------------------------------------------------------------------------

describe("A7 conversation history", () => {
  let core: FakeCore;
  let client: CoreClient;
  let qc: QueryClient;

  const messages = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sequence: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i + 1}`,
    }));

  beforeEach(() => {
    core = new FakeCore();
    client = new CoreClient(core.transport);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    core.addConversation({
      id: "c-long",
      projectId: "p1",
      title: "long",
      agentId: "codex",
      createdAt: "2026-10-09T00:00:00Z",
      messages: messages(205),
    });
    core.addConversation({
      id: "c-short",
      projectId: "p1",
      title: "short",
      agentId: "codex",
      createdAt: "2026-10-09T00:00:00Z",
      messages: messages(2),
    });
  });

  afterEach(() => {
    qc.clear();
    client.close();
  });

  it("keys pages per conversation, so a page never lands in another chat", async () => {
    const [long, short] = await Promise.all([
      qc.fetchInfiniteQuery(conversationHistoryQueryOptions(client, "c-long")),
      qc.fetchInfiniteQuery(conversationHistoryQueryOptions(client, "c-short")),
    ]);
    expect(long.pages[0]?.messages.every((m) => m.conversationId === "c-long")).toBe(true);
    expect(short.pages[0]?.messages.map((m) => m.content)).toEqual(["m1", "m2"]);
  });

  it("offers a next page only while Core's newest page is truncated", () => {
    const { getNextPageParam } = conversationHistoryQueryOptions(client, "c");
    const truncated: ConversationHistoryResult = { messages: [], truncated: true, nextSequence: 200 };
    const complete: ConversationHistoryResult = { messages: [], truncated: false, nextSequence: 205 };
    expect(getNextPageParam(truncated)).toBe(200);
    expect(getNextPageParam(complete)).toBeUndefined();
  });

  it("a second load-more while one is in flight sends no second request", async () => {
    const observer = new InfiniteQueryObserver<
      ConversationHistoryResult,
      Error,
      InfiniteData<ConversationHistoryResult, number>,
      readonly string[],
      number
    >(qc, conversationHistoryQueryOptions(client, "c-long"));
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    const before = core.callsFor("conversation.history");
    await Promise.all([
      observer.fetchNextPage({ cancelRefetch: false }),
      observer.fetchNextPage({ cancelRefetch: false }),
    ]);
    expect(core.callsFor("conversation.history") - before).toBe(1);
    const pages = observer.getCurrentResult().data?.pages ?? [];
    const view = foldTranscript(pages);
    expect(view.entries).toHaveLength(205);
    // The newest page completed the read: the "not complete" banner clears.
    expect(view.truncated).toBe(false);
    unsubscribe();
  });

  it("invalidation after a send re-reads what Core stored", async () => {
    const options = conversationHistoryQueryOptions(client, "c-short");
    await qc.fetchInfiniteQuery(options);
    core.conversations
      .find((c) => c.id === "c-short")
      ?.messages.push({ sequence: 3, role: "user", content: "m3" });
    await qc.invalidateQueries({ queryKey: options.queryKey });
    const refreshed = await qc.fetchInfiniteQuery(options);
    expect(foldTranscript(refreshed.pages).entries.map((m) => m.content)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });
});

// ---------------------------------------------------------------------------
// A8 — project scoping and meaningful ordering
// ---------------------------------------------------------------------------

describe("A8 project-scoped task index", () => {
  const projection = (taskId: string, conversationId: string | null): TaskProjection => ({
    ...emptyProjection(taskId),
    conversationId,
    lastSequence: 1,
  });

  it("keeps only tasks Core's project-scoped reads attribute to the project", () => {
    const all = [
      projection("t-row", null), // in this project's task.list
      projection("t-chat", "c-mine"), // created from this project's conversation
      projection("t-elsewhere", "c-other-project"),
      projection("t-orphan", null), // no row, no conversation: cannot be attributed
    ];
    const { inScope, unattributed } = scopeProjectionsToProject(all, {
      taskIds: new Set(["t-row"]),
      conversationIds: new Set(["c-mine"]),
      conversationsAuthoritative: true,
    });
    expect(inScope.map((p) => p.taskId).sort()).toEqual(["t-chat", "t-row"]);
    expect(unattributed).toBe(1);
  });

  it("without Core's conversation list, an unknown conversation is counted, not dropped", () => {
    // Legacy Core / list still loading: the set holds only this window's chats,
    // so a task from a VS Code chat cannot be ruled out of this project.
    const { inScope, unattributed } = scopeProjectionsToProject(
      [projection("t-vscode-chat", "c-from-another-client"), projection("t-mine", "c-mine")],
      { taskIds: new Set(), conversationIds: new Set(["c-mine"]), conversationsAuthoritative: false },
    );
    expect(inScope.map((p) => p.taskId)).toEqual(["t-mine"]);
    expect(unattributed).toBe(1);
  });

  it("orders by Core event time, not by per-task sequence numbers", () => {
    const busyButOld = foldTaskEvents(
      emptyProjection("t-old"),
      Array.from({ length: 50 }, (_, i) =>
        ev("t-old", i + 1, "message.user", { text: "x" }, "2026-10-01T00:00:00Z"),
      ),
    );
    const quietButNew = foldTaskEvents(emptyProjection("t-new"), [
      ev("t-new", 1, "task.created", {}, "2026-10-09T12:00:00Z"),
    ]);
    const rows = foldTaskIndex(
      new Map([
        ["t-old", busyButOld],
        ["t-new", quietButNew],
      ]),
    );
    expect(rows.map((r) => r.taskId)).toEqual(["t-new", "t-old"]);
    expect(rows[0]?.lastEventAt).toBe("2026-10-09T12:00:00Z");
  });

  it("rows with no events follow, newest-created first (Core lists created_at ASC)", () => {
    const rows = foldTaskIndex(new Map(), [
      { id: "first-created", conversationId: "c", status: "queued" },
      { id: "second-created", conversationId: "c", status: "queued" },
    ]);
    expect(rows.map((r) => r.taskId)).toEqual(["second-created", "first-created"]);
  });

  it("the event store snapshot uses the same activity order", () => {
    const store = new TaskEventStore(new CoreClient(new FakeCore().transport));
    store.applyEvents([
      ...Array.from({ length: 9 }, (_, i) =>
        ev("t-old", i + 1, "message.user", { text: "x" }, "2026-10-01T00:00:00Z"),
      ),
      ev("t-new", 1, "task.created", {}, "2026-10-09T00:00:00Z"),
    ]);
    expect(store.getSnapshot().map((p) => p.taskId)).toEqual(["t-new", "t-old"]);
    store.stop();
  });
});

// ---------------------------------------------------------------------------
// A9 — confirmation dialog rules
// ---------------------------------------------------------------------------

describe("A9 confirm dialog helpers", () => {
  it("traps Tab inside the dialog and wraps at both ends", () => {
    expect(nextTrapIndex(3, 0, false)).toBe(1);
    expect(nextTrapIndex(3, 2, false)).toBe(0);
    expect(nextTrapIndex(3, 0, true)).toBe(2);
    expect(nextTrapIndex(3, -1, false)).toBe(0);
    expect(nextTrapIndex(3, -1, true)).toBe(2);
    expect(nextTrapIndex(0, -1, false)).toBeNull();
  });

  it("a required phrase must match exactly", () => {
    expect(confirmEnabled(undefined, "")).toBe(true);
    expect(confirmEnabled("apply", "apply")).toBe(true);
    expect(confirmEnabled("apply", "Apply")).toBe(false);
    expect(confirmEnabled("apply", " apply")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A10 — store status is observable, attention flushes immediately
// ---------------------------------------------------------------------------

describe("A10 event store notifications", () => {
  let core: FakeCore;
  let client: CoreClient;
  let store: TaskEventStore;

  beforeEach(() => {
    vi.useFakeTimers();
    core = new FakeCore();
    client = new CoreClient(core.transport);
    store = new TaskEventStore(client, { batchMs: 80, pollIntervalMs: 60_000 });
  });

  afterEach(() => {
    store.stop();
    client.close();
    vi.useRealTimers();
  });

  it("a status change notifies listeners and changes the snapshot reference", async () => {
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getStatus();
    expect(store.getStatus()).toBe(before);
    core.failNextWith(1);
    store.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(store.getStatus().kind).toBe("degraded");
    expect(store.getStatus()).not.toBe(before);
    expect(listener).toHaveBeenCalled();
  });

  it("an unchanged status keeps the same reference (no re-render per poll)", async () => {
    store.start();
    await vi.advanceTimersByTimeAsync(10);
    const streaming = store.getStatus();
    expect(streaming.kind).toBe("streaming");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getStatus()).toBe(streaming);
  });

  it("a terminal status is flushed at once, not after the batch window", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyEvents([ev("t1", 1, "task.created", {}, "2026-10-09T00:00:00Z")]);
    expect(listener).not.toHaveBeenCalled(); // ordinary event: batched
    store.applyEvents([ev("t1", 2, "status.changed", { to: "failed" }, "2026-10-09T00:00:01Z")]);
    expect(listener).toHaveBeenCalledTimes(1); // terminal: immediate
    vi.advanceTimersByTime(200);
    expect(listener).toHaveBeenCalledTimes(1); // the pending batch was folded into that flush
  });

  it("awaiting review and approvals also flush immediately; streaming text does not", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyEvents([
      ev("t1", 1, "message.delta", { type: "message.delta", text: "tok" }, "2026-10-09T00:00:00Z"),
    ]);
    expect(listener).not.toHaveBeenCalled();
    store.applyEvents([
      ev("t1", 2, "status.changed", { to: "awaiting_review" }, "2026-10-09T00:00:01Z"),
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
    store.applyEvents([
      ev(
        "t2",
        1,
        "approval.required",
        { type: "approval.required", requestId: "r", description: "d" },
        "2026-10-09T00:00:02Z",
      ),
    ]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// A11 — preferences actually drive behaviour; no confirmation off-switch
// ---------------------------------------------------------------------------

describe("A11 UI preferences", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    uiPreferences.reset();
  });

  it("the coalescing window is live and clamped", () => {
    vi.useFakeTimers();
    try {
      const store = new TaskEventStore(new CoreClient(new FakeCore().transport), { batchMs: 80 });
      store.setBatchMs(5);
      expect(store.batchWindowMs).toBe(16);
      store.setBatchMs(10_000);
      expect(store.batchWindowMs).toBe(500);
      store.setBatchMs(200);
      const listener = vi.fn();
      store.subscribe(listener);
      store.applyEvents([ev("t1", 1, "task.created", {}, "2026-10-09T00:00:00Z")]);
      vi.advanceTimersByTime(100);
      expect(listener).not.toHaveBeenCalled(); // the 80 ms default no longer applies
      vi.advanceTimersByTime(150);
      expect(listener).toHaveBeenCalledTimes(1);
      store.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("there is no destructive-confirmation preference, even from old storage", () => {
    expect(Object.keys(uiPreferences.get())).not.toContain("confirmDestructiveActions");
    const legacy = { confirmDestructiveActions: false, theme: "dark" } as unknown as Partial<UiState>;
    expect(Object.keys(sanitize(legacy))).not.toContain("confirmDestructiveActions");

    const storage = new Map<string, string>([
      ["sandpane.desktop.ui", JSON.stringify({ confirmDestructiveActions: false, sidebarCollapsed: false })],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    loadUiPreferences();
    expect(uiPreferences.get().sidebarCollapsed).toBe(false); // the stored choice wins
    expect(Object.keys(uiPreferences.get())).not.toContain("confirmDestructiveActions");
  });

  it("the navigation rail is icon-only by default (design spec §3)", () => {
    uiPreferences.reset();
    expect(uiPreferences.get().sidebarCollapsed).toBe(true);
  });

  it("set() applies the same bounds as a persisted payload", () => {
    uiPreferences.set({ eventBatchMs: 1, maxVisibleEvents: 1_000_000 });
    expect(uiPreferences.get().eventBatchMs).toBe(16);
    expect(uiPreferences.get().maxVisibleEvents).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// A12 — robustness and consistency
// ---------------------------------------------------------------------------

describe("A12 robustness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    uiPreferences.reset();
  });

  it("a malformed escape in the hash is an unknown route, not a thrown render", () => {
    expect(() => parseHash("#/projects/%E0%A4%A")).not.toThrow();
    const route = parseHash("#/projects/%E0%A4%A");
    expect(route.unmatched).toBe(true);
    expect(parseHash("#/projects/a%20b").params.projectId).toBe("a b");
  });

  it("a storage write that throws does not break a preference change", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => uiPreferences.set({ theme: "light" })).not.toThrow();
    expect(uiPreferences.get().theme).toBe("light");
  });

  it("the system theme follows OS changes while 'system' is selected", () => {
    const listeners: (() => void)[] = [];
    const removed: (() => void)[] = [];
    vi.stubGlobal("window", {
      matchMedia: () => ({
        matches: false,
        addEventListener: (_: string, fn: () => void) => listeners.push(fn),
        removeEventListener: (_: string, fn: () => void) => removed.push(fn),
      }),
    });
    const onChange = vi.fn();
    const stop = watchSystemTheme({ ...uiPreferences.get(), theme: "system" }, onChange);
    expect(listeners).toHaveLength(1);
    listeners[0]?.();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    expect(removed).toHaveLength(1);
    // An explicit theme does not subscribe at all.
    watchSystemTheme({ ...uiPreferences.get(), theme: "dark" }, onChange);
    expect(listeners).toHaveLength(1);
  });

  it("every filter tab count equals the rows that tab shows", () => {
    const rows = TASK_STATUSES.map((status) => ({ status }));
    const counts = countTasks(rows);
    const shown = (bucket: string) =>
      rows.filter((r) => taskBucket(r.status as TaskStatus) === bucket).length;
    expect(shown("running")).toBe(counts.running);
    expect(shown("queued")).toBe(counts.queued);
    expect(shown("waiting")).toBe(counts.needsReview + counts.awaitingInput);
    expect(shown("completed")).toBe(counts.completed);
    expect(shown("failed")).toBe(counts.failed);
    expect(shown("cancelled")).toBe(counts.cancelled);
    expect(counts.cancelled).toBe(1);
  });
});
