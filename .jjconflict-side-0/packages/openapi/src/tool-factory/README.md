# tool-factory/

The tool-factory public surface: `createOpenApiTools` / `createOpenApiTool`
(async — spec loaded via `loadSpecEffect`, so URLs work) and the `*Sync`
variants (object / local-file / raw-text specs only), plus `listOperations`
for CLI preview. `index.js` is the barrel re-exported by `../tool-factory.js`
and the package root.

`_helpers.js` holds everything shared: auth headers, `buildUrl` (preserves the
server base path when joining the operation path), per-media-type request-body
serialization (JSON / multipart / urlencoded / raw), `executeRequest`,
`executeToolEffect` (call/error counters, duration metric, log spans),
curation (include/exclude/rename/describe via `options.operations`),
`resolveBaseUrl` (relative `servers[].url` resolved via `SPEC_SOURCE_URL`),
and `createToolFromOperation` / `createOpenApiTool(s)FromSpec`.

Trust boundary (keep intact): operator-injected auth/headers are spread AFTER
LLM-controlled header params, so a spec-declared `Authorization` header
parameter can never override the injected secret. The request body is read
from the same collision-free key `getRequestBodyArgName` computed for the
schema, so a parameter named `body` cannot shadow it.

`_helpers.js` is underscore-private by convention but reachable via the
package's `./*` wildcard export and imported directly by tests (`buildUrl`,
`resolveBaseUrl`, `executeToolEffect`) — treat its exports as frozen surface.
