/**
 * Typed wrappers for **exactly** the 28 Core methods (`sandpane_protocol::Method`
 * / `Method::ALL`). Every wrapper maps to one Core method; `sandbox.remove` has
 * two wrappers because its two confirmation steps are deliberately separate
 * calls (`sandboxRemoveRequest` never carries a token, `sandboxRemoveConfirm`
 * always does); `project.delete` and `conversation.delete` likewise
 * (`…DeleteRequest` / `…DeleteConfirm`).
 *
 * Every payload key is written in the wire spelling (camelCase), every enum in
 * its wire spelling (snake_case / SCREAMING_SNAKE). Unknown methods are
 * impossible to call: the parameter type is the `CoreMethodName` union and
 * `CoreConnection.request` re-checks it at runtime. There is no
 * "run this command" method and there never will be (specs/02 §2).
 *
 * The client-side validators below mirror `sandpane_core::validation` and the
 * `sandpane_service` bounds so an illegal value is explained before it is sent —
 * Core validates again, and its verdict is the one that counts (specs/06 §4).
 *
 * `task.list`, `conversation.list` and `conversation.history` are ADDITIVE v1
 * methods: a pre-revision Core does not dispatch them. Callers that must work
 * against any Core feature-detect with `coreAdvertisesMethod(probe, 'task.list')`
 * instead of assuming the method exists.
 *
 * `sandbox.stop` and `sandbox.remove` are A1 additions (design 2026-10-09 §3):
 * callers gate them on `coreAdvertisesMethod` too. Neither is replay-safe, so
 * neither is ever retried automatically.
 */

import { CoreConnection } from './connection';
import type {
  AgentCapability,
  ApplyResult,
  ChangeSet,
  Conversation,
  ConversationCreateParams,
  ConversationDeleteResult,
  ConversationExportParams,
  ConversationExportResult,
  ConversationHistoryParams,
  ConversationHistoryResult,
  ConversationListParams,
  ConversationRenameParams,
  ConversationSendParams,
  ConfirmationRequest,
  CoreCapabilities,
  GitApplyParams,
  Project,
  ProjectCreateParams,
  ProjectDeleteResult,
  ProjectListParams,
  ProjectRepositoryParams,
  ProjectUpdateParams,
  SandboxCreateSpec,
  SendMode,
  GitDiffParams,
  SandboxRemoveResult,
  SandboxStopResult,
  SandboxSummary,
  SbxAgent,
  TaskListParams,
  TaskSubscribeParams,
  TaskSummary,
} from './protocol';
import {
  FILE_CHANGE_STATUSES,
  MAX_DIFF_BYTES,
  SBX_AGENTS,
  SEND_MODES,
  isSbxAgent,
  MAX_CURSOR_KEY_LEN,
  MAX_LIST_LIMIT,
  MAX_SCOPING_ID_LEN,
  MAX_SUBSCRIBE_CURSORS,
} from './protocol';
import type { ErrorCode, TaskEvent, TaskStatus } from './events';
import { isTaskStatus } from './events';

/** A4: Core's exact refusal for any other `mode` (sandpane-service `MSG_SEND_MODE_INVALID`). */
export const MSG_SEND_MODE_INVALID = 'mode must be "task" or "discuss"';

/**
 * A4: exactly Core's rule — "task" or "discuss", case-sensitive, nothing
 * trimmed; `null` (like absent) means no mode. Never stricter than Core: every
 * value Core accepts passes.
 */
export function validateSendMode(mode: unknown): SendMode | undefined {
  if (mode === undefined || mode === null) return undefined;
  if (typeof mode === 'string' && (SEND_MODES as readonly string[]).includes(mode)) return mode as SendMode;
  throw new CoreValidationError('mode', MSG_SEND_MODE_INVALID);
}

/** Thrown before a request leaves the client. Never a Core verdict. */
export class CoreValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'CoreValidationError';
    this.field = field;
  }
}

/** `Validator::sandbox_name` — 1..=63, lowercase alnum + single hyphens, alnum ends. */
export function validateSandboxName(name: string): string {
  if (name.length === 0) throw new CoreValidationError('name', 'value is empty');
  if (name.length > 63) throw new CoreValidationError('name', `value exceeds max length 63`);
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new CoreValidationError(
      'name',
      'only lowercase ASCII letters, digits and single hyphens are allowed',
    );
  }
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) {
    throw new CoreValidationError('name', 'must start and end with an ASCII letter or digit');
  }
  if (name.includes('--')) {
    throw new CoreValidationError('name', 'contains the disallowed sequence "--"');
  }
  return name;
}

/** `Validator::sandbox_name`'s length bound (Sandpane's own; sbx documents none). */
export const MAX_ADDRESSABLE_SANDBOX_NAME_LEN = 128;

/**
 * `Validator::sandbox_name` in Core — the rule for ADDRESSING an existing
 * sandbox (stop / remove / pick). It follows sbx v0.47's documented `--name`
 * rule, so names sbx itself generates (`<agent>-<workdir>`, e.g. `Atlas.Demo`)
 * are reachable: 2..=128 chars of ASCII letters, digits, `-` and `.`, a leading
 * letter or digit (never read as an option), and `default` (any case) is
 * reserved. Pinned against the Rust source by `test/protocolWire.test.ts`.
 *
 * `validateSandboxName` (below) stays the stricter rule for names this client
 * CREATES.
 */
