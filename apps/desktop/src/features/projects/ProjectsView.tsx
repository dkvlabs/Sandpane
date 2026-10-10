import { useEffect, useState } from "react";
import {
  useCoreLink,
  useCreateProject,
  useProjectDeletionFlow,
  useProjectLifecycleGates,
  useProjects,
} from "../../lib/hooks";
import { describeCoreError, displayRevealed } from "../../lib/reducers";
import { archivedLabel, isArchived } from "../../lib/project-lifecycle";
import {
  ProjectDeleteDialog,
  ProjectDeletionNotices,
  ProjectSettingsPanel,
} from "./ProjectSettings";
import { RETRY_SAFELY_EXPLANATION, RETRY_SAFELY_LABEL } from "../../lib/idempotency";
import {
  validateProjectName,
  validateRepositoryPaths,
} from "../../lib/wizard";
import { AppShell, ViewHeader } from "../../components/layout/AppShell";
import { ConnectionBanner, ConnectionChip } from "../../components/layout/ConnectionState";
import { ProjectSidebar } from "../../components/project/ProjectSidebar";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Mono,
  Panel,
  Skeleton,
  TextInput,
  Warning,
} from "../../components/ui/primitives";
import { IconRefresh } from "../../components/layout/icons";
import { href, navigate, type Route } from "../../app/router";
import { CoreRequestError } from "../../lib/core-client";
import { useProbeRefetch } from "../../components/ui/refresh";

