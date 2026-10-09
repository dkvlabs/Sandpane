import { capabilitiesOf, useCoreLink, useProjects } from "../../lib/hooks";
import { foldAgentView } from "../../lib/reducers";
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
import { IconRefresh } from "../../components/layout/icons";
import { navigate, type Route } from "../../app/router";
import { useProbeRefetch } from "../../components/ui/refresh";

/**
 * Agents & sessions. Capability labels are the exact booleans Core advertised —
 * `verified` is true only after the adapter's in-SBX feasibility gate passed, and
 * `supportsResume` only after restart tests. Nothing here is inferred from the
 * agent's name or from what the provider is generally known to do.
 */
export function AgentsView({ route }: { route: Route }) {
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  const capabilities = capabilitiesOf(link);
  const agents = capabilities?.agents ?? [];

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={
        <span className="statusbar__counts">
          {agents.length} adapter(s) reported by this Core build
        </span>
      }
    >
      <ViewHeader
        title="Agents"
        subtitle="Capabilities as advertised by system.probe, per adapter."
        actions={
          <Button onClick={refetch}>
            <IconRefresh /> Re-probe
          </Button>
        }
      />
      <ConnectionBanner link={link} onRetry={refetch} />

      <Panel title="Adapters">
        {link.kind !== "attached" ? (
          <EmptyState
            variant="offline"
            heading="No capability data"
            body="Capabilities come from the Core handshake. Reconnect to load them."
          />
        ) : agents.length === 0 ? (
          <EmptyState
            heading="Core reported no agent adapters"
            body="This Core build compiled no verified adapter. Chats can be created, but tasks will stay queued with an adapter.unavailable event."
          />
        ) : (
          <ul className="list list--agents">
            {agents.map((cap) => {
              const view = foldAgentView(cap);
              return (
                <li key={cap.id} className="card">
                  <div className="card__head">
                    <span className="card__title">
                      <Mono>{view.id}</Mono>
                    </span>
                    <Badge tone={view.verified ? "success" : "attention"}>
                      {view.verified ? "verified adapter" : "not verified"}
                    </Badge>
                  </div>
                  <div className="badges">
                    <Badge tone={cap.supportsStreaming ? "info" : "neutral"}>
                      {view.streamingLabel}
                    </Badge>
                    <Badge tone={cap.supportsCancel ? "info" : "neutral"}>
                      {view.cancelLabel}
                    </Badge>
                    <Badge tone={cap.supportsResume ? "success" : "neutral"}>
                      {view.resumeLabel}
                    </Badge>
                  </div>
                  <p className="muted">
                    {view.verified
                      ? "Usable for tasks in this build."
                      : "Selectable, but a task will not start: Core keeps it queued and records why."}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Session operations">
        <table className="table">
          <thead>
            <tr>
              <th>Operation</th>
              <th>Support</th>
              <th>Source of that claim</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Stream events</td>
              <td>
                <Badge tone={agents.some((a) => a.supportsStreaming) ? "info" : "neutral"}>
                  per adapter
                </Badge>
              </td>
              <td>
                <Mono>agents[].supportsStreaming</Mono> from <Mono>system.probe</Mono>
              </td>
            </tr>
            <tr>
              <td>Cancel</td>
              <td>
                <Badge tone={agents.some((a) => a.supportsCancel) ? "info" : "neutral"}>
                  per adapter
                </Badge>
              </td>
              <td>
                <Mono>agents[].supportsCancel</Mono>; executed by Core via <Mono>task.cancel</Mono>
              </td>
            </tr>
            <tr>
              <td>Native session resume</td>
              <td>
                <Badge tone="neutral">only when advertised</Badge>
              </td>
              <td>
                <Mono>agents[].supportsResume</Mono> — false until restart tests pass; the desktop
                never offers resume on its own.
              </td>
            </tr>
            <tr>
              <td>MCP add / authorize / load</td>
              <td>
                <Badge tone="neutral">not supported by this build</Badge>
              </td>
              <td>DT4 — no Core method exists in protocol v1.</td>
            </tr>
          </tbody>
        </table>
        <Warning tone="neutral" title="No credential import">
          Sandpane does not read provider credentials out of any app, and stores none itself. Agent
          authentication happens through the provider's official flow; the desktop only shows the
          resulting <Mono>PROVIDER_AUTH_REQUIRED</Mono> error when Core reports it.
        </Warning>
      </Panel>

      {projects.length > 0 && (
        <p className="muted">
          Start a chat with one of these adapters from a{" "}
          <button type="button" className="linkbtn" onClick={() => navigate("projects")}>
            project workspace
          </button>
          .
        </p>
      )}
    </AppShell>
  );
}
