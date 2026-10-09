import { describe, expect, it } from "vitest";
import {
  countTasks,
  describeTaskAction,
  emptyProjection,
  fileChangeLabel,
  foldTaskEvents,
  foldTaskIndex,
  reviewSummary,
  taskStatusView,
  windowEntries,
  markReplayGap,
  associateFolder,
  featureGate,
  foldTranscript,
  normalizeRepoPath,
  sandboxModeView,
  workspaceModeView,
  type TaskProjection,
} from "../src/lib/reducers";
import {
  TASK_STATUSES,
  type ConversationHistoryResult,
  type Project,
  type TaskEvent,
  type TaskStatus,
  type TaskSummary,
} from "../src/lib/protocol";

function event(
  taskId: string,
  sequence: number,
  kind: string,
  payload: unknown,
): TaskEvent {
  return { taskId, sequence, kind, payload, timestamp: `2026-10-09T00:00:${String(sequence).padStart(2, "0")}Z` };
}

describe("taskStatusView", () => {
  it("covers every protocol status with a distinct label", () => {
    const labels = TASK_STATUSES.map((status) => taskStatusView(status).label);
    expect(new Set(labels).size).toBe(TASK_STATUSES.length);
  });

  it("names wire states verbatim so drift is visible", () => {
    expect(taskStatusView("awaiting_review").label).toBe("Ready for review");
    expect(taskStatusView("verifying").label).toBe("Running verification");
    expect(taskStatusView("preparing").alive).toBe(true);
  });

  it("never marks interrupted as alive or resumable", () => {
    const view = taskStatusView("interrupted");
    expect(view.alive).toBe(false);
    expect(view.terminal).toBe(true);
    expect(view.note).toContain("NOT resumed automatically");
    expect(describeTaskAction("interrupted").canRetry).toBe(true);
    expect(describeTaskAction("interrupted").canCancel).toBe(false);
  });

  it("surfaces an unknown status instead of defaulting to running", () => {
    const view = taskStatusView("paused_by_the_agent");
    expect(view.status).toBe("unknown");
    expect(view.alive).toBe(false);
    expect(view.label).toBe("Unknown");
  });

  it("has no pause concept at all", () => {
    for (const status of TASK_STATUSES) {
      expect(status).not.toBe("paused");
    }
  });
});

describe("describeTaskAction", () => {
  it("only offers review when Core says awaiting_review", () => {
    expect(describeTaskAction("awaiting_review").canReview).toBe(true);
    expect(describeTaskAction("running").canReview).toBe(false);
    expect(describeTaskAction("completed").canReview).toBe(false);
  });

  it("allows cancel while work is live or pending", () => {
    for (const status of ["queued", "preparing", "running", "verifying", "awaiting_input"] as const) {
      expect(describeTaskAction(status).canCancel).toBe(true);
    }
    for (const status of ["completed", "failed", "cancelled", "rejected"] as const) {
      expect(describeTaskAction(status).canCancel).toBe(false);
    }
  });
});

describe("countTasks", () => {
  const tasks = (statuses: TaskSummary["status"][]): TaskSummary[] =>
    statuses.map((status, index) => ({
      id: `t${index}`,
      conversationId: "c1",
      status,
    }));

  it("splits the status bar counts correctly", () => {
    const counts = countTasks(
      tasks([
        "running",
        "verifying",
        "queued",
        "awaiting_review",
        "failed",
        "interrupted",
        "completed",
      ]),
    );
    expect(counts).toMatchObject({
      running: 2,
      queued: 1,
      needsReview: 1,
      failed: 2,
      completed: 1,
      interrupted: 1,
      total: 7,
    });
  });

  it("counts nothing as running when there are no tasks", () => {
    expect(countTasks([]).running).toBe(0);
  });
});

