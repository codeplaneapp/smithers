# @smithers-orchestrator/gateway — src

The stable Gateway runtime contract package: pure data plus tiny pure
functions. `@smithers-orchestrator/protocol/gateway-rpc` owns the canonical
wire types; this package owns the runtime RPC catalog and JSON schemas, auth
scopes, compatibility aliases, and API row serializers. Its only runtime
dependency is `@smithers-orchestrator/protocol`, and it deliberately has no
`effect` dependency.

Layout:

- `rpc/index.js` — the frozen v1 runtime catalog: JSON schemas,
  `GATEWAY_RPC_DEFINITIONS`, the error table, legacy method aliases, and the
  required-scope lookup (including HTTP-only routes).
- `rpc/gatewayRpcTypes.ts` — types for the gateway-owned runtime catalog plus
  compatibility re-exports of the protocol-owned wire types.
- `auth/scopes.js` — the scope catalog, per-family scope hierarchy, and
  `hasGatewayScope` enforcement (including legacy `read`/`execute`/`approve`/
  `admin` grants and per-method name/prefix grants).
- `api/` — pure DB-row → wire-row serializers for the collection endpoints
  (see `api/README.md`).
- `index.js` — re-exports all three; `package.json` also exposes each subpath
  (`./rpc`, `./auth/scopes`, `./api`) directly.

`@smithers-orchestrator/gateway/rpc` remains a supported compatibility surface:
it re-exports the protocol wire types alongside the gateway-owned runtime
catalog values. The server consumes that runtime catalog. Client code uses
`@smithers-orchestrator/gateway-client`, and `gateway-react` consumes
`gateway-client` instead of importing this package directly.

Gotchas:

- `openapi.yaml` at the package root is generated from
  `GATEWAY_RPC_DEFINITIONS` by `scripts/generate-openapi.ts` and gated by
  `check:openapi` — any change to serialized schema content requires
  regenerating it.
- Every RPC here is maturity `stable`; adding or renaming a method or scope is
  a contract change pinned by `tests/rpc-contract.test.ts` (exact method list
  and per-method required scopes).
