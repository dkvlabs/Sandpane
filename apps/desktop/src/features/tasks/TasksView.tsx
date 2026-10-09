import { useMemo, useState } from "react";
import {
  useCancelTask,
  useCoreLink,
  useProjects,
  useStoreStatus,
  useTaskIndex,
  useTaskProjection,
} from "../../lib/hooks";
import { countTasks, describeTaskAction, taskStatusView } from "../../lib/reducers";
import { AppShell, ViewHeader } from "../../components/layout/AppShell";
import {
  ConnectionBanner,
  ConnectionChip,
} from "../../components/layout/ConnectionState";
import { ProjectSidebar } from "../../components/project/ProjectSidebar";
import { ActivityTimeline, TaskHeader } from "../../components/chat/ActivityTimeline";
import { ReviewPanel } from "../../components/review/ReviewPanel";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Mono,
  Panel,
  Tabs,
  Warning,
} from "../../components/ui/primitives";
import { ErrorPanel } from "../projects/ProjectsView";
import { FeatureGateNotice } from "../../components/ui/feature-gate";
import { navigate, type Route } from "../../app/router";
import { useProbeRefetch } from "../../components/ui/refresh";
import type { TaskStatus } from "../../lib/protocol";

type Filter = "all" | "running" | "waiting" | "queued" | "completed" | "failed";

const FILTER_MATCH: Record<Filter, (status: TaskStatus | "unknown") => boolean> = {
  all: () => true,
  running: (s) => s === "preparing" || s === "running" || s === "verifying",
  waiting: (s) => s === "awaiting_review" || s === "awaiting_input",
  queued: (s) => s === "queued" || s === "created",
  completed: (s) => s === "completed",
  failed: (s) => s === "failed" || s === "rejected" || s === "interrupted" || s === "cancelled",
};

