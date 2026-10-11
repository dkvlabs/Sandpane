/**
 * A7 confirmations (design 2026-10-09 §3.7 item 8): Approve and Run.
 *
 * Each renders ONLY while its panel holds a frozen snapshot, and a snapshot
 * is created ONLY by `openApproveConfirmation` / `openRunConfirmation` inside
 * a trusted click handler on Sandpane's own control. Nothing else — chat,
 * agent or tool text, an event, a timer, a reconnect — can open one or send.
 * Every Core- or user-supplied string is revealed and capped React text.
 */

import {
  APPROVE_BINDS_STATEMENT,
  APPROVE_NO_SECRETS,
  APPROVE_NO_SHELL,
  ARGV_ELEMENT_DISPLAY_MAX_CHARS,
  EARLIER_RUN_UNKNOWN_WARNING,
  LABEL_DISPLAY_MAX_CHARS,
  NAME_DISPLAY_MAX_CHARS,
  NOTE_DISPLAY_MAX_CHARS,
  RUN_NO_CANCEL_NOTE,
  RUN_STATEMENT,
  runModeWarnings,
  type ApproveSnapshot,
  type RunSnapshot,
} from "../../lib/verification";
import { sandboxModeView } from "../../lib/reducers";
import { Badge } from "../ui/primitives";
import { AlertConfirmDialog, ArgvList, RevealedText } from "./VerificationText";

export function ApproveConfirmDialog({
  snapshot,
  onCancel,
  onConfirm,
  confirmDisabled = false,
}: {
  snapshot: ApproveSnapshot;
  onCancel: () => void;
  onConfirm: () => void;
  confirmDisabled?: boolean;
}) {
  const { request, source } = snapshot;
  const count = request.argv.length;
  return (
    <AlertConfirmDialog
      title="Approve this exact argument list?"
      statement={
        <>
          <p>
            <strong>{APPROVE_BINDS_STATEMENT}</strong>
          </p>
          <p>
            <strong>{APPROVE_NO_SECRETS}</strong>
          </p>
        </>
      }
      confirmLabel="Approve"
      confirmDisabled={confirmDisabled}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <dl className="kvs kvs--tight">
        <div className="kv">
          <dt>label</dt>
          <dd>
            <RevealedText value={request.label} max={LABEL_DISPLAY_MAX_CHARS} />
          </dd>
        </div>
      </dl>
      <h3 className="apply-confirm__heading">
        {count} {count === 1 ? "argument" : "arguments"}, exactly as they will be stored
      </h3>
      <p className="muted">{APPROVE_NO_SHELL}</p>
      <ArgvList argv={request.argv} max={ARGV_ELEMENT_DISPLAY_MAX_CHARS} />
      {source.kind === "suggestion" && (
        <section aria-label="What Core noted about this suggestion">
          <h3 className="apply-confirm__heading">
            Suggested from <RevealedText value={source.manifest} max={NAME_DISPLAY_MAX_CHARS} /> in{" "}
            <RevealedText value={source.repoPath} max={NAME_DISPLAY_MAX_CHARS} />
          </h3>
          <ul className="apply-confirm__list">
            {source.notes.map((note, index) => (
              <li key={index}>
                <RevealedText value={note} max={NOTE_DISPLAY_MAX_CHARS} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </AlertConfirmDialog>
  );
}

export function RunConfirmDialog({
  snapshot,
  onCancel,
  onConfirm,
  confirmDisabled = false,
}: {
  snapshot: RunSnapshot;
  onCancel: () => void;
  onConfirm: () => void;
  confirmDisabled?: boolean;
}) {
  const mode = sandboxModeView(snapshot.expectedWorkspaceMode);
  const warnings = runModeWarnings(snapshot.expectedWorkspaceMode);
  return (
    <AlertConfirmDialog
      title="Run this verification command in the task's sandbox?"
      statement={
        <p>
          <strong>{RUN_STATEMENT}</strong>
        </p>
      }
      confirmLabel="Run"
      confirmDisabled={confirmDisabled}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <dl className="kvs kvs--tight">
        <div className="kv">
          <dt>command</dt>
          <dd>
            <RevealedText value={snapshot.command.label} max={LABEL_DISPLAY_MAX_CHARS} />
          </dd>
        </div>
        <div className="kv">
          <dt>sandbox</dt>
          <dd>
            <RevealedText value={snapshot.expectedSandboxName} max={NAME_DISPLAY_MAX_CHARS} />
          </dd>
        </div>
        <div className="kv">
          <dt>workspace mode</dt>
          <dd>
            <Badge tone={mode.liveWritable ? "danger" : "neutral"} title={mode.blurb}>
              {mode.label}
            </Badge>
          </dd>
        </div>
      </dl>
      {snapshot.earlierRunMayHaveStarted && (
        <p className="stop-tasks stop-tasks--risk" role="note">
          <strong>{EARLIER_RUN_UNKNOWN_WARNING}</strong>
        </p>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="stop-tasks stop-tasks--risk" role="note">
          <strong>{warning}</strong>
        </p>
      ))}
      <h3 className="apply-confirm__heading">
        {snapshot.command.argv.length} {snapshot.command.argv.length === 1 ? "argument" : "arguments"} (passed as
        approved, nothing interpreted)
      </h3>
      <ArgvList argv={snapshot.command.argv} max={ARGV_ELEMENT_DISPLAY_MAX_CHARS} />
      <p className="muted">{RUN_NO_CANCEL_NOTE}</p>
    </AlertConfirmDialog>
  );
}
