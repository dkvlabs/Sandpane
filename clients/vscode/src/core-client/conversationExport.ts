/**
 * The `conversation.export` paging loop (A3b, design 2026-10-09 §3.3 item 6)
 * and the ONE JSON document assembled from it. Pure: the caller injects the
 * page fetch (`CoreCommands.conversationExport`), so this has no `vscode` and
 * no socket dependency.
 *
 * Rules (shared by every Sandpane client):
 *  - pages are read from `afterSequence: 0` until `truncated` is false;
 *  - `nextSequence` must strictly increase; when it does not, the loop stops
 *    and the export is PARTIAL (`complete: false`);
 *  - at most `EXPORT_PAGE_CAP` pages; still truncated after that = PARTIAL;
 *  - every page is shape-checked; ANY page failure (Core error, transport
 *    loss, malformed page) yields NO document at all;
 *  - `redaction.replacements` and `redaction.byKind` are SUMMED over pages
 *    (Core counts the title's replacements on the first page only, so a plain
 *    sum counts it once); a kind absent from a page counts 0.
 *
 * Nothing here logs, and no error message quotes page content.
 */

import type { Conversation, MessageRecord } from './protocol';
import { CONVERSATION_EXPORT_FORMAT } from './protocol';

/** Hard cap on pages per export; reaching it with more to read = PARTIAL. */
export const EXPORT_PAGE_CAP = 200;

/** Written into every export file (shared cross-client wording). */
export const EXPORT_NOTE =
  'Redaction is best-effort; review before sharing. Task events, artifacts and verification output are not included.';

/** Shown before and after an export (shared cross-client wording). */
export const EXPORT_BEST_EFFORT_COPY = 'Redaction is best-effort; review the export before sharing it.';

/** The one file an export produces. */
export interface ConversationExportFile {
  format: string;
  /** From the FIRST page. */
  exportedAt: string;
  /** From the FIRST page (title redacted by Core). */
  conversation: Conversation;
  /** Every page's messages, concatenated in page order (content redacted). */
  messages: MessageRecord[];
  redaction: { bestEffort: true; replacements: number; byKind: Record<string, number> };
  /** False when the loop stopped early (cursor not advancing, or the page cap). */
  complete: boolean;
  note: string;
}

export type ExportIncomplete = 'cursor-not-advancing' | 'page-cap';

export type ExportOutcome =
  | { ok: true; file: ConversationExportFile; pages: number; incomplete: ExportIncomplete | null }
  | { ok: false; error: unknown; pages: number };

/** A page that does not have the documented shape. The message names the check only. */
export class ExportPageError extends Error {
  constructor(pageNumber: number, check: string) {
    super(`export page ${pageNumber} was not accepted (${check}); no file was written`);
    this.name = 'ExportPageError';
  }
}

