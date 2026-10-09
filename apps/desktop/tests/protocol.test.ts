/**
 * Wire-fidelity suite.
 *
 * Every literal below is copied from an assertion in
 * `core/crates/sandpane-protocol/src/lib.rs` or a `schemas/*.json` requirement,
 * so this file is the drift check between the Rust types, the JSON schemas and
 * this TypeScript mirror (AGENTS.md §Conventions: protocol change touches
 * schemas + client types together).
 */

import { describe, expect, it } from "vitest";
import {
  decodeAgentEvent,
  decodeApplyResult,
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
  PROTOCOL_VERSION,
  TASK_STATUSES,
  WORKSPACE_MODES,
} from "../src/lib/protocol";

describe("constants match the Rust side", () => {
  it("protocol version is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("method allowlist matches schemas/rpc-request.schema.json", () => {
    expect(METHODS).toEqual([
      "system.probe",
      "project.create",
      "project.list",
      "sandbox.list",
      "sandbox.create",
      "conversation.create",
      "conversation.send",
      "task.cancel",
      "task.subscribe",
      "git.review",
      "git.apply",
    ]);
  });

  it("error codes match the schema enum", () => {
    expect(ERROR_CODES).toEqual([
      "NOT_INSTALLED",
      "DAEMON_DOWN",
      "UNSUPPORTED_SBX_VERSION",
      "PROVIDER_AUTH_REQUIRED",
      "CONFLICT",
      "TASK_INTERRUPTED",
      "PERMISSION_DENIED",
      "VALIDATION_FAILED",
      "NOT_FOUND",
      "INTERNAL",
    ]);
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
