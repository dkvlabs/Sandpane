/**
 * A3b conversation lifecycle controls (design 2026-10-09 §3.3 item 9): rename,
 * archive / unarchive, delete through the A1 two-step confirmation dialog,
 * export (read-only preview + Copy — the desktop has no file save), and the
 * "sandbox chosen at creation" label. Every action is gated on `system.probe`
 * `methods`; on an archived conversation (or project) the actions Core
 * refuses are disabled with Core's own reason. After every write the
 * conversation lists are re-read from Core.
 *
 * Every Core string (title, impact line, sandbox name, preview line) is
 * rendered as React TEXT only, revealed and capped by the pure helpers.
 */

import { useEffect, useRef, useState } from "react";
import type { ConfirmationRequest, Conversation } from "../../lib/protocol";
import { useConversationAction } from "../../lib/hooks";
import {
  CONVERSATION_DELETE_FOOTNOTE,
  EXPORT_REVIEW_NOTICE,
  conversationArchivedLabel,
  conversationWriteBlock,
  isConversationArchived,
  planConversationRename,
  renamePrefill,
  type ConversationDeletionFlow,
  type ConversationDeletionState,
  type ConversationExportState,
  type ConversationLifecycleGates,
  type SandboxChosenView,
} from "../../lib/conversation-lifecycle";
import {
  confirmationView,
  gateBlockLabel,
  isExpired,
  parseExpiry,
  type ConfirmationView,
} from "../../lib/sandbox-lifecycle";
import { displayRevealed, type FeatureGate } from "../../lib/reducers";
import { Badge, Button, ConfirmDialog, Field, Mono, TextInput, Warning } from "../ui/primitives";
import { ErrorPanel } from "../../features/projects/ProjectsView";

/** The disabled reason for a control: unsupported/unprobed first, then Core's refusal. */
function blockFor(gate: FeatureGate, refusal: string | null): string | null {
  return gateBlockLabel(gate) ?? refusal;
}

/**
 * Rename, archive / unarchive and the entry to delete for ONE conversation.
 * `projectArchived` mirrors Core's check order: the project refusal comes
 * first. Delete opens Core's confirmation (rendered by the parent view, so the
 * dialog and its outcome survive the list re-read).
 */
