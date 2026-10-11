/**
 * Pure helpers for the A3b conversation lifecycle (design 2026-10-09 §3.3):
 * Core's exact user-facing messages (drift-tested against
 * conversation_lifecycle.rs / confirm.rs), their plain client copy, the delete
 * confirmation view (A1 two-step pattern), the "sandbox chosen at creation"
 * label, the title derived from a first message and the export file name.
 * No `vscode` import.
 */

import type { ConfirmationRequest, Conversation } from '../core-client/protocol';
import { CoreRpcError } from '../core-client/connection';
import {
  CoreValidationError,
  MAX_CONVERSATION_TITLE_CHARS,
  validateConversationRenameTitle,
} from '../core-client/commands';
import { inspectHidden, plainText } from '../text/visibleText';
import { TOKEN_REJECTED_MESSAGE } from './projectActions';
import {
  EXTERNAL_MARKER,
  EXTERNAL_TEXT,
  MAX_IDENTITY_CHARS,
  MAX_IMPACT_LINES,
  MAX_IMPACT_LINE_CHARS,
  describeExpiry,
} from './sandboxActions';
import { CONVERSATION_VERIFICATION_RUNNING_COPY, MSG_CONVERSATION_VERIFICATION_RUNNING } from './verification';

// --- Core's exact messages (sandpane-service conversation_lifecycle.rs) ---
export const MSG_CONVERSATION_ARCHIVED = 'conversation is archived; unarchive it first; nothing was changed';
export const MSG_CONVERSATION_HAS_TASKS =
  'conversation has tasks that are not finished; cancel or finish them first; nothing was deleted';
export const MSG_CONVERSATION_NOT_FOUND = 'conversation not found';
export const MSG_TITLE_BLANK = 'conversation title must not be empty or whitespace-only; nothing was changed';

/** Plain copy per exact Core message; each keeps Core's "nothing was …". */
const COPY: ReadonlyArray<[code: string, message: string, copy: string]> = [
  ['VALIDATION_FAILED', MSG_CONVERSATION_ARCHIVED, 'This conversation is archived. Unarchive it first; nothing was changed.'],
  [
    'CONFLICT',
    MSG_CONVERSATION_HAS_TASKS,
    'The conversation has unfinished tasks. Cancel or finish them first; nothing was deleted.',
  ],
  // A7: Core refuses a delete while a verification runs for one of the conversation's tasks.
  ['CONFLICT', MSG_CONVERSATION_VERIFICATION_RUNNING, CONVERSATION_VERIFICATION_RUNNING_COPY],
  ['NOT_FOUND', MSG_CONVERSATION_NOT_FOUND, 'Core has no such conversation (it may have been deleted); nothing was changed.'],
  ['VALIDATION_FAILED', MSG_TITLE_BLANK, 'The title must not be empty or whitespace-only; nothing was changed.'],
];

const TOKEN_COPY =
  'Core refused the confirmation (invalid, expired or already used). Nothing was deleted — run Delete Conversation again for a fresh confirmation.';

