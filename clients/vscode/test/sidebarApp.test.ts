/**
 * The real sidebar script (`src/webview/app.ts`) executed against a minimal
 * fake DOM (test/helpers/fakeDom.ts):
 *  - review bug 5: the composer is never rebuilt — a draft, the writable
 *    checkbox and focus survive every state push; pushes are rAF-batched;
 *  - review bug 6: Send never sends an attachment list the user has not seen
 *    for the chosen intent; it asks the extension for the list instead;
 *  - review 12b: the stream is labelled with what it really contains.
 */

import { describe, expect, it } from 'vitest';
import { loadSidebar } from './helpers/fakeDom';

interface PlanInput {
  planId: number;
  mode: 'read_only' | 'writable';
}

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connection: 'online',
    header: {
      project: 'Atlas Demo',
      agent: 'codex',
      sandbox: 'atlas-box',
      workspaceMode: null,
      workspaceModeBadge: 'UNVERIFIED — TREAT AS LIVE-WRITABLE',
      workspaceHostWritable: true,
      branch: null,
    },
    sandboxes: [
      { name: 'atlas-box', probedState: 'running', workspaceMode: null, modeBadge: 'UNVERIFIED', modeHostWritable: true },
    ],
    selectedSandbox: 'atlas-box',
    conversation: null,
    lines: [],
    transcript: { scope: 'project', label: 'Transcript of all tasks in this project (no conversation selected)' },
    tasks: [],
    acceptedSends: 0,
    sending: false,
    status: null,
    capabilities: null,
    contextPlan: null,
    notices: [],
    conversations: { supported: true, note: null, showArchived: false, showArchivedSupported: true, rows: [] },
    composerBlocked: null,
    ...overrides,
  };
}

const ENABLED = { enabled: true, reason: null };
const ARCHIVED_REASON = 'Core refuses it for an archived conversation ("conversation is archived; unarchive it first; nothing was changed"); unarchive it first';

function convRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    title: 'Auth',
    archived: false,
    selected: false,
    sandboxLabel: null,
    statusNote: null,
    actions: {
      rename: ENABLED,
      archive: ENABLED,
      unarchive: { enabled: false, reason: 'not archived' },
      export: ENABLED,
      delete: ENABLED,
    },
    ...overrides,
  };
}

function plan({ planId, mode }: PlanInput): Record<string, unknown> {
  return {
    planId,
    mode,
    summary: 'Attaching file×1',
    disclosure: 'Core v1 accepts the references but does not yet store or forward them to the agent.',
    attachments: [{ kind: 'file', label: 'AuthService.ts', target: 'file:///x', excerpt: '', truncated: false }],
    excluded: [],
  };
}

function boot() {
  const h = loadSidebar();
  h.push(state());
  h.flushFrame();
  return h;
}

describe('sidebar boot', () => {
  it('announces readiness and paints the first state', () => {
    const h = boot();
    expect(h.posted[0]).toEqual({ type: 'ready' });
    expect(h.byId('sp-input').tagName).toBe('TEXTAREA');
    expect(h.root.textContent).toContain('Atlas Demo');
  });
});