export function ConversationActions({
  conversation,
  projectArchived,
  gates,
  deletion,
}: {
  conversation: Conversation;
  projectArchived: boolean;
  gates: ConversationLifecycleGates;
  deletion: { flow: ConversationDeletionFlow; state: ConversationDeletionState };
}) {
  const rename = useConversationAction();
  const toggle = useConversationAction();
  // A stored title Core would refuse (bidi / invisible / control characters)
  // is never put into the field raw: it starts empty, the title shown revealed.
  const prefill = renamePrefill(conversation.title);
  const [draft, setDraft] = useState(prefill.draft);
  // Core's stored title changed (this or another client renamed it): start
  // over from what Core now holds rather than keep a stale draft.
  useEffect(() => {
    setDraft(renamePrefill(conversation.title).draft);
  }, [conversation.id, conversation.title]);

  const archived = isConversationArchived(conversation);
  const renameBlocked = blockFor(gates.rename, conversationWriteBlock(conversation, projectArchived, "rename"));
  const toggleGate = archived ? gates.unarchive : gates.archive;
  const toggleBlocked = blockFor(
    toggleGate,
    conversationWriteBlock(conversation, projectArchived, archived ? "unarchive" : "archive"),
  );
  const deleteBlocked = gateBlockLabel(gates.delete);
  const plan = planConversationRename(conversation, draft);
  const canRename = renameBlocked === null && !rename.isPending && plan.title !== null;
  const { flow, state } = deletion;
  const deletingHere =
    (state.kind === "requesting" || state.kind === "deleting") && state.conversationId === conversation.id;

  return (
    <section className="stack" aria-label="Conversation settings">
      <p className="muted">
        <Mono>{displayRevealed(conversation.id, 200).text}</Mono>
        {archived && (
          <>
            {" "}
            <Badge tone="attention">{conversationArchivedLabel(conversation)}</Badge>
          </>
        )}
      </p>
      <form
        className="row-actions"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canRename || plan.title === null) return;
          rename.mutate({ kind: "rename", conversationId: conversation.id, title: plan.title });
        }}
      >
        <Field
          label="Title"
          error={plan.error ?? undefined}
          hint="One line, at most 200 characters; Core refuses control, separator and direction-changing characters, and a blank title."
        >
          {(id) => (
            <TextInput
              id={id}
              value={draft}
              disabled={renameBlocked !== null}
              invalid={plan.error !== null}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={!canRename} title={renameBlocked ?? undefined}>
          {rename.isPending ? "Renaming…" : "Rename"}
        </Button>
      </form>
      {prefill.storedRevealed !== null && (
        <p className="muted">
          The stored title contains characters Core refuses in a new title, so it is not copied into
          the field. Stored title (revealed): <Mono>{prefill.storedRevealed}</Mono>
        </p>
      )}
      {renameBlocked !== null && <p className="muted">Rename: {renameBlocked}</p>}
      {rename.isError && <ErrorPanel error={rename.error} />}
      <div className="row-actions">
        <Button
          disabled={toggleBlocked !== null || toggle.isPending}
          title={toggleBlocked ?? undefined}
          onClick={() =>
            toggle.mutate(
              archived
                ? { kind: "unarchive", conversationId: conversation.id }
                : { kind: "archive", conversationId: conversation.id },
            )
          }
        >
          {toggle.isPending ? "Working…" : archived ? "Unarchive" : "Archive"}
        </Button>
        <Button
          variant="danger"
          disabled={deleteBlocked !== null || flow.busy || state.kind === "confirming"}
          title={deleteBlocked ?? undefined}
          onClick={() => void flow.begin(conversation.id, conversation.projectId)}
        >
          {deletingHere ? "Asking Core…" : "Delete…"}
        </Button>
      </div>
      {toggleBlocked !== null && (
        <p className="muted">
          {archived ? "Unarchive" : "Archive"}: {toggleBlocked}
        </p>
      )}
      {deleteBlocked !== null && <p className="muted">Delete: {deleteBlocked}</p>}
      <p className="muted">
        {archived
          ? "Archived: Core refuses new messages and renames; its history and export stay readable, and running tasks keep running."
          : "Archiving is reversible and changes nothing outside Core. Deleting asks Core for a confirmation first."}
      </p>
      {toggle.isError && <ErrorPanel error={toggle.error} />}
    </section>
  );
}

/** "Sandbox chosen at creation": a stored NAME, with its caveat — never a binding. */
export function SandboxChosenLabel({ view }: { view: SandboxChosenView | null }) {
  if (view === null) return null;
  return (
    <p className="muted">
      sandbox chosen at creation: <Mono>{view.text}</Mono> — {view.note}
    </p>
  );
}

/**
 * Outcome notices for the delete flow, rendered at VIEW level so they survive
 * the list re-read that drops a deleted conversation's tab.
 */
export function ConversationDeletionNotices({
  state,
  flow,
}: {
  state: ConversationDeletionState;
  flow: ConversationDeletionFlow;
}) {
  if (state.kind === "deleted") {
    return (
      <Warning tone="success" title="Conversation deleted in Core">
        Core answered <Mono>deleted: true</Mono> for{" "}
        <Mono>{displayRevealed(state.target.name, 200).text}</Mono> (
        <Mono>{displayRevealed(state.target.id, 200).text}</Mono>). Host files, worktrees, branches
        and sandboxes were not touched.{" "}
        <Button variant="ghost" onClick={() => flow.reset()}>
          Dismiss
        </Button>
      </Warning>
    );
  }
  if (state.kind === "gone") {
    return (
      <Warning tone="attention" title="Core no longer lists this conversation">
        The answer to the confirmation was lost, but a re-read of the project's conversations
        (archived included) no longer contains{" "}
        <Mono>{displayRevealed(state.target.name, 200).text}</Mono> (
        <Mono>{displayRevealed(state.target.id, 200).text}</Mono>), so this window has forgotten it.
        A conversation delete never touches host files, worktrees, branches or sandboxes.{" "}
        <Button variant="ghost" onClick={() => flow.reset()}>
          Dismiss
        </Button>
      </Warning>
    );
  }
  if (state.kind === "failed") {
    return (
      <Warning tone={state.outcomeUnknown ? "danger" : "attention"} title={state.copy.title}>
        <p>{state.copy.body}</p>
        {state.copy.coreMessage !== undefined && (
          <p>
            <strong>Core said:</strong> <Mono>{state.copy.coreMessage}</Mono>
          </p>
        )}
        <p>
          <strong>What you can do:</strong> {state.copy.action}
        </p>
        <Button variant="ghost" onClick={() => flow.reset()}>
          Dismiss
        </Button>
      </Warning>
    );
  }
  return null;
}

