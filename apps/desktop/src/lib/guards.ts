/**
 * Pre-flight guards for Core request params.
 *
 * Why this exists separately: AGENTS.md §Code Review rule 2 says an external
 * value must be validated BEFORE it reaches an argument vector, and rule 9 caps
 * an IPC frame. For the desktop the "argument vector" is the NDJSON frame the
 * webview writes to the Tauri proxy, so every value that came from a URL hash,
 * a text input or a stored checkpoint is checked here — before `encodeFrame`
 * runs, so an illegal request never leaves the window.
 *
 * These mirror `sandpane_service`'s own checks (`validate_scoping_id`,
 * `clamp_limit`, `validate_cursor_map`) and Core answers with the same codes
 * again. Core's verdict stays the authority (specs/06 §4); a local refusal is
 * the faster, structured one.
 */

import {
  CONFIRM_TOKEN_PATTERN,
  MAX_CURSOR_KEY_LEN,
  MAX_LIST_LIMIT,
  MAX_SCOPING_ID_LEN,
  MAX_SUBSCRIBE_CURSORS,
  TASK_STATUSES,
  type ConversationHistoryParams,
  type ConversationListParams,
  type TaskListParams,
  type TaskStatus,
  type TaskSubscribeParams,
} from "./protocol";

/** A refusal raised by this client. It is NOT a Core verdict and never claims one. */
export class CoreValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    // Same shape Core uses (`VALIDATION_FAILED: projectId: value is empty`), so
    // the user sees one consistent message whichever plane did the refusing.
    super(`${field}: ${message}`);
    this.name = "CoreValidationError";
    this.field = field;
  }
}

const utf8 = /* @__PURE__ */ new TextEncoder();

/** UTF-8 byte length — Rust measures key lengths with `str::len()`, not chars. */
export function byteLength(value: string): number {
  return utf8.encode(value).length;
}

/**
 * Unicode scalar-value count — what `chars().count()` returns in Rust.
 * `String.prototype.length` is UTF-16 code units, so a single astral-plane
 * character (emoji, `𝔵`) counts as 2 there and 1 here; comparing `.length`
 * against a Rust character bound refuses values Core accepts.
 */
export function charCount(value: string): number {
  return Array.from(value).length;
}

/**
 * `Validator::display_text` as Core applies it to a scoping id: non-empty, at
 * most `MAX_SCOPING_ID_LEN` characters, no control characters other than
 * `\n`/`\t`, no `0x7f`.
 *
 * Character count (not byte count) is deliberate: the Rust side compares
 * `chars().count()` against the limit.
 */
export function validateScopingId(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new CoreValidationError(field, "value must be a string");
  }
  if (value.length === 0) {
    throw new CoreValidationError(field, "value is empty");
  }
  if (charCount(value) > MAX_SCOPING_ID_LEN) {
    throw new CoreValidationError(
      field,
      `value exceeds max length ${MAX_SCOPING_ID_LEN}`,
    );
  }
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && ch !== "\n" && ch !== "\t") {
      throw new CoreValidationError(
        field,
        `contains a disallowed control character U+${code.toString(16).padStart(4, "0")}`,
      );
    }
    if (code === 0x7f) {
      throw new CoreValidationError(field, "contains a disallowed character U+007f");
    }
  }
  return value;
}

/**
 * An OPTIONAL scoping id: `undefined`/`null` means "unscoped" and is omitted
 * from the payload entirely (the key must not be present with a null value —
 * Rust reads a present key as `Some`). A blank string is refused instead: Core
 * proved live that `projectId: ""` is `VALIDATION_FAILED: projectId: value is
 * empty`, and without this guard a stale hash param would silently read as
 * "no conversations exist".
 */
export function optionalScopingId(
  value: string | null | undefined,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return validateScopingId(value, field);
}

/** A required id (a method whose whole result is about one row). */
export function requiredId(value: string | null | undefined, field: string): string {
  if (value === undefined || value === null) {
    throw new CoreValidationError(field, "value is required");
  }
  return validateScopingId(value, field);
}

/**
 * `sandpane-service`'s cursor normalisation: a negative or fractional sequence
 * is meaningless (event sequences are integers ≥ 1), so it is floored to 0
 * rather than refused. 0 means "from the beginning", which is safe.
 */
export function normalizeSequence(value: number | null | undefined): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CoreValidationError("afterSequence", "value must be a finite number");
  }
  return Math.max(0, Math.trunc(value));
}

/**
 * `sandpane_service::clamp_limit` — absent means "use Core's own default", so the
 * key is OMITTED rather than filled with 200; a present value is clamped into
 * `1..=MAX_LIST_LIMIT`. A negative or fractional limit is refused locally: Rust's
 * `limit` is a `u32`, and live Core answers `limit: -5` with
 * `VALIDATION_FAILED: invalid value: integer -5, expected u32`.
 */
