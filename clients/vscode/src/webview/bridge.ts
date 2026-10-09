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
}

export interface CapabilitySummary {
  coreVersion: string;
  protocolVersion: number;
  instanceId: string;
  platform: string;
  sbxInstalled: boolean | null;
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

export interface SidebarState {
  connection: ConnectionTone;
  header: HeaderContext;
  sandboxes: SandboxOption[];
  selectedSandbox: string | null;
  conversation: { id: string; title: string; agentId: string } | null;
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
  | { type: 'send'; text: string; writable: boolean; planId: number | null }
  | { type: 'cancelTask'; taskId: string }
  | { type: 'reviewTask'; taskId: string };

export type ExtensionToWebview = { type: 'state'; state: SidebarState };

export const WEBVIEW_MESSAGE_KINDS: readonly string[] = [
  'ready',
  'refresh',
  'selectSandbox',
  'previewContext',
  'send',
  'cancelTask',
  'reviewTask',
];

/** Runtime gate for inbound webview messages — unknown kinds are dropped. */
export function parseWebviewMessage(raw: unknown): WebviewToExtension | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string' || !WEBVIEW_MESSAGE_KINDS.includes(type)) return undefined;
  switch (type) {
    case 'ready':
    case 'refresh':
      return { type };
    case 'previewContext':
      return { type: 'previewContext', writable: (raw as { writable?: unknown }).writable === true };
    case 'selectSandbox': {
      const name = (raw as { name?: unknown }).name;
      return typeof name === 'string' ? { type: 'selectSandbox', name } : undefined;
    }
    case 'send': {
      const r = raw as { text?: unknown; writable?: unknown; planId?: unknown };
      if (typeof r.text !== 'string') return undefined;
      return {
        type: 'send',
        text: r.text,
        writable: r.writable === true,
        planId: typeof r.planId === 'number' && Number.isSafeInteger(r.planId) && r.planId >= 0 ? r.planId : null,
      };
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
