import { Suspense } from "react";
import { GhosttyTerminalPane } from "./GhosttyTerminalPane";
import { useStudioStore } from "./useStudioStore";

export function TerminalWorkspace() {
  const tabs = useStudioStore((s) => s.tabs);
  const activeTabId = useStudioStore((s) => s.activeTabId);
  const { closeTerminal } = useStudioStore.getState();

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  return (
    <section aria-label="Terminal workspace" className="workspace">
      <header className="workspace-header">
        <div><span>Active terminal</span><h1>{activeTab?.title ?? "Terminal"}</h1></div>
        <button
          data-testid="close-terminal"
          disabled={tabs.length === 1}
          onClick={() => activeTab && closeTerminal(activeTab.id)}
          type="button"
        >
          Close Tab
        </button>
      </header>
      <div className="terminal-stack">
        <Suspense fallback={<div className="terminal-loading">Loading Ghostty terminal.</div>}>
          {tabs.map((tab) => (
            <div className={tab.id === activeTabId ? "terminal-tab active" : "terminal-tab"} data-testid="terminal-tab" key={tab.id}>
              <GhosttyTerminalPane active={tab.id === activeTabId} tab={tab} />
            </div>
          ))}
        </Suspense>
      </div>
    </section>
  );
}
