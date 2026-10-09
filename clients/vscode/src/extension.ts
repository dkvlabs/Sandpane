/**
 * Extension entry point (specs/03 §2).
 *
 * activate(): attach to Core, register the sidebar webview, the task tree, the
 * nine commands (each one is a progress-wrapped call into the typed Core
 * client) and the status bar item.
 *
 * deactivate(): dispose subscriptions ONLY. A detached window must never be able
 * to terminate a running task — Core owns the agent processes (specs/02 §1,
 * specs/03 §2.6). There is deliberately no cancellation call anywhere below.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { SandpaneSession } from './session';
import { SandpaneChatProvider } from './webview/sidebar';
import { SandpaneTaskTreeProvider } from './vscode/taskTree';
import { coreDataDir, coreSocketPath, unsupportedPlatformReason } from './core-client/paths';
import { allWorkspaceModeViews } from './vscode/workspaces';
import { isKnownWorkspaceMode } from './vscode/workspaces';
import { validateSandboxName, CoreValidationError } from './core-client/commands';
import { workspaceDiagnosticSummary } from './vscode/editor';

const CORE_AVAILABLE_CONTEXT = 'sandpane.coreAvailable';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Sandpane', { log: true });
  const log = (message: string): void => output.appendLine(message);

  const session = new SandpaneSession(context);
  session.setOutputChannel(output);

  const host = session.host;
  if (!host.supported) {
    log(`remote host detected (${vscode.env.remoteName ?? 'unknown'}) — all Sandpane actions disabled`);
  }

  const provider = new SandpaneChatProvider(context.extensionUri, session, log);
  const tree = new SandpaneTaskTreeProvider(session);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'sandpane.openCoreLogs';

  const stateSub = session.subscribe((state) => {
    const icon =
      state.connection === 'online'
        ? '$(pass)'
        : state.connection === 'unsupported'
          ? '$(error)'
          : '$(debug-disconnect)';
    status.text = `${icon} Sandpane: ${state.connection}`;
    status.tooltip =
      state.capabilities === null
        ? `${host.explanation}\n\nCore socket: ${socketPathFor()}`
        : `Core ${state.capabilities.coreVersion} · protocol v${state.capabilities.protocolVersion}\n` +
          `instance ${state.capabilities.instanceId}\nplatform: ${state.capabilities.platform}\n` +
          `sbx installed: ${String(state.capabilities.sbxInstalled)}\n` +
          `agents: ${state.capabilities.agents
            .map((a) => `${a.id}${a.verified ? ' (verified)' : ' (unverified)'}`)
            .join(', ') || 'none'}\nCore socket: ${socketPathFor()}`;
    status.show();
    void vscode.commands.executeCommand('setContext', CORE_AVAILABLE_CONTEXT, host.supported);
  });

  context.subscriptions.push(
    output,
    status,
    stateSub,
    session,
    provider,
    tree,
    vscode.window.registerWebviewViewProvider(SandpaneChatProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.createTreeView(SandpaneTaskTreeProvider.viewId, { treeDataProvider: tree }),
    ...registrations(session, output, log),
  );

  if (host.supported) {
    // Probe on activation so the sidebar shows real state, not a placeholder.
    void session.attach().catch((error: unknown) =>
      log(`attach failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  if (
    vscode.workspace.getConfiguration('sandpane').get<boolean>('autoRefreshSandboxes', false) &&
    host.supported
  ) {
    const timer = setInterval(() => {
      void session.refresh().catch(() => undefined);
    }, 30_000);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));
  }

  log(
    `activated (host=${host.supported ? 'local' : 'remote'}, socket=${socketPathFor()}, protocol v1, transport=unix-socket)`,
  );
}

/** Never cancels anything: subscriptions are the only thing released. */
export function deactivate(): void {
  // Intentionally empty. VS Code disposes the ExtensionContext subscriptions,
  // and `SandpaneSession.dispose()` closes our socket and stops event polling.
  // Task cancellation is a separate, explicit user action through `task.cancel`.
}

function socketPathFor(): string {
  const config = vscode.workspace.getConfiguration('sandpane');
  return coreSocketPath(
    { env: process.env, platform: process.platform, homedir: process.env['HOME'] ?? '' },
    config.get<string>('coreSocketPath', ''),
  );
}