export function TasksView({ route }: { route: Route }) {
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  const index = useTaskIndex();
  const storeStatus = useStoreStatus();
  const tasks = index.rows;
  const [filter, setFilter] = useState<Filter>("all");
  const counts = useMemo(() => countTasks(tasks), [tasks]);
  const shown = tasks.filter((t) => FILTER_MATCH[filter](t.status));
  const detailTaskId = route.name === "task-detail" ? route.params.taskId ?? null : null;

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={
        <span className="statusbar__counts">
          Running {counts.running} · Queued {counts.queued} · Review needed {counts.needsReview} ·
          Failed {counts.failed}
        </span>
      }
    >
      <ViewHeader
        title="Tasks & Review"
        subtitle={
          index.gate.state === "supported"
            ? "Rows are Core's own task records (task.list) merged with the durable events this window replayed (task.subscribe). Each row says which of the two it came from; a task with neither is not shown."
            : index.gate.state === "unprobed"
              ? "Rows come from durable task events replayed through task.subscribe. Core has not been probed yet, so this build does not know whether task.list exists here."
              : "Rows come from durable task events replayed through task.subscribe. This Core does not advertise task.list, so a task that has produced no events in this window is not visible."
        }
        actions={
          <Button
            onClick={() => {
              refetch();
              void index.refresh();
            }}
          >
            Refresh from Core
          </Button>
        }
      />
      <ConnectionBanner link={link} onRetry={refetch} />
      {storeStatus.kind === "refused" && (
        <Warning tone="attention" title="Event replay is paused, not failed">
          {storeStatus.reason} One wide replay cannot fit a 4 MiB frame, so this window stopped
          pulling that scope instead of retrying a request Core can never answer. Open a single
          task, or a smaller project, to continue.
        </Warning>
      )}

      {detailTaskId !== null && <TaskDetail taskId={detailTaskId} />}

      <FeatureGateNotice
        gate={index.gate}
        title="Task list from Core"
        onRetry={refetch}
      />

      <Panel
        title="All tasks"
        actions={
          <Tabs
            label="Filter tasks"
            active={filter}
            onChange={(id) => setFilter(id as Filter)}
            tabs={[
              { id: "all", label: `All ${tasks.length}` },
              { id: "running", label: `Running ${counts.running}` },
              { id: "waiting", label: `Waiting ${counts.needsReview + counts.awaitingInput}` },
              { id: "queued", label: `Queued ${counts.queued}` },
              { id: "completed", label: `Completed ${counts.completed}` },
              { id: "failed", label: `Failed ${counts.failed}` },
            ]}
          />
        }
      >
        {link.kind !== "attached" ? (
          <EmptyState
            variant="offline"
            heading="No task rows"
            body="Task state lives in Core's event log. While the link is down the table stays empty; nothing is carried over as if it were live."
          />
        ) : shown.length === 0 ? (
          <EmptyState
            heading="Nothing matches this filter"
            body={
              tasks.length === 0
                ? "No tasks have been created against this Core yet."
                : `${tasks.length} task(s) total; none in "${filter}".`
            }
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>Conversation</th>
                <th>Seq</th>
                <th>Source</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((task) => {
                const view = taskStatusView(task.status);
                const actions = describeTaskAction(
                  task.status === "unknown" ? undefined : task.status,
                );
                return (
                  <tr key={task.taskId}>
                    <td>
                      <Mono>{task.taskId.slice(0, 8)}</Mono>
                    </td>
                    <td>
                      <Badge tone={view.tone} title={view.note}>
                        {view.label}
                      </Badge>
                    </td>
                    <td>
                      {task.conversationId === null ? (
                        <span className="muted">not reported</span>
                      ) : (
                        <Mono>{task.conversationId.slice(0, 8)}</Mono>
                      )}
                    </td>
                    <td>{task.lastSequence}</td>
                    <td>
                      <span className="muted" title={task.source === "task.list"
                        ? "Core's stored task row (task.list)"
                        : "Folded from durable events (task.subscribe)"}>
                        {task.source === "task.list" ? "Core row" : "events"}
                      </span>
                      {task.disagreement !== null && (
                        <Badge tone="attention" title={
                          `Core's event log last said ${taskStatusView(task.disagreement.fromEvents).label} ` +
                          `while its task row says ${taskStatusView(task.disagreement.fromTaskList).label}. ` +
                          "The desktop reports both; it never decides which one is current."
                        }>
                          reads differ
                        </Badge>
                      )}
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() => navigate("task-detail", { taskId: task.taskId })}
                      >
                        Open
                      </Button>
                      {!actions.canCancel && (
                        <span className="muted"> cancel n/a </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Warning tone="neutral" title="Paused is never shown">
        Sandpane does not implement a provider pause it cannot verify. The distinct states here are
        Queued, Running, Awaiting input, Awaiting review, Completed, Rejected, Failed, Cancelled
        and Interrupted — and Interrupted is Core's restart reconciliation, never a resumed run.
      </Warning>
    </AppShell>
  );
}

function TaskDetail({ taskId }: { taskId: string }) {
  const projection = useTaskProjection(taskId);
  const cancel = useCancelTask();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const actions = describeTaskAction(
    projection?.status === "unknown" ? undefined : projection?.status,
  );

  return (
    <div className="grid grid--workspace">
      <div>
        <TaskHeader projection={projection} />
        <ActivityTimeline projection={projection} maxVisible={200} />
        <Panel title="Cancel this task">
          <div className="row-actions">
            <Button
              variant="danger"
              disabled={!actions.canCancel}
              onClick={() => setConfirmOpen(true)}
            >
              Cancel task
            </Button>
            {!actions.canCancel && (
              <span className="muted">
                This task is already in a terminal or review state; cancelling would change nothing.
              </span>
            )}
          </div>
          <ConfirmDialog
            open={confirmOpen}
            title="Cancel the running task?"
            confirmLabel="Cancel through Core"
            onCancel={() => setConfirmOpen(false)}
            onConfirm={() => {
              setConfirmOpen(false);
              cancel.mutate(taskId);
            }}
            consequence={
              <>
                <p>
                  Core records a <Mono>cancelled</Mono> status event and stops the agent through the
                  adapter's supported cancellation, or a controlled process-tree stop. Partial work
                  stays in the sandbox until you review it.
                </p>
                <p>
                  This is not the same as closing a tab, and it does not delete the task's events.
                </p>
              </>
            }
          />
          {cancel.isError && <ErrorPanel error={cancel.error} />}
          {cancel.isSuccess && (
            <Warning tone="info" title="Cancellation requested">
              The status badge changes when Core appends the <Mono>status.changed</Mono> event — not
              before.
            </Warning>
          )}
        </Panel>
      </div>
      <ReviewPanel taskId={taskId} liveWritable={false} />
    </div>
  );
}
