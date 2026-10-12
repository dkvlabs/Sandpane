/**
 * A9 maintenance on the desktop: `maintenance.inventory` and the two-step,
 * token-confirmed `maintenance.cleanup` (design 2026-10-09 §3.9).
 *
 * Pure logic only (no React, no DOM), so the node-only vitest suites can prove
 * the behaviour that matters: what is sent, when, how often, and what the copy
 * claims. Core stays the authority on every outcome — nothing here decides an
 * item is removable; it only renders what Core said and never sends step 2
 * without a fresh user gesture.
 */

import {
  CoreRequestError,
  asCoreRequestError,
  coreErrorCode,
  type CoreClient,
} from "./core-client";
import {
  FEATURE_MAINTENANCE,
  MAINTENANCE_KINDS,
  MAINTENANCE_METHODS,
  coreAdvertisesFeature,
  coreAdvertisesMethod,
  type CoreCapabilities,
  type MaintenanceCleanupResult,
  type MaintenanceConfirmation,
  type MaintenanceInventoryResult,
  type MaintenanceItem,
  type MaintenanceSkipped,
} from "./protocol";
import { describeCoreError, displayRevealed, featureGate, type FeatureGate } from "./reducers";
import { isExpired, parseExpiry } from "./sandbox-lifecycle";

// ---------------------------------------------------------------------------
// Gating on `system.probe`
// ---------------------------------------------------------------------------

/**
 * Whether the Maintenance view is usable against THIS Core: the `maintenance`
 * feature AND both methods advertised. `null` capabilities = not probed yet
 * (disabled as pending, never as unsupported).
 */
export function maintenanceGate(
  capabilities: Pick<CoreCapabilities, "methods" | "features"> | null,
): FeatureGate {
  if (capabilities === null) {
    return featureGate(null, "`maintenance.inventory`", "");
  }
  const feature = coreAdvertisesFeature(capabilities, FEATURE_MAINTENANCE);
  const methods = MAINTENANCE_METHODS.every((m) => coreAdvertisesMethod(capabilities, m));
  if (feature && methods) {
    return featureGate(
      true,
      "`maintenance.inventory`",
      "This Core does not advertise maintenance, so cleanup is not supported by this Core. Upgrade Core to clean up from Sandpane.",
    );
  }
  return featureGate(
    false,
    "`maintenance.inventory`",
    "This Core does not advertise maintenance, so cleanup is not supported by this Core. Upgrade Core to clean up from Sandpane.",
  );
}

// ---------------------------------------------------------------------------
// Selection defaults (§3.9 item 7.3)
// ---------------------------------------------------------------------------

/**
 * Whether an item's checkbox starts checked: only removable items of a KNOWN
 * kind other than `dbBackup` (backups are the way back to an older Core, so
 * they stay unchecked until the user opts in). Unknown kinds render unchecked
 * with Core's `detail`.
 */
export function defaultChecked(item: MaintenanceItem): boolean {
  return (
    item.removable &&
    item.kind !== "dbBackup" &&
    (MAINTENANCE_KINDS as readonly string[]).includes(item.kind)
  );
}

/** The pre-checked ids of a fresh inventory. */
export function defaultSelection(items: readonly MaintenanceItem[]): Set<string> {
  return new Set(items.filter(defaultChecked).map((item) => item.id));
}

// ---------------------------------------------------------------------------
// Grouping and display text (untrusted strings are revealed, never executed)
// ---------------------------------------------------------------------------

export const KIND_LABELS: Readonly<Record<string, string>> = {
  temp: "Core temporary directories",
  dbBackup: "Database migration backups",
  verificationOutput: "Stored verification output",
  worktree: "Worktrees (report-only)",
};

/** Code points shown of an unknown `kind` before the cut is disclosed. */
const KIND_CHARS = 80;
/** Code points shown per detail/reason/note line. */
const LINE_CHARS = 500;
/** Impact lines shown before the overflow line. */
const MAX_IMPACT_LINES = 20;

export function kindLabel(kind: string): string {
  const known = KIND_LABELS[kind];
  return known ?? `Other (${displayRevealed(kind, KIND_CHARS).text}) — unchecked`;
}

export interface MaintenanceGroup {
  kind: string;
  label: string;
  items: MaintenanceItem[];
}

/** Items grouped by `kind`, known kinds first in `MAINTENANCE_KINDS` order. */
export function groupMaintenanceItems(items: readonly MaintenanceItem[]): MaintenanceGroup[] {
  const byKind = new Map<string, MaintenanceItem[]>();
  for (const item of items) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }
  const order = (kind: string): number => {
    const index = (MAINTENANCE_KINDS as readonly string[]).indexOf(kind);
    return index === -1 ? MAINTENANCE_KINDS.length : index;
  };
  return [...byKind.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([kind, grouped]) => ({ kind, label: kindLabel(kind), items: grouped }));
}

