/**
 * A3a project lifecycle on the desktop (design 2026-10-09 §3.2): rename and
 * description, archive / unarchive, the "show archived" filter, repository
 * add / remove, and delete through the A1 two-step confirmation pattern.
 *
 * Pure logic only (no React, no DOM), so the node-only vitest suites prove
 * what is sent, when, and how often. Core stays the authority on every
 * outcome; nothing here decides a project's state on Core's behalf.
 */

import {
  asCoreRequestError,
  coreErrorCode,
  type CoreClient,
  type CoreRequestError,
} from "./core-client";
import {
  coreAdvertisesMethod,
  type ConfirmationRequest,
  type ConfirmationTarget,
  type CoreCapabilities,
  type Project,
  type ProjectLifecycleMethod,
} from "./protocol";
import { MSG_PROJECT_ARCHIVED } from "./project-messages";
import { describeCoreError, displayRevealed, featureGate, type FeatureGate } from "./reducers";
import {
  MAX_CORE_MESSAGE_CHARS,
  isExpired,
  parseExpiry,
  type FailureCopy,
} from "./sandbox-lifecycle";
import { validateProjectDescription, validateProjectName } from "./wizard";

// ---------------------------------------------------------------------------
// Gating on `system.probe`
// ---------------------------------------------------------------------------

export interface ProjectLifecycleGates {
  update: FeatureGate;
  archive: FeatureGate;
  unarchive: FeatureGate;
  delete: FeatureGate;
  addRepository: FeatureGate;
  removeRepository: FeatureGate;
  /**
   * `project.list {includeArchived}` exists exactly on a Core that has the A3a
   * methods; an older Core is never sent the field (it has nothing archived).
   */
  showArchived: FeatureGate;
}

const UNSUPPORTED: Record<ProjectLifecycleMethod, string> = {
  "project.update": "Rename and description edits are not supported by this Core.",
  "project.archive": "Archiving is not supported by this Core.",
  "project.unarchive": "Unarchiving is not supported by this Core.",
  "project.delete": "Deleting projects is not supported by this Core.",
  "project.add_repository": "Adding a repository to an existing project is not supported by this Core.",
  "project.remove_repository": "Removing a repository from a project is not supported by this Core.",
};

/**
 * Availability of each A3a action for THIS Core. `null` capabilities = the
 * probe has not answered: every control is "not probed yet", never optimistic.
 */
export function projectLifecycleGates(
  capabilities: Pick<CoreCapabilities, "methods"> | null,
): ProjectLifecycleGates {
  const gate = (method: ProjectLifecycleMethod): FeatureGate =>
    featureGate(
      capabilities === null ? null : coreAdvertisesMethod(capabilities, method),
      `\`${method}\``,
      `This Core does not advertise \`${method}\`. ${UNSUPPORTED[method]} Upgrade Core to use it from Sandpane.`,
    );
  const archive = gate("project.archive");
  return {
    update: gate("project.update"),
    archive,
    unarchive: gate("project.unarchive"),
    delete: gate("project.delete"),
    addRepository: gate("project.add_repository"),
    removeRepository: gate("project.remove_repository"),
    showArchived:
      archive.state === "supported"
        ? { state: "supported", note: "Archived projects are listed with `includeArchived: true`." }
        : archive.state === "unprobed"
          ? archive
          : {
              state: "unsupported",
              note: "This Core has no archived projects to show: it does not advertise `project.archive`.",
            },
  };
}

/** True when Core reports the project archived (`archivedAt` present). */
export function isArchived(project: Pick<Project, "archivedAt">): boolean {
  return project.archivedAt !== undefined;
}

/**
 * The reason an action is disabled on an ARCHIVED project, or `null`. Core
 * refuses `project.update`, both repository methods, `conversation.create`,
 * `conversation.send` and `sandbox.create` while archived (its exact message
 * is quoted); unarchive and delete stay allowed, and so does every read.
 */
export function archivedBlock(
  project: Pick<Project, "archivedAt">,
  action:
    | "update"
    | "addRepository"
    | "removeRepository"
    | "chat"
    | "sandbox"
    | "unarchive"
    | "delete"
    | "archive",
): string | null {
  if (!isArchived(project)) return null;
  if (action === "unarchive" || action === "delete" || action === "archive") return null;
  return `Archived — Core refuses this until the project is unarchived ("${MSG_PROJECT_ARCHIVED}").`;
}

