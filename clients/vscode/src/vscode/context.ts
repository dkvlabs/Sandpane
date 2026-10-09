/**
 * Context attachments (specs/03 §1, §4 "Context attachment").
 *
 * The planner below is **pure** (no `vscode` import) so the exclusion, sizing
 * and explicit-list rules are unit-testable; `editor.ts` supplies the snapshot
 * from the real editor. Every attachment is listed for the user before sending,
 * a sensitive path is dropped rather than redacted, and diagnostics require an
 * explicit opt-in. Discussion vs writable execution is part of the plan.
 */

import type { ContextRef, ContextRefKind } from '../core-client/protocol';

export interface DiagnosticSnapshot {
  uri: string;
  message: string;
  severity: 'error' | 'warning' | 'information' | 'hint';
  source?: string;
  startLine: number;
  character?: number;
}

export interface EditorSnapshot {
  /** Document URI string (`file:` on a supported host). */
  uri: string;
  fsPath: string;
  languageId: string;
  /** Whole-document text, capped by the caller before it gets here. */
  text: string;
  selection?: { text: string; startLine: number; endLine: number };
  diagnostics?: DiagnosticSnapshot[];
}

export interface ContextPolicy {
  /** Excerpt characters kept per attachment for the preview list. */
  maxAttachmentChars: number;
  maxAttachments: number;
  /** Diagnostics are attached only with consent (specs/03 §4). */
  includeDiagnostics: boolean;
  /** Extra regex sources (case-insensitive) matched against the fsPath. */
  sensitivePathPatterns: string[];
}

/**
 * Defaults follow specs/06 §5: deny sensitive paths by default, cap size, never
 * blanket-send a directory.
 */
export const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = [
  '(^|/)\.env($|\\.)',
  '(^|/)\\.env\\.production($|\\.)',
  '(^|/)id_(rsa|ed25519|ecdsa|dsa)($|\\.)',
  '(^|/)\\.ssh/',
  '(^|/)\\.aws/credentials',
  '(^|/)\\.npmrc$',
  '(^|/)\\.netrc$',
  '(^|/)\\.git-credentials$',
  '\\.pem$',
  '\\.key$',
  '\\.p12$',
  '(^|/)credentials\\.json$',
  '(^|/)service-account(-[^/]+)?\\.json$',
  '(^|/)[^/]*secret[^/]*\\.(json|ya?ml|toml|env|txt)$',
  '(^|/)[^/]*token[^/]*\\.(json|txt|env)$',
];

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  maxAttachmentChars: 2000,
  maxAttachments: 8,
  includeDiagnostics: false,
  sensitivePathPatterns: [],
};

export interface AttachmentPlan {
  kind: ContextRefKind;
  /** What Core receives: a reference, never a body (protocol v1 `ContextRef`). */
  target: string;
  label: string;
  /** Preview shown to the user before send; not transmitted. */
  excerpt: string;
  excerptTruncated: boolean;
}

export interface ExcludedAttachment {
  target: string;
  label: string;
  reason: string;
}

export interface ContextPlan {
  attachments: AttachmentPlan[];
  excluded: ExcludedAttachment[];
  /** Wire payload for `conversation.send.attachments`. */
  refs: ContextRef[];
  mode: 'read_only' | 'writable';
  /** One-line human summary for the confirmation message. */
  summary: string;
}

export function isSensitivePath(fsPath: string, extraPatterns: readonly string[] = []): boolean {
  const patterns = [...DEFAULT_SENSITIVE_PATTERNS, ...extraPatterns];
  return patterns.some((source) => {
    try {
      return new RegExp(source, 'i').test(fsPath);
    } catch {
      // A broken user pattern must not silently widen access: treat as sensitive.
      return true;
    }
  });
}

export function selectionTarget(uri: string, startLine: number, endLine: number): string {
  const from = Math.max(1, Math.trunc(startLine));
  const to = Math.max(from, Math.trunc(endLine));
  return `${uri}#L${from}-L${to}`;
}

function clip(text: string, max: number): { excerpt: string; truncated: boolean } {
  if (text.length <= max) return { excerpt: text, truncated: false };
  return { excerpt: text.slice(0, max), truncated: true };
}

function baseName(fsPath: string): string {
  const parts = fsPath.split('/');
  return parts[parts.length - 1] || fsPath;
}

