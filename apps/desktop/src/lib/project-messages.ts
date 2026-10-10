/**
 * A3a project-lifecycle messages, VERBATIM from `sandpane-service`
 * (`project_lifecycle.rs`, design 2026-10-09 §3.2 item 8). Core uses shared
 * codes (CONFLICT / VALIDATION_FAILED / NOT_FOUND), so the client tells the
 * cases apart by Core's exact text. `tests/project-lifecycle.test.ts` reads the
 * Rust consts from disk and fails on any drift.
 *
 * Every message here is a refusal Core issues BEFORE changing anything, which
 * is the only reason the copy below may say "nothing was …". Dependency-free so
 * `reducers.ts` (every error surface) and `project-lifecycle.ts` can share it.
 */

export const MSG_PROJECT_ARCHIVED = "project is archived; unarchive it first; nothing was changed";
export const MSG_PROJECT_HAS_TASKS =
  "project has tasks that are not finished; cancel or finish them first; nothing was deleted";
export const MSG_PROJECT_HAS_SANDBOXES = "project has sandboxes; remove them first; nothing was deleted";
export const MSG_PROJECT_CREATE_IN_FLIGHT =
  "a sandbox is being created for this project; try again when it finishes; nothing was deleted";
export const MSG_REPOSITORY_IN_USE =
  "repository is used by a task or sandbox of this project; nothing was removed";
export const MSG_REPOSITORY_REMOVE_WHILE_CREATING =
  "a sandbox is being created for this project; try again when it finishes; nothing was removed";
export const MSG_REPOSITORY_UNREGISTERED_DURING_CREATE =
  "the repository was unregistered from this project while the sandbox was being prepared; nothing was run";
export const MSG_PROJECT_NOT_FOUND = "project not found";
export const MSG_REPOSITORY_NOT_REGISTERED =
  "repository is not registered with this project; nothing was removed";
export const MSG_UPDATE_NEEDS_A_FIELD = "project.update needs name or description; nothing was changed";

/** The Rust const name each message is drift-tested against. */
export const PROJECT_MESSAGE_CONSTS: Readonly<Record<string, string>> = {
  MSG_PROJECT_ARCHIVED,
  MSG_PROJECT_HAS_TASKS,
  MSG_PROJECT_HAS_SANDBOXES,
  MSG_PROJECT_CREATE_IN_FLIGHT,
  MSG_REPOSITORY_IN_USE,
  MSG_REPOSITORY_REMOVE_WHILE_CREATING,
  MSG_REPOSITORY_UNREGISTERED_DURING_CREATE,
  MSG_PROJECT_NOT_FOUND,
  MSG_REPOSITORY_NOT_REGISTERED,
  MSG_UPDATE_NEEDS_A_FIELD,
};

export interface ProjectMessageCopy {
  title: string;
  action: string;
}

/**
 * Copy for one of Core's exact A3a refusals (matched on code AND text), or
 * `null` for anything else — which then gets the generic copy, never a
 * "nothing was …" claim.
 */
export function projectMessageCopy(code: string, message: string): ProjectMessageCopy | null {
  const key = `${code}\u0000${message}`;
  switch (key) {
    case `VALIDATION_FAILED\u0000${MSG_PROJECT_ARCHIVED}`:
      return {
        title: "Nothing was changed — the project is archived",
        action: "Unarchive the project first (Projects → Settings), then try again.",
      };
    case `VALIDATION_FAILED\u0000${MSG_UPDATE_NEEDS_A_FIELD}`:
      return {
        title: "Nothing was changed — no field to update",
        action: "Change the name or the description, then save.",
      };
    case `CONFLICT\u0000${MSG_PROJECT_HAS_TASKS}`:
      return {
        title: "Nothing was deleted — the project has unfinished tasks",
        action: "Cancel or finish its tasks first, then request a new confirmation.",
      };
    case `CONFLICT\u0000${MSG_PROJECT_HAS_SANDBOXES}`:
      return {
        title: "Nothing was deleted — the project still has sandboxes",
        action:
          "Remove its sandboxes first (Sandboxes view); Core never removes a sandbox as a side effect.",
      };
    case `CONFLICT\u0000${MSG_PROJECT_CREATE_IN_FLIGHT}`:
      return {
        title: "Nothing was deleted — a sandbox is being created for this project",
        action: "Wait for the create to finish, then request a new confirmation.",
      };
    case `CONFLICT\u0000${MSG_REPOSITORY_IN_USE}`:
      return {
        title: "Nothing was removed — the repository is in use",
        action: "A task or a live sandbox of this project uses it; finish or remove those first.",
      };
    case `CONFLICT\u0000${MSG_REPOSITORY_REMOVE_WHILE_CREATING}`:
      return {
        title: "Nothing was removed — a sandbox is being created for this project",
        action: "Wait for the create to finish, then try again.",
      };
    case `CONFLICT\u0000${MSG_REPOSITORY_UNREGISTERED_DURING_CREATE}`:
      return {
        title: "Nothing was run — the repository was unregistered while the sandbox was being prepared",
        action: "Re-read the project's repositories, then create the sandbox again if you still want it.",
      };
    case `NOT_FOUND\u0000${MSG_PROJECT_NOT_FOUND}`:
      return {
        title: "Nothing was changed — Core has no project with this id",
        action: "It may have been deleted elsewhere; re-read the project list.",
      };
    case `NOT_FOUND\u0000${MSG_REPOSITORY_NOT_REGISTERED}`:
      return {
        title: "Nothing was removed — the repository is not registered with this project",
        action: "Re-read the project list; the repository may already have been removed.",
      };
    default:
      return null;
  }
}
