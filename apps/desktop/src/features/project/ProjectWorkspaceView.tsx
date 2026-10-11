import { useMemo, useState } from "react";
import {
  capabilitiesOf,
  useCoreLink,
  useProjectLifecycleGates,
  useProjects,
  useSandboxes,
  useStoreStatus,
  useTaskIndex,
  useTaskProjection,
} from "../../lib/hooks";
import { archivedBlock, archivedLabel, isArchived } from "../../lib/project-lifecycle";
import {
  foldSbxView,
  resolveSelection,
  sandboxModeView,
  taskActionGate,
  taskIsolationView,
  taskStatusView,
} from "../../lib/reducers";
import type { WorkspaceMode } from "../../lib/protocol";
import { AppShell, ViewHeader } from "../../components/layout/AppShell";
import {
  ConnectionBanner,
  ConnectionChip,
  SbxBadge,
} from "../../components/layout/ConnectionState";
import { ProjectSidebar } from "../../components/project/ProjectSidebar";
import { ChatPanel } from "../../components/chat/ChatPanel";
import { ActivityTimeline, TaskHeader } from "../../components/chat/ActivityTimeline";
import { ReviewPanel } from "../../components/review/ReviewPanel";
import {
  Badge,
  Button,
  EmptyState,
  Mono,
  Panel,
  Warning,
} from "../../components/ui/primitives";
import { IconRefresh } from "../../components/layout/icons";
import { href, navigate, type Route } from "../../app/router";
import { useProbeRefetch } from "../../components/ui/refresh";
import { TaskSendFacts } from "../../components/chat/SendMode";
import { useUiPreferences } from "../../app/context";

