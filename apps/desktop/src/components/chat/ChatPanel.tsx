import { useEffect, useMemo, useState } from "react";
import {
  capabilitiesOf,
  useConversationDeletionFlow,
  useConversationExport,
  useConversationLifecycleGates,
  useCoreConversations,
  useCoreLink,
  useCreateConversation,
  useSandboxes,
  useSessionConversations,
  useKeyedSend,
} from "../../lib/hooks";
import {
  conversationArchivedLabel,
  conversationCreateTitle,
  conversationWriteBlock,
  isConversationArchived,
  mergeConversationRows,
  sandboxChosenAtCreation,
} from "../../lib/conversation-lifecycle";
import { displayRevealed } from "../../lib/reducers";
import { validateConversationTitle } from "../../lib/wizard";
import {
  ConversationActions,
  ConversationDeleteDialog,
  ConversationDeletionNotices,
  ConversationExportPanel,
  SandboxChosenLabel,
} from "./ConversationLifecycle";
import { clearSentDraft, foldAgentView, taskStatusView, withDraft } from "../../lib/reducers";
import type { Conversation } from "../../lib/protocol";
import { ConversationTranscript } from "./ConversationTranscript";
import { FeatureChip } from "../ui/feature-gate";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Mono,
  Panel,
  TextInput,
  Warning,
} from "../ui/primitives";
import { ErrorPanel } from "../../features/projects/ProjectsView";
import {
  REPLAY_NOTICE,
  REPLAY_UNCERTAIN_NOTICE,
  forNewAction,
  idempotencyKeysAdvertised,
} from "../../lib/idempotency";
import { KeyedWriteFailure } from "../ui/keyed-write";

/**
 * Chat tab list + composer for one project.
 *
 * Tabs come from `conversation.list` (ADDITIVE v1) when this Core advertises it,
 * so a chat started in VS Code or JetBrains reopens here exactly as it is stored
 * in the shared Core database. When the method is not advertised the panel says
 * so and falls back to what this window created — it never implies the local
 * list is complete. Either way a message is inert text that Core turns into a
 * task, and the desktop never renders a reply it did not receive as an event.
 */
