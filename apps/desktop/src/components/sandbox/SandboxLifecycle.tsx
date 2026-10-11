import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  useLifecycleGates,
  useSandboxRemovalFlow,
  useStopConfirm,
  useStopSandbox,
  useTaskProjections,
} from "../../lib/hooks";
import type { CoreRequestError } from "../../lib/core-client";
import {
  confirmationView,
  gateBlockLabel,
  isExpired,
  parseExpiry,
  startUnsupportedCopy,
  EXTERNAL_BANNER,
  EXTERNAL_TEXT,
  STOP_ENDS_VERIFICATION,
  stopConfirmationCopy,
  stopOutcomeView,
  type ActiveTaskCount,
  type ConfirmationView,
  type SandboxStopConfirm,
  type StopConfirmState,
  type RemovalState,
  type SandboxRemovalFlow,
} from "../../lib/sandbox-lifecycle";
import type {
  ConfirmationRequest,
  SandboxStopResult,
  SandboxSummary,
} from "../../lib/protocol";
import { displayRevealed, verificationsRunningIn } from "../../lib/reducers";
import { Button, ConfirmDialog, Mono, Warning } from "../ui/primitives";
import { ErrorPanel } from "../../features/projects/ProjectsView";

/** The answer to one `sandbox.stop`, kept until the user dismisses it. */
export type StopOutcome =
  | { name: string; result: SandboxStopResult }
  | { name: string; error: CoreRequestError };

/**
 * Lifecycle state owned by the VIEW (list or detail), not by a row.
 *
 * Stop and remove both re-read `sandbox.list` when they settle, and exactly the
 * outcomes that matter most — "state UNKNOWN" after a stop, "removed", "already
 * gone" — are the ones where the row disappears from that list (or the whole
 * list turns into an error). Notices kept in the row would unmount with it, so
 * they live here and are rendered once by `SandboxLifecycleNotices`.
 */
export interface SandboxLifecycle {
  flow: SandboxRemovalFlow;
  removal: RemovalState;
  /** The stop confirmation (specs/05: stop requires a confirmation too). */
  stopConfirm: SandboxStopConfirm;
  stopDialog: StopConfirmState;
  /** Names whose `sandbox.stop` is in flight (per sandbox, never global). */
  stopsPending: ReadonlySet<string>;
  /** Confirmed in the dialog → send `sandbox.stop` once for that name. */
  confirmStop: () => void;
  stopOutcomes: readonly StopOutcome[];
  dismissStop: (name: string) => void;
}

export function useSandboxLifecycle(): SandboxLifecycle {
  const { flow, state } = useSandboxRemovalFlow();
  const { confirm: stopConfirm, state: stopDialog } = useStopConfirm();
  const [stopOutcomes, setStopOutcomes] = useState<readonly StopOutcome[]>([]);
  const [stopsPending, setStopsPending] = useState<ReadonlySet<string>>(() => new Set());
  const recordStop = useCallback((outcome: StopOutcome) => {
    setStopOutcomes((current) => [...current.filter((o) => o.name !== outcome.name), outcome]);
  }, []);
  const dismissStop = useCallback((name: string) => {
    setStopOutcomes((current) => current.filter((o) => o.name !== name));
  }, []);
  // Hook-level callbacks: they fire for every concurrent stop, and still fire
  // when the row that started it has been dropped by the list re-read.
  const stop = useStopSandbox({
    onSuccess: (result, name) => recordStop({ name, result }),
    onError: (error, name) => recordStop({ name, error }),
    onSettled: (name) =>
      setStopsPending((current) => {
        const next = new Set(current);
        next.delete(name);
        return next;
      }),
  });
  const confirmStop = useCallback(() => {
    const name = stopConfirm.confirm();
    if (name === null) return;
    dismissStop(name);
    setStopsPending((current) => new Set(current).add(name));
    stop.mutate(name);
  }, [stopConfirm, dismissStop, stop]);
  return {
    flow,
    removal: state,
    stopConfirm,
    stopDialog,
    stopsPending,
    confirmStop,
    stopOutcomes,
    dismissStop,
  };
}

