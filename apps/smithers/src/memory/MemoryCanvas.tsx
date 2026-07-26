import "./memory.css";
import {
  factAge,
  factsInNamespace,
  factValuePreview,
  formatTimestamp,
  formatTtl,
  namespaces,
  prettyValue,
  scoreTone,
  type MemoryFact,
  type RecallResult,
} from "./memoryFacts";
import { useMemoryStore, type MemoryMode } from "./memoryStore";

const MODES: { id: MemoryMode; label: string }[] = [
  { id: "facts", label: "Facts" },
  { id: "recall", label: "Recall" },
];

function BrainGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" width="22" height="22">
      <path
        d="M12 3a4 4 0 0 0-4 4 4 4 0 0 0-1 7 3 3 0 0 0 5 2 3 3 0 0 0 5-2 4 4 0 0 0-1-7 4 4 0 0 0-4-4z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" width="20" height="20" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M21 21l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function WarnGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" width="20" height="20" aria-hidden="true">
      <path d="M12 3l9 16H3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M12 10v4M12 17v.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The namespace filter: an All-Namespaces pill plus one per distinct namespace. */
function NamespaceFilter() {
  const facts = useMemoryStore((state) => state.facts);
  const active = useMemoryStore((state) => state.namespaceFilter);
  const setNamespaceFilter = useMemoryStore((state) => state.setNamespaceFilter);
  const options = namespaces(facts);

  return (
    <div className="mem-namespaces" data-testid="memory-namespaces">
      <button
        type="button"
        className={active === null ? "mem-ns-pill is-on" : "mem-ns-pill"}
        onClick={() => setNamespaceFilter(null)}
      >
        All Namespaces
      </button>
      {options.map((namespace) => (
        <button
          key={namespace}
          type="button"
          className={active === namespace ? "mem-ns-pill is-on" : "mem-ns-pill"}
          onClick={() => setNamespaceFilter(namespace)}
        >
          {namespace}
        </button>
      ))}
    </div>
  );
}

/** One row of the fact table; clicking it opens the inline detail. */
function FactRow({ fact, onOpen }: { fact: MemoryFact; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="mem-row" onClick={() => onOpen(fact.id)} data-testid="memory-fact-row">
      <span className="mem-col-ns">
        <span className="ns-chip">{fact.namespace}</span>
      </span>
      <span className="mem-col-key mem-key">{fact.key}</span>
      <span className="mem-col-value mem-value-preview">{factValuePreview(fact.value)}</span>
      <span className="mem-col-updated mem-age">{factAge(fact.updatedAtMs, Date.now())}</span>
    </button>
  );
}

/** The inline fact detail (replaces the table, not a new route). */
function FactDetail({ fact }: { fact: MemoryFact }) {
  const selectFact = useMemoryStore((state) => state.selectFact);

  return (
    <div className="mem-detail" data-testid="memory-fact-detail">
      <button type="button" className="mem-detail-back card-link" onClick={() => selectFact(null)}>
        ‹ Back to list
      </button>
      <div className="mem-detail-meta">
        <div className="mem-meta-row">
          <span className="mem-meta-label">Namespace</span>
          <span className="mem-meta-value">
            <span className="ns-chip">{fact.namespace}</span>
          </span>
        </div>
        <div className="mem-meta-row">
          <span className="mem-meta-label">Key</span>
          <span className="mem-meta-value mem-key">{fact.key}</span>
        </div>
        <div className="mem-meta-row">
          <span className="mem-meta-label">Updated</span>
          <span className="mem-meta-value">
            {formatTimestamp(fact.updatedAtMs)} · {factAge(fact.updatedAtMs, Date.now())}
          </span>
        </div>
        <div className="mem-meta-row">
          <span className="mem-meta-label">Created</span>
          <span className="mem-meta-value">{formatTimestamp(fact.createdAtMs)}</span>
        </div>
        {fact.ttlMs !== undefined ? (
          <div className="mem-meta-row">
            <span className="mem-meta-label">TTL</span>
            <span className="mem-meta-value">{formatTtl(fact.ttlMs)}</span>
          </div>
        ) : null}
      </div>
      <div className="mem-value-eyebrow">VALUE</div>
      <pre className="mem-value-block">{prettyValue(fact.value)}</pre>
    </div>
  );
}

/** Facts mode: the namespace filter + fact table, or the open fact detail. */
function FactsMode() {
  const facts = useMemoryStore((state) => state.facts);
  const namespaceFilter = useMemoryStore((state) => state.namespaceFilter);
  const selectFact = useMemoryStore((state) => state.selectFact);
  const selected = useMemoryStore((state) => state.facts.find((fact) => fact.id === state.selectedFactId) ?? null);

  // Stable order: most-recently-updated first, so the table reads top-down.
  const visible = factsInNamespace(facts, namespaceFilter).sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  if (selected) return <FactDetail fact={selected} />;

  return (
    <div className="mem-facts" data-testid="memory-facts">
      <NamespaceFilter />
      {visible.length > 0 ? (
        <div className="mem-table" data-testid="memory-table">
          <div className="mem-table-head">
            <span className="mem-col-ns">Namespace</span>
            <span className="mem-col-key">Key</span>
            <span className="mem-col-value">Value</span>
            <span className="mem-col-updated">Updated</span>
          </div>
          {visible.map((fact) => (
            <FactRow key={fact.id} fact={fact} onOpen={selectFact} />
          ))}
        </div>
      ) : (
        <div className="surface-empty mem-empty">
          <BrainGlyph />
          <span>No memory facts</span>
        </div>
      )}
    </div>
  );
}

