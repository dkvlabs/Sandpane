/**
 * A7 verification refusals, VERBATIM from Core (design 2026-10-09 §3.7):
 * `sandpane-service/src/verification.rs`, `sandpane-core/src/verification.rs`
 * and `sandpane-core/src/validation.rs`. `tests/verification.test.ts` reads
 * the Rust sources from disk and fails on any drift (whole constants with
 * `rustStrConst`, and the fixed fragments of each `format!` template).
 *
 * Core uses shared codes (VALIDATION_FAILED / CONFLICT / NOT_FOUND /
 * UNSUPPORTED_SBX_VERSION), so the client tells the cases apart by Core's
 * exact text. Only a message Core issues BEFORE it acts may be worded as
 * "nothing was …". Dependency-free so `reducers.ts` (every error surface)
 * and `verification.ts` can share it.
 */

// ---- verification.run gates (sandpane-service verification.rs) ------------

export const MSG_VERIFICATION_NOT_BOUND = "this task is not bound to a sandbox; nothing was run";
export const MSG_VERIFICATION_SANDBOX_CHANGED =
  "the task's sandbox changed since you confirmed; nothing was run";
export const MSG_VERIFICATION_IDENTITY = "Core cannot confirm the sandbox's identity; nothing was run";
export const MSG_VERIFICATION_TASK_BUSY =
  "a verification is already running for this task; wait for it to finish; nothing was run";
export const MSG_VERIFICATION_SANDBOX_BUSY =
  "a verification is already running in this sandbox; wait for it to finish; nothing was run";
export const MSG_VERIFICATION_CORE_BUSY =
  "a verification is already running in each of Core's 4 verification slots; wait for one to finish; nothing was run";
export const MSG_VERIFICATION_SHUTTING_DOWN = "Core is shutting down; nothing was run";
export const MSG_COMMAND_NOT_FOUND = "verification command not found";
export const MSG_COMMAND_REVOKED = "this verification command was revoked; nothing was run";
export const MSG_COMMAND_OTHER_PROJECT = "this verification command belongs to another project; nothing was run";
export const MSG_RUN_NOT_FOUND = "verification run not found";
export const MSG_TASK_NOT_FOUND = "task not found";
export const MSG_TOO_MANY_COMMANDS =
  "this project already has 50 approved verification commands, the most it can hold; revoke one first; nothing was approved";
export const MSG_VERSION_UNREADABLE =
  "sbx exec argument passing has not been verified for this sbx (Core could not read its version); nothing was run";
export const MSG_COMMAND_NO_LONGER_PASSES =
  "this command no longer passes the secret check; revoke it; nothing was run";
export const MSG_RUN_SECRET_CHECK_UNAVAILABLE = "the secret check is unavailable, so nothing was run";

// ---- delete refusals while a run is in flight (CONFLICT, steps 1 and 2) ---

export const MSG_PROJECT_VERIFICATION_RUNNING =
  "a verification is running for a task of this project; wait for it to finish; nothing was deleted";
export const MSG_CONVERSATION_VERIFICATION_RUNNING =
  "a verification is running for a task of this conversation; wait for it to finish; nothing was deleted";
export const MSG_SANDBOX_VERIFICATION_RUNNING =
  "a verification is running in this sandbox; wait for it to finish; nothing was deleted";

// ---- approve (sandpane-core verification.rs) ------------------------------

export const MSG_SECRET_CHECK_UNAVAILABLE = "the secret check is unavailable, so nothing was approved";
/** Core's advice for a secret refusal, sent in `details.hint` (never a command to run). */
export const SECRET_REFUSAL_HINT =
  "if this is not a secret, rename the argument or move it into a script; approved commands cannot hold secrets and there is no override";

/** The three `ApprovalRefusal::message` templates share this tail. */
export const SECRET_REFUSAL_SUFFIX = "); approved commands cannot hold secrets; nothing was approved";
/** `argument {number} looks like a secret (` — the infix after the number. */
export const SECRET_ARGUMENT_INFIX = " looks like a secret (";
export const SECRET_ARGUMENT_PREFIX = "argument ";
export const SECRET_LABEL_PREFIX = "the label looks like a secret (";
export const SECRET_COMBINED_PREFIX = "the arguments together look like a secret (";

/** Shape refusals: `argv: {ValidationError}` / `label: {ValidationError}`. */
export const ARGV_SHAPE_PREFIX = "argv: value has an invalid shape: ";
export const LABEL_REFUSAL_PREFIX = "label: ";

// ---- format! templates (fixed fragments) ----------------------------------

/** `msg_exec_unverified`: `…for sbx {version}; nothing was run`. */
export const EXEC_UNVERIFIED_PREFIX = "sbx exec argument passing has not been verified for sbx ";
export const NOTHING_WAS_RUN_SUFFIX = "; nothing was run";
/** `msg_sandbox_not_running`: `sandbox "{name}" is not running; …`. */
export const NOT_RUNNING_PREFIX = 'sandbox "';
export const NOT_RUNNING_SUFFIX =
  '" is not running; sbx exec would start it; start it with `sbx run` in a terminal; nothing was run';
