/**
 * A7 verification commands and `project.context` on the desktop (design
 * 2026-10-09 §3.7). Pure logic, no React, so the node-only suites can prove
 * what is gated, what is sent, and what every outcome and refusal says.
 *
 * Binding rules carried here:
 * - The verification UI is enabled ONLY when the `verification` feature AND
 *   all six methods are advertised (item 1).
 * - Approve and Run open ONLY from a trusted user gesture on Sandpane's own
 *   control (item 8); no entry point takes argv, a `commandId` or a `runId`
 *   from anywhere else — the dialogs are filled from Core state.
 * - `expectedSandboxName` is the task's BINDING (`TaskSummary.sandboxName`),
 *   never `chosenSandboxName`; `expectedWorkspaceMode` is that sandbox's
 *   `sandbox.list` entry (item 1, W5).
 * - Labels, argv, notes, sandbox names, repository paths and output are
 *   UNTRUSTED. They are rendered as plain React text, revealed (every C0/C1
 *   control, bidi and invisible character becomes a visible escape) and
 *   capped (item 6, W9). Output keeps LF and TAB; CR is shown as `\r`.
 * - Exit status is `sbx exec`'s, UNVERIFIED as the command's own (C-2): never
 *   coloured or worded as a pass or a fail (I4).
 * - Task status is never changed or inferred by a verification (rule 3).
 */

import {
  CoreRequestError,
  MAY_HAVE_BEEN_APPLIED_COPY,
  PROXY_MAY_HAVE_BEEN_APPLIED_SUFFIX,
  asCoreRequestError,
  coreErrorCode,
  type ProbeOutcome,
} from "./core-client";
import { idempotencyConflictCopy, idempotencyConflictKind, isUnknownOutcome, type KeyRecheck } from "./idempotency";
import {
  FEATURE_IDEMPOTENCY_KEYS,
  FEATURE_VERIFICATION,
  VERIFICATION_METHODS,
  WORKSPACE_MODES,
  coreAdvertisesFeature,
  coreAdvertisesMethod,
  type CoreCapabilities,
  type SandboxSummary,
  type VerificationCommand,
  type VerificationResult,
  type WorkspaceMode,
} from "./protocol";
import { conversationMessageCopy } from "./conversation-messages";
import { projectMessageCopy } from "./project-messages";
import {
  DISCLOSURE_OUTPUT_INCOMPLETE,
  DISCLOSURE_OUTPUT_WITHHELD,
  describeCoreError,
  displayRevealed,
  isNameLockConflict,
  redactedCountText,
  type FeatureGate,
  type StatusTone,
} from "./reducers";
import {
  ARGV_SHAPE_PREFIX,
  LABEL_REFUSAL_PREFIX,
  MSG_COMMAND_NOT_FOUND,
  MSG_COMMAND_NO_LONGER_PASSES,
  MSG_COMMAND_OTHER_PROJECT,
  MSG_COMMAND_REVOKED,
  MSG_RUN_NOT_FOUND,
  MSG_RUN_SECRET_CHECK_UNAVAILABLE,
  MSG_SECRET_CHECK_UNAVAILABLE,
  MSG_TASK_NOT_FOUND,
  MSG_TOO_MANY_COMMANDS,
  MSG_VERIFICATION_CORE_BUSY,
  MSG_VERIFICATION_IDENTITY,
  MSG_VERIFICATION_NOT_BOUND,
  MSG_VERIFICATION_SANDBOX_BUSY,
  MSG_VERIFICATION_SANDBOX_CHANGED,
  MSG_VERIFICATION_SHUTTING_DOWN,
  MSG_VERIFICATION_TASK_BUSY,
  NOTHING_WAS_RUN_SUFFIX,
  NOT_RUNNING_PREFIX,
  NOT_RUNNING_SUFFIX,
  REPO_BUSY_INFIX,
  REPO_BUSY_SUFFIX,
  SHAPE_NO_LONGER_PREFIX,
  SHAPE_NO_LONGER_SUFFIX,
  isExecUnverified,
  isFrameRefusal,
  secretRefusalKind,
} from "./verification-messages";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/** The `verification` feature AND every one of the six methods advertised. */
export function verificationAdvertised(
  capabilities: Pick<CoreCapabilities, "methods" | "features"> | null | undefined,
): boolean {
  return (
    coreAdvertisesFeature(capabilities, FEATURE_VERIFICATION) &&
    VERIFICATION_METHODS.every((m) => coreAdvertisesMethod(capabilities, m))
  );
}

/**
 * The verification surface's gate. `null` capabilities = not probed yet,
 * which is NOT "unsupported" (AGENTS rule 5).
 */
