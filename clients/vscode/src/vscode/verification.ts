/**
 * Pure helpers for A7 (verification commands + `project.context`, design
 * 2026-10-09 §3.7). No `vscode` import.
 *
 * The flows they serve (wired in `session.ts`) are reached ONLY from a user
 * gesture on Sandpane's own controls. No entry point takes argv, a commandId
 * or a runId from a `command:` URI, `executeCommand` arguments, chat, agent
 * or tool text, an event, a reconnect or a timer: every dialog is filled from
 * a fresh Core read (§3.7 item 8).
 *
 * Rendering rules (§3.7 item 6): labels, argv, notes, sandbox names, repo
 * paths and output are UNTRUSTED. They are shown as plain text only —
 * never HTML, never Markdown, never in a terminal, pty or console widget —
 * with every control character except LF and TAB (and every bidi / invisible
 * character) escaped visibly, CR as `\r`, and `$(` / `](` broken where a
 * VS Code surface would render them.
 *
 * Honesty rules: exit status 0 is never "passed" (I4); a lost run answer says
 * the run MAY have started; `UNSUPPORTED_SBX_VERSION` is not a failure of the
 * command; nothing claims more than Core said.
 */

import { CoreRpcError, CoreTransportError } from '../core-client/connection';
import { CoreValidationError, validateVerificationArgv } from '../core-client/commands';
import { classifyKeyedConflict, isProvablyUnsent, keyedConflictCopy } from '../core-client/idempotency';
import { isWorkspaceMode } from '../core-client/protocol';
import type {
  CoreFeature,
  CoreMethodName,
  OutputRedaction,
  ProjectContextResult,
  RepositoryContext,
  SandboxSummary,
  VerificationCommand,
  VerificationResult,
  VerificationRunResult,
  WorkspaceMode,
} from '../core-client/protocol';
import { isHiddenCodePoint, plainText, revealKeepingTabs } from '../text/visibleText';
import { matchesTemplate, noIcons } from './gitApply';

/** The feature an A7 Core advertises (`sandpane_protocol::FEATURES`). */
export const VERIFICATION_FEATURE: CoreFeature = 'verification';

/** Scheme of the read-only result / argument-list documents (in memory, never on disk). */
export const VERIFICATION_SCHEME = 'sandpane-verification';
/**
 * Language id of those documents: a dedicated, grammar-less language so the
 * manifest's `configurationDefaults` can turn the editor's link detection off
 * for it (`"[sandpane-verification-output]": {"editor.links": false}`).
 */
export const VERIFICATION_LANGUAGE = 'sandpane-verification-output';
/**
 * The file extension package.json maps to `VERIFICATION_LANGUAGE`; the
 * virtual document paths end with it, so a view never opens as plaintext
 * first (review W3b).
 */
export const VERIFICATION_EXTENSION = '.sandpane-verification';

/** Outcome strings (sandpane-core verification.rs). OPEN on the wire. */
export const OUTCOMES = {
  running: 'running',
  exited: 'exited',
  signaled: 'signaled',
  timed_out: 'timed_out',
  spawn_failed: 'spawn_failed',
  read_failed: 'read_failed',
  possibly_sbx_error: 'possibly_sbx_error',
  interrupted: 'interrupted',
} as const;

// --- Core's exact messages (sandpane-service / sandpane-core verification.rs; drift-tested) ---

export const MSG_VERIFICATION_NOT_BOUND = 'this task is not bound to a sandbox; nothing was run';
export const MSG_VERIFICATION_SANDBOX_CHANGED = "the task's sandbox changed since you confirmed; nothing was run";
export const MSG_VERIFICATION_IDENTITY = "Core cannot confirm the sandbox's identity; nothing was run";
export const MSG_VERIFICATION_TASK_BUSY =
  'a verification is already running for this task; wait for it to finish; nothing was run';
export const MSG_VERIFICATION_SANDBOX_BUSY =
  'a verification is already running in this sandbox; wait for it to finish; nothing was run';
export const MSG_VERIFICATION_CORE_BUSY =
  "a verification is already running in each of Core's 4 verification slots; wait for one to finish; nothing was run";
export const MSG_VERIFICATION_SHUTTING_DOWN = 'Core is shutting down; nothing was run';
export const MSG_COMMAND_NOT_FOUND = 'verification command not found';
export const MSG_COMMAND_REVOKED = 'this verification command was revoked; nothing was run';
export const MSG_COMMAND_OTHER_PROJECT = 'this verification command belongs to another project; nothing was run';
export const MSG_RUN_NOT_FOUND = 'verification run not found';
export const MSG_TASK_NOT_FOUND = 'task not found';
export const MSG_TOO_MANY_COMMANDS =
  'this project already has 50 approved verification commands, the most it can hold; revoke one first; nothing was approved';
export const MSG_VERSION_UNREADABLE =
  'sbx exec argument passing has not been verified for this sbx (Core could not read its version); nothing was run';
export const MSG_PROJECT_VERIFICATION_RUNNING =
  'a verification is running for a task of this project; wait for it to finish; nothing was deleted';
export const MSG_CONVERSATION_VERIFICATION_RUNNING =
  'a verification is running for a task of this conversation; wait for it to finish; nothing was deleted';
export const MSG_SANDBOX_VERIFICATION_RUNNING =
  'a verification is running in this sandbox; wait for it to finish; nothing was deleted';
export const MSG_COMMAND_NO_LONGER_PASSES = 'this command no longer passes the secret check; revoke it; nothing was run';
export const MSG_RUN_SECRET_CHECK_UNAVAILABLE = 'the secret check is unavailable, so nothing was run';
export const MSG_SECRET_CHECK_UNAVAILABLE = 'the secret check is unavailable, so nothing was approved';
/**
 * A3a / A3b archived refusals that `verification.approve` / `.run` return
 * (R4; `project_lifecycle.rs` / `conversation_lifecycle.rs`, drift-tested).
 * Kept here, not imported, because projectActions / conversationActions
 * import this module.
 */
