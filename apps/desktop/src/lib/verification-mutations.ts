/**
 * The A7 writes as TanStack mutations, outside React so they are testable
 * with TanStack's own `MutationObserver` (the class `useMutation` wraps).
 *
 * `verification.run` (design 2026-10-09 §3.7 item 5):
 * - Keyed per task (`["core","verification","run",taskId]`) and kept in the
 *   client's mutation cache with `gcTime: Infinity`, so single flight and a
 *   lost-answer outcome (with its idempotency key) survive a task switch
 *   (the A6 review W2 lesson).
 * - `submitRun` is the ONLY way a run is sent: it refuses while a run of the
 *   same task is pending. TanStack dispatches `pending` synchronously inside
 *   `mutate`, so a double confirm sends exactly one frame.
 * - Every new user gesture carries a FRESH key; the SAME key is reused only by
 *   an explicit "Retry safely" after an unknown outcome (A2 rules).
 * - `networkMode: "always"` (A6 D-C1): sent at the click or failed then.
 * - `retry: false`: nothing is ever re-sent by itself.
 *
 * `verification.approve` / `verification.revoke`: plain mutations, the same
 * network mode, never retried, the list re-read after every outcome.
 */

import type { MutationFilters, MutationOptions, MutationState, QueryClient } from "@tanstack/react-query";
import { asCoreRequestError, type CoreClient, type CoreRequestError } from "./core-client";
import { isUnknownOutcome, provablyUnsent } from "./idempotency";
import type { VerificationCommand, VerificationRunParams, VerificationRunResult } from "./protocol";
import type { VerificationFailureCopy } from "./verification";

/** What one confirmed Run sends. `retry` marks an explicit "Retry safely". */
export interface RunVariables {
  request: VerificationRunParams;
  retry: boolean;
}

export type RunMutationState = MutationState<VerificationRunResult, CoreRequestError, RunVariables>;

export function runMutationKey(taskId: string): readonly ["core", "verification", "run", string] {
  return ["core", "verification", "run", taskId];
}

export function runMutationFilters(taskId: string): MutationFilters {
  return { mutationKey: [...runMutationKey(taskId)], exact: true };
}

/** Query keys of the verification reads (one place, so writes invalidate exactly these). */
export const verificationKeys = {
  commands: (projectId: string) => ["core", "verification", "commands", projectId] as const,
  context: (projectId: string) => ["core", "verification", "context", projectId] as const,
  result: (runId: string) => ["core", "verification", "result", runId] as const,
};

export function runMutationOptions(
  client: Pick<CoreClient, "runVerification">,
  taskId: string,
): MutationOptions<VerificationRunResult, CoreRequestError, RunVariables> {
  return {
    mutationKey: [...runMutationKey(taskId)],
    networkMode: "always",
    retry: false,
    gcTime: Number.POSITIVE_INFINITY,
    mutationFn: async (variables) => {
      try {
        return await client.runVerification(variables.request);
      } catch (err) {
        throw asCoreRequestError(err);
      }
    },
  };
}

/**
 * Send one run, or nothing when a run of this task is already pending in the
 * client's mutation cache. Returns whether `mutate` was called.
 */
export function submitRun(
  qc: QueryClient,
  taskId: string,
  mutate: (variables: RunVariables) => unknown,
  variables: RunVariables,
): boolean {
  if (variables.request.taskId !== taskId) return false;
  if (qc.isMutating(runMutationFilters(taskId)) > 0) return false;
  mutate(variables);
  return true;
}

export interface RunOutcomeView {
  /** The state that defines what the user sees, or null when nothing was sent. */
  current: RunMutationState | null;
  /** Secondary text: the last Retry safely never reached Core. */
  note: string | null;
  /**
   * When the FIRST frame carrying `current`'s idempotency key was sent
   * (TanStack's `submittedAt`, a `Date.now()` value), or null when `current`
   * carried no key. A Retry safely reuses the key, so this stays the
   * original send — the age Core's key retention is measured against.
   */
  keyFirstSentAt: number | null;
  /**
   * The task's latest run answer was lost (keyed or not) and nothing has
   * resolved it since: an earlier run of this task may have started. Run
   * stays possible as a NEW gesture; its confirmation says so (D-I2).
   */
  earlierRunUnknown: boolean;
}

/**
 * The newest run of a task — except that a "Retry safely" which provably
 * never reached Core does not replace the earlier unknown outcome (its key
 * and its Retry safely offer stay).
 */
