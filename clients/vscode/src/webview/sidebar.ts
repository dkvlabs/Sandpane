/**
 * Sidebar WebviewViewProvider (specs/03 §2). Hosts the Copilot-style panel:
 * sandbox picker + chat shell. The webview is a script from our own resource
 * root under a strict nonce CSP; it can only post the whitelisted message kinds,
 * and every one of them maps to a typed Core method in the session.
 *
 * Disposing the view tears down **our** listeners only. Tasks live in Core and
 * keep running (specs/03 §2.6).
 */

import * as vscode from 'vscode';
import { createNonce, renderSidebarHtml } from './html';
import { parseWebviewMessage, type SidebarState } from './bridge';
import type { SandpaneSession } from '../session';

export class SandpaneChatProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'sandpane.chat';

  private view: vscode.WebviewView | undefined;
  private messageSub: vscode.Disposable | undefined;
  private readonly stateSub: vscode.Disposable;
  private droppedMessages = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: SandpaneSession,
    private readonly log: (message: string) => void,
  ) {
    // The provider outlives a hidden view; state updates are skipped when gone.
    this.stateSub = this.session.subscribe((state) => this.post(state));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.title = 'Sandpane';
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'out', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    view.webview.html = this.renderHtml(view.webview);

    this.messageSub?.dispose();
    this.messageSub = view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (!message) {
        // Unknown or malformed: dropped, counted, never executed.
        this.droppedMessages += 1;
        this.log(
          `dropped webview message #${this.droppedMessages} (not a whitelisted kind) — the webview has no command execution path`,
        );
        return;
      }
      this.session.handleWebviewMessage(message);
    });
    // UI detach only: no task cancellation happens here.
    view.onDidDispose(() => {
      this.view = undefined;
    });
    this.post(this.session.snapshot());
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptSrc = webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'app.js'))
      .toString();
    const styleSrc = webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.css'))
      .toString();
    const html = renderSidebarHtml({
      cspSource: webview.cspSource,
      nonce,
      scriptSrc,
      styleSrc,
      title: 'Sandpane',
    });
    // The webview must be able to fetch its own script/CSP meta; nothing else
    // is exposed to it.
    this.log('rendered sidebar document (nonce per render, default-src \'none\')');
    return html;
  }

  private post(state: SidebarState): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ type: 'state', state });
  }

  dispose(): void {
    this.stateSub.dispose();
    this.messageSub?.dispose();
    this.view = undefined;
  }
}
