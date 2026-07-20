# gatewayRoutes/

Transport-agnostic route handlers shared by the Gateway RPC layer
(`../gateway.js`), the plain HTTP server (`../index.js` re-exports them), and
the CLI (diff/output/rewind/tree commands call them directly):

- `getNodeOutput.js` — node output rows with size caps (`NODE_OUTPUT_MAX_BYTES.js`,
  `NODE_OUTPUT_WARN_BYTES.js`) and typed failures (`NodeOutputRouteError.js`).
- `getNodeDiff.js` — node diff with a DB-backed cache.
- `getDevToolsSnapshot.js` / `streamDevTools.js` — DevTools snapshot capture and
  the polling snapshot+delta stream; the stream re-baselines to the latest frame
  on `FrameOutOfRange` gaps (pruned or rewound frames).
- `jumpToFrame.js` — time-travel jump wrapper with DB-backed reconciler defaults.
- `DiffSummary.ts`, `GetNodeDiffRouteResult.ts`, `NodeOutputResponse.ts` —
  type-only sidecars.

Each route validates raw inputs itself (RUN_ID/NODE_ID regex patterns, i32
iteration/frame bounds) and signals failures with typed errors.

Gotchas:

- Observability emission is wrapped in local `swallow()` helpers — metrics and
  logs must never break an RPC response.
- Errors crossing `runPromise` (smithersRuntime) are normalized to
  `SmithersError`, so `instanceof` checks on route errors need cause-chain
  unwrapping (see `findDevToolsRouteError` in `streamDevTools.js`).
- Everything exported here is public npm surface via the package's `./*`
  wildcard export plus `index.js` `export *` — do not rename or remove exports.
