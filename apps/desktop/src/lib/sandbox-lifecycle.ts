/**
 * A1 sandbox lifecycle on the desktop: `sandbox.stop`, the two-step
 * `sandbox.remove`, the visibly unsupported Start, and the sbx agent choice in
 * the create wizard (design 2026-10-09 §2, §3 row A1, §4).
 *
 * Pure logic only (no React, no DOM), so the node-only vitest suites can prove
 * the behaviour that matters: what is sent, when, and how often. Core stays the
 * authority on every outcome; nothing here computes a sandbox state.
 */

import {
  CoreRequestError,
  asCoreRequestError,
  coreErrorCode,
  type CoreClient,
} from "./core-client";
import {
  SBX_AGENTS,
  DEFAULT_SBX_AGENT,
  MAX_LIST_LIMIT,
  TASK_STATUSES,
  coreAdvertisesMethod,
  type ConfirmationRequest,
  type ConfirmationTarget,
  type CoreCapabilities,
  type SandboxStopResult,
  type SbxAgent,
  type TaskStatus,
} from "./protocol";
import {
  TERMINAL_STATUSES,
  describeCoreError,
  displayRevealed,
  featureGate,
  type FeatureGate,
} from "./reducers";

// ---------------------------------------------------------------------------
// Gating on `system.probe`
// ---------------------------------------------------------------------------

/** Short label on a disabled control whose method this Core does not advertise. */
export const NOT_SUPPORTED_BY_CORE = "not supported by this Core";

/** Short label while the probe has not answered (NOT the same as unsupported). */
export const NOT_PROBED_YET = "Core not probed yet";

export interface LifecycleGates {
  stop: FeatureGate;
  remove: FeatureGate;
}

/**
 * Stop / Remove availability for THIS Core. `null` capabilities means the probe
 * has not answered: the controls are disabled as "not probed yet", never as
 * unsupported and never optimistically enabled.
 */
export function lifecycleGates(
  capabilities: Pick<CoreCapabilities, "methods"> | null,
): LifecycleGates {
  const advertised = (method: "sandbox.stop" | "sandbox.remove"): boolean | null =>
    capabilities === null ? null : coreAdvertisesMethod(capabilities, method);
  return {
    stop: featureGate(
      advertised("sandbox.stop"),
      "`sandbox.stop`",
      "This Core does not advertise `sandbox.stop`, so Stop is not supported by this Core. Upgrade Core to stop sandboxes from Sandpane.",
    ),
    remove: featureGate(
      advertised("sandbox.remove"),
      "`sandbox.remove`",
      "This Core does not advertise `sandbox.remove`, so Remove is not supported by this Core. Upgrade Core to remove sandboxes from Sandpane.",
    ),
  };
}

/** The disabled-reason label for a gated control, or `null` when it may be used. */
export function gateBlockLabel(gate: FeatureGate): string | null {
  if (gate.state === "supported") return null;
  return gate.state === "unprobed" ? NOT_PROBED_YET : NOT_SUPPORTED_BY_CORE;
}

/**
 * Start is not a Core method at all: sbx v0.47 has no `start`, and restarting
 * is the interactive `sbx run --name`. The desktop never runs it; it says so.
 */
export function startUnsupportedCopy(name: string): string {
  const shown = displayRevealed(name, 63).text;
  return `Start: not supported by sbx v0.47 (use \`sbx run --name ${shown}\` in a terminal)`;
}

// ---------------------------------------------------------------------------
// Stop outcome
// ---------------------------------------------------------------------------

export interface StopOutcomeView {
  /** True only when Core's re-query returned the row WITH a probed state. */
  stateKnown: boolean;
  /** The probed state as Core re-queried it, or `null` = UNKNOWN. */
  probedState: string | null;
  title: string;
  body: string;
}

/**
 * How a `sandbox.stop` answer is shown. `stopped: true` only means `sbx stop`
 * exited 0; the state shown is the re-queried one, and an ABSENT `requeried`
 * is shown as UNKNOWN — never as an assumed "stopped".
 */