export const MSG_PROJECT_ARCHIVED_FOR_VERIFICATION = 'project is archived; unarchive it first; nothing was changed';
export const MSG_CONVERSATION_ARCHIVED_FOR_VERIFICATION = 'conversation is archived; unarchive it first; nothing was changed';
/** Core's INTERNAL refusals of a run BEFORE anything starts end with this (drift-tested). */
const NOTHING_WAS_RUN_SUFFIX = '; nothing was run';
/** `details.hint` of a secret refusal (I-g): advice, shown as such. */
export const SECRET_REFUSAL_HINT =
  'if this is not a secret, rename the argument or move it into a script; approved commands cannot hold secrets and ' +
  'there is no override';

/** Core's formatted messages, `{}` marking each inserted value (matched by fixed parts). */
export const VERIFICATION_TEMPLATES = {
  exec_unverified: 'sbx exec argument passing has not been verified for sbx {}; nothing was run',
  sandbox_not_running:
    'sandbox "{}" is not running; sbx exec would start it; start it with `sbx run` in a terminal; nothing was run',
  repo_busy:
    '{} is busy: {} holds its writer lock (a running writer task, an apply, a worktree discard or another ' +
    'verification); a verification is already running or the repository is being written; nothing was run',
  shape_no_longer_passes: 'this command no longer passes the argument checks ({}); revoke it; nothing was run',
  frame_refusal: 'the response would exceed the frame limit ({} bytes, the limit is {}); {}; nothing was returned',
  secret_argument: 'argument {} looks like a secret ({}); approved commands cannot hold secrets; nothing was approved',
  secret_label: 'the label looks like a secret ({}); approved commands cannot hold secrets; nothing was approved',
  secret_combined:
    'the arguments together look like a secret ({}); approved commands cannot hold secrets; nothing was approved',
} as const;

// --- user-facing copy -------------------------------------------------------

export const UNSUPPORTED_VERSION_COPY =
  "Running is disabled until this sbx version's `sbx exec` behaviour has been captured and verified; your approved " +
  'commands are kept.';
export const DIRECT_MOUNT_WARNING =
  'this sandbox mounts your repository directly; the command can change your working tree, including `.git/hooks` ' +
  'that later run on your machine';
export const RUN_SCOPE_SENTENCE =
  "Runs in sbx's default working directory inside the sandbox; the result is the exit status reported by sbx exec; " +
  'not yet verified against a real sbx';
export const HOST_WORKTREE_WARNING =
  "the command can change files in the task's workspace, so a review taken before may no longer match; a later " +
  'apply then refuses "changed since reviewed" and you can review again';
export const APPROVE_NO_SECRETS = 'Do not put tokens or passwords in arguments.';
export const APPROVE_BINDING_SENTENCE =
  'Approval binds this exact argument list, not what it executes. Commands such as `npm run test`, `make test` or ' +
  '`./gradlew test` run code from the repository that the agent can change after you approve.';
export const NOT_BOUND_REASON = 'this task is not bound to a sandbox';
export const VERIFICATION_UNSUPPORTED =
  'Verification is not supported by the attached Sandpane Core (it does not advertise "verification"); nothing was sent.';
export const VERIFICATION_IN_FLIGHT =
  'A verification run is already being started for this task (confirmation or Core’s answer). Wait for it; ' +
  'nothing else was sent.';
export const NOT_CONFIRMED = 'Not confirmed; nothing was sent.';
export const APPROVE_BUTTON = 'Approve';
export const RUN_BUTTON = 'Run';
export const REVOKE_BUTTON = 'Revoke';
export const CANCEL_STEP_LABEL = 'Cancel — nothing is sent';

/** Display caps (revealed, then capped). */
const MAX_LABEL = 120;
const MAX_NAME = 200;
const MAX_NOTE = 700;
const MAX_CORE_TEXT = 2_000;
/** A modal lists at most this many elements, each at most this many characters. */
export const MODAL_ARGV_CAP = 20;
export const MODAL_ELEMENT_CHARS = 300;

// --- argv literals: an explicit list, never a shell split ------------------

function escapeCodePoint(cp: number): string {
  const unit = (u: number): string => `\\u${u.toString(16).toUpperCase().padStart(4, '0')}`;
  if (cp <= 0xffff) return unit(cp);
  const v = cp - 0x10000;
  return unit(0xd800 + (v >> 10)) + unit(0xdc00 + (v & 0x3ff));
}

/**
 * ONE argv element as a JSON string literal in which every hidden code point
 * (controls, bidi, invisible, line separators, lone surrogates) is a visible
 * `\uXXXX` escape, LF / TAB / CR are `\n` / `\t` / `\r`, and `$(` / `](` are
 * written with the parenthesis as `\u0028` so no VS Code surface renders an icon or a
 * link. Valid JSON: `JSON.parse` gives back the exact element. An empty,
 * leading-space or whitespace-only element is visibly distinct.
 */
export function argvLiteral(element: string): string {
  let out = '"';
  let previous = '';
  for (const ch of element) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (cp === 0x0a) out += '\\n';
    else if (cp === 0x09) out += '\\t';
    else if (cp === 0x0d) out += '\\r';
    else if (isHiddenCodePoint(cp)) out += escapeCodePoint(cp);
    else if (ch === '(' && (previous === '$' || previous === ']')) out += '\\u0028';
    else out += ch;
    previous = ch;
  }
  return `${out}"`;
}

/** The editable one-line JSON array for an argv (round-trips byte-exact). */
export function argvInputValue(argv: readonly string[]): string {
  return `[${argv.map(argvLiteral).join(', ')}]`;
}

export type ArgvInput = { ok: true; argv: string[] } | { ok: false; problem: string };

/**
 * Parse the one-line argv field: a JSON array of strings, nothing else — no
 * shell-like split, no glob, no trimming. Core's shape rules are applied for
 * early feedback only (never stricter than Core); a problem names the
 * argument number, never its value.
 */
