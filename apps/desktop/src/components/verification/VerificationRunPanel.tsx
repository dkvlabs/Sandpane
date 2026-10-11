/**
 * A7 task-level Run control and results (design 2026-10-09 §3.7).
 *
 * - Gated on the `verification` feature AND a bound task: the expected
 *   sandbox is the task's BINDING (`sandboxName`, never `chosenSandboxName`)
 *   and its mode comes from that sandbox's `sandbox.list` entry.
 * - The run dialog opens ONLY from a trusted click on Run; the command comes
 *   from Core's own list for the task's project. Confirm sends ONE frame with
 *   a FRESH idempotency key (single flight per task, in the mutation cache);
 *   only "Retry safely" after a lost answer resends the SAME key.
 * - Results are read with `verification.result` when the task's events show a
 *   run finished, or when the user presses Refresh — never on a timer.
 * - Nothing here changes or infers the task's status (rule 3).
 */

import { useRef, useState } from "react";
import {
  capabilitiesOf,
  useCoreLink,
  useRunVerification,
  useSandboxes,
  useTaskProjection,
  useVerificationCommands,
  useVerificationGate,
  useVerificationResult,
} from "../../lib/hooks";
import { forNewAction, idempotencyKeysAdvertised } from "../../lib/idempotency";
import { verificationRunsOf, type VerificationRunRecord } from "../../lib/reducers";
import {
  ARGV_ELEMENT_DISPLAY_MAX_CHARS,
  DISCLOSURE_BEST_EFFORT,
  LABEL_DISPLAY_MAX_CHARS,
  NAME_DISPLAY_MAX_CHARS,
  RUN_UNVERIFIED_NOTICE,
  openRunConfirmation,
  outcomeView,
  resultDisclosures,
  revealTimestamp,
  runBinding,
  runBlockedReason,
  shortRunId,
  verificationFailureCopy,
  type RunSnapshot,
} from "../../lib/verification";
import { TOO_LATE_TO_RETRY_SAFELY, retrySafelyWindow, runFailureCopyAt } from "../../lib/verification-mutations";
import type { VerificationResult, VerificationRunParams, VerificationRunResult } from "../../lib/protocol";
import { Badge, Button, Mono, Panel, Warning } from "../ui/primitives";
import { FeatureGateNotice } from "../ui/feature-gate";
import { RunConfirmDialog } from "./VerificationDialogs";
import { VerificationFailureNotice } from "./VerificationPanel";
import { ArgvList, OutputBlock, RevealedText } from "./VerificationText";