export function validateAddressableSandboxName(name: string, field = 'name'): string {
  if (typeof name !== 'string' || name.length === 0) throw new CoreValidationError(field, 'value is empty');
  if (name.length > MAX_ADDRESSABLE_SANDBOX_NAME_LEN) {
    throw new CoreValidationError(field, `value exceeds max length ${MAX_ADDRESSABLE_SANDBOX_NAME_LEN}`);
  }
  if (!/^[A-Za-z0-9.-]+$/.test(name)) {
    throw new CoreValidationError(field, 'only ASCII letters, digits, "-" and "." are allowed');
  }
  if (name.length < 2) throw new CoreValidationError(field, 'sandbox name must be at least two characters');
  if (!/^[A-Za-z0-9]/.test(name)) {
    throw new CoreValidationError(field, 'sandbox name must start with an ASCII letter or digit');
  }
  if (name.toLowerCase() === 'default') throw new CoreValidationError(field, "'default' is a reserved sandbox name");
  return name;
}

/** `MAX_PROJECT_NAME_CHARS` / `MAX_PROJECT_DESCRIPTION_CHARS` in sandpane-core (A3a). */
export const MAX_PROJECT_NAME_CHARS = 120;
export const MAX_PROJECT_DESCRIPTION_CHARS = 2000;

/**
 * Rust `char::is_control()` = general category Cc (C0, DEL, C1).
 */
function isRustControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

/**
 * `is_spoofing_format_char` in sandpane-core: line/paragraph separators, LRM,
 * RLM, ALM, the embeddings/overrides U+202A..=U+202E and the isolates
 * U+2066..=U+2069. Nothing else (Core does NOT refuse e.g. U+200B).
 */
function isSpoofingFormatChar(cp: number): boolean {
  return (
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x200e ||
    cp === 0x200f ||
    cp === 0x061c ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

/**
 * A lone UTF-16 surrogate is not a Unicode scalar value: Core's JSON decoder
 * cannot turn it into a Rust `String`, so Core refuses the whole frame. Refusing
 * it here is the same outcome, never stricter.
 */
function isLoneSurrogate(cp: number): boolean {
  return cp >= 0xd800 && cp <= 0xdfff;
}

function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * `Validator::project_name` exactly (A3a; `project.create` and
 * `project.update`): non-empty, at most 120 chars (Unicode scalar values), no
 * Cc at all (incl. `\n`, `\t`, DEL, C1), no spoofing format character.
 * Not trimmed: Core does not trim either.
 */
export function validateProjectName(value: string, field = 'name'): string {
  if (typeof value !== 'string' || value.length === 0) throw new CoreValidationError(field, 'value is empty');
  const points = Array.from(value);
  if (points.length > MAX_PROJECT_NAME_CHARS) {
    throw new CoreValidationError(field, `value exceeds max length ${MAX_PROJECT_NAME_CHARS}`);
  }
  for (const ch of points) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isRustControl(cp) || isSpoofingFormatChar(cp) || isLoneSurrogate(cp)) {
      throw new CoreValidationError(field, `contains a disallowed character ${hex(cp)}`);
    }
  }
  return value;
}

/**
 * `Validator::project_description` exactly (A3a): at most 2000 chars, `\n` is
 * the ONLY allowed control character, no spoofing format character. Empty is
 * allowed and clears the description.
 */
export function validateProjectDescription(value: string, field = 'description'): string {
  if (typeof value !== 'string') throw new CoreValidationError(field, 'value must be a string');
  const points = Array.from(value);
  if (points.length > MAX_PROJECT_DESCRIPTION_CHARS) {
    throw new CoreValidationError(field, `value exceeds max length ${MAX_PROJECT_DESCRIPTION_CHARS}`);
  }
  for (const ch of points) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((isRustControl(cp) && cp !== 0x0a) || isSpoofingFormatChar(cp) || isLoneSurrogate(cp)) {
      throw new CoreValidationError(field, `contains a disallowed character ${hex(cp)}`);
    }
  }
  return value;
}

/** `MAX_CONVERSATION_TITLE_CHARS` in sandpane-core (A3b). */
export const MAX_CONVERSATION_TITLE_CHARS = 200;

/**
 * Rust `char::is_whitespace` (Unicode White_Space) — what `str::trim` strips.
 * Deliberately NOT JavaScript's `trim()`: JS also strips U+FEFF, which Rust
 * keeps, so a JS-trim blank check would refuse a title Core accepts.
 */
