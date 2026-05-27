import { useStudioStore } from "./useStudioStore";

export function Sidebar() {
  const tabs = useStudioStore((s) => s.tabs);
  const activeTabId = useStudioStore((s) => s.activeTabId);
  const { openTerminal, setActiveTabId, openPalette } = useStudioStore.getState();

  return (
    <aside aria-label="Terminal tabs" className="sidebar">
      <div className="brand-block"><span>Smithers</span><strong>Studio 2</strong></div>
      <div className="sidebar-heading">
        <span>Terminals</span>
        <button aria-label="New terminal" onClick={openTerminal} type="button">+</button>
      </div>
      <div aria-orientation="vertical" className="tab-list" role="tablist">
        {tabs.map((tab) => (
          <button aria-selected={tab.id === activeTabId} className={`tab-row ${tab.id === activeTabId ? "active" : ""}`} key={tab.id} onClick={() => setActiveTabId(tab.id)} role="tab" type="button">
            <span>{tab.title}</span>
            <small>{tab.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
          </button>
        ))}
      </div>
      <button className="command-button" onClick={openPalette} type="button"><span>Command Palette</span><kbd>Cmd-P</kbd></button>
    </aside>
  );
}
