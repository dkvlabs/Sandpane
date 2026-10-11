/**
 * A7 project-level Verification panel (design 2026-10-09 §3.7): the approved
 * commands with Revoke, "Add command…" (label plus argv entered as a LIST,
 * one field per element — never a shell split), and the `project.context`
 * suggestions per repository with their notes shown in full.
 *
 * Gated on the `verification` feature AND its six methods; otherwise shown
 * as visibly unavailable. Approve opens ONLY from a trusted click on this
 * panel's own control (`openApproveConfirmation`), and the dialog is filled
 * from the draft the user built here — never from chat, an event or a URL.
 */

import { useState } from "react";
import {
  useApproveVerification,
  useProjectContext,
  useRevokeVerification,
  useVerificationCommands,
  useVerificationGate,
} from "../../lib/hooks";
import {
  ARGV_ELEMENT_DISPLAY_MAX_CHARS,
  LABEL_DISPLAY_MAX_CHARS,
  MAX_VERIFICATION_ARGS,
  MAX_VERIFICATION_LABEL_CHARS,
  NAME_DISPLAY_MAX_CHARS,
  NOTE_DISPLAY_MAX_CHARS,
  APPROVE_NO_SECRETS,
  approveDraftProblem,
  effectiveApproveSource,
  openApproveConfirmation,
  openRevokeConfirmation,
  revealTimestamp,
  verificationFailureCopy,
  type ApproveDraft,
  type ApproveSnapshot,
  type ApproveSource,
  type VerificationFailureCopy,
  type VerificationOp,
} from "../../lib/verification";
import type { VerificationCommand } from "../../lib/protocol";
import { Badge, Button, ConfirmDialog, EmptyState, Mono, Panel, Warning } from "../ui/primitives";
import { FeatureGateNotice } from "../ui/feature-gate";
import { ApproveConfirmDialog } from "./VerificationDialogs";
import { ArgvList, RevealedText } from "./VerificationText";

/** Copy for one failed verification exchange (Core's text revealed; advice, never a command). */
export function VerificationFailureNotice({
  copy,
  onRetrySafely,
}: {
  copy: VerificationFailureCopy;
  onRetrySafely?: () => void;
}) {
  return (
    <Warning tone={copy.tone} title={copy.title}>
      <p>
        <strong>Core said:</strong> <Mono>{copy.reason}</Mono>
      </p>
      {copy.advice !== undefined && (
        <p>
          <strong>Core's advice:</strong> {copy.advice}
        </p>
      )}
      {copy.listed !== undefined && copy.listed.length > 0 && (
        <ul className="apply-confirm__list">
          {copy.listed.map((item, index) => (
            <li key={index}>
              <Mono>{item}</Mono>
            </li>
          ))}
        </ul>
      )}
      <p>
        <strong>What you can do:</strong> {copy.action}
      </p>
      {onRetrySafely !== undefined && (
        <p>
          <Button onClick={onRetrySafely}>Retry safely</Button>{" "}
          <span className="muted">
            Resends the identical request with the same idempotency key; Core returns the earlier answer instead of
            running it twice. It never retries by itself.
          </span>
        </p>
      )}
    </Warning>
  );
}

function failure(error: unknown, op: VerificationOp) {
  return <VerificationFailureNotice copy={verificationFailureCopy(error, op)} />;
}

/** The editable draft: label plus argv as a list of elements (never split from one string). */
interface DraftState {
  label: string;
  argv: string[];
  source: ApproveSource;
}

const EMPTY_DRAFT: DraftState = { label: "", argv: [""], source: { kind: "manual" } };

/** A default label for a suggestion: its elements joined with spaces, capped (the user can edit it). */
function suggestionLabel(argv: readonly string[]): string {
  return Array.from(argv.join(" ")).slice(0, MAX_VERIFICATION_LABEL_CHARS).join("");
}

/**
 * One approved command: label, argv element by element, and Core's
 * `approvedAt` — every Core string revealed and capped (D-I1). Revoke… only
 * reports the click; the panel opens the dialog through the trusted-only
 * `openRevokeConfirmation` (D-I3).
 */
export function ApprovedCommandRow({
  command,
  revokeDisabled,
  onRevoke,
}: {
  command: VerificationCommand;
  revokeDisabled: boolean;
  onRevoke: (event: { nativeEvent?: { isTrusted?: boolean } }) => void;
}) {
  return (
    <li className="row row--stacked">
      <span className="row__title">
        <RevealedText value={command.label} max={LABEL_DISPLAY_MAX_CHARS} />
      </span>
      <ArgvList argv={command.argv} max={ARGV_ELEMENT_DISPLAY_MAX_CHARS} />
      <span className="row__meta">
        approved {revealTimestamp(command.approvedAt)}{" "}
        <Button variant="ghost" disabled={revokeDisabled} onClick={onRevoke}>
          Revoke…
        </Button>
      </span>
    </li>
  );
}

