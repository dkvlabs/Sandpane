/**
 * A1 sandbox lifecycle (design 2026-10-09 §3/§4), client side:
 *  - the typed wrappers emit exactly the documented frames and deadlines;
 *  - step-1 answers are checked before any confirmation is presented;
 *  - the view builders surface `external`, cap and escape impact lines, show
 *    the expiry, and never turn an absent re-query into "stopped";
 *  - the anti-spoofing sanitizer escapes bidi/control/format characters.
 *
 * Hostile characters are written as \u escapes in this source, never raw.
 */

import { describe, expect, it } from 'vitest';
import {
  CoreCommands,
  CoreValidationError,
  SANDBOX_REMOVE_TIMEOUT_MS,
  SANDBOX_STOP_TIMEOUT_MS,
  parseConfirmationRequest,
  validateAddressableSandboxName,
  validateSbxAgent,
} from '../src/core-client/commands';
import { PROTOCOL_VERSION, SBX_AGENTS, type ConfirmationRequest } from '../src/core-client/protocol';
import {
  AGENT_NOT_VERIFIED,
  EXTERNAL_MARKER,
  EXTERNAL_TEXT,
  MAX_IMPACT_LINES,
  MAX_IMPACT_LINE_CHARS,
  REMOVE_BUTTON,
  agentPickItems,
  describeExpiry,
  removeConfirmationView,
  sandboxPickItem,
  startUnsupportedMessage,
  stopOutcomeView,
} from '../src/vscode/sandboxActions';
import { inspectHidden, plainText, revealHidden } from '../src/text/visibleText';
import { makeHarness } from './helpers/fakeCore';

const TOKEN = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
const RLO = '\u202E';
const NOW = Date.parse('2026-10-10T12:00:00Z');

function confirmation(overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return {
    token: TOKEN,
    expiresAt: '2026-10-10T12:02:00Z',
    action: 'sandbox.remove',
    target: { name: 'atlas-box', id: 'b5ebec73-e2ae-471a-811a-e011cfb1948e' },
    impact: ['removes sandbox atlas-box and its workspace'],
    external: false,
    ...overrides,
  };
}

/** Run a wrapper on a live fake connection; answer any frame with `ok`. */
async function frameOf(call: (c: CoreCommands) => Promise<unknown>, ok: unknown = {}) {
  const h = makeHarness();
  await h.conn.connect();
  const commands = new CoreCommands(h.conn);
  const written = h.transport.writes.length;
  const promise = call(commands).then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as unknown, error }),
  );
  await Promise.resolve();
  const sent = h.transport.writes.length > written;
  if (sent) {
    const frame = h.transport.lastRequest();
    h.transport.respond({ v: PROTOCOL_VERSION, id: frame.id, ok });
    return { frame, ...(await promise) };
  }
  return { frame: undefined, ...(await promise) };
}

