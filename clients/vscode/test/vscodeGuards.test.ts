import { describe, expect, it } from 'vitest';
import {
  DIRECT_MOUNT_LIVE_WRITABLE,
  allWorkspaceModeViews,
  isKnownWorkspaceMode,
  sandboxWorkspaceModeView,
  unknownWorkspaceModeView,
  unverifiedWorkspaceModeView,
  workspaceModeLabel,
  workspaceModeView,
} from '../src/vscode/workspaces';
import { evaluateHostContext } from '../src/vscode/host';
import { coreDataDir, coreDbPath, coreSocketPath, unsupportedPlatformReason } from '../src/core-client/paths';
import { WORKSPACE_MODES } from '../src/core-client/protocol';

describe('workspace mode labels (specs/02 §7, specs/06 §6)', () => {
  it('covers every wire mode', () => {
    expect(allWorkspaceModeViews().map((v) => v.mode).sort()).toEqual([...WORKSPACE_MODES].sort());
  });

  it('labels direct_mount as live-writable and never as isolated', () => {
    const view = workspaceModeView('direct_mount');
    expect(view.badge).toBe(DIRECT_MOUNT_LIVE_WRITABLE);
    expect(view.hostWritable).toBe(true);
    expect(view.tone).toBe('live_writable');
    expect(`${view.label} ${view.badge} ${view.explanation}`).not.toMatch(/isolat/i);
    expect(view.explanation).toMatch(/cannot take those writes back|cannot retroactively block/);
  });

  it('marks the isolated modes as not host-writable but not secret-safe', () => {
    expect(workspaceModeView('sbx_clone').hostWritable).toBe(false);
    expect(workspaceModeView('sbx_clone').explanation).toMatch(/not secrecy|mounts and copied repos/);
    expect(workspaceModeView('mountless').tone).toBe('scratch');
    expect(workspaceModeView('host_worktree').explanation).toMatch(/same worktree|worktree/);
  });

  it('treats an unrecognized mode as the worst case', () => {
    expect(isKnownWorkspaceMode('direct_mount')).toBe(true);
    expect(isKnownWorkspaceMode('docker_forever')).toBe(false);
    const view = unknownWorkspaceModeView('docker_forever');
    expect(view.hostWritable).toBe(true);
    expect(view.badge).toMatch(/UNKNOWN.*LIVE-WRITABLE/);
    expect(workspaceModeLabel('docker_forever')).toContain('docker_forever');
  });

  /**
   * `SandboxSummary.workspaceMode` is ABSENT when Core has no readable
   * `sandbox_bindings` row, and Core never guesses one. The client must render
   * that as UNVERIFIED — a blank cell would read as "no risk".
   */
  it('renders an absent sandbox mode as UNVERIFIED, never as safe', () => {
    for (const absent of [{}, { workspaceMode: null }, { workspaceMode: undefined }]) {
      const view = sandboxWorkspaceModeView(absent);
      expect(view.badge).toMatch(/UNVERIFIED/);
      expect(view.hostWritable).toBe(true);
      expect(view.tone).toBe('live_writable');
      // Saying "unknown" is not the same as promising isolation.
      expect(`${view.label} ${view.badge} ${view.explanation}`).not.toMatch(/isolated\b/i);
    }
    expect(unverifiedWorkspaceModeView().badge).toContain('LIVE-WRITABLE');
  });

  it('keeps the recorded direct_mount sandbox loud, and an unknown string loudest', () => {
    expect(sandboxWorkspaceModeView({ workspaceMode: 'direct_mount' }).badge).toBe(
      DIRECT_MOUNT_LIVE_WRITABLE,
    );
    expect(sandboxWorkspaceModeView({ workspaceMode: 'sbx_clone' }).hostWritable).toBe(false);
    // A mode name from a newer Core is treated as host-writable, not hidden.
    const future = sandboxWorkspaceModeView({ workspaceMode: 'bind_forever' });
    expect(future.hostWritable).toBe(true);
    expect(future.badge).toMatch(/UNKNOWN/);
    // Absent and unknown are distinct statements; both are loud.
    expect(sandboxWorkspaceModeView({}).badge).not.toBe(future.badge);
  });
});