export function parseArgvInput(text: string): ArgvInput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      problem: 'Write the arguments as a JSON array of strings, e.g. ["npm", "run", "test"] (no shell splitting is done).',
    };
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    return { ok: false, problem: 'The arguments must be a JSON array of strings, e.g. ["cargo", "test"].' };
  }
  try {
    return { ok: true, argv: validateVerificationArgv(value as string[]) };
  } catch (error) {
    return {
      ok: false,
      problem: `Core would refuse these arguments: ${error instanceof CoreValidationError ? error.message.replace(/^argv: /, '') : 'invalid'}`,
    };
  }
}

/** `[i] "element"` lines; with `cap`, at most that many lines and characters each. */
export function argvLines(argv: readonly string[], cap: { lines: number; chars: number } | null = null): string[] {
  const shown = cap === null ? argv : argv.slice(0, cap.lines);
  const lines = shown.map((element, i) => {
    const literal = argvLiteral(element);
    const points = Array.from(literal);
    return cap !== null && points.length > cap.chars
      ? `[${i + 1}] ${points.slice(0, cap.chars).join('')}… (cut here; the full element is open in the editor)`
      : `[${i + 1}] ${literal}`;
  });
  if (shown.length < argv.length) {
    lines.push(`… and ${argv.length - shown.length} more arguments — the full list is open in the editor`);
  }
  return lines;
}

/** Would the modal have to cut the argv (so the full list must be shown first)? */
export function argvNeedsFullList(argv: readonly string[]): boolean {
  return argv.length > MODAL_ARGV_CAP || argv.some((e) => Array.from(argvLiteral(e)).length > MODAL_ELEMENT_CHARS);
}

const MODAL_CAP = { lines: MODAL_ARGV_CAP, chars: MODAL_ELEMENT_CHARS };

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// --- decode (shape checks; a malformed answer is null and never echoed) ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? [...(value as string[])] : null;
}

export function parseVerificationCommand(raw: unknown): VerificationCommand | null {
  if (!isRecord(raw)) return null;
  const argv = stringArray(raw['argv']);
  const { id, projectId, label, approvedAt } = raw;
  if (typeof id !== 'string' || typeof projectId !== 'string' || typeof label !== 'string' || argv === null) return null;
  if (typeof approvedAt !== 'string') return null;
  return { id, projectId, label, argv, approvedAt };
}

function commandList(value: unknown): VerificationCommand[] | null {
  if (!Array.isArray(value)) return null;
  const out: VerificationCommand[] = [];
  for (const row of value) {
    const command = parseVerificationCommand(row);
    if (command === null) return null;
    out.push(command);
  }
  return out;
}

/** `verification.list` answer → the commands, or null. */
export function parseVerificationList(raw: unknown): VerificationCommand[] | null {
  return isRecord(raw) ? commandList(raw['commands']) : null;
}

/** `project.context` answer → the documented fields only, or null. */
export function parseProjectContext(raw: unknown): ProjectContextResult | null {
  if (!isRecord(raw) || !Array.isArray(raw['repositories'])) return null;
  const approved = commandList(raw['approved']);
  if (approved === null) return null;
  const repositories: RepositoryContext[] = [];
  for (const repo of raw['repositories'] as unknown[]) {
    if (!isRecord(repo) || typeof repo['repoPath'] !== 'string' || !Array.isArray(repo['detected'])) return null;
    const unreadable = stringArray(repo['unreadable']);
    if (unreadable === null) return null;
    const detected = [];
    for (const item of repo['detected'] as unknown[]) {
      if (!isRecord(item) || typeof item['manifest'] !== 'string') return null;
      const notes = stringArray(item['notes']);
      const suggestions = item['suggestedCommands'];
      if (notes === null || !Array.isArray(suggestions)) return null;
      const suggestedCommands: string[][] = [];
      for (const suggestion of suggestions) {
        const argv = stringArray(suggestion);
        if (argv === null) return null;
        suggestedCommands.push(argv);
      }
      detected.push({ manifest: item['manifest'], suggestedCommands, notes });
    }
    repositories.push({ repoPath: repo['repoPath'], detected, unreadable });
  }
  return { repositories, approved };
}

function parseRedactions(raw: unknown): OutputRedaction | null {
  if (!isRecord(raw) || typeof raw['bestEffort'] !== 'boolean' || typeof raw['replacements'] !== 'number') return null;
  const byKind: Record<string, number> = {};
  if (raw['byKind'] !== undefined) {
    if (!isRecord(raw['byKind'])) return null;
    for (const [kind, n] of Object.entries(raw['byKind'])) if (typeof n === 'number') byKind[kind] = n;
  }
  const withheld = raw['outputWithheld'];
  if (withheld !== undefined && withheld !== null && typeof withheld !== 'boolean') return null;
  return {
    bestEffort: raw['bestEffort'],
    replacements: raw['replacements'],
    byKind,
    ...(withheld === true || withheld === false ? { outputWithheld: withheld } : {}),
  };
}

