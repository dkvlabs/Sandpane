/**
 * Sandpane sidebar app — plain TypeScript, compiled as a single global script
 * (`tsconfig.webview.json`, `module: none`) so it needs no bundler and no
 * remote code. It renders state pushed by the extension host and posts only the
 * whitelisted message kinds from `src/webview/bridge.ts`.
 *
 * Rendering model (review bug 5, specs/03 §3 "throttled repaint/batching"):
 *  - the skeleton — and in particular the COMPOSER (textarea, writable
 *    checkbox, buttons) — is built ONCE and never replaced, so a state push
 *    (refresh, reconnect, attachment preview, event poll) can never wipe a
 *    draft, reset the checkbox or steal focus;
 *  - every other region is patched in place, and only when its content changed;
 *  - state pushes are coalesced: many pushes inside one animation frame paint
 *    once, with the newest state;
 *  - interactive rows use stable ids so focus survives a region rebuild.
 *
 * Consent (review bug 6): Send is only a send when the attachment list the
 * extension last showed matches the chosen intent (read-only vs writable).
 * Otherwise pressing Send asks the extension for that list first. The
 * extension re-checks the plan id and intent, which rejects a stale or
 * wrong-intent list (it is not a defence against script in this webview).
 *
 * Deliberately NOT React + Tailwind + shadcn/ui: that stack is the VS2
 * deliverable (see README "Deferred").
 *
 * This file must stay import-free; the payload types below mirror
 * `src/webview/bridge.ts` by hand. Keep the two in sync when a field changes.
 * All text goes through `textContent` — nothing from Core is parsed as HTML.
 */

/// <reference lib="dom" />

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

type Role = 'user' | 'agent' | 'tool' | 'system';

interface ChatLine {
  role: Role;
  text: string;
  unsupported?: boolean;
  errorCode?: string;
}

interface SandboxOption {
  name: string;
  probedState: string | null;
  /** Core's recorded binding mode; null = Core has no readable binding row. */
  workspaceMode: string | null;
  /** Precomputed by the extension side — the webview interprets nothing. */
  modeBadge: string;
  modeHostWritable: boolean;
}

interface HeaderContext {
  project: string | null;
  agent: null | string;
  sandbox: null | string;
  workspaceMode: null | string;
  workspaceModeBadge: null | string;
  workspaceHostWritable: boolean;
  branch: null | string;
}

interface TaskRow {
  taskId: string;
  status: string | null;
  conversationId?: string;
  branch: string | null;
  baseCommit: string | null;
  unknownKinds: string[];
  /** A4: Core's send mode (open string), already revealed and capped. */
  mode?: string;
  /** A4: the name the task's chat chose — NOT where it runs. */
  chosenSandboxName?: string;
  /** A7: Verify… / Results… (absent from an older host = unsupported). */
  verification?: { runEnabled: boolean; runReason: string | null; runs: string[] };
}

/** A9: the Maintenance section (a click opens the native flow). */
interface MaintenancePanelView {
  supported: boolean;
  inFlight: boolean;
}

/** A7: the per-project Verification section (every string already plain text). */
interface VerificationPanelView {
  supported: boolean;
  note: string | null;
  commands: { label: string; argv: string[] }[];
  repositories: {
    repoPath: string;
    manifests: { manifest: string; suggestions: string[]; notes: string[] }[];
    unreadable: string[];
  }[];
}

interface ContextPlanView {
  planId: number;
  summary: string;
  disclosure: string;
  mode: 'read_only' | 'writable';
  attachments: { kind: string; label: string; target: string; excerpt: string; truncated: boolean }[];
  excluded: { label: string; reason: string }[];
}

type ConversationAction = 'rename' | 'archive' | 'unarchive' | 'export' | 'delete';

interface ConversationActionState {
  enabled: boolean;
  reason: string | null;
}

/** A3b: one row of Core's conversation list (strings already plain text). */
interface ConversationRow {
  id: string;
  title: string;
  archived: boolean;
  selected: boolean;
  sandboxLabel: string | null;
  statusNote: string | null;
  actions: Record<ConversationAction, ConversationActionState>;
}

interface ConversationListView {
  supported: boolean;
  note: string | null;
  showArchived: boolean;
  showArchivedSupported: boolean;
  rows: ConversationRow[];
}

interface SidebarState {
  connection: 'online' | 'connecting' | 'reconnecting' | 'offline' | 'unsupported';
  header: HeaderContext;
  sandboxes: SandboxOption[];
  selectedSandbox: string | null;
  conversation: { id: string; title: string; agentId: string; archived: boolean } | null;
  conversations: ConversationListView;
  /** Why Send is disabled (Core's own reason), or null. */
  composerBlocked: string | null;
  /** A4: Core advertises `conversation-send-mode` (absent from an older host = no). */
  sendModeSupported?: boolean;
  /** A5: Core advertises `git.diff` (absent from an older host = no). */
  gitDiffSupported?: boolean;
  /** A6: Core advertises `git.apply` + feature `git-apply` (absent = no). */
  gitApplySupported?: boolean;
  /** A6: an apply flow is running in the extension host. */
  applyInFlight?: boolean;
  /** A7: absent from an older host = unsupported. */
  verification?: VerificationPanelView;
  maintenance?: MaintenancePanelView;
  lines: ChatLine[];
  transcript: { scope: 'conversation' | 'project'; label: string };
  tasks: TaskRow[];
  acceptedSends: number;
  /** A send is in flight in the extension host: Send is disabled. */
  sending: boolean;
  status: { tone: 'ok' | 'error' | 'info'; text: string } | null;
  capabilities: {
    coreVersion: string;
    protocolVersion: number;
    instanceId: string;
    platform: string;
    sbxInstalled: boolean | null;
    // A8a — optional here so a state without them (older extension host) still paints.
    sbxNote?: string | null;
    sbxVersion?: string | null;
    sbxDaemon?: string | null;
    sbxExec?: string | null;
    sbxCaptured?: string | null;
    agents: { id: string; verified: boolean; supportsStreaming: boolean; supportsCancel: boolean }[];
  } | null;
  contextPlan: ContextPlanView | null;
  notices: string[];
}

