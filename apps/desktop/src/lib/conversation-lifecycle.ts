/**
 * A3b conversation lifecycle on the desktop (design 2026-10-09 §3.3): rename,
 * archive / unarchive, the "show archived" filter, the "sandbox chosen at
 * creation" label, delete through the A1 two-step confirmation pattern, and
 * the paged, always-redacted export.
 *
 * The desktop has NO file save (no dialog/fs plugin, A3a W3): the export is
 * shown read-only as a capped, revealed preview, and the full text can be
 * copied with an explicit Copy action. Nothing here writes a file, and the
 * export's contents are never logged.
 *
 * Pure logic only (no React, no DOM), so the node-only vitest suites prove
 * what is sent, when, and how often. Core stays the authority on every
 * outcome; nothing here decides a conversation's or a task's state.
 */

import {
  MAY_HAVE_BEEN_APPLIED_COPY,
  asCoreRequestError,
  coreErrorCode,
  type CoreClient,
  type CoreRequestError,
} from "./core-client";
import {
  CONVERSATION_EXPORT_FORMAT,
  FEATURE_CONVERSATION_SANDBOX_ID,
  MAX_LIST_LIMIT,
  coreAdvertisesFeature,
  coreAdvertisesMethod,
  type ConfirmationRequest,
  type ConfirmationTarget,
  type Conversation,
  type ConversationExportPage,
  type ConversationLifecycleMethod,
  type ConversationListParams,
  type CoreCapabilities,
  type ExportRedaction,
  type MessageRecord,
} from "./protocol";
import { MSG_CONVERSATION_ARCHIVED } from "./conversation-messages";
import { MSG_PROJECT_ARCHIVED } from "./project-messages";
import { TOKEN_REJECTED_MESSAGE } from "./project-lifecycle";
import { describeCoreError, displayRevealed, featureGate, type FeatureGate } from "./reducers";
import {
  MAX_CORE_MESSAGE_CHARS,
  isExpired,
  parseExpiry,
  type FailureCopy,
} from "./sandbox-lifecycle";
import { CONVERSATION_TITLE_MAX, isRustBlank, validateConversationTitle } from "./wizard";

// ---------------------------------------------------------------------------
// Gating on `system.probe`
// ---------------------------------------------------------------------------

export interface ConversationLifecycleGates {
  rename: FeatureGate;
  archive: FeatureGate;
  unarchive: FeatureGate;
  delete: FeatureGate;
  export: FeatureGate;
  /**
   * `conversation.list {includeArchived}` is sent only to a Core that
   * advertises `conversation.archive`; an older Core is never sent the field
   * (it has nothing archived that a client could have made).
   */
  showArchived: FeatureGate;
  /**
   * `conversation-sandbox-id` advertised: only then is `sandboxId` known to be
   * persisted. `null` = not probed yet.
   */
  sandboxIdPersisted: boolean | null;
}

const UNSUPPORTED: Record<ConversationLifecycleMethod, string> = {
  "conversation.rename": "Renaming conversations is not supported by this Core.",
  "conversation.archive": "Archiving conversations is not supported by this Core.",
  "conversation.unarchive": "Unarchiving conversations is not supported by this Core.",
  "conversation.delete": "Deleting conversations is not supported by this Core.",
  "conversation.export": "Exporting conversations is not supported by this Core.",
};

/**
 * Availability of each A3b action for THIS Core. `null` capabilities = the
 * probe has not answered: every control is "not probed yet", never optimistic.
 */
export function conversationLifecycleGates(
  capabilities: Pick<CoreCapabilities, "methods" | "features"> | null,
): ConversationLifecycleGates {
  const gate = (method: ConversationLifecycleMethod): FeatureGate =>
    featureGate(
      capabilities === null ? null : coreAdvertisesMethod(capabilities, method),
      `\`${method}\``,
      `This Core does not advertise \`${method}\`. ${UNSUPPORTED[method]} Upgrade Core to use it from Sandpane.`,
    );
  const archive = gate("conversation.archive");
  return {
    rename: gate("conversation.rename"),
    archive,
    unarchive: gate("conversation.unarchive"),
    delete: gate("conversation.delete"),
    export: gate("conversation.export"),
    showArchived:
      archive.state === "supported"
        ? { state: "supported", note: "Archived conversations are listed with `includeArchived: true`." }
        : archive.state === "unprobed"
          ? archive
          : {
              state: "unsupported",
              note: "This Core has no archived conversations to show: it does not advertise `conversation.archive`.",
            },
    sandboxIdPersisted:
      capabilities === null ? null : coreAdvertisesFeature(capabilities, FEATURE_CONVERSATION_SANDBOX_ID),
  };
}