describe('stable composer (review bug 5)', () => {
  it('keeps the same textarea node, the draft and the checkbox across state pushes', () => {
    const h = boot();
    const input = h.byId('sp-input');
    const writable = h.byId('sp-writable');
    input.value = 'half-typed prompt';
    writable.checked = true;
    input.focus();

    // The pushes that used to wipe the draft: status, refresh, preview, reconnect.
    h.push(state({ status: { tone: 'ok', text: '2 sandbox(es) from Core' } }));
    h.flushFrame();
    h.push(state({ connection: 'reconnecting' }));
    h.flushFrame();
    h.push(state({ contextPlan: plan({ planId: 1, mode: 'read_only' }) }));
    h.flushFrame();
    h.push(state({ tasks: [{ taskId: 't-1', status: 'queued', branch: null, baseCommit: null, unknownKinds: [] }] }));
    h.flushFrame();

    expect(h.byId('sp-input')).toBe(input);
    expect(input.value).toBe('half-typed prompt');
    expect(h.byId('sp-writable')).toBe(writable);
    expect(writable.checked).toBe(true);
    expect(h.document.activeElement).toBe(input);
  });

  it('coalesces many pushes in one frame into one paint of the newest state', () => {
    const h = boot();
    const before = h.rafRequests();
    h.push(state({ status: { tone: 'info', text: 'first' } }));
    h.push(state({ status: { tone: 'info', text: 'second' } }));
    h.push(state({ status: { tone: 'error', text: 'third' } }));
    expect(h.rafRequests() - before).toBe(1);
    expect(h.byId('sp-status').textContent).toBe(''); // nothing painted before the frame
    expect(h.flushFrame()).toBe(1);
    expect(h.byId('sp-status').textContent).toBe('third');
    expect(h.byId('sp-status').getAttribute('data-tone')).toBe('error');
  });

  it('clears the draft only after Core accepted a send from the composer', () => {
    const h = boot();
    h.push(state({ contextPlan: plan({ planId: 1, mode: 'read_only' }) }));
    h.flushFrame();
    const input = h.byId('sp-input');
    input.value = 'draft';
    h.byId('sp-send').click();
    h.push(state({ acceptedSends: 0, status: { tone: 'error', text: 'Not sent: …' } }));
    h.flushFrame();
    expect(input.value).toBe('draft'); // a refusal keeps the text
    h.push(state({ acceptedSends: 1 }));
    h.flushFrame();
    expect(input.value).toBe('');
  });

  it('a late-booting view takes the current counter as baseline instead of clearing', () => {
    const h = loadSidebar();
    h.push(state({ acceptedSends: 5 }));
    h.flushFrame();
    const input = h.byId('sp-input');
    input.value = 'new draft';
    h.push(state({ acceptedSends: 5, status: { tone: 'ok', text: 'x' } }));
    h.flushFrame();
    expect(input.value).toBe('new draft');
  });

  it('keeps focus on a task button whose region was rebuilt (stable ids)', () => {
    const h = boot();
    const row = (status: string) => ({ taskId: 'task-1', status, branch: null, baseCommit: null, unknownKinds: [] });
    h.push(state({ tasks: [row('queued')] }));
    h.flushFrame();
    h.byId('sp-review-task-1').focus();
    h.push(state({ tasks: [row('running')] }));
    h.flushFrame();
    expect(h.document.activeElement?.id).toBe('sp-review-task-1');
    expect(h.byId('sp-tasks').textContent).toContain('running');
  });

  it('appends new transcript lines without rebuilding the existing ones', () => {
    const h = boot();
    const line = (text: string) => ({ role: 'user', text });
    h.push(state({ lines: [line('one')] }));
    h.flushFrame();
    const stream = h.byId('sp-stream');
    const first = stream.children[0];
    h.push(state({ lines: [line('one'), line('two')] }));
    h.flushFrame();
    expect(stream.children[0]).toBe(first);
    expect(stream.children).toHaveLength(2);
  });

  it('renders hostile text verbatim as text, never as markup', () => {
    const h = boot();
    const hostile = '<img src=x onerror=alert(1)>\n$(rm -rf /)';
    h.push(state({ lines: [{ role: 'agent', text: hostile }] }));
    h.flushFrame();
    const body = h.byId('sp-stream').find((el) => el.tagName === 'PRE');
    expect(body?.textContent).toBe(hostile);
    expect(body?.children).toHaveLength(0);
  });
});

