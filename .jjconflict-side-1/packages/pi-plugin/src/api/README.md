# api/

Plain-HTTP helpers against the Smithers gateway `/v1` REST endpoints. These are
the HTTP counterparts to `../runtime/DevToolsClient.ts`, which speaks the
gateway WS/RPC protocol instead.

- One exported async function per file (`approve`, `cancel`, `deny`,
  `getFrames`, `getStatus`, `listRuns`, `resume`, `runWorkflow`,
  `streamEvents`), each a thin wrapper over `SmithersPiHttpClient`.
- `SmithersPiHttpClient` — bearer-auth `fetch` wrapper. `json()` throws
  `SmithersError` `PI_HTTP_ERROR` on non-2xx; `events()` is an async generator
  that parses SSE `data:` frames and skips malformed JSON.
- All arg objects accept optional `baseUrl`/`apiKey`; the default base is
  `http://127.0.0.1:7331` (the local gateway default).
