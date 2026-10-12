/**
 * Pure helpers for A9 (maintenance inventory + token-confirmed cleanup, design
 * 2026-10-09 §3.9). No `vscode` import.
 *
 * The flow (wired in `session.ts`) runs only from a user gesture: a command or
 * a webview button. Step 2 is never called without a fresh gesture and is
 * never retried; the view always re-scans after it settles.
 *
 * Rendering rules: every item field, impact line, skipped reason and note is
 * UNTRUSTED Core text, shown as plain text with hidden characters escaped
 * (`plainText`). Worktree paths are copyable display values, never executed.
 */

import {
  isCoreMethodName,
  MAINTENANCE_KINDS,
  type CoreCapabilities,
  type MaintenanceCleanupResult,
  type MaintenanceConfirmation,
  type MaintenanceInventoryResult,
  type MaintenanceItem,
} from '../core-client/protocol';
import { plainText } from '../text/visibleText';

/** The two A9 method names (in `Method::ALL` order). */
export const MAINTENANCE_METHOD_NAMES = ['maintenance.inventory', 'maintenance.cleanup'] as const;

/**
 * Whether the Maintenance flow is usable against THIS Core: the `maintenance`
 * feature AND both methods advertised. `null` capabilities = not probed.
 */
export function maintenanceAdvertised(
  capabilities: Pick<CoreCapabilities, 'methods' | 'features'> | null | undefined,
): boolean | null {
  if (capabilities === null || capabilities === undefined) return null;
  const feature = Array.isArray(capabilities.features) && capabilities.features.includes('maintenance');
  const methods = MAINTENANCE_METHOD_NAMES.every(
    (m) => isCoreMethodName(m) && Array.isArray(capabilities.methods) && capabilities.methods.includes(m),
  );
  return feature === true && methods === true;
}

// ---------------------------------------------------------------------------
// Parsing (shape checks; anything else is malformed, never guessed)
// ---------------------------------------------------------------------------

function parseMaintenanceItem(raw: unknown): MaintenanceItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || typeof r['kind'] !== 'string' || typeof r['removable'] !== 'boolean') return null;
  if (typeof r['detail'] !== 'string') return null;
  const opt = (key: string, type: 'number' | 'string' | 'boolean'): boolean =>
    r[key] === undefined || r[key] === null || typeof r[key] === type;
  if (!opt('bytes', 'number') || !opt('sizeIncomplete', 'boolean') || !opt('createdAt', 'string')) return null;
  if (!opt('reason', 'string') || !opt('path', 'string') || !opt('repositoryPath', 'string')) return null;
  return {
    id: r['id'],
    kind: r['kind'],
    removable: r['removable'],
    detail: r['detail'],
    ...(typeof r['bytes'] === 'number' ? { bytes: r['bytes'] } : {}),
    ...(r['sizeIncomplete'] === true ? { sizeIncomplete: true } : {}),
    ...(typeof r['createdAt'] === 'string' ? { createdAt: r['createdAt'] } : {}),
    ...(typeof r['reason'] === 'string' ? { reason: r['reason'] } : {}),
    ...(typeof r['path'] === 'string' ? { path: r['path'] } : {}),
    ...(typeof r['repositoryPath'] === 'string' ? { repositoryPath: r['repositoryPath'] } : {}),
  };
}

/** `maintenance.inventory` answer → the documented shape, or null. */
export function parseMaintenanceInventory(raw: unknown): MaintenanceInventoryResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r['items']) || typeof r['truncated'] !== 'boolean') return null;
  const items = r['items'].map(parseMaintenanceItem);
  if (items.some((i) => i === null)) return null;
  let unavailable: MaintenanceInventoryResult['unavailable'];
  if (r['unavailable'] !== undefined) {
    if (!Array.isArray(r['unavailable'])) return null;
    const parsed = r['unavailable'].map((u): { kind: string; reason: string } | null => {
      if (typeof u !== 'object' || u === null) return null;
      const rec = u as Record<string, unknown>;
      return typeof rec['kind'] === 'string' && typeof rec['reason'] === 'string'
        ? { kind: rec['kind'], reason: rec['reason'] }
        : null;
    });
    if (parsed.some((p) => p === null)) return null;
    unavailable = parsed as { kind: string; reason: string }[];
  }
  return { items: items as MaintenanceItem[], truncated: r['truncated'], ...(unavailable !== undefined ? { unavailable } : {}) };
}

function parseMaintenanceConfirmation(raw: unknown): MaintenanceConfirmation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const t = r['target'];
  if (typeof t !== 'object' || t === null || !Array.isArray((t as Record<string, unknown>)['items'])) return null;
  const targetItems = (t as Record<string, unknown>)['items'] as unknown[];
  if (targetItems.some((i) => typeof i !== 'string')) return null;
  if (typeof r['token'] !== 'string' || typeof r['expiresAt'] !== 'string') return null;
  if (typeof r['action'] !== 'string' || typeof r['external'] !== 'boolean') return null;
  if (!Array.isArray(r['impact']) || r['impact'].some((l) => typeof l !== 'string')) return null;
  return {
    token: r['token'],
    expiresAt: r['expiresAt'],
    action: r['action'],
    target: { items: targetItems as string[] },
    impact: r['impact'] as string[],
    external: r['external'],
  };
}