export function clampLimit(
  limit: number | null | undefined,
  field = "limit",
): number | undefined {
  if (limit === undefined || limit === null) return undefined;
  if (typeof limit !== "number" || !Number.isFinite(limit) || !Number.isInteger(limit)) {
    throw new CoreValidationError(field, "value must be an integer");
  }
  if (limit < 0) {
    throw new CoreValidationError(field, "value must not be negative");
  }
  return Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
}

/**
 * `task.list.statuses` are Core's OWN stored values, deserialized into a closed
 * enum. An unknown status string is refused here exactly as Core would refuse it
 * — never normalized into the nearest real status. Duplicates are collapsed
 * because they carry no meaning in an SQL IN-list (Rust does the same).
 */
export function validateStatusFilter(
  statuses: readonly TaskStatus[] | undefined | null,
): TaskStatus[] | undefined {
  if (statuses === undefined || statuses === null) return undefined;
  if (!Array.isArray(statuses)) {
    throw new CoreValidationError(
      "statuses",
      "value must be an array of Core task statuses",
    );
  }
  const out: TaskStatus[] = [];
  for (const status of statuses) {
    if (!(TASK_STATUSES as readonly string[]).includes(status)) {
      throw new CoreValidationError(
        "statuses",
        `"${String(status)}" is not a Core task status — statuses are Core's own values and are never guessed`,
      );
    }
    if (!out.includes(status)) out.push(status);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * `sandpane_service::validate_cursor_map` — bounded entry count, non-empty
 * id-sized keys, non-negative cursors. Keys are compared in BYTES, matching
 * `str::len()` on the Rust side.
 */
export function validateCursorMap(
  map: Record<string, number> | null | undefined,
  field = "afterSequences",
): Record<string, number> | undefined {
  if (map === undefined || map === null) return undefined;
  if (typeof map !== "object" || Array.isArray(map)) {
    throw new CoreValidationError(field, "value must be a task id → sequence map");
  }
  const entries = Object.entries(map);
  if (entries.length === 0) return undefined;
  if (entries.length > MAX_SUBSCRIBE_CURSORS) {
    throw new CoreValidationError(
      field,
      `has ${entries.length} entries, the bound is ${MAX_SUBSCRIBE_CURSORS}`,
    );
  }
  const out: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (key.length === 0) {
      throw new CoreValidationError(
        field,
        `key must be 1..=${MAX_CURSOR_KEY_LEN} bytes`,
      );
    }
    if (byteLength(key) > MAX_CURSOR_KEY_LEN) {
      throw new CoreValidationError(
        field,
        `key must be 1..=${MAX_CURSOR_KEY_LEN} bytes`,
      );
    }
    out[key] = normalizeSequenceFor(field, key, value);
  }
  return out;
}

function normalizeSequenceFor(
  field: string,
  key: string,
  value: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CoreValidationError(field, `cursor for ${key} must be a finite number`);
  }
  return Math.max(0, Math.trunc(value));
}

// ---------------------------------------------------------------------------
// Wire payload builders — the single place each method's params object is made
// ---------------------------------------------------------------------------

/**
 * `task.subscribe` params, built with the cursor rules from
 * `TaskSubscribeParams` in Rust (mirrored exactly):
 *
 * * `taskId` present → the scalar is THE cursor and `afterSequences` is ignored
 *   by Core, so it is not put on the wire at all.
 * * `taskId` absent → `afterSequences` (when non-empty) replays each task from
 *   its own cursor; omitting it keeps the legacy shared-scalar behaviour.
 *
 * Returns a plain object with only the keys that should be serialized.
 */
export function buildTaskSubscribeParams(
  params: TaskSubscribeParams,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    afterSequence: normalizeSequence(params.afterSequence),
  };
  const projectId = optionalScopingId(params.projectId, "projectId");
  // Deliberate asymmetry, recorded honestly: `task.subscribe` does NOT validate
  // `projectId` server-side (verified live against `sandpane-service` — a blank
  // scope answers `ok []`), so a typo'd empty id would read to the user as
  // "Core has no events" while an omitted one means "every task". The desktop
  // refuses the blank case instead: the safer reading, and the same rule the
  // list methods' `optional_scoping_id` applies.
  if (projectId !== undefined) payload.projectId = projectId;

  const taskId = params.taskId;
  if (taskId !== undefined && taskId !== null) {
    payload.taskId = requiredId(taskId, "taskId");
    // Core ignores a map alongside `taskId`; sending one would imply otherwise.
    return payload;
  }

  const cursors = validateCursorMap(params.afterSequences);
  if (cursors !== undefined && Object.keys(cursors).length > 0) {
    payload.afterSequences = cursors;
  }
  return payload;
}

