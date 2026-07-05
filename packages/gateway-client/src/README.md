# @smithers-orchestrator/gateway-client — src

Browser-first SDK for the Smithers Gateway. `SmithersGatewayClient` speaks HTTP
RPC (`POST /v1/rpc/<method>`), `SmithersGatewayConnection` wraps a raw
WebSocket session, and `streamRunEventsResilient` layers reconnection on top:
exponential backoff (`gatewayBackoffDelay`), `afterSeq` resume, and a
flap-protected backoff reset (backoff only resets after sustained liveness).

Wire/type modules:

- `GatewayEventFrame` / `GatewayResponseFrame` — WS frame shapes.
- `GatewayRpcTypeMap` — method → request/response maps layered over
  `@smithers-orchestrator/gateway/rpc`; `GatewayRpcError` is the thrown error.
- `GatewayUiBootConfig` — the `__SMITHERS_GATEWAY_UI__` boot global a served UI
  page reads for base URL / WS path.
- `GatewayExtensionEnvelope` — the `ext.*` method/stream wire contract
  mirroring the server-side `GatewayExtensions` registry.
- `objectGuards` — shared narrowing helpers (`isObject`, `asRecord`,
  `isGatewayResponseFrame`).

Subdirectories: `data/` is the REST + SSE data client and TanStack DB
collection layer; `sync/` holds the `Gateway*Row` types and the
DevTools-snapshot → run-tree mapping.

Gotchas: package.json exports a `./*` wildcard, so EVERY file here is a public
npm subpath — never move, rename, or delete a module. The package has no
`effect` dependency, so all code stays Promise/async.
