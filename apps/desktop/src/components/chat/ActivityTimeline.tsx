import { useState } from "react";
import type { TaskProjection, TimelineEntry } from "../../lib/reducers";
import { displayPath, taskStatusView, windowEntries } from "../../lib/reducers";
import { Badge, Button, EmptyState, Mono, Panel, Warning } from "../ui/primitives";

/**
 * Compact agent-activity timeline (design spec S03: "not a raw console dump").
 * Rendering is bounded by `maxVisible`; the remainder stays in Core and is
 * revealed on request, so a 2,000-event task cannot grow the DOM without limit.
 */
export function ActivityTimeline({
  projection,
  maxVisible,
}: {
  projection: TaskProjection | null;
  maxVisible: number;
}) {
  const [showAll, setShowAll] = useState(false);
  if (projection === null) {
    return (
      <EmptyState
        heading="No task selected"
        body="Send a message to create a task, or pick one from Tasks & Review. Events stream from Core's durable log, so this fills in as sequences arrive."
      />
    );
  }
  const { visible, hiddenBefore } = windowEntries(projection.entries, maxVisible);
  const shown = showAll ? projection.entries : visible;

  return (
    <div className="timeline">
      <div className="timeline__head">
        <span className="timeline__title">Agent activity</span>
        <Badge tone={taskStatusView(projection.status, projection.unrecognizedStatus).tone}>
          {taskStatusView(projection.status, projection.unrecognizedStatus).label}
        </Badge>
        <span className="timeline__meta">
          sequence {projection.lastSequence} · {projection.entries.length} event(s)
        </span>
      </div>

      <p className="timeline__note">
        {taskStatusView(projection.status, projection.unrecognizedStatus).note}
      </p>

      {projection.replayGap !== null && (
        <Warning
          tone="attention"
          title={`Replay gap between sequence ${projection.replayGap.from} and ${projection.replayGap.to}`}
        >
          Events exist that this pass did not return. They stay in Core's log; the UI does not
          fill them in by inference.
        </Warning>
      )}

      {projection.changedFiles.length > 0 && (
        <div className="timeline__files">
          {projection.changedFiles.map((path, index) => (
            <span key={`${index}:${path}`} className="pill">
              <Mono>{displayPath(path).text}</Mono>
            </span>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="muted">
          No events folded yet for <Mono>{projection.taskId.slice(0, 8)}</Mono>.
        </p>
      ) : (
        <ol className="timeline__list">
          {shown.map((entry, index) => (
            <TimelineRow key={`${entry.sequence}-${index}`} entry={entry} />
          ))}
        </ol>
      )}

      {hiddenBefore > 0 && !showAll && (
        <div className="row-actions">
          <Button variant="ghost" onClick={() => setShowAll(true)}>
            Show {hiddenBefore} earlier event(s)
          </Button>
          <span className="muted">
            Bounded DOM: {hiddenBefore} earlier entries hidden (change the limit in Settings).
          </span>
        </div>
      )}
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  switch (entry.kind) {
    case "user-message":
      return (
        <li className="timeline__row timeline__row--user">
          <span className="timeline__who">You</span>
          <span className="timeline__text">{entry.text}</span>
          <Seq entry={entry} />
        </li>
      );
    case "agent-message":
      return (
        <li className="timeline__row timeline__row--agent">
          <span className="timeline__who">Agent</span>
          <span className="timeline__text">{entry.text}</span>
          <Seq entry={entry} />
        </li>
      );
    case "status": {
      const view = taskStatusView(entry.status, entry.raw);
      return (
        <li className="timeline__row timeline__row--status">
          <Badge tone={view.tone}>{view.label}</Badge>
          <Seq entry={entry} />
        </li>
      );
    }
    case "tool":
      return (
        <li className="timeline__row timeline__row--tool">
          <ToolDisclosure entry={entry} />
          <Seq entry={entry} />
        </li>
      );
    case "file":
      return (
        <li className="timeline__row">
          <span className="timeline__text">
            changed <Mono>{displayPath(entry.path).text}</Mono>
          </span>
          <Seq entry={entry} />
        </li>
      );
    case "approval":
      return (
        <li className="timeline__row timeline__row--attention">
          <Warning tone="attention" title="Approval required">
            {entry.description} <Mono>{entry.requestId}</Mono>
            <p className="muted">
              Approving agent actions is a DT3 deliverable — protocol v1 has no approval response
              method, so this cannot be answered from the desktop yet.
            </p>
          </Warning>
          <Seq entry={entry} />
        </li>
      );
    case "error":
      return (
        <li className="timeline__row timeline__row--error">
          {entry.code !== undefined && <Badge tone="danger">{entry.code}</Badge>}
          <span className="timeline__text">{entry.message}</span>
          <Seq entry={entry} />
        </li>
      );
    case "unmodelled":
      return (
        <li className="timeline__row timeline__row--unknown">
          <Badge tone="neutral">{entry.eventKind}</Badge>
          <span className="timeline__text">{entry.detail}</span>
          <Seq entry={entry} />
        </li>
      );
  }
}

function Seq({ entry }: { entry: TimelineEntry }) {
  return (
    <span className="timeline__seq">
      #{entry.sequence} · {entry.timestamp}
    </span>
  );
}

function ToolDisclosure({
  entry,
}: {
  entry: Extract<TimelineEntry, { kind: "tool" }>;
}) {
  const state =
    entry.ok === undefined ? "running" : entry.ok ? "ok" : "failed";
  return (
    <details className="disclosure">
      <summary>
        <span className={`dot dot--${state}`} aria-hidden="true" />
        {entry.name ?? (entry.toolId.length > 0 ? entry.toolId : "tool")} — {state}
      </summary>
      <div className="disclosure__body">
        <Mono>{entry.toolId}</Mono>
        {entry.summary !== undefined && <p>{entry.summary}</p>}
        {entry.ok === undefined && (
          <p className="muted">
            No tool.finished event yet for this id, so completion is unknown rather than assumed.
          </p>
        )}
      </div>
    </details>
  );
}

export function TaskHeader({ projection }: { projection: TaskProjection | null }) {
  if (projection === null) return null;
  const view = taskStatusView(projection.status, projection.unrecognizedStatus);
  return (
    <Panel title={<Mono>{projection.taskId}</Mono>} tone={view.tone}>
      <div className="badges">
        <Badge tone={view.tone}>{view.label}</Badge>
        {projection.conversationId !== null && (
          <Badge tone="neutral">conversation {projection.conversationId.slice(0, 8)}</Badge>
        )}
        {projection.unknownKinds.length > 0 && (
          <Badge tone="attention">{projection.unknownKinds.length} unmodelled kind(s)</Badge>
        )}
      </div>
      <p className="muted">{view.note}</p>
    </Panel>
  );
}