/** `verification.result` answer → the documented fields only (outcome is open), or null. */
export function parseVerificationResult(raw: unknown): VerificationResult | null {
  if (!isRecord(raw)) return null;
  const argv = stringArray(raw['argv']);
  const redactions = parseRedactions(raw['redactions']);
  const strings = ['runId', 'taskId', 'commandId', 'label', 'sandbox', 'workspaceMode', 'outcome', 'stdout', 'stderr', 'startedAt'];
  if (argv === null || redactions === null || strings.some((k) => typeof raw[k] !== 'string')) return null;
  if (typeof raw['stdoutTruncated'] !== 'boolean' || typeof raw['stderrTruncated'] !== 'boolean') return null;
  const optional = (key: string, type: 'number' | 'string' | 'boolean'): boolean =>
    raw[key] === undefined || raw[key] === null || typeof raw[key] === type;
  if (!optional('exitCode', 'number') || !optional('elapsedMs', 'number') || !optional('finishedAt', 'string')) return null;
  if (!optional('outputIncomplete', 'boolean')) return null;
  const s = (key: string): string => raw[key] as string;
  return {
    runId: s('runId'),
    taskId: s('taskId'),
    commandId: s('commandId'),
    label: s('label'),
    argv,
    sandbox: s('sandbox'),
    workspaceMode: s('workspaceMode'),
    outcome: s('outcome'),
    ...(typeof raw['exitCode'] === 'number' ? { exitCode: raw['exitCode'] } : {}),
    stdout: s('stdout'),
    stderr: s('stderr'),
    stdoutTruncated: raw['stdoutTruncated'],
    stderrTruncated: raw['stderrTruncated'],
    redactions,
    ...(typeof raw['elapsedMs'] === 'number' ? { elapsedMs: raw['elapsedMs'] } : {}),
    startedAt: s('startedAt'),
    ...(typeof raw['finishedAt'] === 'string' ? { finishedAt: raw['finishedAt'] } : {}),
    ...(typeof raw['outputIncomplete'] === 'boolean' ? { outputIncomplete: raw['outputIncomplete'] } : {}),
  };
}

/** `verification.run` answer → `{runId, startedSequence, replayed?}`, or null. */
export function parseRunStarted(raw: unknown): VerificationRunResult | null {
  if (!isRecord(raw) || typeof raw['runId'] !== 'string' || typeof raw['startedSequence'] !== 'number') return null;
  return {
    runId: raw['runId'],
    startedSequence: raw['startedSequence'],
    ...(raw['replayed'] === true ? { replayed: true } : {}),
  };
}

// --- outcomes and disclosures (I4: no pass/fail, no green) -----------------

/** Honest copy for one outcome; an unknown outcome is shown as Core reported it. */
export function outcomeCopy(outcome: string, exitCode?: number | null): string {
  const status = typeof exitCode === 'number' ? exitCode : null;
  switch (outcome) {
    case OUTCOMES.exited:
      return status === null ? 'exited; Core reported no exit status' : `exit status ${status} (as reported by sbx exec)`;
    case OUTCOMES.signaled:
      return 'ended by a signal (no exit status)';
    case OUTCOMES.timed_out:
      return 'stopped after 10 minutes; the command may still be running inside the sandbox';
    case OUTCOMES.interrupted:
      return 'Core restarted (or stopped) while this ran; the result is unknown; the command may still be running inside the sandbox';
    case OUTCOMES.possibly_sbx_error:
      return status === null
        ? "possibly sbx's own error, or the command's own output (no exit status reported)"
        : `possibly sbx's own error, or the command's own output (exit status ${status} as reported by sbx exec)`;
    case OUTCOMES.spawn_failed:
      return 'Core could not start sbx exec (spawn_failed); the command was not started';
    case OUTCOMES.read_failed:
      return "Core could not read the command's output (read_failed); the command may have run and its result is unknown";
    case OUTCOMES.running:
      return 'still running (Core has recorded no result yet)';
    default:
      return `outcome "${plainText(outcome, 80)}" (not known to this client; shown as Core reported it)`;
  }
}

export interface DisclosureInput {
  stdoutTruncated?: boolean | null;
  stderrTruncated?: boolean | null;
  outputIncomplete?: boolean | null;
  redactions?: Partial<OutputRedaction> | null;
}

/** Every flag Core set, as plain sentences (none = empty list). */
export function resultDisclosures(input: DisclosureInput): string[] {
  const out: string[] = [];
  if (input.stdoutTruncated === true) out.push('stdout was truncated at 64 KiB');
  if (input.stderrTruncated === true) out.push('stderr was truncated at 64 KiB');
  if (input.outputIncomplete === true) {
    out.push('output may be incomplete: a process kept the output open after the command exited');
  }
  if (input.redactions?.outputWithheld === true) out.push('output was not stored because the secret check was unavailable');
  const n = input.redactions?.replacements;
  if (typeof n === 'number' && n > 0) out.push(`${n} ${n === 1 ? 'value was' : 'values were'} redacted (best effort)`);
  return out;
}

export interface FinishedSummary {
  runId: string;
  outcome: string;
  startedSequence: number | null;
  text: string;
}

/** A `verification.finished` payload (open fields; output is never in it). */
export function finishedEventSummary(payload: unknown): FinishedSummary | null {
  if (!isRecord(payload) || typeof payload['runId'] !== 'string' || typeof payload['outcome'] !== 'string') return null;
  const exitCode = typeof payload['exitCode'] === 'number' ? payload['exitCode'] : null;
  const redactions = isRecord(payload['redactions']) ? (payload['redactions'] as Partial<OutputRedaction>) : null;
  const flags = resultDisclosures({
    stdoutTruncated: payload['stdoutTruncated'] === true,
    stderrTruncated: payload['stderrTruncated'] === true,
    outputIncomplete: payload['outputIncomplete'] === true,
    redactions,
  });
  const elapsed = typeof payload['elapsedMs'] === 'number' ? ` after ${payload['elapsedMs']} ms` : '';
  const reconciled = payload['reconciledAfterRestart'] === true ? ' (recorded by Core when it restarted)' : '';
  return {
    runId: payload['runId'],
    outcome: payload['outcome'],
    startedSequence: typeof payload['startedSequence'] === 'number' ? payload['startedSequence'] : null,
    text: `${outcomeCopy(payload['outcome'], exitCode)}${elapsed}${reconciled}${flags.length > 0 ? ` · ${flags.join(' · ')}` : ''}`,
  };
}