/** The step-2 dialog: Core's confirmation, Cancel by default, expiry re-checked at click. */
export function ConversationDeleteDialog({
  confirmation,
  flow,
}: {
  confirmation: ConfirmationRequest;
  flow: ConversationDeletionFlow;
}) {
  const [now, setNow] = useState(() => Date.now());
  const clicked = useRef(false);

  useEffect(() => {
    clicked.current = false;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [confirmation]);

  const view = confirmationView(confirmation, now);

  return (
    <ConfirmDialog
      open
      title="Delete this conversation?"
      consequence={<ConversationDeleteConsequence view={view} />}
      confirmLabel="Delete conversation"
      confirmDisabled={view.expired || clicked.current}
      onCancel={() => flow.cancel()}
      onConfirm={() => {
        if (clicked.current) return;
        if (isExpired(parseExpiry(confirmation.expiresAt), Date.now())) {
          setNow(Date.now());
          flow.confirm(); // records the expiry; sends nothing
          return;
        }
        clicked.current = true;
        flow.confirm();
      }}
    />
  );
}

/**
 * Everything Core said about the deletion, as React TEXT only. Untrusted
 * strings arrive revealed and capped by `confirmationView` (impact capped at
 * 20 lines, the rest disclosed). A conversation confirmation is never
 * `external` (the decoder refuses one that is), so there is no external
 * banner. Exported for the markup tests.
 */
export function ConversationDeleteConsequence({ view }: { view: ConfirmationView }) {
  return (
    <div className="stack">
      <dl className="kvs">
        <div className="kv">
          <dt>conversation</dt>
          <dd>
            <Mono>{view.targetName}</Mono>
          </dd>
        </div>
        <div className="kv">
          <dt>conversation id</dt>
          <dd>
            <Mono>{view.targetId}</Mono>
          </dd>
        </div>
        <div className="kv">
          <dt>confirmation expires</dt>
          <dd>
            <Mono>{view.expiresAtText}</Mono>{" "}
            {view.expired
              ? "— EXPIRED. Cancel and request a new confirmation."
              : `(${view.secondsLeft} s left)`}
          </dd>
        </div>
      </dl>
      <p>
        <strong>What Core says this deletion does:</strong>
      </p>
      {view.impactLines.length === 0 ? (
        <p>Core listed no impact lines.</p>
      ) : (
        <ul className="removal-impact">
          {view.impactLines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      {view.overflowLine !== null && <p className="removal-impact__overflow">{view.overflowLine}</p>}
      {view.revealedHiddenCharacters && (
        <p className="removal-impact__overflow">
          Some text above contained hidden, control or direction-changing characters; they are shown
          as <Mono>{"\\u"}</Mono> escapes instead of being applied.
        </p>
      )}
      <p>{CONVERSATION_DELETE_FOOTNOTE}</p>
    </div>
  );
}

const STOP_REASON_COPY = {
  cursor:
    "Core's paging cursor stopped advancing, so the export stopped there rather than loop.",
  "page-cap": "The export reached this desktop's limit of 200 pages and stopped there.",
} as const;

/**
 * The export surface. There is NO save-to-file on the desktop (it would need
 * `@tauri-apps/plugin-dialog`, which this build does not ship): the redacted
 * JSON is shown read-only as a capped preview, and Copy copies the full text.
 * The review notice is shown before and after; the export is never called
 * secret-free.
 */
export function ConversationExportPanel({
  gate,
  state,
  onStart,
  onCopy,
  onDismiss,
}: {
  gate: FeatureGate;
  state: ConversationExportState;
  onStart: () => void;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  const blocked = gateBlockLabel(gate);
  const busy = state.kind === "exporting";
  return (
    <section className="stack" aria-label="Export">
      <p className="muted">
        {EXPORT_REVIEW_NOTICE} Core redacts tokens, keys and credentials it recognizes; host names
        and paths are not redacted. Only the conversation and its messages are exported — task
        events, artifacts and verification output are not.
      </p>
      <p className="muted">
        Save to file is not available in this build (it needs the Tauri dialog plugin, which is not
        shipped); the export is shown below read-only, and Copy puts the full text on the clipboard.
      </p>
      <div className="row-actions">
        <Button disabled={blocked !== null || busy} title={blocked ?? undefined} onClick={onStart}>
          {busy ? "Exporting…" : state.kind === "ready" ? "Export again" : "Export…"}
        </Button>
        {blocked !== null && <span className="muted">{blocked}</span>}
        {(state.kind === "ready" || state.kind === "failed") && (
          <Button variant="ghost" onClick={onDismiss}>
            Close export
          </Button>
        )}
      </div>
      {state.kind === "exporting" && (
        <p className="muted" role="status">
          Reading redacted pages from Core… {state.pagesRead} page(s) so far.
        </p>
      )}
      {state.kind === "failed" && (
        <Warning tone="danger" title={state.copy.title}>
          <p>{state.copy.body}</p>
          <p>
            <strong>What you can do:</strong> {state.copy.action}
          </p>
        </Warning>
      )}
      {state.kind === "ready" && <ExportReady state={state} onCopy={onCopy} />}
    </section>
  );
}

function ExportReady({
  state,
  onCopy,
}: {
  state: Extract<ConversationExportState, { kind: "ready" }>;
  onCopy: () => void;
}) {
  const kinds = Object.entries(state.byKind);
  return (
    <div className="stack">
      <Warning
        tone={state.complete ? "info" : "attention"}
        title={
          state.complete
            ? "Export ready (complete)"
            : "PARTIAL export — not the whole conversation"
        }
      >
        <p>
          {state.messageCount} message(s) from {state.pages} page(s);{" "}
          <strong>
            {state.replacements} replacement{state.replacements === 1 ? "" : "s"}
          </strong>{" "}
          by Core's best-effort redaction
          {kinds.length > 0
            ? ` (${kinds
                .map(([kind, n]) => `${displayRevealed(kind, 64).text}: ${n}`)
                .join(", ")})`
            : ""}
          .
        </p>
        {!state.complete && state.stopReason !== null && <p>{STOP_REASON_COPY[state.stopReason]}</p>}
        <p>{EXPORT_REVIEW_NOTICE}</p>
      </Warning>
      <pre className="export-preview" aria-label="Export preview (read-only)">
        {state.preview.lines.join("\n")}
      </pre>
      {state.preview.hiddenLines > 0 && (
        <p className="muted">
          …{state.preview.hiddenLines} more lines are not shown here; Copy copies the full text (
          {state.chars} characters).
        </p>
      )}
      {state.preview.revealed && (
        <p className="muted">
          Some preview lines contained hidden or direction-changing characters; they are shown as{" "}
          <Mono>{"\\u"}</Mono> escapes.
        </p>
      )}
      <div className="row-actions">
        <Button variant="primary" disabled={state.copy.kind === "copying"} onClick={onCopy}>
          {state.copy.kind === "copying" ? "Copying…" : "Copy"}
        </Button>
        {state.copy.kind === "copied" && (
          <span className="muted" role="status">
            Copied the full export to the clipboard. {EXPORT_REVIEW_NOTICE}
          </span>
        )}
      </div>
      {state.copy.kind === "copy-failed" && (
        <Warning tone="danger" title="Copy failed — nothing was copied">
          {state.copy.reason}
        </Warning>
      )}
    </div>
  );
}
