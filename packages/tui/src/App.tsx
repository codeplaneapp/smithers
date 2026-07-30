import { useState, type ReactNode } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useKeymap } from "./Keybindings.tsx";
import { Header } from "./Header.tsx";
import { OverlayOpenContext } from "./OverlayContext.tsx";
import { TreeMode } from "./modes/TreeMode.tsx";
import { GraphMode } from "./modes/GraphMode.tsx";
import { LogMode } from "./modes/LogMode.tsx";
import { TimelineMode } from "./modes/TimelineMode.tsx";
import { HijackMode } from "./modes/HijackMode.tsx";
import { RunsListMode, TextInputCaptureContext } from "./modes/RunsListMode.tsx";

export type Mode = 1 | 2 | 3 | 4 | 5 | 6;

const COMPACT_WIDTH = 100;

function ModeBody({
  runId,
  mode,
  treeSelectedNodeKey,
  onSelectNodeKey,
  onSelectRun,
  onBack,
}: {
  runId: string;
  mode: Mode;
  treeSelectedNodeKey: string | null;
  onSelectNodeKey: (nodeKey: string) => void;
  onSelectRun: (runId: string) => void;
  onBack: () => void;
}) {
  switch (mode) {
    case 1:
      return <TreeMode runId={runId} initialSelectedNodeKey={treeSelectedNodeKey} />;
    case 2:
      return <GraphMode runId={runId} onSelectNodeKey={onSelectNodeKey} />;
    case 3:
      return <LogMode runId={runId} />;
    case 4:
      return <TimelineMode runId={runId} />;
    case 5:
      return <HijackMode runId={runId} onBack={onBack} />;
    case 6:
      return <RunsListMode onSelectRun={onSelectRun} />;
  }
}

// In Tree mode (1), keys 1-4 are the inspector TABS — not mode switches — and
// modes are reached via the g/l/t/h letter aliases. Advertise those so the
// keybar matches actual behavior instead of the default 1-5 mode list.
const TREE_KEYBAR_ENTRIES: { key: string; description: string }[] = [
  { key: "1-4", description: "Tabs" },
  { key: "g", description: "Graph" },
  { key: "l", description: "Logs" },
  { key: "t", description: "Timeline" },
  { key: "h", description: "Hijack" },
  { key: "r", description: "Runs" },
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
  // Tree mode rebinds 1-4 to inspector tabs, so the global 1-5 mode list would
  // be a lie there. Show Tree's actual bindings (tabs + g/l/t/h) when in Tree,
  // and the global 1-5 mode list everywhere else — mirroring the Keybar.
  const entries = mode === 1 ? TREE_KEYBAR_ENTRIES : keymap.entries;
  // Absolutely positioned ON TOP of the (still-mounted) active mode — swapping
  // the mode out for the overlay would unmount it and destroy its local state
  // (tree selection, scrub position, log filter). The panel carries an opaque
  // background so the mode underneath doesn't bleed through it.
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <box
        width={48}
        flexDirection="column"
        border={true}
        borderColor="#00d7ff"
        backgroundColor="#101018"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        <text fg="#00d7ff"> Keybindings</text>
        <text> </text>
        {entries.map((e) => (
          <text key={e.key} fg="#cccccc">{`  ${e.key.padEnd(3)} ${e.description}`}</text>
        ))}
        <text> </text>
        {mode === 1 ? (
          <text fg="#888888"> 1-4 select an inspector tab in Tree</text>
        ) : (
          <text fg="#888888"> g/l/t/h switch mode from Tree</text>
        )}
        <text fg="#555555"> ? or Esc to close</text>
      </box>
    </box>
  );
}

/**
 * Body layout shared by {@link App} and the render tests: the active mode stays
 * MOUNTED (all its local state intact) while the help overlay renders
 * absolutely positioned on top. `OverlayOpenContext` tells every mode's key
 * handler to ignore keys while the overlay is open — useKeyboard listeners are
 * independent subscriptions, so App's own early-return can't swallow keys for
 * them. `helpMode` is the mode whose bindings the overlay shows (null = closed).
 */
export function AppBody({ helpMode, children }: { helpMode: Mode | null; children: ReactNode }) {
  return (
    <OverlayOpenContext.Provider value={helpMode !== null}>
      <box width="100%" flexGrow={1}>
        {children}
        {helpMode !== null ? <HelpOverlay mode={helpMode} /> : null}
      </box>
    </OverlayOpenContext.Provider>
  );
}

/** What a global key should do, routed by {@link routeAppKey}. */
export type AppKeyAction =
  | { kind: "exit"; code?: number }
  | { kind: "toggle-help" }
  | { kind: "close-help" }
  | { kind: "set-mode"; mode: Mode }
  | { kind: "toggle-graph" };

