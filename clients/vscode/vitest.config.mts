import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `.mts` (ESM): Vite's planned native config loader rejects ESM syntax in a
// file loaded as CommonJS, and this package has no "type": "module".
// fileURLToPath, not URL.pathname: the checkout path may contain spaces.
export default defineConfig({
  resolve: {
    // `vscode` only exists inside the extension host. The session-level tests
    // run src/session.ts against a recording stub of the API surface it uses
    // (test/helpers/vscodeStub.ts); every other suite imports no vscode at all.
    alias: { vscode: fileURLToPath(new URL('./test/helpers/vscodeStub.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // No VS Code extension host and no real Core: sockets are local test peers,
    // the sidebar script runs in node:vm against a fake DOM.
    globals: false,
    reporters: ['default'],
  },
});
