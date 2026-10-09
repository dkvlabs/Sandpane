# 0011 — Auto-review record: VS Code .vsix packaging + local installation guide (P3)

- **date:** 2026-10-09
- **implementation commit:** `a725b52` — feat(clients/vscode): package .vsix via vsce + local installation guide (P3) (8 files, +1,973/−2)
- **review ran:** before the commit, on the same working-tree diff, per `audit/README.md`

## Scope

Small tooling/docs change: `clients/vscode/package.json` (repository/bugs metadata, `package` script, `@vscode/vsce` devDependency; `package-lock.json` follows), new `clients/vscode/.vscodeignore`, `clients/vscode/LICENSE` (copy of the repo-root MIT file, shipped inside the package), new `clients/vscode/INSTALL.md`, `clients/vscode/README.md` build/test block + pointer, `docs/compatibility.md` row for `@vscode/vsce` 4.0.0, root `.gitignore` (`clients/vscode/*.vsix` artifact exclusion).

## Method

Docs/tooling checklist tier per the `sandpane-changelog` skill (the change ships no protocol, IPC, credential, Git-apply or webview code). Checklist walked by the orchestrator inline (subagent dispatch still unavailable in this session — same harness reasoning-level error as entry 0010; recorded there):

- Manifest correctness vs the real packager (vsce accepted the manifest; artifact produced).
- Package contents audit against leaks (sources, tests, tooling, source maps, session-artifact dirs).
- Honesty pass on every new claim in INSTALL.md/README/compatibility (each claim traced to a command run or a source line).
- Licensing (AGENTS.md rule 10): no third-party binaries, MIT shipped, zero runtime deps claim verified against `package.json`.

## Findings

1. **Fixed pre-commit (found during packaging):** the first `.vsix` build leaked `extension/.gitignore` and `extension/.mimosa/hook-state/…` (session-artifact dir created by the environment's commit-gate tooling inside the extension folder) into the package. Both added to `.vscodeignore`; repackaged and re-verified — `unzip -l | grep -cE 'mimosa|gitignore'` → **0**, 28 files.
2. **No Critical findings, no Warning findings.** Rules 1–10 spot-checks: no subprocess changes at all; no protocol/schema files touched; no claims without evidence (install command syntax is the standard VS Code CLI/UI; socket-path resolution traced to `default_socket_path()` in `sandpane-service/src/lib.rs:1514`; "55 checks" matches this session's fresh `check:live` run; NOT_INSTALLED behavior matches the live harness output).

## Disposition

| # | Disposition | Reason |
|---|---|---|
| 1 | fixed pre-commit | `.vscodeignore` extended; artifact rebuilt and contents re-verified clean |
| 2 | n/a | No Critical/Warning findings to disposition |

## Verification evidence

- `npm install` + `npm run package` in `clients/vscode` → `DONE Packaged: sandpane-0.0.1.vsix (28 files, 77.21 KB)` with `@vscode/vsce` 4.0.0 (fresh install this session).
- `unzip -l sandpane-0.0.1.vsix` → 28 files: `out/**` (extension + webview JS), `media/` (icon + css), manifest, `LICENSE.txt`, `readme.md`; **0** matches for `mimosa|gitignore` after the fix (first build had 2 — finding #1).
- `npm test` after the manifest/metadata changes → **171 passed / 12 files, 0 failed** (same count as entry 0010's run — no behavioral change).
- `npx vsce --version` → 4.0.0.

**Checklist pass (docs/tooling tier, orchestrator inline — subagents unavailable) — 1 finding fixed pre-commit; no Critical findings. PASS.**
