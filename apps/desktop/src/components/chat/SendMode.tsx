/**
 * A4 surfaces: the composer's Task / Discuss choice and the read-only A4 facts
 * of a task (Send mode, the sandbox its chat chose). Every Core string is
 * revealed and capped by `taskSendFacts`; nothing here decides task state.
 */

import type { FeatureGate } from "../../lib/reducers";
import {
  SEND_MODE_COMPOSER_COPY,
  taskSendFacts,
  type SendChoice,
} from "../../lib/send-mode";
import type { TaskSummary } from "../../lib/protocol";
import { Mono } from "../ui/primitives";

const CHOICES: readonly { value: SendChoice; label: string }[] = [
  { value: "task", label: "Task" },
  { value: "discuss", label: "Discuss" },
];

/**
 * Task (default) / Discuss. Enabled only when Core advertises
 * `conversation-send-mode`; otherwise shown disabled with the reason, and the
 * caller never puts `mode` on the wire.
 */
export function SendModeChoice({
  gate,
  value,
  onChange,
}: {
  gate: FeatureGate;
  value: SendChoice;
  onChange: (next: SendChoice) => void;
}) {
  const enabled = gate.state === "supported";
  return (
    <fieldset className="send-mode" aria-describedby="send-mode-note">
      <legend>Send as</legend>
      {CHOICES.map((choice) => (
        <label key={choice.value} className="send-mode__option">
          <input
            type="radio"
            name="send-mode"
            value={choice.value}
            checked={(enabled ? value : "task") === choice.value}
            disabled={!enabled}
            onChange={() => onChange(choice.value)}
          />{" "}
          {choice.label}
        </label>
      ))}
      <p id="send-mode-note" className="muted">
        {enabled ? SEND_MODE_COMPOSER_COPY : gate.note}
      </p>
    </fieldset>
  );
}

/**
 * The A4 facts Core reported for one task; nothing when it reported none.
 * `inline` is the compact form for list rows (the caveat moves to a title).
 */
export function TaskSendFacts({
  task,
  inline = false,
}: {
  task: Pick<TaskSummary, "mode" | "chosenSandboxName"> | { mode: string | null; chosenSandboxName: string | null };
  inline?: boolean;
}) {
  const facts = taskSendFacts(task);
  if (facts.length === 0) return null;
  if (inline) {
    return (
      <span className="task-facts task-facts--inline">
        {facts.map((fact) => (
          <span key={fact.label} title={fact.note ?? undefined}>
            {" · "}
            {fact.label} <Mono>{fact.value}</Mono>
          </span>
        ))}
      </span>
    );
  }
  return (
    <dl className="task-facts">
      {facts.map((fact) => (
        <div key={fact.label} className="task-facts__row">
          <dt>{fact.label}</dt>
          <dd>
            <Mono>{fact.value}</Mono>
            {fact.note !== null && <span className="muted"> — {fact.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
