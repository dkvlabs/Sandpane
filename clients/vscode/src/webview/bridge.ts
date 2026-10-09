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
  workspaceMode: WorkspaceMode | string | null;
  branch: string | null;
}

export interface SandboxOption {
  name: string;
  probedState: string | null;
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
  summary: string;
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
  tasks: TaskRow[];
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
  | { type: 'previewContext' }
  | { type: 'send'; text: string; writable: boolean; authorizedContext: boolean }
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
    case 'previewContext':
      return { type };
    case 'selectSandbox': {
      const name = (raw as { name?: unknown }).name;
      return typeof name === 'string' ? { type: 'selectSandbox', name } : undefined;
    }
    case 'send': {
      const r = raw as { text?: unknown; writable?: unknown; authorizedContext?: unknown };
      if (typeof r.text !== 'string') return undefined;
      return {
        type: 'send',
        text: r.text,
        writable: r.writable === true,
        authorizedContext: r.authorizedContext === true,
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
    header: { project: null, agent: null, sandbox: null, workspaceMode: null, branch: null },
    sandboxes: [],
    selectedSandbox: null,
    conversation: null,
    lines: [],
    tasks: [],
    status: null,
    capabilities: null,
    contextPlan: null,
    notices: [
      'P3 scaffold: sidebar wiring, Core attach and sandbox inventory are real; chat streaming is ' +
        'gated on the P0 Codex-in-SBX feasibility check (VS2).',
    ],
  };
}
