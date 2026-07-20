# runtime/

Gateway transport and inspector state for the `/smithers` run inspector.

- `DevToolsClient.ts` — gateway transport. `streamDevTools()` is an async
  generator over a WS connection (connect handshake, per-run seq resume,
  `SeqOutOfRange` -> `gapResync`); mutations (approve/deny/signal/cancel/
  resume/rewind) go over HTTP `/rpc` and surface `auditRowId` from
  loosely-shaped payloads.
- `DevToolsStore.ts` — all inspector state: live snapshot/delta application
  (via `@smithers-orchestrator/devtools` `applyDelta`), reconnect with
  exponential backoff, historical frame scrubbing + rewind, ghost-node
  capture/eviction for unmounted subtrees, and stale-banner timing. Notifies
  subscribers synchronously via `emit()`.
- `normalizeState.ts` — canonical node-state normalization (lowercase,
  separators -> dashes) shared by the store, views, and `extension.ts`.

Gotcha: the store deliberately keeps live state (`liveSnapshot`) separate from
displayed state (`tree`/`seq`) so scrubbing to a historical frame buffers live
events without losing them.
