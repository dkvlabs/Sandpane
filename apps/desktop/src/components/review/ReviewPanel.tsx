import { useEffect, useRef, useState } from "react";
import {
  capabilitiesOf,
  useApplyChanges,
  useCoreLink,
  useForgetTaskDiffs,
  useTaskDiff,
  useTaskReview,
} from "../../lib/hooks";
import {
  changeSetCompleteness,
  copyDiffText,
  diffCopyNote,
  diffFailureCopy,
  diffGate,
} from "../../lib/git-diff";
import {
  applyFailureCopy,
  applyGate,
  applyOutcomeCopy,
  confirmRefusal,
  diffMismatch,
  diffRecordKey,
  diffRecordFor,
  openApplyConfirmation,
  planReviewedApply,
  reviewSelectability,
  type ApplySnapshot,
  type DiffRecord,
} from "../../lib/git-apply";
import type { FileChangeStatus } from "../../lib/protocol";
import { ApplyConfirmDialog } from "./ApplyConfirmDialog";
import { ApplyOutcome } from "./ApplyOutcome";
import { DiffView } from "./DiffView";
import {
  displayPath,
  displayRaw,
  fileChangeLabel,
  reviewSummary,
  type SandboxModeView,
} from "../../lib/reducers";
import { Badge, Button, EmptyState, Mono, Panel, Warning } from "../ui/primitives";
import { ErrorPanel } from "../../features/projects/ProjectsView";

