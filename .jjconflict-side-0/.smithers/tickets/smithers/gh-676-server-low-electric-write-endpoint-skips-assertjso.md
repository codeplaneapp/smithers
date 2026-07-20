# 🐛 server: [low] electric-write endpoint skips assertJsonPayloadWithinBounds body-size guard

GitHub: https://github.com/smithersai/smithers/issues/676

_via ultracode (Opus multi-agent) review_

**Summary:** `handleElectricWrite` reaches `routeRequest` without the `assertJsonPayloadWithinBounds` structural-DoS guard that both sibling ingress paths apply, so a sub-`maxBodyBytes` but pathologically structured payload is bounded on the RPC/WS paths yet unbounded here.

**References:**
- `packages/server/src/gateway.js:5177` — `handleElectricWrite` reads body with only the raw byte cap (`readBody(req, this.maxBodyBytes)`); `params` derived at :5182; frame built at :5205-5210 and passed to `executeRpc`/`routeRequest` at :5211 — no `assertJsonPayloadWithinBounds` call anywhere in the function.
- `packages/server/src/gateway.js:5316-5320` — `handleHttpRpc` calls `assertJsonPayloadWithinBounds("gateway frame", body, { maxArrayLength, maxDepth, maxStringLength })` before routing.
- `packages/server/src/gateway.js:1136-1140` — WS `parseGatewayRequestFrame` applies the same guard.
- Bounds constants: `packages/server/src/gateway.js:188-190` (depth 32, array 256, string 16 KiB) — independent of `maxBodyBytes`.

**Failure scenario:** An authenticated client holding the required write scope POSTs to `/v1/electric/write` a body under `maxBodyBytes` but with `params` deeply nested (>32) or containing a very long string (>16 KiB) or large array (>256). The identical payload is rejected on `handleHttpRpc`/WS by `assertJsonPayloadWithinBounds`, but on `handleElectricWrite` it passes straight to `routeRequest` and the engine.

**Why it matters:** Two paths reaching the same `routeRequest` have inconsistent input hardening; the structural-bounds defense-in-depth against CPU/stack amplification should hold uniformly. Fix: add the same `assertJsonPayloadWithinBounds("gateway frame", body, { maxArrayLength: GATEWAY_RPC_MAX_ARRAY_LENGTH, maxDepth: GATEWAY_RPC_MAX_DEPTH, maxStringLength: GATEWAY_RPC_MAX_STRING_LENGTH })` after the `!body` check (~line 5180), before deriving `params`.
