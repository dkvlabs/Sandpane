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
import { CoreCommands, verifiedAgents, CoreValidationError } from './core-client/commands';
import { CoreConnection, CoreRpcError, CoreTransportError } from './core-client/connection';
import { TaskSubscription } from './core-client/catchup';
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
import { evaluateHostContext, type HostVerdict } from './vscode/host';
import { explainFailure, toFailure, type GuidanceAction } from './vscode/diagnostics';
import {
  isKnownWorkspaceMode,
  sandboxWorkspaceModeView,
  unknownWorkspaceModeView,
  workspaceModeView,
} from './vscode/workspaces';
import {
  DEFAULT_CONTEXT_POLICY,
  planContextAttachments,
  type ContextPlan,
} from './vscode/context';
import { collectEditorSnapshot } from './vscode/editor';
import { buildChangeSetPlans } from './vscode/diff';
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

export type SessionListener = (state: SidebarState) => void;

export class SandpaneSession {
  readonly connection: CoreConnection;
  readonly commands: CoreCommands;

  private view: TaskViewState = EMPTY_STATE;
  private subscription: TaskSubscription | null = null;
  private capabilities: CoreCapabilities | null = null;
  private projects: Project[] = [];
  private sandboxes: SandboxSummary[] = [];
  private conversation: Conversation | null = null;
  /**
   * `conversation.list` hydration — Core's own enumeration, cached only for this
   * session's display. Not a database: it is re-read on every refresh, and an
   * archived conversation is absent because Core filters it (specs/02 §1).
   */
  private conversations: Conversation[] = [];
  private selectedProjectId: string | null = null;
  private selectedSandbox: string | null = null;
  private workspaceMode: string | null = null;
  private contextPlan: ContextPlan | null = null;
  private status: { tone: 'ok' | 'error' | 'info'; text: string } | null = null;
  private readonly listeners = new Set<SessionListener>();
  private attached = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('sandpane');
    const socketPath = coreSocketPath(
      { env: process.env, platform: process.platform, homedir: process.env['HOME'] ?? '' },
      config.get<string>('coreSocketPath', ''),
    );
    this.selectedProjectId = context.workspaceState.get<string>(UI_KEYS.selectedProject) ?? null;
    this.selectedSandbox = context.workspaceState.get<string>(UI_KEYS.selectedSandbox) ?? null;
    const storedConversation = context.workspaceState.get<{
      id: string;
      projectId: string;
      title: string;
      agentId: string;
    }>(UI_KEYS.conversation);
    if (storedConversation) {
      // A restored selection is a UI preference; the conversation itself is
      // re-read from Core on the next send (createdAt is not carried locally).
      this.conversation = { ...storedConversation, createdAt: '' };
    }

    this.connection = new CoreConnection({
      transportFactory: () => createSocketTransport({ path: socketPath, connectTimeoutMs: 3_000 }),
      onStateChange: () => this.emit(),
      onDecodeError: (error) => this.log(`frame decode ${error.reason}: ${error.message}`),
      onNotification: (frame) =>
        // Forward-compat only: this Core build never pushes frames.
        this.log(`unexpected pushed frame "${frame.method}" — ignored (no such Core capability)`),
      onReconnect: async () => {
        await this.catchUpNow();
      },
    });
    this.commands = new CoreCommands(this.connection);
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