export function verificationGate(
  capabilities: Pick<CoreCapabilities, "methods" | "features"> | null,
): FeatureGate {
  if (capabilities === null) {
    return {
      state: "unprobed",
      note: "Verification needs Core's `verification` feature; Core has not been probed yet.",
    };
  }
  if (verificationAdvertised(capabilities)) {
    return { state: "supported", note: "This Core advertises the verification feature and its six methods." };
  }
  return {
    state: "unsupported",
    note:
      "This Core does not advertise the `verification` feature (and its six methods), so approved verification commands, runs and project.context do not exist here — they are unavailable, not hidden.",
  };
}

// ---------------------------------------------------------------------------
// Rendering untrusted text (item 6, W9)
// ---------------------------------------------------------------------------

/** Display caps, in code points; every cut is disclosed in the text. */
export const LABEL_DISPLAY_MAX_CHARS = 200;
export const ARGV_ELEMENT_DISPLAY_MAX_CHARS = 600;
export const NOTE_DISPLAY_MAX_CHARS = 800;
export const NAME_DISPLAY_MAX_CHARS = 300;
export const CORE_REASON_MAX_CHARS = 600;
export const HINT_DISPLAY_MAX_CHARS = 300;
/** Output: at most this many lines, each capped (the rest is counted). */
export const OUTPUT_MAX_LINES = 2000;
export const OUTPUT_LINE_MAX_CHARS = 2000;

/** Display caps for Core's timestamps and run ids (RFC 3339 / UUID by contract, untrusted on screen). */
export const TIMESTAMP_DISPLAY_MAX_CHARS = 64;
export const RUN_ID_SHORT_CHARS = 8;

/** A Core timestamp (`approvedAt`, `startedAt`, `finishedAt`) as display text: revealed and capped. */
export function revealTimestamp(value: string): string {
  return displayRevealed(value, TIMESTAMP_DISPLAY_MAX_CHARS).text;
}

/** The first 8 code points of a Core run id, revealed (never a raw `slice`). */
export function shortRunId(runId: string): string {
  const head = Array.from(runId).slice(0, RUN_ID_SHORT_CHARS).join("");
  return displayRevealed(head, RUN_ID_SHORT_CHARS).text;
}

/** One-line untrusted text (label, argv element, note, name): every control revealed, capped. */
export function revealText(value: string, maxChars: number): { text: string; unusual: boolean } {
  return displayRevealed(value, maxChars);
}

/** A segment with no LF and no TAB: CR shown as `\r`, everything else through `displayRevealed`. */
function revealSegment(segment: string): { text: string; unusual: boolean } {
  let unusual = false;
  const text = segment
    .split("\r")
    .map((part) => {
      const shown = displayRevealed(part, Number.MAX_SAFE_INTEGER);
      if (shown.unusual) unusual = true;
      return shown.text;
    })
    .join("\\r");
  return { text, unusual: unusual || segment.includes("\r") };
}

/** One output line: capped in code points first, then revealed (TAB kept). */
function revealOutputLine(line: string): { text: string; unusual: boolean } {
  const points = Array.from(line);
  const cut = points.length > OUTPUT_LINE_MAX_CHARS;
  const head = cut ? points.slice(0, OUTPUT_LINE_MAX_CHARS).join("") : line;
  let unusual = false;
  const text = head
    .split("\t")
    .map((part) => {
      const shown = revealSegment(part);
      if (shown.unusual) unusual = true;
      return shown.text;
    })
    .join("\t");
  return {
    text: cut ? `${text}… (${points.length - OUTPUT_LINE_MAX_CHARS} more characters)` : text,
    unusual,
  };
}

export interface RevealedOutput {
  /** The display text: LF-separated revealed lines, for ONE React text child in a `<pre>`. */
  text: string;
  /** Lines not shown (past `OUTPUT_MAX_LINES`). */
  hiddenLines: number;
  /** Some shown line held a control, bidi or invisible character (now escaped). */
  unusual: boolean;
}

/**
 * Command output for display. Split on LF only; TAB kept; CR shown as `\r`;
 * every other C0/C1 control (ESC included, so OSC 8 links and OSC 52
 * clipboard writes are inert text), bidi and invisible character becomes a
 * visible `\uXXXX`. Capped per line and in line count, with the cut counted.
 */
export function revealOutput(output: string): RevealedOutput {
  if (output.length === 0) return { text: "", hiddenLines: 0, unusual: false };
  const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : output.split("\n");
  const shown = lines.slice(0, OUTPUT_MAX_LINES).map(revealOutputLine);
  return {
    text: shown.map((l) => l.text).join("\n"),
    hiddenLines: lines.length - shown.length,
    unusual: shown.some((l) => l.unusual),
  };
}

