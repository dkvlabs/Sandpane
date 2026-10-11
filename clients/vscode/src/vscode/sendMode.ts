/**
 * Pure helpers for A4 (`conversation.send` mode, design 2026-10-09 §3.4):
 * the feature string, the composer copy, Core's exact refusal and its client
 * copy, and the read-only display of `TaskSummary.mode` /
 * `chosenSandboxName`. No `vscode` import.
 *
 * What Core records and nothing more: the REQUESTED send mode. In this build
 * no agent runs for either mode (no verified adapter, both record
 * PERMISSION_DENIED and stay queued), and Discuss is not a sandbox, an
 * isolation level or a safe-execution mode.
 */

import { CoreRpcError } from '../core-client/connection';
import { MSG_SEND_MODE_INVALID } from '../core-client/commands';
import type { CoreFeature } from '../core-client/protocol';
import { plainText } from '../text/visibleText';

export { MSG_SEND_MODE_INVALID };

export const SEND_MODE_FEATURE: CoreFeature = 'conversation-send-mode';

/** Label of `TaskSummary.mode` wherever it is shown. */
export const SEND_MODE_LABEL = 'Send mode';
/** Label of `TaskSummary.chosenSandboxName`: a stored name, never a binding. */
export const CHOSEN_SANDBOX_LABEL = 'sandbox chosen by its chat — not where it runs';

/** Display caps for the two Core strings (revealed, then capped). */
export const MAX_TASK_MODE_CHARS = 64;
export const MAX_CHOSEN_SANDBOX_CHARS = 128;

/** Composer note while Core advertises the feature. */
export const SEND_MODE_NOTE =
  'Send mode: Core records whether you asked for a Task or a Discuss. Neither mode runs an agent in ' +
  'this build: every send stays queued. Discuss is not a sandbox, not a dry run and not safe execution.';

/** Composer note when it does not (the choice is disabled at Task). */
export const SEND_MODE_UNSUPPORTED =
  'Task / Discuss: not supported by this Core (it does not advertise "conversation-send-mode"); ' +
  'every send is a Task.';

/** Send-time refusal: Discuss chosen, but THIS Core does not honour `mode`. */
export const DISCUSS_NOT_ADVERTISED =
  'the connected Core does not advertise "conversation-send-mode", so it would drop the mode and ' +
  'record a discussion as a task. Choose Task, or update Core.';

/** Send-time refusal: Discuss together with the writable intent. */
export const DISCUSS_NOT_WRITABLE =
  'Discuss never asks for a writable workspace; untick "writable task" or choose Task.';

/** "Retry safely" refusal (click-time gate) for a send that carries `mode`. */
export const RETRY_MODE_NOT_ADVERTISED =
  'Not retried: the connected Core does not advertise "conversation-send-mode", so it would drop the ' +
  'mode and could record this discussion as a task. Nothing was sent — check state first.';

function rpcMessage(error: CoreRpcError): string {
  const prefix = `${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/**
 * Honest copy for Core's exact VALIDATION_FAILED mode refusal, or `null`.
 * This client only ever sends "discuss" or no mode, so the refusal suggests (it does not prove)
 * that the extension and Core are different versions.
 */
export function sendModeErrorCopy(error: unknown): string | null {
  if (!(error instanceof CoreRpcError)) return null;
  if (error.code !== 'VALIDATION_FAILED' || rpcMessage(error) !== MSG_SEND_MODE_INVALID) return null;
  return (
    'Core refused the send mode: it accepts only "task" or "discuss". This extension sends only "discuss" ' +
    'or no mode, so this may mean the extension and Core are different versions. Choose Task, or update the ' +
    'extension or Core.'
  );
}

/** Shown for a present but non-string value; the value itself is never echoed. */
export const UNREADABLE_CORE_VALUE = '(unreadable value from Core \u2014 not shown)';

function coreText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return UNREADABLE_CORE_VALUE;
  return plainText(value, max);
}

/** `TaskSummary.mode` for display: open string, revealed and capped; absent → null. */
export function taskModeText(mode: unknown): string | null {
  return coreText(mode, MAX_TASK_MODE_CHARS);
}

/** `TaskSummary.chosenSandboxName` for display: revealed and capped; absent → null. */
export function chosenSandboxText(name: unknown): string | null {
  return coreText(name, MAX_CHOSEN_SANDBOX_CHARS);
}

/**
 * The labelled parts a task row shows, only for what Core reported. Takes a
 * snapshot row, whose values were already revealed and capped (no re-cap).
 */
export function taskModeParts(row: { mode?: string | null; chosenSandboxName?: string | null }): string[] {
  const mode = typeof row.mode === 'string' && row.mode.length > 0 ? row.mode : null;
  const chosen =
    typeof row.chosenSandboxName === 'string' && row.chosenSandboxName.length > 0 ? row.chosenSandboxName : null;
  return [
    ...(mode !== null ? [`${SEND_MODE_LABEL}: ${mode}`] : []),
    ...(chosen !== null ? [`${CHOSEN_SANDBOX_LABEL}: ${chosen}`] : []),
  ];
}

/** Text for inside a Markdown code span: a backtick could close the span. */
export function codeSpanText(text: string): string {
  return text.replace(/`/g, "'");
}
