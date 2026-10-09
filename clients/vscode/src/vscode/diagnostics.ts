/**
 * Error code → human guidance (specs/03 §4 "Status — Version/daemon/agent errors:
 * Missing SBX results in actionable install instructions").
 *
 * Pure mapping so the copy is unit-tested. Nothing here re-grades a Core verdict:
 * the code shown is exactly the code Core sent, and an unmapped code falls back
 * to "report this" instead of a generic success-ish shrug.
 */

import type { ErrorCode } from '../core-client/events';
import { isErrorCode } from '../core-client/events';

export type ClientFailureReason =
  | 'not_connected'
  | 'timeout'
  | 'closed'
  | 'frame_too_large'
  | 'invalid_frame'
  | 'unknown_method'
  | 'validation'
  | 'unsupported_platform'
  | 'remote_host'
  | 'adapter_unverified'
  | 'service_policy';

export type SandpaneFailure =
  | { source: 'core'; code: ErrorCode; message: string; details?: unknown }
  | { source: 'client'; reason: ClientFailureReason; message: string }
  | { source: 'unknown'; message: string };

export interface GuidanceAction {
  label: string;
  /** A command registered by this extension, when there is one to offer. */
  command?: string;
  /** External documentation, when the fix lives outside Sandpane. */
  url?: string;
}

export interface ErrorGuidance {
  headline: string;
  explanation: string;
  actions: GuidanceAction[];
  /** Shown when our advice might be wrong — always for INTERNAL/unknown. */
  honestUncertainty?: string;
}

const SBX_DOCS = 'https://docs.docker.com/ai/sandboxes/';
const COMPAT_MATRIX = 'docs/compatibility.md';

const CORE_GUIDANCE: Record<ErrorCode, ErrorGuidance> = {
  NOT_INSTALLED: {
    headline: 'Docker Sandboxes CLI (sbx) is not installed',
    explanation:
      'Sandpane Core could not locate an `sbx` executable, so it cannot list, create or start ' +
      'sandboxes. Sandpane never bundles or downloads SBX itself, and it will not run an agent ' +
      'outside a sandbox as a fallback.',
    actions: [
      { label: `Install Docker Sandboxes (${SBX_DOCS})`, url: SBX_DOCS },
      {
        label: 'Point Core at an existing binary',
        command: 'sandpane.openCoreLogs',
      },
      { label: 'Refresh sandboxes once installed', command: 'sandpane.refreshSandboxes' },
    ],
    honestUncertainty:
      'Set SANDPANE_SBX_PATH on the **Core service process** (not this window) to a verified ' +
      'binary and restart Core; the extension will not launch or pin a binary on its own.',
  },
  DAEMON_DOWN: {
    headline: 'The sandbox daemon is not reachable',
    explanation:
      'SBX is installed but its daemon did not answer, so sandbox state cannot be probed. Core ' +
      'reports the daemon instead of assuming a state (specs/02 §5).',
    actions: [
      { label: 'Start Docker / the SBX daemon', url: SBX_DOCS },
      { label: 'Refresh sandboxes', command: 'sandpane.refreshSandboxes' },
    ],
  },
  UNSUPPORTED_SBX_VERSION: {
    headline: 'Installed SBX version is not on the tested matrix',
    explanation:
      `Core validates the installed CLI against its tested version/capability matrix before use. ` +
      `This build has no verified SBX release (see ${COMPAT_MATRIX}: "sbx — not installed / P0 BLOCKER").`,
    actions: [{ label: 'Open the compatibility matrix' }],
    honestUncertainty:
      'Advanced SBX flags are withheld rather than guessed. Upgrading Core to a build with a ' +
      'tested fixture for your SBX version is the supported path.',
  },
  PROVIDER_AUTH_REQUIRED: {
    headline: 'The agent provider needs authentication',
    explanation:
      'The coding-agent provider inside the sandbox is not signed in. Sandpane does not scrape ' +
      'credentials from Docker, Codex or Claude installations and cannot complete this login for ' +
      'you (specs/06 §5).',
    actions: [{ label: 'Sign in inside the sandbox (provider flow)', url: SBX_DOCS }],
  },
  CONFLICT: {
    headline: 'Core rejected the operation for the task’s current state',
    explanation:
      'Lifecycle transitions are enforced in Core (specs/02 §4). A cancel or apply that conflicts ' +
      'with the recorded state is refused rather than forced.',
    actions: [{ label: 'Re-read task state', command: 'sandpane.refreshSandboxes' }],
  },
  TASK_INTERRUPTED: {
    headline: 'The task was interrupted by a Core restart',
    explanation:
      'After a restart Core reconciles its records with real processes and marks unverified tasks ' +
      '`interrupted`. It deliberately never resumes or re-runs them (specs/02 §1).',
    actions: [{ label: 'Start a fresh task', command: 'sandpane.startTask' }],
  },
  PERMISSION_DENIED: {
    headline: 'Operation not permitted',
    explanation:
      'Core authorizes mutating operations server-side. The socket is per-user (0600); a client ' +
      'cannot widen what the service allows.',
    actions: [{ label: 'Open client logs', command: 'sandpane.openCoreLogs' }],
  },
  VALIDATION_FAILED: {
    headline: 'Input was rejected by validation',
    explanation:
      'A name, path, ref or payload did not pass Core’s strict validators (specs/06 §4). This is ' +
      'the expected answer for anything that looks like an injected command — content is data, ' +
      'never an argument vector.',
    actions: [{ label: 'Open client logs', command: 'sandpane.openCoreLogs' }],
  },
  NOT_FOUND: {
    headline: 'Core has no record of that id',
    explanation:
      'The project, conversation, task or repository id is unknown to this Core instance. Ids are ' +
      'Core-owned; the extension keeps no authoritative database, so a stale id is usually a ' +
      'different Core instance (check the probe instanceId after a restart).',
    actions: [{ label: 'Refresh from Core', command: 'sandpane.refreshSandboxes' }],
  },
  INTERNAL: {
    headline: 'Core reported an internal failure',
    explanation:
      'A transport-level or unexpected server-side failure. The message Core sent is preserved ' +
      'below verbatim; nothing was retried automatically.',
    actions: [{ label: 'Open client logs', command: 'sandpane.openCoreLogs' }],
    honestUncertainty: 'Repeated INTERNAL usually means a Core version mismatch — probe and compare versions.',
  },
};

