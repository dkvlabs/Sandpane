import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDeps } from "../../app/context";
import {
  cleanupOutcomeView,
  defaultSelection,
  groupMaintenanceItems,
  itemSizeText,
  maintenanceConfirmationView,
  maintenanceGate,
  MaintenanceFlow,
} from "../../lib/maintenance";
import type { CoreCapabilities, MaintenanceItem } from "../../lib/protocol";
import { Badge, Button, Mono, Panel, Warning } from "../../components/ui/primitives";
import { ConfirmDialog } from "../../components/ui/primitives";

/**
 * A9 Maintenance (design 2026-10-09 §3.9 item 7), gated on the `maintenance`
 * feature plus both methods. Everything the user sees is Core's own text
 * rendered as plain text: items, reasons, impact, skipped reasons and notes.
 * Scan and both cleanup steps run only on a user gesture; step 2 opens the
 * confirmation dialog from that gesture and the flow re-scans automatically
 * after it settles.
 */
export function MaintenancePanel({
  capabilities,
}: {
  capabilities: CoreCapabilities | null;
}) {
  const deps = useDeps();
  const gate = maintenanceGate(capabilities);
  const flowRef = useRef<MaintenanceFlow | null>(null);
  const flow = (flowRef.current ??= new MaintenanceFlow(deps.client));
  const state = useSyncExternalStore(flow.subscribe, flow.getState);
  const settled = flow.getSettled();
  // `scanError` is a stable reference between notifications (set on failure,
  // cleared on a good scan), so reading it live here is safe.
  const scanError = useSyncExternalStore(flow.subscribe, () => flow.scanError);
  // Re-render once a second while a confirmation is open, for the countdown.
  const [, tick] = useState(0);
  const confirming = state.kind === "confirming";
  useEffect(() => {
    if (!confirming) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, [confirming]);

  // Selection: reset to the defaults whenever a NEW inventory arrives (keyed
  // by the item ids, so re-rendering the same scan keeps the user's choices).
  const inventory = state.kind === "ready" ? state.inventory : null;
  const itemsKey = useMemo(
    () => (inventory ? inventory.items.map((i) => i.id).join("\n") : ""),
    [inventory],
  );
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (inventory) setChecked(defaultSelection(inventory.items));
    // itemsKey changes exactly when a fresh inventory replaced the old one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  if (gate.state !== "supported") {
    return (
      <Panel title="Maintenance" description="Clean up state Core itself created.">
        <p className="muted">{gate.note}</p>
      </Panel>
    );
  }

  const removableChecked = inventory
    ? inventory.items.filter((i) => i.removable && checked.has(i.id))
    : [];
  const unavailable = inventory?.unavailable ?? [];
  const confirmationView =
    state.kind === "confirming"
      ? maintenanceConfirmationView(state.confirmation, Date.now())
      : null;

  return (
    <Panel
      title="Maintenance"
      description="Clean up state Core itself created: temporary directories, migration backups and stored verification output. Worktrees are report-only."
    >
      <div className="row-actions">
        <Button onClick={() => void flow.scan()} disabled={flow.busy || confirming}>
          {state.kind === "scanning" ? "Scanning…" : "Scan"}
        </Button>
        <span className="muted">
          Nothing runs automatically; every scan and cleanup needs a click. Sandpane never spawns
          git or sbx for this.
        </span>
      </div>

      {scanError && (
        <Warning tone="attention" title={scanError.title}>
          {scanError.body} {scanError.action}
          {scanError.coreMessage ? ` (Core: ${scanError.coreMessage})` : null}
        </Warning>
      )}

      {settled?.kind === "done" && (
        <Warning tone="neutral" title={cleanupOutcomeView(settled.outcome, settled.confirmedCount).headline}>
          <CleanupOutcomeBody outcome={settled.outcome} confirmedCount={settled.confirmedCount} />
        </Warning>
      )}
      {settled?.kind === "failed" && (
        <Warning tone={settled.copy.title.includes("may have been removed") ? "attention" : "neutral"} title={settled.copy.title}>
          {settled.copy.body} {settled.copy.action}
          {settled.copy.coreMessage ? ` (Core: ${settled.copy.coreMessage})` : null}
        </Warning>
      )}
      {settled && (
        <div className="row-actions">
          <Button variant="ghost" onClick={() => flow.dismiss()}>
            Dismiss outcome
          </Button>
        </div>
      )}

      {inventory && (
        <>
          {inventory.truncated && (
            <Warning tone="attention" title="The scan was cut short">
              Core left items out of this list (too many entries, or the answer hit its size cap).
              Clean up what is listed, then scan again.
            </Warning>
          )}
          {unavailable.map((u) => (
            <Warning key={u.kind} tone="neutral" title={`${u.kind} could not be scanned`}>
              {u.reason}
            </Warning>
          ))}
          {inventory.items.length === 0 && (
            <p className="muted">Core found nothing to clean up.</p>
          )}
          {groupMaintenanceItems(inventory.items).map((group) => (
            <div key={group.kind} className="stack">
              <h3 className="panel__subsection">{group.label}</h3>
              <ul className="list">
                {group.items.map((item) => (
                  <MaintenanceRow
                    key={item.id}
                    item={item}
                    checked={checked.has(item.id)}
                    onToggle={(next) =>
                      setChecked((prev) => {
                        const copy = new Set(prev);
                        if (next) copy.add(item.id);
                        else copy.delete(item.id);
                        return copy;
                      })
                    }
                  />
                ))}
              </ul>
            </div>
          ))}
          {removableChecked.length > 0 && (
            <div className="row-actions">
              <Button
                variant="danger"
                disabled={flow.busy}
                onClick={() => void flow.beginCleanup(removableChecked.map((i) => i.id))}
              >
                Clean up {removableChecked.length} item{removableChecked.length === 1 ? "" : "s"}…
              </Button>
              <span className="muted">
                Migration backups are unchecked by default: they are the way back to an older Core.
                {checkedHasBackup(removableChecked)
                  ? " You have selected backup file(s) — they are deleted for good."
                  : ""}
              </span>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={state.kind === "confirming" && confirmationView !== null}
        title="Remove the selected items?"
        confirmLabel={
          confirmationView?.expired ? "Confirmation expired" : "Remove them (cannot be undone)"
        }
        confirmDisabled={confirmationView === null || confirmationView.expired || flow.busy}
        onCancel={() => flow.cancel()}
        onConfirm={() => {
          flow.confirm();
        }}
        consequence={
          confirmationView && (
            <div className="stack">
              <p>
                Core's confirmation of this exact item set is valid for{" "}
                {confirmationView.secondsLeft}s (until {confirmationView.expiresAtMs === null
                  ? "an unreadable expiry — treated as expired"
                  : new Date(confirmationView.expiresAtMs).toLocaleTimeString()}).
              </p>
              <ul className="bullets">
                {confirmationView.impactLines.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
              {confirmationView.overflowLine && <p className="muted">{confirmationView.overflowLine}</p>}
              <p className="muted">
                This cannot be undone. Items that changed since the scan are skipped and reported,
                not removed silently.
              </p>
              {confirmationView.revealedHiddenCharacters && (
                <p className="muted">
                  Some text from Core contained hidden or control characters; they are shown as
                  escapes.
                </p>
              )}
            </div>
          )
        }
      />
    </Panel>
  );
}

function checkedHasBackup(items: readonly MaintenanceItem[]): boolean {
  return items.some((i) => i.kind === "dbBackup");
}

function CleanupOutcomeBody({
  outcome,
  confirmedCount,
}: {
  outcome: Parameters<typeof cleanupOutcomeView>[0];
  confirmedCount: number;
}) {
  const view = cleanupOutcomeView(outcome, confirmedCount);
  return (
    <div className="stack">
      {view.freedText && <p>{view.freedText}</p>}
      {view.skippedLines.length > 0 && (
        <>
          <p>Not removed:</p>
          <ul className="bullets">
            {view.skippedLines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {view.noteLines.length > 0 && (
        <ul className="bullets">
          {view.noteLines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MaintenanceRow({
  item,
  checked,
  onToggle,
}: {
  item: MaintenanceItem;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (value: string, what: string) => {
    void globalThis.navigator?.clipboard?.writeText(value).then(
      () => {
        setCopied(what);
        window.setTimeout(() => setCopied(null), 2_000);
      },
      () => setCopied(null),
    );
  };
  const size = itemSizeText(item);
  return (
    <li className="row">
      <span className="row__title">
        {item.removable ? (
          <label className="check">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => onToggle(event.target.checked)}
            />
            <span>
              <Mono>{item.id}</Mono>
            </span>
          </label>
        ) : (
          <Mono>{item.id}</Mono>
        )}
        {size && <Badge tone="neutral">{size}</Badge>}
        {!item.removable && <Badge tone="neutral">report-only</Badge>}
      </span>
      <span className="row__meta">
        {item.detail}
        {item.reason ? ` — ${item.reason}` : ""}
      </span>
      {(item.path || item.repositoryPath) && (
        <span className="row__meta">
          {item.repositoryPath && (
            <>
              <Mono>{item.repositoryPath}</Mono>{" "}
              <Button variant="ghost" onClick={() => copy(item.repositoryPath ?? "", "repository")}>
                {copied === "repository" ? "Copied" : "Copy repository path"}
              </Button>
            </>
          )}
          {item.path && (
            <>
              {" "}
              <Mono>{item.path}</Mono>{" "}
              <Button variant="ghost" onClick={() => copy(item.path ?? "", "worktree")}>
                {copied === "worktree" ? "Copied" : "Copy worktree path"}
              </Button>
            </>
          )}
        </span>
      )}
    </li>
  );
}
