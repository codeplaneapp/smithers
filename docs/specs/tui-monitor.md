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

**Gateway autostart**: Before constructing the client, probe `http://127.0.0.1:7331/health`. If unreachable, spawn `smithers gateway --background` (or reuse the existing `ensureGateway` utility from `apps/cli/src/gateway.js`) and wait up to 10 s for it to answer. This mirrors the behavior of `bunx smithers-orchestrator ui`.

### Hook inventory

| Hook | Source | Feeds |
|---|---|---|
| `useGatewayRun(runId)` | `gateway-react` | Header status dot, workflow name, model, run state, frame counter |
| `useGatewayRunEvents(runId, { maxEvents: 2000 })` | `gateway-react` | LOGS mode transcript; TIMELINE tick strip (seq numbers → frame markers) |
| `useGatewayNodeOutput({ runId, nodeId, iteration })` | `gateway-react` | NodeInspector Output tab; TREE node metadata/elapsed |
| `useGatewayApprovals({ runId })` | `gateway-react` | Approval banner in TREE mode; gate markers in TIMELINE |
| `useGatewayActions()` | `gateway-react` | `cancelRun`, `resumeRun`, `submitApproval`, `rewindRun` mutations |

The `useGatewayRun` hook drives the header and is polled via the collection's built-in live-stream (no polling interval needed). `useGatewayRunEvents` drives both the LOGS stream and the TIMELINE scrubber; the DevTools frame protocol (`packages/protocol/src/devtools`) parses `DevToolsSnapshot` and `DevToolsDelta` payloads from `FrameCommitted` events to reconstruct the node tree at each frame.

---

## 4. Bootstrap / Provider Stack

> **As built:** the bootstrap below lives at module top-level in `packages/tui/src/index.tsx`, the `smithers-mon` **bin entry script**, run as a child process. It is not exported as a `runTuiMonitor(runId, opts)` function; the sketch below is illustrative of the same wiring (gateway autostart, `exitOnCtrlC: false`, `onExit` teardown).

```tsx
/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { SmithersGatewayClient } from "smithers-orchestrator/gateway-client";
import { SmithersGatewayProvider } from "smithers-orchestrator/gateway-react";
import { App } from "./App.js";

export async function runTuiMonitor(runId: string, opts: TuiMonitorOpts) {
  await ensureGateway(opts.gatewayUrl ?? "http://127.0.0.1:7331");

  const client = new SmithersGatewayClient({
    baseUrl: opts.gatewayUrl ?? "http://127.0.0.1:7331",
    WebSocket: globalThis.WebSocket,  // Bun global
  });

  const renderer = createCliRenderer({ exitOnCtrlC: false });

  const root = createRoot(renderer);
  root.render(
    <SmithersGatewayProvider client={client}>
      <App runId={runId} onExit={() => { root.unmount(); renderer.destroy(); process.exit(0); }} />
    </SmithersGatewayProvider>
  );
}
```

`exitOnCtrlC: false` because the TUI handles `c` / `q` in its own keymap and shows a confirm banner before cancelling a running run.

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
  - Tabs: **Output** / **Logs** / **Tools** / **Diff** / **Props**
  - Auto-default per node kind:
    - Has output → Output tab.
    - Currently running → Logs tab.
    - Container/parallel node → Props tab.
  - **Output tab**: `<code>` block with formatted node output from `useGatewayNodeOutput`.
  - **Logs tab**: scrollable `<scrollbox>` of agent transcript events filtered to this node from `useGatewayRunEvents`.
  - **Tools tab**: tool-call events for this node, each with read/write/shell side-effect badge.
  - **Diff tab**: `<diff>` element (OpenTUI diff primitive) showing code changes if node produced a diff in its output.
  - **Props tab**: `<code>` block with node metadata (nodeId, iteration, attempt, state, timing) from the DevTools snapshot.
  - Tab switching: `1`–`5` or left/right arrows when inspector is focused.

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

- Live agent transcript - all `AgentStream` / tool-call events from `useGatewayRunEvents`, interleaved in seq order.
- Each line: `[nodeId-color] │ event text`
- Tool calls rendered with side-effect badges: `[read]` (dim), `[write]` (yellow), `[shell]` (red).
- **Follow mode**: on by default. Scrollbox auto-scrolls to bottom as new events arrive. `f` toggles follow; the `[live]`/`[paused]` indicator in the header reflects this.
- `[`/`]` walk backward/forward across node attempts (filters events to the selected attempt).
- Data: `useGatewayRunEvents` with `maxEvents: 2000`.

### Mode 4: TIMELINE

**Layout**: horizontal split.

