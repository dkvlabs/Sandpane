import {
  capabilitiesOf,
  useCoreLink,
  useProjects,
  useStoreStatus,
} from "../../lib/hooks";
import { foldSbxView, taskStatusView, workspaceModeView } from "../../lib/reducers";
import { PROTOCOL_VERSION, WORKSPACE_MODES, coreAdvertisesMethod } from "../../lib/protocol";
import { AppShell, ViewHeader } from "../../components/layout/AppShell";
import {
  ConnectionBanner,
  ConnectionChip,
  SbxBadge,
  SbxDetails,
} from "../../components/layout/ConnectionState";
import { ProjectSidebar } from "../../components/project/ProjectSidebar";
import {
  Badge,
  Button,
  Field,
  Mono,
  Panel,
  Warning,
} from "../../components/ui/primitives";
import { IconRefresh } from "../../components/layout/icons";
import type { Route } from "../../app/router";
import { useProbeRefetch, RefreshButton } from "../../components/ui/refresh";
import { useDeps, useUiPreferences } from "../../app/context";
import { uiPreferences } from "../../stores/ui";

/**
 * Settings.
 *
 * Split by ownership, because that is the rule that keeps this honest: what is
 * genuinely local (appearance, density, DOM bounds) is saved; anything that would
 * change Core or SBX behaviour has no control here while protocol v1 has no
 * settings RPC — the value is shown as reported, and the gap is named.
 */
