/**
 * The single extension-side controller: owns the Core connection, the typed
 * command surface, the durable-event subscription and the display state, then
 * fans a snapshot out to the sidebar webview, the task tree and the status bar.
 *
 * Boundaries enforced here:
 *  - the webview never reaches Core; it posts whitelisted messages, this class
 *    decides what may be sent, always through `CoreCommands` (no shell, no
 *    arbitrary RPC);
 *  - Core is authoritative for project/sandbox/task state; this process caches
 *    nothing durable and persists UI preferences only;
 *  - anything this build cannot do is surfaced as a notice or a refusal.
 */

import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import {
  CoreCommands,
  verifiedAgents,
  CoreValidationError,
  errorCodeOf,
  validateAddressableSandboxName,
} from './core-client/commands';
import {
  CoreConnection,
  CoreRpcError,
  CoreTransportError,
  type CoreTransport,
} from './core-client/connection';
import { ProjectEventFeed } from './core-client/catchup';
import { coreSocketPath } from './core-client/paths';
import { createSocketTransport } from './core-client/transport';
import type {
  AgentCapability,
  ChangeSet,
  ConfirmationRequest,
  Conversation,
  ConversationSendParams,
  CoreCapabilities,
  CoreFeature,
  CoreMethodName,
  Project,
  SandboxCreateSpec,
  SandboxStopResult,
  SandboxSummary,
  SbxAgent,
} from './core-client/protocol';
import { coreAdvertisesFeature, coreAdvertisesMethod, MAX_LIST_LIMIT } from './core-client/protocol';
import {
  REPLAY_NOTICE,
  RETRY_SAFELY,
  classifyKeyedConflict,
  isProvablyUnsent,
  isUnknownOutcome,
  keyedConflictCopy,
  newIdempotencyKey,
} from './core-client/idempotency';
import { TASK_STATUSES, isTerminalStatus } from './core-client/events';
import { EMPTY_STATE, reduceTaskView, selectTasks, type TaskViewState } from './state/reducer';
import {
  authorizeSend,
  conversationInScope,
  matchWorkspaceFolder,
  selectedWorkspaceMode,
  sendGate,
  shouldPollEvents,
  transcriptView,
} from './state/sessionPolicy';
import { evaluateHostContext, type HostVerdict } from './vscode/host';
import { explainFailure, remediationFrom, toFailure, type GuidanceAction } from './vscode/diagnostics';
import { workspaceModeView } from './vscode/workspaces';
import {
  REMOVE_BUTTON,
  STOP_BUTTON,
  notAdvertisedMessage,
  removeConfirmationView,
  stopConfirmation,
  stopOutcomeView,
} from './vscode/sandboxActions';
import { plainText } from './text/visibleText';
import {
  DEFAULT_CONTEXT_POLICY,
  planContextAttachments,
  type ContextPlan,
} from './vscode/context';
import { collectEditorSnapshot } from './vscode/editor';
import { buildChangeSetPlans, capReviewPlans, materializeUri, type UriFactory } from './vscode/diff';
import {
  emptySidebarState,
  type ConnectionTone,
  type ContextPlanView,
  type SidebarState,
  type WebviewToExtension,
} from './webview/bridge';

const UI_KEYS = {
  selectedProject: 'sandpane.ui.selectedProject',
  selectedSandbox: 'sandpane.ui.selectedSandbox',
  conversation: 'sandpane.ui.conversation',
} as const;

/** `task.subscribe` re-pull interval while a task is non-terminal (Core never pushes). */
export const EVENT_POLL_INTERVAL_MS = 2_000;

/** Fallback (task-by-task) mode follows at most this many tasks. */
const MAX_FOLLOWED_TASKS = 64;

/** UI preference for the selected conversation, incl. the sandbox it was made in. */
interface ConversationPreference {
  id: string;
  projectId: string;
  title: string;
  agentId: string;
  /** Absent in preferences written before review bug 8 — read as null. */
  sandboxName?: string | null;
}

export type SessionListener = (state: SidebarState) => void;

/** Injection seams for tests; production uses the real socket and timers. */
export interface SessionDeps {
  transportFactory?: (socketPath: string) => CoreTransport;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  requestTimeoutMs?: number;
  /** Wall clock for confirmation expiry display (tests pin it). */
  now?: () => number;
}

const VSCODE_URI: UriFactory<vscode.Uri> = { file: (fsPath: string) => vscode.Uri.file(fsPath) };

export class SandpaneSession {
  readonly connection: CoreConnection;
  readonly commands: CoreCommands;

