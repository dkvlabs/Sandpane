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
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CoreCommands,
  verifiedAgents,
  CoreValidationError,
  errorCodeOf,
  validateAddressableSandboxName,
  validateConversationRenameTitle,
  validateVerificationLabel,
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
  ConversationListParams,
  ConversationSendParams,
  CoreCapabilities,
  CoreFeature,
  CoreMethodName,
  FileChange,
  Project,
  ProjectListParams,
  SandboxCreateSpec,
  SandboxStopResult,
  SandboxSummary,
  SbxAgent,
  SendMode,
  ProjectContextResult,
  TaskSummary,
  VerificationCommand,
  VerificationRunParams,
} from './core-client/protocol';
import {
  coreAdvertisesFeature,
  coreAdvertisesMethod,
  DEFAULT_DIFF_BYTES,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from './core-client/protocol';
import {
  REPLAY_NOTICE,
  RETRY_SAFELY,
  classifyKeyedConflict,
  isProvablyUnsent,
  isUnknownOutcome,
  keyedConflictCopy,
  newIdempotencyKey,
  IDEMPOTENCY_RETENTION_MS,
  safeRetryWindowOpen,
} from './core-client/idempotency';
import { TASK_STATUSES, VERIFICATION_EVENT_KINDS, isTerminalStatus } from './core-client/events';
import { EXPORT_BEST_EFFORT_COPY, collectConversationExport } from './core-client/conversationExport';
import { EMPTY_STATE, reduceTaskView, selectTasks, type TaskView, type TaskViewState } from './state/reducer';
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
import { sbxStatusView } from './vscode/sbxStatus';
import {
  APPLY_IN_FLIGHT,
  APPLY_LIST_GONE_TEXT,
  APPLY_LIST_SCHEME,
  MODAL_LIST_CAP,
  TYPED_NOT_CONFIRMED,
  createBusyCopy,
  renderApplyListDocument,
  typedConfirmation,
  typedConfirmed,
  APPLY_NOT_IMPLEMENTED,
  CORE_RESTARTED,
  GIT_APPLY_FEATURE,
  MALFORMED_REVIEW,
  NO_REVIEW_ID,
  REVIEW_AGAIN,
  ReviewedDiffs,
  applyConfirmationView,
  applyErrorView,
  applyPickPlan,
  applyResultView,
  diffMismatch,
  malformedApplyCopy,
  mismatchCopy,
  notApplicableCopy,
  parseApplyChangeSet,
  plainChangeLabel,
  parseApplyResult,
  type ApplyOutcomeView,
  noIcons,
} from './vscode/gitApply';
import {
  MALFORMED_VERIFICATION,
  NOT_CONFIRMED,
  SHOW_RESULT_BUTTON,
  VERIFICATION_FEATURE,
  VERIFICATION_GONE_TEXT,
  VERIFICATION_IN_FLIGHT,
  VERIFICATION_LANGUAGE,
  VERIFICATION_METHODS,
  VERIFICATION_SCHEME,
  VERIFICATION_EXTENSION,
  VERIFICATION_TOO_LATE,
  VERIFICATION_UNSUPPORTED,
  VERIFICATION_UNSUPPORTED_NOTE,
  approveConfirmationView,
  approvedCopy,
  argvInputValue,
  confirmStepItems,
  finishedEventSummary,
  outcomeCopy,
  panelArgvLines,
  parseArgvInput,
  parseProjectContext,
  parseRunStarted,
  parseVerificationCommand,
  parseVerificationList,
  parseVerificationResult,
  renderArgvDocument,
  renderResultDocument,
  revokeConfirmationView,
  runBinding,
  runConfirmationView,
  runRowText,
  runStartedCopy,
  sandboxVerificationRunningCopy,
  verificationErrorView,
  type ConfirmationView,
  type VerificationErrorView,
  type VerificationOperation,
} from './vscode/verification';
import {
  LOST_STEP2_TITLE,
  MAINTENANCE_CONFLICT_TITLE,
  defaultChecked,
  itemPickLine,
  maintenanceAdvertised,
  maintenanceOutcomeCopy,
  parseMaintenanceCleanup,
  parseMaintenanceInventory,
} from './vscode/maintenance';
import {
  MALFORMED_DIFF_COPY,
  PATCH_SCHEME,
  PatchDocumentStore,
  changeLabel,
  changeSetNotes,
  gitErrorCopy,
  labelText,
  parseGitDiffResult,
  renderPatchDocument,
} from './vscode/gitDiff';
import {
  DISCUSS_NOT_ADVERTISED,
  DISCUSS_NOT_WRITABLE,
  RETRY_MODE_NOT_ADVERTISED,
  SEND_MODE_FEATURE,
  chosenSandboxText,
  sendModeErrorCopy,
  taskModeText,
} from './vscode/sendMode';
import {
  ARCHIVED_LABEL,
  DELETE_PROJECT_BUTTON,
  MSG_PROJECT_ARCHIVED,
  MSG_PROJECT_NOT_FOUND,
  isArchived,
  projectDeleteView,
  projectErrorCopy,
  projectPickItem,
} from './vscode/projectActions';
import {
  ARCHIVED_CONVERSATION_LABEL,
  DELETE_CONVERSATION_BUTTON,
  MSG_CONVERSATION_ARCHIVED,
  conversationDeleteView,
  conversationErrorCopy,
  conversationSandboxLabel,
  conversationTitleProblem,
  exportFileName,
  isConversationArchived,
  isConversationNotFound,
  titleFromMessage,
} from './vscode/conversationActions';
import {
  DEFAULT_CONTEXT_POLICY,
  planContextAttachments,
  type ContextPlan,
} from './vscode/context';
import { collectEditorSnapshot } from './vscode/editor';
import { buildChangeSetPlans, capReviewPlans, materializeUri, type UriFactory } from './vscode/diff';
import {
  emptySidebarState,
  type CapabilitySummary,
  type ConnectionTone,
  type ContextPlanView,
  type ConversationAction,
  type ConversationActionState,
  type ConversationListView,
  type SidebarState,
  type TaskVerificationRow,
  type VerificationAction,
  type MaintenancePanelView,
  type VerificationPanelView,
  type WebviewToExtension,
} from './webview/bridge';

const UI_KEYS = {
  selectedProject: 'sandpane.ui.selectedProject',
  selectedSandbox: 'sandpane.ui.selectedSandbox',
  conversation: 'sandpane.ui.conversation',
  /** A3a UI preference: include archived projects in lists (`includeArchived`). */
  showArchived: 'sandpane.ui.showArchivedProjects',
  /** A3b UI preference: include archived conversations in the chat list. */
  showArchivedConversations: 'sandpane.ui.showArchivedConversations',
} as const;

/** Rows asked for when settling an unknown delete outcome (Core's MAX_LIST_LIMIT). */
const SETTLE_LIST_LIMIT = MAX_LIST_LIMIT;

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

/** Marks a hydration that did not read `project.context` (background refresh). */
const CONTEXT_NOT_READ = Symbol('project.context not read');

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
  /** Whether the last `sandbox.list` succeeded (A3b label: never "not in the list" without one). */
  private sandboxListRead = false;
  private conversation: Conversation | null = null;
  /**
   * UI scope key of `conversation`: the sandbox selected when it was created
   * or opened here. Never Core's `sandboxId` (a stored name, not a binding).
   */
  private conversationSandbox: string | null = null;
  /**
   * `conversation.list` hydration — Core's own enumeration, cached only for this
   * session's display. Not a database: it is re-read on every refresh, and an
   * archived conversation is absent unless "show archived" is on (A3b,
   * `includeArchived`) — Core filters it (specs/02 §1).
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
    this.showArchived = context.workspaceState.get<boolean>(UI_KEYS.showArchived) === true;
    this.showArchivedConversations = context.workspaceState.get<boolean>(UI_KEYS.showArchivedConversations) === true;
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
      onReconnect: () => {
        // A (re)connect is a project load: Core may be another instance.
        this.verificationContextDue = true;
        return this.load();
      },
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
      projects = await this.commands.projectList(this.projectListParams());
      this.projects = projects;
    } catch (error) {
      this.log(`project.list failed while picking: ${describe(error)} — using the last snapshot`);
    }
    return projects.map((project) => {
      const row = projectPickItem(project);
      return { label: row.label, description: row.description, id: row.id };
    });
  }

  /**
   * `project.list` params for this window's lists: `includeArchived: true`
   * only when the user turned "show archived" on AND this Core has the A3a
   * project lifecycle (an older Core would ignore the flag silently).
   */
  private projectListParams(): ProjectListParams {
    return this.showArchived && this.coreAdvertises('project.archive') ? { includeArchived: true } : {};
  }

  /** UI preference (workspaceState): include archived projects in lists. */
  private showArchived = false;

  get showingArchivedProjects(): boolean {
    return this.showArchived;
  }

  /**
   * Fresh projects for the project-settings commands: archived ones included
   * (labeled) when Core supports it, so unarchive/delete can reach them.
   */
  async listProjectsForSettings(): Promise<Project[]> {
    return this.commands.projectList(this.coreAdvertises('project.archive') ? { includeArchived: true } : {});
  }

  /** Re-read `project.list` after a mutation. Returns false when it failed. */
  private async refreshProjects(params: ProjectListParams = this.projectListParams()): Promise<boolean> {
    try {
      this.projects = await this.commands.projectList(params);
    } catch (error) {
      this.log(`project.list after a project change failed: ${describe(error)} — the list may be stale`);
      return false;
    }
    this.emit();
    return true;
  }

  /**
   * Pre-flight for a contributed A3a command, before any picker is shown: the
   * same gate the action applies (host supported, attached, fresh probe
   * advertises `method`). The action re-checks it when it runs.
   */
  async offers(method: CoreMethodName, action: string): Promise<boolean> {
    return this.ensureAdvertised(method, action);
  }

  /** "Show archived projects" toggle (A3a): gated on the lifecycle methods. */
  async toggleShowArchived(): Promise<void> {
    if (!(await this.ensureAdvertised('project.archive', 'Show archived projects'))) return;
    this.showArchived = !this.showArchived;
    void this.context.workspaceState.update(UI_KEYS.showArchived, this.showArchived);
    const listed = await this.refreshProjects();
    this.setStatus(
      'info',
      (this.showArchived
        ? 'Archived projects are shown (labeled ARCHIVED).'
        : 'Archived projects are hidden.') + (listed ? '' : ' The project list could not be re-read.'),
    );
    this.emit();
  }

  /**
   * One A3a project mutation: gated on the probe; on an archived project every
   * mutation except unarchive/delete is refused HERE with Core's own reason
   * (nothing is sent); afterwards `project.list` is re-read.
   */
  private async projectMutation(
    method: CoreMethodName,
    action: string,
    project: Project,
    allowArchived: boolean,
    run: () => Promise<Project>,
    done: (updated: Project) => string,
  ): Promise<Project | undefined> {
    if (!(await this.ensureAdvertised(method, action))) return undefined;
    if (!allowArchived && this.refuseIfArchived(project, action)) return undefined;
    try {
      const updated = await run();
      const listed = await this.refreshProjects();
      this.setStatus('ok', done(updated) + (listed ? '' : ' (the project list could not be re-read; it may be stale)'));
      this.emit();
      return updated;
    } catch (error) {
      this.reportProjectError(error, method);
      return undefined;
    }
  }

  /**
   * Edits of an archived project are disabled with Core's own reason: when
   * `project` is archived this shows the refusal (nothing is sent) and returns
   * true. Commands call it right after the project pick, before asking for a
   * name, folder or repository; the mutation itself checks it again.
   */
  refuseIfArchived(project: Project, action: string): boolean {
    if (!isArchived(project)) return false;
    const text =
      `${action} is not available: Core refuses changes to an archived project ("${MSG_PROJECT_ARCHIVED}"). ` +
      'Unarchive it first. Nothing was sent.';
    void vscode.window.showWarningMessage(text);
    this.setStatus('error', text);
    this.emit();
    return true;
  }

  /** Core's exact A3a refusals get honest copy; no answer = UNKNOWN + re-read. */
  private reportProjectError(error: unknown, operation: string): void {
    if (isUnknownOutcome(error)) {
      this.reportError(
        error,
        operation,
        'Outcome UNKNOWN: Core did not confirm whether this changed anything. Re-reading the project list from Core; not retried.',
      );
      void this.refreshProjects({ ...(this.coreAdvertises('project.archive') ? { includeArchived: true } : {}) });
      return;
    }
    this.reportError(error, operation);
  }

  async renameProject(project: Project, name: string): Promise<Project | undefined> {
    return this.projectMutation('project.update', 'Rename project', project, false,
      () => this.commands.projectUpdate({ projectId: project.id, name }),
      (p) => `Project renamed to "${plainText(p.name, 120)}" in Core.`);
  }

  /** An empty description clears it (Core's rule). */
  async editProjectDescription(project: Project, description: string): Promise<Project | undefined> {
    return this.projectMutation('project.update', 'Edit project description', project, false,
      () => this.commands.projectUpdate({ projectId: project.id, description }),
      (p) => (description.length === 0 ? `Description of "${plainText(p.name, 120)}" cleared in Core.` : `Description of "${plainText(p.name, 120)}" updated in Core.`));
  }

  async archiveProject(project: Project): Promise<Project | undefined> {
    return this.projectMutation('project.archive', 'Archive project', project, true,
      () => this.commands.projectArchive(project.id),
      (p) => {
        const base = `Project "${plainText(p.name, 120)}" archived in Core — Core now refuses new chats, sends, sandboxes and edits for it until it is unarchived.`;
        if (this.showArchived) return base;
        // Hidden from the re-read list: never keep it selected as an unlabeled,
        // seemingly usable project.
        const deselected = this.selectedProjectId === p.id && this.setProject(null);
        return `${base} It is hidden from lists${deselected ? ' and was deselected' : ''}; use "Show / Hide Archived Projects" to see it.`;
      });
  }

  async unarchiveProject(project: Project): Promise<Project | undefined> {
    return this.projectMutation('project.unarchive', 'Unarchive project', project, true,
      () => this.commands.projectUnarchive(project.id),
      (p) => `Project "${plainText(p.name, 120)}" unarchived in Core.`);
  }

  async addRepository(project: Project, path: string): Promise<Project | undefined> {
    return this.projectMutation('project.add_repository', 'Add repository', project, false,
      () => this.commands.projectAddRepository({ projectId: project.id, path }),
      (p) => `Core registered the repository with "${plainText(p.name, 120)}" (${(p.repositories ?? []).length} repository(ies) now).`);
  }

  async removeRepository(project: Project, path: string): Promise<Project | undefined> {
    return this.projectMutation('project.remove_repository', 'Remove repository', project, false,
      () => this.commands.projectRemoveRepository({ projectId: project.id, path }),
      (p) => `Core unregistered the repository from "${plainText(p.name, 120)}"; the host repository was not touched.`);
  }

  /** Forget every client-side reference to a deleted project (UI state only). */
  private forgetProject(projectId: string): void {
    this.projects = this.projects.filter((p) => p.id !== projectId);
    if (this.conversation?.projectId === projectId) {
      this.conversation = null;
      this.conversationSandbox = null;
      void this.context.workspaceState.update(UI_KEYS.conversation, undefined);
    }
    if (this.selectedProjectId === projectId) {
      this.setProject(null);
    }
  }

  /**
   * `project.delete` (A3a) with the A1 two-step pattern: step 1 → native modal
   * (name, id, capped impact, expiry) → only "Delete project", re-checked for
   * expiry at click time, sends step 2 with the token. Cancel sends nothing.
   * Neither step is retried; the token is never logged or shown.
   */
  async deleteProject(project: Project): Promise<boolean> {
    if (!(await this.ensureAdvertised('project.delete', 'Delete project'))) return false;
    let confirmation: ConfirmationRequest;
    try {
      confirmation = await this.commands.projectDeleteRequest(project.id);
    } catch (error) {
      // Step 1 changes nothing in Core, whatever happened.
      this.reportError(error, 'project.delete (confirmation request)', projectErrorCopy(error) ?? 'Nothing was deleted.');
      return false;
    }
    const view = projectDeleteView(confirmation, this.now());
    const answer = await vscode.window.showWarningMessage(view.message, { modal: true, detail: view.detail }, DELETE_PROJECT_BUTTON);
    if (answer !== DELETE_PROJECT_BUTTON) {
      this.setStatus('info', 'Delete not confirmed — nothing was sent; the confirmation expires on its own.');
      this.emit();
      return false;
    }
    const expiresAt = Date.parse(confirmation.expiresAt);
    if (!Number.isFinite(expiresAt) || this.now() >= expiresAt) {
      this.setStatus('info', 'Confirmation expired — nothing was sent; run Delete Project again.');
      this.emit();
      return false;
    }
    let deleted: boolean;
    try {
      const result = await this.commands.projectDeleteConfirm(project.id, confirmation.token);
      deleted = result.deleted === true;
    } catch (error) {
      if (isUnknownOutcome(error)) {
        this.reportError(error, 'project.delete', 'Outcome UNKNOWN: Core did not confirm whether the project was deleted. Re-reading the project list (including archived) from Core; not retried.');
        // A Core-answered INTERNAL means Core finished that request; a
        // timeout / closed / failed write means it may still be running.
        await this.settleDeleteFromCore(project, error instanceof CoreRpcError);
        return false;
      }
      this.reportError(error, 'project.delete', projectErrorCopy(error) ?? undefined);
      // Core says the project no longer exists (e.g. deleted from another
      // window): drop it from UI state exactly as a confirmed delete does.
      if (error instanceof CoreRpcError && error.message === `NOT_FOUND: ${MSG_PROJECT_NOT_FOUND}`) {
        this.forgetProject(project.id);
      }
      await this.refreshProjects();
      this.emit();
      return false;
    }
    if (deleted) {
      this.forgetProject(project.id);
      const listed = await this.refreshProjects();
      this.setStatus(
        'ok',
        `Core deleted project "${plainText(confirmation.target.name, 120)}" (its Core records only; host files, branches and sandboxes were not touched).` +
          (listed ? '' : ' (the project list could not be re-read; it may be stale)'),
      );
    } else {
      this.setStatus('error', 'Core did not report the deletion — its state is unknown; re-reading the project list.');
      await this.settleDeleteFromCore(project, true);
    }
    this.emit();
    return deleted;
  }

  /**
   * After an unknown delete outcome, let Core's own list say what it shows NOW.
   * "It was not deleted" is said only when Core answered the step-2 request
   * (`coreFinished`): without an answer the request may still be running.
   */
  private async settleDeleteFromCore(project: Project, coreFinished: boolean): Promise<void> {
    let all: Project[];
    try {
      all = await this.listProjectsForSettings();
    } catch (error) {
      this.log(`project.list after an unknown delete failed: ${describe(error)}`);
      this.setStatus(
        'error',
        'The project list could not be re-read after the unknown outcome; whether the project was deleted is UNKNOWN.',
      );
      this.emit();
      return;
    }
    if (all.some((p) => p.id === project.id)) {
      this.setStatus(
        'info',
        coreFinished
          ? 'Core still lists the project as of this re-read — it was not deleted (Core answered the delete request, so that request has finished).'
          : 'Core still lists the project as of this re-read. Core never answered the delete request, so it may still finish — re-read before acting; not retried.',
      );
    } else {
      this.forgetProject(project.id);
      this.setStatus('info', 'Core no longer lists the project after the unknown outcome — the delete took effect.');
    }
    await this.refreshProjects();
    this.emit();
  }

  // -----------------------------------------------------------------------
  // A3b conversation lifecycle (design 2026-10-09 §3.3)
  // -----------------------------------------------------------------------

  /** UI preference (workspaceState): include archived conversations in the chat list. */
  private showArchivedConversations = false;

  /**
   * `conversation.list` params for the chat list: `includeArchived: true` only
   * when "show archived" is on AND this Core advertises `conversation.archive`
   * (an older Core would ignore the flag silently).
   */
  private conversationListParams(projectId: string): ConversationListParams {
    return this.showArchivedConversations && this.coreAdvertises('conversation.archive')
      ? { projectId, includeArchived: true }
      : { projectId };
  }

  /**
   * Take Core's list as the chat list. A selected conversation is re-pointed at
   * Core's record (archived state, title) or dropped when Core does not list
   * it; the stored preference is cleared only on Core's verdict (a successful
   * list without it), never on a transient failure.
   */
  private applyConversationList(conversations: Conversation[], listed: boolean): void {
    this.conversations = conversations;
    if (!this.conversation) return;
    const live = conversations.find((c) => c.id === this.conversation?.id);
    if (live) {
      this.conversation = live;
      return;
    }
    if (listed && conversations.length >= DEFAULT_LIST_LIMIT) {
      // A FULL page without it proves nothing (Core's list is bounded): keep
      // the selection; a send to a conversation Core no longer has answers
      // NOT_FOUND, which is reported, never hidden.
      return;
    }
    this.conversation = null;
    if (listed) {
      this.conversationSandbox = null;
      void this.context.workspaceState.update(UI_KEYS.conversation, undefined);
    }
  }

  /** Re-read the selected project's conversations after a change. False = not re-read. */
  private async refreshConversations(): Promise<boolean> {
    const projectId = this.selectedProjectId;
    if (!projectId || !this.coreAdvertises('conversation.list')) return false;
    let conversations: Conversation[];
    try {
      conversations = await this.commands.conversationList(this.conversationListParams(projectId));
    } catch (error) {
      this.log(`conversation.list after a conversation change failed: ${describe(error)} — the list may be stale`);
      return false;
    }
    if (this.selectedProjectId !== projectId) return false; // stale answer (W1)
    this.applyConversationList(conversations, true);
    this.emit();
    return true;
  }

  /** "Show archived" in the chat list (A3b), gated on `conversation.archive`. */
  async toggleShowArchivedConversations(): Promise<void> {
    if (!(await this.ensureAdvertised('conversation.archive', 'Show archived conversations'))) return;
    this.showArchivedConversations = !this.showArchivedConversations;
    void this.context.workspaceState.update(UI_KEYS.showArchivedConversations, this.showArchivedConversations);
    const listed = await this.refreshConversations();
    this.setStatus(
      'info',
      (this.showArchivedConversations
        ? 'Archived conversations are shown (labeled ARCHIVED).'
        : 'Archived conversations are hidden.') + (listed ? '' : ' The conversation list could not be re-read.'),
    );
    this.emit();
  }

  /**
   * A conversation the WEBVIEW named must be one Core listed for the selected
   * project (like `selectSandbox`, review S3); anything else is refused here.
   */
  private listedConversation(id: string, action: string): Conversation | undefined {
    const conversation = this.conversations.find((c) => c.id === id);
    if (conversation) return conversation;
    const text = `${action}: that conversation is not listed by Core for the selected project; nothing was sent. Refresh to re-read the list.`;
    void vscode.window.showWarningMessage(text);
    this.setStatus('error', text);
    this.emit();
    return undefined;
  }

  /** Select a Core-listed conversation; `''` = the next send starts a new one. */
  selectConversation(id: string): void {
    if (id.length === 0) {
      this.conversation = null;
      this.conversationSandbox = null;
      void this.context.workspaceState.update(UI_KEYS.conversation, undefined);
      this.setStatus('info', 'No conversation selected — the next send starts a new conversation.');
      this.emit();
      return;
    }
    const conversation = this.conversations.find((c) => c.id === id);
    if (!conversation) {
      this.setStatus('error', 'That conversation is not listed by Core for the selected project; selection unchanged.');
      this.emit();
      return;
    }
    this.conversation = conversation;
    // The UI scope of the selection is the CURRENT sandbox (the user chose to
    // continue it here). Core's `sandboxId` is a stored name, never a binding,
    // so it never feeds the scope check.
    this.conversationSandbox = this.selectedSandbox;
    const preference: ConversationPreference = {
      id: conversation.id,
      projectId: conversation.projectId,
      title: conversation.title,
      agentId: conversation.agentId,
      sandboxName: this.conversationSandbox,
    };
    void this.context.workspaceState.update(UI_KEYS.conversation, preference);
    this.emit();
  }

  private projectOf(conversation: Pick<Conversation, 'projectId'>): Project | undefined {
    return this.projects.find((p) => p.id === conversation.projectId);
  }

  private static readonly PROJECT_ARCHIVED_REASON = `Core refuses this in an archived project ("${MSG_PROJECT_ARCHIVED}")`;
  private static readonly CONVERSATION_ARCHIVED_REASON = `Core refuses it for an archived conversation ("${MSG_CONVERSATION_ARCHIVED}")`;

  /**
   * Local pre-check in Core's own order (§3.3 item 4): an archived PROJECT
   * first, then (unless allowed) an archived conversation. Shows the refusal
   * with Core's reason and returns true; nothing is sent.
   */
  private refuseConversationEdit(conversation: Conversation, action: string, allowArchivedConversation: boolean): boolean {
    const project = this.projectOf(conversation);
    let text: string | null = null;
    if (project && isArchived(project)) {
      text = `${action} is not available: ${SandpaneSession.PROJECT_ARCHIVED_REASON}. Unarchive the project first. Nothing was sent.`;
    } else if (!allowArchivedConversation && isConversationArchived(conversation)) {
      text = `${action} is not available: ${SandpaneSession.CONVERSATION_ARCHIVED_REASON}. Unarchive it first. Nothing was sent.`;
    }
    if (text === null) return false;
    void vscode.window.showWarningMessage(text);
    this.setStatus('error', text);
    this.emit();
    return true;
  }

  /** Why the composer cannot send right now (Core's own reason), or null. */
  private composerBlockedReason(): string | null {
    const project = this.projects.find((p) => p.id === this.selectedProjectId);
    if (project && isArchived(project)) {
      return `Sending is disabled: Core refuses sends in an archived project ("${MSG_PROJECT_ARCHIVED}"). Unarchive the project first.`;
    }
    if (this.conversation && isConversationArchived(this.conversation)) {
      return (
        `Sending is disabled: Core refuses sends to an archived conversation ("${MSG_CONVERSATION_ARCHIVED}"). ` +
        'Unarchive it, or choose "New conversation". Its history stays readable.'
      );
    }
    return null;
  }

  /** Core's exact A3b/A3a refusals get honest copy; no answer = UNKNOWN + re-read. */
  private reportConversationError(error: unknown, operation: string): void {
    if (isUnknownOutcome(error)) {
      this.reportError(
        error,
        operation,
        'Outcome UNKNOWN: Core did not confirm whether this changed anything. Re-reading the conversation list from Core; not retried.',
      );
    } else {
      this.reportError(error, operation, conversationErrorCopy(error) ?? projectErrorCopy(error) ?? undefined);
    }
    void this.refreshConversations();
  }

  private async conversationMutation(
    method: CoreMethodName,
    run: () => Promise<Conversation>,
    done: (updated: Conversation) => string,
  ): Promise<Conversation | undefined> {
    try {
      const updated = await run();
      const listed = await this.refreshConversations();
      this.setStatus('ok', done(updated) + (listed ? '' : ' (the conversation list could not be re-read; it may be stale)'));
      this.emit();
      return updated;
    } catch (error) {
      this.reportConversationError(error, method);
      return undefined;
    }
  }

  /**
   * Rename (A3b): gated on the probe; disabled with Core's reason on an
   * archived project / conversation (nothing sent); a native input box whose
   * validator mirrors Core exactly (incl. the whitespace-only refusal).
   */
  async renameConversation(id: string): Promise<Conversation | undefined> {
    const conversation = this.listedConversation(id, 'Rename conversation');
    if (!conversation) return undefined;
    if (!(await this.ensureAdvertised('conversation.rename', 'Rename conversation'))) return undefined;
    if (this.refuseConversationEdit(conversation, 'Rename conversation', false)) return undefined;
    // A stored title from before A3b may hold characters Core now refuses (or
    // hides): never prefill those into an editable field.
    const prefill = conversationTitleProblem(conversation.title) === undefined ? conversation.title : '';
    const title = await vscode.window.showInputBox({
      title: `Rename conversation "${plainText(conversation.title, 200)}"`,
      prompt: 'New title (1–200 characters, one line; Core stores it exactly as typed)',
      value: prefill,
      validateInput: conversationTitleProblem,
    });
    if (title === undefined || title === conversation.title) {
      this.setStatus('info', 'Rename cancelled — nothing was sent.');
      this.emit();
      return undefined;
    }
    try {
      validateConversationRenameTitle(title);
    } catch (error) {
      this.reportError(error, 'conversation.rename', 'Nothing was sent.');
      return undefined;
    }
    return this.conversationMutation(
      'conversation.rename',
      () => this.commands.conversationRename({ conversationId: conversation.id, title }),
      (c) => `Conversation renamed to "${plainText(c.title, 200)}" in Core.`,
    );
  }

  /** Archive (A3b): allowed in an archived project too; idempotent in Core. */
  async archiveConversation(id: string): Promise<Conversation | undefined> {
    const conversation = this.listedConversation(id, 'Archive conversation');
    if (!conversation) return undefined;
    if (!(await this.ensureAdvertised('conversation.archive', 'Archive conversation'))) return undefined;
    const wasSelected = this.conversation?.id === conversation.id;
    return this.conversationMutation(
      'conversation.archive',
      () => this.commands.conversationArchive(conversation.id),
      (c) => {
        const base = `Conversation "${plainText(c.title, 200)}" archived in Core — Core now refuses sends and renames for it until it is unarchived; its history stays readable.`;
        if (this.showArchivedConversations) return base;
        return `${base} It is hidden from the list${wasSelected ? ' and was deselected' : ''}; turn on "Show archived" to see it.`;
      },
    );
  }

  /** Unarchive (A3b): refused locally in an archived project (Core's reason). */
  async unarchiveConversation(id: string): Promise<Conversation | undefined> {
    const conversation = this.listedConversation(id, 'Unarchive conversation');
    if (!conversation) return undefined;
    if (!(await this.ensureAdvertised('conversation.unarchive', 'Unarchive conversation'))) return undefined;
    if (this.refuseConversationEdit(conversation, 'Unarchive conversation', true)) return undefined;
    return this.conversationMutation(
      'conversation.unarchive',
      () => this.commands.conversationUnarchive(conversation.id),
      (c) => `Conversation "${plainText(c.title, 200)}" unarchived in Core.`,
    );
  }

  /**
   * Forget every client-side reference to a deleted conversation (UI state
   * only): the list row, the selection and its stored preference, and the
   * deleted tasks still painted (the view is re-hydrated from Core).
   */
  private async forgetConversation(id: string): Promise<void> {
    this.conversations = this.conversations.filter((c) => c.id !== id);
    if (this.conversation?.id === id) {
      this.conversation = null;
      this.conversationSandbox = null;
      void this.context.workspaceState.update(UI_KEYS.conversation, undefined);
    }
    // `taskList` hydration merges, so the deleted conversation's tasks would
    // stay painted: reset the task view and re-read it from Core.
    this.stopFeed();
    this.view = EMPTY_STATE;
    await this.reloadScope();
  }

  /**
   * `conversation.delete` (A3b) with the A1 two-step pattern: step 1 → native
   * modal (title, id, capped impact, expiry) → only "Delete conversation",
   * re-checked for expiry at click time (fail closed), sends step 2 with the
   * token. Cancel sends nothing. Neither step is retried; the token is never
   * logged or shown. `external` is always false for conversations.
   */
  async deleteConversation(id: string): Promise<boolean> {
    return this.singleFlight('Delete conversation', () => this.deleteConversationOnce(id));
  }

  /** The conversation delete/export currently running (one at a time), if any. */
  private conversationOpInFlight: string | null = null;

  /**
   * Delete and export are single-flight: a second one while one runs is
   * refused visibly and sends nothing (no second step-1 request, no second
   * page loop). The guard is taken synchronously, before any await.
   */
  private async singleFlight(action: string, work: () => Promise<boolean>): Promise<boolean> {
    if (this.conversationOpInFlight !== null) {
      const text = `${action}: "${this.conversationOpInFlight}" is already in progress; wait for it to finish. Nothing was sent.`;
      void vscode.window.showWarningMessage(text);
      this.setStatus('info', text);
      this.emit();
      return false;
    }
    this.conversationOpInFlight = action;
    try {
      return await work();
    } finally {
      this.conversationOpInFlight = null;
    }
  }

  private async deleteConversationOnce(id: string): Promise<boolean> {
    const conversation = this.listedConversation(id, 'Delete conversation');
    if (!conversation) return false;
    if (!(await this.ensureAdvertised('conversation.delete', 'Delete conversation'))) return false;
    let confirmation: ConfirmationRequest;
    try {
      confirmation = await this.commands.conversationDeleteRequest(conversation.id);
    } catch (error) {
      // Step 1 changes nothing in Core, whatever happened.
      this.reportError(
        error,
        'conversation.delete (confirmation request)',
        conversationErrorCopy(error) ?? projectErrorCopy(error) ?? 'Nothing was deleted.',
      );
      return false;
    }
    const view = conversationDeleteView(confirmation, this.now());
    const answer = await vscode.window.showWarningMessage(view.message, { modal: true, detail: view.detail }, DELETE_CONVERSATION_BUTTON);
    if (answer !== DELETE_CONVERSATION_BUTTON) {
      this.setStatus('info', 'Delete not confirmed — nothing was sent; the confirmation expires on its own.');
      this.emit();
      return false;
    }
    const expiresAt = Date.parse(confirmation.expiresAt);
    if (!Number.isFinite(expiresAt) || this.now() >= expiresAt) {
      this.setStatus('info', 'Confirmation expired — nothing was sent; run Delete Conversation again.');
      this.emit();
      return false;
    }
    let deleted: boolean;
    try {
      const result = await this.commands.conversationDeleteConfirm(conversation.id, confirmation.token);
      deleted = result.deleted === true;
    } catch (error) {
      if (isUnknownOutcome(error)) {
        this.reportError(
          error,
          'conversation.delete',
          'Outcome UNKNOWN: Core did not confirm whether the conversation was deleted. Re-reading the conversation list (including archived) from Core; not retried.',
        );
        // A Core-answered INTERNAL means Core finished that request; a
        // timeout / closed / failed write means it may still be running.
        await this.settleConversationDelete(conversation, error instanceof CoreRpcError);
        return false;
      }
      this.reportError(error, 'conversation.delete', conversationErrorCopy(error, { delete: true }) ?? projectErrorCopy(error) ?? undefined);
      // Core says the conversation no longer exists (deleted elsewhere): drop
      // it from UI state exactly as a confirmed delete does.
      if (isConversationNotFound(error)) await this.forgetConversation(conversation.id);
      await this.refreshConversations();
      this.emit();
      return false;
    }
    if (deleted) {
      await this.forgetConversation(conversation.id);
      const listed = await this.refreshConversations();
      this.setStatus(
        'ok',
        `Core deleted conversation "${plainText(confirmation.target.name, 200)}" (its Core records only: messages, tasks and their events, artifacts and verification records; host files, worktrees, branches and sandboxes were not touched).` +
          (listed ? '' : ' (the conversation list could not be re-read; it may be stale)'),
      );
    } else {
      this.setStatus('error', 'Core did not report the deletion — its state is unknown; re-reading the conversation list.');
      await this.settleConversationDelete(conversation, true);
    }
    this.emit();
    return deleted;
  }

  /**
   * After an unknown delete outcome, let Core's own list (scoped to the
   * conversation's project, archived included) say what it shows NOW. "It
   * was not deleted" only when Core answered the step-2 request; absence from
   * a FULL page proves nothing, so the outcome then stays UNKNOWN.
   */
  private async settleConversationDelete(conversation: Conversation, coreFinished: boolean): Promise<void> {
    // Without `conversation.archive` the re-read is LIVE-only: an absent row
    // may be archived rather than deleted, so absence proves nothing then.
    const includesArchived = this.coreAdvertises('conversation.archive');
    let all: Conversation[];
    try {
      all = await this.commands.conversationList({
        projectId: conversation.projectId,
        limit: SETTLE_LIST_LIMIT,
        ...(includesArchived ? { includeArchived: true } : {}),
      });
    } catch (error) {
      this.log(`conversation.list after an unknown delete failed: ${describe(error)}`);
      this.setStatus(
        'error',
        'The conversation list could not be re-read after the unknown outcome; whether the conversation was deleted is UNKNOWN.',
      );
      this.emit();
      return;
    }
    if (all.some((c) => c.id === conversation.id)) {
      this.setStatus(
        'info',
        coreFinished
          ? 'Core still lists the conversation as of this re-read — it was not deleted (Core answered the delete request, so that request has finished).'
          : 'Core still lists the conversation as of this re-read. Core never answered the delete request, so it may still finish — re-read before acting; not retried.',
      );
    } else if (all.length >= SETTLE_LIST_LIMIT) {
      this.setStatus(
        'error',
        `Core's re-read returned a full page (${SETTLE_LIST_LIMIT} conversations) without this one — absence from a full page proves nothing; whether it was deleted is still UNKNOWN.`,
      );
    } else if (!includesArchived) {
      // Keep every local reference (and skip the live-only list refresh, which
      // would drop the selection on the same non-proof).
      this.setStatus(
        'error',
        'Core\'s re-read lists live conversations only (this Core does not advertise conversation.archive), so its absence proves nothing; whether it was deleted is still UNKNOWN.',
      );
      this.emit();
      return;
    } else {
      await this.forgetConversation(conversation.id);
      this.setStatus('info', 'Core no longer lists this conversation; the outcome of this request was not confirmed.');
    }
    await this.refreshConversations();
    this.emit();
  }

  /**
   * `conversation.export` (A3b): every page is read and checked first (any page
   * failure → no file, no dialog); then the native save dialog proposes
   * `<redacted-title>-export.json`; the ONE JSON document is written only to
   * the URI the user chose. Cancel writes nothing. The content is never logged.
   */
  async exportConversation(id: string): Promise<boolean> {
    return this.singleFlight('Export conversation', () => this.exportConversationOnce(id));
  }

  private async exportConversationOnce(id: string): Promise<boolean> {
    const conversation = this.listedConversation(id, 'Export conversation');
    if (!conversation) return false;
    if (!(await this.ensureAdvertised('conversation.export', 'Export conversation'))) return false;
    this.setStatus('info', `Exporting "${plainText(conversation.title, 200)}" from Core (redacted by Core). ${EXPORT_BEST_EFFORT_COPY}`);
    this.emit();
    const outcome = await collectConversationExport(conversation.id, (afterSequence) =>
      this.commands.conversationExport({ conversationId: conversation.id, afterSequence }),
    );
    if (!outcome.ok) {
      const copy = conversationErrorCopy(outcome.error);
      this.reportError(outcome.error, 'conversation.export', `No file was written.${copy ? ` ${copy}` : ''}`);
      return false;
    }
    const { file } = outcome;
    const partial =
      outcome.incomplete === null
        ? ''
        : outcome.incomplete === 'page-cap'
          ? ` PARTIAL: stopped after ${outcome.pages} pages (the client's page cap); later messages are not included.`
          : ' PARTIAL: Core\'s paging cursor stopped advancing; later messages may be missing.';
    const kinds = Object.entries(file.redaction.byKind)
      .map(([kind, count]) => `${plainText(kind, 64)}: ${count}`)
      .join(', ');
    const counts =
      `${file.messages.length} message(s), ${file.redaction.replacements} redaction replacement(s)` +
      (kinds.length > 0 ? ` (${kinds})` : '');
    const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.scheme === 'file');
    const defaultUri = vscode.Uri.file(join(folder?.uri.fsPath ?? homedir(), exportFileName(file.conversation.title)));
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { JSON: ['json'] },
      saveLabel: 'Save redacted export',
      title: `Save redacted export — ${counts}.${partial} ${EXPORT_BEST_EFFORT_COPY}`,
    });
    if (!target) {
      this.setStatus('info', 'Export not saved — nothing was written.');
      this.emit();
      return false;
    }
    try {
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`));
    } catch (error) {
      this.reportError(error, 'conversation.export (write)', 'The export could not be written to the chosen file.');
      return false;
    }
    // Counts only — the export content is never logged.
    this.log(`conversation.export wrote ${file.messages.length} message(s), complete=${file.complete}`);
    const text = `Redacted export written to ${plainText(target.fsPath, 500)}: ${counts}.${partial} ${EXPORT_BEST_EFFORT_COPY}`;
    this.setStatus(outcome.incomplete === null ? 'ok' : 'info', text);
    void vscode.window.showInformationMessage(text);
    this.emit();
    return true;
  }

  /** One row's action states: enabled, or disabled with the reason shown. */
  private conversationActionStates(conversation: Conversation): Record<ConversationAction, ConversationActionState> {
    const unsupported = (method: CoreMethodName): string | null =>
      this.capabilities === null
        ? 'Core is not attached'
        : this.coreAdvertises(method)
          ? null
          : `not supported by the attached Sandpane Core (it does not advertise "${method}")`;
    const state = (reason: string | null): ConversationActionState => ({ enabled: reason === null, reason });
    const project = this.projectOf(conversation);
    const projectArchived = project !== undefined && isArchived(project);
    const archived = isConversationArchived(conversation);
    const projectReason = `${SandpaneSession.PROJECT_ARCHIVED_REASON}; unarchive the project first`;
    const conversationReason = `${SandpaneSession.CONVERSATION_ARCHIVED_REASON}; unarchive it first`;
    return {
      rename: state(unsupported('conversation.rename') ?? (projectArchived ? projectReason : archived ? conversationReason : null)),
      archive: state(unsupported('conversation.archive') ?? (archived ? 'already archived' : null)),
      unarchive: state(unsupported('conversation.unarchive') ?? (!archived ? 'not archived' : projectArchived ? projectReason : null)),
      export: state(unsupported('conversation.export')),
      delete: state(unsupported('conversation.delete')),
    };
  }

  private conversationListView(): ConversationListView {
    const listAdvertised = this.coreAdvertises('conversation.list');
    const archiveAdvertised = this.coreAdvertises('conversation.archive');
    const showArchived = this.showArchivedConversations && archiveAdvertised;
    const featureAdvertised = this.coreHasFeature('conversation-sandbox-id');
    const sandboxNames = this.sandboxListRead ? this.sandboxes.map((s) => s.name) : null;
    const rows = this.conversations.map((conversation) => {
      const archived = isConversationArchived(conversation);
      return {
        id: conversation.id,
        title: plainText(conversation.title, 200),
        archived,
        selected: this.conversation?.id === conversation.id,
        sandboxLabel: conversationSandboxLabel(conversation, featureAdvertised, sandboxNames),
        statusNote: archived
          ? `${ARCHIVED_CONVERSATION_LABEL} — send and rename are disabled: Core says "${MSG_CONVERSATION_ARCHIVED}". Its history stays readable.`
          : null,
        actions: this.conversationActionStates(conversation),
      };
    });
    const note =
      this.capabilities === null
        ? null
        : !listAdvertised
          ? 'This Core does not advertise conversation.list — conversations cannot be listed (no fake list).'
          : this.selectedProjectId === null
            ? 'Select a project to list its conversations.'
            : rows.length === 0
              ? showArchived
                ? 'Core lists no conversation for this project.'
                : 'Core lists no live conversation for this project (archived ones are hidden).'
              : null;
    return {
      supported: listAdvertised && this.selectedProjectId !== null,
      note,
      showArchived,
      showArchivedSupported: archiveAdvertised,
      rows,
    };
  }

  // -----------------------------------------------------------------------
  // Core operations (each is a typed RPC)
  // -----------------------------------------------------------------------

  /**
   * Reload from Core; (re)connects first when not online (the hook then loads).
   * `background` (the auto-refresh timer) re-reads everything EXCEPT
   * `project.context`, which is read on a project load, a reconnect, an
   * explicit refresh or the Approve-suggestion action only (review I4).
   */
  async refresh(options: { background?: boolean } = {}): Promise<void> {
    if (options.background !== true) this.verificationContextDue = true;
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
    const results = await Promise.allSettled([
      this.commands.projectList(this.projectListParams()),
      this.commands.sandboxList(),
    ]);
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
    this.sandboxListRead = sandboxes.status === 'fulfilled';
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
    // A7: another project's commands and suggestions are never shown here.
    this.verificationContextDue = true;
    this.verificationCommands = [];
    this.verificationContext = null;
    this.verificationNote = null;
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
        conversations = await this.commands.conversationList(this.conversationListParams(projectId));
        listed = true;
      } catch (error) {
        this.log(`conversation.list failed: ${describe(error)}`);
      }
      if (this.selectedProjectId !== projectId) return; // stale answer (W1)
      this.applyConversationList(conversations, listed);
    } else {
      this.conversations = [];
      this.log(
        'conversation.list not advertised by this Core — chat history cannot be enumerated (no fake list)',
      );
    }

    // A7: not awaited — `project.context` may take up to its 45 s deadline,
    // and the tasks and events must not wait for it. It repaints when it lands.
    void this.hydrateVerification(projectId).then(() => this.emit());
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
    this.noteKeySent(spec.idempotencyKey);
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
      // V-W3: Core's "repository busy" CONFLICT is not a task-state or keyed
      // conflict: own copy, Core's text kept, no "Re-read task state" and no
      // "Retry safely".
      const busy = createBusyCopy(error);
      if (busy !== null) {
        const said = error instanceof Error ? plainText(error.message, 2_000).replace(/\$\(/g, '$ (') : '';
        void vscode.window.showErrorMessage(`sandbox.create \u2014 ${busy}\n\nCore said: ${said}`);
        this.setStatus('error', `sandbox.create: ${busy}`);
        this.log(`sandbox.create refused (repository busy): ${said}`);
        this.emit();
        return undefined;
      }
      this.reportKeyedFailure(
        error,
        'sandbox.create',
        spec.idempotencyKey,
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
    key: string | undefined,
    priorUnknown: boolean,
    attempt: () => Promise<unknown>,
    reread: () => Promise<unknown>,
  ): void {
    const keyed = key !== undefined;
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
    this.offerSafeRetry(operation, error, unsentRetry, attempt, key);
  }

  /** When each idempotency key was FIRST sent (memory only; pruned after Core's retention). */
  private readonly keyFirstSentAt = new Map<string, number>();

  private noteKeySent(key: string | undefined): void {
    if (key === undefined || this.keyFirstSentAt.has(key)) return;
    const now = this.now();
    for (const [stored, at] of this.keyFirstSentAt) {
      if (now - at > IDEMPOTENCY_RETENTION_MS) this.keyFirstSentAt.delete(stored);
    }
    if (this.keyFirstSentAt.size >= 1024) {
      const oldest = this.keyFirstSentAt.keys().next().value;
      if (oldest !== undefined) this.keyFirstSentAt.delete(oldest);
    }
    this.keyFirstSentAt.set(key, now);
  }

  /** "Retry safely" only within 23 h of the key's first send (Core keeps keys 24 h). */
  private retryWindowOpen(key: string | undefined): boolean {
    return safeRetryWindowOpen(key === undefined ? undefined : this.keyFirstSentAt.get(key), this.now());
  }

  private tooLateToRetry(operation: string): void {
    const text =
      `${operation} — Too late to retry safely: this request was first sent more than 23 hours ago and Core keeps ` +
      'idempotency keys for 24 hours, so a retry could run it twice. The earlier request may have run; check state ' +
      'before trying again. Nothing was sent.';
    void vscode.window.showErrorMessage(text);
    this.setStatus('error', text);
    this.emit();
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
    key: string | undefined,
  ): void {
    if (!this.retryWindowOpen(key)) {
      this.tooLateToRetry(operation);
      return;
    }
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
      if (choice === RETRY_SAFELY) void this.retryKeyed(operation, attempt, key);
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
  private async retryKeyed(operation: string, attempt: () => Promise<unknown>, key: string | undefined): Promise<void> {
    // The window is re-checked at click time: the notification may have sat for hours.
    if (!this.retryWindowOpen(key)) {
      this.tooLateToRetry(operation);
      return;
    }
    try {
      if (this.connection.connectionState !== 'online') await this.connection.connect();
      this.capabilities = await this.commands.systemProbe();
    } catch (error) {
      this.offerSafeRetry(operation, error, true, attempt, key);
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
      this.sandboxListRead = true;
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
      this.sandboxListRead = true;
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
    // A7: catch up Core's events first, so a run started elsewhere is named.
    if (this.verificationSupported()) await this.catchUpNow();
    const confirm = stopConfirmation(validName, await this.activeTasksIn(validName), this.verificationRunningIn(validName));
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
      this.reportError(
        error,
        'sandbox.remove (confirmation request)',
        sandboxVerificationRunningCopy(error) ?? 'Nothing was removed.',
      );
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
      const context = sandboxVerificationRunningCopy(error) ?? (
        code === 'VALIDATION_FAILED'
          ? 'Core refused the confirmation (wrong, expired or already used). Nothing was removed — run Remove again for a fresh confirmation.'
          : code === 'CONFLICT'
            ? 'Core reported a conflict: another operation on this sandbox is in progress, or a different ' +
              'sandbox now carries this name (same-named replacement) — see Core\'s message. Nothing was ' +
              'removed; run Remove again for a fresh confirmation.'
            : code === 'NOT_FOUND'
              ? 'The sandbox disappeared between the confirmation and the removal.'
              : null);
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
      // Core starts filling `sandboxName` is the count meaningful. A4's
      // `chosenSandboxName` is deliberately NOT read: it is the name a chat
      // chose, not where a task runs (design §3.4 item 3).
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
    mode: SendMode = 'task',
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
    const run = this.sendGuarded(text, writable, planId, origin, mode).finally(() => {
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
    mode: SendMode,
  ): Promise<void> {
    // A3b: an archived project / conversation — Core would refuse the send;
    // say so with Core's own reason and send nothing.
    const blocked = this.composerBlockedReason();
    if (blocked !== null) {
      this.setStatus('error', `Not sent: ${blocked}`);
      this.emit();
      return;
    }
    // A4: Discuss is never silently downgraded to Task — refused instead.
    if (mode === 'discuss') {
      const refusal = writable
        ? DISCUSS_NOT_WRITABLE
        : this.coreHasFeature(SEND_MODE_FEATURE)
          ? null
          : DISCUSS_NOT_ADVERTISED;
      if (refusal !== null) {
        this.setStatus('error', `Not sent: ${refusal}`);
        this.emit();
        return;
      }
    }
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
    if (mode === 'discuss' && !(await this.sendModeStillAdvertised())) return;
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
          // A3b: Core validates titles with `Validator::conversation_title`
          // (no \n / \t / bidi controls): derive one valid line, or '' for
          // Core's "Untitled conversation".
          title: titleFromMessage(text),
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
    // A4 (review I1): a reconnect may have landed between the re-probe and
    // here (the cache is refreshed on every load). A Discuss send goes only to
    // a Core that still advertises send mode — refused, never downgraded.
    if (mode === 'discuss' && !this.coreHasFeature(SEND_MODE_FEATURE)) {
      this.setStatus('error', `Not sent: ${DISCUSS_NOT_ADVERTISED}`);
      this.emit();
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
        // A4: Task travels as no key (identical to A2/A3b frames).
        ...(mode === 'discuss' ? { mode: 'discuss' as const } : {}),
      },
      { scopeProjectId, sentPlanId, origin },
    );
  }

  /**
   * A4 send-time gate for Discuss: attach if needed and re-probe THIS Core —
   * the cached probe may predate a reconnect to a pre-A4 build, which would
   * drop `mode` and record the discussion as a task. Runs before any
   * conversation is created, so a refusal leaves nothing behind.
   */
  private async sendModeStillAdvertised(): Promise<boolean> {
    try {
      if (this.connection.connectionState !== 'online') await this.connection.connect();
      this.capabilities = await this.commands.systemProbe();
    } catch (error) {
      this.reportError(error, 'system.probe', 'Not sent: the send mode could not be checked with Core.');
      return false;
    }
    if (this.coreHasFeature(SEND_MODE_FEATURE)) return true;
    this.setStatus('error', `Not sent: ${DISCUSS_NOT_ADVERTISED}`);
    this.emit();
    return false;
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
    this.noteKeySent(params.idempotencyKey);
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
        params.idempotencyKey,
        priorUnknown,
        () => this.retrySend(params, ctx),
        () => this.reloadScope(),
      );
      // A3b: Core refused because the conversation was archived (or deleted)
      // elsewhere — re-read so the list and composer show Core's state.
      if (conversationErrorCopy(error) !== null) void this.refreshConversations();
    }
  }

  /** "Retry safely" for a send: same params and key, under the one-send guard. */
  private async retrySend(
    params: ConversationSendParams,
    ctx: { scopeProjectId: string | null; sentPlanId: number; origin: 'sidebar' | 'command' },
  ): Promise<void> {
    // A4: `retryKeyed` re-probed THIS Core just now. A send that carries
    // `mode` is resent only to a Core that honours it — never stripped of it
    // (that would change the request under the same key).
    if (params.mode !== undefined && !this.coreHasFeature(SEND_MODE_FEATURE)) {
      void vscode.window.showErrorMessage(RETRY_MODE_NOT_ADVERTISED);
      this.setStatus('error', RETRY_MODE_NOT_ADVERTISED);
      this.emit();
      return;
    }
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
      // A5: exact paths may carry a real tab / newline — never trusted as text.
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
        ...changeSetNotes(changeSet),
        refused.length > 0
          ? `${refused.length} not shown: ${refused.map((r) => `${plainText(r.path, 300)} (${r.reason})`).join('; ')}`
          : null,
      ].filter((s): s is string => s !== null);
      this.setStatus('info', notes.join(' · '));
      this.emit();
      return changeSet;
    } catch (error) {
      this.reportError(error, 'git.review', gitErrorCopy(error, 'git.review') ?? undefined);
      return undefined;
    }
  }

  /** A5: in-memory backing store of the read-only `sandpane-diff:` documents. */
  readonly patchDocuments = new PatchDocumentStore();

  /**
   * A5 "Diff" for one file of a task: `git.review` (exact change list) → the
   * user picks one entry → `git.diff {taskId, path, status}` with the entry's
   * path byte-exact → a read-only virtual document (`sandpane-diff:`, `diff`
   * language). Display only: nothing is written, applied or run; no temp
   * file. Gated on a fresh `git.diff` advertisement before any frame.
   * Returns true only when a patch document was opened.
   */
  async showTaskPatch(taskId: string): Promise<boolean> {
    if (!(await this.ensureAdvertised('git.diff', 'Show task patch'))) return false;
    let changeSet: ChangeSet;
    try {
      changeSet = await this.commands.gitReview(taskId);
    } catch (error) {
      this.reportError(error, 'git.review', gitErrorCopy(error, 'git.review') ?? undefined);
      return false;
    }
    const notes = changeSetNotes(changeSet);
    if (changeSet.changes.length === 0) {
      this.setStatus(
        'info',
        ['Core lists no changed file for this task, so there is no patch to show', ...notes].join(' \u00b7 '),
      );
      this.emit();
      return false;
    }
    const picked = await vscode.window.showQuickPick(
      changeSet.changes.map((change) => ({
        label: changeLabel(change),
        description: change.status,
        change,
      })),
      {
        title: `Show the patch of one file (task ${taskId.slice(0, 8)}) \u2014 read-only, from Core's git.diff`,
        placeHolder: notes.length > 0 ? notes.join(' \u00b7 ') : 'Pick a file from the change list Core reported',
        matchOnDescription: true,
      },
    );
    if (!picked) {
      this.setStatus('info', 'No file picked; nothing was requested.');
      this.emit();
      return false;
    }
    let raw: unknown;
    try {
      raw = await this.commands.gitDiff({ taskId, path: picked.change.path, status: picked.change.status });
    } catch (error) {
      this.reportError(error, 'git.diff', gitErrorCopy(error, 'git.diff') ?? undefined);
      return false;
    }
    const result = parseGitDiffResult(raw);
    if (!result) {
      void vscode.window.showErrorMessage(`git.diff \u2014 ${MALFORMED_DIFF_COPY}`);
      this.setStatus('error', `git.diff: ${MALFORMED_DIFF_COPY}`);
      this.log('git.diff answer failed the shape check (payload not logged)');
      this.emit();
      return false;
    }
    // A6: what the user saw (content id, binary/truncated/lossy) — memory only,
    // per Core instance; the apply confirmation and mismatch rule read it.
    this.reviewedDiffs.sync(this.capabilities?.instanceId ?? null);
    this.reviewedDiffs.record(taskId, result);
    const rendered = renderPatchDocument({ taskId, result, maxBytes: DEFAULT_DIFF_BYTES });
    const { path } = this.patchDocuments.put(result.path, rendered.text);
    try {
      const uri = vscode.Uri.from({ scheme: PATCH_SCHEME, path });
      let document = await vscode.workspace.openTextDocument(uri);
      if (document.languageId !== 'diff') document = await vscode.languages.setTextDocumentLanguage(document, 'diff');
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      this.reportError(error, 'open patch view', 'The patch was received but the read-only view could not be opened.');
      return false;
    }
    const flags = [
      result.binary ? 'binary' : null,
      result.truncated ? 'truncated' : null,
      result.lossy ? 'lossy' : null,
    ].filter((f): f is string => f !== null);
    this.setStatus(
      'info',
      `Patch of ${changeLabel(result)} opened read-only${flags.length > 0 ? ` (${flags.join(', ')} \u2014 see the header)` : ''}`,
    );
    this.emit();
    return true;
  }

  /** A6: the `git.diff` answers the user opened this session (memory only). */
  readonly reviewedDiffs = new ReviewedDiffs();
  /** A6 V-W1: in-memory backing store of the read-only `sandpane-apply:` full lists. */
  readonly applyListDocuments = new PatchDocumentStore(APPLY_LIST_GONE_TEXT, '.txt');
  /** A6: one apply flow at a time — review, pick, modal and Core's answer. */
  private applyInFlight = false;

  /**
   * A6 Apply (design 2026-10-09 §3.6): an explicit, confirmed Git operation
   * through Core, never a file write by this client. Reached ONLY from a user
   * gesture: the `sandpane.applyTask` command, the sidebar's Apply button, or
   * the "Review again" button of an earlier apply notification — never from
   * chat / agent / tool text, a timer, a poll or a reconnect.
   *
   * Flow: fresh probe (`git.apply` + feature `git-apply`) → ONE `git.review`
   * → the user picks applicable entries → native modal (repository, every
   * file, flags (a)/(b)/(c), the binding sentence) → only "Apply N files"
   * sends `git.apply {taskId, expectedBase, reviewId, entries}` with the
   * entries copied verbatim. Single-flight; never retried ("Retry safely" is
   * not offered: Core gives no idempotency for git.apply).
   */
  async applyTask(taskId: string): Promise<void> {
    if (this.applyInFlight) {
      void vscode.window.showWarningMessage(APPLY_IN_FLIGHT);
      this.setStatus('info', APPLY_IN_FLIGHT);
      this.emit();
      return;
    }
    this.applyInFlight = true;
    this.emit();
    let followUp: ApplyOutcomeView | null = null;
    try {
      followUp = await this.runApply(taskId);
    } finally {
      this.applyInFlight = false;
      this.emit();
    }
    if (followUp) this.presentApplyOutcome(taskId, followUp);
  }

  /** One apply flow; returns the notification to show once it has ended. */
  private async runApply(taskId: string): Promise<ApplyOutcomeView | null> {
    if (!(await this.ensureAdvertised('git.apply', 'Apply task changes'))) return null;
    if (!this.coreHasFeature(GIT_APPLY_FEATURE)) {
      void vscode.window.showWarningMessage(APPLY_NOT_IMPLEMENTED);
      this.setStatus('error', APPLY_NOT_IMPLEMENTED);
      this.emit();
      return null;
    }
    const instanceAtReview = this.capabilities?.instanceId ?? null;
    this.reviewedDiffs.sync(instanceAtReview);
    let raw: unknown;
    try {
      raw = await this.commands.gitReview(taskId);
    } catch (error) {
      const copy = gitErrorCopy(error, 'git.review');
      this.reportError(error, 'git.review (for apply)', copy ? `${copy} Nothing was sent to git.apply.` : undefined);
      return null;
    }
    const changeSet = parseApplyChangeSet(raw);
    if (!changeSet) {
      void vscode.window.showErrorMessage(`git.review \u2014 ${MALFORMED_REVIEW}`);
      this.setStatus('error', `git.review: ${MALFORMED_REVIEW}`);
      this.log('git.review answer failed the apply shape check (payload not logged)');
      this.emit();
      return null;
    }
    const notes = changeSetNotes(changeSet);
    if (changeSet.changes.length === 0) {
      this.setStatus('info', ['Core lists no changed file for this task, so there is nothing to apply; nothing was sent', ...notes].join(' \u00b7 '));
      this.emit();
      return null;
    }
    const reviewId = changeSet.reviewId;
    if (typeof reviewId !== 'string' || reviewId.length === 0) {
      void vscode.window.showWarningMessage(NO_REVIEW_ID);
      this.setStatus('error', NO_REVIEW_ID);
      this.emit();
      return null;
    }
    const diffFor = (change: FileChange) => this.reviewedDiffs.get(taskId, change);
    const plan = applyPickPlan(changeSet, diffFor);
    if (plan.selectable.length === 0) {
      const text =
        `None of the ${changeSet.changes.length} entries Core listed can be applied: ` +
        `${plan.disabled.slice(0, 10).map((d) => `${plainChangeLabel(d.entry)} (${d.reason})`).join('; ')}` +
        `${plan.disabled.length > 10 ? ` (and ${plan.disabled.length - 10} more)` : ''}. Nothing was sent.`;
      void vscode.window.showWarningMessage(text);
      this.setStatus('error', text);
      this.emit();
      return null;
    }
    const picks = await vscode.window.showQuickPick(
      plan.items.map((item) => ({
        label: item.label,
        ...(item.description !== undefined ? { description: item.description } : {}),
        picked: false,
        // The header above the rows that cannot be applied.
        ...(item.separator ? { kind: vscode.QuickPickItemKind.Separator } : {}),
        entry: item.entry,
        applicable: item.applicable,
      })),
      {
        canPickMany: true,
        ignoreFocusOut: true,
        matchOnDescription: true,
        // Core text in a QuickPick goes through labelText (`$(` broken).
        title: labelText(
          `Apply which files of task ${taskId.slice(0, 8)}? (review ${reviewId.slice(0, 8)}; the top checkbox selects all)`,
        ),
        placeHolder: labelText(
          [
            `${plan.selectable.length} of ${changeSet.changes.length} entries can be applied`,
            ...(plan.disabled.length > 0
              ? [`${plan.disabled.length} cannot \u2014 shown last with the reason; checking them sends nothing`]
              : []),
            ...notes,
          ].join(' \u00b7 '),
        ),
      },
    );
    const chosen = new Set((picks ?? []).map((p) => p.entry).filter((e): e is FileChange => e !== undefined));
    // Review order, the ORIGINAL objects (sent verbatim), applicable only.
    const selected = plan.selectable.filter((entry) => chosen.has(entry));
    // Rows that cannot be applied are inert: checked ones are disclosed, never sent.
    const ignored = plan.disabled.filter((d) => chosen.has(d.entry));
    if (selected.length === 0) {
      if (ignored.length > 0) {
        const text = notApplicableCopy(ignored);
        void vscode.window.showWarningMessage(text);
        this.setStatus('error', text);
      } else {
        this.setStatus('info', 'No file selected; nothing was sent.');
      }
      this.emit();
      return null;
    }
    // §3.6 item 9: an opened diff showed other content than the entry binds.
    const mismatched = selected.filter((entry) => diffMismatch(entry, diffFor(entry)));
    if (mismatched.length > 0) {
      // Those records describe content that is gone: the next review flags
      // the entries as not shown instead of refusing forever.
      for (const entry of mismatched) this.reviewedDiffs.forget(taskId, entry);
      const text = mismatchCopy(mismatched);
      this.setStatus('error', text);
      this.emit();
      return { tone: 'error', text, reReview: true };
    }
    const confirmInput = {
      taskId,
      repoPath: changeSet.repoPath,
      hostDirty: changeSet.hostDirty,
      hostHooksPath: changeSet.hostHooksPath,
      entries: selected,
      diffFor,
      ignored,
    };
    const view = applyConfirmationView(confirmInput);
    // V-W1: a list the modal caps is opened in full FIRST (read-only, in memory).
    if (selected.length > MODAL_LIST_CAP) {
      const { path } = this.applyListDocuments.put('apply-list', renderApplyListDocument(confirmInput));
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: APPLY_LIST_SCHEME, path }));
        await vscode.window.showTextDocument(document, { preview: true });
      } catch (error) {
        this.reportError(error, 'open apply list', 'The full list of files could not be shown, so nothing was sent.');
        return null;
      }
    }
    const answer = await vscode.window.showWarningMessage(view.message, { modal: true, detail: view.detail }, view.button);
    if (answer !== view.button) {
      this.setStatus('info', 'Apply not confirmed; nothing was sent.');
      this.emit();
      return null;
    }
    // V-W1: the modal's button may be the default (Enter); a typed number is
    // required on top. Never pre-filled; Escape / focus loss sends nothing.
    const typed = await vscode.window.showInputBox(typedConfirmation(selected.length, changeSet.repoPath));
    if (!typedConfirmed(typed, selected.length)) {
      this.setStatus('info', TYPED_NOT_CONFIRMED);
      this.emit();
      return null;
    }
    // Core keeps reviews in memory: a restart while the modal was open voids it.
    if ((this.capabilities?.instanceId ?? null) !== instanceAtReview) {
      this.setStatus('error', CORE_RESTARTED);
      this.emit();
      return { tone: 'error', text: CORE_RESTARTED, reReview: true };
    }
    let outcome: ApplyOutcomeView;
    try {
      const answered = await this.commands.gitApply({
        taskId,
        expectedBase: changeSet.baseCommit,
        reviewId,
        entries: selected,
      });
      const result = parseApplyResult(answered);
      if (result) {
        outcome = applyResultView(result, { repoPath: changeSet.repoPath, selected: selected.length });
      } else {
        this.log('git.apply answer failed the shape check (payload not logged)');
        outcome = { tone: 'warning', text: malformedApplyCopy(changeSet.repoPath), reReview: false };
      }
    } catch (error) {
      const view = applyErrorView(error, changeSet.repoPath);
      if (!view) {
        // Provably unsent (not attached, untrusted socket …): generic copy.
        this.reportError(error, 'git.apply', 'Nothing was sent to Core, so nothing was applied.');
        return null;
      }
      this.log(`git.apply failed: ${plainText(describe(error), 2_000)}`);
      outcome = view;
    }
    // I2: partial and lost answers are not "info".
    this.setStatus(outcome.tone === 'ok' ? 'ok' : 'error', `git.apply: ${outcome.text}`);
    this.emit();
    await this.refreshReviewAfterApply(taskId, outcome);
    return outcome;
  }

  /**
   * After Core answered (or did not): re-read the review, read-only, so the
   * status shows what Core lists NOW. The touched paths are staged after a
   * success, so a retry is refused by Core's dirty gate — which is correct.
   */
  private async refreshReviewAfterApply(taskId: string, outcome: ApplyOutcomeView): Promise<void> {
    try {
      const fresh = parseApplyChangeSet(await this.commands.gitReview(taskId));
      if (!fresh) return;
      this.setStatus(
        outcome.tone === 'ok' ? 'ok' : 'error',
        `git.apply: ${outcome.text} \u00b7 review refreshed: Core now lists ${fresh.changes.length} changed file(s) for this task`,
      );
      this.emit();
    } catch (error) {
      this.log(`git.review after git.apply failed: ${plainText(describe(error), 2_000)} \u2014 the review was not refreshed`);
    }
  }

  /** The apply notification; "Review again" (a user click) starts a fresh flow. */
  private presentApplyOutcome(taskId: string, view: ApplyOutcomeView): void {
    const buttons = view.reReview ? [REVIEW_AGAIN] : [];
    const shown =
      view.tone === 'ok'
        ? vscode.window.showInformationMessage(view.text, ...buttons)
        : view.tone === 'warning'
          ? vscode.window.showWarningMessage(view.text, ...buttons)
          : vscode.window.showErrorMessage(view.text, ...buttons);
    void Promise.resolve(shown).then((choice) => {
      if (choice === REVIEW_AGAIN) void this.applyTask(taskId);
    });
  }

  // -----------------------------------------------------------------------
  // A7 — verification commands + project.context (design 2026-10-09 §3.7)
  //
  // Every write (approve, revoke, run) is reached ONLY from a user gesture:
  // a contributed command (whose handler ignores its arguments) or a sidebar
  // button (whose message carries no argv, command id or run id). Each opens
  // a dialog filled from a FRESH Core read, then a native modal and a
  // Cancel-first second step. Output is shown in a read-only
  // `sandpane-verification:` document — never a terminal, never Markdown.
  // Verification events are display-only: no task status is derived here.
  // -----------------------------------------------------------------------

  /** A7: in-memory backing store of the read-only `sandpane-verification:` documents. */
  readonly verificationDocuments = new PatchDocumentStore(VERIFICATION_GONE_TEXT, VERIFICATION_EXTENSION);
  /** Core's approved commands of the selected project (display cache, re-read on every load). */
  private verificationCommands: VerificationCommand[] = [];
  private verificationContext: ProjectContextResult | null = null;
  /** Why the section is incomplete (a failed or malformed read), when it is. */
  private verificationNote: string | null = null;
  /** Tasks whose Run flow (dialogs or Core's answer) is open: one per task. */
  private readonly verificationRunsOpening = new Set<string>();
  /** Runs started from this window (runId → revealed label): their finish is announced. */
  private readonly verificationRunsStartedHere = new Map<string, string>();
  /** One approve / revoke dialog at a time. */
  private verificationEditOpen = false;
  /** A9: one Maintenance flow at a time (a second gesture is refused). */
  private maintenanceOpen = false;
  /** Only the newest hydration may write the section (loads can overlap). */
  private verificationGeneration = 0;
  /** `project.context` is due: a project load, an explicit refresh or a reconnect (never the timer). */
  private verificationContextDue = true;
  /** The one `project.context` read in flight (two never overlap). */
  private contextRead: { projectId: string; answer: Promise<unknown> } | null = null;

  /** Single-flight `project.context`: a second caller joins the read in flight for that project. */
  private readProjectContext(projectId: string): Promise<unknown> {
    if (this.contextRead !== null && this.contextRead.projectId === projectId) return this.contextRead.answer;
    const answer = this.commands.projectContext(projectId);
    const entry = { projectId, answer };
    this.contextRead = entry;
    const clear = (): void => {
      if (this.contextRead === entry) this.contextRead = null;
    };
    answer.then(clear, clear);
    return answer;
  }

  /** Core advertises every A7 method AND the feature `verification` (last probe). */
  private verificationSupported(): boolean {
    return VERIFICATION_METHODS.every((method) => this.coreAdvertises(method)) && this.coreHasFeature(VERIFICATION_FEATURE);
  }

  /** Click-time gate: fresh probe; the method, the other A7 methods and the feature. */
  private async ensureVerification(method: CoreMethodName, action: string): Promise<boolean> {
    if (!(await this.ensureAdvertised(method, action))) return false;
    if (!this.verificationSupported()) {
      void vscode.window.showWarningMessage(VERIFICATION_UNSUPPORTED);
      this.setStatus('error', VERIFICATION_UNSUPPORTED);
      this.emit();
      return false;
    }
    return true;
  }

  /**
   * Read-only hydration of the selected project's Verification section. A
   * failure becomes a visible note; only the error CODE is logged (never a
   * label, an argv or a note).
   */
  private async hydrateVerification(projectId: string): Promise<void> {
    const generation = ++this.verificationGeneration;
    if (!this.verificationSupported()) {
      this.verificationCommands = [];
      this.verificationContext = null;
      this.verificationNote = null;
      return;
    }
    const wantContext = this.verificationContextDue;
    this.verificationContextDue = false;
    const [list, context] = await Promise.allSettled([
      this.commands.verificationList(projectId),
      wantContext ? this.readProjectContext(projectId) : Promise.resolve(CONTEXT_NOT_READ),
    ]);
    // A stale answer (another project, or a newer load) never paints (W1).
    if (this.selectedProjectId !== projectId || generation !== this.verificationGeneration) {
      if (wantContext) this.verificationContextDue = true;
      return;
    }
    const notes: string[] = [];
    if (list.status === 'fulfilled') {
      const commands = parseVerificationList(list.value);
      this.verificationCommands = commands ?? [];
      if (commands === null) notes.push(this.malformedVerificationNote('verification.list'));
    } else {
      this.verificationCommands = [];
      notes.push(this.verificationReadNote(list.reason, 'verification.list'));
    }
    if (context.status === 'fulfilled' && context.value === CONTEXT_NOT_READ) {
      // Background refresh: the last suggestions stay (same project).
    } else if (context.status === 'fulfilled') {
      const parsed = parseProjectContext(context.value);
      this.verificationContext = parsed;
      if (parsed === null) notes.push(this.malformedVerificationNote('project.context'));
    } else {
      this.verificationContext = null;
      notes.push(this.verificationReadNote(context.reason, 'project.context'));
    }
    this.verificationNote = notes.length > 0 ? notes.join('\n') : null;
  }

  private verificationReadNote(error: unknown, operation: VerificationOperation): string {
    this.log(`${operation} failed: ${errorCodeOf(error) ?? 'no Core error code'}`);
    const view = verificationErrorView(error, operation);
    return view === null ? `${operation}: Sandpane Core is not attached; nothing was read.` : noIcons(view.text);
  }

  private malformedVerificationNote(operation: VerificationOperation): string {
    this.log(`${operation} answer failed the shape check (payload not logged)`);
    return `${operation}: ${MALFORMED_VERIFICATION}`;
  }

  private async reloadVerification(projectId: string): Promise<void> {
    await this.hydrateVerification(projectId);
    this.emit();
  }

  private notConfirmed(): void {
    this.setStatus('info', NOT_CONFIRMED);
    this.emit();
  }

  private verificationWarning(text: string, tone: 'info' | 'error' = 'error'): void {
    const shown = noIcons(text);
    void vscode.window.showWarningMessage(shown);
    this.setStatus(tone, shown);
    this.emit();
  }

  /** A failed A7 call: honest copy (lost answer / Core refusal); the code only is logged. */
  private reportVerificationFailure(error: unknown, operation: VerificationOperation): void {
    const view = verificationErrorView(error, operation);
    if (view === null) {
      this.reportError(error, operation, 'Nothing was sent to Core.');
      return;
    }
    this.log(`${operation} failed: ${errorCodeOf(error) ?? 'no answer from Core'}`);
    this.showVerificationView(view);
  }

  private showVerificationView(view: VerificationErrorView): void {
    const text = noIcons(view.text);
    if (view.tone === 'warning') void vscode.window.showWarningMessage(text);
    else void vscode.window.showErrorMessage(text);
    // The status line carries the client's own sentence, never Core's text.
    this.setStatus('error', text.split('\n\n')[0] ?? text);
    this.emit();
  }

  private verificationProject(action: string): Project | null {
    const project = this.projects.find((p) => p.id === this.selectedProjectId) ?? null;
    if (!project) {
      this.verificationWarning(`${action}: no project is selected. Nothing was sent.`);
      return null;
    }
    return project;
  }

  /** One approve / revoke dialog at a time (two dialogs could confirm stale lists). */
  private async verificationEdit(work: () => Promise<void>): Promise<void> {
    if (this.verificationEditOpen) {
      this.verificationWarning('Another verification dialog is open; finish it first. Nothing was sent.', 'info');
      return;
    }
    this.verificationEditOpen = true;
    try {
      await work();
    } finally {
      this.verificationEditOpen = false;
    }
  }

  /** Opens `text` as a read-only, plain-text `sandpane-verification:` document. */
  private async openVerificationDocument(name: string, text: string): Promise<boolean> {
    const { path } = this.verificationDocuments.put(name, text);
    try {
      let document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: VERIFICATION_SCHEME, path }));
      if (document.languageId !== VERIFICATION_LANGUAGE) {
        document = await vscode.languages.setTextDocumentLanguage(document, VERIFICATION_LANGUAGE);
      }
      await vscode.window.showTextDocument(document, { preview: true });
      return true;
    } catch (error) {
      this.reportError(error, 'open verification view', 'The read-only view could not be opened, so nothing was sent.');
      return false;
    }
  }

  /**
   * Native modal (every element, warnings), then the A6-style second step
   * with Cancel as the first (active) item. A list the modal cuts is opened
   * in full first. True only for the explicit choice in both.
   */
  private async confirmVerification(view: ConfirmationView, step: string, fullList: () => string): Promise<boolean> {
    if (view.fullList && !(await this.openVerificationDocument('arguments', fullList()))) return false;
    const answer = await vscode.window.showWarningMessage(view.message, { modal: true, detail: view.detail }, view.button);
    if (answer !== view.button) return false;
    const picked = await vscode.window.showQuickPick(confirmStepItems(step), {
      title: view.message,
      placeHolder: 'Cancel is selected; choose the second item to send it to Core.',
      ignoreFocusOut: true,
    });
    return picked?.confirm === true;
  }

  private async askVerificationLabel(projectName: string): Promise<string | undefined> {
    const problem = (value: string): string | null => {
      try {
        validateVerificationLabel(value);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : 'invalid label';
      }
    };
    const typed = await vscode.window.showInputBox({
      title: noIcons(`Verification command for "${plainText(projectName, 120)}" (1/2: label)`),
      prompt: 'A short name for this command (1 to 80 characters). Do not put tokens or passwords in it.',
      ignoreFocusOut: true,
      validateInput: problem,
    });
    if (typed === undefined) return undefined;
    try {
      return validateVerificationLabel(typed);
    } catch (error) {
      this.verificationWarning(`Add verification command: ${error instanceof Error ? error.message : 'invalid label'}. Nothing was sent.`);
      return undefined;
    }
  }

  /** The argv as ONE JSON array of strings: no shell split, glob, quoting or trimming. */
  private async askVerificationArgv(projectName: string, prefill: readonly string[] | null): Promise<string[] | undefined> {
    const typed = await vscode.window.showInputBox({
      title: noIcons(`Verification command for "${plainText(projectName, 120)}" (2/2: arguments)`),
      prompt:
        'The exact argument list as a JSON array of strings, e.g. ["npm", "run", "test"]. No shell: nothing is ' +
        'split, expanded or quoted for you. Do not put tokens or passwords in arguments.',
      ...(prefill !== null ? { value: argvInputValue(prefill) } : {}),
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        const parsed = parseArgvInput(value);
        return parsed.ok ? null : parsed.problem;
      },
    });
    if (typed === undefined) return undefined;
    const parsed = parseArgvInput(typed);
    if (!parsed.ok) {
      this.verificationWarning(`Add verification command: ${parsed.problem} Nothing was sent.`);
      return undefined;
    }
    return parsed.argv;
  }

  private async confirmAndApprove(project: Project, label: string, argv: string[], notes: readonly string[]): Promise<void> {
    const view = approveConfirmationView({ projectName: project.name, label, argv, notes });
    const step = `Approve exactly ${argv.length === 1 ? 'this 1 argument' : `these ${argv.length} arguments`}`;
    const confirmed = await this.confirmVerification(view, step, () =>
      renderArgvDocument('arguments to approve', label, argv, notes),
    );
    if (!confirmed) {
      this.notConfirmed();
      return;
    }
    // I7: which commands existed BEFORE, so a byte-equal re-approval is told
    // as such (Core returns the existing command). Read-only; best effort.
    const knownIds = new Set(this.verificationCommands.map((c) => c.id));
    try {
      for (const c of parseVerificationList(await this.commands.verificationList(project.id)) ?? []) knownIds.add(c.id);
    } catch (error) {
      this.log(`verification.list before approve failed: ${errorCodeOf(error) ?? 'no Core error code'}`);
    }
    let raw: unknown;
    try {
      raw = await this.commands.verificationApprove({ projectId: project.id, label, argv });
    } catch (error) {
      this.reportVerificationFailure(error, 'verification.approve');
      await this.reloadVerification(project.id);
      return;
    }
    const command =
      typeof raw === 'object' && raw !== null ? parseVerificationCommand((raw as { command?: unknown }).command) : null;
    if (command === null) {
      this.log('verification.approve answer failed the shape check (payload not logged)');
      this.verificationWarning(
        `verification.approve: ${MALFORMED_VERIFICATION} The command may have been approved; the Verification list is re-read.`,
      );
    } else {
      const existing = knownIds.has(command.id) || command.label !== label;
      const text = approvedCopy({ label: command.label, argvCount: command.argv.length, projectName: project.name, existing });
      this.setStatus(existing ? 'info' : 'ok', text);
      if (existing) void vscode.window.showInformationMessage(text);
    }
    await this.reloadVerification(project.id);
  }

  /** "Add verification command…": label + JSON argv → modal → second step → `verification.approve`. */
  async approveVerificationCommand(): Promise<void> {
    await this.verificationEdit(async () => {
      if (!(await this.ensureVerification('verification.approve', 'Add verification command'))) return;
      const project = this.verificationProject('Add verification command');
      if (!project) return;
      const label = await this.askVerificationLabel(project.name);
      if (label === undefined) return this.notConfirmed();
      const argv = await this.askVerificationArgv(project.name, null);
      if (argv === undefined) return this.notConfirmed();
      await this.confirmAndApprove(project, label, argv, []);
    });
  }

  /**
   * Approve one of Core's detected suggestions: a FRESH `project.context` →
   * pick → the suggestion's argv prefilled exactly (still editable) → the
   * same modal + step, with Core's notes about the suggestion in the modal.
   */
  async approveVerificationSuggestion(): Promise<void> {
    await this.verificationEdit(async () => {
      if (!(await this.ensureVerification('project.context', 'Approve a suggested verification command'))) return;
      const project = this.verificationProject('Approve a suggested verification command');
      if (!project) return;
      let raw: unknown;
      try {
        raw = await this.readProjectContext(project.id);
      } catch (error) {
        this.reportVerificationFailure(error, 'project.context');
        return;
      }
      const context = parseProjectContext(raw);
      if (context === null) {
        this.verificationWarning(this.malformedVerificationNote('project.context'));
        return;
      }
      if (this.selectedProjectId === project.id) {
        this.verificationContext = context;
        this.verificationCommands = context.approved;
        this.emit();
      }
      const approved = new Set(context.approved.map((c) => JSON.stringify(c.argv)));
      const suggestions = context.repositories.flatMap((repo) =>
        repo.detected.flatMap((manifest) =>
          manifest.suggestedCommands.map((argv) => ({ repoPath: repo.repoPath, manifest: manifest.manifest, argv, notes: manifest.notes })),
        ),
      );
      if (suggestions.length === 0) {
        const unreadable = context.repositories.flatMap((r) => r.unreadable);
        this.setStatus(
          'info',
          `Core detected no suggested command in this project's repositories` +
            (unreadable.length > 0 ? ` (not read: ${unreadable.slice(0, 10).map((u) => plainText(u, 120)).join(', ')})` : '') +
            '. Nothing was sent.',
        );
        this.emit();
        return;
      }
      const picked = await vscode.window.showQuickPick(
        suggestions.map((s) => ({
          label: labelText(argvInputValue(s.argv)),
          description: labelText(
            `${plainText(s.manifest, 120)} in ${plainText(s.repoPath, 300)}${approved.has(JSON.stringify(s.argv)) ? ' (already approved)' : ''}`,
          ),
          ...(s.notes.length > 0 ? { detail: labelText(plainText(s.notes.join(' · '), 300)) } : {}),
          suggestion: s,
        })),
        {
          title: labelText(`Approve which suggested command for "${project.name}"? (detected by Core from root manifests; nothing runs now)`),
          matchOnDescription: true,
          ignoreFocusOut: true,
        },
      );
      if (!picked) return this.notConfirmed();
      const label = await this.askVerificationLabel(project.name);
      if (label === undefined) return this.notConfirmed();
      const argv = await this.askVerificationArgv(project.name, picked.suggestion.argv);
      if (argv === undefined) return this.notConfirmed();
      await this.confirmAndApprove(project, label, argv, picked.suggestion.notes);
    });
  }

  /** A fresh `verification.list` for a dialog (never the cached rows). */
  private async freshVerificationCommands(projectId: string): Promise<VerificationCommand[] | null> {
    let raw: unknown;
    try {
      raw = await this.commands.verificationList(projectId);
    } catch (error) {
      this.reportVerificationFailure(error, 'verification.list');
      return null;
    }
    const commands = parseVerificationList(raw);
    if (commands === null) {
      this.verificationWarning(this.malformedVerificationNote('verification.list'));
      return null;
    }
    if (this.selectedProjectId === projectId) {
      this.verificationCommands = commands;
      this.emit();
    }
    return commands;
  }

  private async pickVerificationCommand(commands: VerificationCommand[], title: string): Promise<VerificationCommand | undefined> {
    const picked = await vscode.window.showQuickPick(
      commands.map((command) => ({
        label: labelText(plainText(command.label, 120)),
        description: labelText(argvInputValue(command.argv)),
        command,
      })),
      { title: labelText(title), matchOnDescription: true, ignoreFocusOut: true },
    );
    return picked?.command;
  }

  /** "Revoke…": fresh list → pick → modal + second step → `verification.revoke`. */
  async revokeVerificationCommand(): Promise<void> {
    await this.verificationEdit(async () => {
      if (!(await this.ensureVerification('verification.revoke', 'Revoke verification command'))) return;
      const project = this.verificationProject('Revoke verification command');
      if (!project) return;
      const commands = await this.freshVerificationCommands(project.id);
      if (commands === null) return;
      if (commands.length === 0) {
        this.setStatus('info', 'This project has no approved verification command. Nothing was sent.');
        this.emit();
        return;
      }
      const command = await this.pickVerificationCommand(commands, `Revoke which verification command of "${project.name}"?`);
      if (!command) return this.notConfirmed();
      const view = revokeConfirmationView(command);
      const confirmed = await this.confirmVerification(view, 'Revoke it (future runs only)', () =>
        renderArgvDocument('command to revoke', command.label, command.argv),
      );
      if (!confirmed) return this.notConfirmed();
      let raw: unknown;
      try {
        raw = await this.commands.verificationRevoke(command.id);
      } catch (error) {
        this.reportVerificationFailure(error, 'verification.revoke');
        await this.reloadVerification(project.id);
        return;
      }
      const revoked = typeof raw === 'object' && raw !== null ? (raw as { revoked?: unknown }).revoked : undefined;
      if (revoked === true) {
        this.setStatus('ok', noIcons(`Revoked "${plainText(command.label, 120)}": it can no longer run; past results stay readable.`));
      } else {
        // W2: anything but `revoked: true` is NOT a confirmation.
        this.log('verification.revoke answered without revoked:true (payload not logged)');
        const text = noIcons(
          `verification.revoke — Core did not confirm that "${plainText(command.label, 120)}" was revoked: it may not ` +
            'have been revoked. The Verification list is re-read; check it before relying on the revocation.',
        );
        void vscode.window.showErrorMessage(text);
        this.setStatus('error', text);
      }
      await this.reloadVerification(project.id);
    });
  }

  /** The sidebar's Verification buttons (clicks). */
  private async runVerificationAction(action: VerificationAction): Promise<void> {
    switch (action) {
      case 'add':
        await this.approveVerificationCommand();
        return;
      case 'approveSuggestion':
        await this.approveVerificationSuggestion();
        return;
      case 'revoke':
        await this.revokeVerificationCommand();
        return;
      case 'refresh':
        if (!(await this.ensureVerification('verification.list', 'Refresh verification'))) return;
        if (this.selectedProjectId) await this.reloadVerification(this.selectedProjectId);
        return;
      default: {
        const _exhaustive: never = action;
        void _exhaustive;
      }
    }
  }

  /** "Run Verification…" from the palette: pick a task Core lists, then the Run flow. */
  async runVerificationFromPicker(): Promise<void> {
    if (!(await this.ensureVerification('verification.run', 'Run verification'))) return;
    const project = this.verificationProject('Run verification');
    if (!project) return;
    let tasks: TaskSummary[];
    try {
      tasks = await this.commands.taskList({ projectId: project.id });
    } catch (error) {
      this.reportError(error, 'task.list (for Run verification)', 'Nothing was sent.');
      return;
    }
    if (tasks.length === 0) {
      this.setStatus('info', 'Core lists no task in this project, so there is nothing to verify. Nothing was sent.');
      this.emit();
      return;
    }
    const picked = await vscode.window.showQuickPick(
      tasks.map((task) => {
        const binding = runBinding(task, this.sandboxes);
        return {
          label: labelText(`task ${plainText(task.id, 200).slice(0, 8)}`),
          description: labelText(
            `${plainText(String(task.status), 40)} · ${binding.ok ? `sandbox ${binding.sandboxName} (${binding.workspaceMode})` : binding.reason}`,
          ),
          taskId: task.id,
        };
      }),
      { title: 'Run a verification on which task?', ignoreFocusOut: true },
    );
    if (!picked) return this.notConfirmed();
    await this.runVerificationOnTask(picked.taskId);
  }

  /**
   * Verify… on one task. Single-flight per task (dialogs AND Core's answer).
   * The binding is read FRESH at click time: `expectedSandboxName` is
   * `TaskSummary.sandboxName` (never `chosenSandboxName`) and
   * `expectedWorkspaceMode` that sandbox's `sandbox.list` mode — exactly what
   * the modal shows. A fresh idempotency key per gesture; only "Retry
   * safely" reuses it.
   */
  async runVerificationOnTask(taskId: string): Promise<void> {
    if (this.verificationRunsOpening.has(taskId)) {
      this.verificationWarning(VERIFICATION_IN_FLIGHT, 'info');
      return;
    }
    this.verificationRunsOpening.add(taskId);
    this.emit();
    try {
      await this.runVerificationFlow(taskId);
    } finally {
      this.verificationRunsOpening.delete(taskId);
      this.emit();
    }
  }

  private async runVerificationFlow(taskId: string): Promise<void> {
    if (!(await this.ensureVerification('verification.run', 'Run verification'))) return;
    const project = this.verificationProject('Run verification');
    if (!project) return;
    let tasks: TaskSummary[];
    let sandboxes: SandboxSummary[];
    try {
      [tasks, sandboxes] = await Promise.all([this.commands.taskList({ projectId: project.id }), this.commands.sandboxList()]);
    } catch (error) {
      this.reportError(error, 'task.list / sandbox.list (for Run verification)', 'Nothing was sent.');
      return;
    }
    this.sandboxes = sandboxes;
    this.sandboxListRead = true;
    if (this.selectedProjectId === project.id) this.view = reduceTaskView(this.view, { kind: 'taskList', tasks });
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      this.verificationWarning('Run verification: Core no longer lists this task in the selected project. Nothing was sent.');
      return;
    }
    const binding = runBinding(task, sandboxes);
    if (!binding.ok) {
      this.verificationWarning(`Run verification: ${binding.reason}. Nothing was sent.`);
      return;
    }
    const commands = await this.freshVerificationCommands(project.id);
    if (commands === null) return;
    if (commands.length === 0) {
      this.setStatus('info', 'This project has no approved verification command; add one first. Nothing was sent.');
      this.emit();
      return;
    }
    const command = await this.pickVerificationCommand(
      commands,
      `Run which verification command on task ${taskId.slice(0, 8)} (sandbox ${binding.sandboxName}, ${binding.workspaceMode})?`,
    );
    if (!command) return this.notConfirmed();
    const view = runConfirmationView({
      taskId,
      label: command.label,
      argv: command.argv,
      sandboxName: binding.sandboxName,
      workspaceMode: binding.workspaceMode,
    });
    const confirmed = await this.confirmVerification(view, `Run "${plainText(command.label, 120)}" now`, () =>
      renderArgvDocument('command to run', command.label, command.argv),
    );
    if (!confirmed) return this.notConfirmed();
    const params: VerificationRunParams = {
      taskId,
      commandId: command.id,
      expectedSandboxName: binding.sandboxName,
      expectedWorkspaceMode: binding.workspaceMode,
      idempotencyKey: newIdempotencyKey(),
    };
    await this.attemptVerificationRun(params, plainText(command.label, 120), false);
  }

  /** One `verification.run` attempt with fixed params (a retry resends them unchanged). */
  private async attemptVerificationRun(params: VerificationRunParams, label: string, priorUnknown: boolean): Promise<void> {
    this.noteKeySent(params.idempotencyKey);
    let raw: unknown;
    try {
      raw = await this.commands.verificationRun(params);
    } catch (error) {
      const view = verificationErrorView(error, 'verification.run');
      if (view === null) {
        if (priorUnknown) {
          // The retry never left: the FIRST attempt's outcome is still unknown.
          this.offerVerificationRetry(
            'verification.run — the retry could not reach Core, so nothing new was sent; the earlier attempt\'s ' +
              'outcome is still unknown (the verification may have started).',
            params,
            label,
          );
          return;
        }
        this.reportError(error, 'verification.run', 'Nothing was sent to Core, so nothing was run.');
        return;
      }
      this.log(`verification.run failed: ${errorCodeOf(error) ?? 'no answer from Core'}`);
      if (view.retrySafely) {
        this.offerVerificationRetry(view.text, params, label);
        return;
      }
      this.showVerificationView(view);
      return;
    }
    const started = parseRunStarted(raw);
    if (started === null) {
      this.log('verification.run answer failed the shape check (payload not logged)');
      this.verificationWarning(
        `verification.run: ${MALFORMED_VERIFICATION} The verification may have started; use Results… on the task to check.`,
      );
      return;
    }
    this.verificationRunsStartedHere.set(started.runId, label);
    const text = runStartedCopy(label, started);
    void vscode.window.showInformationMessage(text);
    this.setStatus('ok', text);
    this.emit();
    // Read Core's durable `verification.started` (and a replay's finish) now:
    // the feed does not poll a terminal task, and the stop warning needs it.
    await this.catchUpNow();
  }

  /** The lost-answer notification; only the "Retry safely" click resends (same key, same params). */
  private offerVerificationRetry(text: string, params: VerificationRunParams, label: string): void {
    if (!this.retryWindowOpen(params.idempotencyKey)) {
      // #9: Core may have forgotten the key: a resend could start it twice.
      const late = noIcons(`${text}\n\n${VERIFICATION_TOO_LATE}`);
      void vscode.window.showErrorMessage(late);
      this.setStatus('error', `verification.run: ${VERIFICATION_TOO_LATE}`);
      this.emit();
      return;
    }
    const shown = noIcons(text);
    this.setStatus('error', `verification.run: outcome unknown — use "${RETRY_SAFELY}" or open Results… to check.`);
    this.emit();
    void vscode.window.showErrorMessage(shown, RETRY_SAFELY).then((choice) => {
      if (choice === RETRY_SAFELY) void this.retryVerificationRun(params, label);
    });
  }

  /**
   * Click-time gate for "Retry safely" (as `retryKeyed`): attach if needed,
   * re-probe THIS Core, and resend only if it still advertises
   * `idempotency-keys`, `verification` and `verification.run`.
   */
  private async retryVerificationRun(params: VerificationRunParams, label: string): Promise<void> {
    // #9: re-checked at click time — the notification may have sat for hours.
    if (!this.retryWindowOpen(params.idempotencyKey)) {
      void vscode.window.showErrorMessage(VERIFICATION_TOO_LATE);
      this.setStatus('error', `verification.run: ${VERIFICATION_TOO_LATE}`);
      this.emit();
      return;
    }
    if (this.verificationRunsOpening.has(params.taskId)) {
      this.verificationWarning(VERIFICATION_IN_FLIGHT, 'info');
      return;
    }
    this.verificationRunsOpening.add(params.taskId);
    this.emit();
    try {
      try {
        if (this.connection.connectionState !== 'online') await this.connection.connect();
        this.capabilities = await this.commands.systemProbe();
      } catch {
        this.offerVerificationRetry(
          'verification.run — the retry could not reach Core, so nothing new was sent; the earlier attempt\'s ' +
            'outcome is still unknown (the verification may have started).',
          params,
          label,
        );
        return;
      }
      if (!this.coreHasFeature('idempotency-keys') || !this.verificationSupported()) {
        this.verificationWarning(
          'Not retried: the connected Core no longer advertises idempotency keys and verification, so a retry could ' +
            'start it twice. Nothing was sent; open Results… on the task to check.',
        );
        return;
      }
      await this.attemptVerificationRun(params, label, true);
    } finally {
      this.verificationRunsOpening.delete(params.taskId);
      this.emit();
    }
  }

  /** "Results…" on one task: pick a run named by Core's events, open its result. */
  async showVerificationResults(taskId: string): Promise<void> {
    if (!(await this.ensureVerification('verification.result', 'Show verification result'))) return;
    await this.catchUpNow();
    await this.pickAndOpenRun(taskId);
  }

  /** "Show Verification Result…" from the palette: pick a task with runs, then a run. */
  async showVerificationResultFromPicker(): Promise<void> {
    if (!(await this.ensureVerification('verification.result', 'Show verification result'))) return;
    await this.catchUpNow();
    const tasks = selectTasks(this.view).filter((task) => (task.verifications ?? []).length > 0);
    if (tasks.length === 0) {
      this.setStatus('info', "Core's events name no verification run for the tasks of this project. Nothing was requested.");
      this.emit();
      return;
    }
    const picked = await vscode.window.showQuickPick(
      tasks.map((task) => ({
        label: labelText(`task ${plainText(task.taskId, 200).slice(0, 8)}`),
        description: `${(task.verifications ?? []).length} verification run(s)`,
        taskId: task.taskId,
      })),
      { title: 'Show the verification result of which task?', ignoreFocusOut: true },
    );
    if (!picked) return;
    await this.pickAndOpenRun(picked.taskId);
  }

  private async pickAndOpenRun(taskId: string): Promise<void> {
    const runs = [...(this.view.tasks[taskId]?.verifications ?? [])].reverse();
    if (runs.length === 0) {
      this.setStatus('info', "Core's events name no verification run for this task yet. Nothing was requested.");
      this.emit();
      return;
    }
    const picked = await vscode.window.showQuickPick(
      runs.map((run) => ({
        label: labelText(run.label),
        description: labelText(run.finished ?? outcomeCopy('running')),
        runId: run.runId,
      })),
      { title: labelText(`Show which verification result of task ${taskId.slice(0, 8)}? (read-only)`), ignoreFocusOut: true },
    );
    if (!picked) return;
    await this.openVerificationResult(picked.runId);
  }

  /** `verification.result` → the read-only, revealed plain-text document. */
  private async openVerificationResult(runId: string): Promise<boolean> {
    let raw: unknown;
    try {
      raw = await this.commands.verificationResult(runId);
    } catch (error) {
      this.reportVerificationFailure(error, 'verification.result');
      return false;
    }
    const result = parseVerificationResult(raw);
    if (result === null) {
      this.verificationWarning(this.malformedVerificationNote('verification.result'));
      return false;
    }
    // W3a: "not linked" only when link detection is off for this language
    // (a workspace or user override can turn it back on).
    const links = vscode.workspace.getConfiguration('editor', { languageId: VERIFICATION_LANGUAGE }).get<unknown>('links');
    const document = renderResultDocument(result, { linksDisabled: links === false });
    if (!(await this.openVerificationDocument(`verification-${runId.slice(0, 8)}`, document))) return false;
    this.setStatus(
      'info',
      noIcons(`Result of "${plainText(result.label, 120)}" opened read-only: ${outcomeCopy(result.outcome, result.exitCode)}.`),
    );
    this.emit();
    return true;
  }

  /** A run started in this window finished (Core's event): say so; "Show result" is a click. */
  private notifyFinishedRuns(events: readonly { kind: string; payload: unknown }[]): void {
    for (const event of events) {
      if (event.kind !== VERIFICATION_EVENT_KINDS.finished) continue;
      const summary = finishedEventSummary(event.payload);
      if (summary === null) continue;
      const label = this.verificationRunsStartedHere.get(summary.runId);
      if (label === undefined) continue;
      this.verificationRunsStartedHere.delete(summary.runId);
      void Promise.resolve(
        vscode.window.showInformationMessage(
          noIcons(`Verification "${label}" finished: ${summary.text}. The task status is not changed.`),
          SHOW_RESULT_BUTTON,
        ),
      ).then(async (choice) => {
        if (choice !== SHOW_RESULT_BUTTON) return;
        if (await this.ensureVerification('verification.result', 'Show verification result')) {
          await this.openVerificationResult(summary.runId);
        }
      });
    }
  }

  /** A run this client saw start (and not finish) in `sandbox` — for the stop warning. */
  private verificationRunningIn(sandbox: string): boolean {
    return selectTasks(this.view).some((task) =>
      (task.verifications ?? []).some((run) => run.sandbox === sandbox && run.finished === null),
    );
  }

  private taskVerificationRow(task: TaskView): TaskVerificationRow {
    const supported = this.verificationSupported();
    const binding = runBinding(task, this.sandboxes);
    const opening = this.verificationRunsOpening.has(task.taskId);
    return {
      runEnabled: supported && binding.ok && !opening,
      runReason: !supported
        ? 'not supported by the attached Sandpane Core'
        : !binding.ok
          ? binding.reason
          : opening
            ? 'a verification is being started for this task'
            : null,
      runs: [...(task.verifications ?? [])].reverse().slice(0, 10).map(runRowText),
    };
  }

  private verificationPanel(): VerificationPanelView {
    if (!this.verificationSupported()) {
      return {
        supported: false,
        note: this.capabilities ? VERIFICATION_UNSUPPORTED_NOTE : 'Sandpane Core is not attached.',
        commands: [],
        repositories: [],
      };
    }
    if (!this.selectedProjectId) {
      return { supported: true, note: 'Select a project to see its verification commands.', commands: [], repositories: [] };
    }
    const cap = (text: string): string => {
      const points = Array.from(text);
      return points.length > 300 ? `${points.slice(0, 300).join('')}… (cut here)` : text;
    };
    return {
      supported: true,
      note: this.verificationNote,
      commands: this.verificationCommands.map((command) => ({
        label: plainText(command.label, 120),
        argv: panelArgvLines(command.argv),
      })),
      repositories: (this.verificationContext?.repositories ?? []).map((repo) => ({
        repoPath: plainText(repo.repoPath, 300),
        unreadable: repo.unreadable.map((name) => plainText(name, 200)),
        manifests: repo.detected.map((manifest) => ({
          manifest: plainText(manifest.manifest, 120),
          suggestions: manifest.suggestedCommands.slice(0, 20).map((argv) => cap(argvInputValue(argv))),
          notes: manifest.notes.slice(0, 20).map((note) => plainText(note, 700)),
        })),
      })),
    };
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

  // -----------------------------------------------------------------------
  // A9 maintenance (design 2026-10-09 §3.9): scan → pick → step 1 → modal →
  // step 2 → re-scan. Runs ONLY from a user gesture (the command or the
  // sidebar button); step 2 is never retried and never sent without the
  // modal, and the flow always re-scans after it settles.
  // -----------------------------------------------------------------------

  /** Click-time gate: fresh probe; both methods and the `maintenance` feature. */
  private async ensureMaintenance(action: string): Promise<boolean> {
    if (!(await this.ensureAdvertised('maintenance.inventory', action))) return false;
    if (maintenanceAdvertised(this.capabilities) !== true) {
      const text = 'This Core does not advertise maintenance, so cleanup is not supported by this Core.';
      void vscode.window.showWarningMessage(text);
      this.setStatus('error', text);
      this.emit();
      return false;
    }
    return true;
  }

  /**
   * The whole Maintenance flow, one gesture at a time: fresh inventory →
   * multi-select (removable items only; dbBackup and unknown kinds unchecked
   * by default) → step 1 → modal with Core's impact → step 2 → re-scan.
   */
  async runMaintenanceCleanup(): Promise<void> {
    if (this.maintenanceOpen) {
      this.setStatus('info', 'A maintenance dialog is already open; finish it first. Nothing was sent.');
      this.emit();
      return;
    }
    this.maintenanceOpen = true;
    try {
      if (!(await this.ensureMaintenance('Clean up Core state'))) return;
      let raw: unknown;
      try {
        raw = await this.commands.maintenanceInventory();
      } catch (error) {
        this.reportMaintenanceFailure(error, 'maintenance.inventory');
        return;
      }
      const inventory = parseMaintenanceInventory(raw);
      if (inventory === null) {
        this.setStatus('error', 'maintenance.inventory: Core answered a shape this client cannot read. Nothing was sent.');
        this.emit();
        return;
      }
      if (inventory.items.length === 0) {
        this.setStatus('ok', 'Core found nothing to clean up.');
        this.emit();
        return;
      }
      const removable = inventory.items.filter((item) => item.removable);
      const reportOnly = inventory.items.filter((item) => !item.removable);
      if (inventory.truncated) {
        void vscode.window.showInformationMessage(
          'The maintenance scan was cut short: Core left items out (too many entries). Clean up what is listed, then scan again.',
        );
      }
      if (removable.length === 0) {
        this.setStatus(
          'info',
          `Nothing is removable by Sandpane (${reportOnly.length} report-only item${reportOnly.length === 1 ? '' : 's'}; run the command for the paths).`,
        );
        this.emit();
        return;
      }
      // Multi-select: every removable item is listed; the pre-picked set is
      // Core's default (temp + verificationOutput; dbBackup and unknown kinds
      // stay UNchecked until the user opts in).
      const picked = await vscode.window.showQuickPick(
        removable.map((item) => ({
          label: labelText(itemPickLine(item)),
          description: labelText(plainText(item.detail, 300)),
          picked: defaultChecked(item),
          item,
        })),
        {
          title: labelText(
            `Clean up which items? (Core's fresh scan${reportOnly.length > 0 ? `; ${reportOnly.length} report-only item${reportOnly.length === 1 ? ' is' : 's are'} not offered` : ''})`,
          ),
          canPickMany: true,
          ignoreFocusOut: true,
        },
      );
      if (picked === undefined || picked.length === 0) {
        this.notConfirmedMaintenance();
        return;
      }
      const items = picked.map((p) => p.item.id);
      // Step 1: Core re-inventories, refuses what changed, mints the token.
      let step1: unknown;
      try {
        step1 = await this.commands.maintenanceCleanupRequest(items);
      } catch (error) {
        this.reportMaintenanceFailure(error, 'maintenance.cleanup (step 1)');
        return;
      }
      const request = parseMaintenanceCleanup(step1);
      if (request === null || request.confirmation === undefined) {
        this.setStatus(
          'error',
          'maintenance.cleanup: Core answered a shape this client cannot read. Nothing was sent.',
        );
        this.emit();
        return;
      }
      const confirmation = request.confirmation;
      const impact = confirmation.impact.map((line) => plainText(line, 500)).join('\n');
      const answer = await vscode.window.showWarningMessage(
        `Remove ${items.length} confirmed item${items.length === 1 ? '' : 's'}? This cannot be undone.`,
        { modal: true, detail: labelText(`${impact}\n\nValid until ${plainText(confirmation.expiresAt, 64)}. Items that changed since the scan are skipped and reported, not removed silently.`) },
        'Remove them',
      );
      if (answer !== 'Remove them') {
        this.notConfirmedMaintenance();
        return;
      }
      // Step 2: the token is spent exactly once, from this gesture only.
      let step2: unknown;
      try {
        step2 = await this.commands.maintenanceCleanupConfirm(items, confirmation.token);
      } catch (error) {
        this.reportMaintenanceFailure(error, 'maintenance.cleanup (step 2)');
        await this.maintenanceRescan();
        return;
      }
      const outcome = parseMaintenanceCleanup(step2);
      if (outcome === null || outcome.confirmation !== undefined || outcome.removed === undefined) {
        this.setStatus(
          'error',
          'maintenance.cleanup: Core answered a shape this client cannot read. Some items may have been removed — scan again.',
        );
        this.emit();
        await this.maintenanceRescan();
        return;
      }
      const copy = maintenanceOutcomeCopy(outcome, items.length);
      this.setStatus(
        outcome.skipped !== undefined && outcome.skipped.length > 0 ? 'info' : 'ok',
        copy.headline,
      );
      void vscode.window.showInformationMessage(
        labelText(
          [
            copy.headline,
            ...copy.skippedLines.slice(0, 10),
            ...(copy.skippedLines.length > 10 ? [`…and ${copy.skippedLines.length - 10} more`] : []),
            ...copy.noteLines,
          ].join('\n'),
        ),
      );
      this.emit();
      // §3.9 item 7.5: always re-scan after step 2.
      await this.maintenanceRescan();
    } finally {
      this.maintenanceOpen = false;
    }
  }

  /** A silent re-scan after step 2: failures surface as a status line only. */
  private async maintenanceRescan(): Promise<void> {
    try {
      await this.commands.maintenanceInventory();
    } catch (error) {
      this.setStatus('info', 'The post-cleanup re-scan failed; run the command again to see what remains.');
      this.log(`maintenance.inventory re-scan failed: ${errorCodeOf(error) ?? 'no Core error code'}`);
      this.emit();
    }
  }

  private notConfirmedMaintenance(): void {
    this.setStatus('info', 'Not confirmed; nothing was sent.');
    this.emit();
  }

  /** Honesty copy for a maintenance failure (client brief, §9 step 2). */
  private reportMaintenanceFailure(error: unknown, what: string): void {
    const code = errorCodeOf(error);
    this.log(`${what} failed: ${code ?? 'no Core error code'}`);
    if (code === 'CONFLICT') {
      const text = MAINTENANCE_CONFLICT_TITLE;
      void vscode.window.showWarningMessage(text);
      this.setStatus('info', text);
      this.emit();
      return;
    }
    if (what.includes('step 2')) {
      // A lost answer or a token refusal: the client cannot tell "expired"
      // from "consumed by a lost earlier attempt" — never "nothing was removed".
      const text = `${LOST_STEP2_TITLE}. ${plainText(error instanceof Error ? error.message : String(error), 300)}`;
      void vscode.window.showWarningMessage(labelText(text));
      this.setStatus('error', LOST_STEP2_TITLE);
      this.emit();
      return;
    }
    this.reportError(error, what, 'The cleanup was not started; nothing was changed.');
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
        void this.send(message.text, message.writable, message.planId, 'sidebar', message.mode ?? 'task');
        break;
      case 'cancelTask':
        void this.cancelTask(message.taskId);
        break;
      case 'showTaskPatch':
        void this.showTaskPatch(message.taskId);
        break;
      case 'reviewTask':
        void this.reviewChanges(message.taskId);
        break;
      case 'applyTask':
        // A6: the sidebar's Apply button (a click); the modal still decides.
        void this.applyTask(message.taskId);
        break;
      case 'selectConversation':
        this.selectConversation(message.conversationId);
        break;
      case 'toggleArchivedConversations':
        void this.toggleShowArchivedConversations();
        break;
      case 'conversationAction':
        void this.runConversationAction(message.action, message.conversationId);
        break;
      case 'verificationAction':
        // A7: a click opens a native dialog filled from Core; nothing else is sent.
        void this.runVerificationAction(message.action);
        break;
      case 'runVerification':
        void this.runVerificationOnTask(message.taskId);
        break;
      case 'showVerificationResults':
        void this.showVerificationResults(message.taskId);
        break;
      case 'maintenanceScan':
        // A9: a click opens the native Maintenance flow; nothing is sent
        // without its modal.
        void this.runMaintenanceCleanup();
        break;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  private async runConversationAction(action: ConversationAction, id: string): Promise<void> {
    switch (action) {
      case 'rename':
        await this.renameConversation(id);
        return;
      case 'archive':
        await this.archiveConversation(id);
        return;
      case 'unarchive':
        await this.unarchiveConversation(id);
        return;
      case 'export':
        await this.exportConversation(id);
        return;
      case 'delete':
        await this.deleteConversation(id);
        return;
      default: {
        const _exhaustive: never = action;
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
        project: project
          ? `${project.name}${isArchived(project) ? ` · ${ARCHIVED_LABEL}` : ''}`
          : this.projects.length > 0
            ? `${this.projects.length} project(s), none selected`
            : null,
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
        ? {
            id: this.conversation.id,
            title: this.conversation.title,
            agentId: this.conversation.agentId,
            archived: isConversationArchived(this.conversation),
          }
        : null,
      conversations: this.conversationListView(),
      composerBlocked: this.composerBlockedReason(),
      sendModeSupported: this.coreHasFeature(SEND_MODE_FEATURE),
      gitDiffSupported: this.coreAdvertises('git.diff'),
      gitApplySupported: this.coreAdvertises('git.apply') && this.coreHasFeature(GIT_APPLY_FEATURE),
      applyInFlight: this.applyInFlight,
      verification: this.verificationPanel(),
      maintenance: {
        supported: maintenanceAdvertised(this.capabilities) === true,
        inFlight: this.maintenanceOpen,
      },
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
        ...optionalText('mode', taskModeText(task.mode)),
        ...optionalText('chosenSandboxName', chosenSandboxText(task.chosenSandboxName)),
        verification: this.taskVerificationRow(task),
      })),
      acceptedSends: this.acceptedSends,
      sending: this.sending,
      status: this.status,
      capabilities: this.capabilities ? this.capabilitySummary(this.capabilities) : null,
      contextPlan: this.planView(),
      notices: this.notices(base),
    };
  }

  private capabilitySummary(capabilities: CoreCapabilities): CapabilitySummary {
    // A8a: the webview gets finished display strings only (src/vscode/sbxStatus.ts);
    // a `null` exec/captured line = Core did not say, so nothing is shown for it.
    const sbx = sbxStatusView(capabilities.sbx);
    return {
      coreVersion: capabilities.coreVersion,
      protocolVersion: capabilities.protocolVersion,
      instanceId: capabilities.instanceId,
      platform: capabilities.platform,
      sbxInstalled: capabilities.sbx?.installed ?? null,
      sbxNote: sbx.note,
      sbxVersion: sbx.version,
      sbxDaemon: sbx.daemon,
      sbxExec: sbx.exec,
      sbxCaptured: sbx.captured,
      agents: capabilities.agents.map((a: AgentCapability) => ({
        id: a.id,
        verified: a.verified,
        supportsStreaming: a.supportsStreaming,
        supportsCancel: a.supportsCancel,
      })),
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
          this.notifyFinishedRuns(events);
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
    // A5: Core now names the task's repository (`repoPath`); prefer the open
    // folder that IS that repository, else fall back to the project match.
    const coreRepo = typeof changeSet.repoPath === 'string' && changeSet.repoPath.length > 0 ? changeSet.repoPath : null;
    const byCore = coreRepo ? matchWorkspaceFolder(canonical, [coreRepo]) : null;
    const matched = byCore ?? matchWorkspaceFolder(canonical, project?.repositories ?? []);
    const candidate = matched?.fsPath ?? canonical[0]?.fsPath;
    if (!candidate) return null;
    const provenance = byCore
      ? `This folder is the task's repository as reported by Core (${plainText(coreRepo, 500)}).`
      : coreRepo
        ? `WARNING: no open folder is the task's repository reported by Core (${plainText(coreRepo, 500)}).`
        : matched
          ? `This folder is one of the project's repositories registered in Core (${plainText(matched.canonical, 500)}).`
          : project?.repositories && project.repositories.length > 0
            ? `WARNING: no open folder matches the project's repositories in Core (${project.repositories.map((r) => plainText(r, 500)).join(', ')}).`
            : 'Core reports no repository for the selected project.';
    const answer = await vscode.window.showInformationMessage(
      `Diff the ${changeSet.changes.length} reported change(s) against the task base ` +
        `${changeSet.baseCommit.slice(0, 8)} using this workspace folder as the repository root?\n\n${candidate}\n\n` +
        `${provenance}\n\n` +
        (coreRepo
          ? 'Confirm it is the right repository.'
          : 'This Core did not report the task repository path (pre-A5). Confirm it is the right repo.'),
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
  reportError(error: unknown, operation: string, contextArg?: string): void {
    // Core's exact A3a refusals (archived project, unregistered repository …)
    // get their honest copy wherever they surface.
    const context =
      contextArg ?? projectErrorCopy(error) ?? conversationErrorCopy(error) ?? sendModeErrorCopy(error) ?? undefined;
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

/** `{ [key]: value }` when there is a value to show, else nothing (no invented field). */
function optionalText<K extends string>(key: K, value: string | null): Partial<Record<K, string>> {
  return value === null ? {} : ({ [key]: value } as Partial<Record<K, string>>);
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
