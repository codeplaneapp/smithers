import "./palette.css";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import {
  buildResults,
  modeLabel,
  parseQuery,
  sections,
  type PaletteItem,
  type PaletteItemKind,
  type PaletteMode,
} from "./palette";
import { usePaletteStore } from "./paletteStore";

/** The mode tabs that prepend a sigil when clicked (open-anything has no sigil). */
const MODE_TABS: { mode: PaletteMode; label: string }[] = [
  { mode: "open", label: "All" },
  { mode: "files", label: "@ Files" },
  { mode: "commands", label: "> Commands" },
  { mode: "slash", label: "/ Slash" },
  { mode: "ask", label: "? Ask AI" },
];

function MagnifierIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3ZM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Pick the leading glyph for a result row by its kind. */
function RowIcon({ kind }: { kind: PaletteItemKind }) {
  switch (kind) {
    case "file":
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
          <path
            d="M6 3h8l4 4v14H6V3Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M14 3v4h4" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      );
    case "workspace":
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3 9h18" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case "command":
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
          <path
            d="M9 9V6a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v3m0 6v3a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2v-3m0-6h6v6H9V9Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "slash":
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
          <path d="M15 4 9 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "ask":
      return <SparklesIcon />;
  }
}

/** Render a title/path with the fuzzy-matched character positions accented. */
function Highlighted({ text, matches }: { text: string; matches: number[] }) {
  if (matches.length === 0) return <>{text}</>;
  const set = new Set(matches);
  const parts: ReactNode[] = [];
  let run = "";
  let runMatched = set.has(0);
  for (let i = 0; i < text.length; i += 1) {
    const matched = set.has(i);
    if (matched !== runMatched) {
      parts.push(
        runMatched ? (
          <mark className="palette-match" key={`m${i}`}>
            {run}
          </mark>
        ) : (
          <span key={`s${i}`}>{run}</span>
        ),
      );
      run = "";
      runMatched = matched;
    }
    run += text[i];
  }
  parts.push(
    runMatched ? (
      <mark className="palette-match" key="last">
        {run}
      </mark>
    ) : (
      <span key="last">{run}</span>
    ),
  );
  return <>{parts}</>;
}

/** One result row; clicking selects + executes, mirroring the keyboard path. */
function ResultRow({
  item,
  index,
  selected,
}: {
  item: PaletteItem;
  index: number;
  selected: boolean;
}) {
  const setSelectedIndex = usePaletteStore((state) => state.setSelectedIndex);
  const execute = usePaletteStore((state) => state.execute);

  const classes = ["palette-row"];
  if (selected) classes.push("is-selected");
  if (item.disabled) classes.push("is-disabled");

  return (
    <button
      type="button"
      className={classes.join(" ")}
      disabled={item.disabled}
      onMouseEnter={() => setSelectedIndex(index)}
      onClick={() => {
        setSelectedIndex(index);
        execute();
      }}
      data-testid="palette-row"
    >
      <span className="palette-row-icon">
        <RowIcon kind={item.kind} />
      </span>
      <span className="palette-row-text">
        <span className="palette-row-title">
          <Highlighted text={item.title} matches={item.titleMatches} />
        </span>
        {item.subtitle ? (
          <span className="palette-row-sub">
            {item.kind === "file" ? (
              <Highlighted text={item.subtitle} matches={item.subtitleMatches} />
            ) : (
              item.subtitle
            )}
          </span>
        ) : null}
      </span>
      {item.shortcut ? <span className="palette-row-shortcut">{item.shortcut}</span> : null}
    </button>
  );
}

/** The command palette / quick-open surface: an input that drives a result list. */
export function PaletteCanvas() {
  const query = usePaletteStore((state) => state.query);
  const selectedIndex = usePaletteStore((state) => state.selectedIndex);
  const files = usePaletteStore((state) => state.files);
  const workspaces = usePaletteStore((state) => state.workspaces);
  const commands = usePaletteStore((state) => state.commands);
  const slashCommands = usePaletteStore((state) => state.slashCommands);
  const recentPaths = usePaletteStore((state) => state.recentPaths);
  const setQuery = usePaletteStore((state) => state.setQuery);
  const moveSelection = usePaletteStore((state) => state.moveSelection);
  const setMode = usePaletteStore((state) => state.setMode);
  const tabComplete = usePaletteStore((state) => state.tabComplete);
  const execute = usePaletteStore((state) => state.execute);
  const askAi = usePaletteStore((state) => state.askAi);
  const close = usePaletteStore((state) => state.close);

  const parsed = parseQuery(query);
  const items = buildResults(parsed, { files, recentPaths, workspaces, commands, slashCommands });
  const grouped = sections(items);
  const count = items.length;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveSelection(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveSelection(-1);
        return;
      case "Enter":
        event.preventDefault();
        execute();
        return;
      case "Escape":
        event.preventDefault();
        close();
        return;
      case "Tab":
        event.preventDefault();
        tabComplete();
        return;
    }
  };

  return (
    <section className="surface" data-testid="palette-canvas">
      <header className="surface-head">
        <div className="palette-input">
          <span className="palette-input-icon">
            <MagnifierIcon />
          </span>
          <input
            aria-label="Command palette"
            autoComplete="off"
            placeholder="Type a command or search…"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            data-testid="palette-input"
          />
        </div>
        {parsed.sigil ? <span className="palette-sigil">{parsed.sigil}</span> : null}
        <span className="palette-mode-label">{modeLabel(parsed.mode)}</span>
      </header>

      <div className="palette-tabs" data-testid="palette-tabs">
        {MODE_TABS.map((tab) => (
          <button
            key={tab.mode}
            type="button"
            className={parsed.mode === tab.mode ? "palette-tab is-on" : "palette-tab"}
            onClick={() => setMode(tab.mode)}
          >
            {tab.label}
          </button>
        ))}
        <span className="palette-count" data-testid="palette-count">
          {count} result{count === 1 ? "" : "s"}
        </span>
      </div>

      {count > 0 ? (
        <div className="palette-results" data-testid="palette-results">
          {grouped.map((group) => (
            <div key={group.section}>
              <div className="palette-section-head">{group.label}</div>
              {group.items.map(({ item, index }) => (
                <ResultRow
                  key={item.id}
                  item={item}
                  index={index}
                  selected={index === selectedIndex}
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="palette-empty" data-testid="palette-empty">
          <SparklesIcon />
          <div>No matching results</div>
          {parsed.searchText ? (
            <button type="button" className="palette-empty-ask" onClick={askAi}>
              Ask AI: {parsed.searchText}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