/** A `verification.started` payload as one transcript line (revealed; never a status). */
export function startedEventText(payload: unknown): string {
  const p = isRecord(payload) ? payload : {};
  const label = typeof p['label'] === 'string' ? plainText(p['label'], MAX_LABEL) : '(no label recorded)';
  const argv = stringArray(p['argv']);
  const sandbox = typeof p['sandbox'] === 'string' ? plainText(p['sandbox'], MAX_NAME) : 'an unnamed sandbox';
  const mode = typeof p['workspaceMode'] === 'string' ? plainText(p['workspaceMode'], 40) : 'unknown mode';
  const args = argv === null ? '(no arguments recorded)' : argvLines(argv, { lines: 10, chars: 120 }).join(' ');
  return `verification started: ${label} — ${args} in sandbox ${sandbox} (${mode}); the task status is not changed`;
}

/** A `verification.finished` payload as one transcript line. */
export function finishedEventText(payload: unknown): string {
  const summary = finishedEventSummary(payload);
  return summary === null
    ? 'verification finished (Core recorded an outcome this client cannot read)'
    : `verification finished: ${summary.text}`;
}

// --- confirmations ------------------------------------------------------------

export interface ConfirmationView {
  message: string;
  detail: string;
  button: string;
  /** The modal cuts the argv: the full list must be opened in the editor first. */
  fullList: boolean;
}

export interface ApproveInput {
  projectName: string;
  label: string;
  argv: readonly string[];
  /** For a suggestion: the notes Core showed (item 9). */
  notes?: readonly string[];
}

/** §3.7 item 8 approve confirmation: every element, the count, the label, both warnings. */
export function approveConfirmationView(input: ApproveInput): ConfirmationView {
  const n = input.argv.length;
  const notes = input.notes ?? [];
  return {
    message: noIcons(
      `Approve this verification command for "${plainText(input.projectName, MAX_LABEL)}"? (${count(n, 'argument', 'arguments')})`,
    ),
    detail: [
      `Label: ${plainText(input.label, MAX_LABEL)}`,
      `Arguments (${n}) — exactly what is stored and passed to sbx exec, one element per line:`,
      ...argvLines(input.argv, MODAL_CAP),
      '',
      APPROVE_NO_SECRETS,
      APPROVE_BINDING_SENTENCE,
      ...(notes.length > 0
        ? ['', 'Notes from Core about this suggestion:', ...notes.map((note) => `· ${plainText(note, MAX_NOTE)}`)]
        : []),
      '',
      'Nothing runs now: an approved command runs only when you choose Run on a task and confirm it there.',
    ].join('\n'),
    button: APPROVE_BUTTON,
    fullList: argvNeedsFullList(input.argv),
  };
}

export interface RunInput {
  taskId: string;
  label: string;
  argv: readonly string[];
  sandboxName: string;
  workspaceMode: WorkspaceMode;
}

/** §3.7 item 8 run confirmation. */
export function runConfirmationView(input: RunInput): ConfirmationView {
  const sandbox = plainText(input.sandboxName, MAX_NAME);
  return {
    message: noIcons(
      `Run "${plainText(input.label, MAX_LABEL)}" in sandbox "${sandbox}" for task ${plainText(input.taskId, MAX_NAME).slice(0, 8)}?`,
    ),
    detail: [
      `Command: ${plainText(input.label, MAX_LABEL)}`,
      `Arguments (${input.argv.length}):`,
      ...argvLines(input.argv, MODAL_CAP),
      '',
      `Sandbox: ${sandbox} · workspace mode: ${input.workspaceMode}`,
      ...(input.workspaceMode === 'direct_mount' ? [`WARNING: ${DIRECT_MOUNT_WARNING}.`] : []),
      ...(input.workspaceMode === 'host_worktree' ? [`Note: ${HOST_WORKTREE_WARNING}.`] : []),
      `${RUN_SCOPE_SENTENCE}.`,
      'Core runs a command only for an sbx version whose `sbx exec` behaviour has been captured and verified; until ' +
        'then it refuses and nothing runs.',
      'There is no cancel in this build: stopping the sandbox is the way to end a runaway command.',
    ].join('\n'),
    button: RUN_BUTTON,
    fullList: argvNeedsFullList(input.argv),
  };
}

/** Revoke: a plain, non-destructive confirmation. */
export function revokeConfirmationView(command: VerificationCommand): ConfirmationView {
  return {
    message: noIcons(`Revoke the verification command "${plainText(command.label, MAX_LABEL)}"?`),
    detail: [
      `Arguments (${command.argv.length}):`,
      ...argvLines(command.argv, MODAL_CAP),
      '',
      'Revoking stops future runs only: a verification already running is not stopped, and past results stay ' +
        'readable. Nothing is deleted.',
    ].join('\n'),
    button: REVOKE_BUTTON,
    fullList: argvNeedsFullList(command.argv),
  };
}

export interface ConfirmStepItem {
  label: string;
  description?: string;
  confirm: boolean;
}

/** The A6-style second step: Cancel first (VS Code makes the first item active), then the explicit choice. */
export function confirmStepItems(confirmLabel: string): ConfirmStepItem[] {
  return [
    { label: CANCEL_STEP_LABEL, confirm: false },
    { label: noIcons(confirmLabel), description: 'sends it to Core', confirm: true },
  ];
}

/** The read-only full argument list (opened before a modal that had to cut it). */
export function renderArgvDocument(title: string, label: string, argv: readonly string[], notes: readonly string[] = []): string {
  return [
    `# Sandpane — ${title} (read-only; nothing is approved or run from this view; only the dialog sends anything).`,
    `# label: ${plainText(label, MAX_LABEL)}`,
    `# arguments (${argv.length}), one element per line, as JSON string literals:`,
    ...argvLines(argv),
    ...(notes.length > 0 ? ['# notes from Core:', ...notes.map((note) => `# · ${plainText(note, MAX_NOTE)}`)] : []),
    '',
  ].join('\n');
}

// --- run binding (§3.7 item 1: never chosenSandboxName) --------------------

export type RunBinding =
  | { ok: true; sandboxName: string; workspaceMode: WorkspaceMode }
  | { ok: false; reason: string };

