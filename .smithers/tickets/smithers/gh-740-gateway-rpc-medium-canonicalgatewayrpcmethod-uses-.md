# 🐛 gateway/rpc: [medium] canonicalGatewayRpcMethod uses prototype-unsafe indexing, returns inherited Object members for names like "toString"

GitHub: https://github.com/smithersai/smithers/issues/740

_via ultracode (Opus multi-agent) review_

**Summary:** `canonicalGatewayRpcMethod` reads the legacy alias table with non-own indexing on a plain object literal, so method names colliding with `Object.prototype` members return an inherited function instead of `undefined`, violating its documented return type.

**Location:** `packages/gateway/src/rpc/index.js:862` (alias table at `:225`).

```js
export function canonicalGatewayRpcMethod(method) {
  if (definitionByMethod.has(method)) return method;
  return GATEWAY_RPC_LEGACY_METHOD_ALIASES[method]; // <-- non-own indexing
}
```

**Failure scenario:** `canonicalGatewayRpcMethod("toString")` — `definitionByMethod` is a `Map` so `.has("toString")` is false, then `GATEWAY_RPC_LEGACY_METHOD_ALIASES["toString"]` yields `Object.prototype.toString` (a function), not `undefined`. Same for `"constructor"`, `"valueOf"`, `"hasOwnProperty"`. This breaks the documented `@returns {GatewayRpcMethod | undefined}`.

**Why it matters:** No active scope bypass today — the only in-repo caller (`getGatewayRpcDefinition`, `:870`) funnels the result through `definitionByMethod.get()` (a `Map`, safe for a function key → `undefined`). But this is a latent contract violation in a publicly-exported, auth-adjacent lookup: any consumer treating a truthy return as valid (`canonicalGatewayRpcMethod(m) ?? fallback`, string interpolation, object-key use) mis-handles it. It is also inconsistent with the sibling `getRequiredScopeForGatewayMethod` (`:881`), which already guards the identical pattern with `Object.hasOwn` and a comment naming this exact `"toString"` hazard.

**Fix:** Guard the alias lookup with `Object.hasOwn(GATEWAY_RPC_LEGACY_METHOD_ALIASES, method)` (or make it a `Map` like `definitionByMethod`) so the two lookups are consistent and prototype-safe.
