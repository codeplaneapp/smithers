# web-search/

`createGroundedWebSearchToolset.js` — a `grounded_web_search` tool that fans a
query out to Exa (required; semantic) plus at least one fresh/SERP provider
(Tavily, Brave, or Serper), dedupes results by hash-stripped URL, and assigns
citation numbers.

Each `create*SearchProvider.js` file is deliberately self-contained (its own
freshness mapping and `readJson` response handling) so providers can be
audited and vendored independently — the small duplication across them is
accepted.

Behavior notes:

- `maxResults` is capped at `maxResultsPerProvider` (default 5) even though
  the input schema advertises up to 20.
- Provider failures are tolerated (`Promise.allSettled`) and reflected in the
  returned `providers` list.

Type sidecars: `GroundedWebSearchProvider.ts`, `GroundedWebSearchToolset.ts`.
All entry points are re-exported from the package root via `index.js`.
