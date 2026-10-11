# 0036 — Auto-review record: protocol A5, `git.diff` and exact change lists

- **date:** 2026-10-11
- **implementation commits:**
  - `10c5f18` — feat(protocol): git.diff and exact change lists (A5, WIP — client review fixes in progress) (67 files, +6842/−282)
  - `394709e` — fix(clients): A5 git.diff client review fixes (24 files)
- **review ran:** the Core review ran before `10c5f18`. The combined client review also ran before `10c5f18`, but its fixes landed in `394709e`. See "Commit sequencing" below.

## Scope

This covers the whole A5 addition, built to [§3.5 of the design of record](../plans/2026-10-09-protocol-v1-additions.md). The §3.5 "Implementation decisions" block was added in `10c5f18`.

- **Core:**
  - `sandpane-protocol`: `GitDiffParams` / `GitDiffResult`, `FileChange.oldPath?`, `ChangeSet.repoPath?` / `uninspected?`, and `git.diff` in `Method::ALL` right after `git.review`. That makes **28 methods**. Features are unchanged at 4.
  - `sandpane-core`:
    - `git.rs`: `change_list` runs with `-z --find-renames`, so paths are exact; a pinned `--work-tree`; `confirm_work_tree`; a pinned patch shape; `LiteralPathspec::from_change`; capped error excerpts.
    - New `diff.rs`: race-safe untracked reads, and synthesized untracked patches that include `diff --git` and `new file mode` lines.
  - `sandpane-service`: the `git.diff` handler. The path is gated on the task's change list, `status` disambiguates a path listed twice, and `maxBytes` is clamped to 1..=524 288. New `tests/git_diff.rs`.
- **Schemas:** `rpc-request.schema.json`, `change-set.schema.json`, `schemas/README.md`.
- **Clients** (VS Code, desktop, JetBrains):
  - typed `git.diff` wrappers and the 28-method pins;
  - the 45 s git deadline for `git.review` and `git.diff` (the desktop proxy uses 43 s);
  - per-file read-only diff views: a VS Code virtual document, a desktop `<pre>` as React text, a JetBrains read-only dialog;
  - disclosures for binary, truncated, lossy, rename and symlink patches;
  - honest copy for every exact refusal.
- **Docs:** design §3.5, `docs/specs/02_ARCHITECTURE_AND_DATA.md` (contract lines and the v7 tasks columns), the root and client READMEs.

## Method

1. Core and schema were reviewed by one `security-reviewer` pass on the Core diff. It reproduced findings end to end through the real `sandpane-service` from a scratch probe crate, and returned **BLOCK**.
2. The Core fixes were made test-first with RED evidence and mutation runs. The same reviewer then re-verified C1 as PASS: the probe repro showed `LEAK=false`, and `hostDirty` was true again.
3. Core was frozen and the three clients were briefed from one shared document (`a5-client-brief.md`).
4. One combined `security-reviewer` / phase pass covered all three clients and returned **PASS-WITH-WARNINGS**.
5. Its fixes were dispatched per client.
   - That fix pass was interrupted twice: first by a usage limit, then by a network error.
   - The user asked to commit the tree in between, which produced the WIP commit `10c5f18`.
   - The agents resumed and checked their state against the committed tree; none of their earlier edits had reached disk.
   - Every item was then fixed test-first, with RED evidence where applicable.
6. The orchestrator re-ran every gate fresh on the final tree.

### Commit sequencing (deviation)

AGENTS.md asks for review findings to be fixed before the implementation commit. Here the client review fixes landed one commit later, in `394709e`, because the user explicitly asked to commit the in-progress tree. `10c5f18` is labelled WIP / UNVERIFIED in its message and lists the open items. No gate was claimed for it. The gates below were run on `394709e`.

## Findings

**Core review: BLOCK.**

