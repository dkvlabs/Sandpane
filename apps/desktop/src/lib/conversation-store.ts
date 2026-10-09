/**
 * Conversations created by this window, in memory only.
 *
 * Protocol v1 has no `conversation.list`, so this is the complete and honest
 * scope of what the desktop can show as a chat tab: the conversations IT created.
 * It is not a cache of Core state and is never presented as history.
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

/** Test/reload seam: a window restart drops this in-memory view by design. */
export function clearConversations(): void {
  snapshot = [];
  for (const listener of [...listeners]) listener();
}