const CLIENT_GUIDANCE: Record<ClientFailureReason, ErrorGuidance> = {
  not_connected: {
    headline: 'Sandpane Core is not attached',
    explanation:
      'No live Core was found on the per-user socket. The extension will not start a service ' +
      'binary by itself: the ownership and auto-start policy (ADR 1, specs/02 §10) is undecided.',
    actions: [
      { label: 'What I can do about it', command: 'sandpane.startService' },
      { label: 'Retry the connection', command: 'sandpane.refreshSandboxes' },
    ],
  },
  timeout: {
    headline: 'Core did not answer in time',
    explanation:
      'The request timed out and its id was dropped. No blind retry is performed, because a ' +
      'non-idempotent call could otherwise run twice.',
    actions: [{ label: 'Open client logs', command: 'sandpane.openCoreLogs' }],
  },
  closed: {
    headline: 'Connection to Core closed',
    explanation:
      'The socket dropped. Reconnect is scheduled with backoff; in-flight requests were failed ' +
      'locally, and any running task keeps running in Core.',
    actions: [{ label: 'Open client logs', command: 'sandpane.openCoreLogs' }],
  },
  frame_too_large: {
    headline: 'Frame exceeds the IPC size ceiling',
    explanation:
      'NDJSON frames are bounded by MAX_FRAME_BYTES (4 MiB). Oversized input is refused on both ' +
      'sides instead of being buffered (specs/02 §2).',
    actions: [{ label: 'Open client logs', command: 'sandpane.openCoreLogs' }],
  },
  invalid_frame: {
    headline: 'Core sent a frame this client cannot parse',
    explanation:
      'The frame failed envelope validation. Treating it as success would be a fabricated result, ' +
      'so it is discarded and reported.',
    actions: [{ label: 'Open client logs', command: 'sandpane.openCoreLogs' }],
  },
  unknown_method: {
    headline: 'Requested action has no Core method',
    explanation:
      'The RPC surface is an allowlist of 11 typed methods and there is no free-form execution ' +
      'method. What you asked for cannot be expressed as an arbitrary command (specs/02 §2).',
    actions: [],
  },
  validation: {
    headline: 'Input failed client-side validation',
    explanation:
      'Checked before sending against the same rules Core applies (sandbox name shape, absolute ' +
      'path, Git ref, text bounds). Core validates again; its verdict is authoritative.',
    actions: [],
  },
  unsupported_platform: {
    headline: 'This platform has no supported Core transport yet',
    explanation:
      'Core binds a Unix domain socket in this build; the Windows named-pipe transport is a P1 ' +
      'deliverable. TCP is never used as a fallback.',
    actions: [{ label: 'Open client logs', command: 'sandpane.openCoreLogs' }],
  },
  remote_host: {
    headline: 'Remote extension hosts are not supported in v0.1',
    explanation:
      'This window edits files on a remote host while Core would act with local filesystem ' +
      'authority. Running SBX or Git against that mismatch is exactly the wrong-filesystem bug ' +
      'specs/03 §2 forbids, so all actions are disabled here.',
    actions: [],
  },
  adapter_unverified: {
    headline: 'No verified agent adapter in this Core build',
    explanation:
      'Core advertises adapters only after their in-SBX feasibility gate passes (P0). Right now ' +
      '`codex` reports verified=false, supportsStreaming=false. Sending a prompt would only queue ' +
      'a task that cannot run; there is no terminal-scraping fallback (specs/02 §6, specs/03 §6.7).',
    actions: [{ label: 'Probe Core capabilities', command: 'sandpane.startService' }],
    honestUncertainty: 'Chat is a VS2 deliverable gated on the P0 Codex-in-SBX gate — not a UI gap.',
  },
  service_policy: {
    headline: 'The extension does not manage the Core service lifecycle',
    explanation:
      'Starting, upgrading or stopping the Sandpane-owned service requires the agreed ownership ' +
      'policy (ADR 1). Until that lands the extension tells you the command instead of executing ' +
      'an unverified binary.',
    actions: [],
  },
};