export function stopOutcomeView(result: SandboxStopResult): StopOutcomeView {
  if (!result.stopped) {
    return {
      stateKnown: false,
      probedState: null,
      title: "Core did not report the stop as done — state UNKNOWN",
      body: "Core answered stopped: false. Re-probe to see what SBX reports.",
    };
  }
  const row = result.requeried;
  if (row === undefined) {
    return {
      stateKnown: false,
      probedState: null,
      title: "Stop ran — state UNKNOWN",
      body: "sbx stop exited 0, but the sandbox is no longer listed or Core could not re-query SBX. Sandpane does not assume it is stopped; re-probe to see what SBX reports.",
    };
  }
  if (row.probedState === null) {
    return {
      stateKnown: false,
      probedState: null,
      title: "Stop ran — state UNKNOWN",
      body: "Core re-queried SBX after the stop, but SBX reported no state for this sandbox.",
    };
  }
  const state = displayRevealed(row.probedState, 80).text;
  return {
    stateKnown: true,
    probedState: row.probedState,
    title: `Stop ran — SBX now reports "${state}"`,
    body: "This is the state Core re-queried from SBX after the stop, not an assumption from the exit code.",
  };
}

// ---------------------------------------------------------------------------
// Removal confirmation view
// ---------------------------------------------------------------------------

/**
 * Shared cross-client wording for `ConfirmationRequest.external`. It must not
 * claim the sandbox was created outside Sandpane: `external` is also true for a
 * pre-A1 binding with no recorded sbx id, or a binding for an earlier sandbox
 * that had a different sbx id.
 */
export const EXTERNAL_BANNER = "NOT CONFIRMED AS CREATED BY SANDPANE";
export const EXTERNAL_TEXT =
  "Core cannot confirm Sandpane created this sandbox (no Sandpane binding is recorded for this sbx id).";

/** Impact lines shown before the overflow line. */
export const MAX_IMPACT_LINES = 20;
/** Code points shown per impact line before it is cut (the cut is disclosed). */
export const MAX_IMPACT_LINE_CHARS = 500;

export interface ConfirmationView {
  targetName: string;
  targetId: string;
  impactLines: string[];
  /** "…and N more" line when Core sent more than `MAX_IMPACT_LINES`; else null. */
  overflowLine: string | null;
  external: boolean;
  /** Core's `expiresAt`, revealed for display. */
  expiresAtText: string;
  /** Parsed expiry, or `null` when it cannot be parsed (treated as expired). */
  expiresAtMs: number | null;
  expired: boolean;
  /** Whole seconds left (0 once expired). */
  secondsLeft: number;
  /** True when any shown text had hidden/control characters revealed as escapes. */
  revealedHiddenCharacters: boolean;
}

/** Parse Core's RFC 3339 expiry. Unparseable → `null`, which fails closed. */
export function parseExpiry(expiresAt: string): number | null {
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Fail closed: an unreadable expiry counts as already expired. */
export function isExpired(expiresAtMs: number | null, nowMs: number): boolean {
  return expiresAtMs === null || nowMs >= expiresAtMs;
}

/**
 * Everything the confirmation dialog shows, as plain strings for React to
 * render as TEXT (never HTML). Untrusted strings go through `displayRevealed`,
 * so a bidi override or a newline is shown as a visible `\uXXXX` escape rather
 * than reordering or splitting the line.
 */
export function confirmationView(
  confirmation: ConfirmationRequest,
  nowMs: number,
): ConfirmationView {
  let revealed = false;
  const reveal = (value: string, max: number): string => {
    const shown = displayRevealed(value, max);
    if (shown.unusual) revealed = true;
    return shown.text;
  };
  const targetName = reveal(confirmation.target.name, 200);
  const targetId = reveal(confirmation.target.id, 200);
  const impactLines = confirmation.impact
    .slice(0, MAX_IMPACT_LINES)
    .map((line) => reveal(line, MAX_IMPACT_LINE_CHARS));
  const hidden = confirmation.impact.length - MAX_IMPACT_LINES;
  const expiresAtMs = parseExpiry(confirmation.expiresAt);
  const expired = isExpired(expiresAtMs, nowMs);
  return {
    targetName,
    targetId,
    impactLines,
    overflowLine:
      hidden > 0
        ? `…and ${hidden} more impact line${hidden === 1 ? "" : "s"} from Core, not shown here.`
        : null,
    external: confirmation.external,
    expiresAtText: reveal(confirmation.expiresAt, 64),
    expiresAtMs,
    expired,
    secondsLeft:
      expired || expiresAtMs === null ? 0 : Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000)),
    revealedHiddenCharacters: revealed,
  };
}

// ---------------------------------------------------------------------------
// Two-step removal controller
// ---------------------------------------------------------------------------

export interface FailureCopy {
  title: string;
  body: string;
  action: string;
  /**
   * Core's own message, revealed and capped, when the copy above is this
   * build's interpretation of a code — so cases that share a code (two kinds of
   * CONFLICT) stay distinguishable. Absent when `body` already is Core's text.
   */
  coreMessage?: string;
}

