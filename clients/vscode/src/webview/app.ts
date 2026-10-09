/**
 * Sandpane sidebar app — plain TypeScript, compiled as a single global script
 * (`tsconfig.webview.json`, `module: none`) so it needs no bundler and no
 * remote code. It renders state pushed by the extension host and posts only the
 * whitelisted message kinds from `src/webview/bridge.ts`.
 *
 * Deliberately NOT React + Tailwind + shadcn/ui: that stack is the VS2
 * deliverable (see README "Deferred"), and a spec-faithful component tree would
 * be a lot of machinery to claim before the chat gate (P0 Codex-in-SBX) can pass.
 *
 * This file must stay import-free; the payload types below mirror
 * `src/webview/bridge.ts` by hand. Keep the two in sync when a field changes.
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
  branch: null | string;
}

interface TaskRow {
  taskId: string;
  status: string | null;
  branch: string | null;
  baseCommit: string | null;
  unknownKinds: string[];
}

interface ContextPlanView {
  summary: string;
  mode: 'read_only' | 'writable';
  attachments: { kind: string; label: string; target: string; excerpt: string; truncated: boolean }[];
  excluded: { label: string; reason: string }[];
}

interface SidebarState {
  connection: 'online' | 'connecting' | 'reconnecting' | 'offline' | 'unsupported';
  header: HeaderContext;
  sandboxes: SandboxOption[];
  selectedSandbox: string | null;
  conversation: { id: string; title: string; agentId: string } | null;
  lines: ChatLine[];
  tasks: TaskRow[];
  status: { tone: 'ok' | 'error' | 'info'; text: string } | null;
  capabilities: {
    coreVersion: string;
    protocolVersion: number;
    instanceId: string;
    platform: string;
    sbxInstalled: boolean | null;
    agents: { id: string; verified: boolean; supportsStreaming: boolean; supportsCancel: boolean }[];
  } | null;
  contextPlan: ContextPlanView | null;
  notices: string[];
}

const LIVE_WRITABLE_LABEL = 'LIVE-WRITABLE';

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

function mount(root: HTMLElement, state: SidebarState): void {
  const api = (window as unknown as { __sandpaneApi?: VsCodeApi }).__sandpaneApi;
  if (!api) return;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';

  root.replaceChildren();

  // --- header: project · Core state, then the five mandatory context rows ---
  const header = el('div', 'sp-header');
  const headerRow = el('div', 'sp-header-row');
  const dot = el('span', 'sp-dot');
  dot.setAttribute('data-state', stateTone(state));
  dot.setAttribute('aria-hidden', 'true');
  headerRow.appendChild(dot);
  headerRow.appendChild(el('strong', 'sp-project', valueOrDash(state.header.project)));
  headerRow.appendChild(
    el(
      'span',
      'sp-meta',
      state.connection === 'online'
        ? `Core ${state.capabilities ? state.capabilities.coreVersion : ''}`.trim()
        : state.connection,
    ),
  );
  header.appendChild(headerRow);

  const meta = el('dl', 'sp-meta');
  const addMeta = (label: string, value: string, live: boolean): void => {
    meta.appendChild(el('dt', undefined, label));
    const dd = el('dd');
    dd.appendChild(el('span', undefined, value));
    if (live) {
      const badge = el('span', 'sp-live', LIVE_WRITABLE_LABEL);
      badge.setAttribute('title', 'Direct mount: the agent can change these host files immediately.');
      dd.appendChild(badge);
    }
    meta.appendChild(dd);
  };
  addMeta('Sandbox', valueOrDash(state.header.sandbox), false);
  addMeta('Agent', valueOrDash(state.header.agent), false);
  addMeta(
    'Workspace',
    valueOrDash(state.header.workspaceMode),
    state.header.workspaceMode === 'direct_mount',
  );
  addMeta('Git branch', valueOrDash(state.header.branch), false);
  header.appendChild(meta);
  root.appendChild(header);

  // --- sandbox picker (fed by Core's sandbox.list) ---
  const picker = el('div', 'sp-picker');
  picker.appendChild(el('label', undefined, 'Sandbox'));
  const select = el('select', 'sp-sandbox-select') as HTMLSelectElement;
  select.id = 'sp-sandbox-select';
  select.setAttribute('aria-label', 'Sandbox selected by Sandpane Core');
  if (state.sandboxes.length === 0) {
    const none = el('option', undefined, 'no sandboxes from Core');
    none.value = '';
    select.appendChild(none);
  } else {
    for (const option of state.sandboxes) {
      // The mode travels with the name: a `direct_mount` mount is LIVE-WRITABLE
      // and an unverified one is labelled as such — never left blank so the
      // user could read it as safe (specs/02 §7).
      const parts = [option.name];
      if (option.probedState) parts.push(option.probedState);
      parts.push(option.modeBadge);
      const opt = el('option', undefined, parts.join(' · '));
      opt.value = option.name;
      if (option.modeHostWritable) {
        opt.setAttribute(
          'title',
          `${option.name}: ${option.modeBadge} — the agent can change host files in this workspace.`,
        );
      }
      if (option.name === state.selectedSandbox) opt.selected = true;
      select.appendChild(opt);
    }
  }
  select.addEventListener('change', () => {
    api.postMessage({ type: 'selectSandbox', name: select.value });
  });
  picker.appendChild(select);
  const refresh = el('button', 'secondary', 'Refresh');
  refresh.addEventListener('click', () => api.postMessage({ type: 'refresh' }));
  picker.appendChild(refresh);
  root.appendChild(picker);

  // --- notices: what this build cannot do, stated up front ---
  if (state.notices.length > 0) {
    const notices = el('div', 'sp-status');
    for (const notice of state.notices) notices.appendChild(el('div', 'sp-empty', notice));
    root.appendChild(notices);
  }

  // --- message stream ---
  const stream = el('div', 'sp-stream');
  stream.id = 'sp-stream';
  stream.setAttribute('role', 'log');
  stream.setAttribute('aria-label', 'Sandpane conversation');
  if (state.lines.length === 0) {
    stream.appendChild(
      el(
        'div',
        'sp-empty',
        'No messages yet. The composer below sends through Core; each prompt creates a task record.',
      ),
    );
  }
  for (const line of state.lines) {
    const article = el('article', 'sp-msg');
    article.setAttribute('data-role', line.role);
    article.appendChild(el('div', 'sp-msg-role', line.errorCode ? `${line.role} · ${line.errorCode}` : line.role));
    article.appendChild(el('pre', 'sp-msg-body', line.text));
    stream.appendChild(article);
  }
  root.appendChild(stream);

  // --- tasks (status comes only from Core; unknown = "no status emitted") ---
  if (state.tasks.length > 0) {
    const tasks = el('div', 'sp-attachments');
    tasks.setAttribute('aria-label', 'Tasks known to Core for this conversation');
    for (const row of state.tasks) {
      const chip = el(
        'span',
        'sp-chip',
        `task ${row.taskId.slice(0, 8)} · ${row.status ?? 'no status from Core'}` +
          (row.unknownKinds.length > 0 ? ` · ${row.unknownKinds.length} unrecognized event(s)` : ''),
      );
      chip.setAttribute('title', `branch: ${valueOrDash(row.branch)} · base: ${valueOrDash(row.baseCommit)}`);
      tasks.appendChild(chip);

      const review = el('button', 'secondary', 'Review');
      review.setAttribute('aria-label', `Review changes of task ${row.taskId}`);
      review.addEventListener('click', () => api.postMessage({ type: 'reviewTask', taskId: row.taskId }));
      tasks.appendChild(review);

      // Cancel is an explicit request; Core decides whether the state allows it.
      const cancel = el('button', 'secondary', 'Cancel');
      cancel.setAttribute('aria-label', `Ask Core to cancel task ${row.taskId}`);
      cancel.addEventListener('click', () => api.postMessage({ type: 'cancelTask', taskId: row.taskId }));
      tasks.appendChild(cancel);
    }
    root.appendChild(tasks);
  }

  // --- attachment plan (explicit list before send) ---
  if (state.contextPlan) {
    const plan = el('div', 'sp-attachments');
    plan.setAttribute('aria-label', 'Context attachments included in the next message');
    for (const attachment of state.contextPlan.attachments) {
      plan.appendChild(
        el('span', 'sp-chip', `${attachment.kind}: ${attachment.label}${attachment.truncated ? ' (preview clipped)' : ''}`),
      );
    }
    for (const excluded of state.contextPlan.excluded) {
      plan.appendChild(el('span', 'sp-chip', `excluded — ${excluded.label}: ${excluded.reason}`));
    }
    root.appendChild(plan);
    root.appendChild(el('div', 'sp-status', state.contextPlan.summary));
  }

  // --- composer ---
  const composer = el('div', 'sp-picker');
  const input = el('textarea', 'sp-input') as HTMLTextAreaElement;
  input.id = 'sp-input';
  input.setAttribute('aria-label', 'Ask the agent');
  input.placeholder = 'Ask the agent…';
  input.rows = 2;
  composer.appendChild(input);
  root.appendChild(composer);

  const actions = el('div', 'sp-picker');
  const preview = el('button', 'secondary', 'Show attachments');
  preview.addEventListener('click', () => api.postMessage({ type: 'previewContext' }));
  const writable = el('input') as HTMLInputElement;
  writable.type = 'checkbox';
  writable.id = 'sp-writable';
  writable.checked = state.contextPlan?.mode === 'writable';
  const writableLabel = el('label', undefined, 'writable task');
  writableLabel.setAttribute('for', writable.id);
  const send = el('button', undefined, 'Send');
  send.addEventListener('click', () => {
    const text = input.value;
    if (text.trim().length === 0) return;
    api.postMessage({
      type: 'send',
      text,
      writable: writable.checked,
      // Without an authorized attachment list the extension refuses to send.
      authorizedContext: writable.checked ? true : state.contextPlan !== null,
    });
  });
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      send.click();
    }
  });
  actions.appendChild(preview);
  actions.appendChild(writable);
  actions.appendChild(writableLabel);
  actions.appendChild(send);
  root.appendChild(actions);

  // --- status line ---
  const status = el('div', 'sp-status');
  status.setAttribute('data-tone', state.status ? state.status.tone : 'info');
  status.textContent = state.status ? state.status.text : '';
  root.appendChild(status);

  if (previousFocus) {
    const refocus = document.getElementById(previousFocus);
    if (refocus instanceof HTMLElement) refocus.focus();
  }
}

function bootSandpaneSidebar(): void {
  const api = acquireVsCodeApi();
  (window as unknown as { __sandpaneApi?: VsCodeApi }).__sandpaneApi = api;
  const root = document.getElementById('sandpane-root');
  const announcer = document.getElementById('sp-announcer');
  if (!(root instanceof HTMLElement)) return;

  let lastLineCount = 0;
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; state?: SidebarState } | undefined;
    if (!data || data.type !== 'state' || !data.state) return;
    const state = data.state;
    mount(root, state);
    if (announcer && state.lines.length > lastLineCount) {
      const latest = state.lines[state.lines.length - 1];
      // Screen-reader announcement for new messages (specs/03 §3).
      announcer.textContent = latest ? `${latest.role}: ${latest.text.slice(0, 160)}` : '';
    }
    lastLineCount = state.lines.length;
  });

  api.postMessage({ type: 'ready' });
}

bootSandpaneSidebar();