export function explainCoreErrorCode(code: ErrorCode): ErrorGuidance {
  return CORE_GUIDANCE[code];
}

export function explainClientFailure(reason: ClientFailureReason): ErrorGuidance {
  return CLIENT_GUIDANCE[reason];
}

/** Classify anything thrown by the client stack into a failure envelope. */
export function toFailure(error: unknown): SandpaneFailure {
  if (error && typeof error === 'object') {
    const e = error as { name?: string; code?: unknown; reason?: unknown; message?: unknown };
    const message = typeof e.message === 'string' ? e.message : String(error);
    if (isErrorCode(e.code)) {
      return {
        source: 'core',
        code: e.code,
        message,
        ...('details' in e ? { details: (e as { details?: unknown }).details } : {}),
      };
    }
    if (typeof e.reason === 'string') {
      const reason = e.reason as ClientFailureReason;
      if (Object.prototype.hasOwnProperty.call(CLIENT_GUIDANCE, reason)) {
        return { source: 'client', reason, message };
      }
    }
    if (e.name === 'FrameTooLargeError') return { source: 'client', reason: 'frame_too_large', message };
    if (e.name === 'UnknownMethodError') return { source: 'client', reason: 'unknown_method', message };
    if (e.name === 'CoreValidationError') return { source: 'client', reason: 'validation', message };
    return { source: 'unknown', message };
  }
  return { source: 'unknown', message: typeof error === 'string' ? error : String(error) };
}

export function explainFailure(error: unknown): ErrorGuidance {
  const failure = toFailure(error);
  switch (failure.source) {
    case 'core':
      return CORE_GUIDANCE[failure.code];
    case 'client':
      return CLIENT_GUIDANCE[failure.reason];
    case 'unknown':
      return {
        headline: 'Unexpected client error',
        explanation: failure.message,
        actions: [{ label: 'Open client logs', command: 'sandpane.openCoreLogs' }],
        honestUncertainty: 'No mapping exists for this failure; it was not interpreted or hidden.',
      };
    default: {
      const _exhaustive: never = failure;
      return _exhaustive;
    }
  }
}

/** Human text for a message box — includes Core's verbatim message. */
export function formatGuidance(guidance: ErrorGuidance, coreMessage?: string): string {
  const parts = [guidance.headline, guidance.explanation];
  if (coreMessage) parts.push(`Core said: ${coreMessage}`);
  if (guidance.actions.length > 0) {
    parts.push(`Next: ${guidance.actions.map((a) => a.label).join(' · ')}`);
  }
  if (guidance.honestUncertainty) parts.push(guidance.honestUncertainty);
  return parts.join('\n\n');
}
