# Single-Run Monitor TUI - Engineering Spec

**Status**: Implemented

**Date**: 2026-06-30

---

## 1. Goal & How It Ships

The single-run monitor TUI is a full-screen terminal UI launched from the `bunx smithers-orchestrator up --interactive` flow (`apps/cli/src/tui.js` → `runTuiCommand`). Instead of clack cards streaming down the terminal, the user gets a persistent, keyboard-driven, five-mode monitor that stays live for the full lifetime of a run.

**Entry points:**

- `bunx smithers-orchestrator up --interactive <workflow>` - existing flag (no short alias; `-i` is `--input`); picks/starts a run, then hands off to the monitor.
- `bunx smithers-orchestrator up --interactive` with no workflow argument - shows the fuzzy workflow picker (reusing existing `fuzzySelect` + `buildWorkflowPickerOptions` logic from `tui.js`), then monitors the selected run.

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
  token: process.env.SMITHERS_API_KEY,  // bearer for HTTP + WS; see auth note below
})
```

**Auth token (as built)**: the gateway enables token auth whenever `SMITHERS_API_KEY` (or a `--auth-token`) is set, after which it rejects unauthenticated RPC/WS calls (though `/health` still answers). So `gatewayConfig.ts` resolves a bearer token (in priority order: `--token` arg, then `SMITHERS_TOKEN`, then `SMITHERS_API_KEY`) and `index.tsx` threads it consistently through: the `SmithersGatewayClient` (`token` → HTTP `Authorization` header + WS `auth.token`), the `/health` probe, and - when it autostarts a local gateway - the spawned `gateway --auth-token <token>`. When no token is configured, a loopback gateway with no auth stays token-free.

**No OPFS / navigator persistence.** `createGatewayPersistence` calls `navigator.*` APIs that do not exist in Bun. Pass no `persistence` option to `createGatewayCollections`. The in-memory sync backend (no-persistence path) works correctly headless.

**No `createGatewayReactRoot`.** That helper wraps `react-dom/client` and is for browser contexts. Use `@opentui/react`'s `createRoot` directly.

**Gateway autostart (as built)**: When the user has NOT pinned an explicit gateway (`--gateway` / `SMITHERS_GATEWAY_URL`), `index.tsx` probes `http://127.0.0.1:7331` and, if unreachable, spawns the resolved CLI's `gateway` subcommand (`bunx smithers-orchestrator gateway --host 127.0.0.1 --port <port>`, detached, via `cliEntry.ts` - never `process.argv[1]`, which would recursively relaunch the monitor) and waits for it to answer. If the user DID pin a gateway and it is unreachable, the monitor errors out with a "start it with `bunx smithers-orchestrator gateway`" hint instead of autostarting a local one it would never connect to. There is no `--background` flag.

### Hook inventory