describe("foldTaskEvents", () => {
  it("folds the documented event kinds into a projection", () => {
    let p = emptyProjection("task-1");
    p = foldTaskEvents(p, [
      event("task-1", 1, "task.created", { conversationId: "conv-1" }),
      event("task-1", 2, "status.changed", { to: "queued" }),
      event("task-1", 3, "message.user", { type: "message.delta", text: "implement auth" }),
      event("task-1", 4, "status.changed", { to: "running" }),
      event("task-1", 5, "message.delta", { type: "message.delta", text: "he" }),
      event("task-1", 6, "message.delta", { type: "message.delta", text: "llo" }),
      event("task-1", 7, "tool.started", { type: "tool.started", id: "call-1", name: "read_file" }),
      event("task-1", 8, "tool.finished", { type: "tool.finished", id: "call-1", ok: true }),
      event("task-1", 9, "file.changed", { type: "file.changed", path: "src/auth.ts" }),
      event("task-1", 10, "approval.required", {
        type: "approval.required",
        requestId: "req-1",
        description: "run tests",
      }),
      event("task-1", 11, "status.changed", { to: "awaiting_review" }),
    ]);

    expect(p.conversationId).toBe("conv-1");
    expect(p.status).toBe("awaiting_review");
    expect(p.lastSequence).toBe(11);
    expect(p.agentText).toBe("hello");
    expect(p.changedFiles).toEqual(["src/auth.ts"]);
    expect(p.pendingApprovals).toEqual([{ requestId: "req-1", description: "run tests" }]);
    const tool = p.entries.find((entry) => entry.kind === "tool");
    expect(tool).toMatchObject({ toolId: "call-1", ok: true });
  });

  it("is idempotent across a replay that re-delivers a boundary event", () => {
    const batch = [
      event("task-2", 1, "task.created", { conversationId: "conv-2" }),
      event("task-2", 2, "message.delta", { type: "message.delta", text: "once" }),
    ];
    let p = foldTaskEvents(emptyProjection("task-2"), batch);
    p = foldTaskEvents(p, batch);
    expect(p.agentText).toBe("once");
    expect(p.entries).toHaveLength(2);
    expect(p.lastSequence).toBe(2);
  });

  it("ignores events belonging to another task", () => {
    const p = foldTaskEvents(emptyProjection("mine"), [
      event("other", 1, "status.changed", { to: "running" }),
    ]);
    expect(p.status).toBeNull();
    expect(p.lastSequence).toBe(0);
  });

  it("keeps an unverified adapter event visible as an error row", () => {
    const p = foldTaskEvents(emptyProjection("task-3"), [
      event("task-3", 1, "task.created", {}),
      event("task-3", 2, "adapter.unavailable", {
        type: "error",
        code: "PROVIDER_AUTH_REQUIRED",
        message: "no verified adapter for agent 'codex' in this build",
      }),
    ]);
    const error = p.entries.find((entry) => entry.kind === "error");
    expect(error).toMatchObject({ code: "ADAPTER_UNAVAILABLE" });
    expect(p.status).toBe("created");
  });

  it("reports unknown kinds instead of guessing them", () => {
    const p = foldTaskEvents(emptyProjection("task-4"), [
      event("task-4", 1, "plan.updated", { type: "plan.updated", steps: 3 }),
      event("task-4", 2, "anything", { type: "unsupported.event", providerType: "codex.weird" }),
    ]);
    expect(p.unknownKinds).toContain("plan.updated");
    expect(p.unknownKinds).toContain("unsupported.event:codex.weird");
    expect(p.entries.every((entry) => entry.kind === "unmodelled")).toBe(true);
  });

  it("refuses to invent a status from a payload it cannot read", () => {
    const p = foldTaskEvents(emptyProjection("task-5"), [
      event("task-5", 1, "status.changed", { to: "vibing" }),
    ]);
    expect(p.status).toBe("unknown");
  });

  it("records a replay gap without fabricating the missing rows", () => {
    let p = foldTaskEvents(emptyProjection("task-6"), [
      event("task-6", 1, "task.created", {}),
      event("task-6", 5, "status.changed", { to: "running" }),
    ]);
    p = markReplayGap(p, { from: 1, to: 5 });
    expect(p.replayGap).toEqual({ from: 1, to: 5 });
    expect(p.entries.filter((entry) => entry.kind === "status")).toHaveLength(2);
  });

  it("matches the wire payload Core writes for status.changed", () => {
    // Core serializes `{ "to": <TaskStatus> }` where the status is a JSON string.
    const p = foldTaskEvents(emptyProjection("task-7"), [
      event("task-7", 1, "status.changed", { to: "verifying" }),
    ]);
    expect(p.status).toBe("verifying");
  });
});

describe("foldTaskIndex", () => {
  it("derives the task table from projections only", () => {
    const projections = new Map(
      [
        foldTaskEvents(emptyProjection("a"), [event("a", 1, "task.created", { conversationId: "c1" })]),
        foldTaskEvents(emptyProjection("b"), [
          event("b", 1, "task.created", {}),
          event("b", 2, "status.changed", { to: "queued" }),
        ]),
      ].map((p) => [p.taskId, p] as const),
    );
    const index = foldTaskIndex(projections);
    expect(index.map((row) => row.taskId)).toEqual(["b", "a"]);
    expect(index[0]).toMatchObject({ status: "queued", lastSequence: 2 });
    expect(index[1]?.conversationId).toBe("c1");
  });

  it("has no row for a task with no events", () => {
    expect(foldTaskIndex(new Map())).toEqual([]);
  });
});