/**
 * `maintenance.cleanup` answer → step 1 (`confirmation`) or step 2
 * (`removed` + `skipped`); a mix or a half-answer is malformed, never a
 * guessed outcome.
 */
export function parseMaintenanceCleanup(raw: unknown): MaintenanceCleanupResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const hasConfirmation = r['confirmation'] !== undefined;
  const hasOutcome = r['removed'] !== undefined || r['skipped'] !== undefined;
  if (hasConfirmation === hasOutcome) return null;
  if (hasConfirmation) {
    const confirmation = parseMaintenanceConfirmation(r['confirmation']);
    return confirmation === null ? null : { confirmation };
  }
  if (!Array.isArray(r['removed']) || !Array.isArray(r['skipped'])) return null;
  if (r['removed'].some((i) => typeof i !== 'string')) return null;
  const skipped = r['skipped'].map((s): { id: string; reason: string } | null => {
    if (typeof s !== 'object' || s === null) return null;
    const rec = s as Record<string, unknown>;
    return typeof rec['id'] === 'string' && typeof rec['reason'] === 'string'
      ? { id: rec['id'], reason: rec['reason'] }
      : null;
  });
  if (skipped.some((s) => s === null)) return null;
  if (r['freedBytes'] !== undefined && typeof r['freedBytes'] !== 'number') return null;
  if (r['notes'] !== undefined && (!Array.isArray(r['notes']) || r['notes'].some((n) => typeof n !== 'string'))) return null;
  return {
    removed: r['removed'] as string[],
    skipped: skipped as { id: string; reason: string }[],
    ...(typeof r['freedBytes'] === 'number' ? { freedBytes: r['freedBytes'] } : {}),
    ...(Array.isArray(r['notes']) ? { notes: r['notes'] as string[] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Selection defaults (§3.9 item 7.3)
// ---------------------------------------------------------------------------

/**
 * Whether an item's checkbox starts checked: only removable items of a KNOWN
 * kind other than `dbBackup` (backups are the way back to an older Core).
 * Unknown kinds are unchecked and show Core's `detail`.
 */
export function defaultChecked(item: MaintenanceItem): boolean {
  return (
    item.removable &&
    item.kind !== 'dbBackup' &&
    (MAINTENANCE_KINDS as readonly string[]).includes(item.kind)
  );
}

// ---------------------------------------------------------------------------
// Copy (cross-client wording; plain text only)
// ---------------------------------------------------------------------------

/** Cross-client copy for a CONFLICT from either maintenance method. */
export const MAINTENANCE_CONFLICT_TITLE = 'Another maintenance scan or cleanup is running; try again shortly';

/** Cross-client copy for a lost step-2 answer (client brief, §9 step 2). */
export const LOST_STEP2_TITLE = 'Some items may have been removed — scan again';

/** `kind` label for the grouped list; an unknown kind keeps its raw text. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case 'temp':
      return 'Core temporary directories';
    case 'dbBackup':
      return 'Database migration backups';
    case 'verificationOutput':
      return 'Stored verification output';
    case 'worktree':
      return 'Worktrees (report-only)';
    default:
      return `Other (${plainText(kind, 80)})`;
  }
}

/** Binary-prefixed size, or null when Core did not measure one. */
export function itemSizeText(item: MaintenanceItem): string | null {
  if (item.bytes === undefined) return null;
  const bytes = item.bytes;
  let value = bytes;
  let unit = 'B';
  for (const next of ['KiB', 'MiB', 'GiB', 'TiB']) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  const text = bytes < 1024
    ? `${bytes} B`
    : `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
  return item.sizeIncomplete === true ? `${text} (incomplete measurement)` : text;
}

/** One QuickPick line per item: id + size + reason, all as plain text. */
export function itemPickLine(item: MaintenanceItem): string {
  const size = itemSizeText(item);
  return [
    plainText(item.id, 300),
    size === null ? null : size,
    item.removable ? null : plainText(item.reason ?? 'report-only', 300),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/**
 * Step-2 outcome copy. Never "everything was cleaned" when something was
 * skipped; freed bytes are file-system removals only.
 */
export function maintenanceOutcomeCopy(result: Pick<MaintenanceCleanupResult, 'removed' | 'skipped' | 'freedBytes' | 'notes'>, confirmedCount: number): {
  headline: string;
  skippedLines: string[];
  noteLines: string[];
} {
  const removed = result.removed ?? [];
  const skipped = result.skipped ?? [];
  const headline =
    confirmedCount > 0 && removed.length === confirmedCount && skipped.length === 0
      ? `Removed all ${confirmedCount} confirmed item${confirmedCount === 1 ? '' : 's'}.`
      : `Removed ${removed.length} of ${confirmedCount} confirmed item${confirmedCount === 1 ? '' : 's'}${skipped.length > 0 ? `; ${skipped.length} were not removed` : ''}.`;
  return {
    headline,
    skippedLines: skipped.map((s) => `${plainText(s.id, 200)}: ${plainText(s.reason, 300)}`),
    noteLines: (result.notes ?? []).map((n) => plainText(n, 300)),
  };
}
