import type { KeyedWrite, KeyedWriteState } from "../../lib/idempotency";
import { describeCoreError } from "../../lib/reducers";
import { ErrorPanel } from "../../features/projects/ProjectsView";
import { Mono } from "./primitives";

/**
 * The failure surface of one keyed write (A2): the error that defines the
 * outcome, "Retry safely" only when the controller offers it (keyed + unknown
 * outcome), and — as SECONDARY text — why the last retry attempt sent nothing
 * or did not reach Core. A retry that never reached Core does not replace the
 * unknown-outcome panel with an "unreachable, retry" message that would invite
 * a fresh-key duplicate.
 */
export function KeyedWriteFailure<P extends { idempotencyKey?: string }, R>({
  state,
  write,
}: {
  state: Extract<KeyedWriteState<P, R>, { kind: "failed" }>;
  write: KeyedWrite<P, R>;
}) {
  const secondary = state.noteError === null ? null : describeCoreError(state.noteError);
  return (
    <>
      <ErrorPanel
        error={state.error}
        {...(state.retryOffered ? { onRetrySafely: () => void write.retrySafely() } : {})}
      />
      {state.note !== null && (
        <p className="muted" role="status">
          {state.note}
          {secondary !== null && (
            <>
              {" "}
              Last attempt: {secondary.title} — <Mono>{secondary.reason}</Mono>
            </>
          )}
        </p>
      )}
    </>
  );
}