export function VerificationPanel({ projectId, archived }: { projectId: string; archived: boolean }) {
  const gate = useVerificationGate();
  const supported = gate.state === "supported";
  const list = useVerificationCommands(projectId, supported);
  const [contextRequested, setContextRequested] = useState(false);
  const context = useProjectContext(projectId, supported && contextRequested);
  const approve = useApproveVerification(projectId);
  const revoke = useRevokeVerification(projectId);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [snapshot, setSnapshot] = useState<ApproveSnapshot | null>(null);
  const [revoking, setRevoking] = useState<VerificationCommand | null>(null);

  if (!supported) {
    return (
      <Panel title="Verification">
        <FeatureGateNotice gate={gate} title="Verification commands" />
      </Panel>
    );
  }

  const draftValue: ApproveDraft | null =
    draft === null ? null : { projectId, label: draft.label, argv: draft.argv, source: draft.source };
  const problem = draftValue === null ? null : approveDraftProblem(draftValue);
  // D-I4: Core's notes describe the suggestion as listed; once an element is
  // edited they no longer apply and are not shown.
  const shownSource = draft === null ? null : effectiveApproveSource(draft.argv, draft.source);

  return (
    <Panel
      title="Verification"
      description="Commands you approve here can be run inside a task's sandbox with sbx exec. Nothing runs on your machine, and nothing runs without your click."
      actions={
        <Button variant="ghost" onClick={list.refetch}>
          Refresh
        </Button>
      }
    >
      <Warning tone="info" title="Running is gated on a verified sbx">
        Core runs a command only for an sbx version whose <Mono>sbx exec</Mono> behaviour has been captured and
        verified; no sbx version is verified yet, so every run is refused with nothing run. Approved commands are
        kept. No task created over the wire is bound to a sandbox yet either.
      </Warning>

      <h3 className="apply-confirm__heading">Approved commands</h3>
      {list.isLoading && <p className="muted">Reading the approved commands…</p>}
      {list.error !== null && failure(list.error, "list")}
      {list.commands !== null && list.commands.length === 0 && (
        <EmptyState heading="No approved commands" body="Add one below, or detect suggestions from the project's repositories." />
      )}
      {list.commands !== null && list.commands.length > 0 && (
        <ul className="list">
          {list.commands.map((command) => (
            <ApprovedCommandRow
              key={command.id}
              command={command}
              revokeDisabled={revoke.isPending}
              onRevoke={(event) => {
                const opened = openRevokeConfirmation(event, command);
                if (opened !== null) setRevoking(opened);
              }}
            />
          ))}
        </ul>
      )}
      {revoke.isError && failure(revoke.error, "revoke")}
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this verification command?"
        confirmLabel="Revoke"
        confirmDisabled={revoke.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          const target = revoking;
          setRevoking(null);
          if (target !== null) revoke.mutate({ commandId: target.id });
        }}
        consequence={
          revoking === null ? null : (
            <>
              <p>
                <RevealedText value={revoking.label} max={LABEL_DISPLAY_MAX_CHARS} /> can no longer be run. Core keeps
                the record so older events still name it. A run already in progress is not stopped.
              </p>
              <ArgvList argv={revoking.argv} max={ARGV_ELEMENT_DISPLAY_MAX_CHARS} />
            </>
          )
        }
      />

      <h3 className="apply-confirm__heading">Add a command</h3>
      {archived ? (
        <p className="muted">This project is archived; unarchive it to approve commands. Revoking still works.</p>
      ) : draft === null ? (
        <Button onClick={() => setDraft(EMPTY_DRAFT)}>Add command…</Button>
      ) : (
        <div className="stack">
          {shownSource !== null && shownSource.kind === "suggestion" && (
            <Warning tone="neutral" title="Pre-filled from a suggestion">
              Exactly as Core suggested it; edit any element before approving (an edited command is your own, and
              Core's notes below no longer apply to it). Core's notes:
              <ul className="apply-confirm__list">
                {shownSource.notes.map((note, index) => (
                  <li key={index}>
                    <RevealedText value={note} max={NOTE_DISPLAY_MAX_CHARS} />
                  </li>
                ))}
              </ul>
            </Warning>
          )}
          <label className="field">
            <span className="field__label">Label (1 to {MAX_VERIFICATION_LABEL_CHARS} characters)</span>
            <input
              className="input"
              value={draft.label}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </label>
          <p className="field__hint">
            Arguments, one per field — the program first. Nothing is split, trimmed or interpreted by a shell.{" "}
            {APPROVE_NO_SECRETS}
          </p>
          <ol className="argv-editor">
            {draft.argv.map((element, index) => (
              <li key={index} className="argv-editor__row">
                <textarea
                  className="input argv-editor__field"
                  rows={1}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={`Argument ${index + 1}`}
                  value={element}
                  onChange={(event) => {
                    const argv = [...draft.argv];
                    argv[index] = event.target.value;
                    setDraft({ ...draft, argv });
                  }}
                />
                <Button
                  variant="ghost"
                  disabled={draft.argv.length <= 1}
                  onClick={() => setDraft({ ...draft, argv: draft.argv.filter((_, i) => i !== index) })}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ol>
          <div className="row-actions">
            <Button
              variant="ghost"
              disabled={draft.argv.length >= MAX_VERIFICATION_ARGS}
              onClick={() => setDraft({ ...draft, argv: [...draft.argv, ""] })}
            >
              Add argument
            </Button>
            <Button
              variant="primary"
              disabled={problem !== null || approve.isPending}
              onClick={(event) => {
                if (draftValue === null) return;
                const opened = openApproveConfirmation(event, draftValue);
                if (opened !== null) setSnapshot(opened);
              }}
            >
              Approve…
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Discard draft
            </Button>
          </div>
          {problem !== null && <p className="muted">Core would refuse this: {problem}</p>}
        </div>
      )}
      {approve.isError && failure(approve.error, "approve")}
      {approve.isSuccess && (
        <p className="muted" role="status">
          Core approved <RevealedText value={approve.data.label} max={LABEL_DISPLAY_MAX_CHARS} /> (an identical,
          already approved argument list returns the existing command with its label unchanged).
        </p>
      )}
      {snapshot !== null && (
        <ApproveConfirmDialog
          snapshot={snapshot}
          confirmDisabled={approve.isPending}
          onCancel={() => setSnapshot(null)}
          onConfirm={() => {
            const sent = snapshot;
            setSnapshot(null);
            approve.mutate(
              { request: sent.request },
              { onSuccess: () => setDraft(null) },
            );
          }}
        />
      )}

      <h3 className="apply-confirm__heading">Suggestions from the project's repositories</h3>
      {!contextRequested ? (
        <p>
          <Button variant="ghost" onClick={() => setContextRequested(true)}>
            Detect suggestions
          </Button>{" "}
          <span className="muted">
            Core reads root manifests (package.json, Cargo.toml, go.mod, makefiles, Gradle, pyproject.toml) in each
            registered repository. It runs no tool, and nothing is approved or run automatically.
          </span>
        </p>
      ) : (
        <>
          {context.isLoading && <p className="muted">Reading the repositories' manifests…</p>}
          {context.error !== null && failure(context.error, "context")}
          {context.context !== null && context.context.repositories.length === 0 && (
            <p className="muted">This project has no registered repositories.</p>
          )}
          {context.context?.repositories.map((repo, repoIndex) => (
            <section key={repoIndex} className="stack" aria-label="Repository suggestions">
              <h4>
                <RevealedText value={repo.repoPath} max={NAME_DISPLAY_MAX_CHARS} />
              </h4>
              {repo.unreadable.length > 0 && (
                <p className="muted">
                  Nothing was taken from:{" "}
                  {repo.unreadable.map((name, i) => (
                    <span key={i}>
                      {i > 0 && ", "}
                      <RevealedText value={name} max={NAME_DISPLAY_MAX_CHARS} />
                    </span>
                  ))}
                </p>
              )}
              {repo.detected.length === 0 && <p className="muted">No manifest Core recognises at the root.</p>}
              {repo.detected.map((manifest, manifestIndex) => (
                <div key={manifestIndex} className="stack">
                  <Badge tone="neutral">
                    <RevealedText value={manifest.manifest} max={NAME_DISPLAY_MAX_CHARS} />
                  </Badge>
                  <ul className="apply-confirm__list">
                    {manifest.notes.map((note, i) => (
                      <li key={i}>
                        <RevealedText value={note} max={NOTE_DISPLAY_MAX_CHARS} />
                      </li>
                    ))}
                  </ul>
                  {manifest.suggestedCommands.map((argv, i) => (
                    <div key={i} className="row row--stacked">
                      <ArgvList argv={argv} max={ARGV_ELEMENT_DISPLAY_MAX_CHARS} />
                      <Button
                        variant="ghost"
                        disabled={archived}
                        onClick={() =>
                          setDraft({
                            label: suggestionLabel(argv),
                            argv: [...argv],
                            source: {
                              kind: "suggestion",
                              repoPath: repo.repoPath,
                              manifest: manifest.manifest,
                              notes: [...manifest.notes],
                              suggestedArgv: [...argv],
                            },
                          })
                        }
                      >
                        Approve…
                      </Button>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
          {context.context !== null && (
            <Button variant="ghost" onClick={context.refetch}>
              Detect again
            </Button>
          )}
        </>
      )}
    </Panel>
  );
}