export function isRustWhitespace(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** Rust `value.trim().is_empty()`. */
export function isRustBlank(value: string): boolean {
  for (const ch of value) {
    if (!isRustWhitespace(ch.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/**
 * `Validator::conversation_title` exactly (A3b): non-empty, at most 200 chars
 * (Unicode scalar values), no Cc at all (incl. `\n`, `\t`, DEL, C1), no
 * spoofing format character — the `project_name` refusals. Not trimmed.
 */
export function validateConversationTitle(value: string, field = 'title'): string {
  if (typeof value !== 'string' || value.length === 0) throw new CoreValidationError(field, 'value is empty');
  const points = Array.from(value);
  if (points.length > MAX_CONVERSATION_TITLE_CHARS) {
    throw new CoreValidationError(field, `value exceeds max length ${MAX_CONVERSATION_TITLE_CHARS}`);
  }
  for (const ch of points) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isRustControl(cp) || isSpoofingFormatChar(cp) || isLoneSurrogate(cp)) {
      throw new CoreValidationError(field, `contains a disallowed character ${hex(cp)}`);
    }
  }
  return value;
}

/**
 * The `conversation.rename` rule: Core first refuses an empty or
 * whitespace-only title (`p.title.trim().is_empty()`, Rust's White_Space), then
 * applies `Validator::conversation_title`.
 */
export function validateConversationRenameTitle(value: string, field = 'title'): string {
  if (typeof value === 'string' && isRustBlank(value)) {
    throw new CoreValidationError(field, 'must not be empty or whitespace-only');
  }
  return validateConversationTitle(value, field);
}

/** Core's `Validator::idempotency_key` bound (A2). */
export const MAX_IDEMPOTENCY_KEY_LEN = 128;

/**
 * `Validator::idempotency_key` — exactly Core's rule, never stricter: 1..=128
 * chars of `[A-Za-z0-9._-]` (ASCII, so chars = bytes = UTF-16 units).
 */
export function validateIdempotencyKey(value: unknown, field = 'idempotencyKey'): string {
  if (typeof value !== 'string' || value.length === 0) throw new CoreValidationError(field, 'value is empty');
  if (value.length > MAX_IDEMPOTENCY_KEY_LEN) {
    throw new CoreValidationError(field, `value exceeds max length ${MAX_IDEMPOTENCY_KEY_LEN}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new CoreValidationError(field, 'only ASCII letters, digits, ".", "_" and "-" are allowed');
  }
  return value;
}

/** `Validator::git_ref` — hex object id (>=7) or a conservative branch name. */
export function validateGitRef(value: string, field = 'expectedBase'): string {
  if (value.length === 0) throw new CoreValidationError(field, 'value is empty');
  if (value.length > 200) throw new CoreValidationError(field, 'value exceeds max length 200');
  if (value.length >= 7 && /^[0-9a-fA-F]+$/.test(value)) return value;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new CoreValidationError(field, 'only [A-Za-z0-9._/-] are allowed in a ref');
  }
  for (const seq of ['..', '//', '.lock', './', '/.']) {
    if (value.includes(seq)) {
      throw new CoreValidationError(field, `contains the disallowed sequence "${seq}"`);
    }
  }
  if (
    value.startsWith('-') ||
    value.startsWith('.') ||
    value.endsWith('/') ||
    value.endsWith('.')
  ) {
    throw new CoreValidationError(
      field,
      'ref may not start with "-" or "." or end with "/" or "."',
    );
  }
  return value;
}

/** `Validator::display_text` — bounded, control characters other than \n and \t rejected. */
export function validateDisplayText(value: string, max: number, field: string): string {
  if (value.length === 0) throw new CoreValidationError(field, 'value is empty');
  // Rust compares `chars().count()` (Unicode scalar values); `.length` is UTF-16
  // code units and would refuse an astral-plane value Core accepts.
  if (Array.from(value).length > max) throw new CoreValidationError(field, `value exceeds max length ${max}`);
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && ch !== '\n' && ch !== '\t') {
      throw new CoreValidationError(field, `contains a disallowed control character U+${code.toString(16)}`);
    }
    if (code === 0x7f) {
      throw new CoreValidationError(field, 'contains a disallowed character U+7f');
    }
  }
  return value;
}

/**
 * `git.apply` `selectedFiles` entries are EXACT paths as `git.review` lists them
 * (A5: a real tab, CR or newline may occur), and Core's params type
 * (`Option<Vec<String>>`) adds no rule of its own; so only an empty entry or a
 * NUL (never part of a Git path) is refused here. The frame cap still bounds it.
 */
export function validateSelectedFile(value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new CoreValidationError('selectedFiles', 'value is empty');
  if (value.includes('\0')) throw new CoreValidationError('selectedFiles', 'path contains a NUL byte');
  return value;
}

export function validateAbsoluteRepoPath(value: string, field = 'repoPath'): string {
  if (!value.startsWith('/')) {
    throw new CoreValidationError(field, `path is not absolute: ${value}`);
  }
  if (value.includes('\0')) {
    throw new CoreValidationError(field, 'path contains a NUL byte');
  }
  return value;
}

function requireId(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CoreValidationError(field, 'identifier is required');
  }
  return value.trim();
}

/**
 * `sandpane_service::validate_scoping_id` — an id that scopes a read must be
 * non-empty, control-character-free and ≤ `MAX_SCOPING_ID_LEN` **chars** (Rust
 * `Validator::display_text` counts chars). A typo'd empty `projectId` is a
 * structured refusal here, not a silently empty list that reads as "no tasks".
 */
export function validateScopingId(value: string, field: string): string {
  return validateDisplayText(value, MAX_SCOPING_ID_LEN, field);
}

/**
 * `sandpane_service::optional_scoping_id` — absent means unscoped; an empty
 * string is a client bug and is refused. Returns `undefined` so the caller
 * OMITS the key instead of sending `null`.
 */
export function optionalScopingId(value: string | null | undefined, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CoreValidationError(field, 'value must be a string or absent');
  return validateScopingId(value, field);
}

/**
 * `sandpane_service::clamp_limit` — absent → Core's own default (so we omit the
 * key rather than inventing 200 on the wire); anything else is clamped into
 * `1..=MAX_LIST_LIMIT`. A non-integer or non-finite value is refused locally:
 * Rust's `limit` is a `u32`, so `-5` and `1.5` are `VALIDATION_FAILED` at parse
 * time and must not leave this client looking like a valid request.
 */
export function clampLimit(limit: number | null | undefined, field = 'limit'): number | undefined {
  if (limit === undefined || limit === null) return undefined;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isInteger(limit)) {
    throw new CoreValidationError(field, 'limit must be an integer');
  }
  if (limit < 0) throw new CoreValidationError(field, 'limit must not be negative');
  return Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);
}

/**
 * `sandpane_service::validate_cursor_map` — bounded entries and non-empty,
 * id-sized keys. Rust measures a key in BYTES (`str::len()`), so the bound here
 * is the UTF-8 byte length, not `string.length`.
 *
 * Values: Core normalizes a cursor with `.max(0)` and ignores the entry shape
 * otherwise, so a negative cursor is normalized to 0 here rather than refused —
 * the same thing the scalar `afterSequence` already does. A non-number or a
 * non-finite number is refused locally because it is not representable in Rust's
 * `i64` and would be a parse-time `VALIDATION_FAILED` at Core.
 */
export function validateCursorMap(
  map: Record<string, number> | null | undefined,
  field = 'afterSequences',
): Record<string, number> | undefined {
  if (map === undefined || map === null) return undefined;
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw new CoreValidationError(field, 'value must be a task id → sequence map');
  }
  const entries = Object.entries(map);
  if (entries.length > MAX_SUBSCRIBE_CURSORS) {
    throw new CoreValidationError(
      field,
      `has ${entries.length} entries, the bound is ${MAX_SUBSCRIBE_CURSORS}`,
    );
  }
  const bytes = new TextEncoder();
  const out: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || bytes.encode(key).length > MAX_CURSOR_KEY_LEN) {
      throw new CoreValidationError(field, `key must be 1..=${MAX_CURSOR_KEY_LEN} bytes`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CoreValidationError(field, `cursor for ${key} must be a finite number`);
    }
    out[key] = Math.max(0, Math.trunc(value));
  }
  return out;
}

/**
 * `task.list.statuses` are Core's OWN stored status names, deserialized into a
 * closed enum — an unknown string is `VALIDATION_FAILED`, never normalized.
 * Duplicates are collapsed here because they carry no meaning in an SQL IN-list
 * and collapsing keeps the bound-parameter count finite (Rust does the same).
 */
export function validateStatusFilter(
  statuses: readonly string[] | undefined,
): TaskStatus[] | undefined {
  if (statuses === undefined || statuses === null) return undefined;
  if (!Array.isArray(statuses)) {
    throw new CoreValidationError('statuses', 'value must be an array of Core task statuses');
  }
  const out: TaskStatus[] = [];
  for (const status of statuses) {
    if (!isTaskStatus(status)) {
      throw new CoreValidationError(
        'statuses',
        `"${String(status)}" is not a Core task status — statuses are Core's own values and are never guessed`,
      );
    }
    if (!out.includes(status)) out.push(status);
  }
  return out.length > 0 ? out : undefined;
}

export interface CancelResult {
  requested: boolean;
}

/**
 * A wrapper is an async surface: a failed guard must REJECT the returned
 * promise, never throw synchronously out of a `Promise`-typed call. Kept out of
 * the class so the prototype exposes only protocol wrappers.
 */
function guarded<R>(work: () => Promise<R>): Promise<R> {
  try {
    return work();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * `sandbox.create` runs `sbx create`, which Core allows up to 300 s; the client
 * waits a little longer so Core's own timeout verdict arrives first. Every
 * other method keeps the connection's default deadline.
 */
export const SANDBOX_CREATE_TIMEOUT_MS = 330_000;

/**
 * `sandbox.stop` runs `sbx stop` (Core allows 300 s) and then re-queries
 * `sbx ls --json` (30 s): up to ~330 s inside Core, so the client waits 360 s.
 * A client timeout means the outcome is UNKNOWN, not that the stop failed.
 */
export const SANDBOX_STOP_TIMEOUT_MS = 360_000;

/**
 * Client deadline for `project.add_repository` and `project.create`: Core
 * resolves each repository's git top level with `RunLimits::QUERY` (30 s per
 * git call), longer than the 15 s default. 45 s leaves headroom for ONE such
 * call; a `project.create` with several slow repositories can still exceed it
 * (the outcome is then reported UNKNOWN, never as a failure).
 */
export const PROJECT_GIT_TIMEOUT_MS = 45_000;

/**
 * A5 (§3.5 item 5): `git.review` and `git.diff` run git under
 * `RunLimits::QUERY` (30 s per run) — the same 45 s git deadline. A single
 * `git.diff` may run git several times, so it can still exceed this; it is
 * read-only, so a timeout changed nothing.
 */
export const GIT_QUERY_TIMEOUT_MS = PROJECT_GIT_TIMEOUT_MS;

/** A5: `maxBytes` exactly as Core clamps it (1..=MAX_DIFF_BYTES); absent stays absent. */
export function clampDiffBytes(maxBytes: number | undefined): number | undefined {
  if (maxBytes === undefined || !Number.isFinite(maxBytes)) return undefined;
  return Math.min(MAX_DIFF_BYTES, Math.max(1, Math.trunc(maxBytes)));
}

/**
 * `sandbox.remove` (either step) — step 1 probes the target, step 2 runs
 * `sbx rm --force` after the token check. Client deadline 400 s. NOT replay-safe:
 * never retried automatically.
 */
export const SANDBOX_REMOVE_TIMEOUT_MS = 400_000;

/** Core's confirmation token shape: 256-bit random, 64 lowercase hex chars. */
export const CONFIRM_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** `Validator::sbx_agent` — an EXACT built-in agent name, nothing else. */
export function validateSbxAgent(value: unknown, field = 'agent'): SbxAgent {
  if (!isSbxAgent(value)) {
    throw new CoreValidationError(
      field,
      `"${String(value)}" is not a built-in sbx agent (allowed: ${SBX_AGENTS.join(', ')})`,
    );
  }
  return value;
}

export function validateConfirmToken(value: unknown, field = 'confirmToken'): string {
  if (typeof value !== 'string' || !CONFIRM_TOKEN_PATTERN.test(value)) {
    throw new CoreValidationError(field, 'not a Core confirmation token (64 lowercase hex characters)');
  }
  return value;
}

/**
 * Checks a step-1 answer before anything is shown to the user or a step 2 is
 * possible. Every check is a client verdict about Core's answer; a failure
 * means the confirmation is NOT presented and step 2 is never sent.
 */
export function parseConfirmationRequest(
  raw: unknown,
  expected: { action: string; name?: string; id?: string },
): ConfirmationRequest {
  const refuse = (why: string): never => {
    throw new CoreValidationError(
      'confirmation',
      `Core's confirmation answer was not accepted (${why}); nothing was confirmed and step 2 is not sent`,
    );
  };
  if (!raw || typeof raw !== 'object') refuse('the answer is not an object');
  const outer = raw as SandboxRemoveResult & { deleted?: unknown };
  if (outer.removed === true || outer.deleted === true) refuse('step 1 claimed the action already happened');
  const c = outer.confirmation;
  if (!c || typeof c !== 'object') refuse('no confirmation in the answer');
  const conf = c as Partial<ConfirmationRequest>;
  if (typeof conf.token !== 'string' || !CONFIRM_TOKEN_PATTERN.test(conf.token)) {
    refuse('malformed token');
  }
  if (conf.action !== expected.action) refuse(`it is for a different action`);
  const target = conf.target as Partial<ConfirmationRequest['target']> | undefined;
  if (!target || typeof target.name !== 'string' || typeof target.id !== 'string') {
    refuse('no target identity');
  }
  if (expected.name !== undefined && target?.name !== expected.name) {
    refuse('it names a different target than the one requested');
  }
  if (expected.id !== undefined && target?.id !== expected.id) {
    refuse('it is for a different target id than the one requested');
  }
  if (typeof conf.expiresAt !== 'string') refuse('no expiry');
  if (!Array.isArray(conf.impact) || !conf.impact.every((line) => typeof line === 'string')) {
    refuse('impact is not a list of lines');
  }
  if (typeof conf.external !== 'boolean') refuse('the external flag is missing');
  return {
    token: conf.token as string,
    expiresAt: conf.expiresAt as string,
    action: conf.action as string,
    target: { name: target?.name as string, id: target?.id as string },
    impact: conf.impact as string[],
    external: conf.external as boolean,
  };
}

export class CoreCommands {
  constructor(private readonly connection: CoreConnection) {}

  /** `{}` → `CoreCapabilities`. Probe identity, SBX presence and adapter gates. */
  systemProbe(): Promise<CoreCapabilities> {
    return guarded(() => this.connection.request<CoreCapabilities>('system.probe', {}));
  }

  /**
   * `{includeArchived?}` → `Project[]`. Absent / false = live projects only
   * (`{}` on the wire, exactly as before A3a); `includeArchived: true` is sent
   * only when asked for.
   */
  projectList(params: ProjectListParams = {}): Promise<Project[]> {
    return guarded(() =>
      this.connection.request<Project[]>(
        'project.list',
        params.includeArchived === true ? { includeArchived: true } : {},
      ),
    );
  }

  /** A3a: `{projectId, name?, description?}` → `Project`. At least one field. */
  projectUpdate(params: ProjectUpdateParams): Promise<Project> {
    return guarded(() => {
      const payload: Record<string, unknown> = { projectId: validateScopingId(params.projectId, 'projectId') };
      if (params.name !== undefined) payload['name'] = validateProjectName(params.name);
      if (params.description !== undefined) payload['description'] = validateProjectDescription(params.description);
      if (params.name === undefined && params.description === undefined) {
        throw new CoreValidationError('project.update', 'needs name or description');
      }
      return this.connection.request<Project>('project.update', payload);
    });
  }

  /** A3a: `{projectId}` → `Project`. Idempotent. */
  projectArchive(projectId: string): Promise<Project> {
    return guarded(() =>
      this.connection.request<Project>('project.archive', { projectId: validateScopingId(projectId, 'projectId') }),
    );
  }

  /** A3a: `{projectId}` → `Project`. Idempotent. */
  projectUnarchive(projectId: string): Promise<Project> {
    return guarded(() =>
      this.connection.request<Project>('project.unarchive', { projectId: validateScopingId(projectId, 'projectId') }),
    );
  }

  /**
   * `project.delete` STEP 1: `{projectId}` (never a token) → a checked
   * `ConfirmationRequest` bound to this project id. Core changes nothing.
   */
  projectDeleteRequest(projectId: string): Promise<ConfirmationRequest> {
    return guarded(async () => {
      const id = validateScopingId(projectId, 'projectId');
      const raw = await this.connection.request<unknown>('project.delete', { projectId: id });
      return parseConfirmationRequest(raw, { action: 'project.delete', id });
    });
  }

  /**
   * `project.delete` STEP 2: `{projectId, confirmToken}` → `{deleted: true}`.
   * Only after the user explicitly confirmed step 1. Never retried.
   */
  projectDeleteConfirm(projectId: string, confirmToken: string): Promise<ProjectDeleteResult> {
    return guarded(() =>
      this.connection.request<ProjectDeleteResult>('project.delete', {
        projectId: validateScopingId(projectId, 'projectId'),
        confirmToken: validateConfirmToken(confirmToken),
      }),
    );
  }

  /** A3a: `{projectId, path}` → `Project`. Core canonicalizes and vets the git root. */
  projectAddRepository(params: ProjectRepositoryParams): Promise<Project> {
    return guarded(() =>
      this.connection.request<Project>(
        'project.add_repository',
        {
          projectId: validateScopingId(params.projectId, 'projectId'),
          path: validateAbsoluteRepoPath(params.path, 'path'),
        },
        { timeoutMs: PROJECT_GIT_TIMEOUT_MS },
      ),
    );
  }

  /** A3a: `{projectId, path}` (absolute) → `Project`. Never touches the host repository. */
  projectRemoveRepository(params: ProjectRepositoryParams): Promise<Project> {
    return guarded(() =>
      this.connection.request<Project>('project.remove_repository', {
        projectId: validateScopingId(params.projectId, 'projectId'),
        path: validateAbsoluteRepoPath(params.path, 'path'),
      }),
    );
  }

  /** Repositories must be absolute: Core rejects anything else with VALIDATION_FAILED. */
  projectCreate(params: ProjectCreateParams): Promise<Project> {
    return guarded(() => {
      const name = validateProjectName(params.name);
      const repositories = params.repositories.map((repo) => validateAbsoluteRepoPath(repo, 'repositories'));
      return this.connection.request<Project>('project.create', { name, repositories }, { timeoutMs: PROJECT_GIT_TIMEOUT_MS });
    });
  }

  /**
   * `{}` → `SandboxSummary[]`. Real behaviour: without an `sbx` binary Core
   * answers NOT_INSTALLED, with a stopped daemon DAEMON_DOWN. Surfaced verbatim
   * by `explainCoreError`; never turned into an empty list.
   */
  sandboxList(): Promise<SandboxSummary[]> {
    return guarded(() => this.connection.request<SandboxSummary[]>('sandbox.list', {}));
  }

  sandboxCreate(spec: SandboxCreateSpec): Promise<SandboxSummary> {
    return guarded(() => {
      const name = validateSandboxName(spec.name);
      const projectId = requireId(spec.projectId, 'projectId');
      const payload: Record<string, unknown> = { name, projectId, workspaceMode: spec.workspaceMode };
      if (typeof spec.repoPath === 'string' && spec.repoPath.length > 0) {
        payload['repoPath'] = validateAbsoluteRepoPath(spec.repoPath);
      }
      // A1: sent exactly when the caller chose one (absent = Core's `shell`).
      // Only an exact built-in leaves this client; Core re-validates.
      if (spec.agent !== undefined) payload['agent'] = validateSbxAgent(spec.agent);
      // A2: present only when the caller passed one (callers pass one only
      // when Core advertises `idempotency-keys`).
      if (spec.idempotencyKey !== undefined) payload['idempotencyKey'] = validateIdempotencyKey(spec.idempotencyKey);
      return this.connection.request<SandboxSummary>('sandbox.create', payload, {
        timeoutMs: SANDBOX_CREATE_TIMEOUT_MS,
      });
    });
  }

  /**
   * `{name}` → `{stopped, requeried?}` (A1). Not destructive, no token.
   * `requeried` absent ⇒ the state is UNKNOWN (no longer listed, or the
   * re-query failed) — callers never read it as "stopped".
   */
  sandboxStop(name: string): Promise<SandboxStopResult> {
    return guarded(() =>
      this.connection.request<SandboxStopResult>(
        'sandbox.stop',
        { name: validateAddressableSandboxName(name) },
        { timeoutMs: SANDBOX_STOP_TIMEOUT_MS },
      ),
    );
  }

  /**
   * `sandbox.remove` STEP 1: `{name}` (never a token) → the server-side
   * `ConfirmationRequest`. Core changes nothing. The answer is checked by
   * `parseConfirmationRequest` (token shape, action, target name) before it is
   * returned, so a caller can only ever present a well-formed confirmation.
   */
  sandboxRemoveRequest(name: string): Promise<ConfirmationRequest> {
    return guarded(async () => {
      const validName = validateAddressableSandboxName(name);
      const raw = await this.connection.request<unknown>(
        'sandbox.remove',
        { name: validName },
        { timeoutMs: SANDBOX_REMOVE_TIMEOUT_MS },
      );
      return parseConfirmationRequest(raw, { action: 'sandbox.remove', name: validName });
    });
  }

  /**
   * `sandbox.remove` STEP 2: `{name, confirmToken}` → `{removed: true}`. Only
   * call this after the user explicitly confirmed the step-1 answer; the token
   * is single-use and bound by Core to the target's name AND sbx id. A wrong,
   * expired or reused token is Core's VALIDATION_FAILED, a same-named
   * replacement CONFLICT, a vanished sandbox NOT_FOUND. Never retried.
   */
  sandboxRemoveConfirm(name: string, confirmToken: string): Promise<SandboxRemoveResult> {
    return guarded(() =>
      this.connection.request<SandboxRemoveResult>(
        'sandbox.remove',
        { name: validateAddressableSandboxName(name), confirmToken: validateConfirmToken(confirmToken) },
        { timeoutMs: SANDBOX_REMOVE_TIMEOUT_MS },
      ),
    );
  }

  conversationCreate(params: ConversationCreateParams): Promise<Conversation> {
    return guarded(() => {
      const projectId = requireId(params.projectId, 'projectId');
      const agentId = validateDisplayText(params.agentId, 64, 'agentId');
      const payload: Record<string, unknown> = { projectId, agentId };
      if (typeof params.sandboxId === 'string' && params.sandboxId.length > 0) {
        // Core validates it with `Validator::sandbox_name` (the addressable
        // rule), so an sbx-named sandbox such as `Atlas.Demo` is accepted.
        payload['sandboxId'] = validateAddressableSandboxName(params.sandboxId, 'sandboxId');
      }
      // A3b: Core stores "Untitled conversation" for an empty or whitespace-only
      // title (Rust trim) and applies `Validator::conversation_title` to
      // anything else, unchanged — so a non-blank title is validated as is.
      payload['title'] =
        typeof params.title === 'string' && !isRustBlank(params.title) ? validateConversationTitle(params.title) : '';
      return this.connection.request<Conversation>('conversation.create', payload);
    });
  }

  /**
   * `{conversationId, content, attachments}` → `TaskSummary`.
   * `content` is data. It is never interpolated into a command anywhere in this
   * client (AGENTS.md rule 1); Core stores it and hands it to an adapter.
   */
  conversationSend(params: ConversationSendParams): Promise<TaskSummary> {
    return guarded(() => {
      const conversationId = requireId(params.conversationId, 'conversationId');
      const content = validateDisplayText(params.content, 64 * 1024, 'content');
      const attachments = params.attachments.map((ref) => ({
        kind: ref.kind,
        target: validateDisplayText(ref.target, 4096, 'attachments.target'),
      }));
      const payload: Record<string, unknown> = { conversationId, content, attachments };
      if (params.idempotencyKey !== undefined) {
        payload['idempotencyKey'] = validateIdempotencyKey(params.idempotencyKey);
      }
      // A4: Task is the default and travels as NO key; only Discuss is sent.
      if (validateSendMode(params.mode) === 'discuss') payload['mode'] = 'discuss';
      return this.connection.request<TaskSummary>('conversation.send', payload);
    });
  }

  /** `{taskId}` → `{requested}`. Cancelling is a Core decision, not ours. */
  taskCancel(taskId: string): Promise<CancelResult> {
    return guarded(() =>
      this.connection.request<CancelResult>('task.cancel', {
        taskId: requireId(taskId, 'taskId'),
      }),
    );
  }

  /**
   * Replay of durable events strictly after `afterSequence` → `TaskEvent[]`.
   *
   * Cursor rules mirrored from `TaskSubscribeParams` in Rust:
   * * `taskId` present → the scalar is the cursor and `afterSequences` is
   *   ignored by Core, so this client does not even put it on the wire.
   * * `taskId` absent → `afterSequences` (when supplied) replays each task from
   *   its OWN cursor; omitting it keeps the legacy shared-scalar behavior.
   */
  taskSubscribe(params: TaskSubscribeParams): Promise<TaskEvent[]> {
    return guarded(() => {
      const taskId = typeof params.taskId === 'string' && params.taskId.length > 0 ? params.taskId : undefined;
      const payload: Record<string, unknown> = {
        afterSequence: Math.max(0, Math.trunc(params.afterSequence)),
      };
      if (typeof params.projectId === 'string' && params.projectId.length > 0) {
        payload['projectId'] = params.projectId;
      }
      if (taskId !== undefined) {
        payload['taskId'] = taskId;
        // Core ignores a map alongside taskId; sending it would suggest otherwise.
        return this.connection.request<TaskEvent[]>('task.subscribe', payload);
      }
      const cursors = validateCursorMap(params.afterSequences);
      if (cursors !== undefined && Object.keys(cursors).length > 0) {
        payload['afterSequences'] = cursors;
      }
      return this.connection.request<TaskEvent[]>('task.subscribe', payload);
    });
  }

  /**
   * `{projectId?, statuses?, limit?}` → `TaskSummary[]`. Read-only discovery of
   * Core task state; statuses are displayed exactly as Core stores them — this
   * client computes no transitions (AGENTS.md rule 3).
   *
   * ADDITIVE v1 method: feature-detect via `coreAdvertisesMethod` before calling
   * against an unknown Core build.
   */
  taskList(params: TaskListParams = {}): Promise<TaskSummary[]> {
    return guarded(() => {
      const payload: Record<string, unknown> = {};
      const projectId = optionalScopingId(params.projectId, 'projectId');
      if (projectId !== undefined) payload['projectId'] = projectId;
      const statuses = validateStatusFilter(params.statuses);
      if (statuses !== undefined) payload['statuses'] = statuses;
      const limit = clampLimit(params.limit);
      if (limit !== undefined) payload['limit'] = limit;
      return this.connection.request<TaskSummary[]>('task.list', payload);
    });
  }

  /**
   * `{projectId?, limit?, includeArchived?}` → `Conversation[]`. Without
   * `includeArchived` Core lists live conversations only (exactly the pre-A3b
   * answer); `includeArchived: true` is sent only when asked for — callers ask
   * only when Core advertises `conversation.archive`. ADDITIVE v1 method —
   * feature-detect before calling.
   */
  conversationList(params: ConversationListParams = {}): Promise<Conversation[]> {
    return guarded(() => {
      const payload: Record<string, unknown> = {};
      const projectId = optionalScopingId(params.projectId, 'projectId');
      if (projectId !== undefined) payload['projectId'] = projectId;
      const limit = clampLimit(params.limit);
      if (limit !== undefined) payload['limit'] = limit;
      if (params.includeArchived === true) payload['includeArchived'] = true;
      return this.connection.request<Conversation[]>('conversation.list', payload);
    });
  }

  /**
   * A3b: `{conversationId, title}` → `Conversation`. Title per
   * `validateConversationRenameTitle` (Core's rule); Core refuses it on an
   * archived conversation or project. Default deadline.
   */
  conversationRename(params: ConversationRenameParams): Promise<Conversation> {
    return guarded(() =>
      this.connection.request<Conversation>('conversation.rename', {
        conversationId: validateScopingId(params.conversationId, 'conversationId'),
        title: validateConversationRenameTitle(params.title),
      }),
    );
  }

  /** A3b: `{conversationId}` → `Conversation`. Idempotent; allowed in an archived project. */
  conversationArchive(conversationId: string): Promise<Conversation> {
    return guarded(() =>
      this.connection.request<Conversation>('conversation.archive', {
        conversationId: validateScopingId(conversationId, 'conversationId'),
      }),
    );
  }

  /** A3b: `{conversationId}` → `Conversation`. Idempotent; refused in an archived project. */
  conversationUnarchive(conversationId: string): Promise<Conversation> {
    return guarded(() =>
      this.connection.request<Conversation>('conversation.unarchive', {
        conversationId: validateScopingId(conversationId, 'conversationId'),
      }),
    );
  }

  /**
   * `conversation.delete` STEP 1: `{conversationId}` (never a token) → a
   * checked `ConfirmationRequest` for this conversation id. The target NAME is
   * not required to match: Core binds the token by id, and a rename between
   * the steps is legal. Core changes nothing.
   */
  conversationDeleteRequest(conversationId: string): Promise<ConfirmationRequest> {
    return guarded(async () => {
      const id = validateScopingId(conversationId, 'conversationId');
      const raw = await this.connection.request<unknown>('conversation.delete', { conversationId: id });
      return parseConfirmationRequest(raw, { action: 'conversation.delete', id });
    });
  }

  /**
   * `conversation.delete` STEP 2: `{conversationId, confirmToken}` →
   * `{deleted: true}`. Only after the user explicitly confirmed step 1. Never
   * retried; never touches host files, worktrees, branches or sandboxes.
   */
  conversationDeleteConfirm(conversationId: string, confirmToken: string): Promise<ConversationDeleteResult> {
    return guarded(() =>
      this.connection.request<ConversationDeleteResult>('conversation.delete', {
        conversationId: validateScopingId(conversationId, 'conversationId'),
        confirmToken: validateConfirmToken(confirmToken),
      }),
    );
  }

  /**
   * A3b: `{conversationId, afterSequence, limit?}` → ONE redacted export page.
   * Read-only. The page is shape-checked by `collectConversationExport`, which
   * owns the paging loop; this wrapper never logs or inspects the content.
   */
  conversationExport(params: ConversationExportParams): Promise<ConversationExportResult> {
    return guarded(() => {
      if (typeof params.afterSequence !== 'number' || !Number.isFinite(params.afterSequence)) {
        throw new CoreValidationError('afterSequence', 'must be a finite number');
      }
      const payload: Record<string, unknown> = {
        conversationId: validateScopingId(params.conversationId, 'conversationId'),
        // Core normalises a negative cursor to 0; the client does the same.
        afterSequence: Math.max(0, Math.trunc(params.afterSequence)),
      };
      const limit = clampLimit(params.limit);
      if (limit !== undefined) payload['limit'] = limit;
      return this.connection.request<ConversationExportResult>('conversation.export', payload);
    });
  }

  /**
   * `{conversationId, afterSequence?, limit?}` → `ConversationHistoryResult` —
   * an OBJECT, not an array: `truncated` discloses whether the row limit OR the
   * byte ceiling cut the scan short, and `nextSequence` is the cursor for the
   * following page. An unknown conversation is Core's `NOT_FOUND`, never an
   * empty-but-successful answer that reads as "no messages"; since A3b an
   * ARCHIVED conversation's history is served (it stays readable).
   */
  conversationHistory(params: ConversationHistoryParams): Promise<ConversationHistoryResult> {
    return guarded(() => {
      const conversationId = validateScopingId(
        requireId(params.conversationId, 'conversationId'),
        'conversationId',
      );
      const payload: Record<string, unknown> = { conversationId };
      // Core normalises a negative cursor to 0; we normalize identically.
      payload['afterSequence'] = Math.max(0, Math.trunc(params.afterSequence ?? 0));
      const limit = clampLimit(params.limit);
      if (limit !== undefined) payload['limit'] = limit;
      return this.connection.request<ConversationHistoryResult>('conversation.history', payload);
    });
  }

  /** `{taskId}` → `ChangeSet` (base commit, dirty host flag, per-file status). */
  gitReview(taskId: string): Promise<ChangeSet> {
    return guarded(() =>
      this.connection.request<ChangeSet>(
        'git.review',
        { taskId: requireId(taskId, 'taskId') },
        { timeoutMs: GIT_QUERY_TIMEOUT_MS },
      ),
    );
  }

  /**
   * A5: `{taskId, path, status, maxBytes?}` → `GitDiffResult` (display only).
   * `path` goes out byte-for-byte as `git.review` returned it — no trimming,
   * normalizing or path validation (Core gates it against the change list,
   * so a client check could only be stricter than Core). `status` is always
   * sent. The answer is untrusted; callers shape-check it before display.
   */
  gitDiff(params: GitDiffParams): Promise<unknown> {
    return guarded(() => {
      if (typeof params.path !== 'string') throw new CoreValidationError('path', 'must be a string');
      if (!(FILE_CHANGE_STATUSES as readonly unknown[]).includes(params.status)) {
        throw new CoreValidationError('status', `must be one of ${FILE_CHANGE_STATUSES.join(', ')}`);
      }
      const payload: Record<string, unknown> = {
        taskId: requireId(params.taskId, 'taskId'),
        path: params.path,
        status: params.status,
      };
      const maxBytes = clampDiffBytes(params.maxBytes);
      if (maxBytes !== undefined) payload['maxBytes'] = maxBytes;
      return this.connection.request<unknown>('git.diff', payload, { timeoutMs: GIT_QUERY_TIMEOUT_MS });
    });
  }

  /** Explicit, base-checked Git integration. Never a file overwrite (specs/06 §6). */
  gitApply(params: GitApplyParams): Promise<ApplyResult> {
    return guarded(() => {
      const payload: Record<string, unknown> = {
        taskId: requireId(params.taskId, 'taskId'),
        expectedBase: validateGitRef(params.expectedBase),
      };
      if (Array.isArray(params.selectedFiles) && params.selectedFiles.length > 0) {
        payload['selectedFiles'] = params.selectedFiles.map(validateSelectedFile);
      }
      return this.connection.request<ApplyResult>('git.apply', payload);
    });
  }
}

/** Convenience: the adapters Core reports as actually verified (P0 gate passed). */
export function verifiedAgents(agents: AgentCapability[]): AgentCapability[] {
  return agents.filter((a) => a.verified === true);
}

/** Structured error code carried by a rejection, if any. */
export function errorCodeOf(error: unknown): ErrorCode | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z_0-9]*$/.test(code)) return code as ErrorCode;
  }
  return undefined;
}