/** `task.list` params (`{}` is a valid global enumeration). */
export function buildTaskListParams(params: TaskListParams = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const projectId = optionalScopingId(params.projectId, "projectId");
  if (projectId !== undefined) payload.projectId = projectId;
  const statuses = validateStatusFilter(params.statuses);
  if (statuses !== undefined) payload.statuses = statuses;
  const limit = clampLimit(params.limit);
  if (limit !== undefined) payload.limit = limit;
  return payload;
}

/** `conversation.list` params. */
export function buildConversationListParams(
  params: ConversationListParams = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const projectId = optionalScopingId(params.projectId, "projectId");
  if (projectId !== undefined) payload.projectId = projectId;
  const limit = clampLimit(params.limit);
  if (limit !== undefined) payload.limit = limit;
  return payload;
}

/**
 * `conversation.history` params. `conversationId` is REQUIRED (Core's params type
 * has no default for it and live Core answers a missing one with
 * `VALIDATION_FAILED: invalid params: missing field \`conversationId\``).
 */
export function buildConversationHistoryParams(
  params: ConversationHistoryParams,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    conversationId: requiredId(params.conversationId, "conversationId"),
    afterSequence: normalizeSequence(params.afterSequence),
  };
  const limit = clampLimit(params.limit);
  if (limit !== undefined) payload.limit = limit;
  return payload;
}

// ---------------------------------------------------------------------------
// A1 sandbox lifecycle (`sandbox.stop`, `sandbox.remove`)
// ---------------------------------------------------------------------------

/** `Validator::sandbox_name`'s length bound (Sandpane's own sanity limit). */
export const ADDRESSABLE_SANDBOX_NAME_MAX = 128;

/**
 * Mirror of Core's `Validator::sandbox_name`
 * (core/crates/sandpane-core/src/validation.rs) — the rule for ADDRESSING an
 * existing sandbox, which is sbx's own documented `--name` rule: 2..=128
 * characters, only ASCII letters, digits, `-` and `.`, starting with a letter or
 * digit, and not `default` in any case. Uppercase and periods are legal because
 * sbx itself names sandboxes like `claude-My.Project`.
 *
 * Used for stop/remove ONLY. Creating a sandbox keeps the stricter wizard rule
 * (`validateSandboxName`). Drift-tested against the Rust source.
 */
export function validateAddressableSandboxName(name: string): string | null {
  if (name.length === 0) return "value is empty";
  if (charCount(name) > ADDRESSABLE_SANDBOX_NAME_MAX) {
    return `value exceeds max length ${ADDRESSABLE_SANDBOX_NAME_MAX}`;
  }
  for (const ch of name) {
    if (!/^[A-Za-z0-9.-]$/.test(ch)) {
      const code = ch.codePointAt(0) ?? 0;
      return `contains a disallowed character U+${code.toString(16).padStart(4, "0")}`;
    }
  }
  if (charCount(name) < 2) return "sandbox name must be at least two characters";
  if (!/^[A-Za-z0-9]/.test(name)) return "sandbox name must start with an ASCII letter or digit";
  if (name.toLowerCase() === "default") return "'default' is a reserved sandbox name";
  return null;
}

/**
 * A sandbox name about to reach `sandbox.stop` / `sandbox.remove`, checked with
 * Core's addressing rule BEFORE the frame is written, so sandboxes sbx named
 * itself (uppercase, periods) stay stoppable and removable. Core re-validates;
 * this is the faster local refusal.
 */
export function requireSandboxName(name: string | null | undefined): string {
  if (typeof name !== "string") {
    throw new CoreValidationError("name", "value is required");
  }
  const problem = validateAddressableSandboxName(name);
  if (problem !== null) throw new CoreValidationError("name", problem);
  return name;
}

/** `sandbox.stop` params: exactly `{ name }`. */
export function buildSandboxStopParams(name: string): { name: string } {
  return { name: requireSandboxName(name) };
}

/**
 * `sandbox.remove` STEP 1 params: exactly `{ name }` — the `confirmToken` key is
 * absent (not null, not empty), so Core issues a confirmation and changes nothing.
 */
export function buildSandboxRemoveRequestParams(name: string): { name: string } {
  return { name: requireSandboxName(name) };
}

/**
 * `sandbox.remove` STEP 2 params: `{ name, confirmToken }`. The token must have
 * the shape Core issues (64 lowercase hex); anything else is refused locally so
 * a garbled value never reaches Core. The token itself never appears in the
 * refusal text.
 */
export function buildSandboxRemoveConfirmParams(
  name: string,
  confirmToken: string,
): { name: string; confirmToken: string } {
  const checked = requireSandboxName(name);
  if (typeof confirmToken !== "string" || !CONFIRM_TOKEN_PATTERN.test(confirmToken)) {
    throw new CoreValidationError(
      "confirmToken",
      "must be the 64-character lowercase hex token Core issued in step 1",
    );
  }
  return { name: checked, confirmToken };
}