export function runOutcomeView(states: readonly RunMutationState[]): RunOutcomeView {
  const ordered = [...states].sort((a, b) => a.submittedAt - b.submittedAt);
  const newest = ordered.at(-1) ?? null;
  if (newest === null) return { current: null, note: null, keyFirstSentAt: null, earlierRunUnknown: false };
  const view = (current: RunMutationState, note: string | null): RunOutcomeView => {
    const key = current.variables?.request.idempotencyKey;
    const sameKey = key === undefined ? [] : ordered.filter((s) => s.variables?.request.idempotencyKey === key);
    return {
      current,
      note,
      keyFirstSentAt: sameKey.length === 0 ? null : Math.min(...sameKey.map((s) => s.submittedAt)),
      earlierRunUnknown: current.status === "error" && current.error !== null && isUnknownOutcome(current.error),
    };
  };
  if (
    newest.status === "error" &&
    newest.variables?.retry === true &&
    newest.error !== null &&
    provablyUnsent(newest.error)
  ) {
    const earlier = [...ordered.slice(0, -1)]
      .reverse()
      .find((s) => s.status === "error" && s.variables?.request.idempotencyKey === newest.variables?.request.idempotencyKey);
    if (earlier !== undefined) {
      return view(earlier, "The retry did not reach Core, so nothing was sent; the earlier outcome is still unknown.");
    }
  }
  return view(newest, null);
}

/**
 * Core keeps an idempotency key for 24 hours (`idempotency::RETENTION_SECS`,
 * drift-pinned in the tests). "Retry safely" is
 * offered only while the key is certainly still held: within 23 hours of the
 * key's FIRST send, leaving an hour of margin for clock skew and a slow
 * answer. The mutation cache keeps the state forever (`gcTime: Infinity`), so
 * without this a day-old offer would resend a key Core may have forgotten —
 * and then run the command a second time.
 */
export const RETRY_SAFELY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const TOO_LATE_TO_RETRY_SAFELY =
  "Too late to retry safely — the earlier run may have started; check Results before running again.";

export type RetrySafelyWindow = "open" | "expired" | "none";

/** Whether the current failed run's key is still inside the retry window, at `now` (injectable clock). */
export function retrySafelyWindow(view: RunOutcomeView, now: number): RetrySafelyWindow {
  if (view.current?.status !== "error" || view.keyFirstSentAt === null) return "none";
  return now - view.keyFirstSentAt < RETRY_SAFELY_WINDOW_MS ? "open" : "expired";
}

/**
 * The run failure copy as shown at `now`: past the window, Retry safely is
 * withdrawn and the action says it is too late; otherwise unchanged.
 */
export function runFailureCopyAt(copy: VerificationFailureCopy, view: RunOutcomeView, now: number): VerificationFailureCopy {
  if (!copy.retrySafely) return copy;
  const window = retrySafelyWindow(view, now);
  if (window === "open") return copy;
  return { ...copy, retrySafely: false, action: TOO_LATE_TO_RETRY_SAFELY };
}

export interface ApproveVariables {
  request: { projectId: string; label: string; argv: string[] };
}

export function approveMutationOptions(
  client: Pick<CoreClient, "approveVerificationCommand">,
  qc: QueryClient,
  projectId: string,
): MutationOptions<VerificationCommand, CoreRequestError, ApproveVariables> {
  return {
    mutationKey: ["core", "verification", "approve", projectId],
    networkMode: "always",
    retry: false,
    mutationFn: async (variables) => {
      try {
        return await client.approveVerificationCommand(variables.request);
      } catch (err) {
        throw asCoreRequestError(err);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: verificationKeys.commands(projectId) });
      void qc.invalidateQueries({ queryKey: verificationKeys.context(projectId) });
    },
  };
}

export function revokeMutationOptions(
  client: Pick<CoreClient, "revokeVerificationCommand">,
  qc: QueryClient,
  projectId: string,
): MutationOptions<{ revoked: true }, CoreRequestError, { commandId: string }> {
  return {
    mutationKey: ["core", "verification", "revoke", projectId],
    networkMode: "always",
    retry: false,
    mutationFn: async (variables) => {
      try {
        return await client.revokeVerificationCommand(variables.commandId);
      } catch (err) {
        throw asCoreRequestError(err);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: verificationKeys.commands(projectId) });
      void qc.invalidateQueries({ queryKey: verificationKeys.context(projectId) });
    },
  };
}