- **C1 (Critical):** a repository-local `core.worktree` made tracked `git.diff` read file content outside the review target. With an agent-staged name and `core.worktree` pointing at a directory outside the repo, the real Core returned that outside file's content in the patch. `-c core.worktree=` does not override this; `--work-tree` does.
- **W-pre (pre-existing, same root cause):** `is_dirty`, and therefore `ChangeSet.hostDirty` and the apply preconditions, could be made to report a dirty host as clean.
- **W1 (Warning):** the patch shape followed user and repo `diff.*` config. With `diff.noprefix`, headers had no `a/`/`b/` prefixes, and a file named `-p` became ambiguous.
- **Info:**
  - **I1:** `LiteralPathspec::new` was public, so a future caller could wrap client input.
  - **I2:** a path listed twice (`deleted` + `untracked`) could not be chosen.
  - **I3:** parser errors could echo up to 4 MiB of stdout.
  - **I4:** a device node was opened before its type check.
  - **I5:** hardlinks, bind mounts and the root open — acceptable as is.
  - **I6:** repository attributes can hide content behind `binary: true`.
  - **I7:** the synthesized symlink patch had no `new file mode 120000`, and a vanished file was reported as INTERNAL.
- **Verified OK:**
  - no shell;
  - pathspecs are always `:(literal)`, after `--`, on a separate argv channel; hostile names (`:(glob)*`, `:!a.txt`, `-p`, `--output=x`) each produced a one-file patch and created no file;
  - newline names are diffed exactly;
  - `cargo test`, clippy, `schema-lint` and `schema-drift` were clean (28 methods).

**Combined client review: PASS-WITH-WARNINGS, no Critical.**

- **VS Code:**
  - **W1:** a typechange or multi-line link target could forge or truncate the `symlink → target` line.
  - **W2:** `$(icon)` injection in QuickPick labels.
  - **W5:** INTERNAL got generic copy.
  - **W6:** a stale 27-method comment.
  - **I1:** the `git.apply` `selectedFiles` validator was stricter than Core.
  - **I7:** unrevealed paths in the `confirmRepoRoot` modal.
- **Desktop:**
  - **W1:** same symlink issue.
  - **W4:** a lost answer to a read said both "no file was changed" and the proxy's "may have been applied".
  - **W6:** stale README count.
  - **I2:** the per-line cap applied per tab segment.
  - **I4:** the git refusal copy matched on every method.
  - **I5:** the Copy note lacked the hidden-character count and the never-apply warning.
- **JetBrains:**
  - **W3:** the patch view folded CRLF into a plain newline, which hid the carriage returns.
  - **I3:** the review resolved against the first VCS root instead of the one matching `repoPath`.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| C1, W-pre | fixed pre-commit (`10c5f18`) | Every git call pins `--work-tree=<cwd>` as a global option. `show_toplevel` runs unpinned as the detector, and `confirm_work_tree` refuses with `MSG_WORK_TREE_REDIRECTED`: "…is a repository-local core.worktree set?; nothing was read". A regression test models the probe. The reviewer re-verified: `LEAK=false`, `hostDirty` true. |
