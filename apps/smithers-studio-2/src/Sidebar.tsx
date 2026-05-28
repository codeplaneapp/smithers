import { useStudioStore } from "./useStudioStore";

export function Sidebar() {
  const tabs = useStudioStore((s) => s.tabs);
  const activeTabId = useStudioStore((s) => s.activeTabId);
  const activeView = useStudioStore((s) => s.activeView);
  const { openTerminal, setActiveTabId, setActiveView, openPalette } = useStudioStore.getState();

  return (
    <aside aria-label="Studio navigation" className="sidebar">
      <div className="brand-block"><span>Smithers</span><strong>Studio 2</strong></div>

      {/* View Navigation */}
      <div className="sidebar-section">
        <div className="sidebar-heading">
          <span>Views</span>
        </div>
        <div className="view-list">
          <button
            className={`view-button ${activeView === "terminal" ? "active" : ""}`}
            onClick={() => setActiveView("terminal")}
            type="button"
          >
            Terminal
          </button>
          <button
            className={`view-button ${activeView === "issues" ? "active" : ""}`}
            onClick={() => setActiveView("issues")}
            type="button"
          >
            Issues
          </button>
          <button
            className={`view-button ${activeView === "landings" ? "active" : ""}`}
            onClick={() => setActiveView("landings")}
            type="button"
          >
            Landings
          </button>
          <button
            className={`view-button ${activeView === "workspaces" ? "active" : ""}`}
            onClick={() => setActiveView("workspaces")}
            type="button"
          >
            Workspaces
          </button>
        </div>
      </div>

      {/* Terminal Tabs - only show when terminal view is active */}
      {activeView === "terminal" && (
        <div className="sidebar-section">
          <div className="sidebar-heading">
            <span>Terminals</span>
            <button aria-label="New terminal" onClick={openTerminal} type="button">+</button>
          </div>
          <div aria-orientation="vertical" className="tab-list" role="tablist">
            {tabs.map((tab) => (
              <button
                aria-selected={tab.id === activeTabId}
                className={`tab-row ${tab.id === activeTabId ? "active" : ""}`}
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                role="tab"
                type="button"
              >
                <span>{tab.title}</span>
                <small>{tab.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="sidebar-footer">
        <button className="command-button" onClick={openPalette} type="button">
          <span>Command Palette</span>
          <kbd>Cmd-P</kbd>
        </button>
      </div>
    </aside>
  );
}
