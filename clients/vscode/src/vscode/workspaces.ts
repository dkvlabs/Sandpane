/**
 * Workspace-mode labelling (specs/02 §7, specs/06 §6).
 *
 * The `direct_mount` label is the one thing this client must never soften: the
 * host tree is writable immediately and review cannot retroactively block it.
 * Pure — no vscode import — so the wording is covered by unit tests.
 */

import type { WorkspaceMode } from '../core-client/protocol';
import { WORKSPACE_MODES } from '../core-client/protocol';

export interface WorkspaceModeView {
  /** `'unknown'` for a mode this client cannot name. */
  mode: WorkspaceMode | 'unknown';
  /** Sidebar label, always shown next to a task/chat. */
  label: string;
  /** Badge text; loud for direct_mount. */
  badge: string;
  /** Full explanation for tooltips and confirmations. */
  explanation: string;
  /** `live_writable` renders with the error palette; never a neutral tone. */
  tone: 'live_writable' | 'isolated' | 'scratch';
  /** True when host files can change while an agent works. */
  hostWritable: boolean;
}

export const DIRECT_MOUNT_LIVE_WRITABLE = 'LIVE-WRITABLE';

const VIEWS: Record<WorkspaceMode, WorkspaceModeView> = {
  direct_mount: {
    mode: 'direct_mount',
    label: 'Direct mount',
    badge: DIRECT_MOUNT_LIVE_WRITABLE,
    explanation:
      'Direct mount binds the host working tree into the sandbox: agent edits can change these ' +
      'files immediately, and review cannot retroactively block a write. Commit or stash your own ' +
      'work first, and expect the dirty-host guard on apply.',
    tone: 'live_writable',
    hostWritable: true,
  },
  sbx_clone: {
    mode: 'sbx_clone',
    label: 'SBX clone',
    badge: 'ISOLATED',
    explanation:
      'The repository is cloned inside the sandbox; host files are not written by the agent. ' +
      'Isolation covers writes, not secrecy: mounts and copied repos can still expose ' +
      'sensitive or untracked data (specs/06 §6).',
    tone: 'isolated',
    hostWritable: false,
  },
  host_worktree: {
    mode: 'host_worktree',
    label: 'Host Git worktree',
    badge: 'ISOLATED (host dir)',
    explanation:
      'An independent host directory and branch. Valid only when the filesystem mount and the ' +
      'sandbox selection point at that same worktree; otherwise it behaves like direct mount on ' +
      'the wrong tree.',
    tone: 'isolated',
    hostWritable: false,
  },
  mountless: {
    mode: 'mountless',
    label: 'Mountless',
    badge: 'NO HOST ACCESS',
    explanation:
      'Scratch execution with no automatic access to the host project. Nothing is written to ' +
      'these files; there is also nothing to review from the host side.',
    tone: 'scratch',
    hostWritable: false,
  },
};

export function workspaceModeView(mode: WorkspaceMode): WorkspaceModeView {
  return VIEWS[mode];
}

/** Label for a mode we cannot name (forward-compatible Core enum addition). */
export function unknownWorkspaceModeView(raw: string): WorkspaceModeView {
  return {
    mode: 'mountless',
    label: `Unknown workspace mode "${raw}"`,
    badge: 'UNKNOWN — TREAT AS LIVE-WRITABLE',
    explanation:
      'Core reported a workspace mode this client does not know. Until it is identified, the ' +
      'sidebar assumes the worst case (host writable) rather than promising isolation.',
    tone: 'live_writable',
    hostWritable: true,
  };
}

export function isKnownWorkspaceMode(value: unknown): value is WorkspaceMode {
  return typeof value === 'string' && (WORKSPACE_MODES as readonly string[]).includes(value);
}

export function workspaceModeLabel(value: unknown): string {
  return isKnownWorkspaceMode(value)
    ? workspaceModeView(value).label
    : unknownWorkspaceModeView(String(value)).label;
}

export function allWorkspaceModeViews(): WorkspaceModeView[] {
  return WORKSPACE_MODES.map((mode) => VIEWS[mode]);
}
