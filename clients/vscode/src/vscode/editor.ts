/**
 * Thin `vscode` glue that turns the live editor into the plain snapshot the
 * pure context planner (`vscode/context.ts`) consumes. Keeping this separate is
 * what makes the planner unit-testable without an extension host.
 *
 * Bounds are enforced here, before any text reaches the planner: a document is
 * read at most `MAX_DOCUMENT_CHARS`, and a directory is never blanket-attached
 * (specs/06 §5).
 */

import * as vscode from 'vscode';
import type { DiagnosticSnapshot, EditorSnapshot } from './context';

const MAX_DOCUMENT_CHARS = 200_000;
const MAX_SELECTION_CHARS = 200_000;

function severityName(severity: vscode.DiagnosticSeverity): DiagnosticSnapshot['severity'] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'information';
  }
}

export interface CollectOptions {
  /** Include the whole document text (bounded) in the snapshot. */
  includeDocumentText?: boolean;
}

/** Snapshot of the active editor + its real diagnostics. `null` when none. */
export function collectEditorSnapshot(options: CollectOptions = {}): EditorSnapshot | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const document = editor.document;
  if (document.uri.scheme !== 'file') {
    // A virtual/remote document has no host path Core could resolve.
    return null;
  }
  const includeDocumentText = options.includeDocumentText ?? true;
  const fullText = document.getText();
  const selection = editor.selection;
  const selectionText = selection.isEmpty ? '' : document.getText(selection);

  const snapshot: EditorSnapshot = {
    // Fully encoded: a skip-encoding string could carry a literal '#' that
    // collides with the '#L…' selection range separator (review 12h).
    uri: document.uri.toString(),
    fsPath: document.uri.fsPath,
    languageId: document.languageId,
    text: includeDocumentText ? fullText.slice(0, MAX_DOCUMENT_CHARS) : '',
  };
  if (selectionText.length > 0) {
    snapshot.selection = {
      text: selectionText.slice(0, MAX_SELECTION_CHARS),
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
    };
  }
  const diagnostics = collectDiagnostics(document.uri);
  if (diagnostics.length > 0) snapshot.diagnostics = diagnostics;
  return snapshot;
}

/**
 * Real diagnostics for a URI, read on explicit user action only (opt-in in the
 * plan). `languages.getDiagnostics` is the documented API; nothing is scraped
 * from the Problems panel text.
 */
export function collectDiagnostics(uri: vscode.Uri): DiagnosticSnapshot[] {
  return vscode.languages.getDiagnostics(uri).map((diagnostic) => ({
    uri: uri.toString(),
    message: diagnostic.message,
    severity: severityName(diagnostic.severity),
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    startLine: diagnostic.range.start.line + 1,
    character: diagnostic.range.start.character,
  }));
}