/** Long-lived nodes of the sidebar; created once by `buildSkeleton`. */
interface SidebarRefs {
  dot: HTMLElement;
  project: HTMLElement;
  coreMeta: HTMLElement;
  meta: HTMLElement;
  select: HTMLSelectElement;
  sbx: HTMLElement;
  notices: HTMLElement;
  conversations: HTMLElement;
  verification: HTMLElement;
  maintenance: HTMLElement;
  stream: HTMLElement;
  tasks: HTMLElement;
  plan: HTMLElement;
  input: HTMLTextAreaElement;
  writable: HTMLInputElement;
  sendMode: HTMLSelectElement;
  sendModeNote: HTMLElement;
  preview: HTMLElement;
  send: HTMLButtonElement;
  composerNote: HTMLElement;
  status: HTMLElement;
}

/** Per-region "last painted" keys, so unchanged regions are not touched. */
interface PaintMemo {
  header: string;
  sandboxes: string;
  sbx: string;
  notices: string;
  conversations: string;
  verification: string;
  maintenance: string;
  composerNote: string;
  sendModeNote: string;
  lineKeys: string[];
  transcriptLabel: string;
  tasks: string;
  plan: string;
  acceptedSends: number | null;
  sendLabel: string;
  /** Text of the last send posted from here; cleared after Core accepts it. */
  sentText: string | null;
}

const LIVE_WRITABLE_LABEL = 'LIVE-WRITABLE';

// A4 copy — mirrors src/vscode/sendMode.ts (this script is import-free; a
// test pins the two copies together).
const SEND_MODE_LABEL = 'Send mode';
const CHOSEN_SANDBOX_LABEL = 'sandbox chosen by its chat \u2014 not where it runs';
const SEND_MODE_NOTE = 'Send mode: Core records whether you asked for a Task or a Discuss. Neither mode runs an agent in this build: every send stays queued. Discuss is not a sandbox, not a dry run and not safe execution.';
const APPLY_UNSUPPORTED =
  'Apply: not implemented by this Core (it does not advertise "git.apply" with the feature "git-apply")';
const APPLY_IN_FLIGHT_TITLE = 'Apply: another apply is in progress \u2014 wait for it to finish';
const VERIFICATION_UNSUPPORTED_NOTE =
  'Verification: not supported by the attached Sandpane Core (it does not advertise "verification").';
const VERIFICATION_DISCLOSURE =
  'Approved commands are exact argument lists, never run here: Verify\u2026 on a task opens a dialog in VS Code, and Core runs ' +
  'one only after you confirm it there. Suggestions are what Core detected in root manifests; approving one opens the same dialogs.';
const SEND_MODE_UNSUPPORTED = 'Task / Discuss: not supported by this Core (it does not advertise "conversation-send-mode"); every send is a Task.';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent: never HTML
  return node;
}

function valueOrDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? 'unknown' : value;
}

function stateTone(state: SidebarState): string {
  switch (state.connection) {
    case 'online':
      return 'online';
    case 'connecting':
    case 'reconnecting':
      return 'reconnecting';
    default:
      return 'offline';
  }
}

/** A DOM-id-safe token derived from a Core id (stable across repaints). */
function idToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

function intentOf(writable: boolean): 'read_only' | 'writable' {
  return writable ? 'writable' : 'read_only';
}

/** The plan the user saw, if it matches the intent currently chosen. */
function matchingPlan(state: SidebarState | null, writable: boolean): ContextPlanView | null {
  const plan = state?.contextPlan ?? null;
  return plan !== null && plan.mode === intentOf(writable) ? plan : null;
}

