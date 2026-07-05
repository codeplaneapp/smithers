# @smithers-orchestrator/gateway — src

The dependency-free, stable Gateway contract package: pure data plus tiny pure
functions. It has no runtime dependencies (and deliberately no `effect`); the
server (`packages/server`), `gateway-client`, and `gateway-react` consume it.

Layout:

- `rpc/index.ts` — the frozen v1 RPC catalog: request/response types, JSON
  schemas, `GATEWAY_RPC_DEFINITIONS`, the error table, legacy method aliases,
  and the required-scope lookup (including HTTP-only routes).
- `auth/scopes.ts` — the scope catalog, per-family scope hierarchy, and
  `hasGatewayScope` enforcement (including legacy `read`/`execute`/`approve`/
  `admin` grants and per-method name/prefix grants).
- `api/` — pure DB-row → wire-row serializers for the collection endpoints
  (see `api/README.md`).
- `index.ts` — re-exports all three; `package.json` also exposes each subpath
  (`./rpc`, `./auth/scopes`, `./api`) directly.

Gotchas:

- `openapi.yaml` at the package root is generated from
  `GATEWAY_RPC_DEFINITIONS` by `scripts/generate-openapi.ts` and gated by
  `check:openapi` — any change to serialized schema content requires
  regenerating it.
- Every RPC here is maturity `stable`; adding or renaming a method or scope is
  a contract change pinned by `tests/rpc-contract.test.ts` (exact method list
  and per-method required scopes).
