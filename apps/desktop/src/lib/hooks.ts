/**
 * React data layer.
 *
 * Server/cache state (Core reads and writes) goes through React Query. The
 * task-event stream goes through `TaskEventStore` + `useSyncExternalStore`
 * because it is a replayed stream, not a request/response cache. No Core data is
 * duplicated into a client-side "database": the checkpoint is the only thing the
 * UI remembers, and it only ever asks Core for events after it.
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { useDeps } from "../app/context";

import {
  CoreClient,
  CoreRequestError,
  asCoreRequestError,
  type ProbeOutcome,
} from "./core-client";
import { TaskEventStore } from "./event-store";
import {
  addConversation,
  listConversations,
  subscribeConversations,
} from "./conversation-store";
import {
  decodeApplyResult,
  decodeChangeSet,
  decodeConversation,
  decodeProject,
  decodeProjects,
  decodeSandboxSummaries,
  decodeTaskSummary,
} from "./decode";
import { foldCoreLink, foldTaskIndex, type CoreLinkState, type TaskProjection } from "./reducers";
import type {
  ApplyResult,
  ChangeSet,
  Conversation,
  CoreCapabilities,
  GitApplyParams,
  Project,
  SandboxCreateSpec,
  SandboxSummary,
  TaskStatus,
  TaskSummary,
} from "./protocol";

export interface AppDeps {
  client: CoreClient;
  store: TaskEventStore;
  queryClient: QueryClient;
  /** False when the webview is not inside a Tauri window (no Core socket). */
  transportAvailable: boolean;
  transportKind: string;
  transportReason: string | null;
}

export const queryKeys = {
  probe: ["core", "probe"] as const,
  projects: ["core", "projects"] as const,
  sandboxes: ["core", "sandboxes"] as const,
  review: (taskId: string) => ["core", "git", "review", taskId] as const,
};

// ---------------------------------------------------------------------------
// Link state
// ---------------------------------------------------------------------------

