---
description: "Export the spans and counters the store packages already record to an OpenTelemetry collector."
---

# Telemetry

How an application exports what the stores already measure. The spans and counters described in [Observability](/observability) exist whether or not anything exports them; this page is the wiring that sends them to an OpenTelemetry collector.

## One layer

[`@smthrs/observability`](/api/observability) provides two distinct wiring families. The `Otlp` subpath below composes Effect's own OTLP logger, metrics exporter, and tracer (`effect/unstable/observability`) into one layer with the Smithers service identity as the default resource. That subpath uses `effect` alone, resolves no `node:` built-in, and bundles for Node and the browser. The package also ships explicit SDK-backed `NodeOtel`, `BrowserOtel`, `Otel`, and `Resource` subpaths; their platform and validation contracts are listed in the API reference.

```typescript
import * as Otlp from "@smthrs/observability/Otlp"
import { Effect } from "effect"

const Telemetry = Otlp.layerFetch({
  baseUrl: "http://localhost:4318",
  serviceName: "my-app", // defaults to "flows"
  serviceVersion: "1.2.3"
})

const program = Effect.log("telemetry online")
const main = program.pipe(Effect.provide(Telemetry))

Effect.runPromise(Effect.scoped(main))
```

That is the whole wiring. Spans opened through `Effect.fn` and `Effect.withSpan` reach `/v1/traces`, `Metric` counters reach `/v1/metrics` on the export interval and on shutdown, and log lines reach `/v1/logs`. The layer's scope owns the export fibers, so closing the application scope flushes and stops them. There is no unsubscribe to remember.

Three layers cover the deployment shapes:

| Layer                      | Use                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Otlp.layerFetch(options)` | the default: export over the host's global `fetch` (Node 22, every browser)                                                                             |
| `Otlp.layer(options)`      | the same wiring minus the HTTP client, for a host that provides its own `HttpClient`, for example Undici via `@smthrs/platform-node`'s `NodeHttpClient` |
| `Otlp.layerNoop`           | no collector: provides nothing, so wiring code switches layers rather than branches                                                                     |

### Options

| Option            | Meaning                                                                              | Default                      |
| ----------------- | ------------------------------------------------------------------------------------ | ---------------------------- |
| `baseUrl`         | collector endpoint; signals post to `/v1/logs`, `/v1/metrics`, `/v1/traces` below it | required                     |
| `serviceName`     | the `service.name` resource attribute                                                | `"flows"`                    |
| `serviceVersion`  | the `service.version` resource attribute                                             | the flows release version    |
| `attributes`      | extra resource attributes on every signal                                            | none                         |
| `headers`         | headers on every export request, for example vendor auth                             | none                         |
| `exportInterval`  | export cadence for all three signals                                                 | Effect's per-signal defaults |
| `shutdownTimeout` | bound on the shutdown flush                                                          | Effect's default             |

Operators who configure through the standard `OTEL_*` environment variables can use Effect's `Otlp.layerFromConfig` from `effect/unstable/observability` directly. It reads `OTEL_EXPORTER_OTLP_ENDPOINT`, per-signal endpoints, and `OTEL_SDK_DISABLED`, and requires `OTEL_{LOGS,METRICS,TRACES}_EXPORTER=otlp` to enable each signal. Provide it an `HttpClient` (for example `FetchHttpClient.layer`) and pass the same resource options.

## What arrives

Traces are the spans listed in [Observability](/observability): every store operation, flow lifecycle step, and engine dispatch, connected across the durable queue boundary.

Metrics are the hot-path series the store packages define beside the code that updates them, one `<Service>Metrics` module per package:

| Counter                                 | Attributes                                                                                                                     | Updated by                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `flows_journal_writes`                  | `channel` = `durable` \| `lossy`; `receipt` = `accepted` \| `duplicate` \| `dropped`                                           | `@smthrs/journal` `SqlJournal`, once per emission receipt                                            |
| `flows_db_write_retries`                | none                                                                                                                           | `@smthrs/database` `DurableWriter`, once per scheduled transaction replay after a transient conflict |
| `flows_run_claims`                      | `op` = `claim` \| `claim_and_own` \| `activate` \| `steal`; `outcome` = the operation's result tag in snake case               | `@smthrs/run-store` `RunStore`                                                                       |
| `flows_run_heartbeats`                  | `outcome` = `updated` \| `fence_lost` \| `not_found`                                                                           | `RunStore.heartbeat`; `fence_lost` is the fencing event                                              |
| `flows_run_transitions`                 | `outcome` = `transitioned` \| `fence_lost` \| `not_found` \| `guard_failed`; `to` = target status                              | `RunStore.transitionOwned`                                                                           |
| `flows/run/throughput`                  | none                                                                                                                           | `RunStore.transitionOwned`, after a terminal transition commits                                      |
| `flows/seat/active`                     | none                                                                                                                           | the scoped lifetime of each production `Agent.run` stream                                            |
| `flows/quota/park`                      | none                                                                                                                           | the first execution of a sealed quota park decision; durable replay does not count again             |
| `flows_step_cache_lookups`              | `outcome` = `hit` \| `miss`                                                                                                    | `@smthrs/step-cache` `CacheStore.get`                                                                |
| `flows_step_cache_puts`                 | `outcome` = `inserted` \| `existing_same` \| `conflict`                                                                        | `CacheStore.put`, after the write transaction returns                                                |
| `flows_artifact_puts`                   | none                                                                                                                           | `@smthrs/artifacts` local stores, once per successful put, dedupe included                           |
| `flows_artifact_gets`                   | none                                                                                                                           | once per successful digest-verified get; typed misses are error evidence, not throughput             |
| `flows_engine_dispatches`               | `outcome` = `success` \| `failure` \| `interrupt`                                                                              | `@smthrs/engine-store` `ActionPersistence`, once per durable dispatch, cache-served and fresh alike  |
| `flows_engine_scheduler_admissions`     | none                                                                                                                           | `PlanScheduler`, once per admission pass that launched at least one dispatch                         |
| `flows_engine_scheduler_nodes`          | `outcome` = `built` \| `clean` \| `failed` \| `skipped` \| `deferred`                                                          | `PlanScheduler`, once per node settlement                                                            |
| `flows_engine_sandbox_executions`       | `outcome` = `success` \| `failure` \| `interrupt`                                                                              | `WorkspaceSandbox.execute`                                                                           |
| `flows_engine_sandbox_materializations` | `outcome` = `success` \| `failure` \| `interrupt`                                                                              | `WorkspaceSandbox.materialize`, the one host write                                                   |
| `flows_engine_sandbox_conflicts`        | none                                                                                                                           | copy-back preflight, once per compare-and-set refusal                                                |
| `flows_engine_boundary_settlements`     | `outcome` = `clean` \| `deviation` \| `violation` \| `refused`                                                                 | the dispatch seam, once per boundary settle                                                          |
| `flows_engine_step_cache_decisions`     | `outcome` = `verified_hit` \| `miss` \| `unverifiable_evidence` \| `unmeasurable` \| `stale_read_set` \| `replay_failed`       | `ActionPersistence`, at most once per cache-consulting dispatch                                      |
| `flows_engine_claims`                   | `outcome` = `activated` \| `terminal` \| `heartbeat_fresh` \| `steal_refused_owner_alive` \| `claim_lost` \| `activation_lost` | `RunDriver.claimAndActivate`, the engine-level decisions before and after the store CAS              |

`flows_engine_step_cache_decisions` is counted where the decision takes effect: `verified_hit` as the cached result is served, a fall-through outcome as the dispatch proceeds to the real execution. A dispatch that fails or is fenced out mid-decision (a journal failure on the provenance emit, a strict corruption verdict) records no decision; its exit lands in `flows_engine_dispatches` instead. Unlike `flows_step_cache_lookups`, this counter is the effective reuse-or-fall-through decision.

Durations are `Metric.timer` histograms recorded through Effect's `Effect.trackDuration` (monotonic clock; success, failure, and interruption alike):

| Timer                                           | Measures                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `flows_engine_dispatch_duration`                | one durable dispatch, admission through settlement                              |
| `flows_engine_scheduler_dispatch_duration`      | one scheduler dispatch, admission through terminal event, rebase turns included |
| `flows_engine_sandbox_execution_duration`       | one isolated workspace execution                                                |
| `flows_engine_sandbox_materialization_duration` | one copy-back                                                                   |

The handles are exported (`JournalMetrics`, `RunStoreMetrics`, `CacheStoreMetrics`, `ArtifactStoreMetrics`, `DatabaseMetrics`, `EngineStoreMetrics`), so a program can read them with `Metric.value` without an exporter at all.

:::warning
Read an outcome-dimensioned counter through its exported attribute view (`CacheStoreMetrics.hit`, `EngineStoreMetrics.dispatch.Success`), not through the bare counter handle. `Metric.value` reads the series for the exact attribute set on the handle, and the packages update only the tagged series, so the bare handle's attribute-less series stays at zero.
:::

## Testing without a network

Updates resolve the metric registry from the running Effect context, so a test provides a fresh registry and reads it back with no exporter and no network:

```typescript
import { assert, it } from "@effect/vitest"
import { CacheStoreMetrics } from "@smthrs/step-cache"
import { Effect, Metric } from "effect"

it.effect("records cache hits", () =>
  Effect.gen(function*() {
    const hits = yield* program.pipe(
      Effect.andThen(Metric.value(CacheStoreMetrics.hit)),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )

    assert.strictEqual(hits.count, 1)
  }))
```

The exporter itself is testable the same way: `Otlp.layerFetch` reads its `fetch` from the `FetchHttpClient.Fetch` reference, so a test provides a recording stub and asserts on the OTLP request bodies. `packages/observability/test/Otlp.test.ts` does exactly this.