/**
 * Start / Stop / Remove buttons for one sandbox row (A1).
 *
 * - Start is visibly unsupported: sbx v0.47 has no `start`, and the desktop
 *   never runs `sbx run` for the user.
 * - Stop and Remove are enabled only when THIS Core advertises the method in
 *   `system.probe`; otherwise they stay visible, disabled, and say why.
 * - Remove is Core's two-step confirmation: step 1 asks Core what removal would
 *   affect, the dialog shows that, and only an explicit "Remove sandbox" click
 *   sends step 2 with Core's token. Cancel sends nothing.
 *
 * - Stop is confirmed too (specs/05): the dialog shows how many non-terminal
 *   Core tasks record this sandbox, and cancelling sends nothing.
 *
 * Pending stops are tracked per sandbox name at view level, so a pending stop
 * never disables other rows, and its outcome survives the row unmounting.
 */
export function SandboxLifecycleControls({
  sandbox,
  lifecycle,
}: {
  sandbox: SandboxSummary;
  lifecycle: SandboxLifecycle;
}) {
  const gates = useLifecycleGates();
  const { flow, removal } = lifecycle;
  const stopping = lifecycle.stopsPending.has(sandbox.name);
  const stopDialogOpen = lifecycle.stopDialog.kind === "confirming";
  const noteId = useId();

  const stopBlocked = gateBlockLabel(gates.stop);
  const removeBlocked = gateBlockLabel(gates.remove);
  // One removal at a time per view: the dialog is modal anyway.
  const removalActive =
    removal.kind === "requesting" || removal.kind === "removing" || removal.kind === "confirming";
  const removingThis = removalActive && removal.name === sandbox.name;
  const startCopy = startUnsupportedCopy(sandbox.name);

  return (
    <div className="stack sandbox-lifecycle">
      <div className="row-actions" aria-describedby={noteId}>
        <Button disabled title={startCopy}>
          Start
        </Button>
        <Button
          disabled={stopBlocked !== null || stopping || stopDialogOpen || removingThis}
          title={
            stopBlocked === null
              ? "Asks you to confirm, then sbx stop and a Core re-query of SBX"
              : `Stop: ${stopBlocked}`
          }
          onClick={() => lifecycle.stopConfirm.open(sandbox.name)}
        >
          {stopping ? "Stopping…" : "Stop…"}
        </Button>
        <Button
          variant="danger"
          disabled={removeBlocked !== null || removalActive || stopping || stopDialogOpen}
          title={
            removeBlocked === null
              ? "Asks Core what removal would affect, then asks you to confirm"
              : `Remove: ${removeBlocked}`
          }
          onClick={() => void flow.begin(sandbox.name)}
        >
          {removingThis && removal.kind === "requesting" ? "Preparing…" : "Remove…"}
        </Button>
      </div>
      <p id={noteId} className="muted sandbox-lifecycle__notes">
        {startCopy}
        {stopBlocked !== null && <> · Stop: {stopBlocked}</>}
        {removeBlocked !== null && <> · Remove: {removeBlocked}</>}
      </p>
      {stopping && (
        <p className="muted" role="status">
          Stopping — Core runs <Mono>sbx stop</Mono> and then re-queries SBX; this can take a few
          minutes and is never retried automatically.
        </p>
      )}
    </div>
  );
}

/**
 * Stop outcomes, removal progress/results, and the confirmation dialog —
 * rendered ONCE per view, outside the sandbox rows and outside the list's
 * error branch, so they survive the list re-read that every outcome triggers.
 */
