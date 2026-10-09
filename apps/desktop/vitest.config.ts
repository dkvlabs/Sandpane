import { defineConfig } from "vitest/config";

// Unit suites are pure-logic (no DOM): the framing codec, reducers, connection
// state folding and wizard validation. Component rendering tests are a DT1 item
// and would add jsdom — deliberately not installed for this scaffold.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
