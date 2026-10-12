/**
 * Structured webview ⇄ extension bridge (specs/03 §2 "structured message bridge").
 *
 * The webview may ONLY send the message types below; the extension host is the
 * sole place that talks to Core, and it goes through the typed client. The
 * webview has no command execution, no shell, no arbitrary RPC passthrough.
 * Pure types — safe to import from both sides.
 */

import type { WorkspaceMode } from '../core-client/protocol';

export type ConnectionTone = 'online' | 'connecting' | 'reconnecting' | 'offline' | 'unsupported';

/** The always-visible context strip (specs/03 §1). `null` = genuinely unknown. */
export interface HeaderContext {
  project: string | null;
  agent: string | null;
  sandbox: string | null;
  /** Core's recorded mode for the SELECTED sandbox; null = none recorded/selected. */
  workspaceMode: WorkspaceMode | string | null;
  /** Precomputed badge (LIVE-WRITABLE / ISOLATED / UNVERIFIED — …); null = no sandbox. */
  workspaceModeBadge: string | null;
  /** True for direct_mount, unknown and unverified modes — rendered loud. */
  workspaceHostWritable: boolean;
  branch: string | null;
}

export interface SandboxOption {
  name: string;
  probedState: string | null;
  /**
   * Core's RECORDED binding mode for this name — `null` means Core has no
   * readable binding row, which the client renders as UNVERIFIED, never as
   * safe (specs/02 §7). Computed here so the webview interprets nothing.
   */
  workspaceMode: WorkspaceMode | string | null;
  /** Badge text, e.g. `LIVE-WRITABLE` / `ISOLATED` / `UNVERIFIED — …`. */
  modeBadge: string;
  /** True when host files can change while an agent works (incl. unverified). */
  modeHostWritable: boolean;
}

export interface ChatLine {
  role: 'user' | 'agent' | 'tool' | 'system';
  text: string;
  unsupported?: boolean;
  errorCode?: string;
}

export interface TaskRow {
  taskId: string;
  status: string | null;
  conversationId?: string;
  branch: string | null;
  baseCommit: string | null;
  unknownKinds: string[];
  /** A4: Core's send mode, revealed and capped (open string); absent on older tasks. */
  mode?: string;
  /** A4: the name the task's chat chose — NOT where it runs; revealed and capped. */
  chosenSandboxName?: string;
  /** A7: the per-task Verify… / Results… buttons. */
  verification?: TaskVerificationRow;
}

/** A7 per-task verification row. Every string is already plain text. */
export interface TaskVerificationRow {
  /** Verify… is enabled (Core advertises verification, the task is bound, no run is being started). */
  runEnabled: boolean;
  /** Why Verify… is disabled (shown as the button's tooltip and next to it). */
  runReason: string | null;
  /** One line per run named by Core's events (label — honest outcome copy). */
  runs: string[];
}

/** A7: one approved command as the sidebar shows it (label + `[i] "literal"` lines). */
export interface VerificationCommandRow {
  label: string;
  argv: string[];
}

/** A7: Core's detection for one registered repository (display only). */
export interface VerificationRepositoryRow {
  repoPath: string;
  manifests: { manifest: string; suggestions: string[]; notes: string[] }[];
  unreadable: string[];
}

/** A9 Maintenance section: a button that opens the native flow. */
export interface MaintenancePanelView {
  /** Core advertises the two A9 methods and the feature `maintenance`. */
  supported: boolean;
  /** A flow is open; the button is disabled. */
  inFlight: boolean;
}

/** A7 per-project Verification section. */
export interface VerificationPanelView {
  /** Core advertises the six A7 methods and the feature `verification`. */
  supported: boolean;
  /** Why the section is empty or unavailable, when it is. */
  note: string | null;
  commands: VerificationCommandRow[];
  repositories: VerificationRepositoryRow[];
}

export const VERIFICATION_ACTIONS = ['add', 'approveSuggestion', 'revoke', 'refresh'] as const;

