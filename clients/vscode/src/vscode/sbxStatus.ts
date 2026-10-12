/**
 * Pure display of `system.probe` → `capabilities.sbx` (A8a, design 2026-10-09
 * §3.8 item 1). No `vscode` import; the webview receives only the finished
 * strings built here and renders them as text.
 *
 * Honesty rules this module enforces:
 *  - a running daemon is "running", never "ready"/"healthy": the captured sbx
 *    errors show a running daemon can still be unusable (not signed in, policy
 *    not initialised);
 *  - `execVerified` / `versionCaptured` are shown only when Core sent them as a
 *    real boolean — absent (or a non-boolean, since the wire is not validated
 *    at runtime) means "this Core does not say", so no line at all;
 *  - the captured line is a statement about Sandpane's evidence, never a
 *    support claim (the caller must not give it a success tone).
 *
 * Nothing here starts, stops or probes sbx.
 */

import { plainText } from '../text/visibleText';

// "(at last check)": the probe is a point in time, and the `sbx ls` that
// `sandbox.list` runs after it was captured auto-starting the daemon (v0.47.0),
// so the state can change right after it is read (review W2).
export const SBX_DAEMON_RUNNING = 'SBX daemon running (at last check)';
export const SBX_DAEMON_STOPPED = 'SBX daemon stopped (at last check)';
export const SBX_DAEMON_UNKNOWN = 'SBX daemon state unknown';

/** Shown instead of the daemon / exec / captured lines (review W3). */
export const SBX_NOT_INSTALLED = 'Docker SBX not installed';
export const SBX_NOT_REPORTED = 'SBX status not reported by this Core';

export const SBX_EXEC_ENABLED = 'Verification runs are enabled for this sbx version';
export const SBX_EXEC_NOT_ENABLED = 'Verification runs are not enabled for this sbx version';

export const SBX_CAPTURED_PREFIX =
  "Same sbx version number as Sandpane's captured fixtures (macOS; build not compared)";
export const SBX_CAPTURED_YES = `${SBX_CAPTURED_PREFIX}: yes`;
export const SBX_CAPTURED_NO = `${SBX_CAPTURED_PREFIX}: no`;

/** Display cap for the version string Core relays from sbx output. */
export const MAX_SBX_VERSION_CHARS = 64;

export interface SbxStatusView {
  /** `null` when Core sent no `sbx` object or no boolean `installed`. */
  installed: boolean | null;
  /**
   * Shown INSTEAD of the daemon / exec / captured lines when sbx is not known
   * to be installed: "Docker SBX not installed" (`installed === false`) or
   * "SBX status not reported by this Core" (no sbx object, or no boolean
   * `installed`). `null` when sbx is installed.
   */
  note: string | null;
  /** Revealed and capped; `null` when unknown, empty or sbx not installed. */
  version: string | null;
  /** One of the three daemon strings when installed; `null` otherwise. */
  daemon: string | null;
  /** `null` = no line (Core did not say, or sbx not installed). */
  exec: string | null;
  /** `null` = no line (Core did not say, or sbx not installed). */
  captured: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * `sbx` exactly as received from `system.probe` (typed `SbxStatus`, but read
 * defensively: every field is checked, unknown extra keys are ignored).
 * Daemon / exec / captured lines are produced ONLY when `installed === true`.
 */
export function sbxStatusView(sbx: unknown): SbxStatusView {
  const s = record(sbx);
  const installed = bool(s?.installed);
  if (s === null || installed !== true) {
    return {
      installed,
      note: installed === false ? SBX_NOT_INSTALLED : SBX_NOT_REPORTED,
      version: null,
      daemon: null,
      exec: null,
      captured: null,
    };
  }
  const daemonRunning = bool(s.daemonRunning);
  const execVerified = bool(s.execVerified);
  const versionCaptured = bool(s.versionCaptured);
  const rawVersion = s.version;
  const version =
    typeof rawVersion === 'string' && rawVersion.length > 0 ? plainText(rawVersion, MAX_SBX_VERSION_CHARS) : null;
  return {
    installed,
    note: null,
    version,
    daemon: daemonRunning === true ? SBX_DAEMON_RUNNING : daemonRunning === false ? SBX_DAEMON_STOPPED : SBX_DAEMON_UNKNOWN,
    exec: execVerified === null ? null : execVerified ? SBX_EXEC_ENABLED : SBX_EXEC_NOT_ENABLED,
    captured: versionCaptured === null ? null : versionCaptured ? SBX_CAPTURED_YES : SBX_CAPTURED_NO,
  };
}
