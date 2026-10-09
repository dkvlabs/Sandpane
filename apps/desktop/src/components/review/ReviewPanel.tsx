import { useState } from "react";
import { useApplyChanges, useTaskReview } from "../../lib/hooks";
import {
  displayRaw,
  fileChangeLabel,
  planApply,
  reviewSummary,
  type SandboxModeView,
} from "../../lib/reducers";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Mono,
  Panel,
  Warning,
} from "../ui/primitives";
import { ErrorPanel } from "../../features/projects/ProjectsView";

/**
 * Git review surface (docs/specs/05 §3.C, design spec S07).
 *
 * Only the change set Core returned is listed — file paths and their status,
 * which is everything `git.review` provides in protocol v1. There is no diff
 * text method yet, so the panel says so instead of rendering invented hunks,
 * and apply is always an explicit, confirmed Git operation against a recorded
 * base commit.
 *
 * Forward compatibility: a file whose status this build does not recognise is
 * listed with Core's raw status but cannot be selected, and its presence blocks
 * a whole-set apply (`planApply`). A task whose own status is unrecognised gets
 * `blockedReason`, which disables both review and apply.
 */
export function ReviewPanel({
  taskId,
  isolation,
  blockedReason = null,
}: {
  taskId: string | null;
  /**
   * The disclosure for THIS task's own sandbox (`taskIsolationView`), never a
   * focused sandbox's. Unknown is UNVERIFIED and treated as live-writable.
   */
  isolation: SandboxModeView & { reason: string };
  /** Non-null when review/apply must stay disabled (`reviewBlockReason`). */
  blockedReason?: string | null;
}) {
  if (taskId === null) {
    return (
      <EmptyState
        heading="No task selected"
        body="Review works against a specific task's base commit. Pick a task from the timeline or Tasks & Review."
      />
    );
  }
  // Keyed by task: selection, the "review requested" flag, the confirm dialog
  // and the last apply result belong to ONE task and must never carry over
  // (a stale "Applied" or another task's selected files would be a lie).
  return (
    <ReviewPanelBody
      key={taskId}
      taskId={taskId}
      isolation={isolation}
      blockedReason={blockedReason}
    />
  );
}