describe('remote host gate (specs/03 §2)', () => {
  it('allows only the local extension host', () => {
    expect(evaluateHostContext({}).supported).toBe(true);
    expect(evaluateHostContext({ remoteName: undefined, extensionScheme: 'file' }).supported).toBe(true);
  });

  it('refuses every remote kind with an explanation, without running anything', () => {
    for (const remoteName of ['ssh-remote', 'wsl', 'dev-container', 'codespaces', 'attached-container']) {
      const verdict = evaluateHostContext({ remoteName });
      expect(verdict.supported).toBe(false);
      expect(verdict.label).toContain('unsupported');
      expect(verdict.explanation).toMatch(/remote/i);
      expect(verdict.explanation).toMatch(/wrong filesystem|local filesystem/i);
    }
    expect(evaluateHostContext({ remoteName: 'ssh-remote' }).label).toContain('SSH');
    expect(evaluateHostContext({ remoteName: 'brand-new-remote' }).label).toContain('brand-new-remote');
  });

  it('refuses an extension loaded from a non-file scheme', () => {
    const verdict = evaluateHostContext({ extensionScheme: 'vscode-vfs' });
    expect(verdict.supported).toBe(false);
    expect(verdict.explanation).toContain('vscode-vfs');
  });
});

describe('Core socket path resolution (mirrors sandpane_service)', () => {
  const base = { env: {}, platform: 'darwin' as const, homedir: '/Users/me' };

  it('uses the macOS application-support data directory', () => {
    expect(coreDataDir(base)).toBe('/Users/me/Library/Application Support/sandpane');
    expect(coreSocketPath(base)).toBe('/Users/me/Library/Application Support/sandpane/sandpane.sock');
    expect(coreDbPath(base)).toBe('/Users/me/Library/Application Support/sandpane/sandpane.sqlite3');
  });

  it('prefers an explicit setting, then SANDPANE_SOCKET, then the default', () => {
    expect(coreSocketPath({ ...base, env: { SANDPANE_SOCKET: '/tmp/x.sock' } })).toBe('/tmp/x.sock');
    expect(coreSocketPath({ ...base, env: { SANDPANE_SOCKET: '/tmp/x.sock' } }, '/tmp/y.sock')).toBe('/tmp/y.sock');
    expect(coreSocketPath(base, '   ')).toBe('/Users/me/Library/Application Support/sandpane/sandpane.sock');
  });

  it('follows XDG_STATE_HOME on linux, with the documented fallback', () => {
    const linux = { env: {}, platform: 'linux' as const, homedir: '/home/me' };
    expect(coreDataDir(linux)).toBe('/home/me/.local/state/sandpane');
    expect(coreDataDir({ ...linux, env: { XDG_STATE_HOME: '/state' } })).toBe('/state/sandpane');
    expect(coreDbPath({ ...linux, env: { SANDPANE_DB: '/tmp/db.sqlite3' } })).toBe('/tmp/db.sqlite3');
  });

  it('reports Windows as unsupported instead of pretending a pipe exists', () => {
    const reason = unsupportedPlatformReason('win32');
    expect(reason).toMatch(/named-pipe/i);
    expect(reason).toMatch(/P1/i);
    expect(unsupportedPlatformReason('darwin')).toBeUndefined();
    expect(unsupportedPlatformReason('linux')).toBeUndefined();
  });

  it('never resolves a TCP address (specs/02 §2: no TCP by default)', () => {
    for (const inputs of [base, { env: {}, platform: 'linux' as const, homedir: '/home/me' }]) {
      expect(coreSocketPath(inputs)).not.toMatch(/^(tcp|http|localhost|127\.)/);
      expect(coreSocketPath(inputs)).toContain('.sock');
    }
  });
});