| Hook | Source | Feeds |
|---|---|---|
| `useGatewayRun(runId)` | `gateway-react` | Header status dot, workflow name, model, run state |
| `useGatewayRunEvents(runId, { maxEvents: 2000 })` | `gateway-react` | LOGS mode transcript; TIMELINE tick strip (seq numbers → frame markers) |
| `useGatewayNodeOutput({ runId, nodeId, iteration })` | `gateway-react` | NodeInspector Output tab (the selected node's formatted output) |
| `useGatewayApprovals({ filter: { runId } })` | `gateway-react` | Approval banner in TREE mode; gate markers in TIMELINE. Exposes `refetch`, called after a successful `submitApproval` so the resolved gate's banner clears. |
| `getNodeDiff` RPC (via `useGatewayRpc`) | `gateway-react` | NodeInspector Diff tab (gated on the tab being active) |
| `useGatewayActions()` | `gateway-react` | Only `submitApproval` (approve/deny a gate in TREE). The monitor does NOT cancel/resume/rewind from actions - those are CLI-driven; HIJACK shells out to `bunx smithers-orchestrator hijack`. |

The `useGatewayRun` hook drives the header and is polled via the collection's built-in live-stream (no polling interval needed). `useGatewayRunEvents` feeds the run-*events* surfaces (the LOGS transcript and the TIMELINE scrubber), not the tree. The **tree** comes from a separate hook, `useGatewayRunTree(runId)`, a live query over the per-run `nodes` collection; that collection is kept fresh by the gateway's `streamDevTools` stream (each devtools frame triggers a `getDevToolsSnapshot` refetch + reconcile), so the tree stays current without the TUI parsing any frame payloads itself.

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
● workflow-name  run-abc123  claude-opus-4-8  02:34  [live]
```

Implemented by `RunHeaderView` (presentational) in `packages/tui/src/Header.tsx`,
fed by the gateway-connected `Header` (pulls `useGatewayRun`, ticks a 1s clock
while the run is live). Pure helpers live in `packages/tui/src/headerUtils.ts`.

Fields, left to right:
- **Status dot** - `●` colored by `statusDotColor`: cyan = running/recovering, amber = waiting-approval/event/timer, red = failed, green = succeeded/finished, grey = cancelled (terminal but not a failure, so dim rather than red), darker grey = unknown.
- **Workflow name** - `useGatewayRun().data.workflowKey` (falls back to `(workflow)`).
- **Short run id** - shown whole unless longer than 24 chars, then elided from the end.
- **Model** - from the run row's `model` when present; **omitted** (never fabricated) when the row carries none.
- **Elapsed** - ticking `mm:ss` (or `hh:mm:ss` past an hour) from `startedAtMs`/`createdAtMs`, frozen at `finishedAtMs` once the run is terminal.
- **live|paused** - `[live]` while running, `[paused]` while parked on a gate/event/timer, else the literal terminal state.

> No frame counter (`fn/total`): the monitor subscribes to the run-event stream,
> which carries no `_smithers_frames.frame_no` total, so there is no honest frame
> count to show in the header; it is intentionally omitted rather than guessed.
> (TIMELINE mode has its own `frame n/total` over the events it actually holds.)

### Mode 1: TREE (default)

**Layout**: horizontal split.

- **Left pane** (`<scrollbox>`, ~38% width): collapsible node tree.
  - Each row: `indent + chevron + glyph + label + inline meta`. Rows do NOT render a per-node elapsed time (the snapshot node carries no readily-available per-node timing); the optional trailing `meta` is the node's own `meta` string, rendered inline and dim after the label (truncated to fit the pane).
  - Chevron: `▾` expanded, `▸` collapsed, `·` leaf.
  - Glyph: `✓` finished/ok, `●` running, `⏸` waiting, `○` pending/queued, `✗` failed, `·` other/unknown.
  - j/k / arrow keys move the cursor (the right pane tracks the cursored node live); `space` folds/unfolds a node with children; `⏎` moves focus INTO the inspector (right) pane; `tab` toggles focus between the two panes.
  - Data: `useGatewayRunTree(runId)` - a live query over the per-run `nodes` collection, kept fresh via the gateway's `streamDevTools` stream (refetch + reconcile of `getDevToolsSnapshot`). The TUI does not reconstruct the tree from raw event frames.

- **Right pane** (`NodeInspector`): tabbed panel for the selected node.
  - Tabs: **Output** / **Logs** / **Diff** / **Props**. (There is no Tools tab: the gateway exposes no per-node tool-call stream to the monitor; tool calls live only in the durable store and are surfaced by `bunx smithers-orchestrator node`, so an always-empty tab would be dishonest.)
  - Auto-default tab per node, in priority order:
    - Container node (root/parallel/loop/saga/try/workflow/group) → Props tab.
    - Otherwise currently running → Logs tab.
    - Otherwise has output → Output tab.
    - Otherwise → Props tab.
  - **Output tab**: `<code>` block with formatted node output from `useGatewayNodeOutput`.
  - **Logs tab**: scrollable `<scrollbox>` of agent transcript events filtered to this node from `useGatewayRunEvents`.
  - **Diff tab**: unified-diff **text** rendered in a `<code filetype="diff">` block (a summary line + the patch), fetched lazily via the `getNodeDiff` RPC only while this tab is active. It does **not** use an OpenTUI `<diff>` primitive. Falls back to a stat summary or an explicit empty/loading state.
  - **Props tab**: `<code filetype="json">` block with node metadata - `id`, `key` (the unique row key), `iteration`, `name`, `kind`, `status`, `agent`, `meta`, `cardLabel`, `parentId`, `childIds`. `key` + `iteration` distinguish repeated logical nodes (loop/retry attempts).
  - Tab switching: `1`–`4` (output/logs/diff/props) or left/right arrows when inspector is focused.

- **Approval banner**: when the CURSORED node has a pending gate in `useGatewayApprovals({ filter: { runId } }).data`, a bordered banner renders at the top of the inspector (right) pane, ABOVE the tab bar (not above the keybar). It shows `⏸  <title>  [<mode>]` plus a summary line and mode-appropriate controls: a plain gate shows `[a] approve   [d] deny`; a `select` lists its options and shows `[[/]] choose   [a] approve selected   [d] deny`; a `rank` shows `[a] approve (ranked as listed)   [d] deny`. Keys `a`/`d` (and `[`/`]` for a `select`) work whether focus is in the tree or the inspector, and call `actions.submitApproval`. A pending durable **HumanTask** renders a distinct variant instead (the gateway has no RPC to submit the typed answer), pointing the operator at `bunx smithers-orchestrator human inbox` rather than offering an approve/deny that would strand the run.

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
- **Follow mode**: on by default. Scrollbox auto-scrolls to bottom as new events arrive. `f` toggles follow; a `[live]`/`[paused]` indicator in the LOGS mode status row reflects this.
- `[`/`]` walk backward/forward across node attempts (filters events to the selected attempt).
- Data: `useGatewayRunEvents` with `maxEvents: 2000`.

### Mode 4: TIMELINE

**Layout**: vertical stack - a status bar, a fixed-height tick strip, a divider, then the node-snapshot body below.

- **Tick strip**: a `frame n/total` + selected-event info row above a single row of tick marks, then a controls row. The tick row shows a window of frames centered on the selection (it is NOT a horizontally scrolling `<scrollbox>`; it slices `maxVisible` frames around the cursor). Notable frames (first agent event, gate raises) are marked; gate/approval frames stand out; the selected frame is highlighted.
- **Body**: node state inspected as of the selected frame, reconstructed from the event history.
- **Inspect-only**: this is an event timeline you *scrub* to read run history; it deliberately offers **no** fork/rewind/replay/jump mutations. Wiring a "rewind" here would either no-op or rewind to a guessed frame, so the timeline stays honest and points you at the durable command instead: rewind a run with `bunx smithers-orchestrator rewind` (fork with `bunx smithers-orchestrator fork`, replay with `bunx smithers-orchestrator replay`).
- **Keys**: `j`/`k` (or `←`/`→`) scrub events; `L` returns to the live head.
- Data: `useGatewayRunEvents` (full event buffer); no mutating actions.

### Mode 5: HIJACK

**Activation**: `h` is a global key (works from any mode) that switches to HIJACK mode. It does NOT depend on the tree cursor being on a running node - HIJACK resolves the hijackable nodes itself and lists them.

**Flow (as built)**:
1. A `<select>` overlay lists the hijackable (running) nodes - resolved from the run tree + live-session signal in the event stream. Pick one to confirm, or press `Esc` to cancel back to TREE. When there are no running nodes, HIJACK shows a "no running nodes available" message instead of a picker.
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
| `j`/`k` / arrows | TREE, GRAPH, TIMELINE | Move cursor / scrub (TREE + GRAPH use `↑`/`↓`; TIMELINE scrubs with `←`/`→`) |
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

Each layout-aware module reads `useTerminalDimensions()` (from `@opentui/react`)
and compares the width against the constant `COMPACT_WIDTH`, declared locally in
`packages/tui/src/App.tsx` and the width-adapting mode files under
`packages/tui/src/modes/`. Below that threshold the modes switch to a compact
layout; the exact ratios and truncation lengths live in the code and are not
pinned here (to keep the spec from drifting on volatile constants):

- TREE: the side-by-side tree/inspector split collapses to a **vertical** stack (node tree above, inspector below).
- GRAPH: card labels are truncated and the connector arrows are shortened.
- LOGS: the per-line node tag prefix is truncated more aggressively.
- TIMELINE: the tick strip is compressed to fit the narrower width.

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

**Test file layout (representative, under `packages/tui/tests/` - the pure-util `*-mode`/`*-utils`/`*-config` tests plus the `*-render` view tests; not an exhaustive listing):**
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
  header-utils.test.ts       # status-dot color + elapsed formatting
  approval-utils.test.ts     # decision shaping + runApprovalSubmit ordering
  human-utils.test.ts        # human-request banner shaping
  diff-utils.test.ts         # node diff → view
  event-frame.test.ts        # gateway frame unwrap/normalize
  gateway-config.test.ts     # gateway base/port/autostart arg+env precedence
```

---

## 8. File / Module Layout

### New package: `packages/tui`

As built - a flat module layout (no `hooks/`, `devtools/`, `bootstrap.tsx`, `ensureGateway.ts`, `layout.ts`; the gateway tree/elapsed/frame logic lives in the shared `gateway-react` hooks, and each mode keeps its presentational view + a thin gateway wrapper in one file). The tree below is representative of the key modules, not an exhaustive file listing:

```
packages/tui/
  package.json          # name: "@smithers-orchestrator/tui", bin "smithers-mon"
                        # deps: @opentui/core, @opentui/react,
                        #       @smithers-orchestrator/gateway-client (workspace:*),
                        #       @smithers-orchestrator/gateway-react (workspace:*)
                        # peer/dev: react, react-dom (19); no zod, no smithers-orchestrator dep
  tsconfig.json         # jsxImportSource "@opentui/react"
  src/
    index.tsx           # smithers-mon BIN entry: argv + gateway autostart + createRoot + providers
    gatewayConfig.ts    # pure gateway base/port/autostart resolution (arg/env precedence)
    App.tsx             # root: header + mode router + keybar + global keymap
    Header.tsx          # gateway-connected header + presentational RunHeaderView
    headerUtils.ts      # pure header helpers (status dot color, elapsed formatting)
    ErrorBoundary.tsx   # in-terminal render-error fallback
    Keybindings.tsx     # keymap context shared by all modes
    RendererContext.tsx # OpenTUI renderer context (for HIJACK PTY hand-off)
    cliEntry.ts         # resolve the real smithers CLI (gateway autostart / hijack)
    data.ts             # typed selectors over the gateway-react hooks
    modes/
      TreeMode.tsx      # TREE: tree panel + NodeInspector (Output/Logs/Diff/Props) + approval/human banner
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
      humanUtils.ts     # human-request banner shaping (ask-human gates in TREE)
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

5. **Run-tree reconstruction** - resolved: the tree comes from the shared `useGatewayRunTree` hook (a live query over the per-run `nodes` collection, kept fresh by the gateway's `streamDevTools` stream, each frame driving a `getDevToolsSnapshot` refetch + reconcile), keyed by `runNodeKey`. Run *events* (`useGatewayRunEvents`) feed the logs/timeline surfaces, not the tree; `packages/tui` does not implement its own delta-merge.
