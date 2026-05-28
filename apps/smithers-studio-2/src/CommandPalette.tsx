import { useMemo } from "react";
import { useStudioStore } from "./useStudioStore";

type PaletteAction = { id: string; label: string; hint: string; run: () => void };

export function CommandPalette() {
  const tabs = useStudioStore((s) => s.tabs);
  const paletteQuery = useStudioStore((s) => s.paletteQuery);
  const selectedPaletteIndex = useStudioStore((s) => s.selectedPaletteIndex);
  const { openTerminal, setActiveTabId, closePalette, setPaletteQuery, setSelectedPaletteIndex } = useStudioStore.getState();

  const paletteActions = useMemo<PaletteAction[]>(() => [
    { id: "new-terminal", label: "New Terminal", hint: "Open a new terminal tab", run: openTerminal },
    ...tabs.map((tab) => ({
      id: `focus-${tab.id}`,
      label: `Focus ${tab.title}`,
      hint: "Switch terminal tab",
      run: () => {
        setActiveTabId(tab.id);
        closePalette();
      },
    })),
  ], [tabs]);

  const filteredActions = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase();
    return query
      ? paletteActions.filter((action) => `${action.label} ${action.hint}`.toLowerCase().includes(query))
      : paletteActions;
  }, [paletteActions, paletteQuery]);

  return (
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closePalette()}>
      <div aria-label="Command palette" className="command-palette" data-testid="command-palette" role="dialog">
        <input
          autoFocus
          onChange={(event) => setPaletteQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") closePalette();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelectedPaletteIndex((index) => Math.min(index + 1, filteredActions.length - 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelectedPaletteIndex((index) => Math.max(index - 1, 0));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              filteredActions[selectedPaletteIndex]?.run();
            }
          }}
          placeholder="Type a command"
          value={paletteQuery}
        />
        <div className="palette-list">
          {filteredActions.length === 0 ? <div className="palette-empty">No commands found.</div> : filteredActions.map((action, index) => (
            <button className={index === selectedPaletteIndex ? "selected" : ""} key={action.id} onClick={action.run} onMouseEnter={() => setSelectedPaletteIndex(index)} type="button">
              <span>{action.label}</span>
              <small>{action.hint}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