export function SandboxLifecycleNotices({ lifecycle }: { lifecycle: SandboxLifecycle }) {
  const { flow, removal, stopOutcomes, dismissStop, stopDialog } = lifecycle;
  // A7: runs this window's task events show started in that sandbox and not
  // yet finished. Informational only — stop stays allowed and ends the run.
  const projections = useTaskProjections();
  const verificationsRunning =
    stopDialog.kind === "confirming" ? verificationsRunningIn(projections, stopDialog.name) : 0;
  return (
    <>
      {stopDialog.kind === "confirming" && (
        <StopDialog
          name={stopDialog.name}
          active={stopDialog.active}
          verificationsRunning={verificationsRunning}
          onCancel={() => lifecycle.stopConfirm.cancel()}
          onConfirm={lifecycle.confirmStop}
        />
      )}
      {stopOutcomes.map((outcome) => (
        <StopOutcomeNotice
          key={outcome.name}
          outcome={outcome}
          onDismiss={() => dismissStop(outcome.name)}
        />
      ))}
      <RemovalStatus state={removal} flow={flow} />
      {removal.kind === "confirming" && (
        <RemovalDialog confirmation={removal.confirmation} flow={flow} />
      )}
    </>
  );
}

/**
 * Stop confirmation on the shared `ConfirmDialog`: initial focus on Cancel,
 * Escape cancels, explicit "Stop sandbox". The active-task count never blocks
 * the button; while it is being checked the dialog says so. Exported for the
 * markup tests.
 */