export type VerificationAction = (typeof VERIFICATION_ACTIONS)[number];

export interface CapabilitySummary {
  coreVersion: string;
  protocolVersion: number;
  instanceId: string;
  platform: string;
  sbxInstalled: boolean | null;
  /** A8a: the probed sbx version, revealed and capped; `null` = unknown. */
  sbxVersion: string | null;
  /** A8a: "Docker SBX not installed" / "SBX status not reported by this Core"; `null` when installed. */
  sbxNote: string | null;
  /** A8a: "SBX daemon running|stopped (at last check)" / "SBX daemon state unknown"; `null` unless installed. */
  sbxDaemon: string | null;
  /** A8a: the verification-runs line, or `null` when Core did not say (no line). */
  sbxExec: string | null;
  /** A8a: the captured-fixtures evidence line, or `null` when Core did not say (no line). */
  sbxCaptured: string | null;
  agents: { id: string; verified: boolean; supportsStreaming: boolean; supportsCancel: boolean }[];
}

/** The attachment list the user must see and authorize before a send. */
export interface ContextPlanView {
  /** Identifies exactly this list; a send must quote it back (review bug 6). */
  planId: number;
  summary: string;
  /** What Core does with attachments (v1: accepts, does not store) — always shown. */
  disclosure: string;
  mode: 'read_only' | 'writable';
  attachments: { kind: string; label: string; target: string; excerpt: string; truncated: boolean }[];
  excluded: { label: string; reason: string }[];
}

/** One action on a conversation row: enabled, or disabled with the reason shown. */
export interface ConversationActionState {
  enabled: boolean;
  /** Why it is disabled (Core's own reason, or "not supported by this Core"). */
  reason: string | null;
}

export const CONVERSATION_ACTIONS = ['rename', 'archive', 'unarchive', 'export', 'delete'] as const;

export type ConversationAction = (typeof CONVERSATION_ACTIONS)[number];

/** A conversation Core listed (A3b). Every string is already plain text. */
export interface ConversationRow {
  id: string;
  title: string;
  archived: boolean;
  selected: boolean;
  /** "sandbox chosen at creation: …" — only when Core advertises the feature. */
  sandboxLabel: string | null;
  /** Archived note incl. Core's reason send/rename are disabled; null when live. */
  statusNote: string | null;
  actions: Record<ConversationAction, ConversationActionState>;
}

export interface ConversationListView {
  /** `conversation.list` advertised and a project selected. */
  supported: boolean;
  /** Why the list is empty/unavailable, when it is. */
  note: string | null;
  showArchived: boolean;
  /** `conversation.archive` advertised (the toggle is otherwise unsupported). */
  showArchivedSupported: boolean;
  rows: ConversationRow[];
}

export interface SidebarState {
  connection: ConnectionTone;
  header: HeaderContext;
  sandboxes: SandboxOption[];
  selectedSandbox: string | null;
  conversation: { id: string; title: string; agentId: string; archived: boolean } | null;
  /** A3b: Core's conversation list (rows, archived labels, per-row actions). */
  conversations: ConversationListView;
  /**
   * Why the composer cannot send right now (archived project / conversation,
   * Core's own reason); null = sending is allowed. Send is disabled while set.
   */
  composerBlocked: string | null;
  /**
   * A4: Core advertises `conversation-send-mode`. When false the composer's
   * Task / Discuss choice is disabled at Task and nothing sends `mode`.
   */
  sendModeSupported: boolean;
  /** A5: Core advertises `git.diff` (the per-task Diff button is enabled). */
  gitDiffSupported: boolean;
  /**
   * A6: Core advertises `git.apply` AND the feature `git-apply` (the per-task
   * Apply button is enabled). Otherwise Apply stays "not implemented".
   */
  gitApplySupported: boolean;
  /** A6: an apply flow is running (review → pick → modal → answer): Apply is disabled. */
  applyInFlight: boolean;
  /** A7: the selected project's Verification section. */
  verification: VerificationPanelView;
  /** A9: the Maintenance section (a click opens the native flow). */
  maintenance: MaintenancePanelView;
  lines: ChatLine[];
  /** What the stream shows: one conversation, or every task of the project. */
  transcript: { scope: 'conversation' | 'project'; label: string };
  tasks: TaskRow[];
  /**
   * Increments each time Core accepted a send from the sidebar composer, so the
   * webview clears its draft only after a real acceptance (never optimistically).
   */
  acceptedSends: number;
  /** A send is in flight in the extension host; the composer's Send is disabled. */
  sending: boolean;
  status: { tone: 'ok' | 'error' | 'info'; text: string } | null;
  capabilities: CapabilitySummary | null;
  contextPlan: ContextPlanView | null;
  /** Durable statements about what this build cannot do (never hidden). */
  notices: string[];
}

