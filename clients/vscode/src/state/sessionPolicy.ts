/**
 * Pure decisions behind `SandpaneSession` (which is vscode glue). Nothing here
 * talks to Core or computes a task lifecycle transition: it only decides what
 * the client may display or send, from data Core already returned.
 */

import { isTaskStatus, isTerminalStatus, type TaskStatus } from '../core-client/events';
import type { AgentCapability, SandboxSummary } from '../core-client/protocol';
import type { ConnectionState } from '../core-client/connection';
import {
  sandboxWorkspaceModeView,
  unverifiedWorkspaceModeView,
  type WorkspaceModeView,
} from '../vscode/workspaces';

export interface SelectedModeView extends WorkspaceModeView {
  /** Core's recorded mode string for the selected sandbox; null = none recorded/selected. */
  raw: string | null;
}

/**
 * The workspace mode that applies to the next task: ALWAYS derived from the
 * currently selected sandbox's `SandboxSummary` (Core's binding record), never
 * from a separately cached value that a selection change can leave stale
 * (review bug 4). No sandbox, a sandbox Core no longer lists, or one without a
 * recorded mode are all UNVERIFIED — treated as host-writable, never as safe.
 */
export function selectedWorkspaceMode(
  sandboxes: readonly SandboxSummary[],
  selectedSandbox: string | null,
): SelectedModeView {
  const summary = selectedSandbox === null ? undefined : sandboxes.find((s) => s.name === selectedSandbox);
  if (!summary) {
    const view = unverifiedWorkspaceModeView();
    return {
      ...view,
      raw: null,
      label: selectedSandbox === null ? 'No sandbox selected' : `Sandbox "${selectedSandbox}" not listed by Core`,
    };
  }
  const raw: string | null | undefined = summary.workspaceMode;
  return {
    ...sandboxWorkspaceModeView(summary),
    raw: raw === undefined || raw === null || raw === '' ? null : String(raw),
  };
}

export interface GateVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * When a send needs an explicit "send anyway" confirmation. A writable intent
 * in any host-writable mode — direct_mount, an unknown mode, or UNVERIFIED —
 * requires it; `null` is never read as safe (review bug 4).
 */
export function sendGate(
  agents: readonly AgentCapability[],
  writable: boolean,
  mode: WorkspaceModeView,
): GateVerdict {
  if (agents.length === 0) {
    return { allowed: false, reason: 'Core advertised no agent adapters at all.' };
  }
  if (!agents.some((a) => a.verified === true)) {
    return {
      allowed: false,
      reason:
        `No verified adapter: ${agents.map((a) => `${a.id}(verified=${a.verified})`).join(', ')}. ` +
        'The P0 Codex-in-SBX feasibility gate has not passed, so streaming/cancel/resume are all off.',
    };
  }
  if (writable && mode.hostWritable) {
    return {
      allowed: false,
      reason: `Writable task in "${mode.label}" mode — ${mode.badge}. ${mode.explanation}`,
    };
  }
  return { allowed: true, reason: '' };
}

/** The scope a conversation was created in (Core's Conversation has no sandbox field). */
export interface ConversationScope {
  projectId: string;
  /** Sandbox selected when the conversation was created; null = none / not recorded. */
  sandboxName: string | null;
}

/**
 * A conversation is reused only for the project AND sandbox it was created in;
 * otherwise the next send creates a new one (review bug 8).
 */
export function conversationInScope(
  conversation: ConversationScope,
  current: { projectId: string | null; sandbox: string | null },
): boolean {
  return (
    current.projectId !== null &&
    conversation.projectId === current.projectId &&
    conversation.sandboxName === current.sandbox
  );
}

/**
 * Poll `task.subscribe` only while it can show something new: connected, and at
 * least one task without a terminal status (a task with no status from Core yet
 * counts as active). Terminal-ness is read from Core's statuses, not computed.
 */
export function shouldPollEvents(
  connection: ConnectionState,
  statuses: readonly (TaskStatus | string | null)[],
): boolean {
  if (connection !== 'online') return false;
  return statuses.some((status) => status === null || !isTaskStatus(status) || !isTerminalStatus(status));
}

export type SendAuthorization = { ok: true } | { ok: false; reason: string };

/**
 * Whether a send matches the attachment plan the extension last built and
 * showed: same plan id (not stale, not replaced) and same intent (a read-only
 * plan is never sent as writable) — review bug 6.
 *
 * Limit (review W4): this guards against stale or wrong-intent plans and UI
 * mistakes. It does NOT make consent unforgeable: the plan id is delivered to
 * the webview, so script running inside the webview could post it back. The
 * webview's protection is its CSP and the bridge whitelist, not this check.
 */
export function authorizeSend(
  plan: { id: number; mode: 'read_only' | 'writable' } | null,
  request: { writable: boolean; planId: number | null },
): SendAuthorization {
  if (plan === null) {
    return { ok: false, reason: 'Review the attachment list ("Show attachments") before sending.' };
  }
  if (request.planId === null || request.planId !== plan.id) {
    return {
      ok: false,
      reason: 'The attachment list changed since you reviewed it. Review the current list, then send.',
    };
  }
  const wanted = request.writable ? 'writable' : 'read_only';
  if (plan.mode !== wanted) {
    return {
      ok: false,
      reason:
        `The list you reviewed was for a ${plan.mode === 'writable' ? 'writable task' : 'read-only discussion'}, ` +
        `but this send is ${request.writable ? 'a writable task' : 'a read-only discussion'}. Review it again.`,
    };
  }
  return { ok: true };
}

export interface TranscriptTask<L> {
  conversationId?: string;
  lines: readonly L[];
}

export interface TranscriptView<L> {
  scope: 'conversation' | 'project';
  /** Accessible label naming exactly what the stream contains. */
  label: string;
  lines: L[];
}

/**
 * Lines for the message stream: the selected conversation's tasks only, or —
 * with no conversation — every task of the project, labelled as such so the
 * stream is never presented as one conversation when it is not (review 12b).
 */
export function transcriptView<L>(
  tasks: readonly TranscriptTask<L>[],
  conversation: { id: string; title: string } | null,
): TranscriptView<L> {
  if (conversation) {
    return {
      scope: 'conversation',
      label: `Conversation "${conversation.title}"`,
      lines: tasks.filter((t) => t.conversationId === conversation.id).flatMap((t) => [...t.lines]),
    };
  }
  return {
    scope: 'project',
    label: 'Transcript of all tasks in this project (no conversation selected)',
    lines: tasks.flatMap((t) => [...t.lines]),
  };
}

/** A workspace folder with its canonical path (fs.realpath, resolved by the caller). */
export interface CanonicalFolder {
  fsPath: string;
  canonical: string;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * The workspace folder that IS one of the project's repositories. Core returns
 * canonical paths (symlinks resolved — e.g. `/private/var/…` on macOS) and
 * accepts only a git toplevel, so the folder side must be canonicalized before
 * comparing, and the comparison is exact: a monorepo subfolder or a sibling
 * with a common prefix is NOT a match.
 */
export function matchWorkspaceFolder(
  folders: readonly CanonicalFolder[],
  repositories: readonly string[],
): CanonicalFolder | undefined {
  const wanted = new Set(repositories.map(stripTrailingSlash));
  return folders.find((folder) => wanted.has(stripTrailingSlash(folder.canonical)));
}