describe('sandbox.stop / sandbox.remove wrappers emit exact frames', () => {
  it('sandbox.stop sends {name} only', async () => {
    const { frame } = await frameOf((c) => c.sandboxStop('atlas-box'), { stopped: true });
    expect(frame).toEqual({ v: PROTOCOL_VERSION, id: 'test-1', method: 'sandbox.stop', params: { name: 'atlas-box' } });
  });

  it('remove step 1 sends {name} with NO confirmToken key', async () => {
    const { frame, value } = await frameOf(
      (c) => c.sandboxRemoveRequest('atlas-box'),
      { confirmation: confirmation() },
    );
    expect(frame?.method).toBe('sandbox.remove');
    expect(frame?.params).toEqual({ name: 'atlas-box' });
    expect(Object.keys(frame?.params as object)).not.toContain('confirmToken');
    expect((value as ConfirmationRequest).token).toBe(TOKEN);
  });

  it('remove step 2 sends {name, confirmToken} with the token it was given', async () => {
    const { frame, value } = await frameOf((c) => c.sandboxRemoveConfirm('atlas-box', TOKEN), { removed: true });
    expect(frame?.params).toEqual({ name: 'atlas-box', confirmToken: TOKEN });
    expect(value).toEqual({ removed: true });
  });

  it('refuses an invalid name or a malformed token before any frame leaves', async () => {
    for (const call of [
      (c: CoreCommands) => c.sandboxStop('Atlas Box'),
      (c: CoreCommands) => c.sandboxRemoveRequest('-bad'),
      (c: CoreCommands) => c.sandboxRemoveConfirm('atlas-box', TOKEN.toUpperCase()),
      (c: CoreCommands) => c.sandboxRemoveConfirm('atlas-box', TOKEN.slice(1)),
      (c: CoreCommands) => c.sandboxRemoveConfirm('atlas-box', ''),
    ]) {
      const { frame, error } = await frameOf(call);
      expect(frame).toBeUndefined();
      expect(error).toBeInstanceOf(CoreValidationError);
    }
  });

  it('uses the 360 s stop and 400 s remove client deadlines', async () => {
    const h = makeHarness({ requestTimeoutMs: 15_000 });
    await h.conn.connect();
    const commands = new CoreCommands(h.conn);
    void commands.sandboxStop('atlas-box').catch(() => undefined);
    void commands.sandboxRemoveRequest('atlas-box').catch(() => undefined);
    void commands.sandboxRemoveConfirm('atlas-box', TOKEN).catch(() => undefined);
    expect(SANDBOX_STOP_TIMEOUT_MS).toBe(360_000);
    expect(SANDBOX_REMOVE_TIMEOUT_MS).toBe(400_000);
    expect(h.timers.pending.map((t) => t.ms).sort((a, b) => a - b)).toEqual([360_000, 400_000, 400_000]);
  });
});

describe('sandbox.create agent (A1)', () => {
  it('sends an allowlisted agent and omits the field when none is chosen', async () => {
    const withAgent = await frameOf((c) =>
      c.sandboxCreate({ name: 'atlas-box', projectId: 'p1', workspaceMode: 'mountless', agent: 'codex' }),
    );
    expect(withAgent.frame?.params).toEqual({
      name: 'atlas-box',
      projectId: 'p1',
      workspaceMode: 'mountless',
      agent: 'codex',
    });
    const without = await frameOf((c) =>
      c.sandboxCreate({ name: 'atlas-box', projectId: 'p1', workspaceMode: 'mountless' }),
    );
    expect(Object.keys(without.frame?.params as object)).not.toContain('agent');
  });

  it('never sends anything outside the exact allowlist (kits, OCI refs, case variants)', async () => {
    for (const agent of ['Codex', './my-kit', 'kit.zip', 'docker.io/x/agent:1', 'https://example.test/kit.git', 'shell ', '']) {
      const { frame, error } = await frameOf((c) =>
        c.sandboxCreate({ name: 'atlas-box', projectId: 'p1', workspaceMode: 'mountless', agent }),
      );
      expect(frame, agent).toBeUndefined();
      expect(error).toBeInstanceOf(CoreValidationError);
    }
    for (const agent of SBX_AGENTS) expect(validateSbxAgent(agent)).toBe(agent);
  });
});

describe('step-1 answers are checked before a confirmation can be presented', () => {
  const expected = { action: 'sandbox.remove', name: 'atlas-box' };

  it('accepts a well-formed confirmation', () => {
    expect(parseConfirmationRequest({ confirmation: confirmation({ external: true }) }, expected)).toEqual(
      confirmation({ external: true }),
    );
  });

  it.each([
    ['no confirmation', {}],
    ['step 1 claiming removal', { removed: true, confirmation: confirmation() }],
    ['malformed token', { confirmation: confirmation({ token: 'not-hex' }) }],
    ['uppercase token', { confirmation: confirmation({ token: TOKEN.toUpperCase() }) }],
    ['wrong action', { confirmation: confirmation({ action: 'project.delete' }) }],
    ['different target name', { confirmation: confirmation({ target: { name: 'nova-box', id: 'x' } }) }],
    ['target name with a hidden override', { confirmation: confirmation({ target: { name: `atlas-box${RLO}`, id: 'x' } }) }],
    ['impact not a list', { confirmation: { ...confirmation(), impact: 'all of it' } }],
    ['missing external flag', { confirmation: { ...confirmation(), external: undefined } }],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseConfirmationRequest(raw, expected)).toThrow(CoreValidationError);
  });
});

