import { useMemo, useState } from "react";
import {
  capabilitiesOf,
  useCoreLink,
  useCreateSandbox,
  useProjects,
  useSandboxes,
} from "../../lib/hooks";
import { foldAgentView, workspaceModeView } from "../../lib/reducers";
import { WORKSPACE_MODES, type WorkspaceMode } from "../../lib/protocol";
import {
  QUICK_STEPS,
  STEP_TITLES,
  buildSpec,
  canAdvance,
  emptyDraft,
  fieldErrors,
  nextStep,
  prevStep,
  reviewWarnings,
  stepErrors,
  type SandboxDraft,
  type WizardContext,
} from "../../lib/wizard";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Mono,
  Panel,
  TextInput,
  Warning,
} from "../ui/primitives";
import { ErrorPanel } from "../../features/projects/ProjectsView";

/**
 * Quick Create wizard: Project/workspace → Agent → Isolation → Review → Create
 * (docs/specs/05 §3.B, design spec S04).
 *
 * Advanced options are hidden until Core reports the capability, and the review
 * step names the effective settings plus the consequences. The create result is
 * whatever `sandbox.create` returned — never a success banner on an error frame.
 */
export function SandboxWizard() {
  const link = useCoreLink();
  const { projects } = useProjects();
  const { sandboxes } = useSandboxes();
  const create = useCreateSandbox();
  const [draft, setDraft] = useState<SandboxDraft>(() => ({
    ...emptyDraft(),
    projectId: projects[0]?.id ?? "",
  }));

  const capabilities = capabilitiesOf(link);
  const agents = capabilities?.agents ?? [];

  const context: WizardContext = useMemo(
    () => ({
      existingSandboxNames: sandboxes.map((s) => s.name),
      verifiedAgentIds: agents.filter((a) => a.verified).map((a) => a.id),
      knownAgentIds: agents.map((a) => a.id),
      // Core does not probe SBX features in this build, so advanced settings
      // stay unavailable rather than being offered blindly.
      advancedAvailable: false,
    }),
    [sandboxes, agents],
  );

  if (link.kind !== "attached") {
    return (
      <EmptyState
        variant="offline"
        heading="Sandbox creation needs Core"
        body="The wizard talks to Core, which in turn probes SBX. With no Core link the wizard would only be theatre, so it is disabled."
      />
    );
  }

  const errors = fieldErrors(draft, context);
  const visibleStepErrors = stepErrors(draft, context);
  const stepIndex = QUICK_STEPS.indexOf(draft.step);
  const atReview = draft.step === "review";
  const advanced = false;

  return (
    <Panel
      title={`Create sandbox — ${STEP_TITLES[draft.step]}`}
      description={`Step ${stepIndex + 1} of ${QUICK_STEPS.length}. Field checks mirror Core's validator; Core validates again before any argument vector is built.`}
      actions={
        <div className="wizard__dots" aria-hidden="true">
          {QUICK_STEPS.map((step, index) => (
            <span
              key={step}
              className={`dot${index <= stepIndex ? " dot--on" : ""}`}
            />
          ))}
        </div>
      }
    >
      {draft.step === "project" && (
        <div className="stack">
          <Field
            label="Sandbox name"
            error={errors.name}
            hint="Lowercase letters, digits and single hyphens; starts and ends alphanumeric; 63 characters max. Matches Validator::sandbox_name."
          >
            {(id) => (
              <TextInput
                id={id}
                value={draft.name}
                invalid={errors.name !== undefined}
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="atlas-auth"
              />
            )}
          </Field>
          <Field
            label="Project"
            error={errors.projectId}
            hint="Sandbox bindings are stored per project in the shared Core store."
          >
            {(id) => (
              <select
                id={id}
                className="input"
                value={draft.projectId}
                onChange={(event) =>
                  setDraft({ ...draft, projectId: event.target.value })
                }
              >
                <option value="">Select a project…</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {projects.length === 0 && (
            <Warning tone="attention" title="No projects in Core">
              Create a project first — a sandbox must bind to one.
            </Warning>
          )}
        </div>
      )}

      {draft.step === "agent" && (
        <div className="stack">
          <Field label="Agent" error={errors.agentId}>
            {(id) => (
              <select
                id={id}
                className="input"
                value={draft.agentId}
                onChange={(event) => setDraft({ ...draft, agentId: event.target.value })}
              >
                <option value="">Select an agent…</option>
                {agents.map((cap) => {
                  const view = foldAgentView(cap);
                  return (
                    <option key={cap.id} value={cap.id}>
                      {view.id} — {view.verified ? "verified" : "NOT verified"} ·{" "}
                      {view.streamingLabel}
                    </option>
                  );
                })}
              </select>
            )}
          </Field>
          {agents.length === 0 && (
            <Warning tone="danger" title="Core reported no agent adapters">
              Nothing is selectable. This is reported as-is rather than filling the list with
              sample agents.
            </Warning>
          )}
          <p className="muted">
            Capability labels come from <Mono>system.probe</Mono>. Unverified adapters can still be
            chosen — the sandbox is a workspace, and Core will keep a task for an unverified agent
            <Mono>queued</Mono> with an <Mono>adapter.unavailable</Mono> event.
          </p>
        </div>
      )}

      {draft.step === "isolation" && (
        <div className="stack">
          <fieldset className="radiogroup">
            <legend>Isolation mode</legend>
            {WORKSPACE_MODES.map((mode: WorkspaceMode) => {
              const view = workspaceModeView(mode);
              return (
                <label key={mode} className="radio">
                  <input
                    type="radio"
                    name="workspaceMode"
                    checked={draft.workspaceMode === mode}
                    onChange={() => setDraft({ ...draft, workspaceMode: mode })}
                  />
                  <span>
                    <strong>{view.label}</strong>
                    {mode === "sbx_clone" && <Badge tone="success">recommended</Badge>}
                    {view.liveWritable && <Badge tone="attention">live-writable</Badge>}
                    <span className="radio__blurb">{view.blurb}</span>
                    <Mono>{mode}</Mono>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {errors.workspaceMode !== undefined && (
            <p className="field__error" role="alert">
              {errors.workspaceMode}
            </p>
          )}
          <Field
            label="Repository path"
            error={errors.repoPath}
            hint="Absolute host path. Core canonicalizes it and confines the mount; nothing outside it is reachable."
          >
            {(id) => (
              <TextInput
                id={id}
                value={draft.repoPath}
                invalid={errors.repoPath !== undefined}
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, repoPath: event.target.value })}
                placeholder="/absolute/path/to/repo"
              />
            )}
          </Field>
          <Warning tone="neutral" title="Advanced options are not available">
            Mounts beyond this path, resource limits, templates, network restrictions and
            environment settings require SBX feature detection that this Core build does not
            perform. Not supported by this build — rather than a dead control.
          </Warning>
        </div>
      )}

      {atReview && (
        <div className="stack">
          <dl className="kvs">
            <div className="kv">
              <dt>sandbox name</dt>
              <dd>
                <Mono>{draft.name}</Mono>
              </dd>
            </div>
            <div className="kv">
              <dt>project</dt>
              <dd>
                <Mono>{draft.projectId}</Mono>
              </dd>
            </div>
            <div className="kv">
              <dt>agent</dt>
              <dd>
                <Mono>{draft.agentId}</Mono>{" "}
                {context.verifiedAgentIds.includes(draft.agentId) ? (
                  <Badge tone="success">verified adapter</Badge>
                ) : (
                  <Badge tone="attention">not verified</Badge>
                )}
              </dd>
            </div>
            <div className="kv">
              <dt>workspace mode</dt>
              <dd>
                {draft.workspaceMode === null
                  ? "—"
                  : workspaceModeView(draft.workspaceMode).label}
              </dd>
            </div>
            <div className="kv">
              <dt>repo path</dt>
              <dd>
                <Mono>{draft.repoPath || "(none)"}</Mono>
              </dd>
            </div>
          </dl>
          {reviewWarnings(draft, context).map((warning) => (
            <Warning key={warning} tone="attention" title="Before you create">
              {warning}
            </Warning>
          ))}
          <pre className="spec-preview">{JSON.stringify(trySpec(draft), null, 2)}</pre>
          <p className="muted">
            This is the exact <Mono>sandbox.create</Mono> payload.{" "}
            {advanced ? "" : "No other fields are sent."}
          </p>
          {create.isError && <ErrorPanel error={create.error} />}
          {create.isSuccess && (
            <Warning tone="success" title="Core accepted sandbox.create">
              The list is re-read from SBX — Core re-queries after every mutation, so exit status
              alone is never shown as the desired state.
            </Warning>
          )}
        </div>
      )}

      <div className="wizard__nav">
        <Button
          variant="ghost"
          disabled={stepIndex === 0}
          onClick={() => {
            const back = prevStep(draft.step);
            if (back !== null) setDraft({ ...draft, step: back });
          }}
        >
          Back
        </Button>
        {atReview ? (
          <Button
            variant="primary"
            disabled={Object.keys(errors).length > 0 || create.isPending}
            onClick={() => create.mutate(trySpec(draft) ?? buildSpec(draft))}
          >
            {create.isPending ? "Creating…" : "Create sandbox"}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!canAdvance(draft, context)}
            onClick={() => {
              const forward = nextStep(draft.step);
              if (forward !== null) setDraft({ ...draft, step: forward });
            }}
          >
            Continue
          </Button>
        )}
        <span className="muted">
          {Object.keys(visibleStepErrors).length === 0
            ? "This step is valid."
            : `${Object.keys(visibleStepErrors).length} field(s) need attention.`}
        </span>
      </div>
    </Panel>
  );
}

function trySpec(draft: SandboxDraft) {
  try {
    return buildSpec(draft);
  } catch {
    return null;
  }
}
