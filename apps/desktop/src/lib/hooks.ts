/**
 * React data layer.
 *
 * Server/cache state (Core reads and writes) goes through React Query. The
 * task-event stream goes through `TaskEventStore` + `useSyncExternalStore`
 * because it is a replayed stream, not a request/response cache. No Core data is
 * duplicated into a client-side "database": the checkpoint is the only thing the
 * UI remembers, and it only ever asks Core for events after it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import {
  foldCoreLink,
  foldTaskIndex,
  foldTranscript,
  featureGate,
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
  refresh: () => Promise<unknown>;
} {
  const projections = useTaskProjections();
  const { tasks, gate, error } = useCoreTasks(projectId);
  const deps = useDeps();
  const rows = useMemo(() => {
    const map = new Map(projections.map((p) => [p.taskId, p]));
    // Only hand Core's rows to the fold when the method was actually advertised
    // and answered; otherwise the index stays the event-derived one.
    const coreRows = gate.state === "supported" ? tasks : [];
    return foldTaskIndex(map, coreRows);
  }, [projections, tasks, gate.state]);
  return {
    rows,
    gate,
    error,
    refresh: () =>
      deps.queryClient.invalidateQueries({ queryKey: queryKeys.coreTasks(projectId) }),
  };
}

export function useStoreStatus() {
  const deps = useDeps();
  useSyncExternalStore(deps.store.subscribe, deps.store.getSnapshot);
  return deps.store.getStatus();
}

/** Conversations created in this window (in-memory; survives no reload by design). */
export function useSessionConversations(): readonly Conversation[] {
  return useSyncExternalStore(subscribeConversations, listConversations);
}

/**
 * `conversation.list` — every non-archived conversation Core holds for a
 * project, which is what lets the cockpit show chats this window never created.
 */
export function useCoreConversations(projectId: string | null): {
  conversations: Conversation[];
  gate: FeatureGate;
  isLoading: boolean;
  error: CoreRequestError | null;
  refetch: () => void;
} {
  const deps = useDeps();
  const gate = useCoreFeatureGate("conversation.list", "conversation.list");
  const query = useQuery<Conversation[]>({
    queryKey: queryKeys.conversations(projectId),
    queryFn: () =>
      deps.client.listConversations({ ...(projectId === null ? {} : { projectId }) }),
    enabled: deps.transportAvailable && gate.state === "supported",
    staleTime: 5_000,
  });
  return {
    conversations: query.data ?? [],
    gate,
    isLoading: query.isPending && gate.state === "supported" && deps.transportAvailable,
    error: query.error ? asCoreRequestError(query.error) : null,
    refetch: () => void query.refetch(),
  };
}

/**
 * Paged `conversation.history` for one conversation.
 *
 * Pages accumulate one bounded read at a time (each asks Core for
 * `nextSequence` onward) and every page keeps Core's own `truncated`
 * disclosure, so the transcript can always say "this is what N bounded pages
 * returned", never "this is the whole conversation".
 */
export function useConversationHistory(conversationId: string | null): {
  transcript: TranscriptView;
  gate: FeatureGate;
  isLoading: boolean;
  error: CoreRequestError | null;
  loadMore: () => void;
} {
  const deps = useDeps();
  const gate = useCoreFeatureGate("conversation.history", "conversation.history");
  const enabled = deps.transportAvailable && conversationId !== null && gate.state === "supported";
  const [pages, setPages] = useState<ConversationHistoryResult[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CoreRequestError | null>(null);
  const client = deps.client;

  const load = useCallback(
    async (after: number) => {
      if (conversationId === null) return;
      setPending(true);
      setError(null);
      try {
        const page = await client.getConversationHistory({
          conversationId,
          afterSequence: after,
        });
        setPages((current) => [...current, page]);
      } catch (err) {
        setError(asCoreRequestError(err));
      } finally {
        setPending(false);
      }
    },
    [client, conversationId],
  );

  // First page when a conversation is opened; a clean slate when it changes, so
  // one chat's transcript is never shown under another chat's header.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || conversationId === null) return;
    if (loadedFor.current === conversationId) return;
    loadedFor.current = conversationId;
    setPages([]);
    void load(0);
  }, [conversationId, enabled, load]);

  const transcript = useMemo(() => foldTranscript(pages), [pages]);
  return {
    transcript,
    gate,
    isLoading: pending || (enabled && pages.length === 0 && error === null),
    error,
    loadMore: () => void load(transcript.cursor),
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
