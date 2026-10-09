/**
 * Shared primitives. Deliberately small: the design spec says to generalize only
 * what repeats, and Section 17's full shadcn/ui pass is deferred until the
 * workflows are functional. Every control is a native element with a token class,
 * so keyboard behaviour comes from the platform rather than from a dependency.
 */

import {
  forwardRef,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import type { StatusTone } from "../../lib/reducers";

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

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function TextInput({ invalid, className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={`input${className ? ` ${className}` : ""}`}
        aria-invalid={invalid ? true : undefined}
        {...rest}
      />
    );
  },
);

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
  const [typedPhrase, setTypedPhrase] = useState("");
  const phraseSatisfied = requirePhrase === undefined || typedPhrase === requirePhrase;

  useEffect(() => {
    if (!open) return;
    setTypedPhrase("");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-title" className="dialog__title">
          {title}
        </h2>
        <div className="dialog__body">{consequence}</div>
        {requirePhrase !== undefined && (
          <label className="dialog__phrase">
            <span>
              Type <Mono>{requirePhrase}</Mono> to enable this action.
            </span>
            <TextInput
              autoFocus
              spellCheck={false}
              value={typedPhrase}
              onChange={(event) => setTypedPhrase(event.target.value)}
            />
          </label>
        )}
        <div className="dialog__actions">
          <Button variant="ghost" onClick={onCancel}>
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
