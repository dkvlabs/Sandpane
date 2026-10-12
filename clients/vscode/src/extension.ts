/**
 * Extension entry point (specs/03 §2).
 *
 * activate(): attach to Core, register the sidebar webview, the task tree, the
 * twenty commands (each one is a progress-wrapped call into the typed Core
 * client, or an honest explanation of what is not offered) and the status bar
 * item.
 *
 * deactivate(): dispose subscriptions ONLY. A detached window must never be able
 * to terminate a running task — Core owns the agent processes (specs/02 §1,
 * specs/03 §2.6). There is deliberately no cancellation call anywhere below.
 */

import * as vscode from 'vscode';
import { PATCH_SCHEME } from './vscode/gitDiff';
import { APPLY_LIST_SCHEME } from './vscode/gitApply';
import { VERIFICATION_SCHEME } from './vscode/verification';
import {
  verificationCommandHandlers,
  type VerificationCommandId,
  type VerificationHandler,
} from './vscode/verificationCommands';
import * as fs from 'node:fs';
import { SandpaneSession } from './session';
import { SandpaneChatProvider } from './webview/sidebar';
import { SandpaneTaskTreeProvider } from './vscode/taskTree';
import { coreDataDir, unsupportedPlatformReason } from './core-client/paths';
import { allWorkspaceModeViews } from './vscode/workspaces';
import { isKnownWorkspaceMode } from './vscode/workspaces';
import {
  validateSandboxName,
  validateAddressableSandboxName,
  validateProjectDescription,
  validateProjectName,
  CoreValidationError,
} from './core-client/commands';
import { agentPickItems, pickText, sandboxPickItem, startUnsupportedMessage } from './vscode/sandboxActions';
import { isArchived, projectPickItem } from './vscode/projectActions';
import type { Project, SbxAgent } from './core-client/protocol';
import { plainText } from './text/visibleText';

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

  // `sandpane.coreAvailable` means "Core is attached", not "this host is
  // supported" (review 12f) — and it is only re-sent when it changes.
  let coreAvailable: boolean | null = null;
  const stateSub = session.subscribe((state) => {
    const icon =
      state.connection === 'online'
        ? '$(pass)'
        : state.connection === 'unsupported'
          ? '$(error)'
          : '$(debug-disconnect)';
    status.text = `${icon} Sandpane: ${state.connection}`;
    // The path shown is the one the session actually dialled (review 12g).
    status.tooltip =
      state.capabilities === null
        ? `${host.explanation}\n\nCore socket: ${session.socketPath}`
        : `Core ${state.capabilities.coreVersion} · protocol v${state.capabilities.protocolVersion}\n` +
          `instance ${state.capabilities.instanceId}\nplatform: ${state.capabilities.platform}\n` +
          `sbx installed: ${String(state.capabilities.sbxInstalled)}\n` +
          // A8a: the same finished lines the sidebar shows (src/vscode/sbxStatus.ts),
          // only while online — a cached probe is not presented as current.
          (state.connection === 'online'
            ? [
                state.capabilities.sbxNote,
                state.capabilities.sbxVersion === null ? null : `sbx version: ${state.capabilities.sbxVersion}`,
                state.capabilities.sbxDaemon,
                state.capabilities.sbxExec,
                state.capabilities.sbxCaptured,
              ]
            : [`sbx status: last probe not shown while Core is ${state.connection}`]
          )
            .filter((line): line is string => line !== null)
            .map((line) => `${line}\n`)
            .join('') +
          `agents: ${state.capabilities.agents
            .map((a) => `${a.id}${a.verified ? ' (verified)' : ' (unverified)'}`)
            .join(', ') || 'none'}\nCore socket: ${session.socketPath}`;
    status.show();
    const available = host.supported && state.connection === 'online';
    if (available !== coreAvailable) {
      coreAvailable = available;
      void vscode.commands.executeCommand('setContext', CORE_AVAILABLE_CONTEXT, available);
    }
  });

  const configSub = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('sandpane.coreSocketPath')) {
      void vscode.window.showInformationMessage(
        'Sandpane: the Core socket path changed. It is used from the next connection attempt; ' +
          `this window is still attached to ${session.socketPath}. Reload the window to switch now.`,
      );
    }
  });

  context.subscriptions.push(
    output,
    status,
    stateSub,
    configSub,
    session,
    provider,
    tree,
    vscode.window.registerWebviewViewProvider(SandpaneChatProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.createTreeView(SandpaneTaskTreeProvider.viewId, { treeDataProvider: tree }),
    // A5: read-only virtual documents for git.diff patches (in memory, no temp files).
    vscode.workspace.registerTextDocumentContentProvider(PATCH_SCHEME, session.patchDocuments),
    // A6 V-W1: the read-only full list of a large apply (in memory, never on disk).
    vscode.workspace.registerTextDocumentContentProvider(APPLY_LIST_SCHEME, session.applyListDocuments),
    // A7: read-only verification output and argument lists (in memory, plain text, never a terminal).
    vscode.workspace.registerTextDocumentContentProvider(VERIFICATION_SCHEME, session.verificationDocuments),
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
      void session.refresh({ background: true }).catch(() => undefined);
    }, 30_000);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));
  }

  log(
    `activated (host=${host.supported ? 'local' : 'remote'}, socket=${session.socketPath}, protocol v1, transport=unix-socket)`,
  );
}