/** The archived label shown on a row: Core's instant, revealed and capped. */
export function archivedLabel(project: Pick<Project, "archivedAt">): string | null {
  if (project.archivedAt === undefined) return null;
  return `archived ${displayRevealed(project.archivedAt, 64).text}`;
}

// ---------------------------------------------------------------------------
// Settings draft → `project.update` changes
// ---------------------------------------------------------------------------

export interface ProjectSettingsDraft {
  name: string;
  description: string;
}

export interface ProjectUpdatePlan {
  /** Only the changed fields; `null` when nothing changed. */
  changes: { name?: string; description?: string } | null;
  nameError: string | null;
  descriptionError: string | null;
}

/**
 * Which fields a Save would send. Only a CHANGED field is sent (Core refuses
 * an update with neither), and each changed field is checked with Core's exact
 * rule. A stored name Core accepted before the stricter rule is left alone
 * unless the user edits it.
 */
export function planProjectUpdate(
  project: Pick<Project, "name" | "description">,
  draft: ProjectSettingsDraft,
): ProjectUpdatePlan {
  const nameChanged = draft.name !== project.name;
  const descriptionChanged = draft.description !== project.description;
  const nameError = nameChanged ? validateProjectName(draft.name) : null;
  const descriptionError = descriptionChanged ? validateProjectDescription(draft.description) : null;
  if (!nameChanged && !descriptionChanged) {
    return { changes: null, nameError: null, descriptionError: null };
  }
  return {
    changes: {
      ...(nameChanged ? { name: draft.name } : {}),
      ...(descriptionChanged ? { description: draft.description } : {}),
    },
    nameError,
    descriptionError,
  };
}

// ---------------------------------------------------------------------------
// Two-step delete controller (A1 pattern)
// ---------------------------------------------------------------------------

export type DeletionState =
  | { kind: "idle" }
  /** Step 1 in flight (`{ projectId }` sent; Core is minting a confirmation). */
  | { kind: "requesting"; projectId: string }
  /** Step 1 answered; the dialog shows Core's confirmation. */
  | { kind: "confirming"; projectId: string; confirmation: ConfirmationRequest }
  /** Step 2 in flight; the token has been spent and is no longer held. */
  | { kind: "deleting"; projectId: string; target: ConfirmationTarget }
  | { kind: "deleted"; projectId: string; target: ConfirmationTarget }
  /**
   * Step 2's outcome was unknown, and a re-read of `project.list
   * {includeArchived: true}` no longer lists the project. Stated as exactly
   * that — not as "deleted by this request".
   */
  | { kind: "gone"; projectId: string; target: ConfirmationTarget }
  | {
      kind: "failed";
      projectId: string;
      stage: "request" | "confirm" | "expired";
      error: CoreRequestError | null;
      copy: FailureCopy;
      /** True when Core may have deleted it: the list must be re-read, never assumed. */
      outcomeUnknown: boolean;
    };

/** The two Core calls the flow needs (a `CoreClient` satisfies it). */
export type DeletionClient = Pick<CoreClient, "requestProjectDeletion" | "confirmProjectDeletion">;

export interface DeletionFlowOptions {
  /** After every exchange settles, success or not (re-read `project.list`). */
  onSettled?: () => void;
  /** Only on `deleted: true` (clear client-side selection of that project). */
  onDeleted?: (projectId: string) => void;
  /**
   * After an UNKNOWN step 2: does Core still list the project (archived
   * included)? `true` / `false`, or `null` when the read failed. A rejection
   * counts as `null`. Absent → the outcome simply stays unknown.
   */
  recheckListed?: (projectId: string) => Promise<boolean | null>;
  /**
   * Core no longer has the project although THIS request is not known to have
   * deleted it (re-read after an unknown outcome, or a step-2 NOT_FOUND):
   * forget it locally all the same.
   */
  onGone?: (projectId: string) => void;
  now?: () => number;
}

/** Core's step-2 token refusal (`confirm::TOKEN_REJECTED_MESSAGE`), drift-tested. */
export const TOKEN_REJECTED_MESSAGE =
  "confirmation token is invalid, expired, already used, or not for this action and target; " +
  "request a new confirmation";