export function SettingsView({ route }: { route: Route }) {
  const deps = useDeps();
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  const storeStatus = useStoreStatus();
  const { preferences, set } = useUiPreferences();
  const capabilities = capabilitiesOf(link);
  const sbxView = foldSbxView(capabilities);

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={
        <span className="statusbar__counts">
          UI preferences stored locally · Core settings not writable from this build
        </span>
      }
    >
      <ViewHeader
        title="Settings"
        subtitle="Local Core attachment, SBX detection, appearance, privacy and diagnostics."
        actions={
          <Button onClick={refetch}>
            <IconRefresh /> Re-probe Core
          </Button>
        }
      />
      <ConnectionBanner link={link} onRetry={refetch} />

      <Panel
        title="Runtime"
        description="What Core reported at the last successful handshake."
      >
        <dl className="kvs">
          <div className="kv">
            <dt>Transport</dt>
            <dd>
              <Mono>{deps.transportKind}</Mono> —{" "}
              {link.kind === "unreachable" && link.code === "TRANSPORT_UNAVAILABLE"
                ? "no Tauri IPC bridge in this window"
                : "webview → narrow Tauri command → Core socket"}
            </dd>
          </div>
          <div className="kv">
            <dt>Desktop protocol</dt>
            <dd>
              <Mono>v{PROTOCOL_VERSION}</Mono>
            </dd>
          </div>
          <div className="kv">
            <dt>Core version</dt>
            <dd>
              {capabilities === null ? (
                <Badge tone="danger">unknown — never probed</Badge>
              ) : (
                <>
                  <Mono>{capabilities.coreVersion}</Mono> · instance{" "}
                  <Mono>{capabilities.instanceId.slice(0, 8)}</Mono>
                </>
              )}
            </dd>
          </div>
          <div className="kv">
            <dt>Platform</dt>
            <dd>{capabilities?.platform ?? "unknown"}</dd>
          </div>
          <div className="kv">
            <dt>SBX</dt>
            <dd>
              <SbxBadge view={sbxView} />
              {capabilities?.sbx?.version != null && (
                <>
                  {" "}
                  · version <Mono>{capabilities.sbx.version}</Mono>
                </>
              )}
              <SbxDetails view={sbxView} />
            </dd>
          </div>
          <div className="kv">
            <dt>Event stream</dt>
            <dd>
              {storeStatus.kind === "degraded" ? (
                <Badge tone="danger">
                  degraded ({storeStatus.reason}) — attempt {storeStatus.attempt}
                </Badge>
              ) : (
                <Badge tone={storeStatus.kind === "streaming" ? "success" : "neutral"}>
                  {storeStatus.kind}
                </Badge>
              )}
            </dd>
          </div>
          <div className="kv">
            <dt>Advertised methods</dt>
            <dd>
              {capabilities === null ? (
                <Badge tone="neutral">not probed</Badge>
              ) : capabilities.methods === undefined ? (
                <Badge tone="attention">
                  this Core does not advertise its methods — nothing beyond the original surface is
                  assumed
                </Badge>
              ) : (
                <>
                  <Badge tone="success">{capabilities.methods.length} advertised</Badge>{" "}
                  <Mono>{capabilities.methods.join(", ")}</Mono>
                </>
              )}
            </dd>
          </div>
          <div className="kv">
            <dt>Additive reads this view can use</dt>
            <dd>
              <div className="badges">
                {(["task.list", "conversation.list", "conversation.history"] as const).map(
                  (method) => {
                    const on =
                      capabilities !== null &&
                      coreAdvertisesMethod(capabilities, method);
                    return (
                      <Badge key={method} tone={on ? "success" : "neutral"}>
                        {method}: {on ? "advertised" : "absent"}
                      </Badge>
                    );
                  },
                )}
              </div>
              <span className="muted">
                Support is read from <Mono>system.probe</Mono>, never inferred from a version
                number. A method this Core does not advertise is not called anywhere in the app.
              </span>
            </dd>
          </div>
        </dl>

        <Warning tone="neutral" title="Runtime limits are not writable here">
          Concurrency maxima, per-project limits and queue policy live in Core
          (<Mono>sandpane_core::scheduler</Mono>). Protocol v1 has no{" "}
          <Mono>settings.update</Mono>, so this build exposes no sliders: a control that looked
          adjustable but changed nothing would be a false capability. Limits are reported by the
          scheduler in the task events it emits (<Mono>scheduler.deferred</Mono>).
        </Warning>
      </Panel>

      <Panel
        title="Workspace modes"
        description="Static reference for what the isolation choice means (docs/specs/02 §7)."
      >
        <ul className="list">
          {WORKSPACE_MODES.map((mode) => {
            const view = workspaceModeView(mode);
            return (
              <li key={mode} className="row">
                <span className="row__title">
                  {view.label} {view.liveWritable && <Badge tone="attention">live-writable</Badge>}
                </span>
                <span className="row__meta">
                  <Mono>{mode}</Mono> — {view.blurb}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="muted">
          Default isolation for new sandboxes is chosen in the wizard per-create; a saved default
          would be a Core setting and is not available in this build.
        </p>
      </Panel>

      <Panel
        title="Appearance"
        description="Saved on this device only, in the webview's preference store."
      >
        <div className="grid grid--two">
          <Field label="Theme">
            {(id) => (
              <select
                id={id}
                className="input"
                value={preferences.theme}
                onChange={(event) =>
                  set({ theme: event.target.value as typeof preferences.theme })
                }
              >
                <option value="system">Match system</option>
                <option value="dark">Dark (Obsidian Atmosphere)</option>
                <option value="light">Light</option>
              </select>
            )}
          </Field>
          <Field label="Density">
            {(id) => (
              <select
                id={id}
                className="input"
                value={preferences.density}
                onChange={(event) =>
                  set({ density: event.target.value as typeof preferences.density })
                }
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            )}
          </Field>
          <Field label="Timeline entries rendered">
            {(id) => (
              <input
                id={id}
                className="input"
                type="number"
                min={25}
                max={1000}
                step={25}
                // Committed on blur, then clamped by the store (25–1000), so a
                // half-typed number is never clamped mid-edit.
                key={`events-${preferences.maxVisibleEvents}`}
                defaultValue={preferences.maxVisibleEvents}
                onBlur={(event) => {
                  set({ maxVisibleEvents: Number(event.currentTarget.value) || 200 });
                  // Show the value actually applied (clamping may leave the key unchanged).
                  event.currentTarget.value = String(uiPreferences.get().maxVisibleEvents);
                }}
              />
            )}
          </Field>
          <Field
            label="Streaming coalescing window (ms)"
            hint="Batches event-driven re-renders; 16–500 ms. Never re-renders per token."
          >
            {(id) => (
              <input
                id={id}
                className="input"
                type="number"
                min={16}
                max={500}
                step={4}
                // Live: the event store re-reads this window on commit (blur).
                key={`batch-${preferences.eventBatchMs}`}
                defaultValue={preferences.eventBatchMs}
                onBlur={(event) => {
                  set({ eventBatchMs: Number(event.currentTarget.value) || 80 });
                  event.currentTarget.value = String(uiPreferences.get().eventBatchMs);
                }}
              />
            )}
          </Field>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={preferences.reducedMotionOverride}
            onChange={(event) => set({ reducedMotionOverride: event.target.checked })}
          />
          <span>
            Force reduced motion (beyond the OS <Mono>prefers-reduced-motion</Mono> setting)
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={preferences.sidebarCollapsed}
            onChange={(event) => set({ sidebarCollapsed: event.target.checked })}
          />
          <span>Icon-only navigation rail (tooltips on hover); untick to show labels</span>
        </label>
        <p className="muted">
          Destructive actions (delete sandbox, discard changes, apply to your repository, expose a
          port) always ask for confirmation and state their consequence. That is a safety boundary,
          not a preference, so there is no setting to turn it off.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={preferences.nativeNotifications}
            onChange={(event) => set({ nativeNotifications: event.target.checked })}
          />
          <span>
            Native notifications on completion/review — stored as a preference only; the Tauri
            notification command is a DT5 item, so no notification can be promised yet
          </span>
        </label>
        <div className="row-actions">
          <Button variant="ghost" onClick={() => set({ ...APPEARANCE_DEFAULTS })}>
            Reset appearance
          </Button>
        </div>
      </Panel>

      <Panel title="Privacy and security">
        <ul className="bullets">
          <li>
            <strong>No telemetry.</strong> This app makes no network requests except the local Core
            RPC proxy; the CSP in <Mono>index.html</Mono> and <Mono>tauri.conf.json</Mono> allows{" "}
            <Mono>'self'</Mono> plus <Mono>ipc:</Mono> only, and there is no analytics dependency in{" "}
            <Mono>package.json</Mono>.
          </li>
          <li>
            <strong>No cloud account.</strong> Core is a per-user local process reached over a
            user-scoped Unix socket (0600) — never TCP.
          </li>
          <li>
            <strong>No credential import.</strong> Provider auth stays in the provider's own flow;
            secret values are never read, logged or exported, only presence.
          </li>
          <li>
            <strong>Local storage.</strong> UI preferences live in the webview store under{" "}
            <Mono>sandpane.desktop.ui</Mono> (theme, density, bounds, flags). Chat and task state is
            never duplicated there.
          </li>
        </ul>
        <RefreshButton label="Re-check Core" />
      </Panel>

      <Panel title="Diagnostics">
        <p className="muted">
          Export of redacted diagnostics is DT4. The inputs it would need are already visible here:
          transport kind, protocol version, Core version and instance id, SBX status, and the stream
          state above.
        </p>
        <p className="muted">
          Task states this window can currently render:{" "}
          {["created", "queued", "preparing", "running", "verifying", "awaiting_input",
            "awaiting_review", "completed", "rejected", "failed", "cancelled", "interrupted"]
            .map((status) => taskStatusView(status).label)
            .join(" · ")}
        </p>
      </Panel>
    </AppShell>
  );
}

const APPEARANCE_DEFAULTS = {
  theme: "system",
  density: "comfortable",
  reducedMotionOverride: false,
  sidebarCollapsed: true,
  inspectorOpen: false,
  maxVisibleEvents: 200,
  eventBatchMs: 80,
} as const;