  /** Probe + first replay. Never auto-starts a service (ADR 1 undecided). */
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
      await this.catchUpNow().catch(() => undefined);
      return;
    }
    this.attached = true;
    await this.refresh();
  }

  /**
   * UI detach only. Tasks keep running in Core (specs/03 §2.6) — we stop
   * pulling events and close our socket, nothing more.
   */
  detach(): void {
    this.subscription?.stop();
    this.subscription = null;
    this.attached = false;
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

  async refresh(): Promise<void> {
    if (!this.host.supported) {
      void vscode.window.showWarningMessage(this.host.explanation);
      return;
    }
    if (!this.attached) await this.attach();
    if (!this.attached) return;
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
        this.selectedProjectId = this.projects[0]?.id ?? null;
      }
    } else {
      this.log(`project.list failed: ${describe(projects.reason)}`);
    }
    const sandboxes = results[1];
    if (sandboxes.status === 'fulfilled') {
      this.sandboxes = sandboxes.value;
      if (!this.selectedSandbox && this.sandboxes.length === 1) {
        this.selectedSandbox = this.sandboxes[0]?.name ?? null;
      }
      this.setStatus('ok', `${this.sandboxes.length} sandbox(es) from Core`);
    } else {
      // NOT_INSTALLED / DAEMON_DOWN are real states, not an empty list.
      this.sandboxes = [];
      this.reportError(sandboxes.reason, 'sandbox.list');
    }
    await this.hydrateFromCore();
    await this.catchUpNow();
    this.emit();
  }

  /**
   * Pull the read-only enumerations Core advertises: `task.list` and
   * `conversation.list`.
   *
   * Both are ADDITIVE protocol-v1 methods, so they are FEATURE-DETECTED from
   * `system.probe`'s `methods` array rather than assumed — a pre-revision Core
   * answers `VALIDATION_FAILED` for an unknown method, and a client that
   * assumed it would report a false failure on every refresh.
   *
   * Hydration is display-only: `task.list` rows carry Core's stored status and go
   * straight into the reducer. Nothing here derives, advances or repairs a
   * lifecycle state (AGENTS.md rule 3).
   *
   * Scoping is deliberate: with no project selected nothing is pulled at all. An
   * unscoped read would be Core-legal, but it would paint other projects' tasks
   * and chats into a per-project sidebar, which is a display bug the client is
   * responsible for, not a Core verdict.
   */
  private async hydrateFromCore(): Promise<void> {
    const caps = this.capabilities;
    const projectId = this.selectedProjectId;
    if (!caps || !projectId) return;

    if (coreAdvertisesMethod(caps, 'task.list')) {
      try {
        const tasks = await this.commands.taskList({ projectId });
        this.view = reduceTaskView(this.view, { kind: 'taskList', tasks });
      } catch (error) {
        this.log(`task.list failed: ${describe(error)}`);
      }
    } else {
      this.log('task.list not advertised by this Core — task history stays unrecovered (no fake list)');
    }

    if (coreAdvertisesMethod(caps, 'conversation.list')) {
      try {
        this.conversations = await this.commands.conversationList({ projectId });
      } catch (error) {
        this.conversations = [];
        this.log(`conversation.list failed: ${describe(error)}`);
      }
      // Re-point a restored UI preference at Core's live record when the id still
      // exists; otherwise drop it rather than rendering a conversation Core does
      // not have.
      if (this.conversation) {
        const live = this.conversations.find((c) => c.id === this.conversation?.id);
        this.conversation = live ?? null;
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
      this.selectedProjectId = project.id;
      await this.context.workspaceState.update(UI_KEYS.selectedProject, project.id);
      this.setStatus('ok', `Project "${project.name}" created in Core`);
      this.emit();
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
      this.selectedSandbox = summary.name;
      this.workspaceMode = input.workspaceMode;
      await this.context.workspaceState.update(UI_KEYS.selectedSandbox, summary.name);
      const view = workspaceModeView(input.workspaceMode);
      this.setStatus('ok', `Sandbox "${summary.name}" created — ${view.label}${view.hostWritable ? ` (${view.badge})` : ''}`);
      this.emit();
      return summary;
    } catch (error) {
      this.reportError(error, 'sandbox.create');
      return undefined;
    }
  }

  /**
   * Composer send. Attachment authorization is mandatory: a send without the
   * explicit list the user saw is refused (specs/03 §4).
   */
  async send(text: string, writable: boolean, authorizedContext: boolean): Promise<void> {
    if (!this.host.supported) {
      void vscode.window.showWarningMessage(this.host.explanation);
      return;
    }
    if (text.trim().length === 0) {
      this.setStatus('info', 'Nothing to send: the message is empty.');
      this.emit();
      return;
    }
    if (!authorizedContext) {
      this.setStatus(
        'error',
        'Refused: review the attachment list ("Show attachments") and confirm before sending.',
      );
      this.emit();
      return;
    }
    const gate = this.adapterGate(writable);
    if (!gate.allowed) {
      const confirmed = await vscode.window.showWarningMessage(
        `${gate.reason}\n\nCore will accept this and the task stays queued — nothing runs. Send anyway?`,
        { modal: true, detail: 'Sending creates a real task record in Core. It is not a simulation.' },
        'Send anyway',
      );
      if (confirmed !== 'Send anyway') {
        this.setStatus('info', 'Not sent: no verified agent adapter in this Core build.');
        this.emit();
        return;
      }
    }
    try {
      if (!this.attached) await this.attach();
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
        await this.context.workspaceState.update(UI_KEYS.conversation, {
          id: this.conversation.id,
          projectId: this.conversation.projectId,
          title: this.conversation.title,
          agentId: this.conversation.agentId,
        });
      }
      const summary = await this.commands.conversationSend({
        conversationId: this.conversation.id,
        content: text,
        attachments: this.contextPlan?.refs ?? [],
      });
      this.view = reduceTaskView(this.view, { kind: 'taskSummary', summary });
      // No local echo: Core appends `message.user` durably itself, and the
      // catch-up below brings it back. Inventing the line here would paint a
      // transcript the durable log does not contain (AGENTS.md rule 3).
      this.contextPlan = null;
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
      let opened = 0;
      for (const item of reviewed) {
        if (!item.plan.ok) continue;
        if (item.plan.kind === 'diff') {
          await vscode.commands.executeCommand(item.plan.plan.command, ...item.plan.plan.args);
          opened += 1;
        } else {
          await vscode.commands.executeCommand(
            item.plan.plan.command,
            vscode.Uri.parse(item.plan.plan.args[0]),
          );
          opened += 1;
        }
      }
      const notes = [
        `${changeSet.changes.length} change(s) from Core, ${opened} opened`,
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
    const view: ContextPlanView = {
      summary: plan.summary,
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
    this.emit();
    return view;
  }

  selectSandbox(name: string): void {
    this.selectedSandbox = name.length > 0 ? name : null;
    const bound = this.sandboxes.find((s) => s.name === name);
    if (bound?.boundProjectId) this.selectedProjectId = bound.boundProjectId;
    void this.context.workspaceState.update(UI_KEYS.selectedSandbox, this.selectedSandbox);
    this.emit();
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
        this.previewContext(false);
        break;
      case 'send':
        void this.send(message.text, message.writable, message.authorizedContext);
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
    const tasks = selectTasks(this.view);
    const lines = tasks
      .flatMap((task) => task.lines.map((line) => ({ task, line })))
      .map(({ line }) => ({
        role: line.role,
        text: line.text,
        ...(line.unsupported ? { unsupported: true } : {}),
        ...(line.errorCode ? { errorCode: line.errorCode } : {}),
      }));
    return {
      connection: this.tone(),
      header: {
        project: project?.name ?? (this.projects.length > 0 ? `${this.projects.length} project(s), none selected` : null),
        agent,
        sandbox: sandbox?.name ?? null,
        workspaceMode: this.workspaceMode,
        branch: tasks[tasks.length - 1]?.taskBranch ?? null,
      },
      sandboxes: this.sandboxes.map((s) => {
        const mode = sandboxWorkspaceModeView(s);
        return {
          name: s.name,
          probedState: s.probedState ?? null,
          workspaceMode: s.workspaceMode ?? null,
          modeBadge: mode.badge,
          modeHostWritable: mode.hostWritable,
        };
      }),
      selectedSandbox: this.selectedSandbox,
      conversation: this.conversation
        ? { id: this.conversation.id, title: this.conversation.title, agentId: this.conversation.agentId }
        : null,
      lines,
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        status: task.status,
        ...(task.conversationId ? { conversationId: task.conversationId } : {}),
        branch: task.taskBranch ?? null,
        baseCommit: task.baseCommit ?? null,
        unknownKinds: task.unknownKinds,
      })),
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
      contextPlan: this.contextPlan
        ? {
            summary: this.contextPlan.summary,
            mode: this.contextPlan.mode,
            attachments: this.contextPlan.attachments.map((a) => ({
              kind: a.kind,
              label: a.label,
              target: a.target,
              excerpt: a.excerpt,
              truncated: a.excerptTruncated,
            })),
            excluded: this.contextPlan.excluded.map((e) => ({ label: e.label, reason: e.reason })),
          }
        : null,
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

  private async catchUpNow(): Promise<void> {
    if (!this.host.supported) return;
    if (!this.subscription) {
      this.subscription = new TaskSubscription(this.commands, {
        projectId: this.selectedProjectId ?? undefined,
        onApplied: (events) => {
          this.view = reduceTaskView(this.view, { kind: 'taskEvents', events });
          this.emit();
        },
        onError: (error) => this.log(`task.subscribe replay failed: ${describe(error)}`),
        // Core refuses a replay that cannot fit one IPC frame instead of
        // sending a frame both ends reject. It is recoverable — narrow the
        // request — and the subscription stops polling so nothing retries in a
        // loop; surface the guidance rather than hiding it.
        onReplayRefused: (message) => {
          this.log(`task.subscribe refused: ${message}`);
          this.setStatus(
            'info',
            'Event replay is larger than one Core frame — narrow to one task or a higher cursor.',
          );
        },
      });
    }
    try {
      await this.subscription.catchUp();
    } catch (error) {
      // Core answered VALIDATION_FAILED / NOT_FOUND etc.: report, never hide.
      this.log(`task.subscribe replay failed: ${describe(error)}`);
    }
  }

  private pickAgentId(): string | null {
    if (!this.capabilities) return this.conversation?.agentId ?? null;
    const verified = verifiedAgents(this.capabilities.agents);
    return (verified[0] ?? this.capabilities.agents[0])?.id ?? null;
  }

  private adapterGate(writable: boolean): { allowed: boolean; reason: string } {
    const agents = this.capabilities?.agents ?? [];
    if (agents.length === 0) {
      return {
        allowed: false,
        reason: 'Core advertised no agent adapters at all.',
      };
    }
    if (verifiedAgents(agents).length === 0) {
      return {
        allowed: false,
        reason:
          `No verified adapter: ${agents.map((a) => `${a.id}(verified=${a.verified})`).join(', ')}. ` +
          'The P0 Codex-in-SBX feasibility gate has not passed, so streaming/cancel/resume are all off.',
      };
    }
    if (writable) {
      const raw = this.workspaceMode;
      const mode =
        raw === null
          ? null
          : isKnownWorkspaceMode(raw)
            ? workspaceModeView(raw)
            : unknownWorkspaceModeView(String(raw));
      if (mode?.hostWritable) {
        return {
          allowed: false,
          reason: `Writable task in "${mode.label}" mode — ${mode.badge}. ${mode.explanation}`,
        };
      }
    }
    return { allowed: true, reason: '' };
  }

  /**
   * Protocol v1 `git.review` returns no repository root (only baseCommit +
   * paths), so the client must propose one. It is confirmed explicitly instead
   * of being assumed — a wrong root would diff unrelated files.
   */
  private async confirmRepoRoot(changeSet: ChangeSet): Promise<string | null> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return null;
    const candidate = folder.uri.fsPath;
    const answer = await vscode.window.showInformationMessage(
      `Diff the ${changeSet.changes.length} reported change(s) against the task base ` +
        `${changeSet.baseCommit.slice(0, 8)} using this workspace folder as the repository root?\n\n${candidate}\n\n` +
        'Gap: protocol v1 does not return the task repository path (P4). Confirm it is the right repo.',
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
    const text = `${operation} — ${[guidance.headline, guidance.explanation, coreMessage ? `Core said: ${coreMessage}` : null, guidance.honestUncertainty ?? null]
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
    this.setStatus('error', `${operation}: ${guidance.headline}`);
    this.emit();
  }

  private emit(): void {
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