describe('preview before send (review bug 6)', () => {
  it('Send without a reviewed list asks for the list for the chosen intent — it does not send', () => {
    const h = boot();
    h.byId('sp-input').value = 'refactor this';
    h.posted.length = 0;
    h.byId('sp-send').click();
    expect(h.posted).toEqual([{ type: 'previewContext', writable: false }]);

    h.byId('sp-writable').checked = true;
    h.posted.length = 0;
    h.byId('sp-send').click();
    expect(h.posted).toEqual([{ type: 'previewContext', writable: true }]);
  });

  it('sends with the id of the list the user saw, for the same intent', () => {
    const h = boot();
    h.push(state({ contextPlan: plan({ planId: 7, mode: 'read_only' }) }));
    h.flushFrame();
    expect(h.byId('sp-send').textContent).toBe('Send');
    h.byId('sp-input').value = 'explain';
    h.posted.length = 0;
    h.byId('sp-send').click();
    expect(h.posted).toEqual([{ type: 'send', text: 'explain', writable: false, planId: 7 }]);
  });

  it('a read-only list is never sent as a writable task', () => {
    const h = boot();
    h.push(state({ contextPlan: plan({ planId: 7, mode: 'read_only' }) }));
    h.flushFrame();
    const writable = h.byId('sp-writable');
    writable.checked = true;
    h.posted.length = 0;
    writable.dispatch('change');
    // Switching intent requests the list for the new intent...
    expect(h.posted).toEqual([{ type: 'previewContext', writable: true }]);
    expect(h.byId('sp-send').textContent).toBe('Review attachments to send');
    // ...and Send, until that list arrives, only asks for it again.
    h.byId('sp-input').value = 'do it';
    h.posted.length = 0;
    h.byId('sp-send').click();
    expect(h.posted).toEqual([{ type: 'previewContext', writable: true }]);
  });

  it('shows the Core v1 attachment disclosure with the list', () => {
    const h = boot();
    h.push(state({ contextPlan: plan({ planId: 2, mode: 'writable' }) }));
    h.flushFrame();
    expect(h.byId('sp-plan').textContent).toContain('does not yet store or forward');
  });
});

describe('honest labels', () => {
  it('labels the stream with what it contains (review 12b)', () => {
    const h = boot();
    expect(h.byId('sp-stream').getAttribute('aria-label')).toMatch(/all tasks in this project/);
    h.push(state({ transcript: { scope: 'conversation', label: 'Conversation "Auth"' } }));
    h.flushFrame();
    expect(h.byId('sp-stream').getAttribute('aria-label')).toBe('Conversation "Auth"');
  });

  it('an unverified workspace mode is rendered loud, never blank or safe (bug 4)', () => {
    const h = boot();
    expect(h.root.textContent).toContain('UNVERIFIED');
    expect(h.root.textContent).toContain('TREAT AS LIVE-WRITABLE');
  });
});

describe('in-flight send (review W3) and draft clearing (S2)', () => {
  it('Send is disabled while the extension reports a send in flight, and posts nothing', () => {
    const h = boot();
    h.push(state({ contextPlan: plan({ planId: 3, mode: 'read_only' }), sending: true }));
    h.flushFrame();
    const send = h.byId('sp-send');
    expect(send.disabled).toBe(true);
    h.byId('sp-input').value = 'again';
    h.posted.length = 0;
    send.click();
    h.byId('sp-input').dispatch('keydown', { key: 'Enter', metaKey: true });
    expect(h.posted).toEqual([]);
    h.push(state({ contextPlan: plan({ planId: 3, mode: 'read_only' }), sending: false }));
    h.flushFrame();
    expect(send.disabled).toBe(false);
  });

  it('after acceptance, clears the draft only if it is still the text that was sent', () => {
    const h = boot();
    h.push(state({ contextPlan: plan({ planId: 3, mode: 'read_only' }) }));
    h.flushFrame();
    const input = h.byId('sp-input');
    input.value = 'first message';
    h.byId('sp-send').click();
    input.value = 'next message being typed'; // the user kept typing
    h.push(state({ acceptedSends: 1 }));
    h.flushFrame();
    expect(input.value).toBe('next message being typed');
  });
});

