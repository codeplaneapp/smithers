import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { TerminalWorkspace } from "./TerminalWorkspace";
import { useHotkey } from "./useHotkey";
import { useStudioStore } from "./useStudioStore";

export default function App() {
  const paletteOpen = useStudioStore((s) => s.paletteOpen);
  const { openPalette, openTerminal } = useStudioStore.getState();

  useHotkey("p", openPalette);
  useHotkey("t", openTerminal);

  return (
    <main className="studio-shell">
      <Sidebar />
      <TerminalWorkspace />
      {paletteOpen ? <CommandPalette /> : null}
    </main>
  );
}