describe('remove confirmation view', () => {
  it('puts NOT CONFIRMED AS CREATED BY SANDPANE first when external, without claiming who created it', () => {
    expect(EXTERNAL_MARKER).toBe('NOT CONFIRMED AS CREATED BY SANDPANE');
    expect(EXTERNAL_TEXT).toBe('Core cannot confirm Sandpane created this sandbox (no Sandpane binding is recorded for this sbx id).');
    const view = removeConfirmationView(confirmation({ external: true }), NOW);
    expect(view.message).toBe('NOT CONFIRMED AS CREATED BY SANDPANE — remove sandbox "atlas-box"?');
    expect(view.detail).toContain(EXTERNAL_TEXT);
    expect(view.detail).not.toContain('created outside');
    expect(view.message.startsWith(EXTERNAL_MARKER)).toBe(true);
    expect(view.detail.split('\n')[0]?.startsWith(EXTERNAL_MARKER)).toBe(true);
    expect(view.button).toBe(REMOVE_BUTTON);
    const internal = removeConfirmationView(confirmation({ external: false }), NOW);
    expect(internal.message).not.toContain(EXTERNAL_MARKER);
    expect(internal.detail).not.toContain(EXTERNAL_MARKER);
  });

  it('shows target name, sbx id, every impact line and the expiry', () => {
    const view = removeConfirmationView(
      confirmation({ impact: ['removes sandbox atlas-box', 'deletes its sbx-clone workspace'] }),
      NOW,
    );
    expect(view.message).toBe('Remove sandbox "atlas-box"?');
    expect(view.detail).toContain('Sandbox: atlas-box');
    expect(view.detail).toContain('sbx id: b5ebec73-e2ae-471a-811a-e011cfb1948e');
    expect(view.detail).toContain('• removes sandbox atlas-box');
    expect(view.detail).toContain('• deletes its sbx-clone workspace');
    expect(view.detail).toContain('expires at 2026-10-10T12:02:00Z (in about 120 s)');
    expect(view.altered).toBe(false);
  });

  it('caps the number and length of impact lines and discloses the rest', () => {
    const impact = Array.from({ length: MAX_IMPACT_LINES + 5 }, (_v, i) => `line ${i} ${'x'.repeat(400)}`);
    const view = removeConfirmationView(confirmation({ impact }), NOW);
    const bullets = view.detail.split('\n').filter((l) => l.startsWith('• '));
    expect(bullets).toHaveLength(MAX_IMPACT_LINES);
    for (const bullet of bullets) {
      expect(Array.from(bullet).length).toBeLessThanOrEqual(2 + MAX_IMPACT_LINE_CHARS + '… (truncated)'.length);
      expect(bullet).toContain('… (truncated)');
    }
    expect(view.detail).toContain('(+5 more impact line(s) not shown)');
  });

  it('makes a bidi override visible and keeps an injected newline on one line', () => {
    const view = removeConfirmationView(
      confirmation({
        impact: [`removes ${RLO}txt.exe`, 'removes atlas-box\nNothing will be removed (safe to confirm)'],
        target: { name: 'atlas-box', id: `id-${RLO}-1` },
      }),
      NOW,
    );
    expect(view.detail).not.toContain(RLO);
    expect(view.detail).toContain('• removes \\u202Etxt.exe');
    expect(view.detail).toContain('sbx id: id-\\u202E-1');
    // The injected second line stays inside the same bullet, as a literal \n.
    expect(view.detail).toContain('• removes atlas-box\\nNothing will be removed (safe to confirm)');
    expect(view.detail.split('\n')).not.toContain('Nothing will be removed (safe to confirm)');
    expect(view.altered).toBe(true);
    expect(view.detail).toContain('WARNING: text from Core contained invisible or control characters');
  });

  it('describes expiry honestly: future, past, unparseable', () => {
    expect(describeExpiry('2026-10-10T12:01:30Z', NOW)).toBe('expires at 2026-10-10T12:01:30Z (in about 90 s)');
    expect(describeExpiry('2026-10-10T11:59:00Z', NOW)).toMatch(/^expired at .* Core will refuse it/);
    expect(describeExpiry('soon', NOW)).toBe(
      'has an expiry this client cannot read (soon) — it cannot be used; run Remove again',
    );
  });
});