describe('A3b conversation list and archived state', () => {
  function withRows(rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
    const h = loadSidebar();
    h.push(state({ conversations: { supported: true, note: null, showArchived: true, showArchivedSupported: true, rows }, ...extra }));
    h.flushFrame();
    return h;
  }

  it('lists Core\'s conversations with ARCHIVED labels, the sandbox label and the archived note', () => {
    const archived = convRow({
      id: 'c2',
      title: 'Old',
      archived: true,
      statusNote: 'ARCHIVED — send and rename are disabled: Core says "conversation is archived; unarchive it first; nothing was changed". Its history stays readable.',
      sandboxLabel: 'sandbox chosen at creation: gone-box (not in the current sandbox list)',
      actions: {
        rename: { enabled: false, reason: ARCHIVED_REASON },
        archive: { enabled: false, reason: 'already archived' },
        unarchive: ENABLED,
        export: ENABLED,
        delete: ENABLED,
      },
    });
    const h = withRows([convRow({ selected: true }), archived]);
    const region = h.byId('sp-conversations');
    expect(region.textContent).toContain('Auth');
    expect(region.textContent).toContain('ARCHIVED');
    expect(region.textContent).toContain('sandbox chosen at creation: gone-box (not in the current sandbox list)');
    expect(region.textContent).toContain('conversation is archived; unarchive it first; nothing was changed');
    expect(h.byId('sp-conv-open-c1').getAttribute('aria-pressed')).toBe('true');
    expect(h.byId('sp-conv-open-c2').getAttribute('aria-pressed')).toBe('false');
    // Rename of the archived row is disabled with Core's reason; Unarchive replaces Archive.
    const rename = h.byId('sp-conv-rename-c2');
    expect(rename.disabled).toBe(true);
    expect(rename.getAttribute('title')).toBe(ARCHIVED_REASON);
    expect(() => h.byId('sp-conv-archive-c2')).toThrow();
    expect(h.byId('sp-conv-unarchive-c2').disabled).toBe(false);
    expect(() => h.byId('sp-conv-unarchive-c1')).toThrow();
  });

  it('row buttons post whitelisted messages; disabled ones post nothing', () => {
    const h = withRows([
      convRow(),
      convRow({ id: 'c2', title: 'Old', archived: true, actions: { ...convRow()['actions'] as object, rename: { enabled: false, reason: ARCHIVED_REASON }, unarchive: ENABLED } }),
    ]);
    const before = h.posted.length;
    h.byId('sp-conv-open-c1').click();
    h.byId('sp-conv-rename-c1').click();
    h.byId('sp-conv-archive-c1').click();
    h.byId('sp-conv-export-c1').click();
    h.byId('sp-conv-delete-c1').click();
    h.byId('sp-conv-rename-c2').click(); // disabled: nothing
    h.byId('sp-conv-unarchive-c2').click();
    h.byId('sp-conv-new').click();
    h.byId('sp-conv-archived').click();
    expect(h.posted.slice(before)).toEqual([
      { type: 'selectConversation', conversationId: 'c1' },
      { type: 'conversationAction', action: 'rename', conversationId: 'c1' },
      { type: 'conversationAction', action: 'archive', conversationId: 'c1' },
      { type: 'conversationAction', action: 'export', conversationId: 'c1' },
      { type: 'conversationAction', action: 'delete', conversationId: 'c1' },
      { type: 'conversationAction', action: 'unarchive', conversationId: 'c2' },
      { type: 'selectConversation', conversationId: '' },
      { type: 'toggleArchivedConversations' },
    ]);
  });

  it('unsupported actions and toggle are visibly unsupported (disabled with the reason, never hidden)', () => {
    const unsupported = { enabled: false, reason: 'not supported by the attached Sandpane Core (it does not advertise "conversation.rename")' };
    const h = loadSidebar();
    h.push(state({
      conversations: {
        supported: true,
        note: null,
        showArchived: false,
        showArchivedSupported: false,
        rows: [convRow({ actions: { rename: unsupported, archive: unsupported, unarchive: unsupported, export: unsupported, delete: unsupported } })],
      },
    }));
    h.flushFrame();
    const toggle = h.byId('sp-conv-archived');
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('title')).toMatch(/not supported/);
    expect(h.byId('sp-conv-rename-c1').disabled).toBe(true);
    expect(h.byId('sp-conversations').textContent).toMatch(/not supported by the attached Sandpane Core/);
  });

  it('an archived conversation (or project) disables Send and shows Core\'s reason; history stays painted', () => {
    const reason = 'Sending is disabled: Core refuses sends to an archived conversation ("conversation is archived; unarchive it first; nothing was changed").';
    const h = loadSidebar();
    h.push(state({
      composerBlocked: reason,
      contextPlan: plan({ planId: 1, mode: 'read_only' }),
      lines: [{ role: 'user', text: 'earlier message' }],
      transcript: { scope: 'conversation', label: 'Conversation "Old"' },
    }));
    h.flushFrame();
    const send = h.byId('sp-send');
    expect(send.disabled).toBe(true);
    expect(h.byId('sp-composer-note').textContent).toBe(reason);
    expect(h.byId('sp-stream').textContent).toContain('earlier message');
    h.byId('sp-input').value = 'try anyway';
    const before = h.posted.length;
    send.click();
    expect(h.posted.slice(before)).toEqual([]);
    // A later push that clears the block re-enables Send (and a busy send still disables it).
    h.push(state({ composerBlocked: null, contextPlan: plan({ planId: 1, mode: 'read_only' }) }));
    h.flushFrame();
    expect(send.disabled).toBe(false);
    expect(h.byId('sp-composer-note').textContent).toBe('');
    h.push(state({ composerBlocked: null, sending: true }));
    h.flushFrame();
    expect(send.disabled).toBe(true);
  });

  it('shows Core\'s note when the list is unavailable', () => {
    const h = loadSidebar();
    h.push(state({ conversations: { supported: false, note: 'This Core does not advertise conversation.list — conversations cannot be listed (no fake list).', showArchived: false, showArchivedSupported: false, rows: [] } }));
    h.flushFrame();
    expect(h.byId('sp-conversations').textContent).toContain('does not advertise conversation.list');
  });
});

