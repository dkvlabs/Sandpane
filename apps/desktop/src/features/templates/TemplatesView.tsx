import { useCoreLink, useProjects } from "../../lib/hooks";
import { foldSbxView } from "../../lib/reducers";
import { AppShell, ViewHeader } from "../../components/layout/AppShell";
import {
  ConnectionBanner,
  ConnectionChip,
  SbxBadge,
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
import { navigate, type Route } from "../../app/router";
import { useProbeRefetch } from "../../components/ui/refresh";

/**
 * Templates & presets — read-only until Core ships a template RPC.
 *
 * Saved SBX templates, presets and skills are gated on the installed SBX version
 * (docs/specs/05 §3.D). The desktop does not keep its own template database:
 * showing locally invented "templates" would look like success while doing
 * nothing, so this view is an honest unsupported state with the exact gap named.
 */
export function TemplatesView({ route }: { route: Route }) {
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  const sbx = foldSbxView(
    link.kind === "attached" ? link.capabilities : null,
  );

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={<span className="statusbar__counts">no template RPC in protocol v1</span>}
    >
      <ViewHeader
        title="Templates & presets"
        subtitle="Saved SBX templates and Sandpane presets — load, export, remove."
      />
      <ConnectionBanner link={link} onRetry={refetch} />

      <Panel title="Availability">
        <div className="badges">
          <SbxBadge view={sbx} />
          <Badge tone="neutral">feature detection: not available</Badge>
        </div>
        <EmptyState
          variant="unsupported"
          heading="Not supported by this build"
          body={
            <>
              <p>
                Protocol v1 has no <Mono>template.list</Mono>, <Mono>template.save</Mono> or{" "}
                <Mono>preset.apply</Mono>, and Core does not probe which template features the
                installed SBX supports. Rather than list invented templates, this destination stays
                empty and says why.
              </p>
              <ul className="bullets">
                <li>
                  DT4 scope: template list/load/export/remove, presets, and skills gated by the
                  detected SBX version.
                </li>
                <li>
                  Lifecycle limits that must be reported honestly: a template referencing a removed
                  image, or a preset whose mount path no longer exists.
                </li>
              </ul>
            </>
          }
          action={
            <Button onClick={() => navigate("integrations")}>
              See what Integrations can do today
            </Button>
          }
        />
      </Panel>

      <Warning tone="neutral" title="What you can do instead">
        Describe the workspace in the create wizard (<Mono>sandbox.create</Mono> takes a name,
        project, workspace mode and repository path), and keep the recipe in your own repository
        until Core can store it. Nothing here writes to Sandpane's SQLite store, because no method
        for it exists.
      </Warning>

      <Panel title="Planned data shape">
        <p className="muted">
          The schema slot is already reserved in Core's SQLite (<Mono>presets</Mono>, per
          docs/specs/02 §3), so a template RPC extends the existing store instead of adding a second
          source of truth.
        </p>
        <p className="muted">
          Reference: <Mono>schemas/</Mono> in this repository defines the frames this app can
          already speak; a <Mono>template-*.schema.json</Mono> would land with the RPC.
        </p>
      </Panel>
    </AppShell>
  );
}
