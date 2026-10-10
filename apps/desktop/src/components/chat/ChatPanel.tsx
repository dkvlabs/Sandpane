import { useEffect, useMemo, useState } from "react";
import {
  capabilitiesOf,
  useCoreConversations,
  useCoreLink,
  useCreateConversation,
  useSessionConversations,
  useKeyedSend,
} from "../../lib/hooks";
import { clearSentDraft, foldAgentView, taskStatusView, withDraft } from "../../lib/reducers";
import type { Conversation } from "../../lib/protocol";
import { ConversationTranscript } from "./ConversationTranscript";
import { FeatureChip } from "../ui/feature-gate";
import {
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
}: {
  projectId: string;
  selectedConversationId: string | null;
  onSelectConversation: (id: string) => void;
}) {
  const link = useCoreLink();
  const capabilities = capabilitiesOf(link);
  const session = useSessionConversations();
  const coreChats = useCoreConversations(projectId);
  const conversations: Conversation[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Conversation[] = [];
    for (const c of [...coreChats.conversations, ...session]) {
      if (c.projectId !== projectId || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  }, [coreChats.conversations, session, projectId]);
  const createConversation = useCreateConversation();
  const { write: sendWrite, state: send } = useKeyedSend();
  const keysAdvertised = idempotencyKeysAdvertised(capabilities);

  const agents = capabilities?.agents ?? [];
  const [agentId, setAgentId] = useState<string>("");
  const [title, setTitle] = useState("");
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
          <Button
          variant="primary"
          disabled={
            agents.length === 0 ||
            effectiveAgent.length === 0 ||
            createConversation.isPending
          }
          onClick={() =>
            createConversation.mutate({
              projectId,
              agentId: effectiveAgent,
              title: title.trim().length > 0 ? title.trim() : "Untitled chat",
            })
          }
        >
          New chat
        </Button>
        </div>
      }
    >
      {agents.length === 0 && (
        <Warning tone="danger" title="Core reported no agent adapters">
          No <Mono>agents</Mono> capability came back from <Mono>system.probe</Mono>, so a chat
          cannot be created. Build/enable an adapter in Core first.
        </Warning>
      )}

      <div className="row-actions">
        <Field label="Conversation title (optional)">
          {(id) => (
            <TextInput
              id={id}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Untitled chat"
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
              {conversation.title}
              <span className="tab__meta">{conversation.agentId}</span>
            </button>
          ))}
        </div>
      )}

      {selected !== null && <ConversationTranscript conversationId={selected.id} />}

      {selected !== null && (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim().length === 0 || sending) return;
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
              disabled={draft.trim().length === 0 || sending}
            >
              Send
            </Button>
            <span className="muted">
              Creates a task in Core (conversation.send). Closing this tab never cancels it.
            </span>
          </div>
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
