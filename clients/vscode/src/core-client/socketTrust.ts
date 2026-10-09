/**
 * Socket trust check before the client attaches (security review W4).
 *
 * The Core socket path can come from a setting or `SANDPANE_SOCKET`; whatever
 * answers there receives every prompt and attachment reference this client
 * sends. Before connecting, the path is `lstat`ed (a symlink is NOT followed)
 * and must be a Unix socket owned by the current user with no group/other
 * permission bits — the exact shape `sandpane-service` creates (0600, in a 0700
 * directory). Anything else is refused with a reason, never "tried anyway".
 *
 * Pure verdict function so the rules are unit-tested without a filesystem.
 */

export interface SocketStatLike {
  isSocket(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
}

/** `undefined` = trusted; otherwise the human-readable refusal reason. */
export function checkSocketTrust(stat: SocketStatLike, expectedUid: number): string | undefined {
  if (stat.isSymbolicLink()) {
    return 'the Core socket path is a symbolic link; Sandpane only attaches to the socket file itself';
  }
  if (!stat.isSocket()) {
    return 'the Core socket path exists but is not a Unix socket';
  }
  if (stat.uid !== expectedUid) {
    return `the Core socket is owned by uid ${stat.uid}, not by you (uid ${expectedUid})`;
  }
  const looseBits = stat.mode & 0o077;
  if (looseBits !== 0) {
    return (
      `the Core socket grants group/other permissions (mode ${(stat.mode & 0o777).toString(8)}); ` +
      'sandpane-service creates it 0600'
    );
  }
  return undefined;
}