interface CheckedPage {
  exportedAt: string;
  conversation: Conversation;
  messages: MessageRecord[];
  truncated: boolean;
  nextSequence: number;
  replacements: number;
  byKind: [string, number][];
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function checkPage(raw: unknown, conversationId: string, pageNumber: number): CheckedPage {
  const refuse = (check: string): never => {
    throw new ExportPageError(pageNumber, check);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('the page is not an object');
  const page = raw as Record<string, unknown>;
  if (page['format'] !== CONVERSATION_EXPORT_FORMAT) refuse('unknown export format');
  if (typeof page['exportedAt'] !== 'string') refuse('no exportedAt');
  const conversation = page['conversation'] as Record<string, unknown> | null | undefined;
  if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) refuse('no conversation');
  const c = conversation as Record<string, unknown>;
  if (c['id'] !== conversationId) refuse('it is for a different conversation');
  for (const key of ['projectId', 'title', 'agentId', 'createdAt']) {
    if (typeof c[key] !== 'string') refuse(`conversation.${key} is not a string`);
  }
  if (!isOptionalString(c['archivedAt']) || !isOptionalString(c['sandboxId'])) {
    refuse('conversation has a malformed optional field');
  }
  const messages = page['messages'];
  if (!Array.isArray(messages)) refuse('messages is not a list');
  for (const message of messages as unknown[]) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) refuse('a message is not an object');
    const m = message as Record<string, unknown>;
    if (typeof m['id'] !== 'string' || typeof m['role'] !== 'string' || typeof m['content'] !== 'string') {
      refuse('a message is missing id, role or content');
    }
    if (m['conversationId'] !== conversationId) refuse('a message belongs to a different conversation');
    if (typeof m['sequence'] !== 'number' || !Number.isSafeInteger(m['sequence'])) refuse('a message sequence is not an integer');
  }
  if (typeof page['truncated'] !== 'boolean') refuse('truncated is not a boolean');
  const next = page['nextSequence'];
  if (typeof next !== 'number' || !Number.isSafeInteger(next)) refuse('nextSequence is not an integer');
  const redaction = page['redaction'] as Record<string, unknown> | null | undefined;
  if (!redaction || typeof redaction !== 'object' || Array.isArray(redaction)) refuse('no redaction summary');
  const r = redaction as Record<string, unknown>;
  // Core never exports unredacted text; a page that does not say so is refused.
  if (r['bestEffort'] !== true) refuse('redaction.bestEffort is not true');
  if (!isCount(r['replacements'])) refuse('redaction.replacements is not a non-negative integer');
  const byKindRaw = r['byKind'];
  if (!byKindRaw || typeof byKindRaw !== 'object' || Array.isArray(byKindRaw)) refuse('redaction.byKind is not a map');
  const byKind: [string, number][] = [];
  let sum = 0;
  for (const [kind, count] of Object.entries(byKindRaw as Record<string, unknown>)) {
    if (!isCount(count)) refuse('a redaction.byKind count is not a non-negative integer');
    byKind.push([kind, count as number]);
    sum += count as number;
  }
  if (sum !== r['replacements']) refuse('redaction.replacements is not the sum of byKind');
  return {
    exportedAt: page['exportedAt'] as string,
    conversation: c as unknown as Conversation,
    messages: messages as MessageRecord[],
    truncated: page['truncated'] as boolean,
    nextSequence: next as number,
    replacements: r['replacements'] as number,
    byKind,
  };
}

/**
 * Read every export page of `conversationId` through `fetchPage(afterSequence)`
 * and assemble the single export document — or, on ANY page failure, no
 * document at all.
 */
export async function collectConversationExport(
  conversationId: string,
  fetchPage: (afterSequence: number) => Promise<unknown>,
  pageCap = EXPORT_PAGE_CAP,
): Promise<ExportOutcome> {
  let cursor = 0;
  let pages = 0;
  let first: CheckedPage | null = null;
  const messages: MessageRecord[] = [];
  // A Map, never a plain object: a kind named `__proto__` stays plain data.
  const kinds = new Map<string, number>();
  let replacements = 0;
  let incomplete: ExportIncomplete | null = null;

  for (;;) {
    let page: CheckedPage;
    try {
      const raw = await fetchPage(cursor);
      page = checkPage(raw, conversationId, pages + 1);
    } catch (error) {
      return { ok: false, error, pages };
    }
    pages += 1;
    first ??= page;
    messages.push(...page.messages);
    replacements += page.replacements;
    for (const [kind, count] of page.byKind) kinds.set(kind, (kinds.get(kind) ?? 0) + count);
    if (!page.truncated) break;
    if (page.nextSequence <= cursor) {
      incomplete = 'cursor-not-advancing';
      break;
    }
    if (pages >= pageCap) {
      incomplete = 'page-cap';
      break;
    }
    cursor = page.nextSequence;
  }

  if (first === null) return { ok: false, error: new ExportPageError(1, 'no page was read'), pages };
  const byKind = Object.fromEntries([...kinds.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    ok: true,
    pages,
    incomplete,
    file: {
      format: CONVERSATION_EXPORT_FORMAT,
      exportedAt: first.exportedAt,
      conversation: first.conversation,
      messages,
      redaction: { bestEffort: true, replacements, byKind },
      complete: incomplete === null,
      note: EXPORT_NOTE,
    },
  };
}