/** Binary-prefixed bytes; the exact number stays available to the UI. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

/** One item's size line, or `null` when Core did not measure it. */
export function itemSizeText(item: MaintenanceItem): string | null {
  if (item.bytes === undefined) return null;
  if (item.sizeIncomplete === true) return `${formatBytes(item.bytes)} (incomplete measurement)`;
  return formatBytes(item.bytes);
}

// ---------------------------------------------------------------------------
// Confirmation view (§2 pattern; untrusted impact lines revealed as text)
// ---------------------------------------------------------------------------

export interface MaintenanceConfirmationView {
  impactLines: string[];
  overflowLine: string | null;
  /** Parsed expiry, or `null` when unparseable (treated as expired). */
  expiresAtMs: number | null;
  expired: boolean;
  /** Whole seconds left (0 once expired). */
  secondsLeft: number;
  /** True when any shown text had hidden/control characters revealed as escapes. */
  revealedHiddenCharacters: boolean;
}

export function maintenanceConfirmationView(
  confirmation: MaintenanceConfirmation,
  nowMs: number,
): MaintenanceConfirmationView {
  let revealed = false;
  const reveal = (value: string, max: number): string => {
    const shown = displayRevealed(value, max);
    if (shown.unusual) revealed = true;
    return shown.text;
  };
  const impactLines = confirmation.impact
    .slice(0, MAX_IMPACT_LINES)
    .map((line) => reveal(line, LINE_CHARS));
  const hidden = confirmation.impact.length - MAX_IMPACT_LINES;
  const expiresAtMs = parseExpiry(confirmation.expiresAt);
  const expired = isExpired(expiresAtMs, nowMs);
  return {
    impactLines,
    overflowLine:
      hidden > 0
        ? `…and ${hidden} more impact line${hidden === 1 ? "" : "s"} from Core, not shown here.`
        : null,
    expiresAtMs,
    expired,
    secondsLeft:
      expired || expiresAtMs === null ? 0 : Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000)),
    revealedHiddenCharacters: revealed,
  };
}

// ---------------------------------------------------------------------------
// Step-2 outcome view (honesty: never "everything was cleaned")
// ---------------------------------------------------------------------------

export interface CleanupOutcomeView {
  /** `removed.length` of the confirmed count — never "all clean" when skipped. */
  headline: string;
  freedText: string | null;
  skippedLines: string[];
  noteLines: string[];
}

export function cleanupOutcomeView(
  result: Pick<MaintenanceCleanupResult, "removed" | "skipped" | "freedBytes" | "notes">,
  confirmedCount: number,
): CleanupOutcomeView {
  const removed = result.removed ?? [];
  const skipped = result.skipped ?? [];
  const removedText =
    confirmedCount > 0 && removed.length === confirmedCount && skipped.length === 0
      ? `Removed all ${confirmedCount} confirmed item${confirmedCount === 1 ? "" : "s"}.`
      : `Removed ${removed.length} of ${confirmedCount} confirmed item${
          confirmedCount === 1 ? "" : "s"
        }${skipped.length > 0 ? `; ${skipped.length} were not removed` : ""}.`;
  return {
    headline: removedText,
    freedText:
      result.freedBytes === undefined
        ? null
        : `${formatBytes(result.freedBytes)} of files were removed (verification output does not count)`,
    skippedLines: skipped.map(
      (s: MaintenanceSkipped) =>
        `${displayRevealed(s.id, 200).text}: ${displayRevealed(s.reason, LINE_CHARS).text}`,
    ),
    noteLines: (result.notes ?? []).map((n) => displayRevealed(n, LINE_CHARS).text),
  };
}

// ---------------------------------------------------------------------------
// Failure copy
// ---------------------------------------------------------------------------

export interface MaintenanceFailureCopy {
  title: string;
  body: string;
  action: string;
  /** Core's own message, revealed and capped, when the copy interprets a code. */
  coreMessage?: string;
}

/** Code points of Core's own message shown beside interpreted copy. */
const MAX_CORE_MESSAGE_CHARS = 300;

/** Cross-client copy for a CONFLICT from either maintenance method. */
export const CONFLICT_COPY: MaintenanceFailureCopy = {
  title: "Another maintenance scan or cleanup is running",
  body: "Core refused because another maintenance scan or cleanup is running; nothing was changed.",
  action: "Try again shortly.",
};

/** Cross-client copy for a lost step-2 answer (client brief, §9 step 2). */
export const LOST_STEP2_TITLE = "Some items may have been removed — scan again";

function coreMessageOf(error: CoreRequestError): string {
  return displayRevealed(error.message, MAX_CORE_MESSAGE_CHARS).text;
}