- **Top strip** (`<scrollbox>` horizontal): tick bar showing frame numbers. Notable frames (first agent event, tool calls, gate raises) are marked with `│`. Gate/approval frames are marked `⊛`. The selected frame is highlighted.
- **Body**: the TREE view rendered as it was at the selected frame, reconstructed from the DevTools snapshot at that frame number.
- **Bottom controls**: `jump` (⏎ on a frame), `fork` (spawns a new run from this frame via `actions.rewindRun`), `rewind` (calls `actions.rewindRun` then re-attaches), `replay` (re-runs from frame 0), `back-to-live` (`L`) returns to the live head.
- Backed by the DevTools jump-to-frame protocol: `DevToolsEvent` stream from `useGatewayRunEvents`, replaying `DevToolsDelta` ops against the initial `DevToolsSnapshot` to build the tree at each frame.
- Data: `useGatewayRunEvents` (full event buffer), `useGatewayActions` for fork/rewind mutations.

### Mode 5: HIJACK

**Activation**: press `h` while a node is running (cursor on a running node in TREE mode).

**Flow**:
1. A `<select>` overlay appears (OpenTUI select primitive): "Hijack [nodeId] ([engine])? [confirm / cancel]".
2. On confirm:
   a. `renderer.suspend()` - yields the terminal back to raw stdio.
   b. Resolve hijack candidate via `resolveHijackCandidate(adapter, runId)` from `apps/cli/src/hijack.js`.
   c. Build the launch spec via `buildHijackLaunchSpec(candidate)`.
   d. `launchHijackSession(spec)` - spawns `claude --resume <id>` / `codex resume <id>` / etc. inheriting stdio.
   e. On native CLI exit: `renderer.resume()` (or re-initialize if needed), show a banner: "Hijack session ended. [a] resume automation  [d] dismiss".
3. `a` calls `actions.resumeRun({ runId })` and returns to live TREE mode.
4. `d` dismisses the banner; the run remains paused.

---

## 6. Full Keymap & Responsive / Compact Behavior

### Global keys (all modes)

| Key | Action |
|---|---|
| `j` / `↓` | Move cursor down |
| `k` / `↑` | Move cursor up |
| `space` | Fold/unfold node (TREE); page-down (LOGS) |
| `⏎` | Select / confirm |
| `g` | Toggle TREE ↔ GRAPH |
| `l` | Switch to LOGS mode |
| `t` | Switch to TIMELINE mode |
| `h` | HIJACK active node |
| `a` | Approve pending gate |
| `d` | Deny pending gate |
| `c` | Cancel run (shows confirmation banner first) |
| `R` | Resume failed run (`actions.resumeRun`) |
| `y` | Copy run id to clipboard (via `Bun.write` to pbcopy/xclip) |
| `?` | Toggle help overlay (lists all keys) |
| `q` | Back one level / quit (Esc also closes overlays) |
| `Esc` | Close overlay / back |

### Mode-specific keys

| Key | Mode | Action |
|---|---|---|
| `1`–`5` | TREE | Switch NodeInspector tab |
| `←`/`→` | TREE (inspector focused) | Walk inspector tabs |
| `f` | LOGS | Toggle follow mode |
| `[` / `]` | LOGS | Walk node attempts |
| `L` | TIMELINE | Back to live head |
| `⏎` on tick | TIMELINE | Jump to frame |
| `F` | TIMELINE | Fork from current frame |
| `W` | TIMELINE | Rewind from current frame |

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

**Unit / component tests** (`packages/tui/src/**/*.test.tsx`):
- Use `@opentui/react`'s test renderer (if available) or a headless snapshot renderer to mount components in a fake terminal.
- Supply a fake `SmithersGatewayClient` constructed with a mock `SyncTransport` that returns canned collections (no network).
- Assert on rendered cell content (text, glyphs, colors) with snapshot tests.
- Simulate keyboard events via the renderer's event API and assert state transitions.

