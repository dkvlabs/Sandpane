# 0039 — Auto-review record: protocol A8a, sbx daemon status, `execVerified` and `versionCaptured`

- **date:** 2026-10-12
- **implementation commit:** `20829f9` — feat(protocol): sbx daemon status from the text form, execVerified and versionCaptured (A8a) (38 files, +1834/−109)
- **design commit:** `391babc` — docs(plan): A8 and A9 design decisions (§3.8, §3.9)
- **review ran:** every review below ran, and every fix landed, before `20829f9`.

## Scope

This covers A8a, built to [§3.8 of the design of record](../plans/2026-10-09-protocol-v1-additions.md). Item 4 of §3.8 (implementation and review outcome) was added in `20829f9`. A8b (ports) and A8c (policy, template, MCP and secret listings) are **not** implemented: none of their outputs is captured, so they wait for captures C-8 to C-13 (§3.8 item 2).

- **Core:**
  - `sandpane-core/src/sbx.rs`:
    - `SbxCommandBuilder::daemon_status` (argv exactly `["daemon","status"]`);
    - `parse_daemon_status_text` (the §3.8 W8 rule);
    - `CAPTURED_VERSIONS = [0.47.0]` and `version_captured`, drift-tested against the `captured/` directory names;
    - `SbxVersion.pre` (semver pre-release identifier, review fix);
    - the JSON daemon-status parser kept as an unused, tested fallback, its `"stopped"` arm labelled illustrative.
  - `sandpane-core/src/process.rs`: a doc comment only.
  - `sandpane-protocol/src/lib.rs`: optional `SbxStatus.execVerified` and `versionCaptured`; the `a8a_sbx_status_wire_shape` test pins the struct's wire keys against the schema.
  - `sandpane-service/src/lib.rs`: `probe_sbx` runs the text form and returns the parsed version; `system_probe` fills the two fields with the `verification.run` gate's predicate and seam.
  - `sandpane-service/src/verification.rs`: the version gate refuses truncated `sbx version` stdout (review fix, pre-existing A7 gap).
  - Tests: `tests/service_integration.rs` (fake sbx answers the text form; argv pinned; stopped, unclean, truncated and version cases) and `tests/verification.rs` (truncated version output refused).
- **Schemas:** `core-capabilities.schema.json` (`sbx` gains `execVerified` and `versionCaptured`), `schemas/README.md`.
- **Clients:**
  - desktop: tolerant decoding of the two booleans, `foldSbxView` labels and lines, `SbxDetails` in Settings, Sandboxes and the SBX banner, the exec line in the Run panel, the `info` tone instead of `success`, README;
  - VS Code: `sbxStatusView` (pure), a new `sp-sbx` sidebar region shown only while online, the status-bar tooltip, the schema pin;
  - JetBrains: `SbxStatus` fields, `SbxStatusText` (pure), the refresh notification lines, a schema-to-serializer drift test, README gate row.
- **Docs:** `docs/plans/2026-10-09-protocol-v1-additions.md` §3.8 item 4, `docs/compatibility.md` (A8a row), `README.md` (status line and counts).

## Method

- **Design:** `security-reviewer` on the §3.8/§3.9 diff before `391babc`. It returned BLOCK on one Critical, which was in A9 (C1, temp liveness). §3.8 itself drew W8 (parse rule) and I1–I4 and I10. After the C1 text was changed, the same reviewer re-checked C1 only and returned PASS. Both are recorded in `391babc`'s message and in §3.8/§3.9.
- **Core:** a `core-engineer` agent implemented it from a written brief, with test-first steps. A read-only `security-reviewer` then reviewed `git diff -- core schemas`; it ran the targeted sbx, protocol and probe tests.
- **Clients:** `desktop-engineer`, `vscode-engineer` and `jetbrains-engineer` agents worked in parallel from one written brief with the exact strings. A read-only `security-reviewer` then reviewed the client diffs (webview and DOM injection, hostile version strings, honesty wording, decoder tolerance, staleness), ran the targeted client tests and cross-checked against the Core code.
- **Orchestrator:** re-ran every gate, ran the live checks, the invisible-character scan and the secret gate, and removed raw bidi characters from two new test files.
- Wire freeze: not hashed for A8a. The Core wire change (two optional booleans) was settled before the clients were briefed. The only later Core edits were the review fixes, none of which touched the `SbxStatus` wire keys. The `a8a_sbx_status_wire_shape` test and both client schema pins enforce the keys.