/**
 * The `conversation.list` params a view sends: scoped to the project when one
 * is open, and with `includeArchived: true` ONLY when the user asked for
 * archived rows AND this Core advertises `conversation.archive`.
 */
export function conversationListParams(
  projectId: string | null,
  showArchived: boolean,
  gates: Pick<ConversationLifecycleGates, "showArchived">,
): ConversationListParams {
  return {
    ...(projectId === null ? {} : { projectId }),
    ...(showArchived && gates.showArchived.state === "supported" ? { includeArchived: true } : {}),
  };
}

/**
 * The rows a chat list shows: Core's rows first, then this window's own
 * (created before the next read), each once. With "show archived" off an
 * archived row is left out on BOTH sides — Core's list already omits them,
 * and this window's copy (kept in step by `replaceConversation`) must not
 * re-add a chat as if it were live. `projectId` `null` = every project.
 */
export function mergeConversationRows(
  coreRows: readonly Conversation[],
  sessionRows: readonly Conversation[],
  scope: { projectId: string | null; showArchived: boolean },
): { conversation: Conversation; fromCore: boolean }[] {
  const seen = new Set<string>();
  const out: { conversation: Conversation; fromCore: boolean }[] = [];
  const add = (rows: readonly Conversation[], fromCore: boolean) => {
    for (const conversation of rows) {
      if (scope.projectId !== null && conversation.projectId !== scope.projectId) continue;
      if (seen.has(conversation.id)) continue;
      if (!scope.showArchived && isConversationArchived(conversation)) continue;
      seen.add(conversation.id);
      out.push({ conversation, fromCore });
    }
  };
  add(coreRows, true);
  add(sessionRows, false);
  return out;
}

// ---------------------------------------------------------------------------
// Archived state
// ---------------------------------------------------------------------------

/** True when Core reports the conversation archived (`archivedAt` present). */
export function isConversationArchived(conversation: Pick<Conversation, "archivedAt">): boolean {
  return conversation.archivedAt !== undefined;
}

/** The archived label shown on a row: Core's instant, revealed and capped. */
export function conversationArchivedLabel(conversation: Pick<Conversation, "archivedAt">): string | null {
  if (conversation.archivedAt === undefined) return null;
  return `archived ${displayRevealed(conversation.archivedAt, 64).text}`;
}

export type ConversationAction = "send" | "rename" | "archive" | "unarchive" | "delete" | "export";

/**
 * Why Core would refuse `action` here, with Core's exact message quoted, or
 * `null`. Core's CHECK ORDER is mirrored: when the project is archived its
 * refusal comes first (send, rename and unarchive); then an archived
 * conversation refuses send and rename. Archive, delete, export and every
 * read stay allowed. This only disables a control — Core still decides.
 */
export function conversationWriteBlock(
  conversation: Pick<Conversation, "archivedAt">,
  projectArchived: boolean,
  action: ConversationAction,
): string | null {
  if (projectArchived && (action === "send" || action === "rename" || action === "unarchive")) {
    return `Archived project — Core refuses this until the project is unarchived ("${MSG_PROJECT_ARCHIVED}").`;
  }
  if (isConversationArchived(conversation) && (action === "send" || action === "rename")) {
    return `Archived conversation — Core refuses this until it is unarchived ("${MSG_CONVERSATION_ARCHIVED}"). Its history stays readable.`;
  }
  return null;
}

/**
 * The `title` a "New chat" sends. It is the user's own one-line field — never
 * derived from a message. Blank as Rust judges it (`trim().is_empty()`, Unicode
 * White_Space, not JS `trim()`) is sent as `""`, so Core stores its own
 * "Untitled conversation" (the same as the VS Code client); anything else is
 * sent with surrounding whitespace removed and is checked by
 * `validateConversationTitle(…, "create")` before the button is enabled.
 */
export function conversationCreateTitle(raw: string): string {
  if (isRustBlank(raw)) return "";
  const trimmed = raw.trim();
  return isRustBlank(trimmed) ? "" : trimmed;
}

export interface RenamePlan {
  /** The title to send, or `null` when nothing changed or it is invalid. */
  title: string | null;
  error: string | null;
}

export interface RenamePrefill {
  /** What the rename field starts with. */
  draft: string;
  /** The stored title, revealed, when it is NOT copied into the field. */
  storedRevealed: string | null;
}

/**
 * The rename field's starting value. A stored title that Core would refuse as
 * a new title (control / separator / bidi characters, too long — e.g. one
 * stored before A3b), or that holds characters the desktop reveals as unusual
 * (zero-width and other invisible ones, which Core's rule allows), is never
 * put into an editable field raw: the field starts empty and the title is
 * shown revealed beside it (as VS Code does). Typing such a title is still
 * allowed — only Core's rule decides what can be SENT.
 */
