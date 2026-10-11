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
  CONVERSATION_EXPORT_FORMAT,
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
  type ProjectDeleteResult,
  type Conversation,
  type ConversationDeleteResult,
  type ConversationExportPage,
  type ConversationHistoryResult,
  type CoreCapabilities,
  type ErrorCode,
  type FileChange,
  type GitDiffResult,
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

/** `{ [key]: value }` only when the value is present. */
function optField<K extends string>(key: K, value: string | null): Partial<Record<K, string>> {
  return value === null ? {} : ({ [key]: value } as Record<K, string>);
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
    // A2 features: absent stays absent (= nothing advertised). Tolerant on
    // purpose — a capability list never fails the probe: non-string entries
    // and a non-array value are dropped, which can only DISABLE a feature.
    ...(Array.isArray(rec.features)
      ? { features: rec.features.filter((f): f is string => typeof f === "string") }
      : {}),
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
  // A3a, additive: absent/null = live (and every pre-A3a Core). A present
  // non-string is malformed like any other mistyped field.
  const archivedAt = optStr(p, "archivedAt", "Project");
  return {
    id: str(p, "id", "Project"),
    name: str(p, "name", "Project"),
    description: optStr(p, "description", "Project") ?? "",
    createdAt: str(p, "createdAt", "Project"),
    ...(repositories === undefined ? {} : { repositories }),
    ...(archivedAt === null ? {} : { archivedAt }),
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
    ...(replayedMarker(s) ?? {}),
  };
}

/**
 * A2 `replayed`: an explicit `true` marks a replay; absent/null/false mean a
 * first response. A present NON-boolean does not fail the whole reply (Core
 * answered, and may have applied the write): it reads as "maybe replayed",
 * which the UI treats like a replay — re-read state, status not current.
 */
function replayedMarker(rec: Rec): { replayed: true } | { replayedUncertain: true } | null {
  const v = rec.replayed;
  if (v === true) return { replayed: true };
  if (v === undefined || v === null || v === false) return null;
  return { replayedUncertain: true };
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

/**
 * `project.delete` result (A3a): exactly one of `confirmation` (step 1) or
 * `deleted: true` (step 2). `deleted` with any other value is malformed and
 * never shown as a success. A project confirmation is always
 * `external: false` (a project exists only in Core); anything else is refused
 * rather than rendered, because no client copy exists for it.
 */
export function decodeProjectDeleteResult(value: unknown): ProjectDeleteResult {
  const r = asRecord(value, "ProjectDeleteResult");
  const hasConfirmation = r.confirmation !== undefined && r.confirmation !== null;
  const hasDeleted = r.deleted !== undefined && r.deleted !== null;
  if (hasConfirmation === hasDeleted) {
    throw new MalformedFrameError("project.delete must answer exactly one of confirmation / deleted");
  }
  if (hasDeleted) {
    if (r.deleted !== true) {
      throw new MalformedFrameError("ProjectDeleteResult.deleted must be true when present");
    }
    return { kind: "deleted" };
  }
  const confirmation = decodeConfirmationRequest(r.confirmation, "project.delete");
  if (confirmation.external) {
    throw new MalformedFrameError(
      "a project.delete confirmation must have external: false; refusing to use this token",
    );
  }
  return { kind: "confirmation", confirmation };
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
  return {
    messages: decodeMessageRecords(rec, "ConversationHistoryResult"),
    truncated: bool(rec, "truncated", "ConversationHistoryResult"),
    nextSequence: decodeNextSequence(rec, "ConversationHistoryResult"),
  };
}

/** `messages[]` with `conversation.history`'s rules (shared by A3b export pages). */
function decodeMessageRecords(rec: Rec, what: string): MessageRecord[] {
  return arr(rec, "messages", what).map((item) => {
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
  });
}

function decodeNextSequence(rec: Rec, what: string): number {
  const nextSequence = num(rec, "nextSequence", what);
  if (!Number.isInteger(nextSequence) || nextSequence < 0) {
    throw new MalformedFrameError(`${what}.nextSequence must be >= 0`);
  }
  return nextSequence;
}

export function decodeConversation(value: unknown): Conversation {
  const c = asRecord(value, "Conversation");
  // A3b, additive: absent/null = live / none stored (and every pre-A3b Core).
  // A present non-string is malformed like any other mistyped field.
  const archivedAt = optStr(c, "archivedAt", "Conversation");
  const sandboxId = optStr(c, "sandboxId", "Conversation");
  return {
    id: str(c, "id", "Conversation"),
    projectId: str(c, "projectId", "Conversation"),
    title: str(c, "title", "Conversation"),
    agentId: str(c, "agentId", "Conversation"),
    createdAt: str(c, "createdAt", "Conversation"),
    ...(archivedAt === null ? {} : { archivedAt }),
    ...(sandboxId === null ? {} : { sandboxId }),
  };
}

/**
 * `conversation.delete` result (A3b): exactly one of `confirmation` (step 1)
 * or `deleted: true` (step 2). A conversation exists only in Core, so its
 * confirmation is always `external: false`; anything else is refused rather
 * than rendered, because no client copy exists for it.
 */
export function decodeConversationDeleteResult(value: unknown): ConversationDeleteResult {
  const r = asRecord(value, "ConversationDeleteResult");
  const hasConfirmation = r.confirmation !== undefined && r.confirmation !== null;
  const hasDeleted = r.deleted !== undefined && r.deleted !== null;
  if (hasConfirmation === hasDeleted) {
    throw new MalformedFrameError(
      "conversation.delete must answer exactly one of confirmation / deleted",
    );
  }
  if (hasDeleted) {
    if (r.deleted !== true) {
      throw new MalformedFrameError("ConversationDeleteResult.deleted must be true when present");
    }
    return { kind: "deleted" };
  }
  const confirmation = decodeConfirmationRequest(r.confirmation, "conversation.delete");
  if (confirmation.external) {
    throw new MalformedFrameError(
      "a conversation.delete confirmation must have external: false; refusing to use this token",
    );
  }
  return { kind: "confirmation", confirmation };
}

/** A non-negative integer count (`u64` on the Rust side). */
function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new MalformedFrameError(`${what} must be a non-negative integer`);
  }
  return value;
}

