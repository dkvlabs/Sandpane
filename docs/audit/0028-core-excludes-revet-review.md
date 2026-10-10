# 0028 — Auto-review record: re-vet the global excludes file on registration

- **date:** 2026-10-10
- **implementation commit:** `ab68c5b` — fix(core): re-vet the global excludes file when repositories are registered
- **review ran:** before the commit — `security-reviewer`, then orchestrator verification. The reviewer's Suggestions 1 and 6 were applied before the commit and the gate re-run.

## Scope

`core/` only:

- `sandpane-core/src/git.rs`: `GitRunner` gains a private one-way revocation flag (`with_excludes_file`, `active_excludes_file`, `revoke_excludes`); `accept_excludes_file` also refuses a file or parent directory writable by group or others.
- `sandpane-service/src/lib.rs`: `revet_excludes_for_new_repositories`, called in `project_create` under the DB lock before the insert transaction; the forbidden-roots query is shared with startup vetting.
- `sandpane-service/tests/task_git_context.rs`: three integration tests.

`sandpane-protocol` and `schemas/` were **not** changed. No client changes.

## Origin

Follow-up to entry 0027. The automated commit review flagged a validator scope mismatch (MEDIUM): the user's global excludes file was checked against registered repositories only at startup. A repository registered later that contains the file (a dotfiles repo) would let an agent with write access there (direct_mount) hide files from the reviews and the host dirty gate of OTHER repositories. The per-call lexical guard only covered the repository git ran in.

## Method

1. **TDD.** The new tests were written first and observed failing: first at compile time (missing API), then behaviourally — `group_or_world_writable_excludes_files_or_directories_are_refused` and `registering_the_repository_that_holds_the_excludes_file_revokes_it_everywhere` both FAILED before the implementation.
2. **Security review** (`security-reviewer`, read-only): **PASS-WITH-NOTES** (no Critical, no Warning). It confirmed:
   - `project_create` is the only production `INSERT INTO repositories`, and there is no UPDATE path;
   - non-test code reads the excludes path only through `active_excludes_file()`, and every production git call goes through `hardened_command`;
   - `extra_config` (appended after the excludes `-c`) only ever carries validated `filter.*` keys;
   - the re-vet runs before any row exists, so no task can target the new repository first; every error path revokes (fail safe);
   - containment compares whole path components on canonical paths, both nesting directions;
   - the integration test discriminates (it would fail without the re-vet).

## Findings and disposition

| # | Finding (severity) | Disposition |
|---|---|---|
| 1 | One-way revocation was a convention: the fields were `pub` (Suggestion) | **Fixed before commit**: both fields private; constructor + accessors only. |
| 2 | Only the immediate parent directory's mode is checked; a writable grandparent without the sticky bit lets another LOCAL USER swap the parent (Suggestion) | **Accepted, recorded.** Not reachable by an agent (it would need write access inside a registered root, which is refused). Owner and macOS ACLs are not checked either. |
| 3 | Linux distros with user-private groups and umask 002 create `~/.config/git/ignore` 0664 or its directory 0775; such users fall back to `/dev/null` with one stderr line (Suggestion) | **Accepted, recorded** (fails safe: more files show as untracked, never fewer). Follow-up: accept group-write when the group is the user's private group, or document it in the install guide. |
| 4 | A transient error at registration (editor atomic save, DB error) revokes until restart (Suggestion) | **Accepted, recorded** (fail safe). Restarting Core re-vets. |
| 5 | Only `project.create` re-vets; a registered root later swapped for a symlink is re-canonicalized at mount time without a re-vet (Suggestion) | **Accepted, recorded.** Needs write access to the root's parent, the user's own tree. Re-vet on mount is a follow-up for the A3 `project.addRepository` work. |
| 6 | No integration test for the realistic symlinked dotfiles layout (Suggestion) | **Fixed before commit**: `a_symlinked_excludes_file_is_revoked_when_its_target_repository_is_registered`. |

## Verification evidence (fresh, after the last edit)

- `cargo fmt --check`: clean.
- `cargo clippy --all-targets -- -D warnings`: `Finished` with no warnings.
- `cargo test`: suites `125, 3, 13, 19, 35, 19` passed, 0 failed (214 tests).
- `make schema-drift`: `All schema/protocol value sets in sync.`
- Secret/path gate on the staged diff: clean (3 files). One false positive (a fictional home-directory path in a test) was renamed to `/opt/sandpane-test/...` before the commit.
