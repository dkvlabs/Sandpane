import { useState } from "react";
import {
  capabilitiesOf,
  useCoreLink,
  useLifecycleGates,
  useSandboxes,
} from "../../lib/hooks";
import {
  displayRevealed,
  foldSbxView,
  sandboxModeView,
  type FeatureGate,
} from "../../lib/reducers";
import { gateBlockLabel } from "../../lib/sandbox-lifecycle";
import {
  SandboxLifecycleControls,
  SandboxLifecycleNotices,
  useSandboxLifecycle,
} from "../../components/sandbox/SandboxLifecycle";
import { AppShell, ViewHeader } from "../../components/layout/AppShell";
import {
  ConnectionBanner,
  ConnectionChip,
  SbxBadge,
  SbxDetails,
} from "../../components/layout/ConnectionState";
import { ProjectSidebar } from "../../components/project/ProjectSidebar";
import { SandboxWizard } from "../../components/sandbox/SandboxWizard";
import {
  Badge,
  Button,
  EmptyState,
  Mono,
  Panel,
  Tabs,
  Warning,
} from "../../components/ui/primitives";
import { ErrorPanel } from "../projects/ProjectsView";
import { IconPlus, IconRefresh } from "../../components/layout/icons";
import { navigate, type Route } from "../../app/router";
import { useProbeRefetch } from "../../components/ui/refresh";
import { useProjects } from "../../lib/hooks";

export function SandboxesView({ route }: { route: Route }) {
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  const wizard = route.name === "sandbox-new";
  const [filter, setFilter] = useState("all");

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={<span className="statusbar__counts">Docker SBX owns sandbox state</span>}
    >
      <ViewHeader
        title="Sandboxes"
        subtitle="SBX is the source of truth for sandbox state. Sandpane probes it and shows the last probed result — it never maintains a competing inventory."
        actions={
          <>
            <Button onClick={refetch}>
              <IconRefresh /> Re-probe
            </Button>
            <Button
              variant="primary"
              onClick={() => navigate("sandbox-new")}
              disabled={link.kind !== "attached"}
            >
              <IconPlus /> Create sandbox
            </Button>
          </>
        }
      />
      <ConnectionBanner link={link} onRetry={refetch} />

      {wizard ? (
        <SandboxWizard />
      ) : (
        <>
          <SandboxList filter={filter} onFilter={setFilter} />
          <CapabilityPanel />
        </>
      )}
    </AppShell>
  );
}