/** Code points of Core's own message shown beside interpreted copy. */
export const MAX_CORE_MESSAGE_CHARS = 300;

export type RemovalState =
  | { kind: "idle" }
  /** Step 1 in flight (`{ name }` sent; Core is minting a confirmation). */
  | { kind: "requesting"; name: string }
  /** Step 1 answered; the dialog is showing Core's confirmation. */
  | { kind: "confirming"; name: string; confirmation: ConfirmationRequest }
  /** Step 2 in flight; the token has been spent and is no longer held. */
  | { kind: "removing"; name: string; target: ConfirmationTarget }
  | { kind: "removed"; name: string; target: ConfirmationTarget }
  | {
      kind: "failed";
      name: string;
      stage: "request" | "confirm" | "expired";
      error: CoreRequestError | null;
      copy: FailureCopy;
    };

/** The two Core calls the flow needs (a `CoreClient` satisfies it). */
export type RemovalClient = Pick<CoreClient, "requestSandboxRemoval" | "confirmSandboxRemoval">;

export interface RemovalFlowOptions {
  /** Called after every Core exchange settles, success or not (refresh the list). */
  onSettled?: () => void;
  now?: () => number;
}

/**
 * Step-2 failure copy. Each Core verdict means "nothing was removed" except a
 * lost answer, which may have been applied and says to re-read state.
 */
export function removalFailureCopy(err: unknown): FailureCopy {
  const error = asCoreRequestError(err);
  const coreMessage = displayRevealed(error.message, MAX_CORE_MESSAGE_CHARS).text;
  switch (coreErrorCode(error)) {
    case "VALIDATION_FAILED":
      return {
        title: "Confirmation refused — nothing was removed",
        body: "Core refused the confirmation: it expired, was already used, or does not match this sandbox.",
        action: "Request a new confirmation if you still want to remove it.",
        coreMessage,
      };
    case "CONFLICT":
      // Core uses CONFLICT for two different situations; Core's own message
      // (shown beside this copy) says which one happened.
      return {
        title: "Conflict — nothing was removed",
        body:
          "Either a sandbox with this name now has a different sbx id than the one you confirmed " +
          "(the confirmation is bound to that id), or another operation on this sandbox is still " +
          "in progress in Core.",
        action:
          "Wait for any running operation to finish, re-probe, and review the sandbox before requesting a new confirmation.",
        coreMessage,
      };
    case "NOT_FOUND":
      return {
        title: "The sandbox is already gone",
        body: "SBX no longer lists this sandbox, so there was nothing left to remove.",
        action: "Re-probe to refresh the list.",
        coreMessage,
      };
    default: {
      // `describeCoreError` already reveals and caps Core's text as `reason`.
      const copy = describeCoreError(error);
      return { title: copy.title, body: copy.reason, action: copy.action };
    }
  }
}

/**
 * The two-step `sandbox.remove` flow, single-flight and token-safe:
 *
 * - `begin` sends step 1 (`{ name }` only). Nothing changes in Core.
 * - `cancel` drops the token; nothing is sent. A step-1 answer that arrives
 *   after a cancel is discarded, never shown.
 * - `confirm` spends the token exactly once: the state moves to `removing`
 *   synchronously BEFORE the request is written, so a double click cannot send
 *   twice. An expired (or unreadable) expiry sends nothing.
 * - Nothing is ever retried; a failed step 2 needs a fresh step 1.
 *
 * The token lives only in this object's `confirming` state. It is never logged,
 * routed, persisted or put into error text.
 */
export class SandboxRemovalFlow {
  private state: RemovalState = { kind: "idle" };
  private readonly listeners = new Set<() => void>();
  /** Bumped by `cancel`/`reset`, so a late step-1 answer is discarded. */
  private generation = 0;
  private readonly now: () => number;

