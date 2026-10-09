/**
 * The decisions `session.ts` makes, extracted so they are testable without an
 * extension host (session.ts itself is vscode glue).
 */

import { describe, expect, it } from 'vitest';
import {
  authorizeSend,
  conversationInScope,
  selectedWorkspaceMode,
  sendGate,
  shouldPollEvents,
  transcriptView,
} from '../src/state/sessionPolicy';
import type { AgentCapability, SandboxSummary } from '../src/core-client/protocol';

const verified: AgentCapability = {
  id: 'codex',
  verified: true,
  supportsStreaming: true,
  supportsCancel: true,
  supportsResume: false,
} as AgentCapability;
const unverified: AgentCapability = { ...verified, verified: false } as AgentCapability;

const box = (name: string, workspaceMode?: string | null): SandboxSummary =>
  ({ name, ...(workspaceMode === undefined ? {} : { workspaceMode }) }) as SandboxSummary;

describe('selectedWorkspaceMode (bug 4)', () => {
  it("reads the mode from the SELECTED sandbox's Core record", () => {
    const sandboxes = [box('safe', 'sbx_clone'), box('live', 'direct_mount')];
    expect(selectedWorkspaceMode(sandboxes, 'live')).toMatchObject({ raw: 'direct_mount', hostWritable: true });
    expect(selectedWorkspaceMode(sandboxes, 'safe')).toMatchObject({ raw: 'sbx_clone', hostWritable: false });
  });

  it('treats a sandbox with no recorded mode as UNVERIFIED (host-writable), never safe', () => {
    const view = selectedWorkspaceMode([box('restored')], 'restored');
    expect(view.hostWritable).toBe(true);
    expect(view.badge).toMatch(/UNVERIFIED/);
    expect(view.raw).toBeNull();
  });

  it('treats an unknown mode name as host-writable', () => {
    expect(selectedWorkspaceMode([box('x', 'future_mode')], 'x').hostWritable).toBe(true);
  });

  it('no selected sandbox (or one Core no longer lists) is unknown, not safe', () => {
    expect(selectedWorkspaceMode([box('a', 'sbx_clone')], null)).toMatchObject({
      raw: null,
      hostWritable: true,
    });
    expect(selectedWorkspaceMode([], 'gone').hostWritable).toBe(true);
  });
});

describe('sendGate (bug 4)', () => {
  const isolated = selectedWorkspaceMode([box('s', 'sbx_clone')], 's');
  const unverifiedMode = selectedWorkspaceMode([box('s')], 's');
  const live = selectedWorkspaceMode([box('s', 'direct_mount')], 's');

  it('requires confirmation when no agent adapter is verified', () => {
    expect(sendGate([unverified], false, isolated).allowed).toBe(false);
    expect(sendGate([], false, isolated).allowed).toBe(false);
  });

  it('requires confirmation for a writable task in direct_mount AND in an unverified mode', () => {
    expect(sendGate([verified], true, live)).toMatchObject({ allowed: false });
    const gate = sendGate([verified], true, unverifiedMode);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/UNVERIFIED/);
  });

  it('lets a writable task through only for a recorded isolated mode', () => {
    expect(sendGate([verified], true, isolated).allowed).toBe(true);
    expect(sendGate([verified], false, unverifiedMode).allowed).toBe(true); // discussion intent
  });
});

describe('conversationInScope (bug 8)', () => {
  const conv = { projectId: 'p1', sandboxName: 'box-a' };
  it('keeps the conversation only for the same project and sandbox', () => {
    expect(conversationInScope(conv, { projectId: 'p1', sandbox: 'box-a' })).toBe(true);
    expect(conversationInScope(conv, { projectId: 'p2', sandbox: 'box-a' })).toBe(false);
    expect(conversationInScope(conv, { projectId: 'p1', sandbox: 'box-b' })).toBe(false);
    expect(conversationInScope(conv, { projectId: 'p1', sandbox: null })).toBe(false);
    expect(conversationInScope(conv, { projectId: null, sandbox: 'box-a' })).toBe(false);
  });

  it('a restored preference with no recorded sandbox is out of scope once a sandbox is chosen', () => {
    expect(conversationInScope({ projectId: 'p1', sandboxName: null }, { projectId: 'p1', sandbox: null })).toBe(true);
    expect(conversationInScope({ projectId: 'p1', sandboxName: null }, { projectId: 'p1', sandbox: 'b' })).toBe(false);
  });
});

describe('shouldPollEvents (bug 10 / backlog 6)', () => {
  it('polls only while online and some task is not terminal', () => {
    expect(shouldPollEvents('online', ['queued'])).toBe(true);
    expect(shouldPollEvents('online', [null])).toBe(true); // no status from Core yet
    expect(shouldPollEvents('online', ['awaiting_review', 'completed'])).toBe(true);
    expect(shouldPollEvents('online', ['completed', 'failed', 'cancelled', 'interrupted', 'rejected'])).toBe(false);
    expect(shouldPollEvents('online', [])).toBe(false);
    expect(shouldPollEvents('reconnecting', ['running'])).toBe(false);
    expect(shouldPollEvents('offline', ['running'])).toBe(false);
  });
});

describe('authorizeSend (bug 6)', () => {
  const plan = (id: number, mode: 'read_only' | 'writable') => ({ id, mode });

  it('refuses a send when the user has not been shown an attachment list', () => {
    expect(authorizeSend(null, { writable: false, planId: null }).ok).toBe(false);
    expect(authorizeSend(null, { writable: false, planId: 1 }).ok).toBe(false);
  });

  it('refuses a stale or foreign plan id', () => {
    expect(authorizeSend(plan(3, 'read_only'), { writable: false, planId: 2 }).ok).toBe(false);
    expect(authorizeSend(plan(3, 'read_only'), { writable: false, planId: null }).ok).toBe(false);
  });

  it('refuses when the shown plan was for the other intent (read-only plan sent as writable)', () => {
    const verdict = authorizeSend(plan(3, 'read_only'), { writable: true, planId: 3 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/writable/);
    expect(authorizeSend(plan(4, 'writable'), { writable: false, planId: 4 }).ok).toBe(false);
  });

  it('accepts exactly the plan the user saw, for the same intent', () => {
    expect(authorizeSend(plan(3, 'read_only'), { writable: false, planId: 3 }).ok).toBe(true);
    expect(authorizeSend(plan(5, 'writable'), { writable: true, planId: 5 }).ok).toBe(true);
  });
});

describe('transcriptView (review 12b)', () => {
  const tasks = [
    { conversationId: 'c1', lines: [{ role: 'user' as const, text: 'one', sequence: 1 }] },
    { conversationId: 'c2', lines: [{ role: 'user' as const, text: 'two', sequence: 1 }] },
  ];
  it('shows only the selected conversation, labelled as such', () => {
    const view = transcriptView(tasks, { id: 'c1', title: 'Auth' });
    expect(view.lines.map((l) => l.text)).toEqual(['one']);
    expect(view.scope).toBe('conversation');
    expect(view.label).toContain('Auth');
  });

  it('without a conversation, labels the merged lines as the whole project', () => {
    const view = transcriptView(tasks, null);
    expect(view.lines.map((l) => l.text)).toEqual(['one', 'two']);
    expect(view.scope).toBe('project');
    expect(view.label).toMatch(/all tasks in this project/i);
  });
});
