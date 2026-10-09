/**
 * Narrow runtime decoders for Core `ok` payloads.
 *
 * `ok` arrives as `unknown` (the Rust side serializes `serde_json::Value`), so
 * every view goes through these guards instead of casting. A payload that does
 * not match the documented shape raises `MalformedFrameError` — the client never
 * substitutes invented defaults for missing Core data.
 */

import {
  AGENT_EVENT_TYPES,
  CORE_EVENT_KINDS,
  ERROR_CODES,
  TASK_STATUSES,
  WORKSPACE_MODES,
  type AgentEvent,
  type AgentCapability,
  type ApplyResult,
  type ChangeSet,
  type Conversation,
  type CoreCapabilities,
  type ErrorCode,
  type FileChange,
  type Project,
  type SandboxSummary,
  type TaskEvent,
  type TaskStatus,
  type TaskSummary,
  type WorkspaceMode,
} from "./protocol";
import { MalformedFrameError } from "./framing";

type Rec = Record<string, unknown>;

function asRecord(value: unknown, what: string): Rec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MalformedFrameError(`expected ${what} to be an object`);
  }
  return value as Rec;
}

function str(rec: Rec, key: string, what: string): string {
  const v = rec[key];
  if (typeof v !== "string") {
    throw new MalformedFrameError(`${what}.${key} must be a string`);
  }
  return v;
}

function optStr(rec: Rec, key: string, what: string): string | null {
  const v = rec[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    throw new MalformedFrameError(`${what}.${key} must be a string or null`);
  }
  return v;
}

function num(rec: Rec, key: string, what: string): number {
  const v = rec[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new MalformedFrameError(`${what}.${key} must be a finite number`);
  }
  return v;
}

function bool(rec: Rec, key: string, what: string): boolean {
  const v = rec[key];
  if (typeof v !== "boolean") {
    throw new MalformedFrameError(`${what}.${key} must be a boolean`);
  }
  return v;
}

function optBool(rec: Rec, key: string, what: string): boolean | null {
  const v = rec[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "boolean") {
    throw new MalformedFrameError(`${what}.${key} must be a boolean or null`);
  }
  return v;
}

function arr(rec: Rec, key: string, what: string): unknown[] {
  const v = rec[key];
  if (!Array.isArray(v)) {
    throw new MalformedFrameError(`${what}.${key} must be an array`);
  }
  return v;
}

function pickEnum<T extends string>(
  rec: Rec,
  key: string,
  what: string,
  allowed: readonly T[],
): T {
  const v = str(rec, key, what);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new MalformedFrameError(`${what}.${key} has unknown value "${v}"`);
  }
  return v as T;
}

export function decodeErrorCode(value: unknown): ErrorCode {
  if (typeof value !== "string" || !ERROR_CODES.includes(value as ErrorCode)) {
    throw new MalformedFrameError(`unknown error code: ${String(value)}`);
  }
  return value as ErrorCode;
}

export function decodeTaskStatus(value: unknown): TaskStatus {
  if (
    typeof value !== "string" ||
    !TASK_STATUSES.includes(value as TaskStatus)
  ) {
    throw new MalformedFrameError(`unknown task status: ${String(value)}`);
  }
  return value as TaskStatus;
}

export function decodeWorkspaceMode(value: unknown): WorkspaceMode {
  if (
    typeof value !== "string" ||
    !WORKSPACE_MODES.includes(value as WorkspaceMode)
  ) {
    throw new MalformedFrameError(`unknown workspace mode: ${String(value)}`);
  }
  return value as WorkspaceMode;
}

export function decodeCoreCapabilities(value: unknown): CoreCapabilities {
  const rec = asRecord(value, "CoreCapabilities");
  const sbxRaw = rec.sbx;
  let sbx = null as CoreCapabilities["sbx"];
  if (sbxRaw !== undefined && sbxRaw !== null) {
    const s = asRecord(sbxRaw, "SbxStatus");
    sbx = {
      installed: bool(s, "installed", "SbxStatus"),
      binaryPath: optStr(s, "binaryPath", "SbxStatus"),
      version: optStr(s, "version", "SbxStatus"),
      daemonRunning: optBool(s, "daemonRunning", "SbxStatus"),
    };
  }
  const agents: AgentCapability[] = arr(rec, "agents", "CoreCapabilities").map(
    (item) => {
      const a = asRecord(item, "AgentCapability");
      return {
        id: str(a, "id", "AgentCapability"),
        verified: bool(a, "verified", "AgentCapability"),
        supportsStreaming: bool(a, "supportsStreaming", "AgentCapability"),
        supportsCancel: bool(a, "supportsCancel", "AgentCapability"),
        supportsResume: bool(a, "supportsResume", "AgentCapability"),
      };
    },
  );
  return {
    protocolVersion: num(rec, "protocolVersion", "CoreCapabilities"),
    coreVersion: str(rec, "coreVersion", "CoreCapabilities"),
    instanceId: str(rec, "instanceId", "CoreCapabilities"),
    sbx,
    agents,
    platform: str(rec, "platform", "CoreCapabilities"),
  };
}

export function decodeProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) {
    throw new MalformedFrameError("project.list must return an array");
  }
  return value.map((item) => {
    const p = asRecord(item, "Project");
    return {
      id: str(p, "id", "Project"),
      name: str(p, "name", "Project"),
      description: optStr(p, "description", "Project") ?? "",
      createdAt: str(p, "createdAt", "Project"),
    };
  });
}

export function decodeProject(value: unknown): Project {
  const p = asRecord(value, "Project");
  return {
    id: str(p, "id", "Project"),
    name: str(p, "name", "Project"),
    description: optStr(p, "description", "Project") ?? "",
    createdAt: str(p, "createdAt", "Project"),
  };
}