export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'selectSandbox'; name: string }
  /** Build the attachment list for this intent and show it (no send). */
  | { type: 'previewContext'; writable: boolean }
  /**
   * `planId` is the id of the attachment list the user was shown; the
   * extension checks it (and its mode) to reject a stale or wrong-intent
   * plan. Not a forgery defence: the id is visible to the webview.
   */
  | {
      type: 'send';
      text: string;
      writable: boolean;
      planId: number | null;
      /** A4: present ONLY when the user chose Discuss; absent = Task. */
      mode?: 'discuss';
    }
  | { type: 'cancelTask'; taskId: string }
  | { type: 'reviewTask'; taskId: string }
  /** A5: pick one file of the task's change list and show its patch (read-only). */
  | { type: 'showTaskPatch'; taskId: string }
  /** A6: start the apply flow (pick files → native modal); nothing is sent without the modal. */
  | { type: 'applyTask'; taskId: string }
  /** A3b: select a Core-listed conversation; `''` = start a new one on the next send. */
  | { type: 'selectConversation'; conversationId: string }
  /** A3b: one lifecycle action on a Core-listed conversation (native dialogs follow). */
  | { type: 'conversationAction'; action: ConversationAction; conversationId: string }
  | { type: 'toggleArchivedConversations' }
  /**
   * A7: open a native dialog filled from Core (add / approve a suggestion /
   * revoke) or re-read the section. Carries NO argv, command id or label: the
   * dialog reads them from Core.
   */
  | { type: 'verificationAction'; action: VerificationAction }
  /** A7: open the Run dialog for this task (command picked there, from Core's list). */
  | { type: 'runVerification'; taskId: string }
  /** A7: pick one of the task's runs (named by Core's events) and open its result. */
  | { type: 'showVerificationResults'; taskId: string }
  /** A9: open the native Maintenance flow (scan → pick → modal); carries no ids. */
  | { type: 'maintenanceScan' };

export type ExtensionToWebview = { type: 'state'; state: SidebarState };

export const WEBVIEW_MESSAGE_KINDS: readonly string[] = [
  'ready',
  'refresh',
  'selectSandbox',
  'previewContext',
  'send',
  'cancelTask',
  'reviewTask',
  'showTaskPatch',
  'applyTask',
  'selectConversation',
  'conversationAction',
  'toggleArchivedConversations',
  'verificationAction',
  'runVerification',
  'showVerificationResults',
  'maintenanceScan',
];

/** Upper bound on a conversation id from the webview (Core's scoping-id bound). */
const MAX_WEBVIEW_ID_CHARS = 200;

function webviewId(value: unknown, allowEmpty: boolean): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0) return allowEmpty ? value : undefined;
  return value.length <= MAX_WEBVIEW_ID_CHARS ? value : undefined;
}

