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
import { CoreCommands, verifiedAgents, CoreValidationError } from './core-client/commands';
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
  Conversation,
  CoreCapabilities,
  Project,
  SandboxSummary,
} from './core-client/protocol';
import { coreAdvertisesMethod } from './core-client/protocol';
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
  }): Promise<SandboxSummary | undefined> {
    try {
      const summary = await this.commands.sandboxCreate({
        name: input.name,
        projectId: input.projectId,
        workspaceMode: input.workspaceMode,
        ...(input.repoPath ? { repoPath: input.repoPath } : {}),
      });
      this.sandboxes = [...this.sandboxes.filter((s) => s.name !== summary.name), summary];
      // The header/gate read the mode from Core's returned summary; if Core
      // returned none, it shows UNVERIFIED rather than the requested mode.
      this.selectSandbox(summary.name);
      const view = workspaceModeView(input.workspaceMode);
      this.setStatus(
        'ok',
        `Sandbox "${summary.name}" created — requested ${view.label}${view.hostWritable ? ` (${view.badge})` : ''}`,
      );
      this.emit();
      return summary;
    } catch (error) {
      this.reportError(error, 'sandbox.create');
      return undefined;
    }
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
    try {
      await this.sendGuarded(text, writable, planId, origin);
    } finally {
      this.sending = false;
      this.emit();
    }
  }

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
      const summary = await this.commands.conversationSend({
        conversationId: this.conversation.id,
        content: text,
        attachments: plan?.refs ?? [],
      });
      // Only paint the accepted task if the user is still on that project.
      if (this.selectedProjectId === scopeProjectId) {
        this.view = reduceTaskView(this.view, { kind: 'taskSummary', summary });
      }
      // No local echo: Core appends `message.user` durably itself, and the
      // catch-up below brings it back. Inventing the line here would paint a
      // transcript the durable log does not contain (AGENTS.md rule 3).
      // Discard the plan only if it is still the one that was sent: a list the
      // user reviewed while this send was in flight stays (review S4).
      if (this.contextPlanId === sentPlanId) this.contextPlan = null;
      if (origin === 'sidebar') this.acceptedSends += 1;
      this.setStatus('ok', `Core accepted task ${summary.id.slice(0, 8)} (status: ${summary.status})`);
      await this.catchUpNow();
      this.emit();
    } catch (error) {
      this.reportError(error, 'conversation.send');
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

  /** Error box with mapped guidance + the raw Core message. */
  reportError(error: unknown, operation: string): void {
    const failure = toFailure(error);
    const guidance = explainFailure(error);
    const coreMessage =
      error instanceof CoreRpcError || error instanceof CoreTransportError || error instanceof CoreValidationError
        ? error.message
        : undefined;
    // Core's own remediation (`details.hint`, e.g. `sbx login` or
    // `sbx policy init …`) is shown verbatim as text for the user to run
    // themselves; Sandpane never executes it.
    const remedy = remediationFrom(error);
    const remedyText = remedy
      ? `Core suggests${remedy.provider ? ` (provider: ${remedy.provider})` : ''}: ${remedy.hint} — run it yourself; Sandpane never runs it.`
      : null;
    const text = `${operation} — ${[guidance.headline, guidance.explanation, coreMessage ? `Core said: ${coreMessage}` : null, remedyText, guidance.honestUncertainty ?? null]
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
    this.setStatus('error', `${operation}: ${guidance.headline}${remedy ? ` — Core suggests: ${remedy.hint}` : ''}`);
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