| W1 (Core) | fixed pre-commit | `--src-prefix=a/ --dst-prefix=b/ -U3` are pinned, and the oracle test was updated. |
| I1–I4, I7 (Core) | fixed pre-commit | I1: `LiteralPathspec::from_change`. I2: the optional `status` param; without it, a path listed twice is refused. I3: excerpts are capped. I4: `fstatat`, then `openat(O_NOFOLLOW\|O_NONBLOCK)`, then an `st_dev`/`st_ino` check. I7: `new file mode` lines in synthesized patches. |
| I5, I6 (Core) | accepted / disclosed | I5 needs host privileges or names already reachable. I6 is a documented residual; every client words `binary` as "treated as binary (possibly by repository attributes) — no text diff shown". |
| VS Code W1, W2, W5, W6, I1, I7 | fixed (`394709e`) | W1: the symlink line follows the JetBrains rule: untracked, `new file mode 120000` on line 2, exactly `@@ -0,0 +1 @@`, exactly one `+` line, and not binary or truncated. W2: `$(` is broken visibly. W5: `DIFF_INTERNAL_COPY` / `REVIEW_INTERNAL_COPY`, never echoing Core. W6: the count is 28. I1: the validator refuses only empty or NUL. I7: values pass through `plainText`. Nine tests, all RED first. |
| Desktop W1, W4, W6, I2, I4, I5 | fixed (`394709e`) | W4: the proxy gets an `is_read_only` exhaustive match, separate from `replay_safe` (`git.diff` stays non-replay-safe). Reads never get the "may have been applied" suffix, the suffix constant is drift-tested across Rust and TS, and `diffFailureCopy` strips it. I4: `CoreRequestError.method` scopes the copy. The others are as described. RED for each, except the typechange case (a regression guard: the old code already returned null there). |
| JetBrains W3, I3 | fixed (`394709e`) | W3: each line is revealed separately, so a CR shows as `\r`, and CRLF patches get a count disclosure. I3: `ReviewRoots.choose` uses an exact canonical match. On a mismatch, or when `repoPath` is absent, it warns visibly and resolves nothing; it never falls back to `basePath`. The 5 `ReviewRootTest` cases were RED first. The symlink rule has new negative cases, each confirmed by mutation. |

## Verification evidence

The orchestrator ran all of the following fresh on `394709e`'s tree before committing it:

- **`make check`** (`make-check-a5.log`): exit 0.
  - Rust: 455 tests passed, 0 failed (Core 422 plus the Tauri shell's 33).
  - Schemas: both method checks report `28 values match`, features report `4 values match`, and `All schema/protocol value sets in sync.`
  - VS Code: `Tests 641 passed (641)`.
  - Desktop: `Tests 614 passed | 8 skipped (622)`.
  - JetBrains: `BUILD SUCCESSFUL`.
- **JetBrains, run alone:**
  - `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` → 37 result files, **410 tests, 0 failures, 0 errors, 0 skipped**.
  - `verifyPlugin --offline --rerun-tasks` → `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`.
- **Live checks** against an isolated Core (`env -i`, a temporary `HOME`, `SANDPANE_SBX_PATH=/nonexistent/sbx`, a temporary socket and DB that were removed afterwards):
  - VS Code: `62/62 checks passed against the live Core service`.
  - Desktop: `Tests 8 passed (8)`.
  - The first desktop attempt skipped all 8 tests, because the socket path under the scratchpad exceeded the macOS socket path limit and Core never came up. The re-run used a short `/tmp` path.
  - Core stderr: "sbx executable not found". `pgrep` showed no leftover Core process.
  - Over the wire, `git.diff` can only answer "task has no Git context". That is what the live scripts check.
- **Hidden characters and secrets:**
  - `invisible-scan`: 0 raw invisible characters in the 24 staged files of `394709e`.
  - Secret gate: clean on `394709e`.
  - On `10c5f18`, the gate flagged only a fictional home-directory fixture path for the Atlas Demo project in two test lines. It was accepted after a grep found no real home path, username or scratch path in the staged diff.
- **Not run:**
  - anything against a real `sbx`;
  - any client in a real editor, app or IDE (the patch views, the quick pick, the JetBrains root warning, the desktop `ReviewPanel` Copy-note wiring);
  - a `git.diff` that returns a real patch over the wire (no wire-created task has Git context until A4b);
  - `cargo-audit` / `cargo-deny` (not installed; no new dependencies).

**Reviews:**
- `security-reviewer` on Core: BLOCK. C1 fixed and re-verified PASS; W1 and I1–I4, I7 fixed; I5 and I6 accepted or disclosed.
- Combined client pass: PASS-WITH-WARNINGS. Every dispatched Warning and Info item was fixed in `394709e`.

No Critical remains.