/**
 * Git review surface (docs/specs/05 §3.C, design spec S07).
 *
 * Only the change set Core returned is listed — file paths, their status and
 * (A5) a rename's old path. Each entry has a Diff action (A5 `git.diff`, gated
 * on advertisement) that shows Core's patch as read-only, revealed text; the
 * patch is never applied from here.
 *
 * A6 apply (design 2026-10-09 §3.6), gated on the `git-apply` feature:
 * - per-entry checkboxes plus "select all" over the entries of ONE `git.review`
 *   answer (selection is keyed by entry index AND that answer's `reviewId`, so
 *   a new answer starts with nothing selected);
 * - the entries sent are copied VERBATIM from that answer, with its
 *   `reviewId` — never `selectedFiles`;
 * - the confirmation (`ApplyConfirmDialog`) opens ONLY from the Apply button's
 *   click handler, on a trusted user gesture, and shows a frozen snapshot that
 *   is exactly what is sent;
 * - a `git.diff` the user opened that returned a different `taskBlob` blocks
 *   the send ("changed after you reviewed it — review again");
 * - single-flight, never retried; the review is re-read after every outcome.
 *
 * Forward compatibility: a file whose status this build does not recognise is
 * listed with Core's raw status but cannot be selected (nor can a recognised
 * twin of its path). A task whose own status is unrecognised gets
 * `blockedReason`, which disables both review and apply.
 *
 * Paths are Core's raw strings and are only ever SHOWN through `displayPath`:
 * hidden, control or reordering characters appear as visible escapes with an
 * "unusual characters" mark, never silently cleaned — and never altered in
 * what is selected or sent.
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
  const blocked = blockedReason !== null;
  const { changeSet, isLoading, error, refetch } = useTaskReview(taskId, requested && !blocked);
  // Keyed per task in the client cache: single flight and the last outcome
  // survive a task switch (A6 review W2).
  const apply = useApplyChanges(taskId);
  const forgetDiffs = useForgetTaskDiffs();
  const capabilities = capabilitiesOf(useCoreLink());
  // A5: one open diff at a time, addressed by the entry's exact path + status.
  const gate = diffGate(capabilities);
  // A6: Apply needs the git.apply method AND the git-apply feature.
  const applyAvailability = applyGate(capabilities);
  const applySupported = applyAvailability.state === "supported";
  const [diffEntry, setDiffEntry] = useState<{ path: string; status: FileChangeStatus } | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const diff = useTaskDiff(diffEntry === null ? null : { taskId, ...diffEntry });
  const incomplete = changeSet === null ? null : changeSetCompleteness(changeSet);

  // A6 state. The selection belongs to ONE review answer (its reviewId).
  const [selection, setSelection] = useState<{ reviewId: string | null; indices: ReadonlySet<number> }>({
    reviewId: null,
    indices: new Set(),
  });
  // What each opened git.diff showed (taskBlob, binary, truncated) — never the patch.
  const [diffs, setDiffs] = useState<ReadonlyMap<string, DiffRecord>>(new Map());
  // Non-null ONLY between a trusted click on Apply and Cancel/confirm.
  const [confirm, setConfirm] = useState<ApplySnapshot | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const result = diff.result;
    if (diffEntry === null || result === null) return;
    // I2: recorded only when BOTH path and status are the opened entry's.
    const record = diffRecordFor(diffEntry, result);
    if (record === null) return;
    const key = diffRecordKey(diffEntry.path, diffEntry.status);
    setDiffs((previous) => new Map(previous).set(key, record));
  }, [diff.result, diffEntry]);

  const reviewId = changeSet?.reviewId ?? null;
  const selected: ReadonlySet<number> =
    reviewId !== null && selection.reviewId === reviewId ? selection.indices : new Set<number>();
  const selectability = changeSet === null ? [] : reviewSelectability(changeSet);
  const selectableIndices = selectability.flatMap((verdict, index) => (verdict.selectable ? [index] : []));
  const allSelected = selectableIndices.length > 0 && selectableIndices.every((index) => selected.has(index));
  const plan =
    changeSet === null ? null : planReviewedApply({ taskId, changeSet, selected, diffs });

  // The newest apply of THIS task (from the client cache, not this mount).
  const last = apply.last;
  const lastRepo = last?.variables?.repoPath;
  const lastCount = last?.variables?.request.entries.length ?? 0;
  const lastCopy =
    last === null
      ? null
      : last.status === "error" && last.error !== null
        ? applyFailureCopy(last.error, lastRepo)
        : last.status === "success" && last.data !== undefined
          ? applyOutcomeCopy(last.data, lastRepo, lastCount)
          : null;
  const lastResult = last?.status === "success" ? (last.data ?? null) : null;
  const outcomeUnknown = lastCopy?.kind === "unknown";
  const summary = reviewSummary(changeSet, lastResult, lastCount, outcomeUnknown);

  /** "Review again": a fresh git.review; the selection and diff records are discarded. */
  const reviewAgain = () => {
    setSelection({ reviewId: null, indices: new Set() });
    setDiffs(new Map());
    setConfirm(null);
    setRefusal(null);
    setDiffEntry(null);
    forgetDiffs(taskId);
    // Keep any outcome that may have written files (success, partial, a lost
    // answer) on screen; only a clean refusal (nothing written) is cleared.
    if (lastCopy !== null && (lastCopy.kind === "aborted" || lastCopy.kind === "refused" || lastCopy.kind === "not-sent")) {
      apply.forgetSettled();
    }
    setRequested(true);
    refetch();
  };

  const setSelected = (indices: ReadonlySet<number>) => setSelection({ reviewId, indices });

  const onConfirm = () => {
    const snapshot = confirm;
    setConfirm(null);
    // Single-flight: never a second git.apply while one is pending.
    if (snapshot === null || inFlight.current || apply.pending) return;
    // A diff may have arrived after the modal opened: re-check, send nothing.
    const refused = confirmRefusal(snapshot, diffs);
    if (refused !== null) {
      setRefusal(refused);
      return;
    }
    inFlight.current = true;
    apply.mutate({ request: snapshot.request, repoPath: snapshot.repoPath }, {
      onSettled: () => {
        inFlight.current = false;
      },
    });
  };

  return (
    <Panel
      title="Changes & review"
      description={`Task ${taskId.slice(0, 8)} · git.review reads the ACTUAL change set versus the recorded base commit.`}
      actions={
        <>
          <Button onClick={() => setRequested(true)} disabled={isLoading || blocked}>
            Review changes
          </Button>
          {changeSet !== null && !blocked && (
            <Button variant="ghost" onClick={reviewAgain} disabled={apply.pending}>
              Review again
            </Button>
          )}
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
            {changeSet.repoPath !== undefined && (
              <div className="kv">
                <dt>repository</dt>
                <dd>
                  <Mono>{displayPath(changeSet.repoPath).text}</Mono>
                </dd>
              </div>
            )}
          </dl>

          {incomplete !== null && (
            <Warning tone="attention" title="Change set not complete">
              {incomplete} Core reported paths it could not inspect, so this list may not show every
              change.
            </Warning>
          )}

          {changeSet.changes.length === 0 && incomplete !== null ? (
            <p className="muted">Core listed no inspected changes; see the warning above.</p>
          ) : changeSet.changes.length === 0 ? (
            <EmptyState
              heading="Empty change set"
              body="Core reported no files changed against the base commit. That is a real result, not a load failure."
            />
          ) : (
            <>
              {applySupported && selectableIndices.length > 0 && (
                <label className="row__check">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={apply.pending}
                    onChange={(event) =>
                      setSelected(event.target.checked ? new Set(selectableIndices) : new Set())
                    }
                  />
                  Select all applicable ({selectableIndices.length} of {changeSet.changes.length})
                </label>
              )}
              <ul className="list list--files">
                {changeSet.changes.map((change, index) => {
                  const verdict = selectability[index] ?? { selectable: false, reason: "" };
                  const shown = displayPath(change.path);
                  const changedSinceReview =
                    change.status !== "unknown" &&
                    diffMismatch(change, diffs.get(diffRecordKey(change.path, change.status)));
                  const checkTitle = !applySupported
                    ? applyAvailability.note
                    : verdict.selectable
                      ? undefined
                      : change.status === "unknown"
                        ? `Core reported status "${displayRaw(change.unrecognizedStatus ?? "unknown")}", which this build does not recognise; it cannot be applied from here.`
                        : verdict.reason;
                  return (
                    // Core may list a path more than once; index keeps keys unique.
                    <li key={`${index}:${change.path}`} className="row">
                      <label className="row__check" title={checkTitle}>
                        <input
                          type="checkbox"
                          disabled={!applySupported || !verdict.selectable || apply.pending}
                          checked={applySupported && verdict.selectable && selected.has(index)}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.target.checked) next.add(index);
                            else next.delete(index);
                            setSelected(next);
                          }}
                        />
                        {change.oldPath !== undefined && (
                          <>
                            <Mono>{displayPath(change.oldPath).text}</Mono> →{" "}
                          </>
                        )}
                        <Mono>{shown.text}</Mono>
                      </label>
                      {shown.unusual && (
                        <Badge
                          tone="attention"
                          title="This path contains hidden, control or look-alike characters. They are shown as \u escapes so the name cannot pass for a different file."
                        >
                          unusual characters
                        </Badge>
                      )}
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
                      {applySupported && !verdict.selectable && change.status !== "unknown" && (
                        <span className="muted">{verdict.reason}</span>
                      )}
                      {changedSinceReview && (
                        <Badge tone="danger" title="The diff you opened shows different content than this review.">
                          changed after review
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        disabled={gate.state !== "supported" || change.status === "unknown"}
                        title={
                          gate.state !== "supported"
                            ? gate.note
                            : change.status === "unknown"
                              ? "This build does not recognise this entry's status, so it cannot name the entry for git.diff."
                              : "Show Core's patch for this entry (read-only)"
                        }
                        onClick={() => {
                          if (change.status === "unknown") return;
                          setCopyNote(null);
                          // The entry's path and status exactly as git.review returned them.
                          setDiffEntry({ path: change.path, status: change.status });
                        }}
                      >
                        Diff
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {gate.state !== "supported" && <p className="muted">{gate.note}</p>}
          {diffEntry !== null && (
            <div className="review__diff">
              {diff.isLoading && <p className="muted">Reading the diff from Core…</p>}
              {diff.error !== null && (
                <Warning tone="attention" title={diffFailureCopy(diff.error).title}>
                  <p>{diffFailureCopy(diff.error).body}</p>
                  <p>{diffFailureCopy(diff.error).action}</p>
                </Warning>
              )}
              {diff.result !== null && (
                <DiffView
                  result={diff.result}
                  maxBytesSent={undefined}
                  copyNote={copyNote}
                  onCopy={() => {
                    const text = diff.result?.patch ?? "";
                    void copyDiffText(globalThis.navigator?.clipboard, text).then((outcome) =>
                      setCopyNote(outcome.ok ? diffCopyNote(text) : outcome.message),
                    );
                  }}
                />
              )}
              <Button variant="ghost" onClick={() => setDiffEntry(null)}>
                Close diff
              </Button>
            </div>
          )}

          <div className="row-actions">
            <Button
              variant="primary"
              disabled={!applySupported || !plan.ok || apply.pending || confirm !== null}
              onClick={(event) => {
                // The ONLY opener of the confirmation: a trusted click here.
                setRefusal(null);
                const snapshot = openApplyConfirmation(event, plan);
                if (snapshot !== null) setConfirm(snapshot);
              }}
            >
              {plan.ok ? `Apply ${plan.snapshot.request.entries.length} selected…` : "Apply selected…"}
            </Button>
            <span className="muted">
              {!applySupported
                ? applyAvailability.note
                : apply.pending
                  ? "Applying through Core… a second apply cannot start until this one answers."
                  : plan.ok
                    ? `${plan.snapshot.request.entries.length} reviewed file(s) selected.`
                    : plan.reason}
            </span>
            {applySupported && !plan.ok && plan.reReview && (
              <Button variant="ghost" onClick={reviewAgain}>
                Review again
              </Button>
            )}
          </div>

          {refusal !== null && (
            <Warning tone="danger" title="Not sent — nothing was written">
              <p>{refusal}</p>
              <Button variant="ghost" onClick={reviewAgain}>
                Review again
              </Button>
            </Warning>
          )}

          {confirm !== null && (
            <ApplyConfirmDialog
              snapshot={confirm}
              confirmDisabled={apply.pending}
              onCancel={() => setConfirm(null)}
              onConfirm={onConfirm}
            />
          )}

          {apply.pending && (
            <p className="muted">Applying through Core… Core's apply budget is 41 s.</p>
          )}
          {lastCopy !== null && <ApplyOutcome copy={lastCopy} onReReview={reviewAgain} />}
        </>
      )}
    </Panel>
  );
}