export function renamePrefill(storedTitle: string): RenamePrefill {
  const revealed = displayRevealed(storedTitle, CONVERSATION_TITLE_MAX);
  if (validateConversationTitle(storedTitle, "rename") === null && !revealed.unusual) {
    return { draft: storedTitle, storedRevealed: null };
  }
  return { draft: "", storedRevealed: revealed.text };
}

/** What a Rename would send: only a CHANGED title, checked with Core's rule. */
export function planConversationRename(
  conversation: Pick<Conversation, "title">,
  draft: string,
): RenamePlan {
  // The untouched starting value (the stored title, or the empty field that
  // replaces a refused one) is "nothing to send", never an error.
  if (draft === renamePrefill(conversation.title).draft) return { title: null, error: null };
  const error = validateConversationTitle(draft, "rename");
  return error === null ? { title: draft, error: null } : { title: null, error };
}

// ---------------------------------------------------------------------------
// "Sandbox chosen at creation" (design §3.3 item 3)
// ---------------------------------------------------------------------------

export interface SandboxChosenView {
  /** The stored name (revealed, capped) or a plain statement. */
  text: string;
  note: string;
}

/**
 * The stored `sandboxId` as what it is: the sandbox NAME chosen when the
 * conversation was created — never a binding or an identity. `sandboxNames`
 * is the current `sandbox.list`, or `null` when that list is unavailable (it
 * failed, or is not loaded): then existence is unknown and is said so, never
 * "not in the current sandbox list". `featureAdvertised` `null` = unprobed →
 * nothing is shown.
 */
export function sandboxChosenAtCreation(
  conversation: Pick<Conversation, "sandboxId">,
  featureAdvertised: boolean | null,
  sandboxNames: readonly string[] | null,
): SandboxChosenView | null {
  if (featureAdvertised === null) return null;
  if (!featureAdvertised) {
    return {
      text: "not reported by this Core",
      note: "This Core does not advertise `conversation-sandbox-id`, so it cannot say whether a sandbox was chosen.",
    };
  }
  if (conversation.sandboxId === undefined) {
    return {
      text: "none chosen at creation",
      note: "Core stored no sandbox name for this conversation (none was chosen, or it predates A3b).",
    };
  }
  const caveat =
    "A name recorded when the chat was created — not a binding: Core does not check that it still exists, and a same-named replacement looks identical.";
  const where =
    sandboxNames === null
      ? "The sandbox list is unavailable, so whether a sandbox with this name exists now is unknown."
      : sandboxNames.includes(conversation.sandboxId)
        ? "A sandbox with this name is in the current sandbox list."
        : "It is not in the current sandbox list.";
  return {
    text: displayRevealed(conversation.sandboxId, 128).text,
    note: `${where} ${caveat}`,
  };
}

// ---------------------------------------------------------------------------
// Two-step delete controller (A1 pattern)
// ---------------------------------------------------------------------------

export type ConversationDeletionState =
  | { kind: "idle" }
  /** Step 1 in flight (`{ conversationId }` sent; Core is minting a confirmation). */
  | { kind: "requesting"; conversationId: string; projectId: string }
  /** Step 1 answered; the dialog shows Core's confirmation. */
  | {
      kind: "confirming";
      conversationId: string;
      projectId: string;
      confirmation: ConfirmationRequest;
    }
  /** Step 2 in flight; the token has been spent and is no longer held. */
  | { kind: "deleting"; conversationId: string; projectId: string; target: ConfirmationTarget }
  | { kind: "deleted"; conversationId: string; projectId: string; target: ConfirmationTarget }
  /**
   * Step 2's outcome was unknown, and a re-read of `conversation.list
   * {projectId, includeArchived: true}` no longer lists the conversation.
   * Stated as exactly that — not as "deleted by this request".
   */
  | { kind: "gone"; conversationId: string; projectId: string; target: ConfirmationTarget }
  | {
      kind: "failed";
      conversationId: string;
      projectId: string;
      stage: "request" | "confirm" | "expired";
      error: CoreRequestError | null;
      copy: FailureCopy;
      /** True when Core may have deleted it: the list must be re-read, never assumed. */
      outcomeUnknown: boolean;
    };

/** The two Core calls the flow needs (a `CoreClient` satisfies it). */
export type ConversationDeletionClient = Pick<
  CoreClient,
  "requestConversationDeletion" | "confirmConversationDeletion"
>;