## Findings

### Core review (`security-reviewer`): PASS-WITH-WARNINGS

- **W1.** The phrase "Can never disagree" overstated parity between the probe and the gate. They use the same predicate, but each reads `sbx version` separately (environment, working directory, truncation filter, time). It cannot disagree today, because `VERIFIED_EXEC_VERSIONS` is empty. It could once that list has entries. The gate re-reads the version before every exec, so a mismatch is display-only. Locations: `sandpane-service/src/lib.rs` (`system_probe`), `sandpane-protocol/src/lib.rs` (`SbxStatus` doc), and the schema description.
- **W2.** Pre-release versions collapsed to the release. `SbxVersion::parse_token` dropped `-rc.1`, so `0.47.0-rc.1` reported `versionCaptured: true`, and it would later pass `exec_verified`.
- **W3 (pre-existing A7).** The `verification.run` version gate parsed truncated `sbx version` stdout, which breaks the `process.rs` contract.
- **I1.** An unlabelled duplicate of the illustrative JSON `"stopped"` assert.
- **I2.** The `Starting…` preamble guard assumes the auto-start preamble goes to stdout. The capture mixes the streams.
- **I3.** The probe passes Core's full environment to sbx (pre-existing).
- **I4.** The desktop "SBX ready" relabel belonged to the client step.

### Client review (`security-reviewer`): PASS-WITH-WARNINGS

