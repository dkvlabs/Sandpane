/**
 * Follow-up to the unknown-enum tolerance change (phase review W1, S1, S3, S4,
 * S5). Each block pins one gap the review found:
 *
 * * W1 — Cancel read only the event fold's status, so a task whose Core row
 *   status is unrecognised still offered Cancel while review/apply were
 *   blocked. One pure gate now combines BOTH Core reads.
 * * S1 — a path listed twice (one recognised, one not) must not be applicable
 *   through its recognised twin.
 * * S3 — invisible / bidi / tag characters in untrusted text; code-point cap;
 *   file paths shown visibly escaped rather than silently cleaned.
 * * S4 — unrecognised tasks get their own count so the tabs add up to "All".
 * * S5 — both Core reads unrecognised but different is still a disagreement.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ChangeSet, TaskSummary } from "../src/lib/protocol";
import {
  countTasks,
  displayPath,
  emptyProjection,
  foldTaskIndex,
  indexRowEventsRead,
  planApply,
  reviewBlockReason,
  sanitizeHint,
  taskActionGate,
  taskBucket,
  type TaskProjection,
} from "../src/lib/reducers";

function projection(
  taskId: string,
  status: TaskProjection["status"],
  unrecognizedStatus: string | null = null,
): TaskProjection {
  return { ...emptyProjection(taskId), status, unrecognizedStatus, lastSequence: 3 };
}

function coreRow(id: string, status: TaskSummary["status"], raw?: string): TaskSummary {
  return {
    id,
    conversationId: "c1",
    status,
    ...(raw === undefined ? {} : { unrecognizedStatus: raw }),
  };
}

// ---------------------------------------------------------------------------
// W1 — one gate for cancel / review / apply over both Core reads
// ---------------------------------------------------------------------------

describe("taskActionGate combines Core's task row and its event log", () => {
  it("row unrecognised + events say running: cancel, review and retry are all disabled", () => {
    const [row] = foldTaskIndex(
      new Map([["t1", projection("t1", "running")]]),
      [coreRow("t1", "unknown", "future_state")],
    );
    const gate = taskActionGate(row, projection("t1", "running"));
    expect(gate.canCancel).toBe(false);
    expect(gate.canReview).toBe(false);
    expect(gate.canRetry).toBe(false);
    expect(gate.unrecognized).toBe(true);
    expect(gate.blockedReason).toContain("future_state");
    expect(gate.cancelUnavailableReason).toContain("does not recognise");
  });

  it("events unrecognised + row says running: everything disabled", () => {
    const events = projection("t1", "unknown", "future_state");
    const [row] = foldTaskIndex(new Map([["t1", events]]), [coreRow("t1", "running")]);
    const gate = taskActionGate(row, events);
    expect(gate).toMatchObject({ canCancel: false, canReview: false, canRetry: false });
    expect(gate.blockedReason).not.toBeNull();
  });

  it("a task.list row reporting unknown without a raw value still blocks", () => {
    const gate = taskActionGate(
      { status: "unknown", unrecognizedStatus: null, source: "task.list" },
      projection("t1", "running"),
    );
    expect(gate.canCancel).toBe(false);
    expect(gate.blockedReason).not.toBeNull();
  });

  it("an event-only row whose status was never reported is NOT treated as unrecognised", () => {
    const events = projection("t1", null);
    const [row] = foldTaskIndex(new Map([["t1", events]]));
    const gate = taskActionGate(row, events);
    expect(gate.unrecognized).toBe(false);
    expect(gate.blockedReason).toBeNull();
    expect(gate.canCancel).toBe(false);
    expect(gate.cancelUnavailableReason).toContain("No status has been reported");
  });

  it("both reads recognised: the event log decides, as before", () => {
    const running = projection("t1", "running");
    const [row] = foldTaskIndex(new Map([["t1", running]]), [coreRow("t1", "running")]);
    expect(taskActionGate(row, running)).toMatchObject({
      canCancel: true,
      canReview: false,
      cancelUnavailableReason: null,
      blockedReason: null,
    });
    const review = projection("t1", "awaiting_review");
    const [reviewRow] = foldTaskIndex(new Map([["t1", review]]), [coreRow("t1", "awaiting_review")]);
    expect(taskActionGate(reviewRow, review)).toMatchObject({ canCancel: false, canReview: true });
    const failed = projection("t1", "failed");
    expect(taskActionGate(null, failed)).toMatchObject({ canCancel: false, canRetry: true });
    expect(taskActionGate(null, failed).cancelUnavailableReason).toContain("terminal");
  });

  it("no projection at all: nothing to cancel, nothing blocked", () => {
    const gate = taskActionGate(null, null);
    expect(gate).toMatchObject({ canCancel: false, canReview: false, blockedReason: null });
  });

  it("its review block is exactly reviewBlockReason, so the two can never disagree", () => {
    const events = projection("t1", "running");
    const [row] = foldTaskIndex(new Map([["t1", events]]), [coreRow("t1", "unknown", "x_y")]);
    expect(taskActionGate(row, events).blockedReason).toBe(reviewBlockReason(row, events));
  });

  it("both views take cancel and review from the gate, not from the event fold alone", () => {
    for (const rel of [
      "../src/features/tasks/TasksView.tsx",
      "../src/features/project/ProjectWorkspaceView.tsx",
    ]) {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(source, rel).toContain("taskActionGate(");
      expect(source, rel).not.toMatch(/describeTaskAction\(\s*projection/);
      expect(source, rel).not.toContain("describeTaskAction");
    }
  });
});

// ---------------------------------------------------------------------------
// S1 — a duplicated path never applies its unrecognised twin
// ---------------------------------------------------------------------------

describe("planApply with a path Core listed twice", () => {
  const changeSet: ChangeSet = {
    taskId: "t1",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    hostDirty: false,
    changes: [
      { path: "src/a.ts", status: "modified" },
      { path: "src/a.ts", status: "unknown", unrecognizedStatus: "type_changed" },
      { path: "src/b.ts", status: "added" },
      { path: "src/b.ts", status: "added" },
    ],
  };

  it("selecting the recognised entry does not carry the unrecognised change", () => {
    const plan = planApply(changeSet, new Set(["src/a.ts"]));
    expect(plan.selectedFiles ?? []).not.toContain("src/a.ts");
    expect(plan.canApply).toBe(false);
    expect(plan.unrecognized).toEqual(["src/a.ts"]);
  });

  it("other files still apply, each sent once", () => {
    const plan = planApply(changeSet, new Set(["src/a.ts", "src/b.ts"]));
    expect(plan).toMatchObject({ canApply: true, selectedFiles: ["src/b.ts"] });
  });

  it("the plan always carries Core's raw path, never a display form", () => {
    const raw = "src/‮evil.ts";
    const plan = planApply(
      { ...changeSet, changes: [{ path: raw, status: "modified" }] },
      new Set([raw]),
    );
    expect(plan.selectedFiles).toEqual([raw]);
  });

  it("the review list keys entries by index, not by path alone", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/components/review/ReviewPanel.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("key={change.path}");
    expect(source).not.toContain("<Mono>{change.path}</Mono>");
    expect(source).toContain("displayPath(");
  });
});

// ---------------------------------------------------------------------------
// S3 — invisible characters, code-point cap, visibly escaped paths
// ---------------------------------------------------------------------------

describe("sanitizeHint strips every invisible / reordering character", () => {
  const hidden = [
    "؜", // Arabic letter mark
    "­", // soft hyphen
    "᠎", // Mongolian vowel separator
    "⁠", "⁡", "⁢", "⁣", "⁤",
    "￹", "￺", "￻",
    "‮", "⁦", "‏", "﻿",
  ];

  for (const ch of hidden) {
    it(`U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`, () => {
      expect(sanitizeHint(`sbx${ch}login`)).toBe("sbx login");
    });
  }

  it("tag characters (U+E0000–U+E007F) are removed", () => {
    const tagged = `sbx login${String.fromCodePoint(0xe0001, 0xe0041, 0xe007f)}`;
    expect(sanitizeHint(tagged)).toBe("sbx login");
  });

  it("caps by code points and never splits a surrogate pair", () => {
    const value = `${"a".repeat(118)}\u{1F600}${"b".repeat(20)}`;
    const out = sanitizeHint(value)!;
    expect(Array.from(out).length).toBeLessThanOrEqual(120);
    // No lone surrogate survives the cut.
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(out).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(out.endsWith("…")).toBe(true);
  });

  it("an astral-heavy value under the cap is left whole", () => {
    const value = "\u{1F600}".repeat(100);
    expect(sanitizeHint(value)).toBe(value);
  });
});

describe("displayPath escapes hidden characters visibly instead of removing them", () => {
  it("a bidi override is shown as an escape and flagged unusual", () => {
    const shown = displayPath("src/‮gnp.exe");
    expect(shown.text).toBe("src/\\u202Egnp.exe");
    expect(shown.unusual).toBe(true);
  });

  it("control characters and tag characters are escaped too", () => {
    expect(displayPath("a\nb").text).toBe("a\\u000Ab");
    expect(displayPath(`x${String.fromCodePoint(0xe0041)}`).text).toBe("x\\u{E0041}");
  });

  it("an ordinary path is untouched and not flagged", () => {
    expect(displayPath("src/components/App.tsx")).toEqual({
      text: "src/components/App.tsx",
      unusual: false,
    });
    // Ordinary non-ASCII names are not "unusual".
    expect(displayPath("docs/café.md").unusual).toBe(false);
  });

  it("an overlong path is cut visibly, by code points", () => {
    const shown = displayPath(`${"d/".repeat(600)}\u{1F600}`);
    expect(shown.text).toMatch(/… \(\d+ more characters\)$/);
    expect(shown.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("the apply-blocked reason shows the path escaped, not cleaned", () => {
    const plan = planApply(
      {
        taskId: "t1",
        baseCommit: "b",
        hostDirty: false,
        changes: [{ path: "a‮b", status: "unknown", unrecognizedStatus: "x" }],
      },
      new Set(),
    );
    expect(plan.blockedReason).toContain("a\\u202Eb");
  });
});

// ---------------------------------------------------------------------------
// S4 — unrecognised tasks are counted, so the tabs add up to "All"
// ---------------------------------------------------------------------------

describe("countTasks has an unrecognised bucket", () => {
  it("every bucket together equals the total", () => {
    const statuses = [
      "running", "queued", "awaiting_review", "awaiting_input", "completed",
      "failed", "interrupted", "cancelled", "unknown", "unknown",
    ] as const;
    const counts = countTasks(statuses.map((status) => ({ status })));
    expect(counts.unrecognized).toBe(2);
    expect(
      counts.running + counts.needsReview + counts.awaitingInput + counts.queued +
        counts.completed + counts.failed + counts.cancelled + counts.unrecognized,
    ).toBe(counts.total);
    expect(statuses.filter((s) => taskBucket(s) === "unknown")).toHaveLength(counts.unrecognized);
  });

  it("the Tasks view offers an Unrecognised filter and both status bars count it", () => {
    const tasks = readFileSync(
      fileURLToPath(new URL("../src/features/tasks/TasksView.tsx", import.meta.url)),
      "utf8",
    );
    expect(tasks).toMatch(/id: "unknown", label: `Unrecognised \$\{counts\.unrecognized\}`/);
    expect(tasks).toContain("Unrecognised {counts.unrecognized}");
    const dashboard = readFileSync(
      fileURLToPath(new URL("../src/features/dashboard/DashboardView.tsx", import.meta.url)),
      "utf8",
    );
    expect(dashboard).toContain("counts.unrecognized");
  });
});

// ---------------------------------------------------------------------------
// S5 — disagreement compares raw values too
// ---------------------------------------------------------------------------

describe("foldTaskIndex disagreement keeps raw values", () => {
  it("both sides unrecognised with different raw values is a disagreement", () => {
    const [row] = foldTaskIndex(
      new Map([["t1", projection("t1", "unknown", "state_b")]]),
      [coreRow("t1", "unknown", "state_a")],
    );
    expect(row.disagreement).toEqual({
      fromEvents: "unknown",
      fromEventsRaw: "state_b",
      fromTaskList: "unknown",
      fromTaskListRaw: "state_a",
    });
  });

  it("the same raw value on both sides is not a disagreement", () => {
    const [row] = foldTaskIndex(
      new Map([["t1", projection("t1", "unknown", "state_a")]]),
      [coreRow("t1", "unknown", "state_a")],
    );
    expect(row.disagreement).toBeNull();
  });

  it("a known vs unknown split carries the raw side", () => {
    const [row] = foldTaskIndex(
      new Map([["t1", projection("t1", "running")]]),
      [coreRow("t1", "unknown", "state_a")],
    );
    expect(row.disagreement).toEqual({
      fromEvents: "running",
      fromEventsRaw: null,
      fromTaskList: "unknown",
      fromTaskListRaw: "state_a",
    });
  });

  it("an event log that has not reported a status yet does not disagree", () => {
    const [row] = foldTaskIndex(new Map([["t1", projection("t1", null)]]), [
      coreRow("t1", "running"),
    ]);
    expect(row.disagreement).toBeNull();
  });

  it("the tooltip renders each side with its own raw value", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/features/tasks/TasksView.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("task.disagreement.fromEventsRaw");
    expect(source).toContain("task.disagreement.fromTaskListRaw");
  });
});

describe("indexRowEventsRead feeds the Tasks table the same gate", () => {
  it("an unrecognised row status disables the row's actions even when events say running", () => {
    const [row] = foldTaskIndex(
      new Map([["t1", projection("t1", "running")]]),
      [coreRow("t1", "unknown", "future_state")],
    );
    const gate = taskActionGate(row, indexRowEventsRead(row));
    expect(gate).toMatchObject({ unrecognized: true, canCancel: false });
  });

  it("an event-only row with no reported status reads as not reported", () => {
    const [row] = foldTaskIndex(new Map([["t1", projection("t1", null)]]));
    expect(indexRowEventsRead(row)).toEqual({ status: null, unrecognizedStatus: null });
    expect(taskActionGate(row, indexRowEventsRead(row)).unrecognized).toBe(false);
  });

  it("a recognised split uses the event side", () => {
    const [row] = foldTaskIndex(
      new Map([["t1", projection("t1", "running")]]),
      [coreRow("t1", "completed")],
    );
    expect(indexRowEventsRead(row)).toEqual({ status: "running", unrecognizedStatus: null });
  });
});
