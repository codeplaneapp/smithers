import { openSurface } from "../app/navigation";
import { AUTH_REFACTOR_DIFF } from "./authRefactorDiff";
import { detectBinary, diffTotals } from "./diffPaginate";
import { useDiffStore } from "./diffStore";
import { DiffHunks } from "./DiffHunks";

function DiffIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M6 3v12a3 3 0 0 0 3 3h6M18 21v-6M18 9V3M6 3a2 2 0 1 0 0 .01M18 21a2 2 0 1 0 0-.01M18 9a2 2 0 1 0 0-.01"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The inline diff card: file tabs + the selected file's hunks (Image: Diff). */
export function DiffCard({ runId }: { runId: string }) {
  const diff = AUTH_REFACTOR_DIFF;
  const totals = diffTotals(diff);
  // Selection is owned by diffStore now; the card keys it by runId so the chat
  // card and the canvas keep their own active file independently.
  const active = useDiffStore((state) => state.activeByDiff[runId] ?? 0);
  const selectFile = useDiffStore((state) => state.selectFile);
  const file = diff.files[active];

  return (
    <article className="diff-card" data-testid="diff-card">
      <header className="card-head">
        <span className="card-icon">
          <DiffIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">{diff.title}</div>
          <div className="card-sub">
            {totals.files} files · <span className="delta-add">+{totals.add}</span>{" "}
            <span className="delta-del">−{totals.del}</span>
          </div>
        </div>
        <button
          className="card-link"
          type="button"
          onClick={() => openSurface({ kind: "diff", runId, diffId: diff.id })}
        >
          Review in canvas ›
        </button>
      </header>

      <div className="card-body">
        <div className="file-tabs">
          {diff.files.map((entry, index) => (
            <button
              key={entry.path}
              type="button"
              className={index === active ? "file-tab is-on" : "file-tab"}
              onClick={() => selectFile(runId, index)}
            >
              {entry.path}
            </button>
          ))}
        </div>
        {file && detectBinary(file) ? (
          <div className="diff-binary-body">Binary file</div>
        ) : file ? (
          <DiffHunks file={file} />
        ) : null}
      </div>
    </article>
  );
}
