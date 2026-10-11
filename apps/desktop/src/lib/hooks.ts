/**
 * React data layer.
 *
 * Server/cache state (Core reads and writes) goes through React Query. The
 * task-event stream goes through `TaskEventStore` + `useSyncExternalStore`
 * because it is a replayed stream, not a request/response cache. No Core data is
 * duplicated into a client-side "database": the checkpoint is the only thing the
 * UI remembers, and it only ever asks Core for events after it.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
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
  ProjectDeletionFlow,
  forgetProjectLocally,
  projectCacheIds,
  projectLifecycleGates,
  type DeletionState,
  type ProjectLifecycleGates,
} from "./project-lifecycle";
import { uiPreferences } from "../stores/ui";
import {
  KeyedWrite,
  keyRecheckFromProbe,
  type KeyedWriteState,
  type KeyRecheck,
} from "./idempotency";
import { sendKeyRecheckFromProbe, sendParamsFor, type SendVariables } from "./send-mode";
import {
  SandboxRemovalFlow,
  SandboxStopConfirm,
  countActiveTasksOn,
  lifecycleGates,
  type StopConfirmState,
  type LifecycleGates,
  type RemovalState,
} from "./sandbox-lifecycle";
import {
  addConversation,
  forgetConversation,
  forgetProjectConversations,
  listConversations,
  replaceConversation,
  subscribeConversations,
} from "./conversation-store";
import {
  ConversationDeletionFlow,
  ConversationExportController,
  conversationCacheTaskIds,
  conversationLifecycleGates,
  conversationListParams,
  forgetConversationLocally,
  conversationRecheck,
  type ConversationDeletionState,
  type ConversationExportState,
  type ConversationLifecycleGates,
} from "./conversation-lifecycle";
import {
  decodeApplyResult,
  decodeConversation,
  decodeProject,
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
  coreAdvertisesFeature,
  coreAdvertisesMethod,
  type KnownFeature,
  type ApplyResult,
  type ChangeSet,
  type Conversation,
  type ConversationHistoryResult,
  type CoreCapabilities,
  type GitApplyParams,
  type Method,
  type Project,
  type SandboxCreateSpec,
  type SandboxStopResult,
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

export function useProjects(options: { includeArchived?: boolean } = {}): {
  projects: Project[];
  isLoading: boolean;
  error: CoreRequestError | null;
} {
  const deps = useDeps();
  const includeArchived = options.includeArchived === true;
  const query = useQuery<Project[]>({
    // The live-only key is unchanged; the archived read is a child key, so
    // invalidating `queryKeys.projects` re-reads both.
    queryKey: includeArchived ? [...queryKeys.projects, "with-archived"] : queryKeys.projects,
    queryFn: () => deps.client.listProjectRows(includeArchived),
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

export function useSandboxes(wanted = true): {
  sandboxes: SandboxSummary[];
  isLoading: boolean;
  /** True once Core actually answered `sandbox.list` (not pending, not failed). */
  loaded: boolean;
  error: CoreRequestError | null;
} {
  const deps = useDeps();
  const query = useQuery<SandboxSummary[]>({
    queryKey: queryKeys.sandboxes,
    queryFn: () => deps.client.listSandboxSummaries(),
    enabled: wanted && deps.transportAvailable,
    staleTime: 5_000,
  });
  return {
    sandboxes: query.data ?? [],
    isLoading: query.isPending && wanted && deps.transportAvailable,
    loaded: query.isSuccess,
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
 *
 * `includeArchived` (A3b) adds archived rows, and is put on the wire ONLY when
 * this Core advertises `conversation.archive`; the archived read is a child
 * key, so invalidating `["core","conversations"]` re-reads both.
 */
export function useCoreConversations(
  projectId: string | null,
  wanted = true,
  includeArchived = false,
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
  const lifecycle = useConversationLifecycleGates();
  const params = conversationListParams(projectId, includeArchived, lifecycle);
  const withArchived = params.includeArchived === true;
  const query = useQuery<Conversation[]>({
    queryKey: withArchived
      ? [...queryKeys.conversations(projectId), "with-archived"]
      : queryKeys.conversations(projectId),
    queryFn: () => deps.client.listConversations(params),
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

/**
 * `sandbox.create` as a keyed write (A2): one controller per wizard. The spec
 * carries an `idempotencyKey` only when the caller minted one for this action.
 * Never retried automatically; "Retry safely" re-probes Core first. The list
 * and probe are re-read after every exchange that may have reached Core.
 */
export function useKeyedCreateSandbox(): KeyedWriteHandle<SandboxCreateSpec, SandboxSummary> {
  const deps = useDeps();
  const qc = useQueryClient();
  return useKeyedWrite<SandboxCreateSpec, SandboxSummary>(
    (spec) => deps.client.createSandboxSummary(spec),
    () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sandboxes });
      void qc.invalidateQueries({ queryKey: queryKeys.probe });
    },
  );
}

export interface KeyedWriteHandle<P extends { idempotencyKey?: string }, R> {
  write: KeyedWrite<P, R>;
  state: KeyedWriteState<P, R>;
}

/**
 * One `KeyedWrite` controller for the lifetime of the component. `run` and
 * `settled` are read through refs so the controller is created once.
 */
function useKeyedWrite<P extends { idempotencyKey?: string }, R>(
  run: (params: P) => Promise<R>,
  settled: (params: P) => void,
  /** Pre-retry check; default: `idempotency-keys` still advertised. */
  recheck?: (params: P) => Promise<KeyRecheck>,
): KeyedWriteHandle<P, R> {
  const deps = useDeps();
  const runRef = useRef(run);
  const settledRef = useRef(settled);
  useEffect(() => {
    runRef.current = run;
    settledRef.current = settled;
  });
  const ref = useRef<KeyedWrite<P, R> | null>(null);
  if (ref.current === null) {
    ref.current = new KeyedWrite<P, R>((params) => runRef.current(params), {
      // W1: the CURRENT Core must still advertise keys right before a retry.
      recheckKeys: recheck ?? (async () => keyRecheckFromProbe(await deps.client.probe())),
      onSettled: (params) => settledRef.current(params),
    });
  }
  const write = ref.current;
  const state = useSyncExternalStore(write.subscribe, write.getState);
  return { write, state };
}

/** Does the attached Core advertise `feature`? `null` while unprobed. */
export function useCoreFeature(feature: KnownFeature): boolean | null {
  const link = useCoreLink();
  const capabilities = capabilitiesOf(link);
  if (capabilities === null) return null;
  return coreAdvertisesFeature(capabilities, feature);
}

/**
 * `sandbox.stop` (A1). Never retried (not replay-safe); the list is re-read on
 * SETTLED, not just success, because a lost answer may still have stopped it.
 */
export function useStopSandbox(
  report: {
    onSuccess?: (result: SandboxStopResult, name: string) => void;
    onError?: (error: CoreRequestError, name: string) => void;
    onSettled?: (name: string) => void;
  } = {},
) {
  const deps = useDeps();
  const qc = useQueryClient();
  // Hook-level callbacks (not `mutate(…, callbacks)`): they still fire when the
  // row that started the stop has unmounted because the re-read dropped it.
  return useMutation<SandboxStopResult, CoreRequestError, string>({
    mutationFn: (name) => deps.client.stopSandbox(name),
    retry: false,
    onSuccess: (result, name) => report.onSuccess?.(result, name),
    onError: (error, name) => report.onError?.(asCoreRequestError(error), name),
    onSettled: (_data, _error, name) => {
      report.onSettled?.(name);
      void qc.invalidateQueries({ queryKey: queryKeys.sandboxes });
    },
  });
}

/**
 * The stop confirmation controller for one view. The active-task count reads
 * `task.list` (all projects) only when THIS Core advertises it; the latest probe
 * is read at open time through a ref.
 */
export function useStopConfirm(): { confirm: SandboxStopConfirm; state: StopConfirmState } {
  const deps = useDeps();
  const link = useCoreLink();
  const capabilities = capabilitiesOf(link);
  const capsRef = useRef(capabilities);
  useEffect(() => {
    capsRef.current = capabilities;
  }, [capabilities]);
  const ref = useRef<SandboxStopConfirm | null>(null);
  if (ref.current === null) {
    ref.current = new SandboxStopConfirm((name) =>
      countActiveTasksOn(
        deps.client,
        capsRef.current !== null && coreAdvertisesMethod(capsRef.current, "task.list"),
        name,
      ),
    );
  }
  const confirm = ref.current;
  const state = useSyncExternalStore(confirm.subscribe, confirm.getState);
  return { confirm, state };
}

/**
 * One two-step `sandbox.remove` flow per mounted row/view. The controller holds
 * the confirmation token in memory only; it never reaches React Query, Zustand,
 * a route or a log. The sandbox list is re-read after every Core exchange.
 */
export function useSandboxRemovalFlow(): { flow: SandboxRemovalFlow; state: RemovalState } {
  const deps = useDeps();
  const qc = useQueryClient();
  const ref = useRef<SandboxRemovalFlow | null>(null);
  if (ref.current === null) {
    ref.current = new SandboxRemovalFlow(deps.client, {
      onSettled: () => {
        void qc.invalidateQueries({ queryKey: queryKeys.sandboxes });
      },
    });
  }
  const flow = ref.current;
  const state = useSyncExternalStore(flow.subscribe, flow.getState);
  return { flow, state };
}

/** Stop/Remove gates folded from the probe (`unprobed` ≠ `unsupported`). */
export function useLifecycleGates(): LifecycleGates {
  const link = useCoreLink();
  return lifecycleGates(capabilitiesOf(link));
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

/** Variables of one chat send (the key travels only when minted for this action). */
export type { SendVariables };

/**
 * `conversation.send` as a keyed write (A2). The conversation id travels WITH
 * the variables, so the caller can attribute an outcome to the chat it was sent
 * from even if the user switched tabs. Decoded by the client: a status this
 * build does not recognise is still an ACCEPTED send. History and `task.list`
 * are re-read after every exchange that may have reached Core.
 */
export function useKeyedSend(): KeyedWriteHandle<SendVariables, TaskSummary> {
  const deps = useDeps();
  const qc = useQueryClient();
  return useKeyedWrite<SendVariables, TaskSummary>(
    // A4: the variables already hold `mode` only when it may be sent; a
    // "Retry safely" passes the SAME variables, so the same key and mode.
    (variables) => deps.client.sendConversationMessage(sendParamsFor(variables)),
    (variables) => {
      void qc.invalidateQueries({ queryKey: queryKeys.history(variables.conversationId) });
      void qc.invalidateQueries({ queryKey: ["core", "task-list"] });
    },
    // A Discuss retry also needs conversation-send-mode advertised NOW.
    async (variables) => sendKeyRecheckFromProbe(await deps.client.probe(), variables),
  );
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

// ---------------------------------------------------------------------------
// A3a project lifecycle
// ---------------------------------------------------------------------------

/** Every A3a action's gate, folded from the probe (`unprobed` ≠ `unsupported`). */
export function useProjectLifecycleGates(): ProjectLifecycleGates {
  const link = useCoreLink();
  return projectLifecycleGates(capabilitiesOf(link));
}

/** One A3a project write (each is one RPC answering a `Project`). */
export type ProjectAction =
  | { kind: "update"; projectId: string; changes: { name?: string; description?: string } }
  | { kind: "archive"; projectId: string }
  | { kind: "unarchive"; projectId: string }
  | { kind: "add_repository"; projectId: string; path: string }
  | { kind: "remove_repository"; projectId: string; path: string };

/**
 * Project writes. Never retried (none is replay-safe). The project list is
 * re-read on SETTLED — success or failure — because a lost answer may still
 * have been applied; the UI never patches the list locally.
 */
export function useProjectAction() {
  const deps = useDeps();
  const qc = useQueryClient();
  return useMutation<Project, CoreRequestError, ProjectAction>({
    mutationFn: (action) => {
      switch (action.kind) {
        case "update":
          return deps.client.updateProject(action.projectId, action.changes);
        case "archive":
          return deps.client.archiveProject(action.projectId);
        case "unarchive":
          return deps.client.unarchiveProject(action.projectId);
        case "add_repository":
          return deps.client.addProjectRepository(action.projectId, action.path);
        case "remove_repository":
          return deps.client.removeProjectRepository(action.projectId, action.path);
      }
    },
    retry: false,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

/**
 * The two-step `project.delete` flow. Re-reads the project list after every
 * exchange; on `deleted: true` only, forgets the project locally (remembered
 * selection, this window's chats of it, its cached reads).
 */
export function useProjectDeletionFlow(): { flow: ProjectDeletionFlow; state: DeletionState } {
  const deps = useDeps();
  const qc = useQueryClient();
  const ref = useRef<ProjectDeletionFlow | null>(null);
  if (ref.current === null) {
    const forget = (projectId: string) =>
      forgetProjectLocally(projectId, {
        lastProjectId: () => uiPreferences.get().lastProjectId,
        clearLastProjectId: () => uiPreferences.set({ lastProjectId: null }),
        forgetConversations: forgetProjectConversations,
        dropCachedReads: (id) => {
          const { conversationIds, taskIds } = projectCacheIds(id, {
            conversations: qc.getQueryData(queryKeys.conversations(id)),
            sessionConversations: listConversations(),
            projectTasks: qc.getQueryData(queryKeys.coreTasks(id)),
            allTasks: qc.getQueryData(queryKeys.coreTasks(null)),
          });
          for (const conversationId of conversationIds) {
            qc.removeQueries({ queryKey: queryKeys.history(conversationId) });
          }
          deps.store.forgetTasks(taskIds);
          qc.removeQueries({ queryKey: queryKeys.conversations(id) });
          qc.removeQueries({ queryKey: queryKeys.coreTasks(id) });
          // The global task list still names the deleted tasks: re-read it.
          void qc.invalidateQueries({ queryKey: queryKeys.coreTasks(null) });
        },
      });
    ref.current = new ProjectDeletionFlow(deps.client, {
      onSettled: () => {
        void qc.invalidateQueries({ queryKey: queryKeys.projects });
      },
      onDeleted: forget,
      onGone: forget,
      // `project.delete` exists only on an A3a Core, which accepts includeArchived.
      recheckListed: async (projectId) =>
        (await deps.client.listProjectRows(true)).some((p) => p.id === projectId),
    });
  }
  const flow = ref.current;
  const state = useSyncExternalStore(flow.subscribe, flow.getState);
  return { flow, state };
}

// ---------------------------------------------------------------------------
// A3b conversation lifecycle
// ---------------------------------------------------------------------------

/** Every A3b action's gate, folded from the probe (`unprobed` ≠ `unsupported`). */
export function useConversationLifecycleGates(): ConversationLifecycleGates {
  const link = useCoreLink();
  return conversationLifecycleGates(capabilitiesOf(link));
}

/** One A3b conversation write (each is one RPC answering a `Conversation`). */
export type ConversationActionInput =
  | { kind: "rename"; conversationId: string; title: string }
  | { kind: "archive"; conversationId: string }
  | { kind: "unarchive"; conversationId: string };

/**
 * Conversation writes. Never retried (none is replay-safe). Core's answer
 * replaces this window's own copy (so a merged list never re-adds a stale
 * one), and every conversation list is re-read on SETTLED — success or
 * failure — because a lost answer may still have been applied.
 */
export function useConversationAction() {
  const deps = useDeps();
  const qc = useQueryClient();
  return useMutation<Conversation, CoreRequestError, ConversationActionInput>({
    mutationFn: (action) => {
      switch (action.kind) {
        case "rename":
          return deps.client.renameConversation(action.conversationId, action.title);
        case "archive":
          return deps.client.archiveConversation(action.conversationId);
        case "unarchive":
          return deps.client.unarchiveConversation(action.conversationId);
      }
    },
    retry: false,
    onSuccess: (conversation) => replaceConversation(conversation),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["core", "conversations"] });
    },
  });
}

/**
 * The two-step `conversation.delete` flow for one view. Re-reads every
 * conversation list after each exchange. When Core no longer has the
 * conversation (`deleted: true`, a step-2 NOT_FOUND, or an unknown outcome a
 * scoped re-read settled) it is forgotten locally: the route leaves it if it
 * is open, its history pages and task projections are dropped, and this
 * window's copy is removed. The token lives only inside the flow.
 */
export function useConversationDeletionFlow(selection: {
  selectedConversationId: string | null;
  onClearSelection: () => void;
}): { flow: ConversationDeletionFlow; state: ConversationDeletionState } {
  const deps = useDeps();
  const qc = useQueryClient();
  const link = useCoreLink();
  const selectionRef = useRef(selection);
  // The probed capabilities, read when an unknown outcome is re-checked.
  const capabilitiesRef = useRef(capabilitiesOf(link));
  useEffect(() => {
    selectionRef.current = selection;
    capabilitiesRef.current = capabilitiesOf(link);
  });
  const ref = useRef<ConversationDeletionFlow | null>(null);
  if (ref.current === null) {
    const forget = (conversationId: string) =>
      forgetConversationLocally(conversationId, {
        selectedConversationId: () => selectionRef.current.selectedConversationId,
        clearSelection: () => selectionRef.current.onClearSelection(),
        forgetSessionConversation: forgetConversation,
        dropCachedReads: (id) => {
          const taskIds = conversationCacheTaskIds(
            id,
            qc.getQueriesData({ queryKey: ["core", "task-list"] }).map(([, data]) => data),
            deps.store.getSnapshot(),
          );
          deps.store.forgetTasks(taskIds);
          qc.removeQueries({ queryKey: queryKeys.history(id) });
          // The task lists still name the deleted tasks: re-read them.
          void qc.invalidateQueries({ queryKey: ["core", "task-list"] });
        },
      });
    ref.current = new ConversationDeletionFlow(deps.client, {
      onSettled: () => {
        void qc.invalidateQueries({ queryKey: ["core", "conversations"] });
      },
      onDeleted: forget,
      onGone: forget,
      // `includeArchived` only when `conversation.archive` is advertised;
      // otherwise the outcome stays unknown (a live-only list proves nothing).
      recheckListed: conversationRecheck(deps.client, () => capabilitiesRef.current),
    });
  }
  const flow = ref.current;
  const state = useSyncExternalStore(flow.subscribe, flow.getState);
  return { flow, state };
}

/**
 * One export controller per view. The full export text stays inside the
 * controller (never React Query, a store or a log); Copy uses the webview's
 * `navigator.clipboard`.
 */
export function useConversationExport(): {
  controller: ConversationExportController;
  state: ConversationExportState;
} {
  const deps = useDeps();
  const ref = useRef<ConversationExportController | null>(null);
  if (ref.current === null) ref.current = new ConversationExportController(deps.client);
  const controller = ref.current;
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  return { controller, state };
}
