import { useMemo } from "react";
import {
  capabilitiesOf,
  useCoreLink,
  useProjects,
  useStoreStatus,
  useTaskIndex,
  useTaskProjections,
} from "../../lib/hooks";
import {
  countTasks,
  displayPath,
  foldSbxView,
  taskStatusView,
  type TimelineEntry,
} from "../../lib/reducers";
import { AppShell, ViewHeader } from "../../components/layout/AppShell";
import {
  ConnectionBanner,
  ConnectionChip,
  SbxBadge,
} from "../../components/layout/ConnectionState";
import {
  Badge,
  Button,
  EmptyState,
  KeyValue,
  Panel,
  Skeleton,
} from "../../components/ui/primitives";
import { IconPlus, IconRefresh, IconSandboxes } from "../../components/layout/icons";
import { href, navigate, type Route } from "../../app/router";
import { ProjectSidebar } from "../../components/project/ProjectSidebar";
import { RefreshButton, useProbeRefetch } from "../../components/ui/refresh";

type ActivityItem = { entry: TimelineEntry; taskId: string };

export function DashboardView({ route }: { route: Route }) {
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects, isLoading: projectsLoading, error: projectsError } = useProjects();
  const tasks = useTaskIndex().rows;
  const projections = useTaskProjections();
  const storeStatus = useStoreStatus();
  const attached = link.kind === "attached";

  const counts = useMemo(() => countTasks(tasks), [tasks]);
  const activity = useMemo(() => {
    const recent: ActivityItem[] = projections
      .flatMap((p) => p.entries.slice(-6).map((entry) => ({ entry, taskId: p.taskId })))
      .sort((a, b) => b.entry.sequence - a.entry.sequence);
    // Bounded DOM: newest N rendered, the rest stays in Core (same rule the
    // chat timeline uses; `windowEntries` needs a `sequence` on the item, so the
    // wrapped activity rows are sliced here).
    const limit = 24;
    return {
      visible: recent.slice(Math.max(0, recent.length - limit)),
      hiddenBefore: Math.max(0, recent.length - limit),
    };
  }, [projections]);

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={
        <ConnectionChip link={link} onRetry={refetch} />
      }
      statusTrailing={
        <span className="statusbar__counts">
          Running {counts.running} · Queued {counts.queued} · Review needed{" "}
          {counts.needsReview} · Failed {counts.failed}
          {counts.unrecognized > 0 && <> · Unrecognised {counts.unrecognized}</>}
        </span>
      }
    >
      <ViewHeader
        title="Your workspace"
        subtitle={
          attached
            ? `Core v${capabilitiesOf(link)?.coreVersion ?? "?"} · ${
                capabilitiesOf(link)?.agents.length ?? 0
              } agent adapter(s) reported · single-instance socket`
            : "Prerequisites are not satisfied — nothing below is simulated."
        }
        actions={
          <>
            <Button onClick={refetch}>
              <IconRefresh /> Re-check Core
            </Button>
            <Button
              variant="primary"
              onClick={() => navigate("sandbox-new")}
              disabled={!attached}
            >
              <IconSandboxes /> Create sandbox
            </Button>
          </>
        }
      />

      <ConnectionBanner link={link} onRetry={refetch} />

      <div className="grid grid--counts">
        <CountCard
          label="Running"
          value={counts.running}
          tone="active"
          note="preparing · running · verifying"
          onClick={() => navigate("tasks")}
        />
        <CountCard
          label="Waiting for review"
          value={counts.needsReview}
          tone="attention"
          note="awaiting_review — not applied yet"
          onClick={() => navigate("tasks")}
        />
        <CountCard
          label="Queued"
          value={counts.queued}
          tone="info"
          note="created · queued"
          onClick={() => navigate("tasks")}
        />
        <CountCard
          label="Failed / interrupted"
          value={counts.failed}
          tone="danger"
          note="interrupted is never auto-resumed"
          onClick={() => navigate("tasks")}
        />
      </div>

      <div className="grid grid--two">
        <Panel
          title="Projects"
          description="Read from Core over project.list. Creating a project registers it in the shared SQLite store."
          actions={
            <Button variant="ghost" onClick={() => navigate("projects")}>
              <IconPlus /> New project
            </Button>
          }
        >
          {!attached ? (
            <EmptyState
              variant="offline"
              heading="No project data"
              body="Projects come from Core. While Core is unreachable this list stays empty rather than showing sample data."
              action={<RefreshButton />}
            />
          ) : projectsLoading ? (
            <Skeleton rows={3} />
          ) : projectsError !== null ? (
            <EmptyState
              variant="offline"
              heading={`Core rejected project.list (${projectsError.code})`}
              body={projectsError.message}
              action={<RefreshButton />}
            />
          ) : projects.length === 0 ? (
            <EmptyState
              heading="No projects yet"
              body="Add a project and bind a repository path to start a task."
              action={
                <Button variant="primary" onClick={() => navigate("projects")}>
                  Create project
                </Button>
              }
            />
          ) : (
            <ul className="list">
              {projects.map((project) => (
                <li key={project.id}>
                  <a className="row" href={href("project-workspace", { projectId: project.id })}>
                    <span className="row__title">{project.name}</span>
                    <span className="row__meta">{project.id.slice(0, 8)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Global activity"
          description={
            storeStatus.kind === "degraded"
              ? `Replay degraded: ${storeStatus.reason} (attempt ${storeStatus.attempt})`
              : "Folded from durable task events (task.subscribe replay)."
          }
        >
          {!attached ? (
            <EmptyState
              variant="offline"
              heading="No events"
              body="Event replay needs a live Core connection."
              action={<RefreshButton />}
            />
          ) : activity.visible.length === 0 ? (
            <EmptyState
              heading="Nothing has run yet"
              body="Activity appears as Core appends task events. A freshly restarted Core reports reconciled tasks as interrupted — it does not pretend they kept running."
            />
          ) : (
            <>
              {activity.hiddenBefore > 0 && (
                <p className="list__truncated">
                  {activity.hiddenBefore} earlier entries not rendered (bounded DOM — adjust in
                  Settings).
                </p>
              )}
              <ul className="list list--activity">
                {activity.visible.map((item, index) => (
                  <li key={`${item.taskId}-${item.entry.sequence}-${index}`}>
                    <ActivityRow entry={item.entry} taskId={item.taskId} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      </div>

      <Panel title="Readiness as reported by Core">
        <dl className="kvs">
          <KeyValue label="Transport">
            <TransportLine />
          </KeyValue>
          <KeyValue label="SBX">
            <SbxBadgeLine />
          </KeyValue>
          <KeyValue label="Tasks tracked by this window">{counts.total}</KeyValue>
        </dl>
      </Panel>
    </AppShell>
  );
}

function TransportLine() {
  const link = useCoreLink();
  if (link.kind === "attached") {
    return (
      <>
        live · attached <Badge tone="success">stale: false</Badge>
      </>
    );
  }
  return link.kind === "unreachable" ? (
    <>
      {link.code} <Badge tone="danger">stale: true</Badge>
    </>
  ) : (
    <>{link.kind}</>
  );
}

function SbxBadgeLine() {
  const link = useCoreLink();
  return <SbxBadge view={foldSbxView(capabilitiesOf(link))} />;
}

function CountCard({
  label,
  value,
  tone,
  note,
  onClick,
}: {
  label: string;
  value: number;
  tone: "active" | "attention" | "info" | "danger";
  note: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`count count--${tone}`} onClick={onClick}>
      <span className="count__value">{value}</span>
      <span className="count__label">{label}</span>
      <span className="count__note">{note}</span>
    </button>
  );
}

function ActivityRow({ entry, taskId }: { entry: TimelineEntry; taskId: string }) {
  const detail = describeEntry(entry);
  return (
    <div className="row">
      <span className="row__title">{detail}</span>
      <span className="row__meta">
        {entry.kind} · {taskId.slice(0, 8)} #{entry.sequence} · {entry.timestamp}
      </span>
    </div>
  );
}

function describeEntry(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "status":
      return taskStatusView(entry.status, entry.raw).label;
    case "error":
      return entry.code ? `${entry.code}: ${entry.message}` : entry.message;
    case "tool":
      return entry.ok === undefined
        ? `Running ${entry.name ?? entry.toolId}`
        : `${entry.name ?? entry.toolId} ${entry.ok ? "succeeded" : "failed"}`;
    case "file":
      return `Changed ${displayPath(entry.path).text}`;
    case "approval":
      return `Approval required: ${entry.description}`;
    case "unmodelled":
      return entry.detail;
    case "git-apply":
    case "verification":
      return entry.text;
    case "user-message":
      return `You: ${entry.text}`;
    case "agent-message":
      return `Agent: ${entry.text}`;
  }
}
