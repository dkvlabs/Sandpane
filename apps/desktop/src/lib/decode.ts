/**
 * Narrow runtime decoders for Core `ok` payloads.
 *
 * `ok` arrives as `unknown` (the Rust side serializes `serde_json::Value`), so
 * every view goes through these guards instead of casting. A payload that does
 * not match the documented shape raises `MalformedFrameError` — the client never
 * substitutes invented defaults for missing Core data.
 *
 * Forward compatibility (additive Core enums): a STRING enum value this build
 * does not recognise — a new task status, file-change status or workspace mode
 * from a newer Core — does not fail the whole call. It decodes to the explicit
 * `"unknown"` variant (or `null` for a workspace mode, the unverified reading)
 * with the raw value kept beside it, and is never mapped onto a known state.
 * A value of the wrong TYPE, or a missing required field, is still malformed.
 */

import {
  AGENT_EVENT_TYPES,
  CONFIRM_TOKEN_PATTERN,
  CORE_EVENT_KINDS,
  ERROR_CODES,
  FILE_CHANGE_STATUSES,
  TASK_STATUSES,
  WORKSPACE_MODES,
  type AgentEvent,
  type AgentCapability,
  type ApplyResult,
  type ChangeSet,
  type ConfirmationRequest,
  type Conversation,
  type ConversationHistoryResult,
  type CoreCapabilities,
  type ErrorCode,
  type FileChange,
  type FileChangeStatus,
  type MessageRecord,
  type Project,
  type SandboxRemoveResult,
  type SandboxStopResult,
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

/**
 * A string enum field that tolerates values added by a newer Core.
 *
 * Returns the known value, or `{ value: "unknown", raw }` for a non-empty
 * string this build does not recognise. A non-string, missing or empty value is
 * still a malformed frame: tolerance covers additive VALUES, not broken shapes.
 */
function tolerantEnum<T extends string>(
  value: unknown,
  what: string,
  allowed: readonly T[],
): { value: T } | { value: "unknown"; raw: string } {
  if (typeof value !== "string" || value.length === 0) {
    throw new MalformedFrameError(`${what} must be a non-empty string`);
  }
  if ((allowed as readonly string[]).includes(value)) return { value: value as T };
  return { value: "unknown", raw: value };
}

/**
 * An OPTIONAL string array mirroring a Rust `#[serde(default)] Vec<String>`.
 * Absent stays `undefined` — "this Core did not send the field" is a fact the UI
 * must be able to show, and inventing `[]` would read as "registered nothing".
 * A present-but-wrong-typed array is a malformed frame, never coerced.
 */
function optStrArray(
  rec: Rec,
  key: string,
  what: string,
): string[] | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new MalformedFrameError(`${what}.${key} must be an array of strings`);
  }
  return v.map((item, index) => {
    if (typeof item !== "string") {
      throw new MalformedFrameError(`${what}.${key}[${index}] must be a string`);
    }
    return item;
  });
}

export function decodeErrorCode(value: unknown): ErrorCode {
  if (typeof value !== "string" || !ERROR_CODES.includes(value as ErrorCode)) {
    throw new MalformedFrameError(`unknown error code: ${String(value)}`);
  }
  return value as ErrorCode;
}

/**
 * STRICT check: is `value` a status this build knows? Payload decoders use the
 * tolerant path (`decodeTaskSummary`) instead, so an additive status from a
 * newer Core never fails a whole `task.list` / `conversation.send`.
 */
export function decodeTaskStatus(value: unknown): TaskStatus {
  if (
    typeof value !== "string" ||
    !TASK_STATUSES.includes(value as TaskStatus)
  ) {
    throw new MalformedFrameError(`unknown task status: ${String(value)}`);
  }
  return value as TaskStatus;
}

/** STRICT check; `decodeSandboxSummaries` uses the tolerant path. */
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
    // Advertised method surface. Absent stays absent: `coreAdvertisesMethod`
    // reads that as "not advertised", which is the only safe interpretation of a
    // response from a Core that predates method advertisement.
    methods: optStrArray(rec, "methods", "CoreCapabilities"),
  };
}

export function decodeProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) {
    throw new MalformedFrameError("project.list must return an array");
  }
  return value.map((item) => decodeProjectRow(asRecord(item, "Project")));
}

export function decodeProject(value: unknown): Project {
  return decodeProjectRow(asRecord(value, "Project"));
}