/** Runtime gate for inbound webview messages — unknown kinds are dropped. */
export function parseWebviewMessage(raw: unknown): WebviewToExtension | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string' || !WEBVIEW_MESSAGE_KINDS.includes(type)) return undefined;
  switch (type) {
    case 'ready':
    case 'refresh':
      return { type };
    case 'toggleArchivedConversations':
    case 'maintenanceScan':
      return { type };
    case 'selectConversation': {
      const id = webviewId((raw as { conversationId?: unknown }).conversationId, true);
      return id === undefined ? undefined : { type: 'selectConversation', conversationId: id };
    }
    case 'conversationAction': {
      const r = raw as { action?: unknown; conversationId?: unknown };
      const id = webviewId(r.conversationId, false);
      const action = (CONVERSATION_ACTIONS as readonly unknown[]).includes(r.action) ? (r.action as ConversationAction) : undefined;
      return id === undefined || action === undefined ? undefined : { type: 'conversationAction', action, conversationId: id };
    }
    case 'previewContext':
      return { type: 'previewContext', writable: (raw as { writable?: unknown }).writable === true };
    case 'selectSandbox': {
      const name = (raw as { name?: unknown }).name;
      return typeof name === 'string' ? { type: 'selectSandbox', name } : undefined;
    }
    case 'send': {
      const r = raw as { text?: unknown; writable?: unknown; planId?: unknown; mode?: unknown };
      if (typeof r.text !== 'string') return undefined;
      return {
        type: 'send',
        text: r.text,
        writable: r.writable === true,
        planId: typeof r.planId === 'number' && Number.isSafeInteger(r.planId) && r.planId >= 0 ? r.planId : null,
        // A4: only the exact "discuss" selects Discuss; anything else is Task.
        ...(r.mode === 'discuss' ? { mode: 'discuss' as const } : {}),
      };
    }
    case 'showTaskPatch': {
      const id = webviewId((raw as { taskId?: unknown }).taskId, false);
      return id === undefined ? undefined : { type: 'showTaskPatch', taskId: id };
    }
    case 'applyTask': {
      const id = webviewId((raw as { taskId?: unknown }).taskId, false);
      return id === undefined ? undefined : { type: 'applyTask', taskId: id };
    }
    case 'verificationAction': {
      const action = (raw as { action?: unknown }).action;
      return (VERIFICATION_ACTIONS as readonly unknown[]).includes(action)
        ? { type: 'verificationAction', action: action as VerificationAction }
        : undefined;
    }
    case 'runVerification':
    case 'showVerificationResults': {
      const id = webviewId((raw as { taskId?: unknown }).taskId, false);
      if (id === undefined) return undefined;
      return type === 'runVerification' ? { type: 'runVerification', taskId: id } : { type: 'showVerificationResults', taskId: id };
    }
    case 'cancelTask':
    case 'reviewTask': {
      const r = raw as { taskId?: unknown };
      if (typeof r.taskId !== 'string') return undefined;
      return type === 'cancelTask'
        ? { type: 'cancelTask', taskId: r.taskId }
        : { type: 'reviewTask', taskId: r.taskId };
    }
    default:
      return undefined;
  }
}

export function emptySidebarState(connection: ConnectionTone): SidebarState {
  return {
    connection,
    header: {
      project: null,
      agent: null,
      sandbox: null,
      workspaceMode: null,
      workspaceModeBadge: null,
      workspaceHostWritable: false,
      branch: null,
    },
    sandboxes: [],
    selectedSandbox: null,
    conversation: null,
    conversations: { supported: false, note: null, showArchived: false, showArchivedSupported: false, rows: [] },
    composerBlocked: null,
    sendModeSupported: false,
    gitDiffSupported: false,
    gitApplySupported: false,
    applyInFlight: false,
    verification: { supported: false, note: null, commands: [], repositories: [] },
    maintenance: { supported: false, inFlight: false },
    lines: [],
    transcript: { scope: 'project', label: 'Transcript of all tasks in this project (no conversation selected)' },
    tasks: [],
    acceptedSends: 0,
    sending: false,
    status: null,
    capabilities: null,
    contextPlan: null,
    notices: [
      'P3 scaffold: sidebar wiring, Core attach and sandbox inventory are real; chat streaming is ' +
        'gated on the P0 Codex-in-SBX feasibility check (VS2).',
    ],
  };
}