  constructor(
    private readonly client: RemovalClient,
    private readonly options: RemovalFlowOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  getState = (): RemovalState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get busy(): boolean {
    return this.state.kind === "requesting" || this.state.kind === "removing";
  }

  /** Step 1. Ignored while a step is already in flight. */
  async begin(name: string): Promise<void> {
    if (this.busy || this.state.kind === "confirming") return;
    const generation = ++this.generation;
    this.set({ kind: "requesting", name });
    try {
      const confirmation = await this.client.requestSandboxRemoval(name);
      if (generation !== this.generation) return; // cancelled: drop the token unseen
      this.set({ kind: "confirming", name, confirmation });
    } catch (err) {
      if (generation !== this.generation) return;
      const error = asCoreRequestError(err);
      const copy = describeCoreError(error);
      this.set({
        kind: "failed",
        name,
        stage: "request",
        error,
        copy: {
          title: `Could not prepare the removal — ${copy.title}`,
          body: copy.reason,
          action: copy.action,
        },
      });
    } finally {
      if (generation === this.generation) this.options.onSettled?.();
    }
  }

  /** Cancel the dialog. Sends NOTHING; the token is dropped. No-op while removing. */
  cancel(): void {
    if (this.state.kind === "removing") return;
    this.generation += 1;
    this.set({ kind: "idle" });
  }

  /** Clear a finished/failed state (same as cancel, but explicit for the UI). */
  reset(): void {
    this.cancel();
  }

  /**
   * Step 2. Sends `{ name, confirmToken }` once, only from `confirming`, only
   * before expiry. Returns whether a request was written.
   */
  confirm(): boolean {
    const state = this.state;
    if (state.kind !== "confirming") return false;
    const { name, confirmation } = state;
    if (isExpired(parseExpiry(confirmation.expiresAt), this.now())) {
      this.set({
        kind: "failed",
        name,
        stage: "expired",
        error: null,
        copy: {
          title: "Confirmation expired — nothing was sent",
          body: "Core's confirmation is only valid until its expiry time, so this desktop did not send it.",
          action: "Request a new confirmation if you still want to remove the sandbox.",
        },
      });
      return false;
    }
    const target = confirmation.target;
    // Spend the token: from here on only the in-flight request holds it.
    this.set({ kind: "removing", name, target });
    void this.client
      .confirmSandboxRemoval(name, confirmation.token)
      .then(
        () => this.set({ kind: "removed", name, target }),
        (err: unknown) =>
          this.set({
            kind: "failed",
            name,
            stage: "confirm",
            error: asCoreRequestError(err),
            copy: removalFailureCopy(err),
          }),
      )
      .finally(() => this.options.onSettled?.());
    return true;
  }

  private set(next: RemovalState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

// ---------------------------------------------------------------------------
// Stop confirmation (specs/05: start/stop/remove require confirmation)
// ---------------------------------------------------------------------------

/** Non-terminal statuses — the tasks a stop would end. */
export const NON_TERMINAL_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter(
  (status) => !TERMINAL_STATUSES.includes(status),
);

/**
 * What the stop dialog can honestly say about active tasks in a sandbox:
 * - a number — counted from non-terminal tasks that carry `sandboxName`;
 * - `null` — could not be fully checked (`task.list` not advertised, failed,
 *   or returned a full page, so more rows may exist);
 * - `"unrecorded"` — Core returned active tasks but none carries a
 *   `sandboxName` (today's Core never records which sandbox a task uses), so
 *   a count of 0 would be a false claim;
 * - `"checking"` — `task.list` is still in flight.
 */
export type ActiveTaskCount = number | null | "checking" | "unrecorded";

/**
 * Count non-terminal Core tasks (all projects) on this sandbox via `task.list`.
 * Never blocks the stop; it only informs the confirmation.
 *
 * A number is returned only when it is established: either Core has NO
 * non-terminal task at all (0 everywhere, so 0 here), or at least one returned
 * task carries a `sandboxName` (a Core that records the link). Otherwise the
 * answer is `"unrecorded"`, never 0.
 */
export async function countActiveTasksOn(
  client: Pick<CoreClient, "listTasks">,
  taskListAdvertised: boolean,
  sandboxName: string,
): Promise<number | null | "unrecorded"> {
  if (!taskListAdvertised) return null;
  try {
    const tasks = await client.listTasks({
      statuses: NON_TERMINAL_STATUSES,
      limit: MAX_LIST_LIMIT,
    });
    if (tasks.length >= MAX_LIST_LIMIT) return null;
    if (tasks.length === 0) return 0;
    const linked = tasks.filter(
      (task) => typeof task.sandboxName === "string" && task.sandboxName.length > 0,
    );
    if (linked.length === 0) return "unrecorded";
    return linked.filter((task) => task.sandboxName === sandboxName).length;
  } catch {
    return null;
  }
}

/** Exact cross-client copy when Core does not record a task's sandbox. */
export const TASK_SANDBOX_UNRECORDED_COPY =
  "Active tasks in this sandbox cannot be checked: Core does not yet record which sandbox a task uses.";

export interface StopConfirmationCopy {
  title: string;
  taskLine: string;
  /** True when the count is known and non-zero (shown as a warning). */
  tasksAtRisk: boolean;
  body: string;
}

export function stopConfirmationCopy(name: string, active: ActiveTaskCount): StopConfirmationCopy {
  const shown = displayRevealed(name, 63).text;
  const taskLine =
    active === "checking"
      ? "Checking Core for active tasks in this sandbox… (you do not have to wait)"
      : active === "unrecorded"
        ? TASK_SANDBOX_UNRECORDED_COPY
        : active === null
          ? "Active tasks could not be fully checked (Core did not list them, or the list hit its limit) — any agent task inside the sandbox would end."
          : active > 0
            ? `WARNING: Core records ${active} active task${active === 1 ? "" : "s"} in this sandbox; stopping it ends ${active === 1 ? "it" : "them"}.`
            : "Core records no active task in this sandbox.";
  return {
    title: `Stop sandbox ${shown}?`,
    taskLine,
    tasksAtRisk: typeof active === "number" && active > 0,
    body:
      "sbx stops the sandbox and every process running inside it ends. Core re-queries SBX afterwards; the state shown is what SBX reports. " +
      "Start is not available from Sandpane (sbx v0.47 has no start command; use `sbx run --name` in a terminal).",
  };
}

export type StopConfirmState =
  | { kind: "idle" }
  | { kind: "confirming"; name: string; active: ActiveTaskCount };

/**
 * The stop confirmation. `open` shows the dialog at once and counts active
 * tasks in the background (a late count for a closed or different dialog is
 * dropped). `cancel` sends nothing. `confirm` returns the name to stop exactly
 * once and closes the dialog; the caller sends `sandbox.stop`.
 */
export class SandboxStopConfirm {
  private state: StopConfirmState = { kind: "idle" };
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  constructor(
    private readonly countActive: (name: string) => Promise<number | null | "unrecorded">,
  ) {}

  getState = (): StopConfirmState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  open(name: string): void {
    if (this.state.kind === "confirming") return;
    const generation = ++this.generation;
    this.set({ kind: "confirming", name, active: "checking" });
    void this.countActive(name)
      .catch(() => null)
      .then((active) => {
        const current = this.state;
        if (generation !== this.generation || current.kind !== "confirming") return;
        this.set({ ...current, active });
      });
  }

  cancel(): void {
    this.generation += 1;
    this.set({ kind: "idle" });
  }

  /** The name to stop (once), or `null` when no dialog is open. */
  confirm(): string | null {
    const current = this.state;
    if (current.kind !== "confirming") return null;
    this.generation += 1;
    this.set({ kind: "idle" });
    return current.name;
  }

  private set(next: StopConfirmState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

// ---------------------------------------------------------------------------
// sbx agent choice in the create wizard
// ---------------------------------------------------------------------------

export interface SbxAgentOption {
  id: SbxAgent;
  label: string;
  /** Disabled when this Core would not honour the field (pre-A1). */
  disabled: boolean;
}

export const SHELL_AGENT_LABEL = "shell (provider-free)";
export const UNVERIFIED_AGENT_NOTE =
  "agent not verified — may need provider sign-in inside the sandbox";

/**
 * Options for the wizard's sbx agent select: the exact `SBX_AGENTS` allowlist,
 * `shell` first and default. Every other entry is labelled unverified.
 *
 * `agentFieldHonoured` is whether THIS Core understands `SandboxCreateSpec.agent`.
 * A pre-A1 Core would silently IGNORE the key (serde drops unknown fields) and
 * create a shell sandbox while the UI claimed otherwise, so non-shell options
 * are disabled unless the A1 signal (`sandbox.remove` advertised) is present.
 */
export function sbxAgentOptions(agentFieldHonoured: boolean): SbxAgentOption[] {
  const rest = SBX_AGENTS.filter((id) => id !== DEFAULT_SBX_AGENT);
  return [
    { id: DEFAULT_SBX_AGENT, label: SHELL_AGENT_LABEL, disabled: false },
    ...rest.map((id) => ({
      id,
      label: agentFieldHonoured
        ? `${id} — ${UNVERIFIED_AGENT_NOTE}`
        : `${id} — ${NOT_SUPPORTED_BY_CORE}`,
      disabled: !agentFieldHonoured,
    })),
  ];
}

/** The A1 signal the wizard uses to decide whether `agent` is honoured. */
export function agentFieldHonoured(
  capabilities: Pick<CoreCapabilities, "methods"> | null,
): boolean {
  return capabilities !== null && coreAdvertisesMethod(capabilities, "sandbox.remove");
}
