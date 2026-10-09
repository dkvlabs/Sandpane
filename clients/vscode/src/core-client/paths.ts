/**
 * Core socket/data-directory resolution, mirroring `sandpane_service`
 * (default_socket_path / data_dir in core/crates/sandpane-service/src/lib.rs).
 * Pure so the precedence rules are testable without a filesystem.
 */

export interface PathInputs {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform | string;
  homedir: string;
}

/** Extension setting wins, then `SANDPANE_SOCKET`, then the per-user default. */
export function coreSocketPath(inputs: PathInputs, override?: string): string {
  const setting = override?.trim();
  if (setting) return setting;
  const fromEnv = inputs.env['SANDPANE_SOCKET'];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return joinPosix(coreDataDir(inputs), 'sandpane.sock');
}

export function coreDbPath(inputs: PathInputs): string {
  const fromEnv = inputs.env['SANDPANE_DB'];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return joinPosix(coreDataDir(inputs), 'sandpane.sqlite3');
}

/**
 * `data_dir()`: macOS → `~/Library/Application Support/sandpane`,
 * otherwise `$XDG_STATE_HOME` (else `~/.local/state`) + `/sandpane`.
 * The directory is created 0700 by the service; the socket is 0600.
 */
export function coreDataDir(inputs: PathInputs): string {
  const home = inputs.homedir || '/tmp';
  if (inputs.platform === 'darwin') {
    return joinPosix(home, 'Library/Application Support/sandpane');
  }
  const xdg = inputs.env['XDG_STATE_HOME'];
  const base = xdg && xdg.trim().length > 0 ? xdg.trim() : joinPosix(home, '.local/state');
  return joinPosix(base, 'sandpane');
}

/**
 * Windows is not supported by this transport: the Core service binds a Unix
 * domain socket, and the named-pipe transport is a P1 deliverable
 * (core/crates/sandpane-service/src/lib.rs header). Reported, never pretended.
 */
export function unsupportedPlatformReason(platform: NodeJS.Platform | string): string | undefined {
  return platform === 'win32'
    ? 'Sandpane Core serves a Unix domain socket in this build; the Windows named-pipe ' +
        'transport is a P1 deliverable (specs/02 §2). Attaching over a local TCP socket is ' +
        'not offered — Core never binds TCP.'
    : undefined;
}

export function joinPosix(...parts: string[]): string {
  const cleaned = parts.map((p) => p.replace(/\/+$/, '')).filter((p) => p.length > 0);
  if (cleaned.length === 0) return '/';
  return cleaned.join('/');
}
