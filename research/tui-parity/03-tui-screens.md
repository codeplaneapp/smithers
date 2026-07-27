# 03: TUI screens, mode by mode

The shell is the existing `packages/tui` app (bin `smithers-mon`), extended from a single-run monitor into the product TUI. Keep its conventions: one persistent header + bottom keybar, modes as thin opentui views over pure sibling modules, a single `data.ts` facade over gateway-react hooks (`TUI_EVENT_CAP = 2000` so every consumer shares one event ring), `RendererContext`/`OverlayContext`/`Keybindings` providers, ErrorBoundary with a working quit key, `COMPACT_WIDTH = 100` responsive stacking.

## What exists today (verified inventory)

Entry `src/index.tsx`: requires both stdout and stdin TTY; args `smithers-mon <runId> [--gateway <url>] [--port <n>] [--token <t>]`; startup pipeline `gatewayConfig -> gatewayRuntimeState -> startupGateway -> cliEntry`; mounts ErrorBoundary > RendererProvider > Keybindings > SmithersGatewayProvider > App; SIGHUP/SIGINT/SIGTERM teardown with exit codes 129/130/143.

Modes (each with pure sibling + no-TTY test + headless render test): TreeMode/treeUtils, GraphMode/graphUtils, LogMode/logUtils, TimelineMode/timelineUtils, HijackMode/hijackUtils. TreeMode also owns `approvalUtils.ts`, `diffUtils.ts`, `humanUtils.ts`; `eventFrame.ts` is the shared event-envelope normalizer (`unwrapEvent`/`normalizeFrame`, needed because `useGatewayRunEvents` frames nest the event at `frame.payload.event`).

Key routing (`App.tsx` `routeAppKey`, pure): Ctrl-C exits (renderer runs `exitOnCtrlC: false`); other ctrl/meta chords no-op; `?` help; inside Tree mode digits 1-4 are inspector tabs, so digits switch modes only outside Tree; aliases `g` graph toggle, `l` logs, `t` timeline, `h` hijack, `q` quit; overlays swallow keys via OverlayContext.

## Target information architecture

multi's law (SPEC 7.0): everything is a chat embed; one concierge chat is home; fullscreen is a mode of an embed. TUI translation: chat is the home mode; every other surface is a full-screen mode you enter from chat (embed activation), the palette, or a direct keybinding; `Esc` returns to where you came from (the mode stack is the embed-minimize analog). multi's `Surface.ts` (24 kinds) is the shared vocabulary; the TUI ships modes for: runs, gatewayRun (the inspector), approvals, vcs, tickets, memory, prompts, scores, crons, palette, chat. Not in TUI v1: files, terminal (the terminal is your terminal; hijack covers it), issues, landings, environment, engine (smithers-mon IS the monitor), admin, evals, optimize, agents, docs, pairConnect, repoFeature, advanced.

Navigation model: `RouteState` from ui-core (deriveRoute/routeStore/appShellDecision, 01-packages.md); a bounded back/forward stack; deep links round-trip as URL strings so any TUI location can be opened in multi and vice versa.

## Mode-by-mode

Each row: data source (ui-core VM over gateway-react) + tui-ui leaves + keys + the zmux e2e assertion that pins it.

### Chat home (phase 4)

- VM: `useChatTranscriptVm` (transcript grouping, embed cards as rows) + composer state + slash autocomplete over the flow catalog (gateway `useGatewayWorkflows` + flow catalog projection; full 300-descriptor catalog arrives when descriptors move into ui-core).
- tui-ui: `ChatTranscriptView` (scrollbox of grouped messages + embed cards), `ComposerInput`, `AutocompletePopup`.
- Keys: type to compose; `/` opens autocomplete; Enter sends; Ctrl-K/`:` palette; embed cards focusable with j/k, Enter opens the embed's mode.
- zmux: type `/ru`, assert autocomplete lists `runs`; Enter opens Runs mode.

### Runs list (phase 2)

- VM: `useRunsListVm` over `useGatewayRuns` + extracted `runsList.ts` reducers (filter/group/summarize) + `statusMeta.ts` tones + `runProgress.ts`.
- tui-ui: `ListTable` rows with `StatusPill`, footer summary.
- Keys: j/k move, Enter opens run inspector, `f` cycles status filter, `/` filter text.
- zmux: seeded gateway with 2 runs; assert both run ids render; Enter shows the tree.

### Run inspector (phase 2; today's smithers-mon modes refactored onto ui-core)

