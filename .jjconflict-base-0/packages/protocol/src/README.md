# @smithers-orchestrator/protocol — src

Zero-dependency Smithers wire contracts. The public
`@smithers-orchestrator/protocol/gateway-rpc` subpath is the canonical owner of
the stable v1 Gateway method, request, response, error, event-frame, and
response-frame types. `@smithers-orchestrator/gateway` consumes those wire
shapes and adds runtime schemas, catalog metadata, auth, and compatibility
exports.

Layout:

- `index.js` — the runtime entry (values only, re-exports from `devtools.js`
  and `errors/index.js`).
- `index.ts` — the TYPE entry. It looks like a duplicate of `index.js`, but it
  is the tsup dts entry (`tsup.config.ts` → `dts: { only: true }`,
  `outDir: "src"`) that produces the committed `src/index.d.ts`. Keep the two
  entries in sync; never delete or move `index.ts`.
- `gatewayRpcTypes.ts` — the canonical type-only Gateway RPC wire contract.
- `gateway-rpc.js` — the public type-export bridge that produces the committed
  `gateway-rpc.d.ts`; it deliberately exports no runtime catalog values.
- `devtools.js` — `DEVTOOLS_PROTOCOL_VERSION` plus JSDoc typedefs for the
  devtools types.
- `devtools/`, `errors/` — one type per file (see their READMEs).

Gotchas:

- The `// @smithers-type-exports-begin/end` blocks in `gateway-rpc.js`,
  `devtools.js`, and `errors/index.js` are tool-managed — never hand-edit them.
- Error codes are triple-maintained in identical member order (the
  `errors/index.js` tuples, the `errors/*.ts` unions, and the committed
  `index.d.ts`); `tests/protocol-contracts.test.js` fails on any drift,
  including a reorder.
- Keep runtime JSON schemas, required scopes, legacy method aliases, and
  OpenAPI metadata in `@smithers-orchestrator/gateway`. Its `./rpc` entry
  re-exports these protocol-owned wire types for compatibility.
