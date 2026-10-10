/**
 * A3a project settings (design 2026-10-09 §3.2 item 9): rename, description,
 * archive / unarchive, repositories add / remove, and delete through the A1
 * two-step confirmation dialog. Every action is gated on `system.probe`
 * `methods`; on an archived project the actions Core refuses are disabled
 * with Core's own reason (unarchive and delete stay available). After every
 * write the project list is re-read from Core — nothing is patched locally.
 */

import { useEffect, useRef, useState } from "react";
import type { ConfirmationRequest, Project } from "../../lib/protocol";
import { useProjectAction, type ProjectAction } from "../../lib/hooks";
import {
  PROJECT_DELETE_FOOTNOTE,
  archivedBlock,
  archivedLabel,
  isArchived,
  planProjectUpdate,
  type DeletionState,
  type ProjectDeletionFlow,
  type ProjectLifecycleGates,
} from "../../lib/project-lifecycle";
import {
  confirmationView,
  gateBlockLabel,
  isExpired,
  parseExpiry,
  type ConfirmationView,
} from "../../lib/sandbox-lifecycle";
import { displayRevealed, type FeatureGate } from "../../lib/reducers";
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Mono,
  Panel,
  TextInput,
  Warning,
} from "../../components/ui/primitives";
import { ErrorPanel } from "./ProjectsView";

/** The disabled reason for a control: unsupported/unprobed first, then archived. */
function blockFor(gate: FeatureGate, archived: string | null): string | null {
  return gateBlockLabel(gate) ?? archived;
}

export function ProjectSettingsPanel({
  project,
  gates,
  deletion,
  onClose,
}: {
  project: Project;
  gates: ProjectLifecycleGates;
  deletion: { flow: ProjectDeletionFlow; state: DeletionState };
  onClose: () => void;
}) {
  const shownName = displayRevealed(project.name, 200).text;
  const archived = isArchived(project);
  return (
    <Panel
      title={`Settings — ${shownName}`}
      description={
        <>
          <Mono>{project.id}</Mono>
          {archived && (
            <>
              {" "}
              <Badge tone="attention">{archivedLabel(project)}</Badge>
            </>
          )}
        </>
      }
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="stack">
        <DetailsSection project={project} gate={gates.update} />
        <ArchiveSection project={project} gates={gates} />
        <RepositoriesSection project={project} gates={gates} />
        <DeleteSection project={project} gate={gates.delete} deletion={deletion} />
      </div>
    </Panel>
  );
}