  private view: TaskViewState = EMPTY_STATE;
  private feed: ProjectEventFeed | null = null;
  private feedStarted = false;
  private capabilities: CoreCapabilities | null = null;
  private projects: Project[] = [];
  private sandboxes: SandboxSummary[] = [];
  private conversation: Conversation | null = null;
  /** Sandbox selected when `conversation` was created (Core's record has no sandbox field). */
  private conversationSandbox: string | null = null;
  /**
   * `conversation.list` hydration — Core's own enumeration, cached only for this
   * session's display. Not a database: it is re-read on every refresh, and an
   * archived conversation is absent because Core filters it (specs/02 §1).
   */
  private conversations: Conversation[] = [];
  private selectedProjectId: string | null = null;
  private selectedSandbox: string | null = null;
  private contextPlan: ContextPlan | null = null;
  /** Id of `contextPlan`; a send must quote it back (review bug 6). */
  private contextPlanId = 0;
  private acceptedSends = 0;
  /** True while a send is in flight; a second send is refused (review W3). */
  private sending = false;
  private status: { tone: 'ok' | 'error' | 'info'; text: string } | null = null;
  private readonly listeners = new Set<SessionListener>();
  private loading: Promise<void> | null = null;
  private lastSocketPath: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: SessionDeps = {},
  ) {
    this.lastSocketPath = this.resolveSocketPath();
    this.selectedProjectId = context.workspaceState.get<string>(UI_KEYS.selectedProject) ?? null;
    this.selectedSandbox = context.workspaceState.get<string>(UI_KEYS.selectedSandbox) ?? null;
    const storedConversation = context.workspaceState.get<ConversationPreference>(UI_KEYS.conversation);
    if (storedConversation) {
      // A restored selection is a UI preference; it is re-pointed at Core's
      // record (or dropped) by the next conversation.list hydration.
      const { sandboxName, ...conversation } = storedConversation;
      this.conversation = { ...conversation, createdAt: '' };
      this.conversationSandbox = sandboxName ?? null;
    }

    this.connection = new CoreConnection({
      // The socket path is resolved per attempt, so the path shown to the user
      // (`socketPath`) is always the one actually dialled (review 12g).
      transportFactory: () => {
        this.lastSocketPath = this.resolveSocketPath();
        return this.deps.transportFactory
          ? this.deps.transportFactory(this.lastSocketPath)
          : createSocketTransport({ path: this.lastSocketPath, connectTimeoutMs: 3_000 });
      },
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
      ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
      ...(deps.requestTimeoutMs ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
      onStateChange: () => this.emit(),
      onDecodeError: (error) => this.log(`frame decode ${error.reason}: ${error.message}`),
      onNotification: (frame) =>
        // Forward-compat only: this Core build never pushes frames.
        this.log(`unexpected pushed frame "${frame.method}" — ignored (no such Core capability)`),
      // EVERY successful (re)connect — including a background reconnect after a
      // failed first attach — loads Core state. Previously a late reconnect left
      // the sidebar "online" with no data (review bug 9).
      onReconnect: () => this.load(),
    });
    this.commands = new CoreCommands(this.connection);
  }

  /** The Core socket path of the latest connection attempt (what is actually dialled). */
  get socketPath(): string {
    return this.lastSocketPath;
  }

  private resolveSocketPath(): string {
    const config = vscode.workspace.getConfiguration('sandpane');
    return coreSocketPath(
      { env: process.env, platform: process.platform, homedir: process.env['HOME'] ?? '' },
      config.get<string>('coreSocketPath', ''),
    );
  }

  get host(): HostVerdict {
    return evaluateHostContext({ remoteName: vscode.env.remoteName });
  }

  get taskRowsCount(): number {
    return this.view.order.length;
  }

  subscribe(listener: SessionListener): vscode.Disposable {
    this.listeners.add(listener);
    listener(this.snapshot());
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Connect to Core. Loading happens in the connection's `onReconnect` hook, so
   * the first attach, a manual refresh and a background reconnect all take the
   * same single path. Never auto-starts a service (ADR 1 undecided).
   */
  async attach(): Promise<void> {
    if (!this.host.supported) {
      this.setStatus('error', this.host.label);
      void vscode.window.showWarningMessage(this.host.explanation);
      this.emit();
      return;
    }
    try {
      await this.connection.connect();
    } catch (error) {
      this.reportError(error, 'attach');
    }
  }

  /**
   * UI detach only. Tasks keep running in Core (specs/03 §2.6) — we stop
   * pulling events and close our socket, nothing more.
   */
  detach(): void {
    this.stopFeed();
    this.connection.dispose();
  }

  /** Registered in ExtensionContext.subscriptions; releases UI hooks only. */
  dispose(): void {
    this.detach();
    this.listeners.clear();
  }

  /**
   * Fresh project list straight from Core (`project.list`), for command pickers
   * that need ids. Falls back to the cache only when Core is unreachable, and
   * says so in the returned label.
   */
  async listProjectOptions(): Promise<{ label: string; description?: string; id: string }[]> {
    let projects = this.projects;
    try {
      projects = await this.commands.projectList();
      this.projects = projects;
    } catch (error) {
      this.log(`project.list failed while picking: ${describe(error)} — using the last snapshot`);
    }
    return projects.map((project) => ({
      label: project.name,
      description: `id ${project.id.slice(0, 8)}`,
      id: project.id,
    }));
  }

  // -----------------------------------------------------------------------
  // Core operations (each is a typed RPC)
  // -----------------------------------------------------------------------

  /** Reload from Core; (re)connects first when not online (the hook then loads). */
  async refresh(): Promise<void> {
    if (!this.host.supported) {
      void vscode.window.showWarningMessage(this.host.explanation);
      return;
    }
    if (this.connection.connectionState !== 'online') {
      await this.attach();
      return;
    }
    await this.load();
  }

  /** Single-flight load: concurrent triggers (ready + attach + timer) share one. */
  private load(): Promise<void> {
    if (this.loading) return this.loading;
    const run = this.loadOnce().finally(() => {
      if (this.loading === run) this.loading = null;
    });
    this.loading = run;
    return run;
  }

  private async loadOnce(): Promise<void> {
    try {
      this.capabilities = await this.commands.systemProbe();
    } catch (error) {
      this.reportError(error, 'system.probe');
      return;
    }
    const results = await Promise.allSettled([this.commands.projectList(), this.commands.sandboxList()]);
    const projects = results[0];
    if (projects.status === 'fulfilled') {
      this.projects = projects.value;
      if (!this.selectedProjectId && this.projects.length === 1) {
        this.setProject(this.projects[0]?.id ?? null);
      }
    } else {
      this.log(`project.list failed: ${describe(projects.reason)}`);
    }
    const sandboxes = results[1];
    if (sandboxes.status === 'fulfilled') {
      this.sandboxes = sandboxes.value;
      if (!this.selectedSandbox && this.sandboxes.length === 1) {
        this.selectSandbox(this.sandboxes[0]?.name ?? '', { reload: false });
      }
      this.setStatus('ok', `${this.sandboxes.length} sandbox(es) from Core`);
    } else {
      // NOT_INSTALLED / DAEMON_DOWN are real states, not an empty list.
      this.sandboxes = [];
      this.reportError(sandboxes.reason, 'sandbox.list');
    }
    await this.reloadScope();
  }

  /** Re-read the selected project's tasks/conversations and catch up its events. */
  private async reloadScope(): Promise<void> {
    await this.hydrateFromCore();
    await this.catchUpNow();
    this.emit();
  }

  /**
   * The ONE place the selected project changes (review bug 3): the old event
   * feed is stopped, the task display is reset (no other project's tasks stay
   * painted), a conversation from another scope is dropped (bug 8), and the
   * preference is persisted. Callers then `reloadScope()`.
   */
  private setProject(projectId: string | null): boolean {
    if (projectId === this.selectedProjectId) return false;
    this.selectedProjectId = projectId;
    void this.context.workspaceState.update(UI_KEYS.selectedProject, projectId ?? undefined);
    this.stopFeed();
    this.view = EMPTY_STATE;
    this.conversations = [];
    this.dropConversationOutOfScope();
    return true;
  }

  private dropConversationOutOfScope(): void {
    if (!this.conversation) return;
    const inScope = conversationInScope(
      { projectId: this.conversation.projectId, sandboxName: this.conversationSandbox },
      { projectId: this.selectedProjectId, sandbox: this.selectedSandbox },
    );
    if (inScope) return;
    this.log(
      `conversation ${this.conversation.id.slice(0, 8)} belongs to another project/sandbox — ` +
        'the next send starts a new conversation in the current scope',
    );
    this.conversation = null;
    this.conversationSandbox = null;
    void this.context.workspaceState.update(UI_KEYS.conversation, undefined);
  }

  private async hydrateFromCore(): Promise<void> {
    const caps = this.capabilities;
    const projectId = this.selectedProjectId;
    if (!caps || !projectId) return;

    if (coreAdvertisesMethod(caps, 'task.list')) {
      try {
        const tasks = await this.commands.taskList({ projectId });
        // The user may have switched project while this was in flight: a
        // late answer for the old project must never paint the new one (W1).
        if (this.selectedProjectId !== projectId) return;
        this.view = reduceTaskView(this.view, { kind: 'taskList', tasks });
      } catch (error) {
        if (this.selectedProjectId !== projectId) return;
        this.log(`task.list failed: ${describe(error)}`);
      }
    } else {
      this.log('task.list not advertised by this Core — task history stays unrecovered (no fake list)');
    }

    if (coreAdvertisesMethod(caps, 'conversation.list')) {
      let listed = false;
      let conversations: Conversation[] = [];
      try {
        conversations = await this.commands.conversationList({ projectId });
        listed = true;
      } catch (error) {
        this.log(`conversation.list failed: ${describe(error)}`);
      }
      if (this.selectedProjectId !== projectId) return; // stale answer (W1)
      this.conversations = conversations;
      // Re-point a restored UI preference at Core's live record when the id still
      // exists; otherwise drop it rather than rendering a conversation Core does
      // not have. The stored preference is cleared only on Core's verdict (a
      // successful list without it), not on a transient failure.
      if (this.conversation) {
        const live = this.conversations.find((c) => c.id === this.conversation?.id);
        this.conversation = live ?? null;
        if (!live && listed) {
          this.conversationSandbox = null;
          void this.context.workspaceState.update(UI_KEYS.conversation, undefined);
        }
      }
    } else {
      this.conversations = [];
      this.log(
        'conversation.list not advertised by this Core — chat history cannot be enumerated (no fake list)',
      );
    }
  }

  async createProject(name: string, repositories: string[]): Promise<Project | undefined> {
    try {
      const project = await this.commands.projectCreate({ name, repositories });
      this.projects = [...this.projects, project];
      this.setProject(project.id);
      this.setStatus('ok', `Project "${project.name}" created in Core`);
      await this.reloadScope();
      return project;
    } catch (error) {
      this.reportError(error, 'project.create');
      return undefined;
    }
  }

  async createSandbox(input: {
    name: string;
    projectId: string;
    workspaceMode: 'direct_mount' | 'sbx_clone' | 'host_worktree' | 'mountless';
    repoPath?: string;
    /** A1: absent = Core's provider-free `shell` (works with every Core). */
    agent?: SbxAgent;
  }): Promise<SandboxSummary | undefined> {
    // A Core without the `sandbox-create-agent` feature would silently IGNORE
    // an `agent` field and create a shell sandbox while the UI said otherwise.
    if (input.agent !== undefined && !this.coreHasFeature('sandbox-create-agent')) {
      const text =
        `Agent "${input.agent}" cannot be requested: the attached Core does not advertise the ` +
        '"sandbox-create-agent" feature. Nothing was sent; create without choosing an agent to get ' +
        'the default shell.';
      void vscode.window.showWarningMessage(text);
      this.setStatus('error', text);
      this.emit();
      return undefined;
    }
    // A2: one fresh key for THIS user action, only when Core honours keys.
    const key = this.coreHasFeature('idempotency-keys') ? newIdempotencyKey() : undefined;
    const spec: SandboxCreateSpec = {
      name: input.name,
      projectId: input.projectId,
      workspaceMode: input.workspaceMode,
      ...(input.repoPath ? { repoPath: input.repoPath } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(key !== undefined ? { idempotencyKey: key } : {}),
    };
    return this.runCreate(spec);
  }

  /**
   * One `sandbox.create` attempt with fixed params. "Retry safely" calls this
   * again with the IDENTICAL spec (same key); nothing calls it automatically.
   */
  private async runCreate(spec: SandboxCreateSpec, priorUnknown = false): Promise<SandboxSummary | undefined> {
    try {
      const summary = await this.commands.sandboxCreate(spec);
      if (summary.replayed === true) {
        // The stored FIRST response — not current state. Re-read instead of
        // painting it, and never call it a fresh creation.
        await this.refreshSandboxList();
        if (this.sandboxes.some((s) => s.name === spec.name)) this.selectSandbox(spec.name);
        this.setStatus('info', REPLAY_NOTICE);
        this.emit();
        return summary;
      }
      this.sandboxes = [...this.sandboxes.filter((s) => s.name !== summary.name), summary];
      // The header/gate read the mode from Core's returned summary; if Core
      // returned none, it shows UNVERIFIED rather than the requested mode.
      this.selectSandbox(summary.name);
      const view = workspaceModeView(spec.workspaceMode);
      const requestedAgent = spec.agent ?? 'shell';
      const reportedAgent = typeof summary.agent === 'string' && summary.agent.length > 0 ? summary.agent : null;
      const agentNote =
        reportedAgent === null
          ? ` · requested agent ${requestedAgent}; sbx did not report the sandbox's agent`
          : reportedAgent === requestedAgent
            ? ` · sbx reports agent ${plainText(reportedAgent, 64)}${requestedAgent === 'shell' ? '' : ' (not verified by Sandpane)'}`
            : ` · requested agent ${requestedAgent} but sbx reports ${plainText(reportedAgent, 64)}`;
      this.setStatus(
        'ok',
        `Sandbox "${plainText(summary.name, 128)}" created — requested ${view.label}${view.hostWritable ? ` (${view.badge})` : ''}${agentNote}`,
      );
      this.emit();
      return summary;
    } catch (error) {
      this.reportKeyedFailure(
        error,
        'sandbox.create',
        spec.idempotencyKey !== undefined,
        priorUnknown,
        () => this.runCreate(spec, true),
        () => this.refreshSandboxList(),
      );
      return undefined;
    }
  }

  /** Whether the attached Core advertised `feature` in its last probe (A2). */
  coreHasFeature(feature: CoreFeature): boolean {
    return coreAdvertisesFeature(this.capabilities, feature);
  }

  /**
   * Failure of a (possibly) keyed create/send (A2, design §3.1):
   *  - a keyed CONFLICT is mapped to plain copy next to Core's own message;
   *    for "outcome unknown" the state is re-read, and NOTHING claims that
   *    nothing ran;
   *  - an UNKNOWN outcome on a keyed request offers "Retry safely", which
   *    resends the identical params with the same key — only on that click;
   *  - an unknown outcome WITHOUT a key keeps the honest "check before trying
   *    again" copy and offers no retry.
   * Nothing here retries or mints a new key on its own.
   */
  private reportKeyedFailure(
    error: unknown,
    operation: string,
    keyed: boolean,
    priorUnknown: boolean,
    attempt: () => Promise<unknown>,
    reread: () => Promise<unknown>,
  ): void {
    const conflict = classifyKeyedConflict(error);
    if (conflict !== null) {
      this.reportError(error, operation, keyedConflictCopy(conflict));
      if (conflict === 'unknown') void reread();
      return;
    }
    // A "Retry safely" attempt that provably never left keeps the ORIGINAL
    // unknown outcome: a generic "not attached" would invite a fresh-key send.
    const unsentRetry = keyed && priorUnknown && isProvablyUnsent(error);
    if (!isUnknownOutcome(error) && !unsentRetry) {
      this.reportError(error, operation);
      return;
    }
    if (!keyed) {
      this.reportError(
        error,
        operation,
        'Outcome unknown — Core did not confirm whether this ran. Check before trying again ' +
          '(this Core does not advertise idempotency keys, so a retry could run it twice).',
      );
      return;
    }
    this.offerSafeRetry(operation, error, unsentRetry, attempt);
  }

  /**
   * The unknown-outcome notification with the "Retry safely" button. Only the
   * click resends, and only through `retryKeyed`'s click-time gate.
   */
  private offerSafeRetry(
    operation: string,
    error: unknown,
    retryUnsent: boolean,
    attempt: () => Promise<unknown>,
  ): void {
    const coreSaid = error instanceof Error ? plainText(error.message, 2_000) : '';
    const text =
      `${operation} — outcome UNKNOWN: Core did not confirm whether this request ran.\n\n` +
      (retryUnsent
        ? 'The retry could not reach Core, so nothing new was sent; the earlier attempt\'s outcome is still unknown.\n\n'
        : '') +
      `"${RETRY_SAFELY}" resends the identical request with the same idempotency key: Core runs it at ` +
      'most once; otherwise it returns the earlier result or refuses. Core keeps keys for 24 h; after ' +
      'that the same request would run again, so check state first if much time has passed.' +
      (coreSaid ? `\n\nDetail: ${coreSaid}` : '');
    this.log(`${operation} outcome unknown (keyed): ${coreSaid}`);
    this.setStatus('error', `${operation}: outcome unknown — use "${RETRY_SAFELY}" or refresh to check.`);
    this.emit();
    void vscode.window.showErrorMessage(text, RETRY_SAFELY).then((choice) => {
      if (choice === RETRY_SAFELY) void this.retryKeyed(operation, attempt);
    });
  }

  /**
   * Click-time gate for "Retry safely" (security review W1/W2; mirrors
   * JetBrains `KeyedRequests.retryGate`): attach if needed, re-probe THIS Core,
   * and resend only if it advertises `idempotency-keys` now — a background
   * reconnect may have reached another Core build whose features the cache
   * does not know yet. If Core cannot be reached, nothing was sent and the
   * original unknown outcome (with the same key) is offered again.
   */
  private async retryKeyed(operation: string, attempt: () => Promise<unknown>): Promise<void> {
    try {
      if (this.connection.connectionState !== 'online') await this.connection.connect();
      this.capabilities = await this.commands.systemProbe();
    } catch (error) {
      this.offerSafeRetry(operation, error, true, attempt);
      return;
    }
    if (!this.coreHasFeature('idempotency-keys')) {
      const text =
        'Not retried: the connected Core does not advertise idempotency keys, so a retry could run it ' +
        'twice. Nothing was sent — check state first.';
      void vscode.window.showErrorMessage(text);
      this.setStatus('error', text);
      this.emit();
      return;
    }
    await attempt();
  }

  /** Whether the attached Core advertised `method` in its last probe. */
  coreAdvertises(method: CoreMethodName): boolean {
    return coreAdvertisesMethod(this.capabilities, method);
  }

  /**
   * Fresh sandbox list straight from Core for command pickers (like
   * `listProjectOptions`). Falls back to the last snapshot only when Core is
   * unreachable, and logs that it did.
   */
  async listSandboxOptions(): Promise<SandboxSummary[]> {
    try {
      this.sandboxes = await this.commands.sandboxList();
    } catch (error) {
      this.log(`sandbox.list failed while picking: ${describe(error)} — using the last snapshot`);
    }
    return this.sandboxes;
  }

  /**
   * Gate for an additive method (design 2026-10-09 §1.3). The probe is re-read
   * so the verdict is about THIS Core instance — it may have been restarted
   * with another build. Not advertised → a visible refusal and NO frame for the
   * method; Core not attached → a different, equally visible message.
   */
  private async ensureAdvertised(method: CoreMethodName, action: string): Promise<boolean> {
    if (!this.host.supported) {
      void vscode.window.showWarningMessage(this.host.explanation);
      return false;
    }
    if (this.connection.connectionState !== 'online') {
      const text =
        `${action}: Sandpane Core is not attached, so whether it supports "${method}" is unknown. ` +
        'Nothing was sent. Start Core, then run "Sandpane: Refresh Sandboxes".';
      void vscode.window.showWarningMessage(text);
      this.setStatus('error', text);
      this.emit();
      return false;
    }
    try {
      this.capabilities = await this.commands.systemProbe();
    } catch (error) {
      this.reportError(error, 'system.probe');
      return false;
    }
    if (!coreAdvertisesMethod(this.capabilities, method)) {
      const text = notAdvertisedMessage(action, method);
      void vscode.window.showWarningMessage(text);
      this.setStatus('error', text);
      this.emit();
      return false;
    }
    return true;
  }

  /**
   * Re-list sandboxes after a lifecycle action, so the view shows what sbx
   * reports rather than what was requested. A selection Core no longer lists
   * is cleared. Returns false when the list could not be re-read.
   */
  private async refreshSandboxList(): Promise<boolean> {
    try {
      this.sandboxes = await this.commands.sandboxList();
    } catch (error) {
      this.log(`sandbox.list after a lifecycle action failed: ${describe(error)} — the list may be stale`);
      return false;
    }
    if (this.selectedSandbox && !this.sandboxes.some((s) => s.name === this.selectedSandbox)) {
      this.selectedSandbox = null;
      void this.context.workspaceState.update(UI_KEYS.selectedSandbox, undefined);
      this.dropConversationOutOfScope();
    }
    this.emit();
    return true;
  }

  /**
   * A failed lifecycle call. A structured Core error is Core's verdict; anything
   * else (timeout, closed socket) means the OUTCOME IS UNKNOWN — the sandbox may
   * or may not have changed. Never retried (neither method is replay-safe).
   */
  private reportLifecycleError(error: unknown, operation: string, context: string | null): void {
    const structured = error instanceof CoreRpcError || error instanceof CoreValidationError;
    const unknownOutcome = structured
      ? null
      : 'No answer from Core: the outcome is UNKNOWN (the sandbox may or may not have changed). ' +
        'It is not retried — refresh to see what sbx reports.';
    this.reportError(error, operation, [context, unknownOutcome].filter((p): p is string => p !== null).join(' '));
  }

  /**
   * `sandbox.stop` (A1). Gated on the probe; confirmed in a native modal because
   * processes inside the sandbox end. The state shown afterwards is Core's
   * re-query — when Core returns none, the state is UNKNOWN, never "stopped".
   */
  async stopSandbox(name: string): Promise<SandboxStopResult | undefined> {
    let validName: string;
    try {
      validName = validateAddressableSandboxName(name);
    } catch (error) {
      this.reportError(error, 'sandbox.stop');
      return undefined;
    }
    if (!(await this.ensureAdvertised('sandbox.stop', 'Stop sandbox'))) return undefined;
    const confirm = stopConfirmation(validName, await this.activeTasksIn(validName));
    const answer = await vscode.window.showWarningMessage(
      confirm.message,
      { modal: true, detail: confirm.detail },
      STOP_BUTTON,
    );
    if (answer !== STOP_BUTTON) {
      this.setStatus('info', 'Stop not confirmed; nothing was sent.');
      this.emit();
      return undefined;
    }
    let result: SandboxStopResult;
    try {
      result = await this.commands.sandboxStop(validName);
    } catch (error) {
      this.reportLifecycleError(error, 'sandbox.stop', null);
      await this.refreshSandboxList();
      return undefined;
    }
    const requeried = result.requeried;
    this.sandboxes = this.sandboxes.map((s) => {
      if (s.name !== validName) return s;
      // Apply Core's re-query; with none, drop the stale state rather than
      // keep showing "running" (the state is unknown, not "stopped").
      return requeried && typeof requeried === 'object' && requeried.name === validName
        ? requeried
        : { ...s, probedState: null };
    });
    const view = stopOutcomeView(validName, result);
    const listed = await this.refreshSandboxList();
    this.setStatus(
      view.stateKnown ? 'ok' : 'info',
      view.text + (listed ? '' : ' (the sandbox list could not be re-read; it may be stale)'),
    );
    this.emit();
    return result;
  }

  /**
   * `sandbox.remove` (A1), two-step server-side confirmation (design §2):
   *  1. ask Core — it changes nothing and returns a token + impact;
   *  2. show a NATIVE modal with the target name, sbx id, every impact line
   *     (capped), the external flag first, and the expiry;
   *  3. only the explicit "Remove sandbox" button sends step 2 with that token.
   * Cancel sends nothing; the token expires in Core. Neither step is retried.
   */
  async removeSandbox(name: string): Promise<boolean> {
    let validName: string;
    try {
      validName = validateAddressableSandboxName(name);
    } catch (error) {
      this.reportError(error, 'sandbox.remove');
      return false;
    }
    if (!(await this.ensureAdvertised('sandbox.remove', 'Remove sandbox'))) return false;
    let confirmation: ConfirmationRequest;
    try {
      confirmation = await this.commands.sandboxRemoveRequest(validName);
    } catch (error) {
      // Step 1 changes nothing in Core, so even a timeout leaves nothing to undo.
      this.reportError(error, 'sandbox.remove (confirmation request)', 'Nothing was removed.');
      return false;
    }
    const view = removeConfirmationView(confirmation, this.now());
    const answer = await vscode.window.showWarningMessage(
      view.message,
      { modal: true, detail: view.detail },
      REMOVE_BUTTON,
    );
    if (answer !== REMOVE_BUTTON) {
      this.setStatus(
        'info',
        `Remove not confirmed — nothing was sent; Core's confirmation for "${validName}" expires on its own.`,
      );
      this.emit();
      return false;
    }
    // Fail closed at CLICK time (security review W1): a token that expired
    // while the modal was open — or whose expiry cannot be read — is never
    // sent, so step 2 can only ever carry a confirmation still in force.
    const expiresAt = Date.parse(confirmation.expiresAt);
    if (!Number.isFinite(expiresAt) || this.now() >= expiresAt) {
      this.setStatus('info', 'Confirmation expired — nothing was sent; run Remove again.');
      this.emit();
      return false;
    }
    let removed: boolean;
    try {
      const result = await this.commands.sandboxRemoveConfirm(validName, confirmation.token);
      removed = result.removed === true;
    } catch (error) {
      const code = errorCodeOf(error);
      const context =
        code === 'VALIDATION_FAILED'
          ? 'Core refused the confirmation (wrong, expired or already used). Nothing was removed — run Remove again for a fresh confirmation.'
          : code === 'CONFLICT'
            ? 'Core reported a conflict: another operation on this sandbox is in progress, or a different ' +
              'sandbox now carries this name (same-named replacement) — see Core\'s message. Nothing was ' +
              'removed; run Remove again for a fresh confirmation.'
            : code === 'NOT_FOUND'
              ? 'The sandbox disappeared between the confirmation and the removal.'
              : null;
      this.reportLifecycleError(error, 'sandbox.remove', context);
      await this.refreshSandboxList();
      return false;
    }
    const listed = await this.refreshSandboxList();
    this.setStatus(
      removed ? 'ok' : 'error',
      (removed
        ? `Core removed sandbox "${validName}" (sbx rm ran after Core re-checked its identity).`
        : `Core did not report the removal of "${validName}" — its state is unknown; refresh to see what sbx lists.`) +
        (listed ? '' : ' (the sandbox list could not be re-read; it may be stale)'),
    );
    this.emit();
    return removed;
  }

  /**
   * Non-terminal Core tasks recorded on `sandbox`, across all projects — Core's
   * own `task.list`, never this window's cache. `null` = could not be checked.
   */
  private async activeTasksIn(sandbox: string): Promise<number | null> {
    if (!this.coreAdvertises('task.list')) return null;
    try {
      const tasks = await this.commands.taskList({
        statuses: TASK_STATUSES.filter((status) => !isTerminalStatus(status)),
        limit: MAX_LIST_LIMIT,
      });
      // Today's Core never records which sandbox a task uses
      // (`tasks.sandbox_binding_id` is never written, `sandboxName` is always
      // absent), so a zero count would be a false "no active task". Only when
      // Core starts filling `sandboxName` is the count meaningful.
      if (!tasks.some((task) => typeof task.sandboxName === 'string' && task.sandboxName.length > 0)) {
        return null;
      }
      // A full page may hide more rows: say "cannot be checked" rather than
      // claim a count Core did not establish.
      if (tasks.length >= MAX_LIST_LIMIT) return null;
      return tasks.filter((task) => task.sandboxName === sandbox).length;
    } catch (error) {
      this.log(`task.list before stop failed: ${describe(error)}`);
      return null;
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Composer send. The request must quote the CURRENT attachment plan id for
   * this exact intent (specs/03 §4, review bug 6) — this rejects stale and
   * wrong-intent plans; it is not proof against script inside the webview
   * (see `authorizeSend`). `origin` only controls whether the sidebar draft is
   * cleared after Core accepts.
   */
  async send(
    text: string,
    writable: boolean,
    planId: number | null,
    origin: 'sidebar' | 'command' = 'sidebar',
  ): Promise<void> {
    if (!this.host.supported) {
      void vscode.window.showWarningMessage(this.host.explanation);
      return;
    }
    if (text.trim().length === 0) {
      this.setStatus('info', 'Nothing to send: the message is empty.');
      this.emit();
      return;
    }
    // One send at a time: a double click, Ctrl+Enter repeat or a palette send
    // during a sidebar send must not create a second conversation or task.
    if (this.sending) {
      this.setStatus('info', 'A send is already in progress; wait for Core to answer.');
      this.emit();
      return;
    }
    this.sending = true;
    this.emit();
    const run = this.sendGuarded(text, writable, planId, origin).finally(() => {
      this.sending = false;
      if (this.sendInFlight === run) this.sendInFlight = null;
      this.emit();
    });
    this.sendInFlight = run;
    await run;
  }

  /** The send currently holding the one-send guard, if any. */
  private sendInFlight: Promise<void> | null = null;

  private async sendGuarded(
    text: string,
    writable: boolean,
    planId: number | null,
    origin: 'sidebar' | 'command',
  ): Promise<void> {
    const authorization = authorizeSend(
      this.contextPlan ? { id: this.contextPlanId, mode: this.contextPlan.mode } : null,
      { writable, planId },
    );
    if (!authorization.ok) {
      this.setStatus('error', `Not sent: ${authorization.reason}`);
      this.emit();
      return;
    }
    const plan = this.contextPlan;
    const sentPlanId = this.contextPlanId;
    const scopeProjectId = this.selectedProjectId;
    const gate = sendGate(
      this.capabilities?.agents ?? [],
      writable,
      selectedWorkspaceMode(this.sandboxes, this.selectedSandbox),
    );
    if (!gate.allowed) {
      const confirmed = await vscode.window.showWarningMessage(
        `${gate.reason}\n\nCore will accept this and the task stays queued unless a verified adapter runs it. Send anyway?`,
        { modal: true, detail: 'Sending creates a real task record in Core. It is not a simulation.' },
        'Send anyway',
      );
      if (confirmed !== 'Send anyway') {
        this.setStatus('info', 'Not sent.');
        this.emit();
        return;
      }
    }
    let conversationId: string;
    try {
      if (this.connection.connectionState !== 'online') await this.attach();
      this.dropConversationOutOfScope();
      if (!this.conversation) {
        const projectId = this.selectedProjectId;
        const agentId = this.pickAgentId();
        if (!projectId || !agentId) {
          this.setStatus(
            'error',
            'Cannot create a conversation: pick a project first (Core has ' +
              `${this.projects.length} project(s)) and an advertised agent id.`,
          );
          this.emit();
          return;
        }
        this.conversation = await this.commands.conversationCreate({
          projectId,
          agentId,
          ...(this.selectedSandbox ? { sandboxId: this.selectedSandbox } : {}),
          title: text.slice(0, 80),
        });
        this.conversationSandbox = this.selectedSandbox;
        const preference: ConversationPreference = {
          id: this.conversation.id,
          projectId: this.conversation.projectId,
          title: this.conversation.title,
          agentId: this.conversation.agentId,
          sandboxName: this.conversationSandbox,
        };
        await this.context.workspaceState.update(UI_KEYS.conversation, preference);
      }
      conversationId = this.conversation.id;
    } catch (error) {
      this.reportError(error, 'conversation.create');
      return;
    }
    // A2: one fresh key for THIS send, only when Core honours keys.
    const key = this.coreHasFeature('idempotency-keys') ? newIdempotencyKey() : undefined;
    await this.deliverSend(
      {
        conversationId,
        content: text,
        attachments: plan?.refs ?? [],
        ...(key !== undefined ? { idempotencyKey: key } : {}),
      },
      { scopeProjectId, sentPlanId, origin },
    );
  }

  /**
   * One `conversation.send` attempt with fixed params. "Retry safely" calls it
   * again with the IDENTICAL params (same key); nothing calls it automatically.
   */
  private async deliverSend(
    params: ConversationSendParams,
    ctx: { scopeProjectId: string | null; sentPlanId: number; origin: 'sidebar' | 'command' },
    priorUnknown = false,
  ): Promise<void> {
    try {
      const summary = await this.commands.conversationSend(params);
      // Discard the plan only if it is still the one that was sent: a list the
      // user reviewed while this send was in flight stays (review S4).
      if (this.contextPlanId === ctx.sentPlanId) this.contextPlan = null;
      if (ctx.origin === 'sidebar') this.acceptedSends += 1;
      if (summary.replayed === true) {
        // The stored FIRST response: its status is not current. Re-read Core's
        // task list instead of painting it, and never call it a fresh send.
        await this.reloadScope();
        this.setStatus('info', REPLAY_NOTICE);
        this.emit();
        return;
      }
      // Only paint the accepted task if the user is still on that project.
      if (this.selectedProjectId === ctx.scopeProjectId) {
        this.view = reduceTaskView(this.view, { kind: 'taskSummary', summary });
      }
      // No local echo: Core appends `message.user` durably itself, and the
      // catch-up below brings it back. Inventing the line here would paint a
      // transcript the durable log does not contain (AGENTS.md rule 3).
      this.setStatus('ok', `Core accepted task ${summary.id.slice(0, 8)} (status: ${summary.status})`);
      await this.catchUpNow();
      this.emit();
    } catch (error) {
      this.reportKeyedFailure(
        error,
        'conversation.send',
        params.idempotencyKey !== undefined,
        priorUnknown,
        () => this.retrySend(params, ctx),
        () => this.reloadScope(),
      );
    }
  }

  /** "Retry safely" for a send: same params and key, under the one-send guard. */
  private async retrySend(
    params: ConversationSendParams,
    ctx: { scopeProjectId: string | null; sentPlanId: number; origin: 'sidebar' | 'command' },
  ): Promise<void> {
    // The failed send's own guard is released a few microtasks after its
    // notification appears; a click that lands first waits for that release.
    if (this.sendInFlight) await this.sendInFlight.catch(() => undefined);
    if (this.sending) {
      this.setStatus('info', 'A send is already in progress; wait for Core to answer.');
      this.emit();
      return;
    }
    this.sending = true;
    this.emit();
    try {
      await this.deliverSend(params, ctx, true);
    } finally {
      this.sending = false;
      this.emit();
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      `Ask Core to cancel task ${taskId.slice(0, 8)}? Cancellation is honoured only if the task's ` +
        'current state allows it; Core decides.',
      { modal: true },
      'Cancel task',
    );
    if (answer !== 'Cancel task') return;
    try {
      const result = await this.commands.taskCancel(taskId);
      this.setStatus('info', `Core cancellation requested=${result.requested} for ${taskId.slice(0, 8)}`);
      await this.catchUpNow();
    } catch (error) {
      this.reportError(error, 'task.cancel');
    }
    this.emit();
  }

  /** Review: real ChangeSet from Core, then native diffs at real revisions. */
  async reviewChanges(taskId: string): Promise<ChangeSet | undefined> {
    try {
      const changeSet = await this.commands.gitReview(taskId);
      const repoRoot = await this.confirmRepoRoot(changeSet);
      if (!repoRoot) {
        this.setStatus('error', 'Review aborted: no confirmed repository root to build diff URIs from.');
        this.emit();
        return undefined;
      }
      const { reviewed, refused } = buildChangeSetPlans(repoRoot, changeSet);
      // Bounded: one Review never opens hundreds of editors (security S5).
      const { open, notOpened } = capReviewPlans(reviewed);
      let opened = 0;
      for (const item of open) {
        if (!item.plan.ok) continue;
        // Real Uri objects (Uri.file + .with for the git revision) — never
        // pre-encoded strings, which mangle '#'/'?' in paths (review bug 1).
        if (item.plan.kind === 'diff') {
          const [left, right, title] = item.plan.plan.args;
          await vscode.commands.executeCommand(
            item.plan.plan.command,
            materializeUri(left, VSCODE_URI),
            materializeUri(right, VSCODE_URI),
            title,
          );
        } else {
          await vscode.commands.executeCommand(item.plan.plan.command, materializeUri(item.plan.plan.args[0], VSCODE_URI));
        }
        opened += 1;
      }
      const notes = [
        `${changeSet.changes.length} change(s) from Core, ${opened} opened`,
        notOpened > 0 ? `${notOpened} more not opened (limit per review) — run Review again after closing editors` : null,
        changeSet.hostDirty ? 'HOST DIRTY — apply is blocked until your own edits are resolved' : null,
        refused.length > 0 ? `${refused.length} not shown: ${refused.map((r) => `${r.path} (${r.reason})`).join('; ')}` : null,
      ].filter((s): s is string => s !== null);
      this.setStatus('info', notes.join(' · '));
      this.emit();
      return changeSet;
    } catch (error) {
      this.reportError(error, 'git.review');
      return undefined;
    }
  }

  /** Apply = explicit confirmed Git operation through Core, never a file write. */
  async applyTask(taskId: string): Promise<void> {
    let changeSet: ChangeSet;
    try {
      changeSet = await this.commands.gitReview(taskId);
    } catch (error) {
      this.reportError(error, 'git.review');
      return;
    }
    const listing = changeSet.changes
      .map((c) => `· ${c.status} ${c.path}`)
      .join('\n');
    const message =
      `Apply task ${taskId.slice(0, 8)} into the host repository?\n\n` +
      `base: ${changeSet.baseCommit}\n` +
      `host dirty: ${changeSet.hostDirty ? 'YES — Core will abort rather than overwrite your work' : 'no'}\n\n` +
      `${listing || '· (no changes reported)'}`;
    const answer = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail: 'Core performs the Git operation; this client never writes host files.' },
      'Apply via Core',
    );
    if (answer !== 'Apply via Core') {
      this.setStatus('info', 'Apply not confirmed; nothing changed.');
      this.emit();
      return;
    }
    try {
      const result = await this.commands.gitApply({
        taskId,
        expectedBase: changeSet.baseCommit,
        selectedFiles: null,
      });
      if (result.applied) {
        this.setStatus('ok', `Core applied task ${taskId.slice(0, 8)}`);
      } else {
        this.setStatus(
          'error',
          `Apply did not happen: ${result.abortReason ?? 'no reason given by Core'}` +
            (result.conflictedFiles.length > 0 ? ` · conflicts: ${result.conflictedFiles.join(', ')}` : ''),
        );
      }
      this.emit();
    } catch (error) {
      this.reportError(error, 'git.apply');
    }
  }

  /**
   * Build the attachment list for the composer preview. The plan is held until
   * the user sends, and only its references go on the wire.
   */
  previewContext(writable: boolean): ContextPlanView {
    const snapshot = collectEditorSnapshot();
    const policy = {
      ...DEFAULT_CONTEXT_POLICY,
      includeDiagnostics: writable
        ? vscode.workspace.getConfiguration('sandpane').get<boolean>('attachDiagnostics', false) === true
        : false,
    };
    const plan = snapshot
      ? planContextAttachments([snapshot], policy, writable ? 'writable' : 'read_only')
      : planContextAttachments([], policy, writable ? 'writable' : 'read_only');
    this.contextPlan = plan;
    this.contextPlanId += 1;
    const view = this.planView();
    this.emit();
    if (!view) throw new Error('internal: context plan missing right after it was built');
    return view;
  }

  private planView(): ContextPlanView | null {
    const plan = this.contextPlan;
    if (!plan) return null;
    return {
      planId: this.contextPlanId,
      summary: plan.summary,
      disclosure: plan.disclosure,
      mode: plan.mode,
      attachments: plan.attachments.map((a) => ({
        kind: a.kind,
        label: a.label,
        target: a.target,
        excerpt: a.excerpt,
        truncated: a.excerptTruncated,
      })),
      excluded: plan.excluded.map((e) => ({ label: e.label, reason: e.reason })),
    };
  }

  /**
   * Select a sandbox. Its workspace mode is read from Core's summary wherever it
   * is needed (bug 4); a bound project re-scopes the sidebar (bug 3); a
   * conversation from another project/sandbox is dropped (bug 8).
   */
  selectSandbox(name: string, options: { reload?: boolean } = {}): void {
    // Only a sandbox Core listed can be selected (review S3); '' clears.
    if (name.length > 0 && !this.sandboxes.some((s) => s.name === name)) {
      this.setStatus('error', `Sandbox "${name}" is not listed by Core; selection unchanged.`);
      this.emit();
      return;
    }
    this.selectedSandbox = name.length > 0 ? name : null;
    void this.context.workspaceState.update(UI_KEYS.selectedSandbox, this.selectedSandbox ?? undefined);
    const bound = this.sandboxes.find((s) => s.name === name);
    const projectChanged = bound?.boundProjectId ? this.setProject(bound.boundProjectId) : false;
    this.dropConversationOutOfScope();
    this.emit();
    if (projectChanged && options.reload !== false) void this.reloadScope();
  }

  handleWebviewMessage(message: WebviewToExtension): void {
    switch (message.type) {
      case 'ready':
        void this.refresh();
        break;
      case 'refresh':
        void this.refresh();
        break;
      case 'selectSandbox':
        this.selectSandbox(message.name);
        break;
      case 'previewContext':
        this.previewContext(message.writable);
        break;
      case 'send':
        void this.send(message.text, message.writable, message.planId, 'sidebar');
        break;
      case 'cancelTask':
        void this.cancelTask(message.taskId);
        break;
      case 'reviewTask':
        void this.reviewChanges(message.taskId);
        break;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  // -----------------------------------------------------------------------
  // State fan-out
  // -----------------------------------------------------------------------

  snapshot(): SidebarState {
    const base = emptySidebarState(this.tone());
    const project = this.projects.find((p) => p.id === this.selectedProjectId) ?? null;
    const agent = this.pickAgentId();
    const sandbox = this.sandboxes.find((s) => s.name === this.selectedSandbox) ?? null;
    const mode = selectedWorkspaceMode(this.sandboxes, this.selectedSandbox);
    const tasks = selectTasks(this.view);
    const transcript = transcriptView(
      tasks,
      this.conversation ? { id: this.conversation.id, title: this.conversation.title } : null,
    );
    const scopedTasks =
      transcript.scope === 'conversation'
        ? tasks.filter((t) => t.conversationId === this.conversation?.id)
        : tasks;
    return {
      connection: this.tone(),
      header: {
        project: project?.name ?? (this.projects.length > 0 ? `${this.projects.length} project(s), none selected` : null),
        agent,
        sandbox: sandbox?.name ?? this.selectedSandbox,
        workspaceMode: mode.raw,
        workspaceModeBadge: this.selectedSandbox === null ? null : mode.badge,
        workspaceHostWritable: this.selectedSandbox === null ? false : mode.hostWritable,
        branch: scopedTasks[scopedTasks.length - 1]?.taskBranch ?? null,
      },
      sandboxes: this.sandboxes.map((s) => {
        const view = selectedWorkspaceMode([s], s.name);
        return {
          name: s.name,
          probedState: s.probedState ?? null,
          workspaceMode: s.workspaceMode ?? null,
          modeBadge: view.badge,
          modeHostWritable: view.hostWritable,
        };
      }),
      selectedSandbox: this.selectedSandbox,
      conversation: this.conversation
        ? { id: this.conversation.id, title: this.conversation.title, agentId: this.conversation.agentId }
        : null,
      lines: transcript.lines.map((line) => ({
        role: line.role,
        text: line.text,
        ...(line.unsupported ? { unsupported: true } : {}),
        ...(line.errorCode ? { errorCode: line.errorCode } : {}),
      })),
      transcript: { scope: transcript.scope, label: transcript.label },
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        status: task.status,
        ...(task.conversationId ? { conversationId: task.conversationId } : {}),
        branch: task.taskBranch ?? null,
        baseCommit: task.baseCommit ?? null,
        unknownKinds: task.unknownKinds,
      })),
      acceptedSends: this.acceptedSends,
      sending: this.sending,
      status: this.status,
      capabilities: this.capabilities
        ? {
            coreVersion: this.capabilities.coreVersion,
            protocolVersion: this.capabilities.protocolVersion,
            instanceId: this.capabilities.instanceId,
            platform: this.capabilities.platform,
            sbxInstalled: this.capabilities.sbx?.installed ?? null,
            agents: this.capabilities.agents.map((a: AgentCapability) => ({
              id: a.id,
              verified: a.verified,
              supportsStreaming: a.supportsStreaming,
              supportsCancel: a.supportsCancel,
            })),
          }
        : null,
      contextPlan: this.planView(),
      notices: this.notices(base),
    };
  }

  private notices(base: SidebarState): string[] {
    const notices = [...base.notices];
    if (!this.host.supported) notices.push(this.host.explanation);
    if (this.capabilities) {
      if (this.capabilities.sbx && !this.capabilities.sbx.installed) {
        notices.push('SBX CLI not installed on this machine: sandbox operations return NOT_INSTALLED.');
      }
      if (verifiedAgents(this.capabilities.agents).length === 0) {
        notices.push(
          `No verified agent adapter (Core advertises: ${this.capabilities.agents
            .map((a) => `${a.id}${a.verified ? ' ✓' : ' ✗'}`)
            .join(', ')}). Chat is gated on the P0 in-SBX feasibility check — VS2.`,
        );
      }
    }
    if (this.projects.length > 1 && this.selectedProjectId === null) {
      notices.push(
        'No project selected: tasks are shown per project. Select a sandbox bound to a project, or ' +
          'create a project, to load its tasks.',
      );
    }
    if (process.platform === 'win32') {
      notices.push('Windows transport (named pipe) is a P1 deliverable; Core binds a Unix socket here.');
    }
    return notices;
  }

  private tone(): ConnectionTone {
    if (!this.host.supported) return 'unsupported';
    const state = this.connection.connectionState;
    if (state === 'online') return 'online';
    if (state === 'connecting' || state === 'reconnecting') return state;
    return 'offline';
  }

  /**
   * Catch up the selected project's durable events. The feed is scoped to the
   * CURRENT project and rebuilt when it changes (review bug 3); with no project
   * selected nothing is pulled, matching `hydrateFromCore`. After the first
   * replay the feed keeps re-pulling while a task is non-terminal and the
   * connection is online (review bug 10 / backlog 6).
   */
  private async catchUpNow(): Promise<void> {
    if (!this.host.supported) return;
    const projectId = this.selectedProjectId;
    if (!projectId) {
      this.stopFeed();
      return;
    }
    if (this.feed && this.feed.projectId !== projectId) this.stopFeed();
    if (!this.feed) {
      // Every callback checks it still belongs to the CURRENT feed: a stopped
      // feed's late page must never reach another project's view (W1).
      let created: ProjectEventFeed | null = null;
      const isCurrent = (): boolean => created !== null && this.feed === created;
      created = new ProjectEventFeed(this.commands, {
        projectId,
        knownTaskIds: () => this.view.order,
        isTaskActive: (taskId) =>
          shouldPollEvents(this.connection.connectionState, [this.view.tasks[taskId]?.status ?? null]),
        pollIntervalMs: EVENT_POLL_INTERVAL_MS,
        ...(this.deps.setTimer ? { schedule: this.deps.setTimer } : {}),
        ...(this.deps.clearTimer ? { cancel: this.deps.clearTimer } : {}),
        shouldPoll: () =>
          shouldPollEvents(
            this.connection.connectionState,
            selectTasks(this.view).map((t) => t.status),
          ),
        rankTask: (taskId) => {
          const task = this.view.tasks[taskId];
          const stamp = task?.lastTimestamp ? Date.parse(task.lastTimestamp) : Number.NaN;
          return {
            active: shouldPollEvents('online', [task?.status ?? null]),
            lastActivity: Number.isFinite(stamp) ? stamp : Number.NEGATIVE_INFINITY,
          };
        },
        onApplied: (events) => {
          if (!isCurrent()) return;
          this.view = reduceTaskView(this.view, { kind: 'taskEvents', events });
          this.emit();
        },
        onError: (error) => {
          if (isCurrent()) this.log(`task.subscribe replay failed: ${describe(error)}`);
        },
        // Core refuses a replay that cannot fit one IPC frame. Re-sending it can
        // never succeed, so the feed switches to task-scoped pulls instead of
        // disabling catch-up; say so rather than hiding it.
        onFallback: (message, omitted) => {
          if (!isCurrent()) return;
          this.log(`task.subscribe refused project-wide: ${message}`);
          this.setStatus(
            'info',
            'Event replay for the whole project is larger than one Core frame — catching up task by task' +
              (omitted > 0
                ? ` (${omitted} task(s) not followed: only the ${MAX_FOLLOWED_TASKS} most relevant are pulled — ` +
                  'unfinished tasks first, then the most recently active).'
                : '.'),
          );
          this.emit();
        },
        onTaskReplayRefused: (taskId, message) => {
          if (!isCurrent()) return;
          this.log(`task.subscribe refused for task ${taskId.slice(0, 8)}: ${message}`);
          this.setStatus(
            'info',
            `Task ${taskId.slice(0, 8)}'s event history is larger than one Core frame; its events are not shown.`,
          );
          this.emit();
        },
        maxFallbackTasks: MAX_FOLLOWED_TASKS,
      });
      this.feed = created;
      this.feedStarted = false;
    }
    const feed = this.feed;
    try {
      if (!this.feedStarted) {
        this.feedStarted = true;
        await feed.start();
      } else {
        await feed.catchUp();
      }
    } catch (error) {
      // Core answered VALIDATION_FAILED / NOT_FOUND etc.: report, never hide.
      this.log(`task.subscribe replay failed: ${describe(error)}`);
    }
    feed.poke();
  }

  private stopFeed(): void {
    this.feed?.stop();
    this.feed = null;
    this.feedStarted = false;
  }

  private pickAgentId(): string | null {
    if (!this.capabilities) return this.conversation?.agentId ?? null;
    const verified = verifiedAgents(this.capabilities.agents);
    return (verified[0] ?? this.capabilities.agents[0])?.id ?? null;
  }

  /**
   * Protocol v1 `git.review` returns no repository root (only baseCommit +
   * paths), so the client must propose one. It is confirmed explicitly instead
   * of being assumed — a wrong root would diff unrelated files.
   */
  private async confirmRepoRoot(changeSet: ChangeSet): Promise<string | null> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    if (folders.length === 0) return null;
    // Core stores CANONICAL repository paths (symlinks resolved, git toplevel
    // only), so folders are realpath'd before the exact comparison.
    const canonical = await Promise.all(
      folders.map(async (f) => ({
        fsPath: f.uri.fsPath,
        canonical: await realpath(f.uri.fsPath).catch(() => f.uri.fsPath),
      })),
    );
    const project = this.projects.find((p) => p.id === this.selectedProjectId);
    const matched = matchWorkspaceFolder(canonical, project?.repositories ?? []);
    const candidate = matched?.fsPath ?? canonical[0]?.fsPath;
    if (!candidate) return null;
    const provenance = matched
      ? `This folder is one of the project's repositories registered in Core (${matched.canonical}).`
      : project?.repositories && project.repositories.length > 0
        ? `WARNING: no open folder matches the project's repositories in Core (${project.repositories.join(', ')}).`
        : 'Core reports no repository for the selected project.';
    const answer = await vscode.window.showInformationMessage(
      `Diff the ${changeSet.changes.length} reported change(s) against the task base ` +
        `${changeSet.baseCommit.slice(0, 8)} using this workspace folder as the repository root?\n\n${candidate}\n\n` +
        `${provenance}\n\n` +
        'Gap: protocol v1 git.review does not return the task repository path (P4). Confirm it is the right repo.',
      { modal: true },
      'Yes, use this folder',
    );
    return answer === 'Yes, use this folder' ? candidate : null;
  }

  private setStatus(tone: 'ok' | 'error' | 'info', text: string): void {
    this.status = { tone, text };
    if (tone === 'error') this.log(`ERROR ${text}`);
  }

  private log(message: string): void {
    // Client-side log channel; never prompt content, never credentials.
    this.output?.appendLine(`[session] ${message}`);
  }

  private output: vscode.OutputChannel | undefined = undefined;

  setOutputChannel(channel: vscode.OutputChannel): void {
    this.output = channel;
  }

  /**
   * Error box with mapped guidance + the Core message. Core-supplied text is
   * shown as plain text: hidden/bidi/control characters are escaped visibly and
   * notification link syntax is neutralized (anti-spoofing, `plainText`).
   */
  reportError(error: unknown, operation: string, context?: string): void {
    const failure = toFailure(error);
    const guidance = explainFailure(error);
    const coreMessage =
      error instanceof CoreRpcError || error instanceof CoreTransportError || error instanceof CoreValidationError
        ? plainText(error.message, 2_000)
        : undefined;
    // Core's own remediation (`details.hint`, e.g. `sbx login` or
    // `sbx policy init …`) is shown verbatim as text for the user to run
    // themselves; Sandpane never executes it.
    const remedy = remediationFrom(error);
    const remedyHint = remedy ? plainText(remedy.hint, 500) : null;
    const remedyText = remedy
      ? `Core suggests${remedy.provider ? ` (provider: ${plainText(remedy.provider, 100)})` : ''}: ${remedyHint} — run it yourself; Sandpane never runs it.`
      : null;
    const text = `${operation} — ${[guidance.headline, context && context.length > 0 ? context : null, guidance.explanation, coreMessage ? `Core said: ${coreMessage}` : null, remedyText, guidance.honestUncertainty ?? null]
      .filter((p): p is string => p !== null)
      .join('\n\n')}`;
    this.log(`${operation} failed (${failure.source}): ${coreMessage ?? describe(error)}`);
    const actions: GuidanceAction[] = guidance.actions.filter((a) => a.command !== undefined);
    void vscode.window
      .showErrorMessage(text, ...actions.map((a) => a.label))
      .then((choice) => {
        const action = actions.find((a) => a.label === choice);
        if (action?.command) void vscode.commands.executeCommand(action.command);
      });
    this.setStatus(
      'error',
      `${operation}: ${guidance.headline}${context && context.length > 0 ? ` — ${context}` : ''}${remedy ? ` — Core suggests: ${remedyHint}` : ''}`,
    );
    this.emit();
  }

  private emit(): void {
    // Re-arm the event poll if activity resumed (new task, reconnect).
    this.feed?.poke();
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}
