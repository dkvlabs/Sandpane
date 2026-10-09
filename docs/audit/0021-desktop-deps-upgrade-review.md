# 0021 — Auto-review record: desktop dependency upgrade (U3)

- **date:** 2026-10-09
- **implementation commit:** `8b45a9c` — build(desktop): upgrade to React 19.3, Vite 8.3, Vitest 5, TypeScript 7, Tauri 2.12 (U3)
- **review ran:** before the commit (checklist, orchestrator)

## Scope

- `apps/desktop/package.json`
- `apps/desktop/package-lock.json` (regenerated)
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src/components/ui/primitives.tsx`
- `docs/compatibility.md`

## Method

The orchestrator ran a dependency-upgrade checklist against the agent's report and re-ran every gate fresh.

- **Versions:**
  - Each version was confirmed against its registry (`npm view`, crates.io).
  - Pre-releases were not taken: tauri 3.0.0-alpha, libc 1.0.0-alpha.
- **Migration guides consulted through ctx7:**
  - TypeScript 7: the "Removed in TS7" option list.
  - Vite 8: `migration.md`.
  - `@vitejs/plugin-react` 6: Babel replaced by Oxc.
  - Vitest 5: migration.
  - React 19: upgrade guide.
  - Tauri: "updating dependencies".
- **Config check:** each config was checked against the removals. None of the removed options were in use, so the only source change is React 19 ref-as-a-prop in `TextInput`.
- **Lockfile provenance:** all 105 `resolved` URLs point to `https://registry.npmjs.org`, with zero other hosts. Native optional bindings are kept for all platforms, so CI on Linux still resolves. `npm install-scripts ls` reports no unreviewed install scripts.
- **TS 7 actually type-checks:** the agent planted a type error, saw TS2322 / exit 1, then removed it.

## Findings

1. **Note: `@types/node` went from 26.x down to 24.19.1.** This is deliberate: the types now match the Node 24 runtime instead of advertising Node 26 APIs.
2. **Note: `rust-version` was understated.** It said 1.85, but tauri 2.12 itself requires 1.90. Corrected to 1.90.
3. **Note: transitive holds.** thiserror 1.0.69 and toml 0.8.2 are held by the Linux GTK stack (wry/gtk/system-deps). They cannot be raised from this crate.
4. **Residual (UNVERIFIED):**
   - Native `tauri dev`/`tauri build` were not run.
   - React 19 rendering against a live Core was not exercised; the tests are node-only.
   - HMR under Oxc was not exercised.

## Disposition

All notes accepted; no Critical findings.

## Verification evidence (orchestrator, fresh)

- `make desktop-check` exit 0:
  - `Tests 273 passed | 8 skipped (281)`;
  - `test result: ok. 31 passed`.
- `npm run build` → `✓ built in 192ms`.
- `npm audit --omit=dev` → `found 0 vulnerabilities`.
- `npx tsc --version` → `Version 7.0.2`.
- Secret/path gate clean (5 files).

**Checklist: PASS.**
