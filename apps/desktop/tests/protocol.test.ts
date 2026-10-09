/**
 * Wire-fidelity suite.
 *
 * The value SETS here are read from the authoritative sources (see
 * `tests/protocol-drift.test.ts` + `tests/support/rust-source.ts`), not copied
 * into this file, so the mirror cannot drift and stay green. What this file does
 * assert literally is the DECODED SHAPE of a wire payload — the exact field names
 * Core puts on the socket, pinned from the Rust structs' `serde` spelling.
 */

import { describe, expect, it } from "vitest";
import {
  decodeAgentEvent,
  decodeApplyResult,
  decodeConversationHistory,
  decodeConversations,
  decodeTaskSummaries,
  decodeChangeSet,
  decodeConversation,
  decodeCoreCapabilities,
  decodeErrorCode,
  decodeProject,
  decodeProjects,
  decodeSandboxSummaries,
  decodeTaskEvents,
  decodeTaskStatus,
  decodeTaskSummary,
  decodeWorkspaceMode,
  isCoreEventKind,
} from "../src/lib/decode";
import { MalformedFrameError } from "../src/lib/framing";
import {
  AGENT_EVENT_TYPES,
  CORE_EVENT_KINDS,
  ERROR_CODES,
  METHODS,
  coreAdvertisesMethod,
  PROTOCOL_VERSION,
  TASK_STATUSES,
  WORKSPACE_MODES,
} from "../src/lib/protocol";
import {
  readSchema,
  rustMethodAll,
  rustProtocolVersionConst,
  schemaMethodEnum,
} from "./support/rust-source";

describe("constants match the Rust side", () => {
  it("protocol version is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(rustProtocolVersionConst()).toBe(PROTOCOL_VERSION);
  });

  it("method allowlist is Core's, read from the crate and the shipped schema", () => {
    // NOT a literal in this file: a method added, renamed or dropped in Rust (or
    // in schemas/rpc-request.schema.json) fails here even though the TS mirror
    // would still be self-consistent.
    expect(METHODS).toEqual(rustMethodAll().names);
    expect(METHODS).toEqual(schemaMethodEnum());
    expect(METHODS.length).toBe(14);
  });

  it("error codes match the schema enum", () => {
    const schema = readSchema<{ properties: { err: { properties: { code: { enum: string[] } } } } }>(
      "rpc-response",
    );
    expect([...ERROR_CODES].sort()).toEqual(
      [...schema.properties.err.properties.code.enum].sort(),
    );
  });

  it("task statuses and workspace modes match the snake_case wire names", () => {
    expect(TASK_STATUSES).toContain("awaiting_review");
    expect(TASK_STATUSES).toContain("interrupted");
    expect(TASK_STATUSES).not.toContain("paused");
    expect(WORKSPACE_MODES).toEqual([
      "direct_mount",
      "sbx_clone",
      "host_worktree",
      "mountless",
    ]);
    expect(AGENT_EVENT_TYPES).toContain("unsupported.event");
    expect(CORE_EVENT_KINDS).toEqual([
      "task.created",
      "status.changed",
      "message.user",
      "adapter.unavailable",
      "scheduler.deferred",
    ]);
  });
});

describe("decodeCoreCapabilities", () => {
  const frame = {
    protocolVersion: 1,
    coreVersion: "0.1.0",
    instanceId: "6f6b0f2c",
    sbx: {
      installed: true,
      binaryPath: "/usr/local/bin/sbx",
      version: null,
      daemonRunning: null,
    },
    agents: [
      {
        id: "codex",
        verified: false,
        supportsStreaming: true,
        supportsCancel: true,
        supportsResume: false,
      },
    ],
    platform: "macos",
  };

  it("accepts the documented camelCase shape", () => {
    expect(decodeCoreCapabilities(frame)).toEqual(frame);
  });

  it("treats a missing sbx as null rather than installed:false", () => {
    const { sbx, ...rest } = frame;
    expect(sbx).toBeDefined();
    const decoded = decodeCoreCapabilities({ ...rest, sbx: null });
    expect(decoded.sbx).toBeNull();
  });

  it("rejects an invented capability field set", () => {
    expect(() => decodeCoreCapabilities({ ...frame, agents: undefined })).toThrow(
      MalformedFrameError,
    );
    expect(() => decodeCoreCapabilities({ ...frame, coreVersion: 1 })).toThrow(
      MalformedFrameError,
    );
  });

  it("never defaults `verified` to true", () => {
    const decoded = decodeCoreCapabilities(frame);
    expect(decoded.agents[0]?.verified).toBe(false);
    expect(decoded.agents[0]?.supportsResume).toBe(false);
  });
});