function ReviewPanelBody({
  taskId,
  isolation,
  blockedReason,
}: {
  taskId: string;
  isolation: SandboxModeView & { reason: string };
  blockedReason: string | null;
}) {
  const [requested, setRequested] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const blocked = blockedReason !== null;
  const { changeSet, isLoading, error, refetch } = useTaskReview(taskId, requested && !blocked);
  const apply = useApplyChanges();

  const summary = reviewSummary(
    changeSet,
    apply.data ?? null,
    apply.variables?.selectedFiles?.length ?? undefined,
  );
  // What would actually be sent: unrecognised files are never included, and a
  // whole-set apply is refused while one is in the set.
  const plan = changeSet === null ? null : planApply(changeSet, selected);
  const selectedFiles = plan?.selectedFiles ?? [];

  return (
    <Panel
      title="Changes & review"
      description={`Task ${taskId.slice(0, 8)} · git.review reads the ACTUAL change set versus the recorded base commit.`}
      actions={
        <>
          <Button onClick={() => setRequested(true)} disabled={isLoading || blocked}>
            Review changes
          </Button>
          {changeSet !== null && !blocked && <Button variant="ghost" onClick={refetch}>
            Re-read
          </Button>}
        </>
      }
    >
      {isolation.liveWritable &&
        (isolation.verified ? (
          <Warning tone="attention" title="Direct-mounted task">
            Files may already be modified on the host: this workspace is writable immediately, so
            there is no isolated copy to fall back to. {isolation.reason}
          </Warning>
        ) : (
          <Warning tone="attention" title="Workspace mode UNVERIFIED — treated as live-writable">
            {isolation.reason} Until Core reports this task's binding, assume files may already be
            modified on the host.
          </Warning>
        ))}

      {blocked && (
        <Warning tone="attention" title="Review and apply are disabled for this task">
          {blockedReason}
        </Warning>
      )}

      {isLoading && !blocked && <p className="muted">Reading the change set from Core…</p>}
      {error !== null && <ErrorPanel error={error} />}

      {changeSet !== null && plan !== null && !blocked && (
        <>
          <div className="review__summary">
            <Badge tone={summary.tone}>{summary.headline}</Badge>
            <span className="muted">{summary.detail}</span>
          </div>
          <dl className="kvs kvs--tight">
            <div className="kv">
              <dt>base commit</dt>
              <dd>
                <Mono>{changeSet.baseCommit}</Mono>
              </dd>
            </div>
            <div className="kv">
              <dt>host dirty</dt>
              <dd>{changeSet.hostDirty ? "yes — uncommitted host changes exist" : "no"}</dd>
            </div>
          </dl>

          {changeSet.changes.length === 0 ? (
            <EmptyState
              heading="Empty change set"
              body="Core reported no files changed against the base commit. That is a real result, not a load failure."
            />
          ) : (
            <ul className="list list--files">
              {changeSet.changes.map((change) => (
                <li key={change.path} className="row">
                  <label
                    className="row__check"
                    title={
                      change.status === "unknown"
                        ? `Core reported status "${displayRaw(change.unrecognizedStatus ?? "unknown")}", which this build does not recognise; it cannot be applied from here.`
                        : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      disabled={change.status === "unknown"}
                      checked={change.status !== "unknown" && selected.has(change.path)}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.target.checked) next.add(change.path);
                        else next.delete(change.path);
                        setSelected(next);
                      }}
                    />
                    <Mono>{change.path}</Mono>
                  </label>
                  <Badge
                    tone={
                      change.status === "deleted"
                        ? "danger"
                        : change.status === "unknown"
                          ? "attention"
                          : "neutral"
                    }
                  >
                    {fileChangeLabel(change.status, change.unrecognizedStatus)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}

          <p className="muted">
            Diff text needs a Core method that protocol v1 does not have yet (no{" "}
            <Mono>git.diff</Mono>), so side-by-side hunks are a DT3 deliverable. Selection and
            apply already work against the real change set.
          </p>

          <div className="row-actions">
            <Button
              variant="primary"
              disabled={!plan.canApply || apply.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              Apply selected changes
            </Button>
            <span className="muted">
              {plan.blockedReason !== null
                ? plan.blockedReason
                : plan.selectedFiles === undefined
                  ? "Nothing selected — Core would apply the whole change set."
                  : `${plan.selectedFiles.length} file(s) selected.`}
            </span>
          </div>

          <ConfirmDialog
            open={confirmOpen}
            title="Apply these changes to your repository?"
            confirmLabel="Apply through Git"
            requirePhrase="apply"
            onCancel={() => setConfirmOpen(false)}
            onConfirm={() => {
              setConfirmOpen(false);
              // Re-derived at confirm time from the same plan the dialog shows;
              // never a whole-set apply while an unrecognised file is present.
              if (!plan.canApply) return;
              apply.mutate({
                taskId,
                expectedBase: changeSet.baseCommit,
                ...(plan.selectedFiles !== undefined ? { selectedFiles: plan.selectedFiles } : {}),
              });
            }}
            consequence={
              <>
                <p>
                  Core runs an explicit Git operation against base{" "}
                  <Mono>{changeSet.baseCommit}</Mono> and aborts if your tree moved since it was
                  recorded.
                </p>
                {changeSet.hostDirty && (
                  <p>
                    <strong>Your host tree is dirty.</strong> Applying now can collide with
                    uncommitted work you made outside Sandpane.
                  </p>
                )}
                <p>
                  {plan.selectedFiles === undefined
                    ? `All ${changeSet.changes.length} file(s) in the change set.`
                    : `Selected: ${selectedFiles.join(", ")}`}
                </p>
                {plan.unrecognized.length > 0 && (
                  <p>
                    Not included: {plan.unrecognized.length} file(s) whose status this build does
                    not recognise.
                  </p>
                )}
              </>
            }
          />

          {apply.isError && <ErrorPanel error={apply.error} />}
          {apply.data !== undefined && apply.data !== null && (
            <Warning
              tone={apply.data.applied ? "success" : "attention"}
              title={apply.data.applied ? "Applied" : "Not applied"}
            >
              {apply.data.abortReason !== null && apply.data.abortReason !== undefined ? (
                <p>{apply.data.abortReason}</p>
              ) : null}
              {apply.data.conflictedFiles.length > 0 && (
                <p>
                  Conflicts:{" "}
                  {apply.data.conflictedFiles.map((f) => (
                    <Mono key={f}>{f}</Mono>
                  ))}
                </p>
              )}
            </Warning>
          )}
        </>
      )}
    </Panel>
  );
}