/**
 * One `conversation.export` page (A3b). Strict: the format tag must be the v1
 * one, `bestEffort` must be `true`, counts must be non-negative integers.
 * `byKind` keys are kept as Core sent them (a kind added later is shown, not
 * refused). Error text names the field, never the payload — an export page is
 * the user's conversation and must not leak into an error surface.
 */
/**
 * One `conversation.export` page, decoded strictly. `requestedId` is the
 * conversation that was asked for: a page whose conversation, or ANY of whose
 * messages, names another one is refused (the ids are not echoed).
 */
export function decodeConversationExportPage(value: unknown, requestedId: string): ConversationExportPage {
  const rec = asRecord(value, "ConversationExportPage");
  const format = str(rec, "format", "ConversationExportPage");
  if (format !== CONVERSATION_EXPORT_FORMAT) {
    throw new MalformedFrameError(
      `ConversationExportPage.format is not ${CONVERSATION_EXPORT_FORMAT}`,
    );
  }
  const redaction = asRecord(rec.redaction, "ConversationExportPage.redaction");
  if (redaction.bestEffort !== true) {
    throw new MalformedFrameError("ExportRedaction.bestEffort must be true");
  }
  const byKindRaw = asRecord(redaction.byKind, "ExportRedaction.byKind");
  // `fromEntries` defines own data properties, so even a `__proto__` key from
  // Core stays a plain entry instead of touching the prototype.
  const byKind: Record<string, number> = Object.fromEntries(
    Object.entries(byKindRaw).map(([kind, n]) => [kind, count(n, "ExportRedaction.byKind value")]),
  );
  const conversation = decodeConversation(rec.conversation);
  if (conversation.id !== requestedId) {
    throw new MalformedFrameError("ConversationExportPage.conversation is not the requested conversation");
  }
  const messages = decodeMessageRecords(rec, "ConversationExportPage");
  if (messages.some((m) => m.conversationId !== requestedId)) {
    throw new MalformedFrameError("ConversationExportPage.messages name a conversation other than the requested one");
  }
  return {
    format: CONVERSATION_EXPORT_FORMAT,
    exportedAt: str(rec, "exportedAt", "ConversationExportPage"),
    conversation,
    messages,
    truncated: bool(rec, "truncated", "ConversationExportPage"),
    nextSequence: decodeNextSequence(rec, "ConversationExportPage"),
    redaction: {
      bestEffort: true,
      replacements: count(redaction.replacements, "ExportRedaction.replacements"),
      byKind,
    },
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
    // A4: both optional strings; absent / null stay absent. `mode` is an OPEN
    // string (an unknown value is kept and displayed, never refused).
    ...optField("mode", optStr(t, "mode", "TaskSummary")),
    ...optField("chosenSandboxName", optStr(t, "chosenSandboxName", "TaskSummary")),
    ...(replayedMarker(t) ?? {}),
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
      // A5: exact pre-rename path; absent stays absent.
      ...optField("oldPath", optStr(f, "oldPath", "FileChange")),
      // A6: open strings, kept byte for byte (never validated, trimmed or
      // case-folded): they are sent back verbatim in a `git.apply` entry.
      ...optField("taskBlob", optStr(f, "taskBlob", "FileChange")),
      ...optField("taskMode", optStr(f, "taskMode", "FileChange")),
    };
  });
  const uninspected = optStrArray(c, "uninspected", "ChangeSet");
  return {
    taskId: str(c, "taskId", "ChangeSet"),
    baseCommit: str(c, "baseCommit", "ChangeSet"),
    hostDirty: bool(c, "hostDirty", "ChangeSet"),
    changes,
    ...optField("repoPath", optStr(c, "repoPath", "ChangeSet")),
    ...(uninspected === undefined ? {} : { uninspected }),
    // A6: opaque; absent on a pre-A6 Core and on non-host_worktree tasks.
    ...optField("reviewId", optStr(c, "reviewId", "ChangeSet")),
    ...optField("hostHooksPath", optStr(c, "hostHooksPath", "ChangeSet")),
  };
}

