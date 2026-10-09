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
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
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
  decodeConversation,
  decodeProject,
  decodeProjects,
} from "./decode";
import {
  foldCoreLink,
  foldTaskIndex,
  foldTranscript,
  featureGate,
  scopeProjectionsToProject,
  type CoreLinkState,
  type TaskIndexEntry,
  type FeatureGate,
  type TaskProjection,
  type TranscriptView,
} from "./reducers";
import {
  coreAdvertisesMethod,
  type ApplyResult,
  type ChangeSet,
  type Conversation,
  type ConversationHistoryResult,
  type CoreCapabilities,
  type GitApplyParams,
  type Method,
  type Project,
  type SandboxCreateSpec,
  type SandboxSummary,
  type TaskStatus,
  type TaskSummary,
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
  conversations: (projectId: string | null) =>
    ["core", "conversations", projectId ?? "*"] as const,
  coreTasks: (projectId: string | null) =>
    ["core", "task-list", projectId ?? "*"] as const,
  history: (conversationId: string) => ["core", "history", conversationId] as const,
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
    queryFn: () => deps.client.listSandboxSummaries(),
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
 * Does the attached Core advertise `method`?
 *
 * `null` while unprobed (NOT the same as unsupported). Nothing in this app may
 * call a method it has not seen advertised, because a pre-revision Core does not
 * dispatch the additive v1 reads (AGENTS rule 5: no claimed capability without a
 * verified path).
 */
export function useAdvertisesMethod(method: Method): boolean | null {
  const link = useCoreLink();
  const capabilities = capabilitiesOf(link);
  if (capabilities === null) return null;
  return coreAdvertisesMethod(capabilities, method);
}

/**
 * Core's stored task rows via `task.list` — the read that makes reconnect
 * hydration possible. A task Core knows about but this window never folded an
 * event for was invisible before this method existed; now the row can be shown
 * with its status exactly as Core stores it (no transition is computed here).
 *
 * Disabled — never optimistically called — when the probe does not advertise it.
 */
export function useCoreTasks(projectId: string | null = null): {
  tasks: TaskSummary[];
  gate: FeatureGate;
  isLoading: boolean;
  error: CoreRequestError | null;
} {
  const deps = useDeps();
  const gate = useCoreFeatureGate("task.list", "task.list");
  const query = useQuery<TaskSummary[]>({
    queryKey: queryKeys.coreTasks(projectId),
    queryFn: () => deps.client.listTasks({ ...(projectId === null ? {} : { projectId }) }),
    enabled: deps.transportAvailable && gate.state === "supported",
    staleTime: 5_000,
    refetchInterval: 20_000,
    refetchOnReconnect: "always",
  });
  return {
    tasks: query.data ?? [],
    gate,
    isLoading: query.isPending && gate.state === "supported" && deps.transportAvailable,
    error: query.error ? asCoreRequestError(query.error) : null,
  };
}

/**
 * The task index: Core's rows where `task.list` is advertised, plus every task
 * the durable event replay reported. Sources are labelled per row and a
 * disagreement between Core's two reads is surfaced, never silently resolved.
 *
 * Views read `gate.state` for their own copy rather than a derived mode, because
 * "unprobed" and "not advertised" are different statements.
 */
export function useTaskIndex(projectId: string | null = null): {
  rows: TaskIndexEntry[];
  gate: FeatureGate;
  error: CoreRequestError | null;
  /**
   * Projections replayed in this window that could not be attributed to the
   * project (no `task.list` row, no known conversation). Always 0 unscoped.
   */
  unattributed: number;
  refresh: () => Promise<unknown>;
} {
  const projections = useTaskProjections();
  const { tasks, gate, error } = useCoreTasks(projectId);
  // Only a project-scoped index needs the conversation list; the unscoped one
  // must not issue a global `conversation.list` it never reads.
  const coreChats = useCoreConversations(projectId, projectId !== null);
  const session = useSessionConversations();
  const deps = useDeps();
  const conversationsAuthoritative =
    coreChats.gate.state === "supported" &&
    coreChats.error === null &&
    !coreChats.isLoading &&
    coreChats.loaded;
  const { rows, unattributed } = useMemo(() => {
    // Only hand Core's rows to the fold when the method was actually advertised
    // and answered; otherwise the index stays the event-derived one.
    const coreRows = gate.state === "supported" ? tasks : [];
    let scoped: readonly TaskProjection[] = projections;
    let excluded = 0;
    if (projectId !== null) {
      // The replay stream is window-wide; a project view shows only what Core's
      // project-scoped reads prove belongs to this project.
      const conversationIds = new Set<string>();
      for (const c of coreChats.conversations) if (c.projectId === projectId) conversationIds.add(c.id);
      for (const c of session) if (c.projectId === projectId) conversationIds.add(c.id);
      const result = scopeProjectionsToProject(projections, {
        taskIds: new Set(coreRows.map((t) => t.id)),
        conversationIds,
        conversationsAuthoritative,
      });
      scoped = result.inScope;
      excluded = result.unattributed;
    }
    const map = new Map(scoped.map((p) => [p.taskId, p]));
    return { rows: foldTaskIndex(map, coreRows), unattributed: excluded };
  }, [
    projections,
    tasks,
    gate.state,
    projectId,
    coreChats.conversations,
    session,
    conversationsAuthoritative,
  ]);
  return {
    rows,
    gate,
    error,
    unattributed,
    refresh: () =>
      deps.queryClient.invalidateQueries({ queryKey: queryKeys.coreTasks(projectId) }),
  };
}

/**
 * The replay stream's status. `getStatus` returns a stable reference until the
 * status structurally changes, and `setStatus` notifies, so a degraded or
 * refused stream re-renders the banner even when no event arrived.
 */
export function useStoreStatus() {
  const deps = useDeps();
  return useSyncExternalStore(deps.store.subscribe, deps.store.getStatus);
}

/** Conversations created in this window (in-memory; survives no reload by design). */
export function useSessionConversations(): readonly Conversation[] {
  return useSyncExternalStore(subscribeConversations, listConversations);
}

/**
 * `conversation.list` — every non-archived conversation Core holds for a
 * project, which is what lets the cockpit show chats this window never created.
 */
export function useCoreConversations(
  projectId: string | null,
  wanted = true,
): {
  conversations: Conversation[];
  gate: FeatureGate;
  isLoading: boolean;
  /** True once Core actually answered (not pending, not a placeholder). */
  loaded: boolean;
  error: CoreRequestError | null;
  refetch: () => void;
} {
  const deps = useDeps();
  const gate = useCoreFeatureGate("conversation.list", "conversation.list");
  const query = useQuery<Conversation[]>({
    queryKey: queryKeys.conversations(projectId),
    queryFn: () =>
      deps.client.listConversations({ ...(projectId === null ? {} : { projectId }) }),
    enabled: wanted && deps.transportAvailable && gate.state === "supported",
    staleTime: 5_000,
  });
  return {
    conversations: query.data ?? [],
    gate,
    loaded: query.isSuccess,
    isLoading: query.isPending && gate.state === "supported" && deps.transportAvailable,
    error: query.error ? asCoreRequestError(query.error) : null,
    refetch: () => void query.refetch(),
  };
}

/**
 * React Query options for paged `conversation.history`, exported so the paging
 * contract is testable against a plain `QueryClient` without a DOM.
 *
 * Keyed per conversation, so a page can never land in another conversation's
 * transcript (the old local-state version appended a late page to whichever
 * chat was open). The next page exists only while Core's newest page says it
 * was `truncated`; its cursor is Core's own `nextSequence`.
 */
export function conversationHistoryQueryOptions(client: CoreClient, conversationId: string) {
  return {
    queryKey: queryKeys.history(conversationId),
    queryFn: ({ pageParam }: { pageParam: number }) =>
      client.getConversationHistory({ conversationId, afterSequence: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage: ConversationHistoryResult): number | undefined =>
      lastPage.truncated ? lastPage.nextSequence : undefined,
    staleTime: 5_000,
  };
}

/**
 * Paged `conversation.history` for one conversation.
 *
 * Pages accumulate one bounded read at a time (each asks Core for
 * `nextSequence` onward) and every page keeps Core's own `truncated`
 * disclosure, so the transcript can always say "this is what N bounded pages
 * returned", never "this is the whole conversation". A send invalidates the
 * query (see `useSendMessage`), so the transcript re-reads what Core stored.
 */
export function useConversationHistory(conversationId: string | null): {
  transcript: TranscriptView;
  gate: FeatureGate;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: CoreRequestError | null;
  loadMore: () => void;
} {
  const deps = useDeps();
  const gate = useCoreFeatureGate("conversation.history", "conversation.history");
  const enabled = deps.transportAvailable && conversationId !== null && gate.state === "supported";
  const query = useInfiniteQuery<
    ConversationHistoryResult,
    Error,
    InfiniteData<ConversationHistoryResult, number>,
    readonly string[],
    number
  >({
    ...conversationHistoryQueryOptions(deps.client, conversationId ?? ""),
    enabled,
  });
  const pages = query.data?.pages;
  const transcript = useMemo(() => foldTranscript(pages ?? []), [pages]);
  const { fetchNextPage, isFetchingNextPage, hasNextPage } = query;
  const loadMore = useCallback(() => {
    // One page at a time: never stack a second read on an in-flight one.
    if (isFetchingNextPage || !hasNextPage) return;
    void fetchNextPage({ cancelRefetch: false });
  }, [fetchNextPage, isFetchingNextPage, hasNextPage]);
  return {
    transcript,
    gate,
    isLoading: enabled && query.isPending,
    isLoadingMore: isFetchingNextPage,
    error: query.error ? asCoreRequestError(query.error) : null,
    loadMore,
  };
}

/**
 * A capability gate for one ADDITIVE method, folded from the probe so no view
 * has to remember that "not advertised" and "not probed" are different answers.
 */
export function useCoreFeatureGate(method: Method, label?: string): FeatureGate {
  const advertised = useAdvertisesMethod(method);
  return featureGate(
    advertised,
    `\`${label ?? method}\``,
    `This Core does not advertise \`${label ?? method}\`, so the data behind this view does not exist here — it is not hidden, it is unavailable.`,
  );
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

/**
 * `conversation.send`. The conversation id travels WITH the variables, so the
 * caller can attribute a success or failure to the chat it was sent from even
 * if the user switched tabs while it was in flight.
 */
export function useSendMessage() {
  const deps = useDeps();
  const qc = useQueryClient();
  return useMutation<
    TaskSummary,
    CoreRequestError,
    { conversationId: string; content: string }
  >({
    // Decoded by the client: a status this build does not recognise is still
    // an ACCEPTED send (Core applied it), never reported as a failure.
    mutationFn: ({ conversationId, content }) =>
      deps.client.sendConversationMessage({
        conversationId,
        content,
        attachments: [],
      }),
    onSettled: (_data, _error, variables) => {
      // Settled, not just success: a lost answer may still have been stored.
      void qc.invalidateQueries({ queryKey: queryKeys.history(variables.conversationId) });
      void qc.invalidateQueries({ queryKey: ["core", "task-list"] });
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
    queryFn: () => deps.client.reviewChangeSet(taskId ?? ""),
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