describe("windowEntries", () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ sequence: i + 1, n: i }));

  it("keeps the newest entries and reports what was hidden", () => {
    const { visible, hiddenBefore } = windowEntries(entries, 4);
    expect(visible.map((e) => e.sequence)).toEqual([7, 8, 9, 10]);
    expect(hiddenBefore).toBe(6);
  });

  it("hides nothing when the window fits", () => {
    expect(windowEntries(entries, 50).hiddenBefore).toBe(0);
  });
});

describe("workspace and change labels", () => {
  it("labels a direct mount as live-writable", () => {
    expect(workspaceModeView("direct_mount").liveWritable).toBe(true);
    expect(workspaceModeView("sbx_clone").liveWritable).toBe(false);
    expect(workspaceModeView("sbx_clone").blurb).toContain("separate from your working tree");
  });

  it("labels every file change status", () => {
    expect(fileChangeLabel("added")).toBe("Added");
    expect(fileChangeLabel("untracked")).toBe("Untracked");
  });
});

describe("reviewSummary", () => {
  const changeSet = {
    taskId: "t",
    baseCommit: "0123456789abcdef",
    hostDirty: false,
    changes: [{ path: "src/a.ts", status: "modified" as const }],
  };

  it("does not claim anything applied before Core says so", () => {
    const summary = reviewSummary(changeSet, null);
    expect(summary.headline).toBe("1 file(s) changed");
    expect(summary.detail).toContain("Not applied to your working tree");
  });

  it("warns when the host tree is dirty", () => {
    const summary = reviewSummary({ ...changeSet, hostDirty: true }, null);
    expect(summary.detail).toContain("host tree is dirty");
    expect(summary.tone).toBe("attention");
  });

  it("says so when there is no change set at all", () => {
    expect(reviewSummary(null, null).headline).toBe("No change set loaded");
  });

  it("reports an aborted apply with Core's reason", () => {
    const summary = reviewSummary(changeSet, {
      applied: false,
      abortReason: "base diverged",
      conflictedFiles: [],
    });
    expect(summary.detail).toContain("Last apply aborted: base diverged");
  });

  it("only claims success when apply actually succeeded", () => {
    expect(
      reviewSummary(changeSet, { applied: true, conflictedFiles: [] }).headline,
    ).toBe("Applied");
  });
});

// ---------------------------------------------------------------------------
// ADDITIVE-v1 folds: hydration, live-writable disclosure, transcript bounds
// ---------------------------------------------------------------------------

describe("sandboxModeView — an absent mode is never blank-as-safe", () => {
  it("renders a missing workspaceMode as UNVERIFIED and live-writable", () => {
    for (const missing of [null, undefined]) {
      const view = sandboxModeView(missing);
      expect(view.verified).toBe(false);
      expect(view.liveWritable).toBe(true);
      expect(view.label).toContain("UNVERIFIED");
      expect(view.mode).toBeNull();
    }
  });

  it("keeps direct_mount loud and the isolated modes calm", () => {
    expect(sandboxModeView("direct_mount").liveWritable).toBe(true);
    expect(sandboxModeView("direct_mount").tone).toBe("danger");
    expect(sandboxModeView("direct_mount").verified).toBe(true);
    expect(sandboxModeView("sbx_clone").liveWritable).toBe(false);
    expect(sandboxModeView("host_worktree").liveWritable).toBe(false);
    expect(sandboxModeView("mountless").liveWritable).toBe(false);
  });
});

describe("featureGate — 'not probed' is not 'unsupported'", () => {
  it("keeps the unprobed state distinct so no view claims a gap it never observed", () => {
    expect(featureGate(null, "`task.list`", "nope").state).toBe("unprobed");
    expect(featureGate(true, "`task.list`", "nope").state).toBe("supported");
    expect(featureGate(false, "`task.list`", "this Core lacks it").note).toBe(
      "this Core lacks it",
    );
  });
});

