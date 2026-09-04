# @smthrs/observability

This package declares `effect` as an exact
`4.0.0-rc.108` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://observability.smithers.sh

The telemetry exporter for a Smithers process, and the Effect layers a host
installs around it.

Every other package is already instrumented. The stores open spans through
Effect's tracer and update their own metric handles on their hot paths;
`JournalMetrics`, `RunStoreMetrics`, `CacheStoreMetrics`, `ArtifactStoreMetrics`
and `DatabaseMetrics` among them. What none of them does is ship a signal off
the process. That is this package, and in the common case it is one layer.

## Install

```sh
pnpm add @smthrs/observability effect@4.0.0-rc.108
```

## Export to a collector

```ts
import * as Otlp from "@smthrs/observability/Otlp"
import * as Effect from "effect/Effect"

const telemetry = Otlp.layerFetch({
  baseUrl: "http://localhost:4318",
  serviceName: "my-service"
})

// `program` is your durable run, unchanged from its non-telemetry form.
const outcome = program.pipe(Effect.provide(telemetry), Effect.scoped)
```

`Otlp` posts logs, metrics, and traces over the host's global `fetch` and
imports no OpenTelemetry SDK, so it runs unchanged on Node, on Bun, and in a
browser. Nothing in the flow body or the rest of the composition changes;
deleting the `Effect.provide` line removes telemetry and changes nothing else.

## What else is in the package

The root entry point also exports validated collector endpoints (`Endpoint`)
and resource metadata (`Resource`), Effect logger layers (`Logger`), a bounded
journal-forwarding logger (`JournalLogger`), the shared runtime metric handles
(`Metric`), and a provider-neutral OpenTelemetry bridge (`Otel`).

`NodeOtel` and `BrowserOtel` are deliberately not re-exported from the root.
Each resolves a host-specific OpenTelemetry SDK, and `NodeOtel` reaches
Node-only host modules, including the bare `async_hooks` specifier that
`@opentelemetry/context-async-hooks` imports, so re-exporting it would break the
browser bundle the root guarantees. Import them by subpath instead:

```ts
import * as NodeOtel from "@smthrs/observability/NodeOtel"
```

## Documentation

The full documentation lives at [observability.smithers.sh](https://observability.smithers.sh):
the [quickstart](https://observability.smithers.sh/quickstart/), guides for
exporting to a collector and forwarding logs to a run's journal, and the
[API reference](https://observability.smithers.sh/reference/api/) covering
validation, backpressure, shutdown, retry, and platform contracts.