function buildSkeleton(
  root: HTMLElement,
  api: VsCodeApi,
  current: () => SidebarState | null,
  memo: PaintMemo,
): SidebarRefs {
  // --- header: project · Core state, then the mandatory context rows ---
  const header = el('div', 'sp-header');
  const headerRow = el('div', 'sp-header-row');
  const dot = el('span', 'sp-dot');
  dot.setAttribute('aria-hidden', 'true');
  const project = el('strong', 'sp-project');
  const coreMeta = el('span', 'sp-meta');
  headerRow.appendChild(dot);
  headerRow.appendChild(project);
  headerRow.appendChild(coreMeta);
  header.appendChild(headerRow);
  const meta = el('dl', 'sp-meta');
  header.appendChild(meta);
  root.appendChild(header);

  // --- sandbox picker (fed by Core's sandbox.list) ---
  const picker = el('div', 'sp-picker');
  const selectLabel = el('label', undefined, 'Sandbox');
  selectLabel.setAttribute('for', 'sp-sandbox-select');
  picker.appendChild(selectLabel);
  const select = el('select', 'sp-sandbox-select');
  select.id = 'sp-sandbox-select';
  select.setAttribute('aria-label', 'Sandbox selected by Sandpane Core');
  select.addEventListener('change', () => {
    api.postMessage({ type: 'selectSandbox', name: select.value });
  });
  picker.appendChild(select);
  const refresh = el('button', 'secondary', 'Refresh');
  refresh.id = 'sp-refresh';
  refresh.addEventListener('click', () => api.postMessage({ type: 'refresh' }));
  picker.appendChild(refresh);
  root.appendChild(picker);

  // --- A8a: what Core's probe says about sbx — finished text from the
  //     extension host, neutral tone (never "ready"), no daemon controls ---
  const sbx = el('div', 'sp-status');
  sbx.id = 'sp-sbx';
  sbx.setAttribute('aria-label', 'SBX status from the Sandpane Core probe');
  root.appendChild(sbx);

  // --- notices: what this build cannot do, stated up front ---
  const notices = el('div', 'sp-status');
  notices.id = 'sp-notices';
  root.appendChild(notices);

  // --- A3b: Core's conversation list (rows, archived labels, actions) ---
  const conversations = el('div', 'sp-conversations');
  conversations.id = 'sp-conversations';
  conversations.setAttribute('aria-label', 'Conversations Core lists for this project');
  root.appendChild(conversations);

  // --- A7: the project's verification commands and Core's suggestions ---
  const verification = el('div', 'sp-conversations');
  verification.id = 'sp-verification';
  verification.setAttribute('aria-label', 'Verification commands Core lists for this project');
  root.appendChild(verification);

  // --- A9: Maintenance (a click opens the native flow; no ids cross here) ---
  const maintenance = el('div', 'sp-conversations');
  maintenance.id = 'sp-maintenance';
  maintenance.setAttribute('aria-label', 'Clean up state Core itself created');
  root.appendChild(maintenance);

  // --- message stream ---
  const stream = el('div', 'sp-stream');
  stream.id = 'sp-stream';
  stream.setAttribute('role', 'log');
  root.appendChild(stream);

  // --- tasks (status comes only from Core; unknown = "no status emitted") ---
  const tasks = el('div', 'sp-attachments');
  tasks.id = 'sp-tasks';
  tasks.setAttribute('aria-label', 'Tasks Core reports for this project');
  root.appendChild(tasks);

  // --- attachment plan (explicit list before send) ---
  const plan = el('div', 'sp-attachments');
  plan.id = 'sp-plan';
  plan.setAttribute('aria-label', 'Context attachments for the next message');
  root.appendChild(plan);

  // --- composer: built once, never replaced (review bug 5) ---
  const composer = el('div', 'sp-picker');
  const input = el('textarea', 'sp-input');
  input.id = 'sp-input';
  input.setAttribute('aria-label', 'Ask the agent');
  input.placeholder = 'Ask the agent…';
  input.rows = 2;
  composer.appendChild(input);
  root.appendChild(composer);

  const actions = el('div', 'sp-picker');
  const preview = el('button', 'secondary', 'Show attachments');
  preview.id = 'sp-preview';
  const writable = el('input');
  writable.type = 'checkbox';
  writable.id = 'sp-writable';
  const writableLabel = el('label', undefined, 'writable task');
  writableLabel.setAttribute('for', writable.id);
  const send = el('button', undefined, 'Send');
  send.id = 'sp-send';
  // A4: Task / Discuss. Built once, Task by default, disabled until Core
  // advertises `conversation-send-mode`; not remembered (UI-only DOM state).
  const sendMode = el('select', 'sp-sandbox-select');
  sendMode.id = 'sp-send-mode';
  sendMode.setAttribute('aria-label', SEND_MODE_LABEL);
  for (const [value, label] of [
    ['task', 'Task'],
    ['discuss', 'Discuss'],
  ] as const) {
    const option = el('option', undefined, label);
    option.value = value;
    sendMode.appendChild(option);
  }
  sendMode.value = 'task';
  sendMode.disabled = true;

  const requestPreview = (): void => {
    api.postMessage({ type: 'previewContext', writable: writable.checked });
  };
  preview.addEventListener('click', requestPreview);
  // A shown list is tied to the intent it was built for: switching intent
  // replaces it with the list for the new intent (or keeps none).
  const intentChanged = (): void => {
    if (current()?.contextPlan) requestPreview();
    paintSendLabel(send, current(), writable.checked);
  };
  writable.addEventListener('change', intentChanged);
  // Discuss never asks for a writable workspace: it clears and locks the
  // writable intent (the extension refuses the combination as well).
  sendMode.addEventListener('change', () => {
    const discuss = sendMode.value === 'discuss';
    writable.disabled = discuss;
    if (discuss && writable.checked) {
      writable.checked = false;
      intentChanged();
    }
  });
  send.addEventListener('click', () => {
    // The extension refuses a second in-flight send anyway (review W3), and an
    // archived project/conversation (A3b); the disabled button and this check
    // keep the UI from even asking.
    const now = current();
    if (send.disabled || now?.sending === true || (now?.composerBlocked ?? null) !== null) return;
    const text = input.value;
    if (text.trim().length === 0) return;
    const plan = matchingPlan(current(), writable.checked);
    if (!plan) {
      // Never send an unseen list: ask for it, the user presses Send again.
      requestPreview();
      return;
    }
    memo.sentText = text;
    // A4: `mode` only for Discuss — and only while the choice is enabled.
    const discuss = !sendMode.disabled && sendMode.value === 'discuss';
    api.postMessage({
      type: 'send',
      text,
      writable: writable.checked,
      planId: plan.planId,
      ...(discuss ? { mode: 'discuss' } : {}),
    });
  });
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      send.click();
    }
  });
  actions.appendChild(preview);
  actions.appendChild(sendMode);
  actions.appendChild(writable);
  actions.appendChild(writableLabel);
  actions.appendChild(send);
  root.appendChild(actions);

  // --- A4: what the send mode is (and is not) ---
  const sendModeNote = el('div', 'sp-status');
  sendModeNote.id = 'sp-send-mode-note';
  sendModeNote.setAttribute('role', 'note');
  root.appendChild(sendModeNote);

  // --- why Send is disabled (Core's own reason), when it is ---
  const composerNote = el('div', 'sp-status');
  composerNote.id = 'sp-composer-note';
  composerNote.setAttribute('data-tone', 'error');
  composerNote.setAttribute('role', 'note');
  root.appendChild(composerNote);

  // --- status line ---
  const status = el('div', 'sp-status');
  status.id = 'sp-status';
  root.appendChild(status);

  return {
    dot,
    project,
    coreMeta,
    meta,
    select,
    sbx,
    notices,
    conversations,
    verification,
    maintenance,
    stream,
    tasks,
    plan,
    input,
    writable,
    sendMode,
    sendModeNote,
    preview,
    send,
    composerNote,
    status,
  };
}

