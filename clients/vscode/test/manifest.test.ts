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

  it('every contributed command is registered and vice versa (27, incl. the 8 A3a project commands, A5 Show Task Patch, the 5 A7 verification commands and A9 Clean Up Core State)', () => {
    expect([...contributed].sort()).toEqual([...registered].sort());
    expect(contributed).toHaveLength(27);
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
      'sandpane.approveVerification',
      'sandpane.approveVerificationSuggestion',
      'sandpane.revokeVerification',
      'sandpane.runVerification',
      'sandpane.showVerificationResult',
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

  it('extension.ts registers the apply-list store as the sandpane-apply content provider (V-W1)', () => {
    const extension = readFileSync(join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    expect(extension).toContain(
      'vscode.workspace.registerTextDocumentContentProvider(APPLY_LIST_SCHEME, session.applyListDocuments)',
    );
    expect(extension).toContain("import { APPLY_LIST_SCHEME } from './vscode/gitApply';");
  });
});

describe('A7 verification output wiring', () => {
  it('extension.ts registers the session verification store as the sandpane-verification content provider', () => {
    const extension = readFileSync(join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    expect(extension).toContain(
      'vscode.workspace.registerTextDocumentContentProvider(VERIFICATION_SCHEME, session.verificationDocuments)',
    );
    expect(extension).toContain("import { VERIFICATION_SCHEME } from './vscode/verification';");
    // Never a terminal or a pseudoterminal for verification output.
    expect(extension).not.toMatch(/createTerminal|Pseudoterminal/);
  });
});