- **W1 (honesty).** The new desktop `daemon_down` banner said Sandpane never starts the daemon and that "Sandboxes will not list until it answers". In fact `useSandboxes()` calls `sandbox.list` → Core `sbx ls --json`, which sbx 0.47.0 was captured auto-starting the daemon (`state/ls_json_autostarts_daemon.txt`).
- **W2.** The daemon line goes stale while Core stays connected. VS Code `loadOnce` probes and then lists. JetBrains renders the connect-time probe under a "refreshed" title.
- **W3.** VS Code showed "SBX daemon state unknown" when Core reported sbx as not installed, while desktop and JetBrains said "not installed".
- **Info:**
  - DOM injection: pass (`textContent`, React text nodes, escaped IntelliJ notifications).
  - Hostile versions: low risk (Core's version charset is `[0-9A-Za-z.-]`).
  - Exact strings and tone: pass.
  - No daemon controls: pass.
  - Stale state while disconnected: pass.
  - Decoder tolerance: pass. JetBrains' strict decode fails closed (pre-existing).
  - The Run panel title with `execVerified === true` does not overclaim.
  - The desktop README "SBX banner" wording was inexact.
  - "List sandboxes: available" stayed green next to "daemon stopped".
- **Core follow-up raised.** Status report §6.1 rule 2 (refuse a listing that might start the daemon when it reads stopped) is not implemented for A1 `sandbox.list`.

### Found by the orchestrator

- **O1.** Raw U+202E (right-to-left override) characters in `clients/jetbrains/.../SbxStatusTextTest.kt` and `clients/vscode/test/sbxStatus.test.ts` (hostile-input fixtures written as literal characters).

## Disposition

| Finding | Disposition |
|---|---|
| Core W1 | **Fixed.** Protocol doc, schema description and code comment now say "the same predicate over the probe's own reading; `verification.run` re-reads the version and is authoritative". Aligning the probe's read context with the gate's is deferred until `VERIFIED_EXEC_VERSIONS` gets its first entry (recorded in §3.8 item 4). |
| Core W2 | **Fixed.** `SbxVersion.pre: Option<String>` (`[A-Za-z0-9.-]`, at most 64 characters; malformed identifiers refused). Equality includes it, so `version_captured` and `exec_verified` are false for a pre-release. Display shows the suffix. Tests cover `-beta`, `-rc.1+abc`, `+abc`, `1.2.3-` and `1.2.3-b@d`. |
| Core W3 | **Fixed.** The gate refuses `stdout_truncated` with `UNSUPPORTED_SBX_VERSION` and the "could not read its version" message. New test `version_gate_refuses_truncated_version_output` (70 KB after a valid version line; only `version` ran, no events). |
| Core I1 | **Fixed.** The duplicate assert was removed. |
| Core I2 | **Accepted, recorded.** The v0.47.0 stopped capture shows that `daemon status` does not auto-start, so nothing is exposed today. The stream question goes to capture C-14. |
| Core I3 | **Accepted (pre-existing).** sbx is the user's located binary. It is revisited with the W1 read-context alignment. |
| Core I4 | **Fixed in the client step** ("SBX daemon running (at last check)", `info` tone). |
| Client W1 | **Fixed.** The banner now reads: "Core read the SBX daemon as stopped at the last check. Sandpane has no control that starts or stops it. Listing sandboxes runs `sbx ls`, which sbx 0.47.0 was captured starting the daemon; use Re-check to read the state again." |
| Client W2 | **Fixed.** All three clients say "SBX daemon running (at last check)" / "SBX daemon stopped (at last check)". JetBrains adds "SBX status is from the connection check, not this refresh". |
| Client W3 | **Fixed.** VS Code `sbxStatusView` gives "Docker SBX not installed" (or "SBX status not reported by this Core") and no daemon, exec or captured lines unless `installed === true`. |
| Client Info: README, badge tone | **Fixed.** "the SBX banner (when one is shown)"; "List sandboxes: available" uses `info` when the daemon reads stopped. |
| Client Info: JetBrains strict decode | **Accepted (pre-existing, fails closed).** |
| Core follow-up: `sandbox.list` may start a stopped daemon | **Deferred to A8c** (recorded in §3.8 item 4). It changes A1 behaviour and needs the stopped-daemon capture C-14. |
| O1 | **Fixed.** Both files now write the character as a backslash-u escape sequence instead of the raw character. Re-ran: VS Code `sbxStatus.test.ts` 25/25; JetBrains gate 493/0. |

No Critical finding was raised against A8a code.

## Verification evidence

All results below are from runs in this session on the final tree, before `20829f9`.

- **Core:** `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` were clean. `cargo test`: 606 passed, 0 failed. That is 596 before A8a, plus 9 from the Core step and 1 from the gate-truncation fix.
- **Schemas:** `make schema-lint schema-drift` passed: JSON syntax OK, 34 methods, 6 features, all value sets in sync. `Method::ALL` is still 34, with no new feature.
- **`make check`:** exit 0. Rust 642 (606 Core + 36 Tauri shell); VS Code 29 files / 850 tests; desktop 24 files passed, 1 skipped / 747 passed, 9 skipped; JetBrains `BUILD SUCCESSFUL`.
- **JetBrains, run alone** after the bidi-escape edit (`./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache`): exit 0; JUnit XML gives 493 tests, 0 failures, 0 errors. The JetBrains agent's `verifyPlugin --offline --rerun-tasks` returned `Compatible` against IU-262.10968.63.
- **Live checks** against an isolated Core (`env -i`, temporary `HOME`, `SANDPANE_SBX_PATH=/nonexistent/sbx`, temporary socket and DB):
  - VS Code `scripts/live-core-check.mjs`: 66/66;
  - desktop `tests/live-core.test.ts`: 9/9;
  - the Core process was killed by exact PID, and `pgrep` found no `sandpane-service` left.
- **Scans:** 0 raw invisible characters in 38 files; secret gate clean (38 staged files). No new dependency.
- **UNVERIFIED:**
  - never run against a real `sbx`; the text-form parse rests only on the v0.47.0 macOS arm64 captures;
  - the running form's exit status and the stopped JSON form are not captured (C-14);
  - no client display shown in a real editor, app or IDE;
  - the desktop Run panel's `execVerified === true` branch has no test (production Core never sends `true`).
