# hot/

Hot-reload subsystem behind `smithers up` hot mode: watch the workflow source
tree, mirror it into a per-generation overlay, dynamically re-import the
workflow module, and hand the new `build` function back to the engine loop.

## Pieces

- `watch.js` — `WatchTree`: one `fs.watch` per directory plus an adaptive
  polling fallback (interval starts at `max(1s, debounceMs * 4)`, doubles to
  10s while idle, permanently disabled above 5000 files via
  `HotWatchScanLimitError`), with debounced change batching.
- `overlay.js` — hardlink-or-copy generation overlays under
  `<hotRoot>/.smithers/hmr/gen-N`, plus stale-generation cleanup.
- `HotWorkflowController.js` — orchestrates watch → `buildOverlayEffect` →
  dynamic import → validate the default export's `build` function; emits a
  `HotReloadEvent` (`reloaded` | `failed` | `unsafe`).
- `HotReloadEvent.ts` / `OverlayOptions.ts` / `WatchTreeOptions.ts` — type-only
  sidecars.

## Entry points

`index.js` aggregates the public surface and is re-exported from the engine
package root (`export * from "./hot/index.js"`); `HotWorkflowController` is
exposed through that root export and exercised by the `hot-controller*` tests.

## Gotchas

- Promise-facing methods (`init`/`wait`/`reload`/`close`, `buildOverlay`,
  `cleanupGenerations`) are thin `Effect.runPromise` wrappers over the
  `*Effect` variants — edit the Effect version.
- Overlays skip dot-name entries and the exclude/ignore basename lists.
- `__overlayInternals` / `__hotWorkflowControllerInternals` are imported by
  `packages/engine/tests` — keep them exported.