export function VerificationRunPanel({
  taskId,
  task,
  projectId,
}: {
  taskId: string;
  /** The task's `task.list` row (its binding), or null when Core did not list it. */
  task: { sandboxName: string | null } | null;
  /** The task's project, or null when this view cannot tell. */
  projectId: string | null;
}) {
  const gate = useVerificationGate();
  const supported = gate.state === "supported";
  const link = useCoreLink();
  const keysAdvertised = idempotencyKeysAdvertised(capabilitiesOf(link));
  const commands = useVerificationCommands(projectId, supported);
  const sandboxList = useSandboxes(supported);
  const projection = useTaskProjection(taskId);
  const run = useRunVerification(taskId);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  /** Synchronous latch: a double click on Retry safely re-probes and sends once. */
  const retrying = useRef(false);

  if (!supported) {
    return (
      <Panel title="Verification run">
        <FeatureGateNotice gate={gate} title="Verification runs" />
      </Panel>
    );
  }

  const binding = runBinding(task, sandboxList.sandboxes, !sandboxList.isLoading && sandboxList.error === null);
  const list = commands.commands ?? [];
  const command = list.find((c) => c.id === selected) ?? null;
  const runs = verificationRunsOf(projection);
  const current = run.view.current;
  const failedVariables = current?.status === "error" ? current.variables : undefined;
  // D-I5: past the key's retry window, Retry safely is withdrawn ("too late").
  const failedCopy =
    current?.status === "error" && current.error !== null
      ? runFailureCopyAt(verificationFailureCopy(current.error, "run"), run.view, Date.now())
      : null;
  // D-I2: an earlier lost answer does not block a NEW gesture; the dialog warns instead.
  const blocked = runBlockedReason({ projectId, binding, commandCount: list.length, command, pending: run.pending });

  const confirm = () => {
    const sent = snapshot;
    setSnapshot(null);
    if (sent === null) return;
    const params: VerificationRunParams = forNewAction(
      {
        taskId: sent.taskId,
        commandId: sent.command.id,
        expectedSandboxName: sent.expectedSandboxName,
        expectedWorkspaceMode: sent.expectedWorkspaceMode,
      },
      keysAdvertised,
    );
    setRetryNote(null);
    run.submit({ request: params, retry: false });
  };

  const retrySafely = async () => {
    if (failedVariables === undefined || run.pending || retrying.current) return;
    retrying.current = true;
    try {
      await retryOnce(failedVariables.request);
    } finally {
      retrying.current = false;
    }
  };

  const retryOnce = async (request: VerificationRunParams) => {
    if (retrySafelyWindow(run.view, Date.now()) !== "open") {
      setRetryNote(`Not retried: ${TOO_LATE_TO_RETRY_SAFELY}`);
      return;
    }
    const check = await run.recheck().catch(() => ({ kind: "unreachable" as const }));
    if (check.kind === "not-advertised") {
      setRetryNote(
        "Not retried: the connected Core does not advertise idempotency keys, so a retry could run it twice. Nothing was sent — check the task's events first.",
      );
      return;
    }
    if (check.kind === "not-retried") {
      setRetryNote(check.note);
      return;
    }
    if (check.kind === "unreachable") {
      setRetryNote("Not retried: Core could not be re-checked, so nothing was sent. The earlier outcome is still unknown.");
      return;
    }
    if (retrySafelyWindow(run.view, Date.now()) !== "open") {
      setRetryNote(`Not retried: ${TOO_LATE_TO_RETRY_SAFELY}`);
      return;
    }
    setRetryNote(null);
    // The IDENTICAL request, same key: Core returns the first answer, or runs once.
    run.submit({ request, retry: true });
  };

  return (
    <Panel title="Verification run" description="Run one approved command inside this task's sandbox with sbx exec.">
      <Warning tone="info" title="Running is disabled for every sbx version today">
        {RUN_UNVERIFIED_NOTICE} No task created over the wire is bound to a sandbox yet, so Run stays disabled or is
        refused with nothing run.
      </Warning>
      {commands.error !== null && <VerificationFailureNotice copy={verificationFailureCopy(commands.error, "list")} />}
      {list.length > 0 && (
        <fieldset className="stack">
          <legend className="field__label">Approved command</legend>
          {list.map((c) => (
            <label key={c.id} className="row">
              <input
                type="radio"
                name={`verification-command-${taskId}`}
                checked={selected === c.id}
                onChange={() => setSelected(c.id)}
              />{" "}
              <RevealedText value={c.label} max={LABEL_DISPLAY_MAX_CHARS} />
            </label>
          ))}
        </fieldset>
      )}
      <div className="row-actions">
        <Button
          variant="primary"
          disabled={blocked !== null}
          onClick={(event) => {
            const opened = openRunConfirmation(event, {
              taskId,
              command,
              binding,
              earlierRunUnknown: run.view.earlierRunUnknown,
            });
            if (opened !== null) setSnapshot(opened);
          }}
        >
          Run…
        </Button>
        {blocked !== null && <span className="muted">Run is unavailable: {blocked}.</span>}
      </div>
      {snapshot !== null && (
        <RunConfirmDialog
          snapshot={snapshot}
          confirmDisabled={run.pending}
          onCancel={() => setSnapshot(null)}
          onConfirm={confirm}
        />
      )}
      {run.pending && <p className="muted" role="status">Starting — Core answers once it has recorded the start.</p>}
      {current?.status === "success" && current.data !== undefined && <RunStartedStatus data={current.data} />}
      {failedCopy !== null && (
        <VerificationFailureNotice
          copy={failedCopy}
          {...(failedCopy.retrySafely && failedVariables?.request.idempotencyKey !== undefined
            ? { onRetrySafely: () => void retrySafely() }
            : {})}
        />
      )}
      {(run.view.note ?? retryNote) !== null && (
        <p className="muted" role="status">
          {run.view.note ?? retryNote}
        </p>
      )}

      <h3 className="apply-confirm__heading">Runs recorded in this task's events</h3>
      {runs.length === 0 ? (
        <p className="muted">No verification has started for this task.</p>
      ) : (
        <ul className="list">
          {[...runs].reverse().map((r) => (
            <li key={r.runId} className="row row--stacked">
              <RunResultView record={r} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Core's answer to a run that started: run id and timestamps revealed (D-I1). */
export function RunStartedStatus({ data }: { data: VerificationRunResult }) {
  return (
    <p className="muted" role="status">
      {data.replayed === true || data.replayedUncertain === true
        ? "Core returned the answer to your earlier identical request (replayed); no second run was started. "
        : "Core recorded the start. "}
      Run <Mono>{shortRunId(data.runId)}</Mono> started at event #{data.startedSequence}; its result appears below
      when the task's events record the finish.
    </p>
  );
}

/** A run's identity line from its events: run id, start, sandbox — every Core string revealed (D-I1). */
export function RunRecordMeta({ record }: { record: VerificationRunRecord }) {
  return (
    <>
      run <Mono>{shortRunId(record.runId)}</Mono> · started #{record.startedSequence} · {revealTimestamp(record.startedAt)}
      {record.sandbox !== null && (
        <>
          {" "}
          · sandbox <RevealedText value={record.sandbox} max={NAME_DISPLAY_MAX_CHARS} />
        </>
      )}
    </>
  );
}

/** The stored result's timing line: elapsed, mode and `finishedAt` revealed (D-I1). */
export function ResultMetaLine({ result }: { result: Pick<VerificationResult, "elapsedMs" | "workspaceMode" | "finishedAt"> }) {
  return (
    <p className="muted">
      {result.elapsedMs !== undefined ? `elapsed ${result.elapsedMs} ms · ` : ""}
      workspace mode <RevealedText value={result.workspaceMode} max={64} />
      {result.finishedAt !== undefined ? ` · finished ${revealTimestamp(result.finishedAt)}` : ""}
    </p>
  );
}

/** One run: the outcome from its events, and the stored result once it finished (or on Refresh). */
export function RunResultView({ record }: { record: VerificationRunRecord }) {
  const [requested, setRequested] = useState(false);
  const finishedSequence = record.finished?.sequence ?? null;
  const read = useVerificationResult(record.runId, finishedSequence, requested);
  const eventOutcome =
    record.finished === null
      ? outcomeView("running", undefined)
      : record.finished.outcome === null
        ? { label: "Core did not report a readable outcome", tone: "attention" as const }
        : outcomeView(record.finished.outcome, record.finished.exitCode);
  const result = read.result;
  const view = result === null ? eventOutcome : outcomeView(result.outcome, result.exitCode);
  return (
    <div className="stack">
      <span className="row__title">
        {record.label === null ? (
          <span className="muted">(label not recorded)</span>
        ) : (
          <RevealedText value={record.label} max={LABEL_DISPLAY_MAX_CHARS} />
        )}{" "}
        <Badge tone={view.tone}>{view.label}</Badge>
      </span>
      <span className="row__meta">
        <RunRecordMeta record={record} />{" "}
        <Button
          variant="ghost"
          onClick={() => {
            setRequested(true);
            read.refetch();
          }}
        >
          Refresh
        </Button>
      </span>
      {read.isLoading && <p className="muted">Reading the result…</p>}
      {read.error !== null && <VerificationFailureNotice copy={verificationFailureCopy(read.error, "result")} />}
      {result !== null && (
        <div className="stack">
          <ArgvList argv={result.argv} max={ARGV_ELEMENT_DISPLAY_MAX_CHARS} />
          <ResultMetaLine result={result} />
          <ul className="apply-confirm__list">
            {resultDisclosures(result).map((d) => (
              <li key={d}>{d}</li>
            ))}
            <li className="muted">{DISCLOSURE_BEST_EFFORT}</li>
          </ul>
          <OutputBlock label="stdout" output={result.stdout} />
          <OutputBlock label="stderr" output={result.stderr} />
        </div>
      )}
      {result === null && record.finished !== null && record.finished.disclosures.length > 0 && (
        <ul className="apply-confirm__list">
          {record.finished.disclosures.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