function paintSendLabel(send: HTMLElement, state: SidebarState | null, writable: boolean): string {
  const label = matchingPlan(state, writable) ? 'Send' : 'Review attachments to send';
  if (send.textContent !== label) send.textContent = label;
  return label;
}

/** Rebuild one region, restoring focus to the element with the same id. */
function rebuildRegion(region: HTMLElement, children: HTMLElement[]): void {
  const active = document.activeElement;
  const focusedId = active instanceof HTMLElement && region.contains(active) ? active.id : '';
  region.replaceChildren(...children);
  if (focusedId) {
    const again = document.getElementById(focusedId);
    if (again instanceof HTMLElement) again.focus();
  }
}

const ACTION_LABELS: ReadonlyArray<[ConversationAction, string]> = [
  ['rename', 'Rename'],
  ['archive', 'Archive'],
  ['unarchive', 'Unarchive'],
  ['export', 'Export'],
  ['delete', 'Delete'],
];

/**
 * The conversation list (A3b). Every action is a whitelisted message; the
 * extension shows the native dialog, gates on Core's advertisement and decides.
 * A disabled action keeps its reason visible (title + text), never hidden.
 */
function conversationChildren(view: ConversationListView, api: VsCodeApi): HTMLElement[] {
  const children: HTMLElement[] = [];
  const head = el('div', 'sp-picker');
  head.appendChild(el('strong', undefined, 'Conversations'));
  const fresh = el('button', 'secondary', 'New conversation');
  fresh.id = 'sp-conv-new';
  fresh.setAttribute('title', 'The next send starts a new conversation in this project.');
  fresh.addEventListener('click', () => api.postMessage({ type: 'selectConversation', conversationId: '' }));
  head.appendChild(fresh);
  const toggle = el('button', 'secondary', view.showArchived ? 'Hide archived' : 'Show archived');
  toggle.id = 'sp-conv-archived';
  toggle.setAttribute('aria-pressed', view.showArchived ? 'true' : 'false');
  if (!view.showArchivedSupported) {
    toggle.disabled = true;
    toggle.setAttribute('title', 'not supported by the attached Sandpane Core (it does not advertise "conversation.archive")');
  }
  toggle.addEventListener('click', () => api.postMessage({ type: 'toggleArchivedConversations' }));
  head.appendChild(toggle);
  children.push(head);
  if (view.note !== null) children.push(el('div', 'sp-empty', view.note));

  for (const row of view.rows) {
    const token = idToken(row.id);
    const box = el('div', 'sp-conv-row');
    box.setAttribute('data-archived', row.archived ? 'true' : 'false');
    box.setAttribute('data-selected', row.selected ? 'true' : 'false');
    const titleRow = el('div', 'sp-picker');
    const open = el('button', 'secondary sp-conv-title', row.title);
    open.id = `sp-conv-open-${token}`;
    open.setAttribute('aria-pressed', row.selected ? 'true' : 'false');
    open.setAttribute('aria-label', `Open conversation ${row.title}${row.archived ? ' (archived)' : ''}`);
    open.addEventListener('click', () => api.postMessage({ type: 'selectConversation', conversationId: row.id }));
    titleRow.appendChild(open);
    if (row.archived) titleRow.appendChild(el('span', 'sp-chip', 'ARCHIVED'));
    box.appendChild(titleRow);
    if (row.sandboxLabel !== null) box.appendChild(el('div', 'sp-empty', row.sandboxLabel));
    if (row.statusNote !== null) box.appendChild(el('div', 'sp-empty', row.statusNote));

    const actions = el('div', 'sp-picker');
    const unavailable: string[] = [];
    for (const [action, label] of ACTION_LABELS) {
      // Only the archive toggle that applies is offered.
      if (action === 'archive' && row.archived) continue;
      if (action === 'unarchive' && !row.archived) continue;
      const state = row.actions[action];
      const button = el('button', 'secondary', label);
      button.id = `sp-conv-${action}-${token}`;
      if (!state.enabled) {
        button.disabled = true;
        if (state.reason !== null) {
          button.setAttribute('title', state.reason);
          button.setAttribute('aria-label', `${label}: unavailable — ${state.reason}`);
          unavailable.push(`${label}: ${state.reason}`);
        }
      } else {
        button.setAttribute('aria-label', `${label} conversation ${row.title}`);
      }
      button.addEventListener('click', () =>
        api.postMessage({ type: 'conversationAction', action, conversationId: row.id }),
      );
      actions.appendChild(button);
    }
    box.appendChild(actions);
    if (unavailable.length > 0) box.appendChild(el('div', 'sp-empty', `Not available — ${unavailable.join(' · ')}`));
    children.push(box);
  }
  return children;
}

