import { useState } from "react";
import {
  capabilitiesOf,
  useCoreLink,
  useCreateConversation,
  useSessionConversations,
  useSendMessage,
} from "../../lib/hooks";
import { foldAgentView } from "../../lib/reducers";
import type { Conversation } from "../../lib/protocol";
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

/**
 * Chat tab list + composer for one project.
 *
 * Two protocol realities shape this component and are shown rather than hidden:
 * `conversation.list` does not exist in v1, so tabs can only cover conversations
 * this window created; and a message is inert text that Core turns into a task —
 * the desktop never renders a reply it did not receive as an event.
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
  const conversations = useSessionConversations().filter(
    (c) => c.projectId === projectId,
  );
  const createConversation = useCreateConversation();
  const send = useSendMessage(selectedConversationId);

  const agents = capabilities?.agents ?? [];
  const [agentId, setAgentId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");

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

  return (
    <Panel
      title="Conversations"
      description="Tabs here are conversations this window created. Core exposes no conversation.list in protocol v1, so older history from other clients is not invented — it appears once that read method lands (DT1)."
      actions={
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

      {selected !== null && (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim().length === 0 || send.isPending) return;
            send.mutate(draft, {
              onSuccess: () => setDraft(""),
            });
          }}
        >
          <label className="field">
            <span className="field__label">Message</span>
            <textarea
              className="input input--multiline"
              rows={3}
              value={draft}
              placeholder="Content is data, never a command — Core validates and stores it."
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className="row-actions">
            <Button variant="primary" type="submit" disabled={draft.trim().length === 0}>
              Send
            </Button>
            <span className="muted">
              Creates a task in Core (conversation.send). Closing this tab never cancels it.
            </span>
          </div>
          {send.isError && <ErrorPanel error={send.error} />}
          {send.isSuccess && (
            <Warning tone="info" title="Task accepted by Core">
              <Mono>{send.data.id.slice(0, 8)}</Mono> · status <Mono>{send.data.status}</Mono>. The
              timeline below is the only place progress is reported, from durable events.
            </Warning>
          )}
        </form>
      )}
    </Panel>
  );
}