export function ProjectWorkspaceView({ route }: { route: Route }) {
  const projectId = route.params.projectId ?? "";
  const conversationId = route.params.conversationId ?? null;
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  // A3a: an archived project is still readable; look it up in the list that
  // includes archived rows when this Core can give one.
  const gates = useProjectLifecycleGates();
  const withArchived = useProjects({ includeArchived: gates.showArchived.state === "supported" });
  const sandboxList = useSandboxes();
  const sandboxes = sandboxList.sandboxes;
  const preferences = useUiPreferences().preferences;
  const index = useTaskIndex(projectId === "" ? null : projectId);
  const taskIndex = index.rows;
  const storeStatus = useStoreStatus();

  const [focusedTask, setFocusedTask] = useState<string | null>(null);
  const [focusedSandbox, setFocusedSandbox] = useState<string | null>(null);

  const project = withArchived.projects.find((p) => p.id === projectId) ?? null;
  const archivedReason = project === null ? null : archivedBlock(project, "chat");

  const tasksForProject = useMemo(() => {
    // Scoped by the conversation actually open; otherwise every row Core named
    // (task.list) or the replay reached (task.subscribe) for this project.
    return conversationId === null
      ? taskIndex
      : taskIndex.filter((t) => t.conversationId === conversationId);
  }, [taskIndex, conversationId]);

  // A remembered focus is honoured only while it is still in the current list
  // (a conversation filter or a refresh can remove it); never act on a task or
  // sandbox the view no longer shows.
  const selectedTask = resolveSelection(
    focusedTask,
    tasksForProject.map((t) => t.taskId),
    "first",
  );
  const selectedRow = tasksForProject.find((t) => t.taskId === selectedTask) ?? null;
  const activeSandbox = resolveSelection(
    focusedSandbox,
    sandboxes.map((s) => s.name),
    "none",
  );
  // The workspace panel describes the FOCUSED sandbox (Core's recorded binding,
  // never a local default). With none focused there is no mount to claim.
  const focusedRow = sandboxes.find((s) => s.name === activeSandbox) ?? null;
  const isolation =
    focusedRow === null
      ? {
          label: "No sandbox bound here",
          liveWritable: false,
          verified: true,
          blurb:
            "No sandbox is focused, so this workspace claims no mount: nothing is being written to your tree through Core from this view.",
        }
      : sandboxModeView(focusedRow.workspaceMode, focusedRow.unrecognizedWorkspaceMode);
  // Review's live-writable disclosure comes from the SELECTED TASK's own
  // sandbox, not the focused one: they can differ, and unknown is UNVERIFIED.
  const taskIsolation = taskIsolationView(
    selectedRow,
    sandboxes,
    !sandboxList.isLoading && sandboxList.error === null,
  );
  const projection = useTaskProjection(selectedTask);
  // ONE gate over both Core reads (the selected task's row AND its event log):
  // an unrecognised status on either side disables review, apply AND cancel.
  const actions = taskActionGate(selectedRow, projection);

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={
        <span className="statusbar__counts">
          {tasksForProject.length} task(s) visible
          {index.unattributed > 0 ? ` · ${index.unattributed} replayed task(s) not provably in this project` : ""}
          {" "}· switching projects never stops a task
        </span>
      }
    >
      <ViewHeader
        title={project?.name ?? "Unknown project"}
        subtitle={
          project === null ? (
            <Mono>{projectId}</Mono>
          ) : (
            <>
              <Mono>{project.id.slice(0, 8)}</Mono> · created {project.createdAt}
            </>
          )
        }
        actions={
          <>
            <Button onClick={refetch}>
              <IconRefresh /> Refresh
            </Button>
            <Button onClick={() => navigate("tasks")}>All tasks</Button>
          </>
        }
      />

      <ConnectionBanner link={link} onRetry={refetch} />

      {storeStatus.kind === "refused" && (
        <Warning tone="attention" title="Event replay is paused for this scope">
          {storeStatus.reason} This window stopped pulling that replay rather than retrying a
          request Core can never deliver in one frame. Task rows Core already returned through{" "}
          <Mono>task.list</Mono> stay visible.
        </Warning>
      )}

      {project !== null && project.repositories !== undefined && (
        <Warning tone="neutral" title="Repositories registered with this project">
          <ul className="bullets">
            {project.repositories.length === 0 ? (
              <li>
                Core registered <em>no</em> repository path for this project.
              </li>
            ) : (
              project.repositories.map((path) => (
                <li key={path}>
                  <Mono>{path}</Mono>
                </li>
              ))
            )}
          </ul>
          These are the paths exactly as they were registered. Core canonicalizes (resolves
          symlinks) when a sandbox is created, not here, so a folder matching one of these
          strings is a path match — not proof that both names are the same directory.
        </Warning>
      )}

      {project !== null && isArchived(project) && (
        <Warning tone="attention" title={`This project is ${archivedLabel(project) ?? "archived"}`}>
          Core refuses new chats, messages and sandboxes for it until it is unarchived
          (Projects → Settings). Reads keep working and running tasks keep running.
        </Warning>
      )}

      {project === null && (
        <Warning tone="attention" title="This project id is not in the current Core list">
          It may be archived, or created by another client after the last refresh. The workspace
          keeps working on the events Core does report.
        </Warning>
      )}

      <div className="grid grid--two">
        <SandboxPicker
          sandboxes={sandboxes.map((s) => ({
            name: s.name,
            bound: s.boundProjectId === projectId,
            state: s.probedState,
            mode: s.workspaceMode,
            unrecognizedMode: s.unrecognizedWorkspaceMode ?? null,
          }))}
          focused={activeSandbox}
          onFocus={setFocusedSandbox}
        />
        <Panel title="Isolation for this workspace">
          <div className="badges">
            <Badge tone={isolation.verified ? (isolation.liveWritable ? "danger" : "success") : "attention"}>
              {isolation.label}
            </Badge>
            <SbxBadge view={foldSbxView(capabilitiesOf(link))} />
          </div>
          <p className="muted">{isolation.blurb}</p>
          <p className="muted">
            {activeSandbox === null
              ? "No sandbox focused yet, so this workspace states the safest thing it can: nothing is bound until one is chosen."
              : `Read from Core's binding record for ${activeSandbox} (sandbox.list). Binding a new sandbox needs a method protocol v1 does not expose — sandbox.create writes bindings only.`}
          </p>
        </Panel>
      </div>

      <ChatPanel
        projectId={projectId}
        selectedConversationId={conversationId}
        onSelectConversation={(id) =>
          navigate("conversation", { projectId, conversationId: id })
        }
        onConversationGone={() => navigate("project-workspace", { projectId })}
        archivedReason={archivedReason}
      />

      <div className="grid grid--workspace">
        <div>
          <TaskHeader projection={projection} />
          {tasksForProject.length > 0 && (
            <Panel title="Tasks in this workspace">
              <ul className="list list--tasks">
                {tasksForProject.map((task) => (
                  <li key={task.taskId}>
                    <button
                      type="button"
                      className={`row row--selectable${task.taskId === selectedTask ? " row--active" : ""}`}
                      onClick={() => setFocusedTask(task.taskId)}
                    >
                      <span className="row__title">
                        <Mono>{task.taskId.slice(0, 8)}</Mono>
                      </span>
                      <span className="row__meta">
                        <Badge
                          tone={taskStatusView(task.status, task.unrecognizedStatus).tone}
                          title={taskStatusView(task.status, task.unrecognizedStatus).note}
                        >
                          {taskStatusView(task.status, task.unrecognizedStatus).label}
                        </Badge>
                        {task.conversationId === null
                          ? " · conversation unknown"
                          : ` · chat ${task.conversationId.slice(0, 8)}`}
                        <TaskSendFacts task={task} inline />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <ActivityTimeline projection={projection} maxVisible={preferences.maxVisibleEvents} />
          {projection === null && tasksForProject.length === 0 && (
            <EmptyState
              heading="No task events yet"
              body="Send a message to create a task. After a Core restart, reconciled tasks show as interrupted rather than falsely running."
              action={
                <Button variant="ghost" onClick={refetch}>
                  <IconRefresh /> Re-check Core
                </Button>
              }
            />
          )}
        </div>
        <div>
          <ReviewPanel
            taskId={selectedTask}
            isolation={taskIsolation}
            blockedReason={actions.blockedReason}
          />
          {selectedTask !== null && (
            <Panel title="Task actions">
              <div className="row-actions">
                <Button
                  disabled={!actions.canReview}
                  onClick={() => navigate("task-detail", { taskId: selectedTask })}
                >
                  Open review
                </Button>
                <Button
                  variant="danger"
                  disabled={!actions.canCancel || projection === null}
                  onClick={() => navigate("task-detail", { taskId: selectedTask })}
                >
                  Cancel task…
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => navigate("conversation", {
                    projectId,
                    conversationId: projection?.conversationId ?? "unknown",
                  })}
                  disabled={projection?.conversationId == null}
                >
                  Open chat
                </Button>
              </div>
              <p className="muted">
                Cancelling stops the task through Core (<Mono>task.cancel</Mono>) and is a different
                action from closing a tab. Retry never resumes an old task — it creates a new one.
              </p>
            </Panel>
          )}
          <Panel title="Inspector">
            <p className="muted">
              Changes, tests, context and preview tabs are DT3/DT4 surfaces. Only{" "}
              <Mono>git.review</Mono> has a Core method today, and it is rendered above.
            </p>
            <p className="muted">
              <a href={href("sandboxes")}>Sandboxes</a> ·{" "}
              <a href={href("tasks")}>Tasks</a>
            </p>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}

function SandboxPicker({
  sandboxes,
  focused,
  onFocus,
}: {
  sandboxes: {
    name: string;
    bound: boolean;
    state: string | null;
    mode: WorkspaceMode | null;
    unrecognizedMode: string | null;
  }[];
  focused: string | null;
  onFocus: (name: string) => void;
}) {
  return (
    <Panel
      title="Sandbox"
      description="Which sandbox this workspace is talking about, straight from sandbox.list."
    >
      {sandboxes.length === 0 ? (
        <EmptyState
          heading="No sandboxes reported"
          body="Create one from the Sandboxes view; the workspace shows the sandbox Core actually binds."
          action={
            <Button variant="primary" onClick={() => navigate("sandbox-new")}>
              Create sandbox
            </Button>
          }
        />
      ) : (
        <ul className="list">
          {sandboxes.map((sandbox) => (
            <li key={sandbox.name} className={`row${sandbox.name === focused ? " row--active" : ""}`}>
              <span className="row__title">
                <Mono>{sandbox.name}</Mono>
                {sandbox.bound && <Badge tone="success"> this project</Badge>}
              </span>
              <span className="row__meta">
                {sandbox.state ?? "state not probed"} ·{" "}
                <Badge
                  tone={sandboxModeView(sandbox.mode, sandbox.unrecognizedMode).verified ? (sandboxModeView(sandbox.mode, sandbox.unrecognizedMode).liveWritable ? "danger" : "neutral") : "attention"}
                  title={sandboxModeView(sandbox.mode, sandbox.unrecognizedMode).blurb}
                >
                  {sandboxModeView(sandbox.mode, sandbox.unrecognizedMode).label}
                </Badge>
                <Button variant="ghost" onClick={() => onFocus(sandbox.name)}>
                  Focus
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
