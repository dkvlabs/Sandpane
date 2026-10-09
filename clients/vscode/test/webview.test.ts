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
    expect(createNonce(() => 0)).toBe('A'.repeat(32));
    // 0.5 lands on alphabet index 31 — lowercase 'f' (A–Z, a–z, 0–9).
    expect(createNonce(() => 0.5)).toBe('f'.repeat(32));
    // A hostile rng cannot break out of the alphabet.
    expect(/^[A-Za-z0-9]{32}$/.test(createNonce(() => 1_000_000))).toBe(true);
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
    expect(
      parseWebviewMessage({ type: 'send', text: 'hi', writable: 'yes', authorizedContext: undefined }),
    ).toEqual({ type: 'send', text: 'hi', writable: false, authorizedContext: false });
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

  it('starts from an honest empty state with the VS2 gate stated', () => {
    const state = emptySidebarState('offline');
    expect(state.connection).toBe('offline');
    expect(state.header).toEqual({
      project: null,
      agent: null,
      sandbox: null,
      workspaceMode: null,
      branch: null,
    });
    expect(state.notices.join(' ')).toMatch(/VS2|P3/);
    expect(state.lines).toEqual([]);
  });
});
