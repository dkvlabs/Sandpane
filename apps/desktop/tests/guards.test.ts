/**
 * Guard suite for the ADDITIVE-v1 read methods.
 *
 * The rules under test were taken from MEASURED responses of the prebuilt
 * `sandpane-service` binary on this host (probe transcript in apps/desktop/README.md),
 * not from prose: blank ids are `VALIDATION_FAILED: <field>: value is empty`,
 * `limit: 0` clamps to 1, `limit: -5` is a u32 parse refusal, and an
 * `afterSequences` key must be 1..=100 BYTES.
 *
 * The other half of the contract is what the client must NOT do: a refused value
 * must never reach the socket (AGENTS rule 2 — validate before the argument),
 * which the write-counting tests below assert.
 */

import { describe, expect, it } from "vitest";
import {
  buildConversationHistoryParams,
  buildConversationListParams,
  buildTaskListParams,
  buildTaskSubscribeParams,
  clampLimit,
  CoreValidationError,
  optionalScopingId,
  validateCursorMap,
  validateScopingId,
  validateStatusFilter,
} from "../src/lib/guards";
import { MAX_LIST_LIMIT, MAX_SCOPING_ID_LEN } from "../src/lib/protocol";
import { CoreClient } from "../src/lib/core-client";
import { FakeCore } from "./support/fake-core";

describe("scoping ids mirror Core's validate_scoping_id", () => {
  it("refuses an empty id with the same message shape Core uses", () => {
    expect(() => validateScopingId("", "projectId")).toThrow(CoreValidationError);
    expect(() => validateScopingId("", "projectId")).toThrow("projectId: value is empty");
  });

  it("refuses an over-long id (Core counts characters)", () => {
    const tooLong = "p".repeat(MAX_SCOPING_ID_LEN + 1);
    expect(() => validateScopingId(tooLong, "projectId")).toThrow(
      `value exceeds max length ${MAX_SCOPING_ID_LEN}`,
    );
    expect(validateScopingId("p".repeat(MAX_SCOPING_ID_LEN), "projectId")).toHaveLength(
      MAX_SCOPING_ID_LEN,
    );
  });

  it("bounds an id by Unicode scalar values, not UTF-16 units (review 0010)", () => {
    // `Validator::display_text` compares `chars().count()`. Each 🧵 is one scalar
    // but two UTF-16 units, so `.length` would refuse an id Core accepts.
    const threads = "🧵".repeat(MAX_SCOPING_ID_LEN);
    expect(Array.from(threads).length).toBe(MAX_SCOPING_ID_LEN);
    expect(threads.length).toBe(MAX_SCOPING_ID_LEN * 2);
    expect(validateScopingId(threads, "projectId")).toBe(threads);
    expect(() => validateScopingId(`${threads}🧵`, "projectId")).toThrow(
      `value exceeds max length ${MAX_SCOPING_ID_LEN}`,
    );
  });

  it("refuses control characters but keeps newline and tab", () => {
    expect(() => validateScopingId("a\u0000b", "conversationId")).toThrow(
      "contains a disallowed control character",
    );
    expect(() => validateScopingId("a\u007Fb", "conversationId")).toThrow("U+007f");
    expect(() => validateScopingId("a\nb", "conversationId")).not.toThrow();
    expect(() => validateScopingId("a\tb", "conversationId")).not.toThrow();
  });

  it("treats absent as unscoped and OMITS the key rather than sending null", () => {
    expect(optionalScopingId(undefined, "projectId")).toBeUndefined();
    expect(optionalScopingId(null, "projectId")).toBeUndefined();
    expect(buildTaskListParams({ projectId: undefined })).toEqual({});
    expect(buildConversationListParams({ projectId: null as never })).toEqual({});
  });
});

