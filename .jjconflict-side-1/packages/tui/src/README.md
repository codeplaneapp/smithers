# @smithers-orchestrator/tui — src

The `smithers-mon` single-run terminal monitor.

- `index.tsx` — the bin entry (referenced by package.json `bin`; never move or
  rename it). Parses args, resolves gateway config, runs the
  reuse/discover/autostart startup state machine, installs signal-safe
  teardown, then mounts the React tree.
- Startup pipeline: `gatewayConfig.ts` (args/env precedence, port + token
  resolution) → `gatewayRuntimeState.ts` (trusted read of the workspace
  singleton gateway's state file; mirrors `apps/cli/src/gateway-runtime.js`,
  guarded by the parity test in `tests/gateway-runtime-state.test.ts`, which
  compares against the apps/cli writer) → `startupGateway.ts` (pure
  `resolveGatewayForRun` state machine over injected probe/servesRun/autoStart
  effects) → `cliEntry.ts` (resolves the real smithers CLI to spawn for
  autostart — never `process.argv[1]`, which is this TUI).
- React shell: `App.tsx` (global key routing via the exported pure
  `routeAppKey`, mode switcher, help overlay), `Header.tsx` + `headerUtils.ts`
  (presentational `RunHeaderView` over pure status/elapsed helpers),
  `Keybindings.tsx` / `OverlayContext.tsx` / `RendererContext.tsx` (contexts),
  `ErrorBoundary.tsx` (crash screen with a working quit), `data.ts` (the single
  facade over gateway-react hooks; `TUI_EVENT_CAP` keeps every event consumer
  on one shared ring), and `modes/` (one full-screen mode per file — see its
  README).
- Gotchas: logic is deliberately split into pure `*Utils`/`*.ts` modules so
  tests never need a live gateway or TTY. Every keyboard handler must gate on
  the overlay context and drop ctrl/meta chords (see
  `treeUtils.isModifiedKeyEvent`), because `useKeyboard` listeners are
  independent subscriptions that would otherwise all fire.
