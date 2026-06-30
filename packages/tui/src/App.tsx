import { useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useKeymap } from "./Keybindings.tsx";
import { Header } from "./Header.tsx";
import { TreeMode } from "./modes/TreeMode.tsx";
import { GraphMode } from "./modes/GraphMode.tsx";
import { LogMode } from "./modes/LogMode.tsx";
import { TimelineMode } from "./modes/TimelineMode.tsx";
import { HijackMode } from "./modes/HijackMode.tsx";

type Mode = 1 | 2 | 3 | 4 | 5;

const COMPACT_WIDTH = 100;

function ModeBody({
  runId,
  mode,
  treeSelectedNodeId,
  onSelectNode,
  onBack,
}: {
  runId: string;
  mode: Mode;
  treeSelectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onBack: () => void;
}) {
  switch (mode) {
    case 1: return <TreeMode runId={runId} initialSelectedNodeId={treeSelectedNodeId} />;
    case 2: return <GraphMode runId={runId} onSelectNode={onSelectNode} />;
    case 3: return <LogMode runId={runId} />;
    case 4: return <TimelineMode runId={runId} />;
    case 5: return <HijackMode runId={runId} onBack={onBack} />;
  }
}

// In Tree mode (1), keys 1-5 are the inspector TABS — not mode switches — and
// modes are reached via the g/l/t/h letter aliases. Advertise those so the
// keybar matches actual behavior instead of the default 1-5 mode list.
const TREE_KEYBAR_ENTRIES: { key: string; description: string }[] = [
  { key: "1-5", description: "Tabs" },
  { key: "g", description: "Graph" },
  { key: "l", description: "Logs" },
  { key: "t", description: "Timeline" },
  { key: "h", description: "Hijack" },
  { key: "q", description: "Quit" },
  { key: "?", description: "Help" },
];

function Keybar({ compact, mode }: { compact: boolean; mode: Mode }) {
  const keymap = useKeymap();
  const entries = mode === 1 ? TREE_KEYBAR_ENTRIES : keymap.entries;
  const sep = compact ? " " : "   ";
  const fmt = (e: { key: string; description: string }) =>
    compact ? `[${e.key}]${e.description}` : `[${e.key}] ${e.description}`;
  return (
    <box width="100%" height={1}>
      <text fg="#888888">{entries.map(fmt).join(sep)}</text>
    </box>
  );
}

function HelpOverlay({ mode }: { mode: Mode }) {
  const keymap = useKeymap();
  // Tree mode rebinds 1-5 to inspector tabs, so the global 1-5 mode list would
  // be a lie there. Show Tree's actual bindings (tabs + g/l/t/h) when in Tree,
  // and the global 1-5 mode list everywhere else — mirroring the Keybar.
  const entries = mode === 1 ? TREE_KEYBAR_ENTRIES : keymap.entries;
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <box
        width={48}
        flexDirection="column"
        border={true}
        borderColor="#00d7ff"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        <text fg="#00d7ff">  Keybindings</text>
        <text> </text>
        {entries.map((e) => (
          <text key={e.key} fg="#cccccc">{`  ${e.key.padEnd(3)} ${e.description}`}</text>
        ))}
        <text> </text>
        {mode === 1 ? (
          <text fg="#888888">  1-5 select an inspector tab in Tree</text>
        ) : (
          <text fg="#888888">  g/l/t/h  switch mode from Tree</text>
        )}
        <text fg="#555555">  ? or Esc to close</text>
      </box>
    </box>
  );
}

export function App({ runId, onExit }: { runId: string; onExit: (code: number) => void }) {
  const [mode, setMode] = useState<Mode>(1);
  const [treeSelectedNodeId, setTreeSelectedNodeId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;

  useKeyboard((e) => {
    // Ctrl-C quits through the same teardown as `q`. The renderer was created
    // with exitOnCtrlC:false so OpenTUI won't intercept it and bypass our
    // cleanup — we own the quit path and route it through onExit.
    if (e.ctrl && e.name === "c") return onExit(0);
    // `?` toggles the help overlay; Esc closes it. While open, the overlay
    // swallows other keys so they don't leak through to the active mode.
    if (e.name === "?") return setShowHelp((prev) => !prev);
    if (showHelp) {
      if (e.name === "escape") setShowHelp(false);
      return;
    }
    // Tree mode owns 1-5 for its inspector tabs, so don't also treat them as
    // global mode switches there (that collision would steal the tab keys and
    // unmount the tree on every 2-5 press). Use 1 to return to Tree from any
    // other mode; the letter aliases (g/l/t/h) switch modes from within Tree.
    if (mode !== 1) {
      if (e.name === "1") return setMode(1);
      if (e.name === "2") return setMode(2);
      if (e.name === "3") return setMode(3);
      if (e.name === "4") return setMode(4);
      if (e.name === "5") return setMode(5);
    }
    if (e.name === "g") setMode((prev) => (prev === 2 ? 1 : 2));
    else if (e.name === "l") setMode(3);
    else if (e.name === "t") setMode(4);
    else if (e.name === "h") setMode(5);
    else if (e.name === "q" || e.name === "Q") onExit(0);
  });

  function handleSelectNode(nodeId: string) {
    setTreeSelectedNodeId(nodeId);
    setMode(1);
  }

  return (
    <box width="100%" height="100%" flexDirection="column">
      <Header runId={runId} compact={compact} />
      <box width="100%" flexGrow={1}>
        {showHelp ? (
          <HelpOverlay mode={mode} />
        ) : (
          <ModeBody
            runId={runId}
            mode={mode}
            treeSelectedNodeId={treeSelectedNodeId}
            onSelectNode={handleSelectNode}
            onBack={() => setMode(1)}
          />
        )}
      </box>
      <Keybar compact={compact} mode={mode} />
    </box>
  );
}
