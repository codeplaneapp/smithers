# @smithers-orchestrator/electric-proxy — src

The auth/scope/rate-limit/observability proxy that fronts an ElectricSQL shape
API (`/v1/shape`) for Smithers cloud and self-hosted deployments. Everything
re-exported from `index.ts` is public npm surface, and the package's `./*`
export map makes every file here a public deep-import path — do not rename
files.

How the pieces fit:

- `createSmithersElectricProxy.ts` — the core fetch handler: duplicate-param
  guard → authenticate → shape lookup in the catalog → gateway-scope check →
  where-clause micro-parser validated against granted run/workspace/user ids →
  open + active rate limits with TTL slot reclaim → frame-bounded upstream
  forwarding. Also serves `/healthz` and `/metrics`.
- `smithersElectricShapeCatalog.ts` — the explicit shape allowlist: base
  `_smithers_*` tables plus an opt-in output-table allowlist, never a regex
  catch-all.
- `createSmithersElectricProxyMetrics.ts` — the Prometheus counters/gauges
  rendered at `/metrics`.
- `createSmithersElectricProxyObserver.ts` — zero-dependency telemetry seam:
  per-proxy observer plus the `__smithersElectricTelemetry` global sink; never
  throws on the hot path.
- `serveSmithersElectricProxy.ts` — wraps the fetch handler in a real Node HTTP
  server (used by `bin/smithers-electric-proxy.ts`).

Key entry points: `createSmithersElectricProxy(options).fetch(request)` and
`serveSmithersElectricProxy({ proxy })`.

Gotchas: the proxy FAILS CLOSED — a scoped principal with no concrete grant
arrays is rejected unless `auth.unscoped` is explicitly set (single-user
local-cloud only). The where parser rejects OR/UNION/SELECT/NOT, comments, and
backslash escapes by design. Output tables are reachable only via the explicit
`outputTables` allowlist.