// ---------------------------------------------------------------------------
// Early feedback on a draft (NEVER stricter than Core; Core is the authority)
// ---------------------------------------------------------------------------

/** Core's caps (`sandpane-core/src/validation.rs`, drift-tested). */
export const MAX_VERIFICATION_LABEL_CHARS = 80;
export const MAX_VERIFICATION_ARGS = 64;
export const MAX_VERIFICATION_ARG_BYTES = 4096;
export const MAX_VERIFICATION_ARGV_BYTES = 16 * 1024;

/** Rust `char::is_whitespace` (Unicode White_Space): what Core's `str::trim` removes. */
const RUST_WHITESPACE = "\\t\\n\\u000b\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const RUST_TRIM = new RegExp(`^[${RUST_WHITESPACE}]+|[${RUST_WHITESPACE}]+$`, "gu");
/** Rust `char::is_control` (general category Cc): C0, DEL and C1. */
const CC = /[\u0000-\u001f\u007f-\u009f]/u;
/** Cc except TAB and LF (Core's argv rule). */
const CC_EXCEPT_TAB_LF = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * A reason Core WOULD refuse this label, or `null`. A subset of Core's rule
 * (empty after Core's trim, longer than 80 characters, a control character):
 * Core also refuses bidi and invisible format characters, which this build
 * leaves to Core rather than risk being stricter.
 */
export function labelProblem(label: string): string | null {
  const trimmed = label.replace(RUST_TRIM, "");
  if (trimmed.length === 0) return "The label is empty.";
  if (Array.from(trimmed).length > MAX_VERIFICATION_LABEL_CHARS) {
    return `The label is longer than ${MAX_VERIFICATION_LABEL_CHARS} characters.`;
  }
  if (CC.test(trimmed)) return "The label contains a control character.";
  return null;
}

/**
 * A reason Core WOULD refuse this argv shape, or `null` — exactly Core's
 * `verification_argv` rule (1..=64 elements, 4096 bytes each, 16 KiB in all,
 * no control character except TAB and LF, the program non-empty and not
 * starting with `-`). The secret check is Core's alone.
 */
export function argvProblem(argv: readonly string[]): string | null {
  if (argv.length === 0 || argv.length > MAX_VERIFICATION_ARGS) {
    return `The argument list must have 1 to ${MAX_VERIFICATION_ARGS} elements (it has ${argv.length}).`;
  }
  let total = 0;
  for (const [i, a] of argv.entries()) {
    const n = i + 1;
    const bytes = utf8Bytes(a);
    if (bytes > MAX_VERIFICATION_ARG_BYTES) return `Argument ${n} is longer than ${MAX_VERIFICATION_ARG_BYTES} bytes.`;
    if (a.includes("\u0000")) return `Argument ${n} contains a NUL character.`;
    if (CC_EXCEPT_TAB_LF.test(a)) return `Argument ${n} contains a control character.`;
    total += bytes;
  }
  if (total > MAX_VERIFICATION_ARGV_BYTES) return `The arguments are longer than ${MAX_VERIFICATION_ARGV_BYTES} bytes in total.`;
  const program = argv[0] ?? "";
  if (program.length === 0) return "Argument 1 (the program) is empty.";
  if (program.startsWith("-")) return "Argument 1 (the program) must not start with '-'.";
  return null;
}

// ---------------------------------------------------------------------------
// Approve (item 8)
// ---------------------------------------------------------------------------

export const APPROVE_NO_SECRETS = "Do not put tokens or passwords in arguments.";
export const APPROVE_BINDS_STATEMENT =
  "Approval binds this exact argument list, not what it executes. Commands such as `npm run test`, `make test` or `./gradlew test` run code from the repository that the agent can change after you approve.";
export const APPROVE_NO_SHELL =
  "Nothing is interpreted: no shell, no splitting, no globbing. Each element below is passed as one argument, exactly as shown.";

/**
 * Where an approve draft came from: typed by the user, or a project.context
 * suggestion. `suggestedArgv` is the suggestion exactly as Core listed it:
 * Core's notes describe THAT argv, so they are shown only while the draft
 * still equals it (see `effectiveApproveSource`).
 */
export type ApproveSource =
  | { kind: "manual" }
  | {
      kind: "suggestion";
      repoPath: string;
      manifest: string;
      notes: readonly string[];
      suggestedArgv: readonly string[];
    };

/**
 * D-I4: once the user edits a suggestion's argv so it differs (element by
 * element) from what Core suggested, the draft is the user's own command —
 * the "Suggested from …" heading and Core's notes are dropped from the draft
 * and from the confirmation, because they described a different argv.
 */
export function effectiveApproveSource(argv: readonly string[], source: ApproveSource): ApproveSource {
  if (source.kind === "manual") return { kind: "manual" };
  const same =
    argv.length === source.suggestedArgv.length && argv.every((element, i) => element === source.suggestedArgv[i]);
  if (!same) return { kind: "manual" };
  return { ...source, notes: [...source.notes], suggestedArgv: [...source.suggestedArgv] };
}

export interface ApproveDraft {
  projectId: string;
  label: string;
  argv: readonly string[];
  source: ApproveSource;
}

/** What the approve confirmation shows and, on Approve, sends — frozen at the click. */
export interface ApproveSnapshot {
  request: { projectId: string; label: string; argv: string[] };
  source: ApproveSource;
}

/** Why the draft cannot be confirmed yet (early feedback), or `null`. */
export function approveDraftProblem(draft: ApproveDraft): string | null {
  return labelProblem(draft.label) ?? argvProblem(draft.argv);
}

/**
 * The approve confirmation opens ONLY from a trusted (browser-generated)
 * click on Sandpane's own control, never from a scripted event, a timer, a
 * reconnect, an event, chat, agent or tool text. Returns the frozen snapshot,
 * or `null`. argv is copied element by element — never split, trimmed or joined.
 */
export function openApproveConfirmation(
  event: { nativeEvent?: { isTrusted?: boolean } } | null | undefined,
  draft: ApproveDraft,
): ApproveSnapshot | null {
  if (event?.nativeEvent?.isTrusted !== true) return null;
  if (approveDraftProblem(draft) !== null) return null;
  return {
    request: { projectId: draft.projectId, label: draft.label, argv: [...draft.argv] },
    source: effectiveApproveSource(draft.argv, draft.source),
  };
}

/**
 * D-I3: the revoke confirmation opens ONLY from a trusted click on the row's
 * own Revoke… control, like approve and run. Returns a frozen copy of the
 * command, or `null`.
 */
export function openRevokeConfirmation(
  event: { nativeEvent?: { isTrusted?: boolean } } | null | undefined,
  command: VerificationCommand,
): VerificationCommand | null {
  if (event?.nativeEvent?.isTrusted !== true) return null;
  return { ...command, argv: [...command.argv] };
}

// ---------------------------------------------------------------------------
// Run (items 1, 4, 8)
// ---------------------------------------------------------------------------

export const RUN_NOT_BOUND_REASON = "this task is not bound to a sandbox";
export const RUN_STATEMENT =
  "Runs in sbx's default working directory inside the sandbox; the result is the exit status reported by sbx exec; not yet verified against a real sbx.";
/** §3.7 item 4 (I7), verbatim. */
export const DIRECT_MOUNT_RUN_WARNING =
  "this sandbox mounts your repository directly; the command can change your working tree, including `.git/hooks` that later run on your machine";
/** §3.7 item 8 (I7). */
export const HOST_WORKTREE_RUN_WARNING =
  "The command can change files in the task's workspace, so a review you took before may no longer match: a later apply then refuses \"changed since reviewed\", and you review again.";
/** The plain statement for every real sbx in A7 (UNSUPPORTED_SBX_VERSION). */
export const RUN_UNVERIFIED_NOTICE =
  "Running is disabled until this sbx version's `sbx exec` behaviour has been captured and verified; your approved commands are kept.";
/** D-I2: shown in the run confirmation while an earlier run's outcome is unknown. */
export const EARLIER_RUN_UNKNOWN_WARNING = "An earlier run of this task may have started; check Results first.";
export const RUN_NO_CANCEL_NOTE =
  "A running verification cannot be cancelled from Sandpane. Stopping the sandbox ends it.";

export type RunBinding =
  | { ok: true; expectedSandboxName: string; expectedWorkspaceMode: WorkspaceMode }
  | { ok: false; reason: string };

/**
 * The two `expected*` values for `verification.run`, from the task's BINDING
 * (`sandboxName` — never `chosenSandboxName`) and the `sandbox.list` entry of
 * that exact name. Anything missing or unrecognised disables Run.
 */
export function runBinding(
  task: { sandboxName: string | null } | null,
  sandboxes: readonly Pick<SandboxSummary, "name" | "workspaceMode">[],
  sandboxListAvailable: boolean,
): RunBinding {
  if (task === null || task.sandboxName === null || task.sandboxName.length === 0) {
    return { ok: false, reason: RUN_NOT_BOUND_REASON };
  }
  const row = sandboxes.find((s) => s.name === task.sandboxName);
  if (row === undefined && !sandboxListAvailable) {
    return {
      ok: false,
      reason: "Core's sandbox list is unavailable right now (loading or failed), so the task's sandbox cannot be confirmed",
    };
  }
  if (row === undefined || row.workspaceMode === null || !(WORKSPACE_MODES as readonly string[]).includes(row.workspaceMode)) {
    return { ok: false, reason: RUN_NOT_BOUND_REASON };
  }
  return { ok: true, expectedSandboxName: row.name, expectedWorkspaceMode: row.workspaceMode };
}

/** What the run confirmation shows and, on Run, sends (plus a fresh key) — frozen at the click. */
export interface RunSnapshot {
  taskId: string;
  command: VerificationCommand;
  expectedSandboxName: string;
  expectedWorkspaceMode: WorkspaceMode;
  /** An earlier run's answer was lost: the dialog says it may have started (D-I2). */
  earlierRunMayHaveStarted: boolean;
}

/**
 * The run confirmation opens ONLY from a trusted click on Sandpane's Run
 * control, and only for a bound task and a command Core listed for the
 * task's project. Returns the frozen snapshot, or `null`.
 */
export function openRunConfirmation(
  event: { nativeEvent?: { isTrusted?: boolean } } | null | undefined,
  input: { taskId: string; command: VerificationCommand | null; binding: RunBinding; earlierRunUnknown: boolean },
): RunSnapshot | null {
  if (event?.nativeEvent?.isTrusted !== true) return null;
  if (input.command === null || !input.binding.ok) return null;
  return {
    taskId: input.taskId,
    command: { ...input.command, argv: [...input.command.argv] },
    expectedSandboxName: input.binding.expectedSandboxName,
    expectedWorkspaceMode: input.binding.expectedWorkspaceMode,
    earlierRunMayHaveStarted: input.earlierRunUnknown,
  };
}

/**
 * Why Run is unavailable right now, or null. Only a run IN FLIGHT blocks: an
 * earlier run whose outcome is unknown does not — a new deliberate gesture
 * may run again, and its confirmation says the earlier one may have started.
 */
export function runBlockedReason(input: {
  projectId: string | null;
  binding: RunBinding;
  commandCount: number;
  command: VerificationCommand | null;
  pending: boolean;
}): string | null {
  if (input.projectId === null) return "this task's project is not known here, so its approved commands cannot be listed";
  if (!input.binding.ok) return input.binding.reason;
  if (input.commandCount === 0) return "the project has no approved commands";
  if (input.command === null) return "choose a command";
  if (input.pending) return "a run of this task is being started";
  return null;
}

/** The workspace-mode warnings the run dialog shows for this binding. */
export function runModeWarnings(mode: WorkspaceMode): string[] {
  if (mode === "direct_mount") return [DIRECT_MOUNT_RUN_WARNING];
  if (mode === "host_worktree") return [HOST_WORKTREE_RUN_WARNING];
  return [];
}

/**
 * Right before "Retry safely": the CURRENT Core must still advertise
 * `idempotency-keys`, the `verification` feature and `verification.run`;
 * otherwise nothing is sent.
 */
export function runKeyRecheckFromProbe(outcome: ProbeOutcome): KeyRecheck {
  if (outcome.kind === "unreachable") return { kind: "unreachable", error: outcome.error };
  if (outcome.kind === "version_mismatch") return { kind: "not-advertised" };
  const caps = outcome.capabilities;
  if (!coreAdvertisesFeature(caps, FEATURE_IDEMPOTENCY_KEYS)) return { kind: "not-advertised" };
  if (!coreAdvertisesFeature(caps, FEATURE_VERIFICATION) || !coreAdvertisesMethod(caps, "verification.run")) {
    return {
      kind: "not-retried",
      note: "Not retried: the connected Core no longer advertises verification, so nothing was sent. Check the task's events first.",
    };
  }
  return { kind: "advertised" };
}

// ---------------------------------------------------------------------------
// Outcomes and disclosures (items 5–6; I4)
// ---------------------------------------------------------------------------

// Outcome copy lives in reducers.ts (shared with the event timeline, no
// import cycle); re-exported here for the verification surfaces.
export { exitStatusText, outcomeView, type OutcomeView } from "./reducers";

export {
  DISCLOSURE_BEST_EFFORT,
  DISCLOSURE_OUTPUT_INCOMPLETE,
  DISCLOSURE_OUTPUT_PRUNED,
  DISCLOSURE_OUTPUT_WITHHELD,
  redactedCountText,
} from "./reducers";
import { DISCLOSURE_OUTPUT_PRUNED } from "./reducers";

/** Every disclosure flag of a stored result, in a fixed order. */
export function resultDisclosures(
  result: Pick<
    VerificationResult,
    "stdoutTruncated" | "stderrTruncated" | "outputIncomplete" | "outputPruned" | "redactions"
  >,
): string[] {
  // A9 precedence (§3.9 item 2): pruned output is not truncated output.
  if (result.outputPruned === true) return [DISCLOSURE_OUTPUT_PRUNED];
  const out: string[] = [];
  if (result.stdoutTruncated) out.push("stdout was cut at Core's 64 KiB cap");
  if (result.stderrTruncated) out.push("stderr was cut at Core's 64 KiB cap");
  if (result.outputIncomplete === true) out.push(DISCLOSURE_OUTPUT_INCOMPLETE);
  if (result.redactions.outputWithheld === true) out.push(DISCLOSURE_OUTPUT_WITHHELD);
  if (result.redactions.replacements > 0) out.push(redactedCountText(result.redactions.replacements));
  return out;
}

// ---------------------------------------------------------------------------
// Failure copy (exact Core texts; honest about what ran)
// ---------------------------------------------------------------------------

export type VerificationOp = "list" | "context" | "result" | "approve" | "revoke" | "run";

export interface VerificationFailureCopy {
  title: string;
  /** Core's (or the transport's) own text, revealed and capped. */
  reason: string;
  action: string;
  /** Core's `details.hint` advice (secret refusals), revealed — advice, never a command. */
  advice?: string;
  /** Frame refusals: the ids / names Core listed in `details`, revealed. */
  listed?: string[];
  tone: StatusTone;
  /** Offer "Retry safely" (run only: keyed request, unknown outcome). */
  retrySafely: boolean;
}

function reasonOf(err: CoreRequestError): string {
  return displayRevealed(err.message, CORE_REASON_MAX_CHARS).text;
}

function hintOf(err: CoreRequestError): string | undefined {
  const details = err.details;
  if (typeof details !== "object" || details === null) return undefined;
  const hint = (details as Record<string, unknown>).hint;
  return typeof hint === "string" ? displayRevealed(hint, HINT_DISPLAY_MAX_CHARS).text : undefined;
}

/** The ids / names a frame refusal lists in `details` (revealed, at most 20). */
function frameRefusalListed(err: CoreRequestError): string[] | undefined {
  const details = err.details;
  if (typeof details !== "object" || details === null) return undefined;
  const rec = details as Record<string, unknown>;
  const raw = Array.isArray(rec.commandIds)
    ? rec.commandIds
    : Array.isArray(rec.repositories)
      ? rec.repositories
      : typeof rec.runId === "string"
        ? [rec.runId]
        : undefined;
  if (raw === undefined) return undefined;
  return raw
    .slice(0, 20)
    .map((v) =>
      typeof v === "string"
        ? displayRevealed(v, NAME_DISPLAY_MAX_CHARS).text
        : typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).repoPath === "string"
          ? displayRevealed((v as Record<string, string>).repoPath, NAME_DISPLAY_MAX_CHARS).text
          : "(unreadable entry)",
    );
}

