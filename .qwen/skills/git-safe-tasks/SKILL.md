---
name: git-safe-tasks
description: Use when implementing or reviewing task workspace isolation, Git worktree/clone/branch assignment, diff generation, change application/merge flows, dirty-host-state handling, or anything that writes to a user's repository.
---

# Git-safe task rules

From `docs/specs/02_ARCHITECTURE_AND_DATA.md` §7 and `docs/specs/06_SECURITY_AND_LICENSING.md` §6. The user's repository is sacred: Sandpane never overwrites uncommitted work, never applies silently, never races two writers on one tree.

## Workspace modes (store per task: `repository_id`, `base_commit`, `task_branch`, `workspace_mode`, `sandbox_name`, `integration_status`)

| Mode | Semantics | Obligations |
|---|---|---|
| `direct_mount` | Host tree writable immediately | Prominent live-writable label; review CANNOT retroactively block edits; never claim "safely pending" |
| `sbx_clone` | Separate sandbox worktree | Verify Git access, base branch, fetch/merge behavior, untracked/secret exposure; not "total secret isolation" |
| `host_worktree` | Independent host dir/branch | Valid only if mount + sandbox selection explicitly match that worktree |
| `mountless` | Scratch, no host access | No automatic project access; say so in UI |

## Before executing a task

1. Check repo identity, base commit, branch, dirty status, intended mode. Snapshot **metadata**, not sensitive contents.
2. Allocate a unique branch/worktree/sandbox binding per independent writable task.
3. **One active writer per writable workspace** (Core scheduler lock); read-only conversations may share. Two writers on one directory → queue the second, never race.
4. Keep untracked files and secrets out of patches by default; ask before including.

## Before integrating changes

1. Re-check host branch + dirty state against recorded `base_commit`; abort cleanly on divergence — no partial destructive side effects.
2. Generate the **actual** diff: added/deleted/renamed/untracked, against the task base revision.
3. Apply only via explicit Git operations (merge/cherry-pick/patch) with conflict detection — never a silent file overwrite.
4. Explicit user approval per apply; commit/PR only on request.
5. Preserve task artifacts and branch references until the user decides cleanup; deleting a task environment ≠ deleting a project/repository.

## Git invocations

Same discipline as SBX: fixed executable + argument vectors via `sandpane_core::git`, strict ref/branch-name validation, bounded output, canonicalized paths (symlink/TOCTOU aware), no shell.

## Common mistakes

| Mistake | Fix |
|---|---|
| Applying a patch onto a dirty host tree | Dirty/base-divergence check gates every apply |
| Two tasks writing one worktree "because both are small" | Writer lock is unconditional |
| Reporting direct-mount edits as "pending review" | Label live-writable; review is post-hoc there |
| Including `.env`/untracked secrets in a diff by default | Excluded by default; explicit opt-in only |
| Treating cancel == stop sandbox == close tab == archive == delete | Five distinct operations with distinct confirmations |