export function StopDialog({
  name,
  active,
  verificationsRunning = 0,
  onCancel,
  onConfirm,
}: {
  name: string;
  active: ActiveTaskCount;
  /** A7: verification runs this window knows are in flight in this sandbox. */
  verificationsRunning?: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = stopConfirmationCopy(name, active);
  return (
    <ConfirmDialog
      open
      title={copy.title}
      confirmLabel="Stop sandbox"
      onCancel={onCancel}
      onConfirm={onConfirm}
      consequence={
        <div className="stack">
          <p className={copy.tasksAtRisk ? "stop-tasks stop-tasks--risk" : "stop-tasks"} role="status">
            {copy.taskLine}
          </p>
          {verificationsRunning > 0 && (
            <p className="stop-tasks stop-tasks--risk" role="note">
              {STOP_ENDS_VERIFICATION}
            </p>
          )}
          <p>{copy.body}</p>
        </div>
      }
    />
  );
}

function StopOutcomeNotice({
  outcome,
  onDismiss,
}: {
  outcome: StopOutcome;
  onDismiss: () => void;
}) {
  const name = displayRevealed(outcome.name, 63).text;
  if ("error" in outcome) {
    return (
      <div className="stack">
        <p className="muted">
          Stop <Mono>{name}</Mono>:
        </p>
        <ErrorPanel error={outcome.error} />
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  }
  const view = stopOutcomeView(outcome.result);
  return (
    <Warning tone={view.stateKnown ? "info" : "attention"} title={`${name}: ${view.title}`}>
      {view.body}{" "}
      <Button variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </Warning>
  );
}

function RemovalStatus({ state, flow }: { state: RemovalState; flow: SandboxRemovalFlow }) {
  switch (state.kind) {
    case "requesting":
      return (
        <p className="muted" role="status">
          Asking Core what removing <Mono>{displayRevealed(state.name, 63).text}</Mono> would
          affect. Nothing is changed by this step.
        </p>
      );
    case "removing":
      return (
        <p className="muted" role="status">
          Removing <Mono>{displayRevealed(state.target.name, 200).text}</Mono> — Core re-checks the
          sandbox id, then runs the removal. This can take a few minutes and is never retried.
        </p>
      );
    case "removed":
      return (
        <Warning tone="success" title="Core removed the sandbox">
          <Mono>{displayRevealed(state.target.name, 200).text}</Mono> (sbx id{" "}
          <Mono>{displayRevealed(state.target.id, 200).text}</Mono>) was removed. The list is
          re-read from SBX.{" "}
          <Button variant="ghost" onClick={() => flow.reset()}>
            Dismiss
          </Button>
        </Warning>
      );
    case "failed":
      return (
        <Warning
          tone={state.stage === "expired" ? "attention" : "danger"}
          title={`${displayRevealed(state.name, 63).text}: ${state.copy.title}`}
        >
          <p>{state.copy.body}</p>
          {state.copy.coreMessage !== undefined && (
            <p>
              <strong>Core said:</strong> <Mono>{state.copy.coreMessage}</Mono>
            </p>
          )}
          <p>
            <strong>What you can do:</strong> {state.copy.action}
          </p>
          <Button variant="ghost" onClick={() => flow.reset()}>
            Dismiss
          </Button>
        </Warning>
      );
    default:
      return null;
  }
}

/**
 * The in-app confirmation for Core's step-1 answer. Built on the shared
 * `ConfirmDialog` (same primitive as the Git apply confirmation): focus is
 * trapped, initial focus is Cancel, Escape cancels, and focus returns to the
 * Remove button on close. The confirm button is disabled once Core's expiry
 * passes (checked on a timer AND at click time) and after the first click.
 */
export function RemovalDialog({
  confirmation,
  flow,
}: {
  confirmation: ConfirmationRequest;
  flow: SandboxRemovalFlow;
}) {
  const [now, setNow] = useState(() => Date.now());
  const clicked = useRef(false);

  useEffect(() => {
    clicked.current = false;
    setNow(Date.now());
    // A once-a-second tick keeps the countdown honest and flips `expired` on
    // time; the click-time check below covers a throttled (hidden) window.
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [confirmation]);

  const view = confirmationView(confirmation, now);

  return (
    <ConfirmDialog
      open
      title="Remove this sandbox?"
      consequence={<RemovalConsequence view={view} />}
      confirmLabel="Remove sandbox"
      confirmDisabled={view.expired || clicked.current}
      onCancel={() => flow.cancel()}
      onConfirm={() => {
        if (clicked.current) return;
        if (isExpired(parseExpiry(confirmation.expiresAt), Date.now())) {
          setNow(Date.now());
          flow.confirm(); // records the expiry; sends nothing
          return;
        }
        clicked.current = true;
        flow.confirm();
      }}
    />
  );
}

/**
 * Everything Core said about the removal, rendered as React TEXT nodes only
 * (never injected as raw HTML). Untrusted strings arrive pre-revealed by
 * `confirmationView`, so hidden/bidi/control characters show as `\uXXXX`.
 * Exported for the markup tests.
 */
export function RemovalConsequence({ view }: { view: ConfirmationView }) {
  return (
    <div className="stack">
      {view.external && (
        <div className="removal-external" role="alert">
          <strong>{EXTERNAL_BANNER}</strong> — {EXTERNAL_TEXT}
        </div>
      )}
      <dl className="kvs">
        <div className="kv">
          <dt>sandbox</dt>
          <dd>
            <Mono>{view.targetName}</Mono>
          </dd>
        </div>
        <div className="kv">
          <dt>sbx id</dt>
          <dd>
            <Mono>{view.targetId}</Mono>
          </dd>
        </div>
        <div className="kv">
          <dt>confirmation expires</dt>
          <dd>
            <Mono>{view.expiresAtText}</Mono>{" "}
            {view.expired
              ? "— EXPIRED. Cancel and request a new confirmation."
              : `(${view.secondsLeft} s left)`}
          </dd>
        </div>
      </dl>
      <p>
        <strong>What Core says this removal does:</strong>
      </p>
      {view.impactLines.length === 0 ? (
        <p>Core listed no impact lines.</p>
      ) : (
        <ul className="removal-impact">
          {view.impactLines.map((line, index) => (
            // Index keys: lines may repeat, and the list never reorders.
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      {view.overflowLine !== null && <p className="removal-impact__overflow">{view.overflowLine}</p>}
      {view.revealedHiddenCharacters && (
        <p className="removal-impact__overflow">
          Some text above contained hidden, control or direction-changing characters; they are shown
          as <Mono>{"\\u"}</Mono> escapes instead of being applied.
        </p>
      )}
      <p>
        Core re-checks that the sandbox still has this sbx id before removing it. Nothing is
        removed if you cancel.
      </p>
    </div>
  );
}