describe("payload decoders", () => {
  it("decodes project.list verbatim and defaults description to empty", () => {
    const rows = decodeProjects([
      { id: "p1", name: "Atlas Demo", createdAt: "2026-10-09T00:00:00Z" },
    ]);
    expect(rows).toEqual([
      { id: "p1", name: "Atlas Demo", description: "", createdAt: "2026-10-09T00:00:00Z" },
    ]);
    expect(() => decodeProjects({ not: "an array" })).toThrow(MalformedFrameError);
    expect(decodeProject(rows[0])).toEqual(rows[0]);
  });

  it("keeps sandbox.probedState nullable (last probe, never assumed)", () => {
    const rows = decodeSandboxSummaries([
      { name: "atlas-auth", probedState: null, boundProjectId: "p1" },
      { name: "nova-search", probedState: "running", boundProjectId: null },
    ]);
    expect(rows[0]?.probedState).toBeNull();
    expect(rows[1]?.probedState).toBe("running");
  });

  it("decodes conversation.create output", () => {
    expect(
      decodeConversation({
        id: "c1",
        projectId: "p1",
        title: "Auth flow",
        agentId: "codex",
        createdAt: "2026-10-09T00:00:00Z",
      }).id,
    ).toBe("c1");
  });

  it("decodes the task summary returned by conversation.send", () => {
    const summary = decodeTaskSummary({
      id: "t1",
      conversationId: "c1",
      status: "queued",
    });
    expect(summary).toMatchObject({ id: "t1", status: "queued" });
    expect(summary.sandboxName).toBeNull();
  });

  it("rejects an unknown task status instead of mapping it", () => {
    expect(() => decodeTaskSummary({ id: "t", conversationId: "c", status: "paused" })).toThrow(
      MalformedFrameError,
    );
    expect(decodeTaskStatus("awaiting_review")).toBe("awaiting_review");
    expect(() => decodeWorkspaceMode("bind_mount")).toThrow(MalformedFrameError);
    expect(() => decodeErrorCode("SOMETHING_WEIRD")).toThrow(MalformedFrameError);
  });

  it("enforces the task-event schema, including sequence >= 1", () => {
    const events = decodeTaskEvents([
      {
        taskId: "t1",
        sequence: 1,
        kind: "status.changed",
        payload: { to: "queued" },
        timestamp: "2026-10-09T00:00:00Z",
      },
    ]);
    expect(events[0]?.payload).toEqual({ to: "queued" });
    expect(() =>
      decodeTaskEvents([
        { taskId: "t1", sequence: 0, kind: "x", payload: {}, timestamp: "t" },
      ]),
    ).toThrow(/sequence/);
    expect(() =>
      decodeTaskEvents([{ taskId: "t1", kind: "x", payload: {}, timestamp: "t" }]),
    ).toThrow(MalformedFrameError);
  });

  it("decodes the git.review change set", () => {
    const changeSet = decodeChangeSet({
      taskId: "t1",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      hostDirty: true,
      changes: [{ path: "src/auth.ts", status: "modified" }],
    });
    expect(changeSet.hostDirty).toBe(true);
    expect(changeSet.changes[0]?.status).toBe("modified");
    expect(() =>
      decodeChangeSet({
        taskId: "t",
        baseCommit: "b",
        hostDirty: false,
        changes: [{ path: "p", status: "force_pushed" }],
      }),
    ).toThrow(/unknown value/);
  });

  it("decodes an aborted apply with its reason", () => {
    expect(
      decodeApplyResult({ applied: false, abortReason: "base diverged", conflictedFiles: [] }),
    ).toEqual({ applied: false, abortReason: "base diverged", conflictedFiles: [] });
    expect(() => decodeApplyResult({ applied: "yes", conflictedFiles: [] })).toThrow(
      MalformedFrameError,
    );
  });
});

describe("decodeAgentEvent — the tagged union from agent-event.schema.json", () => {
  it("round-trips every documented variant", () => {
    const cases: unknown[] = [
      { type: "message.delta", text: "he…llo" },
      { type: "tool.started", name: "read_file", id: "t1" },
      { type: "tool.finished", id: "t1", ok: true },
      { type: "tool.finished", id: "t1", ok: false, summary: "exit 1" },
      { type: "file.changed", path: "src/ünicode/ファイル.rs" },
      { type: "approval.required", requestId: "a1", description: "run tests" },
      { type: "task.completed", ok: true },
      { type: "error", code: "PROVIDER_AUTH_REQUIRED", message: "auth needed" },
      { type: "unsupported.event", providerType: "codex.weird" },
    ];
    for (const payload of cases) {
      const decoded = decodeAgentEvent(payload);
      expect(decoded).not.toBeNull();
      if (decoded && "event" in decoded) {
        expect(AGENT_EVENT_TYPES).toContain(decoded.event.type);
      }
    }
    expect(decodeAgentEvent({ type: "message.delta", text: "x" })).toEqual({
      event: { type: "message.delta", text: "x" },
    });
  });

  it("reports an unrecognised provider type without guessing it", () => {
    expect(decodeAgentEvent({ type: "plan.updated" })).toEqual({
      unsupportedType: "plan.updated",
    });
  });

  it("returns null for the non-agent core event payloads", () => {
    expect(decodeAgentEvent({ conversationId: "c1" })).toBeNull();
    expect(decodeAgentEvent("string")).toBeNull();
    expect(isCoreEventKind("adapter.unavailable")).toBe(true);
    expect(isCoreEventKind("message.delta")).toBe(false);
  });

  it("rejects an agent event missing a required field", () => {
    expect(() => decodeAgentEvent({ type: "tool.started", name: "x" })).toThrow(
      MalformedFrameError,
    );
  });
});

