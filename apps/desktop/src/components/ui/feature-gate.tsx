import { Badge, Button, Mono, Warning } from "./primitives";
import type { FeatureGate } from "../../lib/reducers";

/**
 * One honest rendering of "does this Core have the method this view needs?".
 *
 * The three states must not collapse into each other:
 * * `supported` — no notice at all (a green banner saying "we have it" would be
 *   noise and, worse, an unverified claim about the running build).
 * * `unprobed` — pending. Saying "unsupported" before the probe answered would
 *   report a gap the app has not observed (AGENTS rule 5).
 * * `unsupported` — the additive method is missing from THIS Core, so the data
 *   does not exist here rather than being hidden.
 */
export function FeatureGateNotice({
  gate,
  title,
  onRetry,
}: {
  gate: FeatureGate;
  title: string;
  onRetry?: () => void;
}) {
  if (gate.state === "supported") return null;
  if (gate.state === "unprobed") {
    return (
      <Warning tone="neutral" title={`${title}: not probed yet`}>
        {gate.note}{" "}
        <Mono>system.probe</Mono> has to answer before this build can say either way.
      </Warning>
    );
  }
  return (
    <Warning tone="attention" title={`${title}: not available from this Core`}>
      {gate.note} Upgrade Core, then{" "}
      <Button variant="ghost" onClick={onRetry} disabled={onRetry === undefined}>
        re-check Core
      </Button>
      .
    </Warning>
  );
}

/** A compact chip showing whether an additive read is advertised. */
export function FeatureChip({ gate, method }: { gate: FeatureGate; method: string }) {
  const tone =
    gate.state === "supported" ? "success" : gate.state === "unprobed" ? "neutral" : "attention";
  const label =
    gate.state === "supported"
      ? `${method} advertised`
      : gate.state === "unprobed"
        ? `${method} unknown (not probed)`
        : `${method} absent`;
  return (
    <Badge tone={tone} title={gate.note}>
      {label}
    </Badge>
  );
}
