/**
 * A9 maintenance (design 2026-10-09 §3.9) in the VS Code client: the pure
 * helpers (gating, parsing, selection defaults, copy), the command wrappers'
 * guard behaviour, and the webview bridge's `maintenanceScan` message.
 */

import { describe, expect, it } from 'vitest';
import {
  LOST_STEP2_TITLE,
  MAINTENANCE_CONFLICT_TITLE,
  MAINTENANCE_METHOD_NAMES,
  defaultChecked,
  itemPickLine,
  itemSizeText,
  kindLabel,
  maintenanceAdvertised,
  maintenanceOutcomeCopy,
  parseMaintenanceCleanup,
  parseMaintenanceInventory,
} from '../src/vscode/maintenance';
import {
  MAINTENANCE_TIMEOUT_MS,
  MAX_CLEANUP_ITEMS,
  CoreCommands,
  CoreValidationError,
} from '../src/core-client/commands';
import {
  CORE_METHODS,
  KNOWN_FEATURES,
  MAINTENANCE_KINDS,
  type MaintenanceItem,
} from '../src/core-client/protocol';
import { parseWebviewMessage, WEBVIEW_MESSAGE_KINDS } from '../src/webview/bridge';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tempItem: MaintenanceItem = {
  id: 'temp:0b2a2c56-1111-4222-8333-444455556666',
  kind: 'temp',
  removable: true,
  detail: 'Core temporary directory 0b2a2c56-…',
};
const backupItem: MaintenanceItem = {
  id: 'dbBackup:core.sqlite3.pre-v8.bak',
  kind: 'dbBackup',
  removable: true,
  bytes: 2048,
  detail: 'migration backup taken before schema v8',
};
const outputItem: MaintenanceItem = {
  id: 'verificationOutput:2026-09-01T00:00:00Z',
  kind: 'verificationOutput',
  removable: true,
  bytes: 512,
  detail: 'stored output of 3 verification runs',
};
const worktreeItem: MaintenanceItem = {
  id: 'worktree:task-1',
  kind: 'worktree',
  removable: false,
  detail: 'worktree of a finished task',
  reason: 'removal waits for W-D: Sandpane cannot remove worktrees yet',
  path: '/x/worktrees/task-1',
  repositoryPath: '/repos/demo',
};

describe('A9 maintenance gating', () => {
  it('needs the feature AND both methods; null capabilities = not probed', () => {
    expect(maintenanceAdvertised(null)).toBeNull();
    expect(maintenanceAdvertised(undefined)).toBeNull();
    const base = { methods: [...CORE_METHODS], features: [...KNOWN_FEATURES] };
    expect(maintenanceAdvertised(base)).toBe(true);
    expect(maintenanceAdvertised({ ...base, features: KNOWN_FEATURES.filter((f) => f !== 'maintenance') })).toBe(false);
    expect(maintenanceAdvertised({ ...base, methods: CORE_METHODS.filter((m) => m !== 'maintenance.cleanup') })).toBe(false);
  });

  it('the two methods are the last two of the allowlist', () => {
    expect(MAINTENANCE_METHOD_NAMES).toEqual(['maintenance.inventory', 'maintenance.cleanup']);
    expect(CORE_METHODS.slice(-2)).toEqual([...MAINTENANCE_METHOD_NAMES]);
  });
});

describe('A9 selection defaults (§3.9 item 7.3)', () => {
  it('checks removable temp and verificationOutput only', () => {
    expect(defaultChecked(tempItem)).toBe(true);
    expect(defaultChecked(outputItem)).toBe(true);
    expect(defaultChecked(backupItem)).toBe(false); // the way back to an older Core
    expect(defaultChecked(worktreeItem)).toBe(false);
    expect(defaultChecked({ ...tempItem, kind: 'futureKind' })).toBe(false); // unknown kind
  });
});

