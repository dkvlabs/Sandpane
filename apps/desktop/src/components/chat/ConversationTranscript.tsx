import { useConversationHistory } from "../../lib/hooks";
import { Badge, Button, EmptyState, Mono, Panel, Warning } from "../ui/primitives";
import { FeatureGateNotice } from "../ui/feature-gate";
import { ErrorPanel } from "../../features/projects/ProjectsView";

/**
 * Stored transcript for one conversation, read through `conversation.history`.
 *
 * This is Core's stored `messages` table — the text the user and the agent
 * actually exchanged — and it is bounded twice over by Core (rows per page and a
 * byte ceiling). Two honesty rules drive the rendering:
 *
 * 1. Content is DATA. Nothing here interprets a stored string as a command or
 *    re-executes it (AGENTS rule 1).
 * 2. A truncated page is labelled as truncated. `truncated` is Core's own
 *    disclosure, so the panel cannot present a partial transcript as the whole
 *    conversation, and "Load more" is the only way paging advances.
 */
export function ConversationTranscript({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const { transcript, gate, isLoading, error, loadMore } =
    useConversationHistory(conversationId);

  if (conversationId === null) {
    return (
      <EmptyState
        heading="No conversation selected"
        body="Pick a chat tab to read the messages Core has stored for it."
      />
    );
  }

  return (
    <Panel
      title="Stored transcript"
      description={`conversation.history reads Core's stored messages for this chat, oldest first. ${
        transcript.pages > 0 ? `${transcript.pages} bounded page(s) fetched.` : ""
      }`}
      actions={
        transcript.truncated ? (
          <Badge tone="attention" title="Core stopped a page at its row or byte bound">
            truncated by Core
          </Badge>
        ) : (
          <Badge tone="neutral">{transcript.entries.length} message(s)</Badge>
        )
      }
    >
      <FeatureGateNotice gate={gate} title="Transcript from Core" />

      {error !== null && <ErrorPanel error={error} />}

      {isLoading && error === null && <p className="muted">Reading transcript from Core…</p>}

      {!isLoading && transcript.entries.length === 0 && error === null && (
        <p className="muted">
          Core returned no stored messages for this conversation yet. The live timeline below is
          built from task events, which are a different record.
        </p>
      )}

      {transcript.entries.length > 0 && (
        <ol className="list">
          {transcript.entries.map((message) => (
            <li key={message.id} className="row">
              <span className="row__title">
                <Badge tone={message.role === "user" ? "info" : "neutral"}>{message.role}</Badge>{" "}
                {message.content}
              </span>
              <span className="row__meta">
                seq <Mono>{message.sequence}</Mono> · <Mono>{message.id.slice(0, 8)}</Mono>
              </span>
            </li>
          ))}
        </ol>
      )}

      {transcript.truncated && (
        <Warning tone="attention" title="This transcript is not complete">
          {transcript.notice}{" "}
          <Button variant="ghost" onClick={loadMore}>
            Load the next page
          </Button>
          .
        </Warning>
      )}
    </Panel>
  );
}
