import type { DiffFile } from "./Diff";
import { paginateHunks, PAGINATE_THRESHOLD, PAGINATE_VISIBLE, fileLineCount } from "./diffPaginate";

const SIGN: Record<string, string> = { context: " ", add: "+", del: "−" };

/**
 * Render a file's unified diff grouped into hunks. Each hunk is a `@@ … @@`
 * header row (a "···" gutter plus the header text) above its line rows, and
 * every line row has TWO line-number gutters — old then new — a sign glyph, and
 * the text. When the file exceeds the pagination threshold we render only the
 * first chunk and surface an "Expand remaining N lines" button unless the caller
 * says the tail has been revealed.
 *
 * `revealed` and `onReveal` are threaded from the canvas/store so the pagination
 * state lives in zustand, not here.
 */
export function DiffHunks({
  file,
  revealed = true,
  onReveal,
}: {
  file: DiffFile;
  revealed?: boolean;
  onReveal?: () => void;
}) {
  const total = fileLineCount(file);
  const paginated = total > PAGINATE_THRESHOLD && !revealed;
  const visibleCount = paginated ? PAGINATE_VISIBLE : total;
  const { hunks, hidden } = paginateHunks(file, visibleCount);

  return (
    <div className="diff">
      {hunks.map((hunk, hunkIndex) => (
        <div key={hunk.header || hunkIndex}>
          {hunk.header ? (
            <div className="diff-hunk-head">
              <span className="diff-hunk-gutter">···</span>
              <span className="diff-hunk-header">{hunk.header}</span>
            </div>
          ) : null}
          {hunk.lines.map((line, lineIndex) => (
            <div className={`diff-line ${line.kind}`} key={lineIndex}>
              <span className="diff-ln diff-ln-old">{line.lnOld ?? ""}</span>
              <span className="diff-ln diff-ln-new">{line.ln ?? ""}</span>
              <span className="diff-sign">{SIGN[line.kind]}</span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
      {paginated && hidden > 0 ? (
        <div className="diff-paginate">
          <button className="diff-paginate-btn" type="button" onClick={onReveal}>
            Expand remaining {hidden} lines
          </button>
        </div>
      ) : null}
    </div>
  );
}