describe('A4 composer: Task / Discuss send mode', () => {
  const supported = { sendModeSupported: true };

  it('is built once with Task as the default; the node survives state pushes', () => {
    const h = boot();
    h.push(state(supported));
    h.flushFrame();
    const mode = h.byId('sp-send-mode');
    expect(mode.tagName).toBe('SELECT');
    expect(mode.value).toBe('task');
    expect(mode.children.map((o) => o.value)).toEqual(['task', 'discuss']);
    mode.value = 'discuss';
    h.push(state({ ...supported, status: { tone: 'info', text: 'x' } }));
    h.flushFrame();
    expect(h.byId('sp-send-mode')).toBe(mode);
    expect(mode.value).toBe('discuss');
  });

  it('advertised: the note says neither mode runs an agent and Discuss is not safe execution', () => {
    const h = boot();
    h.push(state(supported));
    h.flushFrame();
    expect(h.byId('sp-send-mode').disabled).toBe(false);
    const note = h.byId('sp-send-mode-note').textContent;
    expect(note).toMatch(/Neither .*runs an agent/);
    expect(note).toMatch(/not safe execution/);
  });

  it('not advertised: disabled at Task with "not supported by this Core"', () => {
    const h = boot();
    h.push(state(supported));
    h.flushFrame();
    h.byId('sp-send-mode').value = 'discuss';
    h.push(state({ sendModeSupported: false }));
    h.flushFrame();
    expect(h.byId('sp-send-mode').disabled).toBe(true);
    expect(h.byId('sp-send-mode').value).toBe('task');
    expect(h.byId('sp-send-mode-note').textContent).toContain('not supported by this Core');
    // An older extension state without the flag is treated as unsupported.
    const old = boot();
    expect(old.byId('sp-send-mode').disabled).toBe(true);
  });

  it('Task posts no mode key; Discuss posts mode "discuss"', () => {
    const h = boot();
    h.push(state({ ...supported, contextPlan: plan({ planId: 7, mode: 'read_only' }) }));
    h.flushFrame();
    h.byId('sp-input').value = 'explain';
    h.posted.length = 0;
    h.byId('sp-send').click();
    expect(h.posted).toEqual([{ type: 'send', text: 'explain', writable: false, planId: 7 }]);
    h.byId('sp-send-mode').value = 'discuss';
    h.byId('sp-send-mode').dispatch('change');
    h.posted.length = 0;
    h.byId('sp-send').click();
    expect(h.posted).toEqual([{ type: 'send', text: 'explain', writable: false, planId: 7, mode: 'discuss' }]);
  });

  it('Discuss clears and disables the writable intent; Task enables it again', () => {
    const h = boot();
    h.push(state(supported));
    h.flushFrame();
    const writable = h.byId('sp-writable');
    writable.checked = true;
    h.byId('sp-send-mode').value = 'discuss';
    h.byId('sp-send-mode').dispatch('change');
    expect(writable.checked).toBe(false);
    expect(writable.disabled).toBe(true);
    h.byId('sp-send-mode').value = 'task';
    h.byId('sp-send-mode').dispatch('change');
    expect(writable.disabled).toBe(false);
  });

  it('task chips show the send mode as-is and the chat-chosen sandbox, labelled "not where it runs"', () => {
    const h = boot();
    h.push(
      state({
        ...supported,
        tasks: [
          { taskId: 't-1', status: 'queued', branch: null, baseCommit: null, unknownKinds: [], mode: 'plan', chosenSandboxName: 'atlas-box' },
          { taskId: 't-2', status: 'queued', branch: null, baseCommit: null, unknownKinds: [] },
        ],
      }),
    );
    h.flushFrame();
    const text = h.byId('sp-tasks').textContent;
    expect(text).toContain('Send mode: plan');
    expect(text).toContain('sandbox chosen by its chat — not where it runs: atlas-box');
    // A row without the fields invents nothing.
    expect(text.match(/Send mode/g)).toHaveLength(1);
  });
});

