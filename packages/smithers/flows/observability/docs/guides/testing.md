---
title: "Test telemetry without a collector"
description: "Assert on what would have been exported: a recording fetch for OTLP payloads, TestJournal for forwarded log records, a fresh metric registry, and the noop layers that stand in for absent telemetry."
sidebar:
  order: 6
---

Telemetry is testable because every outbound edge is a service. Replace the
edge, keep the wiring, and the assertions are about the payloads a collector
would have received.

## Record what the exporter posts

`Otlp.layerFetch` delivers over the `FetchHttpClient.Fetch` service, so
providing your own function captures every export request and touches no
network:

```ts
import * as Otlp from "@smthrs/observability/Otlp"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

const recordingFetch = () => {
  const requests: Array<{ url: string; body: string }> = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    const body = typeof init?.body === "string"
      ? init.body
      : new TextDecoder().decode(init?.body as Uint8Array)
    requests.push({ url: String(input), body })
    return Promise.resolve(new Response("{}", { status: 200 }))
  }
  return { requests, fetch }
}

const collector = recordingFetch()

await Effect.runPromise(
  program.pipe(
    Effect.provide(Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318" })),
    Effect.provideService(FetchHttpClient.Fetch, collector.fetch),
    Effect.provideService(Metric.MetricRegistry, new Map()),
    Effect.orDie,
    Effect.scoped
  )
)
```

Assert after the scope closes, because the shutdown flush is what delivers a
short program's signals. Filter `collector.requests` by URL suffix to separate
the three signals, and parse a body to read span or series names. An
unresolvable host such as `collector.invalid` is a deliberate choice: if the
service is ever missed, the test fails rather than reaching the network.

The fresh `Metric.MetricRegistry` map keeps one test's counters out of the
next test's export.

## Test the journal forwarder

`TestJournal.layer()` from [`@smthrs/journal`](/api/journal) provides the
production SQLite journal over an in-memory database, so a forwarding test
exercises the real write path:

```ts
import * as Journal from "@smthrs/journal/Journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as JournalLogger from "@smthrs/observability/JournalLogger"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

// `runId` is a decoded JournalEvent.RunId, as in the forwarding guide.
const entries = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  yield* Effect.logInfo("hello")
  const page = yield* journal.entries({ runId, limit: 100 })
  return page.entries
}).pipe(
  Effect.provide(Layer.provideMerge(JournalLogger.layerJournalForwarding({ runId }), TestJournal.layer())),
  Effect.scoped
)
```

Forwarding is asynchronous, so poll until the expected number of entries has
landed rather than sleeping a fixed interval. To assert on a loss instead,
read `Metric.value(ObservabilityMetric.droppedLogRecords)`.

## Control time for the retry window

Export retries and the 60-second disable window run on Effect's clock, so
`TestClock` makes them deterministic:

```ts
import { TestClock } from "effect/testing"

const exported = Effect.gen(function*() {
  yield* Effect.void.pipe(Effect.withSpan("exported"))
  // One initial request plus three transient retries completes within four seconds.
  yield* TestClock.adjust("5 seconds")
})
```

Provide `TestClock.layer()` alongside the exporter, then advance the clock and
count the recorded requests.

## Stand telemetry down explicitly

A test that is not about telemetry should say so rather than leave the layer
out and let a type error decide:

| Layer                | What it does                                                    |
| -------------------- | --------------------------------------------------------------- |
| `Otlp.layerNoop`     | Provides nothing and exports nothing.                           |
| `Otel.layerNoop`     | The empty provider-neutral OTEL slot.                           |
| `Logger.layerNoop()` | Removes the logger set and pins `None` unless you name a level. |

`Journal.layerNoop` from [`@smthrs/journal`](/api/journal) is the matching stub
for the forwarder when the assertion is about queue behavior rather than about
persistence.

## Assert on refusals at acquisition

Both configuration refusals happen while the layer is built, so a test builds
the layer and inspects the exit rather than running a program:

```ts
import * as Layer from "effect/Layer"

const exit = await Effect.runPromiseExit(
  Effect.scoped(Layer.build(Otlp.layerFetch({ baseUrl: "collector:4318" })))
)
```

The failure is an `Endpoint.InvalidExporterEndpoint` whose `path` is `baseUrl`.
See [Troubleshooting](../troubleshooting.md) for the catalog.
