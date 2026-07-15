# @smithers-orchestrator/gateway-client — src

Browser-first SDK for the Smithers Gateway. `SmithersGatewayClient` speaks HTTP
RPC (`POST /v1/rpc/<method>`), `SmithersGatewayConnection` wraps a raw
WebSocket session, and `streamRunEventsResilient` layers reconnection on top:
exponential backoff (`gatewayBackoffDelay`), `afterSeq` resume, and a
flap-protected backoff reset (backoff only resets after sustained liveness).
This package owns client behavior, not the Gateway wire contract.

Wire/type modules:

- `rpc.ts` — the public `@smithers-orchestrator/gateway-client/rpc` forwarding
  surface. It re-exports the canonical wire types from
  `@smithers-orchestrator/protocol/gateway-rpc` and adds the client-side method
  maps plus `GatewayRpcError`.
- `GatewayEventFrame` / `GatewayResponseFrame` — compatibility modules that
  forward the protocol-owned frame types.
- `GatewayRpcTypeMap` — method → client request/response maps layered over the
  protocol-owned method and payload types.
- `GatewayUiBootConfig` — the `__SMITHERS_GATEWAY_UI__` boot global a served UI
  page reads for base URL / WS path.
- `GatewayExtensionEnvelope` — the `ext.*` method/stream wire contract
  mirroring the server-side `GatewayExtensions` registry.
- `objectGuards` — shared narrowing helpers (`isObject`, `asRecord`,
  `isGatewayResponseFrame`).

Subdirectories: `data/` is the REST + SSE data client and TanStack DB
collection layer; `sync/` holds the `Gateway*Row` types and the
DevTools-snapshot → run-tree mapping.

`@smithers-orchestrator/gateway-react` builds its providers and hooks on this
package. It imports RPC and row types through `gateway-client` and has no direct
dependency on `@smithers-orchestrator/gateway`.

Gotchas: package.json exports a `./*` wildcard, so EVERY file here is a public
npm subpath — never move, rename, or delete a module. The package has no
`effect` dependency, so all code stays Promise/async.