describe('A5: per-task Diff button', () => {
  const row = { taskId: 't-1', status: 'queued', branch: null, baseCommit: null, unknownKinds: [] };

  it('posts showTaskPatch for the task when Core advertises git.diff', () => {
    const h = boot();
    h.push(state({ gitDiffSupported: true, tasks: [row] }));
    h.flushFrame();
    const button = h.byId('sp-diff-t-1');
    expect(button.textContent).toBe('Diff');
    expect(button.disabled).toBe(false);
    h.posted.length = 0;
    button.click();
    expect(h.posted).toEqual([{ type: 'showTaskPatch', taskId: 't-1' }]);
  });

  it('is disabled with "not supported by this Core" when git.diff is not advertised (or the flag is absent)', () => {
    const h = boot();
    h.push(state({ gitDiffSupported: false, tasks: [row] }));
    h.flushFrame();
    const button = h.byId('sp-diff-t-1');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toContain('not supported by this Core');
    h.posted.length = 0;
    button.click();
    expect(h.posted).toEqual([]);
    const old = boot();
    old.push(state({ tasks: [row] }));
    old.flushFrame();
    expect(old.byId('sp-diff-t-1').disabled).toBe(true);
  });
});

describe('A6: per-task Apply button', () => {
  const row = { taskId: 't-1', status: 'awaiting_review', branch: null, baseCommit: null, unknownKinds: [] };

  it('posts applyTask (only the task id) when Core advertises git.apply + git-apply', () => {
    const h = boot();
    h.push(state({ gitApplySupported: true, tasks: [row] }));
    h.flushFrame();
    const button = h.byId('sp-apply-t-1');
    expect(button.textContent).toBe('Apply…');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('title')).toContain('confirm in a dialog');
    h.posted.length = 0;
    button.click();
    expect(h.posted).toEqual([{ type: 'applyTask', taskId: 't-1' }]);
  });

  it('is disabled with "not implemented by this Core" when unsupported (or the flag is absent), and while an apply runs', () => {
    const h = boot();
    h.push(state({ gitApplySupported: false, tasks: [row] }));
    h.flushFrame();
    const button = h.byId('sp-apply-t-1');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toContain('not implemented by this Core');
    h.posted.length = 0;
    button.click();
    expect(h.posted).toEqual([]);
    const old = boot();
    old.push(state({ tasks: [row] }));
    old.flushFrame();
    expect(old.byId('sp-apply-t-1').disabled).toBe(true);
    const busy = boot();
    busy.push(state({ gitApplySupported: true, applyInFlight: true, tasks: [row] }));
    busy.flushFrame();
    expect(busy.byId('sp-apply-t-1').disabled).toBe(true);
    expect(busy.byId('sp-apply-t-1').getAttribute('title')).toContain('another apply is in progress');
  });
});