/** Scan failures: CONFLICT gets the busy copy; everything else Core's text. */
export function scanFailureCopy(err: unknown): MaintenanceFailureCopy {
  const error = asCoreRequestError(err);
  if (coreErrorCode(error) === "CONFLICT") return { ...CONFLICT_COPY, coreMessage: coreMessageOf(error) };
  const copy = describeCoreError(error);
  return { title: copy.title, body: copy.reason, action: copy.action };
}

/**
 * Step-1 failures: nothing was changed (Core refuses before issuing a token),
 * so the copy may say so — except CONFLICT, which is the busy case.
 */
export function step1FailureCopy(err: unknown): MaintenanceFailureCopy {
  const error = asCoreRequestError(err);
  const code = coreErrorCode(error);
  if (code === "CONFLICT") return { ...CONFLICT_COPY, coreMessage: coreMessageOf(error) };
  if (code === "VALIDATION_FAILED") {
    return {
      title: "Confirmation refused — nothing was changed",
      body: "Core refused the cleanup before issuing a confirmation: an item is no longer in Core's inventory, or is not removable. Core's message names the item.",
      action: "Scan again and re-select the items.",
      coreMessage: coreMessageOf(error),
    };
  }
  const copy = describeCoreError(error);
  return { title: `Could not prepare the cleanup — ${copy.title}`, body: copy.reason, action: copy.action };
}

/**
 * Step-2 failures. A lost answer (the request reached Core) and a token
 * refusal both read "some items may have been removed — scan again": the
 * client cannot tell an expired token from one a lost earlier attempt already
 * consumed (design §3.9 item 7), so it never claims "nothing was removed".
 */
export function step2FailureCopy(err: unknown): MaintenanceFailureCopy {
  const error = asCoreRequestError(err);
  const code = coreErrorCode(error);
  if (code === "CONFLICT") return { ...CONFLICT_COPY, coreMessage: coreMessageOf(error) };
  if (error.mayHaveBeenApplied) {
    return {
      title: LOST_STEP2_TITLE,
      body: "The cleanup was already handed to Core, so it may have been applied — some items may have been removed.",
      action: "Scan again to see what remains.",
      coreMessage: coreMessageOf(error),
    };
  }
  if (code === "VALIDATION_FAILED") {
    return {
      title: LOST_STEP2_TITLE,
      body: "Core refused the confirmation token (expired, already used, or not matching the item set). If an earlier attempt's answer was lost, Core may already have removed some items.",
      action: "Scan again to see what remains.",
      coreMessage: coreMessageOf(error),
    };
  }
  const copy = describeCoreError(error);
  return { title: `Cleanup failed — ${copy.title}`, body: copy.reason, action: copy.action };
}

// ---------------------------------------------------------------------------
// The flow controller
// ---------------------------------------------------------------------------

/** The three Core calls the flow needs (a `CoreClient` satisfies it). */
export type MaintenanceRpc = Pick<
  CoreClient,
  "maintenanceInventory" | "requestMaintenanceCleanup" | "confirmMaintenanceCleanup"
>;

/** The step-2 answer the flow keeps (the confirmation is never re-exported). */
export type CleanupOutcome = Omit<MaintenanceCleanupResult, "confirmation">;

export type MaintenanceState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "ready"; inventory: MaintenanceInventoryResult }
  | { kind: "preparing"; items: string[] }
  | { kind: "confirming"; items: string[]; confirmation: MaintenanceConfirmation }
  | { kind: "cleaning"; items: string[] };

/** What the UI shows beside the state after a cleanup attempt settles. */
export type CleanupSettled =
  | { kind: "done"; outcome: CleanupOutcome; confirmedCount: number }
  | { kind: "failed"; copy: MaintenanceFailureCopy; error: CoreRequestError | null };

export interface MaintenanceFlowOptions {
  now?: () => number;
}

/**
 * The maintenance flow, single-flight and token-safe:
 *
 * - `scan` runs the inventory on a gesture and is ignored while any step is
 *   in flight. After a cleanup settles (either way) the flow re-scans
 *   automatically — the last outcome stays visible in `settled` while the
 *   fresh scan runs (§3.9 item 7.5).
 * - `beginCleanup` sends step 1 (`{ items }` only) from `ready`; nothing
 *   changes in Core. `cancel` drops the token unseen.
 * - `confirm` spends the token exactly once: the state moves to `cleaning`
 *   synchronously BEFORE the request is written, so a double click cannot send
 *   twice. An expired (or unreadable) expiry sends nothing. Step 2 is never
 *   auto-retried; a failed cleanup needs a fresh step 1 on a new gesture.
 * - The token lives only in the `confirming` state. It is never logged,
 *   persisted or put into error text.
 */
export class MaintenanceFlow {
  private state: MaintenanceState = { kind: "idle" };
  private settled: CleanupSettled | null = null;
  private readonly listeners = new Set<() => void>();
  /** Bumped by `cancel`/`reset`, so a late step-1 answer is discarded. */
  private generation = 0;
  private readonly now: () => number;

