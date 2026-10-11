/**
 * The A6 `git.apply` mutation, outside React so it is testable with
 * TanStack's own `MutationObserver` (the class `useMutation` wraps).
 *
 * - Keyed per task (`["core","git","apply",taskId]`): the pending count
 *   (`useIsMutating`) and the last outcome (`useMutationState`) live in the
 *   client's mutation cache, ABOVE the per-task `ReviewPanelBody`, so single
 *   flight and a partial / lost-answer warning survive a task switch (A6
 *   review W2). `gcTime: Infinity` keeps that outcome past TanStack's 5 min
 *   default for observer-less mutations.
 * - `networkMode: "always"` (D-C1): sent at the user's click or failed then,
 *   never paused and resumed later by an `online` event.
 * - `retry: false`: Core gives no idempotency; a lost answer may have applied.
 * - The review is re-read after every outcome.
 */

import type { MutationFilters, MutationOptions, MutationState, QueryClient } from "@tanstack/react-query";
import { asCoreRequestError, type CoreClient, type CoreRequestError } from "./core-client";
import type { ApplyResult, GitApplyParams } from "./protocol";

/** What one confirmation sends, plus the repository its copy names. */
export interface ApplyVariables {
  request: GitApplyParams;
  repoPath: string;
}

export type ApplyMutationState = MutationState<ApplyResult, CoreRequestError, ApplyVariables>;

export function applyMutationKey(taskId: string): readonly ["core", "git", "apply", string] {
  return ["core", "git", "apply", taskId];
}

export function applyMutationFilters(taskId: string): MutationFilters {
  return { mutationKey: [...applyMutationKey(taskId)], exact: true };
}

export function applyMutationOptions(
  client: Pick<CoreClient, "applyChanges">,
  qc: QueryClient,
  taskId: string,
): MutationOptions<ApplyResult, CoreRequestError, ApplyVariables> {
  return {
    mutationKey: [...applyMutationKey(taskId)],
    networkMode: "always",
    retry: false,
    gcTime: Number.POSITIVE_INFINITY,
    mutationFn: async (variables) => {
      try {
        return await client.applyChanges(variables.request);
      } catch (err) {
        throw asCoreRequestError(err);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["core", "git", "review", taskId] });
    },
  };
}

/** The most recently SUBMITTED apply of a task, or `null`. */
export function lastApplyState(states: readonly ApplyMutationState[]): ApplyMutationState | null {
  let last: ApplyMutationState | null = null;
  for (const state of states) {
    if (last === null || state.submittedAt >= last.submittedAt) last = state;
  }
  return last;
}