const VERIFICATION_BUTTONS: ReadonlyArray<[id: string, action: string, label: string, title: string]> = [
  ['sp-verify-add', 'add', 'Add\u2026', 'Add a verification command: label and exact arguments, then confirm in a dialog'],
  ['sp-verify-suggest', 'approveSuggestion', 'Approve suggestion\u2026', "Pick one of Core's detected suggestions, then confirm in a dialog"],
  ['sp-verify-revoke', 'revoke', 'Revoke\u2026', 'Pick an approved command and confirm; future runs only'],
  ['sp-verify-refresh', 'refresh', 'Refresh', 'Re-read the list and the suggestions from Core (read-only)'],
];

/**
 * The Verification section (A7). Buttons post ONLY `{type, action}`: the
 * extension opens a native dialog filled from a fresh Core read. Labels,
 * arguments, suggestions and notes are text (textContent), never run here.
 */
function verificationChildren(view: VerificationPanelView, api: VsCodeApi): HTMLElement[] {
  const children: HTMLElement[] = [];
  const head = el('div', 'sp-picker');
  head.appendChild(el('strong', undefined, 'Verification'));
  for (const [id, action, label, title] of VERIFICATION_BUTTONS) {
    const button = el('button', 'secondary', label);
    button.id = id;
    if (view.supported) {
      button.setAttribute('title', title);
    } else {
      button.disabled = true;
      button.setAttribute('title', VERIFICATION_UNSUPPORTED_NOTE);
    }
    button.addEventListener('click', () => api.postMessage({ type: 'verificationAction', action }));
    head.appendChild(button);
  }
  children.push(head);
  if (!view.supported) {
    children.push(el('div', 'sp-empty', view.note ?? VERIFICATION_UNSUPPORTED_NOTE));
    return children;
  }
  if (view.note !== null) children.push(el('div', 'sp-empty', view.note));
  children.push(el('div', 'sp-empty', VERIFICATION_DISCLOSURE));
  if (view.commands.length === 0) children.push(el('div', 'sp-empty', 'No approved verification command for this project.'));
  for (const command of view.commands) {
    const box = el('div', 'sp-conv-row');
    box.appendChild(el('div', 'sp-conv-title', command.label));
    box.appendChild(el('pre', 'sp-msg-body', command.argv.join('\n')));
    children.push(box);
  }
  for (const repo of view.repositories) {
    const box = el('div', 'sp-conv-row');
    box.appendChild(el('div', 'sp-empty', `Suggestions Core detected in ${repo.repoPath}:`));
    if (repo.manifests.length === 0) box.appendChild(el('div', 'sp-empty', 'none'));
    for (const manifest of repo.manifests) {
      box.appendChild(el('div', 'sp-chip', manifest.manifest));
      if (manifest.suggestions.length > 0) box.appendChild(el('pre', 'sp-msg-body', manifest.suggestions.join('\n')));
      for (const note of manifest.notes) box.appendChild(el('div', 'sp-empty', `note from Core: ${note}`));
    }
    if (repo.unreadable.length > 0) box.appendChild(el('div', 'sp-empty', `not read: ${repo.unreadable.join(', ')}`));
    children.push(box);
  }
  return children;
}

const MAINTENANCE_UNSUPPORTED_NOTE =
  'Maintenance: not supported by the attached Sandpane Core (it does not advertise "maintenance").';

/**
 * The Maintenance section (A9). The button posts ONLY `{type}`; the extension
 * opens the native flow filled from a fresh Core read, and nothing is removed
 * without its modal.
 */
function maintenanceChildren(view: MaintenancePanelView, api: VsCodeApi): HTMLElement[] {
  const children: HTMLElement[] = [];
  const head = el('div', 'sp-picker');
  head.appendChild(el('strong', undefined, 'Maintenance'));
  const button = el('button', 'secondary', 'Clean up…');
  button.id = 'sp-maintenance-scan';
  if (view.supported && !view.inFlight) {
    button.setAttribute('title', 'Scan what Core itself created (temporary directories, migration backups, stored verification output) and confirm a cleanup');
  } else {
    button.disabled = true;
    button.setAttribute('title', view.inFlight && view.supported ? 'A maintenance dialog is already open' : MAINTENANCE_UNSUPPORTED_NOTE);
  }
  button.addEventListener('click', () => api.postMessage({ type: 'maintenanceScan' }));
  head.appendChild(button);
  children.push(head);
  if (!view.supported) {
    children.push(el('div', 'sp-empty', MAINTENANCE_UNSUPPORTED_NOTE));
    return children;
  }
  children.push(
    el('div', 'sp-empty', 'Cleans up only state Core itself created; worktrees are report-only. Nothing runs automatically.'),
  );
  return children;
}