/**
 * Step-2 failure copy. Core's exact refusals mean nothing was deleted; a lost
 * or unreadable answer and a Core INTERNAL are UNKNOWN — the project may be
 * gone — and never say "nothing was deleted".
 */
export function deletionFailureCopy(err: unknown): { copy: FailureCopy; outcomeUnknown: boolean } {
  const error = asCoreRequestError(err);
  if (error.mayHaveBeenApplied || (error.isCoreError && error.code === "INTERNAL")) {
    return {
      outcomeUnknown: true,
      copy: {
        title: "Outcome unknown — the project may have been deleted",
        body:
          "The confirmation reached Core, but this desktop did not get an answer it can trust, so it cannot tell whether the project was deleted.",
        action:
          "Re-read the project list with “Show archived” on before doing anything else. Do not confirm again: the token was single-use.",
        coreMessage: displayRevealed(error.message, MAX_CORE_MESSAGE_CHARS).text,
      },
    };
  }
  if (coreErrorCode(error) === "VALIDATION_FAILED" && error.message === TOKEN_REJECTED_MESSAGE) {
    return {
      outcomeUnknown: false,
      copy: {
        title: "Confirmation refused — nothing was deleted",
        body: "Core refused the confirmation: it expired, was already used, or does not match this project.",
        action: "Request a new confirmation if you still want to delete the project.",
        coreMessage: displayRevealed(error.message, MAX_CORE_MESSAGE_CHARS).text,
      },
    };
  }
  // Exact A3a refusals (unfinished tasks, sandboxes, create in flight, not
  // found) get their "nothing was …" copy from `describeCoreError`; anything
  // else gets the generic copy, which never claims more than Core said.
  const copy = describeCoreError(error);
  return {
    outcomeUnknown: false,
    copy: { title: copy.title, body: copy.reason, action: copy.action },
  };
}

/**
 * The two-step `project.delete` flow, single-flight and token-safe — the same
 * contract as `SandboxRemovalFlow`:
 *
 * - `begin` sends step 1 (`{ projectId }` only). Nothing changes in Core.
 * - `cancel` drops the token; nothing is sent. A step-1 answer that arrives
 *   after a cancel is discarded unseen.
 * - `confirm` spends the token exactly once: the state moves to `deleting`
 *   synchronously BEFORE the request is written, so a double click cannot send
 *   twice. An expired (or unreadable) expiry sends nothing.
 * - Nothing is ever retried; a failed step 2 needs a fresh step 1.
 *
 * The token lives only in the `confirming` state. It is never logged,
 * displayed, persisted or put into error text.
 */
export class ProjectDeletionFlow {
  private state: DeletionState = { kind: "idle" };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private readonly now: () => number;

