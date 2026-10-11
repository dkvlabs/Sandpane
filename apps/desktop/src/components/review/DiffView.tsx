/**
 * A5: one `git.diff` result, read-only. The patch is UNTRUSTED text: every
 * line is a React TEXT child of a `<pre>` (React escapes it), revealed and
 * capped by `patchView`, and a line that held hidden, control or bidi
 * characters is marked. Nothing here renders HTML, runs anything, or applies
 * the patch. File names come from the JSON `path` / `oldPath`, never the
 * patch header.
 */

import {
  DIFF_DISPLAY_ONLY_NOTE,
  DIFF_NAME_MAX_CHARS,
  diffDisclosures,
  patchView,
} from "../../lib/git-diff";
import type { GitDiffResult } from "../../lib/protocol";
import { displayRevealed, fileChangeLabel } from "../../lib/reducers";
import { Badge, Button, Mono } from "../ui/primitives";

export function DiffView({
  result,
  maxBytesSent,
  onCopy,
  copyNote = null,
}: {
  result: GitDiffResult;
  /** The clamped `maxBytes` this client sent; undefined = Core's default. */
  maxBytesSent: number | undefined;
  onCopy: () => void;
  /** Outcome of the last Copy (success or an honest failure), if any. */
  copyNote?: string | null;
}) {
  const disclosures = diffDisclosures(result, maxBytesSent);
  const view = result.binary ? { lines: [], hiddenLines: 0 } : patchView(result.patch);
  const name = displayRevealed(result.path, DIFF_NAME_MAX_CHARS);
  const unusualLines = view.lines.filter((line) => line.unusual).length;
  return (
    <section className="diff-view" aria-label="Diff">
      <header className="diff-view__header">
        <Mono>{name.text}</Mono>{" "}
        <Badge tone="neutral">{fileChangeLabel(result.status, result.unrecognizedStatus)}</Badge>
        {name.unusual && (
          <Badge tone="attention" title="The path contains hidden, control or look-alike characters, shown as \u escapes.">
            unusual characters
          </Badge>
        )}
      </header>
      {disclosures.length > 0 && (
        <ul className="diff-view__disclosures">
          {disclosures.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {unusualLines > 0 && (
        <p className="muted">
          {unusualLines} line(s) contain hidden, control or direction-changing characters; they are
          marked and shown as \u escapes.
        </p>
      )}
      {view.lines.length > 0 && (
        <pre className="diff-view__patch" tabIndex={0}>
          {view.lines.map((line, index) => (
            <span
              key={index}
              className={`diff-line diff-line--${line.kind}`}
              data-unusual={line.unusual ? "true" : undefined}
            >
              <span className="diff-line__mark" aria-hidden="true">
                {line.unusual ? "!" : " "}
              </span>
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
      {view.hiddenLines > 0 && (
        <p className="muted">
          …{view.hiddenLines} more line(s) not shown here; Copy copies the whole patch Core returned.
        </p>
      )}
      <div className="row-actions">
        <Button variant="ghost" onClick={onCopy} disabled={result.binary || result.patch.length === 0}>
          Copy
        </Button>
        {copyNote !== null && <span className="muted">{copyNote}</span>}
      </div>
      <p className="muted">{DIFF_DISPLAY_ONLY_NOTE}</p>
    </section>
  );
}