// ---------------------------------------------------------------------------
// ADDITIVE-v1 payloads: the mirror must read Core's real shapes
// ---------------------------------------------------------------------------

describe("additive fields deserialize from a pre-revision wire AND the new one", () => {
  const baseCaps = {
    protocolVersion: 1,
    coreVersion: "0.1.0",
    instanceId: "i",
    sbx: null,
    agents: [],
    platform: "macos",
  };

  it("keeps an absent `methods` absent — never inventing a full list", () => {
    const old = decodeCoreCapabilities(baseCaps);
    expect(old.methods).toBeUndefined();
    expect(coreAdvertisesMethod(old, "task.list")).toBe(false);
  });

  it("reads the advertised list verbatim", () => {
    const caps = decodeCoreCapabilities({ ...baseCaps, methods: [...METHODS] });
    expect(caps.methods).toEqual([...METHODS]);
    expect(coreAdvertisesMethod(caps, "conversation.history")).toBe(true);
  });

  it("refuses a non-string in the advertised list instead of filtering it", () => {
    expect(() => decodeCoreCapabilities({ ...baseCaps, methods: ["task.list", 7] })).toThrow(
      MalformedFrameError,
    );
  });

  it("Project.repositories is optional and stays undefined when Core omits it", () => {
    const before = decodeProjects([
      { id: "p1", name: "Atlas Demo", createdAt: "2026-10-09T00:00:00Z" },
    ]);
    expect(before[0]?.repositories).toBeUndefined();
    const after = decodeProjects([
      { ...before[0], repositories: ["/repos/atlas", "/repos/atlas-api"] },
    ]);
    expect(after[0]?.repositories).toEqual(["/repos/atlas", "/repos/atlas-api"]);
    // Order is Core's insertion order and must survive the round trip.
    expect(after[0]?.repositories?.[0]).toBe("/repos/atlas");
  });

  it("SandboxSummary.workspaceMode: absent is null (unverified), unknown is refused", () => {
    const rows = decodeSandboxSummaries([
      { name: "no-row", probedState: "running", boundProjectId: null },
      {
        name: "mounted",
        probedState: "running",
        boundProjectId: "p1",
        workspaceMode: "direct_mount",
      },
      {
        name: "cloned",
        probedState: null,
        boundProjectId: null,
        workspaceMode: "sbx_clone",
      },
    ]);
    expect(rows[0]?.workspaceMode).toBeNull();
    expect(rows[1]?.workspaceMode).toBe("direct_mount");
    expect(rows[2]?.workspaceMode).toBe("sbx_clone");
    expect(() =>
      decodeSandboxSummaries([
        { name: "x", probedState: null, boundProjectId: null, workspaceMode: "bind_mount" },
      ]),
    ).toThrow(MalformedFrameError);
  });
});

describe("the three new reads keep Core's envelope shapes", () => {
  it("conversation.list is an array of Conversation", () => {
    expect(
      decodeConversations([
        {
          id: "c1",
          projectId: "p1",
          title: "Auth flow",
          agentId: "codex",
          createdAt: "2026-10-09T00:00:00Z",
        },
      ]),
    ).toHaveLength(1);
    expect(() => decodeConversations({ nope: 1 })).toThrow(MalformedFrameError);
  });

  it("task.list is an array of TaskSummary with Core's stored status", () => {
    const rows = decodeTaskSummaries([
      { id: "t1", conversationId: "c1", status: "awaiting_review", baseCommit: "abc" },
    ]);
    expect(rows[0]).toMatchObject({ status: "awaiting_review", baseCommit: "abc" });
    // An unknown status is refused, not normalized to something nearby.
    expect(() =>
      decodeTaskSummaries([{ id: "t", conversationId: "c", status: "resumed" }]),
    ).toThrow(MalformedFrameError);
  });

  it("conversation.history is an OBJECT with both bounds disclosed", () => {
    const result = decodeConversationHistory({
      messages: [
        {
          id: "m1",
          conversationId: "c1",
          role: "user",
          content: "hi",
          sequence: 1,
        },
      ],
      truncated: true,
      nextSequence: 1,
    });
    expect(result.truncated).toBe(true);
    expect(result.nextSequence).toBe(1);
    expect(result.messages[0]?.content).toBe("hi");
  });

  it("a history result missing its disclosure is not accepted as complete", () => {
    expect(() =>
      decodeConversationHistory({ messages: [], nextSequence: 0 }),
    ).toThrow(MalformedFrameError);
    expect(() =>
      decodeConversationHistory({ messages: [], truncated: false }),
    ).toThrow(MalformedFrameError);
    expect(() =>
      decodeConversationHistory({
        messages: [{ id: "m", conversationId: "c", role: "user", content: "", sequence: 0 }],
        truncated: false,
        nextSequence: 0,
      }),
    ).toThrow(/sequence/);
  });
});