function paint(refs: SidebarRefs, memo: PaintMemo, state: SidebarState, api: VsCodeApi): void {
  // --- header ---
  const headerKey = JSON.stringify([state.connection, state.capabilities?.coreVersion ?? '', state.header]);
  if (headerKey !== memo.header) {
    memo.header = headerKey;
    refs.dot.setAttribute('data-state', stateTone(state));
    refs.project.textContent = valueOrDash(state.header.project);
    refs.coreMeta.textContent =
      state.connection === 'online'
        ? `Core ${state.capabilities ? state.capabilities.coreVersion : ''}`.trim()
        : state.connection;
    const rows: HTMLElement[] = [];
    const addMeta = (label: string, value: string, badge: string | null): void => {
      rows.push(el('dt', undefined, label));
      const dd = el('dd');
      dd.appendChild(el('span', undefined, value));
      if (badge !== null) {
        const live = el('span', 'sp-live', badge);
        live.setAttribute('title', 'The agent may change these host files immediately (or the mode is unverified).');
        dd.appendChild(live);
      }
      rows.push(dd);
    };
    addMeta('Sandbox', valueOrDash(state.header.sandbox), null);
    addMeta('Agent', valueOrDash(state.header.agent), null);
    // A host-writable mode (direct_mount, unknown or UNVERIFIED) is always loud.
    const modeText =
      state.header.workspaceModeBadge === null
        ? 'no sandbox selected'
        : `${valueOrDash(state.header.workspaceMode)} · ${state.header.workspaceModeBadge}`;
    addMeta(
      'Workspace',
      modeText,
      state.header.workspaceHostWritable ? (state.header.workspaceMode === 'direct_mount' ? LIVE_WRITABLE_LABEL : 'TREAT AS LIVE-WRITABLE') : null,
    );
    addMeta('Git branch', valueOrDash(state.header.branch), null);
    refs.meta.replaceChildren(...rows);
  }

  // --- sandbox picker: options rebuilt only when they changed, so an open
  //     dropdown is not closed by an unrelated state push ---
  const sandboxKey = JSON.stringify([state.sandboxes, state.selectedSandbox]);
  if (sandboxKey !== memo.sandboxes) {
    memo.sandboxes = sandboxKey;
    const options: HTMLElement[] = [];
    if (state.sandboxes.length === 0) {
      const none = el('option', undefined, 'no sandboxes from Core');
      none.value = '';
      options.push(none);
    }
    for (const option of state.sandboxes) {
      // The mode travels with the name: never left blank so a user could read
      // an unverified mount as safe (specs/02 §7).
      const parts = [option.name];
      if (option.probedState) parts.push(option.probedState);
      parts.push(option.modeBadge);
      const opt = el('option', undefined, parts.join(' · '));
      opt.value = option.name;
      if (option.modeHostWritable) {
        opt.setAttribute('title', `${option.name}: ${option.modeBadge} — the agent can change host files in this workspace.`);
      }
      if (option.name === state.selectedSandbox) opt.selected = true;
      options.push(opt);
    }
    refs.select.replaceChildren(...options);
  }

  // --- A8a sbx status: text only, every line neutral; an absent exec /
  //     captured line means Core did not say, so nothing is shown. Only while
  //     Core is online: the last probe is not shown as current when Core is
  //     unreachable (the extension host keeps its capabilities across a drop) ---
  const caps = state.capabilities;
  const sbxLines: string[] = [];
  if (caps !== null && state.connection === 'online') {
    // Not installed / not reported: the note replaces every other line.
    if (caps.sbxNote !== undefined && caps.sbxNote !== null) sbxLines.push(caps.sbxNote);
    if (caps.sbxDaemon !== undefined && caps.sbxDaemon !== null) sbxLines.push(caps.sbxDaemon);
    if (caps.sbxVersion !== undefined && caps.sbxVersion !== null) sbxLines.push(`sbx version: ${caps.sbxVersion}`);
    if (caps.sbxExec !== undefined && caps.sbxExec !== null) sbxLines.push(caps.sbxExec);
    if (caps.sbxCaptured !== undefined && caps.sbxCaptured !== null) sbxLines.push(caps.sbxCaptured);
  }
  const sbxKey = JSON.stringify(sbxLines);
  if (sbxKey !== memo.sbx) {
    memo.sbx = sbxKey;
    refs.sbx.replaceChildren(...sbxLines.map((line) => el('div', 'sp-empty', line)));
  }

  // --- notices ---
  const noticesKey = JSON.stringify(state.notices);
  if (noticesKey !== memo.notices) {
    memo.notices = noticesKey;
    refs.notices.replaceChildren(...state.notices.map((notice) => el('div', 'sp-empty', notice)));
  }

  // --- conversation list (A3b): rebuilt only when it changed; stable ids keep focus ---
  const conversationView: ConversationListView = state.conversations ?? {
    supported: false,
    note: null,
    showArchived: false,
    showArchivedSupported: false,
    rows: [],
  };
  const conversationsKey = JSON.stringify(conversationView);
  if (conversationsKey !== memo.conversations) {
    memo.conversations = conversationsKey;
    rebuildRegion(refs.conversations, conversationChildren(conversationView, api));
  }

  // --- A7 verification section: rebuilt only when it changed ---
  const verificationView: VerificationPanelView = state.verification ?? {
    supported: false,
    note: null,
    commands: [],
    repositories: [],
  };
  const verificationKey = JSON.stringify(verificationView);
  if (verificationKey !== memo.verification) {
    memo.verification = verificationKey;
    rebuildRegion(refs.verification, verificationChildren(verificationView, api));
  }

  // --- A9 maintenance section: rebuilt only when it changed ---
  const maintenanceView: MaintenancePanelView = state.maintenance ?? { supported: false, inFlight: false };
  const maintenanceKey = JSON.stringify(maintenanceView);
  if (maintenanceKey !== memo.maintenance) {
    memo.maintenance = maintenanceKey;
    rebuildRegion(refs.maintenance, maintenanceChildren(maintenanceView, api));
  }

  // --- message stream: append when the transcript only grew ---
  if (state.transcript.label !== memo.transcriptLabel) {
    memo.transcriptLabel = state.transcript.label;
    refs.stream.setAttribute('aria-label', state.transcript.label);
  }
  const lineKeys = state.lines.map((line) => JSON.stringify([line.role, line.errorCode ?? '', line.text]));
  const grewOnly =
    memo.lineKeys.length > 0 &&
    lineKeys.length >= memo.lineKeys.length &&
    memo.lineKeys.every((key, i) => key === lineKeys[i]);
  const renderLine = (line: ChatLine): HTMLElement => {
    const article = el('article', 'sp-msg');
    article.setAttribute('data-role', line.role);
    article.appendChild(el('div', 'sp-msg-role', line.errorCode ? `${line.role} · ${line.errorCode}` : line.role));
    article.appendChild(el('pre', 'sp-msg-body', line.text));
    return article;
  };
  if (grewOnly) {
    for (const line of state.lines.slice(memo.lineKeys.length)) refs.stream.appendChild(renderLine(line));
  } else if (lineKeys.length === 0) {
    if (memo.lineKeys.length > 0 || refs.stream.childNodes.length === 0) {
      refs.stream.replaceChildren(
        el('div', 'sp-empty', 'No messages yet. The composer below sends through Core; each prompt creates a task record.'),
      );
    }
  } else {
    refs.stream.replaceChildren(...state.lines.map(renderLine));
  }
  memo.lineKeys = lineKeys;

  // --- tasks: stable button ids keep focus across a rebuild ---
  const tasksKey = JSON.stringify([
    state.tasks,
    state.gitDiffSupported === true,
    state.gitApplySupported === true,
    state.applyInFlight === true,
    state.verification?.supported === true,
  ]);
  if (tasksKey !== memo.tasks) {
    memo.tasks = tasksKey;
    const children: HTMLElement[] = [];
    for (const row of state.tasks) {
      const token = idToken(row.taskId);
      const chip = el(
        'span',
        'sp-chip',
        `task ${row.taskId.slice(0, 8)} · ${row.status ?? 'no status from Core'}` +
          (row.unknownKinds.length > 0 ? ` · ${row.unknownKinds.length} unrecognized event(s)` : ''),
      );
      chip.setAttribute('title', `branch: ${valueOrDash(row.branch)} · base: ${valueOrDash(row.baseCommit)}`);
      children.push(chip);
      // A4: read-only, as Core reported them (already revealed and capped).
      if (typeof row.mode === 'string' && row.mode.length > 0) {
        children.push(el('span', 'sp-chip', `${SEND_MODE_LABEL}: ${row.mode}`));
      }
      if (typeof row.chosenSandboxName === 'string' && row.chosenSandboxName.length > 0) {
        children.push(el('span', 'sp-chip', `${CHOSEN_SANDBOX_LABEL}: ${row.chosenSandboxName}`));
      }

      const review = el('button', 'secondary', 'Review');
      review.id = `sp-review-${token}`;
      review.setAttribute('aria-label', `Review changes of task ${row.taskId}`);
      review.addEventListener('click', () => api.postMessage({ type: 'reviewTask', taskId: row.taskId }));
      children.push(review);

      // A5: the patch of one file, read-only — enabled only when Core
      // advertises git.diff (a disabled button never posts).
      const diff = el('button', 'secondary', 'Diff');
      diff.id = `sp-diff-${token}`;
      diff.setAttribute('aria-label', `Show the patch of one file of task ${row.taskId}`);
      if (state.gitDiffSupported === true) {
        diff.setAttribute('title', "Pick a file and show Core's patch, read-only");
      } else {
        diff.disabled = true;
        diff.setAttribute('title', 'Diff: not supported by this Core (it does not advertise "git.diff")');
      }
      diff.addEventListener('click', () => api.postMessage({ type: 'showTaskPatch', taskId: row.taskId }));
      children.push(diff);

      // A6: Apply reviewed files — enabled only when Core advertises git.apply
      // AND the feature git-apply; a click opens the file picker and then a
      // native modal in the extension host (nothing is sent without it).
      const apply = el('button', 'secondary', 'Apply\u2026');
      apply.id = `sp-apply-${token}`;
      apply.setAttribute('aria-label', `Apply reviewed files of task ${row.taskId} (asks for confirmation)`);
      if (state.gitApplySupported !== true) {
        apply.disabled = true;
        apply.setAttribute('title', APPLY_UNSUPPORTED);
      } else if (state.applyInFlight === true) {
        apply.disabled = true;
        apply.setAttribute('title', APPLY_IN_FLIGHT_TITLE);
      } else {
        apply.setAttribute('title', 'Pick reviewed files and confirm in a dialog; Core writes and stages them (never commits)');
      }
      apply.addEventListener('click', () => api.postMessage({ type: 'applyTask', taskId: row.taskId }));
      children.push(apply);

      // A7: Verify… (opens the Run dialog in the extension host) and
      // Results… (pick a run Core's events name). Only the task id is posted.
      const verify = row.verification;
      const verificationOn = state.verification?.supported === true && verify !== undefined;
      const run = el('button', 'secondary', 'Verify\u2026');
      run.id = `sp-verify-run-${token}`;
      run.setAttribute('aria-label', `Run an approved verification command on task ${row.taskId} (asks for confirmation)`);
      const runReason = !verificationOn
        ? VERIFICATION_UNSUPPORTED_NOTE
        : verify.runEnabled
          ? null
          : (verify.runReason ?? 'unavailable');
      if (runReason === null) {
        run.setAttribute('title', "Pick an approved command and confirm in a dialog; Core runs it in the task's sandbox");
      } else {
        run.disabled = true;
        run.setAttribute('title', runReason);
      }
      run.addEventListener('click', () => api.postMessage({ type: 'runVerification', taskId: row.taskId }));
      children.push(run);
      const results = el('button', 'secondary', 'Results\u2026');
      results.id = `sp-verify-results-${token}`;
      results.setAttribute('aria-label', `Show a verification result of task ${row.taskId} (read-only)`);
      if (verificationOn) {
        results.setAttribute('title', "Pick a run Core's events name and open its output, read-only");
      } else {
        results.disabled = true;
        results.setAttribute('title', VERIFICATION_UNSUPPORTED_NOTE);
      }
      results.addEventListener('click', () => api.postMessage({ type: 'showVerificationResults', taskId: row.taskId }));
      children.push(results);
      if (verificationOn && runReason !== null) children.push(el('div', 'sp-empty', `Verify: ${runReason}`));
      for (const line of verificationOn ? verify.runs : []) children.push(el('div', 'sp-empty', `verification: ${line}`));

      // Cancel is an explicit request; Core decides whether the state allows it.
      const cancel = el('button', 'secondary', 'Cancel');
      cancel.id = `sp-cancel-${token}`;
      cancel.setAttribute('aria-label', `Ask Core to cancel task ${row.taskId}`);
      cancel.addEventListener('click', () => api.postMessage({ type: 'cancelTask', taskId: row.taskId }));
      children.push(cancel);
    }
    rebuildRegion(refs.tasks, children);
  }

  // --- attachment plan ---
  const planKey = JSON.stringify(state.contextPlan);
  if (planKey !== memo.plan) {
    memo.plan = planKey;
    const plan = state.contextPlan;
    const children: HTMLElement[] = [];
    if (plan) {
      children.push(
        el('div', 'sp-status', `${plan.mode === 'writable' ? 'Writable task' : 'Read-only discussion'}: ${plan.summary}`),
      );
      for (const attachment of plan.attachments) {
        children.push(
          el('span', 'sp-chip', `${attachment.kind}: ${attachment.label}${attachment.truncated ? ' (preview clipped)' : ''}`),
        );
      }
      for (const excluded of plan.excluded) {
        children.push(el('span', 'sp-chip', `not attached — ${excluded.label}: ${excluded.reason}`));
      }
      children.push(el('div', 'sp-status', plan.disclosure));
    }
    refs.plan.replaceChildren(...children);
  }

  // --- composer: never rebuilt. The draft is cleared only after Core
  //     accepted a send from here (never optimistically). ---
  if (memo.acceptedSends === null) {
    memo.acceptedSends = state.acceptedSends;
  } else if (state.acceptedSends > memo.acceptedSends) {
    memo.acceptedSends = state.acceptedSends;
    // Clear only if the box still holds exactly what was sent — never text the
    // user typed after pressing Send (review S2).
    if (memo.sentText !== null && refs.input.value === memo.sentText) refs.input.value = '';
    memo.sentText = null;
  }
  const blocked = state.composerBlocked ?? null;
  const sendDisabled = state.sending || blocked !== null;
  if (refs.send.disabled !== sendDisabled) refs.send.disabled = sendDisabled;
  const noteText = blocked ?? '';
  if (noteText !== memo.composerNote) {
    memo.composerNote = noteText;
    refs.composerNote.textContent = noteText;
  }
  // A4: an unadvertised send mode is locked at Task (never sent).
  const modeSupported = state.sendModeSupported === true;
  if (!modeSupported && refs.sendMode.value !== 'task') {
    refs.sendMode.value = 'task';
    refs.writable.disabled = false;
  }
  if (refs.sendMode.disabled === modeSupported) refs.sendMode.disabled = !modeSupported;
  const modeNote = modeSupported ? SEND_MODE_NOTE : SEND_MODE_UNSUPPORTED;
  if (modeNote !== memo.sendModeNote) {
    memo.sendModeNote = modeNote;
    refs.sendModeNote.textContent = modeNote;
  }
  memo.sendLabel = paintSendLabel(refs.send, state, refs.writable.checked);

  // --- status line ---
  const tone = state.status ? state.status.tone : 'info';
  if (refs.status.getAttribute('data-tone') !== tone) refs.status.setAttribute('data-tone', tone);
  const statusText = state.status ? state.status.text : '';
  if (refs.status.textContent !== statusText) refs.status.textContent = statusText;
}

