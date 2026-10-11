import { describe, expect, it } from 'vitest';
import { buildCsp, createNonce, escapeHtml, renderSidebarHtml } from '../src/webview/html';
import {
  WEBVIEW_MESSAGE_KINDS,
  emptySidebarState,
  parseWebviewMessage,
} from '../src/webview/bridge';

const CSP_SOURCE = 'vscode-webview://1a2b3c';
const NONCE = 'a'.repeat(32);
const SCRIPT = `${CSP_SOURCE}/out/webview/app.js`;
const STYLE = `${CSP_SOURCE}/media/sidebar.css`;

function doc(title = 'Sandpane'): string {
  return renderSidebarHtml({ cspSource: CSP_SOURCE, nonce: NONCE, scriptSrc: SCRIPT, styleSrc: STYLE, title });
}

describe('webview CSP (specs/03 §2, §3)', () => {
  it('denies everything by default and allows only our own resources', () => {
    const csp = buildCsp(CSP_SOURCE, NONCE);
    expect(csp.startsWith("default-src 'none';")).toBe(true);
    expect(csp).toContain(`script-src 'nonce-${NONCE}' ${CSP_SOURCE}`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    // No remote origins are permitted anywhere in the policy.
    expect(csp).not.toMatch(/https?:/);
  });

  it('emits exactly one nonced script tag and no inline handler', () => {
    const html = doc();
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(`nonce="${NONCE}"`);
    expect(scripts[0]).toContain(`src="${SCRIPT}"`);
    expect(/on(click|load|error|input|change)\s*=/.test(html)).toBe(false);
    expect(html).not.toContain('javascript:');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${escapeHtml(buildCsp(CSP_SOURCE, NONCE))}"`);
  });

  it('escapes an injected title instead of letting it close the head', () => {
    const html = doc('</title><script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const inline = html.match(/<script/g) ?? [];
    expect(inline).toHaveLength(1);
  });

  it('generates nonces from the allowed alphabet and stays injectable for tests', () => {
    const nonce = createNonce();
    expect(nonce).toHaveLength(32);
    expect(/^[A-Za-z0-9]{32}$/.test(nonce)).toBe(true);
    // Deterministic byte sources: 0 → 'A', 31 → 'f', 61 → '9'.
    expect(createNonce((n) => new Uint8Array(n).fill(0))).toBe('A'.repeat(32));
    expect(createNonce((n) => new Uint8Array(n).fill(31))).toBe('f'.repeat(32));
    expect(createNonce((n) => new Uint8Array(n).fill(61))).toBe('9'.repeat(32));
    // Bytes >= 248 are rejected (no modulo bias), never mapped.
    expect(createNonce((n) => Uint8Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 255 : 1)))).toBe(
      'B'.repeat(32),
    );
    // A source that only yields biased bytes fails loudly instead of a weak nonce.
    expect(() => createNonce((n) => new Uint8Array(n).fill(250))).toThrow(/no usable bytes/);
    // Two default nonces differ (CSPRNG, not a constant).
    expect(createNonce()).not.toBe(createNonce());
  });

  it('links the stylesheet as a resource, never inline', () => {
    const html = doc();
    expect(html).toContain(`<link rel="stylesheet" href="${STYLE}"`);
    expect(html).not.toContain('<style');
  });
});