/** One scored recall hit: a colored score, the content, an optional provenance. */
function RecallResultRow({ result }: { result: RecallResult }) {
  return (
    <div className="mem-result" data-testid="memory-result">
      <span className={`mem-result-score ${scoreTone(result.score)}`}>{result.score.toFixed(3)}</span>
      <div className="mem-result-body">
        <div className="mem-result-content">{result.content}</div>
        {result.metadata ? <div className="mem-result-meta">{result.metadata}</div> : null}
      </div>
    </div>
  );
}

/** Recall mode: a query box + topK control + scope hint, then scored results. */
function RecallMode() {
  const facts = useMemoryStore((state) => state.facts);
  const namespaceFilter = useMemoryStore((state) => state.namespaceFilter);
  const recallQuery = useMemoryStore((state) => state.recallQuery);
  const recallTopK = useMemoryStore((state) => state.recallTopK);
  const recallResults = useMemoryStore((state) => state.recallResults);
  const isRecalling = useMemoryStore((state) => state.isRecalling);
  const hasAttemptedRecall = useMemoryStore((state) => state.hasAttemptedRecall);
  const recallError = useMemoryStore((state) => state.recallError);
  const setRecallQuery = useMemoryStore((state) => state.setRecallQuery);
  const setRecallTopK = useMemoryStore((state) => state.setRecallTopK);
  const runRecall = useMemoryStore((state) => state.runRecall);

  const canSearch = recallQuery.trim() !== "";
  const sliderMax = Math.max(recallTopK, 50);
  const scopeLabel = namespaceFilter ?? "all namespaces";

  return (
    <div className="mem-recall" data-testid="memory-recall">
      <div className="mem-recall-input">
        <input
          className="field-input"
          placeholder="Semantic recall query..."
          value={recallQuery}
          onChange={(event) => setRecallQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") runRecall();
          }}
          data-testid="memory-recall-query"
        />
        <div className="mem-topk">
          <label className="mem-topk-label">Top-K</label>
          <input
            className="field-input mem-topk-input"
            type="number"
            min={1}
            value={recallTopK}
            onChange={(event) => setRecallTopK(Number(event.target.value))}
            data-testid="memory-topk-input"
          />
          <input
            className="mem-topk-slider"
            type="range"
            min={1}
            max={sliderMax}
            value={recallTopK}
            onChange={(event) => setRecallTopK(Number(event.target.value))}
            data-testid="memory-topk-slider"
          />
        </div>
        <button
          type="button"
          className="btn btn-brand"
          disabled={!canSearch || isRecalling}
          onClick={() => runRecall()}
          data-testid="memory-search"
        >
          {isRecalling ? "Searching…" : "Search"}
        </button>
      </div>

      <div className="mem-recall-scope">
        Semantic recall in: <b>{scopeLabel}</b>
      </div>

      {recallError ? (
        <div className="surface-empty mem-recall-state" data-testid="memory-recall-error">
          <WarnGlyph />
          <span>{recallError}</span>
        </div>
      ) : recallResults.length > 0 ? (
        <div className="mem-results" data-testid="memory-results">
          {recallResults.map((result, index) => (
            <RecallResultRow key={`${result.metadata ?? "r"}-${index}`} result={result} />
          ))}
        </div>
      ) : hasAttemptedRecall ? (
        <div className="surface-empty mem-recall-state" data-testid="memory-recall-empty">
          <SearchGlyph />
          <span>No results found.</span>
        </div>
      ) : (
        <div className="surface-empty mem-recall-state" data-testid="memory-recall-idle">
          <SearchGlyph />
          <span>Enter a query to search memory</span>
        </div>
      )}
    </div>
  );
}

/** The full Memory surface: a Facts table or a Recall query, toggled in the head. */
export function MemoryCanvas() {
  const facts = useMemoryStore((state) => state.facts);
  const mode = useMemoryStore((state) => state.mode);
  const namespaceFilter = useMemoryStore((state) => state.namespaceFilter);
  const setMode = useMemoryStore((state) => state.setMode);

  const visibleCount = factsInNamespace(facts, namespaceFilter).length;
  const nsCount = namespaces(facts).length;

  return (
    <section className="surface" data-testid="memory-canvas">
      <header className="surface-head">
        <span className="surface-title">Memory</span>
        <span className="surface-sub">
          {visibleCount} fact{visibleCount === 1 ? "" : "s"} · {nsCount} namespace
          {nsCount === 1 ? "" : "s"}
        </span>
        <div className="seg" data-testid="memory-mode">
          {MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={mode === option.id ? "is-on" : ""}
              onClick={() => setMode(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      <div className="mem-body">{mode === "facts" ? <FactsMode /> : <RecallMode />}</div>
    </section>
  );
}
