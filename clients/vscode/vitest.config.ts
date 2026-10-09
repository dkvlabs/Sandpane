import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Pure logic only — no VS Code extension host, no sockets, no subprocesses.
    globals: false,
    reporters: ['default'],
  },
});
