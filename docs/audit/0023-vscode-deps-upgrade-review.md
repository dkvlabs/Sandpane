# 0023 — Auto-review record: VS Code dependency upgrade (U2)

- **date:** 2026-10-09
- **implementation commit:** `7a0a5b8` — build(vscode): upgrade to TypeScript 7 and Vitest 5; pin @types/vscode to the engine (U2)
- **review ran:** before the commit (checklist, orchestrator)

## Scope

- `clients/vscode/`:
  - `package.json` and a regenerated `package-lock.json`
  - both tsconfigs
  - `vitest.config.ts` → `vitest.config.mts`
  - test helpers and `test/session.test.ts`
  - `.vscodeignore`, `README.md`, `INSTALL.md`
- `docs/compatibility.md`

## Method

The orchestrator ran a dependency-upgrade checklist against the `vscode-engineer` report and re-ran every gate fresh, including the live Core check.

- **Versions:** each was confirmed with `npm view`. The `@vscode/vsce` pre-release `4.0.1-3` (tag `next`) was not taken.
- **Docs (through ctx7):**
  - `/microsoft/typescript/v7.0.2`: the removed-options list.
  - `/vitest-dev/vitest/v5.0.3`: migration notes.
- **Config errors were real:** TS 7 rejected the old configs with TS5108 (node10 removed) and TS6046 (`module none`). Each fix is the minimal option change.
- **Shipped output compared with the pre-upgrade snapshot:**
  - The webview `app.js` is byte-identical.
  - Five extension-host files gained `__importStar`, because `esModuleInterop` is forced on in TS 7.
  - The `.vsix` file count is unchanged at 30.
- **Test helper change:** it now runs `tsc` through `execFileSync` with an argument vector and no shell (AGENTS.md Code Review rule 1). It writes to a private `mkdtemp` directory. In a negative check, `moduleDetection: force` made the 16 sidebar tests fail.

## Findings

1. **Warning (fixed in this commit): `@types/vscode` exceeded `engines.vscode`.** The caret range had floated to 1.140.0, so typecheck could accept APIs that VS Code 1.90 does not have. It is now pinned to exactly 1.90.0, and typecheck still passes.
2. **Note (recorded gap): `@types/node` cannot be 20.x.** vitest 5 rejects it as a peer. The nearest allowed version, 22.20.5, is used, so typecheck would not catch a Node-22-only API. Mitigation: `src/` imports only `node:net`, `node:fs`, `node:fs/promises` and `node:crypto`. The claim that VS Code 1.90 bundles Node 20 was not verified independently, and the README says so.
3. **Note:** npm's install-script allowlist skipped `@vscode/vsce-sign`'s postinstall. Packaging works; signing and publishing are out of scope because of the licensing gate.
4. **Residual (UNVERIFIED):** the five `__importStar` files have not been loaded in a real Extension Development Host. They only loaded under Node 24 with a stub `vscode` module.

## Disposition

Finding 1 is fixed. Findings 2–4 are recorded in the README and in `docs/compatibility.md`. No Critical findings.

## Verification evidence (orchestrator, fresh)

- `npm run typecheck`: exit 0, no diagnostics.
- `npm test`: `Tests 280 passed (280)`.
- `npm run package`: `DONE Packaged: sandpane-0.0.1.vsix (30 files, 98.63 KB)`.
- `npm audit`: `found 0 vulnerabilities`.
- `package-lock.json`: 0 `resolved` URLs outside `registry.npmjs.org`.
- Core service rebuilt at `013ecfd` (rusqlite 0.40); `node scripts/live-core-check.mjs` → `56/56 checks passed against the live Core service`.
- The staged rename was checked: `vitest.config.mts` added and `vitest.config.ts` deleted in the same commit.
- Secret/path gate: clean (12 files).

**Checklist: PASS.**