describe('A7: Verification section and per-task Verify… / Results…', () => {
  const panel = {
    supported: true,
    note: null,
    commands: [{ label: 'unit tests', argv: ['[1] "cargo"', '[2] "test"'] }],
    repositories: [
      {
        repoPath: '/repo/atlas',
        manifests: [{ manifest: 'package.json', suggestions: ['["npm", "run", "test"]'], notes: ['npm run test runs: vitest'] }],
        unreadable: ['Cargo.toml'],
      },
    ],
  };
  const row = (verification: Record<string, unknown> | undefined) => ({
    taskId: 't-1',
    status: 'awaiting_review',
    branch: null,
    baseCommit: null,
    unknownKinds: [],
    ...(verification ? { verification } : {}),
  });

  it('lists approved commands (label + every argv line) and Core suggestions with notes, as text', () => {
    const h = boot();
    h.push(state({ verification: panel }));
    h.flushFrame();
    const section = h.byId('sp-verification');
    for (const text of ['unit tests', '[1] "cargo"', '[2] "test"', '["npm", "run", "test"]', 'npm run test runs: vitest', '/repo/atlas', 'Cargo.toml']) {
      expect(section.textContent).toContain(text);
    }
    expect(section.textContent).toContain('never run here');
  });

  it('section buttons post verificationAction with NO id, label or argv (the dialog reads Core)', () => {
    const h = boot();
    h.push(state({ verification: panel }));
    h.flushFrame();
    h.posted.length = 0;
    for (const id of ['sp-verify-add', 'sp-verify-suggest', 'sp-verify-revoke', 'sp-verify-refresh']) h.byId(id).click();
    expect(h.posted).toEqual([
      { type: 'verificationAction', action: 'add' },
      { type: 'verificationAction', action: 'approveSuggestion' },
      { type: 'verificationAction', action: 'revoke' },
      { type: 'verificationAction', action: 'refresh' },
    ]);
  });

  it('unsupported (or an older host without the field): buttons disabled with the note; nothing posts', () => {
    for (const verification of [
      { supported: false, note: 'Verification is not supported by the attached Sandpane Core (it does not advertise "verification").', commands: [], repositories: [] },
      undefined,
    ]) {
      const h = boot();
      h.push(state({ ...(verification ? { verification } : {}), tasks: [row(undefined)] }));
      h.flushFrame();
      h.posted.length = 0;
      for (const id of ['sp-verify-add', 'sp-verify-suggest', 'sp-verify-revoke', 'sp-verify-refresh', 'sp-verify-run-t-1', 'sp-verify-results-t-1']) {
        expect(h.byId(id).disabled).toBe(true);
        h.byId(id).click();
      }
      expect(h.posted).toEqual([]);
      expect(h.byId('sp-verification').textContent).toContain('not supported');
    }
  });

  it('a hostile label is text, never markup', () => {
    const h = boot();
    const hostile = '<img src=x onerror=alert(1)>';
    h.push(state({ verification: { ...panel, commands: [{ label: hostile, argv: ['[1] "x"'] }] } }));
    h.flushFrame();
    const label = h.byId('sp-verification').find((el) => el.textContent === hostile);
    expect(label).toBeDefined();
    expect(label?.children).toHaveLength(0);
  });

  it('per task: Verify… posts runVerification and Results… posts showVerificationResults (task id only); runs are listed', () => {
    const h = boot();
    h.push(state({
      verification: panel,
      tasks: [row({ runEnabled: true, runReason: null, runs: ['unit tests — exit status 0 (as reported by sbx exec)'] })],
    }));
    h.flushFrame();
    expect(h.byId('sp-tasks').textContent).toContain('unit tests — exit status 0 (as reported by sbx exec)');
    h.posted.length = 0;
    h.byId('sp-verify-run-t-1').click();
    h.byId('sp-verify-results-t-1').click();
    expect(h.posted).toEqual([
      { type: 'runVerification', taskId: 't-1' },
      { type: 'showVerificationResults', taskId: 't-1' },
    ]);
  });

  it('an unbound task: Verify… is disabled and says why (title and visible text)', () => {
    const h = boot();
    h.push(state({ verification: panel, tasks: [row({ runEnabled: false, runReason: 'this task is not bound to a sandbox', runs: [] })] }));
    h.flushFrame();
    const run = h.byId('sp-verify-run-t-1');
    expect(run.disabled).toBe(true);
    expect(run.getAttribute('title')).toContain('this task is not bound to a sandbox');
    expect(h.byId('sp-tasks').textContent).toContain('Verify: this task is not bound to a sandbox');
    h.posted.length = 0;
    run.click();
    expect(h.posted).toEqual([]);
    // Results stays available: Core's events may name runs this view has not caught up on.
    expect(h.byId('sp-verify-results-t-1').disabled).toBe(false);
  });
});
