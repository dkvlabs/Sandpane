import { useState } from "react";
import { capabilitiesOf, useCoreLink, useProjects } from "../../lib/hooks";
import { AppShell, ViewHeader } from "../../components/layout/AppShell";
import {
  ConnectionBanner,
  ConnectionChip,
} from "../../components/layout/ConnectionState";
import { ProjectSidebar } from "../../components/project/ProjectSidebar";
import { Badge, Mono, Panel, Tabs, Warning } from "../../components/ui/primitives";
import type { Route } from "../../app/router";
import { useProbeRefetch } from "../../components/ui/refresh";

type Tab = "editors" | "native" | "mcp" | "policies";

/**
 * Integrations hub: IDE connections, native app connections, MCP/skills/secrets
 * and policies/ports/diagnostics (docs/specs/05 §3.D–E, design spec S08–S09).
 *
 * Every card states its real status: `configured` / `ready for manual step` /
 * `unavailable`. Nothing claims a one-click connection this build cannot perform,
 * and Sandpane never reads another app's private chat history or credentials.
 */
export function IntegrationsView({ route }: { route: Route }) {
  const link = useCoreLink();
  const refetch = useProbeRefetch();
  const { projects } = useProjects();
  const [tab, setTab] = useState<Tab>("editors");
  const capabilities = capabilitiesOf(link);

  return (
    <AppShell
      route={route}
      sidebar={<ProjectSidebar projects={projects} />}
      statusLeading={<ConnectionChip link={link} onRetry={refetch} />}
      statusTrailing={<span className="statusbar__counts">local-first · no telemetry</span>}
    >
      <ViewHeader
        title="Integrations"
        subtitle="How Sandpane connects to editors, native apps, MCP servers, policies and diagnostics."
      />
      <ConnectionBanner link={link} onRetry={refetch} />

      <Tabs
        label="Integration areas"
        active={tab}
        onChange={(id) => setTab(id as Tab)}
        tabs={[
          { id: "editors", label: "Editors" },
          { id: "native", label: "Native apps" },
          { id: "mcp", label: "MCP & secrets" },
          { id: "policies", label: "Policies, ports, diagnostics" },
        ]}
      />

      {tab === "editors" && (
        <div className="grid grid--two">
          <Card
            title="VS Code"
            status="ready for manual step"
            body={
              <>
                <p>
                  Sandpane ships a VS Code extension that attaches to the same persistent per-user
                  Core, so a chat started in the editor is the same chat here (docs/specs/03).
                </p>
                <ol className="steps">
                  <li>Start the Core service once for your user.</li>
                  <li>Install the Sandpane extension from its own marketplace listing.</li>
                  <li>Both clients negotiate the protocol version in system.probe and show identical task state.</li>
                </ol>
              </>
            }
            notes={[
              "No process is launched from the desktop: the Core socket is already owned by your user session.",
              "Acceptance scenario 3 (specs/05 §6): both clients must show consistent statuses.",
            ]}
          />
          <Card
            title="JetBrains (IDEA, and VS Code forks)"
            status="ready for manual step"
            body={
              <>
                <p>
                  The JetBrains plugin (docs/specs/04) speaks the same NDJSON contract over the same
                  socket. It compresses this IA into a Tool Window rather than duplicating it.
                </p>
                <ol className="steps">
                  <li>Install the plugin from the JetBrains Marketplace entry.</li>
                  <li>Point it at the running Core (it discovers the per-user socket automatically).</li>
                </ol>
              </>
            }
            notes={[
              "Plugin builds require a local Gradle/JDK toolchain; that path is recorded in the roadmap rather than claimed from this machine.",
            ]}
          />
          <Card
            title="Open a task in your editor"
            status="unavailable"
            body={
              <p>
                Design spec S07 offers "Open in preferred IDE" from the review panel. It needs a Tauri
                opener capability plus an editor-detection command that this shell does not expose, so
                the button is absent instead of dead.
              </p>
            }
            notes={["DT3 scope, together with the diff viewer."]}
          />
        </div>
      )}

      {tab === "native" && (
        <div className="grid grid--two">
          <Card
            title="ChatGPT Desktop / Claude Desktop"
            status="ready for manual step"
            body={
              <>
                <p>
                  Connection model (docs/specs/05 §3.E): you select a sandbox and a native app, Sandpane
                  checks the documented integration availability and then shows the exact manual
                  configuration. Detection of an installed app uses documented launch mechanisms only.
                </p>
                <ol className="steps">
                  <li>Create the sandbox first (Sandboxes → Create sandbox).</li>
                  <li>Follow the app's own MCP/configuration screen; Sandpane prints the workspace identity.</li>
                  <li>Re-probe: Sandpane reports configured / manual step / unavailable.</li>
                </ol>
              </>
            }
            notes={[
              "Sandpane does not ingest another app's private conversation history, and does not scrape its credentials or internals.",
              "Credential exposure warning is mandatory in this flow: any token handed to a sandboxed agent leaves your machine's boundary.",
            ]}
          />
          <Card
            title="SSH workspace connection"
            status="unavailable"
            body={
              <>
                <p>
                  The native-app wizard's SSH branch requires documented SSH integration checks and an
                  endpoint test. Protocol v1 exposes neither, so the wizard is not offered.
                </p>
                <p className="muted">
                  When it lands it must print the correct hostname and manual steps, and never claim a
                  one-click connect it did not verify.
                </p>
              </>
            }
            notes={[
              `Core platform reported: ${capabilities?.platform ?? "unknown (no probe yet)"}.`,
            ]}
          />
        </div>
      )}

      {tab === "mcp" && (
        <Panel title="MCP servers, skills and secrets">
          <div className="badges">
            <Badge tone="neutral">MCP add / list / authorize: not supported by this build</Badge>
            <Badge tone="neutral">skills & kits: gated on SBX version detection</Badge>
          </div>
          <p className="muted">
            docs/specs/05 §3.D defines these for DT4. The rules that will bind them are already in
            force in this repository:
          </p>
          <ul className="bullets">
            <li>
              Secrets show <strong>name and presence only</strong> — never a value — and are registered
              or removed through the official mechanism (AGENTS.md §Non-negotiable 7).
            </li>
            <li>
              Logs, events and exported diagnostics are token-redacted on a best-effort basis, and that
              effort is documented rather than promised.
            </li>
            <li>
              Sensitive scopes, URLs and permissions raise an explicit warning before anything is wired.
            </li>
          </ul>
        </Panel>
      )}

      {tab === "policies" && (
        <Panel title="Network policy, ports and diagnostics">
          <ul className="bullets">
            <li>
              Ports publish on <strong>loopback by default</strong>; exposing a port is a deliberate,
              confirmed action (docs/specs/05 §5) and only through a verified SBX command.
            </li>
            <li>
              Denied requests must be explained per sandbox, which needs a policy read method Core does
              not have yet.
            </li>
            <li>
              Redacted diagnostics export is DT4. Until it exists, this app writes no log files of its
              own beyond the webview console.
            </li>
          </ul>
          <Warning tone="neutral" title="Transport reality today">
            The only RPC surface is the allowlist in <Mono>sandpane_protocol::Method</Mono>:{" "}
            <Mono>
              {capabilities === null
                ? "system.probe, project.*, sandbox.*, conversation.*, task.*, git.*"
                : `${capabilities.protocolVersion} method names are enforced by the client itself — see src/lib/protocol.ts`}
            </Mono>
            . There is no free-form execution method, and the desktop does not add one.
          </Warning>
        </Panel>
      )}
    </AppShell>
  );
}

function Card({
  title,
  status,
  body,
  notes,
}: {
  title: string;
  status: "configured" | "ready for manual step" | "unavailable";
  body: React.ReactNode;
  notes: string[];
}) {
  const tone = status === "configured" ? "success" : status === "unavailable" ? "neutral" : "attention";
  return (
    <Panel
      title={
        <span className="row">
          <span className="row__title">{title}</span>
          <Badge tone={tone}>{status}</Badge>
        </span>
      }
    >
      {body}
      <ul className="bullets">
        {notes.map((note) => (
          <li key={note} className="muted">
            {note}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
