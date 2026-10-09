/**
 * Forward-compatibility of the shipped desktop against an ADDITIVE Core.
 *
 * A newer Core may add an enum value (a task status, a file-change status, a
 * workspace mode, an error code) before this desktop build learns it. That must
 * not fail the WHOLE call — `task.list`, `conversation.send` (which Core has
 * already applied), `git.review` and `sandbox.list` would otherwise go dark, and
 * a lost `conversation.send` answer invites a duplicate retry.
 *
 * Tolerance is not a guess: the raw wire value is kept and shown, it is never
 * mapped onto a known state, and every action that depends on knowing the
 * state (review, apply, cancel, isolation claims) stays disabled or takes the
 * unsafe reading. Truly malformed frames (wrong types, missing required
 * fields) still fail exactly as before.
 */

import { describe, expect, it } from "vitest";
import {
  CoreClient,
  CoreRequestError,
  UNRECOGNIZED_CORE_CODE,
  parseResponseFrame,
  type CoreTransport,
} from "../src/lib/core-client";
import { decodeChangeSet, decodeSandboxSummaries, decodeTaskSummary } from "../src/lib/decode";
import { MalformedFrameError } from "../src/lib/framing";
import {
  FILE_CHANGE_STATUSES,
  PROTOCOL_VERSION,
  TASK_STATUSES,
  WORKSPACE_MODES,
} from "../src/lib/protocol";
import {
  UNVERIFIED_SANDBOX_MODE_VIEW,
  countTasks,
  describeCoreError,
  describeTaskAction,
  emptyProjection,
  fileChangeLabel,
  foldTaskEvents,
  foldTaskIndex,
  isTaskStatus,
  planApply,
  reviewBlockReason,
  reviewSummary,
  sandboxModeView,
  taskBucket,
  taskIsolationView,
  taskStatusView,
} from "../src/lib/reducers";
import { rustSnakeCaseEnumVariants } from "./support/rust-source";

/** Transport whose replies the test releases by hand. */
class ManualTransport implements CoreTransport {
  readonly kind = "memory";
  readonly requests: { id: string; method: string; params: unknown }[] = [];
  private handlers: ((line: string) => void)[] = [];

