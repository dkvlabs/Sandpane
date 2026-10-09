/**
 * Manifest guards (security review W4): settings that choose WHERE prompts go
 * (the Core socket) or WHAT is attached (diagnostics consent) must not be
 * settable by a repository's .vscode/settings.json.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface SettingSchema {
  scope?: string;
}

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, SettingSchema> } };
};
const settings = manifest.contributes.configuration.properties;

describe('workspace-proof settings (W4)', () => {
  it.each(['sandpane.coreSocketPath', 'sandpane.attachDiagnostics'])('%s is machine-scoped', (key) => {
    // "machine": user/remote settings only — a workspace folder cannot set it.
    expect(settings[key]?.scope).toBe('machine');
  });
});
