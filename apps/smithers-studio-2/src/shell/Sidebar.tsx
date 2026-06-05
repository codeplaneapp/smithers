import { useStudioStore } from "../useStudioStore";
import type { NavItem } from "./navRegistry";
import { NavRow } from "./NavRow";
import { SidebarSection } from "./SidebarSection";
import { useSidebarSectionExpansion } from "./useSidebarSectionExpansion";

const STUDIO_VERSION = "0.1.0";

export type SidebarProps = {
  registry: NavItem[];
};

/**
 * Registry-driven sidebar. Renders NAVIGATION (primary tier) + a collapsible
 * TERMINALS list (only while Workspace is active) + a collapsed-by-default More
 * group + a Developer group (present only when developer items are registered)
 * + a pinned footer. Phase-2 surface agents never edit this file — they add a
 * registry entry and the row appears in the right section automatically.
 */
export function Sidebar({ registry }: SidebarProps) {
  const activeView = useStudioStore((s) => s.activeView);
  const tabs = useStudioStore((s) => s.tabs);
  const activeTabId = useStudioStore((s) => s.activeTabId);
  const { setActiveView, setActiveTabId, openTerminal, openPalette, setShellMode } = useStudioStore.getState();

  const [moreExpanded, toggleMore] = useSidebarSectionExpansion("more", false);
  const [terminalsExpanded, toggleTerminals] = useSidebarSectionExpansion("terminals", true);

  const primary = registry.filter((item) => item.tier === "primary");
  const more = registry.filter((item) => item.tier === "more");
  const developer = registry.filter((item) => item.tier === "developer");

  return (
    <aside aria-label="Studio navigation" className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-glyph" aria-hidden>
          {"\u{1F528}"}
        </span>
        <strong className="sidebar-brand-name">Smithers Studio</strong>
        <button
          className="sidebar-back-to-chat"
          data-testid="back-to-chat"
          onClick={() => setShellMode("chat")}
          title="Back to the chat shell"
          type="button"
        >
          ← Chat
        </button>
      </div>

      <nav className="sidebar-nav">
        <SidebarSection title="Navigation">
          {primary.map((item) => (
            <NavRow active={activeView === item.id} item={item} key={item.id} onSelect={setActiveView} />
          ))}
        </SidebarSection>

        {activeView === "workspace" ? (
          <SidebarSection
            expanded={terminalsExpanded}
            collapsible
            onToggle={toggleTerminals}
            title="Terminals"
          >
            <div aria-orientation="vertical" className="sidebar-terminals" role="tablist">
              {tabs.map((tab) => (
                <button
                  aria-selected={tab.id === activeTabId}
                  className={`sidebar-terminal-row${tab.id === activeTabId ? " sidebar-terminal-row--active" : ""}`}
                  key={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  role="tab"
                  type="button"
                >
                  <span>{tab.title}</span>
                  <small>{tab.createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
                </button>
              ))}
              <button className="sidebar-terminal-new" onClick={openTerminal} type="button">
                + New terminal
              </button>
            </div>
          </SidebarSection>
        ) : null}

        <SidebarSection expanded={moreExpanded} collapsible onToggle={toggleMore} title="More">
          {more.map((item) => (
            <NavRow active={activeView === item.id} item={item} key={item.id} onSelect={setActiveView} />
          ))}
        </SidebarSection>

        {developer.length > 0 ? (
          <SidebarSection title="Developer">
            {developer.map((item) => (
              <NavRow active={activeView === item.id} item={item} key={item.id} onSelect={setActiveView} />
            ))}
          </SidebarSection>
        ) : null}
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-command" onClick={openPalette} type="button">
          <span>Command Palette</span>
          <kbd>⌘P</kbd>
        </button>
        <div className="sidebar-footer-meta">
          <span className="sidebar-version">v{STUDIO_VERSION}</span>
        </div>
      </div>
    </aside>
  );
}