describe('A9 parsing', () => {
  it('parses an inventory and keeps optional fields absent', () => {
    const inv = parseMaintenanceInventory({
      items: [{ id: tempItem.id, kind: 'temp', removable: true, detail: 'd' }],
      truncated: false,
    });
    expect(inv).toEqual({ items: [{ id: tempItem.id, kind: 'temp', removable: true, detail: 'd' }], truncated: false });
    expect(inv?.unavailable).toBeUndefined();
    expect(
      parseMaintenanceInventory({ items: [], truncated: true, unavailable: [{ kind: 'temp', reason: 'no data directory' }] })
        ?.unavailable,
    ).toEqual([{ kind: 'temp', reason: 'no data directory' }]);
    // Missing required fields, wrong types, half items: all malformed.
    expect(parseMaintenanceInventory({ items: [{ id: 'x' }], truncated: false })).toBeNull();
    expect(parseMaintenanceInventory({ items: [], truncated: 'no' })).toBeNull();
    expect(parseMaintenanceInventory(null)).toBeNull();
  });

  it('parses step 1 and step 2 answers and refuses mixes', () => {
    const confirmation = {
      token: 'a'.repeat(64),
      expiresAt: '2100-01-01T00:00:00Z',
      action: 'maintenance.cleanup',
      target: { items: [tempItem.id] },
      impact: ['1 item'],
      external: false,
    };
    expect(parseMaintenanceCleanup({ confirmation })).toEqual({ confirmation });
    const outcome = {
      removed: [tempItem.id],
      skipped: [{ id: backupItem.id, reason: 'changed since you confirmed' }],
      notes: ['temporary directory sizes are not measured'],
    };
    expect(parseMaintenanceCleanup(outcome)).toEqual(outcome);
    expect(parseMaintenanceCleanup({ ...outcome, confirmation })).toBeNull();
    expect(parseMaintenanceCleanup({ removed: [tempItem.id] })).toBeNull();
    expect(parseMaintenanceCleanup({})).toBeNull();
  });
});

describe('A9 copy (honesty)', () => {
  it('never says all-clean when something was skipped', () => {
    const partial = maintenanceOutcomeCopy(
      { removed: ['a'], skipped: [{ id: 'b', reason: 'no longer present' }] },
      2,
    );
    expect(partial.headline).toBe('Removed 1 of 2 confirmed items; 1 were not removed.');
    expect(partial.skippedLines).toEqual(['b: no longer present']);
    const all = maintenanceOutcomeCopy({ removed: ['a', 'b'], skipped: [] }, 2);
    expect(all.headline).toBe('Removed all 2 confirmed items.');
  });

  it('exposes the cross-client CONFLICT and lost-answer copy', () => {
    expect(MAINTENANCE_CONFLICT_TITLE).toBe('Another maintenance scan or cleanup is running; try again shortly');
    expect(LOST_STEP2_TITLE).toBe('Some items may have been removed — scan again');
  });

  it('labels kinds and sizes for the pick list', () => {
    expect(kindLabel('worktree')).toContain('report-only');
    expect(kindLabel('futureKind')).toContain('futureKind');
    expect(itemSizeText(tempItem)).toBeNull();
    expect(itemSizeText(backupItem)).toBe('2 KiB');
    expect(itemPickLine(worktreeItem)).toContain('removal waits for W-D');
  });
});

describe('A9 command wrappers guard before sending', () => {
  it('refuses empty, duplicate and oversized item lists locally', async () => {
    const commands = new CoreCommands({ request: () => Promise.resolve({}) } as never);
    await expect(commands.maintenanceCleanupRequest([])).rejects.toThrow(CoreValidationError);
    await expect(commands.maintenanceCleanupRequest(['a', 'a'])).rejects.toThrow(CoreValidationError);
    const many = Array.from({ length: MAX_CLEANUP_ITEMS + 1 }, (_, i) => `temp:${i}`);
    await expect(commands.maintenanceCleanupRequest(many)).rejects.toThrow(CoreValidationError);
    // The token shape is enforced locally and never appears in the refusal.
    await expect(commands.maintenanceCleanupConfirm(['a'], 'nope')).rejects.toThrow(CoreValidationError);
  });

  it('both steps use the 35 s maintenance deadline (≥ 20 s, above Core scan budget)', () => {
    expect(MAINTENANCE_TIMEOUT_MS).toBe(35_000);
    expect(MAINTENANCE_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });
});

describe('A9 webview bridge', () => {
  it('maintenanceScan is a whitelisted kind and parses without any payload', () => {
    expect(WEBVIEW_MESSAGE_KINDS).toContain('maintenanceScan');
    expect(parseWebviewMessage({ type: 'maintenanceScan' })).toEqual({ type: 'maintenanceScan' });
    // Any extra fields an attacker adds are dropped, not carried.
    expect(parseWebviewMessage({ type: 'maintenanceScan', items: ['temp:x'] })).toEqual({ type: 'maintenanceScan' });
  });

  it('the command is contributed and registered', () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes: { commands: { command: string }[] };
    };
    expect(manifest.contributes.commands.map((c) => c.command)).toContain('sandpane.maintenance');
    const extension = readFileSync(join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    expect(extension).toContain("registerCommand('sandpane.maintenance'");
  });

  it('MAINTENANCE_KINDS are the open-string kinds Core sends today', () => {
    expect([...MAINTENANCE_KINDS]).toEqual(['temp', 'dbBackup', 'verificationOutput', 'worktree']);
  });
});
