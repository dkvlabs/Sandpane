/**
 * A3b conversation-lifecycle messages, VERBATIM from `sandpane-service`
 * (`conversation_lifecycle.rs`, design 2026-10-09 §3.3 item 8). Core uses
 * shared codes (CONFLICT / VALIDATION_FAILED / NOT_FOUND), so the client tells
 * the cases apart by Core's exact text. `tests/conversation-lifecycle.test.ts`
 * reads the Rust consts from disk and fails on any drift.
 *
 * Every message here is a refusal Core issues BEFORE changing anything, which
 * is the only reason the copy below may say "nothing was …". Dependency-free
 * so `reducers.ts` (every error surface) and `conversation-lifecycle.ts` can
 * share it.
 *
 * Behaviour change recorded here: since A3b a send to an ARCHIVED conversation
 * answers `VALIDATION_FAILED` with `MSG_CONVERSATION_ARCHIVED` (it used to be
 * `NOT_FOUND` "conversation not found").
 */

export const MSG_CONVERSATION_ARCHIVED =
  "conversation is archived; unarchive it first; nothing was changed";
export const MSG_CONVERSATION_HAS_TASKS =
  "conversation has tasks that are not finished; cancel or finish them first; nothing was deleted";
export const MSG_CONVERSATION_NOT_FOUND = "conversation not found";
export const MSG_TITLE_BLANK =
  "conversation title must not be empty or whitespace-only; nothing was changed";

/**
 * A4 (`sandpane-service/src/lib.rs`, drift-tested in `tests/send-mode.test.ts`):
 * the frame WAS sent; Core refused the send's `mode` before a key row, a
 * message or a task was created.
 */
export const MSG_SEND_MODE_INVALID = 'mode must be "task" or "discuss"';

/** The Rust const name each message is drift-tested against. */
export const CONVERSATION_MESSAGE_CONSTS: Readonly<Record<string, string>> = {
  MSG_CONVERSATION_ARCHIVED,
  MSG_CONVERSATION_HAS_TASKS,
  MSG_CONVERSATION_NOT_FOUND,
  MSG_TITLE_BLANK,
};

export interface ConversationMessageCopy {
  title: string;
  action: string;
}

/**
 * Copy for one of Core's exact A3b refusals (matched on code AND text), or
 * `null` for anything else — which then gets the generic copy, never a
 * "nothing was …" claim.
 */
export function conversationMessageCopy(code: string, message: string): ConversationMessageCopy | null {
  const key = `${code}\u0000${message}`;
  switch (key) {
    case `VALIDATION_FAILED\u0000${MSG_CONVERSATION_ARCHIVED}`:
      return {
        title: "Nothing was changed — the conversation is archived",
        action: "Unarchive the conversation first, then try again. Its history stays readable meanwhile.",
      };
    case `CONFLICT\u0000${MSG_CONVERSATION_HAS_TASKS}`:
      return {
        title: "Nothing was deleted — the conversation has unfinished tasks",
        action: "Cancel or finish its tasks first, then request a new confirmation.",
      };
    case `NOT_FOUND\u0000${MSG_CONVERSATION_NOT_FOUND}`:
      return {
        title: "Nothing was changed — Core has no conversation with this id",
        action: "It may have been deleted elsewhere; re-read the conversation list.",
      };
    case `VALIDATION_FAILED\u0000${MSG_TITLE_BLANK}`:
      return {
        title: "Nothing was changed — the title is empty or whitespace-only",
        action: "Type a title with at least one visible character.",
      };
    case `VALIDATION_FAILED\u0000${MSG_SEND_MODE_INVALID}`:
      return {
        title: "Core did not accept the message — it refused the send mode",
        action:
          "Core accepts only \"task\" or \"discuss\". This build sends \"discuss\" only when Core advertises conversation-send-mode; re-check Core and send again.",
      };
    default:
      return null;
  }
}