- VM: `useRunInspectorVm` (tree + node detail tabs Output/Logs/Diff/Props, auto-default per node kind) built from treeUtils moved into ui-core + `useGatewayRunTree`/`useGatewayNodeOutput`/`useGatewayRunEvents`/`useNodeDiff` (the `getNodeDiff` RPC wrapper already in `data.ts`).
- Modes preserved: Tree (home), Graph (`g`), Logs (`l`, follow-mode `f`, attempts `[`/`]`), Timeline (`t`, inspect-only scrubber j/k, `L` live). Approval banner + `[a]`/`[d]` when a gate waits (approvalUtils).
- zmux: existing first e2e (phase 1) boots smithers-mon on a seeded run and asserts the header; phase 2 adds tree-node navigation and a diff-tab assertion.

### Approvals queue (phase 3)

- VM: `useApprovalsVm` from the extracted approvals exemplar (orderApprovals, waitTime tones, selection, notes, acting state).
- tui-ui: `ApprovalCard`, `DecisionBar`, `NoteInput`.
- Keys: j/k select, `a` approve, `d` deny (opens note input), Enter confirm.
- zmux: a real paused run with an `<Approval>` gate; approve through the TUI; assert the run proceeds (poll capture for the post-gate node).

### VCS / diff (phase 5)

- VM: `useDiffVm` over `useGatewayRunDiff` + `diffPaginate.ts`; vcs status list from `vcs.ts` + `vcsStore`.
- tui-ui: `DiffView` (`<code filetype="diff">`), file list.
- Keys: j/k files, Enter expand hunk view, `[`/`]` page hunks.

### Tickets, memory, prompts, scores, crons (phase 5)

One thin mode each: `ListTable` over the corresponding hook (`useGatewayTickets`/`useGatewayMemoryFacts`/`useGatewayPrompts`/`useGatewayScores`/`useGatewayCrons`) through a small VM. Keys: j/k + Enter detail pane. zmux: one representative render assertion per mode against seeded data.

### Palette (phase 6)

- VM: `usePaletteVm` over `palette.ts` (modes open/files/flows/ask; fuzzy scorer; section grouper). Sources: surfaces, runs, workflows, flow commands.
- tui-ui: `PaletteOverlay` (input + ranked list) rendered through OverlayContext (all mode keys suspended; poll for overlay disappearance in tests, not for background text).
- Keys: Ctrl-K or `:` open; type; j/k; Enter invoke; Esc close.
- zmux: open palette, type `appro`, Enter, assert Approvals mode header.

### Hijack (phase 7)

05-hijack.md. Keys: `h` from any mode opens the picker (presets + custom command); on a running node the agent-session preset is preselected.

## Keymap (global, target state)

`?` help, `q` quit (outside composer), Ctrl-C quit, Esc close overlay / pop mode stack, Ctrl-K or `:` palette, `c` chat home, digits switch top-level modes outside Tree, existing aliases g/l/t/h preserved, j/k+arrows move, Enter select, Space fold (tree), `a`/`d` approve/deny where a gate is focused, `[`/`]` attempts or pages, `f` follow/filter per mode. Composer-first exception: in chat home, printable keys go to the composer; command keys require the composer to be empty or a Ctrl chord (routeAppKey grows a `composerFocused` input, unit-tested like today).

## Layout

Header (persistent): status dot, workflow name, short run id, connection badge (gatewayRuntimeState), elapsed. Body: active mode. Footer: keybar from the Keybindings registry (auto-generated, truncates under COMPACT_WIDTH). Compact mode stacks split panes vertically (existing TreeMode behavior).

## Invocation

- `smithers-mon <runId>` unchanged (single-run monitor opens the run inspector).
- New `smithers-mon` with no runId: opens chat home (phase 4+; runs list in phase 2-3).
- `smithers up --interactive` keeps launching the monitor via `runTuiCommand` -> `launchTuiMonitor` (`apps/cli/src/tui.js`; spawns `bun <tuiEntry> <runId>` with SMITHERS_CLI/SMITHERS_GATEWAY_URL/SMITHERS_BACKEND/SMITHERS_TOKEN/SMITHERS_WORKSPACE_ROOT env). Same path also serves `workflow run` interactive, `oneshot`, `make-workflow`, `upgrade`. Note: when the TUI package is missing the CLI fails with `TUI_MONITOR_UNAVAILABLE`; there is no inline-stream fallback today.
- `smithers tui <runId|workflow>` (phase 8) opens custom TUIs; the GUI-vs-TUI default preference is 04-custom-tuis.md.

## Testing contract per mode

1. Pure sibling module unit tests (no TTY, plain bun test).
2. Headless render test via `@opentui/react/test-utils` (skipped on win32).
3. One zmux e2e per mode against a real seeded gateway (06-zmux-harness.md); assert substrings on the capture tail, never full-screen equality.