  constructor(
    private readonly client: DeletionClient,
    private readonly options: DeletionFlowOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  getState = (): DeletionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get busy(): boolean {
    return this.state.kind === "requesting" || this.state.kind === "deleting";
  }

  /** Step 1. Ignored while a step is in flight or a confirmation is open. */
  async begin(projectId: string): Promise<void> {
    if (this.busy || this.state.kind === "confirming") return;
    const generation = ++this.generation;
    this.set({ kind: "requesting", projectId });
    try {
      const confirmation = await this.client.requestProjectDeletion(projectId);
      if (generation !== this.generation) return; // cancelled: drop the token unseen
      this.set({ kind: "confirming", projectId, confirmation });
    } catch (err) {
      if (generation !== this.generation) return;
      const error = asCoreRequestError(err);
      const copy = describeCoreError(error);
      this.set({
        kind: "failed",
        projectId,
        stage: "request",
        error,
        outcomeUnknown: false,
        copy: {
          title: `Could not prepare the deletion — ${copy.title}`,
          body: copy.reason,
          action: copy.action,
        },
      });
    } finally {
      if (generation === this.generation) this.options.onSettled?.();
    }
  }

  /** Cancel the dialog. Sends NOTHING; the token is dropped. No-op while deleting. */
  cancel(): void {
    if (this.state.kind === "deleting") return;
    this.generation += 1;
    this.set({ kind: "idle" });
  }

  reset(): void {
    this.cancel();
  }

  /**
   * Step 2. Sends `{ projectId, confirmToken }` once, only from `confirming`,
   * only before expiry (re-checked here, at click time). Returns whether a
   * request was written.
   */
  confirm(): boolean {
    const state = this.state;
    if (state.kind !== "confirming") return false;
    const { projectId, confirmation } = state;
    if (isExpired(parseExpiry(confirmation.expiresAt), this.now())) {
      this.set({
        kind: "failed",
        projectId,
        stage: "expired",
        error: null,
        outcomeUnknown: false,
        copy: {
          title: "Confirmation expired — nothing was sent",
          body: "Core's confirmation is only valid until its expiry time, so this desktop did not send it.",
          action: "Request a new confirmation if you still want to delete the project.",
        },
      });
      return false;
    }
    const target = confirmation.target;
    this.set({ kind: "deleting", projectId, target });
    void this.client
      .confirmProjectDeletion(projectId, confirmation.token)
      .then(
        () => {
          this.set({ kind: "deleted", projectId, target });
          this.options.onDeleted?.(projectId);
        },
        async (err: unknown) => {
          const error = asCoreRequestError(err);
          const { copy, outcomeUnknown } = deletionFailureCopy(error);
          const failed: DeletionState = {
            kind: "failed",
            projectId,
            stage: "confirm",
            error,
            copy,
            outcomeUnknown,
          };
          this.set(failed);
          if (error.isCoreError && coreErrorCode(error) === "NOT_FOUND") {
            // Core checked: it has no project with this id.
            this.options.onGone?.(projectId);
            return;
          }
          if (!outcomeUnknown || this.options.recheckListed === undefined) return;
          let listed: boolean | null;
          try {
            listed = await this.options.recheckListed(projectId);
          } catch {
            listed = null;
          }
          // Only act if nothing replaced this verdict meanwhile (e.g. a reset).
          if (listed !== false || this.state !== failed) return;
          this.set({ kind: "gone", projectId, target });
          this.options.onGone?.(projectId);
        },
      )
      .finally(() => this.options.onSettled?.());
    return true;
  }

  private set(next: DeletionState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** Shown in the delete dialog under Core's impact lines. */
export const PROJECT_DELETE_FOOTNOTE =
  "Core re-checks unfinished tasks, sandboxes and in-flight creates before deleting. It never touches host files, branches or sandboxes. Nothing is deleted if you cancel.";

// ---------------------------------------------------------------------------
// Client-side state of a deleted project (design §3.2 item 9 / brief item 6)
// ---------------------------------------------------------------------------

/** The desktop's local, UI-only places that can still name a project. */
export interface LocalProjectState {
  lastProjectId(): string | null;
  clearLastProjectId(): void;
  forgetConversations(projectId: string): void;
  dropCachedReads(projectId: string): void;
}

/**
 * Run ONLY after Core answered `deleted: true`: clear the remembered selection
 * if it was this project, this window's in-memory chats of it, and its cached
 * reads. The project list itself is re-read from Core, never edited locally.
 */
export function forgetProjectLocally(projectId: string, local: LocalProjectState): void {
  if (local.lastProjectId() === projectId) local.clearLastProjectId();
  // Cached reads first: they find the project's chats and tasks through the
  // in-memory conversations, which are forgotten next.
  local.dropCachedReads(projectId);
  local.forgetConversations(projectId);
}

/**
 * The ids a deleted project leaves in this window's caches: its conversations
 * (Core's cached list + this window's own) and its tasks (the project-scoped
 * task list, plus any row of the global list that belongs to one of those
 * conversations). Inputs are whatever is cached; anything not an array is
 * ignored rather than trusted.
 */
export function projectCacheIds(
  projectId: string,
  cached: {
    conversations: unknown;
    sessionConversations: readonly { id: string; projectId: string }[];
    projectTasks: unknown;
    allTasks: unknown;
  },
): { conversationIds: Set<string>; taskIds: Set<string> } {
  const rows = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      : [];
  const conversationIds = new Set<string>();
  for (const c of [...rows(cached.conversations), ...cached.sessionConversations]) {
    if (c.projectId === projectId && typeof c.id === "string") conversationIds.add(c.id);
  }
  const taskIds = new Set<string>();
  for (const t of rows(cached.projectTasks)) if (typeof t.id === "string") taskIds.add(t.id);
  for (const t of rows(cached.allTasks)) {
    if (typeof t.id === "string" && typeof t.conversationId === "string" && conversationIds.has(t.conversationId)) {
      taskIds.add(t.id);
    }
  }
  return { conversationIds, taskIds };
}