export function useCoreProbe(): {
  outcome: ProbeOutcome | null;
  isError: boolean;
  refetch: () => void;
} {
  const deps = useDeps();
  const query = useQuery<ProbeOutcome>({
    queryKey: queryKeys.probe,
    queryFn: () => deps.client.probe(),
    // A probe never throws: it returns a discriminated outcome, so React Query
    // sees success and `foldCoreLink` decides what the state actually means.
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
  const refetch = useCallback(() => void query.refetch(), [query]);
  return {
    outcome: query.data ?? null,
    isError: query.isError,
    refetch,
  };
}

/**
 * Fold the probe into one link state, carrying the last good capabilities
 * forward so an offline Core can be shown as stale-but-known rather than blank
 * — and never as live.
 */
export function useCoreLink(): CoreLinkState {
  const deps = useDeps();
  const { outcome } = useCoreProbe();
  const lastAttached = useRef<{ capabilities: CoreCapabilities; asOf: number } | null>(null);
  const now = useMemo(() => Date.now(), [outcome]);
  const state = foldCoreLink(outcome, {
    now,
    transportAvailable: deps.transportAvailable,
    transportReason: deps.transportReason,
    ...(lastAttached.current
      ? {
          previous: {
            kind: "attached",
            capabilities: lastAttached.current.capabilities,
            asOf: lastAttached.current.asOf,
            stale: false,
          } as CoreLinkState,
        }
      : {}),
  });
  if (state.kind === "attached") {
    lastAttached.current = {
      capabilities: state.capabilities,
      asOf: state.asOf,
    };
  }
  return state;
}

export function capabilitiesOf(link: CoreLinkState) {
  return link.kind === "attached" ? link.capabilities : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function useProjects(): {
  projects: Project[];
  isLoading: boolean;
  error: CoreRequestError | null;
} {
  const deps = useDeps();
  const query = useQuery<Project[]>({
    queryKey: queryKeys.projects,
    queryFn: async () => decodeProjects(await deps.client.listProjects()),
    enabled: deps.transportAvailable,
    refetchInterval: 20_000,
    staleTime: 5_000,
  });
  return {
    projects: query.data ?? [],
    isLoading: query.isPending && deps.transportAvailable,
    error: query.error ? asCoreRequestError(query.error) : null,
  };
}

export function useSandboxes(): {
  sandboxes: SandboxSummary[];
  isLoading: boolean;
  error: CoreRequestError | null;
} {
  const deps = useDeps();
  const query = useQuery<SandboxSummary[]>({
    queryKey: queryKeys.sandboxes,
    queryFn: async () => decodeSandboxSummaries(await deps.client.listSandboxes()),
    enabled: deps.transportAvailable,
    staleTime: 5_000,
  });
  return {
    sandboxes: query.data ?? [],
    isLoading: query.isPending && deps.transportAvailable,
    error: query.error ? asCoreRequestError(query.error) : null,
  };
}

export function useTaskProjections(): TaskProjection[] {
  const deps = useDeps();
  return useSyncExternalStore(deps.store.subscribe, deps.store.getSnapshot);
}

export function useTaskProjection(taskId: string | null): TaskProjection | null {
  const all = useTaskProjections();
  if (taskId === null) return null;
  return all.find((p) => p.taskId === taskId) ?? null;
}

/**
 * The task index Core implies through its durable events (there is no
 * `task.list` method in protocol v1).
 */
export function useTaskIndex() {
  const projections = useTaskProjections();
  return useMemo(() => {
    const map = new Map(projections.map((p) => [p.taskId, p]));
    return foldTaskIndex(map);
  }, [projections]);
}

export function useStoreStatus() {
  const deps = useDeps();
  useSyncExternalStore(deps.store.subscribe, deps.store.getSnapshot);
  return deps.store.getStatus();
}

export function useSessionConversations(): readonly Conversation[] {
  return useSyncExternalStore(subscribeConversations, listConversations);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function useCreateProject() {
  const deps = useDeps();
  const qc = useQueryClient();
  return useMutation<Project, CoreRequestError, { name: string; repositories: string[] }>({
    mutationFn: async (variables) =>
      decodeProject(await deps.client.createProject(variables)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useCreateSandbox() {
  const deps = useDeps();
  const qc = useQueryClient();
  return useMutation<unknown, CoreRequestError, SandboxCreateSpec>({
    mutationFn: (spec) => deps.client.createSandbox(spec),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sandboxes });
      void qc.invalidateQueries({ queryKey: queryKeys.probe });
    },
  });
}

export function useCreateConversation() {
  const deps = useDeps();
  return useMutation<
    Conversation,
    CoreRequestError,
    { projectId: string; agentId: string; title: string; sandboxId?: string }
  >({
    mutationFn: async (variables) => {
      const conversation = decodeConversation(
        await deps.client.createConversation(variables),
      );
      addConversation(conversation);
      return conversation;
    },
  });
}

export function useSendMessage(conversationId: string | null) {
  const deps = useDeps();
  return useMutation<TaskSummary, CoreRequestError, string>({
    mutationFn: async (content) => {
      if (conversationId === null) {
        throw new CoreRequestError(
          "client",
          "METHOD_NOT_ALLOWED",
          "open a conversation before sending a message",
        );
      }
      return decodeTaskSummary(
        await deps.client.sendMessage({
          conversationId,
          content,
          attachments: [],
        }),
      );
    },
  });
}

export function useCancelTask() {
  const deps = useDeps();
  return useMutation<unknown, CoreRequestError, string>({
    mutationFn: (taskId) => deps.client.cancelTask(taskId),
  });
}

export function useTaskReview(taskId: string | null, enabled: boolean) {
  const deps = useDeps();
  const query = useQuery<ChangeSet>({
    queryKey: ["core", "git", "review", taskId ?? ""],
    queryFn: async () => decodeChangeSet(await deps.client.reviewTask(taskId ?? "")),
    enabled: enabled && taskId !== null && deps.transportAvailable,
    staleTime: 10_000,
  });
  return {
    changeSet: query.data ?? null,
    isLoading: query.isPending && enabled,
    error: query.error ? asCoreRequestError(query.error) : null,
    refetch: () => void query.refetch(),
  };
}

export function useApplyChanges() {
  const deps = useDeps();
  const qc = useQueryClient();
  return useMutation<ApplyResult, CoreRequestError, GitApplyParams>({
    mutationFn: async (params) => decodeApplyResult(await deps.client.applyChanges(params)),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ["core", "git", "review", variables.taskId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Status helpers shared by views
// ---------------------------------------------------------------------------

export function statusOf(
  projection: TaskProjection | null,
): TaskStatus | undefined {
  if (projection === null || projection.status === null) return undefined;
  return projection.status === "unknown" ? undefined : projection.status;
}