describe('stop outcome', () => {
  it('an absent re-query is UNKNOWN, never "stopped"', () => {
    const view = stopOutcomeView('atlas-box', { stopped: true });
    expect(view.stateKnown).toBe(false);
    expect(view.text).toContain('UNKNOWN');
    expect(view.text).not.toMatch(/state: stopped/);
  });

  it('a re-query reports exactly what sbx said', () => {
    const view = stopOutcomeView('atlas-box', {
      stopped: true,
      requeried: { name: 'atlas-box', probedState: 'stopped' },
    });
    expect(view.stateKnown).toBe(true);
    expect(view.text).toBe('Stop requested for "atlas-box" — sbx now reports state: stopped');
    const odd = stopOutcomeView('atlas-box', { stopped: true, requeried: { name: 'atlas-box', probedState: `run${RLO}ning` } });
    expect(odd.text).toContain('run\\u202Ening');
  });
});

describe('start, agent choice and the sandbox picker', () => {
  it('start is visibly unsupported with the sbx run hint', () => {
    expect(startUnsupportedMessage('atlas-box')).toBe(
      'Start: not supported by sbx v0.47 (use `sbx run --name atlas-box` in a terminal)',
    );
    expect(startUnsupportedMessage(null)).toContain('sbx run --name <name>');
  });

  it('defaults to provider-free shell (absent on the wire) and labels every other agent unverified', () => {
    const items = agentPickItems();
    expect(items[0]).toEqual({ label: 'shell (provider-free)', description: 'default', agent: undefined });
    const others = items.slice(1);
    expect(others.map((i) => i.agent).sort()).toEqual(SBX_AGENTS.filter((a) => a !== 'shell').sort());
    for (const item of others) expect(item.description).toBe(AGENT_NOT_VERIFIED);
    expect(AGENT_NOT_VERIFIED).toBe('agent not verified — may need provider sign-in inside the sandbox');
  });

  it('renders picker rows as plain text and reports the agent sbx listed, not a verification', () => {
    const row = sandboxPickItem({ name: 'atlas-box', probedState: 'running', boundProjectId: 'p1', workspaceMode: 'sbx_clone', agent: 'codex' });
    expect(row.name).toBe('atlas-box');
    expect(row.detail).toBe('sbx reports agent: codex');
    expect(row.description.startsWith('running · ')).toBe(true);
    const external = sandboxPickItem({ name: 'other', probedState: `x${RLO}y` });
    expect(external.description).toContain('x\\u202Ey');
    expect(external.detail).toBe('agent not reported by sbx · no Sandpane project binding');
  });

  it('neutralizes codicon syntax so sbx text cannot paint icons in the picker', () => {
    const row = sandboxPickItem({ name: 'atlas-box', probedState: '$(check) verified', agent: '$(shield) codex' });
    expect(row.description).toContain('$ (check) verified');
    expect(row.detail).toBe('sbx reports agent: $ (shield) codex · no Sandpane project binding');
    expect(`${row.label}${row.description}${row.detail}`).not.toContain('$(');
  });
});