describe("foldTaskIndex — Core's rows and the event replay, neither invented", () => {
  const projection = (
    taskId: string,
    lastSequence: number,
    status: TaskStatus | null,
  ): TaskProjection => ({
    ...emptyProjection(taskId),
    lastSequence,
    status,
    conversationId: "c1",
  });

  it("shows a task the event stream never reached, sourced to task.list", () => {
    const rows = foldTaskIndex(new Map(), [
      {
        id: "t-never-seen",
        conversationId: "c-ns",
        status: "interrupted",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: "t-never-seen",
      status: "interrupted",
      source: "task.list",
      // An interrupted row must never be displayed as running/resumed.
      lastSequence: 0,
    });
  });

  it("still folds events-only rows when task.list is unavailable", () => {
    const map = new Map([["t1", projection("t1", 7, "running")]]);
    expect(foldTaskIndex(map)).toEqual([
      expect.objectContaining({ taskId: "t1", status: "running", source: "events" }),
    ]);
  });

  it("reports a disagreement between Core's two reads instead of picking one", () => {
    const map = new Map([["t1", projection("t1", 9, "running")]]);
    const rows = foldTaskIndex(map, [
      { id: "t1", conversationId: "c1", status: "awaiting_review" },
    ]);
    expect(rows[0]?.source).toBe("task.list");
    expect(rows[0]?.status).toBe("awaiting_review");
    expect(rows[0]?.disagreement).toEqual({
      fromEvents: "running",
      fromEventsRaw: null,
      fromTaskList: "awaiting_review",
      fromTaskListRaw: null,
    });
    // No client-side transition was computed: both sides are Core's own values.
  });

  it("keeps conversation and sequence facts from whichever read supplied them", () => {
    const map = new Map([["t1", projection("t1", 3, "queued")]]);
    const rows = foldTaskIndex(map, [
      {
        id: "t1",
        conversationId: "c1",
        status: "queued",
        sandboxName: "atlas-auth",
        taskBranch: "sp/t1",
        baseCommit: "abc1234",
      },
    ]);
    expect(rows[0]).toMatchObject({
      lastSequence: 3,
      sandboxName: "atlas-auth",
      taskBranch: "sp/t1",
      baseCommit: "abc1234",
      disagreement: null,
    });
  });
});

describe("foldTranscript — bounded pages stay disclosed", () => {
  const page = (
    sequences: number[],
    truncated: boolean,
    nextSequence: number,
  ): ConversationHistoryResult => ({
    messages: sequences.map((sequence) => ({
      id: `m${sequence}`,
      conversationId: "c1",
      role: sequence % 2 === 1 ? "user" : "assistant",
      content: `message ${sequence}`,
      sequence,
    })),
    truncated,
    nextSequence,
  });

  it("carries Core's truncation into a notice the view must show", () => {
    const view = foldTranscript([page([1, 2], true, 2)]);
    expect(view.truncated).toBe(true);
    expect(view.cursor).toBe(2);
    expect(view.notice).toContain("not the whole conversation");
    expect(view.notice).toContain("sequence 2");
  });

  it("says nothing is withheld only when Core said so", () => {
    const view = foldTranscript([page([1, 2, 3], false, 3)]);
    expect(view.truncated).toBe(false);
    expect(view.notice).toBe("");
  });

  it("merges pages without duplicating a re-delivered row", () => {
    const view = foldTranscript([page([1, 2], true, 2), page([2, 3], false, 3)]);
    expect(view.entries.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(view.pages).toBe(2);
    expect(view.cursor).toBe(3);
  });
});

describe("associateFolder — a path match is not proof of identity", () => {
  const project: Project = {
    id: "p1",
    name: "Atlas Demo",
    description: "",
    createdAt: "2026-10-09T00:00:00Z",
    repositories: ["/repos/atlas"],
  };

  it("reports unregistered when no Core project names a repository", () => {
    expect(associateFolder("/repos/atlas", []).kind).toBe("unregistered");
    expect(
      associateFolder("/repos/atlas", [{ ...project, repositories: undefined }]).kind,
    ).toBe("unregistered");
  });

  it("matches a trailing slash but never invents a project", () => {
    const hit = associateFolder("/repos/atlas/", [project]);
    expect(hit.kind).toBe("path-match");
    if (hit.kind === "path-match") expect(hit.project.id).toBe("p1");
    const miss = associateFolder("/repos/other", [project]);
    expect(miss.kind).toBe("no-match");
  });

  it("normalizes only lexically — symlink resolution is Core's, not ours", () => {
    expect(normalizeRepoPath("  /repos/atlas  ")).toBe("/repos/atlas");
    expect(normalizeRepoPath("/")).toBe("/");
    expect(normalizeRepoPath("   ")).toBe("");
    // A symlinked path is NOT claimed to match its target: no client-side guess.
    expect(associateFolder("/tmp-link/atlas", [project]).kind).toBe("no-match");
  });
});
