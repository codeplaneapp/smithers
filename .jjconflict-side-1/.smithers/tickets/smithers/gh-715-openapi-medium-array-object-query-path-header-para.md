# 🐛 openapi: [medium] array/object query, path & header params stringified with String(), dropping form/explode serialization

GitHub: https://github.com/smithersai/smithers/issues/715

_via ultracode (Opus multi-agent) review_

**Summary:** Generated OpenAPI tools serialize array/object query, path, and header parameters with a bare `String(value)`, producing malformed requests instead of OpenAPI's default `style: form, explode: true`.

**Location:**
- `packages/openapi/src/tool-factory/_helpers.js:194` — `const strValue = String(value)` (the single stringify for every path/query/header param)
- `packages/openapi/src/tool-factory/_helpers.js:76` — `fullUrl.searchParams.set(key, value)` (single value, no per-element append)

**Why it's reachable:** `buildOperationSchema.js:50` runs each parameter schema through `jsonSchemaToZod`, which returns `z.array(...)` for `type: array` (`jsonSchemaToZod.js:76-79`) and `z.object(...)` for `type: object` (`:80-81`). The model therefore legitimately supplies a JS array/object for such a parameter.

**Failure scenario:** An operation with query param `tags: {type: array, items: {type: string}}`. Model calls the tool with `{ tags: ["cat","dog"] }`. `String(["cat","dog"])` → `"cat,dog"`, and `buildUrl` emits `?tags=cat%2Cdog` (one value). The upstream API parses a single literal tag `"cat,dog"` and returns wrong/empty results. An object param is worse: `String({a:1})` → `"[object Object]"`.

**Why it matters:** Array query params (id lists, tag/filter sets) are among the most common OpenAPI patterns; generated tools silently produce malformed requests for a whole class of endpoints, with no error surfaced. Notably the request-*body* serializers already handle arrays correctly (per-item `.append()` at `_helpers.js:105-113` and `:129-137`) — the query/path/header path is simply missing that handling. Fix: honor at least the default form/explode behavior (append one query entry per array element).