/**
 * `git.diff` result (A5), decoded strictly. The patch is kept verbatim (it is
 * display text); no error message ever includes it or any other payload value.
 */
export function decodeGitDiffResult(value: unknown): GitDiffResult {
  const r = asRecord(value, "GitDiffResult");
  const status = tolerantEnum<FileChangeStatus>(r.status, "GitDiffResult.status", FILE_CHANGE_STATUSES);
  return {
    path: str(r, "path", "GitDiffResult"),
    ...optField("oldPath", optStr(r, "oldPath", "GitDiffResult")),
    status: status.value,
    ...("raw" in status ? { unrecognizedStatus: status.raw } : {}),
    patch: str(r, "patch", "GitDiffResult"),
    binary: bool(r, "binary", "GitDiffResult"),
    truncated: bool(r, "truncated", "GitDiffResult"),
    lossy: bool(r, "lossy", "GitDiffResult"),
    ...optField("baseBlob", optStr(r, "baseBlob", "GitDiffResult")),
    // A6 (host_worktree): the task-side blob/mode of the ONE read the patch
    // was rendered from.
    ...optField("taskBlob", optStr(r, "taskBlob", "GitDiffResult")),
    ...optField("taskMode", optStr(r, "taskMode", "GitDiffResult")),
  };
}

/**
 * `git.apply` result. The A6 fields are additive and tolerant:
 * - `partial`: absent / `null` / `false` = no partial; `true` = partial; any
 *   OTHER value is treated as a possible partial (`true`) — a garbled flag must
 *   never turn "some files may have been written" into "nothing was written".
 * - `appliedFiles` / `modeChanges` / `snapshotTree`: dropped when malformed
 *   (they only ever add detail to the copy, never change its verdict).
 * Error messages never echo payload values.
 */
export function decodeApplyResult(value: unknown): ApplyResult {
  const a = asRecord(value, "ApplyResult");
  const appliedFiles = Array.isArray(a.appliedFiles)
    ? a.appliedFiles.filter((p): p is string => typeof p === "string")
    : undefined;
  const modeChanges = Array.isArray(a.modeChanges)
    ? a.modeChanges.flatMap((m) => {
        if (typeof m !== "object" || m === null) return [];
        const r = m as Rec;
        return typeof r.path === "string" && typeof r.from === "string" && typeof r.to === "string"
          ? [{ path: r.path, from: r.from, to: r.to }]
          : [];
      })
    : undefined;
  const partial =
    a.partial === undefined || a.partial === null || a.partial === false ? undefined : true;
  return {
    applied: bool(a, "applied", "ApplyResult"),
    abortReason: optStr(a, "abortReason", "ApplyResult"),
    conflictedFiles: arr(a, "conflictedFiles", "ApplyResult").map((p) => {
      if (typeof p !== "string") {
        throw new MalformedFrameError("ApplyResult.conflictedFiles items are strings");
      }
      return p;
    }),
    ...(appliedFiles === undefined ? {} : { appliedFiles }),
    ...(modeChanges === undefined ? {} : { modeChanges }),
    ...(typeof a.snapshotTree === "string" ? { snapshotTree: a.snapshotTree } : {}),
    ...(partial === undefined ? {} : { partial }),
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