export interface ConversationDeletionFlowOptions {
  /** After every exchange settles, success or not (re-read `conversation.list`). */
  onSettled?: () => void;
  /** Only on `deleted: true` (clear client-side selection and state). */
  onDeleted?: (conversationId: string) => void;
  /**
   * After an UNKNOWN step 2: does Core still list the conversation (archived
   * included, scoped to its project)? `true` / `false`, or `null` when that
   * cannot be told. A rejection counts as `null`. Absent → stays unknown.
   */
  recheckListed?: (conversationId: string, projectId: string) => Promise<boolean | null>;
  /**
   * Core no longer has the conversation although THIS request is not known to
   * have deleted it (re-read after an unknown outcome, or a step-2
   * NOT_FOUND): forget it locally all the same.
   */
  onGone?: (conversationId: string) => void;
  now?: () => number;
}

/**
 * Step-2 failure copy. Core's exact refusals mean nothing was deleted; a lost
 * or unreadable answer and a Core INTERNAL are UNKNOWN — the conversation may
 * be gone — and never say "nothing was deleted".
 */
export function conversationDeletionFailureCopy(err: unknown): {
  copy: FailureCopy;
  outcomeUnknown: boolean;
} {
  const error = asCoreRequestError(err);
  if (error.mayHaveBeenApplied || (error.isCoreError && error.code === "INTERNAL")) {
    return {
      outcomeUnknown: true,
      copy: {
        title: "Outcome unknown — the conversation may have been deleted",
        body:
          "The confirmation reached Core, but this desktop did not get an answer it can trust, so it cannot tell whether the conversation was deleted.",
        action:
          "Re-read the conversation list with “Show archived” on before doing anything else. Do not confirm again: the token was single-use.",
        coreMessage: displayRevealed(error.message, MAX_CORE_MESSAGE_CHARS).text,
      },
    };
  }
  if (coreErrorCode(error) === "VALIDATION_FAILED" && error.message === TOKEN_REJECTED_MESSAGE) {
    return {
      outcomeUnknown: false,
      copy: {
        title: "Confirmation refused — nothing was deleted",
        body: "Core refused the confirmation: it expired, was already used, or does not match this conversation.",
        action: "Request a new confirmation if you still want to delete the conversation.",
        coreMessage: displayRevealed(error.message, MAX_CORE_MESSAGE_CHARS).text,
      },
    };
  }
  // Exact A3b refusals (unfinished tasks, not found) get their "nothing was …"
  // copy from `describeCoreError`; anything else gets the generic copy, which
  // never claims more than Core said. A token is never part of any of it: the
  // client never puts one into an error message.
  const copy = describeCoreError(error);
  return {
    outcomeUnknown: false,
    copy: { title: copy.title, body: copy.reason, action: copy.action },
  };
}

/**
 * The two-step `conversation.delete` flow, single-flight and token-safe — the
 * same contract as `ProjectDeletionFlow` / `SandboxRemovalFlow`:
 *
 * - `begin` sends step 1 (`{ conversationId }` only). Nothing changes in Core.
 * - `cancel` drops the token; nothing is sent. A step-1 answer that arrives
 *   after a cancel is discarded unseen.
 * - `confirm` spends the token exactly once: the state moves to `deleting`
 *   synchronously BEFORE the request is written, so a double click cannot
 *   send twice. An expired (or unreadable) expiry sends nothing.
 * - Nothing is ever retried; a failed step 2 needs a fresh step 1.
 *
 * The token lives only in the `confirming` state. It is never logged,
 * displayed, persisted or put into error text.
 */
export class ConversationDeletionFlow {
  private state: ConversationDeletionState = { kind: "idle" };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private readonly now: () => number;

