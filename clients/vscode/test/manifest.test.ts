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

describe('contributed commands match the registered ones', () => {
  const contributed = (
    JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }> };
    }
  ).contributes.commands.map((c) => c.command);
  const extension = readFileSync(join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const registered = [...extension.matchAll(/registerCommand\('(sandpane\.[A-Za-z]+)'/g)].map((m) => m[1]);

  it('every contributed command is registered and vice versa (21, incl. the 8 A3a project commands and A5 Show Task Patch)', () => {
    expect([...contributed].sort()).toEqual([...registered].sort());
    expect(contributed).toHaveLength(21);
    for (const id of [
      'sandpane.showTaskPatch',
      'sandpane.renameProject',
      'sandpane.editProjectDescription',
      'sandpane.archiveProject',
      'sandpane.unarchiveProject',
      'sandpane.toggleArchivedProjects',
      'sandpane.addRepository',
      'sandpane.removeRepository',
      'sandpane.deleteProject',
    ]) {
      expect(contributed).toContain(id);
    }
  });
});

describe('A5 patch view wiring', () => {
  it('extension.ts registers the session patch store as the sandpane-diff content provider', () => {
    const extension = readFileSync(join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    expect(extension).toContain('vscode.workspace.registerTextDocumentContentProvider(PATCH_SCHEME, session.patchDocuments)');
    expect(extension).toContain("import { PATCH_SCHEME } from './vscode/gitDiff';");
  });
});
