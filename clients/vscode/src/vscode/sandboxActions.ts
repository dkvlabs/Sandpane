/**
 * Pure view builders for the A1 sandbox lifecycle actions (design 2026-10-09
 * §3/§4): stop, two-step remove, the visibly unsupported start, and the
 * create-time agent choice. No `vscode` import — `session.ts` feeds the result
 * into native modals / quick picks, and these functions are unit-tested alone.
 *
 * Every Core-supplied string (sandbox name, sbx id, impact lines, expiry, sbx
 * state, agent) goes through `plainText`: hidden/bidi/control characters become
 * visible escapes, notification link syntax is broken, and length is capped.
 */

import type {
  ConfirmationRequest,
  SandboxStopResult,
  SandboxSummary,
  SbxAgent,
} from '../core-client/protocol';
import { DEFAULT_SBX_AGENT, SBX_AGENTS } from '../core-client/protocol';
import { inspectHidden, plainText } from '../text/visibleText';
import { selectedWorkspaceMode } from '../state/sessionPolicy';

/** At most this many `impact` lines are listed; the rest are counted. */
export const MAX_IMPACT_LINES = 20;
/** Each impact line is cut to this many code points. */
export const MAX_IMPACT_LINE_CHARS = 200;
/** Name / id / expiry cap (a valid sandbox name is ≤ 63 anyway). */
export const MAX_IDENTITY_CHARS = 128;

export const REMOVE_BUTTON = 'Remove sandbox';
export const STOP_BUTTON = 'Stop sandbox';
/**
 * Shared cross-client wording for `external: true`. Core sets it whenever no
 * Sandpane binding is recorded for this sbx id — which also covers a pre-A1
 * binding with no id, or a binding for an EARLIER sandbox of the same name —
 * so the copy never claims who created the sandbox.
 */
export const EXTERNAL_MARKER = 'NOT CONFIRMED AS CREATED BY SANDPANE';
export const EXTERNAL_TEXT =
  'Core cannot confirm Sandpane created this sandbox (no Sandpane binding is recorded for this sbx id).';

/** The honest unsupported state for `sandbox.start` (sbx v0.47 has no start). */
export function startUnsupportedMessage(name: string | null): string {
  const shown = name && name.length > 0 ? plainText(name, MAX_IDENTITY_CHARS) : '<name>';
  return `Start: not supported by sbx v0.47 (use \`sbx run --name ${shown}\` in a terminal)`;
}

/** Visible refusal when THIS Core does not advertise a method. */
export function notAdvertisedMessage(action: string, method: string): string {
  return (
    `${action}: not supported by the attached Sandpane Core — it does not advertise "${method}" ` +
    'in system.probe. Nothing was sent. Update Core to a build with this method.'
  );
}

export interface RemoveConfirmationView {
  /** Modal title line. Starts with the external marker when `external`. */
  message: string;
  /** Modal body: identity, impact (capped), expiry, what the button does. */
  detail: string;
  button: typeof REMOVE_BUTTON;
  /** True when any Core string contained hidden characters (shown escaped). */
  altered: boolean;
}

/** "in about 87 s" / "already expired" / unknown — never fabricated. */
export function describeExpiry(expiresAt: string, nowMs: number): string {
  const shown = plainText(expiresAt, MAX_IDENTITY_CHARS);
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) {
    return `has an expiry this client cannot read (${shown}) — it cannot be used; run Remove again`;
  }
  const seconds = Math.round((at - nowMs) / 1000);
  if (seconds <= 0) {
    return `expired at ${shown} — Core will refuse it; run Remove again for a fresh confirmation`;
  }
  return `expires at ${shown} (in about ${seconds} s)`;
}

export function removeConfirmationView(
  confirmation: ConfirmationRequest,
  nowMs: number,
): RemoveConfirmationView {
  const name = inspectHidden(confirmation.target.name);
  const id = inspectHidden(confirmation.target.id);
  let altered = name.altered || id.altered;
  const shownName = plainText(confirmation.target.name, MAX_IDENTITY_CHARS);
  const shownId = plainText(confirmation.target.id, MAX_IDENTITY_CHARS);

  const listed = confirmation.impact.slice(0, MAX_IMPACT_LINES).map((line) => {
    if (inspectHidden(line).altered) altered = true;
    return `• ${plainText(line, MAX_IMPACT_LINE_CHARS)}`;
  });
  const hidden = confirmation.impact.length - listed.length;
  for (const line of confirmation.impact.slice(MAX_IMPACT_LINES)) {
    if (inspectHidden(line).altered) altered = true;
  }

  const message = confirmation.external
    ? `${EXTERNAL_MARKER} — remove sandbox "${shownName}"?`
    : `Remove sandbox "${shownName}"?`;

  const lines: string[] = [];
  if (confirmation.external) {
    lines.push(
      `${EXTERNAL_MARKER}: ${EXTERNAL_TEXT} Removing it may destroy work Sandpane knows nothing about.`,
      '',
    );
  }
  lines.push(`Sandbox: ${shownName}`, `sbx id: ${shownId}`, '');
  lines.push(listed.length > 0 ? 'Core reports this impact:' : 'Core reported no impact lines.');
  lines.push(...listed);
  if (hidden > 0) lines.push(`(+${hidden} more impact line(s) not shown)`);
  lines.push('', `This confirmation ${describeExpiry(confirmation.expiresAt, nowMs)}.`);
  if (altered) {
    lines.push(
      'WARNING: text from Core contained invisible or control characters; they are shown as \\u escapes.',
    );
  }
  lines.push(
    '',
    `Nothing is removed unless you press "${REMOVE_BUTTON}". Core then re-checks that the sandbox ` +
      'is still the same one (name and sbx id) before running sbx rm. Cancel sends nothing; the ' +
      'confirmation simply expires.',
  );
  return { message, detail: lines.join('\n'), button: REMOVE_BUTTON, altered };
}