/**
 * Route a global key event to an app action. Pure and exported so the quit /
 * help-overlay / mode-switch contract is unit-testable against REAL
 * parseKeypress events. The rules that earned their comments:
 *
 * - Ctrl-C quits through the same teardown as `q` (the renderer runs with
 *   exitOnCtrlC:false — we own the quit path), but carries exit code 130
 *   (128 + SIGINT) so shell scripts can tell a keyboard interrupt from a
 *   clean `q` quit — the same convention index.tsx's signal handlers use.
 * - Any OTHER ctrl/meta chord is a no-op: parseKeypress maps Ctrl+letter
 *   control bytes (and Alt+letter) to the plain letter name with ctrl/meta
 *   set, so without this a reflexive Ctrl-L (terminal redraw habit) would
 *   switch to Logs and Ctrl-Q would quit — none of which are documented.
 * - While the help overlay is open only Esc (close) and the overlay's own
 *   advertised `q Quit` do anything; modes gate their keys on
 *   OverlayOpenContext.
 * - Tree mode owns 1-4 for its inspector tabs, so 1-6 switch modes only
 *   OUTSIDE Tree; the letter aliases (g/l/t/h/r) always work.
 * - Shift+L is Timeline's "back to live" (it arrives as name "l" + shift, the
 *   parser lowercases shifted letters), so only the bare `l` is the Logs
 *   alias. `q` matches Shift+Q too (name stays "q") — a literal "Q" never
 *   occurs.
 */
export function routeAppKey(
  event: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean },
  ctx: { mode: Mode; showHelp: boolean; keysCaptured?: boolean },
): AppKeyAction | null {
  const { name, ctrl, meta, shift } = event;
  if (ctrl && name === "c") return { kind: "exit", code: 130 };
  if (ctrl || meta) return null;
  // A mounted mode is consuming text. OpenTUI sends the key to every
  // subscription, so suppress all app bindings; Escape still reaches the
  // mode's listener and Ctrl-C remains the one global escape hatch above.
  if (ctx.keysCaptured) return null;
  if (name === "?") return { kind: "toggle-help" };
  if (ctx.showHelp) {
    if (name === "escape") return { kind: "close-help" };
    if (name === "q") return { kind: "exit" };
    return null;
  }
  if (ctx.mode !== 1) {
    if (name === "1") return { kind: "set-mode", mode: 1 };
    if (name === "2") return { kind: "set-mode", mode: 2 };
    if (name === "3") return { kind: "set-mode", mode: 3 };
    if (name === "4") return { kind: "set-mode", mode: 4 };
    if (name === "5") return { kind: "set-mode", mode: 5 };
    if (name === "6") return { kind: "set-mode", mode: 6 };
  }
  if (name === "g") return { kind: "toggle-graph" };
  if (name === "l" && !shift) return { kind: "set-mode", mode: 3 };
  if (name === "t") return { kind: "set-mode", mode: 4 };
  if (name === "h") return { kind: "set-mode", mode: 5 };
  if (name === "r") return { kind: "set-mode", mode: 6 };
  if (name === "q") return { kind: "exit" };
  return null;
}

export function App({ runId, onExit }: { runId: string; onExit: (code: number) => void }) {
  const [mode, setMode] = useState<Mode>(1);
  // The run the modes inspect. Starts at the CLI-provided runId (unchanged
  // `smithers-mon <runId>` behavior); Runs mode (6) lets the operator switch
  // to a different run on the same gateway without restarting the process.
  const [activeRunId, setActiveRunId] = useState(runId);
  const [treeSelectedNodeKey, setTreeSelectedNodeKey] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [keysCaptured, setKeysCaptured] = useState(false);
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;

  useKeyboard((e) => {
    const action = routeAppKey(e, { mode, showHelp, keysCaptured });
    if (!action) return;
    switch (action.kind) {
      case "exit":
        return onExit(action.code ?? 0);
      case "toggle-help":
        return setShowHelp((prev) => !prev);
      case "close-help":
        return setShowHelp(false);
      case "toggle-graph":
        return setMode((prev) => (prev === 2 ? 1 : 2));
      case "set-mode":
        return setMode(action.mode);
    }
  });

  function handleSelectNodeKey(nodeKey: string) {
    setTreeSelectedNodeKey(nodeKey);
    setMode(1);
  }

  function handleSelectRun(nextRunId: string) {
    setActiveRunId(nextRunId);
    setTreeSelectedNodeKey(null);
    setMode(1);
  }

  return (
    <box width="100%" height="100%" flexDirection="column">
      <Header runId={activeRunId} compact={compact} />
      <TextInputCaptureContext.Provider value={setKeysCaptured}>
        <AppBody helpMode={showHelp ? mode : null}>
          <ModeBody
            runId={activeRunId}
            mode={mode}
            treeSelectedNodeKey={treeSelectedNodeKey}
            onSelectNodeKey={handleSelectNodeKey}
            onSelectRun={handleSelectRun}
            onBack={() => setMode(1)}
          />
        </AppBody>
      </TextInputCaptureContext.Provider>
      <Keybar compact={compact} mode={mode} />
    </box>
  );
}
