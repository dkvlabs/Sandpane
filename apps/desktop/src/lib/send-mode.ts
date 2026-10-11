/**
 * A4 `conversation.send` mode (design 2026-10-09 §3.4), as the desktop uses it.
 *
 * - `mode` is sent ONLY when `conversation-send-mode` is advertised: a pre-A4
 *   Core silently drops it and would record a discussion as a task.
 * - Task omits `mode` (frames stay byte-identical to A2/A3b frames); Discuss
 *   sends `"discuss"`. Core normalizes an explicit `"task"` anyway.
 * - A keyed "Retry safely" resends the IDENTICAL params (same key, same mode)
 *   and is not sent at all when a Discuss retry would reach a Core that no
 *   longer advertises send mode.
 * - Neither mode runs an agent in this build: Core records the requested mode
 *   and the task stays queued. Discuss is NOT a sandbox, a read-only run or a
 *   safety setting, and the copy never says so.
 * - `TaskSummary.mode` is an OPEN string and `chosenSandboxName` is a stored
 *   name, never a binding; both are shown read-only, revealed and capped.
 */

import type { ProbeOutcome } from "./core-client";
import { idempotencyKeysAdvertised, keyRecheckFromProbe, type KeyRecheck } from "./idempotency";
import {
  FEATURE_CONVERSATION_SEND_MODE,
  SEND_MODES,
  coreAdvertisesFeature,
  type ConversationSendParams,
  type CoreCapabilities,
  type SendMode,
  type TaskSummary,
} from "./protocol";
import { displayRevealed, featureGate, type FeatureGate } from "./reducers";

export { SEND_MODES };
export type { SendMode };

export { MSG_SEND_MODE_INVALID } from "./conversation-messages";

/** Composer copy: what the choice does — and does not do — in this build. */
export const SEND_MODE_COMPOSER_COPY =
  "Neither Task nor Discuss runs an agent in this build: Core records the requested mode on the task, and the task stays queued because no verified adapter exists. Discuss is a label Core stores, not a sandbox or a restricted run.";

/** Shown when a Discuss retry would reach a Core that would drop `mode`. */
export const NOT_RETRIED_NO_SEND_MODE =
  "Not retried: the connected Core no longer advertises conversation-send-mode, so it would drop \"discuss\" and could record this as a task. Nothing was sent — check state first.";

/** A NEW Discuss send whose fresh probe no longer advertises send modes. */
export const NOT_SENT_NO_SEND_MODE =
  "Not sent: this Core does not advertise send modes, so it would record the discussion as a task. Nothing was sent.";

/** A NEW Discuss send whose fresh probe failed. */
export const NOT_SENT_UNCHECKED =
  "Not sent: Core could not be re-checked for send modes, so the discussion was not sent (it could have been recorded as a task). Nothing was sent — try again.";

/** Display cap for Core strings on task rows (mode, chosen sandbox name). */
export const TASK_FACT_MAX_CHARS = 120;

/** What the composer offers. Not persisted: per conversation, this window only. */
export type SendChoice = SendMode;

/** The variables one Send is made of; `mode` only ever holds `"discuss"`. */
export interface SendVariables {
  conversationId: string;
  content: string;
  idempotencyKey?: string;
  mode?: "discuss";
}

/** The Task / Discuss choice's gate on `system.probe` `features`. */
export function sendModeGate(capabilities: Pick<CoreCapabilities, "features"> | null): FeatureGate {
  return featureGate(
    capabilities === null ? null : coreAdvertisesFeature(capabilities, FEATURE_CONVERSATION_SEND_MODE),
    FEATURE_CONVERSATION_SEND_MODE,
    "Task / Discuss is not supported by this Core (it does not advertise conversation-send-mode); every send is recorded as a task.",
  );
}

/**
 * The variables of a NEW send. `mode: "discuss"` only when Discuss was chosen
 * AND the feature is advertised right now (`null` = not probed = not sent).
 */
export function buildSendVariables(
  send: { conversationId: string; content: string; idempotencyKey?: string },
  choice: SendChoice,
  modeAdvertised: boolean | null,
): SendVariables {
  return {
    conversationId: send.conversationId,
    content: send.content,
    ...(send.idempotencyKey === undefined ? {} : { idempotencyKey: send.idempotencyKey }),
    ...(choice === "discuss" && modeAdvertised === true ? { mode: "discuss" as const } : {}),
  };
}

