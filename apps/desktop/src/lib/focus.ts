/**
 * Pure focus-management helpers for modal dialogs (no DOM access here, so the
 * rules are unit-testable in the node test environment).
 */

/** Elements a keyboard user can Tab to inside a dialog. */
export const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Where Tab (or Shift+Tab) moves inside a focus trap of `count` elements when
 * the element at `current` has focus (`-1` = focus is outside the trap).
 * Wraps at both ends so focus can never leave the dialog. `null` when there is
 * nothing focusable at all.
 */
export function nextTrapIndex(count: number, current: number, backwards: boolean): number | null {
  if (count <= 0) return null;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  return (current + (backwards ? -1 : 1) + count) % count;
}

/**
 * Whether the dialog's confirm action is enabled. A required phrase must match
 * exactly — no trimming or case folding, so a confirmation is always deliberate.
 */
export function confirmEnabled(requirePhrase: string | undefined, typed: string): boolean {
  return requirePhrase === undefined || typed === requirePhrase;
}