/**
 * Turn editor snapshots into the explicit list shown before sending.
 * Order: selection → active file → diagnostics (opt-in).
 */
export function planContextAttachments(
  snapshots: readonly EditorSnapshot[],
  policy: ContextPolicy,
  mode: ContextPlan['mode'] = 'read_only',
): ContextPlan {
  const attachments: AttachmentPlan[] = [];
  const excluded: ExcludedAttachment[] = [];

  const pushCandidate = (candidate: AttachmentPlan, fsPath: string): void => {
    if (isSensitivePath(fsPath, policy.sensitivePathPatterns)) {
      excluded.push({
        target: candidate.target,
        label: candidate.label,
        reason: 'sensitive path — excluded entirely, not redacted (specs/06 §5)',
      });
      return;
    }
    if (attachments.length >= policy.maxAttachments) {
      excluded.push({
        target: candidate.target,
        label: candidate.label,
        reason: `attachment ceiling (${policy.maxAttachments}) reached`,
      });
      return;
    }
    attachments.push(candidate);
  };

  for (const snapshot of snapshots) {
    if (snapshot.selection && snapshot.selection.text.trim().length > 0) {
      const target = selectionTarget(
        snapshot.uri,
        snapshot.selection.startLine,
        snapshot.selection.endLine,
      );
      const clipped = clip(snapshot.selection.text, policy.maxAttachmentChars);
      pushCandidate(
        {
          kind: 'selection',
          target,
          label: `${baseName(snapshot.fsPath)}:${snapshot.selection.startLine}-${snapshot.selection.endLine}`,
          excerpt: clipped.excerpt,
          excerptTruncated: clipped.truncated,
        },
        snapshot.fsPath,
      );
    }

    if (snapshot.text.trim().length > 0) {
      const clipped = clip(snapshot.text, policy.maxAttachmentChars);
      pushCandidate(
        {
          kind: 'file',
          target: snapshot.uri,
          label: baseName(snapshot.fsPath),
          excerpt: clipped.excerpt,
          excerptTruncated: clipped.truncated,
        },
        snapshot.fsPath,
      );
    }

    const diagnostics = snapshot.diagnostics ?? [];
    if (diagnostics.length > 0) {
      if (!policy.includeDiagnostics) {
        excluded.push({
          target: snapshot.uri,
          label: `${baseName(snapshot.fsPath)} diagnostics (${diagnostics.length})`,
          reason: 'diagnostics are opt-in and were not authorized for this send',
        });
      } else {
        const clipped = clip(summarizeDiagnostics(diagnostics), policy.maxAttachmentChars);
        pushCandidate(
          {
            kind: 'diagnostics',
            target: `${snapshot.uri}#diagnostics`,
            label: `${baseName(snapshot.fsPath)} problems (${diagnostics.length})`,
            excerpt: clipped.excerpt,
            excerptTruncated: clipped.truncated,
          },
          snapshot.fsPath,
        );
      }
    }
  }

  const refs: ContextRef[] = attachments.map((a) => ({ kind: a.kind, target: a.target }));
  const summary = describePlan(attachments, excluded, mode);
  return { attachments, excluded, refs, mode, summary };
}

export function summarizeDiagnostics(diagnostics: readonly DiagnosticSnapshot[]): string {
  return diagnostics
    .map((d) => {
      const source = d.source ? ` [${d.source}]` : '';
      return `${d.severity}${source} line ${d.startLine}: ${d.message}`;
    })
    .join('\n');
}

function describePlan(
  attachments: readonly AttachmentPlan[],
  excluded: readonly ExcludedAttachment[],
  mode: ContextPlan['mode'],
): string {
  const kindCount = new Map<ContextRefKind, number>();
  for (const a of attachments) kindCount.set(a.kind, (kindCount.get(a.kind) ?? 0) + 1);
  const listed = [...kindCount.entries()].map(([kind, n]) => `${kind}×${n}`).join(', ') || 'nothing';
  const intent =
    mode === 'writable'
      ? 'writable task in an isolated workspace (agent may edit files)'
      : 'read-only discussion (no writable task)';
  const drop = excluded.length > 0 ? `; ${excluded.length} excluded` : '';
  return `Attaching ${listed}${drop} — ${intent}`;
}