function SandboxList({
  filter,
  onFilter,
}: {
  filter: string;
  onFilter: (id: string) => void;
}) {
  const link = useCoreLink();
  const { sandboxes, isLoading, error } = useSandboxes();
  const attached = link.kind === "attached";
  // View-level, so stop/remove outcomes survive the list re-read that drops a row.
  const lifecycle = useSandboxLifecycle();

  const shown = sandboxes.filter((sandbox) => {
    if (filter === "all") return true;
    if (filter === "running") return (sandbox.probedState ?? "").includes("running");
    if (filter === "stopped") return (sandbox.probedState ?? "").includes("stopped");
    return sandbox.probedState === null;
  });

  return (
    <Panel
      title="Sandbox library"
      description="sandbox.list probes SBX directly; the probed state is the last observed value, never an assumption."
      actions={
        <Tabs
          label="Filter sandboxes"
          active={filter}
          onChange={onFilter}
          tabs={[
            { id: "all", label: "All" },
            { id: "running", label: "Running" },
            { id: "stopped", label: "Stopped" },
            { id: "unknown", label: "Unknown" },
          ]}
        />
      }
    >
      <SandboxLifecycleNotices lifecycle={lifecycle} />
      {!attached ? (
        <EmptyState
          variant="offline"
          heading="No sandbox list"
          body="Sandbox state comes from SBX through Core. While the link is down this stays empty; last-known values are only ever shown labelled stale in the readiness banner."
        />
      ) : isLoading ? (
        <p className="muted">Probing SBX…</p>
      ) : error !== null ? (
        <>
          <ErrorPanel error={error} />
          {error.code === "NOT_INSTALLED" && (
            <InstallGuidance />
          )}
        </>
      ) : shown.length === 0 ? (
        <EmptyState
          heading="No sandboxes match this filter"
          body={
            sandboxes.length === 0
              ? "SBX reported an empty list. Create one from the wizard."
              : `${sandboxes.length} sandbox(es) exist; none match "${filter}".`
          }
          action={
            <Button variant="primary" onClick={() => navigate("sandbox-new")}>
              Create sandbox
            </Button>
          }
        />
      ) : (
        <ul className="list">
          {shown.map((sandbox) => (
            <li key={sandbox.name} className="row row--stacked">
              <div className="row__head">
                <span className="row__title">
                  <Mono>{sandbox.name}</Mono>
                </span>
                <span className="row__meta">
                  {sandbox.probedState === null ? (
                    <Badge tone="neutral">state unknown (not probed)</Badge>
                  ) : (
                    <Badge tone="info">{sandbox.probedState}</Badge>
                  )}
                  {sandbox.boundProjectId === null ? (
                    " unbound"
                  ) : (
                    <>
                      {" "}
                      · project <Mono>{sandbox.boundProjectId.slice(0, 8)}</Mono>
                    </>
                  )}{" "}
                  {/* Core's recorded binding mode, or the UNVERIFIED reading — a
                      sandbox with a probed state but no mode is never shown safe. */}
                  <Badge
                    tone={
                      sandboxModeView(sandbox.workspaceMode, sandbox.unrecognizedWorkspaceMode).verified
                        ? sandboxModeView(sandbox.workspaceMode, sandbox.unrecognizedWorkspaceMode).liveWritable
                          ? "danger"
                          : "neutral"
                        : "attention"
                    }
                    title={sandboxModeView(sandbox.workspaceMode, sandbox.unrecognizedWorkspaceMode).blurb}
                  >
                    {sandboxModeView(sandbox.workspaceMode, sandbox.unrecognizedWorkspaceMode).label}
                  </Badge>
                  {sandbox.agent !== undefined && (
                    // What sbx reported for this sandbox — a probed fact, not a
                    // verification claim.
                    <Badge tone="neutral" title="Agent as reported by sbx ls; not a Sandpane verification">
                      sbx agent {displayRevealed(sandbox.agent, 40).text}
                    </Badge>
                  )}
                </span>
              </div>
              <SandboxLifecycleControls sandbox={sandbox} lifecycle={lifecycle} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function CapabilityPanel() {
  const link = useCoreLink();
  const sbx = foldSbxView(capabilitiesOf(link));
  const gates = useLifecycleGates();
  return (
    <Panel
      title="Lifecycle and detail features"
      description="What this build can honestly do with a sandbox."
    >
      <div className="badges">
        <SbxBadge view={sbx} />
      </div>
      <SbxDetails view={sbx} />
      <table className="table">
        <thead>
          <tr>
            <th>Capability</th>
            <th>Status</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>List sandboxes</td>
            <td>
              {/* A stopped daemon at the last check is not shown green (review Info). */}
              <Badge
                tone={
                  sbx.kind === "not_installed"
                    ? "danger"
                    : sbx.kind === "daemon_down"
                      ? "info"
                      : "success"
                }
              >
                {sbx.kind === "not_installed" ? "unavailable" : "available"}
              </Badge>
            </td>
            <td>sandbox.list exists; it fails with NOT_INSTALLED or DAEMON_DOWN when SBX cannot answer.</td>
          </tr>
          <tr>
            <td>Create sandbox</td>
            <td>
              <Badge tone="success">available</Badge>
            </td>
            <td>sandbox.create with a validated spec; Core re-queries SBX after the mutation.</td>
          </tr>
          <tr>
            <td>Start</td>
            <td>
              <Badge tone="neutral">not supported by sbx v0.47</Badge>
            </td>
            <td>
              sbx v0.47 has no <Mono>start</Mono> command; a stopped sandbox is restarted with the
              interactive <Mono>sbx run --name &lt;name&gt;</Mono> in a terminal. Sandpane does not run
              it for you.
            </td>
          </tr>
          <tr>
            <td>Stop</td>
            <td>
              <LifecycleGateBadge gate={gates.stop} />
            </td>
            <td>
              <Mono>sandbox.stop</Mono> runs <Mono>sbx stop</Mono>, then Core re-queries SBX. The state
              shown afterwards is the re-queried one; if Core could not re-query, it is shown as
              unknown.
            </td>
          </tr>
          <tr>
            <td>Remove</td>
            <td>
              <LifecycleGateBadge gate={gates.remove} />
            </td>
            <td>
              <Mono>sandbox.remove</Mono> is a two-step confirmation held by Core: Core first describes
              the impact and issues a short-lived, single-use token; only your explicit confirmation
              sends it back.
            </td>
          </tr>
          <tr>
            <td>Network, ports, templates, MCP, secrets</td>
            <td>
              <Badge tone="neutral">not supported by this build</Badge>
            </td>
            <td>
              DT4. Ports default to loopback when a verified publish command exists; until then the
              UI says unsupported instead of rendering a dead toggle.
            </td>
          </tr>
          <tr>
            <td>Detail: resources / diagnostics</td>
            <td>
              <Badge tone="neutral">not supported by this build</Badge>
            </td>
            <td>Requires SBX feature detection through Core (probed version is null today).</td>
          </tr>
        </tbody>
      </table>
      <Warning tone="neutral" title="Destructive actions">
        Remove always shows Core's own impact list, the sandbox's sbx id and the confirmation's
        expiry, and says prominently when Core has no record of Sandpane creating the sandbox.
        Cancelling sends nothing; neither Stop nor Remove is ever retried automatically.
      </Warning>
    </Panel>
  );
}

function LifecycleGateBadge({ gate }: { gate: FeatureGate }) {
  const blocked = gateBlockLabel(gate);
  return (
    <Badge tone={blocked === null ? "success" : "neutral"} title={gate.note}>
      {blocked === null ? "available" : blocked}
    </Badge>
  );
}

function InstallGuidance() {
  return (
    <Panel title="Install Docker SBX">
      <ol className="steps">
        <li>
          Install the official Docker SBX CLI from Docker's own documentation. Sandpane does not
          bundle the binary.
        </li>
        <li>
          Sign in through the CLI's own flow. Sandpane never imports or mirrors credentials, and
          logs presence metadata only.
        </li>
        <li>
          Start the Docker daemon, then use <Mono>Re-probe</Mono>. Core locates the executable on
          PATH (or <Mono>SANDPANE_SBX_BIN</Mono>) at probe time.
        </li>
      </ol>
    </Panel>
  );
}

export function SandboxDetailView({ route }: { route: Route }) {
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  const { sandboxes, error } = useSandboxes();
  const name = route.params.sandboxName ?? "";
  const sandbox = sandboxes.find((s) => s.name === name) ?? null;
  const lifecycle = useSandboxLifecycle();
  // Read from Core's binding record for this name — never a guessed default.
  const mode = sandboxModeView(sandbox?.workspaceMode, sandbox?.unrecognizedWorkspaceMode);

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={<span className="statusbar__counts">{name}</span>}
    >
      <ViewHeader title={`Sandbox ${name}`} subtitle="Probed state only." />
      <ConnectionBanner link={link} onRetry={refetch} />
      <SandboxLifecycleNotices lifecycle={lifecycle} />
      <Panel title="Overview">
        {error !== null ? (
          <ErrorPanel error={error} />
        ) : sandbox === null ? (
          <EmptyState
            heading="Not in the current probe"
            body={`Core's sandbox.list did not return "${name}". It may have been removed outside Sandpane; the UI does not keep a phantom row.`}
          />
        ) : (
          <dl className="kvs">
            <div className="kv">
              <dt>probed state</dt>
              <dd>{sandbox.probedState ?? "unknown"}</dd>
            </div>
            <div className="kv">
              <dt>bound project</dt>
              <dd>{sandbox.boundProjectId ?? "unbound"}</dd>
            </div>
            <div className="kv">
              <dt>workspace mode</dt>
              <dd>
                <Badge tone={mode.verified ? (mode.liveWritable ? "danger" : "neutral") : "attention"}>
                  {mode.label}
                </Badge>{" "}
                {mode.blurb}
              </dd>
            </div>
            <div className="kv">
              <dt>sbx agent</dt>
              <dd>
                {sandbox.agent === undefined
                  ? "not reported"
                  : `${displayRevealed(sandbox.agent, 40).text} (reported by sbx; not a Sandpane verification)`}
              </dd>
            </div>
            <div className="kv">
              <dt>live-writable</dt>
              <dd>
                {mode.liveWritable
                  ? "YES — treat files in this workspace as possibly already written to your tree."
                  : "no — Core recorded a mode that keeps edits away from your working tree."}
              </dd>
            </div>
          </dl>
        )}
      </Panel>
      {sandbox !== null && error === null && (
        <Panel title="Lifecycle">
          <SandboxLifecycleControls sandbox={sandbox} lifecycle={lifecycle} />
        </Panel>
      )}
    </AppShell>
  );
}