function decodeProjectRow(p: Rec): Project {
  const repositories = optStrArray(p, "repositories", "Project");
  return {
    id: str(p, "id", "Project"),
    name: str(p, "name", "Project"),
    description: optStr(p, "description", "Project") ?? "",
    createdAt: str(p, "createdAt", "Project"),
    ...(repositories === undefined ? {} : { repositories }),
  };
}

export function decodeSandboxSummaries(value: unknown): SandboxSummary[] {
  if (!Array.isArray(value)) {
    throw new MalformedFrameError("sandbox.list must return an array");
  }
  return value.map((item) => decodeSandboxSummary(item));
}

/**
 * One `SandboxSummary` row (shared by `sandbox.list` and the `requeried` row of
 * `sandbox.stop`).
 */
export function decodeSandboxSummary(item: unknown): SandboxSummary {
  const s = asRecord(item, "SandboxSummary");
  // `workspaceMode` is additive and optional: absent/null means Core has no
  // readable binding row, which the UI must render as UNVERIFIED (and treat as
  // live-writable), never as safe. A PRESENT string this build does not know
  // (a mode a newer Core added) decodes to the SAME unverified reading —
  // `null` — with the raw value kept so the UI can name it; it is never
  // guessed into one of the four known modes, and never into an isolated one.
  // A present value of the wrong type is still a malformed frame.
  const rawMode = s.workspaceMode;
  const mode =
    rawMode === undefined || rawMode === null
      ? null
      : tolerantEnum(rawMode, "SandboxSummary.workspaceMode", WORKSPACE_MODES);
  // `agent` (A1) is what sbx reported — a free string, NOT checked against the
  // create allowlist (sbx may report agents Sandpane never offers) and never a
  // verification claim. Absent stays absent: no key is invented.
  const agent = optStr(s, "agent", "SandboxSummary");
  return {
    name: str(s, "name", "SandboxSummary"),
    probedState: optStr(s, "probedState", "SandboxSummary"),
    boundProjectId: optStr(s, "boundProjectId", "SandboxSummary"),
    workspaceMode: mode === null || mode.value === "unknown" ? null : mode.value,
    ...(mode !== null && "raw" in mode ? { unrecognizedWorkspaceMode: mode.raw } : {}),
    ...(agent === null ? {} : { agent }),
  };
}

/**
 * `sandbox.stop` result (A1). `requeried` ABSENT is a first-class answer — the
 * sandbox is no longer listed or the re-query failed — and stays absent, so the
 * UI shows the state as unknown instead of an assumed "stopped".
 */
export function decodeSandboxStopResult(value: unknown): SandboxStopResult {
  const r = asRecord(value, "SandboxStopResult");
  const requeried = r.requeried;
  return {
    stopped: bool(r, "stopped", "SandboxStopResult"),
    ...(requeried === undefined || requeried === null
      ? {}
      : { requeried: decodeSandboxSummary(requeried) }),
  };
}

/**
 * A server-side destructive-action confirmation. Strict on purpose — this is
 * the object a destructive step-2 request is built from, so a shape this build
 * cannot fully read must never be sent back:
 * - the token must be 64 lowercase hex (it is echoed into the next frame);
 * - `action` must be the one the caller asked about;
 * - every impact line must be a string (the dialog shows the first
 *   `MAX_IMPACT_LINES` and discloses how many more Core sent).
 * `expiresAt` is kept verbatim; an unparseable value is treated as already
 * expired by the dialog (fail closed), not rejected here.
 */
export function decodeConfirmationRequest(
  value: unknown,
  expectedAction: string,
): ConfirmationRequest {
  const c = asRecord(value, "ConfirmationRequest");
  const token = str(c, "token", "ConfirmationRequest");
  if (!CONFIRM_TOKEN_PATTERN.test(token)) {
    // The token value itself is never echoed into an error message.
    throw new MalformedFrameError("ConfirmationRequest.token is not 64 lowercase hex characters");
  }
  const action = str(c, "action", "ConfirmationRequest");
  if (action !== expectedAction) {
    throw new MalformedFrameError(
      `ConfirmationRequest.action is not ${expectedAction}; refusing to use this token`,
    );
  }
  const target = asRecord(c.target, "ConfirmationRequest.target");
  const impact = arr(c, "impact", "ConfirmationRequest").map((line, index) => {
    if (typeof line !== "string") {
      throw new MalformedFrameError(`ConfirmationRequest.impact[${index}] must be a string`);
    }
    return line;
  });
  return {
    token,
    expiresAt: str(c, "expiresAt", "ConfirmationRequest"),
    action,
    target: {
      name: str(target, "name", "ConfirmationTarget"),
      id: str(target, "id", "ConfirmationTarget"),
    },
    impact,
    external: bool(c, "external", "ConfirmationRequest"),
  };
}

