# @smithers-orchestrator/tui

Full-screen terminal monitor for a single Smithers run.  Built on
[OpenTUI](https://github.com/nicholasgasior/opentui) + React; talks to the
local Gateway over HTTP/WebSocket.

## How it launches

The monitor is started automatically when you run:

```sh
smithers up --interactive
```

or, when `smithers up` / `smithers workflow run` is invoked from an interactive
TTY without a positional workflow argument.  The CLI:

1. Opens an interactive fuzzy-picker to choose a workflow and fill its inputs.
2. Starts the workflow in a detached background process.
3. Spawns `packages/tui/src/index.tsx` (as `smithers-mon <runId>`) in the
   foreground to watch the run.

You can also invoke the monitor directly for any existing run:

```sh
bun packages/tui/src/index.tsx <runId>
```

The monitor auto-starts a local `smithers gateway` instance if one is not
already reachable on port 7331, then exits after it starts successfully.

## Modes

Press the number key (or the letter alias) to switch views.

| Key | Mode     | What you see |
|-----|----------|--------------|
| `1` | **Tree** | Node tree for the run with per-node output, logs, tool calls, diffs, and props; inline approval banner when a node is waiting |
| `2` / `g` | **Graph** | Directed graph of node dependencies; arrow-key navigation, press Enter to jump to that node in Tree |
| `3` / `l` | **Logs**  | Filtered event stream (up to 2 000 events); per-attempt filter with `[` / `]`; `f` toggles follow mode |
| `4` / `t` | **Timeline** | Horizontal event tick strip with snapshot table; arrow keys scrub through frames |
| `5` / `h` | **Hijack** | Hand off to `smithers hijack` for an active node — suspends the TUI, drops into the hijack shell, returns when done |
| `q` | — | Quit the monitor |

## Architecture

```
packages/tui/src/
  index.tsx          Entry point — probes / starts Gateway, mounts React tree
  App.tsx            Root component — global keybindings, header, mode router, keybar
  Keybindings.tsx    Keymap context shared by all modes
  RendererContext.tsx OpenTUI renderer context (passed into Hijack for PTY hand-off)
  Theme.tsx          Colour palette
  ErrorBoundary.tsx  Catches render errors and prints them in-terminal
  data.ts            Gateway-react hooks (useRun, useRunTree, useRunEvents, …)
  modes/
    TreeMode.tsx      Node tree + tab panels (output/logs/tools/diff/props)
    GraphMode.tsx     DAG layout renderer
    LogMode.tsx       Event stream with attempt filter
    TimelineMode.tsx  Tick strip + snapshot table
    HijackMode.tsx    Node-picker and PTY hand-off
    treeUtils.ts      Tree flattening, glyph helpers
    graphUtils.ts     Column layout algorithm
    logUtils.ts       Event classification and filter helpers
    timelineUtils.ts  Frame classification and node snapshot helpers
    hijackUtils.ts    Running-node filter and hijack exit message helpers
```

## Running tests

```sh
pnpm -C packages/tui test
```

Tests live in `tests/` and use Bun's built-in test runner.  They cover mode
logic (`*-mode.test.ts`) and render snapshots (`*-render.test.tsx`); no real
Gateway is required.
