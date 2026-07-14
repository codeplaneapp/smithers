# 🐛 fix(gateway-react): [medium] useGatewayMutation ignores `invalidate` option and invalidates ALL collections on every mutation

GitHub: https://github.com/smithersai/smithers/issues/697

_via ultracode (Opus multi-agent) review_

`useGatewayMutation` accepts a typed `invalidate` scoping option but never uses it, unconditionally invalidating every Smithers collection after any mutation.

**Locations**
- `packages/gateway-react/src/useGatewayMutation.ts:18` — the `MutationOptions` param (declared at :12-14 with `invalidate?: readonly unknown[]`) is bound to `_options` and never referenced.
- `packages/gateway-react/src/useGatewayMutation.ts:73` — `await collections.invalidate()` is called with no argument on every successful mutation.
- `packages/gateway-client/src/data/createSmithersCollections.ts:257-261` — `invalidate(names?)` with no/empty `names` invalidates `smithersCollectionKeys.all` (the whole `["smithers"]` prefix = every collection); passing `names` scopes to per-collection prefixes.

**Failure scenario**
A dashboard rendering runs, workflows, crons, tickets, and memory facts calls `useGatewayMutation('updateTicket', { invalidate: ['tickets'] }).mutate(...)`. The `{ invalidate: ['tickets'] }` option is silently dropped, so instead of refetching only tickets, all collections are invalidated → the entire dashboard refetches (N RPCs) on every ticket edit.

**Why it matters**
A public typed option is a silent no-op (contract violation), and full-graph invalidation on every domain write is a real refetch amplifier for any non-trivial UI built on these hooks. Note `packages/gateway-react/tests/collectionHooks.test.ts:288` already passes `{ invalidate: ["runs"] }` but asserts nothing about scoping, so the bug is uncaught by CI.

**Fix**: read the option (`options.invalidate`) and pass it to `collections.invalidate(options.invalidate)`; rename `_options` → `options`; add a test asserting only the named collection(s) are invalidated.


> Closed by ticket-fleet: landed on main in 7ebe0e5292ea70e9647062b65996b3d1daabba23.
