import { Button, Mono } from "../ui/primitives";
import {
  foldSbxView,
  type CoreLinkState,
  type SbxViewState,
} from "../../lib/reducers";

function formatAsOf(ms: number | null): string {
  if (ms === null) return "never";
  return new Date(ms).toLocaleTimeString();
}

export function SbxBadge({ view }: { view: SbxViewState }) {
  return (
    <span className={`badge badge--${view.tone}`} title={view.label}>
      <span className="badge__dot" aria-hidden="true" />
      {view.label}
    </span>
  );
}

/**
 * The A8a evidence lines under an sbx badge, as plain text: the exec line and
 * the captured-fixtures line, each only when Core reported its field. Neither
 * is a badge, a success tone or a check mark — the captured line is a
 * statement about Sandpane's evidence, not a support claim. Renders nothing
 * when Core said neither.
 */
export function SbxDetails({ view }: { view: SbxViewState }) {
  if (view.execLine === null && view.capturedLine === null) return null;
  return (
    <ul className="muted" aria-label="SBX version evidence">
      {view.execLine !== null && <li>{view.execLine}</li>}
      {view.capturedLine !== null && <li>{view.capturedLine}</li>}
    </ul>
  );
}

/** Compact status-bar rendering of the Core link. */
export function ConnectionChip({
  link,
  onRetry,
}: {
  link: CoreLinkState;
  onRetry: () => void;
}) {
  switch (link.kind) {
    case "unloaded":
    case "attaching":
      return (
        <span className="chip chip--pending" role="status">
          <span className="badge__dot" aria-hidden="true" />
          Attaching to Core…
        </span>
      );
    case "attached":
      return (
        <span className="chip chip--live" role="status">
          <span className="badge__dot" aria-hidden="true" />
          Core connected · v{link.capabilities.coreVersion} ·{" "}
          {link.capabilities.platform}
        </span>
      );
    case "version_mismatch":
      return (
        <span className="chip chip--stale" role="status">
          <span className="badge__dot" aria-hidden="true" />
          Protocol mismatch — Core speaks v{link.coreProtocolVersion}
        </span>
      );
    case "unreachable":
      return (
        <button type="button" className="chip chip--off" onClick={onRetry}>
          <span className="badge__dot" aria-hidden="true" />
          Core offline · retry
        </button>
      );
  }
}

/**
 * The full readiness banner. This is where docs/specs/05 §5 is enforced: every
 * non-attached state names the missing prerequisite and the next real action,
 * and no view falls back to a success-looking screen.
 */
export function ConnectionBanner({
  link,
  onRetry,
}: {
  link: CoreLinkState;
  onRetry: () => void;
}) {
  if (link.kind === "attached") {
    const sbx = foldSbxView(link.capabilities);
    // A running daemon raises no banner, but it is not called "ready": sbx can
    // still refuse (signed out, policy not initialised) and operations then
    // surface their real error.
    if (sbx.kind === "daemon_running") return null;
    return (
      <div className={`banner banner--${sbx.tone}`} role="status">
        <div>
          <strong>{sbx.label}</strong>
          <p className="banner__body">
            {sbx.kind === "not_installed" && (
              <>
                Install the official Docker SBX CLI and sign in through its own flow.
                Sandpane never bundles the binary or imports credentials. Docs:{" "}
                <Mono>https://docs.docker.com/reference/cli/sbx/</Mono>
              </>
            )}
            {sbx.kind === "daemon_down" && (
              <>
                Core read the SBX daemon as stopped at the last check. Sandpane has no control
                that starts or stops it. Listing sandboxes runs <Mono>sbx ls</Mono>, which sbx
                0.47.0 was captured starting the daemon; use Re-check to read the state again.
              </>
            )}
            {sbx.kind === "installed_daemon_unknown" && (
              <>
                Core located <Mono>{link.capabilities.sbx?.binaryPath ?? "sbx"}</Mono> but did
                not report a daemon state (the probe answer was not a form Sandpane recognises,
                or this Core does not probe it), so sandbox operations report their real failure
                instead of a guessed state.
              </>
            )}
            {sbx.kind === "unprobed" && (
              <>Core did not report an SBX status, so sandbox features stay gated.</>
            )}
          </p>
          <SbxDetails view={sbx} />
        </div>
        <Button onClick={onRetry}>Re-check</Button>
      </div>
    );
  }

  if (link.kind === "attaching" || link.kind === "unloaded") {
    return (
      <div className="banner banner--info" role="status">
        <div>
          <strong>Attaching to the shared Core</strong>
          <p className="banner__body">
            The desktop attaches to the single per-user Sandpane Core; it never starts a
            competing one.
          </p>
        </div>
      </div>
    );
  }

  if (link.kind === "version_mismatch") {
    return (
      <div className="banner banner--danger" role="alert">
        <div>
          <strong>Core protocol mismatch</strong>
          <p className="banner__body">
            This Core reports protocol v{link.coreProtocolVersion}; the desktop speaks v1.
            Upgrade one of them — mixing versions would silently mis-read task state.
          </p>
        </div>
        <Button onClick={onRetry}>Re-probe</Button>
      </div>
    );
  }

  const noShell = link.code === "TRANSPORT_UNAVAILABLE";
  return (
    <div className="banner banner--danger" role="alert">
      <div>
        <strong>{noShell ? "No Core transport in this window" : "Core is not reachable"}</strong>
        <p className="banner__body">
          {link.reason}
          {noShell
            ? " Run `npm run tauri dev` so the webview gets the narrow `core_request_frame` IPC proxy. Plain `vite` in a browser cannot open the Unix socket — by design."
            : " Start sandpane-service (the persistent per-user Core) and retry. Closing this window does not cancel anything running in Core."}
        </p>
        {link.cached !== null && (
          <p className="banner__cached">
            Last known state (stale, from {formatAsOf(link.cachedAsOf)}): Core{" "}
            <Mono>v{link.cached.coreVersion}</Mono> on <Mono>{link.cached.platform}</Mono>, SBX{" "}
            <Mono>
              {link.cached.sbx === null
                ? "unknown"
                : link.cached.sbx.installed
                  ? "located"
                  : "not installed"}
            </Mono>
            . Cached values are never shown as live.
          </p>
        )}
      </div>
      <Button onClick={onRetry}>Retry attach</Button>
    </div>
  );
}
