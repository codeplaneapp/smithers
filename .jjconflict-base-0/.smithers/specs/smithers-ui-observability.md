# Smithers UI observability

The Smithers PWA (`apps/smithers`) has two halves we need to debug from
outside the browser tab:

1. **The Cloudflare Worker proxy** (`src/worker.ts`) that fronts the auth API,
   the jjhub platform API, the Smithers Gateway, and the Cerebras chat
   completion route.
2. **The gateway client + custom-UI sync path** (`src/gateway/*`,
   `src/auth/authStore.ts`) where slow RPCs, dropped reconnects, stale
   snapshots, or auth expiries silently degrade what the user sees.

Both surfaces emit Prometheus metrics through in-process registries
(`src/observability/metrics.ts`) and structured JSON logs through a single
emitter (`src/observability/logger.ts`). The split between the two registries
is the load-bearing piece of the contract — every metric this spec lists lives
in exactly one realm, and the Worker scrape exposes only one of them.

## Worker vs browser metrics

There are two registries, on purpose:

| Registry | Where it lives | Scraped by |
| --- | --- | --- |
| `workerRegistry` | Worker realm | `GET /metrics` on the Worker |
| `browserRegistry` | Browser realm | Browser-local (no scrape today) |

The Worker's `/metrics` handler calls `renderPrometheus(workerRegistry)` —
not `defaultRegistry`, not `browserRegistry`. Browser-side instrumentation
lands in `browserRegistry`, which is available to in-page debug surfaces and
would graduate to a beacon shipper without churning the API surface.

The previous design tried to share one `defaultRegistry` instance across both
realms; in production the Worker runtime and the browser tab are different JS
realms, so the singleton was per-process anyway, and a Worker scrape
advertising browser metric *names* always rendered zero series for them.
Splitting registries makes the realm boundary visible at registration time
and lets `workerMetrics.test.ts` assert the absence of browser-only series in
the `/metrics` body, blocking that drift in tests.

### `workerRegistry` — scraped by `GET /metrics`

| Metric                                              | Kind      | Labels                            | Why we look at it                                                |
| --------------------------------------------------- | --------- | --------------------------------- | ---------------------------------------------------------------- |
| `smithers_ui_worker_proxy_requests_total`           | counter   | `route_kind`, `method`, `outcome` | Volume + outcome of every proxied request.                       |
| `smithers_ui_worker_proxy_duration_ms`              | histogram | `route_kind`, `method`            | Latency per route family (default ms buckets).                   |
| `smithers_ui_worker_proxy_payload_bytes`            | histogram | `route_kind`                      | Inbound payload sizes — catches large prompts / chat floods.     |
| `smithers_ui_worker_proxy_auth_failures_total`      | counter   | `route_kind`, `reason`            | 401 vs 403 from upstream services and the gateway.               |
| `smithers_ui_logger_drops_total`                    | counter   | `reason` (`serialize`/`sink`)     | Logger silently dropped an event — investigate the caller.       |

The proxy counter intentionally **omits `status`** even though earlier drafts
carried it. Status is already encoded in `outcome` buckets (`ok`,
`client_error`, `auth_failure`, `rate_limited`, `server_error`,
`upstream_unreachable`), and carrying both multiplies cardinality without
adding information. Under a 4xx/5xx storm the `outcome` label is the
discriminator dashboards need; if you need raw status codes during incident
triage, the duration histogram and auth-failure counter together pin the
shape.

### `browserRegistry` — browser-local