function copy(
  err: CoreRequestError,
  title: string,
  action: string,
  tone: StatusTone = "attention",
  extra: Partial<VerificationFailureCopy> = {},
): VerificationFailureCopy {
  return { title, reason: reasonOf(err), action, tone, retrySafely: false, ...extra };
}

/** The generic copy, revealed — never claims more than Core said. */
function generic(err: CoreRequestError): VerificationFailureCopy {
  const d = describeCoreError(err);
  return { title: d.title, reason: d.reason, action: d.action, tone: d.tone, retrySafely: false };
}

/** A read's lost-answer text without the write-only "may have been applied" sentence. */
function withoutAppliedCopy(message: string): string {
  let out = message;
  for (const tail of [PROXY_MAY_HAVE_BEEN_APPLIED_SUFFIX, ` ${MAY_HAVE_BEEN_APPLIED_COPY}`]) {
    if (out.endsWith(tail)) out = out.slice(0, -tail.length);
  }
  return out;
}

const READ_WHAT: Record<"list" | "context" | "result", string> = {
  list: "the approved commands",
  context: "the project context",
  result: "the verification result",
};

/**
 * Failure copy for one verification exchange. Reads never say "may have been
 * applied"; a lost run answer says the run MAY HAVE STARTED; the version gate
 * is never worded as the command failing.
 */