  constructor(
    private readonly rpc: MaintenanceRpc,
    options: MaintenanceFlowOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  getState = (): MaintenanceState => this.state;

  /** The last cleanup outcome (survives scans; cleared by `beginCleanup`). */
  getSettled = (): CleanupSettled | null => this.settled;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get busy(): boolean {
    return (
      this.state.kind === "scanning" ||
      this.state.kind === "preparing" ||
      this.state.kind === "cleaning"
    );
  }

  /** The inventory of the last `ready` state (for re-selecting after cleanup). */
  get inventory(): MaintenanceInventoryResult | null {
    return this.state.kind === "ready" ? this.state.inventory : null;
  }

  /** Scan on a gesture. Ignored while any step is in flight. */
  async scan(): Promise<void> {
    if (this.busy || this.state.kind === "confirming") return;
    const generation = ++this.generation;
    this.set({ kind: "scanning" });
    try {
      const inventory = await this.rpc.maintenanceInventory();
      if (generation !== this.generation) return;
      this.set({ kind: "ready", inventory });
    } catch (err) {
      if (generation !== this.generation) return;
      this.set({ kind: "idle" });
      // A failed (re-)scan never erases a cleanup outcome: the UI shows this
      // copy beside whatever `settled` still holds.
      this.failQuietly(err);
    }
  }

  /**
   * Step 1 on a gesture, from `ready` only. The items are Core-assigned ids
   * the UI read from the inventory this state holds.
   */
  async beginCleanup(items: readonly string[]): Promise<void> {
    if (this.busy || this.state.kind !== "ready") return;
    if (items.length === 0) return;
    const generation = ++this.generation;
    const ids = [...items];
    this.set({ kind: "preparing", items: ids });
    try {
      const confirmation = await this.rpc.requestMaintenanceCleanup(ids);
      if (generation !== this.generation) return; // cancelled: drop the token unseen
      this.settled = null;
      this.set({ kind: "confirming", items: ids, confirmation });
    } catch (err) {
      if (generation !== this.generation) return;
      this.settled = { kind: "failed", copy: step1FailureCopy(err), error: asCoreRequestError(err) };
      this.set({ kind: "idle" });
    }
  }

  /** Cancel the confirmation. Sends NOTHING; the token is dropped. */
  cancel(): void {
    if (this.state.kind === "cleaning" || this.state.kind === "scanning") return;
    this.generation += 1;
    this.set({ kind: "idle" });
  }

  /** Clear the settled outcome panel. Sends nothing. */
  dismiss(): void {
    this.settled = null;
    // A new state object so subscribers re-render and the panel goes away.
    this.set({ ...this.state });
  }

  /**
   * Step 2. Sends `{ items, confirmToken }` once, only from `confirming`,
   * only before expiry. Returns whether a request was written.
   */
  confirm(): boolean {
    const state = this.state;
    if (state.kind !== "confirming") return false;
    const { items, confirmation } = state;
    if (isExpired(parseExpiry(confirmation.expiresAt), this.now())) {
      this.settled = {
        kind: "failed",
        error: null,
        copy: {
          title: "Confirmation expired — nothing was sent",
          body: "Core's confirmation is only valid until its expiry time, so this desktop did not send it.",
          action: "Start the cleanup again if you still want to remove the items.",
        },
      };
      this.set({ kind: "idle" });
      return false;
    }
    // Spend the token: from here on only the in-flight request holds it.
    this.set({ kind: "cleaning", items });
    void this.rpc
      .confirmMaintenanceCleanup(items, confirmation.token)
      .then(
        (outcome) => {
          this.settled = { kind: "done", outcome, confirmedCount: items.length };
          this.set({ kind: "idle" });
        },
        (err: unknown) => {
          this.settled = {
            kind: "failed",
            copy: step2FailureCopy(err),
            error: asCoreRequestError(err),
          };
          this.set({ kind: "idle" });
        },
      )
      .finally(() => {
        // §3.9 item 7.5: always re-scan after step 2, whatever happened. The
        // settled outcome above stays visible while the fresh scan runs.
        void this.scan();
      });
    return true;
  }

  /** Scan failures set no `state` (the previous view stays); the UI shows copy. */
  private failQuietly(err: unknown): void {
    this.scanCopy = scanFailureCopy(err);
    this.emit();
  }

  private scanCopy: MaintenanceFailureCopy | null = null;

  /** The last scan failure, if the last scan failed (cleared by a good scan). */
  get scanError(): MaintenanceFailureCopy | null {
    return this.scanCopy;
  }

  private set(next: MaintenanceState): void {
    this.state = next;
    if (next.kind === "ready") this.scanCopy = null;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
