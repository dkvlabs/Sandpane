/**
 * A2 idempotency keys on the desktop (design 2026-10-09 §3.1 items 1–10).
 *
 * - A key is sent ONLY when `system.probe` advertises `idempotency-keys`; a
 *   pre-A2 Core silently drops the field, so a key sent to it would promise a
 *   safety it does not have.
 * - Each user action (one Create, one Send) gets ONE fresh 128-bit key from the
 *   platform CSPRNG. It is never derived from content.
 * - The same key is reused ONLY by an explicit user "Retry safely" after an
 *   UNKNOWN outcome. Nothing here retries automatically, and the automatic
 *   replay sets (`REPLAY_SAFE_METHODS`, Rust `replay_safe`) are unchanged.
 *
 * Pure logic, no React, so the node-only suites can prove what is sent.
 */

import { CoreRequestError, coreErrorCode, type ProbeOutcome } from "./core-client";
import {
  FEATURE_IDEMPOTENCY_KEYS,
  IDEMPOTENCY_KEY_PATTERN,
  coreAdvertisesFeature,
  type CoreCapabilities,
} from "./protocol";

/** Bytes of entropy per key (128 bits → 32 lowercase hex characters). */
export const IDEMPOTENCY_KEY_BYTES = 16;

/** Fills `bytes` from a CSPRNG. Injected in tests; `crypto.getRandomValues` otherwise. */
export type RandomFill = (bytes: Uint8Array<ArrayBuffer>) => void;

const defaultRandomFill: RandomFill = (bytes) => {
  globalThis.crypto.getRandomValues(bytes);
};