| Metric                                              | Kind      | Labels                            | Why we look at it                                              |
| --------------------------------------------------- | --------- | --------------------------------- | -------------------------------------------------------------- |
| `smithers_ui_gateway_rpc_total`                     | counter   | `method`, `outcome`               | RPC call count by SDK method.                                  |
| `smithers_ui_gateway_rpc_duration_ms`               | histogram | `method`                          | Per-method RPC latency.                                        |
| `smithers_ui_gateway_rpc_errors_total`              | counter   | `method`, `code`                  | Canonical error code from `extractErrorCode`.                  |
| `smithers_ui_gateway_stream_subscriptions_total`    | counter   | `stream`                          | Stream subscriptions opened (`run_events`, `devtools`, `extension`). |
| `smithers_ui_gateway_stream_reconnects_total`       | counter   | `stream`, `reason`                | Reconnects per stream by reason.                               |
| `smithers_ui_gateway_stream_reconnect_storms_total` | counter   | `stream`                          | Storms (>=5 reconnects sliding within 60s).                    |
| `smithers_ui_gateway_stream_backoff_ms`             | histogram | `stream`                          | Backoff applied between reconnects.                            |
| `smithers_ui_gateway_stream_stale_updates_total`    | counter   | `stream`, `reason`                | Updates that landed after their subscription was cancelled.    |
| `smithers_ui_gateway_connection_state`              | gauge     | —                                 | 0=offline, 1=connecting, 2=online, 3=unauthorized.             |
| `smithers_ui_surface_refresh_total`                 | counter   | `surface`, `trigger`, `outcome`   | Per-surface refresh tally.                                     |
| `smithers_ui_surface_refresh_duration_ms`           | histogram | `surface`                         | Per-surface refresh latency.                                   |
| `smithers_ui_offline_mode_active`                   | gauge     | —                                 | 1 when the browser is offline.                                 |

These series fire in the user's tab and stay in the browser's
`browserRegistry`. A future iteration can ship them to the Worker via a
beacon endpoint without changing the call sites — the registration boundary
is already drawn.

## Cardinality safeguards

Every counter, gauge, and histogram registers with an allow-list of label
keys. **Labels outside the allow-list are silently dropped at record time**,
so no caller can introduce a `user_id` label by accident and PII never leaks
into the exposition. `allowedLabels: []` means *enforce zero labels* — every
key is dropped (the previous "empty array disables filtering" behavior was a
foot-gun and is gone). `allowedLabels: undefined` is the explicit "no
filtering" escape hatch.

Every metric also caps the number of distinct label-tuples (default 256).
Once the cap is reached, new tuples collapse to a single `__overflow__`
series — so a runaway loop logging unique workflow keys cannot blow up the
in-memory registry or the scrape size. The cap and the overflow series are
both visible to tests via `hasOverflowed()`.

## Auth-failure semantics

`smithers_ui_worker_proxy_auth_failures_total{route_kind,reason}` ticks once
per 401 (`reason="unauthorized"`) and once per 403 (`reason="forbidden"`).
The gateway RPC path tracks the more granular code on
`smithers_ui_gateway_rpc_errors_total{method,code}` — typically
`UNAUTHORIZED`, `FORBIDDEN`, or `HTTP_4XX`/`HTTP_5XX` for transport errors. A
spike on either counter is the canonical signal that the user's session
expired.

RPC and stream metrics are emitted by the shared `getGatewayClient()` wrapper,
not by individual Zustand store call sites. Typed SDK methods, direct `rpcRaw`
calls used by sync/custom UI surfaces, extension RPCs, and gateway streams all
pass through that boundary, so adding a new consumer does not require remembering
to wrap metrics at the call site. `streamRunEventsResilient` exposes a reconnect
callback from the SDK; the app wrapper records the actual backoff delay and
reason from that callback.

## Reconnect storms

A "storm" is a *sliding window of >=5 reconnect events on the same stream
within 60 seconds*. We tick
`smithers_ui_gateway_stream_reconnect_storms_total{stream}` every time the
window crosses the threshold, including on every subsequent reconnect during
a sustained outage — the counter is a continuous rate, not a one-shot. The
previous "zero the window after raising" behavior masked sustained outages
behind a single tick every five reconnects.

Use this in PagerDuty: >=1 storm in 10 minutes is the alert.

## Trusted-proxy header strip