/** The nine contributed commands, each wrapped in a progress notification. */
function registrations(
  session: SandpaneSession,
  output: vscode.OutputChannel,
  log: (message: string) => void,
): vscode.Disposable[] {
  const run = <T>(title: string, work: () => Promise<T | undefined>): Promise<T | undefined> =>
    Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        async () => {
          try {
            return await work();
          } catch (error) {
            if (error instanceof CoreValidationError) {
              session.reportError(error, title);
              return undefined;
            }
            log(
              `command "${title}" threw an unclassified error: ${error instanceof Error ? error.message : String(error)}`,
            );
            return undefined;
          }
        },
      ),
    );

  const guard = <T>(title: string, work: () => Promise<T | undefined>): Promise<T | undefined> => {
    if (!session.host.supported) {
      void vscode.window.showWarningMessage(session.host.explanation);
      return Promise.resolve(undefined);
    }
    return run(title, work);
  };

  return [
    vscode.commands.registerCommand('sandpane.newProject', () =>
      guard('Sandpane: new project', async () => {
        const name = await vscode.window.showInputBox({
          prompt: 'Project name (stored by Core)',
          validateInput: (value) =>
            value.trim().length === 0
              ? 'required'
              : value.length > 120
                ? 'Core limits a project name to 120 characters'
                : /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)
                  ? 'control characters are rejected by Core'
                  : undefined,
        });
        if (!name) return undefined;
        const folders = vscode.workspace.workspaceFolders ?? [];
        const chosen =
          folders.length === 0
            ? []
            : ((
                await vscode.window.showQuickPick(
                  folders.map((folder) => ({ label: folder.uri.fsPath, description: folder.name })),
                  { canPickMany: true, title: 'Repository paths to associate (optional)' },
                )
              ) ?? []).map((item) => item.label);
        return session.createProject(name.trim(), chosen);
      }),
    ),

    vscode.commands.registerCommand('sandpane.newSandbox', () =>
      guard('Sandpane: new sandbox', async () => {
        const projectId = await pickProject(session);
        if (!projectId) return undefined;
        const name = await vscode.window.showInputBox({
          prompt: 'Sandbox name (lowercase letters/digits, single hyphens, alphanumeric ends)',
          validateInput: (value) => {
            try {
              validateSandboxName(value);
              return undefined;
            } catch (error) {
              return error instanceof Error ? error.message : 'invalid name';
            }
          },
        });
        if (!name) return undefined;
        const mode = await vscode.window.showQuickPick(
          allWorkspaceModeViews().map((view) => ({
            label: view.label,
            description: view.badge,
            detail: view.explanation,
            mode: view.mode,
          })),
          { title: 'Workspace mode', placeHolder: 'How the repository is mapped for tasks here' },
        );
        if (!mode || !isKnownWorkspaceMode(mode.mode)) return undefined;
        if (mode.mode === 'direct_mount') {
          const acknowledged = await vscode.window.showWarningMessage(
            'Direct mount is LIVE-WRITABLE: an agent working in this sandbox can change these host ' +
              'files immediately, and review cannot take those writes back. Commit or stash your own ' +
              'work first.',
            { modal: true, detail: 'specs/06 §6 — direct mount is never described as isolated.' },
            'I understand, continue',
          );
          if (acknowledged !== 'I understand, continue') return undefined;
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        const repoPath =
          mode.mode === 'mountless' || !folder || folder.uri.scheme !== 'file'
            ? undefined
            : folder.uri.fsPath;
        return session.createSandbox({
          name,
          projectId,
          workspaceMode: mode.mode,
          ...(repoPath ? { repoPath } : {}),
        });
      }),
    ),

    vscode.commands.registerCommand('sandpane.startTask', () =>
      guard('Sandpane: start task', async () => {
        const text = await vscode.window.showInputBox({
          prompt: 'Ask the agent (Core receives it as data, never as a command)',
          placeHolder: 'e.g. explain what this function does',
        });
        if (!text) return undefined;
        const intent = await vscode.window.showQuickPick(
          [
            { label: 'Discuss (read-only)', description: 'no writable task is created', writable: false },
            {
              label: 'Writable task',
              description: 'agent may edit files in the bound workspace',
              writable: true,
            },
          ],
          { title: 'What should Sandpane do?' },
        );
        if (!intent) return undefined;
        // Build and show the attachment list BEFORE anything is sent.
        const plan = session.previewContext(intent.writable);
        const listed = [
          plan.summary,
          ...plan.attachments.map((a) => `· ${a.kind}: ${a.label} → ${a.target}`),
          ...plan.excluded.map((e) => `· excluded ${e.label}: ${e.reason}`),
        ].join('\n');
        const problems = intent.writable ? workspaceDiagnosticSummary(5) : null;
        const confirmed = await vscode.window.showInformationMessage(
          [listed, problems ? `Workspace errors (${problems.count}), first: ${problems.lines[0]}` : null]
            .filter((line): line is string => line !== null)
            .join('\n\n'),
          {
            modal: true,
            detail: 'Everything listed above is attached. Nothing is attached implicitly.',
          },
          'Send it',
        );
        if (confirmed !== 'Send it') return undefined;
        await session.send(text, intent.writable, true);
        return undefined;
      }),
    ),

    vscode.commands.registerCommand('sandpane.reviewChanges', (taskIdArg?: unknown) =>
      guard('Sandpane: review task changes', async () => {
        const taskId = typeof taskIdArg === 'string' ? taskIdArg : await pickTask(session);
        if (!taskId) return undefined;
        return session.reviewChanges(taskId);
      }),
    ),

    vscode.commands.registerCommand('sandpane.applyTask', (taskIdArg?: unknown) =>
      guard('Sandpane: apply task changes', async () => {
        const taskId = typeof taskIdArg === 'string' ? taskIdArg : await pickTask(session);
        if (!taskId) return undefined;
        await session.applyTask(taskId);
        return undefined;
      }),
    ),

    vscode.commands.registerCommand('sandpane.refreshSandboxes', () =>
      guard('Sandpane: refresh from Core', () => session.refresh()),
    ),

    vscode.commands.registerCommand('sandpane.startService', () => {
      const blocked = unsupportedPlatformReason(process.platform);
      const configured = vscode.workspace
        .getConfiguration('sandpane')
        .get<string>('sandboxDirectory', '');
      void vscode.window.showInformationMessage(
        'Sandpane does not start, upgrade or stop the Core service.\n\n' +
          'Why: the service ownership / auto-start / upgrade policy (ADR 1, specs/02 §10) is not ' +
          'decided, and launching an unverified binary from an IDE would let a plugin silently ' +
          'downgrade a core another client is already using.\n\n' +
          'Start it yourself, then run "Sandpane: Refresh Sandboxes":\n' +
          '  cd core && cargo run -p sandpane-service\n\n' +
          `Socket it will listen on: ${socketPathFor()}\n` +
          `Sandbox directory (this client's setting, not sent to Core): ${configured || 'not set'}` +
          (blocked ? `\n\n${blocked}` : ''),
        'Copy the command',
      );
      return Promise.resolve(undefined);
    }),

    vscode.commands.registerCommand('sandpane.stopService', () => {
      void vscode.window.showWarningMessage(
        'Stopping Core is not offered from the extension: it would take the service down for every ' +
          'other attached client (desktop app, JetBrains plugin) and any task running there. Stop the ' +
          'process yourself (SIGTERM to the sandpane-service process) — tasks are reconciled to ' +
          '"interrupted" on the next start and are never auto-resumed (specs/02 §1).',
      );
      return Promise.resolve(undefined);
    }),

    vscode.commands.registerCommand('sandpane.openCoreLogs', () => {
      // Client-side log channel: transport + RPC outcomes. Prompt bodies and
      // credentials are never written here (AGENTS.md rule 6).
      output.show(true);
      const dir = coreDataDir({
        env: process.env,
        platform: process.platform,
        homedir: process.env['HOME'] ?? '',
      });
      let listing: string;
      try {
        listing = fs
          .readdirSync(dir, { withFileTypes: true })
          .map((entry) => `${entry.isDirectory() ? 'd' : 'f'} ${entry.name}`)
          .join('\n');
      } catch (error) {
        listing = `(cannot read ${dir}: ${error instanceof Error ? error.message : String(error)})`;
      }
      void vscode.window.showInformationMessage(
        'Sandpane Core writes no log file in this build — sandpane-service logs to its own stderr ' +
          '(core/crates/sandpane-service/src/main.rs). The "Sandpane" output channel shown above is ' +
          'the client-side record: connect/close, frame-decode failures and every RPC outcome.\n\n' +
          `Core data directory: ${dir}\n${listing}`,
        'Open folder',
      );
      return Promise.resolve(undefined);
    }),
  ];
}

async function pickProject(session: SandpaneSession): Promise<string | undefined> {
  // Project ids belong to Core: re-read them instead of trusting a cached list.
  const options = await session.listProjectOptions();
  if (options.length === 0) {
    const create = await vscode.window.showWarningMessage(
      'Core has no projects yet (or it is not attached). Create one first.',
      'New project',
    );
    if (create === 'New project') await vscode.commands.executeCommand('sandpane.newProject');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(options, { title: 'Project' });
  return picked?.id;
}

async function pickTask(session: SandpaneSession): Promise<string | undefined> {
  const tasks = session.snapshot().tasks;
  if (tasks.length === 0) {
    void vscode.window.showInformationMessage(
      'No task is known to this window yet. Tasks come from Core: send a message, or run ' +
        '"Sandpane: Refresh Sandboxes" to replay the durable event log.',
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    tasks.map((task) => ({
      label: `task ${task.taskId.slice(0, 8)}`,
      description: task.status ?? 'no status from Core',
      detail: `branch ${task.branch ?? 'unknown'} · base ${task.baseCommit?.slice(0, 8) ?? 'unknown'}`,
      taskId: task.taskId,
    })),
    { title: 'Review which task?' },
  );
  return picked?.taskId;
}