/** The exact `conversation.send` params for these variables (no attachments in this build). */
export function sendParamsFor(variables: SendVariables): ConversationSendParams {
  return {
    conversationId: variables.conversationId,
    content: variables.content,
    attachments: [],
    ...(variables.idempotencyKey === undefined ? {} : { idempotencyKey: variables.idempotencyKey }),
    ...(variables.mode === undefined ? {} : { mode: variables.mode }),
  };
}

/**
 * The pre-retry check for a keyed Send: keys must still be advertised, and a
 * Discuss retry also needs `conversation-send-mode` (else nothing is sent).
 */
export function sendKeyRecheck(
  capabilities: Pick<CoreCapabilities, "features">,
  variables: Pick<SendVariables, "mode">,
): KeyRecheck {
  if (!idempotencyKeysAdvertised(capabilities)) return { kind: "not-advertised" };
  if (variables.mode !== undefined && !coreAdvertisesFeature(capabilities, FEATURE_CONVERSATION_SEND_MODE)) {
    return { kind: "not-retried", note: NOT_RETRIED_NO_SEND_MODE };
  }
  return { kind: "advertised" };
}

/** `sendKeyRecheck` over a fresh `system.probe` outcome. */
export function sendKeyRecheckFromProbe(outcome: ProbeOutcome, variables: Pick<SendVariables, "mode">): KeyRecheck {
  if (outcome.kind === "attached") return sendKeyRecheck(outcome.capabilities, variables);
  return keyRecheckFromProbe(outcome);
}

export type SubmitOutcome = { kind: "submitted" } | { kind: "not-sent"; note: string };

/**
 * Submit a NEW send. A Discuss send never trusts the cached probe: Core is
 * re-probed first, and when it no longer advertises `conversation-send-mode`
 * (or cannot be re-checked) nothing is sent — it is never downgraded to Task.
 * A Task send is submitted as is.
 */
export async function submitWithDiscussPrecheck(
  variables: SendVariables,
  deps: { probe: () => Promise<ProbeOutcome>; submit: (variables: SendVariables) => Promise<boolean> },
): Promise<SubmitOutcome> {
  if (variables.mode === "discuss") {
    let outcome: ProbeOutcome;
    try {
      outcome = await deps.probe();
    } catch {
      return { kind: "not-sent", note: NOT_SENT_UNCHECKED };
    }
    if (outcome.kind === "unreachable") return { kind: "not-sent", note: NOT_SENT_UNCHECKED };
    if (outcome.kind !== "attached" || !coreAdvertisesFeature(outcome.capabilities, FEATURE_CONVERSATION_SEND_MODE)) {
      return { kind: "not-sent", note: NOT_SENT_NO_SEND_MODE };
    }
  }
  await deps.submit(variables);
  return { kind: "submitted" };
}

/**
 * After a Discuss send Core accepted: a warning when the task does not report
 * `mode: "discuss"` (Core did not record what was asked), else `null`.
 */
export function discussModeNotRecorded(
  variables: Pick<SendVariables, "mode">,
  result: Pick<TaskSummary, "mode">,
): string | null {
  if (variables.mode !== "discuss" || result.mode === "discuss") return null;
  const reported =
    result.mode === undefined
      ? "reports no send mode"
      : `reports send mode "${displayRevealed(result.mode, TASK_FACT_MAX_CHARS).text}"`;
  return `Core did not record the requested mode: Discuss was asked for, but the task ${reported}. Treat it as recorded by Core, not as a discussion.`;
}

export interface TaskFact {
  label: string;
  /** Core's value, revealed and capped. */
  value: string;
  note: string | null;
}

export const CHOSEN_SANDBOX_LABEL = "Sandbox chosen by its chat — not where it runs";

/**
 * The A4 facts of one task, for rows and detail. Only what Core reported;
 * an absent field is left out (older tasks carry neither).
 */
export function taskSendFacts(
  task: Pick<TaskSummary, "mode" | "chosenSandboxName"> | { mode: string | null; chosenSandboxName: string | null },
): TaskFact[] {
  const facts: TaskFact[] = [];
  const mode = task.mode ?? null;
  if (mode !== null) {
    facts.push({ label: "Send mode", value: displayRevealed(mode, TASK_FACT_MAX_CHARS).text, note: null });
  }
  const chosen = task.chosenSandboxName ?? null;
  if (chosen !== null) {
    facts.push({
      label: CHOSEN_SANDBOX_LABEL,
      value: displayRevealed(chosen, TASK_FACT_MAX_CHARS).text,
      note: "A name the chat stored when it was created — not a binding. No task runs in a sandbox in this build.",
    });
  }
  return facts;
}
