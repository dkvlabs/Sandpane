/**
 * A6 confirmation for `git.apply` (design 2026-10-09 §3.6 item 9).
 *
 * An in-app modal `alertdialog`, rendered ONLY while the panel holds a frozen
 * `ApplySnapshot`, which is created ONLY by the Apply button's click handler
 * (`openApplyConfirmation` requires a trusted user gesture). Nothing else —
 * chat, agent or tool text, a timer, a reconnect — can open it or send.
 *
 * Every string Core relayed (the repository path, every file path) is a React
 * TEXT child, revealed (hidden, control and bidi characters become visible
 * escapes) and capped — never injected as raw HTML.
 * Focus starts on Cancel (the safe default); Escape and the backdrop cancel.
 */

import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  APPLY_NAME_MAX_CHARS,
  APPLY_STATEMENT,
  applyButtonLabel,
  type ApplySnapshot,
  type FlaggedEntry,
} from "../../lib/git-apply";
import type { ApplyEntry } from "../../lib/protocol";
import { FOCUSABLE_SELECTOR, nextTrapIndex } from "../../lib/focus";
import { displayRevealed, fileChangeLabel } from "../../lib/reducers";
import { Badge, Button, Mono } from "../ui/primitives";

function Revealed({ value }: { value: string }) {
  const shown = displayRevealed(value, APPLY_NAME_MAX_CHARS);
  return (
    <>
      <Mono>{shown.text}</Mono>
      {shown.unusual && (
        <>
          {" "}
          <Badge
            tone="attention"
            title="Contains hidden, control or direction-changing characters, shown as \u escapes."
          >
            unusual characters
          </Badge>
        </>
      )}
    </>
  );
}

/** `oldPath → path` for a rename, else `path`; both revealed. */
function EntryName({ entry }: { entry: ApplyEntry }) {
  return (
    <>
      {entry.oldPath !== undefined && (
        <>
          <Revealed value={entry.oldPath} /> →{" "}
        </>
      )}
      <Revealed value={entry.path} />
    </>
  );
}

function FlagSection({
  heading,
  explanation,
  items,
}: {
  heading: string;
  explanation: ReactNode;
  items: readonly FlaggedEntry[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="apply-confirm__flags" aria-label={heading}>
      <h3 className="apply-confirm__heading">
        {heading} ({items.length})
      </h3>
      <p>{explanation}</p>
      <ul className="apply-confirm__list">
        {items.map((item, index) => (
          <li key={index}>
            <EntryName entry={item.entry} /> <span className="muted">— {item.why}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ApplyConfirmDialog({
  snapshot,
  onCancel,
  onConfirm,
  confirmDisabled = false,
}: {
  snapshot: ApplySnapshot;
  onCancel: () => void;
  onConfirm: () => void;
  /** e.g. an apply is already in flight (single-flight). */
  confirmDisabled?: boolean;
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
    // The safe default: Cancel has focus, never the Apply button.
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

  const { request, repoPath, flags } = snapshot;
  const count = request.entries.length;
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
          Apply {count} reviewed {count === 1 ? "file" : "files"} to your repository?
        </h2>
        <div className="dialog__body apply-confirm">
          <p id={statementId}>
            <strong>{APPLY_STATEMENT}</strong>
          </p>
          <dl className="kvs kvs--tight">
            <div className="kv">
              <dt>repository</dt>
              <dd>
                <Revealed value={repoPath} />
              </dd>
            </div>
            <div className="kv">
              <dt>base commit</dt>
              <dd>
                <Mono>{displayRevealed(request.expectedBase, APPLY_NAME_MAX_CHARS).text}</Mono>
              </dd>
            </div>
          </dl>

          <FlagSection
            heading="(a) Content you have not fully seen"
            explanation="Binary, truncated, or never opened in the Diff view in this session. Open their diffs first if you want to see what will be written."
            items={flags.notFullyShown}
          />
          <FlagSection
            heading="(b) Executable files"
            explanation="These are written with mode 100755: new executables or exec-bit changes."
            items={flags.executable}
          />
          <FlagSection
            heading="(c) Paths that run automatically"
            explanation="Git hooks, CI workflows, editor, direnv or git attribute files can run code or change behaviour without you starting anything."
            items={flags.autoRun}
          />

          <h3 className="apply-confirm__heading">Every file ({count})</h3>
          <ul className="apply-confirm__list apply-confirm__list--all">
            {request.entries.map((entry, index) => (
              <li key={index}>
                <Badge tone={entry.status === "deleted" ? "danger" : "neutral"}>
                  {fileChangeLabel(entry.status)}
                </Badge>{" "}
                <EntryName entry={entry} />
              </li>
            ))}
          </ul>
        </div>
        <div className="dialog__actions">
          <Button variant="ghost" onClick={onCancel} data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" disabled={confirmDisabled} onClick={onConfirm}>
            {applyButtonLabel(count)}
          </Button>
        </div>
      </div>
    </div>
  );
}
