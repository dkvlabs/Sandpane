import { describe, expect, it } from 'vitest';
import {
  CoreCommands,
  CoreValidationError,
  validateGitRef,
  validateSandboxName,
} from '../src/core-client/commands';
import { CORE_METHODS, PROTOCOL_VERSION } from '../src/core-client/protocol';
import { makeHarness } from './helpers/fakeCore';

async function sentFor(call: (commands: CoreCommands) => Promise<unknown>) {
  const h = makeHarness();
  await h.conn.connect();
  const commands = new CoreCommands(h.conn);
  const promise = call(commands).catch(() => undefined);
  const frame = h.transport.lastRequest();
  // Answer generically so the promise settles; the assertion is on the frame.
  h.transport.respond({ v: PROTOCOL_VERSION, id: frame.id, ok: {} });
  await promise;
  return frame;
}

describe('the typed wrapper emits exactly the documented wire shape', () => {
  it('system.probe', async () => {
    expect(await sentFor((c) => c.systemProbe())).toEqual({
      v: PROTOCOL_VERSION,
      id: 'test-1',
      method: 'system.probe',
      params: {},
    });
  });

  it('project.list / project.create', async () => {
    expect(await sentFor((c) => c.projectList())).toMatchObject({ method: 'project.list', params: {} });
    expect(
      await sentFor((c) =>
        c.projectCreate({ name: 'Atlas Demo', repositories: ['/repo/atlas', '/repo/nova'] }),
      ),
    ).toMatchObject({
      method: 'project.create',
      params: { name: 'Atlas Demo', repositories: ['/repo/atlas', '/repo/nova'] },
    });
  });

  it('sandbox.list / sandbox.create (workspaceMode is snake_case)', async () => {
    expect(await sentFor((c) => c.sandboxList())).toMatchObject({ method: 'sandbox.list', params: {} });
    const frame = await sentFor((c) =>
      c.sandboxCreate({
        name: 'auth-codex',
        projectId: 'p1',
        workspaceMode: 'direct_mount',
        repoPath: '/repo/atlas',
      }),
    );
    expect(frame.params).toEqual({
      name: 'auth-codex',
      projectId: 'p1',
      workspaceMode: 'direct_mount',
      repoPath: '/repo/atlas',
    });
  });

  it('sandbox.create omits repoPath instead of sending null', async () => {
    const frame = await sentFor((c) =>
      c.sandboxCreate({ name: 'scratch', projectId: 'p1', workspaceMode: 'mountless' }),
    );
    expect(frame.params).toEqual({ name: 'scratch', projectId: 'p1', workspaceMode: 'mountless' });
  });

  it('conversation.create / conversation.send (camelCase payloads)', async () => {
    expect(
      await sentFor((c) =>
        c.conversationCreate({ projectId: 'p1', agentId: 'codex', sandboxId: 'auth-codex', title: '  ' }),
      ),
    ).toMatchObject({
      method: 'conversation.create',
      params: { projectId: 'p1', agentId: 'codex', sandboxId: 'auth-codex', title: '' },
    });

    const frame = await sentFor((c) =>
      c.conversationSend({
        conversationId: 'c1',
        content: 'implement refresh tokens; rm -rf /',
        attachments: [{ kind: 'selection', target: 'file:///repo/a.ts#L2-L4' }],
      }),
    );
    expect(frame).toMatchObject({
      method: 'conversation.send',
      params: {
        conversationId: 'c1',
        content: 'implement refresh tokens; rm -rf /',
        attachments: [{ kind: 'selection', target: 'file:///repo/a.ts#L2-L4' }],
      },
    });
  });

  it('task.cancel / task.subscribe use the documented param spellings', async () => {
    expect(await sentFor((c) => c.taskCancel('t1'))).toMatchObject({
      method: 'task.cancel',
      params: { taskId: 't1' },
    });
    expect(
      await sentFor((c) => c.taskSubscribe({ projectId: 'p1', afterSequence: 12 })),
    ).toMatchObject({
      method: 'task.subscribe',
      params: { projectId: 'p1', afterSequence: 12 },
    });
    expect(await sentFor((c) => c.taskSubscribe({ afterSequence: -5 }))).toMatchObject({
      params: { afterSequence: 0 },
    });
  });

  it('git.review / git.apply', async () => {
    expect(await sentFor((c) => c.gitReview('t1'))).toMatchObject({
      method: 'git.review',
      params: { taskId: 't1' },
    });
    expect(
      await sentFor((c) =>
        c.gitApply({ taskId: 't1', expectedBase: 'b71995fc', selectedFiles: ['src/A.ts'] }),
      ),
    ).toMatchObject({
      method: 'git.apply',
      params: { taskId: 't1', expectedBase: 'b71995fc', selectedFiles: ['src/A.ts'] },
    });
    // An empty selection is "all files", so it is omitted rather than sent as [].
    expect(
      await sentFor((c) => c.gitApply({ taskId: 't1', expectedBase: 'refs/heads/main' })),
    ).toMatchObject({ params: { taskId: 't1', expectedBase: 'refs/heads/main' } });
  });

  it('exposes exactly the 11 allowlisted methods and nothing else', () => {
    expect(CORE_METHODS).toHaveLength(11);
    expect(new Set(CORE_METHODS).size).toBe(11);
    expect(CORE_METHODS).not.toContain('shell.exec');
    expect(CORE_METHODS).not.toContain('sbx.raw');
    const names = Object.getOwnPropertyNames(CoreCommands.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(names.sort()).toEqual(
      [
        'conversationCreate',
        'conversationSend',
        'gitApply',
        'gitReview',
        'projectCreate',
        'projectList',
        'sandboxCreate',
        'sandboxList',
        'systemProbe',
        'taskCancel',
        'taskSubscribe',
      ].sort(),
    );
  });
});

describe('client-side guards mirror sandpane_core::validation', () => {
  /**
   * Runs a wrapper on a live connection. Any frame that was written gets an
   * `ok` answer, so a valid call settles instead of waiting for the timeout.
   */
  async function attempt(call: (commands: CoreCommands) => Promise<unknown>) {
    const h = makeHarness();
    await h.conn.connect();
    let error: unknown = null;
    const running = call(new CoreCommands(h.conn)).catch((e: unknown) => {
      error = e;
    });
    for (const frame of h.transport.sentFrames()) {
      const f = frame as { id?: string };
      h.transport.respond({ v: PROTOCOL_VERSION, id: f.id ?? '', ok: {} });
    }
    await running;
    return { error, writes: h.transport.writes.length, frames: h.transport.sentFrames() };
  }

  it('rejects shell-shaped sandbox names before sending', async () => {
    for (const bad of ['', 'A', 'a--b', 'a;', 'a b', '$(id)', '../x', 'a-', '-a', 'x'.repeat(64)]) {
      const { error, writes } = await attempt((c) =>
        c.sandboxCreate({ name: bad, projectId: 'p', workspaceMode: 'mountless' }),
      );
      expect(error, `name ${JSON.stringify(bad)}`).toBeInstanceOf(CoreValidationError);
      expect(writes).toBe(0);
    }
    expect(validateSandboxName('auth-codex')).toBe('auth-codex');
    expect(validateSandboxName('a')).toBe('a');
    expect(validateSandboxName('x'.repeat(63))).toBe('x'.repeat(63));
  });

  it('accepts a hex object id or a conservative ref, rejects the rest', () => {
    expect(validateGitRef('b71995fc')).toBe('b71995fc');
    expect(validateGitRef('refs/heads/main')).toBe('refs/heads/main');
    expect(validateGitRef('sandpane/task-1')).toBe('sandpane/task-1');
    for (const bad of ['', 'a..b', 'a//b', 'a.lock', '-x', 'br/', 'br.', 'a; rm -rf /', '$(id)']) {
      expect(() => validateGitRef(bad)).toThrowError(CoreValidationError);
    }
  });

  it('refuses non-absolute repository paths and blank ids', async () => {
    const repo = await attempt((c) => c.projectCreate({ name: 'Atlas', repositories: ['relative/path'] }));
    expect(repo.error).toBeInstanceOf(CoreValidationError);
    expect(repo.writes).toBe(0);
    const blank = await attempt((c) => c.taskCancel('   '));
    expect(blank.error).toBeInstanceOf(CoreValidationError);
    expect(blank.writes).toBe(0);
  });

  it('refuses an oversized prompt locally instead of letting Core drop the frame', async () => {
    const { error, writes } = await attempt((c) =>
      c.conversationSend({ conversationId: 'c', content: 'x'.repeat(64 * 1024 + 1), attachments: [] }),
    );
    expect(error).toBeInstanceOf(CoreValidationError);
    expect(writes).toBe(0);
  });

  it('rejects a control character in a title, allowing newlines in content', async () => {
    const title = await attempt((c) =>
      c.conversationCreate({ projectId: 'p', agentId: 'codex', title: 'a\u0000b' }),
    );
    expect(title.error).toBeInstanceOf(CoreValidationError);
    const ok = await attempt((c) => c.conversationSend({ conversationId: 'c', content: 'two\nlines', attachments: [] }));
    expect(ok.error).toBe(null);
    expect(ok.writes).toBe(1);
  });
});