function rpcMessage(error: CoreRpcError): string {
  const prefix = `${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/**
 * Honest copy for one of Core's exact A3b messages, or `null` for anything
 * else (the caller then reports it generically, or as UNKNOWN). A1's token
 * rejection is mapped only for the delete flow (`{delete: true}`).
 */
export function conversationErrorCopy(error: unknown, options: { delete?: boolean } = {}): string | null {
  if (!(error instanceof CoreRpcError)) return null;
  const message = rpcMessage(error);
  for (const [code, exact, copy] of COPY) {
    if (error.code === code && message === exact) return copy;
  }
  if (options.delete === true && error.code === 'VALIDATION_FAILED' && message === TOKEN_REJECTED_MESSAGE) {
    return TOKEN_COPY;
  }
  return null;
}

/** Is `error` Core's exact "conversation not found"? */
export function isConversationNotFound(error: unknown): boolean {
  return error instanceof CoreRpcError && error.code === 'NOT_FOUND' && rpcMessage(error) === MSG_CONVERSATION_NOT_FOUND;
}

export const ARCHIVED_CONVERSATION_LABEL = 'ARCHIVED';

/** Is this conversation archived according to Core's record? */
export function isConversationArchived(conversation: Pick<Conversation, 'archivedAt'>): boolean {
  return typeof conversation.archivedAt === 'string' && conversation.archivedAt.length > 0;
}

/**
 * "Sandbox chosen at creation" — ONLY when Core advertises
 * `conversation-sandbox-id` (otherwise an absent value cannot be told apart
 * from an older Core that discarded it). It is a stored NAME, never a binding:
 * it may no longer exist, and a same-named replacement is indistinguishable.
 * Absent means none was recorded (rows from before A3b are absent too).
 */
export function conversationSandboxLabel(
  conversation: Pick<Conversation, 'sandboxId'>,
  featureAdvertised: boolean,
  /** Names from the last successful `sandbox.list`; `null` = no list could be read. */
  listedSandboxNames: readonly string[] | null,
): string | null {
  if (!featureAdvertised) return null;
  const name = conversation.sandboxId;
  if (typeof name !== 'string' || name.length === 0) return 'no sandbox recorded at creation';
  const shown = plainText(name, MAX_IDENTITY_CHARS);
  if (listedSandboxNames === null) return `sandbox chosen at creation: ${shown} (the sandbox list could not be read)`;
  return listedSandboxNames.includes(name)
    ? `sandbox chosen at creation: ${shown}`
    : `sandbox chosen at creation: ${shown} (not in the current sandbox list)`;
}

/** At most this many code points of a first message become the new conversation's title. */
export const DERIVED_TITLE_CHARS = 80;

/**
 * A `conversation.create` title derived from the first message: one line, every
 * character `Validator::conversation_title` refuses (controls incl. `\n`/`\t`,
 * separators, bidi controls, lone surrogates) replaced by a space, whitespace
 * collapsed, cut by CODE POINT (never inside a surrogate pair). Blank → `''`,
 * for which Core stores "Untitled conversation".
 */
export function titleFromMessage(text: string, max = DERIVED_TITLE_CHARS): string {
  let line = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const refused =
      cp <= 0x1f ||
      (cp >= 0x7f && cp <= 0x9f) ||
      cp === 0x2028 ||
      cp === 0x2029 ||
      cp === 0x200e ||
      cp === 0x200f ||
      cp === 0x061c ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      (cp >= 0xd800 && cp <= 0xdfff);
    line += refused ? ' ' : ch;
  }
  const collapsed = line.replace(/\s+/g, ' ').trim();
  return Array.from(collapsed).slice(0, Math.min(max, MAX_CONVERSATION_TITLE_CHARS)).join('').trim();
}

/** `validateInput` for a rename: Core's exact rule, or `undefined` when valid. */
export function conversationTitleProblem(value: string): string | undefined {
  try {
    validateConversationRenameTitle(value);
    return undefined;
  } catch (error) {
    if (error instanceof CoreValidationError && /whitespace-only/.test(error.message)) {
      return 'Core refuses an empty or whitespace-only title';
    }
    return error instanceof CoreValidationError
      ? `Core would refuse this title: ${error.message.replace(/^title: /, '')}`
      : 'Core would refuse this title';
  }
}

/**
 * The default file name of an export, built from the REDACTED title of the
 * first page (a secret never lands in a file name): `[A-Za-z0-9._-]` only,
 * at most 60 characters, `conversation` when nothing usable is left.
 */
export function exportFileName(redactedTitle: string): string {
  const base = redactedTitle
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/[-.]+$/g, '');
  return `${base.length > 0 ? base : 'conversation'}-export.json`;
}

export const DELETE_CONVERSATION_BUTTON = 'Delete conversation';

export interface ConversationDeleteView {
  message: string;
  detail: string;
  button: typeof DELETE_CONVERSATION_BUTTON;
  altered: boolean;
}

/**
 * The A1 two-step pattern for `conversation.delete`: target name + id, every
 * impact line (capped 20 × 200, rest counted), the expiry and what the button
 * does. The token is never part of the view. `external` is always false for
 * conversations; if Core ever says otherwise it is shown, never hidden.
 */
export function conversationDeleteView(confirmation: ConfirmationRequest, nowMs: number): ConversationDeleteView {
  let altered = inspectHidden(confirmation.target.name).altered || inspectHidden(confirmation.target.id).altered;
  const name = plainText(confirmation.target.name, MAX_IDENTITY_CHARS);
  const id = plainText(confirmation.target.id, MAX_IDENTITY_CHARS);
  const listed = confirmation.impact.slice(0, MAX_IMPACT_LINES).map((line) => {
    if (inspectHidden(line).altered) altered = true;
    return `• ${plainText(line, MAX_IMPACT_LINE_CHARS)}`;
  });
  for (const line of confirmation.impact.slice(MAX_IMPACT_LINES)) {
    if (inspectHidden(line).altered) altered = true;
  }
  const hidden = confirmation.impact.length - listed.length;
  const lines: string[] = [];
  if (confirmation.external) lines.push(`${EXTERNAL_MARKER}: ${EXTERNAL_TEXT}`, '');
  lines.push(`Conversation: ${name}`, `Conversation id: ${id}`, '');
  lines.push(listed.length > 0 ? 'Core reports this impact:' : 'Core reported no impact lines.');
  lines.push(...listed);
  if (hidden > 0) lines.push(`(+${hidden} more impact line(s) not shown)`);
  lines.push(
    '',
    `This confirmation ${describeExpiry(confirmation.expiresAt, nowMs).replace('run Remove again', 'run Delete Conversation again')}.`,
  );
  if (altered) {
    lines.push('WARNING: text from Core contained invisible or control characters; they are shown as \\u escapes.');
  }
  lines.push(
    '',
    `Nothing is deleted unless you press "${DELETE_CONVERSATION_BUTTON}". Core deletes only its own records ` +
      'of this conversation (messages, tasks and their events, artifacts and verification records); host ' +
      'files, worktrees, branches and sandboxes are not touched. Cancel sends nothing; the confirmation ' +
      'simply expires.',
  );
  return {
    message: `${confirmation.external ? `${EXTERNAL_MARKER} — ` : ''}Delete conversation "${name}"?`,
    detail: lines.join('\n'),
    button: DELETE_CONVERSATION_BUTTON,
    altered,
  };
}
