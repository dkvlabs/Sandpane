/**
 * A7 command handlers (design 2026-10-09 §3.7). Every handler IGNORES its
 * arguments: a `command:` URI, another extension's `executeCommand` or a
 * keybinding can pass anything (an argv, a command id, a run id), and none of
 * it reaches Core. Each handler opens a dialog filled from a FRESH Core read;
 * only the user's explicit confirmation sends anything.
 */

/** The contributed A7 command ids (package.json `contributes.commands`). */
export const VERIFICATION_COMMAND_IDS = {
  approve: 'sandpane.approveVerification',
  approveSuggestion: 'sandpane.approveVerificationSuggestion',
  revoke: 'sandpane.revokeVerification',
  run: 'sandpane.runVerification',
  showResult: 'sandpane.showVerificationResult',
} as const;

export type VerificationCommandId = (typeof VERIFICATION_COMMAND_IDS)[keyof typeof VERIFICATION_COMMAND_IDS];

/** The session entry points the handlers call — each takes NO argument. */
export interface VerificationGestures {
  approveVerificationCommand(): Promise<void>;
  approveVerificationSuggestion(): Promise<void>;
  revokeVerificationCommand(): Promise<void>;
  runVerificationFromPicker(): Promise<void>;
  showVerificationResultFromPicker(): Promise<void>;
}

export type VerificationHandler = (...ignored: unknown[]) => Promise<void>;

/** One handler per contributed id; the arguments are dropped on purpose. */
export function verificationCommandHandlers(session: VerificationGestures): Record<VerificationCommandId, VerificationHandler> {
  return {
    [VERIFICATION_COMMAND_IDS.approve]: (..._ignored: unknown[]) => session.approveVerificationCommand(),
    [VERIFICATION_COMMAND_IDS.approveSuggestion]: (..._ignored: unknown[]) => session.approveVerificationSuggestion(),
    [VERIFICATION_COMMAND_IDS.revoke]: (..._ignored: unknown[]) => session.revokeVerificationCommand(),
    [VERIFICATION_COMMAND_IDS.run]: (..._ignored: unknown[]) => session.runVerificationFromPicker(),
    [VERIFICATION_COMMAND_IDS.showResult]: (..._ignored: unknown[]) => session.showVerificationResultFromPicker(),
  };
}