/**
 * `expectedSandboxName` = the task's BINDING (`TaskSummary.sandboxName`);
 * `expectedWorkspaceMode` = that sandbox's `sandbox.list` mode. Anything less
 * (no binding, not listed, no / unknown mode) disables Run with its own reason.
 * `chosenSandboxName` is never read.
 */
export function runBinding(
  task: { sandboxName?: string | null; chosenSandboxName?: string | null },
  sandboxes: readonly SandboxSummary[],
): RunBinding {
  const name = task.sandboxName;
  if (typeof name !== 'string' || name.length === 0) return { ok: false, reason: NOT_BOUND_REASON };
  const entry = sandboxes.find((s) => s.name === name);
  // A bound task is never called unbound: say what is missing instead.
  if (!entry) return { ok: false, reason: `the task's sandbox "${plainText(name, MAX_NAME)}" is not in Core's sandbox list` };
  const mode: unknown = entry.workspaceMode;
  if (!isWorkspaceMode(mode)) {
    return { ok: false, reason: `Core has no recorded workspace mode for the task's sandbox "${plainText(name, MAX_NAME)}"` };
  }
  return { ok: true, sandboxName: name, workspaceMode: mode };
}

// --- errors -------------------------------------------------------------------

export type VerificationOperation =
  | 'verification.list'
  | 'verification.approve'
  | 'verification.revoke'
  | 'verification.run'
  | 'verification.result'
  | 'project.context';

export interface VerificationErrorView {
  tone: 'warning' | 'error';
  text: string;
  /** Core may have received the request and its outcome is unknown. */
  lostAnswer: boolean;
  /** Offer "Retry safely" (same idempotency key) — `verification.run` only. */
  retrySafely: boolean;
}

