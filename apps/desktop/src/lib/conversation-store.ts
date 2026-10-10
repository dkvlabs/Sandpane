/**
 * Conversations created by THIS window, in memory only.
 *
 * `conversation.list` (ADDITIVE v1) is what reads Core's real chat list; this
 * store exists only to cover the gap between creating a chat and the next read,
 * so a fresh tab appears instantly. Views merge the two and label which half a
 * row came from — this list alone is never presented as the project's history.
 *
 * The snapshot is replaced rather than mutated because `useSyncExternalStore`
 * compares by identity — pushing into a shared array would silently skip the
 * re-render that tells the user their chat exists.
 */

import type { Conversation } from "./protocol";

let snapshot: readonly Conversation[] = [];
const listeners = new Set<() => void>();

export function listConversations(): readonly Conversation[] {
  return snapshot;
}

export function subscribeConversations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function addConversation(conversation: Conversation): void {
  if (snapshot.some((c) => c.id === conversation.id)) return;
  snapshot = [...snapshot, conversation];
  for (const listener of [...listeners]) listener();
}

/**
 * A3a: after Core confirms `project.delete`, drop this window's in-memory
 * conversations of that project so no view keeps offering a deleted chat.
 */
export function forgetProjectConversations(projectId: string): void {
  const kept = snapshot.filter((c) => c.projectId !== projectId);
  if (kept.length === snapshot.length) return;
  snapshot = kept;
  for (const listener of [...listeners]) listener();
}

/** Test/reload seam: a window restart drops this in-memory view by design. */
export function clearConversations(): void {
  snapshot = [];
  for (const listener of [...listeners]) listener();
}