export function verificationFailureCopy(raw: unknown, op: VerificationOp): VerificationFailureCopy {
  const err = asCoreRequestError(raw);
  const code = coreErrorCode(err);

  // Frame refusals (W1 backstop): Core's text, the listed parts, never retried.
  if (code === "VALIDATION_FAILED" && isFrameRefusal(err.message)) {
    const listed = frameRefusalListed(err);
    return copy(
      err,
      `Core refused to return ${op === "list" ? READ_WHAT.list : op === "context" ? READ_WHAT.context : READ_WHAT.result}: the answer would not fit one frame`,
      op === "list"
        ? "Nothing was returned. Revoke the largest commands (listed below, largest first), then refresh. This view never retries by itself."
        : op === "context"
          ? "Nothing was returned. The repositories or approved commands listed below are the largest parts; remove or revoke some, then refresh."
          : "Nothing was returned for this run. Its stored output is too large to send in one frame.",
      "attention",
      listed === undefined ? {} : { listed },
    );
  }

  if (op === "list" || op === "context" || op === "result") {
    // A read changes nothing: a lost answer or a timeout is "no answer", never
    // "may have been applied" (the proxy never says so for a read; the
    // webview's own timeout copy is replaced here).
    if (!err.isCoreError && (err.code === "TIMEOUT" || err.mayHaveBeenApplied)) {
      return {
        title: `Core did not answer while reading ${READ_WHAT[op]}`,
        reason: displayRevealed(withoutAppliedCopy(err.message), CORE_REASON_MAX_CHARS).text,
        action: "This is a read: nothing was changed. Refresh to ask again.",
        tone: "attention",
        retrySafely: false,
      };
    }
    if (code === "NOT_FOUND" && err.message === MSG_RUN_NOT_FOUND) {
      return copy(err, "Core has no record of this verification run", "Refresh the task's events.");
    }
    return generic(err);
  }

  if (op === "approve") {
    if (isUnknownOutcome(err)) {
      return copy(
        err,
        "Outcome unknown — the command may have been approved",
        "Refresh the approved commands before approving again (approving the same arguments again returns the existing command).",
      );
    }
    if (code === "VALIDATION_FAILED") {
      if (secretRefusalKind(err.message) !== null) {
        const advice = hintOf(err);
        return copy(
          err,
          "Nothing was approved — Core's secret check refused it",
          "Remove the secret-like value. Approved commands cannot hold secrets, and there is no override.",
          "attention",
          advice === undefined ? {} : { advice },
        );
      }
      if (err.message === MSG_SECRET_CHECK_UNAVAILABLE) {
        return copy(err, "Nothing was approved — Core's secret check is unavailable", "Core fails closed; try again later.");
      }
      if (err.message === MSG_TOO_MANY_COMMANDS) {
        return copy(err, "Nothing was approved — this project already has 50 approved commands", "Revoke one first, then approve again.");
      }
      if (err.message.startsWith(ARGV_SHAPE_PREFIX)) {
        return copy(err, "Nothing was approved — Core refused the argument list", "Fix the argument named in Core's reason, then approve again.");
      }
      if (err.message.startsWith(LABEL_REFUSAL_PREFIX)) {
        return copy(err, "Nothing was approved — Core refused the label", "Use 1 to 80 visible characters, then approve again.");
      }
    }
    const project = projectMessageCopy(String(err.code), err.message);
    if (project !== null) return copy(err, project.title, project.action);
    return generic(err);
  }

  if (op === "revoke") {
    if (isUnknownOutcome(err)) {
      return copy(err, "Outcome unknown — the command may have been revoked", "Refresh the approved commands; revoking again is harmless.");
    }
    if (code === "NOT_FOUND" && err.message === MSG_COMMAND_NOT_FOUND) {
      return copy(err, "Core has no such command", "Refresh the approved commands.");
    }
    return generic(err);
  }

  // op === "run"
  if (isUnknownOutcome(err)) {
    const keyed =
      typeof err.details === "object" &&
      err.details !== null &&
      (err.details as Record<string, unknown>).idempotencyKeyed === true;
    return copy(
      err,
      "Outcome unknown — the run may have started",
      keyed
        ? "Check the task's events for a verification start. Retry safely resends the identical request with the same idempotency key, so Core returns the first answer instead of running it twice."
        : "Check the task's events for a verification start before running again; a new run could run it twice.",
      "attention",
      { retrySafely: keyed },
    );
  }
  if (code === "UNSUPPORTED_SBX_VERSION" && isExecUnverified(err.message)) {
    return copy(err, "Nothing was run — running is disabled for this sbx version", RUN_UNVERIFIED_NOTICE, "attention");
  }
  if (code === "NOT_INSTALLED") {
    return copy(err, "Nothing was run — sbx is not installed", "Install the official sbx CLI; Sandpane never bundles it.", "danger");
  }
  const idem = idempotencyConflictKind(err);
  if (idem !== null) {
    const c = idempotencyConflictCopy(idem);
    return copy(err, c.title, c.action, c.nothingRan ? "attention" : "danger");
  }
  if (code === "CONFLICT") {
    switch (err.message) {
      case MSG_VERIFICATION_TASK_BUSY:
        return copy(err, "Nothing was run — a verification is already running for this task", "Wait for its result, then run again.");
      case MSG_VERIFICATION_SANDBOX_BUSY:
        return copy(err, "Nothing was run — a verification is already running in this sandbox", "Wait for it to finish, then run again.");
      case MSG_VERIFICATION_CORE_BUSY:
        return copy(err, "Nothing was run — all of Core's 4 verification slots are busy", "Wait for one to finish, then run again.");
    }
    if (err.message.includes(REPO_BUSY_INFIX) && err.message.endsWith(REPO_BUSY_SUFFIX)) {
      return copy(err, "Nothing was run — the repository is busy", "A writer task, an apply, a worktree discard or another verification holds it. Run again when it finishes.");
    }
    if (isNameLockConflict(err.message)) {
      return copy(err, "Nothing was run — another operation on this sandbox is in progress", "Wait for it to finish, then run again.");
    }
  }
  if (code === "VALIDATION_FAILED") {
    switch (err.message) {
      case MSG_VERIFICATION_NOT_BOUND:
        return copy(err, "Nothing was run — this task is not bound to a sandbox", "No wire-created task is bound to a sandbox yet.");
      case MSG_VERIFICATION_SANDBOX_CHANGED:
        return copy(err, "Nothing was run — the task's sandbox changed since you confirmed", "Refresh, review the sandbox shown, and run again if it is still what you want.");
      case MSG_VERIFICATION_IDENTITY:
        return copy(err, "Nothing was run — Core cannot confirm the sandbox's identity", "Check the sandbox with sbx in a terminal; Core refuses rather than run in a sandbox it cannot identify.");
      case MSG_COMMAND_REVOKED:
        return copy(err, "Nothing was run — this command was revoked", "Refresh the approved commands.");
      case MSG_COMMAND_OTHER_PROJECT:
        return copy(err, "Nothing was run — the command belongs to another project", "Refresh the approved commands.");
      case MSG_COMMAND_NO_LONGER_PASSES:
        return copy(err, "Nothing was run — this command no longer passes Core's secret check", "Revoke it, then approve a clean version.");
      case MSG_RUN_SECRET_CHECK_UNAVAILABLE:
        return copy(err, "Nothing was run — Core's secret check is unavailable", "Core fails closed; try again later.");
      case MSG_VERIFICATION_SHUTTING_DOWN:
        return copy(err, "Nothing was run — Core is shutting down", "Run again after Core restarts.");
    }
    if (err.message.startsWith(NOT_RUNNING_PREFIX) && err.message.endsWith(NOT_RUNNING_SUFFIX)) {
      return copy(err, "Nothing was run — the sandbox is not running", "sbx exec would start it. Start it with `sbx run` in a terminal, then run again.");
    }
    if (err.message.startsWith(SHAPE_NO_LONGER_PREFIX) && err.message.endsWith(SHAPE_NO_LONGER_SUFFIX)) {
      return copy(err, "Nothing was run — this command no longer passes Core's argument checks", "Revoke it, then approve a corrected version.");
    }
    const lifecycle =
      projectMessageCopy(String(err.code), err.message) ?? conversationMessageCopy(String(err.code), err.message);
    if (lifecycle !== null) return copy(err, lifecycle.title, lifecycle.action);
    if (err.message.endsWith(NOTHING_WAS_RUN_SUFFIX)) {
      return copy(err, "Nothing was run — Core refused before running", "Core's reason is shown above.");
    }
  }
  if (code === "NOT_FOUND") {
    if (err.message === MSG_COMMAND_NOT_FOUND) return copy(err, "Nothing was run — Core has no such command", "Refresh the approved commands.");
    if (err.message === MSG_TASK_NOT_FOUND) return copy(err, "Nothing was run — Core has no such task", "Refresh the task list.");
  }
  return generic(err);
}

/** True when this failure needs the panel's plain UNSUPPORTED_SBX_VERSION statement. */
export function isRunVersionGate(err: unknown): boolean {
  return (
    err instanceof CoreRequestError &&
    coreErrorCode(err) === "UNSUPPORTED_SBX_VERSION" &&
    isExecUnverified(err.message)
  );
}