/**
 * `sandbox.remove` result: exactly one of `confirmation` (step 1) or
 * `removed: true` (step 2). `removed` present with any value other than `true`
 * is malformed — it is never shown as a success.
 */
export function decodeSandboxRemoveResult(value: unknown): SandboxRemoveResult {
  const r = asRecord(value, "SandboxRemoveResult");
  const hasConfirmation = r.confirmation !== undefined && r.confirmation !== null;
  const hasRemoved = r.removed !== undefined && r.removed !== null;
  if (hasConfirmation === hasRemoved) {
    throw new MalformedFrameError(
      "sandbox.remove must answer exactly one of confirmation / removed",
    );
  }
  if (hasRemoved) {
    if (r.removed !== true) {
      throw new MalformedFrameError("SandboxRemoveResult.removed must be true when present");
    }
    return { kind: "removed" };
  }
  return {
    kind: "confirmation",
    confirmation: decodeConfirmationRequest(r.confirmation, "sandbox.remove"),
  };
}

export function decodeConversations(value: unknown): Conversation[] {
  if (!Array.isArray(value)) {
    throw new MalformedFrameError("conversation.list must return an array");
  }
  return value.map((item) => decodeConversation(asRecord(item, "Conversation")));
}

export function decodeTaskSummaries(value: unknown): TaskSummary[] {
  if (!Array.isArray(value)) {
    throw new MalformedFrameError("task.list must return an array");
  }
  return value.map((item) => decodeTaskSummary(asRecord(item, "TaskSummary")));
}

/**
 * `conversation.history` returns an OBJECT with both bounds disclosed — the
 * decoder enforces that shape so a `truncated` page can never be mistaken for a
 * complete transcript (AGENTS rule 5: no unverified completeness claim).
 */
export function decodeConversationHistory(value: unknown): ConversationHistoryResult {
  const rec = asRecord(value, "ConversationHistoryResult");
  const messages: MessageRecord[] = arr(rec, "messages", "ConversationHistoryResult").map(
    (item) => {
      const m = asRecord(item, "MessageRecord");
      const sequence = num(m, "sequence", "MessageRecord");
      if (!Number.isInteger(sequence) || sequence < 1) {
        throw new MalformedFrameError("MessageRecord.sequence must be an integer >= 1");
      }
      return {
        id: str(m, "id", "MessageRecord"),
        conversationId: str(m, "conversationId", "MessageRecord"),
        role: str(m, "role", "MessageRecord"),
        content: str(m, "content", "MessageRecord"),
        sequence,
      };
    },
  );
  const nextSequence = num(rec, "nextSequence", "ConversationHistoryResult");
  if (!Number.isInteger(nextSequence) || nextSequence < 0) {
    throw new MalformedFrameError("ConversationHistoryResult.nextSequence must be >= 0");
  }
  return {
    messages,
    truncated: bool(rec, "truncated", "ConversationHistoryResult"),
    nextSequence,
  };
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
  // An additive status from a newer Core keeps its raw value and is NEVER
  // mapped onto a known state; see `TaskSummary.status`.
  const status = tolerantEnum(t.status, "TaskSummary.status", TASK_STATUSES);
  return {
    id: str(t, "id", "TaskSummary"),
    conversationId: str(t, "conversationId", "TaskSummary"),
    status: status.value,
    ...("raw" in status ? { unrecognizedStatus: status.raw } : {}),
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
    const path = str(f, "path", "FileChange");
    // One unrecognised status must not hide the rest of the review; that file
    // stays listed with its raw status and is never selectable for apply.
    const status = tolerantEnum<FileChangeStatus>(
      f.status,
      "FileChange.status",
      FILE_CHANGE_STATUSES,
    );
    return {
      path,
      status: status.value,
      ...("raw" in status ? { unrecognizedStatus: status.raw } : {}),
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