  constructor(
    private readonly client: ConversationDeletionClient,
    private readonly options: ConversationDeletionFlowOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  getState = (): ConversationDeletionState => this.state;

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
  async begin(conversationId: string, projectId: string): Promise<void> {
    if (this.busy || this.state.kind === "confirming") return;
    const generation = ++this.generation;
    this.set({ kind: "requesting", conversationId, projectId });
    try {
      const confirmation = await this.client.requestConversationDeletion(conversationId);
      if (generation !== this.generation) return; // cancelled: drop the token unseen
      this.set({ kind: "confirming", conversationId, projectId, confirmation });
    } catch (err) {
      if (generation !== this.generation) return;
      const error = asCoreRequestError(err);
      const copy = describeCoreError(error);
      this.set({
        kind: "failed",
        conversationId,
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
   * Step 2. Sends `{ conversationId, confirmToken }` once, only from
   * `confirming`, only before expiry (re-checked here, at click time; an
   * unreadable expiry counts as expired). Returns whether a request was written.
   */
  confirm(): boolean {
    const state = this.state;
    if (state.kind !== "confirming") return false;
    const { conversationId, projectId, confirmation } = state;
    if (isExpired(parseExpiry(confirmation.expiresAt), this.now())) {
      this.set({
        kind: "failed",
        conversationId,
        projectId,
        stage: "expired",
        error: null,
        outcomeUnknown: false,
        copy: {
          title: "Confirmation expired — nothing was sent",
          body: "Core's confirmation is only valid until its expiry time, so this desktop did not send it.",
          action: "Request a new confirmation if you still want to delete the conversation.",
        },
      });
      return false;
    }
    const target = confirmation.target;
    this.set({ kind: "deleting", conversationId, projectId, target });
    void this.client
      .confirmConversationDeletion(conversationId, confirmation.token)
      .then(
        () => {
          this.set({ kind: "deleted", conversationId, projectId, target });
          this.options.onDeleted?.(conversationId);
        },
        async (err: unknown) => {
          const error = asCoreRequestError(err);
          const { copy, outcomeUnknown } = conversationDeletionFailureCopy(error);
          const failed: ConversationDeletionState = {
            kind: "failed",
            conversationId,
            projectId,
            stage: "confirm",
            error,
            copy,
            outcomeUnknown,
          };
          this.set(failed);
          if (error.isCoreError && coreErrorCode(error) === "NOT_FOUND") {
            // Core checked: it has no conversation with this id.
            this.options.onGone?.(conversationId);
            return;
          }
          if (!outcomeUnknown || this.options.recheckListed === undefined) return;
          let listed: boolean | null;
          try {
            listed = await this.options.recheckListed(conversationId, projectId);
          } catch {
            listed = null;
          }
          // Only act if nothing replaced this verdict meanwhile (e.g. a reset).
          if (listed !== false || this.state !== failed) return;
          this.set({ kind: "gone", conversationId, projectId, target });
          this.options.onGone?.(conversationId);
        },
      )
      .finally(() => this.options.onSettled?.());
    return true;
  }

  private set(next: ConversationDeletionState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** Shown in the delete dialog under Core's impact lines. */
export const CONVERSATION_DELETE_FOOTNOTE =
  "Core re-checks unfinished tasks before deleting. It never touches host files, worktrees, branches or sandboxes. Nothing is deleted if you cancel.";

/**
 * After an UNKNOWN step 2: does Core still list the conversation? Reads
 * `conversation.list {projectId, includeArchived: true, limit: 500}`. The list
 * has no `truncated` flag, so a FULL page that does not name the conversation
 * proves nothing: that is `null` (unknown), never "gone".
 *
 * `includeArchived` is sent only when `conversation.archive` is advertised.
 * Without it the re-read is not made at all: a live-only list cannot tell an
 * archived conversation from a deleted one, so it never settles the outcome.
 */
export async function recheckConversationListed(
  client: Pick<CoreClient, "listConversations">,
  conversationId: string,
  projectId: string,
  archiveAdvertised: boolean,
): Promise<boolean | null> {
  if (!archiveAdvertised) return null;
  const rows = await client.listConversations({
    projectId,
    includeArchived: true,
    limit: MAX_LIST_LIMIT,
  });
  if (rows.some((row) => row.id === conversationId)) return true;
  return rows.length >= MAX_LIST_LIMIT ? null : false;
}

/**
 * The deletion flow's `recheckListed`, gated on the capabilities probed at the
 * moment of the re-check (they can change while a dialog is open).
 */
export function conversationRecheck(
  client: Pick<CoreClient, "listConversations">,
  capabilities: () => Pick<CoreCapabilities, "methods"> | null,
): (conversationId: string, projectId: string) => Promise<boolean | null> {
  return (conversationId, projectId) =>
    recheckConversationListed(
      client,
      conversationId,
      projectId,
      coreAdvertisesMethod(capabilities(), "conversation.archive"),
    );
}

// ---------------------------------------------------------------------------
// Client-side state of a deleted conversation (design §3.3 item 9)
// ---------------------------------------------------------------------------

/** The desktop's local, UI-only places that can still name a conversation. */
export interface LocalConversationState {
  /** The conversation the route currently has open, if any. */
  selectedConversationId(): string | null;
  /** Navigate away from it (the route is the desktop's selection). */
  clearSelection(): void;
  /** This window's in-memory copy (`conversation-store`). */
  forgetSessionConversation(conversationId: string): void;
  /** Its history pages and task projections. */
  dropCachedReads(conversationId: string): void;
}

/**
 * Run ONLY when Core no longer has the conversation (`deleted: true`, a step-2
 * NOT_FOUND, or an unknown outcome a re-read settled): clear the selection if
 * it is this conversation, its cached reads, and this window's copy. The
 * conversation list itself is re-read from Core, never edited locally.
 */
export function forgetConversationLocally(conversationId: string, local: LocalConversationState): void {
  if (local.selectedConversationId() === conversationId) local.clearSelection();
  local.dropCachedReads(conversationId);
  local.forgetSessionConversation(conversationId);
}

/**
 * The task ids a deleted conversation leaves in this window's caches: rows of
 * any cached `task.list` read and replayed projections that name it. Inputs
 * are whatever is cached; anything not an array of rows is ignored rather
 * than trusted.
 */
export function conversationCacheTaskIds(
  conversationId: string,
  cachedTaskLists: readonly unknown[],
  projections: readonly { taskId: string; conversationId: string | null }[],
): Set<string> {
  const ids = new Set<string>();
  for (const list of cachedTaskLists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (typeof row !== "object" || row === null) continue;
      const rec = row as Record<string, unknown>;
      if (rec.conversationId === conversationId && typeof rec.id === "string") ids.add(rec.id);
    }
  }
  for (const projection of projections) {
    if (projection.conversationId === conversationId) ids.add(projection.taskId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Export (design §3.3 item 6; brief item 5)
// ---------------------------------------------------------------------------

/** Hard cap on export pages; a longer export stops and is disclosed as partial. */
export const EXPORT_PAGE_CAP = 200;

/** Shown before and after an export, on every export surface. */
export const EXPORT_REVIEW_NOTICE = "Redaction is best-effort; review the export before sharing it.";

/** The `note` carried inside every assembled export document. */
export const EXPORT_DOCUMENT_NOTE =
  "Redaction is best-effort; review before sharing. Task events, artifacts and verification output are not included.";

/**
 * The ONE JSON document an export assembles. Key order is fixed and shared
 * with the other clients: `format`, `exportedAt` (first page), `conversation`
 * (first page; title redacted by Core), `messages` (all pages, concatenated),
 * `redaction` (`bestEffort: true` plus `replacements` and `byKind` SUMMED
 * over the pages), `complete`, `note`.
 */
export interface ConversationExportDocument {
  format: typeof CONVERSATION_EXPORT_FORMAT;
  exportedAt: string;
  conversation: Conversation;
  messages: MessageRecord[];
  redaction: ExportRedaction;
  complete: boolean;
  note: string;
}

/** Why an export stopped before Core said it was complete. */
export type ExportStopReason = "cursor" | "page-cap";

export type ExportOutcome =
  | {
      kind: "ready";
      document: ConversationExportDocument;
      /** The full JSON text (hidden characters escaped). Never logged. */
      json: string;
      pages: number;
      complete: boolean;
      stopReason: ExportStopReason | null;
    }
  | { kind: "failed"; error: CoreRequestError; copy: FailureCopy; pagesRead: number };

/** The one Core call the export needs (a `CoreClient` satisfies it). */
export interface ExportPageClient {
  exportConversationPage(params: {
    conversationId: string;
    afterSequence?: number;
  }): Promise<ConversationExportPage>;
}

/**
 * Failure copy for an export. `conversation.export` only reads Core, so a lost
 * answer is NOT "may have been applied" (the generic copy for a non-replay-safe
 * method): that suffix is dropped and the copy says what is true — no export
 * was produced and nothing was copied. Core's text is revealed and capped.
 */
export function exportFailureCopy(err: unknown): FailureCopy {
  const error = asCoreRequestError(err);
  const raw = error.message.endsWith(MAY_HAVE_BEEN_APPLIED_COPY)
    ? error.message.slice(0, -MAY_HAVE_BEEN_APPLIED_COPY.length).trimEnd()
    : error.message;
  const who = error.isCoreError ? "Core" : "This desktop";
  return {
    title: "Export failed — no export was produced",
    body: `${who} reported ${String(error.code)}: ${displayRevealed(raw, MAX_CORE_MESSAGE_CHARS).text}`,
    action:
      "Nothing was copied. conversation.export only reads Core, so exporting again is safe once the cause is fixed.",
  };
}

/**
 * Page through `conversation.export` from `afterSequence: 0` until Core says
 * `truncated: false`. Bounds: `nextSequence` must STRICTLY increase (else the
 * export stops as partial — a cursor that does not move would loop forever),
 * and at most `pageCap` pages are read (then it stops as partial). ANY page
 * failure yields no document at all: a half export is never offered as if it
 * were the whole one. Every page must be about the requested conversation.
 */
export async function collectConversationExport(
  client: ExportPageClient,
  conversationId: string,
  options: { pageCap?: number; onPage?: (pagesRead: number) => void } = {},
): Promise<ExportOutcome> {
  const pageCap = options.pageCap ?? EXPORT_PAGE_CAP;
  let cursor = 0;
  let pages = 0;
  let first: ConversationExportPage | null = null;
  const messages: MessageRecord[] = [];
  let replacements = 0;
  const byKind = new Map<string, number>();
  let stopReason: ExportStopReason | null = null;
  for (;;) {
    if (pages >= pageCap) {
      stopReason = "page-cap";
      break;
    }
    let page: ConversationExportPage;
    try {
      page = await client.exportConversationPage({ conversationId, afterSequence: cursor });
    } catch (err) {
      const error = asCoreRequestError(err);
      return { kind: "failed", error, copy: exportFailureCopy(error), pagesRead: pages };
    }
    if (page.conversation.id !== conversationId) {
      const error = asCoreRequestError(
        new Error("Core answered conversation.export about a different conversation than the one asked about"),
      );
      return { kind: "failed", error, copy: exportFailureCopy(error), pagesRead: pages };
    }
    pages += 1;
    first ??= page;
    messages.push(...page.messages);
    replacements += page.redaction.replacements;
    for (const [kind, n] of Object.entries(page.redaction.byKind)) {
      byKind.set(kind, (byKind.get(kind) ?? 0) + n);
    }
    options.onPage?.(pages);
    if (!page.truncated) break;
    if (page.nextSequence <= cursor) {
      stopReason = "cursor";
      break;
    }
    cursor = page.nextSequence;
  }
  if (first === null) {
    // Only reachable with a page cap of 0: nothing was read, so nothing exists.
    const error = asCoreRequestError(new Error("no export page was read"));
    return { kind: "failed", error, copy: exportFailureCopy(error), pagesRead: 0 };
  }
  const complete = stopReason === null;
  const document: ConversationExportDocument = {
    format: CONVERSATION_EXPORT_FORMAT,
    exportedAt: first.exportedAt,
    conversation: first.conversation,
    messages,
    redaction: {
      bestEffort: true,
      replacements,
      byKind: Object.fromEntries(byKind),
    },
    complete,
    note: EXPORT_DOCUMENT_NOTE,
  };
  return { kind: "ready", document, json: exportJsonText(document), pages, complete, stopReason };
}

/**
 * Characters that render as nothing, reorder their neighbours, imitate a
 * space or split a line: DEL and C1, soft hyphen, ALM, Mongolian vowel
 * separator, zero-width and directional marks, line/paragraph separators,
 * bidi embeddings / overrides / isolates, word joiner and invisible
 * operators, BOM, interlinear annotation controls, the tag block, and the
 * non-ASCII spaces. (C0 controls never appear raw: `JSON.stringify` escapes
 * them inside strings.)
 */
const JSON_HIDDEN = new RegExp(
  "[\\u007f-\\u009f\\u00a0\\u00ad\\u061c\\u1680\\u180e\\u2000-\\u200f\\u2028-\\u202f" +
    "\\u205f-\\u2064\\u2066-\\u2069\\u3000\\ufeff\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}]",
  "gu",
);

function jsonEscape(unit: number): string {
  return `\\u${unit.toString(16).padStart(4, "0")}`;
}

/**
 * The export as JSON text: pretty-printed, with every hidden character
 * written as a JSON `\uXXXX` escape (an astral one as its surrogate pair).
 * The result is still valid JSON that parses to the same document, but no
 * viewer — the preview, a text editor, a chat window it is pasted into — can
 * be tricked by an invisible or direction-changing character in it.
 */
export function exportJsonText(document: ConversationExportDocument): string {
  return JSON.stringify(document, null, 2).replace(JSON_HIDDEN, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0xffff) return jsonEscape(code);
    const v = code - 0x10000;
    return jsonEscape(0xd800 + (v >> 10)) + jsonEscape(0xdc00 + (v & 0x3ff));
  });
}

export interface ExportPreview {
  /** The first lines, each revealed and capped. */
  lines: string[];
  /** Lines not shown (the Copy action still copies them). */
  hiddenLines: number;
  /** True when any shown line had hidden characters revealed as escapes. */
  revealed: boolean;
}

/** Default preview bounds: enough to review the shape, cheap to render. */
export const EXPORT_PREVIEW_MAX_LINES = 400;
export const EXPORT_PREVIEW_MAX_LINE_CHARS = 300;

/**
 * A size-capped, read-only preview of the export text. Revealed LINE BY LINE
 * (one `displayRevealed` over the whole text would escape the formatter's own
 * newlines), so a hidden character in a line can neither reorder it nor fake
 * another one.
 */
export function exportPreview(
  text: string,
  bounds: { maxLines?: number; maxLineChars?: number } = {},
): ExportPreview {
  const maxLines = bounds.maxLines ?? EXPORT_PREVIEW_MAX_LINES;
  const maxLineChars = bounds.maxLineChars ?? EXPORT_PREVIEW_MAX_LINE_CHARS;
  const all = text.split("\n");
  let revealed = false;
  const lines = all.slice(0, maxLines).map((line) => {
    const shown = displayRevealed(line, maxLineChars);
    if (shown.unusual) revealed = true;
    return shown.text;
  });
  return { lines, hiddenLines: Math.max(0, all.length - lines.length), revealed };
}

/** The part of `navigator.clipboard` the Copy action uses (injected in tests). */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export type ExportCopyState =
  | { kind: "not-copied" }
  | { kind: "copying" }
  | { kind: "copied" }
  | { kind: "copy-failed"; reason: string };

/**
 * Copy the FULL export text. A missing clipboard API or a rejected write is
 * reported as a failure with the browser's reason (revealed, capped) — never
 * as "copied". The text itself never appears in the result.
 */
export async function copyExportText(
  text: string,
  clipboard: ClipboardLike | undefined,
): Promise<ExportCopyState> {
  if (clipboard === undefined || typeof clipboard.writeText !== "function") {
    return {
      kind: "copy-failed",
      reason: "This webview exposes no clipboard API, so nothing was copied.",
    };
  }
  try {
    await clipboard.writeText(text);
    return { kind: "copied" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "the clipboard refused the write";
    return {
      kind: "copy-failed",
      reason: `The clipboard refused the copy (${displayRevealed(message, 200).text}); nothing was copied.`,
    };
  }
}

export type ConversationExportState =
  | { kind: "idle" }
  | { kind: "exporting"; conversationId: string; pagesRead: number }
  | {
      kind: "ready";
      conversationId: string;
      pages: number;
      complete: boolean;
      stopReason: ExportStopReason | null;
      replacements: number;
      byKind: Record<string, number>;
      messageCount: number;
      /** Length of the full text in UTF-16 units (shown as a size hint). */
      chars: number;
      preview: ExportPreview;
      copy: ExportCopyState;
    }
  | { kind: "failed"; conversationId: string; copy: FailureCopy; pagesRead: number };

export interface ConversationExportOptions {
  /** Where Copy writes. Default: `navigator.clipboard` when present. */
  clipboard?: () => ClipboardLike | undefined;
  pageCap?: number;
}

function defaultClipboard(): ClipboardLike | undefined {
  return typeof navigator !== "undefined" && navigator.clipboard !== undefined
    ? navigator.clipboard
    : undefined;
}

/**
 * One export at a time per view. The full JSON text is held HERE, privately —
 * never in observable state (which carries only the capped preview), never in
 * React Query, a store, a route, a log or a file. A new export, a reset or a
 * different conversation drops it.
 */
export class ConversationExportController {
  private state: ConversationExportState = { kind: "idle" };
  private readonly listeners = new Set<() => void>();
  private text: string | null = null;
  private inFlight: Promise<void> | null = null;
  private generation = 0;

  constructor(
    private readonly client: ExportPageClient,
    private readonly options: ConversationExportOptions = {},
  ) {}

  getState = (): ConversationExportState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Export `conversationId`. A second call while one runs joins it (single-flight). */
  start(conversationId: string): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const generation = ++this.generation;
    this.text = null;
    this.set({ kind: "exporting", conversationId, pagesRead: 0 });
    const run: Promise<void> = (async () => {
      const outcome = await collectConversationExport(this.client, conversationId, {
        ...(this.options.pageCap === undefined ? {} : { pageCap: this.options.pageCap }),
        onPage: (pagesRead) => {
          if (generation === this.generation) this.set({ kind: "exporting", conversationId, pagesRead });
        },
      });
      if (generation !== this.generation) return;
      if (outcome.kind === "failed") {
        this.set({ kind: "failed", conversationId, copy: outcome.copy, pagesRead: outcome.pagesRead });
        return;
      }
      this.text = outcome.json;
      this.set({
        kind: "ready",
        conversationId,
        pages: outcome.pages,
        complete: outcome.complete,
        stopReason: outcome.stopReason,
        replacements: outcome.document.redaction.replacements,
        byKind: outcome.document.redaction.byKind,
        messageCount: outcome.document.messages.length,
        chars: outcome.json.length,
        preview: exportPreview(outcome.json),
        copy: { kind: "not-copied" },
      });
    })().finally(() => {
      // A reset (or a newer export) may already have replaced it.
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  /** Copy the full text. Only from `ready`; returns whether it was copied. */
  async copy(): Promise<boolean> {
    const state = this.state;
    const text = this.text;
    if (state.kind !== "ready" || text === null || state.copy.kind === "copying") return false;
    const generation = this.generation;
    this.set({ ...state, copy: { kind: "copying" } });
    const clipboard = (this.options.clipboard ?? defaultClipboard)();
    const result = await copyExportText(text, clipboard);
    const current = this.state;
    if (generation !== this.generation || current.kind !== "ready") return false;
    this.set({ ...current, copy: result });
    return result.kind === "copied";
  }

  /** Drop the export (and its text). A running export's answer is discarded. */
  reset(): void {
    this.generation += 1;
    this.text = null;
    this.inFlight = null;
    this.set({ kind: "idle" });
  }

  private set(next: ConversationExportState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