/** `msg_verification_repo_busy`: `{repo} is busy: {holder} holds its writer lock (…); …`. */
export const REPO_BUSY_INFIX = " is busy: ";
export const REPO_BUSY_SUFFIX =
  " holds its writer lock (a running writer task, an apply, a worktree discard or another verification); a verification is already running or the repository is being written; nothing was run";
/** `msg_command_shape_no_longer_passes`: `…argument checks ({why}); revoke it; nothing was run`. */
export const SHAPE_NO_LONGER_PREFIX = "this command no longer passes the argument checks (";
export const SHAPE_NO_LONGER_SUFFIX = "); revoke it; nothing was run";
/** `frame_refusal`: `the response would exceed the frame limit (…); {what}; nothing was returned`. */
export const FRAME_REFUSAL_PREFIX = "the response would exceed the frame limit (";
export const FRAME_REFUSAL_SUFFIX = "; nothing was returned";

/** The Rust const name each whole message is drift-tested against, and its file. */
export const VERIFICATION_SERVICE_CONSTS: Readonly<Record<string, string>> = {
  MSG_VERIFICATION_NOT_BOUND,
  MSG_VERIFICATION_SANDBOX_CHANGED,
  MSG_VERIFICATION_IDENTITY,
  MSG_VERIFICATION_TASK_BUSY,
  MSG_VERIFICATION_SANDBOX_BUSY,
  MSG_VERIFICATION_CORE_BUSY,
  MSG_VERIFICATION_SHUTTING_DOWN,
  MSG_COMMAND_NOT_FOUND,
  MSG_COMMAND_REVOKED,
  MSG_COMMAND_OTHER_PROJECT,
  MSG_RUN_NOT_FOUND,
  MSG_TASK_NOT_FOUND,
  MSG_TOO_MANY_COMMANDS,
  MSG_VERSION_UNREADABLE,
  MSG_COMMAND_NO_LONGER_PASSES,
  MSG_RUN_SECRET_CHECK_UNAVAILABLE,
  MSG_PROJECT_VERIFICATION_RUNNING,
  MSG_CONVERSATION_VERIFICATION_RUNNING,
  MSG_SANDBOX_VERIFICATION_RUNNING,
};
export const VERIFICATION_CORE_CONSTS: Readonly<Record<string, string>> = {
  MSG_SECRET_CHECK_UNAVAILABLE,
  SECRET_REFUSAL_HINT,
};

export type SecretRefusalKind = "argument" | "label" | "combined";

/** Which secret refusal `message` is (matched on Core's template), or `null`. */
export function secretRefusalKind(message: string): SecretRefusalKind | null {
  if (!message.endsWith(SECRET_REFUSAL_SUFFIX)) return null;
  if (message.startsWith(SECRET_LABEL_PREFIX)) return "label";
  if (message.startsWith(SECRET_COMBINED_PREFIX)) return "combined";
  if (/^argument \d+ looks like a secret \(/.test(message)) return "argument";
  return null;
}

/** `UNSUPPORTED_SBX_VERSION` from the A7 version gate (either variant). */
export function isExecUnverified(message: string): boolean {
  return (
    message === MSG_VERSION_UNREADABLE ||
    (message.startsWith(EXEC_UNVERIFIED_PREFIX) && message.endsWith(NOTHING_WAS_RUN_SUFFIX))
  );
}

/** A W1 frame refusal ("…; nothing was returned"). */
export function isFrameRefusal(message: string): boolean {
  return message.startsWith(FRAME_REFUSAL_PREFIX) && message.endsWith(FRAME_REFUSAL_SUFFIX);
}

export interface VerificationMessageCopy {
  title: string;
  action: string;
}

/**
 * Copy for a delete refused because a verification is in flight (CONFLICT,
 * any method that deletes), or `null`. Core refuses BEFORE deleting, so the
 * copy may say nothing was deleted.
 */
export function verificationDeleteRefusalCopy(code: string, message: string): VerificationMessageCopy | null {
  if (code !== "CONFLICT") return null;
  switch (message) {
    case MSG_PROJECT_VERIFICATION_RUNNING:
      return {
        title: "Nothing was deleted — a verification is running for a task of this project",
        action: "Wait for the verification to finish, then request a new confirmation.",
      };
    case MSG_CONVERSATION_VERIFICATION_RUNNING:
      return {
        title: "Nothing was deleted — a verification is running for a task of this conversation",
        action: "Wait for the verification to finish, then request a new confirmation.",
      };
    case MSG_SANDBOX_VERIFICATION_RUNNING:
      return {
        title: "Nothing was deleted — a verification is running in this sandbox",
        action:
          "Wait for it to finish, then request a new confirmation. Stopping the sandbox is still allowed and ends the run.",
      };
    default:
      return null;
  }
}
