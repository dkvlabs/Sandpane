/**
 * A7 rendering of UNTRUSTED verification text (design 2026-10-09 §3.7 item
 * 6, W9): labels, argv elements, notes, sandbox names, repository paths and
 * command output. Everything here is a React TEXT child — revealed (control,
 * bidi and invisible characters become visible escapes) and capped — never
 * raw HTML, never Markdown, never a terminal or link-detecting widget.
 */

import { useEffect, useId, useRef, type ReactNode } from "react";
import { FOCUSABLE_SELECTOR, nextTrapIndex } from "../../lib/focus";
import { revealOutput, revealText } from "../../lib/verification";
import { Badge, Button, Mono } from "../ui/primitives";

/** One line of untrusted text, revealed and capped, with an "unusual" badge. */
export function RevealedText({ value, max }: { value: string; max: number }) {
  const shown = revealText(value, max);
  return (
    <>
      <Mono>{shown.text}</Mono>
      {shown.unusual && (
        <>
          {" "}
          <Badge
            tone="attention"
            title="Contains control, hidden or direction-changing characters, shown as \u escapes."
          >
            unusual characters
          </Badge>
        </>
      )}
    </>
  );
}

/** argv element by element (never joined into one line), with the count. */
export function ArgvList({ argv, max }: { argv: readonly string[]; max: number }) {
  return (
    <ol className="argv-list" aria-label={`${argv.length} ${argv.length === 1 ? "argument" : "arguments"}`}>
      {argv.map((element, index) => (
        <li key={index}>
          <span className="muted">{index + 1}.</span> <RevealedText value={element} max={max} />
          {element.length === 0 && <span className="muted"> (empty)</span>}
        </li>
      ))}
    </ol>
  );
}

/**
 * Command output in a `<pre>` as ONE text child: LF and TAB kept, CR shown as
 * `\r`, every other control (ESC included) escaped, capped with the cut counted.
 */
export function OutputBlock({ label, output }: { label: string; output: string }) {
  const shown = revealOutput(output);
  return (
    <section className="verification-output" aria-label={label}>
      <h4 className="verification-output__head">
        {label}
        {shown.unusual && (
          <>
            {" "}
            <Badge tone="attention" title="Control, hidden or direction-changing characters are shown as escapes.">
              unusual characters
            </Badge>
          </>
        )}
      </h4>
      {output.length === 0 ? (
        <p className="muted">(empty)</p>
      ) : (
        <pre className="verification-output__text">{shown.text}</pre>
      )}
      {shown.hiddenLines > 0 && (
        <p className="muted">… {shown.hiddenLines} more lines not shown.</p>
      )}
    </section>
  );
}

/**
 * The A6 confirmation pattern: an in-app modal `alertdialog`, Cancel focused
 * by default, Escape and the backdrop cancel, Tab trapped. Rendered only while
 * the caller holds a snapshot created by a trusted click.
 */
export function AlertConfirmDialog({
  title,
  statement,
  confirmLabel,
  confirmDisabled = false,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  statement: ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const statementId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    // The safe default: Cancel has focus, never the confirm button.
    dialog?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab" || dialog === null) return;
      const focusables = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      const current = focusables.findIndex((element) => element === document.activeElement);
      const next = nextTrapIndex(focusables.length, current, event.shiftKey);
      event.preventDefault();
      if (next !== null) focusables[next]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="dialog dialog--apply"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={statementId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="dialog__title">
          {title}
        </h2>
        <div className="dialog__body apply-confirm">
          <div id={statementId}>{statement}</div>
          {children}
        </div>
        <div className="dialog__actions">
          <Button variant="ghost" onClick={onCancel} data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
