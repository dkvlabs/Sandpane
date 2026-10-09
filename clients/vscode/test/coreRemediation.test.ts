/**
 * Core-side changes the client must follow (orchestrator update, review 0015):
 *  - "no verified adapter" is PERMISSION_DENIED (policy), not PROVIDER_AUTH_REQUIRED;
 *  - PROVIDER_AUTH_REQUIRED means "sign in" (e.g. sbx: not signed in to Docker)
 *    and both may carry `details.hint` (`sbx login`, `sbx policy init …`) that
 *    must be shown to the user — as text, never executed;
 *  - sandbox.create (sbx create) may take up to 300 s: its request deadline is
 *    longer than the 15 s default, every other method keeps the default;
 *  - Core returns CANONICAL repository paths, so a workspace folder is matched
 *    against them only after realpath on the folder side.
 */

import { describe, expect, it } from 'vitest';
import { CoreRpcError } from '../src/core-client/connection';
import { CoreCommands, SANDBOX_CREATE_TIMEOUT_MS } from '../src/core-client/commands';
import { explainCoreErrorCode, remediationFrom } from '../src/vscode/diagnostics';
import { matchWorkspaceFolder } from '../src/state/sessionPolicy';
import { makeHarness } from './helpers/fakeCore';

const rpc = (code: string, message: string, details?: unknown) =>
  new CoreRpcError({ code: code as 'INTERNAL', message, ...(details === undefined ? {} : { details }) }, 'r1');

describe('remediation hints from Core details', () => {
  it('surfaces details.hint and the provider for a sign-in failure', () => {
    const r = remediationFrom(rpc('PROVIDER_AUTH_REQUIRED', 'not signed in', { provider: 'docker', hint: 'sbx login' }));
    expect(r).toEqual({ hint: 'sbx login', provider: 'docker' });
  });

  it('surfaces the policy-init hint for PERMISSION_DENIED', () => {
    const r = remediationFrom(
      rpc('PERMISSION_DENIED', 'policy not initialized', { hint: 'sbx policy init <allow-all|balanced|deny-all>' }),
    );
    expect(r?.hint).toBe('sbx policy init <allow-all|balanced|deny-all>');
  });

  it('ignores absent, non-string, multi-line or oversized hints', () => {
    expect(remediationFrom(rpc('PERMISSION_DENIED', 'x'))).toBeUndefined();
    expect(remediationFrom(rpc('PERMISSION_DENIED', 'x', { hint: 42 }))).toBeUndefined();
    expect(remediationFrom(rpc('PERMISSION_DENIED', 'x', { hint: 'a\nrm -rf /' }))).toBeUndefined();
    expect(remediationFrom(rpc('PERMISSION_DENIED', 'x', { hint: 'x'.repeat(500) }))).toBeUndefined();
    expect(remediationFrom(new Error('plain'))).toBeUndefined();
  });

  it('the guidance copy matches what each code now means', () => {
    expect(explainCoreErrorCode('PROVIDER_AUTH_REQUIRED').explanation).toMatch(/sign(ed)? in/i);
    const denied = explainCoreErrorCode('PERMISSION_DENIED');
    expect(denied.explanation).toMatch(/verified agent adapter/i);
    expect(denied.explanation).toMatch(/policy/i);
  });
});

describe('per-method request deadlines', () => {
  it('sandbox.create waits up to 330 s; other methods keep the default', async () => {
    const h = makeHarness({ requestTimeoutMs: 15_000 });
    await h.conn.connect();
    const commands = new CoreCommands(h.conn);
    void commands.sandboxCreate({ name: 'atlas-box', projectId: 'p1', workspaceMode: 'mountless' }).catch(() => undefined);
    void commands.projectList().catch(() => undefined);
    expect(SANDBOX_CREATE_TIMEOUT_MS).toBe(330_000);
    expect(h.timers.pending.map((t) => t.ms).sort((a, b) => a - b)).toEqual([15_000, 330_000]);
  });
});

describe('canonical workspace-folder matching', () => {
  it('matches a folder to a project repository only after canonicalizing the folder', () => {
    // macOS: /var is a symlink to /private/var; Core stores the canonical form.
    const folders = [
      { fsPath: '/Users/me/other', canonical: '/Users/me/other' },
      { fsPath: '/var/folders/x/repo', canonical: '/private/var/folders/x/repo' },
    ];
    expect(matchWorkspaceFolder(folders, ['/private/var/folders/x/repo'])?.fsPath).toBe('/var/folders/x/repo');
  });

  it('never matches by prefix (a monorepo subfolder is not the repository)', () => {
    const folders = [{ fsPath: '/repo/mono/packages/a', canonical: '/repo/mono/packages/a' }];
    expect(matchWorkspaceFolder(folders, ['/repo/mono'])).toBeUndefined();
    expect(matchWorkspaceFolder([{ fsPath: '/repo/mono2', canonical: '/repo/mono2' }], ['/repo/mono'])).toBeUndefined();
  });

  it('a trailing slash difference is not a different repository', () => {
    expect(matchWorkspaceFolder([{ fsPath: '/r/a/', canonical: '/r/a/' }], ['/r/a'])?.fsPath).toBe('/r/a/');
  });
});
