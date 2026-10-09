/**
 * Webview document + Content Security Policy (specs/03 §2/§3, specs/06).
 *
 * Strict policy: `default-src 'none'`, scripts only from the extension's own
 * webview resource root with a per-render nonce, styles only from a file
 * (no `unsafe-inline`), no remote origins, no inline event handlers. Every
 * interpolated value is escaped; content from Core is never rendered as HTML.
 *
 * Pure string builder → the invariants are unit-tested in `test/webviewHtml.test.ts`.
 */

export interface SidebarHtmlInput {
  /** `webview.cspSource` — the local resource origin. */
  cspSource: string;
  /** Fresh per-document nonce. */
  nonce: string;
  /** Resolved URI of the compiled sidebar script (`out/webview/app.js`). */
  scriptSrc: string;
  /** Resolved URI of `media/sidebar.css`. */
  styleSrc: string;
  /** View title, escaped before it reaches the document. */
  title: string;
}

const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 32-char nonce from an injectable RNG (tests pass a deterministic one). */
export function createNonce(rng: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    out += NONCE_ALPHABET.charAt(Math.floor(Math.max(0, Math.min(0.9999999, rng())) * 62));
  }
  return out;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildCsp(cspSource: string, nonce: string): string {
  // connect-src 'none' is deliberate: the webview cannot reach the network or
  // the socket. All Core traffic goes through the extension host (specs/06 §4).
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ') + ';';
}

export function renderSidebarHtml(input: SidebarHtmlInput): string {
  const csp = buildCsp(input.cspSource, input.nonce);
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="nonce" content="${escapeHtml(input.nonce)}" />
<title>${escapeHtml(input.title)}</title>
<link rel="stylesheet" href="${escapeHtml(input.styleSrc)}" />
</head>
<body>
<div id="sandpane-root" class="sp-root" role="main" aria-label="${escapeHtml(input.title)}"></div>
<div id="sp-announcer" class="sp-status" role="status" aria-live="polite"></div>
<script nonce="${escapeHtml(input.nonce)}" src="${escapeHtml(input.scriptSrc)}"></script>
</body>
</html>
`;
}
