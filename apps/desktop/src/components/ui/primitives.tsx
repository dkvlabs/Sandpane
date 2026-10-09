/**
 * Shared primitives. Deliberately small: the design spec says to generalize only
 * what repeats, and Section 17's full shadcn/ui pass is deferred until the
 * workflows are functional. Every control is a native element with a token class,
 * so keyboard behaviour comes from the platform rather than from a dependency.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";
import type { StatusTone } from "../../lib/reducers";
import { FOCUSABLE_SELECTOR, confirmEnabled, nextTrapIndex } from "../../lib/focus";

export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: StatusTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      <span className="badge__dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Button({
  variant = "default",
  tone,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
  tone?: StatusTone;
}) {
  const className = [
    "btn",
    `btn--${variant}`,
    tone ? `btn--tone-${tone}` : "",
    rest["aria-label"] === undefined ? "" : "btn--icon",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={className} {...rest}>
      {children}
    </button>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  tone,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <section className={`panel${tone ? ` panel--${tone}` : ""}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="panel__head">
          <div>
            {title !== undefined && <h2 className="panel__title">{title}</h2>}
            {description !== undefined && (
              <p className="panel__desc">{description}</p>
            )}
          </div>
          {actions !== undefined && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
    </section>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint !== undefined && (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p className="field__error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * React 19: `ref` is an ordinary prop on function components, so this no longer
 * needs `forwardRef` (which React has announced it will deprecate). Callers that
 * pass `ref` keep working unchanged.
 */
export function TextInput({
  invalid,
  className,
  ref,
  ...rest
}: ComponentPropsWithRef<"input"> & { invalid?: boolean }) {
  return (
    <input
      ref={ref}
      className={`input${className ? ` ${className}` : ""}`}
      aria-invalid={invalid ? true : undefined}
      {...rest}
    />
  );
}

/**
 * Honest empty state. `variant` distinguishes the three things that look alike
 * but are not: nothing exists yet, the data source is unreachable, or this build
 * does not implement the capability at all.
 */
export function EmptyState({
  heading,
  body,
  action,
  variant = "empty",
}: {
  heading: string;
  body: ReactNode;
  action?: ReactNode;
  variant?: "empty" | "offline" | "unsupported";
}) {
  return (
    <div className={`empty empty--${variant}`} role="status">
      <h3 className="empty__heading">{heading}</h3>
      <div className="empty__body">{body}</div>
      {action !== undefined && <div className="empty__action">{action}</div>}
    </div>
  );
}

export function Warning({
  tone = "attention",
  title,
  children,
}: {
  tone?: StatusTone;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={`warning warning--${tone}`} role="note">
      <strong className="warning__title">{title}</strong>
      {children !== undefined && <div className="warning__body">{children}</div>}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="mono">{children}</code>;
}

/** Static skeleton rows — the spec forbids infinite shimmer. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton__row" key={i} />
      ))}
    </div>
  );
}

export function Tabs({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: { id: string; label: string; disabled?: boolean }[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          disabled={tab.disabled}
          className={`tabs__tab${tab.id === active ? " tabs__tab--active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Destructive confirmation (docs/specs/05 §5, §6 scenario 7). The caller must
 * state the real consequence and require a typed-in or clicked acknowledgement;
 * the dialog never defaults to "yes".
 *
 * Behaviour that must hold across parent re-renders (the task poll re-renders
 * parents every second with a fresh `onCancel`):
 * - the typed phrase resets only when the dialog OPENS, never mid-typing;
 * - initial focus goes to the phrase input, else Cancel — never the danger button;
 * - Tab/Shift+Tab are trapped inside the dialog; Escape cancels;
 * - focus returns to the element that opened it when it closes;
 * - the title id is unique per instance (`useId`), so two dialogs never collide.
 */
export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel,
  requirePhrase,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  consequence: ReactNode;
  confirmLabel: string;
  /** When set, the user must type this exact phrase to enable confirm. */
  requirePhrase?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [typedPhrase, setTypedPhrase] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  });
  const phraseSatisfied = confirmEnabled(requirePhrase, typedPhrase);

  // Reset ONLY on the closed → open transition.
  useEffect(() => {
    if (open) setTypedPhrase("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initial = dialog?.querySelector<HTMLElement>("[data-autofocus]");
    initial?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab" || dialog === null) return;
      const focusables = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      const active = document.activeElement;
      const current = focusables.findIndex((element) => element === active);
      const next = nextTrapIndex(focusables.length, current, event.shiftKey);
      event.preventDefault();
      if (next !== null) focusables[next]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="dialog__title">
          {title}
        </h2>
        <div className="dialog__body">{consequence}</div>
        {requirePhrase !== undefined && (
          <label className="dialog__phrase">
            <span>
              Type <Mono>{requirePhrase}</Mono> to enable this action.
            </span>
            <TextInput
              data-autofocus
              spellCheck={false}
              autoComplete="off"
              value={typedPhrase}
              onChange={(event) => setTypedPhrase(event.target.value)}
            />
          </label>
        )}
        <div className="dialog__actions">
          <Button
            variant="ghost"
            onClick={onCancel}
            {...(requirePhrase === undefined ? { "data-autofocus": true } : {})}
          >
            Cancel
          </Button>
          <Button variant="danger" disabled={!phraseSatisfied} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