describe("limits mirror Core's clamp_limit", () => {
  it("absent means Core's own default, so the key stays off the wire", () => {
    expect(clampLimit(undefined)).toBeUndefined();
    expect(clampLimit(null)).toBeUndefined();
    expect(buildTaskListParams({})).toEqual({});
  });

  it("clamps into 1..=MAX_LIST_LIMIT exactly as the service does", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(MAX_LIST_LIMIT)).toBe(MAX_LIST_LIMIT);
    expect(clampLimit(MAX_LIST_LIMIT + 1)).toBe(MAX_LIST_LIMIT);
    expect(clampLimit(Number.MAX_SAFE_INTEGER)).toBe(MAX_LIST_LIMIT);
  });

  it("refuses values a Rust u32 cannot hold", () => {
    expect(() => clampLimit(-5)).toThrow("value must not be negative");
    expect(() => clampLimit(1.5)).toThrow("value must be an integer");
    expect(() => clampLimit(Number.NaN)).toThrow("value must be an integer");
  });
});

describe("statuses are Core's own values, never guessed", () => {
  it("collapses duplicates and omits an empty filter", () => {
    expect(validateStatusFilter(["running", "running", "queued"])).toEqual([
      "running",
      "queued",
    ]);
    expect(validateStatusFilter([])).toBeUndefined();
    expect(buildTaskListParams({ statuses: [] })).toEqual({});
  });

  it("refuses a status Core does not define", () => {
    expect(() => validateStatusFilter(["paused" as never])).toThrow(
      "is not a Core task status",
    );
  });
});

describe("cursors are bounded and normalized before the frame", () => {
  it("refuses too many entries", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 4097; i += 1) big[`t${i}`] = 1;
    expect(() => validateCursorMap(big)).toThrow("the bound is 4096");
  });

  it("refuses an empty key and a key over 100 BYTES (not chars)", () => {
    expect(() => validateCursorMap({ "": 3 })).toThrow("key must be 1..=100 bytes");
    expect(() => validateCursorMap({ ["x".repeat(101)]: 3 })).toThrow(
      "key must be 1..=100 bytes",
    );
    // 100 multi-byte characters are 300 bytes — Rust's str::len() would reject it.
    expect(() => validateCursorMap({ ["é".repeat(100)]: 3 })).toThrow(
      "key must be 1..=100 bytes",
    );
    expect(validateCursorMap({ ["x".repeat(100)]: 3 })).toEqual({
      ["x".repeat(100)]: 3,
    });
  });

  it("floors a negative cursor to 0 like Core, and refuses a non-finite one", () => {
    expect(validateCursorMap({ a: -9 })).toEqual({ a: 0 });
    // Arrow form matters here: calling it bare would throw before `toThrow` is
    // ever reached, which is a test that silently proves nothing.
    expect(() => validateCursorMap({ a: Number.NaN })).toThrow("must be a finite number");
  });

  it("normalizes the scalar cursor the same way", () => {
    expect(buildTaskSubscribeParams({ afterSequence: -4 })).toEqual({ afterSequence: 0 });
    expect(buildTaskSubscribeParams({ afterSequence: 7.9 })).toEqual({
      afterSequence: 7,
    });
  });
});

describe("buildTaskSubscribeParams mirrors Rust's cursor rules", () => {
  it("a taskId request carries the scalar and NO map", () => {
    const payload = buildTaskSubscribeParams({
      taskId: "t1",
      projectId: "p1",
      afterSequence: 5,
      afterSequences: { t1: 9, t2: 9 },
    });
    expect(payload).toEqual({ afterSequence: 5, projectId: "p1", taskId: "t1" });
    expect(payload.afterSequences).toBeUndefined();
  });

  it("a scope request with a map omits the taskId so Core reads per-task cursors", () => {
    const payload = buildTaskSubscribeParams({
      projectId: "p1",
      afterSequence: 0,
      afterSequences: { "t-odd": 4, "t-even": 11 },
    });
    expect(payload).toEqual({
      afterSequence: 0,
      projectId: "p1",
      afterSequences: { "t-odd": 4, "t-even": 11 },
    });
  });

  it("no map keeps the legacy shared-scalar request shape byte-for-byte", () => {
    expect(
      buildTaskSubscribeParams({ projectId: "p1", afterSequence: 3, afterSequences: {} }),
    ).toEqual({ afterSequence: 3, projectId: "p1" });
  });

  it("an empty taskId is not a task scope (a blank id is refused, not sent)", () => {
    expect(() =>
      buildTaskSubscribeParams({ taskId: "", afterSequence: 1 }),
    ).toThrow("taskId: value is empty");
  });
});

