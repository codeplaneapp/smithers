import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { TerminalWorkspace } from "./TerminalWorkspace";
import { IssuesPanel } from "./IssuesPanel";
import { LandingsPanel } from "./LandingsPanel";
import { WorkspacesPanel } from "./WorkspacesPanel";
import { useHotkey } from "./useHotkey";
import { useStudioStore } from "./useStudioStore";

export default function App() {
  const activeView = useStudioStore((s) => s.activeView);
  const paletteOpen = useStudioStore((s) => s.paletteOpen);
  const { openPalette, openTerminal } = useStudioStore.getState();

  useHotkey("p", openPalette);
  useHotkey("k", openPalette);
  useHotkey("t", openTerminal);

  return (
    <main className="studio-shell">
      <Sidebar />

      <div className="main-content">
        {activeView === "terminal" && <TerminalWorkspace />}
        {activeView === "issues" && <IssuesPanel />}
        {activeView === "landings" && <LandingsPanel />}
        {activeView === "workspaces" && <WorkspacesPanel />}
      </div>

      {paletteOpen ? <CommandPalette /> : null}
    </main>
  );
}
