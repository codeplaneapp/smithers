# Single-Run Monitor TUI - Engineering Spec

**Status**: Draft  
**Date**: 2026-06-30

---

## 1. Goal & How It Ships

The single-run monitor TUI is a full-screen terminal UI launched from the `bunx smithers-orchestrator up --interactive` flow (`apps/cli/src/tui.js` → `runTuiCommand`). Instead of clack cards streaming down the terminal, the user gets a persistent, keyboard-driven, five-mode monitor that stays live for the full lifetime of a run.

**Entry points:**

- `bunx smithers-orchestrator up --interactive` / `bunx smithers-orchestrator up -i <workflow>` - existing flag; picks/starts a run, then hands off to the monitor.
- `bunx smithers-orchestrator up -i` with no workflow argument - shows the fuzzy workflow picker (reusing existing `fuzzySelect` + `buildWorkflowPickerOptions` logic from `tui.js`), then monitors the selected run.

**How it ships (as built):** `runTuiCommand` is retained; it still owns the pre-fullscreen picker/input prompts and starting the run. After the run starts it spawns the monitor as a child process via the `smithers-mon` bin (the `@smithers-orchestrator/tui` package's `bin`, resolved by `resolveTuiEntry()`), passing the `runId` and forwarding `SMITHERS_CLI` / `SMITHERS_GATEWAY_URL`. The monitor (`packages/tui/src/index.tsx`) is a bin entry script, **not** an exported `runTuiMonitor(runId, opts)` function. When the `smithers-mon` bin can't be resolved (e.g. a slim install), `runTuiCommand` falls back to the inline `streamRun` append-only path so the run is still observable. There is no `up --run-id` attach mode.

---

## 2. Runtime & Stack

| Layer | Package | Notes |
|---|---|---|
| Runtime | Bun (>=1.1) | All IO, child process, WebSocket global |
| TUI renderer | `@opentui/core` | Zig-native core via Bun FFI; `createCliRenderer` |
| React reconciler | `@opentui/react` | `createRoot(renderer).render(...)` |
| React | `react` 19 (peer) | Standard reconciler; `react-dom` is a peer of `@opentui/react` |
| JSX | **`jsxImportSource: "@opentui/react"`** | The OpenTUI React JSX runtime, **NOT** plain `react` and **NOT** `smithers-orchestrator`'s jsx-runtime. OpenTUI's runtime supplies the intrinsic element types (`box`/`text`/`select`/`scrollbox`/`code`/`diff`…) so the TUI's JSX type-checks. The smithers jsx-runtime is only for workflow definition files. |
| Data | `smithers-orchestrator/gateway-react` | `SmithersGatewayProvider` + gateway hooks |

**Critical JSX note**: `packages/tui` sets `jsxImportSource: "@opentui/react"` at the `tsconfig` level (so every file uses the OpenTUI React JSX runtime, which declares the OpenTUI intrinsic elements). Never use plain `react` (its JSX runtime has no OpenTUI element types) and never use the `smithers-orchestrator` jsx runtime here - that runtime is exclusively for `.tsx` workflow files that use smithers's declarative task DSL.

---

## 3. Data Layer

### Provider setup

The TUI uses the same gateway hooks as the web UI. There is no DB adapter dependency in this package. All data flows through the Gateway HTTP/WebSocket API.

```
SmithersGatewayClient({
  baseUrl: "http://127.0.0.1:7331",    // default; overridable via env / CLI flag
  WebSocket: globalThis.WebSocket,      // Bun exposes WebSocket globally - inject it
})
```

**No OPFS / navigator persistence.** `createGatewayPersistence` calls `navigator.*` APIs that do not exist in Bun. Pass no `persistence` option to `createGatewayCollections`. The in-memory sync backend (no-persistence path) works correctly headless.

**No `createGatewayReactRoot`.** That helper wraps `react-dom/client` and is for browser contexts. Use `@opentui/react`'s `createRoot` directly.

**Gateway autostart (as built)**: When the user has NOT pinned an explicit gateway (`--gateway` / `SMITHERS_GATEWAY_URL`), `index.tsx` probes `http://127.0.0.1:7331` and, if unreachable, spawns the resolved CLI's `gateway` subcommand (`bunx smithers-orchestrator gateway --host 127.0.0.1 --port <port>`, detached, via `cliEntry.ts` - never `process.argv[1]`, which would recursively relaunch the monitor) and waits for it to answer. If the user DID pin a gateway and it is unreachable, the monitor errors out with a "start it with `bunx smithers-orchestrator gateway`" hint instead of autostarting a local one it would never connect to. There is no `--background` flag.

### Hook inventory

| Hook | Source | Feeds |
|---|---|---|
| `useGatewayRun(runId)` | `gateway-react` | Header status dot, workflow name, model, run state, frame counter |
| `useGatewayRunEvents(runId, { maxEvents: 2000 })` | `gateway-react` | LOGS mode transcript; TIMELINE tick strip (seq numbers → frame markers) |
| `useGatewayNodeOutput({ runId, nodeId, iteration })` | `gateway-react` | NodeInspector Output tab; TREE node metadata/elapsed |
| `useGatewayApprovals({ runId })` | `gateway-react` | Approval banner in TREE mode; gate markers in TIMELINE. Exposes `refetch`, called after a successful `submitApproval` so the resolved gate's banner clears. |
| `useGatewayNodeDiff` (via `getNodeDiff` RPC) | `gateway-react` | NodeInspector Diff tab (gated on the tab being active) |
| `useGatewayActions()` | `gateway-react` | Only `submitApproval` (approve/deny a gate in TREE). The monitor does NOT cancel/resume/rewind from actions - those are CLI-driven; HIJACK shells out to `bunx smithers-orchestrator hijack`. |

The `useGatewayRun` hook drives the header and is polled via the collection's built-in live-stream (no polling interval needed). `useGatewayRunEvents` drives both the LOGS stream and the TIMELINE scrubber; the DevTools frame protocol (`packages/protocol/src/devtools`) parses `DevToolsSnapshot` and `DevToolsDelta` payloads from `FrameCommitted` events to reconstruct the node tree at each frame.

---

## 4. Bootstrap / Provider Stack

> **As built:** the bootstrap below runs at module top-level in `packages/tui/src/index.tsx`, the `smithers-mon` **bin entry script** (a child process). There is NO exported `runTuiMonitor(runId, opts)` function and no `import { runTuiMonitor }` call site - the entry parses `argv`, probes/autostarts the gateway, then mounts. The sketch is illustrative of that same top-level wiring (`exitOnCtrlC: false`, `onExit` teardown).

```tsx
/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayProvider } from "@smithers-orchestrator/gateway-react";
import { App } from "./App.tsx";

// Top-level in the bin entry - not an exported function.
const { runId, gatewayUrl } = parseArgs(process.argv.slice(2));
await ensureGatewayReachable(gatewayUrl); // probe; autostart `bunx smithers-orchestrator gateway` if unpinned & down

const client = new SmithersGatewayClient({
  baseUrl: gatewayUrl,
  WebSocket: globalThis.WebSocket, // Bun global
});

const renderer = createCliRenderer({ exitOnCtrlC: false });
const root = createRoot(renderer);
root.render(
  <SmithersGatewayProvider client={client}>
    <App runId={runId} onExit={() => { root.unmount(); renderer.destroy(); process.exit(0); }} />
  </SmithersGatewayProvider>
);
```

`exitOnCtrlC: false` because the TUI routes `q` / `Q` / Ctrl-C (and external SIGINT/SIGTERM/SIGHUP) through its own `onExit` teardown rather than letting the renderer hard-exit. There is no in-TUI run-cancel; cancel from the CLI.

---

## 5. Five Modes

All five modes share:
- A **persistent header** (1 row).
- A **bottom keybar** (1 row) showing the relevant keybindings for the active mode.
- The remaining terminal height for the mode body.

### Header layout (all modes)

```
● workflow-name  run-abc123  claude-opus-4-8  02:34  f14/21  [live]
```

Fields, left to right:
- **Status dot** - `●` colored: green = running, yellow = waiting-approval/event/timer, red = failed, dim = done/cancelled.
- **Workflow name** - from `useGatewayRun().data.workflowName`.
- **Short run id** - first 12 chars.
- **Model** - from run metadata.
- **Elapsed** - ticking `mm:ss` counter from run `createdAtMs`.
- **Frame counter** - `fn/total` from `FrameCommitted` event count vs `useGatewayRunEvents` total seq.
- **live|paused** - `[live]` while following events; `[f14]` while frozen on frame 14 in TIMELINE mode.

### Mode 1: TREE (default)

**Layout**: horizontal split.

- **Left pane** (`<scrollbox>`, ~40% width): collapsible node tree.
  - Each row: `indent + chevron + glyph + label + right-aligned elapsed/meta`
  - Chevron: `▾` expanded, `▸` collapsed, `·` leaf.
  - Glyph: `✓` finished, `●` running, `⏸` waiting, `○` pending, `✗` failed.
  - j/k / arrow keys move cursor; `space` folds/unfolds; `⏎` selects node → updates right pane.
  - Data: `useGatewayRunEvents` + DevTools snapshot/delta reconstruction.

- **Right pane** (`NodeInspector`): tabbed panel for the selected node.
  - Tabs: **Output** / **Logs** / **Diff** / **Props**. (There is no Tools tab: the gateway exposes no per-node tool-call stream to the monitor; tool calls live only in the durable store and are surfaced by `bunx smithers-orchestrator node`, so an always-empty tab would be dishonest.)
  - Auto-default per node kind:
    - Has output → Output tab.
    - Currently running → Logs tab.
    - Container/parallel node → Props tab.
  - **Output tab**: `<code>` block with formatted node output from `useGatewayNodeOutput`.
  - **Logs tab**: scrollable `<scrollbox>` of agent transcript events filtered to this node from `useGatewayRunEvents`.
  - **Diff tab**: unified-diff **text** rendered in a `<code filetype="diff">` block (a summary line + the patch), fetched lazily via the `getNodeDiff` RPC only while this tab is active. It does **not** use an OpenTUI `<diff>` primitive. Falls back to a stat summary or an explicit empty/loading state.
  - **Props tab**: `<code filetype="json">` block with node metadata - `id`, `key` (the unique row key), `iteration`, `name`, `kind`, `status`, `agent`, `meta`, `cardLabel`, `parentId`, `childIds`. `key` + `iteration` distinguish repeated logical nodes (loop/retry attempts).
  - Tab switching: `1`–`4` (output/logs/diff/props) or left/right arrows when inspector is focused.

- **Approval banner**: when `useGatewayApprovals({ runId }).data` has a pending item, a highlighted overlay row appears above the keybar: `[approval needed: <label>]  a approve  d deny`. Keys `a`/`d` call `actions.submitApproval`.

### Mode 2: GRAPH

**Layout**: full-body `<box>` canvas.

- Nodes rendered as `<box>` cards with a title line (glyph + label) and a status-colored border.
- Cards joined by ASCII arrows `──▶` laid out in topological order (left to right, depth = column, breadth = row).
- Card border colors mirror the glyph palette (green/blue/yellow/dim/red).
- Scrolling: j/k move viewport; `⏎` on a node jumps to TREE mode with that node selected.
- Data: same DevTools snapshot as TREE mode.
- `g` toggles between TREE and GRAPH.

### Mode 3: LOGS

**Layout**: full-body `<scrollbox>`.

- Live agent transcript - the mapped run events from `useGatewayRunEvents`, interleaved in seq order.
- Each line: `seq [nodeId] │ event text`. (No side-effect badges: the gateway maps no tool-call events into the run-event stream, so a read/write/shell badge would never fire on a real run.)
- **Follow mode**: on by default. Scrollbox auto-scrolls to bottom as new events arrive. `f` toggles follow; the `[live]`/`[paused]` indicator in the header reflects this.
- `[`/`]` walk backward/forward across node attempts (filters events to the selected attempt).
- Data: `useGatewayRunEvents` with `maxEvents: 2000`.

### Mode 4: TIMELINE

**Layout**: horizontal split.

- **Top strip** (`<scrollbox>` horizontal): tick bar of run events. Notable frames (first agent event, gate raises) are marked; gate/approval frames stand out. The selected frame is highlighted.
- **Body**: node state inspected as of the selected frame, reconstructed from the event history.
- **Inspect-only**: this is an event timeline you *scrub* to read run history; it deliberately offers **no** fork/rewind/replay/jump mutations. Wiring a "rewind" here would either no-op or rewind to a guessed frame, so the timeline stays honest and points you at the durable command instead: rewind a run with `bunx smithers-orchestrator rewind` (fork with `bunx smithers-orchestrator fork`, replay with `bunx smithers-orchestrator replay`).
- **Keys**: `j`/`k` (or `←`/`→`) scrub events; `L` returns to the live head.
- Data: `useGatewayRunEvents` (full event buffer); no mutating actions.

### Mode 5: HIJACK

**Activation**: press `h` while a node is running (cursor on a running node in TREE mode).

**Flow (as built)**:
1. A `<select>` overlay lists the hijackable (running) nodes - resolved from the run tree + live-session signal in the event stream. Pick one to confirm, or cancel.
2. On confirm:
   a. The renderer is suspended, yielding the terminal back to raw stdio.
   b. The monitor shells out to `bunx smithers-orchestrator hijack RUN_ID --target NODE_ID` via the resolved CLI entry, inheriting stdio (the CLI spawns `claude --resume` / `codex resume` / etc.).
   c. The cleanup kills the child (whole process group on POSIX) and restores the renderer on every exit path, including unmount mid-session.
3. On the native CLI exit the renderer resumes and a return banner shows. **There is no in-TUI "resume automation" action**: `bunx smithers-orchestrator hijack` itself resumes the run when the session exits cleanly on a live run, so the banner only reports what happened -
   - clean exit (code 0): "Smithers automation resumed (handled by hijack on clean exit)."
   - non-zero exit: "Run left as-is - re-run hijack to retry the hand-off."
4. The banner offers only `[d] dismiss`.

---

## 6. Full Keymap & Responsive / Compact Behavior

### Global keys (all modes)

These are the keys actually wired in `App.tsx`. (There is intentionally no global cancel/resume/copy key; drive those from the CLI: `bunx smithers-orchestrator cancel`, `bunx smithers-orchestrator up --resume`, etc.)

| Key | Action |
|---|---|
| `g` | Toggle TREE ↔ GRAPH |
| `l` | Switch to LOGS mode |
| `t` | Switch to TIMELINE mode |
| `h` | Switch to HIJACK mode |
| `1`–`5` | Jump to a mode **from a non-Tree mode** (`1` Tree, `2` Graph, … `5` Hijack); in Tree these are inspector tabs (below) |
| `?` | Toggle help overlay |
| `q` / `Q` / Ctrl-C | Quit (routes through full teardown; external SIGINT/SIGTERM/SIGHUP do too) |
| `Esc` | Close help overlay |

### Mode-specific keys

| Key | Mode | Action |
|---|---|---|
| `j`/`k` / `↑`/`↓` | TREE, GRAPH, TIMELINE | Move cursor / scrub |
| `space` | TREE | Fold/unfold node |
| `⏎` | TREE | Focus inspector pane · GRAPH: inspect node in Tree |
| `tab` | TREE | Toggle focus between tree and inspector |
| `1`–`4` | TREE | Switch NodeInspector tab (output/logs/diff/props) |
| `←`/`→` | TREE (inspector focused) | Walk inspector tabs |
| `a` / `d` | TREE | Approve / deny the focused node's pending gate |
| `[` / `]` | TREE (approval), LOGS | Cycle a `select` approval's options · walk node attempts |
| `f` | LOGS | Toggle follow mode |
| `L` | TIMELINE | Back to live head |

### Responsive / compact behavior

`useTerminalDimensions()` (from `@opentui/core`) is polled on resize. When terminal width falls below **100 columns**:

- TREE: left and right panes stack **vertically** (node tree above, inspector below). Inspector height is capped to `floor((height - headerRows - keybarRows) * 0.45)`.
- GRAPH: card labels truncated to 12 chars; arrows reduced to `→`.
- LOGS: tag prefix truncated to 8 chars.
- TIMELINE: tick strip compressed to show every Nth frame label.

Width threshold is a constant `COMPACT_THRESHOLD = 100` in `packages/tui/src/layout.ts`.

---

## 7. Testing Strategy (CI-safe)

CI has **no agent CLIs and no browser**. Every test must be self-contained against a seeded local Gateway or a fake in-memory sync backend.

### Approach

**As built - two test layers, all in `packages/tui/tests/` (Bun's runner):**

1. **Pure util tests** (`*-mode.test.ts`, `event-frame.test.ts`, `diff-utils.test.ts`, `approval-utils.test.ts`): exercise the mode helpers (tree flatten/glyphs, log attempt keys, timeline frame classification + node snapshots, diff view, approval decision shaping + the `runApprovalSubmit` ordering) as plain functions - no renderer.

2. **Render tests** (`*-render.test.tsx`): mount the **real presentational view** each mode wraps (`NodeInspectorView`, `LogView`, `TimelineView`) with the headless `@opentui/react` test renderer (`testRender`) and **injected props** - no gateway, no provider, no agent, no browser. The thin `*Mode` wrapper only reads the gateway hooks and forwards them, so the view under test can't drift from production. `renderHelpers.tsx` wraps the async mount/idle/destroy in React `act(...)` so the suite stays warning-free.

Keyboard interactions are driven via the test renderer's `mockInput.pressKey(...)` inside `act(...)`; assertions read `captureCharFrame()` cell content.

**CI constraints addressed**:
- No agent CLI and no browser - every test is prop-injection against the real components or pure helpers; nothing spawns a gateway, agent, or PTY.
- No real TTY - the headless `testRender` supplies a fake terminal of a fixed width/height.

**Test file layout (actual):**
```
packages/tui/tests/
  renderHelpers.tsx          # act-wrapped testRender helper
  tree-mode.test.ts          # tree flatten/glyph/tab helpers
  tree-render.test.tsx       # NodeInspectorView: tabs, diff, approval banner
  logs-mode.test.ts          # attempt key split/filter (incl. colon node ids)
  logs-render.test.tsx       # LogView: follow toggle, attempt walking
  timeline-mode.test.ts      # frame classify + node snapshots (incl. iterations)
  timeline-render.test.tsx   # TimelineView: scrub, inspect-only honesty
  graph-mode.test.ts         # graph column layout
  hijack-mode.test.ts        # hijackable-node filter + exit message
  approval-utils.test.ts     # decision shaping + runApprovalSubmit ordering
  diff-utils.test.ts         # node diff → view
  event-frame.test.ts        # gateway frame unwrap/normalize
```

---

## 8. File / Module Layout

### New package: `packages/tui`

As built - a flat module layout (no `components/`, `hooks/`, `devtools/`, `bootstrap.tsx`, `ensureGateway.ts`, `layout.ts`; the gateway tree/elapsed/frame logic lives in the shared `gateway-react` hooks, and each mode keeps its presentational view + a thin gateway wrapper in one file):

```
packages/tui/
  package.json          # name: "@smithers-orchestrator/tui", bin "smithers-mon"
                        # deps: @opentui/core, @opentui/react, react,
                        #       smithers-orchestrator (workspace:*), zod
  tsconfig.json         # jsxImportSource "@opentui/react"
  src/
    index.tsx           # smithers-mon BIN entry: argv + gateway autostart + createRoot + providers
    App.tsx             # root: header + mode router + keybar + global keymap
    ErrorBoundary.tsx   # in-terminal render-error fallback
    Keybindings.tsx     # keymap context shared by all modes
    RendererContext.tsx # OpenTUI renderer context (for HIJACK PTY hand-off)
    cliEntry.ts         # resolve the real smithers CLI (gateway autostart / hijack)
    data.ts             # typed selectors over the gateway-react hooks
    modes/
      TreeMode.tsx      # TREE: tree panel + NodeInspector (Output/Logs/Diff/Props) + approval banner
      GraphMode.tsx     # GRAPH: DAG card layout
      LogMode.tsx       # LOGS: scrollbox + follow + attempt filter
      TimelineMode.tsx  # TIMELINE: tick strip + node-snapshot panel (inspect-only)
      HijackMode.tsx    # HIJACK: node picker + stdio handoff to `bunx smithers-orchestrator hijack`
      treeUtils.ts      # tree flatten, glyph/chevron, default-tab, ALL_TABS
      graphUtils.ts     # column layout algorithm
      logUtils.ts       # attempt-key extract/split/filter, event-text
      timelineUtils.ts  # frame classify, node-snapshot reconstruction
      hijackUtils.ts    # running-node filter + hijack exit message
      eventFrame.ts     # gateway frame unwrap/normalize + per-node log filter
      approvalUtils.ts  # approval mode/options/decision + runApprovalSubmit
      diffUtils.ts      # getNodeDiff payload → NodeDiffView
  tests/                # Bun tests (see §7)
```

### CLI wiring (`apps/cli/src/`), as built

- `apps/cli/src/tui.js` - **`runTuiCommand` is retained.** It owns the pre-fullscreen flow (fuzzy picker + input prompts), starts the run as a detached background process, then hands off to the monitor. The handoff is a **child-process spawn of the `smithers-mon` bin** (`launchTuiMonitor()` → `spawn("bun", [tuiEntry, runId], { stdio: "inherit", env: { SMITHERS_CLI, SMITHERS_GATEWAY_URL } })`), where `tuiEntry` is resolved by `resolveTuiEntry()` from the `@smithers-orchestrator/tui` package `bin`. The CLI distinguishes a clean monitor quit (exit 0, or an expected interrupt signal SIGINT/SIGTERM/SIGHUP) from a startup failure (non-zero exit) or a crash (other terminating signals → reported as `TUI_MONITOR_CRASHED`).

- **Fallback stream path:** when `resolveTuiEntry()` returns null (e.g. a slim install without the TUI package), `runTuiCommand` calls the inline `streamRun(...)` append-only loop instead, so the run stays observable without the full-screen monitor.

- The monitor is a **bin entry script** (`packages/tui/src/index.tsx`), not an exported `runTuiMonitor(...)` function; there is no `import { runTuiMonitor }` call site.

- No changes to `apps/cli/src/hijack.js` from the monitor side. The monitor's HIJACK mode shells out to `bunx smithers-orchestrator hijack RUN_ID --target NODE_ID` via the resolved CLI entry (`SMITHERS_CLI` or the resolved `@smithers-orchestrator/cli` package).

---

## Resolved Decisions (originally open questions)

1. **Renderer suspend/resume for HIJACK** - resolved: HIJACK suspends the renderer and restores it on every exit path of the spawned `bunx smithers-orchestrator hijack` child (the cleanup also kills the child's process group). No destroy/re-create dance is needed.

2. **`<diff>` element** - resolved: the monitor does **not** use an OpenTUI `<diff>` primitive. The Diff tab renders unified-diff **text** in a `<code filetype="diff">` block, fetched lazily via the `getNodeDiff` RPC, with stat/empty/loading fallbacks.

3. **Terminal test driver** - resolved: tests use the headless `@opentui/react` `testRender` (mounting the real presentational views with injected props), not `@microsoft/tui-test` or a spawned PTY. This keeps the suite CI-safe (no agent, no browser, no real TTY) and impossible to drift from production.

4. **Gateway autostart** - resolved: `index.tsx` probes the local gateway and, when unpinned and unreachable, spawns the resolved CLI's `gateway` subcommand directly (via `cliEntry.ts`); a pinned-but-unreachable gateway errors out instead of autostarting.

5. **Run-tree reconstruction** - resolved: the tree comes from the shared `useGatewayRunTree` hook (a live query over the per-run `nodes` collection reconciled from the devtools snapshot/delta stream), keyed by `runNodeKey`. `packages/tui` does not implement its own delta-merge.