describe("conversation.history params", () => {
  it("requires an id, and always sends the cursor", () => {
    expect(() => buildConversationHistoryParams({ conversationId: "" })).toThrow(
      "conversationId: value is empty",
    );
    expect(buildConversationHistoryParams({ conversationId: "c1" })).toEqual({
      conversationId: "c1",
      afterSequence: 0,
    });
  });

  it("passes a clamped limit through", () => {
    expect(
      buildConversationHistoryParams({ conversationId: "c1", limit: 900 }),
    ).toEqual({ conversationId: "c1", afterSequence: 0, limit: MAX_LIST_LIMIT });
  });
});

describe("a refused value never reaches the socket", () => {
  /**
   * The guard tests that matter: an illegal param must produce ZERO writes, so a
   * hostile or stale hash parameter cannot put a frame on the wire.
   */
  function harness() {
    const core = new FakeCore();
    const client = new CoreClient(core.transport);
    return { core, client };
  }

  it("blank projectId on conversation.list: no frame written", async () => {
    const { core, client } = harness();
    await expect(client.listConversations({ projectId: "" })).rejects.toMatchObject({
      source: "client",
      code: "INVALID_PARAMS",
      isCoreError: false,
      message: "projectId: value is empty",
    });
    expect(core.requestCount).toBe(0);
    expect(core.callsFor("conversation.list")).toBe(0);
  });

  it("blank conversationId on conversation.history: no frame written", async () => {
    const { core, client } = harness();
    await expect(
      client.getConversationHistory({ conversationId: "  ".trim() }),
    ).rejects.toThrow("conversationId: value is empty");
    expect(core.requestCount).toBe(0);
  });

  it("oversized projectId on task.list: no frame written", async () => {
    const { core, client } = harness();
    await expect(
      client.listTasks({ projectId: "p".repeat(MAX_SCOPING_ID_LEN + 1) }),
    ).rejects.toMatchObject({
      source: "client",
      code: "INVALID_PARAMS",
      message: `projectId: value exceeds max length ${MAX_SCOPING_ID_LEN}`,
    });
    expect(core.requestCount).toBe(0);
  });

  it("an unknown status filter on task.list: no frame written", async () => {
    const { core, client } = harness();
    await expect(
      client.listTasks({ statuses: ["resumed" as never] }),
    ).rejects.toThrow("is not a Core task status");
    expect(core.requestCount).toBe(0);
  });

  it("a blank-keyed cursor map on task.subscribe: no frame written", async () => {
    const { core, client } = harness();
    await expect(
      client.replayTaskEvents({ afterSequence: 0, afterSequences: { "": 4 } }),
    ).rejects.toThrow("key must be 1..=100 bytes");
    expect(core.requestCount).toBe(0);
  });

  it("a blank projectId on task.subscribe: no frame written (silent-empty scope is the bug)", async () => {
    const { core, client } = harness();
    await expect(
      client.replayTaskEvents({ projectId: "", afterSequence: 0 }),
    ).rejects.toThrow("projectId: value is empty");
    expect(core.requestCount).toBe(0);
  });

  it("maps the local refusal to a CLIENT-plane error, never a fake Core verdict", async () => {
    const { client } = harness();
    await expect(client.listConversations({ projectId: "" })).rejects.toMatchObject({
      source: "client",
      code: "INVALID_PARAMS",
      isCoreError: false,
    });
  });

  it("a clamped limit still produces exactly one frame, with the clamped value", async () => {
    const { core, client } = harness();
    await client.listConversations({ limit: 5000 });
    expect(core.callsFor("conversation.list")).toBe(1);
    expect(core.lastParams("conversation.list")).toEqual({ limit: MAX_LIST_LIMIT });
  });
});
