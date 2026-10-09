import { describe, expect, it } from 'vitest';
import {
  CoreCommands,
  CoreValidationError,
  clampLimit,
  validateCursorMap,
  validateGitRef,
  validateSandboxName,
  validateScopingId,
  validateStatusFilter,
} from '../src/core-client/commands';
import { CORE_METHODS, MAX_LIST_LIMIT, PROTOCOL_VERSION } from '../src/core-client/protocol';
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

  it('task.subscribe sends per-task cursors only on the project-wide path', async () => {
    // No taskId → each task replays from its own cursor (Core's rule).
    const mapFrame = await sentFor((c) =>
      c.taskSubscribe({
        projectId: 'p1',
        afterSequence: 0,
        afterSequences: { 'task-a': 5, 'task-b': 2 },
      }),
    );
    expect(mapFrame).toMatchObject({
      method: 'task.subscribe',
      params: { projectId: 'p1', afterSequence: 0, afterSequences: { 'task-a': 5, 'task-b': 2 } },
    });

    // taskId present → Core IGNORES the map, so the client must not put it on
    // the wire (a key that is silently discarded reads as a per-task cursor).
    const taskFrame = await sentFor((c) =>
      c.taskSubscribe({ taskId: 'task-a', afterSequence: 5, afterSequences: { 'task-a': 5 } }),
    );
    expect(taskFrame.params).toEqual({ afterSequence: 5, taskId: 'task-a' });

    // An empty map is the same as no map: legacy shared-scalar behavior, key omitted.
    expect(await sentFor((c) => c.taskSubscribe({ projectId: 'p1', afterSequence: 3, afterSequences: {} }))).toMatchObject({
      params: { projectId: 'p1', afterSequence: 3 },
    });
    // A negative cursor is normalised to 0 exactly as Core's `.max(0)` does.
    expect(
      await sentFor((c) =>
        c.taskSubscribe({ projectId: 'p1', afterSequence: 0, afterSequences: { 'task-a': -1 } }),
      ),
    ).toMatchObject({ params: { afterSequences: { 'task-a': 0 } } });
  });

  it('task.list / conversation.list omit an absent scope instead of sending null', async () => {
    expect(await sentFor((c) => c.taskList())).toMatchObject({ method: 'task.list', params: {} });
    expect(await sentFor((c) => c.taskList({ projectId: null }))).toMatchObject({ params: {} });
    expect(await sentFor((c) => c.conversationList())).toMatchObject({
      method: 'conversation.list',
      params: {},
    });
    expect(await sentFor((c) => c.taskList({ projectId: 'p1' }))).toMatchObject({
      params: { projectId: 'p1' },
    });
    // `statuses` are Core's own stored names in snake_case; an empty filter is
    // omitted (Rust skips an empty Vec), duplicates collapse.
    expect(
      await sentFor((c) => c.taskList({ statuses: ['queued', 'awaiting_review', 'queued'] })),
    ).toMatchObject({ params: { statuses: ['queued', 'awaiting_review'] } });
    expect(await sentFor((c) => c.taskList({ statuses: [] }))).toMatchObject({ params: {} });
  });

  it('list limits clamp to Core ceiling and 0 becomes 1', async () => {
    expect(await sentFor((c) => c.taskList({ limit: 5_000 }))).toMatchObject({
      params: { limit: MAX_LIST_LIMIT },
    });
    expect(await sentFor((c) => c.taskList({ limit: 0 }))).toMatchObject({ params: { limit: 1 } });
    expect(await sentFor((c) => c.conversationList({ limit: 50 }))).toMatchObject({
      params: { limit: 50 },
    });
    // An omitted limit stays omitted so Core's own default (200) is the answer.
    expect(await sentFor((c) => c.taskList({ limit: null }))).toMatchObject({ params: {} });
    expect(clampLimit(undefined)).toBeUndefined();
    expect(clampLimit(999_999)).toBe(MAX_LIST_LIMIT);
  });

  it('conversation.history is an object result with a required conversationId', async () => {
    const frame = await sentFor((c) =>
      c.conversationHistory({ conversationId: 'c1', afterSequence: 7, limit: 25 }),
    );
    expect(frame).toMatchObject({
      method: 'conversation.history',
      params: { conversationId: 'c1', afterSequence: 7, limit: 25 },
    });
    // Defaults: cursor 0, limit omitted (Core applies its own default).
    expect(await sentFor((c) => c.conversationHistory({ conversationId: 'c1' }))).toMatchObject({
      params: { conversationId: 'c1', afterSequence: 0 },
    });
    expect(
      await sentFor((c) => c.conversationHistory({ conversationId: 'c1', afterSequence: -4 })),
    ).toMatchObject({ params: { afterSequence: 0 } });
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

  it('exposes exactly the 14 allowlisted methods and nothing else', () => {
    expect(CORE_METHODS).toHaveLength(14);
    expect(new Set(CORE_METHODS).size).toBe(14);
    expect(CORE_METHODS).not.toContain('shell.exec');
    expect(CORE_METHODS).not.toContain('sbx.raw');
    const names = Object.getOwnPropertyNames(CoreCommands.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(names.sort()).toEqual(
      [
        'conversationCreate',
        'conversationHistory',
        'conversationList',
        'conversationSend',
        'gitApply',
        'gitReview',
        'projectCreate',
        'projectList',
        'sandboxCreate',
        'sandboxList',
        'systemProbe',
        'taskCancel',
        'taskList',
        'taskSubscribe',
      ].sort(),
    );
    // The wrapper surface must be exactly the allowlist: one wrapper per
    // Core method, no extra callable method (AGENTS.md: no free-form RPC).
    // `system.probe` → `systemProbe`, `conversation.history` → `conversationHistory`.
    const wrapperName = (method: string): string =>
      method.replace(/\.([a-z])/g, (_all, letter: string) => letter.toUpperCase());
    expect(names.sort()).toEqual(CORE_METHODS.map(wrapperName).sort());
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
    for (const bad of [
      '', 'a..b', 'a//b', 'a.lock', '-x', 'br/', 'br.', 'a; rm -rf /', '$(id)',
      // review 0006 #3: these pass the old loose mirror but fail Rust
      // Validator::branch_name — the client guard must reject them too.
      '.foo', 'a./b', '/.x',
    ]) {
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

  /**
   * The read-only enumeration methods take external ids too (a folder path, a
   * stored conversation id), so the same pre-write rule applies: nothing goes on
   * the wire until the value passes the guard that mirrors Core's.
   */
  it('refuses an empty or control-character scoping id before writing', async () => {
    for (const bad of ['', 'a\u0000b', 'x'.repeat(201)]) {
      const list = await attempt((c) => c.taskList({ projectId: bad }));
      expect(list.error, `projectId ${JSON.stringify(bad.slice(0, 12))}`).toBeInstanceOf(
        CoreValidationError,
      );
      expect(list.writes).toBe(0);
    }
    const conv = await attempt((c) => c.conversationList({ projectId: 'p\u0007id' }));
    expect(conv.error).toBeInstanceOf(CoreValidationError);
    expect(conv.writes).toBe(0);
    // Absent scope stays legal — that is the unscoped read, not a blank id.
    const unscoped = await attempt((c) => c.taskList({}));
    expect(unscoped.error).toBe(null);
    expect(unscoped.writes).toBe(1);
    expect(validateScopingId('p1', 'projectId')).toBe('p1');
    // Review 0010: Rust bounds `chars().count()`; each 🧵 is one scalar but TWO
    // UTF-16 units, so an exactly-at-limit astral id is legal and must be sent.
    const threads = '🧵'.repeat(200);
    expect(threads.length).toBe(400);
    const astral = await attempt((c) => c.taskList({ projectId: threads }));
    expect(astral.error).toBe(null);
    expect(astral.writes).toBe(1);
    expect(() => validateScopingId(`${threads}🧵`, 'projectId')).toThrowError(CoreValidationError);
  });

  it('refuses a conversationId that is blank or absurdly long before writing', async () => {
    for (const bad of ['', '   ', 'c'.repeat(201), 'c\u00001']) {
      const { error, writes } = await attempt((c) => c.conversationHistory({ conversationId: bad }));
      expect(error, `conversationId ${JSON.stringify(bad.slice(0, 12))}`).toBeInstanceOf(
        CoreValidationError,
      );
      expect(writes).toBe(0);
    }
  });

  it('refuses a status the closed Core enum does not define (never normalized)', async () => {
    // `half_finished` is exactly the case the Rust params type rejects at parse.
    const { error, writes } = await attempt((c) =>
      c.taskList({ projectId: 'p', statuses: ['queued', 'half_finished' as never] }),
    );
    expect(error).toBeInstanceOf(CoreValidationError);
    expect(writes).toBe(0);
    expect(() => validateStatusFilter(['running'])).not.toThrow();
    expect(validateStatusFilter(['running', 'running'])).toEqual(['running']);
    expect(validateStatusFilter([])).toBeUndefined();
  });

  it('refuses a non-integer or negative limit before writing', async () => {
    for (const bad of [-5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { error, writes } = await attempt((c) => c.taskList({ limit: bad }));
      expect(error, `limit ${bad}`).toBeInstanceOf(CoreValidationError);
      expect(writes).toBe(0);
      const history = await attempt((c) => c.conversationHistory({ conversationId: 'c', limit: bad }));
      expect(history.error, `history limit ${bad}`).toBeInstanceOf(CoreValidationError);
      expect(history.writes).toBe(0);
    }
  });

  it('bounds the afterSequences map like Core does, before writing', async () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 4097 }, (_unused, i) => [`task-${i}`, 1]),
    );
    const big = await attempt((c) => c.taskSubscribe({ projectId: 'p', afterSequence: 0, afterSequences: tooMany }));
    expect(big.error).toBeInstanceOf(CoreValidationError);
    expect(big.writes).toBe(0);

    const blankKey = await attempt((c) => c.taskSubscribe({ projectId: 'p', afterSequence: 0, afterSequences: { '': 3 } }));
    expect(blankKey.error).toBeInstanceOf(CoreValidationError);
    expect(blankKey.writes).toBe(0);

    const longKey = await attempt((c) =>
      c.taskSubscribe({ projectId: 'p', afterSequence: 0, afterSequences: { ['k'.repeat(101)]: 3 } }),
    );
    expect(longKey.error).toBeInstanceOf(CoreValidationError);
    expect(longKey.writes).toBe(0);

    // A 100-char ASCII key is inside the bound; a multi-byte key is measured in
    // BYTES like Rust `str::len()`, so 51 two-byte chars (102 bytes) is refused
    // even though it is only 51 characters.
    expect(validateCursorMap({ ['k'.repeat(100)]: 1 })).toEqual({ ['k'.repeat(100)]: 1 });
    expect(() => validateCursorMap({ ['é'.repeat(51)]: 1 })).toThrowError(CoreValidationError);
    expect(validateCursorMap({ t1: 4 })).toEqual({ t1: 4 });
    expect(validateCursorMap(undefined)).toBeUndefined();
  });
});
