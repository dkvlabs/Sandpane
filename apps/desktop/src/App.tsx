import { useEffect } from "react";
import { useRoute, type Route } from "./app/router";
import { CoreProvider, useUiPreferences } from "./app/context";
import { applyUiTheme } from "./stores/ui";
import { AppShell, ViewHeader } from "./components/layout/AppShell";
import { ConnectionChip } from "./components/layout/ConnectionState";
import { Button, EmptyState, Mono, Panel } from "./components/ui/primitives";
import { useCoreLink, useProjects } from "./lib/hooks";
import { DashboardView } from "./features/dashboard/DashboardView";
import { ProjectsView } from "./features/projects/ProjectsView";
import { ProjectWorkspaceView } from "./features/project/ProjectWorkspaceView";
import { ChatsView } from "./features/chats/ChatsView";
import { TasksView } from "./features/tasks/TasksView";
import { SandboxesView, SandboxDetailView } from "./features/sandboxes/SandboxesView";
import { AgentsView } from "./features/agents/AgentsView";
import { TemplatesView } from "./features/templates/TemplatesView";
import { IntegrationsView } from "./features/integrations/IntegrationsView";
import { SettingsView } from "./features/settings/SettingsView";
import type { AppDeps } from "./lib/hooks";

export function App({ deps }: { deps: AppDeps }) {
  return (
    <CoreProvider deps={deps}>
      <ThemedShell />
    </CoreProvider>
  );
}

function ThemedShell() {
  const { preferences } = useUiPreferences();
  useEffect(() => {
    applyUiTheme(preferences);
  }, [preferences]);
  return <Routes />;
}

function Routes() {
  const route = useRoute();
  if (route.unmatched) return <UnknownRouteView route={route} />;
  switch (route.name) {
    case "dashboard":
      return <DashboardView route={route} />;
    case "projects":
      return <ProjectsView route={route} />;
    case "project-workspace":
    case "conversation":
      return <ProjectWorkspaceView route={route} />;
    case "chats":
      return <ChatsView route={route} />;
    case "tasks":
    case "task-detail":
      return <TasksView route={route} />;
    case "sandboxes":
    case "sandbox-new":
      return <SandboxesView route={route} />;
    case "sandbox-detail":
      return <SandboxDetailView route={route} />;
    case "agents":
      return <AgentsView route={route} />;
    case "templates":
      return <TemplatesView route={route} />;
    case "integrations":
      return <IntegrationsView route={route} />;
    case "settings":
      return <SettingsView route={route} />;
    default:
      return <UnknownRouteView route={route} />;
  }
}

function UnknownRouteView({ route }: { route: Route }) {
  const link = useCoreLink();
  const refetch = () => window.location.reload();
  const { projects } = useProjects();
  return (
    <AppShell
      route={route}
      sidebar={undefined}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={<span className="statusbar__counts">unknown destination</span>}
    >
      <ViewHeader title="No such view" subtitle={<Mono>{route.hash}</Mono>} />
      <Panel title="This hash matches no route">
        <EmptyState
          heading="Unknown destination"
          body="The router did not fall back to the dashboard silently, so a typo or a stale deep link is visible instead of looking like an empty product."
          action={
            <Button variant="primary" onClick={() => (window.location.hash = "#/")}>
              Go to Dashboard
            </Button>
          }
        />
        {projects.length > 0 && (
          <p className="muted">
            {projects.length} project(s) are reachable from the Projects destination.
          </p>
        )}
      </Panel>
    </AppShell>
  );
}
