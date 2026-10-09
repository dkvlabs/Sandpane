import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_POLICY,
  isSensitivePath,
  planContextAttachments,
  selectionTarget,
  summarizeDiagnostics,
  type EditorSnapshot,
} from '../src/vscode/context';

const policy = { ...DEFAULT_CONTEXT_POLICY };

function snapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    uri: 'file:///repo/src/AuthService.ts',
    fsPath: '/repo/src/AuthService.ts',
    languageId: 'typescript',
    text: 'export class AuthService {}\n',
    ...overrides,
  };
}

describe('sensitive path exclusion (specs/06 §5)', () => {
  it.each([
    '/repo/.env',
    '/repo/.env.production',
    '/Users/me/.ssh/id_rsa',
    '/repo/config/tls.key',
    '/repo/service-account-prod.json',
    '/repo/credentials.json',
    '/repo/.npmrc',
    '/repo/deploy/secrets.yaml',
    '/repo/build/github_token.txt',
  ])('treats %s as sensitive', (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it('does not over-block ordinary source files', () => {
    for (const path of [
      '/repo/src/AuthService.ts',
      '/repo/env/envHelper.ts',
      '/repo/docs/keys.md',
      '/repo/src/token/tokenStore.spec.ts',
    ]) {
      expect(isSensitivePath(path)).toBe(false);
    }
  });

  it('honours user-added patterns and fails closed on a broken one', () => {
    expect(isSensitivePath('/repo/a/internal.txt', ['internal\\.txt$'])).toBe(true);
    expect(isSensitivePath('/repo/a/anything.txt', ['('])).toBe(true);
  });
});

describe('explicit attachment list before send', () => {
  it('orders selection → file, and emits only references on the wire', () => {
    const plan = planContextAttachments(
      [
        snapshot({
          selection: { text: 'const token = "x";', startLine: 12, endLine: 18 },
        }),
      ],
      policy,
    );
    expect(plan.attachments.map((a) => a.kind)).toEqual(['selection', 'file']);
    expect(plan.attachments[0]?.target).toBe('file:///repo/src/AuthService.ts#L12-L18');
    expect(plan.refs).toEqual([
      { kind: 'selection', target: 'file:///repo/src/AuthService.ts#L12-L18' },
      { kind: 'file', target: 'file:///repo/src/AuthService.ts' },
    ]);
    // The body is previewed for the human, never transmitted in protocol v1.
    expect(plan.refs[0]).not.toHaveProperty('content');
    expect(plan.attachments[0]?.excerpt).toBe('const token = "x";');
  });

  it('drops a sensitive file entirely and says why', () => {
    const plan = planContextAttachments(
      [snapshot({ uri: 'file:///repo/.env', fsPath: '/repo/.env', text: 'API_KEY=secret\n' })],
      policy,
    );
    expect(plan.attachments).toHaveLength(0);
    expect(plan.excluded.map((e) => e.reason).join(' ')).toMatch(/sensitive path/);
    expect(JSON.stringify(plan.refs)).not.toContain('API_KEY');
  });

  it('diagnostics need opt-in consent', () => {
    const withDiags = snapshot({
      diagnostics: [
        {
          uri: 'file:///repo/src/AuthService.ts',
          message: "Property 'x' is missing",
          severity: 'error',
          source: 'ts',
          startLine: 3,
        },
      ],
    });
    const declined = planContextAttachments([withDiags], policy);
    expect(declined.attachments.map((a) => a.kind)).toEqual(['file']);
    expect(declined.excluded[0]?.reason).toMatch(/opt-in/);

    const accepted = planContextAttachments(
      [withDiags],
      { ...policy, includeDiagnostics: true },
      'writable',
    );
    expect(accepted.attachments.map((a) => a.kind)).toEqual(['file', 'diagnostics']);
    expect(accepted.attachments[1]?.excerpt).toContain("Property 'x' is missing");
    expect(accepted.refs[1]).toEqual({
      kind: 'diagnostics',
      target: 'file:///repo/src/AuthService.ts#diagnostics',
    });
    expect(accepted.mode).toBe('writable');
    expect(accepted.summary).toContain('writable task');
  });

  it('respects the attachment ceiling and clips long excerpts', () => {
    const many = Array.from({ length: 12 }, (_unused, i) =>
      snapshot({
        uri: `file:///repo/src/f${i}.ts`,
        fsPath: `/repo/src/f${i}.ts`,
        text: 'y'.repeat(5_000),
      }),
    );
    const plan = planContextAttachments(many, { ...policy, maxAttachments: 3, maxAttachmentChars: 100 });
    expect(plan.attachments).toHaveLength(3);
    expect(plan.excluded).toHaveLength(9); // 12 files: first 3 in, 1 selection-less each
    expect(plan.attachments[0]?.excerpt).toHaveLength(100);
    expect(plan.attachments[0]?.excerptTruncated).toBe(true);
  });

  it('summarizes an empty selection without dropping the file context', () => {
    const plan = planContextAttachments(
      [snapshot({ selection: { text: '   ', startLine: 1, endLine: 1 } })],
      policy,
    );
    expect(plan.attachments.map((a) => a.kind)).toEqual(['file']);
  });

  it('keeps hostile text inert in both the preview and the wire reference', () => {
    const hostile = '");\nprocess.exit(1);\n// $(rm -rf /) `id`';
    const plan = planContextAttachments([snapshot({ text: hostile })], policy);
    expect(plan.attachments[0]?.excerpt).toBe(hostile);
    expect(plan.refs[0]?.target).toBe('file:///repo/src/AuthService.ts');
    expect(JSON.stringify(plan)).not.toMatch(/shell|exec/i);
  });

  it('normalizes a reversed or zero selection range in the target', () => {
    expect(selectionTarget('file:///a.ts', 9, 2)).toBe('file:///a.ts#L9-L9');
    expect(selectionTarget('file:///a.ts', 0, -5)).toBe('file:///a.ts#L1-L1');
  });

  it('formats diagnostics for the preview', () => {
    expect(
      summarizeDiagnostics([
        { uri: 'u', message: 'bad', severity: 'error', source: 'eslint', startLine: 4 },
        { uri: 'u', message: 'hmm', severity: 'hint', startLine: 7 },
      ]),
    ).toBe('error [eslint] line 4: bad\nhint line 7: hmm');
  });

  it('describes what will happen, distinguishing discussion from execution', () => {
    const readOnly = planContextAttachments([snapshot()], policy, 'read_only');
    expect(readOnly.summary).toContain('read-only discussion');
    const writable = planContextAttachments([snapshot()], policy, 'writable');
    expect(writable.summary).toContain('writable task in an isolated workspace');
  });
});
