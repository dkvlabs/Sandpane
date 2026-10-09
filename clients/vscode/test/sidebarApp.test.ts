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
