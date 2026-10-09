import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // `vscode` only exists inside the extension host. The session-level tests
    // run src/session.ts against a recording stub of the API surface it uses
    // (test/helpers/vscodeStub.ts); every other suite imports no vscode at all.
    alias: { vscode: resolve(__dirname, 'test/helpers/vscodeStub.ts') },
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
