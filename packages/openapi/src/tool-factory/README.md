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

All outbound operation and redirect URLs are HTTP(S)-only. Redirect handling
requires `options.baseUrl` before configured `auth` or `headers` can be sent;
the exact base origin, not a spec-controlled `servers[].url`, is the initial
credential trust boundary. An unpinned spec server using a localhost-style name
or non-global IP address is rejected. Hostnames are resolved and denied when
resolution fails or any A/AAAA answer is non-global. The same destination check
applies to remote spec loads and redirect hops. `options.allowPrivateNetwork`
deliberately permits private/special remote specs, redirects, and uncredentialed
unpinned servers; it cannot replace `baseUrl` for credentialed requests.
`options.resolveHostname` is an injectable resolver for controlled runtimes and
tests. Because Fetch resolves again after validation, DNS-rebinding and private
range policy still belongs at the deployment egress boundary.

Redirect handling preserves credentials on same-origin hops and rejects every
cross-origin hop before contact unless the destination is in
`options.allowedRedirectOrigins` (`options.allowedOrigins` is a compatibility
alias). The redirect allowlist never trusts an initial spec server, and HTTPS
downgrades always fail. Non-2xx errors redact configured secret values and the
Basic/query wire forms generated from them before returning the message/body.
`options.maxRedirects` defaults to 5. `options.maxRequestBytes` defaults to
10 MiB and rejects request bodies locally before fetch based on their serialized
wire bytes; multipart measurement includes aggregate fields/files, boundaries,
and part headers. Exact-cap bodies are accepted, and over-cap bodies fail with
`REQUEST_TOO_LARGE`. `options.maxResponseBytes` defaults to 1 MiB. Remote spec
loading uses `options.maxSpecBytes` (5 MiB by default) and can be cancelled with
`options.signal`. The AI SDK execution `abortSignal` is composed into each
generated tool's fetch and capped response reader.

`_helpers.js` is underscore-private by convention but reachable via the
package's `./*` wildcard export and imported directly by tests (`buildUrl`,
`resolveBaseUrl`, `executeToolEffect`) — treat its exports as frozen surface.