**Integration tests** (`packages/tui/e2e/*.test.ts` or `e2e/tui/`):
- Seed a local Gateway (`packages/server`) with deterministic run rows: a fixed `runId`, 3 nodes (one finished ✓, one running ●, one pending ○), 2 pending approvals, and 20 canned events.
- Launch the TUI process via `Bun.spawn` pointed at the seeded Gateway URL.
- Use `@microsoft/tui-test` (or OpenTUI's `TestRenderer` if it exposes a PTY API) to interact with the spawned process: send keystrokes, capture frames, diff against golden snapshots.
- The seeded Gateway is a real `packages/server` instance seeded with a `SmithersDb` fixture; no mocking of the Gateway itself.

**CI constraints addressed**:
- No agent CLI required - the fake agent is a stub workflow that emits canned `AgentStream` events into the seeded DB.
- No browser - `@microsoft/tui-test` drives a PTY subprocess, not a browser.
- Deterministic timing - elapsed timers in the header are frozen by injecting `createdAtMs` into the seeded run row such that elapsed = a fixed value.

**Test file layout**:
```
packages/tui/
  src/
    __tests__/
      Header.test.tsx          # header status dot + elapsed rendering
      NodeTree.test.tsx        # tree glyph/chevron rendering, fold/unfold
      NodeInspector.test.tsx   # tab switching, output/logs/diff content
      LogsMode.test.tsx        # follow mode toggle, attempt walking
      TimelineMode.test.tsx    # tick strip rendering, frame reconstruction
      HijackMode.test.tsx      # confirm overlay, renderer.suspend/resume
      keymap.test.ts           # key dispatch routing to mode actions
      layout.test.ts           # compact threshold behavior
  e2e/
    tui-monitor.e2e.test.ts    # full PTY integration against seeded gateway
```

---

## 8. File / Module Layout

### New package: `packages/tui`

```
packages/tui/
  package.json          # name: "@smithers-orchestrator/tui"
                        # deps: @opentui/core, @opentui/react, react,
                        #       smithers-orchestrator (workspace:*), zod
                        # jsxImportSource: react (tsconfig)
  tsconfig.json
  src/
    index.tsx           # smithers-mon BIN entry: gateway autostart + createRoot + providers
    bootstrap.tsx       # createCliRenderer + createRoot + providers
    ensureGateway.ts    # probe + autostart logic (mirrors apps/cli)
    App.tsx             # root component: header + mode router + keybar
    Header.tsx          # status dot, name, elapsed, frame counter
    Keybar.tsx          # bottom keybinding strip per mode
    layout.ts           # COMPACT_THRESHOLD, useCompactMode()
    modes/
      TreeMode.tsx      # TREE: NodeTree + NodeInspector split
      GraphMode.tsx     # GRAPH: DAG card layout
      LogsMode.tsx      # LOGS: scrollbox + follow
      TimelineMode.tsx  # TIMELINE: tick strip + frame-tree
      HijackMode.tsx    # HIJACK: confirm overlay + stdio handoff
    components/
      NodeTree.tsx      # collapsible tree with glyphs/chevrons
      NodeInspector.tsx # tabbed Output/Logs/Tools/Diff/Props
      ApprovalBanner.tsx
      HelpOverlay.tsx
    hooks/
      useRunTree.ts     # DevTools snapshot/delta reconstruction
      useElapsed.ts     # ticking mm:ss from createdAtMs
      useFrames.ts      # frame index from FrameCommitted events
    devtools/
      applyDelta.ts     # DevToolsDelta → DevToolsNode tree mutation
    __tests__/          # (see §7)
  e2e/                  # (see §7)
```

### CLI wiring (`apps/cli/src/`), as built

- `apps/cli/src/tui.js` - **`runTuiCommand` is retained.** It owns the pre-fullscreen flow (fuzzy picker + input prompts), starts the run as a detached background process, then hands off to the monitor. The handoff is a **child-process spawn of the `smithers-mon` bin** (`launchTuiMonitor()` → `spawn("bun", [tuiEntry, runId], { stdio: "inherit", env: { SMITHERS_CLI, SMITHERS_GATEWAY_URL } })`), where `tuiEntry` is resolved by `resolveTuiEntry()` from the `@smithers-orchestrator/tui` package `bin`. The CLI distinguishes a clean monitor quit (exit 0, or an expected interrupt signal SIGINT/SIGTERM/SIGHUP) from a startup failure (non-zero exit) or a crash (other terminating signals → reported as `TUI_MONITOR_CRASHED`).

- **Fallback stream path:** when `resolveTuiEntry()` returns null (e.g. a slim install without the TUI package), `runTuiCommand` calls the inline `streamRun(...)` append-only loop instead, so the run stays observable without the full-screen monitor.

- The monitor is a **bin entry script** (`packages/tui/src/index.tsx`), not an exported `runTuiMonitor(...)` function; there is no `import { runTuiMonitor }` call site.

- No changes to `apps/cli/src/hijack.js` from the monitor side. The monitor's HIJACK mode shells out to `bunx smithers-orchestrator hijack RUN_ID --target NODE_ID` via the resolved CLI entry (`SMITHERS_CLI` or the resolved `@smithers-orchestrator/cli` package).

---

## Open Questions

1. **`renderer.suspend()` / `renderer.resume()` API**: Does `@opentui/core`'s `createCliRenderer` expose these methods, or does HIJACK mode need to destroy and re-create the renderer after the native CLI exits? The TUI chat engineering doc references this API but it was removed in 0.20.2; need to confirm the current OpenTUI API surface.

2. **`<diff>` element**: Is OpenTUI's `<diff>` primitive available in the current `@opentui/core` version, or does the Diff tab need to render unified diff text inside a `<scrollbox>` manually?

3. **`@microsoft/tui-test` PTY driver**: Does it support Bun-spawned processes, or does it require Node? If Bun subprocess PTY attachment is unsupported, the integration test may need to use a Node shim or switch to OpenTUI's own test renderer API.

4. **Gateway autostart interface**: The existing `ensureGateway` utility in `apps/cli` - is it a stable function export that `packages/tui` can import, or does it need to be moved to a shared package first?

5. **DevTools frame protocol completeness**: Does the current `packages/protocol/src/devtools` include a stable `applyDelta(snapshot, delta): DevToolsSnapshot` helper, or does `packages/tui` need to implement the merge logic itself from the `DevToolsDelta` / `DevToolsDeltaOp` types?
