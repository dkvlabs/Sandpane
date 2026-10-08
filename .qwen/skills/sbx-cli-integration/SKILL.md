---
name: sbx-cli-integration
description: Use when writing or reviewing code that invokes the Docker Sandboxes CLI (sbx) — sandbox create/list/start/stop/delete, network policies, ports, templates, MCP, secrets, SSH setup — or when capturing SBX fixtures, parsing SBX output, or handling SBX-absent/daemon-down environments.
---

# SBX CLI integration rules

From `docs/specs/02_ARCHITECTURE_AND_DATA.md` §5 and `docs/specs/06_SECURITY_AND_LICENSING.md` §2/§4. SBX is a third-party, separately-installed, separately-licensed tool; Sandpane wraps only its **documented public CLI**.

## Iron rules

1. **Typed argument vectors only.** `std::process::Command::new(program).arg(...)` — never `sh -c`, never string-built command lines. Untrusted values (sandbox names, paths, refs, ports) pass validation (`sandpane_core::validation`) before entering any argument.
2. **Never bundle, download, or auto-install `sbx`.** Locate a trusted binary (PATH/user override with confirmation); never trust a repo-local `sbx` executable or one named by an agent.
3. **Re-query after mutations.** Command exit 0 ≠ desired state. List/inspect after create/start/stop/delete and reconcile; SBX owns sandbox truth, Sandpane stores bindings.
4. **Capability-gate everything version-sensitive.** Probe version, compare against the tested matrix in `docs/compatibility.md`; unsupported → structured `UNSUPPORTED_SBX_VERSION`, not optimistic parsing.
5. **Bounded subprocesses:** timeouts, output caps, process-tree cleanup; no orphaned children on cancel.
6. **Destructive operations** (delete, reset) require explicit user confirmation server-side even if the UI already confirmed; never delete a sandbox created outside Sandpane without explicit confirmation; `reset` stays out of routine troubleshooting UI.
7. **Structured errors** map to protocol codes: `NOT_INSTALLED`, `DAEMON_DOWN`, `UNSUPPORTED_SBX_VERSION`, `CONFLICT`, `PERMISSION_DENIED`, `VALIDATION_FAILED`.

## Fixtures

- Tests run against fixtures in `core/crates/sandpane-core/tests/fixtures/sbx/`.
- Hand-written fixtures are **illustrative** and must carry `"fixture_status": "illustrative"` in `_meta.json` until replaced by sanitized captures from a real CLI (P0 task), which carry `"fixture_status": "captured"` plus exact `sbx_version`, OS, and capture date.
- Never invent output fields or statuses; the moment a real capture exists, it wins and the compatibility matrix records its version.

## Machine-readable output

Prefer official machine-readable flags (e.g. `--format json`) **only when documented for the pinned version** and proven by a captured fixture. Fallback text parsing must be version-gated, minimal, and fail loudly into `VALIDATION_FAILED` rather than guessing.

## Secrets & network

- Secrets: presence/status metadata only; values never read back, displayed, stored, or logged. Add/remove only via documented commands.
- Network policy writes and port publishing: default loopback; warn before permissive rules; show the **effective** policy read back from SBX, not the requested one.
- SSH/native-app flows follow `docs/specs/05_DESKTOP_APP.md` §3.E: guide with documented steps (`sbx setup ssh`), verify hostname, warn on credential forwarding, launch apps only via documented OS mechanisms, never edit proprietary app config or claim history sync.

## Common mistakes

| Mistake | Fix |
|---|---|
| Assuming exit 0 means the sandbox is running | Re-query and reconcile state |
| Parsing human text as if it were a stable API | Version-gate; prefer documented machine formats; fail loudly |
| Passing a user string straight into an argument | Validate against the allowlist patterns first |
| Treating illustrative fixtures as proof of real CLI behavior | Label them; record the P0 capture task |