  write(frame: string): Promise<void> {
    this.requests.push(JSON.parse(frame) as { id: string; method: string; params: unknown });
    return Promise.resolve();
  }
  onLine(handler: (line: string) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
  onClose(): () => void {
    return () => {};
  }
  close(): void {}

  lastId(): string {
    const last = this.requests[this.requests.length - 1];
    if (!last) throw new Error("no request was sent");
    return last.id;
  }
  sendRaw(line: string): void {
    for (const handler of [...this.handlers]) handler(line);
  }
  respond(payload: unknown): void {
    this.sendRaw(JSON.stringify({ v: PROTOCOL_VERSION, id: this.lastId(), ok: payload }));
  }
  respondErr(err: unknown): void {
    this.sendRaw(JSON.stringify({ v: PROTOCOL_VERSION, id: this.lastId(), err }));
  }
}

/** Let the client write its frame before the test answers it. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const FUTURE_STATUS = "future_state";
const UNKNOWN_LABEL = `Unknown status (${FUTURE_STATUS}) — this Sandpane build is older than Core`;

// ---------------------------------------------------------------------------
// TaskStatus
// ---------------------------------------------------------------------------

describe("an unknown TaskStatus is kept raw, never mapped to a known state", () => {
  it("decodes to the explicit unknown variant carrying Core's raw string", () => {
    const summary = decodeTaskSummary({ id: "t1", conversationId: "c1", status: FUTURE_STATUS });
    expect(summary.status).toBe("unknown");
    expect(summary.unrecognizedStatus).toBe(FUTURE_STATUS);
    // A known status carries no raw side-channel.
    const known = decodeTaskSummary({ id: "t2", conversationId: "c1", status: "running" });
    expect(known.status).toBe("running");
    expect(known.unrecognizedStatus).toBeUndefined();
  });

  it("still refuses a status that is not a string, or is missing", () => {
    for (const status of [42, null, undefined, { to: "running" }, ""]) {
      expect(() => decodeTaskSummary({ id: "t", conversationId: "c", status })).toThrow(
        MalformedFrameError,
      );
    }
  });

  it("prototype keys are not task statuses", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(isTaskStatus(key)).toBe(false);
      expect(taskStatusView(key).status).toBe("unknown");
    }
  });

  it("renders visibly, and is neither terminal, running, nor reviewable", () => {
    const view = taskStatusView("unknown", FUTURE_STATUS);
    expect(view.status).toBe("unknown");
    expect(view.label).toBe(UNKNOWN_LABEL);
    expect(view.terminal).toBe(false);
    expect(view.alive).toBe(false);
    expect(view.needsReview).toBe(false);
    expect(describeTaskAction("unknown")).toEqual({
      canCancel: false,
      canReview: false,
      canRetry: false,
    });
    expect(taskBucket("unknown")).toBe("unknown");
    const counts = countTasks([{ status: "unknown" }, { status: "running" }]);
    expect(counts.total).toBe(2);
    expect(counts.running).toBe(1);
    expect(counts.completed + counts.failed + counts.cancelled + counts.interrupted).toBe(0);
  });

  it("strips control characters from the raw value before display", () => {
    const view = taskStatusView("unknown", "evil\u001b[31m\nstate");
    expect(view.label).not.toMatch(/[\u0000-\u001f]/);
    expect(view.label).toContain("evil");
  });

  it("task.list decodes the whole page when one row has an unknown status", async () => {
    const manual = new ManualTransport();
    const client = new CoreClient(manual);
    const inflight = client.listTasks();
    await tick();
    manual.respond([
      { id: "t1", conversationId: "c1", status: "running" },
      { id: "t2", conversationId: "c1", status: FUTURE_STATUS },
      { id: "t3", conversationId: "c1", status: "awaiting_review" },
    ]);
    const rows = await inflight;
    expect(rows.map((r) => r.status)).toEqual(["running", "unknown", "awaiting_review"]);
    expect(rows[1]?.unrecognizedStatus).toBe(FUTURE_STATUS);
    client.close();
  });

  it("task.list still fails on a structurally malformed row", async () => {
    const manual = new ManualTransport();
    const client = new CoreClient(manual);
    const inflight = client.listTasks();
    await tick();
    manual.respond([{ id: "t1", status: "running" }]); // conversationId missing
    await expect(inflight).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    client.close();
  });

  it("conversation.send whose TaskSummary has an unknown status is ACCEPTED, not failed", async () => {
    const manual = new ManualTransport();
    const client = new CoreClient(manual);
    const inflight = client.sendConversationMessage({
      conversationId: "c1",
      content: "hello",
      attachments: [],
    });
    await tick();
    expect(manual.requests[0]?.method).toBe("conversation.send");
    manual.respond({ id: "t9", conversationId: "c1", status: FUTURE_STATUS });
    const summary = await inflight;
    expect(summary).toMatchObject({ id: "t9", status: "unknown", unrecognizedStatus: FUTURE_STATUS });
    client.close();
  });

  it("the task index carries the raw status and never resolves it", () => {
    const rows = foldTaskIndex(new Map(), [
      { id: "t1", conversationId: "c1", status: "unknown", unrecognizedStatus: FUTURE_STATUS },
    ]);
    expect(rows[0]?.status).toBe("unknown");
    expect(rows[0]?.unrecognizedStatus).toBe(FUTURE_STATUS);
    expect(taskStatusView(rows[0]?.status, rows[0]?.unrecognizedStatus).label).toBe(UNKNOWN_LABEL);
  });

  it("a disagreement with the event log keeps the task.list side as unknown", () => {
    const projection = { ...emptyProjection("t1"), status: "running" as const, lastSequence: 3 };
    const rows = foldTaskIndex(new Map([["t1", projection]]), [
      { id: "t1", conversationId: "c1", status: "unknown", unrecognizedStatus: FUTURE_STATUS },
    ]);
    expect(rows[0]?.status).toBe("unknown");
    expect(rows[0]?.disagreement).toEqual({
      fromEvents: "running",
      fromEventsRaw: null,
      fromTaskList: "unknown",
      fromTaskListRaw: FUTURE_STATUS,
    });
  });

  it("the event log keeps a raw status.changed value, and a later known status clears it", () => {
    const ev = (sequence: number, to: unknown) => ({
      taskId: "t1",
      sequence,
      kind: "status.changed",
      payload: { to },
      timestamp: `2026-10-09T00:00:0${sequence}Z`,
    });
    const unknown = foldTaskEvents(emptyProjection("t1"), [ev(1, "running"), ev(2, FUTURE_STATUS)]);
    expect(unknown.status).toBe("unknown");
    expect(unknown.unrecognizedStatus).toBe(FUTURE_STATUS);
    const last = unknown.entries[unknown.entries.length - 1];
    expect(last).toMatchObject({ kind: "status", status: "unknown", raw: FUTURE_STATUS });
    if (last?.kind !== "status") throw new Error("expected a status entry");
    expect(taskStatusView(last.status, last.raw).label).toBe(UNKNOWN_LABEL);
    expect(taskStatusView(unknown.status, unknown.unrecognizedStatus).label).toBe(UNKNOWN_LABEL);
    // An event-only index row carries the same raw value.
    const rows = foldTaskIndex(new Map([["t1", unknown]]), []);
    expect(rows[0]?.unrecognizedStatus).toBe(FUTURE_STATUS);
    // A later recognised status clears it; a malformed `to` is plain unknown.
    expect(foldTaskEvents(unknown, [ev(3, "completed")]).unrecognizedStatus).toBeNull();
    const malformed = foldTaskEvents(emptyProjection("t1"), [ev(1, 42)]);
    expect(malformed.status).toBe("unknown");
    expect(malformed.unrecognizedStatus).toBeNull();
  });

  it("review and apply are blocked for an unknown status, with the raw value", () => {
    const reason = reviewBlockReason({ unrecognizedStatus: FUTURE_STATUS }, null);
    expect(reason).not.toBeNull();
    expect(reason).toContain(FUTURE_STATUS);
    // The event log reporting an unreadable status blocks too.
    expect(reviewBlockReason(null, { status: "unknown" })).not.toBeNull();
    expect(
      reviewBlockReason(null, { status: "unknown", unrecognizedStatus: FUTURE_STATUS }),
    ).toContain(FUTURE_STATUS);
    // A known status, or no status yet, does not.
    expect(reviewBlockReason({ unrecognizedStatus: null }, { status: "awaiting_review" })).toBeNull();
    expect(reviewBlockReason(null, { status: null })).toBeNull();
    expect(reviewBlockReason(null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ErrorCode
// ---------------------------------------------------------------------------

describe("an unknown Core ErrorCode keeps Core's verdict", () => {
  it("parses to a generic display code with details.unrecognizedCode", () => {
    const frame = parseResponseFrame(
      '{"v":1,"id":"x","err":{"code":"RATE_LIMITED","message":"slow down"}}',
    );
    if (!("err" in frame) || frame.err === undefined) throw new Error("expected err frame");
    expect(frame.err.code).toBe(UNRECOGNIZED_CORE_CODE);
    expect(frame.err.message).toBe("slow down");
    expect(frame.err.details).toEqual({ unrecognizedCode: "RATE_LIMITED" });
  });

  it("merges Core's own object details instead of dropping them", () => {
    const frame = parseResponseFrame(
      '{"v":1,"id":"x","err":{"code":"RATE_LIMITED","message":"m","details":{"hint":"sbx login","retryAfter":3}}}',
    );
    if (!("err" in frame) || frame.err === undefined) throw new Error("expected err frame");
    expect(frame.err.details).toEqual({
      hint: "sbx login",
      retryAfter: 3,
      unrecognizedCode: "RATE_LIMITED",
    });
    const scalar = parseResponseFrame(
      '{"v":1,"id":"x","err":{"code":"RATE_LIMITED","message":"m","details":"text"}}',
    );
    if (!("err" in scalar) || scalar.err === undefined) throw new Error("expected err frame");
    expect(scalar.err.details).toEqual({ unrecognizedCode: "RATE_LIMITED", coreDetails: "text" });
  });

  it("a known code is untouched", () => {
    const frame = parseResponseFrame('{"v":1,"id":"x","err":{"code":"CONFLICT","message":"m"}}');
    expect(frame).toEqual({ v: 1, id: "x", err: { code: "CONFLICT", message: "m" } });
  });

  it("still refuses a non-string or empty code, or a missing message", () => {
    for (const err of [
      '{"code":42,"message":"m"}',
      '{"code":"","message":"m"}',
      '{"code":"RATE_LIMITED"}',
      '{"code":"RATE_LIMITED","message":7}',
    ]) {
      expect(() => parseResponseFrame(`{"v":1,"id":"x","err":${err}}`)).toThrow(MalformedFrameError);
    }
  });

  it("reaches the caller as a CORE error with Core's message, not MALFORMED_FRAME", async () => {
    const manual = new ManualTransport();
    const client = new CoreClient(manual);
    const inflight = client.request("project.list", {});
    await tick();
    manual.respondErr({ code: "RATE_LIMITED", message: "Core is throttling project.list" });
    const err = (await inflight.catch((e: unknown) => e)) as CoreRequestError;
    expect(err).toBeInstanceOf(CoreRequestError);
    expect(err.source).toBe("core");
    expect(err.code).toBe(UNRECOGNIZED_CORE_CODE);
    expect(err.code).not.toBe("MALFORMED_FRAME");
    expect(err.message).toBe("Core is throttling project.list");
    expect(err.details).toEqual({ unrecognizedCode: "RATE_LIMITED" });
    expect(client.inFlightCount).toBe(0);
    client.close();
  });

  it("is described with the raw code and Core's reason", () => {
    const err = new CoreRequestError("core", UNRECOGNIZED_CORE_CODE, "Core is throttling", {
      unrecognizedCode: "RATE_LIMITED",
      hint: "wait",
    });
    const copy = describeCoreError(err);
    expect(copy.title).toContain("RATE_LIMITED");
    expect(copy.reason).toBe("Core is throttling");
    expect(copy.hint).toBe("wait");
  });
});

// ---------------------------------------------------------------------------
// FileChange status
// ---------------------------------------------------------------------------

describe("an unknown FileChange status lists the file but never applies it", () => {
  const base = "0123456789abcdef0123456789abcdef01234567";
  const raw = {
    taskId: "t1",
    baseCommit: base,
    hostDirty: false,
    changes: [
      { path: "src/a.ts", status: "modified" },
      { path: "src/b.bin", status: "type_changed" },
      { path: "src/c.ts", status: "added" },
    ],
  };

  it("the rest of the review still decodes, the unknown entry keeps its raw status", () => {
    const changeSet = decodeChangeSet(raw);
    expect(changeSet.changes).toHaveLength(3);
    expect(changeSet.changes[0]).toEqual({ path: "src/a.ts", status: "modified" });
    expect(changeSet.changes[1]).toEqual({
      path: "src/b.bin",
      status: "unknown",
      unrecognizedStatus: "type_changed",
    });
    expect(fileChangeLabel("unknown", "type_changed")).toContain("type_changed");
    expect(fileChangeLabel("modified")).toBe("Modified");
  });

  it("still refuses a non-string status or a missing path", () => {
    expect(() =>
      decodeChangeSet({ ...raw, changes: [{ path: "p", status: 3 }] }),
    ).toThrow(MalformedFrameError);
    expect(() => decodeChangeSet({ ...raw, changes: [{ status: "added" }] })).toThrow(
      MalformedFrameError,
    );
  });

  it("whole-set apply is blocked while an unknown file is in the set", () => {
    const changeSet = decodeChangeSet(raw);
    const plan = planApply(changeSet, new Set());
    expect(plan.canApply).toBe(false);
    expect(plan.unrecognized).toEqual(["src/b.bin"]);
    expect(plan.blockedReason).toContain("type_changed");
  });

  it("an explicit selection never carries the unknown file to Core", () => {
    const changeSet = decodeChangeSet(raw);
    const plan = planApply(changeSet, new Set(["src/a.ts", "src/b.bin"]));
    expect(plan.canApply).toBe(true);
    expect(plan.selectedFiles).toEqual(["src/a.ts"]);
  });

  it("a fully known set keeps the whole-set default", () => {
    const changeSet = decodeChangeSet({ ...raw, changes: [raw.changes[0], raw.changes[2]] });
    const plan = planApply(changeSet, new Set());
    expect(plan).toMatchObject({ canApply: true, selectedFiles: undefined, unrecognized: [] });
    expect(planApply({ ...changeSet, changes: [] }, new Set()).canApply).toBe(false);
  });

  it("a successful apply reports the files actually SENT, never the unappliable one", () => {
    const changeSet = decodeChangeSet(raw);
    const plan = planApply(changeSet, new Set(["src/a.ts", "src/c.ts"]));
    const summary = reviewSummary(
      changeSet,
      { applied: true, conflictedFiles: [] },
      plan.selectedFiles?.length,
    );
    expect(summary.headline).toBe("Applied");
    expect(summary.detail).toContain("Core applied 2 file(s)");
    // Without a sent count, only recognised files are ever counted.
    expect(reviewSummary(changeSet, { applied: true, conflictedFiles: [] }).detail).toContain(
      "Core applied 2 file(s)",
    );
  });

  it("the review summary discloses how many files it cannot read", () => {
    const summary = reviewSummary(decodeChangeSet(raw), null);
    expect(summary.detail).toContain("1 file(s) have a status this build does not recognise");
  });
});

// ---------------------------------------------------------------------------
// WorkspaceMode
// ---------------------------------------------------------------------------

describe("an unknown workspace mode renders UNVERIFIED and live-writable", () => {
  it("the rest of sandbox.list still decodes", () => {
    const rows = decodeSandboxSummaries([
      { name: "a", probedState: "running", boundProjectId: null, workspaceMode: "sbx_clone" },
      { name: "b", probedState: "running", boundProjectId: null, workspaceMode: "overlay_fs" },
      { name: "c", probedState: null, boundProjectId: null },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.workspaceMode).toBe("sbx_clone");
    expect(rows[1]?.workspaceMode).toBeNull();
    expect(rows[1]?.unrecognizedWorkspaceMode).toBe("overlay_fs");
    expect(rows[2]?.workspaceMode).toBeNull();
    expect(rows[2]?.unrecognizedWorkspaceMode).toBeUndefined();
  });

  it("still refuses a non-string mode", () => {
    expect(() =>
      decodeSandboxSummaries([
        { name: "x", probedState: null, boundProjectId: null, workspaceMode: 7 },
      ]),
    ).toThrow(MalformedFrameError);
  });

  it("is never shown as isolated, and the copy names the raw mode", () => {
    const view = sandboxModeView(null, "overlay_fs");
    expect(view.verified).toBe(false);
    expect(view.liveWritable).toBe(true);
    expect(view.label).toBe(UNVERIFIED_SANDBOX_MODE_VIEW.label);
    expect(view.blurb).toContain("overlay_fs");
    expect(view.blurb).not.toContain("no recorded binding mode");
  });

  it("a task's isolation reason names the unrecognised mode instead of 'no recorded mode'", () => {
    const view = taskIsolationView({ sandboxName: "b" }, [
      { name: "b", workspaceMode: null, unrecognizedWorkspaceMode: "overlay_fs" },
    ]);
    expect(view.verified).toBe(false);
    expect(view.liveWritable).toBe(true);
    expect(view.reason).toContain("overlay_fs");
    expect(view.reason).not.toContain("no recorded workspace mode");
  });
});

// ---------------------------------------------------------------------------
// Drift: the desktop's enum lists vs the Rust sources
// ---------------------------------------------------------------------------

describe("desktop enum lists match the Rust protocol crate", () => {
  it("TASK_STATUSES is exactly Rust's TaskStatus, in order", () => {
    expect([...TASK_STATUSES]).toEqual(rustSnakeCaseEnumVariants("TaskStatus"));
  });

  it("FILE_CHANGE_STATUSES is exactly Rust's FileChangeStatus, in order", () => {
    expect([...FILE_CHANGE_STATUSES]).toEqual(rustSnakeCaseEnumVariants("FileChangeStatus"));
  });

  it("WORKSPACE_MODES is exactly Rust's WorkspaceMode, in order", () => {
    expect([...WORKSPACE_MODES]).toEqual(rustSnakeCaseEnumVariants("WorkspaceMode"));
  });

  it("the parser fails loudly on an enum it cannot find", () => {
    expect(() => rustSnakeCaseEnumVariants("NoSuchEnum")).toThrow();
  });
});