function DetailsSection({ project, gate }: { project: Project; gate: FeatureGate }) {
  const update = useProjectAction();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  // Core's stored values changed (this or another client saved): start over
  // from what Core now holds rather than keep a stale draft.
  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
  }, [project.id, project.name, project.description]);

  const blocked = blockFor(gate, archivedBlock(project, "update"));
  const plan = planProjectUpdate(project, { name, description });
  const canSave =
    blocked === null &&
    !update.isPending &&
    plan.changes !== null &&
    plan.nameError === null &&
    plan.descriptionError === null;

  return (
    <section className="stack" aria-label="Name and description">
      <h3 className="section-title">Name and description</h3>
      {blocked !== null && <p className="muted">{blocked}</p>}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave || plan.changes === null) return;
          update.mutate({ kind: "update", projectId: project.id, changes: plan.changes });
        }}
      >
        <Field
          label="Name"
          error={plan.nameError ?? undefined}
          hint="One line, at most 120 characters; Core refuses control, separator and direction-changing characters."
        >
          {(id) => (
            <TextInput
              id={id}
              value={name}
              disabled={blocked !== null}
              invalid={plan.nameError !== null}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field
          label="Description"
          error={plan.descriptionError ?? undefined}
          hint="Optional, at most 2000 characters; line breaks allowed. Empty clears it."
        >
          {(id) => (
            <textarea
              id={id}
              className="input input--multiline"
              rows={4}
              value={description}
              disabled={blocked !== null}
              aria-invalid={plan.descriptionError !== null ? true : undefined}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>
        {update.isError && <ErrorPanel error={update.error} />}
        {update.isSuccess && (
          <Warning tone="success" title="Saved in Core">
            Core stored the change; the project list is being re-read from Core.
          </Warning>
        )}
        <div className="row-actions">
          <Button variant="primary" type="submit" disabled={!canSave}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="ghost"
            type="button"
            disabled={update.isPending}
            onClick={() => {
              setName(project.name);
              setDescription(project.description);
              update.reset();
            }}
          >
            Revert
          </Button>
        </div>
      </form>
    </section>
  );
}

function ArchiveSection({ project, gates }: { project: Project; gates: ProjectLifecycleGates }) {
  const toggle = useProjectAction();
  const archived = isArchived(project);
  const gate = archived ? gates.unarchive : gates.archive;
  const blocked = gateBlockLabel(gate);
  const action: ProjectAction = archived
    ? { kind: "unarchive", projectId: project.id }
    : { kind: "archive", projectId: project.id };
  return (
    <section className="stack" aria-label="Archive">
      <h3 className="section-title">Archive</h3>
      <p className="muted">
        {archived
          ? "Archived: Core refuses new chats, messages, sandboxes, edits and repository changes for this project. Running tasks keep running; reads keep working. Unarchiving reverses it."
          : "Archiving is reversible and changes nothing outside Core. While archived, Core refuses new chats, messages, sandboxes, edits and repository changes; running tasks keep running."}
      </p>
      {toggle.isError && <ErrorPanel error={toggle.error} />}
      <div className="row-actions">
        <Button
          disabled={blocked !== null || toggle.isPending}
          title={blocked ?? undefined}
          onClick={() => toggle.mutate(action)}
        >
          {toggle.isPending ? "Working…" : archived ? "Unarchive project" : "Archive project"}
        </Button>
        {blocked !== null && <span className="muted">{blocked}</span>}
      </div>
    </section>
  );
}

function RepositoriesSection({
  project,
  gates,
}: {
  project: Project;
  gates: ProjectLifecycleGates;
}) {
  const add = useProjectAction();
  const remove = useProjectAction();
  const [path, setPath] = useState("");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const addBlocked = blockFor(gates.addRepository, archivedBlock(project, "addRepository"));
  const removeBlocked = blockFor(gates.removeRepository, archivedBlock(project, "removeRepository"));
  const pathProblem =
    path.length === 0 ? null : path.startsWith("/") ? null : "The path must be absolute (start with /).";
  const repositories = project.repositories;

  return (
    <section className="stack" aria-label="Repositories">
      <h3 className="section-title">Repositories</h3>
      {repositories === undefined ? (
        <p className="muted">
          This Core did not send <Mono>repositories</Mono> for the project, so this build cannot
          show or remove what is registered.
        </p>
      ) : repositories.length === 0 ? (
        <p className="muted">No repository is registered with this project.</p>
      ) : (
        <ul className="list">
          {repositories.map((repo) => {
            const shown = displayRevealed(repo, 500).text;
            const confirming = pendingRemove === repo;
            return (
              <li key={repo} className="row row--action">
                <span className="row__main">
                  <Mono>{shown}</Mono>
                </span>
                {confirming ? (
                  <span className="row-actions">
                    <Button
                      variant="danger"
                      disabled={remove.isPending}
                      onClick={() => {
                        setPendingRemove(null);
                        remove.mutate({ kind: "remove_repository", projectId: project.id, path: repo });
                      }}
                    >
                      Unregister from Core
                    </Button>
                    <Button variant="ghost" onClick={() => setPendingRemove(null)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button
                    disabled={removeBlocked !== null || remove.isPending}
                    title={removeBlocked ?? undefined}
                    onClick={() => setPendingRemove(repo)}
                  >
                    Remove…
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {pendingRemove !== null && (
        <p className="muted">
          Unregistering removes the repository from this project in Core only. Its files, branches
          and worktrees on disk are not touched. Core refuses while a task or a live sandbox of the
          project uses it.
        </p>
      )}
      {removeBlocked !== null && <p className="muted">Remove: {removeBlocked}</p>}
      {remove.isError && <ErrorPanel error={remove.error} />}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (addBlocked !== null || add.isPending || path.length === 0 || pathProblem !== null) return;
          add.mutate(
            { kind: "add_repository", projectId: project.id, path },
            { onSuccess: () => setPath("") },
          );
        }}
      >
        <Field
          label="Add a repository (absolute path)"
          error={pathProblem ?? undefined}
          hint="Typed path: this build has no native folder picker (the Tauri dialog plugin is not a dependency). Core validates it — it must be the top level of a Git repository outside system trees."
        >
          {(id) => (
            <TextInput
              id={id}
              value={path}
              spellCheck={false}
              disabled={addBlocked !== null}
              invalid={pathProblem !== null}
              placeholder="/absolute/path/to/repo"
              onChange={(event) => setPath(event.target.value)}
            />
          )}
        </Field>
        {addBlocked !== null && <p className="muted">Add: {addBlocked}</p>}
        {add.isError && <ErrorPanel error={add.error} />}
        <div className="row-actions">
          <Button
            type="submit"
            disabled={addBlocked !== null || add.isPending || path.length === 0 || pathProblem !== null}
          >
            {add.isPending ? "Adding…" : "Add repository"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function DeleteSection({
  project,
  gate,
  deletion,
}: {
  project: Project;
  gate: FeatureGate;
  deletion: { flow: ProjectDeletionFlow; state: DeletionState };
}) {
  const blocked = gateBlockLabel(gate);
  const { flow, state } = deletion;
  const busyHere =
    (state.kind === "requesting" || state.kind === "deleting") && state.projectId === project.id;
  return (
    <section className="stack" aria-label="Delete">
      <h3 className="section-title">Delete project</h3>
      <p className="muted">
        Deletes the project and all of its Core records after a confirmation Core issues. Core
        refuses while the project has unfinished tasks or sandboxes, and never touches host files,
        branches or sandboxes.
      </p>
      <div className="row-actions">
        <Button
          variant="danger"
          disabled={blocked !== null || flow.busy || state.kind === "confirming"}
          title={blocked ?? undefined}
          onClick={() => void flow.begin(project.id)}
        >
          {busyHere ? "Asking Core…" : "Delete project…"}
        </Button>
        {blocked !== null && <span className="muted">{blocked}</span>}
      </div>
    </section>
  );
}

/**
 * Outcome notices for the delete flow, rendered at VIEW level so they survive
 * the list re-read that drops a deleted project's row.
 */
export function ProjectDeletionNotices({
  state,
  flow,
}: {
  state: DeletionState;
  flow: ProjectDeletionFlow;
}) {
  if (state.kind === "deleted") {
    return (
      <Warning tone="success" title="Project deleted in Core">
        Core answered <Mono>deleted: true</Mono> for{" "}
        <Mono>{displayRevealed(state.target.name, 200).text}</Mono> (
        <Mono>{displayRevealed(state.target.id, 200).text}</Mono>). Host files, branches and
        sandboxes were not touched.{" "}
        <Button variant="ghost" onClick={() => flow.reset()}>
          Dismiss
        </Button>
      </Warning>
    );
  }
  if (state.kind === "gone") {
    return (
      <Warning tone="attention" title="Core no longer lists this project">
        The answer to the confirmation was lost, but a re-read of the project list (archived
        included) no longer contains <Mono>{displayRevealed(state.target.name, 200).text}</Mono> (
        <Mono>{displayRevealed(state.target.id, 200).text}</Mono>), so this window has forgotten it.
        Host files, branches and sandboxes are never touched by a project delete.{" "}
        <Button variant="ghost" onClick={() => flow.reset()}>
          Dismiss
        </Button>
      </Warning>
    );
  }
  if (state.kind === "failed") {
    return (
      <Warning tone={state.outcomeUnknown ? "danger" : "attention"} title={state.copy.title}>
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
  }
  return null;
}

/** The step-2 dialog: Core's confirmation, Cancel by default, expiry re-checked at click. */
export function ProjectDeleteDialog({
  confirmation,
  flow,
}: {
  confirmation: ConfirmationRequest;
  flow: ProjectDeletionFlow;
}) {
  const [now, setNow] = useState(() => Date.now());
  const clicked = useRef(false);

  useEffect(() => {
    clicked.current = false;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [confirmation]);

  const view = confirmationView(confirmation, now);

  return (
    <ConfirmDialog
      open
      title="Delete this project?"
      consequence={<ProjectDeleteConsequence view={view} />}
      confirmLabel="Delete project"
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
 * Everything Core said about the deletion, as React TEXT only. Untrusted
 * strings arrive revealed and capped by `confirmationView` (impact capped at 20
 * lines, the rest disclosed). A project confirmation is never `external`
 * (the decoder refuses one that is), so there is no external banner here.
 * Exported for the markup tests.
 */
export function ProjectDeleteConsequence({ view }: { view: ConfirmationView }) {
  return (
    <div className="stack">
      <dl className="kvs">
        <div className="kv">
          <dt>project</dt>
          <dd>
            <Mono>{view.targetName}</Mono>
          </dd>
        </div>
        <div className="kv">
          <dt>project id</dt>
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
        <strong>What Core says this deletion does:</strong>
      </p>
      {view.impactLines.length === 0 ? (
        <p>Core listed no impact lines.</p>
      ) : (
        <ul className="removal-impact">
          {view.impactLines.map((line, index) => (
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
      <p>{PROJECT_DELETE_FOOTNOTE}</p>
    </div>
  );
}