export function ChatPanel({
  projectId,
  selectedConversationId,
  onSelectConversation,
  onConversationGone,
  archivedReason = null,
}: {
  projectId: string;
  selectedConversationId: string | null;
  onSelectConversation: (id: string) => void;
  /**
   * A3b: Core no longer has the open conversation (deleted, or gone after an
   * unknown outcome): leave it, so the route stops naming a deleted chat.
   */
  onConversationGone?: () => void;
  /**
   * A3a: set when Core reports this project archived. New chats and sends are
   * disabled with Core's reason (Core refuses both); reading stays available.
   */
  archivedReason?: string | null;
}) {
  const link = useCoreLink();
  const capabilities = capabilitiesOf(link);
  const session = useSessionConversations();
  const lifecycle = useConversationLifecycleGates();
  // A3b "show archived": only a Core advertising conversation.archive is asked.
  const [showArchivedChoice, setShowArchived] = useState(false);
  const showArchived = showArchivedChoice && lifecycle.showArchived.state === "supported";
  const coreChats = useCoreConversations(projectId, true, showArchived);
  const conversations: Conversation[] = useMemo(
    () =>
      mergeConversationRows(coreChats.conversations, session, { projectId, showArchived }).map(
        (row) => row.conversation,
      ),
    [coreChats.conversations, session, projectId, showArchived],
  );
  const deletion = useConversationDeletionFlow({
    selectedConversationId,
    onClearSelection: () => onConversationGone?.(),
  });
  const { controller: exporter, state: exportState } = useConversationExport();
  const createConversation = useCreateConversation();
  const { write: sendWrite, state: send } = useKeyedSend();
  const keysAdvertised = idempotencyKeysAdvertised(capabilities);

  const agents = capabilities?.agents ?? [];
  const [agentId, setAgentId] = useState<string>("");
  const [title, setTitle] = useState("");
  // A new chat's title is the user's own field, checked with Core's rule; a
  // blank one is sent as "" so Core stores its "Untitled conversation".
  const createTitle = conversationCreateTitle(title);
  const titleError = validateConversationTitle(createTitle, "create");
  // One draft per conversation: switching tabs never carries text into
  // another chat, and switching back restores what was typed there.
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  // Clear the draft of the chat that was SENT once Core accepted it (a first
  // send or an explicit Retry safely), and only if it still holds the sent
  // text — the user may have kept typing.
  useEffect(() => {
    if (send.kind !== "succeeded") return;
    const { conversationId, content } = send.params;
    setDrafts((current) => clearSentDraft(current, conversationId, content));
  }, [send]);
  // An export belongs to one conversation: switching drops it (and its text).
  useEffect(() => {
    exporter.reset();
  }, [exporter, selectedConversationId]);
  const selectedSandboxId =
    conversations.find((c) => c.id === selectedConversationId)?.sandboxId ?? null;
  // `sandbox.list` is read only to place a stored sandbox name; never otherwise.
  const sandboxList = useSandboxes(
    link.kind === "attached" && lifecycle.sandboxIdPersisted === true && selectedSandboxId !== null,
  );

  if (link.kind !== "attached") {
    return (
      <EmptyState
        variant="offline"
        heading="Chat needs a live Core"
        body="Messages become tasks in Core's durable log. While the link is down the composer stays disabled instead of queuing locally and pretending to send."
      />
    );
  }

  const effectiveAgent = agentId || agents[0]?.id || "";
  const selected: Conversation | null =
    conversations.find((c) => c.id === selectedConversationId) ?? null;
  const draft = selected === null ? "" : (drafts[selected.id] ?? "");
  // The single send mutation outlives tab switches; its result is shown only
  // under the conversation it was actually sent from.
  const sendIsForSelected =
    selected !== null && send.kind !== "idle" && send.params.conversationId === selected.id;
  const sending = send.kind === "sending";
  // Core's check order: the archived PROJECT first, then the archived chat.
  const sendBlocked =
    archivedReason ?? (selected === null ? null : conversationWriteBlock(selected, false, "send"));
  const sandboxView =
    selected === null
      ? null
      : sandboxChosenAtCreation(
          selected,
          lifecycle.sandboxIdPersisted,
          sandboxList.loaded && sandboxList.error === null
            ? sandboxList.sandboxes.map((s) => s.name)
            : null,
        );
  const panelExportState =
    exportState.kind !== "idle" && selected !== null && exportState.conversationId === selected.id
      ? exportState
      : ({ kind: "idle" } as const);

  return (
    <Panel
      title="Conversations"
      description={
        coreChats.gate.state === "supported"
          ? "Tabs are the conversations Core holds for this project (conversation.list), plus any created in this window since the last read."
          : "Core has not answered conversation.list, so these are only the conversations this window created — not the project's whole chat history."
      }
      actions={
        <div className="row-actions">
          <FeatureChip gate={coreChats.gate} method="conversation.list" />
          <label className="row-actions" title={lifecycle.showArchived.note}>
            <input
              type="checkbox"
              checked={showArchived}
              disabled={lifecycle.showArchived.state !== "supported"}
              onChange={(event) => setShowArchived(event.target.checked)}
            />{" "}
            Show archived
          </label>
          <Button
          variant="primary"
          disabled={
            archivedReason !== null ||
            titleError !== null ||
            agents.length === 0 ||
            effectiveAgent.length === 0 ||
            createConversation.isPending
          }
          title={archivedReason ?? undefined}
          onClick={() =>
            createConversation.mutate({
              projectId,
              agentId: effectiveAgent,
              title: createTitle,
            })
          }
        >
          New chat
        </Button>
        </div>
      }
    >
      {archivedReason !== null && <p className="muted">{archivedReason}</p>}
      {lifecycle.showArchived.state === "unsupported" && (
        <p className="muted">{lifecycle.showArchived.note}</p>
      )}
      <ConversationDeletionNotices state={deletion.state} flow={deletion.flow} />
      {deletion.state.kind === "confirming" && (
        <ConversationDeleteDialog confirmation={deletion.state.confirmation} flow={deletion.flow} />
      )}
      {agents.length === 0 && (
        <Warning tone="danger" title="Core reported no agent adapters">
          No <Mono>agents</Mono> capability came back from <Mono>system.probe</Mono>, so a chat
          cannot be created. Build/enable an adapter in Core first.
        </Warning>
      )}

      <div className="row-actions">
        <Field label="Conversation title (optional)" error={titleError ?? undefined}>
          {(id) => (
            <TextInput
              id={id}
              value={title}
              invalid={titleError !== null}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Untitled conversation"
            />
          )}
        </Field>
        <Field label="Agent">
          {(id) => (
            <select
              id={id}
              className="input"
              value={effectiveAgent}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {agents.map((cap) => {
                const view = foldAgentView(cap);
                return (
                  <option key={cap.id} value={cap.id}>
                    {view.id} — {view.verified ? "verified" : "NOT verified"}
                  </option>
                );
              })}
            </select>
          )}
        </Field>
      </div>

      {agents.length > 0 &&
        !foldAgentView(agents.find((a) => a.id === effectiveAgent) ?? agents[0]).usable && (
          <Warning tone="attention" title="Adapter not verified in this Core build">
            Sending creates a task that stays <Mono>queued</Mono>: Core records{" "}
            <Mono>adapter.unavailable</Mono> rather than launching an unverified agent. The UI
            shows that event instead of a spinner.
          </Warning>
        )}

      {createConversation.isError && <ErrorPanel error={createConversation.error} />}

      {conversations.length === 0 ? (
        <EmptyState
          heading="No chats for this project yet"
          body="Use New chat above. Each conversation is stored in the shared Core SQLite database, so the same chat is visible from VS Code and JetBrains."
        />
      ) : (
        <div className="tabstrip" role="tablist" aria-label="Conversations">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              role="tab"
              aria-selected={conversation.id === selected?.id}
              className={`tab${conversation.id === selected?.id ? " tab--active" : ""}`}
              onClick={() => onSelectConversation(conversation.id)}
            >
              {displayRevealed(conversation.title, 200).text}
              <span className="tab__meta">
                {conversation.agentId}
                {isConversationArchived(conversation) && (
                  <>
                    {" "}
                    <Badge tone="attention">{conversationArchivedLabel(conversation)}</Badge>
                  </>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected !== null && (
        <details className="stack">
          <summary>Conversation settings — rename, archive, delete, export</summary>
          <SandboxChosenLabel view={sandboxView} />
          <ConversationActions
            conversation={selected}
            projectArchived={archivedReason !== null}
            gates={lifecycle}
            deletion={deletion}
          />
          <ConversationExportPanel
            gate={lifecycle.export}
            state={panelExportState}
            onStart={() => {
              // One export at a time; another chat's running export is not joined.
              if (exportState.kind === "exporting") return;
              void exporter.start(selected.id);
            }}
            onCopy={() => void exporter.copy()}
            onDismiss={() => exporter.reset()}
          />
        </details>
      )}

      {selected !== null && <ConversationTranscript conversationId={selected.id} />}

      {selected !== null && (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim().length === 0 || sending || sendBlocked !== null) return;
            const conversationId = selected.id;
            const content = draft;
            // One Send = one user action = one fresh key (A2), and no key at all
            // when this Core does not advertise the feature.
            void sendWrite.submit(forNewAction({ conversationId, content }, keysAdvertised));
          }}
        >
          <label className="field">
            <span className="field__label">Message</span>
            <textarea
              className="input input--multiline"
              rows={3}
              value={draft}
              placeholder="Content is data, never a command — Core validates and stores it."
              onChange={(event) => {
                const conversationId = selected.id;
                const text = event.target.value;
                setDrafts((current) => withDraft(current, conversationId, text));
              }}
            />
          </label>
          <div className="row-actions">
            <Button
              variant="primary"
              type="submit"
              disabled={sendBlocked !== null || draft.trim().length === 0 || sending}
              title={sendBlocked ?? undefined}
            >
              Send
            </Button>
            <span className="muted">
              Creates a task in Core (conversation.send). Closing this tab never cancels it.
            </span>
          </div>
          {sendBlocked !== null && archivedReason === null && <p className="muted">{sendBlocked}</p>}
          {sendIsForSelected && send.kind === "sending" && send.retry && (
            <p className="muted" role="status">
              Retrying safely — re-checking Core, then resending the identical message with the same
              key…
            </p>
          )}
          {sendIsForSelected && send.kind === "failed" && (
            <KeyedWriteFailure state={send} write={sendWrite} />
          )}
          {sendIsForSelected &&
            send.kind === "succeeded" &&
            (send.result.replayed === true || send.result.replayedUncertain === true) && (
              // A replay is the task as FIRST created — its status is not current,
              // so none is shown; task.list and the history are being re-read.
              <Warning tone="attention" title="Replayed result">
                {send.result.replayed === true
                  ? REPLAY_NOTICE
                  : REPLAY_UNCERTAIN_NOTICE}{" "}
                Task <Mono>{send.result.id.slice(0, 8)}</Mono>; see the timeline for its current
                state.
              </Warning>
            )}
          {sendIsForSelected &&
            send.kind === "succeeded" &&
            send.result.replayed !== true &&
            send.result.replayedUncertain !== true && (
              <Warning tone="info" title="Task accepted by Core">
                <Mono>{send.result.id.slice(0, 8)}</Mono> · status{" "}
                <Mono>
                  {taskStatusView(send.result.status, send.result.unrecognizedStatus).label}
                </Mono>
                . The timeline below is the only place progress is reported, from durable events.
              </Warning>
            )}
        </form>
      )}
    </Panel>
  );
}
