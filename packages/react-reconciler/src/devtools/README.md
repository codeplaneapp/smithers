# devtools/

React adapter for Smithers DevTools. `SmithersDevTools.js` instruments fiber
commits via bippy, maps `smithers:*` host fibers to `DevToolsNode` trees
(`HOST_TAG_MAP`), and delegates state/snapshot tracking to
`SmithersDevToolsCore` from `@smithers-orchestrator/devtools`.

- `index.js` — the `./devtools` export surface: re-exports `SmithersDevTools`
  plus a tool-managed `@smithers-type-exports` block (preserve byte-for-byte).
- `preload.js` — the `./devtools/preload` export: a Bun `--preload` script that
  installs the React DevTools global hook before any React code loads.

Gotchas: `start()` works best when called before the renderer injects itself;
it saves the hook's previous `onCommitFiberRoot`/`onCommitFiberUnmount`
handlers, and `stop()` only restores them if ours are still installed (another
`instrument()` call may have chained on top). Only host fibers are matched —
composite `Task`/`Workflow` components always create a host fiber underneath,
so matching both would double-count.