function rpcMessage(error: CoreRpcError): string {
  const prefix = `${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

function coreSaid(message: string): string {
  return `Core said: ${noIcons(plainText(message, MAX_CORE_TEXT))}`;
}

const READ_ONLY: ReadonlySet<VerificationOperation> = new Set<VerificationOperation>([
  'verification.list',
  'verification.result',
  'project.context',
]);

/** What Core's own message says was not done, echoed as a sentence (never more). */
function nothingDone(message: string): string | null {
  const m = /nothing was (run|approved|deleted|returned|changed)$/.exec(message);
  return m ? `Nothing was ${m[1]}.` : null;
}

function lost(operation: VerificationOperation, why: string): VerificationErrorView {
  if (READ_ONLY.has(operation)) {
    return { tone: 'warning', text: `${operation} — ${why}; nothing was changed (it is read-only).`, lostAnswer: true, retrySafely: false };
  }
  if (operation === 'verification.run') {
    return {
      tone: 'warning',
      text:
        `verification.run — ${why}: the verification may have started. "Retry safely" resends the identical request ` +
        'with the same idempotency key, so Core starts it at most once (it returns the earlier answer instead).',
      lostAnswer: true,
      retrySafely: true,
    };
  }
  const what = operation === 'verification.approve' ? 'the command may have been approved' : 'the command may have been revoked';
  return {
    tone: 'warning',
    text: `${operation} — ${why}: ${what}. Refresh the Verification list before trying again.`,
    lostAnswer: true,
    retrySafely: false,
  };
}

function frameRefusalAdvice(operation: VerificationOperation): string {
  switch (operation) {
    case 'verification.list':
      return "this project's approved commands are too large to list at once; Core names the largest ones — revoke some.";
    case 'project.context':
      return 'the detected suggestions are too large to send at once; remove repositories from the project or revoke approved commands.';
    case 'verification.result':
      return "this run's stored output cannot be shown.";
    default:
      return 'nothing was returned.';
  }
}

/**
 * Copy for a FAILED A7 call. `null` ONLY when the frame provably never left
 * this client (client-side validation, not attached, untrusted socket): the
 * caller then says nothing was sent. Every Core text is revealed and capped;
 * a frame refusal is never retried; a lost `verification.run` answer offers
 * "Retry safely" and never says nothing ran.
 */
export function verificationErrorView(error: unknown, operation: VerificationOperation): VerificationErrorView | null {
  if (error instanceof CoreValidationError || isProvablyUnsent(error)) return null;
  if (error instanceof CoreTransportError) {
    return lost(operation, error.reason === 'timeout' ? 'Core did not answer in time' : 'the connection to Core was lost before it answered');
  }
  if (!(error instanceof CoreRpcError)) {
    return lost(operation, 'the call failed inside this client after the request may have been handed to Core');
  }
  const message = rpcMessage(error);
  const said = coreSaid(message);
  const done = nothingDone(message);
  const view = (text: string, tone: 'warning' | 'error' = 'error'): VerificationErrorView => ({
    tone,
    text: `${operation} — ${text}${done !== null && !text.includes(done) ? ` ${done}` : ''}\n\n${said}`,
    lostAnswer: false,
    retrySafely: false,
  });
  switch (error.code) {
    case 'UNSUPPORTED_SBX_VERSION':
      return view(`Not run. ${UNSUPPORTED_VERSION_COPY} Nothing was run.`, 'warning');
    case 'NOT_INSTALLED':
      return view('sbx is not installed (or Core cannot find it), so nothing could run.');
    case 'DAEMON_DOWN':
      return view('the Docker sandbox daemon is not running, so nothing could run.');
    case 'NOT_FOUND':
      if (message === MSG_RUN_NOT_FOUND) return view('Core has no such verification run (it may have been deleted with its task).');
      if (message === MSG_COMMAND_NOT_FOUND) return view('Core has no such verification command (it may have been deleted with its project).');
      if (message === MSG_TASK_NOT_FOUND) return view('Core has no such task (it may have been deleted).');
      return view('Core does not know the project, task, command or run named in this request.');
    case 'INTERNAL':
      // I2: Core's own text says nothing ran (shutting down, the exec
      // context could not be prepared): definite, never "may have started".
      if (operation === 'verification.run' && (message === MSG_VERIFICATION_SHUTTING_DOWN || message.endsWith(NOTHING_WAS_RUN_SUFFIX))) {
        return view(
          message === MSG_VERIFICATION_SHUTTING_DOWN
            ? 'Not run — Core is shutting down.'
            : 'Not run — Core failed before starting anything (INTERNAL).',
        );
      }
      if (operation === 'verification.run') {
        const unknown = lost(operation, 'Core reported an internal failure');
        return { ...unknown, text: `${unknown.text}\n\n${said}` };
      }
      return view(
        READ_ONLY.has(operation)
          ? 'Core could not answer (INTERNAL); nothing was changed (it is read-only).'
          : "Core reported an internal failure. Its message below is all this client knows; refresh the Verification list to see Core's state.",
      );
    case 'CONFLICT': {
      const keyed = classifyKeyedConflict(error);
      if (keyed !== null) return view(keyedConflictCopy(keyed));
      if (
        message === MSG_VERIFICATION_TASK_BUSY ||
        message === MSG_VERIFICATION_SANDBOX_BUSY ||
        message === MSG_VERIFICATION_CORE_BUSY ||
        matchesTemplate(message, VERIFICATION_TEMPLATES.repo_busy)
      ) {
        return view('Not run — a verification is already running (or the repository is being written). Wait for it to finish.');
      }
      return view('Core refused it (CONFLICT).');
    }
    case 'VALIDATION_FAILED': {
      if (matchesTemplate(message, VERIFICATION_TEMPLATES.frame_refusal)) {
        return view(`Core's answer is too large to send in one Core frame, so ${frameRefusalAdvice(operation)} It is not retried.`);
      }
      // W1: archived project / conversation (R4) before any generic copy.
      const notDone =
        operation === 'verification.approve'
          ? 'Not approved'
          : operation === 'verification.run'
            ? 'Not run'
            : operation === 'verification.revoke'
              ? 'Not revoked'
              : 'Refused';
      if (message === MSG_PROJECT_ARCHIVED_FOR_VERIFICATION) {
        return view(`${notDone} — this project is archived; unarchive it first.`);
      }
      if (message === MSG_CONVERSATION_ARCHIVED_FOR_VERIFICATION) {
        return view(`${notDone} — the task's conversation is archived; unarchive it first.`);
      }
      if (operation === 'verification.approve') {
        const secret =
          matchesTemplate(message, VERIFICATION_TEMPLATES.secret_argument) ||
          matchesTemplate(message, VERIFICATION_TEMPLATES.secret_label) ||
          matchesTemplate(message, VERIFICATION_TEMPLATES.secret_combined);
        if (secret || message === MSG_SECRET_CHECK_UNAVAILABLE) {
          const details = error.details;
          const hint = isRecord(details) && typeof details['hint'] === 'string' ? details['hint'] : null;
          return view(
            `Not approved — ${message === MSG_SECRET_CHECK_UNAVAILABLE ? "Core's secret check is unavailable, so it approves nothing" : 'Core refused it as secret-shaped (there is no override)'}.` +
              (hint !== null ? `\n\nCore's advice: ${noIcons(plainText(hint, 500))}` : ''),
          );
        }
        if (message === MSG_TOO_MANY_COMMANDS) {
          return view('Not approved — this project already has 50 approved commands. Revoke one first.');
        }
        return view('Not approved — Core refused the label or the arguments.');
      }
      if (operation === 'verification.run') {
        const why =
          message === MSG_VERIFICATION_NOT_BOUND
            ? 'this task is not bound to a sandbox.'
            : message === MSG_VERIFICATION_SANDBOX_CHANGED
              ? "the task's sandbox changed since you confirmed — open Run again to see it."
              : message === MSG_VERIFICATION_IDENTITY
                ? "Core cannot confirm the sandbox's identity."
                : matchesTemplate(message, VERIFICATION_TEMPLATES.sandbox_not_running)
                  ? 'the sandbox is not running (sbx exec would start it); start it yourself first.'
                  : message === MSG_COMMAND_REVOKED || message === MSG_COMMAND_OTHER_PROJECT
                    ? 'the command is revoked or belongs to another project.'
                    : message === MSG_COMMAND_NO_LONGER_PASSES || matchesTemplate(message, VERIFICATION_TEMPLATES.shape_no_longer_passes)
                      ? 'the command no longer passes Core’s checks; revoke it.'
                      : 'Core refused before starting anything.';
        return view(`Not run — ${why}`);
      }
      return view('Core refused the request (VALIDATION_FAILED).');
    }
    default:
      return view(`Core answered with an error (${plainText(error.code, 40)}).`);
  }
}

/** The notice after Core accepted a run (asynchronous: the result comes later). */
export function runStartedCopy(label: string, started: VerificationRunResult): string {
  const replay = started.replayed === true
    ? ' Core returned the answer of your earlier identical request (replayed); it was not started twice.'
    : '';
  return noIcons(
    `Core started the verification "${plainText(label, MAX_LABEL)}" (run ${plainText(started.runId, MAX_NAME).slice(0, 8)}).${replay} ` +
      'The task status is not changed. The result appears when Core records it — use "Results…" on the task to read it.',
  );
}

// --- the output document (sandpane-verification:, plain text) ------------------

function outputSection(name: string, text: string): string[] {
  if (text.length === 0) return [`--- ${name} ---`, `(no ${name})`];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return [`--- ${name} ---`, ...body.split('\n').map((line) => revealKeepingTabs(line).text)];
}

/**
 * The read-only result document: an honest header (outcome copy, every
 * disclosure, label and argv revealed), then stdout and stderr with every
 * control character except LF and TAB escaped visibly (CR as `\r`, ESC as
 * `\u001B`), so OSC 8 links, OSC 52 clipboard writes and bidi tricks cannot
 * act. Never HTML, never Markdown, never a terminal.
 */
