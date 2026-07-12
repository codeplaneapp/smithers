# web-search/

`createGroundedWebSearchToolset.js` — a `grounded_web_search` tool that fans a
query out to Exa (required; semantic) plus at least one fresh/SERP provider
(Tavily, Brave, or Serper), dedupes results by hash-stripped URL, and assigns
citation numbers.

Each `create*SearchProvider.js` file owns its freshness and result mapping.
`searchHttp.js` centralizes credential-safe redirects, bounded response reads,
and cancellation so those transport guarantees stay consistent across every
provider.

Behavior notes:

- `maxResults` is capped at `maxResultsPerProvider` (default 5) even though
  the input schema advertises up to 20.
- Provider failures are tolerated (`Promise.allSettled`) and reflected in the
  returned `providers` list.
- A configured provider origin and exact `allowedOrigins` remain trusted,
  including intentional private endpoints. Every other cross-origin redirect
  fails before contact, so provider keys, queries, and request bodies never
  reach an unapproved origin.
- The AI SDK tool-call `abortSignal` is forwarded to every provider as the
  optional second `search` argument and through the built-in providers' fetch
  and response-read paths. Cancellation returns the original `signal.reason`.
  The outer fan-out also stops waiting if a custom provider ignores its signal.

Type sidecars: `GroundedWebSearchProvider.ts`, `GroundedWebSearchToolset.ts`.
All entry points are re-exported from the package root via `index.js`.