export function decodeSandboxSummaries(value: unknown): SandboxSummary[] {
  if (!Array.isArray(value)) {
    throw new MalformedFrameError("sandbox.list must return an array");
  }
  return value.map((item) => {
    const s = asRecord(item, "SandboxSummary");
    return {
      name: str(s, "name", "SandboxSummary"),
      probedState: optStr(s, "probedState", "SandboxSummary"),
      boundProjectId: optStr(s, "boundProjectId", "SandboxSummary"),
    };
  });
}

export function decodeConversation(value: unknown): Conversation {
  const c = asRecord(value, "Conversation");
  return {
    id: str(c, "id", "Conversation"),
    projectId: str(c, "projectId", "Conversation"),
    title: str(c, "title", "Conversation"),
    agentId: str(c, "agentId", "Conversation"),
    createdAt: str(c, "createdAt", "Conversation"),
  };
}

export function decodeTaskSummary(value: unknown): TaskSummary {
  const t = asRecord(value, "TaskSummary");
  return {
    id: str(t, "id", "TaskSummary"),
    conversationId: str(t, "conversationId", "TaskSummary"),
    status: decodeTaskStatus(t.status),
    sandboxName: optStr(t, "sandboxName", "TaskSummary"),
    taskBranch: optStr(t, "taskBranch", "TaskSummary"),
    baseCommit: optStr(t, "baseCommit", "TaskSummary"),
  };
}

export function decodeTaskEvents(value: unknown): TaskEvent[] {
  if (!Array.isArray(value)) {
    throw new MalformedFrameError("task.subscribe must return an array");
  }
  return value.map((item) => {
    const e = asRecord(item, "TaskEvent");
    const sequence = num(e, "sequence", "TaskEvent");
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new MalformedFrameError("TaskEvent.sequence must be >= 1");
    }
    return {
      taskId: str(e, "taskId", "TaskEvent"),
      sequence,
      kind: str(e, "kind", "TaskEvent"),
      payload: e.payload,
      timestamp: str(e, "timestamp", "TaskEvent"),
    };
  });
}

export function decodeChangeSet(value: unknown): ChangeSet {
  const c = asRecord(value, "ChangeSet");
  const changes: FileChange[] = arr(c, "changes", "ChangeSet").map((item) => {
    const f = asRecord(item, "FileChange");
    return {
      path: str(f, "path", "FileChange"),
      status: pickEnum(f, "status", "FileChange", [
        "added",
        "modified",
        "deleted",
        "renamed",
        "untracked",
      ] as const),
    };
  });
  return {
    taskId: str(c, "taskId", "ChangeSet"),
    baseCommit: str(c, "baseCommit", "ChangeSet"),
    hostDirty: bool(c, "hostDirty", "ChangeSet"),
    changes,
  };
}

export function decodeApplyResult(value: unknown): ApplyResult {
  const a = asRecord(value, "ApplyResult");
  return {
    applied: bool(a, "applied", "ApplyResult"),
    abortReason: optStr(a, "abortReason", "ApplyResult"),
    conflictedFiles: arr(a, "conflictedFiles", "ApplyResult").map((p) => {
      if (typeof p !== "string") {
        throw new MalformedFrameError("ApplyResult.conflictedFiles items are strings");
      }
      return p;
    }),
  };
}

/**
 * Decode a normalized agent event from a TaskEvent payload.
 *
 * Returns `null` when the payload is not an agent event (Core emits several
 * non-agent kinds), and never guesses a type: an unrecognised `type` string is
 * reported through `unsupported` so the UI can label it explicitly.
 */
export function decodeAgentEvent(
  payload: unknown,
): { event: AgentEvent } | { unsupportedType: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const rec = payload as Rec;
  const type = rec.type;
  if (typeof type !== "string") return null;
  if (!(AGENT_EVENT_TYPES as readonly string[]).includes(type)) {
    return { unsupportedType: type };
  }
  switch (type) {
    case "message.delta":
      return { event: { type, text: str(rec, "text", "message.delta") } };
    case "tool.started":
      return {
        event: {
          type,
          name: str(rec, "name", "tool.started"),
          id: str(rec, "id", "tool.started"),
        },
      };
    case "tool.finished":
      return {
        event: {
          type,
          id: str(rec, "id", "tool.finished"),
          ok: bool(rec, "ok", "tool.finished"),
          summary: optStr(rec, "summary", "tool.finished") ?? undefined,
        },
      };
    case "file.changed":
      return { event: { type, path: str(rec, "path", "file.changed") } };
    case "approval.required":
      return {
        event: {
          type,
          requestId: str(rec, "requestId", "approval.required"),
          description: str(rec, "description", "approval.required"),
        },
      };
    case "task.completed":
      return { event: { type, ok: bool(rec, "ok", "task.completed") } };
    case "error":
      return {
        event: {
          type,
          code: decodeErrorCode(rec.code),
          message: str(rec, "message", "error"),
        },
      };
    case "unsupported.event":
      return {
        event: {
          type,
          providerType: str(rec, "providerType", "unsupported.event"),
        },
      };
    default:
      // `type` matched AGENT_EVENT_TYPES but no branch handled it: the type list
      // and this switch have drifted, which must fail loudly, not quietly.
      throw new MalformedFrameError(`agent event type "${type}" is not handled by the decoder`);
  }
}

/** True when a TaskEvent kind is one of the Core-emitted (non-agent) kinds. */
export function isCoreEventKind(kind: string): boolean {
  return (CORE_EVENT_KINDS as readonly string[]).includes(
    kind as (typeof CORE_EVENT_KINDS)[number],
  );
}
