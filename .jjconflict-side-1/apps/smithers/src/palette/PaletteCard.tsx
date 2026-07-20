import { openSurface } from "../app/navigation";
import { fileName, rankFiles, WORKSPACE_FILES } from "./palette";
import { usePaletteStore } from "./paletteStore";

/** The seeded query the card previews — believable for the quick-open pitch. */
const PREVIEW_QUERY = "canvas";

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The inline palette card: the top fuzzy matches for a seeded query + a jump
 *  to the full quick-open surface. Mirrors VcsCard's compact preview + link. */
export function PaletteCard() {
  const mentionFile = usePaletteStore((state) => state.mentionFile);
  const matches = rankFiles(PREVIEW_QUERY, WORKSPACE_FILES, 4);

  return (
    <article className="list-card palette-card" data-testid="palette-card">
      <header className="card-head">
        <span className="card-icon">
          <SearchIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Quick open</div>
          <div className="card-sub">
            Fuzzy <code className="palette-mention-chip">{PREVIEW_QUERY}</code> · {matches.length} match
            {matches.length === 1 ? "" : "es"}
          </div>
        </div>
        <button className="card-link" type="button" onClick={() => openSurface({ kind: "palette" })}>
          Open quick-open ›
        </button>
      </header>

      <div className="card-body card-body-flush">
        {matches.map((item) => (
          <div className="list-row" key={item.id}>
            <span className="palette-row-icon">
              <SearchIcon />
            </span>
            <div className="list-text">
              <div className="list-name">{fileName(item.value)}</div>
              <div className="list-meta">{item.value}</div>
            </div>
            <div className="list-tags">
              <button
                className="palette-mention-chip"
                type="button"
                onClick={() => mentionFile(item.value)}
              >
                @ mention
              </button>
            </div>
          </div>
        ))}
      </div>

      <footer className="card-foot">
        <button className="btn btn-brand" type="button" onClick={() => openSurface({ kind: "palette" })}>
          Search files
        </button>
      </footer>
    </article>
  );
}
