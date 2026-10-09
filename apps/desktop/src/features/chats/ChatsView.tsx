import {
  useCoreLink,
  useProjects,
  useSessionConversations,
} from "../../lib/hooks";
import { AppShell, ViewHeader } from "../../components/layout/AppShell";
import {
  ConnectionBanner,
  ConnectionChip,
} from "../../components/layout/ConnectionState";
import { ProjectSidebar } from "../../components/project/ProjectSidebar";
import {
  Badge,
  Button,
  EmptyState,
  Mono,
  Panel,
  Warning,
} from "../../components/ui/primitives";
import { navigate, type Route, useRoute } from "../../app/router";
import { useProbeRefetch } from "../../components/ui/refresh";
import { IconRefresh } from "../../components/layout/icons";

/**
 * Chats index.
 *
 * The IA demands a Chats destination, and protocol v1 gives it no read method:
 * there is no `conversation.list`, no message history query and no archive or
 * export RPC. So this view lists what this window legitimately knows (the
 * conversations it created) and states the gap, rather than showing sample chats
 * from the design mockups.
 */
export function ChatsView({ route }: { route: Route }) {
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  const conversations = useSessionConversations();
  const current = useRoute();

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={
        <span className="statusbar__counts">
          {conversations.length} conversation(s) created in this window
        </span>
      }
    >
      <ViewHeader
        title="Chats"
        subtitle="Copilot-style streaming with tabs, agent/sandbox/branch context and the task-event timeline — opened inside its project workspace."
        actions={
          <>
            <Button onClick={refetch}>
              <IconRefresh /> Re-check Core
            </Button>
            <Button variant="primary" onClick={() => navigate("projects")} disabled={projects.length === 0}>
              New chat in a project
            </Button>
          </>
        }
      />
      <ConnectionBanner link={link} onRetry={refetch} />

      <Panel title="Conversations this window created">
        {conversations.length === 0 ? (
          <EmptyState
            heading="No conversations in this window"
            body={
              link.kind === "attached"
                ? "Open a project workspace and use New chat. Conversations are stored in the shared Core SQLite store, so a chat started in VS Code is the same chat — this desktop just cannot enumerate them yet."
                : "Core is unreachable, so nothing can be created or read."
            }
          />
        ) : (
          <ul className="list">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  className={`row row--selectable${
                    current.params.conversationId === conversation.id ? " row--active" : ""
                  }`}
                  onClick={() =>
                    navigate("conversation", {
                      projectId: conversation.projectId,
                      conversationId: conversation.id,
                    })
                  }
                >
                  <span className="row__title">{conversation.title}</span>
                  <span className="row__meta">
                    <Badge tone="neutral">agent {conversation.agentId}</Badge> ·{" "}
                    <Mono>{conversation.id.slice(0, 8)}</Mono> · {conversation.createdAt}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Warning tone="neutral" title="What protocol v1 cannot do yet">
        <ul className="bullets">
          <li>
            <Mono>conversation.list</Mono> / message history — chat tabs and cross-client history
            stay local to this window (DT1).
          </li>
          <li>
            Search and archive of Sandpane-owned history, plus export on request (specs/05 §3.A) —
            no Core method exists, so no UI is faked.
          </li>
          <li>
            Provider session recovery: only <Mono>system.probe</Mono> <Mono>agents[]</Mono>{" "}
            capabilities are shown, and <Mono>supportsResume</Mono> is advertised by Core only
            after restart tests pass.
          </li>
        </ul>
      </Warning>
    </AppShell>
  );
}
