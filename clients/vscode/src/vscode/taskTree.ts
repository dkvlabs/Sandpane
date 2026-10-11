/**
 * Task tree (views → `sandpane.tasks`). Displays Core-emitted statuses only;
 * the description text distinguishes "no status emitted" from a real state so a
 * blank field is never read as progress. Opening diffs/apply is delegated to the
 * registered commands, which go through the typed Core client.
 */

import * as vscode from 'vscode';
import type { SandpaneSession } from '../session';
import type { SidebarState, TaskRow } from '../webview/bridge';
import { CHOSEN_SANDBOX_LABEL, SEND_MODE_LABEL, codeSpanText, taskModeParts } from './sendMode';

export class SandpaneTaskTreeProvider implements vscode.TreeDataProvider<TaskRow> {
  static readonly viewId = 'sandpane.tasks';

  private current: SidebarState | null = null;
  private lastTaskCount = 0;
  private readonly emitter = new vscode.EventEmitter<TaskRow | undefined>();
  private readonly subscription: vscode.Disposable;

  readonly onDidChangeTreeData: vscode.Event<TaskRow | undefined> = this.emitter.event;

  constructor(private readonly session: SandpaneSession) {
    this.subscription = this.session.subscribe((state) => {
      this.current = state;
      // Refresh only on a real change — not on every keystroke of a status line.
      if (state.tasks.length !== this.lastTaskCount) {
        this.lastTaskCount = state.tasks.length;
      }
      this.emitter.fire(undefined);
    });
  }

  getTreeItem(element: TaskRow): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.status
        ? `task ${element.taskId.slice(0, 8)} · ${element.status}`
        : `task ${element.taskId.slice(0, 8)} · no status from Core`,
      vscode.TreeItemCollapsibleState.None,
    );
    const detailParts = [
      `branch: ${element.branch ?? 'unknown'}`,
      `base: ${element.baseCommit?.slice(0, 8) ?? 'unknown'}`,
      // A4: send mode and the chat's chosen name — read-only, labelled, and
      // already revealed and capped in the snapshot.
      ...taskModeParts(element),
      element.unknownKinds.length > 0
        ? `${element.unknownKinds.length} unrecognized event kind(s)`
        : null,
    ].filter((p): p is string => p !== null);
    item.description = detailParts.join(' · ');
    item.id = element.taskId;
    item.command = {
      command: 'sandpane.reviewChanges',
      title: 'Review task changes',
      arguments: [element.taskId],
    };
    item.tooltip = new vscode.MarkdownString(
      [
        `**Task ${element.taskId}**`,
        '',
        `- status: \`${element.status ?? 'not emitted by Core'}\` (Core is the only authority)`,
        `- branch: \`${element.branch ?? 'unknown'}\``,
        `- base commit: \`${element.baseCommit ?? 'unknown'}\``,
        element.mode !== undefined ? `- ${SEND_MODE_LABEL}: \`${codeSpanText(element.mode)}\`` : '',
        element.chosenSandboxName !== undefined
          ? `- ${CHOSEN_SANDBOX_LABEL}: \`${codeSpanText(element.chosenSandboxName)}\``
          : '',
        element.unknownKinds.length > 0 ? `- unrecognized event kinds: ${element.unknownKinds.join(', ')}` : '',
        '',
        'Opens `git.review` against the recorded base revision.',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    );
    item.contextValue = 'sandpane.task';
    return item;
  }

  getChildren(): TaskRow[] {
    return this.current?.tasks ?? [];
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