/** Never cancels anything: subscriptions are the only thing released. */
export function deactivate(): void {
  // Intentionally empty. VS Code disposes the ExtensionContext subscriptions,
  // and `SandpaneSession.dispose()` closes our socket and stops event polling.
  // Task cancellation is a separate, explicit user action through `task.cancel`.
}

/** Printed and copied for the user; the extension never runs it (ADR 1). */
const START_SERVICE_COMMAND = 'cd core && cargo run -p sandpane-service';

/** The twenty contributed commands, each wrapped in a progress notification. */
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

  // A7: each handler IGNORES its arguments (a command: URI or another
  // extension can pass anything); the dialogs read everything from Core.
  const verificationHandlers = Object.fromEntries(
    Object.entries(verificationCommandHandlers(session)).map(([id, handler]) => [
      id,
      (..._ignored: unknown[]) => guard(`Sandpane: ${id.replace(/^sandpane\./, '')}`, () => handler()).then(() => undefined),
    ]),
  ) as Record<VerificationCommandId, VerificationHandler>;

  return [
    vscode.commands.registerCommand('sandpane.approveVerification', verificationHandlers['sandpane.approveVerification']),
    // prettier-ignore
    vscode.commands.registerCommand('sandpane.approveVerificationSuggestion', verificationHandlers['sandpane.approveVerificationSuggestion']),
    vscode.commands.registerCommand('sandpane.revokeVerification', verificationHandlers['sandpane.revokeVerification']),
    vscode.commands.registerCommand('sandpane.runVerification', verificationHandlers['sandpane.runVerification']),
    vscode.commands.registerCommand('sandpane.showVerificationResult', verificationHandlers['sandpane.showVerificationResult']),

    // A9: the Maintenance flow (scan → pick → modal → step 2 → re-scan). The
    // handler IGNORES its arguments; everything is read fresh from Core.
    vscode.commands.registerCommand('sandpane.maintenance', (..._ignored: unknown[]) =>
      guard('Sandpane: clean up Core state', () => session.runMaintenanceCleanup()).then(() => undefined),
    ),

    vscode.commands.registerCommand('sandpane.newProject', () =>
      guard('Sandpane: new project', async () => {
        const name = await vscode.window.showInputBox({
          prompt: 'Project name (stored by Core)',
          validateInput: projectNameProblem,
        });
        if (!name) return undefined;
        const folders = vscode.workspace.workspaceFolders ?? [];
        const chosen =
          folders.length === 0
            ? []
            : ((
                await vscode.window.showQuickPick(
                  folders.map((folder) => ({ label: folder.uri.fsPath, description: folder.name })),
                  {
                    canPickMany: true,
                    // Core accepts only a git repository's top-level folder and
                    // stores its canonical path; a monorepo subfolder is refused.
                    title: 'Repositories to associate (optional) — each must be a git top-level folder',
                  },
                )
              ) ?? []).map((item) => item.label);
        return session.createProject(name, chosen);
      }),
    ),

    vscode.commands.registerCommand('sandpane.newSandbox', () =>
      guard('Sandpane: new sandbox (sbx create can take up to 5 minutes)', async () => {
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
        // A1 agent choice — offered only when this Core advertises the
        // "sandbox-create-agent" feature (A2; an older Core would silently
        // ignore the field). Default: provider-free shell, sent as an absent field.
        let agent: SbxAgent | undefined;
        if (session.coreHasFeature('sandbox-create-agent')) {
          const picked = await vscode.window.showQuickPick(agentPickItems(), {
            title: 'Agent inside the sandbox (sbx built-in)',
            placeHolder: 'shell is provider-free; any other agent is not verified by Sandpane',
          });
          if (!picked) return undefined;
          agent = picked.agent;
        } else {
          log('agent choice not offered: this Core does not advertise the "sandbox-create-agent" feature (default shell is used)');
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
          ...(agent !== undefined ? { agent } : {}),
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
        // Honest copy (review bug 7): conversation.send has no mode field, so
        // Core v1 records a task for BOTH choices. The choice changes this
        // client's confirmation gate and attachment policy only.
        const intent = await vscode.window.showQuickPick(
          [
            {
              label: 'Discuss (read-only intent)',
              description: 'Core v1 has no read-only mode: it still records a task',
              writable: false,
            },
            {
              label: 'Writable task',
              description: "agent may edit files in the selected sandbox's workspace",
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
          ...plan.excluded.map((e) => `· not attached — ${e.label}: ${e.reason}`),
        ].join('\n');
        const confirmed = await vscode.window.showInformationMessage(
          listed,
          {
            modal: true,
            detail:
              'Only the references listed above are sent; nothing is attached implicitly. ' +
              plan.disclosure,
          },
          'Send it',
        );
        if (confirmed !== 'Send it') return undefined;
        await session.send(text, intent.writable, plan.planId, 'command');
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

    vscode.commands.registerCommand('sandpane.showTaskPatch', (taskIdArg?: unknown) =>
      guard('Sandpane: show task patch', async () => {
        const taskId = typeof taskIdArg === 'string' ? taskIdArg : await pickTask(session);
        if (!taskId) return undefined;
        return session.showTaskPatch(taskId);
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

    vscode.commands.registerCommand('sandpane.stopSandbox', (nameArg?: unknown) =>
      guard('Sandpane: stop sandbox (sbx stop can take up to 5 minutes)', async () => {
        const name = await sandboxArgOrPick(session, nameArg, 'Stop which sandbox?');
        if (!name) return undefined;
        return session.stopSandbox(name);
      }),
    ),

    vscode.commands.registerCommand('sandpane.removeSandbox', (nameArg?: unknown) =>
      guard('Sandpane: remove sandbox', async () => {
        const name = await sandboxArgOrPick(session, nameArg, 'Remove which sandbox?');
        if (!name) return undefined;
        return session.removeSandbox(name);
      }),
    ),

    vscode.commands.registerCommand('sandpane.startSandbox', (nameArg?: unknown) => {
      // Visibly unsupported (sbx v0.47 has no start). Nothing is sent to Core
      // and nothing is run; the hint is text for the user's own terminal.
      let name: string | null = null;
      if (typeof nameArg === 'string') {
        try {
          name = validateAddressableSandboxName(nameArg);
        } catch {
          name = null;
        }
      }
      void vscode.window.showWarningMessage(startUnsupportedMessage(name));
      return Promise.resolve(undefined);
    }),

    // --- A3a project lifecycle (each gated on Core's probe before any picker) ---
    vscode.commands.registerCommand('sandpane.renameProject', () =>
      guard('Sandpane: rename project', async () => {
        if (!(await session.offers('project.update', 'Rename project'))) return undefined;
        const project = await pickProjectForSettings(session, 'Rename which project?', 'all');
        if (!project || session.refuseIfArchived(project, 'Rename project')) return undefined;
        const name = await vscode.window.showInputBox({
          title: `Rename "${pickText(project.name, 120)}"`,
          prompt: 'New project name (Core stores it exactly as typed; at most 120 characters, one line)',
          value: project.name,
          validateInput: projectNameProblem,
        });
        if (name === undefined || name === project.name) return undefined;
        return session.renameProject(project, name);
      }),
    ),

    vscode.commands.registerCommand('sandpane.editProjectDescription', () =>
      guard('Sandpane: edit project description', async () => {
        if (!(await session.offers('project.update', 'Edit project description'))) return undefined;
        const project = await pickProjectForSettings(session, 'Edit the description of which project?', 'all');
        if (!project || session.refuseIfArchived(project, 'Edit project description')) return undefined;
        return editDescriptionInEditor(session, project);
      }),
    ),

    vscode.commands.registerCommand('sandpane.archiveProject', () =>
      guard('Sandpane: archive project', async () => {
        if (!(await session.offers('project.archive', 'Archive project'))) return undefined;
        const project = await pickProjectForSettings(session, 'Archive which project?', 'live');
        if (!project) return undefined;
        return session.archiveProject(project);
      }),
    ),

    vscode.commands.registerCommand('sandpane.unarchiveProject', () =>
      guard('Sandpane: unarchive project', async () => {
        if (!(await session.offers('project.unarchive', 'Unarchive project'))) return undefined;
        const project = await pickProjectForSettings(session, 'Unarchive which project?', 'archived');
        if (!project) return undefined;
        return session.unarchiveProject(project);
      }),
    ),

    vscode.commands.registerCommand('sandpane.toggleArchivedProjects', () =>
      guard('Sandpane: show / hide archived projects', () => session.toggleShowArchived()),
    ),

    vscode.commands.registerCommand('sandpane.addRepository', () =>
      guard('Sandpane: add repository to project', async () => {
        if (!(await session.offers('project.add_repository', 'Add repository'))) return undefined;
        const project = await pickProjectForSettings(session, 'Add a repository to which project?', 'all');
        if (!project || session.refuseIfArchived(project, 'Add repository')) return undefined;
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Register with project',
          title: `Repository for "${pickText(project.name, 120)}" — a git repository's top-level folder`,
        });
        const folder = picked?.[0];
        if (!folder) return undefined;
        if (folder.scheme !== 'file') {
          void vscode.window.showWarningMessage(
            `Only local folders can be registered (this one is "${plainText(folder.scheme, 32)}:"). Nothing was sent.`,
          );
          return undefined;
        }
        return session.addRepository(project, folder.fsPath);
      }),
    ),

    vscode.commands.registerCommand('sandpane.removeRepository', () =>
      guard('Sandpane: remove repository from project', async () => {
        if (!(await session.offers('project.remove_repository', 'Remove repository'))) return undefined;
        const project = await pickProjectForSettings(session, 'Remove a repository from which project?', 'all');
        if (!project || session.refuseIfArchived(project, 'Remove repository')) return undefined;
        const repositories = project.repositories ?? [];
        if (repositories.length === 0) {
          void vscode.window.showInformationMessage(
            `Core lists no repository for "${plainText(project.name, 120)}". Nothing was sent.`,
          );
          return undefined;
        }
        const picked = await vscode.window.showQuickPick(
          repositories.map((path) => ({ label: pickText(path, 200), path })),
          {
            title: 'Unregister which repository? (Core only forgets it; the folder on disk is not touched)',
          },
        );
        if (!picked) return undefined;
        return session.removeRepository(project, picked.path);
      }),
    ),

    vscode.commands.registerCommand('sandpane.deleteProject', () =>
      guard('Sandpane: delete project', async () => {
        if (!(await session.offers('project.delete', 'Delete project'))) return undefined;
        const project = await pickProjectForSettings(session, 'Delete which project? (a confirmation from Core follows)', 'all');
        if (!project) return undefined;
        return session.deleteProject(project);
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
          `  ${START_SERVICE_COMMAND}\n\n` +
          `Socket this window dials: ${session.socketPath}\n` +
          `Sandbox directory (this client's setting, not sent to Core): ${configured || 'not set'}` +
          (blocked ? `\n\n${blocked}` : ''),
        'Copy the command',
      ).then(async (choice) => {
        // The button does what it says (review 12e): copy only, never run.
        if (choice !== 'Copy the command') return;
        await vscode.env.clipboard.writeText(START_SERVICE_COMMAND);
        void vscode.window.showInformationMessage(`Copied: ${START_SERVICE_COMMAND}`);
      });
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
      ).then((choice) => {
        // Reveal in the OS file manager (review 12e) — opens nothing else.
        if (choice === 'Open folder') {
          void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        }
      });
      return Promise.resolve(undefined);
    }),
  ];
}

/** `validateInput` for a project name: Core's exact rule, or undefined when valid. */
function projectNameProblem(value: string): string | undefined {
  try {
    validateProjectName(value);
    return undefined;
  } catch (error) {
    return error instanceof CoreValidationError
      ? `Core would refuse this name: ${error.message.replace(/^name: /, '')}`
      : 'Core would refuse this name';
  }
}

type ProjectFilter = 'all' | 'live' | 'archived';

/**
 * A project for an A3a command, re-read from Core (archived projects included
 * and labeled ARCHIVED). `live` / `archived` narrow the list for archive /
 * unarchive. Labels are plain text.
 */
async function pickProjectForSettings(
  session: SandpaneSession,
  title: string,
  filter: ProjectFilter,
): Promise<Project | undefined> {
  let projects: Project[];
  try {
    projects = await session.listProjectsForSettings();
  } catch (error) {
    session.reportError(error, 'project.list');
    return undefined;
  }
  const shown = projects.filter((p) => filter === 'all' || (filter === 'archived') === isArchived(p));
  if (shown.length === 0) {
    void vscode.window.showInformationMessage(
      filter === 'archived'
        ? 'Core lists no archived project. Nothing was sent.'
        : filter === 'live'
          ? 'Core lists no project that is not archived. Nothing was sent.'
          : 'Core has no projects yet. Create one with "Sandpane: New Project".',
    );
    return undefined;
  }
  const items = shown.map((project) => {
    const item = projectPickItem(project);
    return {
      ...item,
      ...(item.archived && filter === 'all'
        ? { description: `${item.description} — unarchive to edit; only Unarchive and Delete apply` }
        : {}),
      project,
    };
  });
  const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
  return picked?.project;
}

const SAVE_DESCRIPTION = 'Save as description';
const DISCARD_DESCRIPTION = 'Discard';

/**
 * Multi-line description editing: VS Code's input box is single-line, so the
 * current description opens in an untitled plain-text editor and nothing is
 * sent until "Save as description" is clicked. The editor's text is read at
 * click time; CRLF line ends are sent as LF (Core allows only \n). An empty
 * editor clears the description (Core's rule). Discard / dismiss sends nothing.
 */
async function editDescriptionInEditor(
  session: SandpaneSession,
  project: Project,
): Promise<Project | undefined> {
  const doc = await vscode.workspace.openTextDocument({ content: project.description, language: 'plaintext' });
  await vscode.window.showTextDocument(doc, { preview: false });
  const name = plainText(project.name, 120);
  for (;;) {
    const choice = await vscode.window.showInformationMessage(
      `Editing the description of "${name}" (at most 2000 characters; an empty editor clears it). ` +
        'Nothing is sent until you choose "Save as description".',
      SAVE_DESCRIPTION,
      DISCARD_DESCRIPTION,
    );
    if (choice !== SAVE_DESCRIPTION) {
      void vscode.window.showInformationMessage(
        'Description not changed — nothing was sent. You can close the untitled editor without saving.',
      );
      return undefined;
    }
    const text = doc.getText().replace(/\r\n/g, '\n');
    try {
      validateProjectDescription(text);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Core would refuse this description (${error instanceof Error ? error.message : String(error)}). ` +
          'Nothing was sent; fix it in the editor and choose again.',
      );
      continue;
    }
    const updated = await session.editProjectDescription(project, text);
    if (updated && vscode.window.activeTextEditor?.document === doc) {
      // Close only that untitled scratch editor, without a save prompt.
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    return updated;
  }
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

/**
 * A sandbox name from a command argument (validated) or from a fresh Core
 * `sandbox.list` picker. Labels are plain text (hidden characters escaped).
 */
async function sandboxArgOrPick(
  session: SandpaneSession,
  nameArg: unknown,
  title: string,
): Promise<string | undefined> {
  if (typeof nameArg === 'string') return validateAddressableSandboxName(nameArg);
  const sandboxes = await session.listSandboxOptions();
  if (sandboxes.length === 0) {
    void vscode.window.showInformationMessage(
      'Core lists no sandbox (or it is not attached). Run "Sandpane: Refresh Sandboxes" to re-read sbx.',
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(sandboxes.map(sandboxPickItem), { title });
  return picked?.name;
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
