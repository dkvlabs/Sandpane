/**
 * Pure helpers for the A3a project lifecycle (design 2026-10-09 §3.2): Core's
 * exact user-facing messages (drift-tested against project_lifecycle.rs /
 * confirm.rs), their plain client copy, the delete confirmation view (A1
 * two-step pattern) and project picker rows. No `vscode` import.
 */

import type { ConfirmationRequest, Project } from '../core-client/protocol';
import { CoreRpcError } from '../core-client/connection';
import { inspectHidden, plainText } from '../text/visibleText';
import {
  EXTERNAL_MARKER,
  EXTERNAL_TEXT,
  MAX_IDENTITY_CHARS,
  MAX_IMPACT_LINES,
  MAX_IMPACT_LINE_CHARS,
  describeExpiry,
  pickText,
} from './sandboxActions';
import { MSG_PROJECT_VERIFICATION_RUNNING, PROJECT_VERIFICATION_RUNNING_COPY } from './verification';

// --- Core's exact messages (sandpane-service project_lifecycle.rs / confirm.rs) ---
export const MSG_PROJECT_ARCHIVED = 'project is archived; unarchive it first; nothing was changed';
export const MSG_PROJECT_HAS_TASKS =
  'project has tasks that are not finished; cancel or finish them first; nothing was deleted';
export const MSG_PROJECT_HAS_SANDBOXES = 'project has sandboxes; remove them first; nothing was deleted';
export const MSG_REPOSITORY_IN_USE = 'repository is used by a task or sandbox of this project; nothing was removed';
export const MSG_PROJECT_CREATE_IN_FLIGHT =
  'a sandbox is being created for this project; try again when it finishes; nothing was deleted';
export const MSG_REPOSITORY_REMOVE_WHILE_CREATING =
  'a sandbox is being created for this project; try again when it finishes; nothing was removed';
export const MSG_REPOSITORY_UNREGISTERED_DURING_CREATE =
  'the repository was unregistered from this project while the sandbox was being prepared; nothing was run';
export const MSG_PROJECT_NOT_FOUND = 'project not found';
export const MSG_REPOSITORY_NOT_REGISTERED = 'repository is not registered with this project; nothing was removed';
/** This client never sends an empty update; mapped anyway so it is never shown raw. */
export const MSG_UPDATE_NEEDS_A_FIELD = 'project.update needs name or description; nothing was changed';
/** A1 `confirm::TOKEN_REJECTED_MESSAGE` — a refused step-2 token; nothing ran. */
export const TOKEN_REJECTED_MESSAGE =
  'confirmation token is invalid, expired, already used, or not for this action and target; request a new confirmation';

/** Plain client copy per exact Core message; each one keeps Core's "nothing was …". */
const COPY: ReadonlyArray<[code: string, message: string, copy: string]> = [
  ['VALIDATION_FAILED', MSG_PROJECT_ARCHIVED, 'This project is archived. Unarchive it first; nothing was changed.'],
  ['CONFLICT', MSG_PROJECT_HAS_TASKS, 'The project has unfinished tasks. Cancel or finish them first; nothing was deleted.'],
  ['CONFLICT', MSG_PROJECT_HAS_SANDBOXES, 'The project still has sandboxes. Remove them first; nothing was deleted.'],
  // A7: Core refuses a delete while a verification runs for one of the project's tasks.
  ['CONFLICT', MSG_PROJECT_VERIFICATION_RUNNING, PROJECT_VERIFICATION_RUNNING_COPY],
  ['CONFLICT', MSG_PROJECT_CREATE_IN_FLIGHT, 'A sandbox is being created for this project. Try again when it finishes; nothing was deleted.'],
  ['CONFLICT', MSG_REPOSITORY_IN_USE, 'A task or sandbox of this project uses that repository; nothing was removed.'],
  ['CONFLICT', MSG_REPOSITORY_REMOVE_WHILE_CREATING, 'A sandbox is being created for this project. Try again when it finishes; nothing was removed.'],
  ['CONFLICT', MSG_REPOSITORY_UNREGISTERED_DURING_CREATE, 'The repository was unregistered from the project while the sandbox was being prepared; nothing was run.'],
  ['NOT_FOUND', MSG_PROJECT_NOT_FOUND, 'Core has no such project (it may have been deleted); nothing was changed.'],
  ['NOT_FOUND', MSG_REPOSITORY_NOT_REGISTERED, 'That repository is not registered with this project; nothing was removed.'],
  ['VALIDATION_FAILED', MSG_UPDATE_NEEDS_A_FIELD, 'Nothing to change: give a new name or description; nothing was changed.'],
  ['VALIDATION_FAILED', TOKEN_REJECTED_MESSAGE, 'Core refused the confirmation (invalid, expired or already used). Nothing was deleted — run Delete Project again for a fresh confirmation.'],
];