/** One fresh key: 32 lowercase hex characters from the CSPRNG. */
export function newIdempotencyKey(fill: RandomFill = defaultRandomFill): string {
  const bytes = new Uint8Array(new ArrayBuffer(IDEMPOTENCY_KEY_BYTES));
  fill(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Core's key rule, exactly (1..=128 of `[A-Za-z0-9._-]`). */
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && IDEMPOTENCY_KEY_PATTERN.test(key);
}

/** Whether THIS Core honours `idempotencyKey`. */
export function idempotencyKeysAdvertised(
  capabilities: Pick<CoreCapabilities, "features"> | null | undefined,
): boolean {
  return coreAdvertisesFeature(capabilities, FEATURE_IDEMPOTENCY_KEYS);
}

/**
 * The params for ONE new user action: with a fresh key when the Core
 * advertises the feature, and with no `idempotencyKey` key at all otherwise.
 */
export function forNewAction<P extends object>(
  params: P,
  keysAdvertised: boolean,
  fill: RandomFill = defaultRandomFill,
): P & { idempotencyKey?: string } {
  if (!keysAdvertised) return { ...params };
  return { ...params, idempotencyKey: newIdempotencyKey(fill) };
}

/**
 * An UNKNOWN outcome: the request reached (or may have reached) Core and its
 * answer did not say whether it ran — a client timeout or transport drop after
 * the write (`mayHaveBeenApplied`), or a Core `INTERNAL` failure (sbx may have
 * acted). Core CONFLICTs are NOT unknown outcomes here: they say what happened.
 */
export function isUnknownOutcome(err: unknown): boolean {
  if (!(err instanceof CoreRequestError)) return false;
  if (err.mayHaveBeenApplied) return true;
  return err.isCoreError && err.code === "INTERNAL";
}

/**
 * Offer "Retry safely" only when the failed request CARRIED a key and its
 * outcome is unknown. Resending the identical params with that same key is safe:
 * Core returns the stored first result, refuses with a CONFLICT, or — only if
 * nothing ran — runs it once. Without a key there is no such guarantee, so no
 * offer; the existing "re-read state first" copy stands.
 */
export function retrySafelyOffered(
  err: unknown,
  params: { idempotencyKey?: string } | undefined,
): boolean {
  return params !== undefined && isValidIdempotencyKey(params.idempotencyKey) && isUnknownOutcome(err);
}

export const RETRY_SAFELY_LABEL = "Retry safely";
export const RETRY_SAFELY_EXPLANATION =
  "Resends the identical request with the same idempotency key. Within 24 hours Core returns the earlier result or refuses instead of running it twice; it never retries by itself.";

/** Core sent a `replayed` marker this build cannot read: treat as a maybe-replay. */
export const REPLAY_UNCERTAIN_NOTICE =
  "Core's answer carried a replay marker this desktop build cannot read, so it may be the result of an earlier identical request. It may be out of date; refreshing from Core.";

/** Exact cross-client copy for a replayed response. */
export const REPLAY_NOTICE =
  "Core returned the result of your earlier identical request (replayed). It may be out of date; refreshing from Core.";

// ---------------------------------------------------------------------------
// The three A2 CONFLICT messages (verbatim from sandpane-service; drift-tested)
// ---------------------------------------------------------------------------

export const IDEM_MSG_MISMATCH =
  "idempotency key was already used with different parameters; nothing was run";
export const IDEM_MSG_PENDING =
  "an operation with this idempotency key is still in progress; nothing was run";
export const IDEM_MSG_UNKNOWN =
  "the outcome of the earlier request with this idempotency key is unknown (Core restarted or sbx failed while it ran); re-read state before retrying with a new key";

export type IdempotencyConflict = "mismatch" | "pending" | "unknown";

/**
 * Which A2 CONFLICT this is, matched on Core's exact message prefix (no new
 * error code exists for them). `null` for any other error, including A1's
 * name-lock CONFLICT, which has its own copy.
 */
export function idempotencyConflictKind(err: unknown): IdempotencyConflict | null {
  if (!(err instanceof CoreRequestError) || coreErrorCode(err) !== "CONFLICT") return null;
  if (err.message.startsWith(IDEM_MSG_MISMATCH)) return "mismatch";
  if (err.message.startsWith(IDEM_MSG_PENDING)) return "pending";
  if (err.message.startsWith(IDEM_MSG_UNKNOWN)) return "unknown";
  return null;
}

export interface IdempotencyConflictCopy {
  title: string;
  action: string;
  /** False for "unknown": Core does NOT know whether the earlier request ran. */
  nothingRan: boolean;
}

export function idempotencyConflictCopy(kind: IdempotencyConflict): IdempotencyConflictCopy {
  switch (kind) {
    case "mismatch":
      return {
        title: "Nothing was run — this retry key was already used for a different request",
        action:
          "Core refused because the parameters differ from the request that first used this key. Re-read state, then start a new request if you still want it.",
        nothingRan: true,
      };
    case "pending":
      return {
        title: "Nothing was run — the earlier request with this key is still in progress",
        action: "Wait for it to finish, then re-read state. Do not start it again.",
        nothingRan: true,
      };
    case "unknown":
      return {
        title: "Outcome unknown — re-read state",
        action:
          "Core does not know whether the earlier request ran (it restarted, or sbx failed while it ran). Re-read state first; if it is still needed, a retry needs a new request.",
        nothingRan: false,
      };
  }
}

// ---------------------------------------------------------------------------
// One keyed write (a Create or a Send) and its explicit "Retry safely"
// ---------------------------------------------------------------------------

/** Exact copy when the connected Core no longer advertises keys at retry time. */
export const NOT_RETRIED_NO_KEYS =
  "Not retried: the connected Core does not advertise idempotency keys, so a retry could run it twice. Nothing was sent — check state first.";

/** Copy when Core could not be re-checked before a retry; nothing was sent. */
export const NOT_RETRIED_UNCHECKED =
  "Not retried: Core could not be re-checked, so nothing was sent. The earlier outcome is still unknown; Retry safely stays available.";

/** Result of re-reading `system.probe` right before a retry. */
export type KeyRecheck =
  | { kind: "advertised" }
  | { kind: "not-advertised" }
  /**
   * Keys are advertised, but something else the IDENTICAL params rely on is
   * not (A4: a `"discuss"` send to a Core that no longer advertises
   * `conversation-send-mode` would have `mode` silently dropped). Nothing is
   * sent; `note` says why, and Retry safely is withdrawn.
   */
  | { kind: "not-retried"; note: string }
  | { kind: "unreachable"; error: CoreRequestError };

export type KeyedWriteState<P, R> =
  | { kind: "idle" }
  | { kind: "sending"; params: P; retry: boolean }
  | { kind: "succeeded"; params: P; result: R }
  | {
      kind: "failed";
      params: P;
      /** The failure that defines the outcome (kept across a provably-unsent retry). */
      error: CoreRequestError;
      retryOffered: boolean;
      /** Secondary text: why the last Retry safely attempt sent nothing / did not reach Core. */
      note: string | null;
      noteError: CoreRequestError | null;
    };

export interface KeyedWriteOptions<P, R> {
  /**
   * Re-read `system.probe` and say whether `idempotency-keys` (and whatever
   * else these exact params rely on) is advertised NOW.
   */
  recheckKeys: (params: P) => Promise<KeyRecheck>;
  onSuccess?: (params: P, result: R) => void;
  /** After every exchange that may have reached Core (re-read state). */
  onSettled?: (params: P) => void;
}

/**
 * A retry attempt that provably never reached Core (no Core verdict, and the
 * client says the frame was not applied): the earlier unknown outcome still
 * stands, so it is kept rather than replaced.
 */
export function provablyUnsent(err: CoreRequestError): boolean {
  return !err.isCoreError && !err.mayHaveBeenApplied;
}

/**
 * The state machine behind one Create / Send surface:
 * - `submit` = a NEW user action (the caller minted its key, or none).
 * - `retrySafely` = the explicit retry: only from an unknown outcome of a
 *   KEYED request, only once at a time (a double click sends once), only
 *   after a fresh probe still advertises `idempotency-keys`, and always with
 *   the IDENTICAL params (same key). A retry that provably did not reach Core
 *   keeps the original unknown outcome (and its key) and offers retry again.
 * Nothing here ever retries by itself.
 */
export class KeyedWrite<P extends { idempotencyKey?: string }, R> {
  private state: KeyedWriteState<P, R> = { kind: "idle" };
  private readonly listeners = new Set<() => void>();
  private inFlight = false;

  constructor(
    private readonly run: (params: P) => Promise<R>,
    private readonly options: KeyedWriteOptions<P, R>,
  ) {}

  getState = (): KeyedWriteState<P, R> => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get busy(): boolean {
    return this.inFlight;
  }

  /** A new user action. Returns false (sends nothing) while one is in flight. */
  async submit(params: P): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    this.set({ kind: "sending", params, retry: false });
    try {
      await this.exchange(params, null);
    } finally {
      this.inFlight = false;
    }
    return true;
  }

  /** Explicit "Retry safely". Returns whether a request was written. */
  async retrySafely(): Promise<boolean> {
    const previous = this.state;
    if (this.inFlight || previous.kind !== "failed" || !previous.retryOffered) return false;
    this.inFlight = true; // synchronous latch: a double click sends once
    try {
      this.set({ kind: "sending", params: previous.params, retry: true });
      let check: KeyRecheck;
      try {
        check = await this.options.recheckKeys(previous.params);
      } catch (err) {
        check = { kind: "unreachable", error: asCoreError(err) };
      }
      if (check.kind === "not-advertised") {
        this.set({ ...previous, retryOffered: false, note: NOT_RETRIED_NO_KEYS, noteError: null });
        return false;
      }
      if (check.kind === "not-retried") {
        this.set({ ...previous, retryOffered: false, note: check.note, noteError: null });
        return false;
      }
      if (check.kind === "unreachable") {
        this.set({ ...previous, note: NOT_RETRIED_UNCHECKED, noteError: check.error });
        return false;
      }
      await this.exchange(previous.params, previous);
      return true;
    } finally {
      this.inFlight = false;
    }
  }

  /** Forget the outcome (e.g. the user dismissed it). Not allowed mid-flight. */
  reset(): void {
    if (this.inFlight) return;
    this.set({ kind: "idle" });
  }

  private async exchange(
    params: P,
    previous: Extract<KeyedWriteState<P, R>, { kind: "failed" }> | null,
  ): Promise<void> {
    try {
      const result = await this.run(params);
      this.set({ kind: "succeeded", params, result });
      this.options.onSuccess?.(params, result);
      this.options.onSettled?.(params);
    } catch (err) {
      const error = asCoreError(err);
      if (previous !== null && provablyUnsent(error)) {
        // The retry never reached Core: the ORIGINAL unknown outcome stands.
        this.set({
          ...previous,
          note: "The retry did not reach Core, so nothing was sent; the earlier outcome is still unknown.",
          noteError: error,
        });
        return;
      }
      this.set({
        kind: "failed",
        params,
        error,
        retryOffered: retrySafelyOffered(error, params),
        note: null,
        noteError: null,
      });
      this.options.onSettled?.(params);
    }
  }

  private set(next: KeyedWriteState<P, R>): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

function asCoreError(err: unknown): CoreRequestError {
  return err instanceof CoreRequestError
    ? err
    : new CoreRequestError("client", "TRANSPORT_UNAVAILABLE", err instanceof Error ? err.message : String(err));
}

/** `KeyRecheck` from a `system.probe` outcome. */
export function keyRecheckFromProbe(outcome: ProbeOutcome): KeyRecheck {
  if (outcome.kind === "attached") {
    return idempotencyKeysAdvertised(outcome.capabilities)
      ? { kind: "advertised" }
      : { kind: "not-advertised" };
  }
  if (outcome.kind === "version_mismatch") return { kind: "not-advertised" };
  return { kind: "unreachable", error: outcome.error };
}
