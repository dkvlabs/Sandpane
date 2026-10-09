import { useMemo, useState } from "react";
import {
  capabilitiesOf,
  useCoreLink,
  useProjects,
  useSandboxes,
  useTaskIndex,
  useTaskProjection,
} from "../../lib/hooks";
import {
  describeTaskAction,
  foldSbxView,
  taskStatusView,
  workspaceModeView,
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
import { useUiPreferences } from "../../app/context";

export function ProjectWorkspaceView({ route }: { route: Route }) {
  const projectId = route.params.projectId ?? "";
  const conversationId = route.params.conversationId ?? null;
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  const { sandboxes } = useSandboxes();
  const preferences = useUiPreferences().preferences;
  const taskIndex = useTaskIndex();

  const [focusedTask, setFocusedTask] = useState<string | null>(null);
  const [mode, setMode] = useState<WorkspaceMode>("sbx_clone");

  const project = projects.find((p) => p.id === projectId) ?? null;

  const tasksForProject = useMemo(() => {
    // A task belongs to a conversation, and conversations are known to this
    // window; with no conversation.list in v1 the workspace narrows by the
    // conversations it created and falls back to the whole index otherwise.
    const scoped = conversationId === null
      ? taskIndex
      : taskIndex.filter((t) => t.conversationId === conversationId);
    return scoped;
  }, [taskIndex, conversationId]);

  const selectedTask = focusedTask ?? tasksForProject[0]?.taskId ?? null;
  const projection = useTaskProjection(selectedTask);
  const actions = describeTaskAction(
    projection?.status === "unknown" ? undefined : projection?.status,
  );

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={
        <span className="statusbar__counts">
          {tasksForProject.length} task(s) visible · switching projects never stops a task
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
          }))}
          mode={mode}
          onMode={setMode}
        />
        <Panel title="Isolation for this workspace">
          <div className="badges">
            <Badge tone={workspaceModeView(mode).liveWritable ? "attention" : "success"}>
              {workspaceModeView(mode).label}
            </Badge>
            <SbxBadge view={foldSbxView(capabilitiesOf(link))} />
          </div>
          <p className="muted">{workspaceModeView(mode).blurb}</p>
          <p className="muted">
            Binding a sandbox to this project needs a Core method that protocol v1 does not expose
            (bindings are written by <Mono>sandbox.create</Mono> only), so the picker states the
            link read from <Mono>sandbox.list</Mono> instead of asserting a new one.
          </p>
        </Panel>
      </div>

      <ChatPanel
        projectId={projectId}
        selectedConversationId={conversationId}
        onSelectConversation={(id) =>
          navigate("conversation", { projectId, conversationId: id })
        }
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
                        <Badge tone={taskStatusView(task.status).tone}>
                          {taskStatusView(task.status).label}
                        </Badge>
                        {task.conversationId === null
                          ? " · conversation unknown"
                          : ` · chat ${task.conversationId.slice(0, 8)}`}
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
          <ReviewPanel taskId={selectedTask} liveWritable={workspaceModeView(mode).liveWritable} />
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
  mode,
  onMode,
}: {
  sandboxes: { name: string; bound: boolean; state: string | null }[];
  mode: WorkspaceMode;
  onMode: (mode: WorkspaceMode) => void;
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
            <li key={sandbox.name} className="row">
              <span className="row__title">
                <Mono>{sandbox.name}</Mono>
                {sandbox.bound && <Badge tone="success"> this project</Badge>}
              </span>
              <span className="row__meta">
                {sandbox.state ?? "state not probed"}
                <Button variant="ghost" onClick={() => onMode(mode)}>
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