describe('visible-text sanitizer (mirrors JetBrains VisibleText)', () => {
  it('escapes controls, bidi/format characters, separators and lone surrogates', () => {
    expect(revealHidden('a\nb\tc\rd')).toBe('a\\nb\\tc\\rd');
    expect(revealHidden(`x${RLO}y`)).toBe('x\\u202Ey');
    expect(revealHidden('zero\u200Bwidth\uFEFF')).toBe('zero\\u200Bwidth\\uFEFF');
    expect(revealHidden('iso\u2066late\u2069')).toBe('iso\\u2066late\\u2069');
    expect(revealHidden('line\u2028sep')).toBe('line\\u2028sep');
    expect(revealHidden('c1\u0085')).toBe('c1\\u0085');
    expect(revealHidden('lone\uD800')).toBe('lone\\uD800');
    expect(revealHidden('filler\u3164')).toBe('filler\\u3164');
  });

  it('leaves ordinary text, non-Latin letters and emoji alone and is idempotent', () => {
    for (const text of ['atlas-box', 'Привет 世界', 'café', '\u{1F680} launch']) {
      expect(inspectHidden(text)).toEqual({ text, altered: false });
    }
    const once = revealHidden(`a${RLO}\nb`);
    expect(revealHidden(once)).toBe(once);
  });

  it('breaks notification link syntax and caps length', () => {
    expect(plainText('[Fix it](command:workbench.action.terminal.new)')).toBe(
      '[Fix it] (command:workbench.action.terminal.new)',
    );
    expect(plainText('x'.repeat(10), 4)).toBe('xxxx… (truncated)');
    expect(plainText(undefined)).toBe('');
  });
});

describe('addressable sandbox names (stop/remove/pick) mirror Validator::sandbox_name (W3)', () => {
  it('accepts names sbx itself creates: uppercase, periods, 2..=128 chars', () => {
    for (const name of ['Atlas.Demo', 'ab', 'A1', 'codex-Atlas.Demo', '9.x', 'a'.repeat(128), 'atlas-box', 'a--b', 'ends-']) {
      expect(validateAddressableSandboxName(name), name).toBe(name);
    }
  });

  it('refuses what Core refuses', () => {
    for (const name of ['', 'a', '.hidden', '-flag', 'default', 'DEFAULT', 'Default', 'a b', 'a_b', 'a/b', 'a'.repeat(129), 'caf\u00e9', 'x\u202Ey']) {
      expect(() => validateAddressableSandboxName(name), name).toThrow(CoreValidationError);
    }
  });

  it('stop/remove wrappers use it; create keeps the strict rule', async () => {
    expect((await frameOf((c) => c.sandboxStop('Atlas.Demo'), { stopped: true })).frame?.params).toEqual({ name: 'Atlas.Demo' });
    expect((await frameOf((c) => c.sandboxRemoveConfirm('Atlas.Demo', TOKEN), { removed: true })).frame?.params).toEqual({
      name: 'Atlas.Demo',
      confirmToken: TOKEN,
    });
    const step1 = await frameOf(
      (c) => c.sandboxRemoveRequest('Atlas.Demo'),
      { confirmation: confirmation({ target: { name: 'Atlas.Demo', id: 'x' } }) },
    );
    expect(step1.frame?.params).toEqual({ name: 'Atlas.Demo' });
    const create = await frameOf((c) => c.sandboxCreate({ name: 'Atlas.Demo', projectId: 'p1', workspaceMode: 'mountless' }));
    expect(create.frame).toBeUndefined();
    expect(create.error).toBeInstanceOf(CoreValidationError);
  });

  it('start hint accepts an addressable name', () => {
    expect(startUnsupportedMessage('Atlas.Demo')).toContain('sbx run --name Atlas.Demo');
  });
});