describe('webview message whitelist', () => {
  it('accepts only the documented kinds and shapes', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'refresh' })).toEqual({ type: 'refresh' });
    expect(parseWebviewMessage({ type: 'selectSandbox', name: 'auth-codex' })).toEqual({
      type: 'selectSandbox',
      name: 'auth-codex',
    });
    expect(parseWebviewMessage({ type: 'send', text: 'hi', writable: 'yes', planId: undefined })).toEqual({
      type: 'send',
      text: 'hi',
      writable: false,
      planId: null,
    });
    expect(parseWebviewMessage({ type: 'send', text: 'hi', writable: true, planId: 4 })).toEqual({
      type: 'send',
      text: 'hi',
      writable: true,
      planId: 4,
    });
    // A plan id must be a non-negative integer, or it is no authorization at all.
    expect(parseWebviewMessage({ type: 'send', text: 'hi', writable: true, planId: 1.5 })).toMatchObject({
      planId: null,
    });
    // The preview carries the intent the user chose (review bug 6).
    expect(parseWebviewMessage({ type: 'previewContext', writable: true })).toEqual({
      type: 'previewContext',
      writable: true,
    });
    expect(parseWebviewMessage({ type: 'previewContext' })).toEqual({ type: 'previewContext', writable: false });
    // The old webview-asserted authorization flag is not part of the contract.
    expect(parseWebviewMessage({ type: 'send', text: 'hi', authorizedContext: true })).not.toHaveProperty(
      'authorizedContext',
    );
    expect(parseWebviewMessage({ type: 'cancelTask', taskId: 't1' })).toEqual({
      type: 'cancelTask',
      taskId: 't1',
    });
  });

  it('drops anything else — no command execution path from the webview', () => {
    const rejected: unknown[] = [
      undefined,
      null,
      'execute',
      42,
      {},
      { type: 'executeCommand', command: 'workbench.action.files.newUntitledFile' },
      { type: 'shell', args: ['rm', '-rf', '/'] },
      { type: 'selectSandbox' }, // missing name
      { type: 'cancelTask', taskId: 7 }, // wrong type
      { type: 'send', text: 5 }, // body must be a string
    ];
    for (const value of rejected) {
      expect(parseWebviewMessage(value), JSON.stringify(value)).toBeUndefined();
    }
    expect(WEBVIEW_MESSAGE_KINDS).not.toContain('executeCommand');
    expect(WEBVIEW_MESSAGE_KINDS).not.toContain('shell');
  });

  it('A3b: parses the conversation messages strictly (allowlisted action, bounded id)', () => {
    expect(parseWebviewMessage({ type: 'selectConversation', conversationId: 'c1' })).toEqual({
      type: 'selectConversation',
      conversationId: 'c1',
    });
    expect(parseWebviewMessage({ type: 'selectConversation', conversationId: '' })).toEqual({
      type: 'selectConversation',
      conversationId: '',
    });
    expect(parseWebviewMessage({ type: 'toggleArchivedConversations', extra: 1 })).toEqual({ type: 'toggleArchivedConversations' });
    for (const action of ['rename', 'archive', 'unarchive', 'export', 'delete']) {
      expect(parseWebviewMessage({ type: 'conversationAction', action, conversationId: 'c1' })).toEqual({
        type: 'conversationAction',
        action,
        conversationId: 'c1',
      });
    }
    for (const bad of [
      { type: 'conversationAction', action: 'send', conversationId: 'c1' },
      { type: 'conversationAction', action: 'delete', conversationId: '' },
      { type: 'conversationAction', action: 'delete', conversationId: 'x'.repeat(201) },
      { type: 'conversationAction', action: 'delete' },
      { type: 'conversationAction', action: 'delete', conversationId: 7 },
      { type: 'selectConversation' },
      { type: 'selectConversation', conversationId: 'x'.repeat(201) },
      { type: 'conversationAction', action: 'toString', conversationId: 'c1' },
    ]) {
      expect(parseWebviewMessage(bad), JSON.stringify(bad)).toBeUndefined();
    }
    const empty = emptySidebarState('online');
    expect(empty.conversations).toEqual({ supported: false, note: null, showArchived: false, showArchivedSupported: false, rows: [] });
    expect(empty.composerBlocked).toBeNull();
  });

  it('starts from an honest empty state with the VS2 gate stated', () => {
    const state = emptySidebarState('offline');
    expect(state.connection).toBe('offline');
    expect(state.header).toEqual({
      project: null,
      agent: null,
      sandbox: null,
      workspaceMode: null,
      workspaceModeBadge: null,
      workspaceHostWritable: false,
      branch: null,
    });
    expect(state.notices.join(' ')).toMatch(/VS2|P3/);
    expect(state.lines).toEqual([]);
  });
});

describe('A5 webview message: showTaskPatch', () => {
  it('parses a task id strictly', () => {
    expect(parseWebviewMessage({ type: 'showTaskPatch', taskId: 't1' })).toEqual({ type: 'showTaskPatch', taskId: 't1' });
    expect(parseWebviewMessage({ type: 'showTaskPatch', taskId: 5 })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'showTaskPatch', taskId: '' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'showTaskPatch', taskId: 'x'.repeat(201) })).toBeUndefined();
  });
});
