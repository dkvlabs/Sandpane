/**
 * A6: one `git.apply` outcome (`applyOutcomeCopy` / `applyFailureCopy`).
 * Core's reason is shown revealed and capped as a TEXT child; a partial is a
 * danger-toned warning, never a success; "Review again" appears only when the
 * copy offers it.
 */

import type { ApplyCopy } from "../../lib/git-apply";
import { Button, Warning } from "../ui/primitives";

export function ApplyOutcome({ copy, onReReview }: { copy: ApplyCopy; onReReview: () => void }) {
  return (
    <Warning tone={copy.tone} title={copy.title}>
      {copy.reason !== null && (
        <p>
          Core said: <span className="mono">{copy.reason}</span>
        </p>
      )}
      <p>{copy.action}</p>
      {copy.details.length > 0 && (
        <ul className="apply-confirm__list">
          {copy.details.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      {copy.reReview && (
        <Button variant="ghost" onClick={onReReview}>
          Review again
        </Button>
      )}
    </Warning>
  );
}
