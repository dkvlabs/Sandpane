# 0019 — Auto-review record: Core review fixes (F1)

- **date:** 2026-10-09
- **implementation commit:** `bb5cc8f` — fix(core): security and correctness fixes from the review (F1)
- **review ran:** before the commit, in two rounds

## Scope

`core/**`: sandpane-core (git, sbx, process, validation, task, db, events, scheduler) and sandpane-service (lib, main, runtime, tests). The `sandpane-protocol` crate and `schemas/` were not changed.

## Method

1. **Discovery reviews, read-only, at `81f4841`:**
   - the Core review (bugs 1–10 and backlog);
   - the whole-repository security review (W1–W3, W5, S2–S4, S7, S8).
2. **Fix batch** by the `core-engineer` agent, using the real sbx v0.47.0 captures from entries 0014/0015.
3. **Independent security re-review** of the fix diff. Verdict: PASS-WITH-WARNINGS.
   - The reviewer built working proof-of-concept repositories for two bypasses of the new git hardening:
     - **W-1:** a promisor lazy fetch through a repo-chosen `core.sshCommand`;
     - **W-2:** a submodule's own clean filter.
   - It also raised suggestions S-a to S-g.
4. **Follow-up batch.**
   - Each bypass got a regression test rebuilt from the PoC.
   - A control step proves the trap fires with plain git.
   - The test failed before the fix and passes after.
5. **Orchestrator checks:** re-ran every gate fresh, rebuilt the service, and ran the VS Code live client check against it.

## Findings and disposition

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| Core 1 | Critical (rule 3) | `awaiting_input`/`verifying` were never reconciled after a restart | **Fixed.** Exhaustive per-state test generated from `TaskStatus` |
| Core 2 / sec W2 | Critical | Host git ran repo-configured programs (fsmonitor, hooks, ext-diff, textconv, filters) and inherited `GIT_*` | **Fixed.** Scrubbed env + `-c` overrides; trap tests |
| Core 3 | Critical | sbx argv did not match the real CLI | **Fixed.** Real argv, `--clone`, `rm --force`, sbx name rules, `host_worktree` refused until implemented |
| Core 4–5 | High | Version parse failed on the real string; misclassified errors; probe never ran | **Fixed.** Parse tested on the captured string; classification tested on captured stderr; probe via `daemon status --json` |
| Core 6 / sec W5, S2, S3, S7 | High | Socket/data dir permissions chmodded `$HOME`; stale socket TOCTOU; no peer check; unbounded connections | **Fixed.** `<state>/sandpane`, flock, peer uid, idle timeout, cap 64 |
| Core 7–8 | Medium | Scheduler not idempotent; event sequences reused after pruning | **Fixed.** Migration v2 adds a high-water mark |
| Core 9 | Medium (rule 5) | `conversation.send` returned a provider-auth code | **Fixed.** `PERMISSION_DENIED`: no verified adapter |
| sec W1 | Warning (reachable) | `project.create` accepted any absolute path, so `$HOME` could be live-mounted | **Fixed.** Canonical git root, denylist, and mount must **equal** a registered root (S-g) |
| sec W3 | Warning | Base commit checked by prefix | **Fixed.** Exact OID compare |
| sec S4, S8 | Suggestion | Docs overstated symlink resolution; resolved sbx path not surfaced | **Fixed.** Doc corrected; resolved path logged and probed |
| Re-review W-1 | Warning | Lazy fetch through `core.sshCommand` | **Fixed.** `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=none`. `-c protocol.allow=never` was shown insufficient on this host |
| Re-review W-2 | Warning | Submodule filter driver | **Fixed.** `--ignore-submodules=dirty`, `submodule.recurse=false`, `core.attributesFile=/dev/null`, `GIT_ATTR_SOURCE`=empty tree |
| S-a…S-g | Suggestion | Control runs prove every trap fires; paths with spaces; create-timeout orphan; read errors; daemon autostart note; panic-safe slots; equal-root mounts | **All addressed**, each with a test (S-e is a comment) |

## Residual risk (documented in code)

- `$GIT_DIR/info/attributes` cannot be disabled by any git setting. A `direct_mount` agent racing a review could still get a filter run, if it also writes `.git/config` inside the window.
- Ignoring worktree attributes means LFS and line-ending-normalized files compare raw. A review can over-report changes, never under-report them.
- **Client-visible behaviour change:** a subdirectory of a registered repository can no longer be mounted.
- **Still UNVERIFIED:**
  - Codex/agent execution in a sandbox (needs provider sign-in);
  - Windows/Linux runtime;
  - the service rebuilt here ran only against the VS Code live check and the test suite.

## Verification evidence (orchestrator, fresh, before the commit)

- `cargo fmt --check`: clean.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `cargo test`:
  - sandpane_core 85;
  - lifecycle_integration 3;
  - sandpane_protocol 13;
  - service lib 19;
  - service_integration 34;
  - 0 failed.
- `make schema-drift`: "All schema/protocol value sets in sync."
- After the commit, the service was rebuilt and `clients/vscode/scripts/live-core-check.mjs` reported `56/56 checks passed against the live Core service`. Core logged `sbx resolved to /opt/homebrew/bin/sbx (via PATH)`.
- Secret/path gate: clean (18 files).

**Two-round review: PASS-WITH-WARNINGS → warnings fixed, residual documented. PASS.**
