# 0014 — Auto-review record: real sbx v0.47.0 capture (P0)

- **date:** 2026-10-09
- **implementation commit:** `c392530` — test(sbx): capture real sbx v0.47.0 help, state and error fixtures (P0) (79 files, +2797/−3)
- **review ran:** before the commit, on the staged captures, per `audit/README.md`

## Scope

New fixture tree `core/crates/sandpane-core/tests/fixtures/sbx/captured/v0.47.0/` holds 66 help captures, 7 state captures and 4 error captures, plus `_meta.json`. `docs/compatibility.md` was updated to match. No code changed.

## Method

The orchestrator ran an inline checklist pass:

- **Provenance:** each file is raw CLI output from this session. One exception, `errors/ls_not_signed_in_daemon_stopped.txt`, was transcribed from session output and is labeled as such.
- **Sanitization:** `$HOME` and `$SCRATCH` substitution, then a grep for the username and for credential patterns.
- **Validity:** nested help names were checked against each parent's "Available Commands" list.
- **Labeling:** `fixture_status: captured`, version, commit, OS and date are recorded. The illustrative fixtures were left unchanged and labeled.

## Findings

1. **Suggestion (fixed pre-commit): the first capture pass produced bogus files.** zsh does not word-split `$c`, so `sbx "daemon status" --help` printed the root help and was saved as if it were a subcommand capture. Every file byte-identical to `_root.txt` was discarded. The captures were then redone with bash word-splitting from each parent's command list (66 files, 0 invalid).
2. **Warning (recorded): the daemon was started as a side effect.** `sbx ls --json` auto-starts `sandboxd`. The Core's probe must not use `ls` when it needs a side-effect-free check; that is a Core backlog item.
3. **Warning (blocked, user decision): the sandbox CRUD proof is incomplete.** `sbx create` requires `sbx policy init <allow-all|balanced|deny-all>`, a persistent machine-wide network policy. The agent did not choose it. The CRUD success paths and a non-empty `ls --json` remain UNVERIFIED.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| 1 | fixed pre-commit | Invalid captures removed and re-captured |
| 2 | deferred → Core backlog | The probe must use `sbx daemon status --json` (side-effect free; machine-readable output captured) |
| 3 | deferred (user action) | The user runs `sbx policy init …`; the captures are then completed |

## Verification evidence

- `sbx version` → `sbx version: v0.47.0 0411f50ee4700fe7bd37e6e7e3aced563e850ca9`, exit 0.
- `sbx daemon status --json` → `{"status": "running", …}`.
- The `cmp` check against `_root.txt` found 0 invalid help files out of 66.
- `grep -rIl gabriel` over the captures found no username leaks. Credential-pattern hits are documentation placeholders only (e.g. `${api-key}` in `mcp add` examples).
- `python3 -m json.tool _meta.json` passed.

**Docs/fixtures checklist tier, orchestrator inline: 1 fixed, 2 deferred with owners. PASS.**