function bootSandpaneSidebar(): void {
  const api = acquireVsCodeApi();
  const root = document.getElementById('sandpane-root');
  const announcer = document.getElementById('sp-announcer');
  if (!(root instanceof HTMLElement)) return;

  let latest: SidebarState | null = null;
  let painted: SidebarState | null = null;
  let frameRequested = false;
  let lastLineCount = 0;
  const memo: PaintMemo = {
    header: '',
    sandboxes: '',
    sbx: '',
    notices: '',
    conversations: '',
    verification: '',
    maintenance: '',
    composerNote: '',
    sendModeNote: '',
    lineKeys: [],
    transcriptLabel: '',
    tasks: '',
    plan: '',
    acceptedSends: null,
    sendLabel: '',
    sentText: null,
  };
  const refs = buildSkeleton(root, api, () => painted, memo);

  const flush = (): void => {
    frameRequested = false;
    const state = latest;
    latest = null;
    if (!state) return;
    painted = state;
    paint(refs, memo, state, api);
    if (announcer && state.lines.length > lastLineCount) {
      const newest = state.lines[state.lines.length - 1];
      // Screen-reader announcement for new messages (specs/03 §3).
      announcer.textContent = newest ? `${newest.role}: ${newest.text.slice(0, 160)}` : '';
    }
    lastLineCount = state.lines.length;
  };

  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; state?: SidebarState } | undefined;
    if (!data || data.type !== 'state' || !data.state) return;
    // Coalesce: only the newest state of a frame is painted.
    latest = data.state;
    if (!frameRequested) {
      frameRequested = true;
      window.requestAnimationFrame(flush);
    }
  });

  api.postMessage({ type: 'ready' });
}

bootSandpaneSidebar();
