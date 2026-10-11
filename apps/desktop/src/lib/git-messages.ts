/**
 * A5 `git.review` / `git.diff` refusals, VERBATIM from Core
 * (`sandpane-service/src/lib.rs`, `sandpane-core/src/git.rs`,
 * `sandpane-core/src/diff.rs`); `tests/git-diff.test.ts` reads the Rust
 * sources and fails on drift. Every refusal here is issued by Core BEFORE it
 * reads any file content, which is the only reason the copy says "nothing was
 * read". Matched on code AND text; anything else gets the generic copy.
 * Dependency-free so `reducers.ts` can use it for every error surface.
 */

export const MSG_WORK_TREE_REDIRECTED =
  "git does not place this task's work tree at its recorded directory (is a repository-local core.worktree set?); nothing was read";
export const MSG_DIFF_PATH_NOT_IN_LIST = "path is not in this task's change list; nothing was read";
export const MSG_DIFF_PATH_LISTED_TWICE =
  "path is listed more than once in this task's change list; pass its status; nothing was read";
export const MSG_DIFF_PATH_NOT_EXACT =
  "this path is not valid UTF-8, so Core cannot name the file exactly; nothing was read";
/** Not a named const in Core: the literal `git.review` / `git.diff` return. */
export const MSG_NO_GIT_CONTEXT = "task has no Git context (repo binding + base_commit)";
/** Not a named const in Core: the literal for a discarded worktree. */
export const MSG_WORKTREE_REMOVED =
  "the task's worktree was removed (discarded); there is nothing left to review";
/** Core's submodule refusal starts with this, then names the paths. */
export const SUBMODULE_REFUSAL_PREFIX = "repository contains submodule(s) ";
/** Core's untracked-read refusals (`{reason}; nothing was read`) end with this. */
export const NOTHING_WAS_READ_SUFFIX = "; nothing was read";

export interface GitMessageCopy {
  title: string;
  action: string;
}

/** Copy for one of Core's exact A5 git refusals, or `null` for anything else. */
export function gitMessageCopy(code: string, message: string): GitMessageCopy | null {
  if (code !== "VALIDATION_FAILED") return null;
  switch (message) {
    case MSG_DIFF_PATH_NOT_IN_LIST:
      return {
        title: "Nothing was read — this path is not in this task's change list",
        action: "The change set may have moved on. Re-read the review, then open the diff again.",
      };
    case MSG_DIFF_PATH_LISTED_TWICE:
      return {
        title: "Nothing was read — this path is listed more than once in this task's change list",
        action: "This build always sends the entry's status; re-read the review and open the entry again.",
      };
    case MSG_DIFF_PATH_NOT_EXACT:
      return {
        title: "Nothing was read — this path is not valid UTF-8",
        action: "Core cannot name the file exactly over the protocol, so it does not show it.",
      };
    case MSG_WORK_TREE_REDIRECTED:
      return {
        title: "Nothing was read — git does not place this task's work tree at its recorded directory",
        action: "A repository-local core.worktree may be set. Core refuses rather than read files outside the task.",
      };
    case MSG_NO_GIT_CONTEXT:
      return {
        title: "Nothing was read — this task has no Git context",
        action: "Core has no repository binding and base commit for this task, so there is nothing to review.",
      };
    case MSG_WORKTREE_REMOVED:
      return {
        title: "Nothing was read — the task's worktree was removed",
        action: "The worktree was discarded; there is nothing left to review.",
      };
  }
  if (message.startsWith(SUBMODULE_REFUSAL_PREFIX)) {
    return {
      title: "Nothing was read — the repository contains submodules",
      action: "Core cannot verify submodule work trees safely, so it refuses instead of showing an incomplete review.",
    };
  }
  if (message.endsWith(NOTHING_WAS_READ_SUFFIX)) {
    return {
      title: "Nothing was read — Core refused to read this file",
      action: "Core's reason is shown below (for example the file changed while it was being read, or it is not a regular file).",
    };
  }
  return null;
}
