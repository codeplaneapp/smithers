# views/

pi-tui string-line renderers composed by `RunInspector` (the `/smithers`
overlay).

- `Header.ts` — run status, workflow name, engine/sandbox heartbeat ages,
  connection state.
- `FrameScrubber.ts` — frame position bar and historical/live mode.
- `RunTree.ts` — virtualized tree with search, auto-expansion of running/failed
  paths, failure bubbling to collapsed ancestors, ghost badges.
- `NodeInspector.ts` — Output/Diff/Logs tabs for the selected node.
- `theme.ts` — shared `Theme` type and `paint`/`bold`/`stripAnsi` helpers;
  theme methods are optional so views degrade to plain text.

Contract: `render(width, height, theme)` returns a `string[]` of exactly
`height` lines (Header/FrameScrubber take no height and return what they need);
`handleInput(data)` returns handled/unhandled markers (`RunTree` can return
`"focusInspector"`).

Views read `DevToolsStore` state directly and re-render via `store.subscribe`;
mutations (approve/deny/cancel/rewind) go through `DevToolsClient` from
`RunInspector`.
