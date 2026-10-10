/**
 * A2 idempotency keys, client side (design 2026-10-09 §3.1).
 *
 *  - One fresh key per USER ACTION (one Create, one Send): 128 bits from the
 *    OS CSPRNG, 32 lowercase hex chars. Never derived from content.
 *  - Sent only when Core advertises `idempotency-keys`.
 *  - Reused only by an explicit user "Retry safely" of that same action, with
 *    identical params. Nothing here retries automatically.
 *  - Core's three keyed CONFLICT answers (and A1's name lock) are recognised by
 *    exact message prefix, pinned against the Rust source by a drift test.
 */

import { randomBytes } from 'node:crypto';
import { CoreRpcError, CoreTransportError } from './connection';

// `validateIdempotencyKey` / `MAX_IDEMPOTENCY_KEY_LEN` live in commands.ts
// (beside the other wire validators) to keep this module import-cycle free.

/** A fresh key for ONE user action: 16 CSPRNG bytes as 32 lowercase hex chars. */
export function newIdempotencyKey(): string {
  return randomBytes(16).toString('hex');
}

/** Core `IDEM_MSG_MISMATCH` (sandpane-service). Nothing ran. */
export const IDEM_CONFLICT_MISMATCH =
  'idempotency key was already used with different parameters; nothing was run';
/** Core `IDEM_MSG_PENDING`. Nothing ran. */
export const IDEM_CONFLICT_PENDING =
  'an operation with this idempotency key is still in progress; nothing was run';
/** Core `IDEM_MSG_UNKNOWN`. The EARLIER attempt's outcome is unknown — NOT "nothing ran". */
export const IDEM_CONFLICT_UNKNOWN =
  'the outcome of the earlier request with this idempotency key is unknown (Core restarted or sbx ' +
  'failed while it ran); re-read state before retrying with a new key';
/** A1 `claim_sandbox_name`: `another operation on sandbox "<name>" is in progress; nothing was run`. */
export const NAME_LOCK_CONFLICT_PREFIX = 'another operation on sandbox ';
export const NAME_LOCK_CONFLICT_SUFFIX = ' is in progress; nothing was run';

export type KeyedConflict = 'mismatch' | 'pending' | 'unknown' | 'name-lock';

/** Core's raw message from a CONFLICT `CoreRpcError` (its `.message` is `CODE: message`). */
function conflictMessage(error: unknown): string | null {
  if (!(error instanceof CoreRpcError) || error.code !== 'CONFLICT') return null;
  const prefix = 'CONFLICT: ';
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

export function classifyKeyedConflict(error: unknown): KeyedConflict | null {
  const message = conflictMessage(error);
  if (message === null) return null;
  if (message.startsWith(IDEM_CONFLICT_MISMATCH)) return 'mismatch';
  if (message.startsWith(IDEM_CONFLICT_PENDING)) return 'pending';
  if (message.startsWith(IDEM_CONFLICT_UNKNOWN)) return 'unknown';
  if (message.startsWith(NAME_LOCK_CONFLICT_PREFIX) && message.includes(NAME_LOCK_CONFLICT_SUFFIX)) {
    return 'name-lock';
  }
  return null;
}

/**
 * Plain client copy per keyed CONFLICT. Cases 1, 2 and the name lock say
 * nothing was run (Core says so); case 3 never does — the earlier attempt's
 * outcome is unknown and a retry needs a NEW request (Core refuses this key).
 * Core's own message is shown next to it (sanitized) by the caller.
 */
export function keyedConflictCopy(kind: KeyedConflict): string {
  switch (kind) {
    case 'mismatch':
      return 'Core refused: this request\'s idempotency key was already used with different parameters. Nothing was run.';
    case 'pending':
      return 'Core refused: an earlier attempt of this same request is still in progress. Nothing was run — wait for it, then refresh.';
    case 'unknown':
      return (
        'Outcome unknown: Core cannot tell whether the earlier attempt with this key ran (Core restarted or ' +
        'sbx failed while it ran). Re-read state first; a retry needs a new request.'
      );
    case 'name-lock':
      return 'Core refused: another operation on this sandbox is in progress. Nothing was run.';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * Did the request possibly run without us learning the result? True for a
 * timeout, a connection lost or a write failure AFTER the request was handed
 * to the transport, and Core's INTERNAL (e.g. sbx failed after it started).
 * False when the frame provably never left (`not_connected`, untrusted socket,
 * unsupported platform), for client-side validation, and for any other
 * structured Core verdict.
 */
export function isUnknownOutcome(error: unknown): boolean {
  if (error instanceof CoreTransportError) {
    return error.reason === 'timeout' || error.reason === 'closed' || error.reason === 'send_failed';
  }
  if (error instanceof CoreRpcError) return error.code === 'INTERNAL';
  return false;
}

/**
 * The frame provably never left this client: not connected, an untrusted
 * socket, an unsupported platform. A "Retry safely" attempt that fails like
 * this leaves the EARLIER attempt's outcome exactly as unknown as before.
 */
export function isProvablyUnsent(error: unknown): boolean {
  return (
    error instanceof CoreTransportError &&
    (error.reason === 'not_connected' || error.reason === 'untrusted_socket' || error.reason === 'unsupported_platform')
  );
}

/** Exact copy shown when a response carries `replayed: true` (shared across clients). */
export const REPLAY_NOTICE =
  'Core returned the result of your earlier identical request (replayed). It may be out of date; refreshing from Core.';

export const RETRY_SAFELY = 'Retry safely';