export function ProjectsView({ route }: { route: Route }) {
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  const gates = useProjectLifecycleGates();
  const archiveListing = gates.showArchived.state === "supported";
  const [showArchived, setShowArchived] = useState(false);
  const listed = useProjects({ includeArchived: archiveListing && showArchived });
  // Settings look the selected project up in the widest list this Core can
  // give, so archiving it does not make its settings vanish mid-edit.
  const everything = useProjects({ includeArchived: archiveListing });
  const deletion = useProjectDeletionFlow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    selectedId === null ? null : (everything.projects.find((p) => p.id === selectedId) ?? null);
  // A selection Core no longer lists (deleted here or elsewhere) is dropped,
  // but only once the list read has settled without error.
  useEffect(() => {
    if (
      selectedId !== null &&
      !everything.isLoading &&
      everything.error === null &&
      !everything.projects.some((p) => p.id === selectedId)
    ) {
      setSelectedId(null);
    }
  }, [selectedId, everything.isLoading, everything.error, everything.projects]);
  const { isLoading, error } = listed;
  const create = useCreateProject();
  const [name, setName] = useState("");
  const [repos, setRepos] = useState("");
  const attached = link.kind === "attached";

  const repoList = repos
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const nameError = create.isPending ? null : validateProjectName(name);
  const repoError = create.isPending ? null : validateRepositoryPaths(repoList);
  const canSubmit =
    attached && nameError === null && repoError === null && name.length > 0;

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={
        <span className="statusbar__counts">
          {attached
            ? `${projects.length} project(s) in Core`
            : "project count unavailable while Core is offline"}
        </span>
      }
    >
      <ViewHeader
        title="Projects"
        subtitle="Grouped repositories, chats and task history. State lives in the shared Core SQLite store — the desktop keeps no competing database."
        actions={
          <Button onClick={refetch}>
            <IconRefresh /> Refresh
          </Button>
        }
      />
      <ConnectionBanner link={link} onRetry={refetch} />
      <ProjectDeletionNotices state={deletion.state} flow={deletion.flow} />
      {deletion.state.kind === "confirming" && (
        <ProjectDeleteDialog confirmation={deletion.state.confirmation} flow={deletion.flow} />
      )}
      {attached && selected !== null && (
        <ProjectSettingsPanel
          project={selected}
          gates={gates}
          deletion={deletion}
          onClose={() => setSelectedId(null)}
        />
      )}

      <div className="grid grid--two">
        <Panel
          title="Core projects"
          description={
            archiveListing && showArchived
              ? "project.list with includeArchived: true — archived projects are labelled."
              : "project.list — Core lists live projects only unless archived ones are asked for."
          }
          actions={
            <label className="row-actions" title={gates.showArchived.note}>
              <input
                type="checkbox"
                checked={archiveListing && showArchived}
                disabled={!archiveListing}
                onChange={(event) => setShowArchived(event.target.checked)}
              />{" "}
              Show archived
            </label>
          }
        >
          {!archiveListing && attached && (
            <p className="muted">{gates.showArchived.note}</p>
          )}
          {!attached ? (
            <EmptyState
              variant="offline"
              heading="Project list requires Core"
              body="Start the persistent Core and retry. Sample data from the design mockups is deliberately not rendered here."
              action={
                <Button onClick={refetch}>
                  <IconRefresh /> Retry attach
                </Button>
              }
            />
          ) : isLoading ? (
            <Skeleton rows={4} />
          ) : error !== null ? (
            <ErrorPanel error={error} />
          ) : listed.projects.length === 0 ? (
            <EmptyState
              heading="No projects yet"
              body="Create the first project on the right; repository paths can be added now or later."
            />
          ) : (
            <ul className="list">
              {listed.projects.map((project) => (
                <li key={project.id}>
                  <div className="row row--action">
                    <a
                      className="row__main"
                      href={href("project-workspace", { projectId: project.id })}
                    >
                      <span className="row__title">
                        {displayRevealed(project.name, 200).text}{" "}
                        {isArchived(project) && (
                          <Badge tone="attention">{archivedLabel(project)}</Badge>
                        )}
                      </span>
                      <span className="row__meta">
                        <Mono>{project.id.slice(0, 8)}</Mono> · created{" "}
                        {project.createdAt}
                      </span>
                    </a>
                    <Button
                      variant="ghost"
                      aria-pressed={selectedId === project.id}
                      onClick={() => setSelectedId(project.id)}
                    >
                      Settings
                    </Button>
                    <Button onClick={() => navigate("project-workspace", { projectId: project.id })}>
                      Open
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Create project"
          description="Core validates the name (one line, at most 120 characters, no control or direction-changing characters) and requires absolute repository paths."
        >
          {!attached ? (
            <Warning tone="danger" title="Disabled while Core is unreachable">
              Creating a project needs a live Core connection; otherwise the UI would show a
              success it cannot verify.
            </Warning>
          ) : (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canSubmit) return;
                create.mutate({ name, repositories: repoList });
              }}
            >
              <Field
                label="Project name"
                error={name.length === 0 ? undefined : (nameError ?? undefined)}
                hint="Any Unicode text on one line; control, separator and direction-changing characters are rejected by Core."
              >
                {(id) => (
                  <TextInput
                    id={id}
                    value={name}
                    invalid={nameError !== null && name.length > 0}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Project name"
                  />
                )}
              </Field>
              <Field
                label="Repository paths (one per line, optional)"
                error={repoError ?? undefined}
                hint="Absolute paths only. The native folder picker is a DT1 item, so paths are typed here."
              >
                {(id) => (
                  <textarea
                    id={id}
                    className="input input--multiline"
                    rows={3}
                    spellCheck={false}
                    value={repos}
                    onChange={(event) => setRepos(event.target.value)}
                    placeholder="/absolute/path/to/repo"
                  />
                )}
              </Field>
              {create.isError && <ErrorPanel error={create.error} />}
              {create.isSuccess && (
                <Warning tone="success" title="Project created in Core">
                  <Mono>{create.data.id.slice(0, 8)}</Mono> · {create.data.name}. Chats and tasks
                  for it are available in the workspace.
                </Warning>
              )}
              <div className="row-actions">
                <Button variant="primary" type="submit" disabled={!canSubmit}>
                  Create project
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setName("");
                    setRepos("");
                    create.reset();
                  }}
                >
                  Clear
                </Button>
              </div>
            </form>
          )}
        </Panel>
      </div>

      <Panel
        title="Repositories and context"
        description="Registered paths as Core returns them on each project (project.list → repositories)."
      >
        {projects.every((project) => project.repositories === undefined) ? (
          <p className="muted">
            This Core did not send <Mono>repositories</Mono> on its project rows, so this build
            cannot show what is registered. It is an additive field: a pre-revision Core omits it,
            and the desktop does not reconstruct it from local state.
          </p>
        ) : (
          <ul className="list">
            {projects.map((project) => (
              <li key={project.id} className="row">
                <span className="row__title">{project.name}</span>
                <span className="row__meta">
                  {(project.repositories ?? []).length === 0 ? (
                    <Badge tone="neutral">no repository registered</Badge>
                  ) : (
                    (project.repositories ?? []).map((path) => (
                      <Mono key={path}>{path}</Mono>
                    ))
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          These are the strings the caller registered. Core canonicalizes (resolves symlinks) at{" "}
          <Mono>sandbox.create</Mono> mount time, not at registration, so matching a folder against
          them is a path match — not proof both names are the same directory. Context profiles and
          per-repo task identity still have no Core method, so no UI claims them.
        </p>
      </Panel>
    </AppShell>
  );
}

/**
 * One honest rendering of a request failure. `onRetrySafely` is passed ONLY
 * when the failed request carried an idempotency key and its outcome is
 * unknown (`retrySafelyOffered`): the button then resends the identical
 * request with the same key, as an explicit user action. Without it, the
 * existing "re-read state first" copy stands alone.
 */
export function ErrorPanel({
  error,
  onRetrySafely,
}: {
  error: CoreRequestError;
  onRetrySafely?: () => void;
}) {
  const copy = describeCoreError(error);
  return (
    <Warning tone={copy.tone} title={copy.title}>
      <p>
        <strong>Reason:</strong> {copy.reason}
      </p>
      <p>
        <strong>What you can do:</strong> {copy.action}
      </p>
      {copy.hint !== undefined && (
        <p>
          <strong>Core suggests:</strong> <Mono>{copy.hint}</Mono>
          {copy.provider !== undefined ? ` (${copy.provider})` : ""}; run it yourself in a
          terminal — Sandpane never runs it for you.
        </p>
      )}
      {onRetrySafely !== undefined && (
        <p>
          <Button onClick={onRetrySafely}>{RETRY_SAFELY_LABEL}</Button>{" "}
          <span className="muted">{RETRY_SAFELY_EXPLANATION}</span>
        </p>
      )}
    </Warning>
  );
}