export interface StopOutcomeView {
  /** False when Core gave no re-query: the state is UNKNOWN, never "stopped". */
  stateKnown: boolean;
  text: string;
}

export function stopOutcomeView(name: string, result: SandboxStopResult): StopOutcomeView {
  const shownName = plainText(name, MAX_IDENTITY_CHARS);
  const requeried = result.requeried;
  if (!requeried || typeof requeried !== 'object') {
    return {
      stateKnown: false,
      text:
        `sbx stop for "${shownName}" returned` +
        (result.stopped === true ? ' success' : ' no success flag') +
        ', but its state is UNKNOWN: sbx no longer lists it or the re-query failed. ' +
        'It is not assumed to be stopped — refresh to see what sbx reports.',
    };
  }
  const state =
    typeof requeried.probedState === 'string' && requeried.probedState.length > 0
      ? plainText(requeried.probedState, MAX_IDENTITY_CHARS)
      : 'not reported by sbx';
  return {
    stateKnown: typeof requeried.probedState === 'string' && requeried.probedState.length > 0,
    text: `Stop requested for "${shownName}" — sbx now reports state: ${state}`,
  };
}

/**
 * Modal copy for the (non-destructive) stop confirmation. `activeTasks` is the
 * number of non-terminal Core tasks recorded on this sandbox (`task.list`), or
 * `null` when it cannot be checked — today always, because Core does not
 * record which sandbox a task uses — and the modal then says so instead of
 * implying there are none (specs/03 §6 scenario 6).
 */
export function stopConfirmation(
  name: string,
  activeTasks: number | null,
): { message: string; detail: string } {
  const shown = plainText(name, MAX_IDENTITY_CHARS);
  const warning =
    activeTasks === null
      ? 'Active tasks in this sandbox cannot be checked: Core does not yet record which sandbox a task uses. ' +
        'Any agent task running inside it would end.'
      : activeTasks > 0
        ? `WARNING: ${activeTasks} active task(s) recorded by Core run in this sandbox; stopping it ends them.`
        : 'Core records no active task in this sandbox.';
  return {
    message:
      activeTasks !== null && activeTasks > 0
        ? `Stop sandbox "${shown}"? ${activeTasks} active task(s) use it.`
        : `Stop sandbox "${shown}"?`,
    detail:
      `${warning}\n\n` +
      'sbx stops the sandbox; processes running inside it end. ' +
      'Core re-queries sbx afterwards and the state shown is what sbx reports. ' +
      'Start is not available from Sandpane (sbx v0.47 has no start command).',
  };
}

export interface SandboxPickItem {
  label: string;
  description: string;
  detail: string;
  name: string;
}

/**
 * Quick-pick labels/descriptions/details render `$(icon-name)` as a codicon, so
 * a Core/sbx string could paint a fake check mark. Break the `$(` pair with a
 * visible space, like `plainText` does for notification links.
 */
export function pickText(value: unknown, max = MAX_IDENTITY_CHARS): string {
  return plainText(value, max).replace(/\$\(/g, '$ (');
}

/** Quick-pick row for a Core-listed sandbox; every field is plain text. */
export function sandboxPickItem(summary: SandboxSummary): SandboxPickItem {
  const mode = selectedWorkspaceMode([summary], summary.name);
  const state =
    typeof summary.probedState === 'string' && summary.probedState.length > 0
      ? pickText(summary.probedState)
      : 'state not reported';
  const agent =
    typeof summary.agent === 'string' && summary.agent.length > 0
      ? `sbx reports agent: ${pickText(summary.agent)}`
      : 'agent not reported by sbx';
  return {
    label: pickText(summary.name),
    description: `${state} · ${mode.badge}`,
    detail: `${agent}${summary.boundProjectId ? '' : ' · no Sandpane project binding'}`,
    name: summary.name,
  };
}

export interface AgentPickItem {
  label: string;
  description: string;
  /** `undefined` = omit `agent` on the wire (Core's default `shell`). */
  agent: SbxAgent | undefined;
}

export const AGENT_NOT_VERIFIED =
  'agent not verified — may need provider sign-in inside the sandbox';

/**
 * Create-time agent choice. The default (first) item is the provider-free
 * `shell`, sent as an ABSENT field so it works against every Core. Every other
 * built-in is labeled unverified: Core accepting it is not a verification.
 */
export function agentPickItems(): AgentPickItem[] {
  return [
    { label: `${DEFAULT_SBX_AGENT} (provider-free)`, description: 'default', agent: undefined },
    ...SBX_AGENTS.filter((a) => a !== DEFAULT_SBX_AGENT).map((agent) => ({
      label: agent,
      description: AGENT_NOT_VERIFIED,
      agent,
    })),
  ];
}