export function renderResultDocument(result: VerificationResult, options: { linksDisabled: boolean }): string {
  const disclosures = resultDisclosures(result);
  const timing = [
    `started ${plainText(result.startedAt, 60)}`,
    ...(typeof result.finishedAt === 'string' ? [`finished ${plainText(result.finishedAt, 60)}`] : []),
    ...(typeof result.elapsedMs === 'number' ? [`elapsed ${result.elapsedMs} ms`] : []),
  ].join(' · ');
  return [
    ...(options.linksDisabled
      ? ['# Sandpane — verification result (read-only, display only). Nothing in this view is run, linked or written to your repository.']
      : [
          '# Sandpane — verification result (read-only, display only). Nothing in this view is run or written to your repository.',
          '# Link detection is enabled by a setting (`editor.links` for this view, e.g. a workspace override), so text here may',
          '# be clickable: links in this output are untrusted — do not open them.',
        ]),
    '# Output is untrusted text: every control character except LF and TAB is shown as \\uXXXX (CR as \\r).',
    `# run ${plainText(result.runId, MAX_NAME)} · task ${plainText(result.taskId, MAX_NAME)} · command ${plainText(result.commandId, MAX_NAME)}`,
    `# label: ${plainText(result.label, MAX_LABEL)}`,
    `# arguments (${result.argv.length}):`,
    ...argvLines(result.argv).map((line) => `#   ${line}`),
    `# sandbox: ${plainText(result.sandbox, MAX_NAME)} · workspace mode: ${plainText(result.workspaceMode, 40)}`,
    `# outcome: ${outcomeCopy(result.outcome, result.exitCode)}`,
    ...disclosures.map((d) => `# ${d}`),
    `# ${timing}`,
    `# ${RUN_SCOPE_SENTENCE}.`,
    '# The exit status is the one sbx exec reported; it is not a verdict on the command.',
    '',
    ...outputSection('stdout', result.stdout),
    '',
    ...outputSection('stderr', result.stderr),
    '',
  ].join('\n');
}

export const VERIFICATION_GONE_TEXT =
  '# This Sandpane verification view is no longer available (only the most recent views are kept in memory).\n' +
  '# Open the result again from the task.\n';

// --- sidebar, stop and delete copy -----------------------------------------------

/** The sidebar lists at most this many elements per command, each at most this many characters. */
export const PANEL_ARGV_CAP = 20;
export const PANEL_ELEMENT_CHARS = 200;

/** Sidebar argv lines (`[i] "literal"`, revealed); the dialogs always show every element. */
export function panelArgvLines(argv: readonly string[]): string[] {
  const lines = argv.slice(0, PANEL_ARGV_CAP).map((element, i) => {
    const points = Array.from(argvLiteral(element));
    return points.length > PANEL_ELEMENT_CHARS
      ? `[${i + 1}] ${points.slice(0, PANEL_ELEMENT_CHARS).join('')}… (cut here; Run and Revoke show it in full)`
      : `[${i + 1}] ${points.join('')}`;
  });
  if (argv.length > PANEL_ARGV_CAP) {
    lines.push(`… and ${argv.length - PANEL_ARGV_CAP} more arguments (Run and Revoke show them all)`);
  }
  return lines;
}

/** Added to the stop confirmation when this client knows a run is in flight in that sandbox. */
export const STOP_ENDS_RUN = 'a verification is running in this sandbox; stopping it ends the run';

export const PROJECT_VERIFICATION_RUNNING_COPY =
  'A verification is running for a task of this project. Wait for it to finish, then delete again. Nothing was deleted.';
export const CONVERSATION_VERIFICATION_RUNNING_COPY =
  'A verification is running for a task of this conversation. Wait for it to finish, then delete again. Nothing was deleted.';
export const SANDBOX_VERIFICATION_RUNNING_COPY =
  'A verification is running in this sandbox. Wait for it to finish, then remove it again. Nothing was deleted.';

/** Copy for Core's "a verification is running in this sandbox; …; nothing was deleted" refusal, else null. */
export function sandboxVerificationRunningCopy(error: unknown): string | null {
  return error instanceof CoreRpcError && error.code === 'CONFLICT' && rpcMessage(error) === MSG_SANDBOX_VERIFICATION_RUNNING
    ? SANDBOX_VERIFICATION_RUNNING_COPY
    : null;
}

/** One run as the sidebar shows it: the revealed label and what Core's events say. */
export function runRowText(run: { label: string; finished: string | null }): string {
  return `${run.label} — ${run.finished ?? outcomeCopy(OUTCOMES.running)}`;
}

/** The six A7 methods; the UI is enabled only when all are advertised AND the feature is. */
export const VERIFICATION_METHODS = [
  'verification.list',
  'verification.approve',
  'verification.revoke',
  'verification.run',
  'verification.result',
  'project.context',
] as const satisfies readonly CoreMethodName[];

export const VERIFICATION_UNSUPPORTED_NOTE =
  'Verification is not supported by the attached Sandpane Core (it does not advertise "verification").';
export const MALFORMED_VERIFICATION =
  "Core's answer did not have the documented shape, so nothing from it is shown (the payload is not logged).";
export const SHOW_RESULT_BUTTON = 'Show result';

/** The status after `verification.approve` answered; `existing` = Core returned an already-approved command. */
export function approvedCopy(input: { label: string; argvCount: number; projectName: string; existing: boolean }): string {
  const label = plainText(input.label, MAX_LABEL);
  return noIcons(
    input.existing
      ? `This command was already approved as «${label}»; nothing new was approved.`
      : `Approved "${label}" (${input.argvCount} argument(s)) for "${plainText(input.projectName, MAX_LABEL)}". Nothing ran: an ` +
          "approved command runs only from a task's Verify… and its confirmation.",
  );
}

/** The "Retry safely" window has closed for a run (Core may have forgotten the key). */
export const VERIFICATION_TOO_LATE =
  'Too late to retry safely — the earlier run may have started; check Results before running again.';
