/**
 * Host-context gate (specs/03 §2 "Remote VS Code hosts").
 *
 * v0.1 supports only the verified local extension host. On a remote host the
 * extension must NOT run local SBX logic against remote paths — it explains the
 * unsupported state instead. Pure so the decision is testable.
 */

export interface HostContext {
  /** `vscode.env.remoteName` — undefined on a local window. */
  remoteName?: string;
  /** `vscode.ExtensionContext.extension?.extensionUri.scheme` when known. */
  extensionScheme?: string;
}

export interface HostVerdict {
  supported: boolean;
  /** Short label for the status bar. */
  label: string;
  /** Full explanation for the message shown to the user. */
  explanation: string;
}

const REMOTE_HINT =
  'Sandpane v0.1 attaches to a Sandpane Core process on this machine only. This window is a ' +
  `remote extension host, so the workspace files live somewhere Core cannot reach over its local ` +
  'Unix socket. Binding a local SBX command to a remote path would silently operate on the wrong ' +
  'filesystem, so every Sandpane action is disabled here instead. Remote hosts are a documented ' +
  'P3+ constraint (specs/03 §2, specs/02 §9): install and run Core on the remote host, or use a ' +
  'local window.';

export function evaluateHostContext(context: HostContext): HostVerdict {
  if (context.remoteName) {
    const kind = humanRemoteKind(context.remoteName);
    return {
      supported: false,
      label: `Sandpane: unsupported on ${kind}`,
      explanation: REMOTE_HINT.replace('is a remote extension host', `is a ${kind} remote extension host`),
    };
  }
  if (context.extensionScheme && context.extensionScheme !== 'file') {
    return {
      supported: false,
      label: 'Sandpane: unsupported host scheme',
      explanation:
        `This extension is loaded from a "${context.extensionScheme}" location, which means it is ` +
        'not running on the local machine. ' +
        REMOTE_HINT,
    };
  }
  return {
    supported: true,
    label: 'Sandpane',
    explanation: 'Local extension host — Sandpane Core can be attached over the per-user socket.',
  };
}

function humanRemoteKind(remoteName: string): string {
  switch (remoteName) {
    case 'ssh-remote':
      return 'SSH';
    case 'wsl':
    case 'wsl+.':
      return 'WSL';
    case 'dev-container':
      return 'dev-container';
    case 'codespaces':
      return 'Codespaces';
    case 'attached-container':
      return 'attached-container';
    default:
      return remoteName;
  }
}
