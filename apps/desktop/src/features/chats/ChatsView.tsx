import { useMemo } from "react";
import {
  useCoreConversations,
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
import { FeatureChip, FeatureGateNotice } from "../../components/ui/feature-gate";
import { navigate, type Route, useRoute } from "../../app/router";
import { useProbeRefetch } from "../../components/ui/refresh";
import { IconRefresh } from "../../components/layout/icons";
import type { Conversation } from "../../lib/protocol";

/**
 * Chats index.
 *
 * `conversation.list` (ADDITIVE v1) makes the real cross-client list possible:
 * Core holds every non-archived conversation, including chats started in VS Code
 * or JetBrains. Support is still probed rather than assumed — a Core that does
 * not advertise the method falls back to the conversations this window created,
 * and the view says which of the two it is showing. Message history comes from
 * `conversation.history` inside the workspace, not from a local cache.
 */
export function ChatsView({ route }: { route: Route }) {
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  const session = useSessionConversations();
  const core = useCoreConversations(null);
  const current = useRoute();

  const rows: (Conversation & { fromCore: boolean })[] = useMemo(() => {
    const seen = new Set<string>();
    const out: (Conversation & { fromCore: boolean })[] = [];
    // Core's list wins; the local list only adds rows Core has not returned yet
    // (a conversation created seconds ago, before the next read).
    for (const conversation of core.conversations) {
      if (seen.has(conversation.id)) continue;
      seen.add(conversation.id);
      out.push({ ...conversation, fromCore: true });
    }
    for (const conversation of session) {
      if (seen.has(conversation.id)) continue;
      seen.add(conversation.id);
      out.push({ ...conversation, fromCore: false });
    }
    return out;
  }, [core.conversations, session]);

  const projectName = (projectId: string): string =>
    projects.find((p) => p.id === projectId)?.name ?? "unknown project";

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={
        <span className="statusbar__counts">
          {rows.length} conversation(s) ·{" "}
          {core.gate.state === "supported"
            ? "read from Core"
            : core.gate.state === "unprobed"
              ? "Core not probed yet"
              : "this window only"}
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
            <Button
              variant="primary"
              onClick={() => navigate("projects")}
              disabled={projects.length === 0}
            >
              New chat in a project
            </Button>
          </>
        }
      />
      <ConnectionBanner link={link} onRetry={refetch} />

      <FeatureGateNotice gate={core.gate} title="Conversation list from Core" onRetry={refetch} />
      {core.error !== null && (
        <Warning tone="danger" title={`Core refused conversation.list`}>
          {core.error.message}
        </Warning>
      )}

      <Panel
        title={
          core.gate.state === "supported"
            ? "Conversations Core holds"
            : "Conversations this window created"
        }
        description={
          core.gate.state === "supported"
            ? "Read through conversation.list. Archived chats are excluded by Core, so everything here can actually be reopened."
            : "Core has not answered conversation.list, so this is only what THIS window created — never the whole picture, and never sample data."
        }
        actions={<FeatureChip gate={core.gate} method="conversation.list" />}
      >
        {core.isLoading && core.gate.state === "supported" ? (
          <p className="muted">Reading conversations from Core…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            heading="No conversations to show"
            body={
              link.kind === "attached"
                ? "Open a project workspace and use New chat. Conversations live in the shared Core SQLite store, so a chat started in VS Code is the same chat."
                : "Core is unreachable, so nothing can be created or read."
            }
          />
        ) : (
          <ul className="list">
            {rows.map((conversation) => (
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
                  <span className="row__title">
                    {conversation.title}{" "}
                    <span className="muted">· {projectName(conversation.projectId)}</span>
                  </span>
                  <span className="row__meta">
                    <Badge tone="neutral">agent {conversation.agentId}</Badge> ·{" "}
                    <Badge tone={conversation.fromCore ? "success" : "neutral"}>
                      {conversation.fromCore ? "from Core" : "this window"}
                    </Badge>{" "}
                    · <Mono>{conversation.id.slice(0, 8)}</Mono> · {conversation.createdAt}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Warning tone="neutral" title="What this build still cannot do">
        <ul className="bullets">
          <li>
            Search, archive and export of Sandpane-owned history (specs/05 §3.A): no Core method
            exists for any of the three, so no UI is faked.
          </li>
          <li>
            Transcript paging is bounded by Core: <Mono>conversation.history</Mono> answers up to{" "}
            <Mono>500</Mono> rows and stops on its own byte ceiling, and when it does,{" "}
            <Mono>truncated</Mono> is shown rather than a partial chat looking complete.
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