`proxyHeaders` drops every `x-user-id`, `x-user-scopes`, `x-user-role`, and
`x-smithers-token-id` header on the inbound side of every upstream proxy
call. The gateway path re-adds the validated set after `validateAuth`
returns; auth, platform, and chat upstreams never see attacker-supplied
trusted-proxy headers. The strip is unconditional (not gated on the gateway
route) so a future proxy route added without thinking about auth headers is
safe by default.

## Structured logging

`src/observability/logger.ts` emits one JSON line per event through a
swappable emitter. Production keeps the default `console.info` sink
(Cloudflare log drains stream it through unchanged); tests swap a capturing
sink.

Sensitive headers (`authorization`, `cookie`, `set-cookie`,
`x-smithers-key`, `x-user-id`, `x-user-scopes`, `x-user-role`,
`x-smithers-token-id`, `proxy-authorization`) are replaced with `[redacted]`
before serialization. URL query strings have `access_token`,
`refresh_token`, `code`, `state`, `id_token`, `token`, and `api_key`
redacted; basic-auth userinfo is stripped.

Serialization failures (a circular field, an exotic object) bump
`smithers_ui_logger_drops_total{reason="serialize"}`; a throwing emitter
bumps `{reason="sink"}`. A non-zero counter means an event was silently
dropped — investigate the caller for a non-serializable field or a
misconfigured sink. The previous design's bare `catch {}` swallowed both
failures into nothingness.

## How to view metrics locally

```bash
# 1. Boot the app (real backends, no mocks)
cd apps/smithers
pnpm dev

# 2. In another terminal, scrape `/metrics` through Vite's proxy:
curl -s http://127.0.0.1:5175/metrics | head -40

# 3. Or scrape the Worker directly:
curl -s http://127.0.0.1:<worker-port>/metrics
```

To hook the existing Prometheus + Grafana stack used by Smithers Studio:

```bash
smithers observability     # boots the local Grafana/Prometheus/Tempo stack
# then add this scrape config to `tools/observability/prometheus/prometheus.yml`:
#
# - job_name: smithers-ui
#   metrics_path: /metrics
#   static_configs:
#     - targets: ['127.0.0.1:5175']
```

The metric names are stable; the dashboards under `tools/observability/grafana`
can panel them straight from the `smithers_ui_` prefix.

## jjhub / Plue compatibility

The Worker has no Cloudflare-specific bindings on the observability path —
the handler reads `request.url`, the env, and a stable `performance.now()`
shim that falls back to `Date.now()` when running under Node. Anywhere that
can run the Worker entry can scrape `/metrics`, including the future jjhub
deploy.

## Tests

- `src/observability/metrics.test.ts` — Counter / Gauge / Histogram
  contracts, label allow-list filtering (including `allowedLabels: []`),
  cardinality cap behavior, overflow token.
- `src/observability/promExposition.test.ts` — deterministic Prometheus
  text rendering, escape behavior, idempotent output.
- `src/observability/logger.test.ts` — redaction allow-list, emit/level
  helpers, both serialization-failure and sink-failure drop counters.
- `src/observability/uiMetrics.test.ts` — route-kind / outcome mappings,
  the `recordRpc` wrapper (including back-to-back HTTP failures that would
  catch a `RegExp.$1` regression), sustained-outage storm rate.
- `src/gateway/gatewayClient.test.ts` — shared gateway-client boundary metrics
  for typed RPC, direct `rpcRaw`, stream subscription/error recording, and auth
  fetch behavior.
- `src/observability/workerMetrics.test.ts` — real worker entrypoint
  driven through `worker.fetch`, with cross-origin guard, auth failure,
  payload size, unknown-route, HEAD vs POST `/metrics`, the proxy
  counter's zero-`status`-label contract, and the explicit negative
  assertion that browser-only series never appear in the Worker
  scrape.
- `tests/e2e/observability.spec.ts` — `/metrics` scrape end-to-end against
  the same Vite proxy + worker host the e2e stack uses for the rest of
  the suite.
