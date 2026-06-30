import { useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRun } from "./data.ts";
import { useKeymap } from "./Keybindings.tsx";
import { TreeMode } from "./modes/TreeMode.tsx";
import { GraphMode } from "./modes/GraphMode.tsx";
import { LogMode } from "./modes/LogMode.tsx";
import { TimelineMode } from "./modes/TimelineMode.tsx";
import { HijackMode } from "./modes/HijackMode.tsx";

type Mode = 1 | 2 | 3 | 4 | 5;

const COMPACT_WIDTH = 100;

function Header({ runId, compact }: { runId: string; compact: boolean }) {
  const { data, loading } = useRun(runId);
  const status = loading ? "connecting…" : (data?.status ?? "unknown");
  const label = compact ? `${runId} [${status}]` : `smithers-mon  run: ${runId}  status: ${status}`;
  return (
    <box width="100%" height={1}>
      <text fg="#00d7ff">{label}</text>
    </box>
  );
}

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

function Keybar({ compact }: { compact: boolean }) {
  const keymap = useKeymap();
  const sep = compact ? " " : "   ";
  const fmt = (e: { key: string; description: string }) =>
    compact ? `[${e.key}]${e.description}` : `[${e.key}] ${e.description}`;
  return (
    <box width="100%" height={1}>
      <text fg="#888888">{keymap.entries.map(fmt).join(sep)}</text>
    </box>
  );
}

export function App({ runId }: { runId: string }) {
  const [mode, setMode] = useState<Mode>(1);
  const [treeSelectedNodeId, setTreeSelectedNodeId] = useState<string | null>(null);
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;

  useKeyboard((e) => {
    if (e.name === "1") setMode(1);
    else if (e.name === "2") setMode(2);
    else if (e.name === "3") setMode(3);
    else if (e.name === "4") setMode(4);
    else if (e.name === "5") setMode(5);
    else if (e.name === "g") setMode((prev) => (prev === 2 ? 1 : 2));
    else if (e.name === "l") setMode(3);
    else if (e.name === "t") setMode(4);
    else if (e.name === "h") setMode(5);
    else if (e.name === "q" || e.name === "Q") process.exit(0);
  });

  function handleSelectNode(nodeId: string) {
    setTreeSelectedNodeId(nodeId);
    setMode(1);
  }

  return (
    <box width="100%" height="100%" flexDirection="column">
      <Header runId={runId} compact={compact} />
      <box width="100%" flexGrow={1}>
        <ModeBody
          runId={runId}
          mode={mode}
          treeSelectedNodeId={treeSelectedNodeId}
          onSelectNode={handleSelectNode}
          onBack={() => setMode(1)}
        />
      </box>
      <Keybar compact={compact} />
    </box>
  );
}