/** Core's raw message from a `CoreRpcError` (its `.message` is `CODE: message`). */
function rpcMessage(error: CoreRpcError): string {
  const prefix = `${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/**
 * Honest copy for one of Core's exact A3a messages, or `null` when the error
 * is anything else (the caller then reports it generically or as UNKNOWN).
 */
export function projectErrorCopy(error: unknown): string | null {
  if (!(error instanceof CoreRpcError)) return null;
  const message = rpcMessage(error);
  for (const [code, exact, copy] of COPY) {
    if (error.code === code && message === exact) return copy;
  }
  return null;
}

export const ARCHIVED_LABEL = 'ARCHIVED';

/** Is this project archived according to Core's record? */
export function isArchived(project: Pick<Project, 'archivedAt'>): boolean {
  return typeof project.archivedAt === 'string' && project.archivedAt.length > 0;
}

export interface ProjectPickItem {
  label: string;
  description: string;
  detail?: string;
  id: string;
  archived: boolean;
}

/** Quick-pick row; Core strings are plain text, archived projects visibly labeled. */
export function projectPickItem(project: Project): ProjectPickItem {
  const archived = isArchived(project);
  const repos = project.repositories ?? [];
  return {
    label: pickText(project.name, 120),
    description: `${archived ? `${ARCHIVED_LABEL} · ` : ''}id ${pickText(project.id.slice(0, 8), 8)}`,
    ...(repos.length > 0 ? { detail: `${repos.length} repository(ies): ${repos.map((r) => pickText(r, 200)).join(', ')}` } : {}),
    id: project.id,
    archived,
  };
}

export const DELETE_PROJECT_BUTTON = 'Delete project';

export interface ProjectDeleteView {
  message: string;
  detail: string;
  button: typeof DELETE_PROJECT_BUTTON;
  altered: boolean;
}

/**
 * The A1 two-step pattern for `project.delete`: target name + id, every impact
 * line (capped 20 × 200, rest counted), the expiry, what the button does. The
 * token is never part of the view. `external` is always false for projects;
 * if Core ever says otherwise it is shown, never hidden.
 */
export function projectDeleteView(confirmation: ConfirmationRequest, nowMs: number): ProjectDeleteView {
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
  lines.push(`Project: ${name}`, `Project id: ${id}`, '');
  lines.push(listed.length > 0 ? 'Core reports this impact:' : 'Core reported no impact lines.');
  lines.push(...listed);
  if (hidden > 0) lines.push(`(+${hidden} more impact line(s) not shown)`);
  lines.push('', `This confirmation ${describeExpiry(confirmation.expiresAt, nowMs).replace('run Remove again', 'run Delete Project again')}.`);
  if (altered) {
    lines.push('WARNING: text from Core contained invisible or control characters; they are shown as \\u escapes.');
  }
  lines.push(
    '',
    `Nothing is deleted unless you press "${DELETE_PROJECT_BUTTON}". Core deletes only its own records ` +
      'of this project; host files, branches and sandboxes are not touched. Cancel sends nothing; the ' +
      'confirmation simply expires.',
  );
  return {
    message: `${confirmation.external ? `${EXTERNAL_MARKER} — ` : ''}Delete project "${name}"?`,
    detail: lines.join('\n'),
    button: DELETE_PROJECT_BUTTON,
    altered,
  };
}
