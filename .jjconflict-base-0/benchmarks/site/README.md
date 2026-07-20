# benchmarks.smithers.sh

Static leaderboard for the Smithers benchmark suite. Public SOTA rows come from
each benchmark's own paper/leaderboard; smithers rows are the Claude-only
(Opus→Sonnet delegation) fleet and are **pending** until the first full cloud
pass fills them in.

## Build

```bash
bun benchmarks/site/make-site.ts   # reads ../results.json → index.html
```

`index.html` is self-contained (inline CSS, no network, light/dark theme-aware).
Commit both `benchmarks/results.json` and the generated `index.html` so the build
is deterministic and reviewable — the same pattern the other `*.smithers.sh`
sites use.

## Data

`benchmarks/results.json` is the canonical dataset. Every leaderboard row carries
`n`, `subset`, and a `caveat` so a small or pending run can never read as a
full-benchmark claim (status is `pending` | `reference` | `result`). The fleet's
aggregation step fills in `result` rows as passes complete.

## Deploy to benchmarks.smithers.sh

The hosting shell is unchanged boilerplate. Copy `apps/ui-site`'s `src/worker.ts`
(Cloudflare asset server), `alchemy.run.ts` (Worker + Assets + custom domain), and
`wrangler.jsonc` into an `apps/benchmarks-site`, point its assets dir at this
`site/`, and run `pnpm -C apps/benchmarks-site deploy`.

## Later: live leaderboard

Phase 2 (spec §8) swaps the static page for a gateway-react SPA over shared
Postgres (`useGatewayRuns`/`useGatewayScores`) so in-progress runs stream live.
Keep this static page as the default and fallback.
